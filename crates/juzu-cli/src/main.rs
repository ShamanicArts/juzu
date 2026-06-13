use anyhow::Result;
use juzu_core::{layout::calculate_default_layout, ChangeQuery, JjBackend, LayoutMode, LogQuery};
use juzu_jj::NativeJjBackend;
use serde_json::json;
use std::path::PathBuf;

fn print_help() {
    println!(
        "juzu-cli (Rust scaffold)\n\n\
Usage:\n  juzu-cli --version\n  juzu-cli repo [--path <path>]\n  juzu-cli snapshot [--path <path>] [--limit <n>]\n  juzu-cli layout [--path <path>] [--limit <n>] [--mode <mode>]\n  juzu-cli files [--path <path>] --change <id>\n  juzu-cli diff [--path <path>] --change <id>\n\n\
Commands:\n  repo       Resolve the JJ repo root using the scaffold backend.\n  snapshot   Emit Rust/native snapshot parity JSON.\n  layout     Emit Rust/core graph layout parity JSON.\n  files      Emit native jj diff --summary-style files for one change.\n  diff       Emit native jj git-style diff for one change.\n"
    );
}

fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.windows(2).find_map(|pair| {
        if pair[0] == key {
            Some(pair[1].clone())
        } else {
            None
        }
    })
}

fn parse_layout_mode(raw: Option<String>) -> LayoutMode {
    match raw.as_deref() {
        Some("mainline") => LayoutMode::Mainline,
        Some("bookmark-centric") => LayoutMode::BookmarkCentric,
        Some("wc-focused") => LayoutMode::WcFocused,
        Some("topological") => LayoutMode::Topological,
        _ => LayoutMode::Chronological,
    }
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        print_help();
        return Ok(());
    }
    if args[0] == "--version" || args[0] == "version" {
        println!("juzu-cli {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    match args[0].as_str() {
        "repo" => {
            let path = arg_value(&args, "--path")
                .map(PathBuf::from)
                .unwrap_or(std::env::current_dir()?);
            let backend = NativeJjBackend::new();
            let info = backend.open_workspace_info(&path)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "schemaVersion": 1,
                    "command": "repo",
                    "path": path,
                    "repoRoot": info.workspace_root,
                    "workspaceRoot": info.workspace_root,
                    "repoPath": info.repo_path,
                    "workspaceName": info.workspace_name,
                    "backend": "jj-lib",
                }))?
            );
            Ok(())
        }
        "files" | "diff" => {
            let command = args[0].as_str();
            let path = arg_value(&args, "--path")
                .map(PathBuf::from)
                .unwrap_or(std::env::current_dir()?);
            let Some(change_id) = arg_value(&args, "--change") else {
                anyhow::bail!("{command} requires --change <id>");
            };
            let backend = NativeJjBackend::new();
            if command == "diff" {
                let diff = futures_executor::block_on(backend.diff(ChangeQuery {
                    cwd: path.clone(),
                    change_id: change_id.clone(),
                }))?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "schemaVersion": 1,
                        "command": "diff",
                        "backend": "jj-lib",
                        "path": path,
                        "changeId": change_id,
                        "diff": diff,
                    }))?
                );
                return Ok(());
            }
            let files = futures_executor::block_on(backend.files(ChangeQuery {
                cwd: path.clone(),
                change_id: change_id.clone(),
            }))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "schemaVersion": 1,
                    "command": "files",
                    "backend": "jj-lib",
                    "path": path,
                    "changeId": change_id,
                    "files": files,
                }))?
            );
            Ok(())
        }
        "snapshot" | "layout" => {
            let command = args[0].as_str();
            let path = arg_value(&args, "--path")
                .map(PathBuf::from)
                .unwrap_or(std::env::current_dir()?);
            let limit = arg_value(&args, "--limit")
                .and_then(|raw| raw.parse::<usize>().ok())
                .unwrap_or(50);
            let backend = NativeJjBackend::new();
            let nodes = futures_executor::block_on(backend.log(LogQuery {
                cwd: path.clone(),
                limit,
                revset: None,
            }))?;
            if command == "layout" {
                let mode = parse_layout_mode(arg_value(&args, "--mode"));
                let layout = calculate_default_layout(mode, &nodes);
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "schemaVersion": 1,
                        "command": "layout",
                        "backend": "juzu-core",
                        "path": path,
                        "limit": limit,
                        "mode": mode,
                        "layout": {
                            "maxLane": layout.max_lane,
                            "textColumnX": layout.text_column_x,
                            "totalHeight": layout.total_height,
                        },
                        "nodes": layout.nodes.into_iter().map(|node| json!({
                            "changeId": node.change_id,
                            "commitId": node.commit_id,
                            "parents": node.parents,
                            "lane": node.lane,
                            "x": node.x,
                            "y": node.y,
                            "isPinned": node.is_pinned,
                        })).collect::<Vec<_>>(),
                    }))?
                );
                return Ok(());
            }
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "schemaVersion": 1,
                    "command": "snapshot",
                    "backend": "jj-lib",
                    "path": path,
                    "limit": limit,
                    "returnedNodes": nodes.len(),
                    "nodes": nodes,
                }))?
            );
            Ok(())
        }
        _ => {
            print_help();
            Ok(())
        }
    }
}
