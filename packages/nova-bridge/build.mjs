import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// A standalone bundle keeps the supervised Host process independent of a worktree.
await build({
  absWorkingDir: fileURLToPath(new URL(".", import.meta.url)),
  entryPoints: ["src/main.ts"],
  outfile: "dist/bridge.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  external: ["bufferutil", "utf-8-validate"],
  sourcemap: false,
  legalComments: "eof",
});
