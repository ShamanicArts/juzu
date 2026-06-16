use anyhow::Result;
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use juzu_core::{
    diff::{collapsed_diff_rows, parse_git_patch, DiffRow, DiffRowKind},
    layout::calculate_default_layout,
    ChangeQuery, FileEntry, JjBackend, LayoutMode, LogQuery,
};
use juzu_jj::NativeJjBackend;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    DefaultTerminal, Frame,
};
use std::{collections::HashMap, io::stdout, path::PathBuf, time::Duration};

const DIFF_PREVIEW_ROW_CAP: usize = 420;
const DEFAULT_LOG_LIMIT: usize = 500;

#[derive(Clone, Copy)]
struct UiTokens {
    slate_bg0: Color,
    slate_panel: Color,
    slate_bg2: Color,
    slate_text: Color,
    slate_text_muted: Color,
    slate_border_soft: Color,
    slate_border_strong: Color,
    semantic_info: Color,
    semantic_success: Color,
    semantic_warn: Color,
    semantic_error: Color,
    semantic_mode_log: Color,
    semantic_file_add: Color,
    semantic_file_del: Color,
    slate_bg1: Color,
    graph_lanes: [Color; 8],
    graph_text_desc: Color,
    graph_text_muted: Color,
    graph_commit_id: Color,
    graph_bookmark: Color,
    graph_bookmark_selected: Color,
    graph_file_add: Color,
    graph_file_mod: Color,
    graph_file_del: Color,
}

const UI_TOKENS: UiTokens = UiTokens {
    slate_bg0: Color::Rgb(0x11, 0x13, 0x18),
    slate_panel: Color::Rgb(0x1a, 0x20, 0x29),
    slate_bg2: Color::Rgb(0x1d, 0x25, 0x30),
    slate_text: Color::Rgb(0xd8, 0xde, 0xe8),
    slate_text_muted: Color::Rgb(0x8a, 0x95, 0xa7),
    slate_border_soft: Color::Rgb(0x2a, 0x34, 0x42),
    slate_border_strong: Color::Rgb(0x3a, 0x47, 0x59),
    semantic_info: Color::Rgb(0x7f, 0x9f, 0xbf),
    semantic_success: Color::Rgb(0x74, 0xb8, 0x8c),
    semantic_warn: Color::Rgb(0xc9, 0xa8, 0x6a),
    semantic_error: Color::Rgb(0xce, 0x6f, 0x7c),
    semantic_mode_log: Color::Rgb(0x6f, 0x89, 0xad),
    semantic_file_add: Color::Rgb(0x22, 0xc5, 0x5e),
    semantic_file_del: Color::Rgb(0xef, 0x44, 0x44),
    slate_bg1: Color::Rgb(0x16, 0x1b, 0x22),
    graph_lanes: [
        Color::Rgb(0x00, 0xf0, 0xff),
        Color::Rgb(0xff, 0x00, 0x55),
        Color::Rgb(0x00, 0xff, 0x9d),
        Color::Rgb(0xff, 0xaa, 0x00),
        Color::Rgb(0xaa, 0x00, 0xff),
        Color::Rgb(0x00, 0xaa, 0xff),
        Color::Rgb(0xff, 0xff, 0x00),
        Color::Rgb(0xff, 0x00, 0xaa),
    ],
    graph_text_desc: Color::Rgb(0xbb, 0xbb, 0xbb),
    graph_text_muted: Color::Rgb(0x6a, 0x76, 0x85),
    graph_commit_id: Color::Rgb(0x5a, 0x6a, 0x7a),
    graph_bookmark: Color::Rgb(0xc9, 0xa8, 0x6a),
    graph_bookmark_selected: Color::Rgb(0xe8, 0xc8, 0x84),
    graph_file_add: Color::Rgb(0x74, 0xb8, 0x8c),
    graph_file_mod: Color::Rgb(0xc9, 0xa8, 0x6a),
    graph_file_del: Color::Rgb(0xce, 0x6f, 0x7c),
};

const EMBEDDED_THEMES: &[(&str, &str)] = &[
    (
        "ayu-mirage",
        include_str!("../../../themes/ayu-mirage.toml"),
    ),
    (
        "catppuccin",
        include_str!("../../../themes/catppuccin.toml"),
    ),
    ("cyberpunk", include_str!("../../../themes/cyberpunk.toml")),
    ("dracula", include_str!("../../../themes/dracula.toml")),
    ("ember", include_str!("../../../themes/ember.toml")),
    (
        "everforest",
        include_str!("../../../themes/everforest.toml"),
    ),
    (
        "github-dark",
        include_str!("../../../themes/github-dark.toml"),
    ),
    ("gruvbox", include_str!("../../../themes/gruvbox.toml")),
    ("kanagawa", include_str!("../../../themes/kanagawa.toml")),
    ("monokai", include_str!("../../../themes/monokai.toml")),
    ("moss", include_str!("../../../themes/moss.toml")),
    ("night-owl", include_str!("../../../themes/night-owl.toml")),
    ("nocturne", include_str!("../../../themes/nocturne.toml")),
    ("nord", include_str!("../../../themes/nord.toml")),
    ("oceanic", include_str!("../../../themes/oceanic.toml")),
    ("one-dark", include_str!("../../../themes/one-dark.toml")),
    ("palenight", include_str!("../../../themes/palenight.toml")),
    ("rose-pine", include_str!("../../../themes/rose-pine.toml")),
    (
        "shades-of-purple",
        include_str!("../../../themes/shades-of-purple.toml"),
    ),
    ("slate", include_str!("../../../themes/slate.toml")),
    (
        "tokyo-night",
        include_str!("../../../themes/tokyo-night.toml"),
    ),
];

impl UiTokens {
    fn named(name: &str) -> Self {
        EMBEDDED_THEMES
            .iter()
            .find(|(theme_name, _)| *theme_name == name)
            .map(|(_, raw)| Self::from_theme_toml(raw))
            .unwrap_or(UI_TOKENS)
    }

    fn from_theme_toml(raw: &str) -> Self {
        let mut tokens = UI_TOKENS;
        let mut section = String::new();
        let mut collecting_lanes = false;
        let mut lanes = Vec::new();
        for raw_line in raw.lines() {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if collecting_lanes {
                if let Some(color) = extract_hex_color(line).and_then(parse_hex_color) {
                    lanes.push(color);
                }
                if line.contains(']') {
                    for (idx, color) in lanes.iter().copied().take(8).enumerate() {
                        tokens.graph_lanes[idx] = color;
                    }
                    collecting_lanes = false;
                }
                continue;
            }
            if line.starts_with('[') && line.ends_with(']') {
                section = line.trim_matches(&['[', ']'][..]).to_string();
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let key = key.trim();
            if section == "graph" && key == "lanes" {
                collecting_lanes = true;
                lanes.clear();
                if let Some(color) = extract_hex_color(value).and_then(parse_hex_color) {
                    lanes.push(color);
                }
                continue;
            }
            let value = value.trim().trim_matches('"');
            let Some(color) = parse_hex_color(value) else {
                continue;
            };
            tokens.apply_theme_token(&section, key, color);
        }
        tokens.ensure_readable_contrast()
    }

    fn apply_theme_token(&mut self, section: &str, key: &str, color: Color) {
        match (section, key) {
            ("slate", "bg0") => self.slate_bg0 = color,
            ("slate", "bg1") => self.slate_bg1 = color,
            ("slate", "bg2") => self.slate_bg2 = color,
            ("slate", "panel") => self.slate_panel = color,
            ("slate", "borderSoft") => self.slate_border_soft = color,
            ("slate", "borderStrong") => self.slate_border_strong = color,
            ("slate", "text") => self.slate_text = color,
            ("slate", "textMuted") => self.slate_text_muted = color,
            ("semantic", "success" | "modeMarks") => self.semantic_success = color,
            ("semantic", "warn" | "modeAction") => self.semantic_warn = color,
            ("semantic", "error") => self.semantic_error = color,
            ("semantic", "info" | "modeOps" | "modeView") => self.semantic_info = color,
            ("semantic", "modeLog") => self.semantic_mode_log = color,
            ("semantic", "fileAdd") => {
                self.semantic_file_add = color;
                self.graph_file_add = color;
            }
            ("semantic", "fileMod") => self.graph_file_mod = color,
            ("semantic", "fileDel") => {
                self.semantic_file_del = color;
                self.graph_file_del = color;
            }
            ("graph", "text") => self.graph_text_muted = color,
            ("graph", "textDesc") => self.graph_text_desc = color,
            ("graph", "nodeBorder") => self.graph_commit_id = color,
            ("graph", "bookmark") => self.graph_bookmark = color,
            ("graph", "bookmarkSelected") => self.graph_bookmark_selected = color,
            ("graph", "fileAdd") => self.graph_file_add = color,
            ("graph", "fileMod") => self.graph_file_mod = color,
            ("graph", "fileDel") => self.graph_file_del = color,
            _ => {}
        }
    }

    fn ensure_readable_contrast(mut self) -> Self {
        self.slate_text = readable_on(self.slate_text, self.slate_bg0);
        self.slate_text = readable_on(self.slate_text, self.slate_panel);
        self.slate_text_muted =
            readable_muted_on(self.slate_text_muted, self.slate_bg0, self.slate_text);
        self.slate_text_muted =
            readable_muted_on(self.slate_text_muted, self.slate_panel, self.slate_text);
        self
    }
}

fn theme_options() -> &'static [&'static str] {
    const NAMES: &[&str] = &[
        "ayu-mirage",
        "catppuccin",
        "cyberpunk",
        "dracula",
        "ember",
        "everforest",
        "github-dark",
        "gruvbox",
        "kanagawa",
        "monokai",
        "moss",
        "night-owl",
        "nocturne",
        "nord",
        "oceanic",
        "one-dark",
        "palenight",
        "rose-pine",
        "shades-of-purple",
        "slate",
        "tokyo-night",
    ];
    NAMES
}

fn theme_picker_window(selected: usize, total: usize, capacity: usize) -> (usize, usize) {
    if total == 0 || capacity == 0 {
        return (0, 0);
    }
    let capacity = capacity.min(total);
    let selected = selected.min(total.saturating_sub(1));
    let before = capacity.saturating_sub(1) / 2;
    let mut start = selected.saturating_sub(before);
    if start + capacity > total {
        start = total.saturating_sub(capacity);
    }
    (start, start + capacity)
}

fn extract_hex_color(raw: &str) -> Option<&str> {
    let start = raw.find('#')?;
    raw.get(start..start + 7)
}

fn parse_hex_color(raw: &str) -> Option<Color> {
    let hex = raw.strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
    Some(Color::Rgb(r, g, b))
}

fn readable_on(fg: Color, bg: Color) -> Color {
    if contrast_ratio(fg, bg).unwrap_or(21.0) < 4.5 {
        Color::Rgb(0xf8, 0xf8, 0xf2)
    } else {
        fg
    }
}

fn readable_muted_on(fg: Color, bg: Color, fallback: Color) -> Color {
    if contrast_ratio(fg, bg).unwrap_or(21.0) < 2.6 {
        fallback
    } else {
        fg
    }
}

fn contrast_ratio(a: Color, b: Color) -> Option<f32> {
    let (ar, ag, ab) = color_rgb(a)?;
    let (br, bg, bb) = color_rgb(b)?;
    let al = rel_luminance(ar, ag, ab);
    let bl = rel_luminance(br, bg, bb);
    let (light, dark) = if al > bl { (al, bl) } else { (bl, al) };
    Some((light + 0.05) / (dark + 0.05))
}

fn color_rgb(color: Color) -> Option<(u8, u8, u8)> {
    match color {
        Color::Rgb(r, g, b) => Some((r, g, b)),
        _ => None,
    }
}

fn rel_luminance(r: u8, g: u8, b: u8) -> f32 {
    fn channel(v: u8) -> f32 {
        let c = v as f32 / 255.0;
        if c <= 0.03928 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    }
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.windows(2).find_map(|pair| {
        if pair[0] == key {
            Some(pair[1].clone())
        } else {
            None
        }
    })
}

fn parse_layout_mode(raw: Option<String>) -> LayoutMode {
    match raw.as_deref() {
        Some("mainline") => LayoutMode::Mainline,
        Some("bookmark-centric") => LayoutMode::BookmarkCentric,
        Some("wc-focused") => LayoutMode::WcFocused,
        Some("topological") => LayoutMode::Topological,
        _ => LayoutMode::Chronological,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ViewMode {
    Log,
    Diff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeaderMode {
    Action,
    Ops,
    View,
    Bookmarks,
}

impl LeaderMode {
    fn label(self) -> &'static str {
        match self {
            LeaderMode::Action => "Actions",
            LeaderMode::Ops => "Operations",
            LeaderMode::View => "View",
            LeaderMode::Bookmarks => "Bookmarks",
        }
    }
}

struct App {
    path: PathBuf,
    mode: LayoutMode,
    view_mode: ViewMode,
    active_leader_mode: Option<LeaderMode>,
    sidebar_collapsed: bool,
    files_expanded: bool,
    desc_expanded: bool,
    show_help: bool,
    boxed_chrome: bool,
    diff_scaffold: bool,
    theme_picker_mode: bool,
    theme_picker_index: usize,
    current_theme: String,
    theme: UiTokens,
    revset_mode: bool,
    revset_value: String,
    revset_query: String,
    nodes: Vec<juzu_core::CommitNode>,
    files_by_change: HashMap<String, Vec<FileEntry>>,
    diffs_by_change: HashMap<String, DiffPreview>,
    selected: usize,
    diff_scroll: usize,
    diff_file_index: usize,
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = arg_value(&args, "--path")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    let limit = arg_value(&args, "--limit")
        .and_then(|raw| raw.parse::<usize>().ok())
        .unwrap_or(DEFAULT_LOG_LIMIT);
    let mode = parse_layout_mode(arg_value(&args, "--mode"));
    let backend = NativeJjBackend::new();
    let nodes = futures_executor::block_on(backend.log(LogQuery {
        cwd: path.clone(),
        limit,
        revset: None,
    }))?;
    let mut files_by_change = HashMap::new();
    let diffs_by_change = HashMap::new();
    for node in &nodes {
        let files = futures_executor::block_on(backend.files(ChangeQuery {
            cwd: path.clone(),
            change_id: node.change_id.clone(),
        }))
        .unwrap_or_default();
        files_by_change.insert(node.change_id.clone(), files);
    }
    let selected = arg_value(&args, "--select-prefix")
        .and_then(|prefix| {
            nodes.iter().position(|node| {
                node.change_id.starts_with(&prefix) || node.commit_id.starts_with(&prefix)
            })
        })
        .or_else(|| nodes.iter().position(|node| node.is_working_copy))
        .unwrap_or(0);
    let mut app = App {
        path,
        mode,
        view_mode: ViewMode::Log,
        active_leader_mode: None,
        sidebar_collapsed: false,
        files_expanded: true,
        desc_expanded: false,
        show_help: false,
        boxed_chrome: false,
        diff_scaffold: args.iter().any(|arg| arg == "--diff-scaffold"),
        theme_picker_mode: false,
        theme_picker_index: theme_options()
            .iter()
            .position(|name| *name == "slate")
            .unwrap_or(0),
        current_theme: "slate".to_string(),
        theme: UiTokens::named("slate"),
        revset_mode: false,
        revset_value: String::new(),
        revset_query: String::new(),
        nodes,
        files_by_change,
        diffs_by_change,
        selected,
        diff_scroll: 0,
        diff_file_index: 0,
    };
    ensure_selected_diff(&mut app, false);

    if args.iter().any(|arg| arg == "--debug-state") {
        emit_debug_state(&mut app, arg_value(&args, "--keys"))?;
        return Ok(());
    }

    enable_raw_mode()?;
    execute!(stdout(), EnterAlternateScreen)?;
    let terminal = ratatui::init();
    let result = run(terminal, &mut app);
    ratatui::restore();
    execute!(stdout(), LeaveAlternateScreen)?;
    disable_raw_mode()?;
    result
}

fn run(mut terminal: DefaultTerminal, app: &mut App) -> Result<()> {
    loop {
        terminal.draw(|frame| render(frame, app))?;
        if event::poll(Duration::from_millis(250))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Release {
                    continue;
                }
                if handle_key(app, key.code, key.modifiers) {
                    break;
                }
            }
        }
    }
    Ok(())
}

fn handle_key(app: &mut App, code: KeyCode, modifiers: KeyModifiers) -> bool {
    if modifiers.contains(KeyModifiers::CONTROL) && matches!(code, KeyCode::Char('d')) {
        app.active_leader_mode = None;
        toggle_diff_view(app);
        return false;
    }
    if app.show_help {
        if matches!(code, KeyCode::Char('h') | KeyCode::Char('q') | KeyCode::Esc) {
            app.show_help = false;
        }
        return false;
    }
    if app.theme_picker_mode {
        match code {
            KeyCode::Char('q') | KeyCode::Esc => app.theme_picker_mode = false,
            KeyCode::Char('j') | KeyCode::Down => {
                app.theme_picker_index = (app.theme_picker_index + 1) % theme_options().len()
            }
            KeyCode::Char('k') | KeyCode::Up => {
                app.theme_picker_index =
                    (app.theme_picker_index + theme_options().len() - 1) % theme_options().len()
            }
            KeyCode::Enter => {
                app.current_theme = theme_options()[app.theme_picker_index].to_string();
                app.theme = UiTokens::named(&app.current_theme);
            }
            _ => {}
        }
        return false;
    }
    if app.revset_mode {
        match code {
            KeyCode::Char('q') | KeyCode::Esc => {
                app.revset_mode = false;
                app.revset_value.clear();
            }
            KeyCode::Enter => {
                app.revset_query = app.revset_value.trim().to_string();
                app.revset_mode = false;
            }
            KeyCode::Backspace => {
                app.revset_value.pop();
            }
            KeyCode::Char(ch) if !modifiers.contains(KeyModifiers::CONTROL) => {
                app.revset_value.push(ch)
            }
            _ => {}
        }
        return false;
    }
    if modifiers.contains(KeyModifiers::CONTROL) {
        match code {
            KeyCode::Char('x') => {
                app.active_leader_mode = Some(LeaderMode::Action);
                return false;
            }
            KeyCode::Char('o') => {
                app.active_leader_mode = Some(LeaderMode::Ops);
                return false;
            }
            KeyCode::Char('l') => {
                app.active_leader_mode = Some(LeaderMode::View);
                return false;
            }
            KeyCode::Char('b') => {
                app.active_leader_mode = Some(LeaderMode::Bookmarks);
                return false;
            }
            _ => {}
        }
    }
    if app.active_leader_mode == Some(LeaderMode::View) {
        match code {
            KeyCode::Char('c') => {
                app.sidebar_collapsed = !app.sidebar_collapsed;
                app.active_leader_mode = None;
                return false;
            }
            KeyCode::Char('f') => {
                app.files_expanded = !app.files_expanded;
                app.active_leader_mode = None;
                return false;
            }
            KeyCode::Char('x') => {
                app.desc_expanded = !app.desc_expanded;
                app.active_leader_mode = None;
                return false;
            }
            KeyCode::Char('h') => {
                app.show_help = true;
                app.active_leader_mode = None;
                return false;
            }
            KeyCode::Char('b') => {
                app.boxed_chrome = !app.boxed_chrome;
                app.active_leader_mode = None;
                return false;
            }
            KeyCode::Char('s') => {
                app.diff_scaffold = !app.diff_scaffold;
                app.active_leader_mode = None;
                return false;
            }
            KeyCode::Char('t') => {
                app.theme_picker_mode = true;
                app.theme_picker_index = theme_options()
                    .iter()
                    .position(|theme| *theme == app.current_theme)
                    .unwrap_or(0);
                app.active_leader_mode = None;
                return false;
            }
            KeyCode::Char('/') => {
                app.revset_mode = true;
                app.revset_value = app.revset_query.clone();
                app.active_leader_mode = None;
                return false;
            }
            _ => {}
        }
    }
    if app.active_leader_mode.is_some() && matches!(code, KeyCode::Char('q') | KeyCode::Esc) {
        app.active_leader_mode = None;
        return false;
    }
    match code {
        KeyCode::Char('g') | KeyCode::Char('q') | KeyCode::Esc
            if app.view_mode == ViewMode::Diff =>
        {
            app.view_mode = ViewMode::Log;
            app.diff_scroll = 0;
        }
        KeyCode::Char('q') | KeyCode::Esc => return true,
        KeyCode::Char('j') | KeyCode::Down if app.view_mode == ViewMode::Diff => {
            app.diff_scroll = app.diff_scroll.saturating_add(1);
        }
        KeyCode::Char('k') | KeyCode::Up if app.view_mode == ViewMode::Diff => {
            app.diff_scroll = app.diff_scroll.saturating_sub(1);
        }
        KeyCode::Char('j') | KeyCode::Down => {
            app.selected = (app.selected + 1).min(app.nodes.len().saturating_sub(1));
            app.diff_scroll = 0;
            ensure_selected_diff(app, false);
        }
        KeyCode::Char('k') | KeyCode::Up => {
            app.selected = app.selected.saturating_sub(1);
            app.diff_scroll = 0;
            ensure_selected_diff(app, false);
        }
        KeyCode::PageDown if app.view_mode == ViewMode::Diff => {
            app.diff_scroll = app.diff_scroll.saturating_add(10);
        }
        KeyCode::PageUp if app.view_mode == ViewMode::Diff => {
            app.diff_scroll = app.diff_scroll.saturating_sub(10);
        }
        KeyCode::Char(']') if app.view_mode == ViewMode::Diff => {
            cycle_diff_file(app, 1);
        }
        KeyCode::Char('[') if app.view_mode == ViewMode::Diff => {
            cycle_diff_file(app, -1);
        }
        KeyCode::PageDown | KeyCode::Char(']') => {
            app.diff_scroll = app.diff_scroll.saturating_add(10);
        }
        KeyCode::PageUp | KeyCode::Char('[') => {
            app.diff_scroll = app.diff_scroll.saturating_sub(10);
        }
        KeyCode::Char('}') => jump_selected_diff(app, DiffJump::NextHunk),
        KeyCode::Char('{') => jump_selected_diff(app, DiffJump::PreviousHunk),
        KeyCode::Char('1') => {
            app.mode = LayoutMode::Chronological;
            app.active_leader_mode = None;
        }
        KeyCode::Char('2') => {
            app.mode = LayoutMode::Mainline;
            app.active_leader_mode = None;
        }
        KeyCode::Char('3') => {
            app.mode = LayoutMode::BookmarkCentric;
            app.active_leader_mode = None;
        }
        KeyCode::Char('4') => {
            app.mode = LayoutMode::WcFocused;
            app.active_leader_mode = None;
        }
        KeyCode::Char('5') => {
            app.mode = LayoutMode::Topological;
            app.active_leader_mode = None;
        }
        _ => {}
    }
    false
}

fn parse_debug_key(raw: &str) -> Option<(KeyCode, KeyModifiers)> {
    match raw {
        "C-d" | "Ctrl+D" | "ctrl+d" => Some((KeyCode::Char('d'), KeyModifiers::CONTROL)),
        "C-x" | "Ctrl+X" | "ctrl+x" => Some((KeyCode::Char('x'), KeyModifiers::CONTROL)),
        "C-o" | "Ctrl+O" | "ctrl+o" => Some((KeyCode::Char('o'), KeyModifiers::CONTROL)),
        "C-l" | "Ctrl+L" | "ctrl+l" => Some((KeyCode::Char('l'), KeyModifiers::CONTROL)),
        "C-b" | "Ctrl+B" | "ctrl+b" => Some((KeyCode::Char('b'), KeyModifiers::CONTROL)),
        "Esc" | "Escape" => Some((KeyCode::Esc, KeyModifiers::NONE)),
        "PageDown" => Some((KeyCode::PageDown, KeyModifiers::NONE)),
        "PageUp" => Some((KeyCode::PageUp, KeyModifiers::NONE)),
        "Enter" | "Return" => Some((KeyCode::Enter, KeyModifiers::NONE)),
        "Backspace" => Some((KeyCode::Backspace, KeyModifiers::NONE)),
        "Down" => Some((KeyCode::Down, KeyModifiers::NONE)),
        "Up" => Some((KeyCode::Up, KeyModifiers::NONE)),
        value if value.chars().count() == 1 => {
            Some((KeyCode::Char(value.chars().next()?), KeyModifiers::NONE))
        }
        _ => None,
    }
}

fn emit_debug_state(app: &mut App, keys: Option<String>) -> Result<()> {
    for raw in keys
        .unwrap_or_default()
        .split(',')
        .filter(|key| !key.is_empty())
    {
        if let Some((code, modifiers)) = parse_debug_key(raw.trim()) {
            if handle_key(app, code, modifiers) {
                break;
            }
        }
    }
    ensure_selected_diff(app, app.view_mode == ViewMode::Diff);
    let selected = app.nodes.get(app.selected);
    let diff = selected_diff(app);
    let active_rows = active_diff_rows_for_state(app, diff);
    let max_scroll = active_rows.len().saturating_sub(1);
    let scroll = app.diff_scroll.min(max_scroll);
    let current_row = active_rows.get(scroll);
    let payload = serde_json::json!({
        "viewMode": match app.view_mode { ViewMode::Log => "Log", ViewMode::Diff => "Diff" },
        "layoutMode": format!("{:?}", app.mode),
        "activeLeaderMode": app.active_leader_mode.map(|mode| mode.label()),
        "sidebarCollapsed": app.sidebar_collapsed,
        "filesExpanded": app.files_expanded,
        "descExpanded": app.desc_expanded,
        "showHelp": app.show_help,
        "boxedChrome": app.boxed_chrome,
        "diffScaffold": app.diff_scaffold,
        "themePickerMode": app.theme_picker_mode,
        "themePickerIndex": app.theme_picker_index,
        "currentTheme": app.current_theme,
        "revsetMode": app.revset_mode,
        "revsetValue": app.revset_value,
        "revsetQuery": app.revset_query,
        "selectedIndex": app.selected,
        "selectedChange": selected.map(|node| node.change_id.as_str()).unwrap_or(""),
        "selectedCommit": selected.map(|node| node.commit_id.as_str()).unwrap_or(""),
        "diffScroll": app.diff_scroll,
        "diffFileIndex": app.diff_file_index,
        "diffFileCount": diff.map(|preview| preview.file_count).unwrap_or(0),
        "diffRows": diff.map(|preview| preview.row_count).unwrap_or(0),
        "currentDiffRowKind": current_row.map(|row| format!("{:?}", row.kind)).unwrap_or_default(),
        "currentDiffRowText": current_row.map(|row| row.text.as_str()).unwrap_or(""),
        "stickyContext": diff_sticky_context_text(&active_rows, scroll).unwrap_or_default(),
        "hasParseError": diff.and_then(|preview| preview.parse_error.as_ref()).is_some(),
    });
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Ok(())
}

fn active_diff_rows_for_state(app: &App, diff: Option<&DiffPreview>) -> Vec<DiffRow> {
    let Some(diff) = diff else {
        return Vec::new();
    };
    if app.view_mode == ViewMode::Diff {
        rows_for_diff_file(diff, app.diff_file_index)
    } else {
        diff.preview_rows.clone()
    }
}

fn diff_sticky_context_text(rows: &[DiffRow], scroll: usize) -> Option<String> {
    let upto = rows.len().min(scroll.saturating_add(1));
    if upto == 0 {
        return None;
    }
    let mut file = None;
    let mut hunk = None;
    for row in rows.iter().take(upto) {
        match row.kind {
            DiffRowKind::FileHeader => file = Some(row.text.as_str()),
            DiffRowKind::HunkHeader => hunk = Some(row.text.as_str()),
            _ => {}
        }
    }
    match (file, hunk) {
        (Some(file), Some(hunk)) => Some(format!("{hunk} · {file}")),
        (Some(file), None) => Some(format!("top · {file}")),
        (None, Some(hunk)) => Some(hunk.to_string()),
        (None, None) => None,
    }
}

fn ensure_selected_diff(app: &mut App, include_full_rows: bool) {
    let Some(node) = app.nodes.get(app.selected) else {
        return;
    };
    if app
        .diffs_by_change
        .get(&node.change_id)
        .is_some_and(|diff| {
            !include_full_rows || diff.full_rows.is_some() || diff.parse_error.is_some()
        })
    {
        return;
    }
    let backend = NativeJjBackend::new();
    let diff = futures_executor::block_on(backend.diff(ChangeQuery {
        cwd: app.path.clone(),
        change_id: node.change_id.clone(),
    }))
    .unwrap_or_default();
    let preview = parse_git_patch(&diff)
        .map(|document| {
            let rows = collapsed_diff_rows(&document, 3);
            let row_count = rows.len();
            let preview_rows = cap_diff_preview_rows(rows.clone(), DIFF_PREVIEW_ROW_CAP);
            DiffPreview {
                raw_line_count: diff.lines().count(),
                file_count: document.files.len(),
                row_count,
                full_rows: include_full_rows.then_some(rows),
                preview_rows,
                parse_error: None,
            }
        })
        .unwrap_or_else(|err| DiffPreview {
            raw_line_count: diff.lines().count(),
            file_count: 0,
            row_count: 0,
            full_rows: None,
            preview_rows: Vec::new(),
            parse_error: Some(err.to_string()),
        });
    app.diffs_by_change.insert(node.change_id.clone(), preview);
}

struct DiffPreview {
    raw_line_count: usize,
    file_count: usize,
    row_count: usize,
    full_rows: Option<Vec<DiffRow>>,
    preview_rows: Vec<DiffRow>,
    parse_error: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum DiffJump {
    PreviousHunk,
    NextHunk,
}

fn toggle_diff_view(app: &mut App) {
    if app.view_mode == ViewMode::Diff {
        app.view_mode = ViewMode::Log;
        app.diff_scroll = 0;
        return;
    }
    ensure_selected_diff(app, true);
    app.view_mode = ViewMode::Diff;
    app.diff_scroll = 0;
    app.diff_file_index = 0;
}

fn cycle_diff_file(app: &mut App, dir: isize) {
    ensure_selected_diff(app, true);
    let Some(diff) = selected_diff(app) else {
        return;
    };
    if diff.file_count == 0 {
        app.diff_file_index = 0;
        app.diff_scroll = 0;
        return;
    }
    let total = diff.file_count as isize;
    app.diff_file_index = (app.diff_file_index as isize + dir).rem_euclid(total) as usize;
    app.diff_scroll = 0;
}

fn selected_diff(app: &App) -> Option<&DiffPreview> {
    let node = app.nodes.get(app.selected)?;
    app.diffs_by_change.get(&node.change_id)
}

fn cap_diff_preview_rows(rows: Vec<DiffRow>, cap: usize) -> Vec<DiffRow> {
    if rows.len() <= cap {
        return rows;
    }
    let file_count = rows
        .iter()
        .map(|row| row.file_index)
        .max()
        .map(|idx| idx + 1)
        .unwrap_or(1);
    let per_file_cap = (cap / file_count.max(1)).max(8);
    let mut capped = Vec::new();
    for file_index in 0..file_count {
        let file_rows = rows
            .iter()
            .filter(|row| row.file_index == file_index)
            .cloned()
            .collect::<Vec<_>>();
        if file_rows.len() <= per_file_cap {
            capped.extend(file_rows);
            continue;
        }
        capped.extend(file_rows.iter().take(per_file_cap).cloned());
        let omitted = file_rows.len() - per_file_cap;
        let hunk_index = capped.last().and_then(|row| row.hunk_index);
        capped.push(DiffRow {
            kind: DiffRowKind::Collapse,
            file_index,
            hunk_index,
            old_line: None,
            new_line: None,
            text: format!("preview capped · {omitted} additional rows omitted for this file"),
        });
    }
    capped
}

fn jump_selected_diff(app: &mut App, jump: DiffJump) {
    ensure_selected_diff(app, app.view_mode == ViewMode::Diff);
    let Some(node) = app.nodes.get(app.selected) else {
        return;
    };
    let Some(diff) = app.diffs_by_change.get(&node.change_id) else {
        return;
    };
    let rows = if app.view_mode == ViewMode::Diff {
        full_diff_rows(diff)
    } else {
        &diff.preview_rows
    };
    if rows.is_empty() {
        app.diff_scroll = 0;
        return;
    }
    let target = match jump {
        DiffJump::NextHunk => rows
            .iter()
            .enumerate()
            .skip(app.diff_scroll.saturating_add(1))
            .find(|(_, row)| row.kind == DiffRowKind::HunkHeader)
            .map(|(idx, _)| idx),
        DiffJump::PreviousHunk => rows
            .iter()
            .enumerate()
            .take(app.diff_scroll)
            .rev()
            .find(|(_, row)| row.kind == DiffRowKind::HunkHeader)
            .map(|(idx, _)| idx),
    };
    if let Some(target) = target {
        app.diff_scroll = target;
    }
}

fn render(frame: &mut Frame, app: &App) {
    let layout = calculate_default_layout(app.mode, &app.nodes);
    let status_height = if app.active_leader_mode == Some(LeaderMode::View) {
        2
    } else {
        1
    };
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(status_height),
            Constraint::Min(8),
            Constraint::Length(1),
        ])
        .split(frame.area());
    render_status_bar(frame, chunks[0], app);
    render_body(frame, chunks[1], app, &layout);
    render_footer(frame, chunks[2], app);
}

fn render_status_bar(frame: &mut Frame, area: Rect, app: &App) {
    let t = &app.theme;
    let item_style = status_item_style(t, LeaderMode::View);
    let key_style = status_key_style(t);
    let mode_style = status_mode_style(t, app.active_leader_mode);
    let lines = if app.theme_picker_mode {
        vec![Line::from(vec![
            Span::styled(" THEME ", mode_style),
            Span::raw("  "),
            Span::styled("j/k", key_style),
            Span::styled(" Select ", item_style),
            Span::raw(" "),
            Span::styled("Enter", key_style),
            Span::styled(" Apply ", item_style),
            Span::raw(" "),
            Span::styled("Esc", key_style),
            Span::styled(" Cancel ", item_style),
        ])]
    } else if app.revset_mode {
        vec![Line::from(vec![
            Span::styled(" REVSET ", mode_style),
            Span::raw("  "),
            Span::styled("Enter", key_style),
            Span::styled(" Apply ", item_style),
            Span::raw(" "),
            Span::styled("Esc", key_style),
            Span::styled(" Cancel ", item_style),
        ])]
    } else if app.show_help {
        vec![Line::from(vec![
            Span::styled(" HELP ", mode_style),
            Span::raw("  "),
            Span::styled("h/q/Esc", key_style),
            Span::styled(" Close ", item_style),
        ])]
    } else if app.view_mode == ViewMode::Diff {
        vec![diff_status_bar_line(mode_style, key_style, item_style)]
    } else if let Some(leader) = app.active_leader_mode {
        let active_mode_style = Style::default()
            .fg(t.slate_bg0)
            .bg(leader_mode_color(leader, t))
            .add_modifier(Modifier::BOLD);
        match leader {
            LeaderMode::View => view_leader_status_lines(t),
            LeaderMode::Action => vec![Line::from(vec![
                Span::styled(" ACT ", active_mode_style),
                Span::raw("  "),
                Span::styled("n", key_style),
                Span::styled(" New ", item_style),
                Span::raw(" "),
                Span::styled("e", key_style),
                Span::styled(" Edit ", item_style),
                Span::raw(" "),
                Span::styled("d", key_style),
                Span::styled(" Describe ", item_style),
                Span::raw(" "),
                Span::styled("b", key_style),
                Span::styled(" Rebase ", item_style),
                Span::raw(" "),
                Span::styled("Esc/q", key_style),
                Span::styled(" Exit ", item_style),
            ])],
            LeaderMode::Ops => vec![Line::from(vec![
                Span::styled(" OPS ", active_mode_style),
                Span::raw("  "),
                Span::styled("u", key_style),
                Span::styled(" Undo ", item_style),
                Span::raw(" "),
                Span::styled("r", key_style),
                Span::styled(" Redo ", item_style),
                Span::raw(" "),
                Span::styled("f", key_style),
                Span::styled(" Fetch ", item_style),
                Span::raw(" "),
                Span::styled("p", key_style),
                Span::styled(" Push ", item_style),
                Span::raw(" "),
                Span::styled("Esc/q", key_style),
                Span::styled(" Exit ", item_style),
            ])],
            LeaderMode::Bookmarks => vec![Line::from(vec![
                Span::styled(" BOOK ", active_mode_style),
                Span::raw("  "),
                Span::styled("s", key_style),
                Span::styled(" Bookmark set ", item_style),
                Span::raw(" "),
                Span::styled("d", key_style),
                Span::styled(" Bookmark delete ", item_style),
                Span::raw(" "),
                Span::styled("Esc/q", key_style),
                Span::styled(" Exit ", item_style),
            ])],
        }
    } else {
        vec![Line::from(vec![
            Span::styled(" LOG ", mode_style),
            Span::raw("  "),
            Span::styled("^X", key_style),
            Span::styled(" Act ", status_item_style(t, LeaderMode::Action)),
            Span::raw(" "),
            Span::styled("^O", key_style),
            Span::styled(" Ops ", status_item_style(t, LeaderMode::Ops)),
            Span::raw(" "),
            Span::styled("^L", key_style),
            Span::styled(" View ", status_item_style(t, LeaderMode::View)),
            Span::raw(" "),
            Span::styled("^B", key_style),
            Span::styled(" Book ", status_item_style(t, LeaderMode::Bookmarks)),
        ])]
    };
    frame.render_widget(
        Paragraph::new(lines).style(Style::default().bg(t.slate_panel)),
        area,
    );
}

fn status_key_style(t: &UiTokens) -> Style {
    Style::default().fg(t.semantic_info).bg(t.slate_panel)
}

fn status_mode_style(t: &UiTokens, active: Option<LeaderMode>) -> Style {
    let tint = active
        .map(|mode| leader_mode_color(mode, t))
        .unwrap_or(t.semantic_mode_log);
    Style::default()
        .fg(t.slate_bg0)
        .bg(mix_color(tint, t.slate_text, 0.18))
        .add_modifier(Modifier::BOLD)
}

fn status_item_style(t: &UiTokens, mode: LeaderMode) -> Style {
    let tone = leader_mode_color(mode, t);
    Style::default()
        .bg(mix_color(t.slate_bg2, tone, 0.42))
        .fg(mix_color(t.slate_text, tone, 0.46))
}

fn mix_color(base: Color, overlay: Color, ratio: f32) -> Color {
    let Color::Rgb(br, bg, bb) = base else {
        return overlay;
    };
    let Color::Rgb(or, og, ob) = overlay else {
        return base;
    };
    let t = ratio.clamp(0.0, 1.0);
    let mix = |a: u8, b: u8| -> u8 { (a as f32 + (b as f32 - a as f32) * t).round() as u8 };
    Color::Rgb(mix(br, or), mix(bg, og), mix(bb, ob))
}

fn diff_status_bar_line(mode_style: Style, key_style: Style, item_style: Style) -> Line<'static> {
    Line::from(vec![
        Span::styled(" DIFF ", mode_style),
        Span::raw("  "),
        Span::styled("^d", key_style),
        Span::styled(" Log ", item_style),
        Span::raw("  "),
        Span::styled("[]", key_style),
        Span::styled(" File ", item_style),
        Span::raw("  "),
        Span::styled("j/k", key_style),
        Span::styled(" Move ", item_style),
        Span::raw("  "),
        Span::styled("escape", key_style),
        Span::styled(" Exit ", item_style),
    ])
}

fn view_leader_status_lines(t: &UiTokens) -> Vec<Line<'static>> {
    let key_style = status_key_style(t);
    let item_style = status_item_style(t, LeaderMode::View);
    let active_mode_style = Style::default()
        .fg(t.slate_bg0)
        .bg(leader_mode_color(LeaderMode::View, t))
        .add_modifier(Modifier::BOLD);
    vec![
        Line::from(vec![
            Span::styled(" VIEW ", active_mode_style),
            Span::raw("  "),
            Span::styled("1", key_style),
            Span::styled(" Layout chronological ", item_style),
            Span::raw(" "),
            Span::styled("2", key_style),
            Span::styled(" Layout mainline ", item_style),
            Span::raw(" "),
            Span::styled("3", key_style),
            Span::styled(" Layout bookmark ", item_style),
            Span::raw(" "),
            Span::styled("4", key_style),
            Span::styled(" Layout wc ", item_style),
            Span::raw(" "),
            Span::styled("5", key_style),
            Span::styled(" Layout topological ", item_style),
        ]),
        Line::from(vec![
            Span::styled("c", key_style),
            Span::styled(" Toggle sidebar ", item_style),
            Span::raw(" "),
            Span::styled("t", key_style),
            Span::styled(" Theme picker ", item_style),
            Span::raw(" "),
            Span::styled("f", key_style),
            Span::styled(" Toggle files ", item_style),
            Span::raw(" "),
            Span::styled("x", key_style),
            Span::styled(" Toggle description ", item_style),
            Span::raw(" "),
            Span::styled("h", key_style),
            Span::styled(" Toggle help ", item_style),
            Span::raw(" "),
            Span::styled("/", key_style),
            Span::styled(" Revset filter ", item_style),
            Span::raw(" "),
            Span::styled("^d", key_style),
            Span::styled(" Diff view ", item_style),
        ]),
    ]
}

fn default_chrome_borders(boxed_chrome: bool) -> Borders {
    if boxed_chrome {
        Borders::ALL
    } else {
        Borders::NONE
    }
}

fn leader_mode_color(mode: LeaderMode, t: &UiTokens) -> Color {
    match mode {
        LeaderMode::Action => t.semantic_warn,
        LeaderMode::Ops => t.semantic_info,
        LeaderMode::View => t.semantic_mode_log,
        LeaderMode::Bookmarks => t.semantic_success,
    }
}

fn render_body(frame: &mut Frame, area: Rect, app: &App, layout: &juzu_core::layout::LayoutResult) {
    let constraints = if app.sidebar_collapsed {
        [Constraint::Min(8), Constraint::Length(6)]
    } else {
        [Constraint::Percentage(60), Constraint::Percentage(40)]
    };
    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(constraints)
        .split(area);
    if app.view_mode == ViewMode::Diff {
        let diff_area = Rect {
            width: chunks[0].width.saturating_sub(2).max(1),
            ..chunks[0]
        };
        render_diff_pane(frame, diff_area, app, layout);
    } else {
        render_graph_table(frame, chunks[0], app, layout);
    }
    if app.sidebar_collapsed {
        render_collapsed_sidebar(frame, chunks[1], app);
    } else {
        render_sidebar(frame, chunks[1], app, layout);
    }
}

fn render_diff_pane(
    frame: &mut Frame,
    area: Rect,
    app: &App,
    layout: &juzu_core::layout::LayoutResult,
) {
    let t = &app.theme;
    let selected = app.selected.min(layout.nodes.len().saturating_sub(1));
    let Some(node) = layout.nodes.get(selected) else {
        return;
    };
    let block = Block::default()
        .borders(default_chrome_borders(app.boxed_chrome))
        .border_style(Style::default().fg(t.slate_border_strong))
        .style(Style::default().bg(t.slate_bg0));
    let width = area.width as usize;
    let height = area.height as usize;
    let mut lines = Vec::new();
    let diff = selected_diff(app);
    let title = diff
        .and_then(|preview| diff_file_title(preview, app.diff_file_index, width.saturating_sub(1)))
        .unwrap_or_else(|| "Diff".to_string());
    let title_bar = format!(" {title}");
    lines.push(Line::from(vec![Span::styled(
        format!("{:<width$}", title_bar, width = width),
        Style::default()
            .fg(t.semantic_info)
            .bg(t.slate_bg2)
            .add_modifier(Modifier::BOLD),
    )]));
    if let Some(diff) = diff {
        if let Some(error) = &diff.parse_error {
            lines.push(Line::from(Span::styled(
                truncate(error, width),
                Style::default().fg(t.semantic_error),
            )));
        } else if full_diff_rows(diff).is_empty() {
            lines.push(render_diff_metadata(
                t,
                "No diff available for selected change",
                width,
            ));
        } else {
            let rows = full_diff_pane_rows(diff, app.diff_file_index, app.diff_scaffold);
            let visible_count = height.saturating_sub(lines.len()).max(1);
            let max_scroll = rows.len().saturating_sub(visible_count);
            let scroll = app.diff_scroll.min(max_scroll);
            let gutter_width = diff_line_number_gutter_width(&rows);
            for row in rows.iter().skip(scroll).take(visible_count) {
                for rendered in render_full_diff_row_with_gutter(t, row, width, gutter_width) {
                    if lines.len() >= height {
                        break;
                    }
                    lines.push(rendered);
                }
                if lines.len() >= height {
                    break;
                }
            }
        }
    } else {
        lines.push(render_diff_metadata(
            t,
            "No diff available for selected change",
            width,
        ));
    }
    let _ = node;
    frame.render_widget(Paragraph::new(lines).block(block), area);
}

fn diff_file_title(diff: &DiffPreview, file_index: usize, max_len: usize) -> Option<String> {
    let total = diff.file_count.max(1);
    let index = file_index.min(total.saturating_sub(1));
    let path = full_diff_rows(diff)
        .iter()
        .find(|row| row.kind == DiffRowKind::FileHeader && row.file_index == index)
        .map(|row| row.text.clone())
        .unwrap_or_else(|| "Diff".to_string());
    let prefix = format!("File {}/{}: ", index + 1, total);
    let suffix = "   [ / ] next/prev   Ctrl+d back";
    let path_budget = max_len.saturating_sub(prefix.len() + suffix.len()).max(8);
    Some(format!(
        "{}{}{}",
        prefix,
        truncate(&path, path_budget),
        suffix
    ))
}

fn full_diff_rows(diff: &DiffPreview) -> &[DiffRow] {
    diff.full_rows.as_deref().unwrap_or(&diff.preview_rows)
}

fn rows_for_diff_file(diff: &DiffPreview, file_index: usize) -> Vec<DiffRow> {
    let rows = full_diff_rows(diff);
    if diff.file_count == 0 {
        return rows.to_vec();
    }
    let index = file_index.min(diff.file_count.saturating_sub(1));
    rows.iter()
        .filter(|row| row.file_index == index)
        .cloned()
        .collect()
}

fn full_diff_pane_rows(diff: &DiffPreview, file_index: usize, show_scaffold: bool) -> Vec<DiffRow> {
    if show_scaffold {
        rows_for_diff_file(diff, file_index)
    } else {
        diffview_rows_for_file(diff, file_index)
    }
}

fn diffview_rows_for_file(diff: &DiffPreview, file_index: usize) -> Vec<DiffRow> {
    rows_for_diff_file(diff, file_index)
        .into_iter()
        .filter(|row| {
            matches!(
                row.kind,
                DiffRowKind::Context
                    | DiffRowKind::Add
                    | DiffRowKind::Remove
                    | DiffRowKind::Collapse
            ) || is_no_newline_marker(row)
        })
        .collect()
}

fn is_no_newline_marker(row: &DiffRow) -> bool {
    row.kind == DiffRowKind::Metadata && row.text == r"\ No newline at end of file"
}

fn render_graph_table(
    frame: &mut Frame,
    area: Rect,
    app: &App,
    layout: &juzu_core::layout::LayoutResult,
) {
    let t = &app.theme;
    let block = Block::default()
        .borders(default_chrome_borders(app.boxed_chrome))
        .border_style(Style::default().fg(t.slate_border_soft))
        .style(Style::default().bg(t.slate_bg0));
    let inner = block.inner(area);
    let width = inner.width as usize;
    let height = inner.height as usize;
    let selected = app.selected.min(layout.nodes.len().saturating_sub(1));
    let row_stride = 4usize;
    let visible_rows = ((height.saturating_sub(2)) / row_stride).max(1);
    let start = selected.saturating_sub(visible_rows / 2);
    let end = (start + visible_rows).min(layout.nodes.len());

    let mut cells = vec![vec![GraphCell::default(); width]; height.max(1)];
    let all_index: std::collections::HashMap<_, _> = layout
        .nodes
        .iter()
        .enumerate()
        .map(|(idx, node)| (node.change_id.as_str(), idx))
        .collect();
    let children_by_id = build_children_by_id(&layout.nodes);

    let max_lane = layout.max_lane;
    let left_pad = 2usize;
    let text_gap = 3usize;
    let min_text_w = 28usize;
    let available_for_lanes = width.saturating_sub(left_pad + text_gap + min_text_w);
    let lane_width = (available_for_lanes / (max_lane + 1)).clamp(2, 4);
    let lanes_w = (max_lane + 1) * lane_width;
    let text_x = (left_pad + lanes_w + text_gap).min(width.saturating_sub(1));
    let lane_x = |lane: usize| -> usize {
        (left_pad + (max_lane.saturating_sub(lane)) * lane_width).min(width.saturating_sub(1))
    };
    let row_y_abs =
        |global: usize| -> isize { 1 + (global as isize - start as isize) * row_stride as isize };

    let mut bus_by_y: std::collections::HashMap<isize, (usize, usize)> =
        std::collections::HashMap::new();
    if matches!(app.mode, LayoutMode::Mainline) && max_lane > 0 {
        for idx in start..end {
            let node = &layout.nodes[idx];
            if node.lane.unwrap_or(0) != 0 {
                continue;
            }
            let mut connected_lanes = Vec::new();
            if let Some(children) = children_by_id.get(node.change_id.as_str()) {
                for child_idx in children {
                    let lane = layout.nodes[*child_idx].lane.unwrap_or(0);
                    if lane != 0 {
                        connected_lanes.push(lane);
                    }
                }
            }
            if node.parents.len() > 1 {
                for parent_id in &node.parents {
                    if let Some(parent_idx) = all_index.get(parent_id.as_str()) {
                        let lane = layout.nodes[*parent_idx].lane.unwrap_or(0);
                        if lane != 0 {
                            connected_lanes.push(lane);
                        }
                    }
                }
            }
            let Some(furthest_lane) = connected_lanes.into_iter().max() else {
                continue;
            };
            let x0 = lane_x(0);
            let x1 = lane_x(furthest_lane);
            bus_by_y.insert(row_y_abs(idx), (x0.min(x1), x0.max(x1)));
        }
        for (y, (x0, x1)) in &bus_by_y {
            for x in *x0..=*x1 {
                put_cell(&mut cells, x, *y, '─', lane_color(t, 0));
            }
        }
    }

    let view_top = 0isize;
    let view_bottom = height.saturating_sub(1) as isize;
    for child_idx in 0..layout.nodes.len() {
        let child = &layout.nodes[child_idx];
        let child_lane = child.lane.unwrap_or(0);
        let x0 = lane_x(child_lane);
        let y0 = row_y_abs(child_idx);
        let child_color = lane_color(t, child_lane);

        for parent_id in &child.parents {
            let Some(parent_idx) = all_index.get(parent_id.as_str()).copied() else {
                continue;
            };
            let parent = &layout.nodes[parent_idx];
            let parent_lane = parent.lane.unwrap_or(0);
            let x1 = lane_x(parent_lane);
            let y1 = row_y_abs(parent_idx);
            if y0.max(y1) < view_top || y0.min(y1) > view_bottom {
                continue;
            }
            let parent_color = lane_color(t, parent_lane);
            let connection_selected = child_idx == selected || parent_idx == selected;
            let line_color = if connection_selected {
                t.slate_text
            } else {
                parent_color
            };

            if child_lane == parent_lane {
                draw_vert(&mut cells, x0, y0 + 1, y1 - 1, '│', line_color);
                continue;
            }

            let is_merge_commit = child.parents.len() > 1;
            let connect_y = if is_merge_commit { y0 } else { y1 };
            let seg_min = x0.min(x1);
            let seg_max = x0.max(x1);
            let bus_covers = matches!(app.mode, LayoutMode::Mainline)
                && (child_lane == 0 || parent_lane == 0)
                && bus_by_y
                    .get(&connect_y)
                    .is_some_and(|(min, max)| seg_min >= *min && seg_max <= *max);
            if !bus_covers {
                draw_horz(&mut cells, x0, x1, connect_y, '─', line_color);
            }

            if is_merge_commit {
                let selected_child_color = if child_idx == selected {
                    t.slate_text
                } else {
                    child_color
                };
                if x0 < x1 {
                    put_cell(&mut cells, x0, connect_y, '├', selected_child_color);
                    put_cell(&mut cells, x1, connect_y, '┐', line_color);
                } else {
                    put_cell(&mut cells, x0, connect_y, '┤', selected_child_color);
                    put_cell(&mut cells, x1, connect_y, '┌', line_color);
                }
                draw_vert(&mut cells, x1, connect_y + 1, y1 - 1, '│', line_color);
            } else {
                let selected_child_color = if child_idx == selected {
                    t.slate_text
                } else {
                    child_color
                };
                if x0 < x1 {
                    put_cell(&mut cells, x1, connect_y, '├', line_color);
                    put_cell(&mut cells, x0, connect_y, '└', selected_child_color);
                } else {
                    put_cell(&mut cells, x1, connect_y, '┤', line_color);
                    put_cell(&mut cells, x0, connect_y, '┘', selected_child_color);
                }
                draw_vert(
                    &mut cells,
                    x0,
                    y0 + 1,
                    connect_y - 1,
                    '│',
                    selected_child_color,
                );
            }
        }
    }

    for global in start..end {
        let node = &layout.nodes[global];
        let lane = node.lane.unwrap_or(0);
        let x = lane_x(lane);
        let y = row_y_abs(global);
        let is_selected = global == selected;
        let color = lane_color(t, lane);
        let node_ch = if node.is_working_copy {
            '@'
        } else if node.is_conflict {
            '!'
        } else if node.is_empty && is_selected {
            '0'
        } else if is_selected {
            'O'
        } else {
            'o'
        };
        let node_color = if is_selected && !node.is_working_copy && !node.is_conflict {
            t.slate_text
        } else if node.is_working_copy {
            t.semantic_success
        } else if node.is_conflict {
            t.semantic_error
        } else {
            color
        };
        for cx in x + 1..text_x.saturating_sub(1).min(width) {
            put_cell(&mut cells, cx, y, '.', color);
        }
        put_cell(&mut cells, x, y, node_ch, node_color);

        let change_short: String = node.change_id.chars().take(8).collect();
        let commit_short: String = node.commit_id.chars().take(8).collect();
        let desc = truncate(&node.description_title, width.saturating_sub(text_x + 2));
        let indicator_x = text_x.saturating_sub(2);
        if node.is_working_copy && is_selected {
            put_text(
                &mut cells,
                indicator_x.saturating_sub(1),
                y,
                "@",
                t.semantic_success,
            );
            put_text(&mut cells, indicator_x, y, ">", t.slate_text);
        } else if node.is_working_copy {
            put_text(&mut cells, indicator_x, y, "@", t.semantic_success);
        } else if is_selected {
            put_text(&mut cells, indicator_x, y, ">", t.slate_text);
        }
        put_text(
            &mut cells,
            text_x,
            y,
            &change_short,
            if is_selected {
                selected_text_color(t)
            } else {
                color
            },
        );
        put_text(
            &mut cells,
            text_x + 9,
            y,
            &commit_short,
            if is_selected {
                selected_text_color(t)
            } else {
                t.graph_commit_id
            },
        );
        put_text(
            &mut cells,
            text_x,
            y + 1,
            if desc.is_empty() {
                "(no description)"
            } else {
                &desc
            },
            if is_selected {
                selected_text_color(t)
            } else {
                t.graph_text_desc
            },
        );
        if !node.bookmarks.is_empty() {
            let bm = format!(" ({})", node.bookmarks.join(","));
            let desc_len = desc.len().min(width.saturating_sub(text_x));
            put_text(
                &mut cells,
                text_x + desc_len,
                y + 1,
                &truncate(&bm, width.saturating_sub(text_x + desc_len + 1)),
                if is_selected {
                    t.graph_bookmark_selected
                } else {
                    t.graph_bookmark
                },
            );
        }
        let files = app
            .files_by_change
            .get(&node.change_id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        put_graph_file_summary(
            &mut cells,
            text_x,
            y + 2,
            files,
            width.saturating_sub(text_x + 1),
            is_selected,
            t,
        );
    }

    let lines = cells
        .into_iter()
        .map(|row| {
            Line::from(
                row.into_iter()
                    .map(|cell| Span::styled(cell.ch.to_string(), Style::default().fg(cell.fg)))
                    .collect::<Vec<_>>(),
            )
        })
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines).block(block), area);
}

#[derive(Debug, Clone, Copy)]
struct GraphCell {
    ch: char,
    fg: Color,
}

impl Default for GraphCell {
    fn default() -> Self {
        Self {
            ch: ' ',
            fg: UI_TOKENS.graph_text_muted,
        }
    }
}

fn lane_color(tokens: &UiTokens, lane: usize) -> Color {
    tokens.graph_lanes[lane % tokens.graph_lanes.len()]
}

fn build_children_by_id(
    nodes: &[juzu_core::CommitNode],
) -> std::collections::HashMap<&str, Vec<usize>> {
    let mut children: std::collections::HashMap<&str, Vec<usize>> =
        std::collections::HashMap::new();
    for (idx, child) in nodes.iter().enumerate() {
        for parent_id in &child.parents {
            children.entry(parent_id.as_str()).or_default().push(idx);
        }
    }
    children
}

fn put_cell(cells: &mut [Vec<GraphCell>], x: usize, y: isize, ch: char, fg: Color) {
    if y >= 0 {
        if let Some(row) = cells.get_mut(y as usize) {
            if let Some(cell) = row.get_mut(x) {
                *cell = GraphCell { ch, fg };
            }
        }
    }
}

fn put_text(cells: &mut [Vec<GraphCell>], x: usize, y: isize, text: &str, fg: Color) {
    for (offset, ch) in text.chars().enumerate() {
        put_cell(cells, x + offset, y, ch, fg);
    }
}

fn draw_vert(cells: &mut [Vec<GraphCell>], x: usize, y_a: isize, y_b: isize, ch: char, fg: Color) {
    let from = y_a.min(y_b).max(0);
    let to = y_a.max(y_b).min(cells.len().saturating_sub(1) as isize);
    if from > to {
        return;
    }
    for y in from..=to {
        put_cell(cells, x, y, ch, fg);
    }
}

fn draw_horz(cells: &mut [Vec<GraphCell>], x_a: usize, x_b: usize, y: isize, ch: char, fg: Color) {
    let Some(width) = cells.first().map(Vec::len) else {
        return;
    };
    if y < 0 || y >= cells.len() as isize {
        return;
    }
    for x in x_a.min(x_b)..=x_a.max(x_b).min(width.saturating_sub(1)) {
        put_cell(cells, x, y, ch, fg);
    }
}

fn truncate(s: &str, max_len: usize) -> String {
    if max_len == 0 {
        return String::new();
    }
    let char_count = s.chars().count();
    if char_count <= max_len {
        return s.to_string();
    }
    if max_len <= 3 {
        return "…".repeat(max_len);
    }
    let mut out = s.chars().take(max_len - 3).collect::<String>();
    out.push_str("...");
    out
}

fn file_type_color(tokens: &UiTokens, file_type: &str) -> Color {
    match file_type {
        "A" => tokens.graph_file_add,
        "D" => tokens.graph_file_del,
        "M" => tokens.graph_file_mod,
        "R" => tokens.graph_bookmark,
        _ => tokens.slate_text_muted,
    }
}

fn brighten_color(color: Color, add: u8) -> Color {
    match color {
        Color::Rgb(r, g, b) => Color::Rgb(
            r.saturating_add(add),
            g.saturating_add(add),
            b.saturating_add(add),
        ),
        other => other,
    }
}

fn selected_file_type_color(tokens: &UiTokens, file_type: &str) -> Color {
    brighten_color(file_type_color(tokens, file_type), 60)
}

fn selected_text_color(tokens: &UiTokens) -> Color {
    brighten_color(tokens.slate_text, 60)
}

fn sidebar_heading_style(tokens: &UiTokens) -> Style {
    Style::default()
        .fg(tokens.semantic_info)
        .add_modifier(Modifier::BOLD)
}

fn sidebar_label_style(tokens: &UiTokens) -> Style {
    Style::default().fg(mix_color(tokens.slate_text_muted, tokens.slate_text, 0.65))
}

fn sidebar_muted_style(tokens: &UiTokens) -> Style {
    Style::default().fg(tokens.slate_text_muted)
}

fn sidebar_selected_text_style(tokens: &UiTokens) -> Style {
    Style::default()
        .fg(tokens.slate_text)
        .add_modifier(Modifier::BOLD)
}

fn truncate_bun_text(s: &str, max_len: usize) -> String {
    let char_count = s.chars().count();
    if char_count <= max_len {
        return s.to_string();
    }
    if max_len == 0 {
        return String::new();
    }
    if max_len <= 3 {
        return s.chars().take(max_len).collect();
    }
    let mut out = s.chars().take(max_len - 1).collect::<String>();
    out.push('…');
    out
}

fn sidebar_file_line(
    tokens: &UiTokens,
    file: &FileEntry,
    is_selected_diff_file: bool,
    max_width: usize,
) -> Line<'static> {
    let selector = if is_selected_diff_file { "▶ " } else { "" };
    let type_part = format!("{} ", file.r#type);
    let prefix_width = selector.chars().count() + type_part.chars().count();
    let path = truncate_bun_text(&file.path, max_width.saturating_sub(prefix_width));
    let mut spans = Vec::new();
    if is_selected_diff_file {
        spans.push(Span::styled(
            selector.to_string(),
            sidebar_heading_style(tokens),
        ));
    }
    spans.push(Span::styled(
        type_part,
        Style::default().fg(if is_selected_diff_file {
            selected_file_type_color(tokens, &file.r#type)
        } else {
            file_type_color(tokens, &file.r#type)
        }),
    ));
    spans.push(Span::styled(
        path,
        if is_selected_diff_file {
            sidebar_selected_text_style(tokens)
        } else {
            Style::default().fg(tokens.slate_text)
        },
    ));
    Line::from(spans)
}

fn put_graph_file_summary(
    cells: &mut [Vec<GraphCell>],
    x: usize,
    y: isize,
    files: &[FileEntry],
    max_len: usize,
    is_selected: bool,
    tokens: &UiTokens,
) {
    if max_len == 0 {
        return;
    }
    if files.is_empty() {
        put_text(
            cells,
            x,
            y,
            "no file changes",
            if is_selected {
                brighten_color(tokens.graph_text_muted, 40)
            } else {
                tokens.graph_text_muted
            },
        );
        return;
    }

    let mut cursor = x;
    let end = x.saturating_add(max_len);
    for (idx, file) in files.iter().take(3).enumerate() {
        if idx > 0 && cursor + 2 < end {
            put_text(
                cells,
                cursor,
                y,
                "  ",
                if is_selected {
                    brighten_color(tokens.slate_text, 40)
                } else {
                    tokens.graph_text_muted
                },
            );
            cursor += 2;
        }
        let color = if is_selected {
            selected_file_type_color(tokens, &file.r#type)
        } else {
            file_type_color(tokens, &file.r#type)
        };
        let text = format!("{} {}", file.r#type, file.path);
        let room = end.saturating_sub(cursor);
        if room == 0 {
            return;
        }
        let text = truncate(&text, room);
        put_text(cells, cursor, y, &text, color);
        cursor += text.chars().count();
        if cursor >= end {
            return;
        }
    }
    if files.len() > 3 && cursor + 3 < end {
        let more = truncate(
            &format!("  +{}", files.len() - 3),
            end.saturating_sub(cursor),
        );
        put_text(
            cells,
            cursor,
            y,
            &more,
            if is_selected {
                brighten_color(tokens.graph_text_muted, 40)
            } else {
                tokens.graph_text_muted
            },
        );
    }
}

fn render_collapsed_sidebar(frame: &mut Frame, area: Rect, app: &App) {
    let t = &app.theme;
    let lines = vec![
        Line::from(Span::styled("[ ]", sidebar_heading_style(t))),
        Line::from(Span::styled("^L c", sidebar_muted_style(t))),
    ];
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().bg(t.slate_panel))
            .block(
                Block::default()
                    .title(" side ")
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(t.slate_border_soft))
                    .style(Style::default().bg(t.slate_panel)),
            ),
        area,
    );
}

fn render_sidebar_mode_panel(
    frame: &mut Frame,
    area: Rect,
    title: &'static str,
    lines: Vec<Line<'static>>,
    tokens: &UiTokens,
) {
    frame.render_widget(
        Paragraph::new(lines)
            .style(
                Style::default()
                    .fg(tokens.slate_text)
                    .bg(tokens.slate_panel),
            )
            .block(
                Block::default()
                    .title(title)
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(tokens.slate_border_soft))
                    .style(Style::default().bg(tokens.slate_panel)),
            ),
        area,
    );
}

fn render_sidebar(
    frame: &mut Frame,
    area: Rect,
    app: &App,
    layout: &juzu_core::layout::LayoutResult,
) {
    let t = &app.theme;
    if app.show_help {
        render_sidebar_mode_panel(
            frame,
            area,
            " Help (h to close) ",
            vec![
                Line::from(Span::styled("Navigation", sidebar_heading_style(t))),
                Line::from("j/k or ↑/↓  Navigate"),
                Line::from("PgUp/PgDn   Scroll"),
                Line::from(""),
                Line::from(Span::styled("Leader Modes", sidebar_heading_style(t))),
                Line::from("^X Actions  ^O Ops  ^L View  ^B Book"),
                Line::from(""),
                Line::from(Span::styled("View", sidebar_heading_style(t))),
                Line::from("c sidebar  f files  x description"),
                Line::from("t theme  / revset  ^d diff"),
                Line::from(""),
                Line::from("Press h, q, or Esc to close help"),
            ],
            t,
        );
        return;
    }
    if app.theme_picker_mode {
        let mut lines = vec![
            Line::from(Span::styled("THEME SELECTOR", sidebar_heading_style(t))),
            Line::from(""),
        ];
        let options = theme_options();
        let list_capacity = (area.height as usize).saturating_sub(16).max(5);
        let (start, end) =
            theme_picker_window(app.theme_picker_index, options.len(), list_capacity);
        if start > 0 {
            lines.push(Line::from(Span::styled(
                format!("… {start} above"),
                sidebar_muted_style(t),
            )));
        }
        for (index, theme) in options.iter().enumerate().skip(start).take(end - start) {
            let cursor = if index == app.theme_picker_index {
                ">"
            } else {
                " "
            };
            let current = if *theme == app.current_theme {
                "●"
            } else {
                " "
            };
            let swatch = UiTokens::named(theme);
            let style = if index == app.theme_picker_index {
                Style::default()
                    .fg(t.semantic_success)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(t.slate_text)
            };
            lines.push(Line::from(vec![
                Span::styled(format!("{cursor} "), style),
                Span::styled("██", Style::default().fg(swatch.semantic_info)),
                Span::raw(" "),
                Span::styled(current, Style::default().fg(t.semantic_success)),
                Span::raw(" "),
                Span::styled((*theme).to_string(), style),
            ]));
        }
        if end < options.len() {
            lines.push(Line::from(Span::styled(
                format!("… {} below", options.len() - end),
                sidebar_muted_style(t),
            )));
        }
        let preview_theme_name = options[app.theme_picker_index];
        let preview_theme = UiTokens::named(preview_theme_name);
        lines.extend([
            Line::from(""),
            Line::from(format!("showing {}-{} / {}", start + 1, end, options.len())),
            Line::from(vec![
                Span::styled("PREVIEW ", sidebar_heading_style(t)),
                Span::styled(
                    preview_theme_name.to_string(),
                    Style::default()
                        .fg(preview_theme.semantic_info)
                        .add_modifier(Modifier::BOLD),
                ),
            ]),
            Line::from(vec![
                Span::styled("Surface ", sidebar_muted_style(t)),
                Span::styled(
                    " panel ",
                    Style::default()
                        .fg(preview_theme.slate_text)
                        .bg(preview_theme.slate_panel),
                ),
                Span::raw(" "),
                Span::styled(
                    " border ",
                    Style::default()
                        .fg(preview_theme.slate_border_strong)
                        .bg(preview_theme.slate_bg0),
                ),
            ]),
            Line::from(vec![
                Span::styled("Graph lanes ", sidebar_muted_style(t)),
                Span::styled("██", Style::default().fg(preview_theme.graph_lanes[0])),
                Span::styled("██", Style::default().fg(preview_theme.graph_lanes[1])),
                Span::styled("██", Style::default().fg(preview_theme.graph_lanes[2])),
                Span::styled("██", Style::default().fg(preview_theme.graph_lanes[3])),
                Span::styled("██", Style::default().fg(preview_theme.graph_lanes[4])),
                Span::styled("██", Style::default().fg(preview_theme.graph_lanes[5])),
            ]),
            Line::from(vec![
                Span::styled("Diff bands ", sidebar_muted_style(t)),
                Span::styled(
                    "▌+ Add ",
                    Style::default()
                        .fg(preview_theme.graph_file_add)
                        .bg(preview_theme.slate_bg2),
                ),
                Span::raw(" "),
                Span::styled(
                    "▌- Remove ",
                    Style::default()
                        .fg(preview_theme.graph_file_del)
                        .bg(preview_theme.slate_bg2),
                ),
            ]),
            Line::from(""),
            Line::from("j/k or ↑/↓: select"),
            Line::from("Enter: apply stays open"),
            Line::from("Esc/q: close"),
        ]);
        render_sidebar_mode_panel(frame, area, " Details ", lines, t);
        return;
    }
    if app.revset_mode {
        render_sidebar_mode_panel(
            frame,
            area,
            " Details ",
            vec![
                Line::from(Span::styled("Revset:", sidebar_heading_style(t))),
                Line::from(format!("{} _", app.revset_value)),
                Line::from(""),
                Line::from("Enter: apply  Esc: cancel  ←/→: move cursor"),
            ],
            t,
        );
        return;
    }
    let selected = app.selected.min(layout.nodes.len().saturating_sub(1));
    let Some(node) = layout.nodes.get(selected) else {
        return;
    };
    let mut lines = vec![
        Line::from(Span::styled(
            format!(
                "Change: {}{}",
                node.change_id,
                if node.is_working_copy { " (@)" } else { "" }
            ),
            if node.is_working_copy {
                Style::default().fg(t.semantic_success)
            } else {
                sidebar_heading_style(t)
            },
        )),
        Line::from(Span::styled(
            format!("Commit: {}", node.commit_id),
            sidebar_label_style(t),
        )),
        Line::from(Span::styled(
            format!("Author: {}", node.author),
            sidebar_label_style(t),
        )),
        Line::from(Span::styled(
            format!("Time: {}", node.time),
            sidebar_label_style(t),
        )),
        Line::from(""),
    ];
    if !node.bookmarks.is_empty() {
        lines.push(Line::from(Span::styled(
            "Bookmarks:",
            sidebar_label_style(t),
        )));
        for bookmark in node.bookmarks.iter().take(4) {
            lines.push(Line::from(Span::styled(
                format!("  {bookmark}"),
                Style::default().fg(t.semantic_info),
            )));
        }
        if node.bookmarks.len() > 4 {
            lines.push(Line::from(Span::styled(
                format!("  ... +{} more", node.bookmarks.len() - 4),
                sidebar_muted_style(t),
            )));
        }
        lines.push(Line::from(""));
    }
    lines.push(Line::from(Span::styled(
        if app.desc_expanded {
            "Description:"
        } else {
            "Description (x expand):"
        },
        sidebar_label_style(t),
    )));
    lines.push(Line::from(if app.desc_expanded {
        node.description_full.clone()
    } else {
        node.description_title.clone()
    }));
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        if app.files_expanded {
            "Files (f collapse):"
        } else {
            "Files (f expand):"
        },
        sidebar_label_style(t),
    )));
    let files = app
        .files_by_change
        .get(&node.change_id)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if files.is_empty() {
        lines.push(Line::from("—"));
    } else {
        let diff_is_available = app
            .diffs_by_change
            .get(&node.change_id)
            .is_some_and(|diff| !diff.preview_rows.is_empty());
        let file_preview_limit = if !app.files_expanded {
            3
        } else if diff_is_available {
            4
        } else {
            12
        };
        let selected_file_index = if app.view_mode == ViewMode::Diff {
            Some(app.diff_file_index.min(files.len().saturating_sub(1)))
        } else {
            None
        };
        let mut file_start = 0usize;
        if let Some(selected_file_index) = selected_file_index {
            if selected_file_index >= file_preview_limit {
                file_start = selected_file_index
                    .saturating_add(1)
                    .saturating_sub(file_preview_limit);
            }
        }
        let file_end = (file_start + file_preview_limit).min(files.len());
        if file_start > 0 {
            lines.push(Line::from(format!("… {} before", file_start)));
        }
        for (idx, file) in files
            .iter()
            .enumerate()
            .skip(file_start)
            .take(file_end.saturating_sub(file_start))
        {
            let is_selected_diff_file = selected_file_index == Some(idx);
            lines.push(sidebar_file_line(
                t,
                file,
                is_selected_diff_file,
                area.width as usize,
            ));
        }
        if files.len() > file_end {
            lines.push(Line::from(format!("… {} more", files.len() - file_end)));
        }
    }
    if sidebar_shows_inline_diff_preview(app) {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled("Diff", sidebar_heading_style(t))));
        render_diff_preview_lines(&mut lines, app, node, area.width as usize, 14, t);
    }
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().fg(t.slate_text).bg(t.slate_panel))
            .block(
                Block::default()
                    .borders(default_chrome_borders(app.boxed_chrome))
                    .border_style(Style::default().fg(t.slate_border_soft))
                    .style(Style::default().bg(t.slate_panel)),
            ),
        area,
    );
}

fn sidebar_shows_inline_diff_preview(app: &App) -> bool {
    app.view_mode != ViewMode::Diff
}

fn render_diff_preview_lines(
    lines: &mut Vec<Line<'static>>,
    app: &App,
    node: &juzu_core::CommitNode,
    sidebar_width: usize,
    visible_count: usize,
    t: &UiTokens,
) {
    let Some(diff) = app.diffs_by_change.get(&node.change_id) else {
        lines.push(Line::from(Span::styled(
            "  waiting for native diff",
            sidebar_muted_style(t),
        )));
        return;
    };

    lines.push(render_diff_metadata(
        t,
        &format!(
            "{} files · {} raw · {} rows · {} shown",
            diff.file_count,
            diff.raw_line_count,
            diff.row_count,
            diff.preview_rows.len()
        ),
        sidebar_width.saturating_sub(4),
    ));
    if let Some(error) = &diff.parse_error {
        lines.push(Line::from(Span::styled(
            truncate(error, sidebar_width.saturating_sub(4)),
            Style::default().fg(t.semantic_error),
        )));
        return;
    }
    let active_rows = if app.view_mode == ViewMode::Diff {
        rows_for_diff_file(diff, app.diff_file_index)
    } else {
        diff.preview_rows.clone()
    };
    if active_rows.is_empty() {
        lines.push(render_diff_metadata(
            t,
            "clean patch",
            sidebar_width.saturating_sub(4),
        ));
        return;
    }

    let max_scroll = active_rows.len().saturating_sub(visible_count);
    let scroll = app.diff_scroll.min(max_scroll);
    let end = (scroll + visible_count).min(active_rows.len());
    lines.push(render_diff_scroll_range(
        t,
        scroll,
        end,
        active_rows.len(),
        sidebar_width.saturating_sub(4),
    ));
    if let Some(anchor) =
        render_diff_anchor_label(t, &active_rows, scroll, sidebar_width.saturating_sub(4))
    {
        lines.push(anchor);
    }
    let gutter_width = diff_line_number_gutter_width(&active_rows);
    for row in active_rows.iter().skip(scroll).take(visible_count) {
        lines.push(render_diff_row_with_gutter(
            t,
            row,
            sidebar_width.saturating_sub(4),
            gutter_width,
        ));
    }
    if active_rows.len() > end {
        lines.push(render_diff_collapse_row(
            t,
            &format!("{} more rows below", active_rows.len() - end),
            sidebar_width.saturating_sub(4),
        ));
    }
}

#[cfg(test)]
fn render_diff_rows_with_gutter(
    tokens: &UiTokens,
    rows: &[DiffRow],
    max_len: usize,
) -> Vec<Line<'static>> {
    let gutter_width = diff_line_number_gutter_width(rows);
    rows.iter()
        .map(|row| render_diff_row_with_gutter(tokens, row, max_len, gutter_width))
        .collect()
}

#[cfg(test)]
fn render_full_diff_rows(
    tokens: &UiTokens,
    rows: &[DiffRow],
    max_len: usize,
) -> Vec<Line<'static>> {
    let gutter_width = diff_line_number_gutter_width(rows);
    rows.iter()
        .flat_map(|row| render_full_diff_row_with_gutter(tokens, row, max_len, gutter_width))
        .collect()
}

fn diff_line_number_gutter_width(rows: &[DiffRow]) -> usize {
    rows.iter()
        .filter_map(diff_row_line_number)
        .map(|value| value.to_string().chars().count())
        .max()
        .unwrap_or(0)
        .max(3)
}

fn diff_row_line_number(row: &DiffRow) -> Option<usize> {
    match row.kind {
        DiffRowKind::Remove => row.old_line,
        DiffRowKind::Add | DiffRowKind::Context => row.new_line.or(row.old_line),
        _ => row.new_line.or(row.old_line),
    }
}

#[cfg(test)]
fn render_full_diff_row(tokens: &UiTokens, row: &DiffRow, max_len: usize) -> Vec<Line<'static>> {
    let gutter_width = diff_row_line_number(row)
        .map(|value| value.to_string().chars().count())
        .unwrap_or(0)
        .max(3);
    render_full_diff_row_with_gutter(tokens, row, max_len, gutter_width)
}

fn render_full_diff_row_with_gutter(
    tokens: &UiTokens,
    row: &DiffRow,
    max_len: usize,
    gutter_width: usize,
) -> Vec<Line<'static>> {
    if is_no_newline_marker(row) {
        return vec![render_diff_no_newline_marker_with_gutter(
            tokens,
            max_len,
            gutter_width,
        )];
    }
    if !matches!(
        row.kind,
        DiffRowKind::Context | DiffRowKind::Add | DiffRowKind::Remove
    ) {
        return vec![render_diff_row(tokens, row, max_len)];
    }
    let line_number = diff_row_line_number(row)
        .map(|value| value.to_string())
        .unwrap_or_default();
    let sign_width = 3usize;
    let text_budget = max_len.saturating_sub(gutter_width + sign_width);
    if text_budget == 0 {
        return vec![render_diff_code_row(tokens, row, max_len)];
    }
    let sign = match row.kind {
        DiffRowKind::Add => "+",
        DiffRowKind::Remove => "-",
        _ => " ",
    };
    let add_bg = mix_color(tokens.slate_bg0, tokens.semantic_file_add, 0.48);
    let remove_bg = mix_color(tokens.slate_bg0, tokens.semantic_file_del, 0.48);
    let gutter_style = Style::default()
        .fg(tokens.slate_text_muted)
        .bg(tokens.slate_bg1);
    let (sign_style, text_style) = match row.kind {
        DiffRowKind::Add => (
            Style::default()
                .fg(tokens.semantic_file_add)
                .bg(tokens.slate_bg1)
                .add_modifier(Modifier::BOLD),
            Style::default().fg(tokens.slate_text).bg(add_bg),
        ),
        DiffRowKind::Remove => (
            Style::default()
                .fg(tokens.semantic_file_del)
                .bg(tokens.slate_bg1)
                .add_modifier(Modifier::BOLD),
            Style::default().fg(tokens.slate_text).bg(remove_bg),
        ),
        _ => (
            Style::default()
                .fg(tokens.slate_text_muted)
                .bg(tokens.slate_bg1),
            Style::default().fg(tokens.slate_text).bg(tokens.slate_bg0),
        ),
    };
    let content = row.text.strip_prefix(['+', '-', ' ']).unwrap_or(&row.text);
    let chars: Vec<char> = content.chars().collect();
    if chars.is_empty() {
        return vec![render_diff_code_row(tokens, row, max_len)];
    }

    chars
        .chunks(text_budget)
        .enumerate()
        .map(|(idx, chunk)| {
            let chunk_text: String = chunk.iter().collect();
            let chunk_text = format!("{chunk_text:<width$}", width = text_budget);
            let (gutter, sign_cell) = if idx == 0 {
                (format!("{line_number:>gutter_width$}"), format!(" {sign} "))
            } else {
                (" ".repeat(gutter_width), "   ".to_string())
            };
            Line::from(vec![
                Span::styled(gutter, gutter_style),
                Span::styled(sign_cell, sign_style),
                Span::styled(chunk_text, text_style),
            ])
        })
        .collect()
}

fn render_diff_row(tokens: &UiTokens, row: &DiffRow, max_len: usize) -> Line<'static> {
    render_diff_row_with_gutter(tokens, row, max_len, 3)
}

fn render_diff_row_with_gutter(
    tokens: &UiTokens,
    row: &DiffRow,
    max_len: usize,
    gutter_width: usize,
) -> Line<'static> {
    match row.kind {
        DiffRowKind::FileHeader => render_diff_file_header(tokens, row, max_len),
        DiffRowKind::Metadata => {
            if is_no_newline_marker(row) {
                render_diff_no_newline_marker_with_gutter(tokens, max_len, gutter_width)
            } else {
                render_diff_metadata(tokens, &row.text, max_len)
            }
        }
        DiffRowKind::HunkHeader => render_diff_hunk_header(tokens, row, max_len),
        DiffRowKind::Context | DiffRowKind::Add | DiffRowKind::Remove => {
            render_diff_code_row_with_gutter(tokens, row, max_len, gutter_width)
        }
        DiffRowKind::Collapse => render_diff_collapse_row(tokens, &row.text, max_len),
    }
}

fn render_diff_file_header(_tokens: &UiTokens, row: &DiffRow, max_len: usize) -> Line<'static> {
    let text = truncate(&format!("◆ {}", row.text), max_len.saturating_sub(2));
    Line::from(vec![
        Span::styled(
            "╭",
            Style::default()
                .fg(Color::LightBlue)
                .bg(Color::Rgb(17, 24, 39)),
        ),
        Span::styled(
            format!(" {:<width$}", text, width = max_len.saturating_sub(2)),
            Style::default()
                .fg(Color::LightCyan)
                .bg(Color::Rgb(17, 24, 39))
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            "╮",
            Style::default()
                .fg(Color::LightBlue)
                .bg(Color::Rgb(17, 24, 39)),
        ),
    ])
}

fn render_diff_metadata(tokens: &UiTokens, text: &str, max_len: usize) -> Line<'static> {
    Line::from(vec![
        Span::styled("  · ", sidebar_muted_style(tokens)),
        Span::styled(
            truncate(text, max_len.saturating_sub(4)),
            sidebar_muted_style(tokens),
        ),
    ])
}

fn render_diff_hunk_header(_tokens: &UiTokens, row: &DiffRow, max_len: usize) -> Line<'static> {
    let text = truncate(&row.text, max_len.saturating_sub(5));
    Line::from(vec![
        Span::styled(
            "╭─ ",
            Style::default()
                .fg(Color::LightMagenta)
                .bg(Color::Rgb(30, 27, 75)),
        ),
        Span::styled(
            format!("{:<width$}", text, width = max_len.saturating_sub(5)),
            Style::default()
                .fg(Color::LightBlue)
                .bg(Color::Rgb(30, 27, 75))
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            " ╮",
            Style::default()
                .fg(Color::LightMagenta)
                .bg(Color::Rgb(30, 27, 75)),
        ),
    ])
}

fn render_diff_code_row(tokens: &UiTokens, row: &DiffRow, max_len: usize) -> Line<'static> {
    render_diff_code_row_with_gutter(tokens, row, max_len, 3)
}

fn render_diff_code_row_with_gutter(
    tokens: &UiTokens,
    row: &DiffRow,
    max_len: usize,
    gutter_width: usize,
) -> Line<'static> {
    let line_number = match row.kind {
        DiffRowKind::Remove => row.old_line,
        DiffRowKind::Add | DiffRowKind::Context => row.new_line.or(row.old_line),
        _ => row.new_line.or(row.old_line),
    }
    .map(|value| value.to_string())
    .unwrap_or_default();
    let sign = match row.kind {
        DiffRowKind::Add => "+",
        DiffRowKind::Remove => "-",
        _ => " ",
    };
    let add_bg = mix_color(tokens.slate_bg0, tokens.semantic_file_add, 0.48);
    let remove_bg = mix_color(tokens.slate_bg0, tokens.semantic_file_del, 0.48);
    let gutter_style = Style::default()
        .fg(tokens.slate_text_muted)
        .bg(tokens.slate_bg1);
    let (sign_style, text_style) = match row.kind {
        DiffRowKind::Add => (
            Style::default()
                .fg(tokens.semantic_file_add)
                .bg(tokens.slate_bg1)
                .add_modifier(Modifier::BOLD),
            Style::default().fg(tokens.slate_text).bg(add_bg),
        ),
        DiffRowKind::Remove => (
            Style::default()
                .fg(tokens.semantic_file_del)
                .bg(tokens.slate_bg1)
                .add_modifier(Modifier::BOLD),
            Style::default().fg(tokens.slate_text).bg(remove_bg),
        ),
        _ => (
            Style::default()
                .fg(tokens.slate_text_muted)
                .bg(tokens.slate_bg1),
            Style::default().fg(tokens.slate_text).bg(tokens.slate_bg0),
        ),
    };
    let gutter = format!("{line_number:>gutter_width$}");
    let sign_cell = format!(" {sign} ");
    let text_budget = max_len.saturating_sub(gutter.len() + sign_cell.len());
    let content = row.text.strip_prefix(['+', '-', ' ']).unwrap_or(&row.text);
    let content = truncate(content, text_budget);
    let content = format!("{content:<width$}", width = text_budget);
    Line::from(vec![
        Span::styled(gutter, gutter_style),
        Span::styled(sign_cell, sign_style),
        Span::styled(content, text_style),
    ])
}

fn render_diff_no_newline_marker_with_gutter(
    tokens: &UiTokens,
    max_len: usize,
    gutter_width: usize,
) -> Line<'static> {
    let sign_width = 3usize;
    let text_budget = max_len.saturating_sub(gutter_width + sign_width);
    let content = truncate(r"\ No newline at end of file", text_budget);
    let content = format!("{content:<width$}", width = text_budget);
    Line::from(vec![
        Span::styled(
            " ".repeat(gutter_width),
            Style::default()
                .fg(tokens.slate_text_muted)
                .bg(tokens.slate_bg1),
        ),
        Span::styled(
            " ".repeat(sign_width),
            Style::default()
                .fg(tokens.slate_text_muted)
                .bg(tokens.slate_bg1),
        ),
        Span::styled(
            content,
            Style::default()
                .fg(tokens.slate_text_muted)
                .bg(tokens.slate_bg0),
        ),
    ])
}

fn render_diff_collapse_row(_tokens: &UiTokens, text: &str, max_len: usize) -> Line<'static> {
    let label = format!(" ⋯ {} ", text.trim_start_matches('⋯').trim());
    let clipped = truncate(&label, max_len);
    let left = max_len.saturating_sub(clipped.len()) / 2;
    let right = max_len.saturating_sub(clipped.len() + left);
    Line::from(vec![
        Span::styled(
            "─".repeat(left),
            Style::default().fg(UI_TOKENS.slate_text_muted),
        ),
        Span::styled(
            clipped,
            Style::default()
                .fg(UI_TOKENS.semantic_warn)
                .bg(Color::Rgb(66, 32, 6)),
        ),
        Span::styled(
            "─".repeat(right),
            Style::default().fg(UI_TOKENS.slate_text_muted),
        ),
    ])
}

fn render_diff_scroll_range(
    tokens: &UiTokens,
    scroll: usize,
    end: usize,
    total: usize,
    max_len: usize,
) -> Line<'static> {
    let label = if total == 0 {
        "diff rows 0/0".to_string()
    } else {
        format!("diff rows {}-{} of {}", scroll + 1, end, total)
    };
    render_diff_metadata(tokens, &truncate(&label, max_len), max_len)
}

fn render_diff_anchor_label(
    tokens: &UiTokens,
    rows: &[DiffRow],
    scroll: usize,
    max_len: usize,
) -> Option<Line<'static>> {
    let upto = rows.len().min(scroll.saturating_add(1));
    if upto == 0 {
        return None;
    }
    let mut file = None;
    let mut hunk = None;
    for row in rows.iter().take(upto) {
        match row.kind {
            DiffRowKind::FileHeader => file = Some(row.text.as_str()),
            DiffRowKind::HunkHeader => hunk = Some(row.text.as_str()),
            _ => {}
        }
    }
    let label = match (file, hunk) {
        (Some(file), Some(hunk)) => format!("STICKY ▸ {hunk} · {file}"),
        (Some(file), None) => format!("STICKY ▸ top · {file}"),
        (None, Some(hunk)) => format!("STICKY ▸ {hunk}"),
        (None, None) => return None,
    };
    let clipped = truncate(&label, max_len.saturating_sub(2));
    Some(Line::from(vec![Span::styled(
        format!(" {:<width$}", clipped, width = max_len.saturating_sub(1)),
        Style::default()
            .fg(tokens.semantic_info)
            .bg(tokens.slate_bg2)
            .add_modifier(Modifier::BOLD),
    )]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_ui_tokens_match_old_juzu_defaults() {
        assert_eq!(UI_TOKENS.slate_bg0, Color::Rgb(0x11, 0x13, 0x18));
        assert_eq!(UI_TOKENS.slate_panel, Color::Rgb(0x1a, 0x20, 0x29));
        assert_eq!(UI_TOKENS.slate_bg2, Color::Rgb(0x1d, 0x25, 0x30));
        assert_eq!(UI_TOKENS.semantic_info, Color::Rgb(0x7f, 0x9f, 0xbf));
        assert_eq!(UI_TOKENS.semantic_success, Color::Rgb(0x74, 0xb8, 0x8c));
        assert_eq!(UI_TOKENS.semantic_mode_log, Color::Rgb(0x6f, 0x89, 0xad));
    }

    #[test]
    fn rust_graph_lane_colors_match_old_juzu_defaults() {
        let expected = [
            Color::Rgb(0x00, 0xf0, 0xff),
            Color::Rgb(0xff, 0x00, 0x55),
            Color::Rgb(0x00, 0xff, 0x9d),
            Color::Rgb(0xff, 0xaa, 0x00),
            Color::Rgb(0xaa, 0x00, 0xff),
            Color::Rgb(0x00, 0xaa, 0xff),
            Color::Rgb(0xff, 0xff, 0x00),
            Color::Rgb(0xff, 0x00, 0xaa),
        ];
        for (lane, color) in expected.into_iter().enumerate() {
            assert_eq!(lane_color(&UI_TOKENS, lane), color, "lane {lane}");
        }
        assert_eq!(lane_color(&UI_TOKENS, 8), expected[0]);
    }

    #[test]
    fn graph_lane_colors_use_active_theme_tokens() {
        let theme = UiTokens::named("catppuccin");
        assert_eq!(lane_color(&theme, 0), Color::Rgb(0x89, 0xb4, 0xfa));
        assert_eq!(lane_color(&theme, 8), Color::Rgb(0x89, 0xb4, 0xfa));
    }

    #[test]
    fn rust_file_badge_colors_match_old_juzu_defaults() {
        assert_eq!(
            file_type_color(&UI_TOKENS, "A"),
            Color::Rgb(0x74, 0xb8, 0x8c)
        );
        assert_eq!(
            file_type_color(&UI_TOKENS, "M"),
            Color::Rgb(0xc9, 0xa8, 0x6a)
        );
        assert_eq!(
            file_type_color(&UI_TOKENS, "D"),
            Color::Rgb(0xce, 0x6f, 0x7c)
        );
    }

    #[test]
    fn file_badge_colors_use_active_theme_tokens() {
        let theme = UiTokens::named("catppuccin");
        assert_eq!(file_type_color(&theme, "A"), Color::Rgb(0xa6, 0xe3, 0xa1));
        assert_eq!(file_type_color(&theme, "M"), Color::Rgb(0xf9, 0xe2, 0xaf));
        assert_eq!(file_type_color(&theme, "D"), Color::Rgb(0xf3, 0x8b, 0xa8));
    }

    #[test]
    fn selected_row_colors_brighten_like_old_bun_graph_view() {
        assert_eq!(
            brighten_color(UI_TOKENS.slate_text, 60),
            Color::Rgb(0xff, 0xff, 0xff)
        );
        assert_eq!(
            selected_file_type_color(&UI_TOKENS, "A"),
            Color::Rgb(0xb0, 0xf4, 0xc8)
        );
        assert_eq!(
            selected_file_type_color(&UI_TOKENS, "M"),
            Color::Rgb(0xff, 0xe4, 0xa6)
        );
        assert_eq!(
            selected_file_type_color(&UI_TOKENS, "D"),
            Color::Rgb(0xff, 0xab, 0xb8)
        );
    }

    #[test]
    fn sidebar_styles_use_active_theme_tokens() {
        let theme = UiTokens::named("catppuccin");
        assert_eq!(
            sidebar_heading_style(&theme).fg,
            Some(Color::Rgb(0x89, 0xb4, 0xfa))
        );
        assert_eq!(
            sidebar_muted_style(&theme).fg,
            Some(Color::Rgb(0xa6, 0xad, 0xc8))
        );
        assert_eq!(
            sidebar_selected_text_style(&theme).fg,
            Some(Color::Rgb(0xcd, 0xd6, 0xf4))
        );
    }

    #[test]
    fn sidebar_label_style_matches_bun_dim_to_text_mix() {
        assert_eq!(
            sidebar_label_style(&UI_TOKENS).fg,
            Some(Color::Rgb(0xbd, 0xc4, 0xd1))
        );
    }

    #[test]
    fn sidebar_file_rows_match_bun_padding_and_truncation() {
        let file = FileEntry {
            path: "crates/juzu-tui/src/some/really/deep/file/that/needs/truncation.rs".to_string(),
            r#type: "M".to_string(),
        };
        let line = sidebar_file_line(&UI_TOKENS, &file, false, 24);
        let rendered = line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert_eq!(rendered.chars().count(), 24);
        assert!(rendered.starts_with("M crates/juzu-tui"));
        assert!(rendered.ends_with('…'));
        assert!(!rendered.starts_with("  M"));
    }

    #[test]
    fn sidebar_selected_diff_file_rows_keep_arrow_inside_width() {
        let file = FileEntry {
            path: "packages/super-long-path/component.tsx".to_string(),
            r#type: "A".to_string(),
        };
        let line = sidebar_file_line(&UI_TOKENS, &file, true, 18);
        let rendered = line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert_eq!(rendered.chars().count(), 18);
        assert!(rendered.starts_with("▶ A packages/s"));
        assert!(rendered.ends_with('…'));
    }

    #[test]
    fn compact_home_path_matches_old_footer_bar() {
        let home = std::env::var("HOME").expect("HOME is set in parity environment");
        let path = PathBuf::from(format!("{home}/dev/juzu"));
        assert_eq!(compact_home_path(&path), "~/dev/juzu");
    }

    #[test]
    fn footer_segments_match_old_bun_footer_bar_layers() {
        let home = std::env::var("HOME").expect("HOME is set in parity environment");
        let path = PathBuf::from(format!("{home}/dev/juzu"));
        let nodes = vec![juzu_core::CommitNode {
            change_id: "abc123456789".to_string(),
            commit_id: "def123456789".to_string(),
            parents: vec![],
            author: "tester".to_string(),
            time: "now".to_string(),
            bookmarks: vec!["main".to_string()],
            git_branches: vec![],
            description_title: "wc".to_string(),
            description_full: "wc".to_string(),
            is_empty: false,
            is_conflict: false,
            is_hidden: false,
            is_root: false,
            is_working_copy: true,
            x: None,
            y: None,
            lane: None,
            extra_height: None,
            is_pinned: false,
        }];

        let line = footer_line(&UI_TOKENS, &path, LayoutMode::Mainline, &nodes, 80);
        let spans = line.spans;
        assert_eq!(spans[0].content.as_ref(), " ~/dev/juzu ");
        assert_eq!(spans[0].style.bg, Some(UI_TOKENS.slate_bg2));
        assert_eq!(spans[0].style.fg, Some(UI_TOKENS.semantic_info));
        assert_eq!(spans[1].content.as_ref(), "main");
        assert_eq!(spans[1].style.bg, Some(UI_TOKENS.slate_panel));
        assert_eq!(spans[1].style.fg, Some(UI_TOKENS.semantic_info));
        assert_eq!(spans[2].content.as_ref(), " @abc12345");
        assert_eq!(spans[2].style.bg, Some(UI_TOKENS.slate_panel));
        assert_eq!(spans[2].style.fg, Some(UI_TOKENS.semantic_success));
        assert_eq!(spans[4].content.as_ref(), "mainline");
        assert_eq!(spans[4].style.bg, Some(UI_TOKENS.slate_panel));
        assert_eq!(spans[4].style.fg, Some(UI_TOKENS.slate_text));
        assert_eq!(spans[5].content.as_ref(), " 1 nodes ");
        assert_eq!(spans[5].style.bg, Some(UI_TOKENS.slate_bg2));
        assert_eq!(spans[5].style.fg, Some(UI_TOKENS.semantic_success));
    }

    #[test]
    fn bun_parity_default_chrome_is_smooth_not_boxed() {
        assert_eq!(default_chrome_borders(false), Borders::NONE);
    }

    #[test]
    fn boxed_chrome_toggle_restores_bordered_review_mode() {
        assert_eq!(default_chrome_borders(true), Borders::ALL);
    }

    #[test]
    fn default_log_limit_matches_original_juzu_scale() {
        assert_eq!(DEFAULT_LOG_LIMIT, 500);
    }

    #[test]
    fn status_buttons_use_bun_slate_colored_segments() {
        let style = status_item_style(&UI_TOKENS, LeaderMode::Action);
        assert_eq!(style.bg, Some(Color::Rgb(0x65, 0x5c, 0x48)));
        assert_eq!(style.fg, Some(Color::Rgb(0xd1, 0xc5, 0xae)));
        let style = status_item_style(&UI_TOKENS, LeaderMode::View);
        assert_eq!(style.bg, Some(Color::Rgb(0x3f, 0x4f, 0x65)));
        assert_eq!(style.fg, Some(Color::Rgb(0xa8, 0xb7, 0xcd)));
    }

    #[test]
    fn diff_status_bar_matches_bun_chrome_labels() {
        let line = diff_status_bar_line(
            status_mode_style(&UI_TOKENS, None),
            status_key_style(&UI_TOKENS),
            status_item_style(&UI_TOKENS, LeaderMode::View),
        );
        let rendered = line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(rendered.contains("[] File"), "{rendered:?}");
        assert!(rendered.contains("escape Exit"), "{rendered:?}");
        assert!(!rendered.contains("Hunk"), "{rendered:?}");
        assert!(!rendered.contains("{/}"), "{rendered:?}");
        assert!(!rendered.contains("Esc"), "{rendered:?}");
    }

    #[test]
    fn status_mode_badge_uses_bun_mode_tint_mix() {
        let style = status_mode_style(&UI_TOKENS, None);
        assert_eq!(style.bg, Some(Color::Rgb(0x82, 0x98, 0xb8)));
        assert_eq!(style.fg, Some(UI_TOKENS.slate_bg0));
    }

    #[test]
    fn view_leader_status_fits_two_rows_without_extra_exit_row() {
        let lines = view_leader_status_lines(&UI_TOKENS);
        assert_eq!(lines.len(), 2);
        let rendered = lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(!rendered.contains("Esc/q Exit"));
    }

    #[test]
    fn theme_picker_window_keeps_selected_visible() {
        assert_eq!(theme_picker_window(0, 21, 8), (0, 8));
        assert_eq!(theme_picker_window(10, 21, 8), (7, 15));
        assert_eq!(theme_picker_window(20, 21, 8), (13, 21));
    }

    #[test]
    fn full_diff_scaffold_is_opt_in_not_deleted() {
        let diff = DiffPreview {
            raw_line_count: 7,
            file_count: 1,
            row_count: 5,
            preview_rows: vec![],
            full_rows: Some(vec![
                DiffRow {
                    kind: DiffRowKind::FileHeader,
                    file_index: 0,
                    hunk_index: None,
                    old_line: None,
                    new_line: None,
                    text: "Modified src/lib.rs".to_string(),
                },
                DiffRow {
                    kind: DiffRowKind::Metadata,
                    file_index: 0,
                    hunk_index: None,
                    old_line: None,
                    new_line: None,
                    text: "diff --git a/src/lib.rs b/src/lib.rs".to_string(),
                },
                DiffRow {
                    kind: DiffRowKind::HunkHeader,
                    file_index: 0,
                    hunk_index: Some(0),
                    old_line: None,
                    new_line: None,
                    text: "@@ -1,1 +1,1 @@".to_string(),
                },
                DiffRow {
                    kind: DiffRowKind::Add,
                    file_index: 0,
                    hunk_index: Some(0),
                    old_line: None,
                    new_line: Some(1),
                    text: "+new".to_string(),
                },
            ]),
            parse_error: None,
        };

        let clean_rows = full_diff_pane_rows(&diff, 0, false);
        assert!(clean_rows.iter().all(|row| matches!(
            row.kind,
            DiffRowKind::Add | DiffRowKind::Remove | DiffRowKind::Context | DiffRowKind::Collapse
        )));

        let scaffold_rows = full_diff_pane_rows(&diff, 0, true);
        assert!(scaffold_rows
            .iter()
            .any(|row| row.kind == DiffRowKind::FileHeader));
        assert!(scaffold_rows
            .iter()
            .any(|row| row.kind == DiffRowKind::Metadata));
        assert!(scaffold_rows
            .iter()
            .any(|row| row.kind == DiffRowKind::HunkHeader));
    }

    #[test]
    fn full_diff_pane_hides_patch_scaffold_like_bun_diffview() {
        let diff = DiffPreview {
            raw_line_count: 7,
            file_count: 1,
            row_count: 5,
            preview_rows: vec![],
            full_rows: Some(vec![
                DiffRow {
                    kind: DiffRowKind::FileHeader,
                    file_index: 0,
                    hunk_index: None,
                    old_line: None,
                    new_line: None,
                    text: "Modified src/lib.rs".to_string(),
                },
                DiffRow {
                    kind: DiffRowKind::Metadata,
                    file_index: 0,
                    hunk_index: None,
                    old_line: None,
                    new_line: None,
                    text: "diff --git a/src/lib.rs b/src/lib.rs".to_string(),
                },
                DiffRow {
                    kind: DiffRowKind::HunkHeader,
                    file_index: 0,
                    hunk_index: Some(0),
                    old_line: None,
                    new_line: None,
                    text: "@@ -1,1 +1,1 @@".to_string(),
                },
                DiffRow {
                    kind: DiffRowKind::Remove,
                    file_index: 0,
                    hunk_index: Some(0),
                    old_line: Some(1),
                    new_line: None,
                    text: "-old".to_string(),
                },
                DiffRow {
                    kind: DiffRowKind::Add,
                    file_index: 0,
                    hunk_index: Some(0),
                    old_line: None,
                    new_line: Some(1),
                    text: "+new".to_string(),
                },
            ]),
            parse_error: None,
        };

        let visible = diffview_rows_for_file(&diff, 0);
        assert_eq!(visible.len(), 2);
        assert!(visible
            .iter()
            .all(|row| matches!(row.kind, DiffRowKind::Add | DiffRowKind::Remove)));
        assert!(!visible
            .iter()
            .any(|row| row.text.contains("diff --git") || row.text.contains("@@")));
    }

    #[test]
    fn full_diff_rows_share_larger_bun_line_number_gutter() {
        let rows = vec![
            DiffRow {
                kind: DiffRowKind::Add,
                file_index: 0,
                hunk_index: Some(0),
                old_line: None,
                new_line: Some(9),
                text: "+abcdef".to_string(),
            },
            DiffRow {
                kind: DiffRowKind::Add,
                file_index: 0,
                hunk_index: Some(0),
                old_line: None,
                new_line: Some(1200),
                text: "+ghijkl".to_string(),
            },
        ];
        let rendered: Vec<String> = render_full_diff_rows(&UI_TOKENS, &rows, 12)
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect()
            })
            .collect();
        assert_eq!(rendered[0], "   9 + abcde");
        assert_eq!(rendered[1], "       f    ");
        assert_eq!(rendered[2], "1200 + ghijk");
        assert_eq!(rendered[3], "       l    ");
    }

    #[test]
    fn diff_mode_sidebar_hides_inline_diff_preview_like_bun() {
        let mut app = App {
            path: PathBuf::from("/tmp"),
            mode: LayoutMode::Mainline,
            view_mode: ViewMode::Log,
            active_leader_mode: None,
            sidebar_collapsed: false,
            files_expanded: true,
            desc_expanded: false,
            show_help: false,
            boxed_chrome: false,
            diff_scaffold: false,
            theme_picker_mode: false,
            theme_picker_index: 0,
            current_theme: "slate".to_string(),
            theme: UI_TOKENS,
            revset_mode: false,
            revset_value: String::new(),
            revset_query: String::new(),
            nodes: vec![],
            files_by_change: HashMap::new(),
            diffs_by_change: HashMap::new(),
            selected: 0,
            diff_scroll: 0,
            diff_file_index: 0,
        };
        assert!(sidebar_shows_inline_diff_preview(&app));
        app.view_mode = ViewMode::Diff;
        assert!(!sidebar_shows_inline_diff_preview(&app));
    }

    #[test]
    fn sidebar_diff_rows_share_larger_bun_line_number_gutter() {
        let rows = vec![
            DiffRow {
                kind: DiffRowKind::Add,
                file_index: 0,
                hunk_index: Some(0),
                old_line: None,
                new_line: Some(9),
                text: "+abcdef".to_string(),
            },
            DiffRow {
                kind: DiffRowKind::Add,
                file_index: 0,
                hunk_index: Some(0),
                old_line: None,
                new_line: Some(1200),
                text: "+ghijkl".to_string(),
            },
        ];
        let rendered: Vec<String> = render_diff_rows_with_gutter(&UI_TOKENS, &rows, 12)
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect()
            })
            .collect();
        assert_eq!(rendered[0], "   9 + ab...");
        assert_eq!(rendered[1], "1200 + gh...");
    }

    #[test]
    fn full_diff_pane_preserves_no_newline_marker_like_bun_diffview() {
        let diff = DiffPreview {
            raw_line_count: 7,
            file_count: 1,
            row_count: 5,
            preview_rows: vec![],
            full_rows: Some(vec![
                DiffRow {
                    kind: DiffRowKind::Metadata,
                    file_index: 0,
                    hunk_index: None,
                    old_line: None,
                    new_line: None,
                    text: "diff --git a/a b/a".to_string(),
                },
                DiffRow {
                    kind: DiffRowKind::Add,
                    file_index: 0,
                    hunk_index: Some(0),
                    old_line: None,
                    new_line: Some(1),
                    text: "+new".to_string(),
                },
                DiffRow {
                    kind: DiffRowKind::Metadata,
                    file_index: 0,
                    hunk_index: Some(0),
                    old_line: None,
                    new_line: None,
                    text: r"\ No newline at end of file".to_string(),
                },
            ]),
            parse_error: None,
        };

        let visible = diffview_rows_for_file(&diff, 0);
        assert_eq!(visible.len(), 2);
        assert_eq!(visible[1].text, r"\ No newline at end of file");
        assert!(!visible.iter().any(|row| row.text.contains("diff --git")));

        let rendered = render_full_diff_row(&UI_TOKENS, &visible[1], 40)
            .into_iter()
            .flat_map(|line| line.spans.into_iter())
            .map(|span| span.content.to_string())
            .collect::<String>();
        assert_eq!(rendered, r"      \ No newline at end of file       ");
        assert_eq!(rendered.chars().count(), 40);
    }

    #[test]
    fn diff_code_rows_match_bun_diffview_gutter_order_and_palette() {
        let add_bg = mix_color(UI_TOKENS.slate_bg0, UI_TOKENS.semantic_file_add, 0.48);
        let remove_bg = mix_color(UI_TOKENS.slate_bg0, UI_TOKENS.semantic_file_del, 0.48);
        assert_eq!(add_bg, Color::Rgb(25, 104, 58));
        assert_eq!(remove_bg, Color::Rgb(124, 43, 45));

        let add_row = DiffRow {
            kind: DiffRowKind::Add,
            file_index: 0,
            hunk_index: Some(0),
            old_line: None,
            new_line: Some(12),
            text: "+added".to_string(),
        };
        let line = render_diff_code_row(&UI_TOKENS, &add_row, 32);
        let rendered = line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(rendered.starts_with(" 12 + added"), "{rendered:?}");
        assert!(!rendered.contains("▌+"), "Bun DiffView uses line-number gutter signs, not a custom left mutation band: {rendered:?}");
        assert_eq!(line.spans[0].style.bg, Some(UI_TOKENS.slate_bg1));
        assert_eq!(line.spans[1].style.fg, Some(UI_TOKENS.semantic_file_add));
        assert_eq!(line.spans[2].style.bg, Some(add_bg));

        let remove_row = DiffRow {
            kind: DiffRowKind::Remove,
            file_index: 0,
            hunk_index: Some(0),
            old_line: Some(9),
            new_line: None,
            text: "-removed".to_string(),
        };
        let line = render_diff_code_row(&UI_TOKENS, &remove_row, 32);
        let rendered = line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(rendered.starts_with("  9 - removed"), "{rendered:?}");
        assert_eq!(line.spans[0].style.bg, Some(UI_TOKENS.slate_bg1));
        assert_eq!(line.spans[1].style.fg, Some(UI_TOKENS.semantic_file_del));
        assert_eq!(line.spans[2].style.bg, Some(remove_bg));
    }

    #[test]
    fn full_diff_code_rows_wrap_like_bun_char_mode() {
        let row = DiffRow {
            kind: DiffRowKind::Add,
            file_index: 0,
            hunk_index: Some(0),
            old_line: None,
            new_line: Some(4),
            text: "+abcdefghijklmnop".to_string(),
        };
        let lines = render_full_diff_row(&UI_TOKENS, &row, 12);
        let rendered: Vec<String> = lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect()
            })
            .collect();
        assert_eq!(
            rendered.len(),
            3,
            "Bun DiffView wraps long code rows instead of truncating: {rendered:?}"
        );
        assert_eq!(rendered[0], "  4 + abcdef");
        assert_eq!(rendered[1], "      ghijkl");
        assert_eq!(rendered[2], "      mnop  ");
    }

    #[test]
    fn full_diff_code_rows_wrap_with_large_bun_line_number_gutters() {
        let row = DiffRow {
            kind: DiffRowKind::Add,
            file_index: 0,
            hunk_index: Some(0),
            old_line: None,
            new_line: Some(1200),
            text: "+abcdefghijklmnop".to_string(),
        };
        let lines = render_full_diff_row(&UI_TOKENS, &row, 12);
        let rendered: Vec<String> = lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect()
            })
            .collect();
        assert_eq!(rendered[0], "1200 + abcde");
        assert_eq!(rendered[1], "       fghij");
        assert_eq!(rendered[2], "       klmno");
        assert_eq!(rendered[3], "       p    ");
        assert!(
            rendered.iter().all(|line| line.chars().count() == 12),
            "wrapped large-gutter rows must not overflow the pane width: {rendered:?}"
        );
    }

    #[test]
    fn diff_code_rows_fill_remaining_width_like_bun_diffview() {
        let add_bg = mix_color(UI_TOKENS.slate_bg0, UI_TOKENS.semantic_file_add, 0.48);
        let row = DiffRow {
            kind: DiffRowKind::Add,
            file_index: 0,
            hunk_index: Some(0),
            old_line: None,
            new_line: Some(3),
            text: "+short".to_string(),
        };
        let line = render_diff_code_row(&UI_TOKENS, &row, 24);
        let rendered = line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert_eq!(rendered.len(), 24);
        assert!(rendered.starts_with("  3 + short"), "{rendered:?}");
        assert!(line.spans[2].content.ends_with(' '));
        assert_eq!(line.spans[2].style.bg, Some(add_bg));
    }

    #[test]
    fn diff_code_rows_keep_readable_non_black_mutation_backgrounds() {
        let theme = UiTokens::named("catppuccin");
        let add_bg = mix_color(theme.slate_bg0, theme.semantic_file_add, 0.48);
        let remove_bg = mix_color(theme.slate_bg0, theme.semantic_file_del, 0.48);
        let add_row = DiffRow {
            kind: DiffRowKind::Add,
            file_index: 0,
            hunk_index: Some(0),
            old_line: None,
            new_line: Some(1),
            text: "+added".to_string(),
        };
        let line = render_diff_code_row(&theme, &add_row, 80);
        assert_eq!(line.spans[0].style.bg, Some(theme.slate_bg1));
        assert_eq!(line.spans[2].style.bg, Some(add_bg));
        assert_ne!(line.spans[2].style.bg, Some(theme.slate_bg0));
        assert_eq!(line.spans[2].style.fg, Some(theme.slate_text));

        let remove_row = DiffRow {
            kind: DiffRowKind::Remove,
            file_index: 0,
            hunk_index: Some(0),
            old_line: Some(1),
            new_line: None,
            text: "-removed".to_string(),
        };
        let line = render_diff_code_row(&theme, &remove_row, 80);
        assert_eq!(line.spans[0].style.bg, Some(theme.slate_bg1));
        assert_eq!(line.spans[2].style.bg, Some(remove_bg));
        assert_ne!(line.spans[2].style.bg, Some(theme.slate_bg0));
        assert_eq!(line.spans[2].style.fg, Some(theme.slate_text));
    }

    #[test]
    fn bundled_juzu_theme_names_match_repository_themes() {
        assert_eq!(theme_options().len(), 21);
        assert!(theme_options().contains(&"catppuccin"));
        assert!(theme_options().contains(&"tokyo-night"));
        assert_eq!(EMBEDDED_THEMES.len(), theme_options().len());
    }

    #[test]
    fn parses_bundled_catppuccin_theme_tokens() {
        let theme = UiTokens::named("catppuccin");
        assert_eq!(color_hex(theme.slate_bg0), "#1e1e2e");
        assert_eq!(color_hex(theme.semantic_info), "#89b4fa");
        assert_eq!(color_hex(theme.graph_lanes[0]), "#89b4fa");
        assert_eq!(color_hex(theme.graph_lanes[7]), "#89dceb");
    }

    #[test]
    fn unknown_theme_falls_back_to_slate_tokens() {
        let theme = UiTokens::named("definitely-not-real");
        assert_eq!(theme.slate_bg0, UI_TOKENS.slate_bg0);
        assert_eq!(theme.semantic_info, UI_TOKENS.semantic_info);
    }

    fn color_hex(color: Color) -> String {
        match color {
            Color::Rgb(r, g, b) => format!("#{r:02x}{g:02x}{b:02x}"),
            _ => "#000000".to_string(),
        }
    }
}

fn compact_home_path(path: &std::path::Path) -> String {
    let raw = path.display().to_string();
    let Some(home) = std::env::var_os("HOME") else {
        return raw;
    };
    let home = PathBuf::from(home);
    if let Ok(stripped) = path.strip_prefix(&home) {
        let suffix = stripped.display().to_string();
        if suffix.is_empty() {
            "~".to_string()
        } else {
            format!("~/{}", suffix)
        }
    } else {
        raw
    }
}

fn footer_line<'a>(
    t: &UiTokens,
    path: &std::path::Path,
    mode: LayoutMode,
    nodes: &[juzu_core::CommitNode],
    width: usize,
) -> Line<'a> {
    let repo = compact_home_path(path);
    let working_copy = nodes.iter().find(|node| node.is_working_copy);
    let bookmark = working_copy
        .and_then(|node| node.bookmarks.first())
        .cloned()
        .unwrap_or_default();
    let wc = working_copy
        .map(|node| format!(" @{}", node.change_id.chars().take(8).collect::<String>()))
        .unwrap_or_default();
    let mode = format!("{:?}", mode).to_lowercase();
    let repo_segment = format!(" {repo} ");
    let node_segment = format!(" {} nodes ", nodes.len());
    let fixed_width = repo_segment.chars().count()
        + bookmark.chars().count()
        + wc.chars().count()
        + mode.chars().count()
        + node_segment.chars().count();
    let spacer = width.saturating_sub(fixed_width);
    Line::from(vec![
        Span::styled(
            repo_segment,
            Style::default().fg(t.semantic_info).bg(t.slate_bg2),
        ),
        Span::styled(
            bookmark,
            Style::default().fg(t.semantic_info).bg(t.slate_panel),
        ),
        Span::styled(
            wc,
            Style::default().fg(t.semantic_success).bg(t.slate_panel),
        ),
        Span::styled(" ".repeat(spacer), Style::default().bg(t.slate_panel)),
        Span::styled(mode, Style::default().fg(t.slate_text).bg(t.slate_panel)),
        Span::styled(
            node_segment,
            Style::default().fg(t.semantic_success).bg(t.slate_bg2),
        ),
    ])
}

fn render_footer(frame: &mut Frame, area: Rect, app: &App) {
    let line = footer_line(
        &app.theme,
        &app.path,
        app.mode,
        &app.nodes,
        area.width as usize,
    );
    frame.render_widget(
        Paragraph::new(line).style(Style::default().bg(app.theme.slate_panel)),
        area,
    );
}
