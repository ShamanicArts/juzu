import { transformAsync } from "@babel/core";
// @ts-expect-error - external types not needed here
import ts from "@babel/preset-typescript";
// @ts-expect-error - external types not needed here
import solid from "babel-preset-solid";
import type { BunPlugin } from "bun";

// Transform Solid JSX/TSX for the browser.
// We do this because Bun's built-in TSX transform defaults to React createElement,
// which breaks at runtime for Solid apps.
const solidDomPlugin: BunPlugin = {
  name: "solid-dom-jsx",
  setup(build) {
    build.onLoad({ filter: /\.(ts|tsx)$/ }, async (args) => {
      // Only rewrite our web sources.
      if (!args.path.includes("/src/web/")) return;

      const code = await Bun.file(args.path).text();
      const transformed = await transformAsync(code, {
        filename: args.path,
        presets: [
          [
            solid,
            {
              generate: "dom",
              moduleName: "solid-js/web",
            },
          ],
          [ts],
        ],
      });

      return {
        contents: transformed?.code ?? "",
        loader: "js",
      };
    });
  },
};

export default solidDomPlugin;
