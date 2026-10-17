import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, test, vi } from "vitest";
// Use current source schemas without rebuilding shared declarations.
vi.mock(
  "@getpaseo/protocol/execution-installation",
  () => import("../../../../../protocol/src/execution-installation.js"),
);
import { SupervisorEffectSchema } from "@getpaseo/protocol/execution-installation";
import {
  DevRegistrationProvisionerInputSchema,
  prepareDevRegistrationProvisioner,
  devRegistrationLinuxArtifactDigest,
} from "./dev-registration-provisioner.js";
import {
  DEV_REGISTRATION_NATIVE_OBSERVATION_SCRIPT,
  collectDevRegistrationNativeObservation,
  type DevRegistrationNativeObservationInvocation,
  type DevRegistrationNativeObservationInput,
  type DevRegistrationNativeObservationPorts,
} from "./dev-registration-native-observation.js";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const FACTORY_ENTRY =
  "const candidate = '/fixture/factory-candidate';\nvoid [candidate + '/modules/factory/launch.py', '/fixture/linux-node/bin/node', '/fixture/bootstrap/packages/server/dist/scripts/supervisor-entrypoint.js', candidate + '/runtime.mjs'];\n";
const FACTORY_LAUNCHER =
  "def launch(options):\n    for path in [options.supervisor_entry]:\n        if path == options.node:\n            pass\n        else:\n            physical(path)\n";
function staticInput() {
  const file = (path: string, content: string) => ({
    path,
    content,
    sha256: hash(content),
    size: Buffer.byteLength(content),
  });
  const linuxArtifact = {
    algorithm: "vorteo-container-artifact-v1",
    platform: "linux",
    arch: "arm64",
    root: "/opt/vorteo-managed-releases/prepared-linux",
    sourceCommit: "2".repeat(40),
    artifactSha256: "3".repeat(64),
    entries: [
      { kind: "directory", path: "", mode: 0o40755 },
      { kind: "directory", path: "packages", mode: 0o40755 },
      { kind: "directory", path: "packages/server", mode: 0o40755 },
      { kind: "directory", path: "packages/server/dist", mode: 0o40755 },
      { kind: "directory", path: "packages/server/dist/scripts", mode: 0o40755 },
      {
        kind: "file",
        path: "packages/server/dist/scripts/supervisor-entrypoint.js",
        mode: 0o100644,
        sha256: hash("fixture supervisor"),
        size: 18,
      },
      { kind: "directory", path: "packages/server/dist/server", mode: 0o40755 },
      { kind: "directory", path: "packages/server/dist/server/server", mode: 0o40755 },
      {
        kind: "file",
        path: "packages/server/dist/server/server/daemon-worker.js",
        mode: 0o100644,
        sha256: hash("fixture worker"),
        size: 14,
      },
    ],
  };
  linuxArtifact.artifactSha256 = devRegistrationLinuxArtifactDigest(linuxArtifact);
  const parent = {
    pid: 7,
    parentPid: 1,
    uid: 0,
    gid: 0,
    bootId: "fixture-boot",
    startIdentity: "5113560",
    executable: "/usr/bin/python3.11",
    argumentsSha256: "4".repeat(64),
  };
  return DevRegistrationProvisionerInputSchema.parse({
    installationId: "a3ed817e-d9f4-40c4-8409-5948c4d6b35c",
    preparationNonce: "2fd5c9ab-e74a-4cd1-98fe-47715955740a",
    hostInspector: {
      path: "/host/audited-inspector.py",
      sha256: hash("fixture read-only inspector"),
      size: Buffer.byteLength("fixture read-only inspector"),
    },
    configurationFile: "/host/coordinator.json",
    hostReceiptFile: "/host/dev-registration.json",
    docker: { path: "/host/docker", socket: "/host/docker.sock", containerId: "5".repeat(64) },
    startup: {
      path: "/usr/bin/tini",
      args: ["--", "/bin/bash", "/opt/personal-tailscale/entrypoint"],
      entrypoint: ["/usr/bin/tini", "--", "/bin/bash", "/opt/personal-tailscale/entrypoint"],
      cmd: null,
    },
    account: {
      user: "paseo",
      uid: 1000,
      gid: 1000,
      home: "/home/paseo",
      stateDirectory: "/home/paseo/.paseo",
    },
    requiredCapability: "reviewed-dev-root-registration-and-parent-observation-v1",
    systemPython: { path: "/usr/bin/python3.11", sha256: "6".repeat(64), size: 100 },
    node: {
      path: "/fixture/linux-node/bin/node",
      sha256: "7".repeat(64),
      size: 200,
      platform: "linux",
      arch: "arm64",
    },
    supervisor: {
      ...parent,
      pid: 101,
      parentPid: 7,
      uid: 1000,
      gid: 1000,
      executable: "/fixture/linux-node/bin/node",
      startIdentity: "132361430",
    },
    parent,
    startupFiles: [
      "/opt/personal-tailscale/entrypoint",
      "/etc/personal-tailscale/supervisord.conf",
      "/opt/personal-tailscale/start-paseo",
      "/usr/local/bin/paseo-docker-entrypoint",
    ].map((path) => ({ path, sha256: "8".repeat(64), size: 100 })),
    originalPointer: file("/etc/paseo-server-entry", "/fixture/bootstrap/factory-main-entry.mjs\n"),
    factoryEntry: file("/fixture/bootstrap/factory-main-entry.mjs", FACTORY_ENTRY),
    factoryLauncher: file("/fixture/factory-candidate/modules/factory/launch.py", FACTORY_LAUNCHER),
    originalSupervisorEntrypoint:
      "/fixture/bootstrap/packages/server/dist/scripts/supervisor-entrypoint.js",
    originalFactoryRuntime: "/fixture/factory-candidate/runtime.mjs",
    selectionPath: "/opt/vorteo-managed-releases/current",
    releaseRoot: "/opt/vorteo-managed-releases",
    linuxArtifact,
    originalLinuxArtifact: { ...linuxArtifact, root: "/fixture/bootstrap" },
    factoryRuntime: {
      path: "/fixture/factory-candidate/runtime.mjs",
      sha256: "9".repeat(64),
      size: 100,
    },
  });
}

function observationInput(
  operation: "replace" | "rollback" = "replace",
): DevRegistrationNativeObservationInput {
  const source = staticInput();
  source.systemPython = { path: source.systemPython.path, sha256: hash("python"), size: 6 };
  const provisioner = prepareDevRegistrationProvisioner(source);
  const executor = {
    pid: 501,
    parentPid: 500,
    uid: 501,
    bootId: "host-boot",
    startIdentity: "1:2",
    argumentsSha256: "a".repeat(64),
    auditToken: [0, 501, 0, 0, 0, 501, 0, 1],
    executable: { path: "/host/node", sha256: "b".repeat(64) },
    entrypoint: { path: "/host/controller", sha256: "c".repeat(64) },
    artifactSha256: "d".repeat(64),
  };
  const script = operation === "replace" ? provisioner : provisioner.rollback;
  const binding = {
    requestId: randomUUID(),
    requestRevision: randomUUID(),
    approvedAt: "2026-10-17T00:00:00.000Z",
    decisionSha256: "a".repeat(64),
    requestPlanSha256: "b".repeat(64),
    supervisorPlanSha256: script.sha256,
    registrationPlanSha256: provisioner.planSha256,
    operation,
    preparationNonce: source.preparationNonce,
    original:
      operation === "replace" ? null : { requestId: randomUUID(), claimSha256: "e".repeat(64) },
    generation: randomUUID(),
    candidateSha256: "c".repeat(64),
    grantId: randomUUID(),
    grantRevision: randomUUID(),
    manifestSha256: "d".repeat(64),
    stepId: randomUUID(),
    activationGeneration: randomUUID(),
    sourceCommit: source.linuxArtifact.sourceCommit,
    artifactSha256: source.linuxArtifact.artifactSha256,
    nativeIdentitySha256: "a".repeat(64),
    preconditionSha256: "b".repeat(64),
    settlementSha256: "c".repeat(64),
    controller: executor,
  };
  const reservedAt = "2026-10-17T00:00:01.000Z";
  const effect = SupervisorEffectSchema.parse({
    phase: "consumed",
    binding,
    reservedAt,
    consumedAt: "2026-10-17T00:00:02.000Z",
    child: {
      reservationSha256: hash(JSON.stringify({ binding, reservedAt })),
      executor: { ...executor, pid: 502, parentPid: 501, auditToken: [0, 501, 0, 0, 0, 502, 0, 1] },
      acknowledgedAt: "2026-10-17T00:00:01.500Z",
    },
  });
  return {
    provisioner,
    effect,
    container: {
      containerId: source.docker.containerId,
      startup: source.startup,
      writableMounts: ["/workspace"],
      assertCurrent() {},
    },
  };
}

/** Evaluate only Python function definitions against an in-memory kernel/filesystem.
 * No native program, root probe, /proc read, Docker call or service is run. */
function evaluate(invocation: DevRegistrationNativeObservationInvocation, scenario = "absent") {
  return execFileSync(
    "python3",
    [
      "-I",
      "-c",
      String.raw`
import ast,json,sys,types,io,hashlib,base64,stat,posixpath,uuid
payload=json.load(sys.stdin);request=json.loads(payload['input']);p=request['plan'];mode=payload['scenario'];events=[]
encode=lambda value:json.dumps(value,separators=(',',':'),ensure_ascii=False).encode()
claim=request['claim'];b=claim['binding'];op=b['operation'];destination=p['destination']
root=dict(pid=999,parentPid=1,uid=0,gid=0,bootId=p['parent']['bootId'],startIdentity='9222',executable=p['systemPython']['path'],argumentsSha256='a'*64)
witness=dict(planSha256=request['planSha256'],claimSha256=request['claimSha256'],jobId=b['requestId'],phase='prepared',scriptSha256=b['supervisorPlanSha256'],rootExecutor=root)
if op=='rollback': witness=dict(jobId=b['requestId'],planSha256=request['planSha256'],claimSha256=request['claimSha256'],originalClaimSha256=b['original']['claimSha256'],operation='rollback',scriptSha256=b['supervisorPlanSha256'],rootExecutor=root)
witness_path=destination+('/attempt.json' if op=='replace' else '/rollback-attempt.json')
result_path=p['nativeReceiptFile'] if op=='replace' else destination+'/rollback-result.json'
result=dict(planSha256=request['planSha256'],claimSha256=request['claimSha256'],operation=op,phase='started-unverified',jobId=b['requestId'],scriptSha256=b['supervisorPlanSha256'],rootExecutor=root)
if mode=='legacy-rollback': del witness['rootExecutor']
if mode=='wrong-job': witness['jobId']='other'
if mode=='wrong-script': witness['scriptSha256']='f'*64
if mode=='wrong-operation': witness['operation']='replace'
if mode=='wrong-root-uid': root['uid']=1000
if mode=='wrong-root-python': root['executable']='/other/python'
if mode=='wrong-root-boot': root['bootId']='other'
if mode=='bad-root-argv': root['argumentsSha256']='bad'
if mode=='bad-root-parent': root['parentPid']=False
files={witness_path:encode(witness),result_path:encode(result),p['systemPython']['path']:b'python',p['originalPointer']['path']:b'observed pointer',p['protectedNode']:b'observed copied node',p['supervisorEntrypoint']:b'observed supervisor'}
for item in p['files']: files[item['path']]=b'observed Factory bytes'
if mode=='missing-witness': del files[witness_path]
if mode=='missing-outcome': del files[result_path]
if mode=='bad-json': files[witness_path]=b'not-json'
if mode=='duplicate-key': files[witness_path]=files[witness_path][:-1]+b',"jobId":"duplicate"}'
if mode=='outcome-other-claim': result['claimSha256']='f'*64;files[result_path]=encode(result)
metadata={}
for index,(file,data) in enumerate(files.items()):
    metadata[file]=dict(st_dev=1,st_ino=2**60+index,st_mode=stat.S_IFREG|0o600,st_uid=0,st_gid=0,st_nlink=1,st_size=len(data),st_mtime_ns=1,st_ctime_ns=1)
    parent=posixpath.dirname(file)
    while parent not in metadata:
        metadata[parent]=dict(st_dev=1,st_ino=2**60+len(metadata),st_mode=stat.S_IFDIR|0o755,st_uid=0,st_gid=0,st_nlink=1,st_size=0,st_mtime_ns=1,st_ctime_ns=1)
        if parent=='/': break
        parent=posixpath.dirname(parent)
fds={};counter=[0];proc_reads=[0];crossed=[False]
def lstat(file):
    events.append('stat:'+file)
    if file not in metadata: raise FileNotFoundError(file)
    return types.SimpleNamespace(**metadata[file])
def open_fd(file,flags):
    events.append('open:'+file)
    if file not in files: raise FileNotFoundError(file)
    if mode=='denied-witness' and file==witness_path: raise PermissionError(file)
    counter[0]+=1;fds[counter[0]]=[file,0];return counter[0]
def read_fd(fd,size):
    file,offset=fds[fd];events.append('read:'+file)
    data=files[file][offset:offset+size];fds[fd][1]+=len(data)
    if mode=='witness-inode-race' and file==witness_path: metadata[file]['st_ino']+=1
    return data
def realpath(file):
    if mode=='ancestor-race' and proc_reads[0] and file==destination: return '/moved'
    return file
def native_open(file,*args):
    events.append('native:'+file)
    if file=='/proc/sys/kernel/random/boot_id':
        boot=p['parent']['bootId']
        if mode=='crossboot' or crossed[0]: boot='other-boot'
        return io.StringIO(boot)
    if file!='/proc/999/stat': raise RuntimeError('Unplanned native read '+file)
    proc_reads[0]+=1
    if mode=='root-denied': raise PermissionError(file)
    if mode=='crossboot-after-enoent': crossed[0]=True;raise FileNotFoundError(file)
    if mode not in ('alive','zombie','reused','stat-race','bad-stat','ancestor-race','witness-bytes-race'): raise FileNotFoundError(file)
    if mode=='bad-stat': return io.StringIO('malformed')
    if mode=='witness-bytes-race':
        changed=dict(witness);changed['jobId']='changed';files[witness_path]=encode(changed)
    fields=['S','1']+['0']*18;fields[19]='9333'
    if mode in ('alive','zombie'): fields[19]='9222';fields[0]='Z' if mode=='zombie' else 'S'
    if mode=='stat-race' and proc_reads[0]>1: fields[19]='9444'
    return io.StringIO('999 (root) '+' '.join(fields))
namespace=dict(request=request,p=p,deadline=100,retained={},records={},time=types.SimpleNamespace(monotonic=lambda:0),stat=stat,json=json,hashlib=hashlib,base64=base64,uuid=uuid,pwd=types.SimpleNamespace(getpwnam=lambda _:types.SimpleNamespace(pw_name=p['account']['user'],pw_uid=p['account']['uid'],pw_gid=p['account']['gid'],pw_dir=p['account']['home'])),platform=types.SimpleNamespace(machine=lambda:'aarch64'),sys=types.SimpleNamespace(platform='linux',executable=p['systemPython']['path']),open=native_open)
namespace['os']=types.SimpleNamespace(path=types.SimpleNamespace(realpath=realpath,dirname=posixpath.dirname),lstat=lstat,open=open_fd,fstat=lambda fd:lstat(fds[fd][0]),read=read_fd,close=lambda fd:fds.pop(fd),getuid=lambda:0,geteuid=lambda:0,getgid=lambda:0,getegid=lambda:0,O_RDONLY=0,O_NOFOLLOW=1,O_NONBLOCK=2)
tree=ast.parse(payload['program']);functions=[node for node in tree.body if isinstance(node,ast.FunctionDef)]
exec(compile(ast.Module(body=functions,type_ignores=[]),'<source-unit>','exec'),namespace)
def observed_parent(pid):
    events.append('parent:'+str(pid));return dict(p['parent'])
namespace['process']=observed_parent
try: result=namespace['collect']()
except Exception as error: result=dict(kind='unresolved',reason=type(error).__name__+': '+str(error))
print(json.dumps(dict(facts=result,events=events)))
`,
    ],
    {
      input: JSON.stringify({ input: invocation.input, program: invocation.program, scenario }),
      encoding: "utf8",
    },
  );
}
function inertPorts(scenario = "absent") {
  let lastInvocation: DevRegistrationNativeObservationInvocation | null = null;
  let clock = 0;
  const ports: DevRegistrationNativeObservationPorts = {
    async read(invocation) {
      lastInvocation = invocation;
      return JSON.stringify(JSON.parse(evaluate(invocation, scenario)).facts);
    },
    readSync(invocation) {
      return JSON.stringify(JSON.parse(evaluate(invocation, scenario)).facts);
    },
    now() {
      return clock;
    },
  };
  return {
    ports,
    getInvocation() {
      if (!lastInvocation) throw Error("No source invocation");
      return lastInvocation;
    },
    setClock(value: number) {
      clock = value;
    },
  };
}

for (const operation of ["replace", "rollback"] as const) {
  test(`${operation} collector returns only actual root-exit and protected target facts`, async () => {
    const input = observationInput(operation),
      f = inertPorts();
    const proof = await collectDevRegistrationNativeObservation(input, f.ports);
    expect(proof.facts.kind).toBe("root-exited");
    expect(proof.facts).not.toHaveProperty("settled");
    expect(proof.facts).not.toHaveProperty("ready");
    expect(proof.assertCurrent()).toBeUndefined();
    if (proof.facts.kind === "root-exited") {
      expect(proof.facts.rootExit.evidence).toBe("absent");
      expect(proof.facts.targets[0].sha256).toBe(hash("observed pointer"));
      expect(proof.facts.witness.identity[1]).toMatch(/^115292150460684/);
    }
  });
}
for (const scenario of [
  "alive",
  "zombie",
  "root-denied",
  "crossboot",
  "crossboot-after-enoent",
  "stat-race",
  "bad-stat",
  "missing-witness",
  "bad-json",
  "duplicate-key",
  "wrong-job",
  "wrong-script",
  "wrong-root-uid",
  "wrong-root-python",
  "wrong-root-boot",
  "bad-root-argv",
  "bad-root-parent",
  "witness-inode-race",
  "ancestor-race",
  "witness-bytes-race",
  "denied-witness",
  "missing-outcome",
  "outcome-other-claim",
]) {
  test(`${scenario} remains unresolved, never an exit/settlement assertion`, async () => {
    const f = inertPorts(scenario),
      proof = await collectDevRegistrationNativeObservation(observationInput(), f.ports);
    expect(proof.facts.kind).toBe("unresolved");
  });
}

test("same-boot PID reuse proves only the original root lifetime ended", async () => {
  const f = inertPorts("reused");
  const proof = await collectDevRegistrationNativeObservation(observationInput(), f.ports);
  expect(proof.facts.kind).toBe("root-exited");
  if (proof.facts.kind === "root-exited")
    expect(proof.facts.rootExit).toMatchObject({ evidence: "reused", observedBirth: "9333" });
  expect(JSON.stringify(proof.facts)).not.toMatch(/settled|ready/);
});

test("old rollback witnesses remain unresolved and are never retrofitted", async () => {
  const f = inertPorts("legacy-rollback");
  const proof = await collectDevRegistrationNativeObservation(
    observationInput("rollback"),
    f.ports,
  );
  expect(proof.facts.kind).toBe("unresolved");
  const events = JSON.parse(evaluate(f.getInvocation(), "legacy-rollback")).events;
  expect(events.some((event: string) => event.startsWith("write:"))).toBe(false);
});

test("witness inode and ancestry precede its authoritative bytes; exit precedes target/outcome reads", async () => {
  const input = observationInput(),
    f = inertPorts();
  await collectDevRegistrationNativeObservation(input, f.ports);
  const { events } = JSON.parse(evaluate(f.getInvocation()));
  const witness = input.provisioner.plan.destination + "/attempt.json";
  expect(events.indexOf("stat:" + witness)).toBeLessThan(events.indexOf("read:" + witness));
  expect(events.indexOf("stat:" + input.provisioner.plan.destination)).toBeLessThan(
    events.indexOf("read:" + witness),
  );
  const rootRead = events.indexOf("native:/proc/999/stat");
  expect(events.indexOf("native:/proc/sys/kernel/random/boot_id")).toBeLessThan(rootRead);
  expect(rootRead).toBeLessThan(events.indexOf("read:" + input.provisioner.plan.nativeReceiptFile));
  expect(rootRead).toBeLessThan(
    events.indexOf("read:" + input.provisioner.plan.originalPointer.path),
  );
});

for (const scenario of ["alive", "root-denied", "crossboot-after-enoent", "bad-stat"]) {
  test(`${scenario} cannot read mutable outcome or targets`, async () => {
    const f = inertPorts(scenario),
      input = observationInput();
    await collectDevRegistrationNativeObservation(input, f.ports);
    const { events } = JSON.parse(evaluate(f.getInvocation(), scenario));
    expect(events).not.toContain("read:" + input.provisioner.plan.nativeReceiptFile);
    expect(events).not.toContain("read:" + input.provisioner.plan.originalPointer.path);
  });
}

test("the fixed observer contains no writer or service/executable operation", () => {
  const result = execFileSync(
    "python3",
    [
      "-I",
      "-c",
      String.raw`
import ast,sys,json
module=ast.parse(sys.stdin.read());forbidden={'create','atomic','sync_dir','stopProcess','startProcess','exec','execve','system','Popen','write','mkdir','chmod','chown','replace','unlink','symlink','kill'}
for node in ast.walk(module):
    if isinstance(node,ast.Call):
        name=node.func.attr if isinstance(node.func,ast.Attribute) else node.func.id if isinstance(node.func,ast.Name) else ''
        if name in forbidden: raise RuntimeError('Observer contains effect '+name)
print('read-only')
`,
    ],
    { input: DEV_REGISTRATION_NATIVE_OBSERVATION_SCRIPT, encoding: "utf8" },
  );
  expect(result.trim()).toBe("read-only");
});

for (const phase of ["before", "after", "recheck"]) {
  test(`callback/data substitution ${phase} refuses`, async () => {
    const input = observationInput(),
      f = inertPorts();
    if (phase === "before")
      input.container.assertCurrent = () => {
        input.effect.binding.requestId = randomUUID();
      };
    if (phase === "after") {
      const read = f.ports.read;
      f.ports.read = async (invocation) => {
        const out = await read(invocation);
        input.container.assertCurrent = () => {};
        return out;
      };
    }
    if (phase === "recheck") {
      const proof = await collectDevRegistrationNativeObservation(input, f.ports);
      input.container.assertCurrent = () => {};
      expect(() => proof.assertCurrent()).toThrow("callbacks changed");
      return;
    }
    await expect(collectDevRegistrationNativeObservation(input, f.ports)).rejects.toThrow(
      /changed/,
    );
  });
}

test("proof data mutation during a native recheck cannot become authority", async () => {
  const input = observationInput(),
    f = inertPorts();
  let mutate = () => {};
  const original = f.ports.readSync;
  f.ports.readSync = (invocation) => {
    const out = original(invocation);
    mutate();
    return out;
  };
  const proof = await collectDevRegistrationNativeObservation(input, f.ports);
  mutate = () => {
    proof.facts = { kind: "unresolved", reason: "substituted" };
  };
  expect(() => proof.assertCurrent()).toThrow("facts changed");
});

test("mutated fixed invocation is rejected", async () => {
  const input = observationInput(),
    f = inertPorts();
  const read = f.ports.read;
  f.ports.read = async (invocation) => {
    const result = await read(invocation);
    invocation.program = "different";
    return result;
  };
  await expect(collectDevRegistrationNativeObservation(input, f.ports)).rejects.toThrow(
    "invocation changed",
  );
});

test("revocation does not require new authority to read the consumed claim", async () => {
  const input = observationInput(),
    f = inertPorts();
  const proof = await collectDevRegistrationNativeObservation(input, f.ports);
  // The collector has no enrollment/grant-current check or lifecycle mutator.
  expect(proof.facts.kind).toBe("root-exited");
  expect(proof.assertCurrent()).toBeUndefined();
});

test("expired evidence refuses before a synchronous call", async () => {
  const f = inertPorts();
  const proof = await collectDevRegistrationNativeObservation(observationInput(), f.ports);
  f.setClock(30000);
  expect(() => proof.assertCurrent()).toThrow("expired");
});

test("native recheck checks the total budget after returning", async () => {
  const f = inertPorts();
  const sync = f.ports.readSync;
  f.ports.readSync = (invocation) => {
    const out = sync(invocation);
    f.setClock(12000);
    return out;
  };
  const proof = await collectDevRegistrationNativeObservation(observationInput(), f.ports);
  expect(() => proof.assertCurrent()).toThrow("budget");
});

for (const mount of ["/usr", "/opt"]) {
  test(`a Host-observed writable mount over ${mount} prevents authoritative collection`, async () => {
    const input = observationInput();
    input.container.writableMounts = [mount];
    const f = inertPorts();
    const proof = await collectDevRegistrationNativeObservation(input, f.ports);
    expect(proof.facts.kind).toBe("unresolved");
  });
}

for (const field of [
  "witness binding",
  "target address",
  "runtime",
  "ancestry",
  "inconsistent exit",
]) {
  test(`rejects substituted native ${field}`, async () => {
    const input = observationInput(),
      f = inertPorts(),
      original = f.ports.read;
    f.ports.read = async (invocation) => {
      const data = JSON.parse(await original(invocation));
      if (field === "witness binding") data.witness.record.jobId = "other";
      if (field === "target address") data.targets[0].path = "/unrelated";
      if (field === "runtime") data.runtime.python.sha256 = "f".repeat(64);
      if (field === "ancestry") data.ancestry = [];
      if (field === "inconsistent exit")
        data.rootExit.observedBirth = data.rootExit.rootExecutor.startIdentity;
      return JSON.stringify(data);
    };
    await expect(collectDevRegistrationNativeObservation(input, f.ports)).rejects.toThrow();
  });
}

test("retained custody changes during the final native recheck refuse", async () => {
  const input = observationInput(),
    f = inertPorts();
  let scenario = "absent";
  f.ports.readSync = (invocation) =>
    JSON.stringify(JSON.parse(evaluate(invocation, scenario)).facts);
  const proof = await collectDevRegistrationNativeObservation(input, f.ports);
  scenario = "ancestor-race";
  expect(() => proof.assertCurrent()).toThrow("facts changed");
});

test("a custody callback cannot replace itself while returning", async () => {
  const input = observationInput(),
    f = inertPorts();
  input.container.assertCurrent = () => {
    input.container.assertCurrent = () => {};
  };
  await expect(collectDevRegistrationNativeObservation(input, f.ports)).rejects.toThrow(
    "after custody check",
  );
});

test("native recheck cannot replace the retained port", async () => {
  const input = observationInput(),
    f = inertPorts(),
    original = f.ports.readSync;
  f.ports.readSync = (invocation) => {
    const out = original(invocation);
    f.ports.readSync = original;
    return out;
  };
  const proof = await collectDevRegistrationNativeObservation(input, f.ports);
  expect(() => proof.assertCurrent()).toThrow("callbacks changed");
});
