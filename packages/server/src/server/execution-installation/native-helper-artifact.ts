import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { NativeHelperPlan } from "@getpaseo/protocol/native-helper-maintenance";
import {
  verifyBootstrapReleaseArtifacts,
  assertBootstrapPathsProtected,
  digestBootstrapArtifact,
} from "./coordinator-bootstrap-artifact.js";

export class NativeHelperArtifactError extends Error {}

/** No prepared code runs during admission. The shared artifact verifier checks the
 * whole tooling tree, its source receipt, Node, and every selected entry file. */
export async function verifyNativeHelperTooling(
  plan: NativeHelperPlan,
  writableMountRoots: readonly string[],
): Promise<void> {
  const tooling = plan.tooling;
  if (
    plan.operation === "native-helper-install" &&
    tooling.sourceCommit !== plan.candidate.sourceCommit
  )
    throw new NativeHelperArtifactError(
      "Helper and installation tooling must share reviewed source",
    );
  const entries = [
    { file: tooling.installer, name: "install.mjs" },
    { file: tooling.dispatcher, name: "dispatch.mjs" },
    { file: tooling.invocationClient, name: "dispatch-cli.mjs" },
  ];
  for (const { file, name } of entries) {
    if (file.path !== path.join(tooling.directory, name))
      throw new NativeHelperArtifactError("Helper tooling requires its fixed release entrypoints");
  }
  // These are the shared verifier's file slots, not coordinator configuration.
  // It hashes the complete tooling tree and rejects file aliases outside the release.
  await verifyBootstrapReleaseArtifacts(
    {
      directory: tooling.directory,
      sourceCommit: tooling.sourceCommit,
      artifactSha256: tooling.artifactSha256,
      node: tooling.node,
      entrypoint: tooling.installer,
      configuration: tooling.dispatcher,
      launcher: tooling.invocationClient,
    },
    writableMountRoots,
  );
}

export interface NativeHelperSignatureResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export interface NativeHelperSignatureTools {
  run(command: string, args: string[], input?: string): NativeHelperSignatureResult;
}

const nativeSignatureTools: NativeHelperSignatureTools = {
  run(command, args, input) {
    return spawnSync(command, args, {
      input,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
  },
};

/** Uses OS signature tools only; never launches the application or its client. */
export async function verifyNativeHelperApplication(
  release: NativeHelperPlan["candidate"],
  writableMountRoots: readonly string[],
  tools: NativeHelperSignatureTools = nativeSignatureTools,
): Promise<void> {
  await assertBootstrapPathsProtected([release.directory], writableMountRoots);
  const verifyDigest = async () => {
    if ((await digestBootstrapArtifact(release.directory)) !== release.artifactSha256)
      throw new NativeHelperArtifactError("Prepared helper application changed");
  };
  await verifyDigest();
  function run(command: string, args: string[], input?: string): string {
    const result = tools.run(command, args, input);
    if (result.status !== 0)
      throw new NativeHelperArtifactError("Native helper signature verification failed");
    return result.stdout + result.stderr;
  }
  const app = release.directory;
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  verifyHelperSigners(release, run);
  const plist = path.join(app, "Contents/Info.plist");
  if (
    run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist]).trim() !==
      "com.vorteo.macos-helper" ||
    run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist]).trim() !==
      "VorteoPermissionHelper"
  )
    throw new NativeHelperArtifactError("Unexpected helper bundle identity");
  verifyHelperEntitlements(app, tools);
  await verifyDigest();
}

function verifyHelperSigners(
  release: NativeHelperPlan["candidate"],
  run: (command: string, args: string[]) => string,
): void {
  const app = release.directory;
  const client = path.join(app, "Contents/MacOS/vorteo-helper-client");
  const identities = [
    { file: app, identifier: "com.vorteo.macos-helper", requirement: release.helperRequirement },
    {
      file: client,
      identifier: "com.vorteo.macos-helper.client",
      requirement: release.clientRequirement,
    },
  ];
  const teams: string[] = [];
  const leaves: string[] = [];
  for (const identity of identities) {
    const metadata = run("/usr/bin/codesign", ["-dv", "--verbose=4", identity.file]);
    const identifier = metadata.match(/^Identifier=(.+)$/m)?.[1];
    if (
      identifier !== identity.identifier ||
      !metadata.includes("runtime)") ||
      metadata.includes("Signature=adhoc")
    )
      throw new NativeHelperArtifactError("Unexpected native helper signing identity");
    if (
      release.signingMode === "developer-id" &&
      !metadata.includes("Authority=Developer ID Application:")
    )
      throw new NativeHelperArtifactError("Helper requires Developer ID Application signing");
    const requirement = run("/usr/bin/codesign", ["-dr", "-", identity.file]).match(
      /designated => (.+)/,
    )?.[1];
    if (requirement !== identity.requirement)
      throw new NativeHelperArtifactError(
        "Helper signing requirement differs from reviewed artifact",
      );
    run("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "-R",
      `=${identity.requirement}`,
      identity.file,
    ]);
    teams.push(metadata.match(/^TeamIdentifier=(.+)$/m)?.[1] ?? "");
    const leaf = identity.requirement.match(/certificate leaf = H"([a-f0-9]{40})"/i)?.[1];
    if (release.signingMode === "local" && !leaf)
      throw new NativeHelperArtifactError("Local helper signing must pin its certificate");
    leaves.push(leaf?.toLowerCase() ?? "");
  }
  if (teams[0] !== teams[1] || (release.signingMode === "local" && leaves[0] !== leaves[1]))
    throw new NativeHelperArtifactError("Helper and client signing authorities differ");
}

function verifyHelperEntitlements(app: string, tools: NativeHelperSignatureTools): void {
  // Parse the OS-generated entitlement plist with the OS parser, not an XML regex.
  const entitlementResult = tools.run("/usr/bin/codesign", [
    "-d",
    "--entitlements",
    "-",
    "--xml",
    app,
  ]);
  if (entitlementResult.status !== 0)
    throw new NativeHelperArtifactError("Cannot verify helper entitlements");
  const entitlementJson = tools.run(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "-"],
    entitlementResult.stdout,
  );
  if (entitlementJson.status !== 0)
    throw new NativeHelperArtifactError("Cannot parse helper entitlements");
  const entitlements = z.strictObject({
    "com.apple.security.automation.apple-events": z.literal(true),
  });
  if (!entitlements.safeParse(JSON.parse(entitlementJson.stdout)).success)
    throw new NativeHelperArtifactError("Helper must carry only the Apple Events entitlement");
}
