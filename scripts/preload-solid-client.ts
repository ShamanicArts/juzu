/**
 * Minimal preload: redirects solid-js from server → client build.
 * 
 * Bun's "node" condition resolves solid-js to dist/server.js (SSR).
 * This plugin intercepts that and loads dist/solid.js (client) instead,
 * without the heavy Babel transform overhead of the full @opentui/solid preload.
 */
import { plugin } from "bun";

plugin({
  name: "solid-client-redirect",
  setup(build) {
    build.onLoad(
      { filter: /\/node_modules\/solid-js\/dist\/server\.js$/ },
      async (args) => {
        const path = args.path.replace("server.js", "solid.js");
        return { contents: await Bun.file(path).text(), loader: "js" };
      }
    );
    build.onLoad(
      { filter: /\/node_modules\/solid-js\/store\/dist\/server\.js$/ },
      async (args) => {
        const path = args.path.replace("server.js", "store.js");
        return { contents: await Bun.file(path).text(), loader: "js" };
      }
    );
  },
});
