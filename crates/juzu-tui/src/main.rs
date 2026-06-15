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
            ("semantic", "fileAdd") => self.graph_file_add = color,
            ("semantic", "fileMod") => self.graph_file_mod = color,
            ("semantic", "fileDel") => self.graph_file_del = color,
            ("graph", "text") => self.graph_text_muted = color,
            ("graph", "textDesc") => self.graph_text_desc = color,
            ("graph", "nodeBorder") => self.graph_commit_id = color,
            ("graph", "bookmark") => self.graph_bookmark = color,
            ("graph", "bookmarkSelected") => self.graph_bookmark_selected = color,
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
        .unwrap_or(50);
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
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(8),
            Constraint::Length(3),
        ])
        .split(frame.area());
    render_status_bar(frame, chunks[0], app);
    render_body(frame, chunks[1], app, &layout);
    render_footer(frame, chunks[2], app);
}

fn render_status_bar(frame: &mut Frame, area: Rect, app: &App) {
    let t = &app.theme;
    let item_style = Style::default().bg(t.slate_bg2).fg(t.slate_text);
    let key_style = Style::default().fg(t.semantic_info);
    let mode_style = Style::default()
        .fg(t.slate_bg0)
        .bg(t.semantic_mode_log)
        .add_modifier(Modifier::BOLD);
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
        vec![Line::from(vec![
            Span::styled(" DIFF ", mode_style),
            Span::raw("  "),
            Span::styled("^d", key_style),
            Span::styled(" Log ", item_style),
            Span::raw(" "),
            Span::styled("[ ]", key_style),
            Span::styled(" File ", item_style),
            Span::raw(" "),
            Span::styled("j/k", key_style),
            Span::styled(" Move ", item_style),
            Span::raw(" "),
            Span::styled("{/}", key_style),
            Span::styled(" Hunk ", item_style),
            Span::raw(" "),
            Span::styled("Esc", key_style),
            Span::styled(" Exit ", item_style),
        ])]
    } else if let Some(leader) = app.active_leader_mode {
        let active_mode_style = Style::default()
            .fg(t.slate_bg0)
            .bg(leader_mode_color(leader, t))
            .add_modifier(Modifier::BOLD);
        match leader {
            LeaderMode::View => vec![
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
                Line::from(vec![
                    Span::styled("Esc/q", key_style),
                    Span::styled(" Exit ", item_style),
                ]),
            ],
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
            Span::styled(" Act ", item_style),
            Span::raw(" "),
            Span::styled("^O", key_style),
            Span::styled(" Ops ", item_style),
            Span::raw(" "),
            Span::styled("^L", key_style),
            Span::styled(" View ", item_style),
            Span::raw(" "),
            Span::styled("^B", key_style),
            Span::styled(" Book ", item_style),
        ])]
    };
    frame.render_widget(
        Paragraph::new(lines).style(Style::default().bg(t.slate_panel)),
        area,
    );
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
        .title(" diff ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(t.slate_border_strong))
        .style(Style::default().bg(t.slate_bg0));
    let width = area.width.saturating_sub(2) as usize;
    let height = area.height.saturating_sub(2) as usize;
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
            let rows = rows_for_diff_file(diff, app.diff_file_index);
            let visible_count = height.saturating_sub(lines.len() + 2).max(1);
            let max_scroll = rows.len().saturating_sub(visible_count);
            let scroll = app.diff_scroll.min(max_scroll);
            let end = (scroll + visible_count).min(rows.len());
            lines.push(render_diff_viewport_bar(t, scroll, end, rows.len(), width));
            if let Some(anchor) = render_diff_anchor_label(t, &rows, scroll, width) {
                lines.push(anchor);
            }
            for row in rows.iter().skip(scroll).take(visible_count) {
                lines.push(render_diff_row(t, row, width));
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

fn render_graph_table(
    frame: &mut Frame,
    area: Rect,
    app: &App,
    layout: &juzu_core::layout::LayoutResult,
) {
    let t = &app.theme;
    let block = Block::default()
        .title(" dag graph ")
        .borders(Borders::ALL)
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
            if is_selected { t.slate_text } else { color },
        );
        put_text(
            &mut cells,
            text_x + 9,
            y,
            &commit_short,
            if is_selected {
                t.slate_text
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
                t.slate_text
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
        let file_summary = format_file_summary(files, width.saturating_sub(text_x + 1));
        put_text(
            &mut cells,
            text_x,
            y + 2,
            &file_summary,
            if files.is_empty() {
                t.graph_text_muted
            } else if is_selected {
                t.semantic_info
            } else {
                t.graph_text_muted
            },
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

fn sidebar_heading_style(tokens: &UiTokens) -> Style {
    Style::default()
        .fg(tokens.semantic_info)
        .add_modifier(Modifier::BOLD)
}

fn sidebar_muted_style(tokens: &UiTokens) -> Style {
    Style::default().fg(tokens.slate_text_muted)
}

fn sidebar_selected_text_style(tokens: &UiTokens) -> Style {
    Style::default()
        .fg(tokens.slate_text)
        .add_modifier(Modifier::BOLD)
}

fn format_file_summary(files: &[FileEntry], max_len: usize) -> String {
    if files.is_empty() {
        return "no file changes".to_string();
    }
    let parts = files
        .iter()
        .take(3)
        .map(|file| format!("{} {}", file.r#type, file.path))
        .collect::<Vec<_>>();
    let mut summary = parts.join("  ");
    if files.len() > 3 {
        summary.push_str(&format!("  +{}", files.len() - 3));
    }
    truncate(&summary, max_len)
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
        for (index, theme) in theme_options().iter().enumerate() {
            let cursor = if index == app.theme_picker_index {
                ">"
            } else {
                " "
            };
            let current = if *theme == app.current_theme {
                " *"
            } else {
                ""
            };
            let style = if index == app.theme_picker_index {
                Style::default()
                    .fg(t.semantic_success)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(t.slate_text)
            };
            lines.push(Line::from(Span::styled(
                format!("{cursor} {theme}{current}"),
                style,
            )));
        }
        lines.extend([
            Line::from(""),
            Line::from("j/k or ↑/↓: select"),
            Line::from("Enter: apply"),
            Line::from("Esc: cancel"),
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
    let lines = vec![
        Line::from(Span::styled("Selected", sidebar_heading_style(t))),
        Line::from(format!("Change: {}", node.change_id)),
        Line::from(format!(
            "Commit: {}",
            node.commit_id.chars().take(12).collect::<String>()
        )),
        Line::from(format!(
            "Lane: {:?}  X: {:?}  Y: {:?}",
            node.lane, node.x, node.y
        )),
        Line::from(format!("Author: {}", node.author)),
        Line::from(format!("Time: {}", node.time)),
        Line::from(""),
        Line::from(Span::styled("Bookmarks", sidebar_heading_style(t))),
        Line::from(if node.bookmarks.is_empty() {
            "—".to_string()
        } else {
            node.bookmarks.join(", ")
        }),
        Line::from(""),
        Line::from(Span::styled(
            if app.desc_expanded {
                "Description:"
            } else {
                "Description (x expand):"
            },
            sidebar_heading_style(t),
        )),
        Line::from(if app.desc_expanded {
            node.description_full.clone()
        } else {
            node.description_title.clone()
        }),
        Line::from(""),
        Line::from(Span::styled(
            if app.files_expanded {
                "Files (f collapse):"
            } else {
                "Files (f expand):"
            },
            sidebar_heading_style(t),
        )),
    ];
    let mut lines = lines;
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
            lines.push(Line::from(vec![
                Span::styled(
                    if is_selected_diff_file { "▶ " } else { "  " },
                    sidebar_heading_style(t),
                ),
                Span::styled(
                    format!("{} ", file.r#type),
                    Style::default().fg(file_type_color(&app.theme, &file.r#type)),
                ),
                Span::styled(
                    file.path.clone(),
                    if is_selected_diff_file {
                        sidebar_selected_text_style(t)
                    } else {
                        Style::default().fg(t.slate_text)
                    },
                ),
            ]));
        }
        if files.len() > file_end {
            lines.push(Line::from(format!("… {} more", files.len() - file_end)));
        }
    }
    lines.push(Line::from(""));
    if app.view_mode == ViewMode::Diff {
        lines.push(Line::from(vec![
            Span::styled("Current file preview", sidebar_heading_style(t)),
            Span::styled("  secondary", sidebar_muted_style(t)),
        ]));
    } else {
        lines.push(Line::from(Span::styled("Diff", sidebar_heading_style(t))));
    }
    render_diff_preview_lines(&mut lines, app, node, area.width as usize, 14, t);
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().fg(t.slate_text).bg(t.slate_panel))
            .block(
                Block::default()
                    .title(" details ")
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(t.slate_border_soft))
                    .style(Style::default().bg(t.slate_panel)),
            ),
        area,
    );
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
    for row in active_rows.iter().skip(scroll).take(visible_count) {
        lines.push(render_diff_row(t, row, sidebar_width.saturating_sub(4)));
    }
    if active_rows.len() > end {
        lines.push(render_diff_collapse_row(
            t,
            &format!("{} more rows below", active_rows.len() - end),
            sidebar_width.saturating_sub(4),
        ));
    }
}

fn render_diff_row(tokens: &UiTokens, row: &DiffRow, max_len: usize) -> Line<'static> {
    match row.kind {
        DiffRowKind::FileHeader => render_diff_file_header(tokens, row, max_len),
        DiffRowKind::Metadata => render_diff_metadata(tokens, &row.text, max_len),
        DiffRowKind::HunkHeader => render_diff_hunk_header(tokens, row, max_len),
        DiffRowKind::Context | DiffRowKind::Add | DiffRowKind::Remove => {
            render_diff_code_row(tokens, row, max_len)
        }
        DiffRowKind::Collapse => render_diff_collapse_row(tokens, &row.text, max_len),
    }
}

fn render_diff_file_header(tokens: &UiTokens, row: &DiffRow, max_len: usize) -> Line<'static> {
    let text = truncate(&format!("◆ {}", row.text), max_len.saturating_sub(2));
    let cap_style = Style::default()
        .fg(tokens.semantic_info)
        .bg(tokens.slate_bg2);
    Line::from(vec![
        Span::styled("╭", cap_style),
        Span::styled(
            format!(" {:<width$}", text, width = max_len.saturating_sub(2)),
            Style::default()
                .fg(tokens.semantic_info)
                .bg(tokens.slate_bg2)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("╮", cap_style),
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

fn render_diff_hunk_header(tokens: &UiTokens, row: &DiffRow, max_len: usize) -> Line<'static> {
    let text = truncate(&row.text, max_len.saturating_sub(5));
    let cap_style = Style::default()
        .fg(tokens.semantic_warn)
        .bg(tokens.slate_bg2);
    Line::from(vec![
        Span::styled("╭─ ", cap_style),
        Span::styled(
            format!("{:<width$}", text, width = max_len.saturating_sub(5)),
            Style::default()
                .fg(tokens.semantic_info)
                .bg(tokens.slate_bg2)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(" ╮", cap_style),
    ])
}

fn render_diff_code_row(tokens: &UiTokens, row: &DiffRow, max_len: usize) -> Line<'static> {
    let old_line = row
        .old_line
        .map(|value| value.to_string())
        .unwrap_or_else(|| " ".to_string());
    let new_line = row
        .new_line
        .map(|value| value.to_string())
        .unwrap_or_else(|| " ".to_string());
    let gutter = format!("{old_line:>4} {new_line:>4}");
    let sign = match row.kind {
        DiffRowKind::Add => "+",
        DiffRowKind::Remove => "-",
        _ => " ",
    };
    let band = match row.kind {
        DiffRowKind::Add | DiffRowKind::Remove => "▌",
        _ => "│",
    };
    let (gutter_style, band_style, sign_style, text_style) = match row.kind {
        DiffRowKind::Add => (
            Style::default()
                .fg(tokens.semantic_success)
                .bg(tokens.slate_bg0),
            Style::default()
                .fg(tokens.semantic_success)
                .bg(tokens.slate_bg0)
                .add_modifier(Modifier::BOLD),
            Style::default()
                .fg(tokens.slate_bg0)
                .bg(tokens.semantic_success)
                .add_modifier(Modifier::BOLD),
            Style::default()
                .fg(tokens.semantic_success)
                .bg(tokens.slate_bg0),
        ),
        DiffRowKind::Remove => (
            Style::default()
                .fg(tokens.semantic_error)
                .bg(tokens.slate_bg0),
            Style::default()
                .fg(tokens.semantic_error)
                .bg(tokens.slate_bg0)
                .add_modifier(Modifier::BOLD),
            Style::default()
                .fg(tokens.slate_bg0)
                .bg(tokens.semantic_error)
                .add_modifier(Modifier::BOLD),
            Style::default()
                .fg(tokens.semantic_error)
                .bg(tokens.slate_bg0),
        ),
        _ => (
            sidebar_muted_style(tokens),
            sidebar_muted_style(tokens),
            sidebar_muted_style(tokens),
            Style::default()
                .fg(tokens.slate_text_muted)
                .bg(tokens.slate_bg0)
                .add_modifier(Modifier::DIM),
        ),
    };
    let text_budget = max_len.saturating_sub(gutter.len() + 5);
    let content = row.text.strip_prefix(['+', '-', ' ']).unwrap_or(&row.text);
    Line::from(vec![
        Span::styled(band, band_style),
        Span::styled(sign.to_string(), sign_style),
        Span::styled(" ", sidebar_muted_style(tokens)),
        Span::styled(gutter, gutter_style),
        Span::styled(" ", sidebar_muted_style(tokens)),
        Span::styled(truncate(content, text_budget), text_style),
    ])
}

fn render_diff_collapse_row(tokens: &UiTokens, text: &str, max_len: usize) -> Line<'static> {
    let label = format!(" ⋯ {} ", text.trim_start_matches('⋯').trim());
    let clipped = truncate(&label, max_len);
    let left = max_len.saturating_sub(clipped.len()) / 2;
    let right = max_len.saturating_sub(clipped.len() + left);
    Line::from(vec![
        Span::styled("─".repeat(left), sidebar_muted_style(tokens)),
        Span::styled(
            clipped,
            Style::default()
                .fg(tokens.semantic_warn)
                .bg(tokens.slate_bg2),
        ),
        Span::styled("─".repeat(right), sidebar_muted_style(tokens)),
    ])
}

fn render_diff_viewport_bar(
    tokens: &UiTokens,
    scroll: usize,
    end: usize,
    total: usize,
    max_len: usize,
) -> Line<'static> {
    let range = if total == 0 {
        "diff rows 0/0".to_string()
    } else {
        format!("diff rows {}-{} of {}", scroll + 1, end, total)
    };
    let handle = render_scroll_handle(scroll, end, total, 10);
    let label = format!("VIEWPORT {range}   SCROLL {handle}");
    let clipped = truncate(&label, max_len.saturating_sub(2));
    Line::from(vec![Span::styled(
        format!(" {:<width$}", clipped, width = max_len.saturating_sub(1)),
        Style::default()
            .fg(tokens.slate_text)
            .bg(tokens.slate_bg2)
            .add_modifier(Modifier::BOLD),
    )])
}

fn render_scroll_handle(scroll: usize, end: usize, total: usize, slots: usize) -> String {
    if total <= 1 || slots == 0 {
        return "█".repeat(slots.max(1));
    }
    let visible = end.saturating_sub(scroll).max(1);
    let handle_len = ((visible * slots) / total).clamp(1, slots);
    let max_start = slots.saturating_sub(handle_len);
    let start = if total <= visible {
        0
    } else {
        (scroll * max_start) / total.saturating_sub(visible).max(1)
    };
    let mut out = String::with_capacity(slots + 2);
    out.push('[');
    for idx in 0..slots {
        if idx >= start && idx < start + handle_len {
            out.push('█');
        } else {
            out.push('░');
        }
    }
    out.push(']');
    out
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
    fn compact_home_path_matches_old_footer_bar() {
        let home = std::env::var("HOME").expect("HOME is set in parity environment");
        let path = PathBuf::from(format!("{home}/dev/juzu"));
        assert_eq!(compact_home_path(&path), "~/dev/juzu");
    }

    #[test]
    fn diff_viewport_bar_uses_old_panel_tokens() {
        let line = render_diff_viewport_bar(&UI_TOKENS, 0, 10, 40, 80);
        for span in &line.spans {
            assert_eq!(span.style.bg, Some(UI_TOKENS.slate_bg2));
        }
    }

    #[test]
    fn diff_renderer_styles_use_active_theme_tokens() {
        let theme = UiTokens::named("catppuccin");
        let viewport = render_diff_viewport_bar(&theme, 0, 10, 40, 80);
        assert_eq!(
            viewport.spans[0].style.bg,
            Some(Color::Rgb(0x31, 0x32, 0x44))
        );
        assert_eq!(
            viewport.spans[0].style.fg,
            Some(Color::Rgb(0xcd, 0xd6, 0xf4))
        );

        let add_row = DiffRow {
            kind: DiffRowKind::Add,
            file_index: 0,
            hunk_index: Some(0),
            old_line: None,
            new_line: Some(1),
            text: "+added".to_string(),
        };
        let line = render_diff_code_row(&theme, &add_row, 80);
        assert_eq!(line.spans[0].style.fg, Some(Color::Rgb(0xa6, 0xe3, 0xa1)));
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

fn render_footer(frame: &mut Frame, area: Rect, app: &App) {
    let t = &app.theme;
    let repo = compact_home_path(&app.path);
    let working_copy = app.nodes.iter().find(|node| node.is_working_copy);
    let wc = working_copy
        .map(|node| format!(" @{}", node.change_id.chars().take(8).collect::<String>()))
        .unwrap_or_default();
    let bookmark = working_copy
        .and_then(|node| node.bookmarks.first())
        .map(|bookmark| format!(" {bookmark}"))
        .unwrap_or_default();
    let mode = format!("{:?}", app.mode).to_lowercase();
    let right = format!(" {mode}  {} nodes ", app.nodes.len());
    let width = area.width as usize;
    let left_text = format!(" {repo}{bookmark}{wc}");
    let spacer = width.saturating_sub(left_text.chars().count() + right.chars().count());
    let line = Line::from(vec![
        Span::styled(
            left_text,
            Style::default().fg(t.semantic_info).bg(t.slate_bg2),
        ),
        Span::styled(" ".repeat(spacer), Style::default().bg(t.slate_panel)),
        Span::styled(
            right,
            Style::default().fg(t.semantic_success).bg(t.slate_bg2),
        ),
    ]);
    frame.render_widget(
        Paragraph::new(line).style(Style::default().bg(t.slate_panel)),
        area,
    );
}
