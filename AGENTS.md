# AGENTS.md - Agent Guidelines for Juzu

## Build, Test, and Development Commands

```bash
# Run all tests
bun test

# Run tests in watch mode
bun test --watch

# Run a single test file
bun test src/core/__tests__/state.test.ts

# Run tests matching a pattern
bun test src/core/__tests__/state

# Run tests with only certain test names
bun test -t "nodes and layout mode update"

# Start web UI server
bun run server.ts
bun run cli.ts

# Start TUI
bun run cli.ts --tui
bun run cli.ts -t

# Export config/themes
bun run config:export
bun run themes:export
```

## Code Style Guidelines

### Imports

- Use ES6 imports (`import { } from ""`)
- Group imports in this order: external libraries, internal modules (relative paths)
- Prefer named exports, use `export function`/`export const` declarations
- Internal imports use relative paths with explicit extensions only when needed

### Formatting

- No automated formatter configured (no Prettier/ESLint/Biome)
- Use 2-space indentation (existing convention in codebase)
- Add comments sparingly - only for complex logic or public API documentation
- Keep functions concise and focused

### TypeScript

- Use explicit type annotations for function parameters and return types
- Define clear interfaces/types in `src/core/types.ts` for shared data structures
- Use `satisfies Type` instead of `as Type` for type assertions
- Prefer `Map` and `Set` over array-based lookups for performance
- Use `createMemo`, `createSignal`, `createEffect` from solid-js for reactivity

### Naming Conventions

- **Functions**: camelCase (`calculateLayout`, `fetchJJLog`)
- **Constants**: UPPER_SNAKE_CASE (`DEFAULT_GRAPH_CONFIG`, `JJ_TEMPLATE`)
- **Types/Interfaces**: PascalCase (`CommitNode`, `JJBackend`)
- **Variables**: camelCase (`nodeLanes`, `totalBytes`)
- **Private/internal**: Prefix with underscore (`_clipboardy`, `didBootstrapGlobalConfig`)
- **Boolean variables**: Start with `is`, `has`, `should` (`isLoading`, `isWorkingCopy`)

### Error Handling

- Use async/try-catch for async operations
- For jj-api functions, catch silently with bare `catch {}` when errors are expected/acceptable
- For critical operations, throw descriptive errors with context
- Treat null/undefined as failures - return early or throw

### State Management

- Use `solid-js/store` `createStore` for reactive state (see `src/core/state.ts`)
- Separate concerns: shared state in `state.ts`, platform-specific in `state-tui.ts`/`state-web.ts`
- Use actions and derived memos (`createMemo`) for state updates and computed values
- Cache expensive operations (files, diffs) with timestamp-based pruning

### File Organization

- `src/core/`: Shared business logic, types, utilities
- `src/tui/`: Terminal UI components and TUI-specific code
- `src/web/`: Web UI components and web-specific code
- `src/core/__tests__/`: Tests for core modules (use *.test.ts pattern).
- `themes/`: TOML theme configuration files
- `scripts/`: Build/export utilities

### Backend Abstraction

- All JJ CLI operations go through the `JJBackend` interface in `src/core/backend.ts`
- Platform-specific implementations: `createTuiBackend()` and `createWebBackend()`
- Set backend at startup with `setBackend()`, access via `getBackend()`

### Configuration

- Configuration uses TOML format
- Layered precedence: global (XDG_CONFIG_HOME) → repo (.jj-viz.toml) → local (.juzu.local.toml)
- Runtime config accessible via `getRuntimeConfig()` from `src/core/runtime-config.ts`
- UI tokens for theming: `UI_TOKENS` in `src/core/ui-tokens.ts`

### Testing

- Use `bun:test` framework (`import { test, describe, expect } from "bun:test"`)
- Write unit tests for parsers, layout logic, and state management
- Use test fixtures from `src/test-utils/fixtures.ts`
- Reset state in `beforeEach` blocks
- Test both happy paths and error handling

### Performance Considerations

- Cache files and diffs with size/time-based eviction
- Use in-place pruning for Map caches to avoid allocation overhead
- Lazy-load heavy dependencies (e.g., clipboardy) only when needed
- Optimize for large repos: configurable limits (JUZU_LOG_LIMIT, JUZU_TUI_LOG_LIMIT)

## Platform Differences

- **TUI**: Direct Bun runtime, file I/O, leader-mode keyboard shortcuts
- **Web**: Browser environment, REST API to server, mouse interactions, viewport state
- Both share the same core state, layout engine, and types
