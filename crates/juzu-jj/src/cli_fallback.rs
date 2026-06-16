use juzu_core::{JuzuError, ObslogEntry, OpLogEntry, Result};
use std::path::Path;
use std::process::Command;

const OP_LOG_TEMPLATE: &str =
    "id.short() ++ \"\x01\" ++ time ++ \"\x01\" ++ description.first_line() ++ \"\x01\" ++ user ++ \"\n\x01<JJ-OP-SEP>\x01\n\"";
const OBSLOG_TEMPLATE: &str =
    "commit.change_id().short() ++ \"\x01\" ++ commit.commit_id().short() ++ \"\x01\" ++ commit.author().timestamp() ++ \"\x01\" ++ commit.description().first_line() ++ \"\n\x01<JJ-OBS-SEP>\x01\n\"";

fn run_jj(cwd: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("jj")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|err| JuzuError::Backend(format!("failed to spawn jj cli fallback: {err}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!(
                "jj cli fallback failed with status {} for args {:?}",
                output.status, args
            )
        } else {
            stderr
        };
        return Err(JuzuError::Backend(msg));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub fn fetch_op_log(cwd: &Path, limit: usize) -> Result<Vec<OpLogEntry>> {
    let text = run_jj(
        cwd,
        &[
            "op",
            "log",
            "--no-graph",
            "--limit",
            &limit.to_string(),
            "-T",
            OP_LOG_TEMPLATE,
        ],
    )?;
    Ok(text
        .split("\x01<JJ-OP-SEP>\x01")
        .map(str::trim)
        .filter(|block| !block.is_empty())
        .filter_map(|block| {
            let parts: Vec<_> = block.split('\x01').collect();
            if parts.len() < 4 {
                return None;
            }
            Some(OpLogEntry {
                id: parts[0].trim().to_string(),
                time: parts[1].trim().to_string(),
                description: parts[2].trim().to_string(),
                user: parts[3].trim().to_string(),
            })
        })
        .collect())
}

pub fn fetch_obslog(cwd: &Path, change_id: &str, limit: usize) -> Result<Vec<ObslogEntry>> {
    let text = run_jj(
        cwd,
        &[
            "obslog",
            "--no-graph",
            "-r",
            change_id,
            "--limit",
            &limit.to_string(),
            "-T",
            OBSLOG_TEMPLATE,
        ],
    )?;
    Ok(text
        .split("\x01<JJ-OBS-SEP>\x01")
        .map(str::trim)
        .filter(|block| !block.is_empty())
        .filter_map(|block| {
            let parts: Vec<_> = block.split('\x01').collect();
            if parts.len() < 4 {
                return None;
            }
            Some(ObslogEntry {
                change_id: parts[0].trim().to_string(),
                commit_id: parts[1].trim().to_string(),
                time: parts[2].trim().to_string(),
                description_title: parts[3].trim().to_string(),
            })
        })
        .collect())
}
