use super::model::{DiffDocument, DiffFileKind, DiffLine, DiffLineKind, DiffRow, DiffRowKind};

pub fn collapsed_diff_rows(document: &DiffDocument, context_radius: usize) -> Vec<DiffRow> {
    let mut rows = Vec::new();
    for (file_index, file) in document.files.iter().enumerate() {
        let path = file
            .new_path
            .as_deref()
            .or(file.old_path.as_deref())
            .unwrap_or("<unknown>");
        rows.push(DiffRow {
            kind: DiffRowKind::FileHeader,
            file_index,
            hunk_index: None,
            old_line: None,
            new_line: None,
            text: format!("{} {path}", file_kind_label(file.kind)),
        });
        for metadata in &file.metadata {
            rows.push(DiffRow {
                kind: DiffRowKind::Metadata,
                file_index,
                hunk_index: None,
                old_line: None,
                new_line: None,
                text: metadata.clone(),
            });
        }
        for (hunk_index, hunk) in file.hunks.iter().enumerate() {
            rows.push(DiffRow {
                kind: DiffRowKind::HunkHeader,
                file_index,
                hunk_index: Some(hunk_index),
                old_line: None,
                new_line: None,
                text: hunk.header.clone(),
            });
            let mut visible = vec![false; hunk.lines.len()];
            for (idx, line) in hunk.lines.iter().enumerate() {
                if line.kind != DiffLineKind::Context {
                    let start = idx.saturating_sub(context_radius);
                    let end = (idx + context_radius + 1).min(hunk.lines.len());
                    for slot in visible.iter_mut().take(end).skip(start) {
                        *slot = true;
                    }
                }
            }
            let mut collapsed = 0usize;
            for (idx, line) in hunk.lines.iter().enumerate() {
                if !visible[idx] {
                    collapsed += 1;
                    continue;
                }
                if collapsed > 0 {
                    rows.push(DiffRow {
                        kind: DiffRowKind::Collapse,
                        file_index,
                        hunk_index: Some(hunk_index),
                        old_line: None,
                        new_line: None,
                        text: format!("⋯ {collapsed} unchanged lines collapsed"),
                    });
                    collapsed = 0;
                }
                rows.push(row_for_line(file_index, hunk_index, line));
                if line.no_newline_marker {
                    rows.push(DiffRow {
                        kind: DiffRowKind::Metadata,
                        file_index,
                        hunk_index: Some(hunk_index),
                        old_line: None,
                        new_line: None,
                        text: r"\ No newline at end of file".to_string(),
                    });
                }
            }
            if collapsed > 0 {
                rows.push(DiffRow {
                    kind: DiffRowKind::Collapse,
                    file_index,
                    hunk_index: Some(hunk_index),
                    old_line: None,
                    new_line: None,
                    text: format!("⋯ {collapsed} unchanged lines collapsed"),
                });
            }
        }
    }
    rows
}

fn row_for_line(file_index: usize, hunk_index: usize, line: &DiffLine) -> DiffRow {
    let (kind, prefix) = match line.kind {
        DiffLineKind::Context => (DiffRowKind::Context, " "),
        DiffLineKind::Add => (DiffRowKind::Add, "+"),
        DiffLineKind::Remove => (DiffRowKind::Remove, "-"),
    };
    DiffRow {
        kind,
        file_index,
        hunk_index: Some(hunk_index),
        old_line: line.old_line,
        new_line: line.new_line,
        text: format!("{prefix}{}", line.content),
    }
}

fn file_kind_label(kind: DiffFileKind) -> &'static str {
    match kind {
        DiffFileKind::Modified => "Modified",
        DiffFileKind::Added => "Added",
        DiffFileKind::Deleted => "Deleted",
        DiffFileKind::Renamed => "Renamed",
        DiffFileKind::Copied => "Copied",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::parse_git_patch;

    #[test]
    fn collapsed_rows_preserve_hunk_order() {
        let doc = parse_git_patch("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,7 +1,7 @@\n a\n b\n c\n-old\n+new\n d\n e\n").unwrap();
        let rows = collapsed_diff_rows(&doc, 1);
        let hunk_pos = rows
            .iter()
            .position(|row| row.kind == DiffRowKind::HunkHeader)
            .unwrap();
        let remove_pos = rows
            .iter()
            .position(|row| row.kind == DiffRowKind::Remove)
            .unwrap();
        assert!(hunk_pos < remove_pos);
        assert!(rows.iter().any(|row| row.kind == DiffRowKind::Collapse));
    }
}
