#!/usr/bin/env bun
// TUI Entry point - runs the SolidJS TUI app
import { render } from "@opentui/solid";
import { findJJRoot } from "../core/jj-api";
import { resolveAndApplyRuntimeConfig } from "../core/config-loader";

const repoRoot = await findJJRoot(process.cwd());
await resolveAndApplyRuntimeConfig({
  argv: process.argv.slice(2),
  repoRoot,
  appDir: `${import.meta.dir}/../..`,
});

const mod = await import("./App");
await render(mod.default);
