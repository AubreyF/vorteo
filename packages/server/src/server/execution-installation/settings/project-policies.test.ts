import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { assertWorkspaceEnvironment, ProjectPolicyRefusal } from "./project-policies.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function daemonConfig(environment: "host" | "container", project: string) {
  return MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    installationProjectPolicies: { [project]: { excludedEnvironments: ["container"] } },
    sharedProviderPreferences: {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: {
        installationId: "4c07b582-7d41-4be4-9725-36f975708983",
        serverId: environment,
        environment,
        revision: 1,
      },
    },
  });
}

test("workspace creation is refused only in the environment a project excludes", async () => {
  const root = mkdtempSync(join(tmpdir(), "project-policy-workspace-"));
  roots.push(root);
  const project = join(root, "app");
  mkdirSync(join(project, "docs"), { recursive: true });
  const refusal = assertWorkspaceEnvironment(
    daemonConfig("container", project),
    join(project, "docs"),
  );
  await expect(refusal).rejects.toBeInstanceOf(ProjectPolicyRefusal);
  await expect(refusal).rejects.toThrow("excluded from the Dev container environment");
  await expect(
    assertWorkspaceEnvironment(daemonConfig("host", project), project),
  ).resolves.toBeUndefined();
  mkdirSync(join(root, "other"));
  await expect(
    assertWorkspaceEnvironment(daemonConfig("container", project), join(root, "other")),
  ).resolves.toBeUndefined();
});

test("a project's policy follows it through a symlinked key and covers its real folder", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "project-policy-real-")));
  roots.push(root);
  const project = join(root, "app");
  mkdirSync(join(project, "src"), { recursive: true });
  const link = join(root, "link");
  symlinkSync(project, link, "dir");
  // Keyed by the symlink, entered by the real path.
  await expect(
    assertWorkspaceEnvironment(daemonConfig("container", link), join(project, "src")),
  ).rejects.toBeInstanceOf(ProjectPolicyRefusal);
  // Keyed by the real path, entered through the symlink.
  await expect(
    assertWorkspaceEnvironment(daemonConfig("container", project), join(link, "src")),
  ).rejects.toBeInstanceOf(ProjectPolicyRefusal);
});
