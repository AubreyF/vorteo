import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { DevStartupSchema } from "./dev-registration.js";

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
  generation: z.uuid(),
  jobId: z.uuid(),
  rollback: z.strictObject({
    jobId: z.uuid(),
    grantId: z.uuid(),
    grantRevision: z.uuid(),
    manifestSha256: digest,
    stepId: z.uuid(),
    generation: z.uuid(),
  }),
  activation: z.strictObject({
    grantId: z.uuid(),
    grantRevision: z.uuid(),
    manifestSha256: digest,
    stepId: z.uuid(),
    generation: z.uuid(),
  }),
  configurationFile: absolute,
  hostReceiptFile: absolute,
  docker: z.strictObject({
    path: absolute,
    socket: absolute,
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
  }),
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
  const destination = `/opt/vorteo-persistent-registration/${input.generation}`;
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
  if (input.rollback.jobId === input.jobId)
    throw new Error("Rollback requires its own exact tracked job");
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

function hostScript(input: {
  plan: ReturnType<typeof provisioningPlan>;
  planSha256: string;
  operation: "replace" | "rollback";
}): string {
  return `import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const reviewed=${JSON.stringify(input)};
const {plan,planSha256,operation}=reviewed;
const jobId=operation==='replace'?plan.jobId:plan.rollback.jobId;
const activation=operation==='replace'?plan.activation:plan.rollback;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const check=(ok,reason)=>{if(!ok)throw Error(reason);};
function protectedFile(file){
 check(fs.realpathSync(file)===file,'Host plan path is not canonical');
 for(let current=file;;current=path.dirname(current)){
  const s=fs.lstatSync(current);check((s.uid===process.getuid()||s.uid===0)&&(s.mode&0o022)===0&&!s.isSymbolicLink(),'Host plan custody differs');
  if(path.dirname(current)===current)break;
 }
 const s=fs.lstatSync(file);check(s.isFile()&&s.nlink===1&&s.size<=16*1024*1024,'Host document is unbounded');
 return fs.readFileSync(file);
}
const config=JSON.parse(protectedFile(plan.configurationFile));
const configured=config.container.supervisorMaintenance;
check(configured&&hash(protectedFile(configured.script))===configured.sha256,'Exact protected supervisor plan differs');
check(process.env.VORTEO_RESTART_JOB_ID===jobId,'Registration requires its exact tracked job');
const jobs=JSON.parse(protectedFile(path.join(config.stateDir,'restart-jobs.json')));
const matches=jobs.filter(job=>job.id===jobId);check(matches.length===1,'Tracked registration job absent');
const job=matches[0],decision=job.standingDecision,step=decision?.activationStep;
check(job.status==='running'&&job.target==='container-daemon'&&job.supervisorPlanSha256===configured.sha256&&job.approvedAt&&step&&decision.requestRevision===job.revision,'Registration requires the combined activation child');
for(const key of ['grantId','grantRevision','manifestSha256'])check(decision[key]===activation[key],'Combined activation changed');
check(step.stepId===activation.stepId&&step.generation===activation.generation&&step.candidateArtifactSha256===plan.linuxArtifact.artifactSha256,'Combined activation generation or Linux artifact changed');
check(config.public.installationId===plan.installationId&&config.containerSourceUpdates.containerId===plan.docker.containerId,'Installation or container changed');
const settings=config.containerSourceUpdates;
check(settings.docker===plan.docker.path&&settings.user===plan.account.user&&settings.node===plan.node.path&&settings.home===plan.account.stateDirectory&&settings.releaseRoot===plan.releaseRoot&&settings.currentReleaseLink===plan.selectionPath,'Configured Dev startup settings differ');
const prefix=['--host','unix://'+plan.docker.socket];
const docker=args=>execFileSync(plan.docker.path,[...prefix,...args],{timeout:10000,maxBuffer:1024*1024,encoding:'utf8'});
const container=JSON.parse(docker(['container','inspect','--format','{"id":{{json .Id}},"running":{{json .State.Running}},"path":{{json .Path}},"args":{{json .Args}},"entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}},"mounts":{{json .Mounts}}}',plan.docker.containerId]));
check(container.id===plan.docker.containerId&&container.running,'Configured container differs');
const startup={path:container.path,args:container.args,entrypoint:container.entrypoint,cmd:container.cmd};
check(JSON.stringify(startup)===JSON.stringify(plan.startup),'Docker startup tuple differs');
const writableMounts=container.mounts.filter(m=>m.RW).map(m=>m.Destination);
// This is the declared privileged capability of this admitted queue operation.
// It is never an implicit retry of an unprivileged observation.
const result=JSON.parse(execFileSync(plan.docker.path,[...prefix,'exec','-i','--user','0:0',plan.docker.containerId,'/usr/bin/python3','-I','-c',${JSON.stringify(DEV_REGISTRATION_PROVISIONING_SCRIPT)}],{
 input:JSON.stringify({plan,planSha256,operation,writableMounts,jobId,scriptSha256:configured.sha256}),encoding:'utf8',timeout:240000,maxBuffer:1024*1024,
}));
check(result.planSha256===planSha256&&result.operation===operation&&result.jobId===jobId&&result.phase==='started-unverified','Native registration outcome remains unresolved');
// Authenticated daemon readiness and retained receipt/config publication belong
// to the coordinator after this exact native result, not to pointer selection.
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
def check(ok,reason):
    if time.monotonic()>deadline: raise RuntimeError('Native registration deadline exceeded; inspect retained attempt')
    if not ok: raise RuntimeError(reason)
def digest(data): return hashlib.sha256(data).hexdigest()
def identity(s): return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def no_mount(file):
    check(not any(file==root or file.startswith(root.rstrip('/')+'/') for root in request['writableMounts']),'Registration destination is guest mounted')
def protected(file,directory=False):
    no_mount(file)
    current=file
    while True:
        s=os.lstat(current)
        check(os.path.realpath(current)==current and s.st_uid==0 and not s.st_mode&0o022,'Unprotected native registration path')
        check(stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode) or stat.S_ISSOCK(s.st_mode),'Unsupported native registration object')
        parent=os.path.dirname(current)
        if parent==current: break
        current=parent
    if directory: check(stat.S_ISDIR(os.lstat(file).st_mode),'Expected protected directory')
def read(file,limit=268435456):
    fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        before=os.fstat(fd);check(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size<=limit,'Unsafe source file')
        chunks=[];total=0
        while True:
            chunk=os.read(fd,65536)
            if not chunk: break
            total+=len(chunk);check(total<=limit,'Oversized source file');chunks.append(chunk)
        check(identity(before)==identity(os.fstat(fd))==identity(os.lstat(file)),'Source changed while reading')
        return b''.join(chunks)
    finally: os.close(fd)
def pin(file,protected_path=False):
    if protected_path: protected(file['path'])
    data=read(file['path']);check(len(data)==file['size'] and digest(data)==file['sha256'],'Pinned source changed');return data
def process(pid):
    with open('/proc/'+str(pid)+'/stat') as f: raw=f.read()
    fields=raw[raw.rfind(')')+2:].strip().split();check(fields[0] not in ('Z','T','t','X'),'Process is not running')
    with open('/proc/'+str(pid)+'/status') as f: status=f.read().splitlines()
    def ids(name):
        values=next(line for line in status if line.startswith(name+':')).split()[1:]
        check(len(values)==4 and len(set(values))==1,'Process credentials differ');return int(values[0])
    with open('/proc/'+str(pid)+'/cmdline','rb') as f: argv=[s.decode() for s in f.read(65537).split(b'\0') if s]
    with open('/proc/sys/kernel/random/boot_id') as f: boot=f.read().strip()
    return dict(pid=pid,parentPid=int(fields[1]),uid=ids('Uid'),gid=ids('Gid'),bootId=boot,startIdentity=fields[19],executable=os.path.realpath('/proc/'+str(pid)+'/exe'),argumentsSha256=digest(json.dumps(argv,separators=(',',':'),ensure_ascii=False).encode()))
def sync_dir(directory):
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
def atomic(file,expected,data):
    protected(os.path.dirname(file),True);check(digest(read(file))==expected,'Registration pointer changed')
    temporary=os.path.join(os.path.dirname(file),'.vorteo-registration-'+p['generation'])
    create(temporary,data)
    check(digest(read(file))==expected,'Registration pointer changed before commit')
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
check(digest(json.dumps(p,separators=(',',':'),ensure_ascii=False).encode())==request['planSha256'],'Reviewed native plan digest differs')
check(os.getuid()==0 and sys.platform=='linux','Declared privileged Linux capability unavailable')
check(p['requiredCapability']=='reviewed-dev-root-registration-and-parent-observation-v1','Privileged capability differs')
check({'aarch64':'arm64','x86_64':'x64'}.get(platform.machine())==p['linuxArtifact']['arch'],'Linux artifact architecture differs')
check(os.path.realpath(sys.executable)==p['systemPython']['path'],'System Python identity differs');pin(p['systemPython'],True)
account=pwd.getpwnam(p['account']['user']);check((account.pw_uid,account.pw_gid,account.pw_dir)==(p['account']['uid'],p['account']['gid'],p['account']['home']),'Numeric Dev account differs')
check(process(p['parent']['pid'])==p['parent'],'Native parent precondition differs')
if operation=='replace': check(process(p['supervisor']['pid'])==p['supervisor'],'Native supervisor precondition differs')
for file in p['startupFiles']: pin(file,True)
protected(p['supervisorSocket']);check(stat.S_ISSOCK(os.lstat(p['supervisorSocket']).st_mode),'Supervisord socket differs')
check(p['destination']=='/opt/vorteo-persistent-registration/'+p['generation'],'Protected destination differs')
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
    create(p['destination']+'/attempt.json',json.dumps(dict(planSha256=request['planSha256'],jobId=p['jobId'],phase='prepared'),separators=(',',':')).encode(),0o600)
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
    retained=json.loads(read(p['destination']+'/attempt.json',65536));check(retained['planSha256']==request['planSha256'],'Rollback attempt differs')
    create(p['destination']+'/rollback-attempt.json',json.dumps(dict(jobId=request['jobId'],planSha256=request['planSha256'])).encode(),0o600)
    expected=digest(p['pointerContent'].encode());pointer=original
check(process(p['parent']['pid'])==p['parent'],'Native parent changed before service effect')
server=xmlrpc.client.ServerProxy('http://localhost/RPC2',transport=UnixTransport(),allow_none=True)
service=server.supervisor.getProcessInfo('paseo');stopped=process(service['pid'])
check(stopped['parentPid']==p['parent']['pid'] and stopped['uid']==p['account']['uid'],'Supervisord program custody differs')
if operation=='replace': check(stopped==p['supervisor'],'Registered supervisor changed before stop')
else: check(stopped['executable']==p['protectedNode'],'Rollback supervisor differs from protected candidate')
server.supervisor.stopProcess('paseo',True)
try:
    current=process(stopped['pid'])
    check(current['startIdentity']!=stopped['startIdentity'] or current['bootId']!=stopped['bootId'],'Previous supervisor remains present')
except FileNotFoundError: pass
check(process(p['parent']['pid'])==p['parent'],'Native parent changed before pointer selection')
atomic(p['originalPointer']['path'],expected,pointer)
server.supervisor.startProcess('paseo',True)
check(read(p['originalPointer']['path'])==pointer,'Registration selection changed after startup')
result=dict(planSha256=request['planSha256'],operation=operation,phase='started-unverified',jobId=request['jobId'],scriptSha256=request['scriptSha256'])
create(p['nativeReceiptFile'] if operation=='replace' else p['destination']+'/rollback-result.json',json.dumps(result,separators=(',',':')).encode(),0o600)
print(json.dumps(result,separators=(',',':')))
`;
