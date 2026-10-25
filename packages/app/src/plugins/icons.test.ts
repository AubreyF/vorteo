import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createIconCatalog } from "./icon-catalog-state";
import { iconNameGroups } from "./icon-names.generated";
import { Settings } from "lucide-react-native";
import { describe, expect, it } from "vitest";
import { Icon } from "./icons";

describe("Icon", () => {
  it("renders a host Lucide icon with the requested presentation", () => {
    expect(Icon({ name: "Settings", size: 18, color: "#123456" })).toMatchObject({
      type: Settings,
      props: { size: 18, color: "#123456" },
    });
  });

  it("keeps public aliases of common icons immediate", () => {
    expect(Icon({ name: "LucideSettings", size: 18 })).toMatchObject({ type: Settings });
    expect(Icon({ name: "SettingsIcon", size: 18 })).toMatchObject({ type: Settings });
  });

  it("renders nothing for an unknown icon name", () => {
    expect(Icon({ name: "NotALucideIcon" })).toBeNull();
    expect(Icon({ name: "Icon" })).toBeNull();
    expect(Icon({ name: "createLucideIcon" })).toBeNull();
  });
});

const require = createRequire(import.meta.url);
const iconImports = require("../../babel-lucide-imports.cjs");
const { transformSync } = require("@babel/core");
describe("web icon imports", () => {
  it("keeps the provider import out of the eager catalogue barrel", () => {
    const result = transformSync(
      'import { LucideProvider as Provider, Settings } from "lucide-react-native"; console.log(Provider, Settings);',
      { configFile: false, babelrc: false, plugins: [iconImports] },
    );
    expect(result?.code).not.toContain('from "lucide-react-native"');
    expect(result?.code).toContain("LucideProvider as Provider");
    expect(result?.code).toContain("context.mjs");
    expect(result?.code).toContain('from "lucide-react-native/icons/settings"');
  });

  it("retains the original provider context and explicit presentation defaults", async () => {
    const { LucideProvider, useLucideContext } = await import(
      /* @vite-ignore */ pathToFileURL(iconImports.readContextExports().path).href
    );
    function ReadStroke() {
      const values = useLucideContext();
      return createElement("span", null, `${values.strokeWidth}:${values.color}`);
    }
    expect(
      renderToStaticMarkup(
        createElement(
          LucideProvider,
          {
            strokeWidth: 1.5,
            color: "#123456",
          },
          createElement(ReadStroke),
        ),
      ),
    ).toBe("<span>1.5:#123456</span>");
  });

  it("uses supported public per-icon paths and preserves local aliases", () => {
    const result = transformSync(
      'import { Settings, Check as Tick } from "lucide-react-native"; console.log(Settings, Tick);',
      { configFile: false, babelrc: false, plugins: [iconImports] },
    );
    expect(result?.code).toContain('import Settings from "lucide-react-native/icons/settings"');
    expect(result?.code).toContain('import Tick from "lucide-react-native/icons/check"');
    expect(result?.code).not.toContain('from "lucide-react-native"');
  });
  it("leaves type imports and explicit asynchronous catalogue access intact", () => {
    const result = transformSync(
      'import type { LucideIcon } from "lucide-react-native"; const load = () => import("lucide-react-native");',
      {
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["typescript"] },
        plugins: [iconImports],
      },
    );
    expect(result?.code).toContain('import type { LucideIcon } from "lucide-react-native"');
    expect(result?.code).toContain('import("lucide-react-native")');
  });
  it("keeps synchronous valid-name metadata equal to the pinned public icon catalogue", () => {
    const generated = iconNameGroups.flatMap((group) => group.split(",")).sort();
    expect(generated).toEqual([...iconImports.readIconExports().keys()].sort());
    expect(generated).not.toContain("Icon");
    expect(generated).not.toContain("createLucideIcon");
  });
});

describe("optional icon catalogue", () => {
  it("shares a pending request and publishes readiness without an automatic retry", async () => {
    let finish!: (value: { loaded: boolean }) => void;
    let calls = 0;
    const resource = createIconCatalog(() => {
      calls++;
      return new Promise<{ loaded: boolean }>((resolve) => {
        finish = resolve;
      });
    });
    const first = resource.load();
    const second = resource.load();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(resource.state()).toEqual({ phase: "loading", attempts: 1 });
    finish({ loaded: true });
    await first;
    expect(resource.value()).toEqual({ loaded: true });
    await resource.load();
    expect(calls).toBe(1);
    expect(resource.state()).toEqual({ phase: "ready", attempts: 1 });
  });
  it("reports a safe failure and caps explicit retries without leaking exception content", async () => {
    let calls = 0;
    const resource = createIconCatalog(async () => {
      calls++;
      throw new Error("private fixture token must not leak");
    });
    for (let i = 0; i < 3; i++)
      await expect(resource.load()).rejects.toThrow("Optional icon download failed.");
    await expect(resource.load()).rejects.toThrow("retries exhausted");
    expect(calls).toBe(3);
    expect(resource.state()).toEqual({ phase: "failed", attempts: 3 });
  });
});
