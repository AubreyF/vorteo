import { expect, test } from "vitest";
import type { StoredSchedule } from "@getpaseo/protocol/schedule/types";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuotaGovernorStore } from "../agent/quota-reserve/governor-store.js";
import { createFactoryStageNativeRuntime } from "../factory/governed-stage-native.js";
import { createFactoryScheduleInspection } from "../factory/native-schedule-inspection.js";
import { ScheduleStore } from "./store.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { captureFactoryWorkerProfile } from "../factory/capture-worker-profile.js";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import {
  loadGovernedScheduleRuntimeFactory,
  type GovernedScheduleRuntimeContext,
} from "./governed-runtime.js";

test.skipIf(process.platform === "win32")(
  "startup selects retained accounting without changing daemon home",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "governed-accounting-")));
    try {
      const directory = join(root, "retained-ledger");
      await mkdir(directory, { mode: 0o700 });
      const modulePath = join(root, "runtime.mjs");
      await writeFile(
        modulePath,
        `export const quotaGovernorDirectory = ${JSON.stringify(directory)};
      export async function createGovernedScheduleRuntime(context) {
        if(context.governorDirectory !== quotaGovernorDirectory || context.paseoHome === quotaGovernorDirectory)
          throw new Error('Accounting and daemon home were conflated');
        return { readObservation: context.readObservation, reconcile: async()=>{},
          reconcilePreparation: async()=> 'clear', prepare: async()=> ({kind:'deferred',reason:'held',custody:'none'}), stop:async()=>{} };
      }`,
        { mode: 0o600 },
      );
      const factory = await loadGovernedScheduleRuntimeFactory(modulePath);
      if (!factory) throw new Error("Missing fixture runtime");
      expect(factory.governorDirectory).toBe(directory);
      expect(Reflect.set(factory, "governorDirectory", root)).toBe(false);
      await factory({
        hostId: "fixture",
        paseoHome: root,
        governorDirectory: directory,
        store: new QuotaGovernorStore(directory),
        readObservation: async () => ({ status: "unavailable", reason: "read_failed" }),
        captureClient: () => {
          throw new Error("No worker in fixture");
        },
      });
      await chmod(directory, 0o755);
      await expect(loadGovernedScheduleRuntimeFactory(modulePath)).rejects.toThrow(
        "owner-private physical",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "loads an explicitly installed runtime and rejects invalid exports without fallback",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "governed-module-")));
    const context: GovernedScheduleRuntimeContext = {
      hostId: "srv_fixture",
      paseoHome: root,
      store: new QuotaGovernorStore(join(root, "quota")),
      readObservation: async () => ({ status: "unavailable", reason: "read_failed" }),
      captureClient: () => {
        throw new Error("No worker in fixture");
      },
    };
    try {
      const good = join(root, "runtime.mjs");
      await writeFile(
        good,
        `export async function createGovernedScheduleRuntime(context) {
      return { readObservation: context.readObservation, reconcile: async () => {},
        reconcilePreparation: async () => 'clear', prepare: async () => ({kind:'deferred',reason:'fixture',custody:'none'}), stop: async () => {} };
    }`,
        { mode: 0o600 },
      );
      const factory = await loadGovernedScheduleRuntimeFactory(good);
      if (!factory) throw new Error("Missing fixture factory");
      const runtime = await factory(context);
      expect(await runtime.readObservation("fixture")).toEqual({
        status: "unavailable",
        reason: "read_failed",
      });
      await runtime.stop();
      await expect(loadGovernedScheduleRuntimeFactory(undefined)).resolves.toBeUndefined();
      await expect(loadGovernedScheduleRuntimeFactory("relative.mjs")).rejects.toThrow("absolute");
      const invalid = join(root, "invalid.mjs");
      await writeFile(invalid, "export const createGovernedScheduleRuntime = false;", {
        mode: 0o600,
      });
      await expect(loadGovernedScheduleRuntimeFactory(invalid)).rejects.toThrow(
        "export is missing",
      );
      const incomplete = join(root, "incomplete.mjs");
      await writeFile(
        incomplete,
        "export async function createGovernedScheduleRuntime() { return {}; }",
        { mode: 0o600 },
      );
      const broken = await loadGovernedScheduleRuntimeFactory(incomplete);
      if (!broken) throw new Error("Missing broken fixture");
      await expect(broken(context)).rejects.toThrow("contract is incomplete");
      const alias = join(root, "alias.mjs");
      await symlink(good, alias);
      await expect(loadGovernedScheduleRuntimeFactory(alias)).rejects.toThrow("physical module");
      await chmod(good, 0o666);
      await expect(loadGovernedScheduleRuntimeFactory(good)).rejects.toThrow("physical module");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "supplies installed stage constructors without allowing a replacement governor store",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "governed-native-")));
    const store = new QuotaGovernorStore(join(root, "quota"));
    try {
      const modulePath = join(root, "runtime.mjs");
      await writeFile(
        modulePath,
        `export async function createGovernedScheduleRuntime(context) {
          if (context.factoryStage.store !== context.store) throw new Error('Different store');
          const worker = context.factoryProfiles.capture({
            provider:'fixture-provider', profileId:'fixture-worker',
            environment:'container', assertOwner() {}
          });
          const config = worker.sessionConfig('/work');
          if (config.provider !== 'fixture-provider' || config.model !== 'gpt-6.1-sol' ||
              config.thinkingOptionId !== 'medium' || config.modeId !== 'full-access')
            throw new Error('Native worker profile was not resolved');
          await context.factoryStage.QuotaSupervisor.attach({store: {}}).then(
            () => { throw new Error('Replacement store accepted'); },
            error => { if (error.message !== 'Factory native stage runtime changed.') throw error; }
          );
          return { readObservation: context.readObservation, reconcile: async () => {},
            reconcilePreparation: async () => 'clear',
            prepare: async () => ({kind:'deferred', reason:'fixture', custody:'none'}),
            stop: async () => {} };
        }`,
        { mode: 0o600 },
      );
      const factory = await loadGovernedScheduleRuntimeFactory(modulePath);
      if (!factory) throw new Error("Missing fixture factory");
      const runtime = await factory({
        hostId: "srv_fixture",
        paseoHome: root,
        store,
        factoryStage: createFactoryStageNativeRuntime(store),
        factoryProfiles: {
          capture: (input) =>
            captureFactoryWorkerProfile({
              ...input,
              readSettings: () =>
                MutableDaemonConfigSchema.parse({
                  mcp: { injectIntoAgents: true },
                  agentProfiles: [
                    {
                      id: "fixture-worker",
                      name: "Worker",
                      provider: "fixture-provider",
                      model: "gpt-6.1-sol",
                      thinkingOptionId: "medium",
                      modeId: "full-access",
                    },
                  ],
                }),
            }),
        },
        readObservation: async () => ({ status: "unavailable", reason: "read_failed" }),
        captureClient: () => {
          throw new Error("No worker in fixture");
        },
      });
      expect(await runtime.readObservation("fixture")).toEqual({
        status: "unavailable",
        reason: "read_failed",
      });
      await runtime.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("native schedule inspection returns detached actual store facts and captures the request", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-schedule-reader-"));
  try {
    const store = new ScheduleStore(root, createTestLogger());
    const schedule = await store.create({
      name: "Fixture",
      prompt: "Fixture",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "codex", cwd: root } },
      status: "paused",
      createdAt: "2026-10-09T00:00:00Z",
      updatedAt: "2026-10-09T00:00:00Z",
      nextRunAt: null,
      lastRunAt: null,
      pausedAt: "2026-10-09T00:00:00Z",
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });
    const reader = createFactoryScheduleInspection();
    const request = { scheduleId: schedule.id, assertCurrent() {} };
    await expect(reader.inspect(request)).rejects.toThrow("unavailable");
    reader.activate({
      async inspect(id) {
        request.scheduleId = "ffffffff";
        const value = await store.get(id);
        if (!value) throw new Error("Missing fixture");
        return value;
      },
    });
    const result = await reader.inspect(request);
    expect(result).toEqual(schedule);
    result.runs.push({
      id: "fixture",
      scheduledFor: "2026-10-09T00:00:00Z",
      startedAt: "2026-10-09T00:00:00Z",
      endedAt: null,
      status: "running",
      agentId: null,
      output: null,
      error: null,
    });
    expect(await store.get(schedule.id)).toEqual(schedule);
    reader.revoke();
    await expect(reader.inspect({ ...request, scheduleId: schedule.id })).rejects.toThrow(
      "unavailable",
    );
    expect(() => reader.activate({ inspect: async () => schedule })).toThrow("unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["owner", "method", "revoke", "identity"])(
  "native schedule inspection rejects %s drift across the actual read callback",
  async (drift) => {
    const reader = createFactoryScheduleInspection();
    let owned = true;
    const assertCurrent = () => {
      if (!owned) throw new Error("Owner lost");
    };
    const schedule: StoredSchedule = {
      id: "12345678",
      name: "Fixture",
      prompt: "Fixture",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "10391555-2afc-4b91-aaed-6927e67fc350" },
      status: "paused",
      createdAt: "2026-10-09T00:00:00Z",
      updatedAt: "2026-10-09T00:00:00Z",
      nextRunAt: null,
      lastRunAt: null,
      pausedAt: "2026-10-09T00:00:00Z",
      expiresAt: null,
      maxRuns: null,
      runs: [],
    };
    const service = {
      async inspect() {
        if (drift === "owner") owned = false;
        if (drift === "method") service.inspect = async () => schedule;
        if (drift === "revoke") reader.revoke();
        return drift === "identity" ? { ...schedule, id: "ffffffff" } : schedule;
      },
    };
    reader.activate(service);
    await expect(reader.inspect({ scheduleId: schedule.id, assertCurrent })).rejects.toThrow(
      drift === "owner" ? "Owner lost" : "changed",
    );
  },
);
