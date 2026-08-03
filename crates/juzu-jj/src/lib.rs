//! Native JJ backend for Juzu.
//!
//! Shell-out fallback belongs in an explicit `cli_fallback` module only. Repo
//! discovery, reads, and supported mutations are wired through `jj-lib`.

mod cli_fallback;

use async_trait::async_trait;
use chrono::Local;
use futures::{io::AsyncReadExt, StreamExt};
use jj_lib::backend::TreeValue;
use jj_lib::config::StackedConfig;
use jj_lib::fileset::FilesetAliasesMap;
use jj_lib::gitignore::GitIgnoreFile;
use jj_lib::matchers::{EverythingMatcher, NothingMatcher};
use jj_lib::merged_tree::MergedTree;
use jj_lib::object_id::ObjectId;
use jj_lib::repo::{ReadonlyRepo, Repo, StoreFactories};
use jj_lib::repo_path::RepoPathUiConverter;
use jj_lib::revset::{
    RevsetAliasesMap, RevsetDiagnostics, RevsetExpression, RevsetExtensions, RevsetParseContext,
    RevsetStreamExt, SymbolResolver,
};
use jj_lib::settings::UserSettings;
use jj_lib::time_util::DatePatternContext;
use jj_lib::working_copy::SnapshotOptions;
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

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum TreeValueSignature {
    File { id: String, executable: bool },
    Symlink(String),
    GitSubmodule(String),
    Tree(String),
}

#[derive(Debug, Clone)]
struct NativeTreeDiffEntry {
    path: String,
    before_present: bool,
    after_present: bool,
    before_signature: Option<TreeValueSignature>,
    after_signature: Option<TreeValueSignature>,
    before_bytes: Option<Vec<u8>>,
    after_bytes: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
enum NativeDisplayDiffKind {
    Added,
    Deleted,
    Modified,
    Renamed { old_path: String, new_path: String },
}

#[derive(Debug, Clone)]
struct NativeDisplayDiff {
    order_key: usize,
    old_path: String,
    new_path: String,
    kind: NativeDisplayDiffKind,
    before_bytes: Option<Vec<u8>>,
    after_bytes: Option<Vec<u8>>,
}

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

    async fn open_workspace_and_repo_at_head(
        &self,
        cwd: &Path,
    ) -> Result<(PathBuf, Workspace, Arc<ReadonlyRepo>)> {
        let workspace_root = self
            .find_root_blocking(cwd)
            .ok_or_else(|| JuzuError::RepoNotFound(cwd.to_path_buf()))?;
        let workspace = self.open_workspace(&workspace_root)?;
        let repo = workspace
            .repo_loader()
            .load_at_head()
            .await
            .map_err(|err| JuzuError::Backend(format!("failed to load jj repo head: {err}")))?;
        Ok((workspace_root, workspace, repo))
    }

    async fn snapshot_working_copy_tree(&self, workspace: &mut Workspace) -> Result<MergedTree> {
        let mut locked_ws = workspace
            .start_working_copy_mutation()
            .await
            .map_err(|err| {
                JuzuError::Backend(format!(
                    "failed to lock native jj working copy for snapshot: {err}"
                ))
            })?;
        let options = SnapshotOptions {
            base_ignores: GitIgnoreFile::empty(),
            progress: None,
            start_tracking_matcher: &EverythingMatcher,
            force_tracking_matcher: &NothingMatcher,
            max_new_file_size: u64::MAX,
        };
        let (tree, _stats) = locked_ws
            .locked_wc()
            .snapshot(&options)
            .await
            .map_err(|err| {
                JuzuError::Backend(format!("failed to snapshot native jj working copy: {err}"))
            })?;
        Ok(tree)
    }

    async fn resolve_change_tree(
        &self,
        cwd: &Path,
        change_id: &str,
    ) -> Result<(Arc<ReadonlyRepo>, jj_lib::commit::Commit, MergedTree)> {
        let (_workspace_root, mut workspace, repo) =
            self.open_workspace_and_repo_at_head(cwd).await?;
        let commit = self
            .find_commit_by_change_or_commit_id(&repo, change_id)
            .await?;
        let tree = if repo.view().is_wc_commit_id(commit.id()) {
            self.snapshot_working_copy_tree(&mut workspace).await?
        } else {
            commit.tree()
        };
        Ok((repo, commit, tree))
    }

    async fn read_tree_value_bytes(
        &self,
        repo: &Arc<ReadonlyRepo>,
        path: &jj_lib::repo_path::RepoPath,
        value: Option<&TreeValue>,
    ) -> Result<Option<Vec<u8>>> {
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
                Ok(Some(bytes))
            }
            TreeValue::Symlink(id) => {
                let target = repo.store().read_symlink(path, id).await.map_err(|err| {
                    JuzuError::Backend(format!("failed to read native jj symlink content: {err}"))
                })?;
                Ok(Some(target.into_bytes()))
            }
            TreeValue::GitSubmodule(id) => Ok(Some(
                format!("Subproject commit {}\n", id.hex()).into_bytes(),
            )),
            TreeValue::Tree(_) => Ok(None),
        }
    }

    fn tree_value_signature(value: Option<&TreeValue>) -> Option<TreeValueSignature> {
        match value? {
            TreeValue::File { id, executable, .. } => Some(TreeValueSignature::File {
                id: id.hex(),
                executable: *executable,
            }),
            TreeValue::Symlink(id) => Some(TreeValueSignature::Symlink(id.hex())),
            TreeValue::GitSubmodule(id) => Some(TreeValueSignature::GitSubmodule(id.hex())),
            TreeValue::Tree(id) => Some(TreeValueSignature::Tree(id.hex())),
        }
    }

    fn is_binary_content(bytes: Option<&[u8]>) -> bool {
        let Some(bytes) = bytes else {
            return false;
        };
        bytes.contains(&0) || std::str::from_utf8(bytes).is_err()
    }

    fn bytes_to_lossy_text(bytes: Option<&[u8]>) -> String {
        bytes
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
            .unwrap_or_default()
    }

    /// Line-level content similarity ratio in `[0.0, 1.0]`. Returns `0.0` when
    /// either side is missing or binary so rename detection skips those pairs.
    fn content_similarity_ratio(before: Option<&[u8]>, after: Option<&[u8]>) -> f32 {
        let (Some(before), Some(after)) = (before, after) else {
            return 0.0;
        };
        if Self::is_binary_content(Some(before)) || Self::is_binary_content(Some(after)) {
            return 0.0;
        }
        let before_text = Self::bytes_to_lossy_text(Some(before));
        let after_text = Self::bytes_to_lossy_text(Some(after));
        TextDiff::from_lines(&before_text, &after_text).ratio()
    }

    fn format_rename_summary(old_path: &str, new_path: &str) -> String {
        match (old_path.rsplit_once('/'), new_path.rsplit_once('/')) {
            (Some((old_dir, old_name)), Some((new_dir, new_name))) if old_dir == new_dir => {
                format!("{old_dir}/{{{old_name} => {new_name}}}")
            }
            _ => format!("{{{old_path} => {new_path}}}"),
        }
    }

    async fn collect_native_diff_entries(
        &self,
        repo: &Arc<ReadonlyRepo>,
        before_tree: &MergedTree,
        after_tree: &MergedTree,
    ) -> Result<Vec<NativeTreeDiffEntry>> {
        let mut stream = before_tree.diff_stream(after_tree, &EverythingMatcher);
        let mut entries = Vec::new();
        while let Some(entry) = stream.next().await {
            let values = entry.values.map_err(|err| {
                JuzuError::Backend(format!("failed to read native jj tree diff entry: {err}"))
            })?;
            let before_value = values.before.as_resolved().and_then(Option::as_ref);
            let after_value = values.after.as_resolved().and_then(Option::as_ref);
            entries.push(NativeTreeDiffEntry {
                path: entry.path.as_internal_file_string().to_string(),
                before_present: values.before.is_present(),
                after_present: values.after.is_present(),
                before_signature: Self::tree_value_signature(before_value),
                after_signature: Self::tree_value_signature(after_value),
                before_bytes: self
                    .read_tree_value_bytes(repo, entry.path.as_ref(), before_value)
                    .await?,
                after_bytes: self
                    .read_tree_value_bytes(repo, entry.path.as_ref(), after_value)
                    .await?,
            });
        }
        Ok(entries)
    }

    fn build_display_diffs(entries: Vec<NativeTreeDiffEntry>) -> Vec<NativeDisplayDiff> {
        let mut consumed = vec![false; entries.len()];
        let mut display = Vec::new();

        for (delete_idx, delete_entry) in entries.iter().enumerate() {
            if consumed[delete_idx] || !delete_entry.before_present || delete_entry.after_present {
                continue;
            }
            let Some(signature) = delete_entry.before_signature.as_ref() else {
                continue;
            };
            let Some((add_idx, add_entry)) =
                entries.iter().enumerate().find(|(add_idx, add_entry)| {
                    !consumed[*add_idx]
                        && !add_entry.before_present
                        && add_entry.after_present
                        && add_entry.after_signature.as_ref() == Some(signature)
                        && add_entry.path != delete_entry.path
                })
            else {
                continue;
            };
            consumed[delete_idx] = true;
            consumed[add_idx] = true;
            display.push(NativeDisplayDiff {
                order_key: delete_idx.min(add_idx),
                old_path: delete_entry.path.clone(),
                new_path: add_entry.path.clone(),
                kind: NativeDisplayDiffKind::Renamed {
                    old_path: delete_entry.path.clone(),
                    new_path: add_entry.path.clone(),
                },
                before_bytes: delete_entry.before_bytes.clone(),
                after_bytes: add_entry.after_bytes.clone(),
            });
        }

        // Similarity-based rename detection: pair remaining deletes with the
        // most similar unmatched add when content overlap meets jj's default
        // 50% threshold. This mirrors old `jj diff` detecting a rename even
        // when the file content was also modified.
        const RENAME_SIMILARITY_THRESHOLD: f32 = 0.5;
        let delete_indices: Vec<usize> = entries
            .iter()
            .enumerate()
            .filter(|(idx, entry)| !consumed[*idx] && entry.before_present && !entry.after_present)
            .map(|(idx, _)| idx)
            .collect();
        for delete_idx in delete_indices {
            if consumed[delete_idx] {
                continue;
            }
            let delete_entry = &entries[delete_idx];
            let Some((add_idx, _ratio)) = entries
                .iter()
                .enumerate()
                .filter(|(add_idx, add_entry)| {
                    !consumed[*add_idx]
                        && !add_entry.before_present
                        && add_entry.after_present
                        && add_entry.path != delete_entry.path
                })
                .map(|(add_idx, add_entry)| {
                    (
                        add_idx,
                        Self::content_similarity_ratio(
                            delete_entry.before_bytes.as_deref(),
                            add_entry.after_bytes.as_deref(),
                        ),
                    )
                })
                .filter(|(_, ratio)| *ratio >= RENAME_SIMILARITY_THRESHOLD)
                .max_by(|left, right| {
                    left.1
                        .partial_cmp(&right.1)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
            else {
                continue;
            };
            consumed[delete_idx] = true;
            consumed[add_idx] = true;
            let add_entry = &entries[add_idx];
            display.push(NativeDisplayDiff {
                order_key: delete_idx.min(add_idx),
                old_path: delete_entry.path.clone(),
                new_path: add_entry.path.clone(),
                kind: NativeDisplayDiffKind::Renamed {
                    old_path: delete_entry.path.clone(),
                    new_path: add_entry.path.clone(),
                },
                before_bytes: delete_entry.before_bytes.clone(),
                after_bytes: add_entry.after_bytes.clone(),
            });
        }

        for (idx, entry) in entries.into_iter().enumerate() {
            if consumed[idx] {
                continue;
            }
            let kind = match (entry.before_present, entry.after_present) {
                (false, true) => NativeDisplayDiffKind::Added,
                (true, false) => NativeDisplayDiffKind::Deleted,
                _ => NativeDisplayDiffKind::Modified,
            };
            display.push(NativeDisplayDiff {
                order_key: idx,
                old_path: entry.path.clone(),
                new_path: entry.path.clone(),
                kind,
                before_bytes: entry.before_bytes,
                after_bytes: entry.after_bytes,
            });
        }

        display.sort_by(|left, right| {
            left.order_key
                .cmp(&right.order_key)
                .then(left.old_path.cmp(&right.old_path))
                .then(left.new_path.cmp(&right.new_path))
        });
        display
    }

    fn render_display_diff_patch(display: &NativeDisplayDiff) -> String {
        let mut file_output = String::new();
        file_output.push_str(&format!(
            "diff --git a/{} b/{}\n",
            display.old_path, display.new_path
        ));
        match &display.kind {
            NativeDisplayDiffKind::Renamed { old_path, new_path } => {
                file_output.push_str(&format!("rename from {old_path}\nrename to {new_path}\n"));
            }
            NativeDisplayDiffKind::Added => file_output.push_str("new file mode 100644\n"),
            NativeDisplayDiffKind::Deleted => file_output.push_str("deleted file mode 100644\n"),
            NativeDisplayDiffKind::Modified => {}
        }
        // Pure renames with identical content carry no content hunk, matching
        // old `jj diff --git` which stops after the rename metadata. Added /
        // deleted / modified entries always proceed to a content section.
        let pure_rename = matches!(display.kind, NativeDisplayDiffKind::Renamed { .. })
            && display.before_bytes == display.after_bytes;
        if pure_rename {
            return file_output;
        }
        let old_header = match display.kind {
            NativeDisplayDiffKind::Added => "/dev/null".to_string(),
            _ => format!("a/{}", display.old_path),
        };
        let new_header = match display.kind {
            NativeDisplayDiffKind::Deleted => "/dev/null".to_string(),
            _ => format!("b/{}", display.new_path),
        };
        if Self::is_binary_content(display.before_bytes.as_deref())
            || Self::is_binary_content(display.after_bytes.as_deref())
        {
            file_output.push_str(&format!(
                "Binary files {old_header} and {new_header} differ\n"
            ));
        } else {
            let before_text = Self::bytes_to_lossy_text(display.before_bytes.as_deref());
            let after_text = Self::bytes_to_lossy_text(display.after_bytes.as_deref());
            let diff = TextDiff::from_lines(&before_text, &after_text);
            file_output.push_str(
                &diff
                    .unified_diff()
                    .context_radius(3)
                    .header(&old_header, &new_header)
                    .to_string(),
            );
        }
        file_output
    }

    pub async fn diff_preview(&self, query: ChangeQuery, max_lines: usize) -> Result<String> {
        self.diff_with_line_limit(query, Some(max_lines)).await
    }

    fn normalize_unified_hunk_header(line: &str) -> String {
        fn expand(range: &str) -> String {
            if range.contains(',') {
                range.to_string()
            } else {
                format!("{range},1")
            }
        }

        let Some(inner) = line
            .strip_prefix("@@ ")
            .and_then(|value| value.strip_suffix(" @@"))
        else {
            return line.to_string();
        };
        let mut parts = inner.split_whitespace();
        let Some(old_range) = parts.next() else {
            return line.to_string();
        };
        let Some(new_range) = parts.next() else {
            return line.to_string();
        };
        if !old_range.starts_with('-') || !new_range.starts_with('+') {
            return line.to_string();
        }
        format!("@@ {} {} @@", expand(old_range), expand(new_range))
    }

    async fn diff_with_line_limit(
        &self,
        query: ChangeQuery,
        max_lines: Option<usize>,
    ) -> Result<String> {
        let (repo, commit, commit_tree) = self
            .resolve_change_tree(&query.cwd, &query.change_id)
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
        let entries = self
            .collect_native_diff_entries(&repo, &parent_tree, &commit_tree)
            .await?;
        let mut output = String::new();
        let mut line_count = 0usize;
        let mut truncated = false;
        for display in Self::build_display_diffs(entries) {
            if max_lines.is_some_and(|limit| line_count >= limit) {
                truncated = true;
                break;
            }
            let file_output = Self::render_display_diff_patch(&display);
            for line in file_output.lines() {
                if max_lines.is_some_and(|limit| line_count >= limit) {
                    truncated = true;
                    break;
                }
                output.push_str(&Self::normalize_unified_hunk_header(line));
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
        let (repo, commit, commit_tree) = self
            .resolve_change_tree(&query.cwd, &query.change_id)
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
        let entries = self
            .collect_native_diff_entries(&repo, &parent_tree, &commit_tree)
            .await?;
        let mut files = Vec::new();
        for display in Self::build_display_diffs(entries) {
            let (file_type, path) = match display.kind {
                NativeDisplayDiffKind::Added => ("A", display.new_path),
                NativeDisplayDiffKind::Deleted => ("D", display.old_path),
                NativeDisplayDiffKind::Modified => ("M", display.new_path),
                NativeDisplayDiffKind::Renamed { old_path, new_path } => {
                    ("R", Self::format_rename_summary(&old_path, &new_path))
                }
            };
            files.push(FileEntry {
                r#type: file_type.to_string(),
                path,
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
            Mutation::Describe {
                cwd,
                change_id,
                description,
            } => {
                cli_fallback::describe(&cwd, &change_id, &description)?;
                Ok(MutationResult {
                    changed: true,
                    message: format!("described change {change_id}"),
                })
            }
            Mutation::Rebase {
                cwd,
                source_id,
                destination_id,
            } => {
                cli_fallback::rebase(&cwd, &source_id, &destination_id)?;
                Ok(MutationResult {
                    changed: true,
                    message: format!("rebased change {source_id} onto {destination_id}"),
                })
            }
            Mutation::Insert {
                cwd,
                parent_id,
                child_id,
            } => {
                cli_fallback::insert(&cwd, &parent_id, &child_id)?;
                Ok(MutationResult {
                    changed: true,
                    message: format!("inserted new change between {parent_id} and {child_id}"),
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
            Mutation::Restore {
                cwd,
                change_id,
                paths,
            } => {
                cli_fallback::restore(&cwd, &change_id, &paths)?;
                Ok(MutationResult {
                    changed: true,
                    message: format!("restored change {change_id}"),
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

    fn create_dirty_working_copy_fixture_repo() -> PathBuf {
        let repo = create_action_fixture_repo();
        fs::write(repo.join("note.txt"), "three\n")
            .expect("dirty working-copy file rewrite should work");
        fs::write(repo.join("extra.txt"), "bonus\n")
            .expect("dirty working-copy new file write should work");
        repo
    }

    fn create_binary_fixture_repo() -> PathBuf {
        let repo = unique_test_dir("binary-diff");
        fs::create_dir_all(&repo).expect("fixture repo dir should be created");
        run_jj(&repo, &["git", "init", "."]);
        fs::write(
            repo.join("image.png"),
            [
                0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0x00, 0x01, 0x02, 0x03,
            ],
        )
        .expect("binary fixture write should work");
        run_jj(&repo, &["describe", "-m", "binary add"]);
        repo
    }

    fn create_pure_rename_fixture_repo() -> PathBuf {
        let repo = unique_test_dir("rename-diff");
        fs::create_dir_all(&repo).expect("fixture repo dir should be created");
        run_jj(&repo, &["git", "init", "."]);
        fs::write(repo.join("old.txt"), "hello\n").expect("rename fixture write should work");
        run_jj(&repo, &["describe", "-m", "rename base"]);
        run_jj(&repo, &["new"]);
        fs::rename(repo.join("old.txt"), repo.join("new.txt"))
            .expect("rename fixture move should work");
        run_jj(&repo, &["describe", "-m", "rename change"]);
        repo
    }

    fn create_rename_modify_fixture_repo() -> PathBuf {
        let repo = unique_test_dir("rename-modify-diff");
        fs::create_dir_all(&repo).expect("fixture repo dir should be created");
        run_jj(&repo, &["git", "init", "."]);
        fs::write(
            repo.join("old.txt"),
            "hello\nworld\nthis is line three\nand line four\n",
        )
        .expect("rename-modify fixture write should work");
        run_jj(&repo, &["describe", "-m", "rename mod base"]);
        run_jj(&repo, &["new"]);
        fs::rename(repo.join("old.txt"), repo.join("new.txt"))
            .expect("rename-modify fixture move should work");
        fs::write(
            repo.join("new.txt"),
            "hello\nworld CHANGED\nthis is line three\nand line four\nNEW LINE\n",
        )
        .expect("rename-modify fixture rewrite should work");
        run_jj(&repo, &["describe", "-m", "rename mod change"]);
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

    fn create_rebase_fixture_repo() -> PathBuf {
        let repo = unique_test_dir("rebase-mutations");
        fs::create_dir_all(&repo).expect("fixture repo dir should be created");
        run_jj(&repo, &["git", "init", "."]);
        fs::write(repo.join("a.txt"), "one\n").expect("fixture file write should work");
        run_jj(&repo, &["describe", "-m", "first desc"]);
        run_jj(&repo, &["new", "@"]).trim().to_string();
        fs::write(repo.join("b.txt"), "two\n").expect("fixture file write should work");
        run_jj(&repo, &["describe", "-m", "second desc"]);
        run_jj(&repo, &["new", "@"]).trim().to_string();
        fs::write(repo.join("c.txt"), "three\n").expect("fixture file write should work");
        run_jj(&repo, &["describe", "-m", "third desc"]);
        repo
    }

    fn create_merge_fixture_repo() -> PathBuf {
        let repo = unique_test_dir("merge-mutations");
        fs::create_dir_all(&repo).expect("fixture repo dir should be created");
        run_jj(&repo, &["git", "init", "."]);
        fs::write(repo.join("base.txt"), "base\n").expect("fixture file write should work");
        run_jj(&repo, &["describe", "-m", "base desc"]);
        run_jj(&repo, &["new", "@"]).trim().to_string();
        fs::write(repo.join("left.txt"), "left\n").expect("fixture file write should work");
        run_jj(&repo, &["describe", "-m", "left desc"]);
        run_jj(&repo, &["new", "@-"]).trim().to_string();
        fs::write(repo.join("right.txt"), "right\n").expect("fixture file write should work");
        run_jj(&repo, &["describe", "-m", "right desc"]);
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
        let selected = nodes
            .iter()
            .find(|node| {
                !node.is_root && !node.is_working_copy && !node.description_title.is_empty()
            })
            .or_else(|| {
                nodes
                    .iter()
                    .find(|node| !node.is_root && !node.is_working_copy)
            })
            .unwrap_or(&nodes[0]);
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
    fn native_files_reads_dirty_working_copy_without_snapshotting_repo_state() {
        let repo = create_dirty_working_copy_fixture_repo();
        let backend = NativeJjBackend::new();
        let before_node = futures::executor::block_on(backend.log(LogQuery {
            cwd: repo.clone(),
            limit: 8,
            revset: None,
        }))
        .expect("dirty working-copy log should load")
        .into_iter()
        .find(|node| node.is_working_copy)
        .expect("dirty working-copy node should exist");
        let before_identity = format!(
            "{}\x01{}\x01{}",
            before_node.change_id, before_node.commit_id, before_node.description_title
        );

        let files = futures::executor::block_on(backend.files(ChangeQuery {
            cwd: repo.clone(),
            change_id: before_node.change_id.clone(),
        }))
        .expect("dirty working-copy files should load");

        assert_eq!(
            files,
            vec![
                FileEntry {
                    r#type: "A".to_string(),
                    path: "extra.txt".to_string(),
                },
                FileEntry {
                    r#type: "M".to_string(),
                    path: "note.txt".to_string(),
                },
            ]
        );

        let after_node = futures::executor::block_on(backend.log(LogQuery {
            cwd: repo.clone(),
            limit: 8,
            revset: None,
        }))
        .expect("dirty working-copy log should still load")
        .into_iter()
        .find(|node| node.is_working_copy)
        .expect("dirty working-copy node should still exist");
        let after_identity = format!(
            "{}\x01{}\x01{}",
            after_node.change_id, after_node.commit_id, after_node.description_title
        );
        assert_eq!(after_identity, before_identity);

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn native_diff_reads_dirty_working_copy_without_snapshotting_repo_state() {
        let repo = create_dirty_working_copy_fixture_repo();
        let backend = NativeJjBackend::new();
        let before_node = futures::executor::block_on(backend.log(LogQuery {
            cwd: repo.clone(),
            limit: 8,
            revset: None,
        }))
        .expect("dirty working-copy log should load")
        .into_iter()
        .find(|node| node.is_working_copy)
        .expect("dirty working-copy node should exist");
        let before_identity = format!(
            "{}\x01{}\x01{}",
            before_node.change_id, before_node.commit_id, before_node.description_title
        );

        let diff = futures::executor::block_on(backend.diff(ChangeQuery {
            cwd: repo.clone(),
            change_id: before_node.change_id.clone(),
        }))
        .expect("dirty working-copy diff should load");

        assert!(diff.contains("diff --git a/extra.txt b/extra.txt"));
        assert!(diff.contains("diff --git a/note.txt b/note.txt"));
        assert!(diff.contains("@@ -0,0 +1,1 @@"));
        assert!(diff.contains("@@ -1,1 +1,1 @@"));
        assert!(diff.contains("+bonus"));
        assert!(diff.contains("+three"));
        assert!(!diff.contains("+two"));

        let after_node = futures::executor::block_on(backend.log(LogQuery {
            cwd: repo.clone(),
            limit: 8,
            revset: None,
        }))
        .expect("dirty working-copy log should still load")
        .into_iter()
        .find(|node| node.is_working_copy)
        .expect("dirty working-copy node should still exist");
        let after_identity = format!(
            "{}\x01{}\x01{}",
            after_node.change_id, after_node.commit_id, after_node.description_title
        );
        assert_eq!(after_identity, before_identity);

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn native_diff_renders_binary_file_as_metadata_not_lossy_garbage() {
        let repo = create_binary_fixture_repo();
        let backend = NativeJjBackend::new();
        let change_id = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();

        let diff = futures::executor::block_on(backend.diff(ChangeQuery {
            cwd: repo.clone(),
            change_id,
        }))
        .expect("binary diff should load");

        assert!(diff.contains("diff --git a/image.png b/image.png"));
        assert!(diff.contains("new file mode 100644"));
        assert!(diff.contains("Binary files /dev/null and b/image.png differ"));
        assert!(!diff.contains("PNG\r"));

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn native_files_render_pure_rename_summary() {
        let repo = create_pure_rename_fixture_repo();
        let backend = NativeJjBackend::new();
        let change_id = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();

        let files = futures::executor::block_on(backend.files(ChangeQuery {
            cwd: repo.clone(),
            change_id,
        }))
        .expect("rename files should load");

        assert_eq!(
            files,
            vec![FileEntry {
                r#type: "R".to_string(),
                path: "{old.txt => new.txt}".to_string(),
            }]
        );

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn native_diff_renders_pure_rename_git_patch() {
        let repo = create_pure_rename_fixture_repo();
        let backend = NativeJjBackend::new();
        let change_id = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();

        let diff = futures::executor::block_on(backend.diff(ChangeQuery {
            cwd: repo.clone(),
            change_id,
        }))
        .expect("rename diff should load");

        assert_eq!(
            diff,
            "diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n"
        );

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn native_files_render_rename_with_modify_summary() {
        let repo = create_rename_modify_fixture_repo();
        let backend = NativeJjBackend::new();
        let change_id = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();

        let files = futures::executor::block_on(backend.files(ChangeQuery {
            cwd: repo.clone(),
            change_id,
        }))
        .expect("rename-modify files should load");

        assert_eq!(
            files,
            vec![FileEntry {
                r#type: "R".to_string(),
                path: "{old.txt => new.txt}".to_string(),
            }]
        );

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn native_diff_renders_rename_with_modify_git_patch() {
        let repo = create_rename_modify_fixture_repo();
        let backend = NativeJjBackend::new();
        let change_id = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();

        let diff = futures::executor::block_on(backend.diff(ChangeQuery {
            cwd: repo.clone(),
            change_id,
        }))
        .expect("rename-modify diff should load");

        // Old `jj diff --git` emits rename metadata followed by an `index` line
        // and a unified content hunk.
        // The Rust backend omits the index line for consistency with the other
        // diff kinds, so assert the rename header is a prefix and the hunk body
        // carries the modified content lines.
        assert!(
            diff.starts_with(
                "diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n"
            ),
            "rename-modify diff should start with rename metadata, got: {diff}"
        );
        assert!(
            diff.contains("--- a/old.txt\n+++ b/new.txt\n"),
            "rename-modify diff should carry a/old b/new content headers, got: {diff}"
        );
        assert!(
            diff.contains("-world\n+world CHANGED\n"),
            "rename-modify diff should show the modified content hunk, got: {diff}"
        );
        assert!(
            diff.contains("+NEW LINE\n"),
            "rename-modify diff should show the added line, got: {diff}"
        );

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
    fn native_new_mutation_with_multiple_parents_creates_merge_working_copy() {
        let repo = create_merge_fixture_repo();
        let backend = NativeJjBackend::new();
        let titles = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                "::",
                "-T",
                "change_id.short() ++ \"|\" ++ description.first_line() ++ \"\\n\"",
            ],
        );
        let left_change_id = titles
            .lines()
            .find_map(|line| {
                line.split_once('|')
                    .filter(|(_, title)| *title == "left desc")
            })
            .map(|(change_id, _)| change_id.to_string())
            .expect("left fixture change should exist");
        let right_change_id = run_jj(
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
            parent_id: None,
            parent_ids: vec![left_change_id.clone(), right_change_id.clone()],
        }))
        .expect("merge new mutation should succeed");
        assert!(result.changed, "merge new mutation should report a change");

        let after_count = run_jj(&repo, &["log", "-r", "::", "--count"])
            .trim()
            .parse::<usize>()
            .expect("after count should parse");
        assert_eq!(after_count, before_count + 1);
        let parents_after = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                "@",
                "-T",
                "parents.map(|p| p.change_id().short()).join(\",\")",
            ],
        );
        let parent_ids: Vec<_> = parents_after
            .trim()
            .split(',')
            .filter(|value| !value.is_empty())
            .collect();
        assert_eq!(parent_ids.len(), 2);
        assert!(parent_ids.contains(&left_change_id.as_str()));
        assert!(parent_ids.contains(&right_change_id.as_str()));

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
    fn native_describe_mutation_updates_selected_change_description() {
        let repo = create_action_fixture_repo();
        let backend = NativeJjBackend::new();
        let target_change_id = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();

        let result = futures::executor::block_on(backend.mutate(Mutation::Describe {
            cwd: repo.clone(),
            change_id: target_change_id.clone(),
            description: "renamed from rust test".to_string(),
        }))
        .expect("describe mutation should succeed");
        assert!(result.changed, "describe mutation should report a change");

        let after = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                &target_change_id,
                "-T",
                "description.first_line()",
            ],
        );
        assert_eq!(after.trim(), "renamed from rust test");

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn native_restore_mutation_reverts_selected_change_contents_but_keeps_description() {
        let repo = create_action_fixture_repo();
        let backend = NativeJjBackend::new();
        let target_change_id = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();

        let result = futures::executor::block_on(backend.mutate(Mutation::Restore {
            cwd: repo.clone(),
            change_id: target_change_id.clone(),
            paths: Vec::new(),
        }))
        .expect("restore mutation should succeed");
        assert!(result.changed, "restore mutation should report a change");

        let after = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                "@",
                "-T",
                "change_id.short() ++ \"|\" ++ description.first_line() ++ \"|\" ++ empty ++ \"\\n\"",
            ],
        );
        let mut parts = after.trim().split('|');
        assert_eq!(parts.next(), Some(target_change_id.as_str()));
        assert_eq!(parts.next(), Some("second desc"));
        assert_eq!(parts.next(), Some("true"));
        let diff_after = run_jj(&repo, &["diff", "--summary", "-r", "@"]);
        assert!(
            diff_after.trim().is_empty(),
            "restore should clear file diff"
        );

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
    fn native_rebase_mutation_moves_selected_change_onto_new_destination() {
        let repo = create_rebase_fixture_repo();
        let backend = NativeJjBackend::new();
        let source_change_id = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();
        let destination_change_id = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@--", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();
        let before_parent = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@-", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();
        assert_ne!(before_parent, destination_change_id);

        let result = futures::executor::block_on(backend.mutate(Mutation::Rebase {
            cwd: repo.clone(),
            source_id: source_change_id.clone(),
            destination_id: destination_change_id.clone(),
        }))
        .expect("rebase mutation should succeed");
        assert!(result.changed, "rebase mutation should report a change");

        let after_current = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                "@",
                "-T",
                "change_id.short() ++ \"|\" ++ description.first_line()",
            ],
        );
        let mut current_parts = after_current.trim().split('|');
        assert_eq!(current_parts.next(), Some(source_change_id.as_str()));
        assert_eq!(current_parts.next(), Some("third desc"));

        let after_parent = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@-", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();
        assert_eq!(after_parent, destination_change_id);

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn native_insert_mutation_creates_new_change_between_parent_and_child() {
        let repo = create_action_fixture_repo();
        let backend = NativeJjBackend::new();
        let parent_change_id = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@-", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();
        let child_change_id = run_jj(
            &repo,
            &["log", "--no-graph", "-r", "@", "-T", "change_id.short()"],
        )
        .trim()
        .to_string();
        let before_count = run_jj(&repo, &["log", "-r", "::", "--count"])
            .trim()
            .parse::<usize>()
            .expect("before count should parse");

        let result = futures::executor::block_on(backend.mutate(Mutation::Insert {
            cwd: repo.clone(),
            parent_id: parent_change_id.clone(),
            child_id: child_change_id.clone(),
        }))
        .expect("insert mutation should succeed");
        assert!(result.changed, "insert mutation should report a change");

        let after_count = run_jj(&repo, &["log", "-r", "::", "--count"])
            .trim()
            .parse::<usize>()
            .expect("after count should parse");
        assert_eq!(after_count, before_count + 1);

        let current = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                "@",
                "-T",
                "change_id.short() ++ \"|\" ++ description.first_line() ++ \"|\" ++ parents.map(|p| p.change_id().short()).join(\",\")",
            ],
        );
        let mut current_parts = current.trim().split('|');
        let inserted_change_id = current_parts.next().unwrap_or_default().to_string();
        let inserted_description = current_parts.next().unwrap_or_default();
        let inserted_parent = current_parts.next().unwrap_or_default();
        assert_eq!(inserted_description, "");
        assert_eq!(inserted_parent, parent_change_id);
        assert_ne!(inserted_change_id, child_change_id);

        let rebased_child_parent = run_jj(
            &repo,
            &[
                "log",
                "--no-graph",
                "-r",
                &child_change_id,
                "-T",
                "parents.map(|p| p.change_id().short()).join(\",\")",
            ],
        )
        .trim()
        .to_string();
        assert_eq!(rebased_child_parent, inserted_change_id);

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
