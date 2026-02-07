#!/usr/bin/env bun
/**
 * Pre-compile TUI source files with the SolidJS Babel transform.
 * Produces dist/tui/ with plain .js files that can run without --preload.
 *
 * Usage: bun scripts/build-tui.ts
 */
import { transformAsync } from "@babel/core";
// @ts-expect-error
import ts from "@babel/preset-typescript";
// @ts-expect-error
import solid from "babel-preset-solid";
import { join, relative, dirname } from "node:path";
import { mkdir } from "node:fs/promises";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "dist", "tui");
const SRC_DIRS = [
  join(ROOT, "src/tui"),
  join(ROOT, "src/core"),
];

// Collect all .ts/.tsx files
const files: string[] = [];
for (const dir of SRC_DIRS) {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  for await (const path of glob.scan({ cwd: dir, absolute: true })) {
    // Skip test files
    if (path.includes("__tests__")) continue;
    files.push(path);
  }
}

console.log(`Compiling ${files.length} files...`);

let errors = 0;
for (const filePath of files) {
  const code = await Bun.file(filePath).text();
  const isTsx = filePath.endsWith(".tsx");

  try {
    const result = await transformAsync(code, {
      filename: filePath,
      presets: [
        ...(isTsx
          ? [[solid, { moduleName: "@opentui/solid", generate: "universal" }]]
          : []),
        [ts],
      ],
    });

    if (!result?.code) {
      console.error(`  SKIP (no output): ${filePath}`);
      continue;
    }

    // Determine output path: src/tui/App.tsx -> dist/tui/tui/App.js
    // src/core/state.ts -> dist/tui/core/state.js
    const rel = filePath.startsWith(join(ROOT, "src/tui"))
      ? join("tui", relative(join(ROOT, "src/tui"), filePath))
      : join("core", relative(join(ROOT, "src/core"), filePath));

    const outPath = join(OUT, rel).replace(/\.tsx?$/, ".js");
    await mkdir(dirname(outPath), { recursive: true });

    // Rewrite relative imports: .tsx -> .js, bare .ts -> .js
    let output = result.code;
    output = output.replace(
      /(from\s+["'])(\.\.?\/[^"']+?)(\.tsx?)(["'])/g,
      "$1$2.js$4"
    );
    // Handle imports without extension (TypeScript style)
    output = output.replace(
      /(from\s+["'])(\.\.?\/[^"']+?)(?<!\.js)(["'])/g,
      (_match, pre, path, post) => {
        // Don't add .js if it already ends with .js or has no dots in the basename
        if (path.endsWith(".js")) return _match;
        return `${pre}${path}.js${post}`;
      }
    );

    await Bun.write(outPath, output);
  } catch (e) {
    console.error(`  ERROR: ${filePath}: ${e}`);
    errors++;
  }
}

// Also compile the TUI entry point
const mainCode = await Bun.file(join(ROOT, "src/tui/main.ts")).text();
const mainResult = await transformAsync(mainCode, {
  filename: "main.ts",
  presets: [[ts]],
});
if (mainResult?.code) {
  let output = mainResult.code;
  output = output.replace(
    /(from\s+["'])(\.\.?\/[^"']+?)(\.tsx?)(["'])/g,
    "$1$2.js$4"
  );
  output = output.replace(
    /(from\s+["'])(\.\.?\/[^"']+?)(?<!\.js)(["'])/g,
    (_match, pre, path, post) => {
      if (path.endsWith(".js")) return _match;
      return `${pre}${path}.js${post}`;
    }
  );
  await Bun.write(join(OUT, "tui", "main.js"), output);
}

// Post-compile: fix import.meta.dir-relative paths in compiled output.
// Source files live at src/tui/ (2 levels from root) but compiled output
// lives at dist/tui/tui/ (3 levels). Fix the extra depth.
const fixups: Array<{ file: string; from: string; to: string }> = [
  // main.js: appDir needs 3 levels up
  {
    file: join(OUT, "tui", "main.js"),
    from: '`${import.meta.dir}/../..`',
    to: '`${import.meta.dir}/../../..`',
  },
  // App.js: applyTheme appDir needs 3 levels up
  {
    file: join(OUT, "tui", "App.js"),
    from: '`${import.meta.dir}/../..`',
    to: '`${import.meta.dir}/../../..`',
  },
  // App.js: themes discovery dir needs 3 levels up
  {
    file: join(OUT, "tui", "App.js"),
    from: 'join(import.meta.dir, "../../themes")',
    to: 'join(import.meta.dir, "../../../themes")',
  },
  // App.js: dynamic import("./App") needs extension
  {
    file: join(OUT, "tui", "main.js"),
    from: 'import("./App")',
    to: 'import("./App.js")',
  },
];

for (const { file, from, to } of fixups) {
  try {
    let content = await Bun.file(file).text();
    if (content.includes(from)) {
      content = content.replace(from, to);
      await Bun.write(file, content);
    }
  } catch {
    // File may not exist yet on first build
  }
}

console.log(`Done. ${files.length - errors} files compiled to ${OUT}`);
if (errors > 0) {
  console.error(`${errors} errors`);
  process.exit(1);
}
