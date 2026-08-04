# Product

## Register

product

## Users

Jujutsu users working inside active repositories, especially developers who need
to understand nonlinear history quickly and move between inspection and revision
work without translating JJ concepts into a Git-shaped interface. They use Juzu
for focused repository work on desktop terminals and in a local browser.

## Product Purpose

Juzu makes JJ history spatial, legible, and actionable. Success means a user can
locate the working copy, understand parent and branch relationships, inspect the
selected change and its files, and move confidently into an operation without
losing context. The TUI is canonical; the browser adds a larger visual workspace
without changing the underlying repository model.

## Brand Personality

Precise, calm, technical. Dense information should feel deliberate rather than
crowded. Visual personality comes from graph structure, restrained lane color,
and terminal-adjacent typography, not decoration.

## Anti-references

- Generic SaaS dashboards built from interchangeable metric cards
- Marketing copy, architecture narration, or implementation status in the work surface
- Neon cyberpunk styling that overwhelms repository state
- Git clients that hide or rename JJ-native concepts
- Low-density layouts that force scrolling to inspect ordinary history

## Design Principles

1. The graph is the workspace, not an illustration beside the workspace.
2. Selection preserves context: details, files, and diffs follow one visible change.
3. Progressive detail keeps dense history scannable without hiding useful depth.
4. Keyboard and pointer workflows receive equal care and visible focus.
5. Live updates preserve selection and viewport whenever the underlying change survives.
6. Workspace identity is explicit; human or agent activity must attach to a named workspace, never be guessed from file churn.

## Accessibility & Inclusion

Target WCAG AA contrast for text and controls. Every essential pointer action
must have a keyboard path, focus must remain visible, and state must never rely
on color alone. Respect reduced-motion preferences and avoid motion that does not
communicate state.
