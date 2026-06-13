use super::model::{DiffDocument, DiffFile, DiffFileKind, DiffHunk, DiffLine, DiffLineKind};
use crate::{JuzuError, Result};

pub fn parse_git_patch(text: &str) -> Result<DiffDocument> {
    let mut files: Vec<DiffFile> = Vec::new();
    let mut current_file: Option<DiffFile> = None;
    let mut current_hunk: Option<DiffHunk> = None;
    let mut old_cursor = 0usize;
    let mut new_cursor = 0usize;

    for raw_line in text.lines() {
        if raw_line.starts_with("diff --git ") {
            flush_hunk(&mut current_file, &mut current_hunk);
            if let Some(file) = current_file.take() {
                files.push(file);
            }
            current_file = Some(parse_diff_git_header(raw_line));
            continue;
        }

        let Some(file) = current_file.as_mut() else {
            if raw_line.trim().is_empty() {
                continue;
            }
            return Err(JuzuError::Backend(format!(
                "diff parser saw content before file header: {raw_line}"
            )));
        };

        if raw_line.starts_with("@@ ") {
            flush_hunk(&mut current_file, &mut current_hunk);
            let hunk = parse_hunk_header(raw_line)?;
            old_cursor = hunk.old_start;
            new_cursor = hunk.new_start;
            current_hunk = Some(hunk);
            continue;
        }

        if raw_line == r"\ No newline at end of file" {
            if let Some(hunk) = current_hunk.as_mut() {
                if let Some(last) = hunk.lines.last_mut() {
                    last.no_newline_marker = true;
                }
            } else {
                file.metadata.push(raw_line.to_string());
            }
            continue;
        }

        if let Some(hunk) = current_hunk.as_mut() {
            if let Some(stripped) = raw_line.strip_prefix('+') {
                if raw_line.starts_with("+++") {
                    file.metadata.push(raw_line.to_string());
                    continue;
                }
                hunk.lines.push(DiffLine {
                    kind: DiffLineKind::Add,
                    old_line: None,
                    new_line: Some(new_cursor),
                    content: stripped.to_string(),
                    no_newline_marker: false,
                });
                new_cursor += 1;
            } else if let Some(stripped) = raw_line.strip_prefix('-') {
                if raw_line.starts_with("---") {
                    file.metadata.push(raw_line.to_string());
                    continue;
                }
                hunk.lines.push(DiffLine {
                    kind: DiffLineKind::Remove,
                    old_line: Some(old_cursor),
                    new_line: None,
                    content: stripped.to_string(),
                    no_newline_marker: false,
                });
                old_cursor += 1;
            } else {
                let stripped = raw_line.strip_prefix(' ').unwrap_or(raw_line);
                hunk.lines.push(DiffLine {
                    kind: DiffLineKind::Context,
                    old_line: Some(old_cursor),
                    new_line: Some(new_cursor),
                    content: stripped.to_string(),
                    no_newline_marker: false,
                });
                old_cursor += 1;
                new_cursor += 1;
            }
            continue;
        }

        parse_file_metadata(file, raw_line);
    }

    flush_hunk(&mut current_file, &mut current_hunk);
    if let Some(file) = current_file.take() {
        files.push(file);
    }
    Ok(DiffDocument { files })
}

fn flush_hunk(file: &mut Option<DiffFile>, hunk: &mut Option<DiffHunk>) {
    if let (Some(file), Some(hunk)) = (file.as_mut(), hunk.take()) {
        file.hunks.push(hunk);
    }
}

fn parse_diff_git_header(line: &str) -> DiffFile {
    let mut pieces = line.split_whitespace();
    let _diff = pieces.next();
    let _git = pieces.next();
    let old_path = pieces.next().map(strip_ab_prefix);
    let new_path = pieces.next().map(strip_ab_prefix);
    DiffFile {
        old_path,
        new_path,
        kind: DiffFileKind::Modified,
        metadata: vec![line.to_string()],
        hunks: Vec::new(),
    }
}

fn strip_ab_prefix(path: &str) -> String {
    path.strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(path)
        .to_string()
}

fn parse_hunk_header(line: &str) -> Result<DiffHunk> {
    let mut parts = line.split_whitespace();
    let _at = parts.next();
    let old_part = parts
        .next()
        .ok_or_else(|| JuzuError::Backend(format!("invalid hunk header: {line}")))?;
    let new_part = parts
        .next()
        .ok_or_else(|| JuzuError::Backend(format!("invalid hunk header: {line}")))?;
    let (old_start, old_count) = parse_range(old_part.trim_start_matches('-'))?;
    let (new_start, new_count) = parse_range(new_part.trim_start_matches('+'))?;
    Ok(DiffHunk {
        old_start,
        old_count,
        new_start,
        new_count,
        header: line.to_string(),
        lines: Vec::new(),
    })
}

fn parse_range(raw: &str) -> Result<(usize, usize)> {
    let mut parts = raw.split(',');
    let start = parts
        .next()
        .and_then(|s| s.parse::<usize>().ok())
        .ok_or_else(|| JuzuError::Backend(format!("invalid diff range: {raw}")))?;
    let count = parts
        .next()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(1);
    Ok((start, count))
}

fn parse_file_metadata(file: &mut DiffFile, line: &str) {
    if line == "new file mode 100644" || line.starts_with("new file mode ") {
        file.kind = DiffFileKind::Added;
    } else if line == "deleted file mode 100644" || line.starts_with("deleted file mode ") {
        file.kind = DiffFileKind::Deleted;
    } else if let Some(path) = line.strip_prefix("rename from ") {
        file.kind = DiffFileKind::Renamed;
        file.old_path = Some(path.to_string());
    } else if let Some(path) = line.strip_prefix("rename to ") {
        file.kind = DiffFileKind::Renamed;
        file.new_path = Some(path.to_string());
    } else if line.starts_with("copy from ") || line.starts_with("copy to ") {
        file.kind = DiffFileKind::Copied;
    } else if let Some(path) = line.strip_prefix("--- ") {
        if path != "/dev/null" {
            file.old_path = Some(strip_ab_prefix(path));
        }
    } else if let Some(path) = line.strip_prefix("+++ ") {
        if path != "/dev/null" {
            file.new_path = Some(strip_ab_prefix(path));
        }
    }
    file.metadata.push(line.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::model::{DiffFileKind, DiffLineKind};

    #[test]
    fn parses_modified_file() {
        let doc = parse_git_patch("diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-old\n+new\n").unwrap();
        assert_eq!(doc.files.len(), 1);
        assert_eq!(doc.files[0].kind, DiffFileKind::Modified);
        assert_eq!(doc.files[0].hunks[0].lines.len(), 3);
        assert_eq!(doc.files[0].hunks[0].lines[1].kind, DiffLineKind::Remove);
        assert_eq!(doc.files[0].hunks[0].lines[2].new_line, Some(2));
    }

    #[test]
    fn parses_new_and_deleted_files() {
        let doc = parse_git_patch("diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hi\ndiff --git a/dead.txt b/dead.txt\ndeleted file mode 100644\n--- a/dead.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n").unwrap();
        assert_eq!(doc.files[0].kind, DiffFileKind::Added);
        assert_eq!(doc.files[1].kind, DiffFileKind::Deleted);
    }

    #[test]
    fn preserves_no_newline_marker() {
        let doc = parse_git_patch("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n").unwrap();
        assert!(
            doc.files[0].hunks[0]
                .lines
                .last()
                .unwrap()
                .no_newline_marker
        );
    }

    #[test]
    fn parses_rename_metadata() {
        let doc = parse_git_patch("diff --git a/old b/new\nrename from old\nrename to new\n--- a/old\n+++ b/new\n@@ -1 +1 @@\n-sad\n+glad\n").unwrap();
        assert_eq!(doc.files[0].kind, DiffFileKind::Renamed);
        assert_eq!(doc.files[0].old_path.as_deref(), Some("old"));
        assert_eq!(doc.files[0].new_path.as_deref(), Some("new"));
    }
}
