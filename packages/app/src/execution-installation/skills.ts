import {
  SkillPackageSchema,
  InstallationSkillSchema,
  type InstallationSkill,
  type SkillSource,
} from "@getpaseo/protocol/skill-library";
import { z } from "zod";
import {
  AgentSkillsSaveResultSchema,
  type AgentSkillSelection,
  type AgentSkillsSaveResult,
} from "@getpaseo/protocol/messages";
import type { InstallationEnvironment } from "@getpaseo/protocol/execution-installation";
import { OwnerAccessExpired } from "./client";

const PreviewSchema = z.object({
  sources: z.record(z.string(), AgentSkillsSaveResultSchema.nullable()),
});
export type InstallationSkillPreview = z.infer<typeof PreviewSchema>;

export async function previewInstallationSkills(
  selection: AgentSkillSelection,
): Promise<InstallationSkillPreview> {
  const response = await fetch("/api/installation/owner/settings/skills/preview", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selection }),
  });
  if (response.status === 401)
    throw new OwnerAccessExpired("Unlock Installation controls in General settings to continue.");
  if (!response.ok) throw new Error("Unable to preview shared skill changes.");
  return PreviewSchema.parse(await response.json());
}

function removalLabel(environment: InstallationEnvironment, name: string): string {
  const label = environment.kind === "host" ? "Host" : "Dev container";
  return `${label}: ${name}`;
}

export function installationSkillStatus({
  preview,
  environments,
  selection,
}: {
  preview: InstallationSkillPreview;
  environments: readonly InstallationEnvironment[];
  selection: AgentSkillSelection;
}): AgentSkillsSaveResult {
  const available = new Set<string>();
  const installed = new Set<string>();
  const ops: AgentSkillsSaveResult["ops"] = [];
  const removals: string[] = [];
  let pending = false;
  for (const environment of environments) {
    const status = preview.sources[environment.serverId];
    if (!status) {
      pending = true;
      continue;
    }
    for (const name of status.available) available.add(name);
    for (const name of status.installed) installed.add(name);
    for (const op of status.ops) ops.push({ ...op, name: removalLabel(environment, op.name) });
    for (const name of status.confirmationRequired?.removals ?? [])
      removals.push(removalLabel(environment, name));
  }
  let state: AgentSkillsSaveResult["state"] = installed.size ? "up-to-date" : "not-installed";
  if (pending || ops.length) state = "drift";
  return {
    state,
    ops,
    available: [...available].sort(),
    installed: [...installed].sort(),
    selection,
    confirmationRequired: removals.length ? { removals } : null,
  };
}

export function installationSkillConfirmations({
  preview,
  environments,
  confirmed,
}: {
  preview: InstallationSkillPreview;
  environments: readonly InstallationEnvironment[];
  confirmed: readonly string[];
}): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const environment of environments) {
    const removals = preview.sources[environment.serverId]?.confirmationRequired?.removals ?? [];
    result[environment.serverId] = removals.filter((name) =>
      confirmed.includes(removalLabel(environment, name)),
    );
  }
  return result;
}

const PreparedSkillSchema = z.strictObject({
  definition: InstallationSkillSchema,
  package: SkillPackageSchema,
});
export type PreparedInstallationSkill = z.infer<typeof PreparedSkillSchema>;

async function skillRequest(operation: "prepare" | "package", input: unknown) {
  const response = await fetch(`/api/installation/owner/settings/skills/${operation}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status === 401)
    throw new OwnerAccessExpired("Unlock Installation controls in General settings to continue.");
  if (!response.ok)
    throw new Error("Unable to load the shared skill package. Check its source and retry.");
  return response.json();
}
export async function prepareInstallationSkill(
  source: SkillSource,
): Promise<PreparedInstallationSkill> {
  return PreparedSkillSchema.parse(await skillRequest("prepare", { source }));
}
export async function readInstallationSkillPackage(definition: InstallationSkill) {
  return z
    .object({ package: SkillPackageSchema })
    .parse(await skillRequest("package", { definition })).package;
}
