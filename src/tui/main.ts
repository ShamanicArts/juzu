#!/usr/bin/env bun
// TUI Entry point - runs the SolidJS TUI app
import { render } from "@opentui/solid";
import App from "./App";

await render(App);
