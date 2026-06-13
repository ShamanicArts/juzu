//! Native JJ backend crate for the Rust JUZU port.
//!
//! This scaffold intentionally exposes the backend boundary before binding to
//! `jj-lib`/`jj-cli`. The next slice wires repo-open through native JJ crates;
//! shell-out fallback belongs in an explicit `cli_fallback` module only.

use async_trait::async_trait;
use juzu_core::{
    ChangeQuery, CommitNode, FileEntry, JjBackend, JuzuError, LogQuery, Mutation, MutationResult,
    NodeCountQuery, ObslogEntry, ObslogQuery, OpLogEntry, OpLogQuery, Result,
};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default)]
pub struct NativeJjBackend;

impl NativeJjBackend {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl JjBackend for NativeJjBackend {
    async fn find_root(&self, start: &Path) -> Result<Option<PathBuf>> {
        let mut cursor = if start.is_file() {
            start.parent().unwrap_or(start).to_path_buf()
        } else {
            start.to_path_buf()
        };
        loop {
            if cursor.join(".jj").is_dir() {
                return Ok(Some(cursor));
            }
            if !cursor.pop() {
                return Ok(None);
            }
        }
    }

    async fn log(&self, _query: LogQuery) -> Result<Vec<CommitNode>> {
        Err(JuzuError::Unsupported("native jj log is not wired yet"))
    }

    async fn node_count(&self, _query: NodeCountQuery) -> Result<usize> {
        Err(JuzuError::Unsupported(
            "native jj node_count is not wired yet",
        ))
    }

    async fn description(&self, _query: ChangeQuery) -> Result<String> {
        Err(JuzuError::Unsupported(
            "native jj description is not wired yet",
        ))
    }

    async fn files(&self, _query: ChangeQuery) -> Result<Vec<FileEntry>> {
        Err(JuzuError::Unsupported("native jj files is not wired yet"))
    }

    async fn diff(&self, _query: ChangeQuery) -> Result<String> {
        Err(JuzuError::Unsupported("native jj diff is not wired yet"))
    }

    async fn op_log(&self, _query: OpLogQuery) -> Result<Vec<OpLogEntry>> {
        Err(JuzuError::Unsupported("native jj op_log is not wired yet"))
    }

    async fn obslog(&self, _query: ObslogQuery) -> Result<Vec<ObslogEntry>> {
        Err(JuzuError::Unsupported("native jj obslog is not wired yet"))
    }

    async fn mutate(&self, _mutation: Mutation) -> Result<MutationResult> {
        Err(JuzuError::Unsupported(
            "native jj mutations are not wired yet",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_constructs() {
        let _backend = NativeJjBackend::new();
    }
}
