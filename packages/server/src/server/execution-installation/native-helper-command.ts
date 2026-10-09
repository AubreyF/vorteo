import type { NativeHelperInstallerExit } from "@getpaseo/protocol/native-helper-maintenance";
import { spawn } from "node:child_process";
import type { NativeHelperPlan } from "@getpaseo/protocol/native-helper-maintenance";
import { NativeHelperArtifactError } from "./native-helper-artifact.js";

interface HelperCommand {
  plan: NativeHelperPlan;
  home: string;
  operation: "install" | "status";
  timeoutMs?: number;
  recordInstaller(pid: number): void;
  recordInstallerExit(exit: NativeHelperInstallerExit): void;
}

/** Caller must verify the complete plan before invoking this command runner.
 * A timeout leaves the child observable for recovery, never repeats the operation. */
export function runNativeHelperCommand({
  plan,
  home,
  operation,
  timeoutMs = 120_000,
  recordInstaller,
  recordInstallerExit,
}: HelperCommand): Promise<string> {
  const script =
    operation === "install" ? plan.tooling.installer.path : plan.tooling.invocationClient.path;
  let args = [script, "status"];
  if (operation === "install") {
    args =
      plan.operation === "native-helper-rollback"
        ? [script, "rollback"]
        : [script, "install", plan.candidate.directory];
    if (plan.candidate.signingMode === "local") args.push("--local-signing");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(plan.tooling.node.path, args, {
      cwd: home,
      env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
    });
    let settled = false;
    let output = "";
    function fail() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new NativeHelperArtifactError(
          "Helper command outcome is unresolved. Inspect before recovery.",
        ),
      );
    }
    const timer = setTimeout(fail, timeoutMs);
    timer.unref();
    child.on("spawn", () => {
      if (operation !== "install") return;
      if (!child.pid) {
        fail();
        return;
      }
      try {
        recordInstaller(child.pid);
      } catch {
        fail();
      }
    });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (Buffer.byteLength(output) + chunk.length > 65536) {
        fail();
        return;
      }
      output += chunk.toString("utf8");
    });
    child.on("close", (code, signal) => {
      if (operation === "install" && child.pid) {
        try {
          recordInstallerExit({ code, signal });
        } catch {
          fail();
          return;
        }
      }
      if (settled) return;
      if (code !== 0 && !(operation === "status" && code === 1)) {
        fail();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(output);
    });
    child.stdin.end("{}\n");
  });
}
