import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHelper } from "./install.mjs";

let home;
let candidate;
let app;
let runtime;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "vorteo-installer-test-"));
  candidate = join(home, "candidate.app");
  app = join(home, "Applications/Vorteo Permission Helper.app");
  runtime = join(home, ".local/share/vorteo-macos-helper");
  await mkdir(candidate);
  await writeFile(join(candidate, "fixture.json"), JSON.stringify({ team: "A", build: "one" }));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

// All process operations are fakes. Filesystem operations use only the temporary
// home; no codesign, ps, open, IPC, credentials, or production lifecycle executes.
function fixture({ replace, duringValidation } = {}) {
  const calls = [];
  function bundle(path) {
    const root = path.endsWith("vorteo-helper-client")
      ? path.slice(0, -"/Contents/MacOS/vorteo-helper-client".length)
      : path;
    return JSON.parse(readFileSync(join(root, "fixture.json"), "utf8"));
  }
  return {
    calls,
    options: {
      home,
      installerArgs: ["install", candidate],
      async copy(source, destination, options) {
        if (source === candidate && replace)
          await writeFile(join(candidate, "fixture.json"), JSON.stringify(replace));
        await cp(source, destination, options);
      },
      spawn(command, args) {
        if (command !== "/usr/bin/codesign") throw new Error(`Unexpected command: ${command}`);
        const path = args.at(-1);
        const data = bundle(path);
        const client = path.endsWith("vorteo-helper-client");
        const id = "com.vorteo.macos-helper" + (client ? ".client" : "");
        let stdout = "";
        if (args.includes("--entitlements")) {
          stdout = "<key>com.apple.security.automation.apple-events</key><true/>";
          if (duringValidation && path.endsWith(".staged"))
            writeFileSync(join(path, "fixture.json"), JSON.stringify(duringValidation));
        } else if (args.includes("-dv")) {
          stdout = `Identifier=${id}\nflags=runtime)\nAuthority=Developer ID Application: Fixture\nTeamIdentifier=${data.team}\n`;
        } else if (args.includes("-dr")) {
          stdout = `designated => identifier "${id}" and team "${data.team}"`;
        }
        return { status: 0, stdout, stderr: "" };
      },
      exec(command) {
        if (command === "/usr/bin/stat") return "Regular File";
        if (command === "/usr/libexec/PlistBuddy") return "com.vorteo.macos-helper";
        // Record lifecycle entry without executing anything on the Host.
        calls.push(command);
        if (command === "/bin/ps") return "";
        if (command === "/usr/bin/open") return "";
        throw new Error(`Unexpected command: ${command}`);
      },
      async invoke(operation) {
        calls.push(operation);
        return { ok: true };
      },
    },
  };
}
async function expectUntouched(calls) {
  expect(calls).toEqual([]);
  for (const path of [app, app + ".previous", app + ".staged", app + ".install-lock", runtime])
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("installer staged provenance", () => {
  it.each([
    { team: "B", build: "two" },
    { team: "A", build: "two" },
  ])("rejects a valid substituted bundle before lifecycle entry: %j", async (replace) => {
    const test = fixture({ replace });
    await expect(installHelper(test.options)).rejects.toThrow(
      "Staged bundle differs from validated candidate",
    );
    await expectUntouched(test.calls);
  });
  it("rejects changes during staged signature validation before lifecycle entry", async () => {
    const test = fixture({ duringValidation: { team: "B", build: "two" } });
    await expect(installHelper(test.options)).rejects.toThrow(
      "Bundle changed during signature validation",
    );
    await expectUntouched(test.calls);
  });
  it("derives first-install configuration and provenance from the verified staged bundle", async () => {
    const test = fixture();
    await installHelper(test.options);
    const config = JSON.parse(await readFile(join(runtime, "config.json"), "utf8"));
    const receipt = JSON.parse(await readFile(join(runtime, "installation.json"), "utf8"));
    expect(config.helperRequirement).toBe(receipt.signed.helper.requirement);
    expect(config.clientRequirement).toBe(receipt.signed.client.requirement);
    expect(receipt.signed.bundleSHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(app, "fixture.json"), "utf8")).toBe(
      JSON.stringify({ team: "A", build: "one" }),
    );
    expect(test.calls).toEqual(["/bin/ps", "/bin/ps", "/usr/bin/open", "status"]);
  });
});
