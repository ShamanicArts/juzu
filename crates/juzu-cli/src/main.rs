use anyhow::Result;
use juzu_core::JjBackend;
use juzu_jj::NativeJjBackend;
use serde_json::json;
use std::path::PathBuf;

fn print_help() {
    println!(
        "juzu-cli (Rust scaffold)\n\n\
Usage:\n  juzu-cli --version\n  juzu-cli repo [--path <path>]\n  juzu-cli snapshot --help\n\n\
Commands:\n  repo       Resolve the JJ repo root using the scaffold backend.\n  snapshot   Reserved for Rust/old-oracle parity output.\n"
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
            let root = futures_executor::block_on(backend.find_root(&path))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "schemaVersion": 1,
                    "command": "repo",
                    "path": path,
                    "repoRoot": root,
                }))?
            );
            Ok(())
        }
        "snapshot" => {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "schemaVersion": 1,
                    "command": "snapshot",
                    "status": "reserved",
                    "message": "Rust snapshot parity emitter will land after native jj log wiring"
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
