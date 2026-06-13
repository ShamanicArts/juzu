use super::model::{DiffDocument, DiffLine, DiffLineKind, DiffRow, DiffRowKind};
use super::window::iter_diff_rows;

pub fn collapsed_diff_rows(document: &DiffDocument, context_radius: usize) -> Vec<DiffRow> {
    let mut rows = Vec::new();
    for (file_index, file) in document.files.iter().enumerate() {
        let header_doc = DiffDocument {
            files: vec![file.clone()],
        };
        for row in iter_diff_rows(&header_doc).into_iter().filter(|row| {
            !matches!(
                row.kind,
                DiffRowKind::Context | DiffRowKind::Add | DiffRowKind::Remove
            )
        }) {
            rows.push(DiffRow { file_index, ..row });
        }
        for (hunk_index, hunk) in file.hunks.iter().enumerate() {
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
