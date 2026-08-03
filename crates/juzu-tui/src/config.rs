//! Theme configuration and persistence.
//!
//! The selected theme is written to `<repo>/.juzu.local.toml` as
//! `[theme]\nname = "..."` and read back on startup. The parser intentionally
//! handles only the configuration surface currently supported by the TUI.

use std::fs;
use std::path::{Path, PathBuf};

use juzu_core::JuzuError;

/// The repository-local config file written by the theme picker.
pub const REPO_LOCAL_CONFIG: &str = ".juzu.local.toml";

/// The repo-shared config filename (checked into the repo, not written by the TUI).
pub const REPO_CONFIG: &str = ".juzu.toml";

/// The global config filename under `$XDG_CONFIG_HOME/juzu/`.
pub const GLOBAL_CONFIG_REL: &str = "juzu/config.toml";

/// Read the persisted theme name, preferring repo-local, then repo-shared,
/// then the global XDG config. Returns `None` when no config names a theme.
pub fn load_theme_name(repo_root: &Path) -> Option<String> {
    for candidate in config_candidates(repo_root) {
        if let Some(name) = read_theme_name_from_file(&candidate) {
            return Some(name);
        }
    }
    None
}

/// Persist the selected theme name into `<repo>/.juzu.local.toml`, preserving
/// any unrelated TOML sections already present.
pub fn save_theme_name(repo_root: &Path, theme_name: &str) -> Result<(), JuzuError> {
    let path = repo_root.join(REPO_LOCAL_CONFIG);
    let raw = fs::read_to_string(&path).unwrap_or_default();
    let next = upsert_theme_name_in_toml(&raw, theme_name);
    fs::write(&path, next).map_err(|err| {
        JuzuError::Backend(format!(
            "failed to write juzu local config {}: {err}",
            path.display()
        ))
    })
}

fn config_candidates(repo_root: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![
        repo_root.join(REPO_LOCAL_CONFIG),
        repo_root.join(REPO_CONFIG),
    ];
    if let Some(global) = global_config_path() {
        candidates.push(global);
    }
    candidates
}

fn global_config_path() -> Option<PathBuf> {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return Some(PathBuf::from(xdg).join(GLOBAL_CONFIG_REL));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return Some(PathBuf::from(home).join(".config").join(GLOBAL_CONFIG_REL));
        }
    }
    None
}

/// Parse `[theme]\nname = "..."` out of a TOML string. Only the first
/// `[theme]` section is considered.
pub fn read_theme_name_from_file(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    read_theme_name_from_text(&raw)
}

pub fn read_theme_name_from_text(raw: &str) -> Option<String> {
    let mut in_theme = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_theme = trimmed == "[theme]";
            continue;
        }
        if !in_theme {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            if key.trim() == "name" {
                let value = value.trim().trim_matches('"');
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

/// Replace (or insert) the `[theme] name = "..."` section, keeping all other
/// sections intact.
pub fn upsert_theme_name_in_toml(raw: &str, theme_name: &str) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut in_theme = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_theme = trimmed == "[theme]";
            if !in_theme {
                kept.push(line);
            }
            continue;
        }
        if !in_theme {
            kept.push(line);
        }
    }
    let stripped = kept.join("\n").trim_end().to_string();
    let spacer = if stripped.is_empty() { "" } else { "\n\n" };
    format!("{stripped}{spacer}[theme]\nname = \"{theme_name}\"\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn unique_test_dir(label: &str) -> PathBuf {
        let id = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("juzu-tui-config-{label}-{id}"));
        std::fs::create_dir_all(&dir).expect("test dir should be created");
        dir
    }

    #[test]
    fn read_theme_name_parses_quoted_value() {
        let raw = "[theme]\nname = \"dracula\"\n";
        assert_eq!(read_theme_name_from_text(raw), Some("dracula".to_string()));
    }

    #[test]
    fn read_theme_name_ignores_other_sections() {
        let raw = "[layout]\nstartupMode = \"mainline\"\n\n[theme]\nname = \"ember\"\n\n[tui]\nsidebarMinHeight = 16\n";
        assert_eq!(read_theme_name_from_text(raw), Some("ember".to_string()));
    }

    #[test]
    fn read_theme_name_returns_none_when_missing() {
        assert_eq!(
            read_theme_name_from_text("[layout]\nstartupMode = \"mainline\"\n"),
            None
        );
        assert_eq!(read_theme_name_from_text(""), None);
    }

    #[test]
    fn upsert_inserts_theme_section_into_empty_config() {
        let next = upsert_theme_name_in_toml("", "slate");
        assert_eq!(next, "[theme]\nname = \"slate\"\n");
    }

    #[test]
    fn upsert_replaces_existing_theme_section_but_keeps_others() {
        let raw = "[layout]\nstartupMode = \"mainline\"\n\n[theme]\nname = \"slate\"\n\n[tui]\nsidebarMinHeight = 16\n";
        let next = upsert_theme_name_in_toml(raw, "dracula");
        assert!(next.contains("[layout]\nstartupMode = \"mainline\""));
        assert!(next.contains("[theme]\nname = \"dracula\""));
        assert!(next.contains("[tui]\nsidebarMinHeight = 16"));
        assert!(!next.contains("name = \"slate\""));
    }

    #[test]
    fn save_then_load_round_trips_theme_name() {
        let repo = unique_test_dir("round-trip");
        save_theme_name(&repo, "tokyo-night").expect("save should work");
        let loaded = load_theme_name(&repo).expect("load should find the theme");
        assert_eq!(loaded, "tokyo-night");
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn load_prefers_repo_local_over_repo_shared() {
        let repo = unique_test_dir("precedence");
        std::fs::write(repo.join(REPO_CONFIG), "[theme]\nname = \"slate\"\n").unwrap();
        std::fs::write(repo.join(REPO_LOCAL_CONFIG), "[theme]\nname = \"ember\"\n").unwrap();
        assert_eq!(load_theme_name(&repo), Some("ember".to_string()));
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn save_preserves_unrelated_sections_in_local_config() {
        let repo = unique_test_dir("preserve");
        let path = repo.join(REPO_LOCAL_CONFIG);
        std::fs::write(&path, "[layout]\nstartupMode = \"mainline\"\n").unwrap();
        save_theme_name(&repo, "nord").expect("save should work");
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("[layout]\nstartupMode = \"mainline\""));
        assert!(raw.contains("[theme]\nname = \"nord\""));
        std::fs::remove_dir_all(&repo).ok();
    }
}
