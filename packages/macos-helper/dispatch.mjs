import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
// Stable entry points dispatch in a fresh Node process to the currently selected,
// signature-sealed bundle. No cached adapter survives upgrade or rollback.
export function adapterEntry(app) {
  return join(app, "Contents/Resources/adapter/invoke.mjs");
}
export function invokeHelper(operation, { preview = false, parameters = {} } = {}) {
  const app = join(
    homedir(),
    "Applications",
    preview ? "Vorteo Permission Helper Preview.app" : "Vorteo Permission Helper.app",
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [adapterEntry(app), operation, ...(preview ? ["--preview"] : [])],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Helper outcome unknown after timeout"));
    }, 45000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 32768) child.kill();
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error("Invalid helper reply"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(parameters));
  });
}
