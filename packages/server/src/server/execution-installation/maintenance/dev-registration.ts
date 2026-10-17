import { createHash } from "node:crypto";
import path from "node:path";
import * as fs from "node:fs";
import { selectMaintenanceFiles } from "../coordinator-bootstrap-maintenance-file-selection.js";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { DaemonMaintenanceProcessSchema } from "@getpaseo/protocol/maintenance-interruption";
import type { InstallationConfig } from "../config.js";
import type { EnrollmentNativeIdentity } from "./native-identity.js";

const absolutePath = z
  .string()
  .startsWith("/")
  .max(4096)
  .refine(
    (value) =>
      !value.includes("\0") && path.posix.normalize(value) === value && !value.endsWith("/"),
    "Dev registration requires canonical absolute paths",
  );
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const registeredFile = z.strictObject({ path: absolutePath, sha256: digest });
export const DevRegistrationReferenceSchema = z.strictObject({
  receiptFile: absolutePath,
  sha256: digest,
});
export const DevStartupSchema = z.strictObject({
  path: absolutePath,
  args: z.array(z.string()).max(64),
  entrypoint: z.array(z.string()).max(64).nullable(),
  cmd: z.array(z.string()).max(64).nullable(),
});
const registeredFiles = z.strictObject({
  containerEntrypoint: registeredFile,
  supervisorConfiguration: registeredFile,
  profileLauncher: registeredFile,
  dockerEntrypoint: registeredFile,
  entrySelection: registeredFile,
  factoryEntrypoint: registeredFile,
  factoryLauncher: registeredFile,
  supervisorEntrypoint: registeredFile,
  parentExecutable: registeredFile,
  node: registeredFile,
});
/** This receipt pins a provisioning result. It does not establish the semantics
 * of an opaque Factory entry or grant lifecycle authority. */
export const DevRegistrationReceiptSchema = z.strictObject({
  version: z.literal(1),
  purpose: z.literal("dev-persistent-registration"),
  installationId: z.uuid(),
  containerId: z.string().regex(/^[a-f0-9]{64}$/),
  startup: DevStartupSchema,
  account: z.strictObject({
    user: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
    uid: z.number().int().positive(),
    gid: z.number().int().nonnegative(),
    home: absolutePath,
    stateDirectory: absolutePath,
  }),
  supervisorPlanSha256: digest,
  launcherPath: absolutePath,
  selectionPath: absolutePath,
  releaseRoot: absolutePath,
  selectionCustody: z.literal("configured-dev-user"),
  parentArgumentsSha256: digest,
  files: registeredFiles,
});
export type DevRegistrationReceipt = z.infer<typeof DevRegistrationReceiptSchema>;
export const DevRegistrationObservationSchema = z.strictObject({
  files: registeredFiles,
  entrySelection: absolutePath,
  selectionPath: absolutePath,
  selectedRelease: absolutePath,
  parent: DaemonMaintenanceProcessSchema,
});
type DevRegistrationObservation = z.infer<typeof DevRegistrationObservationSchema>;
interface RegistrationBinding {
  bytes: Buffer;
  reference: z.infer<typeof DevRegistrationReferenceSchema>;
  config: InstallationConfig;
  expected: Extract<EnrollmentNativeIdentity, { environment: "container" }>;
  startup: z.infer<typeof DevStartupSchema>;
}
export function readDevRegistrationBinding(input: RegistrationBinding): DevRegistrationReceipt {
  const reference = DevRegistrationReferenceSchema.parse(input.reference);
  if (
    input.bytes.length > 65536 ||
    createHash("sha256").update(input.bytes).digest("hex") !== reference.sha256
  )
    throw new Error("Dev registration receipt changed");
  const receipt = DevRegistrationReceiptSchema.parse(JSON.parse(input.bytes.toString("utf8")));
  if (receipt.launcherPath !== receipt.files.entrySelection.path)
    throw new Error("Dev stable launcher identity must name the protected entry pointer");
  const settings = input.config.containerSourceUpdates;
  const plan = input.config.container.supervisorMaintenance;
  const expected = input.expected;
  if (!settings || !plan)
    throw new Error("Dev registration requires a configured supervisor maintenance plan");
  const configuredBinding = {
    installationId: input.config.public.installationId,
    containerId: settings.containerId,
    startup: DevStartupSchema.parse(input.startup),
    user: settings.user,
    stateDirectory: settings.home,
    supervisorPlanSha256: plan.sha256,
    selectionPath: settings.currentReleaseLink,
    releaseRoot: settings.releaseRoot,
    node: settings.node,
  };
  const receiptBinding = {
    installationId: receipt.installationId,
    containerId: receipt.containerId,
    startup: receipt.startup,
    user: receipt.account.user,
    stateDirectory: receipt.account.stateDirectory,
    supervisorPlanSha256: receipt.supervisorPlanSha256,
    selectionPath: receipt.selectionPath,
    releaseRoot: receipt.releaseRoot,
    node: receipt.files.node.path,
  };
  const enrolledBinding = {
    installationId: expected.installationId,
    containerId: expected.containerId,
    uid: expected.containerUid,
    gid: expected.containerGid,
    home: expected.containerHome,
    stateDirectory: expected.containerStateDirectory,
    launcherPath: expected.launcherPath,
    selectionPath: expected.selectionPath,
  };
  const receiptEnrollment = {
    installationId: receipt.installationId,
    containerId: receipt.containerId,
    uid: receipt.account.uid,
    gid: receipt.account.gid,
    home: receipt.account.home,
    stateDirectory: receipt.account.stateDirectory,
    launcherPath: receipt.launcherPath,
    selectionPath: receipt.selectionPath,
  };
  const matches =
    isDeepStrictEqual(configuredBinding, receiptBinding) &&
    isDeepStrictEqual(enrolledBinding, receiptEnrollment);
  if (!matches)
    throw new Error(
      "Dev persistent registration binding differs from protected configuration or enrollment",
    );
  return receipt;
}
interface RegistrationObservation {
  receipt: DevRegistrationReceipt;
  observation: unknown;
  supervisor: z.infer<typeof DaemonMaintenanceProcessSchema>;
  selectedRelease: string;
}
/** Compare independently read native facts. Success is file/process evidence,
 * never proof that the opaque Factory entry implements the registered handoff. */
export function verifyDevRegistrationObservation(
  input: RegistrationObservation,
): DevRegistrationObservation {
  const observed = DevRegistrationObservationSchema.parse(input.observation);
  const { receipt, supervisor } = input;
  const parent = observed.parent;
  const matches =
    isDeepStrictEqual(observed.files, receipt.files) &&
    observed.entrySelection === receipt.files.factoryEntrypoint.path &&
    observed.selectionPath === receipt.selectionPath &&
    observed.selectedRelease === input.selectedRelease &&
    parent.pid === supervisor.parentPid &&
    parent.uid === 0 &&
    parent.bootId === supervisor.bootId &&
    parent.executable === receipt.files.parentExecutable.path &&
    parent.argumentsSha256 === receipt.parentArgumentsSha256;
  if (!matches) throw new Error("Dev independent registration or native parent differs");
  return observed;
}

interface RegistrationPathStat {
  uid: number;
  mode: number;
  kind: "file" | "directory" | "link";
}
/** Symlink permission bits do not represent Linux write authority. The owner,
 * retained link identity, target and parent directories establish its custody. */
export function assertDevRegistrationPathStat(stat: RegistrationPathStat, ownerUid: number): void {
  if (stat.uid !== ownerUid) throw new Error("Dev registration path owner differs");
  if (stat.kind !== "link" && (stat.mode & 0o022) !== 0)
    throw new Error("Dev registration path is writable by another account");
}

interface SelectorCustodyInput {
  selectionPath: string;
  releaseRoot: string;
  account: Pick<DevRegistrationReceipt["account"], "uid" | "home" | "stateDirectory">;
}
/** The managed updater owns selection. User-owned ancestors must lie on the
 * configured home/state chains; unrelated user-owned directories are refused. */
export function inspectDevRegistrationSelector(
  input: SelectorCustodyInput,
  nativeFs: typeof fs = fs,
  pathApi: typeof path = path,
  assertStat: typeof assertDevRegistrationPathStat = assertDevRegistrationPathStat,
) {
  const { selectionPath, releaseRoot } = input;
  const account = { ...input.account };
  const retained = new Map<string, string>();
  const directories = new Set<string>();
  const anchors = [account.home, account.stateDirectory];
  function canonical(value: string): void {
    if (!pathApi.isAbsolute(value) || pathApi.normalize(value) !== value || value.includes("\0"))
      throw new Error("Dev selector custody requires canonical configured paths");
  }
  for (const value of [selectionPath, releaseRoot, ...anchors]) canonical(value);
  if (pathApi.dirname(selectionPath) !== releaseRoot)
    throw new Error("Dev selector must remain directly inside its managed root");
  const identityOf = (stat: fs.BigIntStats) =>
    [
      stat.dev,
      stat.ino,
      stat.uid,
      stat.gid,
      stat.mode,
      stat.nlink,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ].join(":");
  const identity = (value: string) => identityOf(nativeFs.lstatSync(value, { bigint: true }));
  function retain(value: string, observed: fs.BigIntStats): void {
    const current = identity(value);
    if (current !== identityOf(observed))
      throw new Error("Dev selector custody changed during inspection");
    const previous = retained.get(value);
    if (previous !== undefined && previous !== current)
      throw new Error("Dev selector retained custody changed during traversal");
    retained.set(value, current);
    if (retained.size > 256) throw new Error("Dev selector custody exceeds its path bound");
  }
  function directory(value: string, owner: number): void {
    const stat = nativeFs.lstatSync(value, { bigint: true });
    if (!stat.isDirectory() || nativeFs.realpathSync(value) !== value)
      throw new Error("Dev selector chain contains a noncanonical directory");
    assertStat({ uid: Number(stat.uid), mode: Number(stat.mode), kind: "directory" }, owner);
    retain(value, stat);
    directories.add(value);
  }
  // Separate home/state anchors may not share the selector ancestry. Retain
  // their complete chains so an unchanged anchor inode cannot mask a moved parent.
  function retainAnchor(anchor: string): void {
    for (let current = anchor; ; current = pathApi.dirname(current)) {
      const stat = nativeFs.lstatSync(current, { bigint: true });
      directory(current, current === anchor || stat.uid === BigInt(account.uid) ? account.uid : 0);
      if (pathApi.dirname(current) === current) break;
    }
  }
  for (const anchor of anchors) retainAnchor(anchor);
  for (let current = selectionPath; ; current = pathApi.dirname(current)) {
    const stat = nativeFs.lstatSync(current, { bigint: true });
    const first = current === selectionPath;
    if (first) {
      if (!stat.isSymbolicLink()) throw new Error("Dev selector is not a symlink");
      assertStat({ uid: Number(stat.uid), mode: Number(stat.mode), kind: "link" }, account.uid);
      retain(current, stat);
    } else {
      const accountChain = anchors.some(
        (anchor) =>
          current === anchor ||
          current.startsWith(anchor + pathApi.sep) ||
          anchor.startsWith(current + pathApi.sep),
      );
      const permittedUserOwner =
        current === releaseRoot || (accountChain && stat.uid === BigInt(account.uid));
      const owner = permittedUserOwner ? account.uid : 0;
      directory(current, owner);
    }
    if (pathApi.dirname(current) === current) break;
  }
  const selectedRelease = nativeFs.realpathSync(selectionPath);
  if (!selectedRelease.startsWith(releaseRoot + pathApi.sep))
    throw new Error("Dev selector target escaped its managed root");
  for (let current = selectedRelease; ; current = pathApi.dirname(current)) {
    directory(current, account.uid);
    if (current === releaseRoot) break;
  }
  const assertCurrent = () => {
    for (const value of directories) {
      if (nativeFs.realpathSync(value) !== value)
        throw new Error("Dev selector retained directory is noncanonical");
    }
    for (const [value, expected] of retained) {
      if (identity(value) !== expected) throw new Error("Dev selector retained custody changed");
    }
    if (nativeFs.realpathSync(selectionPath) !== selectedRelease)
      throw new Error("Dev selector target changed");
  };
  assertCurrent();
  return { selectedRelease, assertCurrent };
}

/** Stream binaries with the same 256 MiB per-file bound as preparation, retaining
 * the opened inode and pathname so replacement cannot silently change evidence. */
export function hashDevRegistrationFile(
  file: string,
  nativeFs: typeof fs = fs,
  hashImplementation: typeof createHash = createHash,
): string {
  const fd = nativeFs.openSync(
    file,
    nativeFs.constants.O_RDONLY | nativeFs.constants.O_NOFOLLOW | nativeFs.constants.O_NONBLOCK,
  );
  try {
    const before = nativeFs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 256n * 1024n * 1024n)
      throw new Error("Dev registration file exceeds its bounded regular-file contract");
    const hash = hashImplementation("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const count = nativeFs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > 256 * 1024 * 1024) throw new Error("Dev registration file grew beyond its bound");
      hash.update(buffer.subarray(0, count));
    }
    const identity = (stat: fs.BigIntStats) =>
      [
        stat.dev,
        stat.ino,
        stat.uid,
        stat.gid,
        stat.mode,
        stat.nlink,
        stat.size,
        stat.mtimeNs,
        stat.ctimeNs,
      ].join(":");
    if (
      identity(before) !== identity(nativeFs.fstatSync(fd, { bigint: true })) ||
      identity(before) !== identity(nativeFs.lstatSync(file, { bigint: true }))
    )
      throw new Error("Dev registration file changed while hashing");
    return hash.digest("hex");
  } finally {
    nativeFs.closeSync(fd);
  }
}

const DevRegistrationReadinessSchema = z.strictObject({
  phase: z.literal("native-and-authenticated-ready"),
  installationId: z.uuid(),
  containerId: z.string().regex(/^[a-f0-9]{64}$/),
  account: DevRegistrationReceiptSchema.shape.account,
  startup: DevStartupSchema,
  supervisor: DaemonMaintenanceProcessSchema.extend({ gid: z.number().int().nonnegative() }),
  worker: DaemonMaintenanceProcessSchema.extend({ gid: z.number().int().nonnegative() }),
  supervisorEntrypoint: absolutePath,
  selectedRelease: absolutePath,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  authenticated: z.strictObject({
    serverId: z.string().min(1),
    workerPid: z.number().int().positive(),
    workerInstanceId: z.string().min(1),
  }),
  registration: DevRegistrationObservationSchema,
});
interface RegistrationPublicationInput {
  config: InstallationConfig;
  configurationFile: string;
  configurationSha256: string;
  configurationBytes: Buffer;
  receiptFile: string;
  receipt: unknown;
  readiness: unknown;
  protectedSourceCommit: string;
}
interface PreparedRegistrationPublication {
  configurationFile: string;
  previousConfigurationSha256: string;
  configurationBytes: Buffer;
  configurationSha256: string;
  receiptFile: string;
  receiptBytes: Buffer;
  reference: z.infer<typeof DevRegistrationReferenceSchema>;
}
/** Data preparation does not prove runtime readiness or authorize publication.
 * The effect adapter must obtain these facts independently and retain them for
 * the synchronous locked admission required by publishDevRegistration. */
export function prepareDevRegistrationPublication(
  input: RegistrationPublicationInput,
): PreparedRegistrationPublication {
  const configurationSha256 = digest.parse(input.configurationSha256);
  if (
    createHash("sha256").update(input.configurationBytes).digest("hex") !== configurationSha256 ||
    !isDeepStrictEqual(JSON.parse(input.configurationBytes.toString("utf8")), input.config)
  )
    throw new Error("Dev publication configuration differs from its protected captured bytes");
  const receipt = DevRegistrationReceiptSchema.parse(input.receipt);
  if (receipt.launcherPath !== receipt.files.entrySelection.path)
    throw new Error("Dev stable launcher identity must name the protected entry pointer");
  const ready = DevRegistrationReadinessSchema.parse(input.readiness);
  const settings = input.config.containerSourceUpdates;
  const plan = input.config.container.supervisorMaintenance;
  const environment = input.config.public.environments.find((item) => item.kind === "container");
  if (!settings || !plan || !environment)
    throw new Error("Dev publication settings are unavailable");
  const expected = {
    installationId: input.config.public.installationId,
    containerId: settings.containerId,
    user: settings.user,
    stateDirectory: settings.home,
    releaseRoot: settings.releaseRoot,
    selectionPath: settings.currentReleaseLink,
    supervisorPlanSha256: plan.sha256,
  };
  const retained = {
    installationId: receipt.installationId,
    containerId: receipt.containerId,
    user: receipt.account.user,
    stateDirectory: receipt.account.stateDirectory,
    releaseRoot: receipt.releaseRoot,
    selectionPath: receipt.selectionPath,
    supervisorPlanSha256: receipt.supervisorPlanSha256,
  };
  const accountMatches = isDeepStrictEqual(ready.account, receipt.account);
  const identityMatches =
    ready.installationId === receipt.installationId && ready.containerId === receipt.containerId;
  const runtimeMatches = registrationRuntimeMatches(ready, receipt);
  if (!ready.selectedRelease.startsWith(settings.releaseRoot + "/"))
    throw new Error("Dev selected release escaped its managed root");
  const authenticationMatches =
    ready.authenticated.serverId === environment.serverId &&
    ready.authenticated.workerPid === ready.worker.pid &&
    ready.sourceCommit === input.protectedSourceCommit;
  if (
    !isDeepStrictEqual(expected, retained) ||
    !accountMatches ||
    !identityMatches ||
    !runtimeMatches ||
    !authenticationMatches ||
    !isDeepStrictEqual(ready.startup, receipt.startup)
  )
    throw new Error("Dev receipt publication differs from native or authenticated readiness");
  verifyDevRegistrationObservation({
    receipt,
    observation: ready.registration,
    supervisor: ready.supervisor,
    selectedRelease: ready.selectedRelease,
  });
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  const reference = DevRegistrationReferenceSchema.parse({
    receiptFile: input.receiptFile,
    sha256: createHash("sha256").update(receiptBytes).digest("hex"),
  });
  const configuration = structuredClone(input.config);
  if (!configuration.containerSourceUpdates) throw new Error("Dev source updater is unavailable");
  configuration.containerSourceUpdates.node = receipt.files.node.path;
  configuration.container.persistentRegistration = reference;
  const configurationBytes = Buffer.from(JSON.stringify(configuration));
  return {
    configurationFile: absolutePath.parse(input.configurationFile),
    previousConfigurationSha256: digest.parse(input.configurationSha256),
    configurationBytes,
    configurationSha256: createHash("sha256").update(configurationBytes).digest("hex"),
    receiptFile: reference.receiptFile,
    receiptBytes,
    reference,
  };
}
function registrationRuntimeMatches(
  ready: z.infer<typeof DevRegistrationReadinessSchema>,
  receipt: DevRegistrationReceipt,
): boolean {
  return (
    ready.supervisor.executable === receipt.files.node.path &&
    ready.worker.executable === receipt.files.node.path &&
    ready.worker.parentPid === ready.supervisor.pid &&
    ready.supervisorEntrypoint === receipt.files.supervisorEntrypoint.path &&
    ready.worker.bootId === ready.supervisor.bootId &&
    ready.worker.uid === ready.account.uid &&
    ready.supervisor.uid === ready.account.uid &&
    ready.worker.gid === ready.account.gid &&
    ready.supervisor.gid === ready.account.gid
  );
}

interface RegistrationPublication {
  prepared: PreparedRegistrationPublication;
  attemptFile: string;
  reservationSha256: string;
  /** Caller holds existing lifecycle exclusion and independently retained native,
   * authenticated readiness and current grant/executor evidence. No effects here. */
  assertCurrent(): void;
}
export function publishDevRegistration(input: RegistrationPublication): void {
  const prepared = { ...input.prepared, reference: { ...input.prepared.reference } };
  const { attemptFile, reservationSha256, assertCurrent } = input;
  const configurationBytes = Buffer.from(prepared.configurationBytes);
  const receiptBytes = Buffer.from(prepared.receiptBytes);
  const unchanged = () => {
    if (
      createHash("sha256").update(configurationBytes).digest("hex") !==
        prepared.configurationSha256 ||
      createHash("sha256").update(receiptBytes).digest("hex") !== prepared.reference.sha256
    )
      throw new Error("Prepared Dev registration publication bytes changed");
    if (typeof assertCurrent !== "function" || assertCurrent() !== undefined)
      throw new Error("Dev registration publication requires synchronous current admission");
  };
  unchanged();
  selectMaintenanceFiles({
    attemptFile: absolutePath.parse(attemptFile),
    reservationSha256,
    launcher: { path: prepared.receiptFile, previousSha256: null, bytes: receiptBytes },
    selection: {
      path: prepared.configurationFile,
      previousSha256: prepared.previousConfigurationSha256,
      bytes: configurationBytes,
    },
    assertCurrent: unchanged,
  });
}

// Fixed observer only. The caller uses its existing unprivileged Docker account;
// unreadable evidence fails rather than requesting root or loading guest code.
export const DEV_REGISTRATION_INSPECTION_SCRIPT = String.raw`
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const input=JSON.parse(process.argv[1]);
function check(ok) { if(!ok) throw Error('Dev protected registration differs'); }
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const createHash=crypto.createHash;
${assertDevRegistrationPathStat.toString()}
${inspectDevRegistrationSelector.toString()}
${hashDevRegistrationFile.toString()}
const retained=new Map();
function identity(file) { const s=fs.lstatSync(file,{bigint:true}); return [s.dev,s.ino,s.uid,s.gid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':'); }
function protect(file, link=false) {
 check(path.isAbsolute(file) && path.normalize(file)===file);
 check(!input.writableMounts.some(root=>file===root || file.startsWith(root+'/')));
 for(let current=file;;current=path.dirname(current)) {
  const s=fs.lstatSync(current);
  const kind=s.isSymbolicLink()?'link':s.isFile()?'file':'directory';
  assertDevRegistrationPathStat({uid:s.uid,mode:s.mode,kind},0);
  if(current===file && link) check(s.isSymbolicLink());
  else check(fs.realpathSync(current)===current && (s.isFile() || s.isDirectory()));
  retained.set(current,identity(current));
  if(path.dirname(current)===current) break;
 }
}
function read(file, limit) {
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try { const b=Buffer.alloc(limit+1), n=fs.readSync(fd,b,0,b.length,0); check(n<=limit); return b.subarray(0,n); }
 finally {fs.closeSync(fd);}
}
const files={};
for(const [role,pin] of Object.entries(input.receipt.files)) {
 protect(pin.path); const s=fs.lstatSync(pin.path); check(s.isFile() && s.nlink===1);
 files[role]={path:pin.path,sha256:hashDevRegistrationFile(pin.path,fs,createHash)};
}
const entrySelection=read(input.receipt.files.entrySelection.path,4096).toString('utf8').trim();
const selectionPath=input.receipt.selectionPath;
const selectionCustody=inspectDevRegistrationSelector({selectionPath,releaseRoot:input.receipt.releaseRoot,account:input.receipt.account},fs,path,assertDevRegistrationPathStat);
const selectedRelease=selectionCustody.selectedRelease;
function parent() {
 const pid=input.parentPid; check(Number.isSafeInteger(pid)&&pid>0);
 const stat=read('/proc/'+pid+'/stat',65536).toString('utf8');
 const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/); check(!['Z','T','t','X'].includes(fields[0]));
 const status=read('/proc/'+pid+'/status',65536).toString('utf8');
 const ids=status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m); check(ids && ids.slice(1).every(v=>v==='0'));
 const argv=read('/proc/'+pid+'/cmdline',65536).toString('utf8').split('\0').filter(Boolean);
 return {pid,parentPid:Number(fields[1]),uid:0,bootId:read('/proc/sys/kernel/random/boot_id',4096).toString('utf8').trim(),startIdentity:fields[19],executable:fs.realpathSync('/proc/'+pid+'/exe'),argumentsSha256:sha(JSON.stringify(argv))};
}
const observedParent=parent();
check(JSON.stringify(observedParent)===JSON.stringify(parent()));
for(const [file,value] of retained) check(identity(file)===value);
selectionCustody.assertCurrent();
console.log(JSON.stringify({files,entrySelection,selectionPath,selectedRelease,parent:observedParent}));
`;
