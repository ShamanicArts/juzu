use crate::{CommitNode, LayoutMode};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLayoutConfig {
    pub lane_width: i32,
    pub y_spacing: i32,
    pub canvas_padding: i32,
    pub text_column_gap: i32,
}

impl Default for GraphLayoutConfig {
    fn default() -> Self {
        Self {
            lane_width: 24,
            y_spacing: 84,
            canvas_padding: 50,
            text_column_gap: 60,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutResult {
    pub nodes: Vec<CommitNode>,
    pub max_lane: usize,
    pub text_column_x: i32,
    pub total_height: i32,
}

fn build_index(nodes: &[CommitNode]) -> HashMap<String, usize> {
    nodes
        .iter()
        .enumerate()
        .map(|(idx, node)| (node.change_id.clone(), idx))
        .collect()
}

fn build_children_by_id(nodes: &[CommitNode]) -> HashMap<String, Vec<usize>> {
    let mut children: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, child) in nodes.iter().enumerate() {
        for parent_id in &child.parents {
            children.entry(parent_id.clone()).or_default().push(idx);
        }
    }
    children
}

fn layout_chronological(nodes: &mut [CommitNode], index: &HashMap<String, usize>) {
    let mut node_lanes: HashMap<String, usize> = HashMap::new();
    let mut next_free_lane = 0usize;

    for node in nodes.iter_mut() {
        let change_id = node.change_id.clone();
        if !node_lanes.contains_key(&change_id) {
            node_lanes.insert(change_id.clone(), next_free_lane);
            next_free_lane += 1;
        }
        let my_lane = node_lanes[&change_id];
        node.lane = Some(my_lane);

        for (parent_idx, parent_id) in node.parents.iter().enumerate() {
            if !index.contains_key(parent_id) || node_lanes.contains_key(parent_id) {
                continue;
            }
            let lane = if parent_idx == 0 {
                my_lane
            } else {
                let lane = next_free_lane;
                next_free_lane += 1;
                lane
            };
            node_lanes.insert(parent_id.clone(), lane);
        }
    }
}

fn layout_bookmark_centric(nodes: &mut [CommitNode], index: &HashMap<String, usize>) {
    let mut bookmark_lanes: HashMap<String, usize> = HashMap::new();
    let mut next_lane = 0usize;

    for node in nodes.iter_mut() {
        if let Some(primary) = node.bookmarks.first() {
            let lane = *bookmark_lanes.entry(primary.clone()).or_insert_with(|| {
                let lane = next_lane;
                next_lane += 1;
                lane
            });
            node.lane = Some(lane);
        }
    }

    for idx in 0..nodes.len() {
        if nodes[idx].lane.is_some() {
            continue;
        }
        let mut inherited = None;
        for parent_id in &nodes[idx].parents {
            if let Some(parent_idx) = index.get(parent_id) {
                if let Some(parent_lane) = nodes[*parent_idx].lane {
                    inherited = Some(parent_lane);
                    break;
                }
            }
        }
        nodes[idx].lane = Some(inherited.unwrap_or_else(|| {
            let lane = next_lane;
            next_lane += 1;
            lane
        }));
    }
}

fn layout_wc_focused(nodes: &mut [CommitNode], index: &HashMap<String, usize>) {
    let Some(wc_idx) = nodes.iter().position(|node| node.is_working_copy) else {
        layout_chronological(nodes, index);
        return;
    };

    nodes[wc_idx].lane = Some(0);
    let children = build_children_by_id(nodes);
    let mut visited: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<(usize, isize)> = VecDeque::from([(wc_idx, 0)]);

    while let Some((idx, lane)) = queue.pop_front() {
        let change_id = nodes[idx].change_id.clone();
        if !visited.insert(change_id.clone()) {
            continue;
        }
        nodes[idx].lane = Some(lane.unsigned_abs());

        for (parent_offset, parent_id) in nodes[idx].parents.clone().iter().enumerate() {
            if let Some(parent_idx) = index.get(parent_id) {
                if !visited.contains(parent_id) {
                    queue.push_back((*parent_idx, lane + 1 + parent_offset as isize));
                }
            }
        }

        if let Some(child_indices) = children.get(&change_id) {
            for child_idx in child_indices {
                let child_id = &nodes[*child_idx].change_id;
                if !visited.contains(child_id) {
                    queue.push_back((*child_idx, lane - 1));
                }
            }
        }
    }

    let mut max_lane = nodes.iter().filter_map(|node| node.lane).max().unwrap_or(0);
    for node in nodes.iter_mut() {
        if node.lane.is_none() {
            max_lane += 1;
            node.lane = Some(max_lane);
        }
    }
}

fn layout_topological(nodes: &mut [CommitNode]) {
    let mut depths: HashMap<String, usize> = HashMap::new();
    for node in nodes
        .iter()
        .filter(|node| node.is_root || node.parents.is_empty())
    {
        depths.insert(node.change_id.clone(), 0);
    }

    for idx in (0..nodes.len()).rev() {
        if depths.contains_key(&nodes[idx].change_id) {
            continue;
        }
        let max_parent_depth = nodes[idx]
            .parents
            .iter()
            .filter_map(|parent_id| depths.get(parent_id).copied())
            .max()
            .map(|depth| depth as isize)
            .unwrap_or(-1);
        depths.insert(
            nodes[idx].change_id.clone(),
            (max_parent_depth + 1) as usize,
        );
    }

    for node in nodes.iter_mut() {
        node.lane = Some(*depths.get(&node.change_id).unwrap_or(&0));
    }
}

fn layout_mainline(
    nodes: &mut [CommitNode],
    index: &HashMap<String, usize>,
    cfg: GraphLayoutConfig,
) {
    let mut current_y = cfg.canvas_padding;
    for node in nodes.iter_mut() {
        node.y = Some(current_y);
        current_y += cfg.y_spacing + node.extra_height.unwrap_or(0);
    }

    let children = build_children_by_id(nodes);
    let heads: Vec<usize> = nodes
        .iter()
        .enumerate()
        .filter_map(|(idx, node)| (!children.contains_key(&node.change_id)).then_some(idx))
        .collect();

    let mut best_path: Vec<usize> = Vec::new();
    let mut best_score = -1isize;
    for head_idx in heads {
        let mut path = Vec::new();
        let mut current = Some(head_idx);
        let mut score = 0isize;
        while let Some(idx) = current {
            path.push(idx);
            let node = &nodes[idx];
            if node.is_working_copy {
                score += 200;
            }
            if node.bookmarks.iter().any(|b| b == "main" || b == "master") {
                score += 150;
            }
            if !node.bookmarks.is_empty() {
                score += 50;
            }
            score += 1;
            current = node
                .parents
                .first()
                .and_then(|parent_id| index.get(parent_id).copied());
        }
        if score > best_score {
            best_score = score;
            best_path = path;
        }
    }

    let mainline_set: HashSet<String> = best_path
        .iter()
        .map(|idx| nodes[*idx].change_id.clone())
        .collect();
    for idx in &best_path {
        nodes[*idx].lane = Some(0);
    }

    let mut lane_ranges: HashMap<usize, Vec<(i32, i32)>> = HashMap::from([(0, vec![(0, 999_999)])]);
    let is_lane_available =
        |lane_ranges: &HashMap<usize, Vec<(i32, i32)>>, lane: usize, y: i32, height: i32| -> bool {
            let Some(ranges) = lane_ranges.get(&lane) else {
                return true;
            };
            let effective_height = height.max(cfg.y_spacing);
            ranges.iter().all(|(min_y, max_y)| {
                !(y <= *max_y + cfg.y_spacing && y + effective_height >= *min_y - cfg.y_spacing)
            })
        };

    let mut branch_commits: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, node) in nodes.iter().enumerate() {
        if mainline_set.contains(&node.change_id) {
            continue;
        }
        if node
            .parents
            .iter()
            .any(|parent_id| mainline_set.contains(parent_id))
        {
            branch_commits.insert(node.change_id.clone(), vec![idx]);
        }
    }

    let mut branch_roots: Vec<String> = branch_commits.keys().cloned().collect();
    branch_roots.sort_by_key(|root_id| {
        branch_commits
            .get(root_id)
            .and_then(|commits| commits.first().copied())
            .unwrap_or(usize::MAX)
    });
    for root_id in branch_roots {
        let mut branch_set: HashSet<String> = branch_commits[&root_id]
            .iter()
            .map(|idx| nodes[*idx].change_id.clone())
            .collect();
        let mut queue: VecDeque<usize> = branch_commits[&root_id].clone().into();
        while let Some(current_idx) = queue.pop_front() {
            if let Some(child_indices) = children.get(&nodes[current_idx].change_id) {
                for child_idx in child_indices {
                    let child = &nodes[*child_idx];
                    if branch_set.contains(&child.change_id)
                        || mainline_set.contains(&child.change_id)
                    {
                        continue;
                    }
                    branch_set.insert(child.change_id.clone());
                    branch_commits.get_mut(&root_id).unwrap().push(*child_idx);
                    queue.push_back(*child_idx);
                }
            }
        }
        branch_commits
            .get_mut(&root_id)
            .unwrap()
            .sort_by_key(|idx| nodes[*idx].y.unwrap_or(0));
    }

    let mut branch_roots: Vec<String> = branch_commits.keys().cloned().collect();
    branch_roots.sort_by_key(|root_id| {
        branch_commits
            .get(root_id)
            .and_then(|commits| commits.first().copied())
            .unwrap_or(usize::MAX)
    });
    for root_id in branch_roots {
        let commits = &branch_commits[&root_id];
        if commits.is_empty() {
            continue;
        }
        let min_y = nodes[*commits.first().unwrap()].y.unwrap_or(0);
        let mut max_y = nodes[*commits.last().unwrap()].y.unwrap_or(min_y);
        if let Some(root_idx) = commits
            .iter()
            .find(|idx| nodes[**idx].change_id == *root_id)
        {
            for parent_id in &nodes[*root_idx].parents {
                if let Some(parent_idx) = index.get(parent_id) {
                    if mainline_set.contains(parent_id) {
                        max_y = max_y.max(nodes[*parent_idx].y.unwrap_or(max_y));
                        break;
                    }
                }
            }
        }
        let mut lane = 1usize;
        while !is_lane_available(&lane_ranges, lane, min_y, max_y - min_y) {
            lane += 1;
        }
        for idx in commits {
            nodes[*idx].lane = Some(lane);
        }
        lane_ranges.entry(lane).or_default().push((min_y, max_y));
    }

    for idx in 0..nodes.len() {
        if nodes[idx].lane.is_some() {
            continue;
        }
        let mut parent_lane = None;
        for parent_id in &nodes[idx].parents {
            if let Some(parent_idx) = index.get(parent_id) {
                if let Some(lane) = nodes[*parent_idx].lane {
                    parent_lane = Some(lane);
                    if !mainline_set.contains(parent_id) {
                        break;
                    }
                }
            }
        }
        let y = nodes[idx].y.unwrap_or(0);
        let mut lane = if matches!(parent_lane, Some(lane) if lane != 0 && is_lane_available(&lane_ranges, lane, y, cfg.y_spacing))
        {
            parent_lane.unwrap()
        } else {
            let mut candidate = 1usize;
            while !is_lane_available(&lane_ranges, candidate, y, cfg.y_spacing) {
                candidate += 1;
            }
            candidate
        };
        if lane == 0 {
            lane = 1;
        }
        nodes[idx].lane = Some(lane);
        lane_ranges
            .entry(lane)
            .or_default()
            .push((y, y + cfg.y_spacing));
    }
}

pub fn calculate_layout(
    mode: LayoutMode,
    nodes: &[CommitNode],
    config: GraphLayoutConfig,
) -> LayoutResult {
    let mut nodes_copy: Vec<CommitNode> = nodes
        .iter()
        .cloned()
        .map(|mut node| {
            node.lane = None;
            node.x = None;
            node.y = None;
            node.is_pinned = false;
            node
        })
        .collect();
    let index = build_index(&nodes_copy);

    match mode {
        LayoutMode::Chronological => layout_chronological(&mut nodes_copy, &index),
        LayoutMode::BookmarkCentric => layout_bookmark_centric(&mut nodes_copy, &index),
        LayoutMode::WcFocused => layout_wc_focused(&mut nodes_copy, &index),
        LayoutMode::Topological => layout_topological(&mut nodes_copy),
        LayoutMode::Mainline => layout_mainline(&mut nodes_copy, &index, config),
    }

    for node in &mut nodes_copy {
        if node.lane.is_none() {
            node.lane = Some(0);
        }
    }

    let max_lane = nodes_copy
        .iter()
        .filter_map(|node| node.lane)
        .max()
        .unwrap_or(0);
    let graph_width = (max_lane as i32 + 1) * config.lane_width;
    let text_column_x = config.canvas_padding + graph_width + config.text_column_gap;

    let mut current_y = config.canvas_padding;
    for node in &mut nodes_copy {
        let lane = node.lane.unwrap_or(0) as i32;
        node.x = Some(config.canvas_padding + ((max_lane as i32 - lane) * config.lane_width));
        node.y = Some(current_y);
        current_y += config.y_spacing + node.extra_height.unwrap_or(0);
    }

    LayoutResult {
        nodes: nodes_copy,
        max_lane,
        text_column_x,
        total_height: current_y + config.canvas_padding,
    }
}

pub fn calculate_default_layout(mode: LayoutMode, nodes: &[CommitNode]) -> LayoutResult {
    calculate_layout(mode, nodes, GraphLayoutConfig::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(change_id: &str, parents: &[&str]) -> CommitNode {
        CommitNode {
            change_id: change_id.to_string(),
            commit_id: change_id.to_string(),
            parents: parents.iter().map(|parent| parent.to_string()).collect(),
            author: "dev@example.com".to_string(),
            time: "2026-01-01T00:00:00Z".to_string(),
            bookmarks: Vec::new(),
            git_branches: Vec::new(),
            description_title: change_id.to_string(),
            description_full: change_id.to_string(),
            is_empty: false,
            is_conflict: false,
            is_hidden: false,
            is_root: parents.is_empty(),
            is_working_copy: change_id == "c3",
            x: None,
            y: None,
            lane: None,
            extra_height: None,
            is_pinned: false,
        }
    }

    #[test]
    fn chronological_uses_expected_coordinate_defaults() {
        let nodes = vec![node("c3", &["c2"]), node("c2", &["c1"]), node("c1", &[])];
        let out = calculate_default_layout(LayoutMode::Chronological, &nodes);
        assert_eq!(out.max_lane, 0);
        assert_eq!(out.text_column_x, 134);
        assert_eq!(out.total_height, 352);
        assert_eq!(out.nodes[0].x, Some(50));
        assert_eq!(out.nodes[0].y, Some(50));
        assert_eq!(out.nodes[1].y, Some(134));
    }

    #[test]
    fn mainline_branch_lanes_are_stable_across_repeated_layouts() {
        let nodes = vec![
            node("wc", &["merge"]),
            node("merge", &["main2", "feature_b2", "feature_a2"]),
            node("feature_b2", &["feature_b1"]),
            node("feature_a2", &["feature_a1"]),
            node("main2", &["main1"]),
            node("feature_b1", &["main1"]),
            node("feature_a1", &["main1"]),
            node("main1", &["root"]),
            node("root", &[]),
        ];
        let first = calculate_default_layout(LayoutMode::Mainline, &nodes);
        let first_lanes: Vec<_> = first.nodes.iter().map(|node| node.lane).collect();
        for _ in 0..100 {
            let next = calculate_default_layout(LayoutMode::Mainline, &nodes);
            let next_lanes: Vec<_> = next.nodes.iter().map(|node| node.lane).collect();
            assert_eq!(next_lanes, first_lanes);
        }
    }
}
