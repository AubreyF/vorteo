import path from "node:path";
import { build } from "esbuild";
import { expect, test } from "@playwright/test";

// Exercise the real installed styling runtime in Chromium. This deliberately
// separates render-time class creation from commit-time ref attachment.
const sourceRoot = path.resolve(
  path.dirname(require.resolve("react-native-unistyles")),
  "../../src",
);
let runtimeScript: string;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import { getClassName } from ${JSON.stringify(path.join(sourceRoot, "core/getClassname.ts"))};
        import { createUnistylesRef } from ${JSON.stringify(path.join(sourceRoot, "web/utils/createUnistylesRef.ts"))};
        import { services } from ${JSON.stringify(path.join(sourceRoot, "web/services.ts"))};
        import { create } from ${JSON.stringify(path.join(sourceRoot, "web/create.ts"))};
        window.checkPendingStyle = async (changeWhilePending) => {
          services.state.init({ themes: { test: { color: 'rgb(245, 245, 247)', fontSize: 14 } }, settings: { initialTheme: 'test', CSSVars: false } });
          // Theme dependency metadata normally comes from the Unistyles Babel plugin.
          const stylesheet = create(theme => ({ label: { color: theme.color, fontSize: theme.fontSize, uni__dependencies: [0] } }));
          const style = stylesheet.label;
          const mountedStyles = getClassName(style);
          const oldNode = document.createElement('span');
          oldNode.className = mountedStyles[0].hash;
          document.body.append(oldNode);
          const oldRef = createUnistylesRef(mountedStyles);
          oldRef(oldNode);

          const pendingStyles = getClassName(style);
          const pendingRef = createUnistylesRef(pendingStyles, undefined, () => getClassName(style));
          oldNode.remove();
          oldRef(null);
          await Promise.resolve();
          if (changeWhilePending) services.runtime.updateTheme('test', () => ({ color: 'rgb(42, 31, 23)', fontSize: 18 }));

          const nextNode = document.createElement('span');
          nextNode.className = pendingStyles[0].hash;
          nextNode.textContent = 'Latest';
          document.body.append(nextNode);
          pendingRef(nextNode);
          const painted = getComputedStyle(nextNode);
          const result = { color: painted.color, fontSize: painted.fontSize };
          await Promise.resolve();
          await Promise.resolve();
          services.runtime.updateTheme('test', () => ({ color: 'rgb(200, 210, 220)', fontSize: 20 }));
          result.updatedColor = getComputedStyle(nextNode).color;
          result.updatedFontSize = getComputedStyle(nextNode).fontSize;
          nextNode.remove();
          pendingRef(null);
          await Promise.resolve();
          await Promise.resolve();
          result.rulesAfterUnmount = document.getElementById('unistyles-web').textContent;
          return result;
        };
      `,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "browser",
    alias: { "react-native": "react-native-web" },
    define: { __DEV__: "false", "process.env.NODE_ENV": '"production"' },
  });
  runtimeScript = result.outputFiles[0].text;
});

for (const changeWhilePending of [false, true]) {
  test(`restores a pending view's released CSS rule${changeWhilePending ? " with updated styles" : ""}`, async ({
    page,
  }) => {
    await page.goto("about:blank");
    await page.addScriptTag({ content: runtimeScript });
    const result = await page.evaluate(async (changed) => {
      const runtime = window as unknown as {
        checkPendingStyle(change: boolean): Promise<{
          color: string;
          fontSize: string;
          updatedColor: string;
          updatedFontSize: string;
          rulesAfterUnmount: string;
        }>;
      };
      return runtime.checkPendingStyle(changed);
    }, changeWhilePending);
    expect(result.color).toBe(changeWhilePending ? "rgb(42, 31, 23)" : "rgb(245, 245, 247)");
    expect(result.fontSize).toBe(changeWhilePending ? "18px" : "14px");
    expect(result.updatedColor).toBe("rgb(200, 210, 220)");
    expect(result.updatedFontSize).toBe("20px");
    expect(result.rulesAfterUnmount).not.toContain("unistyles_");
  });
}
