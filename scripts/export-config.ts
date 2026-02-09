#!/usr/bin/env bun

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

function getXdgConfigHome(): string | null {
  return process.env.XDG_CONFIG_HOME || (process.env.HOME ? join(process.env.HOME, ".config") : null);
}

function getOption(name: string): string | null {
  const prefix = `${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (!hit) return null;
  return hit.slice(prefix.length) || null;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function timestampForFileName(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

const repoRoot = join(import.meta.dir, "..");
const xdg = getXdgConfigHome();

if (!xdg) {
  console.error("Could not resolve XDG config directory (XDG_CONFIG_HOME/HOME missing).");
  process.exit(1);
}

const sourceOption = getOption("--source");
const targetOption = getOption("--target");
const noBackup = hasFlag("--no-backup");

const sourceCandidates = sourceOption
  ? [sourceOption]
  : [".juzu.local.toml", ".juzu.toml", "config.example.toml"];

let sourcePath: string | null = null;
for (const candidate of sourceCandidates) {
  const resolved = isAbsolute(candidate) ? candidate : join(repoRoot, candidate);
  if (await Bun.file(resolved).exists()) {
    sourcePath = resolved;
    break;
  }
}

if (!sourcePath) {
  console.error(`No source config file found. Tried: ${sourceCandidates.join(", ")}`);
  process.exit(1);
}

const targetPath = targetOption
  ? (isAbsolute(targetOption) ? targetOption : join(process.cwd(), targetOption))
  : join(xdg, "juzu", "config.toml");

const sourceRaw = await Bun.file(sourcePath).text();
if (!sourceRaw.trim()) {
  console.error(`Source config is empty: ${sourcePath}`);
  process.exit(1);
}

await mkdir(dirname(targetPath), { recursive: true });

let backupPath: string | null = null;
if (!noBackup && await Bun.file(targetPath).exists()) {
  backupPath = `${targetPath}.backup-${timestampForFileName()}`;
  await copyFile(targetPath, backupPath);
}

await writeFile(targetPath, sourceRaw, "utf8");

console.log(`Exported config to ${targetPath}`);
console.log(`Source: ${sourcePath}`);
if (backupPath) console.log(`Backup: ${backupPath}`);
