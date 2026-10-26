import { createHash } from "node:crypto";
import { Script, runInNewContext } from "node:vm";
import * as fs from "node:fs";
import {
  realpathSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  truncateSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { InstallationConfigSchema, type InstallationConfig } from "../config.js";
import type { EnrollmentNativeIdentity } from "./native-identity.js";
import {
  DEV_REGISTRATION_INSPECTION_SCRIPT,
  DevRegistrationReceiptSchema,
  readDevRegistrationBinding,
  verifyDevRegistrationObservation,
  assertDevRegistrationPathStat,
  inspectDevRegistrationSelector,
  hashDevRegistrationFile,
  prepareDevRegistrationPublication,
  publishDevRegistration,
  captureC1RegistrationDocuments,
  retainC1RegistrationDocuments,
  type CapturedRegistrationDocument,
} from "./dev-registration.js";

function fixture() {
  const installationId = "8ac45b41-5533-431e-961f-80a2538986ff";
  const containerId = "a".repeat(64);
  const file = (name: string) => ({ path: "/protected/" + name, sha256: "b".repeat(64) });
  const startup = {
    path: "/usr/bin/tini",
    args: ["--", "/entry"],
    entrypoint: ["/usr/bin/tini", "--", "/entry"],
    cmd: null,
  };
  const receipt = DevRegistrationReceiptSchema.parse({
    version: 1,
    purpose: "dev-persistent-registration",
    installationId,
    containerId,
    startup,
    account: {
      user: "paseo",
      uid: 1000,
      gid: 1000,
      home: "/home/paseo",
      stateDirectory: "/home/paseo/.paseo",
    },
    supervisorPlanSha256: "c".repeat(64),
    launcherPath: "/protected/entry-pointer",
    selectionPath: "/protected/releases/current",
    releaseRoot: "/protected/releases",
    selectionCustody: "configured-dev-user",
    parentArgumentsSha256: "d".repeat(64),
    files: {
      containerEntrypoint: file("entry"),
      supervisorConfiguration: file("supervisord.conf"),
      profileLauncher: file("start-paseo"),
      dockerEntrypoint: file("docker-entrypoint"),
      entrySelection: file("entry-pointer"),
      factoryEntrypoint: file("factory-entry"),
      factoryLauncher: file("factory-launch.py"),
      supervisorEntrypoint: file("supervisor-entry"),
      parentExecutable: file("python"),
      node: file("node"),
    },
  });
  const config: InstallationConfig = {
    public: {
      version: 1,
      installationId,
      origin: "https://installation.example",
      environments: [
        { kind: "host", serverId: "host", useTls: true, endpoint: "https://host.example" },
        { kind: "container", serverId: "dev", useTls: true, endpoint: "https://dev.example" },
      ],
    },
    listenPort: 6767,
    webDistDir: "/web",
    stateDir: "/state",
    ownerPasswordHash: "$2test",
    hostAgentTokenHash: "1".repeat(64),
    containerAgentTokenHash: "2".repeat(64),
    host: {
      endpoint: "127.0.0.1:6767",
      password: "host",
      launchdService: "gui/501/local.vorteo.host",
    },
    container: {
      endpoint: "127.0.0.1:6768",
      password: "dev",
      supervisorMaintenance: {
        node: "/host/node",
        script: "/host/plan",
        sha256: receipt.supervisorPlanSha256,
      },
    },
    containerSourceUpdates: {
      sourceRepository: "/source",
      toolingDirectory: "/tooling",
      integrationRef: "refs/heads/main",
      receiptFile: "/host/source-receipt",
      docker: "/host/docker",
      containerId,
      user: receipt.account.user,
      node: receipt.files.node.path,
      home: receipt.account.stateDirectory,
      releaseRoot: receipt.releaseRoot,
      currentReleaseLink: receipt.selectionPath,
    },
  };
  const expected: Extract<EnrollmentNativeIdentity, { environment: "container" }> = {
    version: 1,
    environment: "container",
    target: "container-daemon",
    installationId,
    custodyOwnerUid: 501,
    installationRoot: "/host/installation",
    stateDirectory: "/host/state",
    containerId,
    containerUid: 1000,
    containerGid: 1000,
    containerHome: receipt.account.home,
    containerStateDirectory: receipt.account.stateDirectory,
    launcherPath: receipt.launcherPath,
    selectionPath: receipt.selectionPath,
  };
  const bytes = Buffer.from(JSON.stringify(receipt));
  const reference = {
    receiptFile: "/host/registration.json",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const supervisor = {
    pid: 101,
    parentPid: 7,
    uid: 1000,
    gid: 1000,
    bootId: "boot-one",
    startIdentity: "100",
    executable: receipt.files.node.path,
    argumentsSha256: "e".repeat(64),
  };
  const selectedRelease = "/protected/releases/one";
  const observation = {
    files: structuredClone(receipt.files),
    entrySelection: receipt.files.factoryEntrypoint.path,
    selectionPath: receipt.selectionPath,
    selectedRelease,
    parent: {
      pid: 7,
      parentPid: 1,
      uid: 0,
      bootId: supervisor.bootId,
      startIdentity: "7",
      executable: receipt.files.parentExecutable.path,
      argumentsSha256: receipt.parentArgumentsSha256,
    },
  };
  return {
    bytes,
    reference,
    config,
    expected,
    startup,
    receipt,
    supervisor,
    selectedRelease,
    observation,
  };
}

test("optional registration leaves existing protected configuration readable", () => {
  const f = fixture();
  expect(InstallationConfigSchema.parse(f.config).container.persistentRegistration).toBeUndefined();
  f.config.container.persistentRegistration = f.reference;
  expect(InstallationConfigSchema.parse(f.config).container.persistentRegistration).toEqual(
    f.reference,
  );
});

test("reads the pinned receipt without deriving identity from running argv", () => {
  const f = fixture();
  expect(readDevRegistrationBinding(f)).toEqual(f.receipt);
});

test("rejects changed receipt bytes even when their JSON remains valid", () => {
  const f = fixture();
  f.bytes = Buffer.concat([f.bytes, Buffer.from("\n")]);
  expect(() => readDevRegistrationBinding(f)).toThrow("receipt changed");
});

test.each(["container", "startup", "account", "plan", "launcher", "selector", "node"])(
  "rejects changed %s binding",
  (field) => {
    const f = fixture();
    switch (field) {
      case "container":
        f.expected.containerId = "f".repeat(64);
        break;
      case "startup":
        f.startup.args.push("different");
        break;
      case "account":
        f.expected.containerUid++;
        break;
      case "plan":
        f.config.container.supervisorMaintenance!.sha256 = "f".repeat(64);
        break;
      case "launcher":
        f.expected.launcherPath = "/another/launcher";
        break;
      case "selector":
        f.expected.selectionPath = "/another/selector";
        break;
      case "node":
        f.config.containerSourceUpdates!.node = "/another/node";
        break;
    }
    expect(() => readDevRegistrationBinding(f)).toThrow("binding differs");
  },
);

test("refuses registration without the existing maintenance plan", () => {
  const f = fixture();
  delete f.config.container.supervisorMaintenance;
  expect(() => readDevRegistrationBinding(f)).toThrow("configured supervisor maintenance plan");
});

test("matches independently observed files, pointer, selector and native parent", () => {
  const f = fixture();
  expect(verifyDevRegistrationObservation(f)).toEqual(f.observation);
});

test.each([
  "configuration",
  "pointer",
  "selector",
  "parent executable",
  "parent lifetime",
  "parent account",
  "parent argv",
  "release",
])("rejects changed native %s evidence", (field) => {
  const f = fixture();
  switch (field) {
    case "configuration":
      f.observation.files.supervisorConfiguration.sha256 = "f".repeat(64);
      break;
    case "pointer":
      f.observation.entrySelection = "/another/entry";
      break;
    case "selector":
      f.observation.selectionPath = "/another/selector";
      break;
    case "parent executable":
      f.observation.parent.executable = "/another/python";
      break;
    case "parent lifetime":
      f.observation.parent.bootId = "other-boot";
      break;
    case "parent account":
      f.observation.parent.uid = 1000;
      break;
    case "parent argv":
      f.observation.parent.argumentsSha256 = "f".repeat(64);
      break;
    case "release":
      f.observation.selectedRelease = "/protected/releases/another";
      break;
  }
  expect(() => verifyDevRegistrationObservation(f)).toThrow("native parent differs");
});

test("supervisor replacement preserves registration when the independently observed parent is unchanged", () => {
  const f = fixture();
  const original = verifyDevRegistrationObservation(f);
  f.supervisor.pid = 202;
  f.supervisor.startIdentity = "200";
  expect(verifyDevRegistrationObservation(f)).toEqual(original);
});

test("rejects noncanonical or unknown registration fields", () => {
  const f = fixture();
  expect(
    DevRegistrationReceiptSchema.safeParse({ ...f.receipt, launcherPath: "/protected/../launcher" })
      .success,
  ).toBe(false);
  expect(
    DevRegistrationReceiptSchema.safeParse({ ...f.receipt, handoffVerified: true }).success,
  ).toBe(false);
});

test("independent observer is valid JavaScript without executing guest code", () => {
  expect(new Script(DEV_REGISTRATION_INSPECTION_SCRIPT)).toBeInstanceOf(Script);
});

function publicationFixture() {
  const f = fixture();
  const worker = { ...f.supervisor, pid: 102, parentPid: f.supervisor.pid, startIdentity: "101" };
  const readiness = {
    phase: "native-and-authenticated-ready",
    installationId: f.receipt.installationId,
    containerId: f.receipt.containerId,
    account: f.receipt.account,
    startup: f.startup,
    supervisor: f.supervisor,
    worker,
    supervisorEntrypoint: f.receipt.files.supervisorEntrypoint.path,
    selectedRelease: f.selectedRelease,
    sourceCommit: "a".repeat(40),
    authenticated: {
      serverId: "dev",
      workerPid: worker.pid,
      workerInstanceId: "new-worker-instance",
    },
    registration: f.observation,
  };
  return {
    config: f.config,
    receipt: f.receipt,
    configurationFile: "/host/coordinator.json",
    configurationSha256: createHash("sha256").update(JSON.stringify(f.config)).digest("hex"),
    configurationBytes: Buffer.from(JSON.stringify(f.config)),
    receiptFile: "/host/registration.json",
    readiness,
    protectedSourceCommit: readiness.sourceCommit,
  };
}

test("Linux symlink mode 0777 retains ownership custody without treating permission bits as write authority", () => {
  expect(() =>
    assertDevRegistrationPathStat({ uid: 1000, mode: 0o120777, kind: "link" }, 1000),
  ).not.toThrow();
  expect(() =>
    assertDevRegistrationPathStat({ uid: 1000, mode: 0o40777, kind: "directory" }, 1000),
  ).toThrow("writable");
  expect(() =>
    assertDevRegistrationPathStat({ uid: 1000, mode: 0o120777, kind: "link" }, 0),
  ).toThrow("owner differs");
});

test("streams a binary larger than 16 MiB through the exact standalone observer function", () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "dev-registration-binary-"));
  try {
    const file = path.join(root, "node");
    const bytes = Buffer.alloc(20 * 1024 * 1024, 0x61);
    writeFileSync(file, bytes, { mode: 0o600 });
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(hashDevRegistrationFile(file)).toBe(expected);
    expect(
      runInNewContext(`(${hashDevRegistrationFile.toString()})(file, fs, createHash)`, {
        file,
        fs,
        createHash,
        Buffer,
      }),
    ).toBe(expected);
    truncateSync(file, 256 * 1024 * 1024 + 1);
    expect(() => hashDevRegistrationFile(file)).toThrow("bounded regular-file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepares registration with only the protected Node and receipt reference changed", () => {
  const f = publicationFixture();
  if (!f.config.containerSourceUpdates) throw new Error("fixture settings absent");
  f.config.containerSourceUpdates.node = "/previous/node";
  f.config.public.profileSharing = true;
  const original = structuredClone(f.config);
  f.configurationBytes = Buffer.from(JSON.stringify(original));
  f.configurationSha256 = createHash("sha256").update(f.configurationBytes).digest("hex");
  const prepared = prepareDevRegistrationPublication(f);
  const changed = InstallationConfigSchema.parse(
    JSON.parse(prepared.configurationBytes.toString()),
  );
  const expected = structuredClone(original);
  if (!expected.containerSourceUpdates) throw new Error("fixture settings absent");
  expected.containerSourceUpdates.node = f.receipt.files.node.path;
  expected.container.persistentRegistration = prepared.reference;
  expect(changed).toEqual(expected);
  expect(f.config).toEqual(original);
  expect(JSON.parse(prepared.receiptBytes.toString()).selectionCustody).toBe("configured-dev-user");
});

test.each([
  "unverified phase",
  "wrong authentication",
  "wrong source",
  "wrong Node",
  "wrong uid",
  "wrong gid",
  "wrong selector",
  "wrong file hash",
])("refuses receipt publication with %s", (kind) => {
  const f = publicationFixture();
  switch (kind) {
    case "unverified phase":
      f.readiness.phase = "started-unverified";
      break;
    case "wrong authentication":
      f.readiness.authenticated.workerPid++;
      break;
    case "wrong source":
      f.protectedSourceCommit = "b".repeat(40);
      break;
    case "wrong Node":
      f.readiness.supervisor.executable = "/another/node";
      break;
    case "wrong uid":
      f.readiness.worker.uid++;
      break;
    case "wrong gid":
      f.readiness.worker.gid++;
      break;
    case "wrong selector":
      f.readiness.registration.selectionPath = "/another/current";
      break;
    case "wrong file hash":
      f.readiness.registration.files.node.sha256 = "f".repeat(64);
      break;
  }
  expect(() => prepareDevRegistrationPublication(f)).toThrow();
});

test("publishes a private receipt and exact config through the existing addressed file transaction", () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "dev-registration-publication-"));
  try {
    const f = publicationFixture();
    f.configurationFile = path.join(root, "coordinator.json");
    f.receiptFile = path.join(root, "registration.json");
    const original = Buffer.from(JSON.stringify(f.config));
    writeFileSync(f.configurationFile, original, { mode: 0o600 });
    f.configurationSha256 = createHash("sha256").update(original).digest("hex");
    const prepared = prepareDevRegistrationPublication(f);
    const input = {
      prepared,
      attemptFile: path.join(root, "attempt.json"),
      reservationSha256: "c".repeat(64),
      assertCurrent() {},
    };
    publishDevRegistration(input);
    expect(readFileSync(f.configurationFile)).toEqual(prepared.configurationBytes);
    expect(readFileSync(f.receiptFile)).toEqual(prepared.receiptBytes);
    expect(() => publishDevRegistration(input)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changed native admission or stale configuration prevents receipt publication", () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "dev-registration-refusal-"));
  try {
    const f = publicationFixture();
    f.configurationFile = path.join(root, "coordinator.json");
    f.receiptFile = path.join(root, "registration.json");
    const original = Buffer.from(JSON.stringify(f.config));
    writeFileSync(f.configurationFile, original, { mode: 0o600 });
    f.configurationSha256 = createHash("sha256").update(original).digest("hex");
    const prepared = prepareDevRegistrationPublication(f);
    const base = {
      prepared,
      attemptFile: path.join(root, "attempt.json"),
      reservationSha256: "c".repeat(64),
    };
    expect(() =>
      publishDevRegistration({
        ...base,
        assertCurrent() {
          throw new Error("native custody changed");
        },
      }),
    ).toThrow("native custody changed");
    expect(existsSync(f.receiptFile)).toBe(false);
    writeFileSync(f.configurationFile, original + "\n");
    expect(() => publishDevRegistration({ ...base, assertCurrent() {} })).toThrow();
    expect(existsSync(f.receiptFile)).toBe(false);
    expect(existsSync(base.attemptFile)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects uncaptured configuration changes and asynchronous publication admission", () => {
  const f = publicationFixture();
  f.config.public.profileSharing = true;
  expect(() => prepareDevRegistrationPublication(f)).toThrow("captured bytes");
  const g = publicationFixture();
  const prepared = prepareDevRegistrationPublication(g);
  expect(() =>
    publishDevRegistration({
      prepared,
      attemptFile: "/host/attempt.json",
      reservationSha256: "c".repeat(64),
      async assertCurrent() {},
    }),
  ).toThrow("synchronous current admission");
});

test("rejects changed prepared publication bytes before admission", () => {
  const prepared = prepareDevRegistrationPublication(publicationFixture());
  prepared.configurationBytes[0] = 0;
  expect(() =>
    publishDevRegistration({
      prepared,
      attemptFile: "/host/attempt.json",
      reservationSha256: "c".repeat(64),
      assertCurrent() {
        throw new Error("must not reach admission");
      },
    }),
  ).toThrow("publication bytes changed");
});

/**
 * Selector fixtures live under the real home directory, since custody rejects shared temporary
 * roots. Custody checks each ancestor more than once per inspection and fails if it changed in
 * between, and other processes keep changing the home directory. Freeze the stat of directories
 * above the fixture roots, which these tests do not examine; everything inside stays real.
 */
function stableAncestorFs(...roots: string[]): typeof fs {
  const frozen = new Map<string, ReturnType<typeof fs.lstatSync>>();
  const above = (value: string) =>
    roots.some((root) => root.startsWith(value.endsWith(path.sep) ? value : value + path.sep));
  const lstatSync = ((value: string, options?: fs.StatSyncOptions) => {
    if (!above(value)) return fs.lstatSync(value, options);
    const key = `${options?.bigint === true}:${value}`;
    if (!frozen.has(key)) frozen.set(key, fs.lstatSync(value, options));
    return frozen.get(key);
  }) as typeof fs.lstatSync;
  return { ...fs, lstatSync };
}

function selectorFixture() {
  const root = mkdtempSync(path.join(realpathSync(homedir()), ".vorteo-selector-test-"));
  const accountHome = path.join(root, "home");
  const state = path.join(root, "state");
  fs.mkdirSync(accountHome, { mode: 0o700 });
  fs.mkdirSync(state, { mode: 0o700 });
  const releaseRoot = path.join(state, "managed", "releases");
  fs.mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });
  const release = path.join(releaseRoot, "one");
  fs.mkdirSync(release, { mode: 0o700 });
  const selectionPath = path.join(releaseRoot, "current");
  fs.symlinkSync(release, selectionPath);
  const input = {
    selectionPath,
    releaseRoot,
    account: { uid: process.getuid!(), home: accountHome, stateDirectory: state },
  };
  return { root, release, input };
}

test("complete observer selector traversal permits only the configured user home/state chains", () => {
  const f = selectorFixture();
  try {
    const custody = runInNewContext(
      `(${inspectDevRegistrationSelector.toString()})(input, fs, path, assertStat)`,
      {
        input: f.input,
        fs: stableAncestorFs(f.root),
        path,
        assertStat: assertDevRegistrationPathStat,
      },
    );
    expect(custody.selectedRelease).toBe(f.release);
    expect(() => custody.assertCurrent()).not.toThrow();
    fs.unlinkSync(f.input.selectionPath);
    fs.symlinkSync(f.release, f.input.selectionPath);
    expect(() => custody.assertCurrent()).toThrow("retained custody changed");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("complete selector traversal rejects writable ancestors and directory aliases", () => {
  const f = selectorFixture();
  try {
    const parent = path.dirname(f.input.releaseRoot);
    fs.chmodSync(parent, 0o777);
    expect(() => inspectDevRegistrationSelector(f.input, stableAncestorFs(f.root))).toThrow(
      "writable",
    );
    fs.chmodSync(parent, 0o700);
    const alias = path.join(f.root, "state-alias");
    fs.symlinkSync(f.input.account.stateDirectory, alias);
    const aliasRoot = path.join(alias, "managed", "releases");
    expect(() =>
      inspectDevRegistrationSelector(
        { ...f.input, releaseRoot: aliasRoot, selectionPath: path.join(aliasRoot, "current") },
        stableAncestorFs(f.root),
      ),
    ).toThrow("noncanonical");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("complete selector traversal rejects escaped targets and retains account anchors", () => {
  const f = selectorFixture();
  try {
    const custody = inspectDevRegistrationSelector(f.input, stableAncestorFs(f.root));
    fs.chmodSync(f.input.account.home, 0o750);
    expect(() => custody.assertCurrent()).toThrow("retained custody changed");
    fs.chmodSync(f.input.account.home, 0o700);
    fs.unlinkSync(f.input.selectionPath);
    fs.symlinkSync(f.input.account.home, f.input.selectionPath);
    expect(() => inspectDevRegistrationSelector(f.input, stableAncestorFs(f.root))).toThrow(
      "escaped",
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("complete observer traversal retains a separate account anchor parent chain", () => {
  const f = selectorFixture();
  const outside = mkdtempSync(path.join(realpathSync(homedir()), ".vorteo-anchor-test-"));
  try {
    const parent = path.join(outside, "parent");
    const anchor = path.join(parent, "home");
    fs.mkdirSync(anchor, { recursive: true, mode: 0o700 });
    const custody = runInNewContext(
      `(${inspectDevRegistrationSelector.toString()})(input, fs, path, assertStat)`,
      {
        input: { ...f.input, account: { ...f.input.account, home: anchor } },
        fs: stableAncestorFs(f.root, outside),
        path,
        assertStat: assertDevRegistrationPathStat,
      },
    );
    custody.assertCurrent();
    const original = fs.lstatSync(anchor, { bigint: true });
    const moved = path.join(outside, "moved");
    fs.renameSync(parent, moved);
    fs.symlinkSync(moved, parent);
    expect(fs.lstatSync(anchor, { bigint: true }).ino).toBe(original.ino);
    expect(() => custody.assertCurrent()).toThrow("retained directory is noncanonical");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function c1PublicationFixture(root: string, receiptFile = path.join(root, "installed.json")) {
  const f = publicationFixture();
  f.configurationFile = path.join(root, "replacement.json");
  f.receiptFile = receiptFile;
  f.configurationBytes = Buffer.from(JSON.stringify(f.config));
  f.configurationSha256 = createHash("sha256").update(f.configurationBytes).digest("hex");
  const original = structuredClone(f.config);
  delete original.container.supervisorMaintenance;
  const rollback = structuredClone(f.config);
  rollback.container.supervisorMaintenance = {
    ...f.config.container.supervisorMaintenance!,
    script: "/host/rollback.mjs",
    sha256: "d".repeat(64),
  };
  const legacy = prepareDevRegistrationPublication(f);
  function document<T>(name: string, parsed: T): CapturedRegistrationDocument<T> {
    const bytes = Buffer.from(JSON.stringify(parsed));
    return {
      path: path.join(root, name),
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      parsed,
    };
  }
  const documents = {
    original: document("original.json", original),
    replacement: document("replacement.json", f.config),
    rollback: document("rollback.json", rollback),
    selected: document("selected.json", JSON.parse(legacy.configurationBytes.toString("utf8"))),
    preparedReceipt: document("prepared-receipt.json", f.receipt),
  };
  for (const item of Object.values(documents))
    writeFileSync(item.path, item.bytes, { mode: 0o600 });
  return { ...f, documents, registrationPlanSha256: "a".repeat(64) };
}
test("C1 receipt-only publication retains all original configuration bytes and inodes", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "c1-publication-")));
  fs.chmodSync(root, 0o700);
  try {
    const f = c1PublicationFixture(root),
      prepared = prepareDevRegistrationPublication(f);
    const identities = Object.fromEntries(
      Object.entries(f.documents).map(([name, item]) => [
        name,
        fs.lstatSync(item.path, { bigint: true }).ino,
      ]),
    );
    const assertDocuments = retainC1RegistrationDocuments(f.documents);
    publishDevRegistration({
      prepared,
      attemptFile: path.join(root, "attempt.json"),
      reservationSha256: "b".repeat(64),
      assertCurrent: assertDocuments,
    });
    expect(readFileSync(f.receiptFile)).toEqual(prepared.receiptBytes);
    for (const [name, item] of Object.entries(f.documents)) {
      expect(readFileSync(item.path)).toEqual(item.bytes);
      expect(fs.lstatSync(item.path, { bigint: true }).ino).toBe(identities[name]);
    }
    expect(() =>
      publishDevRegistration({
        prepared,
        attemptFile: path.join(root, "attempt.json"),
        reservationSha256: "b".repeat(64),
        assertCurrent: assertDocuments,
      }),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test.each(["raw", "parsed", "projection", "original-reference"])(
  "C1 captured %s substitution refuses",
  (change) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "c1-publication-")));
    fs.chmodSync(root, 0o700);
    try {
      const f = c1PublicationFixture(root);
      if (change === "raw") f.documents.selected.bytes[0] = 32;
      if (change === "parsed") f.documents.selected.parsed.listenPort++;
      if (change === "projection") {
        f.documents.selected.parsed.listenPort++;
        f.documents.selected.bytes = Buffer.from(JSON.stringify(f.documents.selected.parsed));
        f.documents.selected.sha256 = createHash("sha256")
          .update(f.documents.selected.bytes)
          .digest("hex");
      }
      if (change === "original-reference") {
        f.documents.original.parsed.container.supervisorMaintenance =
          f.config.container.supervisorMaintenance;
        f.documents.original.bytes = Buffer.from(JSON.stringify(f.documents.original.parsed));
        f.documents.original.sha256 = createHash("sha256")
          .update(f.documents.original.bytes)
          .digest("hex");
      }
      expect(() => captureC1RegistrationDocuments(f.documents)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test("C1 callback replacement of selected configuration refuses before installed receipt", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "c1-publication-")));
  fs.chmodSync(root, 0o700);
  try {
    const f = c1PublicationFixture(root),
      prepared = prepareDevRegistrationPublication(f);
    let calls = 0;
    expect(() =>
      publishDevRegistration({
        prepared,
        attemptFile: path.join(root, "attempt.json"),
        reservationSha256: "b".repeat(64),
        assertCurrent() {
          if (++calls === 2) {
            const d = f.documents.selected;
            const next = d.path + ".substitute";
            writeFileSync(next, d.bytes, { mode: 0o600 });
            fs.renameSync(next, d.path);
          }
        },
      }),
    ).toThrow("custody changed");
    expect(existsSync(f.receiptFile)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C1 receipt transaction refuses a substituted durable attempt before receipt write", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "c1-publication-")));
  fs.chmodSync(root, 0o700);
  try {
    const f = c1PublicationFixture(root),
      prepared = prepareDevRegistrationPublication(f),
      attemptFile = path.join(root, "attempt.json");
    let replaced = false;
    expect(() =>
      publishDevRegistration({
        prepared,
        attemptFile,
        reservationSha256: "b".repeat(64),
        assertCurrent() {
          if (existsSync(attemptFile) && !replaced) {
            replaced = true;
            const replacement = attemptFile + ".replacement";
            writeFileSync(replacement, readFileSync(attemptFile), { mode: 0o600 });
            fs.renameSync(replacement, attemptFile);
          }
        },
      }),
    ).toThrow("record custody changed");
    expect(replaced).toBe(true);
    expect(existsSync(f.receiptFile)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(
  ["parent", "grandparent"].flatMap((level) =>
    [0o720, 0o702, 0o770, 0o777].map((mode) => ({ level, mode })),
  ),
)("C1 full ancestry rejects writable $level mode $mode", ({ level, mode }) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "c1-ancestry-")));
  fs.chmodSync(root, 0o700);
  try {
    const ancestor = path.join(root, "ancestor"),
      documents = path.join(ancestor, "documents");
    fs.mkdirSync(documents, { recursive: true, mode: 0o700 });
    const f = c1PublicationFixture(documents);
    fs.chmodSync(level === "parent" ? documents : ancestor, mode);
    expect(() => retainC1RegistrationDocuments(f.documents)).toThrow("custody is unsafe");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test.each(["parent", "grandparent"])(
  "C1 full ancestry accepts protected current-user %s and root ancestors",
  (level) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "c1-ancestry-")));
    fs.chmodSync(root, 0o700);
    try {
      const ancestor = path.join(root, "ancestor"),
        documents = path.join(ancestor, "documents");
      fs.mkdirSync(documents, { recursive: true, mode: 0o700 });
      const f = c1PublicationFixture(documents);
      fs.chmodSync(level === "parent" ? documents : ancestor, 0o750);
      expect(() => retainC1RegistrationDocuments(f.documents)()).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
const c1ParentRaces = [1, 2, 3, 4].flatMap((call) =>
  ["attempt", "receipt"].flatMap((target) =>
    ["replace", "chmod"].map((change) => ({ call, target, change })),
  ),
);
test.each(c1ParentRaces)(
  "C1 output-only $target parent $change at callback $call refuses publication",
  ({ call, target, change }) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "c1-output-parent-")));
    fs.chmodSync(root, 0o700);
    try {
      const documents = path.join(root, "documents"),
        attemptParent = path.join(root, "attempt-only"),
        receiptParent = path.join(root, "receipt-only");
      for (const dir of [documents, attemptParent, receiptParent])
        fs.mkdirSync(dir, { mode: 0o700 });
      const attemptFile = path.join(attemptParent, "attempt.json"),
        receiptFile = path.join(receiptParent, "installed.json");
      const f = c1PublicationFixture(documents, receiptFile),
        prepared = prepareDevRegistrationPublication(f);
      const victim = target === "attempt" ? attemptParent : receiptParent,
        retained = victim + ".retained";
      let calls = 0,
        mutated = false,
        attemptBytes: Buffer | undefined,
        attemptInode: bigint | undefined;
      expect(() =>
        publishDevRegistration({
          prepared,
          attemptFile,
          reservationSha256: "b".repeat(64),
          assertCurrent() {
            if (++calls !== call) return;
            if (existsSync(attemptFile)) {
              attemptBytes = readFileSync(attemptFile);
              attemptInode = fs.lstatSync(attemptFile, { bigint: true }).ino;
            }
            mutated = true;
            if (change === "chmod") fs.chmodSync(victim, 0o720);
            else {
              fs.renameSync(victim, retained);
              fs.mkdirSync(victim, { mode: 0o700 });
            }
          },
        }),
      ).toThrow("parent changed");
      expect(calls).toBe(call);
      expect(mutated).toBe(true);
      const actualAttempt =
        target === "attempt" && change === "replace"
          ? path.join(retained, "attempt.json")
          : attemptFile;
      const actualReceipt =
        target === "receipt" && change === "replace"
          ? path.join(retained, "installed.json")
          : receiptFile;
      expect(existsSync(actualAttempt)).toBe(call >= 3);
      expect(existsSync(actualReceipt)).toBe(call === 4);
      if (attemptBytes) {
        expect(readFileSync(actualAttempt)).toEqual(attemptBytes);
        expect(fs.lstatSync(actualAttempt, { bigint: true }).ino).toBe(attemptInode);
      }
      if (call === 4) expect(readFileSync(actualReceipt)).toEqual(prepared.receiptBytes);
      for (const d of Object.values(f.documents)) expect(readFileSync(d.path)).toEqual(d.bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("C1 full ancestry refuses a root-owned writable temporary ancestor", () => {
  const root = realpathSync(mkdtempSync(path.join("/tmp", "c1-root-ancestor-")));
  fs.chmodSync(root, 0o700);
  try {
    const parent = fs.lstatSync(path.dirname(root));
    expect(parent.uid).toBe(0);
    expect(parent.mode & 0o022).not.toBe(0);
    const f = c1PublicationFixture(root);
    expect(() => retainC1RegistrationDocuments(f.documents)).toThrow("custody is unsafe");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
