import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { protocolVersion, operations, validateParameters } from "./protocol.mjs";
export { operations };
export async function privateFile(path, directory = false) {
  const stat = await lstat(path);
  const correctKind = directory ? stat.isDirectory() : stat.isFile();
  const mode = directory ? 0o700 : 0o600;
  if (!correctKind || stat.uid !== process.getuid() || (stat.mode & 0o777) !== mode) {
    throw new Error("Unsafe helper private path");
  }
}
export function parseConfiguration(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error("Invalid private helper configuration");
  }
  if (
    !config ||
    typeof config.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(config.token) ||
    typeof config.clientRequirement !== "string" ||
    typeof config.helperRequirement !== "string"
  ) {
    throw new Error("Invalid private helper configuration");
  }
  return config;
}
export async function invokeHelper(operation, { preview = false, parameters = {} } = {}) {
  validateParameters(operation, parameters);
  if (!operations.includes(operation)) throw new Error("Unsupported helper operation");
  const runtime = join(
    homedir(),
    ".local/share",
    preview ? "vorteo-macos-helper-preview" : "vorteo-macos-helper",
  );
  await privateFile(runtime, true);
  await privateFile(join(runtime, "config.json"));
  const config = parseConfiguration(await readFile(join(runtime, "config.json"), "utf8"));
  const app = join(
    homedir(),
    "Applications",
    preview ? "Vorteo Permission Helper Preview.app" : "Vorteo Permission Helper.app",
  );
  return new Promise((resolve, reject) => {
    const child = spawn(join(app, "Contents/MacOS/vorteo-helper-client"), [operation], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Helper request timed out; permission outcome may be unknown"));
    }, 40000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 32768) child.kill();
    });
    child.on("close", () => {
      clearTimeout(timeout);
      try {
        const reply = JSON.parse(output);
        if (reply.protocolVersion !== protocolVersion) throw new Error("Protocol mismatch");
        if (reply.data) {
          reply.data = JSON.parse(reply.data);
        }
        resolve(reply);
      } catch {
        reject(new Error("Invalid helper response"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(
      JSON.stringify({ token: config.token, operation, protocolVersion, parameters }),
    );
  });
}
