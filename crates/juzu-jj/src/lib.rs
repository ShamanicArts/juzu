//! Native JJ backend crate for the Rust JUZU port.
//!
//! Shell-out fallback belongs in an explicit `cli_fallback` module only. Repo
//! discovery/opening is wired through `jj-lib` here so future log/diff/mutation
//! slices have a real native backend anchor.

mod cli_fallback;

use async_trait::async_trait;
use chrono::Local;
use futures::{io::AsyncReadExt, StreamExt};
use jj_lib::backend::TreeValue;
use jj_lib::config::StackedConfig;
use jj_lib::fileset::FilesetAliasesMap;
use jj_lib::matchers::EverythingMatcher;
use jj_lib::object_id::ObjectId;
use jj_lib::repo::{ReadonlyRepo, Repo, StoreFactories};
use jj_lib::repo_path::RepoPathUiConverter;
use jj_lib::revset::{
    RevsetAliasesMap, RevsetDiagnostics, RevsetExpression, RevsetExtensions, RevsetParseContext,
    RevsetStreamExt, SymbolResolver,
};
use jj_lib::settings::UserSettings;
use jj_lib::time_util::DatePatternContext;
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

    fn evaluate_user_revset<'a>(
        &self,
        repo: &'a Arc<ReadonlyRepo>,
        workspace: &'a Workspace,
        cwd: &Path,
        revset_str: &str,
    ) -> Result<Box<dyn jj_lib::revset::Revset + 'a>> {
        let aliases_map = RevsetAliasesMap::new();
        let fileset_aliases_map = FilesetAliasesMap::new();
        let extensions = RevsetExtensions::default();
        let path_converter = RepoPathUiConverter::Fs {
            cwd: cwd.to_path_buf(),
            base: workspace.workspace_root().to_path_buf(),
        };
        let context = RevsetParseContext {
            aliases_map: &aliases_map,
            local_variables: std::collections::HashMap::new(),
            user_email: "",
            date_pattern_context: DatePatternContext::from(Local::now()),
            default_ignored_remote: None,
            fileset_aliases_map: &fileset_aliases_map,
            use_glob_by_default: true,
            extensions: &extensions,
            workspace: Some(jj_lib::revset::RevsetWorkspaceContext {
                path_converter: &path_converter,
                workspace_name: workspace.workspace_name(),
            }),
        };
        let mut diagnostics = RevsetDiagnostics::new();
        let expression =
            jj_lib::revset::parse(&mut diagnostics, revset_str, &context).map_err(|err| {
                JuzuError::Backend(format!(
                    "failed to parse native jj revset `{revset_str}`: {err}"
                ))
            })?;
        let symbol_resolver =
            SymbolResolver::new(repo.as_ref(), context.extensions.symbol_resolvers());
        let resolved = expression
            .resolve_user_expression(repo.as_ref(), &symbol_resolver)
            .map_err(|err| {
                JuzuError::Backend(format!(
                    "failed to resolve native jj revset `{revset_str}`: {err}"
                ))
            })?;
        resolved.evaluate(repo.as_ref()).map_err(|err| {
            JuzuError::Backend(format!(
                "failed to evaluate native jj revset `{revset_str}`: {err}"
            ))
        })
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
        let workspace_root = self
            .find_root_blocking(&query.cwd)
            .ok_or_else(|| JuzuError::RepoNotFound(query.cwd.clone()))?;
        let workspace = self.open_workspace(&workspace_root)?;
        let repo = workspace
            .repo_loader()
            .load_at_head()
            .await
            .map_err(|err| JuzuError::Backend(format!("failed to load jj repo head: {err}")))?;
        let revset_query = query
            .revset
            .as_deref()
            .map(str::trim)
            .filter(|q| !q.is_empty());
        let revset = if let Some(revset_str) = revset_query {
            self.evaluate_user_revset(&repo, &workspace, &query.cwd, revset_str)?
        } else {
            RevsetExpression::all()
                .evaluate(repo.as_ref())
                .map_err(|err| {
                    JuzuError::Backend(format!("failed to evaluate native jj revset: {err}"))
                })?
        };
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

    async fn op_log(&self, query: OpLogQuery) -> Result<Vec<OpLogEntry>> {
        cli_fallback::fetch_op_log(&query.cwd, query.limit)
    }

    async fn obslog(&self, query: ObslogQuery) -> Result<Vec<ObslogEntry>> {
        cli_fallback::fetch_obslog(&query.cwd, &query.change_id, query.limit)
    }

    async fn mutate(&self, mutation: Mutation) -> Result<MutationResult> {
        match mutation {
            Mutation::New {
                cwd,
                parent_id,
                parent_ids,
            } => {
                cli_fallback::new_change(&cwd, parent_id.as_deref(), &parent_ids)?;
                Ok(MutationResult {
                    changed: true,
                    message: "created new change".to_string(),
                })
            }
            Mutation::Edit { cwd, change_id } => {
                cli_fallback::edit(&cwd, &change_id)?;
                Ok(MutationResult {
                    changed: true,
                    message: format!("editing change {change_id}"),
                })
            }
            Mutation::Duplicate { cwd, change_id } => {
                cli_fallback::duplicate(&cwd, &change_id)?;
                Ok(MutationResult {
                    changed: true,
                    message: format!("duplicated change {change_id}"),
                })
            }
            Mutation::Abandon { cwd, change_id } => {
                cli_fallback::abandon(&cwd, &change_id)?;
                Ok(MutationResult {
                    changed: true,
                    message: format!("abandoned change {change_id}"),
                })
            }
            Mutation::Squash {
                cwd,
                change_id,
                into_id,
            } => {
                cli_fallback::squash(&cwd, &change_id, into_id.as_deref())?;
                Ok(MutationResult {
                    changed: true,
                    message: format!("squashed change {change_id}"),
                })
            }
            Mutation::RestoreOperation { cwd, operation_id } => {
                cli_fallback::restore_operation(&cwd, &operation_id)?;
                Ok(MutationResult {
                    changed: true,
                    message: format!("restored operation {operation_id}"),
                })
            }
            Mutation::BookmarkSet {
                cwd,
                name,
                revision,
            } => {
                cli_fallback::bookmark_set(&cwd, &name, &revision)?;
                Ok(MutationResult {
                    changed: true,
                    message: format!("set bookmark {name} -> {revision}"),
                })
            }
            Mutation::BookmarkDelete { cwd, name } => {
                cli_fallback::bookmark_delete(&cwd, &name)?;
                Ok(MutationResult {
                    changed: true,
                    message: format!("deleted bookmark {name}"),
                })
            }
            Mutation::Undo { cwd } => {
                cli_fallback::undo(&cwd)?;
                Ok(MutationResult {
                    changed: true,
                    message: "undid last operation".to_string(),
                })
            }
            Mutation::Redo { cwd } => {
                cli_fallback::redo(&cwd)?;
                Ok(MutationResult {
                    changed: true,
                    message: "redid last operation".to_string(),
                })
            }
            Mutation::GitFetch { cwd } => {
                cli_fallback::git_fetch(&cwd)?;
                Ok(MutationResult {
                    changed: true,
                    message: "fetched from git remote".to_string(),
                })
            }
            Mutation::GitPush { cwd, bookmark } => {
                cli_fallback::git_push(&cwd, bookmark.as_deref())?;
                Ok(MutationResult {
                    changed: true,
                    message: "pushed to git remote".to_string(),
                })
            }
            _ => Err(JuzuError::Unsupported(
                "native jj mutations are not wired yet",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn unique_test_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("juzu-jj-{label}-{nanos}"))
    }

    fn run_jj(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("jj")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("jj command should start in test fixture");
        if !output.status.success() {
            panic!(
                "jj {:?} failed\nstdout:\n{}\nstderr:\n{}",
                args,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn create_restore_fixture_repo() -> PathBuf {
        let repo = unique_test_dir("restore-op");
        fs::create_dir_all(&repo).expect("fixture repo dir should be created");
        run_jj(&repo, &["git", "init", "."]);
        fs::write(repo.join("note.txt"), "one\n").expect("fixture file write should work");
        run_jj(&repo, &["describe", "-m", "first desc"]);
        fs::write(repo.join("note.txt"), "two\n").expect("fixture file rewrite should work");
        run_jj(&repo, &["describe", "-m", "second desc"]);
        repo
    }

    fn create_action_fixture_repo() -> PathBuf {
        let repo = unique_test_dir("action-mutations");
        fs::create_dir_all(&repo).expect("fixture repo dir should be created");
        run_jj(&repo, &["git", "init", "."]);
        fs::write(repo.join("note.txt"), "one\n").expect("fixture file write should work");
        run_jj(&repo, &["describe", "-m", "first desc"]);
        run_jj(&repo, &["new", "@"]).trim().to_string();
        fs::write(repo.join("note.txt"), "two\n").expect("fixture file rewrite should work");
        run_jj(&repo, &["describe", "-m", "second desc"]);
        repo
    }

    fn create_squash_fixture_repo() -> PathBuf {
        let repo = unique_test_dir("squash-mutations");
        fs::create_dir_all(&repo).expect("fixture repo dir should be created");
        run_jj(&repo, &["git", "init", "."]);
        fs::write(repo.join("note.txt"), "one\n").expect("fixture file write should work");
        run_jj(&repo, &["describe", "-m", "first desc"]);
        run_jj(&repo, &["new", "@"]).trim().to_string();
        fs::write(repo.join("note.txt"), "two\n").expect("fixture file rewrite should work");
        run_jj(&repo, &["describe", "-m", "second desc"]);
        run_jj(&repo, &["new", "@"]).trim().to_string();
        fs::write(repo.join("note.txt"), "three\n").expect("fixture file rewrite should work");
        run_jj(&repo, &["describe", "-m", "third desc"]);
        repo
    }

    fn run_git(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git command should start in test fixture");
        if !output.status.success() {
            panic!(
                "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
                args,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn create_git_remote_fixture() -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let base = unique_test_dir("git-remote");
        let remote_work = base.join("remote-work");
        let remote_bare = base.join("remote.git");
        let local = base.join("local");
        fs::create_dir_all(&base).expect("base fixture dir should be created");
        run_git(&base, &["init", remote_work.to_str().unwrap()]);
        fs::write(remote_work.join("readme.txt"), "hi\n")
            .expect("remote worktree file write should work");
        run_git(&remote_work, &["add", "."]);
        run_git(&remote_work, &["commit", "-m", "init"]);
        run_git(&remote_work, &["branch", "-M", "main"]);
        run_git(
            &base,
            &[
                "clone",
                "--bare",
                remote_work.to_str().unwrap(),
                remote_bare.to_str().unwrap(),
            ],
        );
        run_jj(
            &base,
            &[
                "git",
                "clone",
                remote_bare.to_str().unwrap(),
                local.to_str().unwrap(),
            ],
        );
        (base, local, remote_work, remote_bare)
    }

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

    #[test]
    fn native_revset_query_filters_log_results() {
        let backend = NativeJjBackend::new();
        let nodes = futures::executor::block_on(backend.log(LogQuery {
            cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            limit: 20,
            revset: Some("none()".to_string()),
        }))
        .unwrap();
        assert!(
            nodes.is_empty(),
            "none() revset should produce no log nodes"
        );
    }

    #[test]
    fn native_revset_query_filters_node_count() {
        let backend = NativeJjBackend::new();
        let count = futures::executor::block_on(backend.node_count(NodeCountQuery {
            cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            revset: Some("none()".to_string()),
        }))
        .unwrap();
        assert_eq!(count, 0, "none() revset should produce zero visible nodes");
    }

    #[test]
    fn native_op_log_returns_entries_for_current_workspace() {
        let backend = NativeJjBackend::new();
        let entries = futures::executor::block_on(backend.op_log(OpLogQuery {
            cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            limit: 5,
        }))
        .expect("native/fallback op log should load");
        assert!(
            !entries.is_empty(),
            "expected native/fallback op log to return at least one entry"
        );
        assert!(
            !entries[0].id.is_empty() && !entries[0].description_title.is_empty(),
            "op log entries should include id and description"
        );
        assert!(
            !entries[0].short_id.is_empty() && !entries[0].duration.is_empty(),
            "op log entries should include short id and duration"
        );
    }

    #[test]
    fn native_obslog_returns_entries_for_selected_change() {
        let backend = NativeJjBackend::new();
        let nodes = futures::executor::block_on(backend.log(LogQuery {
            cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            limit: 5,
            revset: None,
        }))
        .expect("native log should load");
        let selected = nodes.iter().find(|node| !node.is_root).unwrap_or(&nodes[0]);
        let entries = futures::executor::block_on(backend.obslog(ObslogQuery {
            cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            change_id: selected.change_id.clone(),
            limit: 5,
        }))
        .expect("native/fallback obslog should load");
        assert!(
            !entries.is_empty(),
            "expected native/fallback obslog to return at least one entry"
        );
        assert!(
            selected.change_id.starts_with(&entries[0].change_id),
            "obslog entry change id should match the selected change prefix"
        );
        assert!(
            !entries[0].operation_id.is_empty() && !entries[0].description_title.is_empty(),
            "obslog entry should include operation metadata and description"
        );
    }

    #[test]
    fn native_restore_operation_mutation_restores_selected_op_state() {
        let repo = create_restore_fixture_repo();
        let backend = NativeJjBackend::new();
        let before = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                "@",
                "-T",
                "description.first_line()",
            ],
        );
        assert_eq!(before.trim(), "second desc");

        let target = futures::executor::block_on(backend.op_log(OpLogQuery {
            cwd: repo.clone(),
            limit: 10,
        }))
        .expect("fixture op log should load")
        .into_iter()
        .find(|entry| entry.description_title == "snapshot working copy")
        .expect("fixture should include the snapshot op that predates the second describe");

        let result = futures::executor::block_on(backend.mutate(Mutation::RestoreOperation {
            cwd: repo.clone(),
            operation_id: target.id.clone(),
        }))
        .expect("restore operation mutation should succeed");
        assert!(result.changed, "restore mutation should report a change");

        let after = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                "@",
                "-T",
                "description.first_line()",
            ],
        );
        assert_eq!(after.trim(), "first desc");

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn native_new_mutation_creates_child_working_copy() {
        let repo = create_action_fixture_repo();
        let backend = NativeJjBackend::new();
        let parent_change_id = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();
        let before_count = run_jj(&repo, &["log", "-r", "::", "--count"])
            .trim()
            .parse::<usize>()
            .expect("before count should parse");

        let result = futures::executor::block_on(backend.mutate(Mutation::New {
            cwd: repo.clone(),
            parent_id: Some(parent_change_id.clone()),
            parent_ids: Vec::new(),
        }))
        .expect("new mutation should succeed");
        assert!(result.changed, "new mutation should report a change");

        let after_count = run_jj(&repo, &["log", "-r", "::", "--count"])
            .trim()
            .parse::<usize>()
            .expect("after count should parse");
        assert_eq!(after_count, before_count + 1);
        let parent_after = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@-", "-T", "change_id.short()"],
        );
        assert_eq!(parent_after.trim(), parent_change_id);

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn native_edit_mutation_moves_working_copy_to_selected_change() {
        let repo = create_action_fixture_repo();
        let backend = NativeJjBackend::new();
        let target_change_id = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@-", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();

        let result = futures::executor::block_on(backend.mutate(Mutation::Edit {
            cwd: repo.clone(),
            change_id: target_change_id.clone(),
        }))
        .expect("edit mutation should succeed");
        assert!(result.changed, "edit mutation should report a change");

        let after = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                "@",
                "-T",
                "change_id.short() ++ \"\\x01\" ++ description.first_line()",
            ],
        );
        let mut parts = after.trim().split('\x01');
        assert_eq!(parts.next(), Some(target_change_id.as_str()));
        assert_eq!(parts.next(), Some("first desc"));

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn native_duplicate_mutation_creates_second_copy_of_selected_description() {
        let repo = create_action_fixture_repo();
        let backend = NativeJjBackend::new();
        let target_change_id = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();
        let before_count = run_jj(&repo, &["log", "-r", "::", "--count"])
            .trim()
            .parse::<usize>()
            .expect("before count should parse");

        let result = futures::executor::block_on(backend.mutate(Mutation::Duplicate {
            cwd: repo.clone(),
            change_id: target_change_id,
        }))
        .expect("duplicate mutation should succeed");
        assert!(result.changed, "duplicate mutation should report a change");

        let after_count = run_jj(&repo, &["log", "-r", "::", "--count"])
            .trim()
            .parse::<usize>()
            .expect("after count should parse");
        assert_eq!(after_count, before_count + 1);
        let duplicated_titles = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                "::",
                "-T",
                "description.first_line() ++ \"\\n\"",
            ],
        );
        assert!(
            duplicated_titles
                .lines()
                .filter(|line| line.trim() == "second desc")
                .count()
                >= 2,
            "expected duplicated description to appear at least twice, got: {duplicated_titles}"
        );

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn native_abandon_mutation_replaces_selected_change_with_empty_working_copy() {
        let repo = create_action_fixture_repo();
        let backend = NativeJjBackend::new();
        let target_change_id = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();
        let before_count = run_jj(&repo, &["log", "-r", "::", "--count"])
            .trim()
            .parse::<usize>()
            .expect("before count should parse");

        let result = futures::executor::block_on(backend.mutate(Mutation::Abandon {
            cwd: repo.clone(),
            change_id: target_change_id.clone(),
        }))
        .expect("abandon mutation should succeed");
        assert!(result.changed, "abandon mutation should report a change");

        let after_count = run_jj(&repo, &["log", "-r", "::", "--count"])
            .trim()
            .parse::<usize>()
            .expect("after count should parse");
        assert_eq!(after_count, before_count);
        let current = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                "@",
                "-T",
                "change_id.short() ++ \"|\" ++ description.first_line() ++ \"\\n\"",
            ],
        );
        let mut current_parts = current.trim().split('|');
        let current_change_id = current_parts.next().unwrap_or_default();
        let current_desc = current_parts.next().unwrap_or_default();
        assert_ne!(current_change_id, target_change_id);
        assert_eq!(current_desc, "");

        let remaining = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                "::",
                "-T",
                "change_id.short() ++ \"\\n\"",
            ],
        );
        assert!(
            !remaining
                .lines()
                .any(|line| line.trim() == target_change_id),
            "expected abandoned change to disappear from visible log, got: {remaining}"
        );

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn native_squash_mutation_folds_selected_non_working_copy_change_into_parent() {
        let repo = create_squash_fixture_repo();
        let backend = NativeJjBackend::new();
        let target_change_id = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@-", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();
        let before_count = run_jj(&repo, &["log", "-r", "::", "--count"])
            .trim()
            .parse::<usize>()
            .expect("before count should parse");

        let result = futures::executor::block_on(backend.mutate(Mutation::Squash {
            cwd: repo.clone(),
            change_id: target_change_id.clone(),
            into_id: None,
        }))
        .expect("squash mutation should succeed");
        assert!(result.changed, "squash mutation should report a change");

        let after_count = run_jj(&repo, &["log", "-r", "::", "--count"])
            .trim()
            .parse::<usize>()
            .expect("after count should parse");
        assert_eq!(after_count, before_count - 1);
        let remaining = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                "::",
                "-T",
                "change_id.short() ++ \"\\n\"",
            ],
        );
        assert!(
            !remaining
                .lines()
                .any(|line| line.trim() == target_change_id),
            "expected squashed change to disappear from visible log, got: {remaining}"
        );
        let current_title = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                "@",
                "-T",
                "description.first_line()",
            ],
        );
        assert_eq!(current_title.trim(), "third desc");

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn native_bookmark_set_mutation_creates_named_bookmark() {
        let repo = create_restore_fixture_repo();
        let backend = NativeJjBackend::new();
        let change_id = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();

        let result = futures::executor::block_on(backend.mutate(Mutation::BookmarkSet {
            cwd: repo.clone(),
            name: "wip/test-bookmark".to_string(),
            revision: change_id.clone(),
        }))
        .expect("bookmark set mutation should succeed");
        assert!(result.changed, "bookmark set should report a change");

        let bookmarks = run_jj(
            &repo,
            &[
                "bookmark",
                "list",
                "-T",
                "name ++ \"|\" ++ present ++ \"\\n\"",
            ],
        );
        assert!(
            bookmarks
                .lines()
                .any(|line| line.trim() == "wip/test-bookmark|true"),
            "expected created bookmark to appear in jj bookmark list, got: {bookmarks}"
        );

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn native_bookmark_delete_mutation_removes_named_bookmark() {
        let repo = create_restore_fixture_repo();
        run_jj(&repo, &["bookmark", "set", "wip/test-bookmark", "-r", "@"]);
        let backend = NativeJjBackend::new();

        let result = futures::executor::block_on(backend.mutate(Mutation::BookmarkDelete {
            cwd: repo.clone(),
            name: "wip/test-bookmark".to_string(),
        }))
        .expect("bookmark delete mutation should succeed");
        assert!(result.changed, "bookmark delete should report a change");

        let bookmarks = run_jj(
            &repo,
            &[
                "bookmark",
                "list",
                "-T",
                "name ++ \"|\" ++ present ++ \"\\n\"",
            ],
        );
        assert!(
            !bookmarks
                .lines()
                .any(|line| line.contains("wip/test-bookmark|true")),
            "expected deleted bookmark to disappear from jj bookmark list, got: {bookmarks}"
        );

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn native_git_fetch_mutation_imports_remote_bookmark_advance() {
        let (base, local, remote_work, remote_bare) = create_git_remote_fixture();
        let backend = NativeJjBackend::new();

        fs::write(remote_work.join("readme.txt"), "hi\nmore\n")
            .expect("remote worktree file rewrite should work");
        run_git(&remote_work, &["add", "."]);
        run_git(&remote_work, &["commit", "-m", "remote two"]);
        run_git(
            &remote_work,
            &["push", remote_bare.to_str().unwrap(), "main"],
        );

        let result =
            futures::executor::block_on(backend.mutate(Mutation::GitFetch { cwd: local.clone() }))
                .expect("git fetch mutation should succeed");
        assert!(result.changed, "git fetch mutation should report a change");

        let main_desc = run_jj(
            &local,
            &[
                "log",
                "--no-graph",
                "-r",
                "main",
                "-T",
                "description.first_line()",
            ],
        );
        assert_eq!(main_desc.trim(), "remote two");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn native_git_push_mutation_updates_origin_bookmark_from_local_main() {
        let (base, local, _remote_work, remote_bare) = create_git_remote_fixture();
        let backend = NativeJjBackend::new();

        fs::write(local.join("note2.txt"), "new\n").expect("local fixture write should work");
        run_jj(&local, &["describe", "-m", "second desc"]);
        run_jj(&local, &["bookmark", "set", "main", "-r", "@"]);

        let result = futures::executor::block_on(backend.mutate(Mutation::GitPush {
            cwd: local.clone(),
            bookmark: None,
        }))
        .expect("git push mutation should succeed");
        assert!(result.changed, "git push mutation should report a change");

        let remote_head = Command::new("git")
            .arg("--git-dir")
            .arg(&remote_bare)
            .args(["log", "-1", "--format=%s", "refs/heads/main"])
            .output()
            .expect("remote git log should start");
        assert!(
            remote_head.status.success(),
            "remote git log should succeed"
        );
        assert_eq!(
            String::from_utf8_lossy(&remote_head.stdout).trim(),
            "second desc"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn native_undo_and_redo_mutations_round_trip_last_operation() {
        let repo = create_restore_fixture_repo();
        let backend = NativeJjBackend::new();

        let before = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                "@",
                "-T",
                "description.first_line()",
            ],
        );
        assert_eq!(before.trim(), "second desc");

        let undo_result =
            futures::executor::block_on(backend.mutate(Mutation::Undo { cwd: repo.clone() }))
                .expect("undo mutation should succeed");
        assert!(undo_result.changed, "undo mutation should report a change");

        let after_undo = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                "@",
                "-T",
                "description.first_line()",
            ],
        );
        assert_eq!(after_undo.trim(), "first desc");

        let redo_result =
            futures::executor::block_on(backend.mutate(Mutation::Redo { cwd: repo.clone() }))
                .expect("redo mutation should succeed");
        assert!(redo_result.changed, "redo mutation should report a change");

        let after_redo = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                "@",
                "-T",
                "description.first_line()",
            ],
        );
        assert_eq!(after_redo.trim(), "second desc");

        let _ = fs::remove_dir_all(&repo);
    }
}
