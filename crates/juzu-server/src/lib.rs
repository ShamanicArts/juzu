use axum::{
    extract::{Path as AxumPath, Query, State},
    http::{header, HeaderValue, Request, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        Html, IntoResponse, Response,
    },
    routing::get,
    Json, Router,
};
use futures_util::{stream, Stream, StreamExt};
use juzu_core::{
    layout::{calculate_default_layout, LayoutResult},
    ChangeQuery, CommitNode, FileEntry, JjBackend, JuzuError, LayoutMode, LogQuery, NodeCountQuery,
    ObslogEntry, ObslogQuery, OpLogEntry, OpLogQuery,
};
use juzu_jj::NativeJjBackend;
use serde::{Deserialize, Serialize};
use std::{
    convert::Infallible,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

const INDEX_HTML: &str = include_str!("../web/index.html");
const APP_JS: &str = include_str!("../web/app.js");
const STYLES_CSS: &str = include_str!("../web/styles.css");
const DEFAULT_LOG_LIMIT: usize = 500;
const MAX_LOG_LIMIT: usize = 2_000;

#[derive(Clone)]
pub struct ServerState {
    inner: Arc<ServerStateInner>,
}

struct ServerStateInner {
    executor: RepoExecutor,
    workspace_root: PathBuf,
    repo_path: PathBuf,
    workspace_name: String,
    events: EventHub,
    shutdown: watch::Sender<bool>,
}

impl ServerState {
    pub fn new(start: impl AsRef<Path>) -> anyhow::Result<Self> {
        let info = NativeJjBackend::new().open_workspace_info(start.as_ref())?;
        let executor = RepoExecutor::spawn(info.workspace_root.clone())?;
        let (shutdown, _) = watch::channel(false);
        Ok(Self {
            inner: Arc::new(ServerStateInner {
                executor,
                workspace_root: info.workspace_root,
                repo_path: info.repo_path,
                workspace_name: info.workspace_name,
                events: EventHub::new(),
                shutdown,
            }),
        })
    }

    pub fn workspace_root(&self) -> &Path {
        &self.inner.workspace_root
    }

    pub fn spawn_repository_watcher(&self, interval: Duration) -> tokio::task::JoinHandle<()> {
        let state = self.clone();
        let mut shutdown = state.inner.shutdown.subscribe();
        tokio::spawn(async move {
            let mut previous = state.repository_fingerprint();
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            ticker.tick().await;
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        let current = state.repository_fingerprint();
                        if current != previous {
                            previous = current;
                            state.inner.events.publish("repo-updated");
                        }
                    }
                    changed = shutdown.changed() => {
                        if changed.is_err() || *shutdown.borrow() {
                            return;
                        }
                    }
                }
            }
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RepoEvent> {
        self.inner.events.subscribe()
    }

    pub fn shutdown(&self) {
        let _ = self.inner.shutdown.send(true);
    }

    fn repository_fingerprint(&self) -> RepositoryFingerprint {
        RepositoryFingerprint::read(&self.inner.workspace_root, &self.inner.repo_path)
    }
}

pub fn router(state: ServerState) -> Router {
    let api = Router::new()
        .route("/repo", get(repository_info))
        .route("/log", get(log))
        .route("/layout", get(layout))
        .route("/node-count", get(node_count))
        .route("/changes/{change_id}/files", get(files))
        .route("/changes/{change_id}/diff", get(diff))
        .route("/oplog", get(op_log))
        .route("/changes/{change_id}/obslog", get(obslog))
        .route("/events", get(events))
        .layer(middleware::from_fn(no_store));

    Router::new()
        .route("/", get(index))
        .route("/assets/app.js", get(app_js))
        .route("/assets/styles.css", get(styles_css))
        .route("/healthz", get(health))
        .nest("/api/v1", api)
        .fallback(not_found)
        .with_state(state)
}

async fn no_store(request: Request<axum::body::Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn app_js() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        APP_JS,
    )
}

async fn styles_css() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        STYLES_CSS,
    )
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "route not found")
}

async fn repository_info(State(state): State<ServerState>) -> Json<RepositoryResponse> {
    Json(RepositoryResponse {
        workspace_root: state.inner.workspace_root.clone(),
        repo_path: state.inner.repo_path.clone(),
        workspace_name: state.inner.workspace_name.clone(),
        backend: "jj-lib",
        api_version: "v1",
        read_only: true,
    })
}

async fn log(
    State(state): State<ServerState>,
    Query(params): Query<LogParams>,
) -> Result<Json<Vec<CommitNode>>, ApiError> {
    let nodes = state
        .inner
        .executor
        .log(params.limit(), params.revset())
        .await?;
    Ok(Json(nodes))
}

async fn layout(
    State(state): State<ServerState>,
    Query(params): Query<LayoutParams>,
) -> Result<Json<LayoutResult>, ApiError> {
    let mode = params.mode()?;
    let nodes = state
        .inner
        .executor
        .log(params.limit(), params.revset())
        .await?;
    Ok(Json(calculate_default_layout(mode, &nodes)))
}

async fn node_count(
    State(state): State<ServerState>,
    Query(params): Query<RevsetParams>,
) -> Result<Json<NodeCountResponse>, ApiError> {
    let count = state.inner.executor.node_count(params.revset()).await?;
    Ok(Json(NodeCountResponse { count }))
}

async fn files(
    State(state): State<ServerState>,
    AxumPath(change_id): AxumPath<String>,
) -> Result<Json<Vec<FileEntry>>, ApiError> {
    validate_change_id(&change_id)?;
    Ok(Json(state.inner.executor.files(change_id).await?))
}

async fn diff(
    State(state): State<ServerState>,
    AxumPath(change_id): AxumPath<String>,
) -> Result<impl IntoResponse, ApiError> {
    validate_change_id(&change_id)?;
    let diff = state.inner.executor.diff(change_id).await?;
    Ok(([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], diff))
}

async fn op_log(
    State(state): State<ServerState>,
    Query(params): Query<LimitParams>,
) -> Result<Json<Vec<OpLogEntry>>, ApiError> {
    Ok(Json(state.inner.executor.op_log(params.limit(100)).await?))
}

async fn obslog(
    State(state): State<ServerState>,
    AxumPath(change_id): AxumPath<String>,
    Query(params): Query<LimitParams>,
) -> Result<Json<Vec<ObslogEntry>>, ApiError> {
    validate_change_id(&change_id)?;
    Ok(Json(
        state
            .inner
            .executor
            .obslog(change_id, params.limit(50))
            .await?,
    ))
}

async fn events(
    State(state): State<ServerState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let receiver = state.inner.events.subscribe();
    let shutdown = state.inner.shutdown.subscribe();
    let ready = state.inner.events.next_event("ready");
    let initial = stream::once(async move { Ok::<_, Infallible>(sse_event(ready)) });
    let updates = stream::unfold(
        (receiver, shutdown),
        |(mut receiver, mut shutdown)| async move {
            loop {
                tokio::select! {
                    result = receiver.recv() => match result {
                        Ok(event) => {
                            return Some((Ok::<_, Infallible>(sse_event(event)), (receiver, shutdown)));
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => return None,
                    },
                    changed = shutdown.changed() => {
                        if changed.is_err() || *shutdown.borrow() {
                            return None;
                        }
                    }
                }
            }
        },
    );

    Sse::new(initial.chain(updates)).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("heartbeat"),
    )
}

fn sse_event(event: RepoEvent) -> Event {
    let kind = event.kind.clone();
    Event::default()
        .event(kind)
        .json_data(event)
        .unwrap_or_else(|_| Event::default().event("error").data("serialization failed"))
}

fn validate_change_id(change_id: &str) -> Result<(), ApiError> {
    if change_id.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "change id must not be empty",
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize, Default)]
struct LogParams {
    limit: Option<usize>,
    revset: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct LayoutParams {
    limit: Option<usize>,
    revset: Option<String>,
    mode: Option<String>,
}

impl LayoutParams {
    fn limit(&self) -> usize {
        self.limit
            .unwrap_or(DEFAULT_LOG_LIMIT)
            .clamp(1, MAX_LOG_LIMIT)
    }

    fn revset(&self) -> Option<String> {
        normalize_revset(self.revset.clone())
    }

    fn mode(&self) -> Result<LayoutMode, ApiError> {
        match self.mode.as_deref().unwrap_or("mainline") {
            "chronological" => Ok(LayoutMode::Chronological),
            "mainline" => Ok(LayoutMode::Mainline),
            "bookmark-centric" => Ok(LayoutMode::BookmarkCentric),
            "wc-focused" => Ok(LayoutMode::WcFocused),
            "topological" => Ok(LayoutMode::Topological),
            other => Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                format!("unknown layout mode: {other}"),
            )),
        }
    }
}

impl LogParams {
    fn limit(&self) -> usize {
        self.limit
            .unwrap_or(DEFAULT_LOG_LIMIT)
            .clamp(1, MAX_LOG_LIMIT)
    }

    fn revset(&self) -> Option<String> {
        normalize_revset(self.revset.clone())
    }
}

#[derive(Debug, Deserialize, Default)]
struct RevsetParams {
    revset: Option<String>,
}

impl RevsetParams {
    fn revset(&self) -> Option<String> {
        normalize_revset(self.revset.clone())
    }
}

#[derive(Debug, Deserialize, Default)]
struct LimitParams {
    limit: Option<usize>,
}

impl LimitParams {
    fn limit(&self, default: usize) -> usize {
        self.limit.unwrap_or(default).clamp(1, MAX_LOG_LIMIT)
    }
}

fn normalize_revset(revset: Option<String>) -> Option<String> {
    revset.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryResponse {
    workspace_root: PathBuf,
    repo_path: PathBuf,
    workspace_name: String,
    backend: &'static str,
    api_version: &'static str,
    read_only: bool,
}

#[derive(Debug, Serialize)]
struct NodeCountResponse {
    count: usize,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn executor_closed() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "repository executor is unavailable",
        )
    }
}

impl From<JuzuError> for ApiError {
    fn from(error: JuzuError) -> Self {
        let status = match &error {
            JuzuError::RepoNotFound(_) => StatusCode::NOT_FOUND,
            JuzuError::Unsupported(_) => StatusCode::NOT_IMPLEMENTED,
            JuzuError::Backend(message) if message.contains("not found") => StatusCode::NOT_FOUND,
            JuzuError::Backend(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self::new(status, error.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorResponse {
                error: self.message,
            }),
        )
            .into_response()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoEvent {
    #[serde(rename = "type")]
    pub kind: String,
    pub timestamp_ms: u64,
    pub sequence: u64,
}

struct EventHub {
    sender: broadcast::Sender<RepoEvent>,
    sequence: AtomicU64,
}

impl EventHub {
    fn new() -> Self {
        let (sender, _) = broadcast::channel(64);
        Self {
            sender,
            sequence: AtomicU64::new(0),
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<RepoEvent> {
        self.sender.subscribe()
    }

    fn next_event(&self, kind: &str) -> RepoEvent {
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64;
        RepoEvent {
            kind: kind.to_string(),
            timestamp_ms,
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed) + 1,
        }
    }

    fn publish(&self, kind: &str) {
        let _ = self.sender.send(self.next_event(kind));
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    exists: bool,
    len: u64,
    modified_ns: u128,
}

impl FileStamp {
    fn read(path: &Path) -> Self {
        let Ok(metadata) = fs::metadata(path) else {
            return Self {
                exists: false,
                len: 0,
                modified_ns: 0,
            };
        };
        let modified_ns = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        Self {
            exists: true,
            len: metadata.len(),
            modified_ns,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RepositoryFingerprint {
    operation_heads: Vec<String>,
    checkout: FileStamp,
    tree_state: FileStamp,
}

impl RepositoryFingerprint {
    fn read(workspace_root: &Path, repo_path: &Path) -> Self {
        let heads_path = repo_path.join("op_heads").join("heads");
        let mut operation_heads = fs::read_dir(heads_path)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect::<Vec<_>>();
        operation_heads.sort();
        let working_copy = workspace_root.join(".jj").join("working_copy");
        Self {
            operation_heads,
            checkout: FileStamp::read(&working_copy.join("checkout")),
            tree_state: FileStamp::read(&working_copy.join("tree_state")),
        }
    }
}

#[derive(Clone)]
struct RepoExecutor {
    sender: mpsc::UnboundedSender<RepoRequest>,
}

impl RepoExecutor {
    fn spawn(workspace_root: PathBuf) -> anyhow::Result<Self> {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        std::thread::Builder::new()
            .name("juzu-repository".to_string())
            .spawn(move || {
                let backend = NativeJjBackend::new();
                while let Some(request) = receiver.blocking_recv() {
                    handle_repo_request(&backend, &workspace_root, request);
                }
            })?;
        Ok(Self { sender })
    }

    async fn request<T>(
        &self,
        build: impl FnOnce(oneshot::Sender<juzu_core::Result<T>>) -> RepoRequest,
    ) -> Result<T, ApiError>
    where
        T: Send + 'static,
    {
        let (sender, receiver) = oneshot::channel();
        self.sender
            .send(build(sender))
            .map_err(|_| ApiError::executor_closed())?;
        receiver
            .await
            .map_err(|_| ApiError::executor_closed())?
            .map_err(ApiError::from)
    }

    async fn log(&self, limit: usize, revset: Option<String>) -> Result<Vec<CommitNode>, ApiError> {
        self.request(|respond_to| RepoRequest::Log {
            limit,
            revset,
            respond_to,
        })
        .await
    }

    async fn node_count(&self, revset: Option<String>) -> Result<usize, ApiError> {
        self.request(|respond_to| RepoRequest::NodeCount { revset, respond_to })
            .await
    }

    async fn files(&self, change_id: String) -> Result<Vec<FileEntry>, ApiError> {
        self.request(|respond_to| RepoRequest::Files {
            change_id,
            respond_to,
        })
        .await
    }

    async fn diff(&self, change_id: String) -> Result<String, ApiError> {
        self.request(|respond_to| RepoRequest::Diff {
            change_id,
            respond_to,
        })
        .await
    }

    async fn op_log(&self, limit: usize) -> Result<Vec<OpLogEntry>, ApiError> {
        self.request(|respond_to| RepoRequest::OpLog { limit, respond_to })
            .await
    }

    async fn obslog(&self, change_id: String, limit: usize) -> Result<Vec<ObslogEntry>, ApiError> {
        self.request(|respond_to| RepoRequest::Obslog {
            change_id,
            limit,
            respond_to,
        })
        .await
    }
}

enum RepoRequest {
    Log {
        limit: usize,
        revset: Option<String>,
        respond_to: oneshot::Sender<juzu_core::Result<Vec<CommitNode>>>,
    },
    NodeCount {
        revset: Option<String>,
        respond_to: oneshot::Sender<juzu_core::Result<usize>>,
    },
    Files {
        change_id: String,
        respond_to: oneshot::Sender<juzu_core::Result<Vec<FileEntry>>>,
    },
    Diff {
        change_id: String,
        respond_to: oneshot::Sender<juzu_core::Result<String>>,
    },
    OpLog {
        limit: usize,
        respond_to: oneshot::Sender<juzu_core::Result<Vec<OpLogEntry>>>,
    },
    Obslog {
        change_id: String,
        limit: usize,
        respond_to: oneshot::Sender<juzu_core::Result<Vec<ObslogEntry>>>,
    },
}

fn handle_repo_request(backend: &NativeJjBackend, workspace_root: &Path, request: RepoRequest) {
    match request {
        RepoRequest::Log {
            limit,
            revset,
            respond_to,
        } => {
            let result = futures_executor::block_on(backend.log(LogQuery {
                cwd: workspace_root.to_path_buf(),
                limit,
                revset,
            }));
            let _ = respond_to.send(result);
        }
        RepoRequest::NodeCount { revset, respond_to } => {
            let result = futures_executor::block_on(backend.node_count(NodeCountQuery {
                cwd: workspace_root.to_path_buf(),
                revset,
            }));
            let _ = respond_to.send(result);
        }
        RepoRequest::Files {
            change_id,
            respond_to,
        } => {
            let result = futures_executor::block_on(backend.files(ChangeQuery {
                cwd: workspace_root.to_path_buf(),
                change_id,
            }));
            let _ = respond_to.send(result);
        }
        RepoRequest::Diff {
            change_id,
            respond_to,
        } => {
            let result = futures_executor::block_on(backend.diff(ChangeQuery {
                cwd: workspace_root.to_path_buf(),
                change_id,
            }));
            let _ = respond_to.send(result);
        }
        RepoRequest::OpLog { limit, respond_to } => {
            let result = futures_executor::block_on(backend.op_log(OpLogQuery {
                cwd: workspace_root.to_path_buf(),
                limit,
            }));
            let _ = respond_to.send(result);
        }
        RepoRequest::Obslog {
            change_id,
            limit,
            respond_to,
        } => {
            let result = futures_executor::block_on(backend.obslog(ObslogQuery {
                cwd: workspace_root.to_path_buf(),
                change_id,
                limit,
            }));
            let _ = respond_to.send(result);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_limits_and_revsets() {
        assert_eq!(
            LogParams {
                limit: Some(0),
                revset: Some("  @  ".to_string()),
            }
            .limit(),
            1
        );
        assert_eq!(
            LogParams {
                limit: Some(usize::MAX),
                revset: None,
            }
            .limit(),
            MAX_LOG_LIMIT
        );
        assert_eq!(
            normalize_revset(Some("  @  ".to_string())),
            Some("@".to_string())
        );
        assert_eq!(normalize_revset(Some("   ".to_string())), None);
        assert_eq!(
            LayoutParams::default().mode().unwrap(),
            LayoutMode::Mainline
        );
        assert!(LayoutParams {
            mode: Some("sideways".to_string()),
            ..LayoutParams::default()
        }
        .mode()
        .is_err());
    }
}
