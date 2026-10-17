import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import {
  DevRegistrationProvisionerInputSchema,
  DEV_REGISTRATION_PROVISIONING_SCRIPT,
  devRegistrationLinuxArtifactDigest,
  prepareDevRegistrationProvisioner,
} from "./dev-registration-provisioner.js";

// Startup-source fixtures preserve the inspected control flow with isolated
// paths. They are not installed registration evidence.
const FACTORY_ENTRY =
  "import { readFileSync, lstatSync, realpathSync } from 'node:fs';\n\n// Retains the installed Factory controller and authority during the daemon update.\n// execve preserves the supervisor PID and its original service environment.\nconst candidate = '/fixture/factory-candidate';\nconst stateRoot = '/fixture/factory-state';\nconst settingsPath = stateRoot + '/factory-settings.json';\nconst stat = lstatSync(settingsPath);\nif (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || realpathSync(settingsPath) !== settingsPath)\n  throw new Error('Unsafe Factory settings');\nconst settings = JSON.parse(readFileSync(settingsPath, 'utf8'));\nif (settings.mainHostHome !== '/home/paseo/.paseo' || process.env.PASEO_HOME !== settings.mainHostHome)\n  throw new Error('Factory main-host home differs from the reviewed installation');\nprocess.env.PASEO_HOST_FILESYSTEM = readFileSync('/fixture/host-filesystem.json', 'utf8').trim();\nprocess.env.PATH = '/fixture/toolchain/node_modules/.bin:' + process.env.PATH;\nprocess.env.PASEO_MANAGED_RELEASE_ROOT = '/opt/vorteo-managed-releases';\nprocess.env.PASEO_MANAGED_RELEASE_LINK = '/opt/vorteo-managed-releases/current';\nif (typeof process.execve !== 'function') throw new Error('Host Node lacks execve');\nprocess.execve('/usr/bin/python3', [\n  '/usr/bin/python3', candidate + '/modules/factory/launch.py',\n  '--state-root', stateRoot,\n  '--paseo-home', settings.mainHostHome,\n  '--node', '/fixture/linux-node/bin/node',\n  '--supervisor-entry', '/fixture/bootstrap/packages/server/dist/scripts/supervisor-entrypoint.js',\n  '--runtime-module', candidate + '/runtime.mjs',\n  '--', ...process.argv.slice(2),\n], process.env);\n";
const FACTORY_LAUNCHER =
  '"""Hold container-local controller ownership across the existing Paseo supervisor."""\n\nimport argparse\nimport ctypes\nimport fcntl\nimport json\nimport os\nimport stat\nimport sys\nimport uuid\n\n\ndef physical(path, directory=False):\n    metadata = os.lstat(path)\n    expected = stat.S_ISDIR if directory else stat.S_ISREG\n    if (not os.path.isabs(path) or os.path.realpath(path) != path\n            or not expected(metadata.st_mode) or metadata.st_uid != os.getuid()\n            or metadata.st_mode & 0o022):\n        raise RuntimeError("Factory paths must be physical and owner controlled")\n    return metadata\n\n\ndef read_record(root, name):\n    try:\n        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)\n    except FileNotFoundError:\n        return None\n    with os.fdopen(descriptor) as stream:\n        metadata = os.fstat(stream.fileno())\n        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()\n                or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_nlink != 1\n                or metadata.st_size > 16384):\n            raise RuntimeError("Unsafe Factory ownership record")\n        return json.load(stream)\n\n\ndef write_record(root, name, value):\n    temporary = ".ownership-" + uuid.uuid4().hex\n    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL\n                         | os.O_NOFOLLOW, 0o600, dir_fd=root)\n    try:\n        with os.fdopen(descriptor, "w") as stream:\n            json.dump(value, stream)\n            stream.flush()\n            os.fsync(stream.fileno())\n        os.rename(temporary, name, src_dir_fd=root, dst_dir_fd=root)\n        os.fsync(root)\n    finally:\n        try:\n            os.unlink(temporary, dir_fd=root)\n        except FileNotFoundError:\n            pass\n\n\ndef launch(options):\n    if sys.platform != "linux":\n        raise RuntimeError("This launcher runs inside the Linux container")\n    if options.initialize_only and not options.initialize:\n        raise RuntimeError("Initialization-only mode requires --initialize")\n    root_info = physical(options.state_root, directory=True)\n    if stat.S_IMODE(root_info.st_mode) != 0o700:\n        raise RuntimeError("Factory state directory must have mode 0700")\n    if options.paseo_home is not None:\n        # Explicit host integration only. Never derive another host\'s registry\n        # from a project ID or silently change the dedicated-host default.\n        physical(options.paseo_home, directory=True)\n    # Do not silently put locking authority on the Mac-shared FUSE mount.\n    # Linux statfs begins with f_type; oversized storage accommodates its struct.\n    filesystem = (ctypes.c_long * 32)()\n    libc = ctypes.CDLL(None, use_errno=True)\n    if libc.statfs(os.fsencode(options.state_root), ctypes.byref(filesystem)) != 0:\n        raise OSError(ctypes.get_errno(), "Cannot inspect Factory filesystem")\n    if filesystem[0] & 0xffffffff not in (0x794c7630, 0xef53, 0x58465342, 0x9123683e):\n        raise RuntimeError("Factory active state requires a supported local filesystem")\n    for path in (options.node, options.supervisor_entry, options.runtime_module):\n        # System Node may be root-owned; its reviewed executable is selected by\n        # the trusted operator, while controller code remains owner controlled.\n        if path == options.node:\n            info = os.lstat(path)\n            if (not os.path.isabs(path) or os.path.realpath(path) != path\n                    or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022\n                    or info.st_uid not in (0, os.getuid())\n                    or not os.access(path, os.X_OK)):\n                raise RuntimeError("Factory Node executable is unsafe")\n        else:\n            physical(path)\n    root = os.open(options.state_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)\n    opened_root = os.fstat(root)\n    if (opened_root.st_dev, opened_root.st_ino) != (root_info.st_dev, root_info.st_ino):\n        raise RuntimeError("Factory state directory changed during startup")\n    lock = os.open("controller.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,\n                   0o600, dir_fd=root)\n    metadata = os.fstat(lock)\n    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()\n            or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_nlink != 1):\n        raise RuntimeError("Unsafe Factory controller lock")\n    try:\n        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)\n    except BlockingIOError:\n        raise RuntimeError("Another Factory controller owns this installation") from None\n    # The permanent lock inode is never replaced or removed. Its descriptor is\n    # shared by the trusted supervisor and daemon. Coding workers never inherit\n    # it. Neither trusted holder may explicitly unlock the shared description.\n    os.fsync(root)\n    previous = read_record(root, "controller.json")\n    if previous is None:\n        if not options.initialize:\n            raise RuntimeError("Factory installation identity is missing; recovery required")\n        if set(os.listdir(root)) != {"controller.lock"}:\n            raise RuntimeError("Refusing to initialize nonempty Factory state")\n        installation = {"version": 1, "installationId": str(uuid.uuid4())}\n        epoch = 0\n    elif options.initialize:\n        raise RuntimeError("Factory is already initialized; launch without --initialize")\n    else:\n        fields = {"version", "installationId", "epoch", "token", "supervisorPid",\n                  "lockDevice", "lockInode"}\n        if (not isinstance(previous, dict) or set(previous) != fields\n                or type(previous["version"]) is not int or previous["version"] != 1\n                or any(type(previous[key]) is not int or previous[key] < 1\n                       for key in ("epoch", "supervisorPid", "lockInode"))\n                or type(previous["lockDevice"]) is not int\n                or any(not isinstance(previous[key], str)\n                       or str(uuid.UUID(previous[key])) != previous[key]\n                       for key in ("installationId", "token"))):\n            raise RuntimeError("Invalid Factory ownership history")\n        if (previous["lockDevice"], previous["lockInode"]) != (metadata.st_dev, metadata.st_ino):\n            raise RuntimeError("Factory controller lock was replaced; recovery required")\n        installation = {key: previous[key] for key in ("version", "installationId")}\n        epoch = previous["epoch"]\n    # Identity and epoch share one atomic record: losing ownership history must\n    # never look like a legitimate first launch of an existing installation.\n    ownership = {**installation, "epoch": epoch + 1, "token": str(uuid.uuid4()),\n                 "supervisorPid": os.getpid(), "lockDevice": metadata.st_dev,\n                 "lockInode": metadata.st_ino}\n    write_record(root, "controller.json", ownership)\n    if options.initialize_only:\n        # Installation prepares the private daemon config after establishing\n        # identity, before starting any provider connection or scheduler.\n        os.close(lock)\n        os.close(root)\n        return\n    os.set_inheritable(lock, True)\n    os.close(root)\n    environment = {**os.environ, "PASEO_HOME": options.paseo_home or os.path.join(options.state_root, "paseo"),\n                   "PASEO_GOVERNED_RUNTIME_MODULE": options.runtime_module,\n                   "VORTON_FACTORY_STATE_ROOT": options.state_root,\n                   "VORTON_FACTORY_OWNER_TOKEN": ownership["token"],\n                   "VORTON_FACTORY_LOCK_FD": str(lock),\n                   "PASEO_CONTROLLER_LIFETIME_FD": str(lock)}\n    # No worker or claim starts here. The runtime must reconcile retained\n    # execution receipts before dispatch, including after successful lock recovery.\n    os.execve(options.node, [options.node, options.supervisor_entry, *options.arguments], environment)\n\n\ndef main():\n    parser = argparse.ArgumentParser(description=__doc__)\n    parser.add_argument("--state-root", required=True)\n    parser.add_argument("--node", required=True)\n    parser.add_argument("--supervisor-entry", required=True)\n    parser.add_argument("--runtime-module", required=True)\n    parser.add_argument("--paseo-home", help="Explicit existing host home for reviewed host integration")\n    parser.add_argument("--initialize", action="store_true")\n    parser.add_argument("--initialize-only", action="store_true")\n    parser.add_argument("arguments", nargs=argparse.REMAINDER)\n    options = parser.parse_args()\n    if options.arguments[:1] == ["--"]:\n        options.arguments = options.arguments[1:]\n    launch(options)\n\n\nif __name__ == "__main__":\n    try:\n        main()\n    except Exception as error:\n        print(str(error), file=sys.stderr)\n        sys.exit(1)\n';
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
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

test("prepares exact copied Factory startup files and an independently bound rollback", () => {
  const input = fixture();
  const prepared = prepareDevRegistrationProvisioner(input);
  expect(prepared.sha256).toBe(hash(prepared.script));
  expect(prepared.rollback.sha256).toBe(hash(prepared.rollback.script));
  expect(prepared.planSha256).toBe(hash(JSON.stringify(prepared.plan)));
  expect(prepared.plan.destination).toBe(
    "/opt/vorteo-persistent-registration/" + input.preparationNonce,
  );
  expect(prepared.plan.files.map((file) => file.path)).toEqual([
    prepared.plan.destination + "/factory-main-entry.mjs",
    prepared.plan.destination + "/factory-launch.py",
  ]);
  expect(prepared.plan.originalPointer).toEqual(input.originalPointer);
  expect(prepared.plan.linuxArtifact).toEqual(input.linuxArtifact);
});

test("preserves Factory runtime, controller ownership and execve environment while relocating static code", () => {
  const prepared = prepareDevRegistrationProvisioner(fixture());
  const entry = Buffer.from(prepared.plan.files[0].contentBase64, "base64").toString();
  const launcher = Buffer.from(prepared.plan.files[1].contentBase64, "base64").toString();
  expect(entry).toContain("'--runtime-module', candidate + '/runtime.mjs'");
  expect(entry).toContain("const stateRoot = '/fixture/factory-state'");
  expect(entry).toContain(
    "process.env.PASEO_MANAGED_RELEASE_LINK = '/opt/vorteo-managed-releases/current'",
  );
  expect(entry).toContain(JSON.stringify(prepared.plan.destination + "/factory-launch.py"));
  expect(entry).toContain(JSON.stringify(prepared.plan.protectedNode));
  expect(entry).toContain(JSON.stringify(prepared.plan.supervisorEntrypoint));
  const physical = FACTORY_LAUNCHER.slice(
    FACTORY_LAUNCHER.indexOf("def physical("),
    FACTORY_LAUNCHER.indexOf("def read_record("),
  );
  expect(launcher).toContain(physical);
  const custody = FACTORY_LAUNCHER.slice(FACTORY_LAUNCHER.indexOf("    root = os.open("));
  expect(launcher).toContain(custody);
  expect(launcher).toContain(
    "elif path == options.supervisor_entry:\n            protected_supervisor(path)\n        else:\n            physical(path)",
  );
});

test.each(["missing", "darwin", "architecture", "omitted dependency", "changed dependency"])(
  "refuses %s Linux closure",
  (kind) => {
    const input = fixture();
    switch (kind) {
      case "missing":
        expect(() =>
          prepareDevRegistrationProvisioner({ ...input, linuxArtifact: undefined }),
        ).toThrow();
        return;
      case "darwin":
        expect(() =>
          prepareDevRegistrationProvisioner({
            ...input,
            linuxArtifact: { ...input.linuxArtifact, platform: "darwin" },
          }),
        ).toThrow();
        return;
      case "architecture":
        input.node.arch = "x64";
        break;
      case "omitted dependency":
        input.linuxArtifact.entries.pop();
        break;
      case "changed dependency":
        input.linuxArtifact.entries[1] = { kind: "directory", path: "packages", mode: 0o40700 };
        break;
    }
    expect(() => prepareDevRegistrationProvisioner(input)).toThrow();
  },
);

test.each(["duplicate", "external link", "missing parent", "writable file", "reordered"])(
  "rejects %s manifest",
  (kind) => {
    const input = fixture();
    switch (kind) {
      case "duplicate":
        input.linuxArtifact.entries.push(input.linuxArtifact.entries[0]);
        break;
      case "external link":
        input.linuxArtifact.entries.push({ kind: "link", path: "z-alias", target: "/etc/passwd" });
        break;
      case "missing parent":
        input.linuxArtifact.entries.splice(1, 1);
        break;
      case "writable file":
        input.linuxArtifact.entries[1] = { kind: "directory", path: "packages", mode: 0o40777 };
        break;
      case "reordered":
        input.linuxArtifact.entries.reverse();
        break;
    }
    expect(() => devRegistrationLinuxArtifactDigest(input.linuxArtifact)).toThrow();
  },
);

test("rejects source substitution, incompatible Factory source and an unbound rollback", () => {
  const input = fixture();
  expect(() =>
    prepareDevRegistrationProvisioner({
      ...input,
      factoryEntry: { ...input.factoryEntry, content: FACTORY_ENTRY + "\n" },
    }),
  ).toThrow("startup bytes differ");
  const other = FACTORY_ENTRY.replace(
    "candidate + '/modules/factory/launch.py'",
    "candidate + '/different.py'",
  );
  expect(() =>
    prepareDevRegistrationProvisioner({
      ...input,
      factoryEntry: {
        ...input.factoryEntry,
        content: other,
        sha256: hash(other),
        size: Buffer.byteLength(other),
      },
    }),
  ).toThrow("reviewed handoff");
  expect(() =>
    prepareDevRegistrationProvisioner({
      ...input,
      activation: { manifestSha256: "0".repeat(64) },
    }),
  ).toThrow();
});

test("rejects redirected Factory runtime and wrong native parent", () => {
  const input = fixture();
  expect(() =>
    prepareDevRegistrationProvisioner({ ...input, originalFactoryRuntime: "/other/runtime.mjs" }),
  ).toThrow("runtime binding differs");
  expect(() =>
    prepareDevRegistrationProvisioner({ ...input, parent: { ...input.parent, uid: 1000 } }),
  ).toThrow("process precondition differs");
});

test("generated programs pass static syntax checks without performing native operations", () => {
  const prepared = prepareDevRegistrationProvisioner(fixture());
  expect(
    execFileSync(process.execPath, ["--check", "--input-type=module"], {
      input: prepared.script,
      encoding: "utf8",
    }),
  ).toBe("");
  expect(
    execFileSync(process.execPath, ["--check", "--input-type=module"], {
      input: prepared.rollback.script,
      encoding: "utf8",
    }),
  ).toBe("");
  expect(
    execFileSync("python3", ["-I", "-c", "import ast,sys; ast.parse(sys.stdin.read())"], {
      input: DEV_REGISTRATION_PROVISIONING_SCRIPT,
      encoding: "utf8",
    }),
  ).toBe("");
});

// Execute only extracted predicates against supplied data. The full native
// program and real /proc, service and root filesystem are never executed.
function rollbackPredicate(
  value: ReturnType<typeof stoppedRollbackFixture> & { observation?: string },
): string {
  return execFileSync(
    "python3",
    [
      "-I",
      "-c",
      String.raw`
import ast,sys,json,hashlib,io,types
data=json.load(sys.stdin)
names={'service_snapshot','assert_rollback_records','assert_stopped_rollback','assert_native_absence','atomic','assert_original_root_exited'}
tree=ast.parse(data['source'])
module=ast.Module(body=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names],type_ignores=[])
def check(ok,reason):
    if not ok: raise RuntimeError(reason)
def missing(path): raise FileNotFoundError(path)
def denied(path): raise PermissionError(path)
observation=data.get('observation','empty')
fields=['S','7']+['0']*17+['132361430']
if data['action']=='original-root': fields[19]=data['attempt']['rootExecutor']['startIdentity'] if observation in ('same-root','zombie-root') else 'reused'
if observation=='zombie-root': fields[0]='Z'
if observation in ('candidate','original','reused','exe-denied'): fields[1]='1'
if observation in ('candidate','reused','exe-denied'): fields[19]='999'
files={'/proc/101/stat':'101 (fixture) '+' '.join(fields),'/proc/101/status':'Uid:\t1000\t1000\t1000\t1000\n','/proc/999/stat':'999 (root fixture) '+' '.join(fields),'/proc/sys/kernel/random/boot_id':'fixture-boot'}
def fake_open(path):
    if observation=='denied': return denied(path)
    if observation=='gone': return missing(path)
    return io.StringIO(files[path])
def fake_readlink(path):
    if observation=='exe-denied': return denied(path)
    if observation=='candidate': return data['plan']['protectedNode']
    return missing(path)
namespace=dict(check=check,p=data['plan'],request={'planSha256':data['planSha256'],'originalClaimSha256':data['originalClaimSha256']},original_binding={'requestId':data['originalJobId'],'supervisorPlanSha256':data['originalScriptSha256']},digest=lambda b:hashlib.sha256(b).hexdigest(),os=types.SimpleNamespace(listdir=lambda path:[] if observation=='empty' else ['101'],readlink=fake_readlink),open=fake_open)
exec(compile(module,'isolated-rollback-predicates','exec'),namespace)
try:
    if data['action']=='original-root': namespace['assert_original_root_exited'](data['attempt'])
    elif data['action']=='atomic':
        contents={'pointer':b'candidate'};metadata={'pointer':(1,2,3)};effects=[]
        if observation=='changed-bytes': contents['pointer']=b'unrelated'
        if observation=='changed-inode': metadata['pointer']=(9,9,9)
        def create(file,content):
            effects.append('temporary');contents[file]=content
            if observation=='raced': metadata['pointer']=(8,8,8)
        def replace(source,target): effects.append('replace');contents[target]=contents[source]
        namespace.update(protected=lambda file,*args:None,read=lambda file:contents[file],identity=lambda value:value,create=create,sync_dir=lambda directory:None,os=types.SimpleNamespace(lstat=lambda file:metadata[file],replace=replace,path=__import__('posixpath')))
        namespace['atomic']('pointer',hashlib.sha256(b'candidate').hexdigest(),b'original',[1,2,3])
        check(contents['pointer']==b'original' and effects==['temporary','replace'],'Unexpected pointer effects')
    elif data['action']=='control':
        effects=[]
        class Supervisor:
            def getProcessInfo(self,name):
                value=dict(data['service'])
                if observation=='service-changed' and effects: value['state']=20
                return value
            def stopProcess(self,*args): raise RuntimeError('Stopped branch attempted stop')
        def process(pid):
            check(pid==data['plan']['parent']['pid'],'Stopped branch attempted candidate process inspection')
            return data['plan']['parent']
        def absence(): effects.append('absence')
        def record(file):
            if file.endswith('/attempt.json'): return data['attempt']
            return data['selection']
        namespace.update(assert_original_root_exited=lambda attempt:None,operation='rollback',server=types.SimpleNamespace(supervisor=Supervisor()),retained=data['attempt'],selection=data['selection'],stopped_outcome=lambda:data['outcome'],process=process,protected_record=record,assert_native_absence=absence)
        nodes=[];active=False
        for node in tree.body:
            if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='service' for target in node.targets): active=True
            if active and isinstance(node,ast.Expr) and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Name) and node.value.func.id=='atomic': break
            if active: nodes.append(node)
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'isolated-stopped-control','exec'),namespace)
        check(effects==['absence','absence'],'Absence was not independently rechecked')
    elif data['action']=='absence': namespace['assert_native_absence']()
    else:
        namespace['service_snapshot'](data['service'])
        namespace['assert_stopped_rollback'](data['service'],data['attempt'],data['selection'],data['outcome'])
    print('accepted')
except Exception as error: print(type(error).__name__+': '+str(error))
`,
    ],
    {
      input: JSON.stringify({ source: DEV_REGISTRATION_PROVISIONING_SCRIPT, ...value }),
      encoding: "utf8",
    },
  ).trim();
}

function stoppedRollbackFixture() {
  const prepared = prepareDevRegistrationProvisioner(fixture());
  const scriptSha256 = prepared.sha256;
  const originalJobId = "726d3128-c864-4cce-a975-59d0d336c962",
    originalClaimSha256 = "a".repeat(64);
  const rootExecutor = {
    pid: 999,
    parentPid: 1,
    uid: 0,
    gid: 0,
    bootId: "fixture-boot",
    startIdentity: "999",
    executable: prepared.plan.systemPython.path,
    argumentsSha256: "b".repeat(64),
  };
  return {
    action: "stopped",
    plan: prepared.plan,
    planSha256: prepared.planSha256,
    originalScriptSha256: scriptSha256,
    originalJobId,
    originalClaimSha256,
    service: {
      name: "paseo",
      group: "paseo",
      pid: 0,
      state: 200,
      start: 10,
      stop: 11,
      exitstatus: 1,
      spawnerr: "failed",
    },
    attempt: {
      planSha256: prepared.planSha256,
      jobId: originalJobId,
      phase: "prepared",
      rootExecutor,
      claimSha256: originalClaimSha256,
      scriptSha256,
    },
    selection: {
      planSha256: prepared.planSha256,
      jobId: originalJobId,
      claimSha256: originalClaimSha256,
      parent: prepared.plan.parent,
      pointerSha256: hash(prepared.plan.pointerContent),
      pointerIdentity: [1, 2, 3],
      scriptSha256,
    },
    outcome: {
      planSha256: prepared.planSha256,
      operation: "replace",
      phase: "start-failed",
      rootExecutor,
      claimSha256: originalClaimSha256,
      jobId: originalJobId,
      scriptSha256,
    },
  };
}

test.each([0, 100, 200])("accepts exact stopped rollback records in terminal state %s", (state) => {
  const value = stoppedRollbackFixture();
  value.service.state = state;
  expect(rollbackPredicate(value)).toBe("accepted");
  value.outcome.phase = "started-unverified";
  expect(rollbackPredicate(value)).toBe("accepted");
});

test.each(["pid", "state", "service", "attempt", "selection", "parent", "outcome", "script"])(
  "rejects changed stopped rollback %s",
  (change) => {
    const value = stoppedRollbackFixture();
    switch (change) {
      case "pid":
        value.service.pid = 999;
        break;
      case "state":
        value.service.state = 30;
        break;
      case "service":
        value.service.name = "unrelated";
        break;
      case "attempt":
        value.attempt.jobId = "47b74dfc-5c91-4b7c-bd7b-ebfbe1757848";
        break;
      case "selection":
        value.selection.pointerSha256 = "0".repeat(64);
        break;
      case "parent":
        value.selection.parent = { ...value.selection.parent, startIdentity: "999" };
        break;
      case "outcome":
        value.outcome.phase = "ready";
        break;
      case "script":
        value.outcome.scriptSha256 = "0".repeat(64);
        break;
    }
    expect(rollbackPredicate(value)).not.toBe("accepted");
  },
);

test.each([
  ["empty", "accepted"],
  ["gone", "accepted"],
  ["present", "RuntimeError: A Dev service child remains present"],
  ["denied", "PermissionError: /proc/101/stat"],
  ["exe-denied", "PermissionError: /proc/101/exe"],
  ["candidate", "RuntimeError: A protected candidate process remains present"],
  ["original", "RuntimeError: Original supervisor lifetime remains present"],
  ["reused", "accepted"],
])(
  "native absence predicate handles %s without treating observation failure as absence",
  (observation, expected) => {
    expect(rollbackPredicate({ ...stoppedRollbackFixture(), action: "absence", observation })).toBe(
      expected,
    );
  },
);

test.each([
  ["empty", "accepted"],
  ["changed-bytes", "RuntimeError: Registration pointer changed"],
  ["changed-inode", "RuntimeError: Retained registration pointer identity changed"],
  ["raced", "RuntimeError: Registration pointer changed before commit"],
])("pointer restoration refuses unrelated %s changes", (observation, expected) => {
  expect(rollbackPredicate({ ...stoppedRollbackFixture(), action: "atomic", observation })).toBe(
    expected,
  );
});

test.each([
  ["empty", "accepted"],
  ["service-changed", "RuntimeError: Stopped service changed before rollback"],
])(
  "stopped control flow checks %s without inspecting PID zero or stopping a missing candidate",
  (observation, expected) => {
    expect(rollbackPredicate({ ...stoppedRollbackFixture(), action: "control", observation })).toBe(
      expected,
    );
  },
);

test("static preparation rejects future authority and leaves scripts independent of enrollment", () => {
  const input = fixture(),
    prepared = prepareDevRegistrationProvisioner(input);
  expect(prepared.plan).not.toHaveProperty("jobId");
  expect(prepared.plan).not.toHaveProperty("activation");
  expect(prepared.plan).not.toHaveProperty("rollback");
  expect(prepared.plan).not.toHaveProperty("generation");
  expect(() =>
    prepareDevRegistrationProvisioner({ ...input, jobId: "726d3128-c864-4cce-a975-59d0d336c962" }),
  ).toThrow();
  expect(prepareDevRegistrationProvisioner(input)).toEqual(prepared);
});

test.each([
  ["gone", "accepted"],
  ["reused-root", "accepted"],
  ["same-root", "RuntimeError: Original root executor remains present"],
  ["zombie-root", "RuntimeError: Original root executor remains present"],
  ["denied", "PermissionError: /proc/999/stat"],
])(
  "rollback root settlement observes %s without using the Host parent as proof",
  (observation, expected) => {
    expect(
      rollbackPredicate({ ...stoppedRollbackFixture(), action: "original-root", observation }),
    ).toBe(expected);
  },
);
