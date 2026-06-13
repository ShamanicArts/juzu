//! Shared domain core for the Rust JUZU port.
//!
//! This crate intentionally has no terminal, HTTP, or native-JJ dependency. UI and
//! server adapters talk to the outside world through the [`JjBackend`] trait.

pub mod diff;
pub mod layout;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub mod prelude {
    pub use crate::{
        diff::{
            collapsed_diff_rows, diff_window_rows, iter_diff_rows, parse_git_patch, DiffDocument,
            DiffFile, DiffFileKind, DiffHunk, DiffLine, DiffLineKind, DiffRow, DiffRowKind,
        },
        layout::{calculate_default_layout, calculate_layout, GraphLayoutConfig, LayoutResult},
        ChangeQuery, CommitNode, FileEntry, JjBackend, JuzuError, LayoutMode, LogQuery, Mutation,
        MutationResult, NodeCountQuery, ObslogEntry, ObslogQuery, OpLogEntry, OpLogQuery, Result,
    };
}

pub type Result<T> = std::result::Result<T, JuzuError>;

#[derive(Debug, thiserror::Error)]
pub enum JuzuError {
    #[error("jj repository not found from {0}")]
    RepoNotFound(PathBuf),
    #[error("backend operation failed: {0}")]
    Backend(String),
    #[error("unsupported operation in current scaffold: {0}")]
    Unsupported(&'static str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LayoutMode {
    Chronological,
    Mainline,
    BookmarkCentric,
    WcFocused,
    Topological,
}

impl Default for LayoutMode {
    fn default() -> Self {
        Self::Chronological
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitNode {
    pub change_id: String,
    pub commit_id: String,
    pub parents: Vec<String>,
    pub author: String,
    pub time: String,
    pub bookmarks: Vec<String>,
    pub git_branches: Vec<String>,
    pub description_title: String,
    pub description_full: String,
    pub is_empty: bool,
    pub is_conflict: bool,
    pub is_hidden: bool,
    pub is_root: bool,
    pub is_working_copy: bool,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub lane: Option<usize>,
    pub extra_height: Option<i32>,
    pub is_pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub r#type: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpLogEntry {
    pub id: String,
    pub description: String,
    pub user: String,
    pub time: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObslogEntry {
    pub change_id: String,
    pub commit_id: String,
    pub description_title: String,
    pub time: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    pub cwd: PathBuf,
    pub limit: usize,
    pub revset: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeCountQuery {
    pub cwd: PathBuf,
    pub revset: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeQuery {
    pub cwd: PathBuf,
    pub change_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpLogQuery {
    pub cwd: PathBuf,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObslogQuery {
    pub cwd: PathBuf,
    pub change_id: String,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "type")]
pub enum Mutation {
    New {
        cwd: PathBuf,
        parent_id: Option<String>,
        parent_ids: Vec<String>,
    },
    Edit {
        cwd: PathBuf,
        change_id: String,
    },
    Describe {
        cwd: PathBuf,
        change_id: String,
        description: String,
    },
    Abandon {
        cwd: PathBuf,
        change_id: String,
    },
    Duplicate {
        cwd: PathBuf,
        change_id: String,
    },
    Rebase {
        cwd: PathBuf,
        source_id: String,
        destination_id: String,
    },
    Undo {
        cwd: PathBuf,
    },
    Redo {
        cwd: PathBuf,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub changed: bool,
    pub message: String,
}

#[async_trait(?Send)]
pub trait JjBackend: Send + Sync {
    async fn find_root(&self, start: &Path) -> Result<Option<PathBuf>>;
    async fn log(&self, query: LogQuery) -> Result<Vec<CommitNode>>;
    async fn node_count(&self, query: NodeCountQuery) -> Result<usize>;
    async fn description(&self, query: ChangeQuery) -> Result<String>;
    async fn files(&self, query: ChangeQuery) -> Result<Vec<FileEntry>>;
    async fn diff(&self, query: ChangeQuery) -> Result<String>;
    async fn op_log(&self, query: OpLogQuery) -> Result<Vec<OpLogEntry>>;
    async fn obslog(&self, query: ObslogQuery) -> Result<Vec<ObslogEntry>>;
    async fn mutate(&self, mutation: Mutation) -> Result<MutationResult>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_mode_serializes_like_old_oracle() {
        let value = serde_json::to_value(LayoutMode::BookmarkCentric).unwrap();
        assert_eq!(value, "bookmark-centric");
    }
}
