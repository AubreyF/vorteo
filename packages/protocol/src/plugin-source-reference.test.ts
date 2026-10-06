import { parsePluginRegistryReference } from "./plugin-registry.js";
import { describe, expect, it } from "vitest";
import { formatPluginIdentity, parsePluginSourceReference } from "./plugin-source-reference.js";

describe("plugin source references", () => {
  it.each([
    ["npm:review@1.2.0:nested", "npm:review@1.2.0", "nested"],
    ["npm:review@^1.2.0", "npm:review@^1.2.0", undefined],
    ["npm:@team/review@next:plugins/main", "npm:@team/review@next", "plugins/main"],
    ["github:owner/repository", "github:owner/repository", undefined],
    [
      "git:git@example.test:owner/repository.git",
      "git:git@example.test:owner/repository.git",
      undefined,
    ],
    ["git:file:///repo:plugins/main", "git:file:///repo", "plugins/main"],
    ["plugins.example.com:8443/owner/slug", "plugins.example.com:8443/owner/slug", undefined],
    ["owner/repository", "owner/repository", undefined],
    ["owner/repository:plugins/review", "owner/repository", "plugins/review"],
    [
      "https://example.test:8443/owner/repository.git",
      "https://example.test:8443/owner/repository.git",
      undefined,
    ],
    [
      "https://example.test:8443/owner/repository.git:plugins/review",
      "https://example.test:8443/owner/repository.git",
      "plugins/review",
    ],
    ["git@example.test:owner/repository.git", "git@example.test:owner/repository.git", undefined],
    [
      "git@example.test:owner/repository.git:plugins/review",
      "git@example.test:owner/repository.git",
      "plugins/review",
    ],
    ["file:///D:/plugins/repository", "file:///D:/plugins/repository", undefined],
    [
      "file:///D:/plugins/repository:plugins/review",
      "file:///D:/plugins/repository",
      "plugins/review",
    ],
    ["D:\\plugins\\repository", "D:\\plugins\\repository", undefined],
    ["D:\\plugins\\repository:plugins/review", "D:\\plugins\\repository", "plugins/review"],
  ])("parses %s", (reference, source, pluginPath) => {
    expect(parsePluginSourceReference(reference)).toEqual({ source, pluginPath });
  });
});

it("addresses default and private registries without treating explicit sources as registry IDs", () => {
  expect(parsePluginRegistryReference("omercnet/dracula")).toEqual({
    url: "https://plugins.paseo.sh",
    id: "omercnet/dracula",
  });
  expect(parsePluginRegistryReference("acme/plugin", "https://internal.example/registry/")).toEqual(
    { url: "https://internal.example/registry", id: "acme/plugin" },
  );
  expect(parsePluginRegistryReference("internal.example:8443/acme/plugin")).toEqual({
    url: "https://internal.example:8443",
    id: "acme/plugin",
  });
  expect(parsePluginRegistryReference("github:acme/plugin")).toBeNull();
  expect(parsePluginRegistryReference("npm:@acme/plugin")).toBeNull();
});

it("round trips registry scheme and base path for source review", () => {
  const registry = { url: "http://127.0.0.1:8123/internal", id: "acme/example" };
  const reference = formatPluginIdentity({
    kind: "git",
    remote: "https://example.test/source.git",
    pluginPath: ".",
    registry,
  });
  expect(reference).toBe("registry:http://127.0.0.1:8123/internal/acme/example");
  expect(parsePluginRegistryReference(reference, "https://unrelated.example")).toEqual(registry);
  expect(parsePluginSourceReference(reference)).toEqual({
    source: reference,
    pluginPath: undefined,
  });
  expect(
    parsePluginRegistryReference("registry:https://user:secret@example.test/acme/example"),
  ).toBeNull();
  expect(
    parsePluginRegistryReference("registry:https://example.test/acme/example?token=value"),
  ).toBeNull();
  expect(parsePluginRegistryReference("registry:file:///internal/acme/example")).toBeNull();
});
