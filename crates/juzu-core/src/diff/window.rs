use super::model::{DiffDocument, DiffLineKind, DiffRow, DiffRowKind};

pub fn iter_diff_rows(document: &DiffDocument) -> Vec<DiffRow> {
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
            text: format!("{:?} {path}", file.kind),
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
            for line in &hunk.lines {
                let (kind, prefix) = match line.kind {
                    DiffLineKind::Context => (DiffRowKind::Context, " "),
                    DiffLineKind::Add => (DiffRowKind::Add, "+"),
                    DiffLineKind::Remove => (DiffRowKind::Remove, "-"),
                };
                rows.push(DiffRow {
                    kind,
                    file_index,
                    hunk_index: Some(hunk_index),
                    old_line: line.old_line,
                    new_line: line.new_line,
                    text: format!("{prefix}{}", line.content),
                });
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
        }
    }
    rows
}

pub fn diff_window_rows(document: &DiffDocument, offset: usize, height: usize) -> Vec<DiffRow> {
    iter_diff_rows(document)
        .into_iter()
        .skip(offset)
        .take(height)
        .collect()
}
