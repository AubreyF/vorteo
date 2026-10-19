import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AgentProfile, MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import { resolveProfileLaunch } from "../agent/create-agent/profile.js";
import type { ExecutionEnvironmentKind } from "@getpaseo/protocol/execution-installation";

interface WorkerProfileInput {
  provider: string;
  profileId: string;
  environment: ExecutionEnvironmentKind;
  readSettings(): MutableDaemonConfig;
  assertOwner(): void;
}

/** Trusted startup only. Uses normal native profile resolution, without creating a session. */
export function captureFactoryWorkerProfile(input: WorkerProfileInput) {
  const captured = { ...input };
  if (!captured.provider || !captured.profileId)
    throw new Error("Factory requires an explicit configured worker profile and account.");
  const assertSource = () => {
    if (
      (Object.keys(captured) as Array<keyof WorkerProfileInput>).some(
        (key) => input[key] !== captured[key],
      )
    )
      throw new Error("Factory configured worker profile or account changed.");
  };
  const assertOwnerAndSource = () => {
    captured.assertOwner();
    assertSource();
  };
  const readSettings = () => {
    assertOwnerAndSource();
    const settings = structuredClone(captured.readSettings());
    assertOwnerAndSource();
    return settings;
  };
  const resolve = (settings: MutableDaemonConfig) => {
    const config = resolveProfileLaunch(
      { provider: captured.provider, profileId: captured.profileId, cwd: "/" },
      settings.agentProfiles ?? [],
      Date.now(),
      settings,
      captured.environment,
    );
    if (!config.profileLaunch || config.provider !== captured.provider || !config.model)
      throw new Error("Factory configured worker profile does not match its retained account.");
    return config;
  };
  captured.assertOwner();
  const settings = readSettings();
  const config = structuredClone(resolve(settings));
  const accountConfig = structuredClone(settings.providers?.[captured.provider]);
  const assertCurrent = () => {
    assertOwnerAndSource();
    const current = readSettings();
    if (
      !isDeepStrictEqual(resolve(current), config) ||
      !isDeepStrictEqual(current.providers?.[captured.provider], accountConfig)
    )
      throw new Error("Factory configured worker profile or account changed.");
    assertOwnerAndSource();
  };
  assertCurrent();
  return {
    assertCurrent,
    sessionConfig(cwd: string): AgentSessionConfig {
      assertCurrent();
      if (!isAbsolute(cwd)) throw new Error("Factory worker requires an absolute workspace path.");
      const sessionConfig = { ...structuredClone(config), cwd };
      assertOwnerAndSource();
      return sessionConfig;
    },
  };
}

/** Resolve the retained account through the same shared-profile rules as native launches. */
export function readFactoryConfiguredProfiles(
  settings: MutableDaemonConfig,
  provider: string,
  profileId: string,
): AgentProfile[] {
  const profiles = settings.agentProfiles ?? [];
  const matches = profiles.filter((profile) => profile.id === profileId);
  if (matches.length > 1) throw new Error("Factory configured profile is ambiguous.");
  const launch = resolveProfileLaunch({ provider, profileId, cwd: "/" }, profiles, 0, settings);
  if (!launch.profileLaunch || launch.provider !== provider)
    throw new Error("Factory configured profile does not match its retained account.");
  return [launch.profileLaunch.profile];
}
