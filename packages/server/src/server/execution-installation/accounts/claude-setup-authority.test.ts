import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeSetupRuntime } from "./claude-setup-runtime.js";
import { writeClaudeSetupFile } from "./claude-setup-file.js";
import { ClaudeSetupDeliverySchema } from "./claude-setup-delivery.js";
import { InstallationConfigSchema } from "../config.js";
import { InstallationSettingsService } from "../settings/service.js";
import { SettingsJournalFake, SettingsEnvironmentFake } from "../settings/fakes.js";
import { expect, test } from "vitest";
import {
  ClaudeSetupAuthority,
  type ClaudeSetupAuthorityState,
  type ClaudeSetupPolicy,
} from "./claude-setup-authority.js";
import { setupCredentialDigest, type ClaudeSetupDelivery } from "./claude-setup-delivery.js";

const token = { version: 1, accessToken: `sk-ant-oat01-${"synthetic".repeat(8)}`, createdAt: 1 };
function fixture() {
  let disk: ClaudeSetupAuthorityState = [];
  const deliveries: ClaudeSetupDelivery[] = [];
  const state = { offline: true, failPersist: false };
  const policy: ClaudeSetupPolicy = {
    revision: 1,
    removed: false,
    targets: [
      { serverId: "host", providerId: "claude-one", excluded: false },
      { serverId: "dev", providerId: "claude-one", excluded: false },
    ],
  };
  const ports = {
    installationId: "11111111-1111-4111-8111-111111111111",
    read: () => structuredClone(disk),
    persist: (next: ClaudeSetupAuthorityState) => {
      if (state.failPersist) throw Error(token.accessToken);
      disk = structuredClone(next);
    },
    policy: () => structuredClone(policy),
    deliver: async (delivery: ClaudeSetupDelivery) => {
      deliveries.push(delivery);
      if (state.offline && delivery.serverId === "dev") throw Error("offline");
      const { credential, ...scope } = delivery;
      return {
        ...scope,
        digest: setupCredentialDigest(credential),
        phase: "applied" as const,
        active: credential !== null,
      };
    },
  };
  return { state, policy, ports, deliveries, authority: new ClaudeSetupAuthority(ports) };
}

test("persists before delivery and resumes the identical pending generation after restart", async () => {
  const f = fixture();
  await f.authority.save("one", token);
  expect(f.deliveries).toHaveLength(0);
  await f.authority.reconcile();
  expect(f.authority.status("one").environments.map((item) => item.status)).toEqual([
    "ready",
    "pending",
  ]);
  expect(JSON.stringify(f.authority.status("one"))).not.toContain(token.accessToken);
  f.state.offline = false;
  const resumed = new ClaudeSetupAuthority(f.ports);
  await resumed.reconcile();
  expect(f.deliveries.map((item) => [item.serverId, item.revision])).toEqual([
    ["host", 1],
    ["dev", 1],
    ["dev", 1],
  ]);
  expect(resumed.status("one").environments.map((item) => item.status)).toEqual(["ready", "ready"]);
});

test("exclusion and sign-out advance generations and send credential-free tombstones", async () => {
  const f = fixture();
  f.state.offline = false;
  await f.authority.save("one", token);
  await f.authority.reconcile();
  f.policy.revision = 2;
  f.policy.targets[1]!.excluded = true;
  await f.authority.reconcile();
  expect(f.deliveries.at(-1)).toMatchObject({ serverId: "dev", revision: 2, credential: null });
  expect(f.authority.status("one").environments[1]?.status).toBe("excluded");
  await f.authority.signOut("one");
  await f.authority.reconcile();
  expect(
    f.deliveries.slice(-2).every((item) => item.credential === null && item.revision === 3),
  ).toBe(true);
  expect(f.authority.status("one")).toMatchObject({
    connected: false,
    environments: [{ status: "disconnected" }, { status: "excluded" }],
  });
});

test("canonical persistence failure and cancelled capture cannot become connected", async () => {
  const f = fixture();
  f.state.failPersist = true;
  await expect(f.authority.save("one", token)).rejects.toThrow("synchronization is pending");
  expect(() => f.authority.status("one")).toThrow("synchronization is pending");
  f.state.failPersist = false;
  await expect(f.authority.save("one", token, AbortSignal.abort())).rejects.toThrow();
  await expect(f.authority.reconcile()).rejects.toThrow("synchronization is pending");
  await new ClaudeSetupAuthority(f.ports).reconcile();
  expect(f.deliveries).toHaveLength(0);
});

test("a lost receipt retries the same generation, and policy changes during delivery cannot mark it ready", async () => {
  const f = fixture();
  f.state.offline = false;
  await f.authority.save("one", token);
  const deliver = f.ports.deliver;
  f.ports.deliver = async (delivery) => {
    const receipt = await deliver(delivery);
    f.policy.revision = 2;
    return receipt;
  };
  await f.authority.reconcile();
  expect(f.authority.status("one").environments.every((item) => item.status === "pending")).toBe(
    true,
  );
  f.ports.deliver = deliver;
  await f.authority.reconcile();
  expect(f.authority.status("one").environments.every((item) => item.status === "ready")).toBe(
    true,
  );
});

test("offline disconnect remains visible until the consumer acknowledges removal", async () => {
  const f = fixture();
  await f.authority.save("one", token);
  await f.authority.reconcile();
  await f.authority.signOut("one");
  await f.authority.reconcile();
  expect(f.authority.status("one")).toMatchObject({
    connected: false,
    environments: [{ status: "disconnected" }, { status: "disconnecting" }],
  });
  f.state.offline = false;
  await f.authority.reconcile();
  expect(
    f.authority.status("one").environments.every((item) => item.status === "disconnected"),
  ).toBe(true);
});

test("unready Dev keeps credential delivery pending but permits credential withdrawal", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-registration-guard-")));
  const deliveries: Array<unknown> = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const value = ClaudeSetupDeliverySchema.parse(JSON.parse(body));
      deliveries.push(value.credential);
      const { credential, ...scope } = value;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          ...scope,
          digest: setupCredentialDigest(credential),
          phase: "applied",
          active: credential !== null,
        }),
      );
    })().catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let runtime: ReturnType<typeof createClaudeSetupRuntime> | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing isolated delivery listener");
    const endpoint = `127.0.0.1:${address.port}`;
    const environment = new SettingsEnvironmentFake("dev");
    environment.config.providers = {
      "claude-one": { extends: "claude", enabled: true, label: "Isolated Claude" },
    };
    const settings = new InstallationSettingsService(new SettingsJournalFake(), [environment]);
    const snapshot = await settings.reconcile();
    const definition = snapshot.settings?.providerDefinitions?.[0];
    if (!definition) throw new Error("Missing isolated account definition");
    const authority = fixture();
    authority.policy.revision = snapshot.revision;
    authority.policy.targets = [{ serverId: "dev", providerId: "claude-one", excluded: false }];
    await authority.authority.save(definition.id, token);
    writeClaudeSetupFile(join(root, "claude-setup/authority.json"), authority.ports.read());
    const config = InstallationConfigSchema.parse({
      public: {
        version: 1,
        installationId: authority.ports.installationId,
        origin: "https://isolated.example",
        environments: [
          { kind: "host", serverId: "host", endpoint, useTls: false },
          { kind: "container", serverId: "dev", endpoint, useTls: false },
        ],
      },
      stateDir: root,
      listenPort: 6767,
      webDistDir: root,
      ownerPasswordHash: "$2fixture",
      hostAgentTokenHash: "a".repeat(64),
      containerAgentTokenHash: "b".repeat(64),
      host: {
        endpoint,
        password: "isolated-host",
        launchdService: "gui/501/local.vorteo.fixture.host",
      },
      container: {
        endpoint,
        password: "isolated-dev",
        persistentRegistration: {
          receiptFile: join(root, "missing-receipt.json"),
          sha256: "a".repeat(64),
        },
      },
    });
    runtime = createClaudeSetupRuntime(config, settings);
    await runtime.reconcile();
    expect(deliveries).toEqual([]);
    expect(runtime.read(definition.id).connection.environments).toEqual([
      expect.objectContaining({ serverId: "dev", status: "pending" }),
    ]);
    await runtime.signOut(definition.id);
    expect(deliveries).toEqual([null]);
    expect(runtime.read(definition.id).connection.connected).toBe(false);
  } finally {
    await runtime?.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
    rmSync(root, { recursive: true, force: true });
  }
});
