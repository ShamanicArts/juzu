# JJ-Viz Styling Plan (Web -> TUI -> Parity)

Date: 2026-02-06
Scope: Visual/interaction styling only (no major behavior changes)

## Progress

- S1: complete (shared tokens, chrome baseline, separators, status-bar flicker fix without changing key order/behavior)
- S2: complete (top bar kept structurally stable with right-rail view switching, collapsible sidebar sections, bottom status bar with contextual hints, 720p responsiveness fixes)
- S3: complete (redo delivered: no aggressive visual shifts; graph palette/texture exposed as tweakable tokens)
- S4: complete (adaptive modal status rows, concise hints, and sidebar detail summarization)
- S5: complete (verified: selector highlight now applies only to selected commit text; removed confusing adjacent-row text highlight while preserving branch color readability)
- S6: complete (copy/terminology parity and readability sanity pass completed; follow-up web↔TUI visual alignment go-over recommended)

## Goals

- Shift from futuristic look to a utilitarian, polished "canvas cockpit" style.
- Align web and TUI chrome and hierarchy with high parity.
- Keep interaction modal clarity high while reducing visual noise.
- Preserve quick information access with progressive disclosure.
- Use minimal meaningful motion only.

## Direction Summary (from review)

- Web:
  - Strong canvas-first experience.
  - Keep dot graph texture, remove blue/cyan futuristic bias.
  - Top/bottom bars should feel closer to TUI structure.
  - Sidebar should be more compact and more feature-rich, with collapsible sections.
  - Confirmations and operational flows should be integrated and non-distracting.
- TUI:
  - Keep current style family, but make it cleaner, more polished, and more modal.
  - Improve graph rendering semantics (selection, branch emphasis, mainline readability).
  - Status area can use multiple rows as needed, especially on narrow terminals.
  - Sidebar emphasizes always-on essentials; long details collapse/summarize.
- Cross-surface:
  - High parity for hierarchy, separators, accent rules, and status semantics.
  - Theme system later; for now use slate-first + semantic/subtle accents.

---

## Phase S1 - Shared Visual System Foundation

### S1.1 Tokens and scales
- Introduce/normalize shared design tokens for:
  - slate ramps (background, panels, borders)
  - semantic colors (success/warn/error/info)
  - spacing scale and radii
  - separator intensity and contrast

### S1.2 Chrome parity baseline
- Align top/bottom bar structure vocabulary across web and TUI:
  - mode
  - context
  - actions
  - status

### S1.3 Separator system
- Standardize vertical/horizontal separators:
  - main canvas vs sidebar
  - view switch region
  - card boundaries and inner dividers

Exit criteria:
- Shared token language exists and is used by both surfaces.
- No obvious blue/cyan bias remains in foundational chrome.

---

## Phase S2 - Web Layout and Interaction Polish

### S2.1 Top bar restructure
- Rebuild into clear zones:
  - Left: app identity, mode, context
  - Center: view controls + revset/filter
  - Right: global actions (refresh/fetch/push/undo/redo) + status

### S2.2 Sidebar redesign
- Convert to sectioned/collapsible information architecture:
  - Essentials (always visible)
  - Actions
  - Bookmarks/sync
  - Files/restore
  - Diff details
- Compact presentation with better rhythm and lower visual clutter.

### S2.3 Confirmation integration
- Keep in-app confirmations, but tune them to feel embedded in workflow.
- Ensure destructive prompts are contextual and non-jarring.

### S2.4 Motion pass
- Add only short, meaningful transitions for expand/collapse and context shifts.

Exit criteria:
- Sidebar is both denser in utility and cleaner in default presentation.
- Top bar logic is obvious and operation-level actions are clearly global.

---

## Phase S3 - Web Canvas Readability Pass

### S3.1 Background and contrast
- Keep current dot texture style.
- Retune to slate/neutral contrast so graph content dominates.

### S3.2 Node/link emphasis
- Improve hierarchy for:
  - selected node
  - active flow/mainline understanding
  - branch differentiation without gaudy color

### S3.3 Graph semantic colors
- Use restrained semantic colors for state signals only.
- Remove decorative color usage that does not communicate meaning.

Exit criteria:
- Selection and branch context are immediately legible.
- Canvas no longer feels stylistically disconnected from TUI.

---

## Phase S4 - TUI Modal Status and Layout Polish

### S4.1 Status area model
- Make status bar row count adaptive to width/mode.
- Show concise key hints by default.
- Overflow hints into additional rows as needed (modal-first).

### S4.2 Mode clarity
- Ensure active mode and next actions are visually explicit.
- Keep status text readable even when key hints expand.

### S4.3 Sidebar essentials
- Keep always-on essentials pinned.
- Collapse/summarize long details unless focused/expanded.

Exit criteria:
- No clipped/confusing key-hint presentation on small widths.
- Modal operations remain clear under constrained terminal sizes.

---

## Phase S5 - TUI Graph Semantics and Highlighting

### S5.1 Mainline/branch rendering review
- Revisit dotted/gray logic for mainline and branch emphasis.
- Ensure highlighted branch/selection semantics are intuitive.

### S5.2 Selection context clarity
- Remove ambiguous gray-above-selection behavior.
- Improve visual explanation of relationship between selected node and neighbors.

### S5.3 Subtle mode color accents
- Apply semantic + subtle mode color cues (non-noisy).

Exit criteria:
- Graph communicates state transitions and selection context clearly.
- Highlight semantics feel intentional and predictable.

---

## Phase S6 - Cross-Surface Parity and Final Polish

### S6.1 Parity checklist
- Validate parity across web and TUI for:
  - chrome hierarchy
  - separators
  - semantic accents
  - confirmation tone and copy

### S6.2 Copy and interaction pass
- Tighten labels, hints, and microcopy for consistency and scanability.

### S6.3 Accessibility/readability sanity
- Verify contrast and focus/readability at common window sizes.

Exit criteria:
- Web and TUI feel like one product family.
- No major visual incoherence or interaction wording drift.

---

## JJ Execution Strategy

- One scoped JJ change per phase (or large subphase):
  1. `style(core): shared tokens and chrome parity baseline`
  2. `style(web): top bar and collapsible sidebar redesign`
  3. `style(web): canvas hierarchy and semantic contrast`
  4. `style(tui): adaptive modal status area and concise hints`
  5. `style(tui): graph semantics and selection clarity`
  6. `style(parity): cross-surface consistency and copy pass`

Rules:
- Keep behavior changes out unless required for layout/readability.
- Keep each change describable as one clear visual intent.

### JJ Workflow Protocol (Required)

- Use JJ-native workflow only (no Git-first flow for local change management).
- At the start of each phase:
  - `jj status`
  - `jj log -n 10`
- Create one scoped change per phase/subphase:
  - `jj new -m "<phase intent>"`
- Keep the change description aligned with intent as work evolves:
  - `jj describe -m "..."`
- Validate before moving to next stacked change:
  - `bun test`
  - `bun run cli.ts --help`
  - `bun run server.ts --help`
- After each phase, confirm stack shape and working copy:
  - `jj status`
  - `jj log -n 10`
- Preserve stack hygiene:
  - do not mix unrelated styling concerns in one change
  - keep web and TUI styling steps separately scoped unless in explicit parity pass
- Safety constraints:
  - avoid destructive VCS shortcuts
  - do not switch to ad-hoc Git commit workflow for phase execution
  - keep conflict-resolve/editor integration deferred unless explicitly re-scoped

---

## Validation at Every Step

- Automated:
  - `bun test`
  - `bun run cli.ts --help`
  - `bun run server.ts --help`
- Manual checkpoints:
  - After S2/S3: web information density, collapsible flow, canvas readability.
  - After S4/S5: TUI small-width status behavior and graph comprehension.
  - After S6: parity review across both surfaces.

---

## Explicit Deferrals

- Conflict resolve/editor-integrated workflow remains deferred.
- Full theme system remains future work (this plan prepares token structure only).
