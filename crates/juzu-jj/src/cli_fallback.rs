use juzu_core::{JuzuError, ObslogEntry, OpLogEntry, Result};
use std::path::Path;
use std::process::Command;

const OP_LOG_TEMPLATE: &str =
    "id.short() ++ \"\x01\" ++ id.short(8) ++ \"\x01\" ++ time ++ \"\x01\" ++ time.duration() ++ \"\x01\" ++ tags ++ \"\x01\" ++ description.first_line() ++ \"\x01\" ++ description ++ \"\x01\" ++ current_operation ++ \"\x01\" ++ user ++ \"\n\x01<JJ-OP-SEP>\x01\n\"";
const OBSLOG_TEMPLATE: &str =
    "commit.change_id().short() ++ \"\x01\" ++ commit.commit_id().short() ++ \"\x01\" ++ operation.id().short() ++ \"\x01\" ++ operation.description().first_line() ++ \"\x01\" ++ operation.description() ++ \"\x01\" ++ operation.user() ++ \"\x01\" ++ operation.time().duration() ++ \"\x01\" ++ operation.tags() ++ \"\x01\" ++ commit.author().timestamp() ++ \"\x01\" ++ commit.author().email() ++ \"\x01\" ++ commit.hidden() ++ \"\x01\" ++ commit.description().first_line() ++ \"\x01\" ++ commit.description() ++ \"\x01\" ++ commit.empty() ++ \"\x01\" ++ commit.conflict() ++ \"\n\x01<JJ-OBS-SEP>\x01\n\"";

fn run_jj_command(cwd: &Path, command: &mut Command, debug_args: String) -> Result<String> {
    let output = command
        .current_dir(cwd)
        .output()
        .map_err(|err| JuzuError::Backend(format!("failed to spawn jj cli fallback: {err}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!(
                "jj cli fallback failed with status {} for args {}",
                output.status, debug_args
            )
        } else {
            stderr
        };
        return Err(JuzuError::Backend(msg));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn run_jj(cwd: &Path, args: &[&str]) -> Result<String> {
    let mut command = Command::new("jj");
    command.args(args);
    run_jj_command(cwd, &mut command, format!("{:?}", args))
}

fn run_jj_owned(cwd: &Path, args: &[String]) -> Result<String> {
    let mut command = Command::new("jj");
    command.args(args);
    run_jj_command(cwd, &mut command, format!("{:?}", args))
}

fn parse_multiline_field(raw: &str) -> Vec<String> {
    raw.split('\n')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn parse_op_log_text(text: &str) -> Vec<OpLogEntry> {
    text.split("\x01<JJ-OP-SEP>\x01")
        .map(str::trim)
        .filter(|block| !block.is_empty())
        .filter_map(|block| {
            let parts: Vec<_> = block.split('\x01').collect();
            if parts.len() < 9 {
                return None;
            }
            Some(OpLogEntry {
                id: parts[0].trim().to_string(),
                short_id: parts[1].trim().to_string(),
                time: parts[2].trim().to_string(),
                duration: parts[3].trim().to_string(),
                tags: parse_multiline_field(parts[4]),
                description_title: parts[5].trim().to_string(),
                description_full: parts[6].trim().to_string(),
                is_current: parts[7].trim() == "true",
                user: parts[8].trim().to_string(),
            })
        })
        .collect()
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
    Ok(parse_op_log_text(&text))
}

fn parse_obslog_text(text: &str, wc_id: &str) -> Vec<ObslogEntry> {
    text.split("\x01<JJ-OBS-SEP>\x01")
        .map(str::trim)
        .filter(|block| !block.is_empty())
        .filter_map(|block| {
            let parts: Vec<_> = block.split('\x01').collect();
            if parts.len() < 15 {
                return None;
            }
            let change_id = parts[0].trim().to_string();
            Some(ObslogEntry {
                change_id: change_id.clone(),
                commit_id: parts[1].trim().to_string(),
                operation_id: parts[2].trim().to_string(),
                operation_description: parts[3].trim().to_string(),
                operation_description_full: parts[4].trim().to_string(),
                operation_user: parts[5].trim().to_string(),
                operation_duration: parts[6].trim().to_string(),
                operation_tags: parse_multiline_field(parts[7]),
                time: parts[8].trim().to_string(),
                author: parts[9].trim().to_string(),
                bookmarks: Vec::new(),
                description_title: parts[11].trim().to_string(),
                description_full: parts[12].trim().to_string(),
                is_working_copy: change_id == wc_id,
                is_empty: parts[13].trim() == "true",
                is_conflict: parts[14].trim() == "true",
                is_hidden: parts[10].trim() == "true",
            })
        })
        .collect()
}

pub fn fetch_obslog(cwd: &Path, change_id: &str, limit: usize) -> Result<Vec<ObslogEntry>> {
    let wc_id = run_jj(
        cwd,
        &["log", "--no-graph", "-r", "@", "-T", "change_id.short()"],
    )?
    .trim()
    .to_string();
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
    Ok(parse_obslog_text(&text, &wc_id))
}

pub fn new_change(cwd: &Path, parent_id: Option<&str>, parent_ids: &[String]) -> Result<()> {
    let mut args = vec!["new".to_string()];
    if !parent_ids.is_empty() {
        args.extend(parent_ids.iter().cloned());
    } else if let Some(parent_id) = parent_id {
        args.push(parent_id.to_string());
    }
    run_jj_owned(cwd, &args).map(|_| ())
}

pub fn edit(cwd: &Path, change_id: &str) -> Result<()> {
    run_jj(cwd, &["edit", change_id]).map(|_| ())
}

pub fn describe(cwd: &Path, change_id: &str, description: &str) -> Result<()> {
    run_jj(cwd, &["describe", "-r", change_id, "-m", description]).map(|_| ())
}

pub fn rebase(cwd: &Path, source_id: &str, destination_id: &str) -> Result<()> {
    run_jj(cwd, &["rebase", "-r", source_id, "-d", destination_id]).map(|_| ())
}

pub fn insert(cwd: &Path, parent_id: &str, child_id: &str) -> Result<()> {
    run_jj(cwd, &["new", parent_id]).map(|_| ())?;
    run_jj(cwd, &["rebase", "-s", child_id, "-d", "@"]).map(|_| ())
}

pub fn duplicate(cwd: &Path, change_id: &str) -> Result<()> {
    run_jj(cwd, &["duplicate", change_id]).map(|_| ())
}

pub fn abandon(cwd: &Path, change_id: &str) -> Result<()> {
    run_jj(cwd, &["abandon", change_id]).map(|_| ())
}

pub fn squash(cwd: &Path, change_id: &str, into_id: Option<&str>) -> Result<()> {
    let mut args = vec![
        "squash".to_string(),
        "--from".to_string(),
        change_id.to_string(),
        "--use-destination-message".to_string(),
    ];
    if let Some(into_id) = into_id {
        args.push("--into".to_string());
        args.push(into_id.to_string());
    }
    run_jj_owned(cwd, &args).map(|_| ())
}

pub fn restore_operation(cwd: &Path, operation_id: &str) -> Result<()> {
    run_jj(cwd, &["op", "restore", operation_id]).map(|_| ())
}

pub fn bookmark_set(cwd: &Path, name: &str, revision: &str) -> Result<()> {
    run_jj(cwd, &["bookmark", "set", name, "-r", revision]).map(|_| ())
}

pub fn bookmark_delete(cwd: &Path, name: &str) -> Result<()> {
    run_jj(cwd, &["bookmark", "delete", name]).map(|_| ())
}

pub fn undo(cwd: &Path) -> Result<()> {
    run_jj(cwd, &["undo"]).map(|_| ())
}

pub fn redo(cwd: &Path) -> Result<()> {
    run_jj(cwd, &["redo"]).map(|_| ())
}

pub fn git_fetch(cwd: &Path) -> Result<()> {
    run_jj(cwd, &["git", "fetch"]).map(|_| ())
}

pub fn git_push(cwd: &Path, bookmark: Option<&str>) -> Result<()> {
    let mut args = vec!["git".to_string(), "push".to_string()];
    if let Some(bookmark) = bookmark {
        args.push("--bookmark".to_string());
        args.push(bookmark.to_string());
    }
    run_jj_owned(cwd, &args).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::{parse_obslog_text, parse_op_log_text};

    #[test]
    fn parse_op_log_text_preserves_rich_fields() {
        let raw = concat!(
            "abc123\x01abc12345\x012026-06-16 12:00:00 +00:00 - 2026-06-16 12:00:01 +00:00\x011s\x01",
            "args: jj op restore abc12345\ntag: undo\x01",
            "restore operation\x01restore operation\nwith extra detail\x01true\x01alice@example.com\n",
            "\x01<JJ-OP-SEP>\x01\n"
        );

        let entries = parse_op_log_text(raw);
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.id, "abc123");
        assert_eq!(entry.short_id, "abc12345");
        assert_eq!(entry.duration, "1s");
        assert_eq!(
            entry.tags,
            vec!["args: jj op restore abc12345", "tag: undo"]
        );
        assert_eq!(entry.description_title, "restore operation");
        assert_eq!(
            entry.description_full,
            "restore operation\nwith extra detail"
        );
        assert!(entry.is_current);
        assert_eq!(entry.user, "alice@example.com");
    }

    #[test]
    fn parse_obslog_text_preserves_operation_metadata() {
        let raw = concat!(
            "change123\x01commit456\x01op789\x01op title\x01op title\nfull detail\x01alice@example.com\x015m\x01",
            "args: jj squash\ntag: rewrite\x012026-06-16 12:00:00 +00:00\x01bob@example.com\x01false\x01",
            "desc title\x01desc title\nfull body\x01false\x01true\x01false\n",
            "\x01<JJ-OBS-SEP>\x01\n"
        );

        let entries = parse_obslog_text(raw, "change123");
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.change_id, "change123");
        assert_eq!(entry.commit_id, "commit456");
        assert_eq!(entry.operation_id, "op789");
        assert_eq!(entry.operation_description, "op title");
        assert_eq!(entry.operation_description_full, "op title\nfull detail");
        assert_eq!(entry.operation_user, "alice@example.com");
        assert_eq!(entry.operation_duration, "5m");
        assert_eq!(
            entry.operation_tags,
            vec!["args: jj squash", "tag: rewrite"]
        );
        assert_eq!(entry.author, "bob@example.com");
        assert_eq!(entry.description_title, "desc title");
        assert_eq!(entry.description_full, "desc title\nfull body");
        assert!(entry.is_working_copy);
        assert!(!entry.is_empty);
        assert!(entry.is_conflict);
        assert!(!entry.is_hidden);
    }
}
