//! Native JJ backend crate for the Rust JUZU port.
//!
//! Shell-out fallback belongs in an explicit `cli_fallback` module only. Repo
//! discovery/opening is wired through `jj-lib` here so future log/diff/mutation
//! slices have a real native backend anchor.

use async_trait::async_trait;
use futures::{io::AsyncReadExt, StreamExt};
use jj_lib::backend::TreeValue;
use jj_lib::config::StackedConfig;
use jj_lib::matchers::EverythingMatcher;
use jj_lib::object_id::ObjectId;
use jj_lib::repo::{ReadonlyRepo, Repo, StoreFactories};
use jj_lib::revset::{RevsetExpression, RevsetStreamExt};
use jj_lib::settings::UserSettings;
use jj_lib::workspace::{default_working_copy_factories, Workspace};
use juzu_core::{
    ChangeQuery, CommitNode, FileEntry, JjBackend, JuzuError, LogQuery, Mutation, MutationResult,
    NodeCountQuery, ObslogEntry, ObslogQuery, OpLogEntry, OpLogQuery, Result,
};
use serde::{Deserialize, Serialize};
use similar::TextDiff;
use std::path::{Path, PathBuf};
use std::sync::Arc;

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

    async fn open_repo_at_head(&self, cwd: &Path) -> Result<(PathBuf, Arc<ReadonlyRepo>)> {
        let workspace_root = self
            .find_root_blocking(cwd)
            .ok_or_else(|| JuzuError::RepoNotFound(cwd.to_path_buf()))?;
        let workspace = self.open_workspace(&workspace_root)?;
        let repo = workspace
            .repo_loader()
            .load_at_head()
            .await
            .map_err(|err| JuzuError::Backend(format!("failed to load jj repo head: {err}")))?;
        Ok((workspace_root, repo))
    }

    async fn read_tree_value_text(
        &self,
        repo: &Arc<ReadonlyRepo>,
        path: &jj_lib::repo_path::RepoPath,
        value: Option<&TreeValue>,
    ) -> Result<Option<String>> {
        let Some(value) = value else {
            return Ok(None);
        };
        match value {
            TreeValue::File { id, .. } => {
                let mut reader = repo.store().read_file(path, id).await.map_err(|err| {
                    JuzuError::Backend(format!("failed to read native jj file content: {err}"))
                })?;
                let mut bytes = Vec::new();
                reader.read_to_end(&mut bytes).await.map_err(|err| {
                    JuzuError::Backend(format!("failed to stream native jj file content: {err}"))
                })?;
                Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
            }
            TreeValue::Symlink(id) => {
                let target = repo.store().read_symlink(path, id).await.map_err(|err| {
                    JuzuError::Backend(format!("failed to read native jj symlink content: {err}"))
                })?;
                Ok(Some(target))
            }
            TreeValue::GitSubmodule(id) => Ok(Some(format!("Subproject commit {}\n", id.hex()))),
            TreeValue::Tree(_) => Ok(None),
        }
    }

    pub async fn diff_preview(&self, query: ChangeQuery, max_lines: usize) -> Result<String> {
        self.diff_with_line_limit(query, Some(max_lines)).await
    }

    async fn diff_with_line_limit(
        &self,
        query: ChangeQuery,
        max_lines: Option<usize>,
    ) -> Result<String> {
        let (_workspace_root, repo) = self.open_repo_at_head(&query.cwd).await?;
        let commit = self
            .find_commit_by_change_or_commit_id(&repo, &query.change_id)
            .await?;
        let parents = commit.parents().await.map_err(|err| {
            JuzuError::Backend(format!(
                "failed to load native jj parent commits for diff: {err}"
            ))
        })?;
        let Some(parent) = parents.first() else {
            return Ok(String::new());
        };
        let parent_tree = parent.tree();
        let commit_tree = commit.tree();
        let mut stream = parent_tree.diff_stream(&commit_tree, &EverythingMatcher);
        let mut output = String::new();
        let mut line_count = 0usize;
        let mut truncated = false;
        while let Some(entry) = stream.next().await {
            if max_lines.is_some_and(|limit| line_count >= limit) {
                truncated = true;
                break;
            }
            let values = entry.values.map_err(|err| {
                JuzuError::Backend(format!("failed to read native jj tree diff entry: {err}"))
            })?;
            let before_value = values.before.as_resolved().and_then(Option::as_ref);
            let after_value = values.after.as_resolved().and_then(Option::as_ref);
            let before_present = values.before.is_present();
            let after_present = values.after.is_present();
            let path = entry.path.as_internal_file_string().to_string();
            let before_text = self
                .read_tree_value_text(&repo, entry.path.as_ref(), before_value)
                .await?
                .unwrap_or_default();
            let after_text = self
                .read_tree_value_text(&repo, entry.path.as_ref(), after_value)
                .await?
                .unwrap_or_default();

            let mut file_output = String::new();
            file_output.push_str(&format!("diff --git a/{path} b/{path}\n"));
            match (before_present, after_present) {
                (false, true) => file_output.push_str("new file mode 100644\n"),
                (true, false) => file_output.push_str("deleted file mode 100644\n"),
                _ => {}
            }
            let diff = TextDiff::from_lines(&before_text, &after_text);
            let old_header = if before_present {
                format!("a/{path}")
            } else {
                "/dev/null".to_string()
            };
            let new_header = if after_present {
                format!("b/{path}")
            } else {
                "/dev/null".to_string()
            };
            file_output.push_str(
                &diff
                    .unified_diff()
                    .context_radius(3)
                    .header(&old_header, &new_header)
                    .to_string(),
            );
            for line in file_output.lines() {
                if max_lines.is_some_and(|limit| line_count >= limit) {
                    truncated = true;
                    break;
                }
                output.push_str(line);
                output.push('\n');
                line_count += 1;
            }
        }
        if truncated {
            output.push_str("… diff preview truncated; open full diff for complete patch\n");
        }
        Ok(output)
    }

    async fn find_commit_by_change_or_commit_id(
        &self,
        repo: &Arc<ReadonlyRepo>,
        id_prefix: &str,
    ) -> Result<jj_lib::commit::Commit> {
        let revset = RevsetExpression::all()
            .evaluate(repo.as_ref())
            .map_err(|err| {
                JuzuError::Backend(format!("failed to evaluate native jj revset: {err}"))
            })?;
        let mut stream = revset.stream().commits(repo.store()).boxed_local();
        while let Some(commit_result) = stream.next().await {
            let commit = commit_result.map_err(|err| {
                JuzuError::Backend(format!("failed to stream native jj commit: {err}"))
            })?;
            if commit.change_id().reverse_hex().starts_with(id_prefix)
                || commit.id().hex().starts_with(id_prefix)
            {
                return Ok(commit);
            }
        }
        Err(JuzuError::Backend(format!(
            "native jj commit not found for id prefix {id_prefix}"
        )))
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

    async fn files(&self, query: ChangeQuery) -> Result<Vec<FileEntry>> {
        let (_workspace_root, repo) = self.open_repo_at_head(&query.cwd).await?;
        let commit = self
            .find_commit_by_change_or_commit_id(&repo, &query.change_id)
            .await?;
        let parents = commit.parents().await.map_err(|err| {
            JuzuError::Backend(format!(
                "failed to load native jj parent commits for files: {err}"
            ))
        })?;
        let Some(parent) = parents.first() else {
            return Ok(Vec::new());
        };
        let parent_tree = parent.tree();
        let commit_tree = commit.tree();
        let mut stream = parent_tree.diff_stream(&commit_tree, &EverythingMatcher);
        let mut files = Vec::new();
        while let Some(entry) = stream.next().await {
            let values = entry.values.map_err(|err| {
                JuzuError::Backend(format!("failed to read native jj tree diff entry: {err}"))
            })?;
            let before_present = values.before.is_present();
            let after_present = values.after.is_present();
            let file_type = match (before_present, after_present) {
                (false, true) => "A",
                (true, false) => "D",
                _ => "M",
            };
            files.push(FileEntry {
                r#type: file_type.to_string(),
                path: entry.path.as_internal_file_string().to_string(),
            });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path).then(a.r#type.cmp(&b.r#type)));
        Ok(files)
    }

    async fn diff(&self, query: ChangeQuery) -> Result<String> {
        self.diff_with_line_limit(query, None).await
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
