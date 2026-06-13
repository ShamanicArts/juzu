use anyhow::Result;
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use juzu_core::{
    layout::calculate_default_layout, ChangeQuery, FileEntry, JjBackend, LayoutMode, LogQuery,
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

struct App {
    path: PathBuf,
    mode: LayoutMode,
    nodes: Vec<juzu_core::CommitNode>,
    files_by_change: HashMap<String, Vec<FileEntry>>,
    diffs_by_change: HashMap<String, String>,
    selected: usize,
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
    let selected = nodes
        .iter()
        .position(|node| node.is_working_copy)
        .unwrap_or(0);
    let mut app = App {
        path,
        mode,
        nodes,
        files_by_change,
        diffs_by_change,
        selected,
    };
    ensure_selected_diff(&mut app);

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
                match key.code {
                    KeyCode::Char('q') | KeyCode::Esc => break,
                    KeyCode::Char('j') | KeyCode::Down => {
                        app.selected = (app.selected + 1).min(app.nodes.len().saturating_sub(1));
                        ensure_selected_diff(app);
                    }
                    KeyCode::Char('k') | KeyCode::Up => {
                        app.selected = app.selected.saturating_sub(1);
                        ensure_selected_diff(app);
                    }
                    KeyCode::Char('1') => app.mode = LayoutMode::Chronological,
                    KeyCode::Char('2') => app.mode = LayoutMode::Mainline,
                    KeyCode::Char('3') => app.mode = LayoutMode::BookmarkCentric,
                    KeyCode::Char('4') => app.mode = LayoutMode::WcFocused,
                    KeyCode::Char('5') => app.mode = LayoutMode::Topological,
                    _ => {}
                }
            }
        }
    }
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
    app.diffs_by_change.insert(node.change_id.clone(), diff);
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
    render_footer(frame, chunks[2]);
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
            format!("{:?}", app.mode),
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
        .constraints([Constraint::Percentage(72), Constraint::Percentage(28)])
        .split(area);
    render_graph_table(frame, chunks[0], app, layout);
    render_sidebar(frame, chunks[1], app, layout);
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
        for file in files.iter().take(12) {
            lines.push(Line::from(vec![
                Span::styled(
                    format!("{} ", file.r#type),
                    Style::default().fg(file_type_color(&file.r#type)),
                ),
                Span::raw(file.path.clone()),
            ]));
        }
        if files.len() > 12 {
            lines.push(Line::from(format!("… {} more", files.len() - 12)));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "Diff",
        Style::default().fg(Color::Yellow),
    )));
    let diff = app
        .diffs_by_change
        .get(&node.change_id)
        .map(String::as_str)
        .unwrap_or("");
    if diff.trim().is_empty() {
        lines.push(Line::from("—"));
    } else {
        for raw in diff.lines().take(14) {
            let style = if raw.starts_with("+++") || raw.starts_with("---") {
                Style::default().fg(Color::Cyan)
            } else if raw.starts_with('+') {
                Style::default().fg(Color::Green)
            } else if raw.starts_with('-') {
                Style::default().fg(Color::Red)
            } else if raw.starts_with("@@") {
                Style::default().fg(Color::Magenta)
            } else if raw.starts_with("diff --git") {
                Style::default()
                    .fg(Color::Blue)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::Gray)
            };
            lines.push(Line::from(Span::styled(
                truncate(raw, area.width as usize - 4),
                style,
            )));
        }
        let total_lines = diff.lines().count();
        if total_lines > 14 {
            lines.push(Line::from(format!(
                "… {} more diff lines",
                total_lines - 14
            )));
        }
    }
    frame.render_widget(
        Paragraph::new(lines).block(Block::default().title(" details ").borders(Borders::ALL)),
        area,
    );
}

fn render_footer(frame: &mut Frame, area: Rect) {
    let line = Line::from(vec![
        Span::styled(" q/esc ", Style::default().fg(Color::Black).bg(Color::Gray)),
        Span::raw(" quit   "),
        Span::styled(" j/k ", Style::default().fg(Color::Black).bg(Color::Gray)),
        Span::raw(" select   "),
        Span::styled(" 1-5 ", Style::default().fg(Color::Black).bg(Color::Gray)),
        Span::raw(" layout modes"),
    ]);
    frame.render_widget(
        Paragraph::new(line).block(Block::default().borders(Borders::TOP)),
        area,
    );
}
