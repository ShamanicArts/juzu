#!/usr/bin/env bun

import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

function getXdgConfigHome(): string | null {
  return process.env.XDG_CONFIG_HOME || (process.env.HOME ? join(process.env.HOME, ".config") : null);
}

const xdg = getXdgConfigHome();
if (!xdg) {
  console.error("Could not resolve XDG config directory (XDG_CONFIG_HOME/HOME missing).");
  process.exit(1);
}

const sourceThemesDir = join(import.meta.dir, "..", "themes");
const targetThemesDir = join(xdg, "juzu", "themes");

await mkdir(targetThemesDir, { recursive: true });

const themeFiles = (await readdir(sourceThemesDir)).filter((name) => name.endsWith(".toml"));
if (themeFiles.length === 0) {
  console.log(`No theme files found in ${sourceThemesDir}`);
  process.exit(0);
}

for (const file of themeFiles) {
  await copyFile(join(sourceThemesDir, file), join(targetThemesDir, file));
}

console.log(`Exported ${themeFiles.length} theme files to ${targetThemesDir}`);
