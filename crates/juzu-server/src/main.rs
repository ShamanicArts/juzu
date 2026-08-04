use anyhow::{bail, Context, Result};
use juzu_server::{router, ServerState};
use std::{net::Ipv4Addr, path::PathBuf, time::Duration};

fn print_help() {
    println!(
        "juzu-server {}\n\n\
Local read-only web server for Juzu.\n\n\
Usage:\n  juzu-server [OPTIONS]\n\n\
Options:\n  --path <PATH>    JJ workspace to serve (default: current directory)\n  --port <PORT>    Local port (default: 3000)\n  -h, --help       Print help\n  -V, --version    Print version",
        env!("CARGO_PKG_VERSION")
    );
}

fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .find_map(|arg| arg.strip_prefix(&format!("{key}=")).map(str::to_string))
        .or_else(|| {
            args.windows(2)
                .find_map(|pair| (pair[0] == key).then(|| pair[1].clone()))
        })
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_help();
        return Ok(());
    }
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        println!("juzu-server {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    let path = arg_value(&args, "--path")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    let port = arg_value(&args, "--port")
        .map(|value| value.parse::<u16>())
        .transpose()
        .context("--port must be an integer between 1 and 65535")?
        .unwrap_or(3000);
    if port == 0 {
        bail!("--port must be between 1 and 65535");
    }

    let state = ServerState::new(&path)
        .with_context(|| format!("failed to open JJ workspace from {}", path.display()))?;
    let watcher = state.spawn_repository_watcher(Duration::from_millis(500));
    let address = (Ipv4Addr::LOCALHOST, port);
    let listener = tokio::net::TcpListener::bind(address).await?;

    println!("Juzu Web: http://{}:{}", address.0, address.1);
    println!("Workspace: {}", state.workspace_root().display());
    println!("Mode: read-only");

    let shutdown_state = state.clone();
    let result = axum::serve(listener, router(state))
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            shutdown_state.shutdown();
        })
        .await;
    watcher.abort();
    result.context("web server failed")
}
