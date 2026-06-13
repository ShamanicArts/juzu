//! Native JJ backend crate for the Rust JUZU port.
//!
//! Shell-out fallback belongs in an explicit `cli_fallback` module only. Repo
//! discovery/opening is wired through `jj-lib` here so future log/diff/mutation
//! slices have a real native backend anchor.

use async_trait::async_trait;
use jj_lib::config::StackedConfig;
use jj_lib::repo::StoreFactories;
use jj_lib::settings::UserSettings;
use jj_lib::workspace::{default_working_copy_factories, Workspace};
use juzu_core::{
    ChangeQuery, CommitNode, FileEntry, JjBackend, JuzuError, LogQuery, Mutation, MutationResult,
    NodeCountQuery, ObslogEntry, ObslogQuery, OpLogEntry, OpLogQuery, Result,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspaceInfo {
    pub workspace_root: PathBuf,
    pub repo_path: PathBuf,
    pub workspace_name: String,
}

#[derive(Debug, Clone, Default)]
pub struct NativeJjBackend;

impl NativeJjBackend {
    pub fn new() -> Self {
        Self
    }

    pub fn open_workspace_info(&self, start: &Path) -> Result<NativeWorkspaceInfo> {
        let workspace_root = self
            .find_root_blocking(start)
            .ok_or_else(|| JuzuError::RepoNotFound(start.to_path_buf()))?;
        let config = StackedConfig::with_defaults();
        let settings = UserSettings::from_config(config)
            .map_err(|err| JuzuError::Backend(format!("failed to load jj user settings: {err}")))?;
        let store_factories = StoreFactories::default();
        let working_copy_factories = default_working_copy_factories();
        let workspace = Workspace::load(
            &settings,
            &workspace_root,
            &store_factories,
            &working_copy_factories,
        )
        .map_err(|err| JuzuError::Backend(format!("failed to open jj workspace: {err}")))?;
        Ok(NativeWorkspaceInfo {
            workspace_root: workspace.workspace_root().to_path_buf(),
            repo_path: workspace.repo_path().to_path_buf(),
            workspace_name: workspace.workspace_name().as_str().to_string(),
        })
    }

    fn find_root_blocking(&self, start: &Path) -> Option<PathBuf> {
        let mut cursor = if start.is_file() {
            start.parent().unwrap_or(start).to_path_buf()
        } else {
            start.to_path_buf()
        };
        loop {
            if cursor.join(".jj").is_dir() {
                return Some(cursor);
            }
            if !cursor.pop() {
                return None;
            }
        }
    }
}

#[async_trait]
impl JjBackend for NativeJjBackend {
    async fn find_root(&self, start: &Path) -> Result<Option<PathBuf>> {
        Ok(self.find_root_blocking(start))
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

    #[test]
    fn opens_current_workspace_with_jj_lib() {
        let backend = NativeJjBackend::new();
        let info = backend
            .open_workspace_info(Path::new(env!("CARGO_MANIFEST_DIR")))
            .unwrap();
        assert!(info.workspace_root.ends_with("juzu"));
        assert!(info.repo_path.ends_with(".jj/repo"));
    }
}
