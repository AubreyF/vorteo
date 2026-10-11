import { once } from "node:events";
import { createBridgeServer } from "./server.js";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  truncateSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadManagedRelease, releaseFileSystem } from "./release-manifest.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function hash(bytes: string | Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
function fixture() {
  const directory = mkdtempSync(join(realpathSync(homedir()), ".nova-release-test-"));
  directories.push(directory);
  const artifactFile = join(directory, "bridge.mjs");
  const configFile = join(directory, "bridge.json");
  const manifestFile = join(directory, "release.json");
  const artifact = "// disposable bundle fixture\n";
  const config = JSON.stringify({
    port: 18777,
    token: "x".repeat(32),
    stateDirectory: join(directory, "state"),
    origin: "https://example.com",
    host: { endpoint: "127.0.0.1:6767", password: "fixture-host", serverId: "host" },
    dev: { endpoint: "127.0.0.1:6768", password: "fixture-dev", serverId: "dev" },
  });
  const manifest = {
    version: 1,
    installationId: "11111111-1111-4111-8111-111111111111",
    sourceCommit: "a".repeat(40),
    artifact: { path: artifactFile, size: Buffer.byteLength(artifact), sha256: hash(artifact) },
    configuration: { path: configFile, size: Buffer.byteLength(config), sha256: hash(config) },
  };
  writeFileSync(artifactFile, artifact, { mode: 0o600 });
  writeFileSync(configFile, config, { mode: 0o600 });
  function saveManifest() {
    writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  }
  saveManifest();
  return {
    directory,
    artifactFile,
    configFile,
    manifestFile,
    manifest,
    saveManifest,
    input: { artifactFile, configFile, manifestFile },
  };
}

it("verifies the selected artifact and parses the same private config bytes it commits", () => {
  const f = fixture();
  const loaded = loadManagedRelease(f.input);
  expect(loaded.identity).toEqual({
    version: 1,
    installationId: f.manifest.installationId,
    sourceCommit: f.manifest.sourceCommit,
    manifestSha256: hash(readFileSync(f.manifestFile)),
    artifactSha256: f.manifest.artifact.sha256,
    configSha256: f.manifest.configuration.sha256,
  });
  expect(loaded.config.host.serverId).toBe("host");
  writeFileSync(f.configFile, "subsequent replacement");
  expect(loaded.config.token).toBe("x".repeat(32));
});

it.each(["artifact", "configuration"])("rejects changed %s bytes and declared sizes", (key) => {
  const f = fixture();
  const selected = key === "artifact" ? f.manifest.artifact : f.manifest.configuration;
  writeFileSync(selected.path, "changed bytes");
  expect(() => loadManagedRelease(f.input)).toThrow("commitment does not match");
  selected.sha256 = hash(readFileSync(selected.path));
  f.saveManifest();
  expect(() => loadManagedRelease(f.input)).toThrow("commitment does not match");
});

it("rejects a manifest for another entrypoint or configuration", () => {
  const f = fixture();
  expect(() =>
    loadManagedRelease({ ...f.input, artifactFile: join(f.directory, "other.mjs") }),
  ).toThrow("does not bind");
  expect(() =>
    loadManagedRelease({ ...f.input, configFile: join(f.directory, "other.json") }),
  ).toThrow("does not bind");
});

it.each(["artifactFile", "configFile", "manifestFile"] as const)(
  "rejects a symlink at %s",
  (key) => {
    const f = fixture();
    const file = f.input[key];
    renameSync(file, file + ".real");
    symlinkSync(file + ".real", file);
    expect(() => loadManagedRelease(f.input)).toThrow("canonical");
  },
);

it("rejects symlinked or writable ancestry", () => {
  const f = fixture();
  const alias = join(f.directory, "alias");
  symlinkSync(f.directory, alias);
  expect(() =>
    loadManagedRelease({ ...f.input, manifestFile: join(alias, "release.json") }),
  ).toThrow("canonical");
  chmodSync(f.directory, 0o777);
  expect(() => loadManagedRelease(f.input)).toThrow("ancestry");
});

it.each(["file", "ancestor"])("rejects foreign ownership of the %s", (kind) => {
  const f = fixture();
  const selected = kind === "file" ? f.artifactFile : f.directory;
  const fs = {
    ...releaseFileSystem,
    inspect(file: string) {
      const stat = releaseFileSystem.inspect(file);
      return file === selected ? { ...stat, uid: releaseFileSystem.uid() + 12345 } : stat;
    },
  };
  expect(() => loadManagedRelease(f.input, fs)).toThrow("ownership");
});

it.each(["artifactFile", "configFile", "manifestFile"] as const)(
  "rejects hard links and unsafe mode on %s",
  (key) => {
    const f = fixture();
    const file = f.input[key];
    linkSync(file, file + ".link");
    expect(() => loadManagedRelease(f.input)).toThrow("singly linked");
    rmSync(file + ".link");
    chmodSync(file, key === "artifactFile" ? 0o666 : 0o644);
    expect(() => loadManagedRelease(f.input)).toThrow("ownership and mode");
  },
);

it("rejects staged substitution between inspection and open", () => {
  const f = fixture();
  const fs = {
    ...releaseFileSystem,
    open(file: string) {
      if (file === f.artifactFile) {
        writeFileSync(file + ".replacement", readFileSync(file), { mode: 0o600 });
        renameSync(file + ".replacement", file);
      }
      return releaseFileSystem.open(file);
    },
  };
  expect(() => loadManagedRelease(f.input, fs)).toThrow("changed before open");
});

it.each(["manifest", "artifact", "configuration"] as const)(
  "rejects %s pathname replacement during the configuration read",
  (kind) => {
    const f = fixture();
    const files = new Map<number, string>();
    let replaced = false;
    const target = kind === "manifest" ? f.manifestFile : f.manifest[kind].path;
    const fs = {
      ...releaseFileSystem,
      open(file: string) {
        const fd = releaseFileSystem.open(file);
        files.set(fd, file);
        return fd;
      },
      read(fd: number, buffer: Buffer) {
        const count = releaseFileSystem.read(fd, buffer);
        if (!replaced && files.get(fd) === f.configFile) {
          replaced = true;
          writeFileSync(target + ".replacement", readFileSync(target), { mode: 0o600 });
          renameSync(target + ".replacement", target);
        }
        return count;
      },
      close(fd: number) {
        files.delete(fd);
        releaseFileSystem.close(fd);
      },
    };
    expect(() => loadManagedRelease(f.input, fs)).toThrow(/changed during/);
    expect(files.size).toBe(0);
  },
);

it("streams a bundle larger than the document limit", () => {
  const f = fixture();
  const bytes = Buffer.alloc(2 * 1024 * 1024, 65);
  writeFileSync(f.artifactFile, bytes);
  f.manifest.artifact.size = bytes.length;
  f.manifest.artifact.sha256 = hash(bytes);
  f.saveManifest();
  expect(loadManagedRelease(f.input).identity.artifactSha256).toBe(hash(bytes));
});

it("rejects an oversized manifest and a non-file artifact", () => {
  const f = fixture();
  writeFileSync(f.manifestFile, Buffer.alloc(64 * 1024 + 1, 32));
  expect(() => loadManagedRelease(f.input)).toThrow("size bound");
  f.saveManifest();
  rmSync(f.artifactFile);
  mkdirSync(f.artifactFile, { mode: 0o700 });
  expect(() => loadManagedRelease(f.input)).toThrow("singly linked");
});

it("validates configuration semantics after its byte commitment matches", () => {
  const f = fixture();
  const bytes = JSON.stringify({ ...JSON.parse(readFileSync(f.configFile, "utf8")), port: 0 });
  writeFileSync(f.configFile, bytes);
  f.manifest.configuration = {
    ...f.manifest.configuration,
    size: Buffer.byteLength(bytes),
    sha256: hash(bytes),
  };
  f.saveManifest();
  expect(() => loadManagedRelease(f.input)).toThrow();
});

it.each(["artifact", "configuration"] as const)(
  "bounds the %s read before allocating its contents",
  (kind) => {
    const f = fixture();
    const limit = kind === "artifact" ? 64 * 1024 * 1024 : 1024 * 1024;
    truncateSync(f.manifest[kind].path, limit + 1);
    expect(() => loadManagedRelease(f.input)).toThrow("size bound");
  },
);

it("serves verified fixture identity without exposing manifest paths or config secrets", async () => {
  const f = fixture();
  const loaded = loadManagedRelease(f.input);
  const server = createBridgeServer({
    token: loaded.config.token,
    release: loaded.identity,
    tools: { list: () => [], call: async () => ({}) },
    events: { list: () => [], subscribe: async () => ({}), unsubscribe: () => {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture listener");
    const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
      headers: { authorization: `Bearer ${loaded.config.token}` },
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body).release).toEqual(loaded.identity);
    expect(body).not.toContain(f.directory);
    expect(body).not.toContain(loaded.config.token);
    expect(body).not.toContain(loaded.config.host.password);
    expect(body).not.toContain(loaded.config.dev.password);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
  }
});
