import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { detect, detectExisting, detectPrerequisites, inspectDeployment } from "./detect.mjs";
import { fakeContext } from "./fakes.mjs";
import { main } from "./main.mjs";

function deployment(directory, { instance = "paseo-0123456789ab", extra = {} } = {}) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, ".container-installation"), "1\n");
  writeFileSync(
    path.join(directory, ".env"),
    `PASEO_INSTANCE=${instance}\nPASEO_PASSWORD=secret-value\n`,
  );
  for (const [name, content] of Object.entries(extra))
    writeFileSync(path.join(directory, name), content);
  return directory;
}

describe("legacy detection", () => {
  test("an empty machine has nothing to adopt", async () => {
    const context = fakeContext();
    expect(await detectExisting(context)).toEqual({ kind: "none", paths: {} });
  });

  test("a standalone deployment beside a ~/vorteo-source checkout", async () => {
    const context = fakeContext();
    mkdirSync(path.join(context.home, "vorteo-source", ".git"), { recursive: true });
    const legacy = deployment(path.join(context.home, "paseo-instance"), {
      extra: {
        "projects-folder.compose.json": JSON.stringify({
          services: { paseo: { environment: { PASEO_PROJECTS_ROOT: "/Users/owner/dev" } } },
        }),
      },
    });
    const existing = await detectExisting(context);
    expect(existing).toMatchObject({
      kind: "legacy-container",
      paths: { container: legacy },
      deployment: {
        path: legacy,
        instance: "paseo-0123456789ab",
        gateMode: false,
        projectsFolder: "/Users/owner/dev",
      },
    });
    expect(JSON.stringify(existing)).not.toContain("secret-value");
  });

  test("a deployment directly in ~/vorteo and one found only through its Compose label", async () => {
    const outside = deployment(path.join(fakeContext().home, "elsewhere", "deep", "deployment"));
    const context = fakeContext({
      rules: [["docker ps", `${outside}\n`]],
    });
    deployment(context.root);
    const existing = await detectExisting(context);
    expect(existing.kind).toBe("legacy-container");
    expect(existing.candidates).toEqual([context.root, outside]);
    expect(context.run.commands()[0]).toContain("label=com.docker.compose.service=paseo");
  });

  test("Host-only detection makes no Docker calls", async () => {
    const context = fakeContext();
    await detectExisting(context, { docker: false });
    await detectPrerequisites(context, { docker: false });
    expect(context.run.calls.filter((call) => call.command === "docker")).toEqual([]);
  });

  test("a marker without an instance and password is not a deployment", () => {
    const context = fakeContext();
    const directory = path.join(context.home, "half");
    mkdirSync(directory);
    writeFileSync(path.join(directory, ".container-installation"), "1\n");
    writeFileSync(path.join(directory, ".env"), "PASEO_INSTANCE=paseo-x\n");
    expect(inspectDeployment(directory)).toBeNull();
  });

  test("the lab layout with its own Host is reported, not adopted", async () => {
    const context = fakeContext();
    const lab = path.join(context.home, ".local/share/vorteo-lab");
    mkdirSync(path.join(lab, "host"), { recursive: true });
    writeFileSync(path.join(lab, "host", "installation.json"), "{}");
    deployment(path.join(lab, "container"));
    expect(await detectExisting(context)).toMatchObject({
      kind: "legacy-lab",
      paths: { lab, host: path.join(lab, "host"), container: path.join(lab, "container") },
      adoptable: false,
    });
  });

  test("a container-only lab is adoptable, and a separate deployment wins over the lab", async () => {
    const context = fakeContext();
    const lab = path.join(context.home, ".local/share/vorteo-lab");
    deployment(path.join(lab, "container"), { extra: { ".gate-mode": "1\n" } });
    expect(await detectExisting(context)).toMatchObject({
      kind: "legacy-lab",
      adoptable: true,
      deployment: { gateMode: true },
    });
    const separate = deployment(path.join(context.home, "paseo-instance"));
    expect(await detectExisting(context)).toMatchObject({
      kind: "legacy-container",
      paths: { container: separate },
      lab,
    });
  });

  test("a journal marks the installation current, even before it finishes", async () => {
    const context = fakeContext();
    mkdirSync(path.join(context.root, "state"), { recursive: true });
    writeFileSync(
      path.join(context.root, "state", "install.json"),
      JSON.stringify({
        plan: { paths: { container: "/c" } },
        outputs: { origin: "http://localhost:6770" },
      }),
    );
    expect(await detectExisting(context)).toMatchObject({
      kind: "current",
      state: "installing",
      origin: "http://localhost:6770",
      paths: { container: "/c" },
    });
  });
});

describe("prerequisites", () => {
  test("each missing tool carries its platform's fix", async () => {
    const context = fakeContext({
      platform: "linux",
      nodeVersion: "v22.1.0",
      which: (name) => (name === "tailscale" ? "/usr/bin/tailscale" : null),
      rules: [
        [
          "tailscale status",
          Object.assign(new Error("exit 1"), { stdout: '{"BackendState":"NeedsLogin"}' }),
        ],
      ],
    });
    const prerequisites = await detectPrerequisites(context);
    expect(prerequisites.node).toMatchObject({
      ok: false,
      fix: expect.stringContaining("nvm install 24"),
    });
    expect(prerequisites.git).toMatchObject({ ok: false, fix: expect.stringContaining("apt") });
    expect(prerequisites.docker).toMatchObject({
      ok: false,
      running: false,
      fix: expect.stringContaining("docs.docker.com"),
    });
    expect(prerequisites.tailscale).toMatchObject({
      ok: true,
      running: true,
      loggedIn: false,
      fix: expect.stringContaining("tailscale up"),
    });
  });

  test("detect --json prints the contract shape", async () => {
    const context = fakeContext();
    let output = "";
    const status = await main(["detect", "--json"], { context, write: (text) => (output += text) });
    expect(status).toBe(0);
    const result = JSON.parse(output);
    expect(result).toEqual(await detect(context));
    expect(result).toMatchObject({
      platform: "darwin",
      existing: { kind: "none" },
      prerequisites: {
        node: { ok: true, version: "v24.18.0" },
        git: { ok: true },
        docker: { ok: true, running: true },
        tailscale: { ok: true, running: true, loggedIn: true },
      },
    });
  });
});
