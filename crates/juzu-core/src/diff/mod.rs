pub mod collapse;
pub mod model;
pub mod parse;
pub mod window;

pub use collapse::collapsed_diff_rows;
pub use model::{
    DiffDocument, DiffFile, DiffFileKind, DiffHunk, DiffLine, DiffLineKind, DiffRow, DiffRowKind,
};
pub use parse::parse_git_patch;
pub use window::{diff_window_rows, iter_diff_rows};
