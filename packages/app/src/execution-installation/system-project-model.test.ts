import { describe, expect, it } from "vitest";
import type { DaemonServerInfo, WorkspaceDescriptor } from "@/stores/session-store";
import { buildSystemHostSummaries } from "./system-project-model";

function workspace(
  id: string,
  fields: Partial<WorkspaceDescriptor> = {},
): [string, WorkspaceDescriptor] {
  return [
    id,
    {
      id,
      projectId: "system",
      projectDisplayName: "Vorteo System",
      projectRootPath: "/system",
      workspaceDirectory: `/system/${id}`,
      projectKind: "directory",
      workspaceKind: "directory",
      name: id,
      status: "done",
      statusEnteredAt: null,
      archivingAt: null,
      diffStat: null,
      scripts: [],
      projectSystem: { kind: "vorteo-system" },
      ...fields,
    },
  ];
}

function info(features: DaemonServerInfo["features"]): DaemonServerInfo {
  return { serverId: "host", hostname: null, version: null, features };
}

const runner = workspace("runner", {
  title: "Optimization runner",
  systemMembership: { role: "optimization-runner" },
});
const ordinary = workspace("ordinary", { projectSystem: undefined, title: "Elsewhere" });

describe("buildSystemHostSummaries", () => {
  it("lists managed workspaces only for hosts that advertise the System project", () => {
    const summaries = buildSystemHostSummaries({
      hosts: [
        { serverId: "host", label: "Host" },
        { serverId: "old", label: "Old" },
      ],
      sessions: {
        host: {
          serverInfo: info({ systemProject: true }),
          workspaces: new Map([runner, ordinary]),
        },
        old: { serverInfo: info({}), workspaces: new Map([runner]) },
      },
    });

    expect(summaries).toEqual([
      {
        serverId: "host",
        label: "Host",
        managed: [{ workspaceId: "runner", title: "Optimization runner" }],
        source: null,
        canSetUpSource: false,
      },
    ]);
  });

  it("offers source setup only when advertised and no checkout exists", () => {
    const features = { systemProject: true, systemProjectSource: true };
    const summarize = (entries: [string, WorkspaceDescriptor][]) =>
      buildSystemHostSummaries({
        hosts: [{ serverId: "host", label: "Host" }],
        sessions: { host: { serverInfo: info(features), workspaces: new Map(entries) } },
      })[0];

    expect(summarize([runner])?.canSetUpSource).toBe(true);

    const titled = workspace("source", { title: "Vorteo source" });
    expect(summarize([runner, titled])).toMatchObject({
      source: { workspaceId: "source", title: "Vorteo source" },
      canSetUpSource: false,
    });

    const checkout = workspace("checkout", { workspaceKind: "local_checkout", name: "vorteo" });
    expect(summarize([runner, checkout])?.source).toEqual({
      workspaceId: "checkout",
      title: "vorteo",
    });

    // A managed workspace never stands in for the operator's checkout.
    const managedCheckout = workspace("managed-checkout", {
      title: "Vorteo source",
      systemMembership: { role: "optimization-runner" },
    });
    expect(summarize([managedCheckout])?.canSetUpSource).toBe(true);
  });

  it("keeps the action hidden on hosts without source setup", () => {
    const [summary] = buildSystemHostSummaries({
      hosts: [{ serverId: "host", label: "Host" }],
      sessions: {
        host: { serverInfo: info({ systemProject: true }), workspaces: new Map([runner]) },
      },
    });
    expect(summary?.canSetUpSource).toBe(false);
  });
});
