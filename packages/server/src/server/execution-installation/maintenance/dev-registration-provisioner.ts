import { DEV_REGISTRATION_NATIVE_PRIMITIVES } from "./dev-registration-native-primitives.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { z } from "zod";
import { InstallationConfigSchema } from "../config.js";
import {
  DevRegistrationReceiptSchema,
  captureC1RegistrationDocuments,
  type CapturedRegistrationDocument,
  type C1RegistrationDocuments,
  DevStartupSchema,
} from "./dev-registration.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z
  .string()
  .startsWith("/")
  .max(4096)
  .refine(
    (value) =>
      path.posix.normalize(value) === value && !value.includes("\0") && !value.endsWith("/"),
  );
const relative = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      value === "" ||
      (!path.posix.isAbsolute(value) &&
        path.posix.normalize(value) === value &&
        value.split("/").every((part) => part !== ".." && part !== "." && part !== "") &&
        !value.includes("\0")),
  );
const sourceFile = z.strictObject({
  path: absolute,
  sha256: digest,
  size: z
    .number()
    .int()
    .nonnegative()
    .max(256 * 1024 * 1024),
});
const runtimeEntry = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("directory"),
    path: relative,
    mode: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("file"),
    path: relative,
    mode: z.number().int().nonnegative(),
    sha256: digest,
    size: z
      .number()
      .int()
      .nonnegative()
      .max(256 * 1024 * 1024),
  }),
  z.strictObject({ kind: z.literal("link"), path: relative, target: z.string().min(1).max(4096) }),
]);
/** Complete Linux manifest from the existing Dev candidate preparation contract.
 * Host builds and a caller's list of inferred imports cannot satisfy this input. */
export const DevRegistrationLinuxArtifactSchema = z.strictObject({
  algorithm: z.literal("vorteo-container-artifact-v1"),
  platform: z.literal("linux"),
  arch: z.enum(["arm64", "x64"]),
  root: absolute,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  artifactSha256: digest,
  entries: z.array(runtimeEntry).min(3).max(250_000),
});
const processIdentity = z.strictObject({
  pid: z.number().int().positive(),
  parentPid: z.number().int().positive(),
  uid: z.number().int().nonnegative(),
  gid: z.number().int().nonnegative(),
  bootId: z.string().min(1).max(100),
  startIdentity: z.string().regex(/^\d+$/),
  executable: absolute,
  argumentsSha256: digest,
});
export const DevRegistrationProvisionerInputSchema = z.strictObject({
  installationId: z.uuid(),
  preparationNonce: z.uuid(),
  configurationFile: absolute,
  c1First: z
    .strictObject({
      format: z.literal("c1-first-v1"),
      configurationFiles: z.strictObject({
        original: absolute,
        replacement: absolute,
        rollback: absolute,
        selected: absolute,
      }),
      preparedReceiptFile: absolute,
      scripts: z.strictObject({ node: absolute, replacement: absolute, rollback: absolute }),
      /** Reviewed startup evidence commitments only. Independent native preflight
       * must establish these semantic roles; labels and membership are not proof. */
      startupReceiptRoles: z.strictObject({
        containerEntrypoint: sourceFile,
        supervisorConfiguration: sourceFile,
        profileLauncher: sourceFile,
        dockerEntrypoint: sourceFile,
      }),
    })
    .optional(),
  hostReceiptFile: absolute,
  /** Existing read-only audited bootstrap inspector; no native resolver is supplied. */
  hostInspector: sourceFile.refine((file) => file.size <= 1024 * 1024),
  docker: z
    .strictObject({
      path: absolute,
      socket: absolute,
      containerId: z.string().regex(/^[a-f0-9]{64}$/),
      sha256: digest.optional(),
      size: z
        .number()
        .int()
        .positive()
        .max(256 * 1024 * 1024)
        .optional(),
    })
    .refine(
      (docker) => (docker.sha256 === undefined) === (docker.size === undefined),
      "Docker digest and size must both be present or absent",
    ),
  startup: DevStartupSchema,
  account: z.strictObject({
    user: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
    uid: z.number().int().positive(),
    gid: z.number().int().nonnegative(),
    home: absolute,
    stateDirectory: absolute,
  }),
  requiredCapability: z.literal("reviewed-dev-root-registration-and-parent-observation-v1"),
  systemPython: sourceFile,
  node: sourceFile.extend({ platform: z.literal("linux"), arch: z.enum(["arm64", "x64"]) }),
  supervisor: processIdentity,
  parent: processIdentity,
  startupFiles: z.array(sourceFile).min(4).max(16),
  originalPointer: sourceFile.extend({
    path: z.literal("/etc/paseo-server-entry"),
    content: z.string().min(1).max(4096),
  }),
  factoryEntry: sourceFile.extend({ content: z.string().min(1).max(65536) }),
  factoryLauncher: sourceFile.extend({ content: z.string().min(1).max(65536) }),
  originalSupervisorEntrypoint: absolute,
  originalFactoryRuntime: absolute,
  selectionPath: absolute,
  releaseRoot: absolute,
  linuxArtifact: DevRegistrationLinuxArtifactSchema,
  originalLinuxArtifact: DevRegistrationLinuxArtifactSchema,
  factoryRuntime: sourceFile,
});
type ProvisionerInput = z.infer<typeof DevRegistrationProvisionerInputSchema>;
interface PreparedFile {
  path: string;
  sha256: string;
  contentBase64: string;
  mode: number;
}
export interface PreparedDevRegistrationProvisioner {
  plan: ReturnType<typeof provisioningPlan>;
  planSha256: string;
  script: string;
  sha256: string;
  rollback: { script: string; sha256: string };
}
function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function replaceExactly(source: string, before: string, after: string): string {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before))
    throw new Error("Factory startup source differs from the reviewed handoff");
  return source.replace(before, after);
}

export function devRegistrationLinuxArtifactDigest(value: unknown): string {
  const artifact = DevRegistrationLinuxArtifactSchema.parse(value);
  const entries = new Map(artifact.entries.map((entry) => [entry.path, entry]));
  if (entries.size !== artifact.entries.length || entries.get("")?.kind !== "directory")
    throw new Error("Linux artifact manifest has duplicate entries or lacks its root");
  const hash = createHash("sha256").update("vorteo-container-artifact-v1\n");
  const visited = new Set<string>();
  const children = new Map<string, string[]>();
  for (const entry of artifact.entries) {
    if (entry.path === "") continue;
    const parent = path.posix.dirname(entry.path);
    const names = children.get(parent) ?? [];
    names.push(entry.path);
    children.set(parent, names);
  }
  function visit(name: string): void {
    const entry = entries.get(name);
    if (!entry) throw new Error("Linux artifact manifest has a missing parent");
    visited.add(name);
    if (entry.kind === "link") {
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(name), entry.target),
      );
      if (path.posix.isAbsolute(entry.target) || !entries.has(resolved))
        throw new Error("Linux artifact link escapes its complete manifest");
      hash.update(JSON.stringify(["link", name, entry.target]) + "\n");
      return;
    }
    if ((entry.mode & 0o7000) !== 0)
      throw new Error("Linux artifact contains special permission bits");
    if ((entry.mode & 0o022) !== 0) throw new Error("Linux artifact has writable runtime files");
    if (entry.kind === "file") {
      if ((entry.mode & 0o170000) !== 0o100000) throw new Error("Linux artifact file mode differs");
      hash.update(JSON.stringify(["file", name, String(entry.mode), entry.sha256]) + "\n");
      return;
    }
    if ((entry.mode & 0o170000) !== 0o040000)
      throw new Error("Linux artifact directory mode differs");
    hash.update(JSON.stringify(["directory", name, String(entry.mode)]) + "\n");
    const names = children.get(name || ".") ?? [];
    for (const child of names.sort()) visit(child);
  }
  visit("");
  if (JSON.stringify([...visited]) !== JSON.stringify(artifact.entries.map((entry) => entry.path)))
    throw new Error("Linux artifact manifest must use the existing collector traversal order");
  if (visited.size !== entries.size)
    throw new Error("Linux artifact manifest has unreachable entries");
  return hash.digest("hex");
}
function preparedFile(file: string, content: string): PreparedFile {
  return {
    path: file,
    sha256: sha(content),
    contentBase64: Buffer.from(content).toString("base64"),
    mode: 0o644,
  };
}
function provisioningPlan(input: ProvisionerInput) {
  const destination = `/opt/vorteo-persistent-registration/${input.preparationNonce}`;
  const runtime = destination + "/runtime";
  const supervisorEntrypoint = runtime + "/packages/server/dist/scripts/supervisor-entrypoint.js";
  const node = destination + "/node";
  let entry = replaceExactly(
    input.factoryEntry.content,
    "candidate + '/modules/factory/launch.py'",
    JSON.stringify(destination + "/factory-launch.py"),
  );
  entry = replaceExactly(
    entry,
    JSON.stringify(input.node.path).replaceAll('"', "'"),
    JSON.stringify(node),
  );
  entry = replaceExactly(
    entry,
    JSON.stringify(input.originalSupervisorEntrypoint).replaceAll('"', "'"),
    JSON.stringify(supervisorEntrypoint),
  );
  // Only the static supervisor gains a protected-root accommodation. Factory's
  // account, mutable state, runtime module and lock ownership checks stay intact.
  let launcher = replaceExactly(
    input.factoryLauncher.content,
    "        else:\n            physical(path)\n",
    "        elif path == options.supervisor_entry:\n            protected_supervisor(path)\n        else:\n            physical(path)\n",
  );
  launcher = replaceExactly(
    launcher,
    "def launch(options):",
    PROTECTED_SUPERVISOR_CHECK + "\n\ndef launch(options):",
  );
  return {
    ...input,
    destination,
    runtime,
    supervisorEntrypoint,
    protectedNode: node,
    files: [
      preparedFile(destination + "/factory-main-entry.mjs", entry),
      preparedFile(destination + "/factory-launch.py", launcher),
    ],
    pointerContent: destination + "/factory-main-entry.mjs\n",
    program: "paseo",
    supervisorSocket: "/run/personal-tailscale/supervisor.sock",
    nativeReceiptFile: destination + "/provisioning-result.json",
    hostAttemptFile:
      input.hostReceiptFile + ".registration-attempt-" + input.preparationNonce + ".json",
  };
}

function assertProcessBinding(input: ProvisionerInput): void {
  if (
    input.node.arch !== input.linuxArtifact.arch ||
    input.parent.uid !== 0 ||
    input.supervisor.uid !== input.account.uid ||
    input.supervisor.gid !== input.account.gid ||
    input.supervisor.parentPid !== input.parent.pid ||
    input.parent.bootId !== input.supervisor.bootId
  )
    throw new Error("Dev registration platform, account or process precondition differs");
}

/** Preparation has no I/O and grants no effect. Both scripts are exact plans for
 * the existing supervisor-maintenance queue, never an alternate dispatch route. */
export function prepareDevRegistrationProvisioner(
  value: unknown,
): PreparedDevRegistrationProvisioner {
  const input = DevRegistrationProvisionerInputSchema.parse(value);
  assertDevRegistrationDockerPin(input.docker);
  return prepareRetainedProvisioner(input);
}

/** Decode only the bounded data envelope, then compare the entire program to
 * this trusted generator. This does not approve its installation or file pins.
 * The limit matches the protected bootstrap document reader's 1 MiB bound. */
export function verifyDevRegistrationC1Script(script: string): PreparedDevRegistrationProvisioner {
  if (Buffer.byteLength(script, "utf8") > 1024 * 1024)
    throw new Error("C1 replacement script exceeds its byte bound");
  const envelopes = [...script.matchAll(/^const reviewed=([^\r\n]+);$/gm)];
  if (envelopes.length !== 1)
    throw new Error("C1 replacement requires one canonical reviewed envelope");
  const bytes = envelopes[0][1];
  const parsed: unknown = JSON.parse(bytes);
  if (JSON.stringify(parsed) !== bytes)
    throw new Error("C1 reviewed envelope is not canonical JSON");
  const reviewed = z
    .strictObject({ plan: z.unknown(), planSha256: digest, operation: z.literal("replace") })
    .parse(parsed);
  // Extraction is not validation of derived plan fields. Only exact generation
  // below can establish that the supplied program is this fixed replacement.
  const input = DevRegistrationProvisionerInputSchema.strip().parse(reviewed.plan);
  if (input.c1First?.format !== "c1-first-v1") throw new Error("C1 replacement format is required");
  const prepared = prepareDevRegistrationProvisioner(input);
  if (prepared.planSha256 !== reviewed.planSha256 || prepared.script !== script)
    throw new Error("C1 replacement script differs from the exact fixed generator");
  return prepared;
}

/** Historical parsing never approves or supplies missing executable pins. */
export function assertDevRegistrationDockerPin(docker: ProvisionerInput["docker"]): void {
  sourceFile
    .extend({
      size: z
        .number()
        .int()
        .positive()
        .max(256 * 1024 * 1024),
    })
    .parse({ path: docker.path, sha256: docker.sha256, size: docker.size });
}

/** Verification only: no regenerated script is returned as fresh authority.
 * Pinless v682 attempts keep their exact plan, scripts and uncertainty fence. */
export function verifyRetainedDevRegistrationProvisioner(
  value: PreparedDevRegistrationProvisioner,
): void {
  const retained = structuredClone(value);
  const input = DevRegistrationProvisionerInputSchema.strip().parse(retained.plan);
  if (!isDeepStrictEqual(prepareRetainedProvisioner(input), retained))
    throw new Error("Registration artifact differs from the exact fixed preparer");
}

function assertC1ProvisionerInput(input: ProvisionerInput) {
  if (input.c1First) {
    assertDevRegistrationDockerPin(input.docker);
    const c = input.c1First;
    const paths = [
      ...Object.values(c.configurationFiles),
      ...Object.values(c.scripts),
      c.preparedReceiptFile,
      input.hostReceiptFile,
    ];
    if (
      new Set(paths).size !== paths.length ||
      input.configurationFile !== c.configurationFiles.replacement
    )
      throw new Error("C1 static configuration paths differ or collide");
    const roles = Object.values(c.startupReceiptRoles);
    if (
      new Set(roles.map((file) => file.path)).size !== 4 ||
      roles.some((role) => !input.startupFiles.some((file) => isDeepStrictEqual(file, role)))
    )
      throw new Error("Named startup receipt roles differ from reviewed closure");
    if (input.parent.executable !== input.systemPython.path)
      throw new Error("Parent executable differs from reviewed Python");
  }
}

function prepareRetainedProvisioner(input: ProvisionerInput): PreparedDevRegistrationProvisioner {
  if (
    input.originalLinuxArtifact.arch !== input.node.arch ||
    input.factoryRuntime.path !== input.originalFactoryRuntime ||
    !input.originalSupervisorEntrypoint.startsWith(input.originalLinuxArtifact.root + "/")
  )
    throw new Error("Original Linux supervisor closure or Factory runtime binding differs");
  if (
    devRegistrationLinuxArtifactDigest(input.originalLinuxArtifact) !==
    input.originalLinuxArtifact.artifactSha256
  )
    throw new Error("Original Linux supervisor closure digest differs");
  assertProcessBinding(input);
  for (const file of [input.factoryEntry, input.factoryLauncher, input.originalPointer]) {
    if (sha(file.content) !== file.sha256 || Buffer.byteLength(file.content) !== file.size)
      throw new Error("Original Factory startup bytes differ from their reviewed digest");
  }
  const candidate = input.factoryEntry.content.match(/^const candidate = '([^'\r\n]+)';$/m);
  if (!candidate || input.originalFactoryRuntime !== candidate[1] + "/runtime.mjs")
    throw new Error("Factory runtime module must retain its inspected candidate binding");
  if (
    input.originalPointer.content.trim() !== input.factoryEntry.path ||
    (!input.factoryEntry.content.includes(input.originalFactoryRuntime) &&
      !input.factoryEntry.content.includes("candidate + '/runtime.mjs'"))
  )
    throw new Error("Factory pointer or runtime handoff differs");
  if (
    devRegistrationLinuxArtifactDigest(input.linuxArtifact) !== input.linuxArtifact.artifactSha256
  )
    throw new Error(
      "Complete Linux candidate manifest differs from the existing prepared artifact digest",
    );
  const worker = "packages/server/dist/server/server/daemon-worker.js";
  const supervisor = "packages/server/dist/scripts/supervisor-entrypoint.js";
  if (
    ![worker, supervisor].every((file) =>
      input.linuxArtifact.entries.some((entry) => entry.path === file && entry.kind === "file"),
    )
  )
    throw new Error("Linux artifact lacks its supervisor or worker entrypoint");
  assertC1ProvisionerInput(input);
  const plan = provisioningPlan(input);
  const planSha256 = sha(JSON.stringify(plan));
  const script = hostScript({ plan, planSha256, operation: "replace" });
  const rollback = hostScript({ plan, planSha256, operation: "rollback" });
  return {
    plan,
    planSha256,
    script,
    sha256: sha(script),
    rollback: { script: rollback, sha256: sha(rollback) },
  };
}

const PROTECTED_SUPERVISOR_CHECK = `def protected_supervisor(file):
    current = file
    while True:
        metadata = os.lstat(current)
        if (os.path.realpath(current) != current or metadata.st_uid != 0
                or metadata.st_mode & 0o022
                or not (stat.S_ISREG(metadata.st_mode) or stat.S_ISDIR(metadata.st_mode))):
            raise RuntimeError("Protected Factory supervisor path differs")
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
`;

/** This gate is part of the exact reviewed eval buffer, never a launch wrapper. */
export const DEV_REGISTRATION_GATE_PREFIX = `import fs from 'node:fs';
const registrationGateByte=new Uint8Array(1);
try {
 if(fs.readSync(3,registrationGateByte,0,1,null)!==1||registrationGateByte[0]!==1)throw Error('Registration gate token refused');
 if(fs.readSync(3,registrationGateByte,0,1,null)!==0)throw Error('Registration gate EOF refused');
} finally { fs.closeSync(3); }
`;

interface HostScriptInput {
  plan: ReturnType<typeof provisioningPlan>;
  planSha256: string;
  operation: "replace" | "rollback";
}
function hostScript(input: HostScriptInput): string {
  const historical = historicalHostScriptV682(input);
  if (input.plan.docker.sha256 === undefined) return historical;
  // Retain the old generator verbatim for historical verification. New bytes
  // commit the reviewed pin before enrollment and verify it before each command.
  const pinned = replaceExactly(
    historical,
    "const prefix=['--host','unix://'+plan.docker.socket];",
    `function verifyDocker(){
 const bytes=protectedFile(plan.docker.path,256*1024*1024);
 check(bytes.length===plan.docker.size&&hash(bytes)===plan.docker.sha256,'Reviewed Docker executable differs');
}
const prefix=['--host','unix://'+plan.docker.socket];`,
  );
  const checked = replaceExactly(
    pinned,
    "const docker=args=>execFileSync(plan.docker.path,[...prefix,...args],{timeout:10000,maxBuffer:1024*1024,encoding:'utf8'});",
    "const docker=args=>{verifyDocker();return execFileSync(plan.docker.path,[...prefix,...args],{timeout:10000,maxBuffer:1024*1024,encoding:'utf8'});};",
  );
  const result = replaceExactly(
    checked,
    "const result=JSON.parse(execFileSync(plan.docker.path,",
    "verifyDocker();\nconst result=JSON.parse(execFileSync(plan.docker.path,",
  );
  return input.plan.c1First ? c1HostScript(result) : result;
}

// This v682 template also defines historical rollback bytes. Do not add new
// policy here: changes belong only to the pinned generator above.
function historicalHostScriptV682(input: HostScriptInput): string {
  return `${DEV_REGISTRATION_GATE_PREFIX}import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const reviewed=${JSON.stringify(input)};
const {plan,planSha256,operation}=reviewed;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=value=>hash(JSON.stringify(value));
const check=(ok,reason)=>{if(!ok)throw Error(reason);};
function protectedFile(file,limit=16*1024*1024){
 check(fs.realpathSync(file)===file,'Host plan path is not canonical');
 for(let current=file;;current=path.dirname(current)){
  const s=fs.lstatSync(current);check((s.uid===process.getuid()||s.uid===0)&&(s.mode&0o022)===0&&!s.isSymbolicLink(),'Host plan custody differs');
  if(path.dirname(current)===current)break;
 }
 const s=fs.lstatSync(file);check(s.isFile()&&s.nlink===1&&s.size<=limit,'Host document is unbounded');
 return fs.readFileSync(file);
}
function authority(effect){
 check(effect&&effect.phase!=='reserved'&&effect.consumedAt&&effect.child,'Consumed child claim is absent');
 return {binding:effect.binding,reservedAt:effect.reservedAt,consumedAt:effect.consumedAt,child:effect.child};
}
// Supervisor jobs exclude source updates, adoption and worker-launch scopes.
// This is the same immutable request projection used by standingRestartPlanDigest.
function requestDigest(job){return digest({id:job.id,target:job.target,requestedBy:job.requestedBy,requester:job.requester??null,reason:job.reason,createdAt:job.createdAt,requireOwnerApproval:job.requireOwnerApproval??false,update:job.update??null,sourceBatch:job.sourceBatch??null,supervisorPlanSha256:job.supervisorPlanSha256??null,factoryRuntimePlanSha256:job.factoryRuntimePlanSha256??null,factoryRuntimeRecoveryOf:job.factoryRuntimeRecoveryOf??null,devRepairs:job.devRepairs??[]});}
function load(){
 const configurationBytes=protectedFile(plan.configurationFile),config=JSON.parse(configurationBytes);
 const configured=config.container.supervisorMaintenance;
 check(configured&&hash(protectedFile(configured.script))===configured.sha256,'Exact protected supervisor plan differs');
 const evalIndex=process.execArgv.indexOf('--eval');
 check(evalIndex>=0&&hash(process.execArgv[evalIndex+1])===configured.sha256,'Actual executing script differs');
 const jobs=JSON.parse(protectedFile(path.join(config.stateDir,'restart-jobs.json')));
 const matches=jobs.filter(item=>item.id===process.env.VORTEO_RESTART_JOB_ID);check(matches.length===1,'Tracked registration job absent');
 const job=matches[0],effect=job.supervisorEffect,b=effect?.binding,d=job.standingDecision;
 check(job.status==='running'&&job.target==='container-daemon'&&effect?.phase!=='reserved'&&effect?.consumedAt&&effect?.child&&job.approvedAt&&d?.activationStep,'Registration requires its consumed activation child');
 check(!job.update&&!job.sourceBatch&&!job.factoryRuntimePlanSha256&&!job.workerLaunchRequest&&!job.workerLaunch,'Registration scope differs');
 check(b.requestId===job.id&&b.requestRevision===job.revision&&b.approvedAt===job.approvedAt&&b.decisionSha256===digest(d)&&d.requestRevision===job.revision,'Consumed approval differs');
 check(b.supervisorPlanSha256===configured.sha256&&job.supervisorPlanSha256===configured.sha256&&b.requestPlanSha256===requestDigest(job)&&d.planSha256===b.requestPlanSha256,'Consumed script or request plan differs');
 check(b.operation===operation&&b.registrationPlanSha256===planSha256&&b.preparationNonce===plan.preparationNonce&&b.sourceCommit===plan.linuxArtifact.sourceCommit&&b.artifactSha256===plan.linuxArtifact.artifactSha256,'Consumed preparation differs');
 check(effect.child.reservationSha256===digest({binding:b,reservedAt:effect.reservedAt}),'Child belongs to another reservation');
 const state=JSON.parse(protectedFile(path.join(config.stateDir,'maintenance-enrollment.json')));
 check(state.status==='enrolled','Registration enrollment absent');
 const {grant,activation}=state,manifest=grant.manifest;
 check(!grant.paused&&!grant.revokedAt&&!grant.disabledTargets.includes('supervisor')&&grant.id===b.grantId&&grant.revision===b.grantRevision&&digest(manifest)===b.manifestSha256&&grant.approval.manifestSha256===b.manifestSha256&&activation.manifestSha256===b.manifestSha256,'Current registration grant changed');
 const step=manifest.steps.find(item=>item.id===b.stepId),progress=activation.steps.find(item=>item.id===b.stepId),target=manifest.targets.find(item=>item.target==='supervisor');
 check(step?.target==='supervisor'&&step.operation==='replacement'&&step.planSha256===b.requestPlanSha256&&step.candidate.sourceCommit===b.sourceCommit&&step.candidate.artifactSha256===b.artifactSha256&&target?.operations.includes('replacement')&&target.identitySha256===b.nativeIdentitySha256,'Registration step differs');
 check(progress?.status==='reserved'&&progress.generation===b.activationGeneration&&progress.generation===b.generation&&progress.grantRevision===grant.revision&&d.activationStep.stepId===b.stepId&&d.activationStep.generation===progress.generation&&d.activationStep.candidateArtifactSha256===b.artifactSha256,'Registration generation differs');
 check(step.dependsOn.every(id=>activation.steps.some(item=>item.id===id&&item.status==='succeeded'))&&!activation.steps.some(item=>item.id!==step.id&&['reserved','recovery_required'].includes(item.status)),'Activation dependencies changed');
 for(const key of ['grantId','grantRevision','manifestSha256'])check(d[key]===b[key],'Standing registration decision changed');
 check(config.public.installationId===plan.installationId&&config.containerSourceUpdates.containerId===plan.docker.containerId,'Installation or container changed');
 const settings=config.containerSourceUpdates;
 check(settings.docker===plan.docker.path&&settings.user===plan.account.user&&settings.node===plan.node.path&&settings.home===plan.account.stateDirectory&&settings.releaseRoot===plan.releaseRoot&&settings.currentReleaseLink===plan.selectionPath,'Configured Dev startup settings differ');
 let original=null;
 if(operation==='rollback'){
  check(b.original,'Rollback original link absent');
  const originals=jobs.filter(item=>item.id===b.original.requestId);check(originals.length===1,'Original registration job absent');
  const prior=originals[0],priorEffect=prior.supervisorEffect;
  check(prior.status==='failed'&&prior.target==='container-daemon'&&priorEffect?.child&&priorEffect.binding.operation==='replace'&&priorEffect.binding.original===null,'Original registration is not durably failed and consumed');
  original=authority(priorEffect);
  check(digest(original)===b.original.claimSha256&&original.binding.preparationNonce===plan.preparationNonce&&original.binding.registrationPlanSha256===planSha256&&original.binding.requestId===prior.id&&original.binding.requestRevision===prior.revision&&original.binding.supervisorPlanSha256===prior.supervisorPlanSha256&&original.binding.approvedAt===prior.approvedAt&&original.binding.decisionSha256===digest(prior.standingDecision)&&original.binding.requestPlanSha256===requestDigest(prior),'Original consumed claim differs');
 }else check(b.original===null,'Replacement cannot borrow rollback authority');
 return {config,configured,job,claim:authority(effect),original,configurationSha256:hash(configurationBytes)};
}
function inspectExecutor(context){
 const helper=protectedFile(plan.hostInspector.path);check(helper.length===plan.hostInspector.size&&hash(helper)===plan.hostInspector.sha256,'Pinned Host inspector changed');
 const child=context.claim.child.executor;
 check(child.pid===process.pid,'Consumed child is not this executor');
 const actual=JSON.parse(execFileSync('/usr/bin/python3',['-I','-B','-c',helper.toString('utf8'),String(process.pid),'--audit-token'],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:10000,maxBuffer:65536}));
 const expected={pid:child.pid,parentPid:child.parentPid,uid:child.uid,bootId:child.bootId,startIdentity:child.startIdentity,argumentsSha256:child.argumentsSha256,executable:child.executable.path};
 check(isDeepStrictEqual(actual.identity,expected)&&isDeepStrictEqual(actual.auditToken,child.auditToken),'Native effect-child lifetime differs');
 check(fs.realpathSync(process.execPath)===child.executable.path&&hash(protectedFile(child.executable.path,256*1024*1024))===child.executable.sha256&&child.entrypoint.path===context.configured.script&&child.entrypoint.sha256===context.configured.sha256,'Effect executor artifact differs');
}
const context=load();inspectExecutor(context);
const {config,configured,job,claim,original}=context,jobId=job.id;
const claimSha256=digest(claim),originalClaim=original??claim,originalClaimSha256=digest(originalClaim);
const publicationConfig={...config,container:{...config.container}};delete publicationConfig.container.supervisorMaintenance;
check(!config.container.persistentRegistration,'Published registration requires separate recovery');
try{fs.lstatSync(plan.hostReceiptFile);throw Error('Registration receipt already published');}catch(error){if(error.code!=='ENOENT')throw error;}
const publicationSnapshot={planSha256,claimSha256:originalClaimSha256,jobId:originalClaim.binding.requestId,scriptSha256:originalClaim.binding.supervisorPlanSha256,configurationSha256:digest(publicationConfig),receiptAbsent:true};
if(operation==='replace'){
 const parent=path.dirname(plan.hostAttemptFile);
 for(let current=parent;;current=path.dirname(current)){const s=fs.lstatSync(current);check(fs.realpathSync(current)===current&&s.isDirectory()&&(s.uid===process.getuid()||s.uid===0)&&(s.mode&0o022)===0,'Host attempt parent custody differs');if(path.dirname(current)===current)break;}
 const fd=fs.openSync(plan.hostAttemptFile,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(publicationSnapshot));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const directory=fs.openSync(parent,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
}else check(isDeepStrictEqual(JSON.parse(protectedFile(plan.hostAttemptFile)),publicationSnapshot),'Rollback publication snapshot differs');
const prefix=['--host','unix://'+plan.docker.socket];
const docker=args=>execFileSync(plan.docker.path,[...prefix,...args],{timeout:10000,maxBuffer:1024*1024,encoding:'utf8'});
const container=JSON.parse(docker(['container','inspect','--format','{"id":{{json .Id}},"running":{{json .State.Running}},"path":{{json .Path}},"args":{{json .Args}},"entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}},"mounts":{{json .Mounts}}}',plan.docker.containerId]));
check(container.id===plan.docker.containerId&&container.running,'Configured container differs');
const startup={path:container.path,args:container.args,entrypoint:container.entrypoint,cmd:container.cmd};check(isDeepStrictEqual(startup,plan.startup),'Docker startup tuple differs');
const writableMounts=container.mounts.filter(m=>m.RW).map(m=>m.Destination);
const final=load();check(isDeepStrictEqual(final.claim,claim)&&isDeepStrictEqual(final.original,original)&&final.configurationSha256===context.configurationSha256,'Consumed authority changed before root invocation');inspectExecutor(final);
// Exact declared registration capability only. No guest token or arbitrary payload.
const result=JSON.parse(execFileSync(plan.docker.path,[...prefix,'exec','-i','--user','0:0',plan.docker.containerId,'/usr/bin/python3','-I','-c',${JSON.stringify(DEV_REGISTRATION_PROVISIONING_SCRIPT)}],{
 input:JSON.stringify({plan,planSha256,operation,writableMounts,jobId,scriptSha256:configured.sha256,claim,claimSha256,originalClaim,originalClaimSha256}),encoding:'utf8',timeout:240000,maxBuffer:1024*1024,
}));
check(result.planSha256===planSha256&&result.claimSha256===claimSha256&&result.operation===operation&&result.jobId===jobId&&result.phase==='started-unverified','Native registration outcome remains unresolved');
console.log(JSON.stringify(result));
`;
}

/** Fixed privileged file/service program, emitted only inside the reviewed Host
 * supervisor-maintenance script. Never run by preparation or source tests. */
export const DEV_REGISTRATION_PROVISIONING_SCRIPT = String.raw`
import os,sys,json,hashlib,stat,time,pwd,platform,socket,http.client,xmlrpc.client
request=json.load(sys.stdin)
deadline=time.monotonic()+120
p=request['plan']; operation=request['operation']
claim=request['claim']; original_claim=request['originalClaim']; original_binding=original_claim['binding']
def check(ok,reason):
    if time.monotonic()>deadline: raise RuntimeError('Native registration deadline exceeded; inspect retained attempt')
    if not ok: raise RuntimeError(reason)
${DEV_REGISTRATION_NATIVE_PRIMITIVES}def sync_dir(directory):
    fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)
def create(file,data,mode=0o644):
    fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    try:
        os.fchmod(fd,mode)
        with os.fdopen(fd,'wb',closefd=False) as stream: stream.write(data);stream.flush();os.fsync(fd)
    finally: os.close(fd)
    sync_dir(os.path.dirname(file))
def atomic(file,expected,data,retained_identity=None):
    protected(file);check(digest(read(file))==expected,'Registration pointer changed')
    before=identity(os.lstat(file))
    if retained_identity is not None: check(list(before)==retained_identity,'Retained registration pointer identity changed')
    temporary=os.path.join(os.path.dirname(file),'.vorteo-registration-'+p['preparationNonce'])
    create(temporary,data)
    check(digest(read(file))==expected and identity(os.lstat(file))==before,'Registration pointer changed before commit')
    os.replace(temporary,file);sync_dir(os.path.dirname(file));check(read(file)==data,'Registration selection uncertain')
def manifest(root):
    output=[];observed={};total=0
    def visit(name):
        nonlocal total
        file=os.path.join(root,name);s=os.lstat(file);observed[file]=identity(s)
        check(s.st_uid in (0,p['account']['uid']),'Linux artifact owner differs')
        check(len(output)<250000,'Linux artifact exceeds entry bound')
        if stat.S_ISDIR(s.st_mode):
            check(not s.st_mode&0o022,'Writable Linux artifact directory');output.append(dict(kind='directory',path=name,mode=s.st_mode))
            for child in sorted(os.listdir(file)): visit(os.path.join(name,child))
        elif stat.S_ISREG(s.st_mode):
            check(not s.st_mode&0o022,'Writable Linux artifact file');data=read(file);total+=len(data);check(total<=8*1024**3,'Linux artifact exceeds byte bound')
            output.append(dict(kind='file',path=name,mode=s.st_mode,sha256=digest(data),size=len(data)))
        elif stat.S_ISLNK(s.st_mode):
            target=os.readlink(file);resolved=os.path.realpath(file)
            check(not os.path.isabs(target) and (resolved==root or resolved.startswith(root+'/')),'Linux artifact link escapes')
            output.append(dict(kind='link',path=name,target=target))
        else: raise RuntimeError('Unsupported Linux artifact object')
    visit('')
    for file,value in observed.items(): check(identity(os.lstat(file))==value,'Linux artifact changed during observation')
    return output
class UnixConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(65);self.sock.connect(p['supervisorSocket'])
class UnixTransport(xmlrpc.client.Transport):
    def make_connection(self,host): return UnixConnection(host,timeout=65)
def service_snapshot(service):
    check(service['name']=='paseo' and service['group']=='paseo','Supervisord program differs')
    return {key:service[key] for key in ('name','group','pid','state','start','stop','exitstatus','spawnerr')}
def assert_rollback_records(attempt,selection,outcome):
    check(selection['scriptSha256']==original_binding['supervisorPlanSha256'] and selection['claimSha256']==request['originalClaimSha256'],'Rollback original script differs')
    check(attempt==dict(planSha256=request['planSha256'],claimSha256=request['originalClaimSha256'],jobId=original_binding['requestId'],phase='prepared',scriptSha256=selection['scriptSha256'],rootExecutor=attempt['rootExecutor']),'Rollback attempt differs')
    expected_selection=dict(planSha256=request['planSha256'],claimSha256=request['originalClaimSha256'],jobId=original_binding['requestId'],parent=p['parent'],pointerSha256=digest(p['pointerContent'].encode()),pointerIdentity=selection['pointerIdentity'],scriptSha256=selection['scriptSha256'])
    check(selection==expected_selection,'Rollback selection record differs')
    check(outcome['phase'] in ('start-failed','started-unverified'),'Rollback outcome is not retained')
    expected_outcome=dict(planSha256=request['planSha256'],claimSha256=request['originalClaimSha256'],operation='replace',phase=outcome['phase'],jobId=original_binding['requestId'],scriptSha256=selection['scriptSha256'],rootExecutor=attempt['rootExecutor'])
    check(outcome==expected_outcome,'Rollback start outcome differs')
def assert_stopped_rollback(service,attempt,selection,outcome):
    check(type(service['pid']) is int and service['pid']==0 and type(service['state']) is int and service['state'] in (0,100,200),'Rollback service is not explicitly stopped')
    assert_rollback_records(attempt,selection,outcome)
def assert_native_absence():
    # A PID-zero RPC reply is not native absence. Read every visible process;
    # only ENOENT races are absence, never permission or transport failures.
    for name in os.listdir('/proc'):
        if not name.isdigit(): continue
        try:
            with open('/proc/'+name+'/stat') as stream: raw=stream.read()
            fields=raw[raw.rfind(')')+2:].strip().split()
            with open('/proc/'+name+'/status') as stream: status=stream.read().splitlines()
        except FileNotFoundError: continue
        uid=next(line for line in status if line.startswith('Uid:')).split()[1:]
        check(not (int(fields[1])==p['parent']['pid'] and str(p['account']['uid']) in uid),'A Dev service child remains present')
        check(not (int(name)==p['supervisor']['pid'] and fields[19]==p['supervisor']['startIdentity']),'Original supervisor lifetime remains present')
        try: executable=os.readlink('/proc/'+name+'/exe')
        except FileNotFoundError: continue
        check(executable not in (p['protectedNode'],p['protectedNode']+' (deleted)'),'A protected candidate process remains present')
def stopped_outcome():
    success=p['nativeReceiptFile'];failure=p['destination']+'/start-failure.json'
    present=[file for file in (success,failure) if os.path.lexists(file)]
    check(len(present)==1,'Rollback requires one retained start outcome')
    return protected_record(present[0])
def assert_original_root_exited(attempt):
    executor=attempt['rootExecutor']
    check(executor['uid']==0 and executor['executable']==p['systemPython']['path'],'Original root executor differs')
    try:
        with open('/proc/'+str(executor['pid'])+'/stat') as stream: raw=stream.read()
    except FileNotFoundError: return
    with open('/proc/sys/kernel/random/boot_id') as stream: boot=stream.read().strip()
    fields=raw[raw.rfind(')')+2:].strip().split()
    check(boot!=executor['bootId'] or fields[19]!=executor['startIdentity'],'Original root executor remains present')
check(digest(json.dumps(p,separators=(',',':'),ensure_ascii=False).encode())==request['planSha256'],'Reviewed native plan digest differs')

check(digest(json.dumps(claim,separators=(',',':'),ensure_ascii=False).encode())==request['claimSha256'],'Consumed child claim digest differs')
check(digest(json.dumps(original_claim,separators=(',',':'),ensure_ascii=False).encode())==request['originalClaimSha256'],'Original consumed claim digest differs')
check(bool(claim.get('consumedAt')) and bool(original_claim.get('consumedAt')),'Durable child consumption absent')
binding=claim['binding']
check(binding['operation']==operation and binding['preparationNonce']==p['preparationNonce'] and binding['registrationPlanSha256']==request['planSha256'] and binding['requestId']==request['jobId'] and binding['supervisorPlanSha256']==request['scriptSha256'],'Consumed child scope differs')
check(binding['artifactSha256']==p['linuxArtifact']['artifactSha256'] and binding['sourceCommit']==p['linuxArtifact']['sourceCommit'],'Consumed candidate differs')
check(claim['child']['reservationSha256']==digest(json.dumps(dict(binding=binding,reservedAt=claim['reservedAt']),separators=(',',':'),ensure_ascii=False).encode()),'Consumed reservation differs')
if operation=='rollback':
    check(binding['original']==dict(requestId=original_binding['requestId'],claimSha256=request['originalClaimSha256']) and original_binding['operation']=='replace' and original_binding['preparationNonce']==p['preparationNonce'] and original_binding['registrationPlanSha256']==request['planSha256'],'Rollback predecessor claim differs')
else: check(operation=='replace' and binding['original'] is None and claim==original_claim,'Replacement cannot borrow predecessor authority')

check(os.getuid()==0 and sys.platform=='linux','Declared privileged Linux capability unavailable')
check(p['requiredCapability']=='reviewed-dev-root-registration-and-parent-observation-v1','Privileged capability differs')
check({'aarch64':'arm64','x86_64':'x64'}.get(platform.machine())==p['linuxArtifact']['arch'],'Linux artifact architecture differs')
check(os.path.realpath(sys.executable)==p['systemPython']['path'],'System Python identity differs');pin(p['systemPython'],True)
root_executor=process(os.getpid())
account=pwd.getpwnam(p['account']['user']);check((account.pw_uid,account.pw_gid,account.pw_dir)==(p['account']['uid'],p['account']['gid'],p['account']['home']),'Numeric Dev account differs')
check(process(p['parent']['pid'])==p['parent'],'Native parent precondition differs')
if operation=='replace': check(process(p['supervisor']['pid'])==p['supervisor'],'Native supervisor precondition differs')
for file in p['startupFiles']: pin(file,True)
protected(p['supervisorSocket']);check(stat.S_ISSOCK(os.lstat(p['supervisorSocket']).st_mode),'Supervisord socket differs')
check(p['destination']=='/opt/vorteo-persistent-registration/'+p['preparationNonce'],'Protected destination differs')
check(p['runtime']==p['destination']+'/runtime' and p['protectedNode']==p['destination']+'/node','Protected runtime destinations differ')
check([item['path'] for item in p['files']]==[p['destination']+'/factory-main-entry.mjs',p['destination']+'/factory-launch.py'],'Factory destinations differ')
check(p['pointerContent']==p['destination']+'/factory-main-entry.mjs\n','Protected pointer target differs')
check(p['supervisorSocket']=='/run/personal-tailscale/supervisor.sock' and p['program']=='paseo','Supervisord capability scope differs')
protected('/opt',True)
pin(p['factoryRuntime'])
check(manifest(p['originalLinuxArtifact']['root'])==p['originalLinuxArtifact']['entries'],'Original Linux supervisor closure differs')
original=p['originalPointer']['content'].encode();check(digest(original)==p['originalPointer']['sha256'],'Original pointer bytes differ')
if operation=='replace':
    pin(p['originalPointer'],True);pin(p['factoryEntry']);pin(p['factoryLauncher']);pin(p['node'])
    check(manifest(p['linuxArtifact']['root'])==p['linuxArtifact']['entries'],'Prepared Linux closure differs')
    base=os.path.dirname(p['destination']);no_mount(base)
    if not os.path.lexists(base): os.mkdir(base,0o755);sync_dir(os.path.dirname(base))
    protected(base,True)
    os.mkdir(p['destination'],0o755);sync_dir(os.path.dirname(p['destination']))
    create(p['destination']+'/attempt.json',json.dumps(dict(planSha256=request['planSha256'],claimSha256=request['claimSha256'],jobId=request['jobId'],phase='prepared',scriptSha256=request['scriptSha256'],rootExecutor=root_executor),separators=(',',':')).encode(),0o600)
    for item in p['files']:
        import base64
        data=base64.b64decode(item['contentBase64'],validate=True);check(digest(data)==item['sha256'],'Prepared Factory bytes differ');create(item['path'],data,item['mode'])
    create(p['protectedNode'],pin(p['node']),0o755)
    os.mkdir(p['runtime'],p['linuxArtifact']['entries'][0]['mode']&0o777);os.chmod(p['runtime'],p['linuxArtifact']['entries'][0]['mode']&0o777)
    for entry in p['linuxArtifact']['entries'][1:]:
        source=os.path.join(p['linuxArtifact']['root'],entry['path']);target=os.path.join(p['runtime'],entry['path'])
        if entry['kind']=='directory': os.mkdir(target,entry['mode']&0o777);os.chmod(target,entry['mode']&0o777)
        elif entry['kind']=='file':
            data=read(source);check(digest(data)==entry['sha256'] and len(data)==entry['size'],'Candidate source changed during copy');create(target,data,entry['mode']&0o777)
        else: os.symlink(entry['target'],target);sync_dir(os.path.dirname(target))
    check(manifest(p['runtime'])==p['linuxArtifact']['entries'],'Protected Linux closure differs after copy')
    sync_dir(p['runtime']);sync_dir(p['destination'])
    pointer=p['pointerContent'].encode();expected=p['originalPointer']['sha256']
else:
    check(operation=='rollback','Unsupported native registration operation')
    pin(p['factoryEntry']);pin(p['factoryLauncher']);pin(p['node'])
    protected(p['destination'],True)
    retained=protected_record(p['destination']+'/attempt.json')
    selection=protected_record(p['destination']+'/selection.json')
    assert_rollback_records(retained,selection,stopped_outcome())
    assert_original_root_exited(retained)
    protected(p['originalPointer']['path'])
    check(digest(read(p['originalPointer']['path']))==digest(p['pointerContent'].encode()) and list(identity(os.lstat(p['originalPointer']['path'])))==selection['pointerIdentity'],'Rollback selected pointer differs')
    create(p['destination']+'/rollback-attempt.json',json.dumps(dict(jobId=request['jobId'],planSha256=request['planSha256'],claimSha256=request['claimSha256'],originalClaimSha256=request['originalClaimSha256'],operation='rollback',scriptSha256=request['scriptSha256'],rootExecutor=root_executor),separators=(',',':')).encode(),0o600)
    expected=digest(p['pointerContent'].encode());pointer=original
check(process(p['parent']['pid'])==p['parent'],'Native parent changed before service effect')
server=xmlrpc.client.ServerProxy('http://localhost/RPC2',transport=UnixTransport(),allow_none=True)
service=server.supervisor.getProcessInfo('paseo');observed_service=service_snapshot(service)
absent=operation=='rollback' and service['pid']==0
if absent:
    outcome=stopped_outcome();assert_stopped_rollback(service,retained,selection,outcome);assert_native_absence()
else:
    stopped=process(service['pid'])
    check(stopped['parentPid']==p['parent']['pid'] and stopped['uid']==p['account']['uid'] and stopped['gid']==p['account']['gid'],'Supervisord program custody differs')
    if operation=='replace': check(stopped==p['supervisor'],'Registered supervisor changed before stop')
    else: check(stopped['executable']==p['protectedNode'],'Rollback supervisor differs from protected candidate')
    server.supervisor.stopProcess('paseo',True)
    try:
        current=process(stopped['pid'])
        check(current['startIdentity']!=stopped['startIdentity'] or current['bootId']!=stopped['bootId'],'Previous supervisor remains present')
    except FileNotFoundError: pass
check(process(p['parent']['pid'])==p['parent'],'Native parent changed before pointer selection')
if absent:
    check(service_snapshot(server.supervisor.getProcessInfo('paseo'))==observed_service,'Stopped service changed before rollback')
    final_attempt=protected_record(p['destination']+'/attempt.json')
    assert_stopped_rollback(service,final_attempt,protected_record(p['destination']+'/selection.json'),stopped_outcome());assert_original_root_exited(final_attempt);assert_native_absence()
atomic(p['originalPointer']['path'],expected,pointer,selection['pointerIdentity'] if operation=='rollback' else None)
if operation=='replace':
    selection=dict(planSha256=request['planSha256'],claimSha256=request['claimSha256'],jobId=request['jobId'],parent=p['parent'],pointerSha256=digest(pointer),pointerIdentity=list(identity(os.lstat(p['originalPointer']['path']))),scriptSha256=request['scriptSha256'])
    create(p['destination']+'/selection.json',json.dumps(selection,separators=(',',':')).encode(),0o600)
try: server.supervisor.startProcess('paseo',True)
except Exception:
    if operation=='replace':
        failure=dict(planSha256=request['planSha256'],claimSha256=request['claimSha256'],operation=operation,phase='start-failed',jobId=request['jobId'],scriptSha256=request['scriptSha256'],rootExecutor=root_executor)
        create(p['destination']+'/start-failure.json',json.dumps(failure,separators=(',',':')).encode(),0o600)
    raise
check(read(p['originalPointer']['path'])==pointer,'Registration selection changed after startup')
result=dict(planSha256=request['planSha256'],claimSha256=request['claimSha256'],operation=operation,phase='started-unverified',jobId=request['jobId'],scriptSha256=request['scriptSha256'],rootExecutor=root_executor)
create(p['nativeReceiptFile'] if operation=='replace' else p['destination']+'/rollback-result.json',json.dumps(result,separators=(',',':')).encode(),0o600)
print(json.dumps(result,separators=(',',':')))
`;

function c1HostScript(script: string): string {
  let result = replaceExactly(
    script,
    "function load(){",
    `${C1_SCRIPT_DOCUMENTS}
function load(){`,
  );
  result = replaceExactly(
    result,
    "const configurationBytes=protectedFile(plan.configurationFile),config=JSON.parse(configurationBytes);",
    "const documents=readC1Documents();const configurationBytes=documents[operation==='replace'?'replacement':'rollback'].bytes,config=JSON.parse(configurationBytes);",
  );
  result = replaceExactly(
    result,
    "return {config,configured,job,claim:authority(effect),original,configurationSha256:hash(configurationBytes)};",
    "return {config,configured,job,claim:authority(effect),original,configurationSha256:hash(configurationBytes),documents};",
  );
  result = replaceExactly(
    result,
    "const context=load();inspectExecutor(context);",
    "const context=load();inspectExecutor(context);assertC1Documents(context.documents);",
  );
  result = replaceExactly(
    result,
    "check(child.pid===process.pid,'Consumed child is not this executor');",
    "check(child.pid===process.pid&&child.executable.path===context.configured.node,'Consumed child is not this executor');",
  );
  result = replaceExactly(
    result,
    "}else check(b.original===null,'Replacement cannot borrow rollback authority');",
    "check(documents.replacement.parsed.container.supervisorMaintenance.sha256===original.binding.supervisorPlanSha256,'Rollback replacement configuration differs from original consumed script');\n }else check(b.original===null,'Replacement cannot borrow rollback authority');",
  );
  result = replaceExactly(
    result,
    "const publicationConfig={...config,container:{...config.container}};delete publicationConfig.container.supervisorMaintenance;",
    "const publicationConfig={...context.documents.replacement.parsed,container:{...context.documents.replacement.parsed.container}};delete publicationConfig.container.supervisorMaintenance;",
  );
  result = replaceExactly(
    result,
    "const publicationSnapshot={planSha256,claimSha256:originalClaimSha256,jobId:originalClaim.binding.requestId,scriptSha256:originalClaim.binding.supervisorPlanSha256,configurationSha256:digest(publicationConfig),receiptAbsent:true};",
    "const publicationSnapshot={version:2,planSha256,claimSha256:originalClaimSha256,jobId:originalClaim.binding.requestId,scriptSha256:originalClaim.binding.supervisorPlanSha256,configurationSha256:digest(publicationConfig),documents:documentPins(context.documents),receiptAbsent:true};",
  );
  result = replaceExactly(
    result,
    "const final=load();check(isDeepStrictEqual(final.claim,claim)&&isDeepStrictEqual(final.original,original)&&final.configurationSha256===context.configurationSha256,'Consumed authority changed before root invocation');inspectExecutor(final);",
    "assertC1Documents(context.documents);const final=load();check(isDeepStrictEqual(final.claim,claim)&&isDeepStrictEqual(final.original,original)&&final.configurationSha256===context.configurationSha256&&isDeepStrictEqual(documentPins(final.documents),documentPins(context.documents)),'Consumed authority changed before root invocation');inspectExecutor(final);assertC1Documents(context.documents);assertC1Documents(final.documents);check(isDeepStrictEqual(documentPins(readC1Documents()),documentPins(context.documents)),'C1 documents changed after native inspection');",
  );
  return result;
}
const C1_SCRIPT_DOCUMENTS = `
const c1Custody=new WeakMap();
function retainC1Files(paths){
 const records=new Map();
 const identity=file=>{const s=fs.lstatSync(file,{bigint:true});check(fs.realpathSync(file)===file&&!s.isSymbolicLink()&&(s.uid===0n||s.uid===BigInt(process.getuid()))&&(s.mode&0o022n)===0n&&(s.isDirectory()||(s.isFile()&&s.nlink===1n&&s.size<=268435456n)),'C1 document custody differs');return [s.dev,s.ino,s.uid,s.gid,s.mode,...(s.isDirectory()?[]:[s.size,s.mtimeNs,s.ctimeNs,s.nlink])].join(':');};
 for(const file of paths)for(let current=file;;current=path.dirname(current)){const value=identity(current);check(!records.has(current)||records.get(current)===value,'C1 ancestry raced');records.set(current,value);check(records.size<=256,'C1 ancestry exceeds bound');if(path.dirname(current)===current)break;}
 return ()=>{for(const [file,value] of records)check(identity(file)===value,'C1 document lifetime changed');};
}
function assertC1Documents(documents){const verify=c1Custody.get(documents);check(typeof verify==='function','C1 retained custody is absent');verify();}
function documentPins(documents){return Object.fromEntries(Object.entries(documents).map(([name,item])=>[name,{path:item.path,sha256:hash(item.bytes)}]));}
function receiptForC1(replacement){
 const roles=plan.c1First.startupReceiptRoles;
 const file=item=>({path:item.path,sha256:item.sha256});
 const supervisor=plan.linuxArtifact.entries.find(item=>item.kind==='file'&&item.path==='packages/server/dist/scripts/supervisor-entrypoint.js');
 return {version:1,purpose:'dev-persistent-registration',installationId:plan.installationId,containerId:plan.docker.containerId,startup:plan.startup,account:plan.account,
 supervisorPlanSha256:replacement.container.supervisorMaintenance.sha256,launcherPath:plan.originalPointer.path,selectionPath:plan.selectionPath,releaseRoot:plan.releaseRoot,selectionCustody:'configured-dev-user',parentArgumentsSha256:plan.parent.argumentsSha256,
 files:{containerEntrypoint:file(roles.containerEntrypoint),supervisorConfiguration:file(roles.supervisorConfiguration),profileLauncher:file(roles.profileLauncher),dockerEntrypoint:file(roles.dockerEntrypoint),entrySelection:{path:plan.originalPointer.path,sha256:hash(plan.pointerContent)},factoryEntrypoint:file(plan.files.find(item=>item.path===plan.destination+'/factory-main-entry.mjs')),factoryLauncher:file(plan.files.find(item=>item.path===plan.destination+'/factory-launch.py')),supervisorEntrypoint:{path:plan.supervisorEntrypoint,sha256:supervisor.sha256},parentExecutable:{path:plan.parent.executable,sha256:plan.systemPython.sha256},node:{path:plan.protectedNode,sha256:plan.node.sha256}}};
}
function readC1Documents(){
 const paths={...plan.c1First.configurationFiles,preparedReceipt:plan.c1First.preparedReceiptFile};
 const assertFiles=retainC1Files([...Object.values(paths),...Object.values(plan.c1First.scripts)]);
 const documents=Object.fromEntries(Object.entries(paths).map(([name,file])=>{const bytes=protectedFile(file,1048576);return [name,{path:file,bytes,parsed:JSON.parse(bytes)}];}));
 const {original,replacement,rollback,selected,preparedReceipt}=Object.fromEntries(Object.entries(documents).map(([name,item])=>[name,item.parsed]));
 check(!original.container.supervisorMaintenance&&!original.container.persistentRegistration&&!replacement.container.persistentRegistration&&!rollback.container.persistentRegistration,'C1 original or operation registration differs');
 const a=replacement.container.supervisorMaintenance,b=rollback.container.supervisorMaintenance;
 check(a?.node===plan.c1First.scripts.node&&b?.node===plan.c1First.scripts.node&&a?.script===plan.c1First.scripts.replacement&&b?.script===plan.c1First.scripts.rollback,'C1 fixed script selectors differ');
 check(a&&b&&a.node===b.node&&a.script!==b.script&&a.sha256!==b.sha256,'C1 operation references differ');
 check(hash(protectedFile(a.script))===a.sha256&&hash(protectedFile(b.script))===b.sha256,'C1 operation script changed');
 const common=config=>{const copy=structuredClone(config);delete copy.container.supervisorMaintenance;return copy;};
 check(isDeepStrictEqual(common(replacement),original)&&isDeepStrictEqual(common(rollback),original),'C1 operation common projection differs');
 const receipt=receiptForC1(replacement);check(isDeepStrictEqual(receipt,preparedReceipt),'C1 prepared receipt projection differs');
 const expected=structuredClone(replacement);expected.containerSourceUpdates.node=plan.protectedNode;
 expected.container.persistentRegistration={receiptFile:plan.hostReceiptFile,sha256:hash(documents.preparedReceipt.bytes)};
 check(isDeepStrictEqual(expected,selected),'C1 selected projection differs');
 assertFiles();c1Custody.set(documents,assertFiles);return documents;
}
`;
export function devRegistrationC1Receipt(prepared: PreparedDevRegistrationProvisioner) {
  const plan = prepared.plan,
    c = plan.c1First;
  if (!c) throw new Error("C1 registration format is absent");
  const file = (item: { path: string; sha256: string } | undefined) => {
    if (!item) throw new Error("Named receipt artifact is absent");
    return { path: item.path, sha256: item.sha256 };
  };
  const supervisor = plan.linuxArtifact.entries.find(
    (item) =>
      item.kind === "file" && item.path === "packages/server/dist/scripts/supervisor-entrypoint.js",
  );
  if (!supervisor || supervisor.kind !== "file")
    throw new Error("Receipt supervisor artifact is absent");
  return DevRegistrationReceiptSchema.parse({
    version: 1,
    purpose: "dev-persistent-registration",
    installationId: plan.installationId,
    containerId: plan.docker.containerId,
    startup: plan.startup,
    account: plan.account,
    supervisorPlanSha256: prepared.sha256,
    launcherPath: plan.originalPointer.path,
    selectionPath: plan.selectionPath,
    releaseRoot: plan.releaseRoot,
    selectionCustody: "configured-dev-user",
    parentArgumentsSha256: plan.parent.argumentsSha256,
    files: {
      containerEntrypoint: file(c.startupReceiptRoles.containerEntrypoint),
      supervisorConfiguration: file(c.startupReceiptRoles.supervisorConfiguration),
      profileLauncher: file(c.startupReceiptRoles.profileLauncher),
      dockerEntrypoint: file(c.startupReceiptRoles.dockerEntrypoint),
      entrySelection: { path: plan.originalPointer.path, sha256: sha(plan.pointerContent) },
      factoryEntrypoint: file(
        plan.files.find((item) => item.path === plan.destination + "/factory-main-entry.mjs"),
      ),
      factoryLauncher: file(
        plan.files.find((item) => item.path === plan.destination + "/factory-launch.py"),
      ),
      supervisorEntrypoint: { path: plan.supervisorEntrypoint, sha256: supervisor.sha256 },
      parentExecutable: { path: plan.parent.executable, sha256: plan.systemPython.sha256 },
      node: { path: plan.protectedNode, sha256: plan.node.sha256 },
    },
  });
}
export function prepareDevRegistrationC1Documents(input: {
  provisioner: PreparedDevRegistrationProvisioner;
  original: CapturedRegistrationDocument<z.infer<typeof InstallationConfigSchema>>;
  replacementScript: { path: string; bytes: Buffer; sha256: string };
  rollbackScript: { path: string; bytes: Buffer; sha256: string };
  hostNode: string;
}): C1RegistrationDocuments {
  const { provisioner } = input;
  verifyRetainedDevRegistrationProvisioner(provisioner);
  const plan = provisioner.plan,
    c = plan.c1First;
  if (!c) throw new Error("C1 registration format is absent");
  const original = structuredClone(input.original);
  original.bytes = Buffer.from(input.original.bytes);
  original.parsed = InstallationConfigSchema.parse(original.parsed);
  if (
    original.path !== c.configurationFiles.original ||
    sha(original.bytes) !== original.sha256 ||
    !isDeepStrictEqual(JSON.parse(original.bytes.toString("utf8")), original.parsed)
  )
    throw new Error("C1 original captured bytes differ");
  const script = (value: typeof input.replacementScript, expected: string, expectedSha: string) => {
    absolute.parse(value.path);
    if (
      !value.bytes.equals(Buffer.from(expected)) ||
      sha(value.bytes) !== value.sha256 ||
      value.sha256 !== expectedSha
    )
      throw new Error("C1 reviewed script bytes differ");
    return { node: absolute.parse(input.hostNode), script: value.path, sha256: value.sha256 };
  };
  const replacement = structuredClone(original.parsed),
    rollback = structuredClone(original.parsed);
  replacement.container.supervisorMaintenance = script(
    input.replacementScript,
    provisioner.script,
    provisioner.sha256,
  );
  rollback.container.supervisorMaintenance = script(
    input.rollbackScript,
    provisioner.rollback.script,
    provisioner.rollback.sha256,
  );
  const receipt = devRegistrationC1Receipt(provisioner);
  if (
    input.hostNode !== c.scripts.node ||
    input.replacementScript.path !== c.scripts.replacement ||
    input.rollbackScript.path !== c.scripts.rollback
  )
    throw new Error("C1 fixed script selectors differ");
  const document = <T>(file: string, parsed: T): CapturedRegistrationDocument<T> => {
    const bytes = Buffer.from(JSON.stringify(parsed));
    return { path: file, bytes, sha256: sha(bytes), parsed };
  };
  const preparedReceipt = document(c.preparedReceiptFile, receipt),
    selected = structuredClone(replacement);
  if (!selected.containerSourceUpdates) throw new Error("C1 source updater is absent");
  selected.containerSourceUpdates.node = plan.protectedNode;
  selected.container.persistentRegistration = {
    receiptFile: plan.hostReceiptFile,
    sha256: preparedReceipt.sha256,
  };
  return captureC1RegistrationDocuments({
    original,
    replacement: document(c.configurationFiles.replacement, replacement),
    rollback: document(c.configurationFiles.rollback, rollback),
    selected: document(c.configurationFiles.selected, selected),
    preparedReceipt,
  });
}
