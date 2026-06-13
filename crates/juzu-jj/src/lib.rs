//! Native JJ backend crate for the Rust JUZU port.
//!
//! Shell-out fallback belongs in an explicit `cli_fallback` module only. Repo
//! discovery/opening is wired through `jj-lib` here so future log/diff/mutation
//! slices have a real native backend anchor.

use async_trait::async_trait;
use futures::StreamExt;
use jj_lib::config::StackedConfig;
use jj_lib::object_id::ObjectId;
use jj_lib::repo::{Repo, StoreFactories};
use jj_lib::revset::{RevsetExpression, RevsetStreamExt};
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
        let workspace = self.open_workspace(&workspace_root)?;
        Ok(NativeWorkspaceInfo {
            workspace_root: workspace.workspace_root().to_path_buf(),
            repo_path: workspace.repo_path().to_path_buf(),
            workspace_name: workspace.workspace_name().as_str().to_string(),
        })
    }

    fn open_workspace(&self, workspace_root: &Path) -> Result<Workspace> {
        let config = StackedConfig::with_defaults();
        let settings = UserSettings::from_config(config)
            .map_err(|err| JuzuError::Backend(format!("failed to load jj user settings: {err}")))?;
        let store_factories = StoreFactories::default();
        let working_copy_factories = default_working_copy_factories();
        Workspace::load(
            &settings,
            workspace_root,
            &store_factories,
            &working_copy_factories,
        )
        .map_err(|err| JuzuError::Backend(format!("failed to open jj workspace: {err}")))
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

#[async_trait(?Send)]
impl JjBackend for NativeJjBackend {
    async fn find_root(&self, start: &Path) -> Result<Option<PathBuf>> {
        Ok(self.find_root_blocking(start))
    }

    async fn log(&self, query: LogQuery) -> Result<Vec<CommitNode>> {
        if query.revset.is_some() {
            return Err(JuzuError::Unsupported(
                "custom native jj revset parsing is not wired yet",
            ));
        }
        let workspace_root = self
            .find_root_blocking(&query.cwd)
            .ok_or_else(|| JuzuError::RepoNotFound(query.cwd.clone()))?;
        let workspace = self.open_workspace(&workspace_root)?;
        let repo = workspace
            .repo_loader()
            .load_at_head()
            .await
            .map_err(|err| JuzuError::Backend(format!("failed to load jj repo head: {err}")))?;
        let revset = RevsetExpression::all()
            .evaluate(repo.as_ref())
            .map_err(|err| {
                JuzuError::Backend(format!("failed to evaluate native jj revset: {err}"))
            })?;
        let mut stream = revset.stream().commits(repo.store()).boxed_local();
        let mut nodes = Vec::new();
        while let Some(commit_result) = stream.next().await {
            if nodes.len() >= query.limit {
                break;
            }
            let commit = commit_result.map_err(|err| {
                JuzuError::Backend(format!("failed to stream native jj commit: {err}"))
            })?;
            let description_full = commit.description().to_string();
            let description_title = description_full.lines().next().unwrap_or("").to_string();
            let author = commit.author();
            let time = author
                .timestamp
                .to_datetime()
                .map(|t| t.to_rfc3339())
                .unwrap_or_else(|_| String::new());
            let commit_id = commit.id().hex();
            let change_id = commit.change_id().reverse_hex();
            let parents = commit
                .parents()
                .await
                .map_err(|err| {
                    JuzuError::Backend(format!("failed to load native jj parent commits: {err}"))
                })?
                .into_iter()
                .map(|parent| parent.change_id().reverse_hex())
                .collect();
            let mut bookmarks: Vec<String> = repo
                .view()
                .local_bookmarks_for_commit(commit.id())
                .map(|(name, _target)| name.as_str().to_string())
                .collect();
            bookmarks.extend(
                repo.view()
                    .all_remote_bookmarks()
                    .filter(|(_symbol, remote_ref)| {
                        remote_ref.target.added_ids().any(|id| id == commit.id())
                    })
                    .map(|(symbol, _remote_ref)| {
                        format!("{}@{}", symbol.name.as_str(), symbol.remote.as_str())
                    }),
            );
            bookmarks.sort();
            let git_branches = repo
                .view()
                .git_refs()
                .iter()
                .filter(|(_name, target)| target.added_ids().any(|id| id == commit.id()))
                .map(|(name, _target)| name.as_str().to_string())
                .collect();
            let is_empty = commit.is_empty(repo.as_ref()).await.map_err(|err| {
                JuzuError::Backend(format!("failed to check empty commit: {err}"))
            })?;
            let is_hidden = commit.is_hidden(repo.as_ref()).map_err(|err| {
                JuzuError::Backend(format!("failed to check hidden commit: {err}"))
            })?;
            nodes.push(CommitNode {
                change_id,
                commit_id,
                parents,
                author: format!("{} <{}>", author.name, author.email),
                time,
                bookmarks,
                git_branches,
                description_title,
                description_full,
                is_empty,
                is_conflict: commit.has_conflict(),
                is_hidden,
                is_root: commit.id() == repo.store().root_commit_id(),
                is_working_copy: repo.view().is_wc_commit_id(commit.id()),
                x: None,
                y: None,
                lane: None,
                extra_height: None,
                is_pinned: false,
            });
        }
        Ok(nodes)
    }

    async fn node_count(&self, query: NodeCountQuery) -> Result<usize> {
        Ok(self
            .log(LogQuery {
                cwd: query.cwd,
                limit: usize::MAX,
                revset: query.revset,
            })
            .await?
            .len())
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
