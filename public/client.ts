
// Types
interface HitRegion {
    x: number;
    y: number;
    w: number;
    h: number;
    cursor: string;
    onClick: () => void;
    id?: string;
}

type LayoutMode = 'chronological' | 'bookmark-centric' | 'wc-focused' | 'topological' | 'mainline';

interface CommitNode {
    changeId: string;
    commitId: string;
    parents: string[];
    author: string;
    time: string;
    bookmarks: string[];
    gitBranches: string[];
    descriptionTitle: string;
    descriptionFull: string;
    isEmpty: boolean;
    isConflict: boolean;
    isHidden: boolean;
    isRoot: boolean;
    isWorkingCopy: boolean;
    // Layout props
    x?: number;
    y?: number;
    lane?: number;
    extraHeight?: number; // For inline file expansion
    isPinned?: boolean;
}

// Config
const NODE_RADIUS = 5;
const LANE_WIDTH = 24;
const Y_SPACING = 45; 
const CANVAS_PADDING = 50;
const TEXT_COLUMN_GAP = 60; // Distance between Lane 0 (Base) and Text Column
const COLORS = {
    node: '#444',
    nodeSelected: '#ffffff',
    nodeConflict: '#ff0055',
    text: '#888',
    textDesc: '#bbb',
    nodeBorder: '#666',
    lanes: [
        '#00f0ff', // Cyan
        '#ff0055', // Red/Pink
        '#00ff9d', // Green
        '#ffaa00', // Orange
        '#aa00ff', // Purple
        '#00aaff', // Blue
        '#ffff00', // Yellow
        '#ff00aa', // Magenta
    ]
};

class GraphVisualizer {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    nodes: CommitNode[] = [];
    selectedNodes: Set<string> = new Set();
    
    // Viewport state
    offsetX = 50;
    offsetY = 50;
    isDragging = false;
    lastMouseX = 0;
    lastMouseY = 0;
    scale = 1;

    // Interaction State
    hoveredRegion: HitRegion | null = null;
    hitRegions: HitRegion[] = [];
    hoveredNode: CommitNode | null = null;
    rebaseSource: CommitNode | null = null;
    expandedFilesNode: string | null = null;
    cachedFiles: Map<string, any[]> = new Map();
    isShiftPressed = false; // Track shift key

    // Operation Mode State
    // Modes: 'none' | 'split' | 'squash' | 'move'
    opMode: 'none' | 'split' | 'squash' | 'move' = 'none';
    opSelectedPaths: Set<string> = new Set();
    opTargetNode: CommitNode | null = null; // For Move/Squash targets

    // Drag-to-Pin State
    isDraggingNode = false;
    dragNode: CommitNode | null = null;
    dragStartX = 0;
    dragCurrentLane: number | null = null;
    
    // Layout State
    maxLane = 0;
    textColumnX = 0;
    layoutMode: LayoutMode = 'chronological';
    pinnedNodes: Map<string, number> = new Map(); // changeId -> lane
    bookmarkColors: Map<string, string> = new Map(); // bookmark -> color

    constructor() {
        this.canvas = document.getElementById('graphCanvas') as HTMLCanvasElement;
        this.ctx = this.canvas.getContext('2d')!;

        this.loadLayoutState();

        this.resize();
        window.addEventListener('resize', () => this.resize());

        this.setupInteractions();
        this.setupLayoutUI();
        this.fetchData();

        document.getElementById('refreshBtn')?.addEventListener('click', () => this.fetchData());
    }

    setupLayoutUI() {
        // Create layout selector if it doesn't exist
        let selector = document.getElementById('layoutSelector') as HTMLSelectElement;
        if (!selector) {
            selector = document.createElement('select');
            selector.id = 'layoutSelector';
            selector.className = 'layout-selector';

            const modes: { value: LayoutMode; label: string }[] = [
                { value: 'chronological', label: 'Chronological' },
                { value: 'mainline', label: 'Mainline' },
                { value: 'bookmark-centric', label: 'Bookmark-Centric' },
                { value: 'wc-focused', label: 'WC-Focused' },
                { value: 'topological', label: 'Topological' }
            ];

            modes.forEach(mode => {
                const option = document.createElement('option');
                option.value = mode.value;
                option.textContent = mode.label;
                if (mode.value === this.layoutMode) option.selected = true;
                selector.appendChild(option);
            });

            selector.addEventListener('change', (e) => {
                this.setLayoutMode((e.target as HTMLSelectElement).value as LayoutMode);
            });

            // Add to controls
            const controls = document.querySelector('.controls');
            if (controls) {
                const label = document.createElement('label');
                label.textContent = 'Layout: ';
                label.style.marginLeft = '10px';
                label.style.color = '#888';
                label.style.fontSize = '12px';
                label.appendChild(selector);
                controls.appendChild(label);
            }
        }
    }

    resize() {
        const parent = this.canvas.parentElement;
        if (parent) {
            this.canvas.width = parent.clientWidth;
            this.canvas.height = parent.clientHeight;
            this.render();
        }
    }

    async fetchData() {
        try {
            const res = await fetch('/api/log?t=' + Date.now());
            const data = await res.json();
            console.log("Fetched Nodes:", data.length, data[0]); // Debug
            this.processGraph(data);
            this.render();
        } catch (err) {
            console.error('Failed to fetch graph:', err);
        }
    }

    processGraph(data: CommitNode[]) {
        const nodesMap = new Map<string, CommitNode>();
        data.forEach(n => nodesMap.set(n.changeId, n));

        // Apply layout strategy based on mode
        switch (this.layoutMode) {
            case 'chronological':
                this.layoutChronological(data, nodesMap);
                break;
            case 'bookmark-centric':
                this.layoutBookmarkCentric(data, nodesMap);
                break;
            case 'wc-focused':
                this.layoutWcFocused(data, nodesMap);
                break;
            case 'topological':
                this.layoutTopological(data, nodesMap);
                break;
            case 'mainline':
                this.layoutMainline(data, nodesMap);
                break;
        }

        // Apply pinned nodes (override strategy)
        this.pinnedNodes.forEach((lane, changeId) => {
            const node = data.find(n => n.changeId === changeId);
            if (node) {
                node.lane = lane;
                node.isPinned = true;
            }
        });

        this.nodes = data;
        this.recalculateLayout();

        // Auto-select Working Copy if nothing selected
        if (this.selectedNodes.size === 0) {
            const wc = this.nodes.find(n => n.isWorkingCopy);
            if (wc) {
                this.selectNode(wc);
            }
        }
    }

    // Layout Strategy 1: Chronological (current behavior)
    private layoutChronological(data: CommitNode[], nodesMap: Map<string, CommitNode>) {
        const nodeLanes = new Map<string, number>();
        let nextFreeLane = 0;

        data.forEach(node => {
            if (!nodeLanes.has(node.changeId)) {
                nodeLanes.set(node.changeId, nextFreeLane++);
            }

            const myLane = nodeLanes.get(node.changeId)!;
            node.lane = myLane;

            node.parents.forEach((parentId, idx) => {
                const parent = nodesMap.get(parentId);
                if (!parent) return;

                if (!nodeLanes.has(parentId)) {
                    if (idx === 0) {
                        nodeLanes.set(parentId, myLane);
                    } else {
                        nodeLanes.set(parentId, nextFreeLane++);
                    }
                }
            });
        });
    }

    // Layout Strategy 2: Bookmark-Centric (bookmarked commits get dedicated lanes)
    private layoutBookmarkCentric(data: CommitNode[], nodesMap: Map<string, CommitNode>) {
        // First, identify all bookmarks and assign them lanes
        const bookmarkLanes = new Map<string, number>();
        let nextLane = 0;

        // Assign lanes to bookmarked commits first
        data.forEach(node => {
            if (node.bookmarks.length > 0) {
                const primaryBookmark = node.bookmarks[0];
                if (!bookmarkLanes.has(primaryBookmark)) {
                    bookmarkLanes.set(primaryBookmark, nextLane++);
                }
                node.lane = bookmarkLanes.get(primaryBookmark)!;
            }
        });

        // Propagate lanes to non-bookmarked commits (inherit from first parent)
        data.forEach(node => {
            if (node.lane === undefined) {
                for (const parentId of node.parents) {
                    const parent = nodesMap.get(parentId);
                    if (parent && parent.lane !== undefined) {
                        node.lane = parent.lane;
                        break;
                    }
                }
                if (node.lane === undefined) {
                    node.lane = nextLane++;
                }
            }
        });
    }

    // Layout Strategy 3: WC-Focused (Working Copy at lane 0, ancestors to left)
    private layoutWcFocused(data: CommitNode[], nodesMap: Map<string, CommitNode>) {
        const wc = data.find(n => n.isWorkingCopy);
        if (!wc) {
            this.layoutChronological(data, nodesMap);
            return;
        }

        // WC at lane 0
        wc.lane = 0;

        // BFS to assign lanes based on distance from WC
        const visited = new Set<string>();
        const queue: [CommitNode, number][] = [[wc, 0]];

        while (queue.length > 0) {
            const [node, lane] = queue.shift()!;
            if (visited.has(node.changeId)) continue;
            visited.add(node.changeId);

            node.lane = Math.abs(lane); // Keep lanes positive

            // Parents go to "earlier" lanes (more to the left in our inverted layout)
            node.parents.forEach((parentId, idx) => {
                const parent = nodesMap.get(parentId);
                if (parent && !visited.has(parentId)) {
                    queue.push([parent, lane + 1 + idx]);
                }
            });

            // Find children
            data.forEach(child => {
                if (child.parents.includes(node.changeId) && !visited.has(child.changeId)) {
                    queue.push([child, lane - 1]);
                }
            });
        }

        // Fill in any unvisited nodes
        let maxLane = Math.max(...data.map(n => n.lane || 0));
        data.forEach(node => {
            if (node.lane === undefined) {
                node.lane = ++maxLane;
            }
        });
    }

    // Layout Strategy 4: Topological (lane = depth from root)
    private layoutTopological(data: CommitNode[], nodesMap: Map<string, CommitNode>) {
        const depths = new Map<string, number>();

        // Find roots
        const roots = data.filter(n => n.isRoot || n.parents.length === 0);
        roots.forEach(r => depths.set(r.changeId, 0));

        // Process nodes in reverse order (oldest first) to calculate depths
        for (let i = data.length - 1; i >= 0; i--) {
            const node = data[i];
            if (!depths.has(node.changeId)) {
                let maxParentDepth = -1;
                node.parents.forEach(parentId => {
                    const parentDepth = depths.get(parentId);
                    if (parentDepth !== undefined) {
                        maxParentDepth = Math.max(maxParentDepth, parentDepth);
                    }
                });
                depths.set(node.changeId, maxParentDepth + 1);
            }
        }

        // Assign lanes based on depth
        data.forEach(node => {
            node.lane = depths.get(node.changeId) || 0;
        });
    }

    // Layout Strategy 5: Mainline (one straight trunk, branches parallel with lane reuse)
    private layoutMainline(data: CommitNode[], nodesMap: Map<string, CommitNode>) {
        // First pass: calculate Y positions (chronological order)
        let currentY = CANVAS_PADDING;
        data.forEach(node => {
            node.y = currentY;
            currentY += Y_SPACING + (node.extraHeight || 0);
        });

        // Build mainline: find longest path from any head to root
        const heads = data.filter(n => !data.some(other => other.parents.includes(n.changeId)));

        let bestPath: CommitNode[] = [];
        let bestScore = -1;

        for (const head of heads) {
            const path: CommitNode[] = [];
            let current: CommitNode | undefined = head;
            let score = 0;

            while (current) {
                path.push(current);
                if (current.isWorkingCopy) score += 200;
                if (current.gitBranches?.includes('main') || current.gitBranches?.includes('master')) score += 150;
                if (current.bookmarks.length > 0) score += 50;
                if (current.gitBranches?.length > 0) score += 30;
                score += 1;

                if (current.parents.length > 0) {
                    current = nodesMap.get(current.parents[0]);
                } else {
                    break;
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestPath = path;
            }
        }

        // Mainline nodes get lane 0
        const mainlineSet = new Set(bestPath.map(n => n.changeId));
        bestPath.forEach(n => n.lane = 0);

        // Track Y ranges occupied in each lane (lane -> array of [minY, maxY] ranges)
        const laneRanges = new Map<number, [number, number][]>();
        laneRanges.set(0, [[0, 999999]]); // Mainline occupies everything

        // Helper to check if a lane is available at a given Y position
        const isLaneAvailable = (lane: number, y: number, height: number = Y_SPACING): boolean => {
            const ranges = laneRanges.get(lane);
            if (!ranges) return true;

            // Check if this Y range overlaps with any existing range
            for (const [minY, maxY] of ranges) {
                // Add some padding between branches
                if (y < maxY + Y_SPACING && y + height > minY - Y_SPACING) {
                    return false; // Overlaps
                }
            }
            return true;
        };

        // Helper to occupy a lane range
        const occupyLane = (lane: number, minY: number, maxY: number) => {
            if (!laneRanges.has(lane)) {
                laneRanges.set(lane, []);
            }
            laneRanges.get(lane)!.push([minY, maxY]);
        };

        // Build branch commit chains and assign lanes
        // Group commits by "branch" (connected component off mainline)
        const assigned = new Set<string>([...mainlineSet]);
        const branchCommits = new Map<string, CommitNode[]>(); // root changeId -> commits in branch

        // Find branch roots (commits that have a mainline parent but aren't on mainline)
        data.forEach(node => {
            if (mainlineSet.has(node.changeId)) return;

            const hasMainlineParent = node.parents.some(pid => mainlineSet.has(pid));
            if (hasMainlineParent) {
                // This is a branch root
                branchCommits.set(node.changeId, [node]);
            }
        });

        // Grow each branch to include all descendants until they hit mainline or another branch
        branchCommits.forEach((commits, rootId) => {
            const toProcess = [...commits];
            const branchSet = new Set<string>(commits.map(c => c.changeId));

            while (toProcess.length > 0) {
                const current = toProcess.shift()!;

                // Find children
                data.forEach(child => {
                    if (branchSet.has(child.changeId)) return;
                    if (mainlineSet.has(child.changeId)) return;

                    // Child has this node as parent
                    if (child.parents.includes(current.changeId)) {
                        branchSet.add(child.changeId);
                        commits.push(child);
                        toProcess.push(child);
                    }
                });
            }

            // Sort commits by Y position
            commits.sort((a, b) => a.y! - b.y!);
        });

        // Assign lanes to branches, reusing lanes when vertically separated
        branchCommits.forEach((commits, rootId) => {
            if (commits.length === 0) return;

            const minY = commits[0].y!;
            const maxY = commits[commits.length - 1].y!;

            // Find the nearest available lane to mainline
            let lane = 1;
            while (!isLaneAvailable(lane, minY, maxY - minY)) {
                lane++;
            }

            // Assign this lane to all commits in the branch
            commits.forEach(node => {
                node.lane = lane;
            });

            // Mark lane as occupied
            occupyLane(lane, minY, maxY);
        });

        // Handle any remaining unassigned commits (merges, etc.)
        data.forEach(node => {
            if (node.lane !== undefined) return;

            // Find parent lane
            let parentLane: number | undefined;
            for (const parentId of node.parents) {
                const parent = nodesMap.get(parentId);
                if (parent && parent.lane !== undefined) {
                    parentLane = parent.lane;
                    if (!mainlineSet.has(parentId)) break;
                }
            }

            if (parentLane !== undefined && parentLane !== 0) {
                // Try to use parent's lane if available at this Y
                if (isLaneAvailable(parentLane, node.y!)) {
                    node.lane = parentLane;
                    occupyLane(parentLane, node.y!, node.y! + Y_SPACING);
                } else {
                    // Find nearest available
                    let lane = 1;
                    while (!isLaneAvailable(lane, node.y!)) {
                        lane++;
                    }
                    node.lane = lane;
                    occupyLane(lane, node.y!, node.y! + Y_SPACING);
                }
            } else {
                // Orphaned - find nearest available lane
                let lane = 1;
                while (!isLaneAvailable(lane, node.y!)) {
                    lane++;
                }
                node.lane = lane;
                occupyLane(lane, node.y!, node.y! + Y_SPACING);
            }
        });
    }

    setLayoutMode(mode: LayoutMode) {
        this.layoutMode = mode;
        this.saveLayoutState();
        this.processGraph(this.nodes);
        this.render();
    }

    pinNode(changeId: string, lane: number) {
        this.pinnedNodes.set(changeId, lane);
        const node = this.nodes.find(n => n.changeId === changeId);
        if (node) node.isPinned = true;
        this.saveLayoutState();
        this.processGraph(this.nodes);
        this.render();
    }

    unpinNode(changeId: string) {
        this.pinnedNodes.delete(changeId);
        const node = this.nodes.find(n => n.changeId === changeId);
        if (node) node.isPinned = false;
        this.saveLayoutState();
        this.processGraph(this.nodes);
        this.render();
    }

    private saveLayoutState() {
        const state = {
            mode: this.layoutMode,
            pinned: Array.from(this.pinnedNodes.entries()),
            bookmarkColors: Array.from(this.bookmarkColors.entries())
        };
        localStorage.setItem('jj-viz-layout', JSON.stringify(state));
    }

    private loadLayoutState() {
        const saved = localStorage.getItem('jj-viz-layout');
        if (saved) {
            const state = JSON.parse(saved);
            this.layoutMode = state.mode || 'chronological';
            this.pinnedNodes = new Map(state.pinned || []);
            this.bookmarkColors = new Map(state.bookmarkColors || []);
        }
    }

    render() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.hitRegions = []; // Reset hit regions

        this.ctx.save();
        this.ctx.translate(this.offsetX, this.offsetY);
        this.ctx.scale(this.scale, this.scale);

        // Draw lane guides during drag
        if (this.isDraggingNode && this.dragNode) {
            this.drawLaneGuides();
        }

        // Draw connections first
        this.nodes.forEach(node => {
            node.parents.forEach((parentId, idx) => {
                const parent = this.nodes.find(n => n.changeId === parentId);
                if (parent) {
                    this.drawConnection(node, parent, idx);
                }
            });
        });

        // Draw drag preview
        if (this.isDraggingNode && this.dragNode && this.dragCurrentLane !== null) {
            this.drawDragPreview();
        }

        // Draw nodes
        this.nodes.forEach(node => this.drawNode(node));

        this.ctx.restore();

        // Draw HUD/Overlays (not affected by zoom/pan if needed, but here we draw inline so strictly inside restore)
        
        // Rebase Toast if active
        if (this.rebaseSource) {
            this.ctx.save();
            this.ctx.fillStyle = 'rgba(255, 170, 0, 0.9)';
            this.ctx.fillRect(20, 20, 300, 40);
            this.ctx.fillStyle = '#000';
            this.ctx.font = 'bold 14px Inter';
            this.ctx.fillText(`Rebasing ${this.rebaseSource.changeId.substring(0,8)}...`, 30, 45);
            this.ctx.font = '12px Inter';
            this.ctx.fillText(`Click destination node or ESC to cancel`, 180, 45);
            this.ctx.restore();
        }
    }

    getLaneColor(laneIndex: number) {
        return COLORS.lanes[laneIndex % COLORS.lanes.length];
    }

    drawConnection(node: CommitNode, parent: CommitNode, parentIndex: number) {
        this.ctx.beginPath();
        
        // Z-Index / Spacing Simulation
        // If a node has multiple parents (merge), offset the lines slightly
        const OFFSET_STEP = 3;
        const yOffset = (parentIndex * OFFSET_STEP);

        // Origin point (bottom of Node)
        const startX = node.x!;
        const startY = node.y! + NODE_RADIUS + 4 + yOffset; 

        this.ctx.moveTo(startX, startY);
        
        if (node.lane === parent.lane) {
            // Straight line down
            // Target point (top of Parent)
            const targetX = parent.x!;
            const targetY = parent.y! - NODE_RADIUS - 4;
            
            this.ctx.lineTo(targetX, targetY);
            this.ctx.strokeStyle = this.getLaneColor(node.lane!);
        } else {
            // "Circuit Board" Style with Beziers
            // Horizontal then Vertical
            
            const radius = 10; // Corner radius
            
            // Target: Top of Parent's lane
            const targetX = parent.x!;
            // We aim for a point just above the parent
            // But if we have multiple lines coming into parent (not handled here, handled at source),
            // we just aim for parent top.
            const targetY = parent.y! - NODE_RADIUS - 4;
            
            // 1. Horizontal Segment
            // We want to go from startY to targetX, but we need a curve.
            // Move horizontal to (targetX +/- radius)
            
            const direction = targetX > startX ? 1 : -1;
            const cornerX = targetX - (radius * direction);
            
            // If the horizontal distance is too small for the radius, straight line it
            if (Math.abs(targetX - startX) < radius * 2) {
                 this.ctx.lineTo(targetX, startY);
                 this.ctx.lineTo(targetX, targetY);
            } else {
                // Line to start of corner
                this.ctx.lineTo(cornerX, startY);
                
                // Curve down
                // Control point: (targetX, startY)
                // End point: (targetX, startY + radius)
                this.ctx.quadraticCurveTo(targetX, startY, targetX, startY + radius);
                
                // Vertical line to target
                this.ctx.lineTo(targetX, targetY);
            }
            
            this.ctx.strokeStyle = this.getLaneColor(parent.lane!);
        }
        
        this.ctx.lineWidth = 2;
        this.ctx.stroke();
    }

    drawLaneGuides() {
        this.ctx.save();
        this.ctx.globalAlpha = 0.3;

        // Draw guide lines for all possible lanes
        for (let lane = 0; lane <= this.maxLane + 2; lane++) {
            const x = CANVAS_PADDING + ((this.maxLane - lane) * LANE_WIDTH);

            this.ctx.beginPath();
            this.ctx.moveTo(x, -1000);
            this.ctx.lineTo(x, 10000);
            this.ctx.strokeStyle = (lane === this.dragCurrentLane) ? '#00ff9d' : '#444';
            this.ctx.lineWidth = (lane === this.dragCurrentLane) ? 3 : 1;
            this.ctx.setLineDash((lane === this.dragCurrentLane) ? [] : [5, 5]);
            this.ctx.stroke();

            // Draw lane number
            this.ctx.fillStyle = (lane === this.dragCurrentLane) ? '#00ff9d' : '#666';
            this.ctx.font = '10px JetBrains Mono';
            this.ctx.fillText(`L${lane}`, x + 3, 30);
        }

        this.ctx.restore();
    }

    drawDragPreview() {
        if (!this.dragNode || this.dragCurrentLane === null) return;

        const previewX = CANVAS_PADDING + ((this.maxLane - this.dragCurrentLane) * LANE_WIDTH);

        this.ctx.save();
        this.ctx.globalAlpha = 0.4;
        this.ctx.beginPath();
        this.ctx.arc(previewX, this.dragNode.y!, NODE_RADIUS * 2, 0, Math.PI * 2);
        this.ctx.fillStyle = '#00ff9d';
        this.ctx.fill();
        this.ctx.strokeStyle = '#00ff9d';
        this.ctx.lineWidth = 2;
        this.ctx.stroke();

        // Draw "Pin to L{N}" text
        this.ctx.fillStyle = '#00ff9d';
        this.ctx.font = 'bold 11px Inter';
        this.ctx.fillText(`Pin to L${this.dragCurrentLane}`, previewX + 15, this.dragNode.y!);
        this.ctx.restore();
    }

    drawNode(node: CommitNode) {
        const isSelected = this.selectedNodes.has(node.changeId);
        const color = this.getLaneColor(node.lane!);
        
        // Node
        this.ctx.beginPath();
        this.ctx.arc(node.x!, node.y!, NODE_RADIUS + (isSelected ? 3 : 0), 0, Math.PI * 2);
        
        this.ctx.fillStyle = node.isConflict ? COLORS.nodeConflict : '#1a1a1a';
        this.ctx.fill();
        
        this.ctx.strokeStyle = isSelected ? '#fff' : color;
        this.ctx.lineWidth = isSelected ? 3 : 2;
        this.ctx.stroke();

        // Pin indicator
        if (node.isPinned) {
            this.ctx.beginPath();
            this.ctx.arc(node.x! + NODE_RADIUS + 4, node.y! - NODE_RADIUS - 4, 3, 0, Math.PI * 2);
            this.ctx.fillStyle = '#ffa500';
            this.ctx.fill();
        }

        // Dotted connector to text
        if (this.textColumnX) {
            this.ctx.beginPath();
            this.ctx.setLineDash([2, 4]);
            this.ctx.moveTo(node.x! + NODE_RADIUS + 2, node.y!);
            this.ctx.lineTo(this.textColumnX - 10, node.y!);
            this.ctx.strokeStyle = color; // Use lane color for the connector
            this.ctx.lineWidth = 1;
            this.ctx.stroke();
            this.ctx.setLineDash([]); // Reset
        }

        // Label (Change ID)
        this.ctx.fillStyle = isSelected ? '#fff' : COLORS.text;
        this.ctx.font = 'bold 12px JetBrains Mono';
        
        // Operation Target Indicator
        if (this.opMode === 'move' && this.opTargetNode && this.opTargetNode.changeId === node.changeId) {
            // Draw a target ring
            this.ctx.beginPath();
            this.ctx.arc(node.x!, node.y!, NODE_RADIUS + 8, 0, Math.PI * 2);
            this.ctx.strokeStyle = '#00ff9d'; // Green target
            this.ctx.lineWidth = 2;
            this.ctx.setLineDash([4, 4]);
            this.ctx.stroke();
            this.ctx.setLineDash([]);
        }

        // Working Copy Indicator
        if (node.isWorkingCopy) {
            this.ctx.fillStyle = '#00ff9d';
            this.ctx.fillText('@', this.textColumnX - 15, node.y! + 4);
            this.ctx.fillStyle = isSelected ? '#fff' : '#00ff9d'; // Highlight change ID too
        }

        // Draw Change ID at the Text Column start
        this.ctx.fillText(node.changeId.substring(0, 8), this.textColumnX, node.y! + 4);

        // Description
        this.ctx.fillStyle = COLORS.textDesc;
        this.ctx.font = '12px Inter';
        let desc = node.descriptionTitle;
        if (desc.length > 50) desc = desc.substring(0, 47) + "...";
        // Offset description by Change ID width
        this.ctx.fillText(desc, this.textColumnX + 80, node.y! + 4);
        
        const descWidth = this.ctx.measureText(desc).width;

        // Inline Actions Logic
        const showActions = node.isWorkingCopy || (isSelected && this.selectedNodes.size === 1) || node === this.hoveredNode;

        if (showActions) {
            const startX = this.textColumnX + 80 + descWidth + 20;
            let currentX = startX;

            // Edit (Checkout) - Only if not already WC
            if (!node.isWorkingCopy) {
                if (this.isShiftPressed) {
                     this.drawActionButton(currentX, node.y! - 8, "Abandon", () => this.handleAbandon(node));
                } else {
                     this.drawActionButton(currentX, node.y! - 8, "Edit", () => this.handleEdit(node));
                }
                currentX += 50;
            }

            // New vs Squash
            if (this.isShiftPressed) {
                this.drawActionButton(currentX, node.y! - 8, "Squash", () => this.handleSquash(node));
            } else {
                this.drawActionButton(currentX, node.y! - 8, "New", () => this.handleNew(node));
            }
            currentX += 50;

            // Desc vs Restore? (Keep Desc for now)
            this.drawActionButton(currentX, node.y! - 8, "Desc", () => this.handleDescribe(node));
            currentX += 50;

            // Rebase vs Duplicate
            if (this.isShiftPressed) {
                this.drawActionButton(currentX, node.y! - 8, "Dupe", () => this.handleDuplicate(node));
            } else {
                this.drawActionButton(currentX, node.y! - 8, "Rebase", () => this.handleRebaseStart(node));
            }
            currentX += 50;
            
            // Toggle Files Button
            const isFilesOpen = this.expandedFilesNode === node.changeId;
            this.drawActionButton(currentX, node.y! - 8, isFilesOpen ? "Hide" : "Files", () => this.handleFilesToggle(node));
        }

        // Inline Files Rendering
        if (this.expandedFilesNode === node.changeId) {
            this.drawInlineFiles(node);
        }

        // Combined bookmarks and git branches display
        const allRefs = [...(node.bookmarks || []), ...(node.gitBranches || [])];
        if (allRefs.length > 0) {
            let pillX = this.textColumnX;
            const pillY = node.y! - 22;

            // Draw jj bookmarks first
            node.bookmarks.forEach((bookmark, idx) => {
                this.ctx.font = '10px Inter';
                const metrics = this.ctx.measureText(bookmark);
                const pillWidth = metrics.width + 12;

                // Cyan pill for jj bookmarks
                this.ctx.fillStyle = 'rgba(0, 240, 255, 0.15)';
                this.ctx.fillRect(pillX, pillY, pillWidth, 16);
                this.ctx.strokeStyle = '#00f0ff';
                this.ctx.lineWidth = 1;
                this.ctx.strokeRect(pillX, pillY, pillWidth, 16);

                this.ctx.fillStyle = '#00f0ff';
                this.ctx.fillText(bookmark, pillX + 6, pillY + 12);

                pillX += pillWidth + 5;
            });

            // Draw git branches
            node.gitBranches?.forEach(branch => {
                this.ctx.font = '10px Inter';
                const metrics = this.ctx.measureText(branch);
                const pillWidth = metrics.width + 12;

                // Orange pill for git branches
                this.ctx.fillStyle = 'rgba(255, 170, 0, 0.15)';
                this.ctx.fillRect(pillX, pillY, pillWidth, 16);
                this.ctx.strokeStyle = '#ffaa00';
                this.ctx.lineWidth = 1;
                this.ctx.strokeRect(pillX, pillY, pillWidth, 16);

                this.ctx.fillStyle = '#ffaa00';
                this.ctx.fillText(branch, pillX + 6, pillY + 12);

                pillX += pillWidth + 5;
            });
        }
    }

    drawInlineFiles(node: CommitNode) {
        const files = this.cachedFiles.get(node.changeId);
        if (!files) return;

        // Align files with text column
        const startX = this.textColumnX + 20;
        let currentY = node.y! + 20;

        this.ctx.font = '11px JetBrains Mono';
        
        files.forEach(f => {
            const typeColor = f.type === 'A' ? '#00ff9d' : f.type === 'D' ? '#ff0055' : '#00aaff';
            
            this.ctx.fillStyle = typeColor;
            this.ctx.fillText(f.type, startX, currentY);
            
            this.ctx.fillStyle = '#aaa';
            this.ctx.fillText(f.path, startX + 20, currentY);
            
            currentY += 14;
        });
    }

    async handleFilesToggle(node: CommitNode) {
        if (this.expandedFilesNode === node.changeId) {
            // Close
            this.expandedFilesNode = null;
            node.extraHeight = 0;
            this.recalculateLayout();
            this.render();
            return;
        }

        // Open
        if (!this.cachedFiles.has(node.changeId)) {
            try {
                const res = await fetch(`/api/files/${node.changeId}`);
                const files = await res.json();
                this.cachedFiles.set(node.changeId, files);
            } catch (e) {
                console.error("Failed to fetch files", e);
                return;
            }
        }

        const files = this.cachedFiles.get(node.changeId)!;
        // Calculate needed height
        // 14px per file + 10px padding
        node.extraHeight = (files.length * 14) + 10;
        
        // Close others? For now let's allow single expansion to simplify logic, or handle multiple?
        // Let's close others to keep layout simple
        if (this.expandedFilesNode && this.expandedFilesNode !== node.changeId) {
            const oldNode = this.nodes.find(n => n.changeId === this.expandedFilesNode);
            if (oldNode) oldNode.extraHeight = 0;
        }
        
        this.expandedFilesNode = node.changeId;
        this.recalculateLayout();
        this.render();
    }

    recalculateLayout() {
        // Find max lane for alignment
        this.maxLane = 0;
        this.nodes.forEach(n => this.maxLane = Math.max(this.maxLane, n.lane || 0));

        // Align Base (Lane 0) to the RIGHT, branches extend LEFT
        // Formula: x = PADDING + (maxLane - lane) * LANE_WIDTH
        // Actually user wants Base (Lane 0) closest to text column
        
        // Let's set the "Trunk Line" (Lane 0) at a fixed offset from the left to ensure room for branches?
        // No, user said "branches left aligned from base tree".
        // This implies: [Left: Branch N ... Branch 1] [Right: Base Tree] [Text Column]
        
        const graphWidth = (this.maxLane + 1) * LANE_WIDTH;
        
        // To keep Lane 0 at the "Rightmost" position of the graph area:
        // Lane 0 X = CANVAS_PADDING + (maxLane * LANE_WIDTH)
        // Lane N X = CANVAS_PADDING + (0 * LANE_WIDTH)
        // So: x = CANVAS_PADDING + ((maxLane - lane) * LANE_WIDTH)
        
        this.textColumnX = CANVAS_PADDING + graphWidth + TEXT_COLUMN_GAP;

        let currentY = CANVAS_PADDING;
        this.nodes.forEach(node => {
            // Inverted X axis for "Graph grows Left"
            node.x = CANVAS_PADDING + ((this.maxLane - (node.lane || 0)) * LANE_WIDTH);
            node.y = currentY;
            currentY += Y_SPACING + (node.extraHeight || 0);
        });
    }

    drawActionButton(x: number, y: number, label: string, onClick: () => void) {
        const width = 40;
        const height = 18;
        const padding = 4;
        
        // Check hover state
        // We need to map world coords back to screen coords to check mouse pos in the event handler?
        // NO: The HitRegion store checks against world coords because we store the *transformed* coords?
        // Actually, easiest is to store WORLD coords in HitRegion, and transform mouse to World during check.
        
        // Draw Button
        this.ctx.fillStyle = '#333';
        this.ctx.strokeStyle = '#666';
        
        // Simple hit check for immediate hover effect during render? 
        // No, render is driven by state. We let the mousemove handler trigger re-renders if needed.
        // For now, simple gray buttons.
        
        this.ctx.beginPath();
        this.ctx.roundRect(x, y, width, height, 4);
        this.ctx.fill();
        this.ctx.stroke();
        
        this.ctx.fillStyle = '#fff';
        this.ctx.font = '10px Inter';
        this.ctx.fillText(label, x + padding, y + 12);

        // Register Hit Region
        this.hitRegions.push({
            x, y, w: width, h: height,
            cursor: 'pointer',
            onClick
        });
    }

    async handleNew(node: CommitNode) {
        if (!confirm(`Create new commit from ${node.changeId.substring(0,8)}?`)) return;
        await fetch('/api/new', {
            method: 'POST',
            body: JSON.stringify({ parentId: node.changeId })
        });
        this.fetchData();
    }

    async handleEdit(node: CommitNode) {
        if (!confirm(`Edit (checkout) ${node.changeId.substring(0,8)}?`)) return;
        
        try {
            const res = await fetch('/api/edit', {
                method: 'POST',
                body: JSON.stringify({ changeId: node.changeId })
            });
            if (!res.ok) throw new Error(await res.text());
            this.fetchData();
        } catch (e) {
            alert("Edit failed: " + e);
        }
    }

    async handleDescribe(node: CommitNode) {
        const newDesc = prompt("Enter new description:", node.descriptionFull);
        if (newDesc === null || newDesc === node.descriptionFull) return;
        
        await fetch('/api/describe', {
            method: 'POST',
            body: JSON.stringify({ changeId: node.changeId, description: newDesc })
        });
        this.fetchData();
    }

    handleRebaseStart(node: CommitNode) {
        this.rebaseSource = node;
        this.render(); // Trigger toast
    }

    async handleAbandon(node: CommitNode) {
        if (!confirm(`Abandon revision ${node.changeId.substring(0,8)}?`)) return;
        try {
            const res = await fetch('/api/abandon', {
                method: 'POST',
                body: JSON.stringify({ changeId: node.changeId })
            });
            if (!res.ok) throw new Error(await res.text());
            this.fetchData();
        } catch (e) {
            alert("Abandon failed: " + e);
        }
    }

    async handleSquash(node: CommitNode) {
        // For merge commits (multiple parents), we need to specify which parent to squash into
        const parentIds = node.parents.filter(p => p && p !== '');
        let intoParent: string | undefined;

        if (parentIds.length > 1) {
            // Merge commit - default to first parent, or let user pick
            intoParent = parentIds[0];
            if (!confirm(`Squash merge ${node.changeId.substring(0,8)} into parent ${intoParent.substring(0,8)}?`)) return;
        } else if (parentIds.length === 1) {
            if (!confirm(`Squash ${node.changeId.substring(0,8)} into parent?`)) return;
            intoParent = parentIds[0];
        } else {
            alert("Cannot squash: no parent commit");
            return;
        }

        try {
            const res = await fetch('/api/squash', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    changeId: node.changeId,
                    into: intoParent
                })
            });
            if (!res.ok) throw new Error(await res.text());
            // Small delay to ensure jj operations complete before refreshing
            setTimeout(() => this.fetchData(), 100);
        } catch (e) {
            alert("Squash failed: " + e);
        }
    }

    async handleDuplicate(node: CommitNode) {
         if (!confirm(`Duplicate revision ${node.changeId.substring(0,8)}?`)) return;
         try {
            const res = await fetch('/api/duplicate', {
                method: 'POST',
                body: JSON.stringify({ changeId: node.changeId })
            });
            if (!res.ok) throw new Error(await res.text());
            this.fetchData();
         } catch (e) {
            alert("Duplicate failed: " + e);
         }
    }

    async handleRebaseExec(destination: CommitNode) {
        if (!this.rebaseSource) return;
        
        if (!confirm(`Rebase ${this.rebaseSource.changeId.substring(0,8)} onto ${destination.changeId.substring(0,8)}?`)) {
            this.rebaseSource = null;
            this.render();
            return;
        }

        try {
            const res = await fetch('/api/rebase', {
                method: 'POST',
                body: JSON.stringify({ 
                    sourceId: this.rebaseSource.changeId, 
                    destinationId: destination.changeId 
                })
            });
            if (!res.ok) throw new Error(await res.text());
            this.rebaseSource = null;
            this.fetchData();
        } catch (e) {
            alert("Rebase failed: " + e);
            this.rebaseSource = null;
            this.render();
        }
    }

    setupInteractions() {
        // Prevent default context menu on canvas (we use right-click for pin toggle)
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        this.canvas.addEventListener('mousedown', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            
            // World coordinates
            const worldX = (mouseX - this.offsetX) / this.scale;
            const worldY = (mouseY - this.offsetY) / this.scale;

            // Check Hit Regions (Buttons) first!
            // Reverse order to catch top-most first
            for (let i = this.hitRegions.length - 1; i >= 0; i--) {
                const r = this.hitRegions[i];
                if (worldX >= r.x && worldX <= r.x + r.w &&
                    worldY >= r.y && worldY <= r.y + r.h) {
                    r.onClick();
                    return; // Stop propagation
                }
            }

            // Node Click Check
            const clickedNode = this.nodes.find(n => {
                const dx = n.x! - worldX;
                const dy = n.y! - worldY;
                return Math.sqrt(dx*dx + dy*dy) < NODE_RADIUS * 3;
            });

        if (clickedNode) {
            // Alt+Click to drag node to different lane
            if (e.altKey) {
                e.preventDefault();
                this.isDraggingNode = true;
                this.dragNode = clickedNode;
                this.dragStartX = worldX;
                this.dragCurrentLane = clickedNode.lane!;
                return;
            }

            // Right-click to toggle pin
            if (e.button === 2) {
                e.preventDefault();
                if (clickedNode.isPinned) {
                    this.unpinNode(clickedNode.changeId);
                } else {
                    this.pinNode(clickedNode.changeId, clickedNode.lane!);
                }
                return;
            }

            if (this.rebaseSource) {
                this.handleRebaseExec(clickedNode);
            } else {
                const isMulti = e.ctrlKey || e.metaKey;
                this.selectNode(clickedNode, isMulti);
            }
            return;
        }

            // Drag Start
            this.isDragging = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
        });

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Shift') {
                this.isShiftPressed = true;
                this.render();
            }
            if (e.key === 'Escape') {
                if (this.rebaseSource) {
                    this.rebaseSource = null;
                    this.render();
                }
                if (this.isDraggingNode) {
                    this.isDraggingNode = false;
                    this.dragNode = null;
                    this.dragCurrentLane = null;
                    this.render();
                }
            }
        });

        window.addEventListener('keyup', (e) => {
            if (e.key === 'Shift') {
                this.isShiftPressed = false;
                this.render();
            }
        });

        window.addEventListener('mousemove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const worldX = (mouseX - this.offsetX) / this.scale;
            const worldY = (mouseY - this.offsetY) / this.scale;

            // Handle node dragging
            if (this.isDraggingNode && this.dragNode) {
                // Calculate which lane the mouse is over
                // x = CANVAS_PADDING + ((maxLane - lane) * LANE_WIDTH)
                // Solve for lane: lane = maxLane - ((x - CANVAS_PADDING) / LANE_WIDTH)
                const laneFloat = this.maxLane - ((worldX - CANVAS_PADDING) / LANE_WIDTH);
                const lane = Math.max(0, Math.round(laneFloat));

                if (this.dragCurrentLane !== lane) {
                    this.dragCurrentLane = lane;
                    this.render(); // Re-render to show preview
                }
                this.canvas.style.cursor = 'grabbing';
                return;
            }

            // Row Hover Detection (for Tooltip visibility)
            // Check if mouse Y is close to any node's Y
            const HOVER_THRESHOLD_Y = 20; // Half spacing roughly
            const foundNode = this.nodes.find(n => Math.abs(n.y! - worldY) < HOVER_THRESHOLD_Y);

            // Only trigger if we changed hovered node
            if (this.hoveredNode !== (foundNode || null)) {
                this.hoveredNode = foundNode || null;
                this.render(); // Re-render to show/hide buttons
            }

            // Hit Region Hover Check
            let cursor = 'default';
            for (const r of this.hitRegions) {
                 if (worldX >= r.x && worldX <= r.x + r.w &&
                    worldY >= r.y && worldY <= r.y + r.h) {
                    cursor = r.cursor;
                    break;
                }
            }
            this.canvas.style.cursor = cursor;

            if (this.isDragging) {
                this.offsetX += e.clientX - this.lastMouseX;
                this.offsetY += e.clientY - this.lastMouseY;
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
                this.render();
            }
        });


        window.addEventListener('mouseup', () => {
            if (this.isDraggingNode && this.dragNode && this.dragCurrentLane !== null) {
                this.pinNode(this.dragNode.changeId, this.dragCurrentLane);
            }
            this.isDragging = false;
            this.isDraggingNode = false;
            this.dragNode = null;
            this.dragCurrentLane = null;
        });

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const zoomSensitivity = 0.001;
            
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            const worldX = (mouseX - this.offsetX) / this.scale;
            const worldY = (mouseY - this.offsetY) / this.scale;

            this.scale -= e.deltaY * zoomSensitivity;
            this.scale = Math.max(0.1, Math.min(this.scale, 5));

            this.offsetX = mouseX - (worldX * this.scale);
            this.offsetY = mouseY - (worldY * this.scale);

            this.render();
        });
    }

    selectNode(node: CommitNode, isMulti: boolean = false) {
        // If in 'move' mode and we click a DIFFERENT node, that is the target
        if (this.opMode === 'move' && this.selectedNodes.size === 1 && !this.selectedNodes.has(node.changeId)) {
             this.opTargetNode = node;
             this.render(); // Re-render to show selection
             const firstId = this.selectedNodes.values().next().value;
             this.updateDetailsPanel(this.nodes.find(n => n.changeId === firstId)!);
             return;
        }

        if (isMulti) {
            // Toggle
            if (this.selectedNodes.has(node.changeId)) {
                this.selectedNodes.delete(node.changeId);
            } else {
                this.selectedNodes.add(node.changeId);
            }
        } else {
            // Replace
            this.selectedNodes.clear();
            this.selectedNodes.add(node.changeId);
        }

        this.resetOpMode();
        this.render();
        this.updateDetailsPanel(node); // Show details for LAST clicked
    }

    async handleMerge(parents: string[]) {
        if (!confirm(`Create merge commit from ${parents.length} parents?`)) return;
        try {
            const res = await fetch('/api/new', {
                method: 'POST',
                body: JSON.stringify({ parentIds: parents })
            });
            if (!res.ok) throw new Error(await res.text());
            this.fetchData();
        } catch (e) {
            alert("Merge failed: " + e);
        }
    }

    resetOpMode() {
        this.opMode = 'none';
        this.opSelectedPaths.clear();
        this.opTargetNode = null;
    }

    setOpMode(mode: 'split' | 'squash' | 'move') {
        if (this.selectedNodes.size !== 1) return;
        this.opMode = mode;
        this.opSelectedPaths.clear();
        this.opTargetNode = null;
        
        const firstId = this.selectedNodes.values().next().value;
        this.updateDetailsPanel(this.nodes.find(n => n.changeId === firstId)!);
    }

    toggleOpFile(path: string) {
        if (this.opSelectedPaths.has(path)) {
            this.opSelectedPaths.delete(path);
        } else {
            this.opSelectedPaths.add(path);
        }
        if (this.selectedNodes.size === 1) {
            const firstId = this.selectedNodes.values().next().value;
            this.updateDetailsPanel(this.nodes.find(n => n.changeId === firstId)!);
        }
    }

    async executeOp() {
        if (this.selectedNodes.size !== 1) return;
        const firstId = this.selectedNodes.values().next().value;
        const node = this.nodes.find(n => n.changeId === firstId)!;

        const paths = Array.from(this.opSelectedPaths);

        if (this.opMode === 'split') {
            if (paths.length === 0) return alert("Select at least one file to split.");
            if (!confirm(`Split ${paths.length} files into a parent commit?`)) return;
            await this.apiCall('/api/split', { changeId: node.changeId, paths });
        } 
        else if (this.opMode === 'squash') {
            // Squash INTO parent (default behavior of our button)
            if (!confirm(`Squash ${paths.length > 0 ? paths.length + ' files' : 'ALL changes'} into parent?`)) return;
            // If paths empty, squash all. If paths, squash paths.
            await this.apiCall('/api/squash', { changeId: node.changeId, paths });
        }
        else if (this.opMode === 'move') {
            if (!this.opTargetNode) return alert("Select a target node from the graph to move changes to.");
            if (!confirm(`Move ${paths.length > 0 ? paths.length + ' files' : 'ALL changes'} to ${this.opTargetNode.changeId.substring(0,8)}?`)) return;
            
            await this.apiCall('/api/squash', { 
                changeId: node.changeId, // From
                intoId: this.opTargetNode.changeId,   // Into
                paths 
            });
        }

        this.resetOpMode();
        this.fetchData();
    }
    
    async apiCall(url: string, body: any) {
        try {
            const res = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
            if (!res.ok) throw new Error(await res.text());
        } catch (e) {
            alert("Operation failed: " + e);
            throw e; // Stop execution
        }
    }

    async updateDetailsPanel(node: CommitNode) {
        const panel = document.getElementById('detailsPanel');
        if (!panel) return;

        // MULTI-SELECT VIEW
        if (this.selectedNodes.size > 1) {
            const count = this.selectedNodes.size;
            panel.innerHTML = `
                <div class="commit-detail">
                    <div class="detail-header">
                        <span class="change-id" style="color: #fff">Multi-Select</span>
                        <div class="meta-row">
                             <span class="badge" style="background: #444">${count} Commits</span>
                        </div>
                    </div>
                    
                    <div style="margin: 20px 0;">
                        <button id="btnMerge" class="btn-confirm" style="width: 100%; padding: 12px; font-size: 14px;">
                            Merge These Commits (Octopus)
                        </button>
                    </div>

                    <div class="description" style="color: #888; font-style: italic;">
                        Selected:
                        <ul style="padding-left: 20px; margin-top: 10px;">
                            ${Array.from(this.selectedNodes).map(id => `<li>${id.substring(0,8)}</li>`).join('')}
                        </ul>
                    </div>
                </div>
            `;
            this.bindOpsButtons();
            return;
        }

        // SINGLE SELECT VIEW
        const bookmarksHtml = node.bookmarks.map(b => `<span class="badge bookmark">${b}</span>`).join('');
        const conflictHtml = node.isConflict ? `<span class="badge conflict">Conflict</span>` : '';
        const emptyHtml = node.isEmpty ? `<span class="badge empty">Empty</span>` : '';

        // Initial render with metadata
        panel.innerHTML = `
            <div class="commit-detail">
                <div class="detail-header">
                    <span class="change-id" style="color: ${this.getLaneColor(node.lane!)}">${node.changeId}</span>
                    <span class="commit-hash">${node.commitId}</span>
                    <div class="meta-row">
                        ${bookmarksHtml}
                        ${conflictHtml}
                        ${emptyHtml}
                    </div>
                </div>

                <div class="description">${node.descriptionFull || '(No description)'}</div>

                <div class="meta-list">
                    <div class="kv-pair">
                        <span class="label">Author</span>
                        <span class="value">${node.author}</span>
                    </div>
                    <div class="kv-pair">
                        <span class="label">Date</span>
                        <span class="value">${new Date(node.time).toLocaleString()}</span>
                    </div>
                </div>
                
                <!-- Operation Toolbar -->
                <div class="ops-toolbar" style="margin: 15px 0; border-top: 1px solid #444; padding-top: 10px;">
                    ${this.renderOpsToolbar()}
                </div>

                <div class="files-section">
                     <h3>Files ${this.opMode !== 'none' ? '(Select to include)' : ''}</h3>
                     <div id="fileList" class="file-list">Loading files...</div>
                </div>

                <div class="diff-section">
                    <h3>Diff</h3>
                    <div id="diffContent" class="diff-content">Loading diff...</div>
                </div>
            </div>
        `;
        
        // Bind Buttons
        this.bindOpsButtons();

        // Fetch Files & Diff (Shared logic)
        this.loadFilesAndDiff(node);
    }
    
    renderOpsToolbar() {
        if (this.opMode === 'none') {
            return `
                <div style="display:flex; gap:8px; flex-wrap:wrap;">
                    <button id="btnModeSplit" class="btn-op">Split...</button>
                    <button id="btnModeSquash" class="btn-op">Squash...</button>
                    <button id="btnModeMove" class="btn-op">Move...</button>
                </div>
            `;
        }

        let actionText = "Confirm";
        let instruction = "";
        
        if (this.opMode === 'split') {
            actionText = `Split (${this.opSelectedPaths.size})`;
            instruction = "Select files to move to parent";
        } else if (this.opMode === 'squash') {
            actionText = `Squash (${this.opSelectedPaths.size || 'All'})`;
            instruction = "Into Parent";
        } else if (this.opMode === 'move') {
            const targetName = this.opTargetNode ? this.opTargetNode.changeId.substring(0,8) : "Select Node...";
            actionText = `Move to ${targetName}`;
            instruction = this.opTargetNode ? "Ready" : "Click target node in graph";
        }

        return `
            <div class="op-active-panel" style="background: #222; padding: 10px; border-radius: 6px; border: 1px solid #555;">
                <div style="font-size: 11px; color: #aaa; margin-bottom: 8px; text-transform: uppercase; font-weight: bold;">
                    Mode: ${this.opMode}
                </div>
                <div style="font-size: 12px; color: #fff; margin-bottom: 8px;">
                    ${instruction}
                </div>
                <div style="display:flex; gap:8px;">
                    <button id="btnOpConfirm" class="btn-confirm">${actionText}</button>
                    <button id="btnOpCancel" class="btn-cancel">Cancel</button>
                </div>
            </div>
        `;
    }
    
    bindOpsButtons() {
        document.getElementById('btnModeSplit')?.addEventListener('click', () => this.setOpMode('split'));
        document.getElementById('btnModeSquash')?.addEventListener('click', () => this.setOpMode('squash'));
        document.getElementById('btnModeMove')?.addEventListener('click', () => this.setOpMode('move'));
        
        document.getElementById('btnOpConfirm')?.addEventListener('click', () => this.executeOp());
        document.getElementById('btnOpCancel')?.addEventListener('click', () => {
             this.resetOpMode();
             const firstId = this.selectedNodes.values().next().value;
             if (firstId) this.updateDetailsPanel(this.nodes.find(n => n.changeId === firstId)!);
        });

        // Merge Button Bind
        document.getElementById('btnMerge')?.addEventListener('click', () => {
            const parents = Array.from(this.selectedNodes);
            this.handleMerge(parents);
        });
    }

    async loadFilesAndDiff(node: CommitNode) {
        // ... (Similar to previous, but using this.opMode)
        // Refactored to separate method to clean up updateDetailsPanel
        
        // Files
        try {
            const res = await fetch(`/api/files/${node.changeId}`);
            const files = await res.json();
            const fileListEl = document.getElementById('fileList');
            if (fileListEl) {
                if (files.length === 0) {
                     fileListEl.textContent = "No files changed";
                } else {
                     fileListEl.innerHTML = files.map((f: any) => {
                        const isChecked = this.opSelectedPaths.has(f.path);
                        const isInteractive = this.opMode !== 'none';
                        
                        const checkbox = isInteractive ? 
                            `<input type="checkbox" class="file-check" data-path="${f.path}" ${isChecked ? 'checked' : ''} style="margin-right:8px;">` 
                            : '';
                        
                        return `
                        <div class="file-item" style="cursor: ${isInteractive ? 'pointer' : 'default'}">
                            ${checkbox}
                            <span class="file-type ${f.type}">${f.type}</span>
                            <span class="file-path">${f.path}</span>
                        </div>
                     `}).join('');
                     
                     // Bind Clicks
                     if (this.opMode !== 'none') {
                         fileListEl.querySelectorAll('.file-item').forEach(el => {
                             el.addEventListener('click', (e) => {
                                 const checkbox = el.querySelector('.file-check') as HTMLInputElement;
                                 if (checkbox) {
                                     const path = checkbox.getAttribute('data-path')!;
                                     if (e.target !== checkbox) this.toggleOpFile(path);
                                 }
                             });
                             el.querySelector('.file-check')?.addEventListener('click', (e) => {
                                 e.stopPropagation();
                                 const path = (e.target as HTMLInputElement).getAttribute('data-path')!;
                                 this.toggleOpFile(path);
                             });
                         });
                     }
                }
            }
        } catch(e) { /* Error handling */ }

        // Diff
        try {
            const res = await fetch(`/api/diff/${node.changeId}`);
            const diffText = await res.text();
            const diffEl = document.getElementById('diffContent');
            if (diffEl) {
                 if (diffText.trim()) diffEl.textContent = diffText;
                 else {
                     diffEl.textContent = "No changes";
                     diffEl.style.color = "#666";
                     diffEl.style.fontStyle = "italic";
                 }
            }
        } catch (e) { /* Error handling */ }
    }
}

// Init
new GraphVisualizer();
