use anyhow::Result;
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use juzu_core::{layout::calculate_default_layout, JjBackend, LayoutMode, LogQuery};
use juzu_jj::NativeJjBackend;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    DefaultTerminal, Frame,
};
use std::{io::stdout, path::PathBuf, time::Duration};

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
    let selected = nodes
        .iter()
        .position(|node| node.is_working_copy)
        .unwrap_or(0);
    let mut app = App {
        path,
        mode,
        nodes,
        selected,
    };

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
                    }
                    KeyCode::Char('k') | KeyCode::Up => {
                        app.selected = app.selected.saturating_sub(1);
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
    let inner_height = area.height.saturating_sub(2) as usize;
    let visible_nodes = (inner_height / 2).max(1);
    let selected = app.selected.min(layout.nodes.len().saturating_sub(1));
    let start = selected.saturating_sub(visible_nodes / 2);
    let end = (start + visible_nodes).min(layout.nodes.len());
    let visible_count = end.saturating_sub(start);
    let graph_width =
        ((layout.max_lane + 1) * 4 + 2).min((area.width as usize).saturating_div(2).max(12));
    let row_count = (visible_count * 2).max(1);
    let mut grid = vec![vec![' '; graph_width]; row_count];
    let all_index: std::collections::HashMap<_, _> = layout
        .nodes
        .iter()
        .enumerate()
        .map(|(idx, node)| (node.change_id.as_str(), idx))
        .collect();
    let visible_index: std::collections::HashMap<_, _> = (start..end)
        .enumerate()
        .map(|(local, global)| (global, local))
        .collect();
    let lane_x = |lane: usize| -> usize { (lane * 4 + 1).min(graph_width.saturating_sub(1)) };
    let node_y = |local: usize| -> usize { local * 2 };

    for child_idx in start..end {
        let child = &layout.nodes[child_idx];
        let child_lane = child.lane.unwrap_or(0);
        let x0 = lane_x(child_lane);
        let y0 = node_y(visible_index[&child_idx]);
        for parent_id in &child.parents {
            let Some(parent_idx) = all_index.get(parent_id.as_str()).copied() else {
                continue;
            };
            if parent_idx < start || parent_idx >= end {
                continue;
            }
            let parent = &layout.nodes[parent_idx];
            let parent_lane = parent.lane.unwrap_or(0);
            let x1 = lane_x(parent_lane);
            let y1 = node_y(visible_index[&parent_idx]);
            if x0 == x1 {
                for y in y0.min(y1) + 1..y0.max(y1) {
                    put_grid(&mut grid, graph_width, x0, y, '│');
                }
                continue;
            }
            let connect_y = if child.parents.len() > 1 { y0 } else { y1 };
            for x in x0.min(x1)..=x0.max(x1) {
                put_grid(&mut grid, graph_width, x, connect_y, '─');
            }
            if child.parents.len() > 1 {
                put_grid(
                    &mut grid,
                    graph_width,
                    x0,
                    connect_y,
                    if x0 < x1 { '├' } else { '┤' },
                );
                put_grid(
                    &mut grid,
                    graph_width,
                    x1,
                    connect_y,
                    if x0 < x1 { '┐' } else { '┌' },
                );
                for y in connect_y + 1..y1 {
                    put_grid(&mut grid, graph_width, x1, y, '│');
                }
            } else {
                put_grid(
                    &mut grid,
                    graph_width,
                    x1,
                    connect_y,
                    if x0 < x1 { '├' } else { '┤' },
                );
                put_grid(
                    &mut grid,
                    graph_width,
                    x0,
                    connect_y,
                    if x0 < x1 { '└' } else { '┘' },
                );
                for y in y0 + 1..connect_y {
                    put_grid(&mut grid, graph_width, x0, y, '│');
                }
            }
        }
    }

    for (local, global) in (start..end).enumerate() {
        let node = &layout.nodes[global];
        let x = lane_x(node.lane.unwrap_or(0));
        let y = node_y(local);
        let ch = if node.is_working_copy {
            '@'
        } else if node.is_conflict {
            '!'
        } else if global == selected {
            'O'
        } else {
            'o'
        };
        put_grid(&mut grid, graph_width, x, y, ch);
    }

    let mut lines = Vec::new();
    for (row, chars) in grid.into_iter().enumerate() {
        let global = start + row / 2;
        let mut text = chars.into_iter().collect::<String>();
        if let Some(node) = layout.nodes.get(global) {
            if row % 2 == 0 {
                text.push_str("  ");
                text.push_str(&node.change_id.chars().take(8).collect::<String>());
                text.push(' ');
                text.push_str(&node.commit_id.chars().take(8).collect::<String>());
            } else {
                let refs = if node.bookmarks.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", node.bookmarks.join(","))
                };
                text.push_str("  ");
                text.push_str(&node.description_title);
                text.push_str(&refs);
            }
        }
        let style = if global == selected {
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else if layout
            .nodes
            .get(global)
            .is_some_and(|node| node.is_working_copy)
        {
            Style::default().fg(Color::Green)
        } else if layout
            .nodes
            .get(global)
            .is_some_and(|node| node.is_conflict)
        {
            Style::default().fg(Color::Red)
        } else {
            Style::default().fg(Color::Gray)
        };
        lines.push(Line::styled(text, style));
    }

    frame.render_widget(
        Paragraph::new(lines).block(Block::default().title(" dag graph ").borders(Borders::ALL)),
        area,
    );
}

fn put_grid(grid: &mut [Vec<char>], width: usize, x: usize, y: usize, ch: char) {
    if y < grid.len() && x < width {
        grid[y][x] = ch;
    }
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
    ];
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
