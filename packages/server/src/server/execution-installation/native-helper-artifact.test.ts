import { afterEach, expect, test } from "vitest";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { NativeHelperPlanSchema } from "@getpaseo/protocol/native-helper-maintenance";
import { digestBootstrapArtifact } from "./coordinator-bootstrap-artifact.js";
import {
  verifyNativeHelperTooling,
  verifyNativeHelperApplication,
} from "./native-helper-artifact.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "helper-artifact-")));
  roots.push(root);
  const directory = path.join(root, "tooling");
  await mkdir(directory, { mode: 0o700 });
  async function file(name: string, content: string, mode = 0o600) {
    const filename = path.join(directory, name);
    await writeFile(filename, content, { mode });
    return { path: filename, sha256: createHash("sha256").update(content).digest("hex") };
  }
  const sourceCommit = "a".repeat(40);
  const node = await file("node", "fixture executable, never invoked", 0o700);
  const installer = await file("install.mjs", 'import "./host.mjs";');
  const dispatcher = await file("dispatch.mjs", "export {};\n");
  const invocationClient = await file("dispatch-cli.mjs", 'import "./host.mjs";');
  await file("host.mjs", 'import "./protocol.mjs";');
  await file("protocol.mjs", "export const version = 1;");
  await file(".installation-source.json", JSON.stringify({ sourceCommit }));
  const plan = NativeHelperPlanSchema.parse({
    version: 1,
    operation: "native-helper-install",
    installationId: "00000000-0000-4000-8000-000000000001",
    candidate: {
      sourceCommit,
      directory: path.join(root, "candidate.app"),
      artifactSha256: "b".repeat(64),
      signingMode: "local",
      helperRequirement: "fixture",
      clientRequirement: "fixture",
    },
    previous: null,
    retainedRollback: null,
    tooling: {
      sourceCommit,
      directory,
      artifactSha256: await digestBootstrapArtifact(directory),
      node,
      installer,
      dispatcher,
      invocationClient,
    },
    destination: {
      application: path.join(root, "Helper.app"),
      runtime: path.join(root, "runtime"),
    },
    expectedState: {
      configurationSha256: null,
      policySha256: null,
      installationReceiptSha256: null,
    },
  });
  return { root, plan, file };
}

test("helper tooling admission binds transitive modules without executing candidate code", async () => {
  const { plan, file } = await fixture();
  await expect(verifyNativeHelperTooling(plan, [])).resolves.toBeUndefined();
  await file("protocol.mjs", 'throw new Error("unreviewed dependency");');
  await expect(verifyNativeHelperTooling(plan, [])).rejects.toThrow("artifact changed");
});

test("helper tooling requires source provenance and fixed entrypoints", async () => {
  const { plan } = await fixture();
  const wrongSource = structuredClone(plan);
  wrongSource.candidate.sourceCommit = "c".repeat(40);
  await expect(verifyNativeHelperTooling(wrongSource, [])).rejects.toThrow("share reviewed source");
  const wrongEntry = structuredClone(plan);
  wrongEntry.tooling.installer = wrongEntry.tooling.dispatcher;
  await expect(verifyNativeHelperTooling(wrongEntry, [])).rejects.toThrow(
    "fixed release entrypoints",
  );
  await writeFile(
    path.join(plan.tooling.directory, ".installation-source.json"),
    JSON.stringify({ sourceCommit: "c".repeat(40) }),
  );
  await expect(verifyNativeHelperTooling(plan, [])).rejects.toThrow("installation receipt");
});

test("helper tooling rejects guest-writable releases and a nonexecutable Node", async () => {
  const { root, plan } = await fixture();
  await expect(verifyNativeHelperTooling(plan, [root])).rejects.toThrow("mount");
  await chmod(plan.tooling.node.path, 0o600);
  await expect(verifyNativeHelperTooling(plan, [])).rejects.toThrow("not executable");
});

test("helper tooling refuses imports replaced by external aliases", async () => {
  const { root, plan } = await fixture();
  const external = path.join(root, "external.mjs");
  await writeFile(external, "export {};", { mode: 0o600 });
  const dependency = path.join(plan.tooling.directory, "protocol.mjs");
  await rm(dependency);
  await symlink(external, dependency);
  await expect(verifyNativeHelperTooling(plan, [])).rejects.toThrow("outside its release");
});

function signatureFixture(plan: ReturnType<typeof NativeHelperPlanSchema.parse>) {
  const leaf = 'certificate leaf = H"' + "a".repeat(40) + '"';
  const release = {
    ...plan.candidate,
    directory: plan.tooling.directory,
    artifactSha256: plan.tooling.artifactSha256,
    helperRequirement: `identifier "com.vorteo.macos-helper" and ${leaf}`,
    clientRequirement: `identifier "com.vorteo.macos-helper.client" and ${leaf}`,
  };
  const calls: string[] = [];
  const tools = {
    run(command: string, args: string[], input?: string) {
      calls.push(command);
      let stdout = "";
      if (command === "/usr/bin/plutil") {
        expect(input).toBe("fixture entitlement plist");
        stdout = JSON.stringify({ "com.apple.security.automation.apple-events": true });
      } else if (command === "/usr/libexec/PlistBuddy") {
        stdout = args.includes("Print :CFBundleIdentifier")
          ? "com.vorteo.macos-helper"
          : "VorteoPermissionHelper";
      } else {
        expect(command).toBe("/usr/bin/codesign");
        const client = args.at(-1)?.endsWith("/vorteo-helper-client");
        if (args.includes("-dv"))
          stdout = `Identifier=com.vorteo.macos-helper${client ? ".client" : ""}\nflags=0x10000(runtime)\nTeamIdentifier=fixture\n`;
        if (args.includes("-dr"))
          stdout = `designated => ${client ? release.clientRequirement : release.helperRequirement}\n`;
        if (args.includes("--entitlements")) stdout = "fixture entitlement plist";
      }
      return { status: 0, stdout, stderr: "" };
    },
  };
  return { release, tools, calls };
}

test("helper application verification invokes fixed OS tools without launching prepared executables", async () => {
  const { plan } = await fixture();
  const f = signatureFixture(plan);
  await expect(verifyNativeHelperApplication(f.release, [], f.tools)).resolves.toBeUndefined();
  expect(new Set(f.calls)).toEqual(
    new Set(["/usr/bin/codesign", "/usr/bin/plutil", "/usr/libexec/PlistBuddy"]),
  );
});

test("helper application refuses ad hoc, wrong identity, missing runtime and changed requirements", async () => {
  const { plan } = await fixture();
  for (const metadata of [
    "Identifier=com.vorteo.macos-helper\nflags=0x10000(runtime)\nSignature=adhoc\n",
    "Identifier=another.application\nflags=0x10000(runtime)\n",
    "Identifier=com.vorteo.macos-helper\n",
  ]) {
    const f = signatureFixture(plan);
    const tools = {
      run(command: string, args: string[], input?: string) {
        const result = f.tools.run(command, args, input);
        return args.includes("-dv") ? { ...result, stdout: metadata } : result;
      },
    };
    await expect(verifyNativeHelperApplication(f.release, [], tools)).rejects.toThrow(
      "signing identity",
    );
  }
  const f = signatureFixture(plan);
  const tools = {
    run(command: string, args: string[], input?: string) {
      const result = f.tools.run(command, args, input);
      return args.includes("-dr")
        ? { ...result, stdout: "designated => another requirement" }
        : result;
    },
  };
  await expect(verifyNativeHelperApplication(f.release, [], tools)).rejects.toThrow(
    "differs from reviewed",
  );
});

test("helper application refuses extra entitlements and failed signature tooling", async () => {
  const { plan } = await fixture();
  const f = signatureFixture(plan);
  const extra = {
    run(command: string, args: string[], input?: string) {
      const result = f.tools.run(command, args, input);
      return command === "/usr/bin/plutil"
        ? {
            ...result,
            stdout: JSON.stringify({
              "com.apple.security.automation.apple-events": true,
              "com.apple.security.get-task-allow": true,
            }),
          }
        : result;
    },
  };
  await expect(verifyNativeHelperApplication(f.release, [], extra)).rejects.toThrow(
    "only the Apple Events",
  );
  const failed = { run: () => ({ status: null, stdout: "", stderr: "fixture timeout" }) };
  await expect(verifyNativeHelperApplication(f.release, [], failed)).rejects.toThrow(
    "signature verification failed",
  );
});

test("helper application rechecks all bytes after signature inspection", async () => {
  const { plan } = await fixture();
  const f = signatureFixture(plan);
  const tools = {
    run(command: string, args: string[], input?: string) {
      const result = f.tools.run(command, args, input);
      if (command === "/usr/bin/plutil")
        writeFileSync(
          path.join(plan.tooling.directory, "protocol.mjs"),
          "changed during inspection",
        );
      return result;
    },
  };
  await expect(verifyNativeHelperApplication(f.release, [], tools)).rejects.toThrow(
    "application changed",
  );
});

test("helper application enforces the selected signing strategy and matching signer authority", async () => {
  const { plan } = await fixture();
  const developer = signatureFixture(plan);
  developer.release.signingMode = "developer-id";
  await expect(
    verifyNativeHelperApplication(developer.release, [], developer.tools),
  ).rejects.toThrow("Developer ID");
  const developerTools = {
    run(command: string, args: string[], input?: string) {
      const result = developer.tools.run(command, args, input);
      return args.includes("-dv")
        ? { ...result, stdout: result.stdout + "Authority=Developer ID Application: Fixture\n" }
        : result;
    },
  };
  await expect(
    verifyNativeHelperApplication(developer.release, [], developerTools),
  ).resolves.toBeUndefined();
  const local = signatureFixture(plan);
  local.release.helperRequirement = 'identifier "com.vorteo.macos-helper"';
  await expect(verifyNativeHelperApplication(local.release, [], local.tools)).rejects.toThrow(
    "pin its certificate",
  );
  const mismatch = signatureFixture(plan);
  const tools = {
    run(command: string, args: string[], input?: string) {
      const result = mismatch.tools.run(command, args, input);
      const isClient = args.at(-1)?.endsWith("/vorteo-helper-client");
      return args.includes("-dv") && isClient
        ? {
            ...result,
            stdout: result.stdout.replace("TeamIdentifier=fixture", "TeamIdentifier=other"),
          }
        : result;
    },
  };
  await expect(verifyNativeHelperApplication(mismatch.release, [], tools)).rejects.toThrow(
    "authorities differ",
  );
});
