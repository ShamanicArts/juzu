use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    response::Response,
    Router,
};
use http_body_util::BodyExt;
use juzu_core::{
    layout::LayoutResult, CommitNode, FileEntry, ObslogEntry, OpLogEntry, WorkspaceEntry,
};
use juzu_server::{router, ServerState};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{fs, path::Path, process::Command, time::Duration};
use tempfile::TempDir;
use tower::ServiceExt;

fn run_jj(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("jj")
        .args(["--config", "user.name=Juzu Test"])
        .args(["--config", "user.email=juzu@example.com"])
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("jj command should start");
    assert!(
        output.status.success(),
        "jj {args:?} failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn fixture_repo() -> TempDir {
    let repo = tempfile::tempdir().expect("temporary directory should be created");
    run_jj(repo.path(), &["git", "init", "."]);
    fs::write(repo.path().join("note.txt"), "hello from juzu web\n")
        .expect("fixture file should be written");
    run_jj(repo.path(), &["describe", "-m", "web fixture"]);
    repo
}

struct MultiWorkspaceFixture {
    _container: TempDir,
    primary: std::path::PathBuf,
}

fn multi_workspace_fixture() -> MultiWorkspaceFixture {
    let container = tempfile::tempdir().expect("temporary directory should be created");
    let primary = container.path().join("main");
    let review = container.path().join("review");
    fs::create_dir_all(&primary).expect("primary workspace should be created");
    run_jj(&primary, &["git", "init", "."]);
    run_jj(
        &primary,
        &[
            "workspace",
            "add",
            review.to_str().expect("review path should be utf-8"),
            "--name",
            "review",
            "--message",
            "review workspace",
        ],
    );
    MultiWorkspaceFixture {
        _container: container,
        primary,
    }
}

async fn get(app: &Router, uri: &str) -> Response {
    app.clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("router should respond")
}

async fn body_text(response: Response) -> String {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("response body should collect")
        .to_bytes();
    String::from_utf8(bytes.to_vec()).expect("response should be utf-8")
}

async fn body_json<T: DeserializeOwned>(response: Response) -> T {
    serde_json::from_str(&body_text(response).await).expect("response should contain valid JSON")
}

#[tokio::test]
async fn serves_embedded_page_health_and_repository_info() {
    let repo = fixture_repo();
    let state = ServerState::new(repo.path()).expect("server state should open fixture repo");
    let app = router(state);

    let response = get(&app, "/").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "text/html; charset=utf-8"
    );
    assert!(body_text(response)
        .await
        .contains("Interactive commit graph"));

    let response = get(&app, "/assets/app.js").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "text/javascript; charset=utf-8"
    );
    let script = body_text(response).await;
    assert!(script.contains("new EventSource"));
    assert!(script.contains("renderWorkspaceDock"));

    let response = get(&app, "/assets/styles.css").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "text/css; charset=utf-8"
    );
    assert!(body_text(response).await.contains(".graph-surface"));

    let response = get(&app, "/healthz").await;
    assert_eq!(response.status(), StatusCode::OK);
    let health: Value = body_json(response).await;
    assert_eq!(health["status"], "ok");

    let response = get(&app, "/api/v1/repo").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-store"
    );
    let info: Value = body_json(response).await;
    assert_eq!(
        info["workspaceRoot"],
        repo.path().to_string_lossy().as_ref()
    );
    assert_eq!(info["backend"], "jj-lib");
    assert_eq!(info["apiVersion"], "v1");
    assert_eq!(info["readOnly"], true);
}

#[tokio::test]
async fn exposes_log_count_files_diff_and_operation_views() {
    let repo = fixture_repo();
    let state = ServerState::new(repo.path()).expect("server state should open fixture repo");
    let app = router(state);

    let response = get(&app, "/api/v1/log?limit=20").await;
    assert_eq!(response.status(), StatusCode::OK);
    let nodes: Vec<CommitNode> = body_json(response).await;
    let working_copy = nodes
        .iter()
        .find(|node| node.is_working_copy)
        .expect("log should contain working copy");
    assert_eq!(working_copy.description_title, "web fixture");

    let response = get(&app, "/api/v1/node-count").await;
    assert_eq!(response.status(), StatusCode::OK);
    let count: Value = body_json(response).await;
    assert_eq!(count["count"].as_u64().unwrap() as usize, nodes.len());

    let files_uri = format!("/api/v1/changes/{}/files", working_copy.change_id);
    let response = get(&app, &files_uri).await;
    assert_eq!(response.status(), StatusCode::OK);
    let files: Vec<FileEntry> = body_json(response).await;
    assert!(files.iter().any(|file| file.path == "note.txt"));

    let diff_uri = format!("/api/v1/changes/{}/diff", working_copy.change_id);
    let response = get(&app, &diff_uri).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "text/plain; charset=utf-8"
    );
    let diff = body_text(response).await;
    assert!(diff.contains("note.txt"));
    assert!(diff.contains("hello from juzu web"));

    let response = get(&app, "/api/v1/oplog?limit=10").await;
    assert_eq!(response.status(), StatusCode::OK);
    let operations: Vec<OpLogEntry> = body_json(response).await;
    assert!(!operations.is_empty());

    let obslog_uri = format!("/api/v1/changes/{}/obslog?limit=10", working_copy.change_id);
    let response = get(&app, &obslog_uri).await;
    assert_eq!(response.status(), StatusCode::OK);
    let evolution: Vec<ObslogEntry> = body_json(response).await;
    assert!(!evolution.is_empty());
}

#[tokio::test]
async fn lays_out_history_and_rejects_unknown_modes() {
    let repo = fixture_repo();
    let state = ServerState::new(repo.path()).expect("server state should open fixture repo");
    let app = router(state);

    let response = get(&app, "/api/v1/layout?mode=mainline&limit=20").await;
    assert_eq!(response.status(), StatusCode::OK);
    let layout: LayoutResult = body_json(response).await;
    assert!(!layout.nodes.is_empty());
    assert!(layout.nodes.iter().all(|node| node.x.is_some()));
    assert!(layout.nodes.iter().all(|node| node.y.is_some()));
    assert!(layout.text_column_x > 0);
    assert!(layout.total_height > 0);

    let response = get(&app, "/api/v1/layout?mode=radial").await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let error: Value = body_json(response).await;
    assert!(error["error"].as_str().unwrap().contains("radial"));
}

#[tokio::test]
async fn exposes_all_jj_workspaces_with_the_current_workspace_marked() {
    let fixture = multi_workspace_fixture();
    let state =
        ServerState::new(&fixture.primary).expect("server state should open fixture workspace");
    let app = router(state);

    let response = get(&app, "/api/v1/workspaces").await;
    assert_eq!(response.status(), StatusCode::OK);
    let workspaces: Vec<WorkspaceEntry> = body_json(response).await;
    assert_eq!(
        workspaces
            .iter()
            .map(|workspace| workspace.name.as_str())
            .collect::<Vec<_>>(),
        vec!["default", "review"]
    );
    assert!(
        workspaces
            .iter()
            .find(|workspace| workspace.name == "default")
            .unwrap()
            .is_current
    );
    assert!(
        !workspaces
            .iter()
            .find(|workspace| workspace.name == "review")
            .unwrap()
            .is_current
    );
}

#[tokio::test]
async fn sends_sse_ready_and_repository_update_events() {
    let repo = fixture_repo();
    let state = ServerState::new(repo.path()).expect("server state should open fixture repo");
    let app = router(state.clone());

    let response = get(&app, "/api/v1/events").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "text/event-stream"
    );
    let mut body = response.into_body();
    let frame = tokio::time::timeout(Duration::from_secs(2), body.frame())
        .await
        .expect("SSE ready event should arrive")
        .expect("SSE response should contain a frame")
        .expect("SSE frame should be valid");
    let ready = String::from_utf8_lossy(frame.data_ref().expect("frame should contain data"));
    assert!(ready.contains("ready"));

    let mut events = state.subscribe();
    let watcher = state.spawn_repository_watcher(Duration::from_millis(20));
    tokio::time::sleep(Duration::from_millis(50)).await;
    run_jj(repo.path(), &["describe", "-m", "updated by watcher test"]);

    let event = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let event = events.recv().await.expect("event channel should stay open");
            if event.kind == "repo-updated" {
                break event;
            }
        }
    })
    .await
    .expect("repository update event should arrive");
    assert!(event.sequence > 0);

    state.shutdown();
    tokio::time::timeout(Duration::from_secs(2), async {
        while body.frame().await.is_some() {}
    })
    .await
    .expect("SSE stream should close during server shutdown");
    watcher.await.expect("watcher should stop cleanly");
}

#[test]
fn rejects_non_repository_paths() {
    let directory = tempfile::tempdir().expect("temporary directory should be created");
    assert!(ServerState::new(directory.path()).is_err());
}
