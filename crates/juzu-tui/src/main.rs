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

struct App {
    path: PathBuf,
    mode: LayoutMode,
    view_mode: ViewMode,
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
        nodes,
        files_by_change,
        diffs_by_change,
        selected,
        diff_scroll: 0,
        diff_file_index: 0,
    };
    ensure_selected_diff(&mut app);

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
        toggle_diff_view(app);
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
            ensure_selected_diff(app);
        }
        KeyCode::Char('k') | KeyCode::Up => {
            app.selected = app.selected.saturating_sub(1);
            app.diff_scroll = 0;
            ensure_selected_diff(app);
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
        KeyCode::Char('1') => app.mode = LayoutMode::Chronological,
        KeyCode::Char('2') => app.mode = LayoutMode::Mainline,
        KeyCode::Char('3') => app.mode = LayoutMode::BookmarkCentric,
        KeyCode::Char('4') => app.mode = LayoutMode::WcFocused,
        KeyCode::Char('5') => app.mode = LayoutMode::Topological,
        _ => {}
    }
    false
}

fn parse_debug_key(raw: &str) -> Option<(KeyCode, KeyModifiers)> {
    match raw {
        "C-d" | "Ctrl+D" | "ctrl+d" => Some((KeyCode::Char('d'), KeyModifiers::CONTROL)),
        "Esc" | "Escape" => Some((KeyCode::Esc, KeyModifiers::NONE)),
        "PageDown" => Some((KeyCode::PageDown, KeyModifiers::NONE)),
        "PageUp" => Some((KeyCode::PageUp, KeyModifiers::NONE)),
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
    ensure_selected_diff(app);
    let selected = app.nodes.get(app.selected);
    let diff = selected_diff(app);
    let payload = serde_json::json!({
        "viewMode": match app.view_mode { ViewMode::Log => "Log", ViewMode::Diff => "Diff" },
        "layoutMode": format!("{:?}", app.mode),
        "selectedIndex": app.selected,
        "selectedChange": selected.map(|node| node.change_id.as_str()).unwrap_or(""),
        "selectedCommit": selected.map(|node| node.commit_id.as_str()).unwrap_or(""),
        "diffScroll": app.diff_scroll,
        "diffFileIndex": app.diff_file_index,
        "diffFileCount": diff.map(|preview| preview.file_count).unwrap_or(0),
        "diffRows": diff.map(|preview| preview.rows.len()).unwrap_or(0),
        "hasParseError": diff.and_then(|preview| preview.parse_error.as_ref()).is_some(),
    });
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Ok(())
}

fn ensure_selected_diff(app: &mut App) {
    let Some(node) = app.nodes.get(app.selected) else {
        return;
    };
    if app.diffs_by_change.contains_key(&node.change_id) {
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
            let rows = cap_diff_preview_rows(rows, DIFF_PREVIEW_ROW_CAP);
            DiffPreview {
                raw_line_count: diff.lines().count(),
                file_count: document.files.len(),
                row_count,
                rows,
                parse_error: None,
            }
        })
        .unwrap_or_else(|err| DiffPreview {
            raw_line_count: diff.lines().count(),
            file_count: 0,
            row_count: 0,
            rows: Vec::new(),
            parse_error: Some(err.to_string()),
        });
    app.diffs_by_change.insert(node.change_id.clone(), preview);
}

struct DiffPreview {
    raw_line_count: usize,
    file_count: usize,
    row_count: usize,
    rows: Vec<DiffRow>,
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
    ensure_selected_diff(app);
    app.view_mode = ViewMode::Diff;
    app.diff_scroll = 0;
    app.diff_file_index = 0;
}

fn cycle_diff_file(app: &mut App, dir: isize) {
    ensure_selected_diff(app);
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
    ensure_selected_diff(app);
    let Some(node) = app.nodes.get(app.selected) else {
        return;
    };
    let Some(diff) = app.diffs_by_change.get(&node.change_id) else {
        return;
    };
    if diff.rows.is_empty() {
        app.diff_scroll = 0;
        return;
    }
    let target = match jump {
        DiffJump::NextHunk => diff
            .rows
            .iter()
            .enumerate()
            .skip(app.diff_scroll.saturating_add(1))
            .find(|(_, row)| row.kind == DiffRowKind::HunkHeader)
            .map(|(idx, _)| idx),
        DiffJump::PreviousHunk => diff
            .rows
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
    render_header(frame, chunks[0], app, &layout);
    render_body(frame, chunks[1], app, &layout);
    render_footer(frame, chunks[2], app);
}

fn render_header(
    frame: &mut Frame,
    area: Rect,
    app: &App,
    layout: &juzu_core::layout::LayoutResult,
) {
    let title = Line::from(vec![
        Span::styled(
            " JUZU ",
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw("  Rust read-only graph  "),
        Span::styled(
            if app.view_mode == ViewMode::Diff {
                "DIFF".to_string()
            } else {
                format!("{:?}", app.mode)
            },
            Style::default().fg(Color::Yellow),
        ),
        Span::raw(format!(
            "  nodes:{} lanes:{} ",
            layout.nodes.len(),
            layout.max_lane + 1
        )),
        Span::styled(
            app.path.display().to_string(),
            Style::default().fg(Color::DarkGray),
        ),
    ]);
    frame.render_widget(
        Paragraph::new(title).block(Block::default().borders(Borders::BOTTOM)),
        area,
    );
}

fn render_body(frame: &mut Frame, area: Rect, app: &App, layout: &juzu_core::layout::LayoutResult) {
    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(60), Constraint::Percentage(40)])
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
    render_sidebar(frame, chunks[1], app, layout);
}

fn render_diff_pane(
    frame: &mut Frame,
    area: Rect,
    app: &App,
    layout: &juzu_core::layout::LayoutResult,
) {
    let selected = app.selected.min(layout.nodes.len().saturating_sub(1));
    let Some(node) = layout.nodes.get(selected) else {
        return;
    };
    let block = Block::default().borders(Borders::NONE);
    let width = area.width as usize;
    let height = area.height as usize;
    let mut lines = Vec::new();
    let diff = selected_diff(app);
    let title = diff
        .and_then(|preview| diff_file_title(preview, app.diff_file_index, width))
        .unwrap_or_else(|| "Diff".to_string());
    lines.push(Line::from(Span::styled(
        title,
        Style::default().fg(Color::DarkGray),
    )));
    if let Some(diff) = diff {
        if let Some(error) = &diff.parse_error {
            lines.push(Line::from(Span::styled(
                truncate(error, width),
                Style::default().fg(Color::Red),
            )));
        } else if diff.rows.is_empty() {
            lines.push(render_diff_metadata(
                "No diff available for selected change",
                width,
            ));
        } else {
            let rows = rows_for_diff_file(diff, app.diff_file_index);
            let visible_count = height.saturating_sub(lines.len() + 2).max(1);
            let max_scroll = rows.len().saturating_sub(visible_count);
            let scroll = app.diff_scroll.min(max_scroll);
            let end = (scroll + visible_count).min(rows.len());
            lines.push(render_diff_scroll_range(scroll, end, rows.len(), width));
            if let Some(anchor) = render_diff_anchor_label(&rows, scroll, width) {
                lines.push(anchor);
            }
            for row in rows.iter().skip(scroll).take(visible_count) {
                lines.push(render_diff_row(row, width));
            }
        }
    } else {
        lines.push(render_diff_metadata(
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
    let path = diff
        .rows
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

fn rows_for_diff_file(diff: &DiffPreview, file_index: usize) -> Vec<DiffRow> {
    if diff.file_count == 0 {
        return diff.rows.clone();
    }
    let index = file_index.min(diff.file_count.saturating_sub(1));
    diff.rows
        .iter()
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
    let block = Block::default().title(" dag graph ").borders(Borders::ALL);
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
                put_cell(&mut cells, x, *y, '─', lane_color(0));
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
        let child_color = lane_color(child_lane);

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
            let parent_color = lane_color(parent_lane);
            let connection_selected = child_idx == selected || parent_idx == selected;
            let line_color = if connection_selected {
                Color::White
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
                    Color::White
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
                    Color::White
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
        let color = lane_color(lane);
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
            Color::White
        } else if node.is_working_copy {
            Color::Green
        } else if node.is_conflict {
            Color::Red
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
                Color::Green,
            );
            put_text(&mut cells, indicator_x, y, ">", Color::White);
        } else if node.is_working_copy {
            put_text(&mut cells, indicator_x, y, "@", Color::Green);
        } else if is_selected {
            put_text(&mut cells, indicator_x, y, ">", Color::White);
        }
        put_text(
            &mut cells,
            text_x,
            y,
            &change_short,
            if is_selected { Color::White } else { color },
        );
        put_text(
            &mut cells,
            text_x + 9,
            y,
            &commit_short,
            if is_selected {
                Color::White
            } else {
                Color::DarkGray
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
                Color::White
            } else {
                Color::Gray
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
                    Color::LightYellow
                } else {
                    Color::Yellow
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
                Color::DarkGray
            } else if is_selected {
                Color::LightBlue
            } else {
                Color::Blue
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
            fg: Color::Gray,
        }
    }
}

fn lane_color(lane: usize) -> Color {
    const COLORS: [Color; 8] = [
        Color::Cyan,
        Color::Magenta,
        Color::Yellow,
        Color::Green,
        Color::Blue,
        Color::LightRed,
        Color::LightCyan,
        Color::LightMagenta,
    ];
    COLORS[lane % COLORS.len()]
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

fn file_type_color(file_type: &str) -> Color {
    match file_type {
        "A" => Color::Green,
        "D" => Color::Red,
        "M" => Color::Yellow,
        "R" => Color::Magenta,
        _ => Color::Gray,
    }
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

fn render_sidebar(
    frame: &mut Frame,
    area: Rect,
    app: &App,
    layout: &juzu_core::layout::LayoutResult,
) {
    let selected = app.selected.min(layout.nodes.len().saturating_sub(1));
    let Some(node) = layout.nodes.get(selected) else {
        return;
    };
    let lines = vec![
        Line::from(Span::styled(
            "Selected",
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )),
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
        Line::from(Span::styled(
            "Bookmarks",
            Style::default().fg(Color::Yellow),
        )),
        Line::from(if node.bookmarks.is_empty() {
            "—".to_string()
        } else {
            node.bookmarks.join(", ")
        }),
        Line::from(""),
        Line::from(Span::styled("Title", Style::default().fg(Color::Yellow))),
        Line::from(node.description_title.clone()),
        Line::from(""),
        Line::from(Span::styled("Files", Style::default().fg(Color::Yellow))),
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
            .is_some_and(|diff| !diff.rows.is_empty());
        let file_preview_limit = if diff_is_available { 4 } else { 12 };
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
                    Style::default()
                        .fg(Color::LightCyan)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("{} ", file.r#type),
                    Style::default().fg(file_type_color(&file.r#type)),
                ),
                Span::styled(
                    file.path.clone(),
                    if is_selected_diff_file {
                        Style::default()
                            .fg(Color::White)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default()
                    },
                ),
            ]));
        }
        if files.len() > file_end {
            lines.push(Line::from(format!("… {} more", files.len() - file_end)));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "Diff",
        Style::default()
            .fg(Color::Yellow)
            .add_modifier(Modifier::BOLD),
    )));
    render_diff_preview_lines(&mut lines, app, node, area.width as usize, 14);
    frame.render_widget(
        Paragraph::new(lines).block(Block::default().title(" details ").borders(Borders::ALL)),
        area,
    );
}

fn render_diff_preview_lines(
    lines: &mut Vec<Line<'static>>,
    app: &App,
    node: &juzu_core::CommitNode,
    sidebar_width: usize,
    visible_count: usize,
) {
    let Some(diff) = app.diffs_by_change.get(&node.change_id) else {
        lines.push(Line::from(Span::styled(
            "  waiting for native diff",
            Style::default().fg(Color::DarkGray),
        )));
        return;
    };

    lines.push(render_diff_metadata(
        &format!(
            "{} files · {} raw · {} rows · {} shown",
            diff.file_count,
            diff.raw_line_count,
            diff.row_count,
            diff.rows.len()
        ),
        sidebar_width.saturating_sub(4),
    ));
    if let Some(error) = &diff.parse_error {
        lines.push(Line::from(Span::styled(
            truncate(error, sidebar_width.saturating_sub(4)),
            Style::default().fg(Color::Red),
        )));
        return;
    }
    if diff.rows.is_empty() {
        lines.push(render_diff_metadata(
            "clean patch",
            sidebar_width.saturating_sub(4),
        ));
        return;
    }

    let max_scroll = diff.rows.len().saturating_sub(visible_count);
    let scroll = app.diff_scroll.min(max_scroll);
    let end = (scroll + visible_count).min(diff.rows.len());
    lines.push(render_diff_scroll_range(
        scroll,
        end,
        diff.rows.len(),
        sidebar_width.saturating_sub(4),
    ));
    if let Some(anchor) =
        render_diff_anchor_label(&diff.rows, scroll, sidebar_width.saturating_sub(4))
    {
        lines.push(anchor);
    }
    for row in diff.rows.iter().skip(scroll).take(visible_count) {
        lines.push(render_diff_row(row, sidebar_width.saturating_sub(4)));
    }
    if diff.rows.len() > end {
        lines.push(render_diff_collapse_row(
            &format!("{} more rows below", diff.rows.len() - end),
            sidebar_width.saturating_sub(4),
        ));
    }
}

fn render_diff_row(row: &DiffRow, max_len: usize) -> Line<'static> {
    match row.kind {
        DiffRowKind::FileHeader => render_diff_file_header(row, max_len),
        DiffRowKind::Metadata => render_diff_metadata(&row.text, max_len),
        DiffRowKind::HunkHeader => render_diff_hunk_header(row, max_len),
        DiffRowKind::Context | DiffRowKind::Add | DiffRowKind::Remove => {
            render_diff_code_row(row, max_len)
        }
        DiffRowKind::Collapse => render_diff_collapse_row(&row.text, max_len),
    }
}

fn render_diff_file_header(row: &DiffRow, max_len: usize) -> Line<'static> {
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

fn render_diff_metadata(text: &str, max_len: usize) -> Line<'static> {
    Line::from(vec![
        Span::styled("  · ", Style::default().fg(Color::DarkGray)),
        Span::styled(
            truncate(text, max_len.saturating_sub(4)),
            Style::default().fg(Color::DarkGray),
        ),
    ])
}

fn render_diff_hunk_header(row: &DiffRow, max_len: usize) -> Line<'static> {
    let text = truncate(&row.text, max_len.saturating_sub(4));
    Line::from(vec![
        Span::styled(
            "╭─ ",
            Style::default()
                .fg(Color::LightMagenta)
                .bg(Color::Rgb(30, 27, 75)),
        ),
        Span::styled(
            format!("{:<width$}", text, width = max_len.saturating_sub(4)),
            Style::default()
                .fg(Color::LightBlue)
                .bg(Color::Rgb(30, 27, 75))
                .add_modifier(Modifier::BOLD),
        ),
    ])
}

fn render_diff_code_row(row: &DiffRow, max_len: usize) -> Line<'static> {
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
    let (gutter_style, sign_style, text_style) = match row.kind {
        DiffRowKind::Add => (
            Style::default()
                .fg(Color::Rgb(134, 239, 172))
                .bg(Color::Rgb(5, 46, 22)),
            Style::default()
                .fg(Color::Rgb(187, 247, 208))
                .bg(Color::Rgb(20, 83, 45))
                .add_modifier(Modifier::BOLD),
            Style::default()
                .fg(Color::Rgb(187, 247, 208))
                .bg(Color::Rgb(5, 46, 22)),
        ),
        DiffRowKind::Remove => (
            Style::default()
                .fg(Color::Rgb(252, 165, 165))
                .bg(Color::Rgb(69, 10, 10)),
            Style::default()
                .fg(Color::Rgb(254, 202, 202))
                .bg(Color::Rgb(127, 29, 29))
                .add_modifier(Modifier::BOLD),
            Style::default()
                .fg(Color::Rgb(254, 202, 202))
                .bg(Color::Rgb(69, 10, 10)),
        ),
        _ => (
            Style::default().fg(Color::DarkGray),
            Style::default().fg(Color::DarkGray),
            Style::default().fg(Color::Gray).add_modifier(Modifier::DIM),
        ),
    };
    let text_budget = max_len.saturating_sub(gutter.len() + 3);
    let content = row.text.strip_prefix(['+', '-', ' ']).unwrap_or(&row.text);
    Line::from(vec![
        Span::styled(gutter, gutter_style),
        Span::styled(" ", Style::default().fg(Color::DarkGray)),
        Span::styled(sign.to_string(), sign_style),
        Span::styled(truncate(content, text_budget), text_style),
    ])
}

fn render_diff_collapse_row(text: &str, max_len: usize) -> Line<'static> {
    let label = format!(" ⋯ {} ", text.trim_start_matches('⋯').trim());
    let clipped = truncate(&label, max_len);
    let left = max_len.saturating_sub(clipped.len()) / 2;
    let right = max_len.saturating_sub(clipped.len() + left);
    Line::from(vec![
        Span::styled("─".repeat(left), Style::default().fg(Color::DarkGray)),
        Span::styled(
            clipped,
            Style::default().fg(Color::Yellow).bg(Color::Rgb(66, 32, 6)),
        ),
        Span::styled("─".repeat(right), Style::default().fg(Color::DarkGray)),
    ])
}

fn render_diff_scroll_range(
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
    render_diff_metadata(&truncate(&label, max_len), max_len)
}

fn render_diff_anchor_label(
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
        (Some(file), Some(hunk)) => format!("pinned {file} · {hunk}"),
        (Some(file), None) => format!("pinned {file}"),
        (None, Some(hunk)) => format!("pinned {hunk}"),
        (None, None) => return None,
    };
    Some(Line::from(vec![
        Span::styled("  ◌ ", Style::default().fg(Color::LightMagenta)),
        Span::styled(
            truncate(&label, max_len.saturating_sub(4)),
            Style::default()
                .fg(Color::LightBlue)
                .add_modifier(Modifier::DIM),
        ),
    ]))
}

fn render_footer(frame: &mut Frame, area: Rect, app: &App) {
    let line = if app.view_mode == ViewMode::Diff {
        Line::from(vec![
            Span::styled(
                " DIFF ",
                Style::default().fg(Color::Black).bg(Color::Yellow),
            ),
            Span::raw("  "),
            Span::styled(" ^d ", Style::default().fg(Color::Black).bg(Color::Gray)),
            Span::raw(" Log   "),
            Span::styled(" [ ] ", Style::default().fg(Color::Black).bg(Color::Gray)),
            Span::raw(" File   "),
            Span::styled(" j/k ", Style::default().fg(Color::Black).bg(Color::Gray)),
            Span::raw(" Move   "),
            Span::styled(" Esc ", Style::default().fg(Color::Black).bg(Color::Gray)),
            Span::raw(" Exit"),
        ])
    } else {
        Line::from(vec![
            Span::styled(" q/esc ", Style::default().fg(Color::Black).bg(Color::Gray)),
            Span::raw(" quit   "),
            Span::styled(" j/k ", Style::default().fg(Color::Black).bg(Color::Gray)),
            Span::raw(" select   "),
            Span::styled(" 1-5 ", Style::default().fg(Color::Black).bg(Color::Gray)),
            Span::raw(" layout modes   "),
            Span::styled(" [/] ", Style::default().fg(Color::Black).bg(Color::Gray)),
            Span::raw(" diff scroll   "),
            Span::styled(" {/} ", Style::default().fg(Color::Black).bg(Color::Gray)),
            Span::raw(" hunk jump"),
        ])
    };
    frame.render_widget(
        Paragraph::new(line).block(Block::default().borders(Borders::TOP)),
        area,
    );
}
