import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeFileTrace } from "@vercel/nft";
import resolveDependency from "@vercel/nft/out/resolve-dependency.js";
import { transform } from "esbuild";
import { describe, expect, test } from "vitest";

// The Host startup module contract traces built entries with @vercel/nft. These
// tests apply the same tracer to the TypeScript sources, transpiled on the fly,
// so they run without a build. Playwright must stay reachable only from the
// separate browser host entry, never from the daemon worker or the CLI.

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
const serverSource = path.join(repoRoot, "packages/server/src");

async function traceSources(entries: string[]): Promise<string[]> {
  const result = await nodeFileTrace(entries, {
    base: repoRoot,
    // Workspace packages export their TypeScript sources under "source".
    conditions: ["source"],
    analysis: { computeFileReferences: false, emitGlobs: false, evaluatePureExpressions: true },
    async readFile(file) {
      if (!existsSync(file)) return null;
      const bytes = await readFile(file);
      if (!/\.tsx?$/.test(file) || file.endsWith(".d.ts")) return bytes;
      const output = await transform(bytes.toString("utf8"), {
        loader: file.endsWith(".tsx") ? "tsx" : "ts",
        format: "esm",
        target: "es2022",
      });
      return output.code;
    },
    async resolve(specifier, parent, job, cjsResolve) {
      try {
        return await resolveDependency(specifier, parent, job, cjsResolve);
      } catch (error) {
        // Sources import compiled names (./module.js) of TypeScript files.
        if (!specifier.startsWith(".") || !specifier.endsWith(".js")) throw error;
        const candidate = path.resolve(path.dirname(parent), `${specifier.slice(0, -3)}.ts`);
        if (!existsSync(candidate)) throw error;
        return candidate;
      }
    },
  });
  return [...result.fileList];
}

function playwrightFiles(files: string[]): string[] {
  return files.filter((file) => /(^|\/)node_modules\/playwright(-core)?\//.test(file));
}

describe("Host startup module contract traces", () => {
  test("the browser host entry reaches Playwright", { timeout: 180_000 }, async () => {
    const files = await traceSources([
      path.join(serverSource, "server/browser-tools/engine/headless-host-process.ts"),
    ]);
    expect(playwrightFiles(files).length).toBeGreaterThan(0);
  });

  test(
    "the daemon worker and CLI entries never reach Playwright",
    { timeout: 300_000 },
    async () => {
      const files = await traceSources([
        path.join(serverSource, "server/daemon-worker.ts"),
        path.join(repoRoot, "packages/cli/src/index.ts"),
      ]);
      // Guard against a vacuous pass: the daemon must reach its browser host client.
      expect(files).toContain(
        "packages/server/src/server/browser-tools/engine/headless-host-process-client.ts",
      );
      expect(files).toContain("packages/cli/src/commands/browser/index.ts");
      expect(playwrightFiles(files)).toEqual([]);
      expect(files.filter((file) => /engine\/headless-host(-process)?\.ts$/.test(file))).toEqual(
        [],
      );
    },
  );
});
