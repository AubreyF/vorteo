import { createHash, randomUUID } from "node:crypto";
import { hashSync } from "bcryptjs";
import { verifyBootstrapConfiguration } from "../coordinator-bootstrap-host.js";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { afterEach, expect, test } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";
import { CoordinatorBootstrapPlanSchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { InstallationConfigSchema } from "../config.js";
import {
  digestBootstrapArtifact,
  verifyBootstrapReleaseArtifacts,
} from "../coordinator-bootstrap-artifact.js";
import { inspectDevRegistrationConfiguration } from "../coordinator-bootstrap-dev-registration-configuration.js";
import {
  DevRegistrationProvisionerInputSchema,
  DEV_REGISTRATION_PROVISIONING_SCRIPT,
  DEV_REGISTRATION_GATE_PREFIX,
  devRegistrationLinuxArtifactDigest,
  prepareDevRegistrationProvisioner,
  verifyRetainedDevRegistrationProvisioner,
  devRegistrationC1Receipt,
  prepareDevRegistrationC1Documents,
  verifyDevRegistrationC1Script,
} from "./dev-registration-provisioner.js";

// Startup-source fixtures preserve the inspected control flow with isolated
// paths. They are not installed registration evidence.
const FACTORY_ENTRY =
  "import { readFileSync, lstatSync, realpathSync } from 'node:fs';\n\n// Retains the installed Factory controller and authority during the daemon update.\n// execve preserves the supervisor PID and its original service environment.\nconst candidate = '/fixture/factory-candidate';\nconst stateRoot = '/fixture/factory-state';\nconst settingsPath = stateRoot + '/factory-settings.json';\nconst stat = lstatSync(settingsPath);\nif (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || realpathSync(settingsPath) !== settingsPath)\n  throw new Error('Unsafe Factory settings');\nconst settings = JSON.parse(readFileSync(settingsPath, 'utf8'));\nif (settings.mainHostHome !== '/home/paseo/.paseo' || process.env.PASEO_HOME !== settings.mainHostHome)\n  throw new Error('Factory main-host home differs from the reviewed installation');\nprocess.env.PASEO_HOST_FILESYSTEM = readFileSync('/fixture/host-filesystem.json', 'utf8').trim();\nprocess.env.PATH = '/fixture/toolchain/node_modules/.bin:' + process.env.PATH;\nprocess.env.PASEO_MANAGED_RELEASE_ROOT = '/opt/vorteo-managed-releases';\nprocess.env.PASEO_MANAGED_RELEASE_LINK = '/opt/vorteo-managed-releases/current';\nif (typeof process.execve !== 'function') throw new Error('Host Node lacks execve');\nprocess.execve('/usr/bin/python3', [\n  '/usr/bin/python3', candidate + '/modules/factory/launch.py',\n  '--state-root', stateRoot,\n  '--paseo-home', settings.mainHostHome,\n  '--node', '/fixture/linux-node/bin/node',\n  '--supervisor-entry', '/fixture/bootstrap/packages/server/dist/scripts/supervisor-entrypoint.js',\n  '--runtime-module', candidate + '/runtime.mjs',\n  '--', ...process.argv.slice(2),\n], process.env);\n";
const FACTORY_LAUNCHER =
  '"""Hold container-local controller ownership across the existing Paseo supervisor."""\n\nimport argparse\nimport ctypes\nimport fcntl\nimport json\nimport os\nimport stat\nimport sys\nimport uuid\n\n\ndef physical(path, directory=False):\n    metadata = os.lstat(path)\n    expected = stat.S_ISDIR if directory else stat.S_ISREG\n    if (not os.path.isabs(path) or os.path.realpath(path) != path\n            or not expected(metadata.st_mode) or metadata.st_uid != os.getuid()\n            or metadata.st_mode & 0o022):\n        raise RuntimeError("Factory paths must be physical and owner controlled")\n    return metadata\n\n\ndef read_record(root, name):\n    try:\n        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)\n    except FileNotFoundError:\n        return None\n    with os.fdopen(descriptor) as stream:\n        metadata = os.fstat(stream.fileno())\n        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()\n                or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_nlink != 1\n                or metadata.st_size > 16384):\n            raise RuntimeError("Unsafe Factory ownership record")\n        return json.load(stream)\n\n\ndef write_record(root, name, value):\n    temporary = ".ownership-" + uuid.uuid4().hex\n    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL\n                         | os.O_NOFOLLOW, 0o600, dir_fd=root)\n    try:\n        with os.fdopen(descriptor, "w") as stream:\n            json.dump(value, stream)\n            stream.flush()\n            os.fsync(stream.fileno())\n        os.rename(temporary, name, src_dir_fd=root, dst_dir_fd=root)\n        os.fsync(root)\n    finally:\n        try:\n            os.unlink(temporary, dir_fd=root)\n        except FileNotFoundError:\n            pass\n\n\ndef launch(options):\n    if sys.platform != "linux":\n        raise RuntimeError("This launcher runs inside the Linux container")\n    if options.initialize_only and not options.initialize:\n        raise RuntimeError("Initialization-only mode requires --initialize")\n    root_info = physical(options.state_root, directory=True)\n    if stat.S_IMODE(root_info.st_mode) != 0o700:\n        raise RuntimeError("Factory state directory must have mode 0700")\n    if options.paseo_home is not None:\n        # Explicit host integration only. Never derive another host\'s registry\n        # from a project ID or silently change the dedicated-host default.\n        physical(options.paseo_home, directory=True)\n    # Do not silently put locking authority on the Mac-shared FUSE mount.\n    # Linux statfs begins with f_type; oversized storage accommodates its struct.\n    filesystem = (ctypes.c_long * 32)()\n    libc = ctypes.CDLL(None, use_errno=True)\n    if libc.statfs(os.fsencode(options.state_root), ctypes.byref(filesystem)) != 0:\n        raise OSError(ctypes.get_errno(), "Cannot inspect Factory filesystem")\n    if filesystem[0] & 0xffffffff not in (0x794c7630, 0xef53, 0x58465342, 0x9123683e):\n        raise RuntimeError("Factory active state requires a supported local filesystem")\n    for path in (options.node, options.supervisor_entry, options.runtime_module):\n        # System Node may be root-owned; its reviewed executable is selected by\n        # the trusted operator, while controller code remains owner controlled.\n        if path == options.node:\n            info = os.lstat(path)\n            if (not os.path.isabs(path) or os.path.realpath(path) != path\n                    or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022\n                    or info.st_uid not in (0, os.getuid())\n                    or not os.access(path, os.X_OK)):\n                raise RuntimeError("Factory Node executable is unsafe")\n        else:\n            physical(path)\n    root = os.open(options.state_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)\n    opened_root = os.fstat(root)\n    if (opened_root.st_dev, opened_root.st_ino) != (root_info.st_dev, root_info.st_ino):\n        raise RuntimeError("Factory state directory changed during startup")\n    lock = os.open("controller.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,\n                   0o600, dir_fd=root)\n    metadata = os.fstat(lock)\n    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()\n            or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_nlink != 1):\n        raise RuntimeError("Unsafe Factory controller lock")\n    try:\n        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)\n    except BlockingIOError:\n        raise RuntimeError("Another Factory controller owns this installation") from None\n    # The permanent lock inode is never replaced or removed. Its descriptor is\n    # shared by the trusted supervisor and daemon. Coding workers never inherit\n    # it. Neither trusted holder may explicitly unlock the shared description.\n    os.fsync(root)\n    previous = read_record(root, "controller.json")\n    if previous is None:\n        if not options.initialize:\n            raise RuntimeError("Factory installation identity is missing; recovery required")\n        if set(os.listdir(root)) != {"controller.lock"}:\n            raise RuntimeError("Refusing to initialize nonempty Factory state")\n        installation = {"version": 1, "installationId": str(uuid.uuid4())}\n        epoch = 0\n    elif options.initialize:\n        raise RuntimeError("Factory is already initialized; launch without --initialize")\n    else:\n        fields = {"version", "installationId", "epoch", "token", "supervisorPid",\n                  "lockDevice", "lockInode"}\n        if (not isinstance(previous, dict) or set(previous) != fields\n                or type(previous["version"]) is not int or previous["version"] != 1\n                or any(type(previous[key]) is not int or previous[key] < 1\n                       for key in ("epoch", "supervisorPid", "lockInode"))\n                or type(previous["lockDevice"]) is not int\n                or any(not isinstance(previous[key], str)\n                       or str(uuid.UUID(previous[key])) != previous[key]\n                       for key in ("installationId", "token"))):\n            raise RuntimeError("Invalid Factory ownership history")\n        if (previous["lockDevice"], previous["lockInode"]) != (metadata.st_dev, metadata.st_ino):\n            raise RuntimeError("Factory controller lock was replaced; recovery required")\n        installation = {key: previous[key] for key in ("version", "installationId")}\n        epoch = previous["epoch"]\n    # Identity and epoch share one atomic record: losing ownership history must\n    # never look like a legitimate first launch of an existing installation.\n    ownership = {**installation, "epoch": epoch + 1, "token": str(uuid.uuid4()),\n                 "supervisorPid": os.getpid(), "lockDevice": metadata.st_dev,\n                 "lockInode": metadata.st_ino}\n    write_record(root, "controller.json", ownership)\n    if options.initialize_only:\n        # Installation prepares the private daemon config after establishing\n        # identity, before starting any provider connection or scheduler.\n        os.close(lock)\n        os.close(root)\n        return\n    os.set_inheritable(lock, True)\n    os.close(root)\n    environment = {**os.environ, "PASEO_HOME": options.paseo_home or os.nodePath.join(options.state_root, "paseo"),\n                   "PASEO_GOVERNED_RUNTIME_MODULE": options.runtime_module,\n                   "VORTON_FACTORY_STATE_ROOT": options.state_root,\n                   "VORTON_FACTORY_OWNER_TOKEN": ownership["token"],\n                   "VORTON_FACTORY_LOCK_FD": str(lock),\n                   "PASEO_CONTROLLER_LIFETIME_FD": str(lock)}\n    # No worker or claim starts here. The runtime must reconcile retained\n    # execution receipts before dispatch, including after successful lock recovery.\n    os.execve(options.node, [options.node, options.supervisor_entry, *options.arguments], environment)\n\n\ndef main():\n    parser = argparse.ArgumentParser(description=__doc__)\n    parser.add_argument("--state-root", required=True)\n    parser.add_argument("--node", required=True)\n    parser.add_argument("--supervisor-entry", required=True)\n    parser.add_argument("--runtime-module", required=True)\n    parser.add_argument("--paseo-home", help="Explicit existing host home for reviewed host integration")\n    parser.add_argument("--initialize", action="store_true")\n    parser.add_argument("--initialize-only", action="store_true")\n    parser.add_argument("arguments", nargs=argparse.REMAINDER)\n    options = parser.parse_args()\n    if options.arguments[:1] == ["--"]:\n        options.arguments = options.arguments[1:]\n    launch(options)\n\n\nif __name__ == "__main__":\n    try:\n        main()\n    except Exception as error:\n        print(str(error), file=sys.stderr)\n        sys.exit(1)\n';
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
    docker: {
      path: "/host/docker",
      socket: "/host/docker.sock",
      containerId: "5".repeat(64),
      sha256: hash("reviewed Docker fixture"),
      size: 23,
    },
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

test.each([
  "valid",
  "empty",
  "extra",
  "read-error",
  "missing-eof",
  "invalid-token",
  "second-read-error",
])("fixed registration gate handles %s before any authority load", (mode) => {
  const calls: string[] = [];
  let reads = 0;
  const source = DEV_REGISTRATION_GATE_PREFIX.replace(/^import .*;\n/gm, "") + "body();";
  const execute = () =>
    runInNewContext(source, {
      fs: {
        readSync(fd: number, bytes: Uint8Array, offset: number, length: number, position: null) {
          expect([fd, offset, length, position]).toEqual([3, 0, 1, null]);
          calls.push("read");
          reads++;
          if (mode === "read-error") throw Error("EIO");
          if (mode === "empty") return 0;
          if (reads === 1) {
            bytes[offset] = mode === "invalid-token" ? 2 : 1;
            return 1;
          }
          if (mode === "missing-eof") throw Error("EAGAIN");
          if (mode === "second-read-error") throw Error("EIO");
          return mode === "extra" ? 1 : 0;
        },
        closeSync(fd: number) {
          expect(fd).toBe(3);
          calls.push("close");
        },
      },
      body() {
        calls.push("body");
      },
    });
  if (mode === "valid") {
    expect(execute).not.toThrow();
    expect(calls).toEqual(["read", "read", "close", "body"]);
  } else {
    expect(execute).toThrow();
    expect(calls.at(-1)).toBe("close");
    expect(calls).not.toContain("body");
  }
});
test("both prepared scripts bind the fixed gate into the whole reviewed buffer before enrollment", () => {
  const prepared = prepareDevRegistrationProvisioner(fixture());
  expect(prepared.script.startsWith(DEV_REGISTRATION_GATE_PREFIX)).toBe(true);
  expect(prepared.rollback.script.startsWith(DEV_REGISTRATION_GATE_PREFIX)).toBe(true);
  expect(hash(prepared.script)).toBe(prepared.sha256);
  expect(hash(prepared.rollback.script)).toBe(prepared.rollback.sha256);
  expect(prepared.script.indexOf("const reviewed=")).toBeGreaterThan(
    DEV_REGISTRATION_GATE_PREFIX.length - 1,
  );
});

for (const operation of ["replace", "rollback"] as const) {
  test(`${operation} writes an exact root lifetime witness before service and pointer effects`, () => {
    const prepared = prepareDevRegistrationProvisioner(fixture());
    const request = {
      jobId: "read-only-unit-job",
      planSha256: prepared.planSha256,
      claimSha256: "a".repeat(64),
      originalClaimSha256: "b".repeat(64),
      scriptSha256: operation === "replace" ? prepared.sha256 : prepared.rollback.sha256,
    };
    const rootExecutor = {
      pid: 999,
      parentPid: 1,
      uid: 0,
      gid: 0,
      bootId: "same-boot",
      startIdentity: "123",
      executable: prepared.plan.systemPython.path,
      argumentsSha256: "c".repeat(64),
    };
    const result = JSON.parse(
      execFileSync(
        "python3",
        [
          "-I",
          "-c",
          String.raw`
import ast,json,sys
value=json.load(sys.stdin);tree=ast.parse(value['source']);suffix='/attempt.json' if value['operation']=='replace' else '/rollback-attempt.json'
calls=[node for node in ast.walk(tree) if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='create' and isinstance(node.args[0],ast.BinOp) and isinstance(node.args[0].right,ast.Constant) and node.args[0].right.value==suffix]
assert len(calls)==1
call=calls[0]
namespace=dict(request=value['request'],root_executor=value['rootExecutor'],json=json)
# Evaluate only the pure bytes expression, never the native program or writer.
record=json.loads(eval(compile(ast.Expression(body=call.args[1]),'<witness-unit>','eval'),namespace))
effects=[node.lineno for node in ast.walk(tree) if isinstance(node,ast.Call) and ((isinstance(node.func,ast.Name) and node.func.id=='atomic') or (isinstance(node.func,ast.Attribute) and node.func.attr in ('stopProcess','startProcess')))]
assert all(call.lineno<line for line in effects)
print(json.dumps(record))
`,
        ],
        {
          input: JSON.stringify({
            source: DEV_REGISTRATION_PROVISIONING_SCRIPT,
            operation,
            request,
            rootExecutor,
          }),
          encoding: "utf8",
        },
      ),
    );
    expect(result.rootExecutor).toEqual(rootExecutor);
    expect(result.scriptSha256).toBe(request.scriptSha256);
    expect(result.claimSha256).toBe(request.claimSha256);
    expect(result.jobId).toBe(request.jobId);
    if (operation === "rollback") {
      expect(result.operation).toBe("rollback");
      expect(result.originalClaimSha256).toBe(request.originalClaimSha256);
    } else expect(result.phase).toBe("prepared");
  });
}

// Reconstruct the recorded v682 shape from inert fixture inputs only. The
// provisioner suite pins the entire historical postimage to its captured hash.
function v682Postimage(prepared: ReturnType<typeof prepareDevRegistrationProvisioner>) {
  const plan = structuredClone(prepared.plan);
  delete plan.docker.sha256;
  delete plan.docker.size;
  const planSha256 = hash(JSON.stringify(plan));
  function script(bytes: string, operation: "replace" | "rollback") {
    return bytes
      .replace(
        /^const reviewed=.*;$/m,
        () => "const reviewed=" + JSON.stringify({ plan, planSha256, operation }) + ";",
      )
      .replace(/function verifyDocker\(\)\{\n[\s\S]*?\n\}\n/, "")
      .replace(
        "const docker=args=>{verifyDocker();return execFileSync(",
        "const docker=args=>execFileSync(",
      )
      .replace("encoding:'utf8'});};", "encoding:'utf8'});")
      .replace("verifyDocker();\nconst result=", "const result=");
  }
  const replacement = script(prepared.script, "replace"),
    rollback = script(prepared.rollback.script, "rollback");
  return {
    plan,
    planSha256,
    script: replacement,
    sha256: hash(replacement),
    rollback: { script: rollback, sha256: hash(rollback) },
  };
}

test("Docker pin compatibility preserves the exact captured v682 full postimage", () => {
  const historical = v682Postimage(prepareDevRegistrationProvisioner(fixture()));
  expect(hash(JSON.stringify(historical))).toBe(
    "d94c6bffaf6513d36c37d6a405a94ef4d8e6a966689c92e8c49ad6ac0591fb1d",
  );
  const before = JSON.stringify(historical);
  expect(verifyRetainedDevRegistrationProvisioner(historical)).toBeUndefined();
  expect(JSON.stringify(historical)).toBe(before);
  expect(() =>
    prepareDevRegistrationProvisioner(
      DevRegistrationProvisionerInputSchema.strip().parse(historical.plan),
    ),
  ).toThrow();
  expect(() =>
    prepareDevRegistrationProvisioner(verifyRetainedDevRegistrationProvisioner(historical)),
  ).toThrow();
});

test.each(["plan", "replace", "rollback", "planHash", "replaceHash", "rollbackHash", "extra"])(
  "Docker pin historical verification refuses changed full postimage %s",
  (part) => {
    const historical = v682Postimage(prepareDevRegistrationProvisioner(fixture()));
    switch (part) {
      case "plan":
        historical.plan.startup.args.push("changed");
        break;
      case "replace":
        historical.script += "\n";
        historical.sha256 = hash(historical.script);
        break;
      case "rollback":
        historical.rollback.script += "\n";
        historical.rollback.sha256 = hash(historical.rollback.script);
        break;
      case "planHash":
        historical.planSha256 = "0".repeat(64);
        break;
      case "replaceHash":
        historical.sha256 = "0".repeat(64);
        break;
      case "rollbackHash":
        historical.rollback.sha256 = "0".repeat(64);
        break;
      case "extra":
        Object.assign(historical, { extra: "not retained" });
        break;
    }
    expect(() => verifyRetainedDevRegistrationProvisioner(historical)).toThrow();
  },
);

test.each([
  { sha256: undefined, size: undefined },
  { sha256: undefined, size: 23 },
  { sha256: "a".repeat(64), size: undefined },
  { sha256: "not-sha256", size: 23 },
  { sha256: "a".repeat(64), size: 0 },
  { sha256: "a".repeat(64), size: 256 * 1024 * 1024 + 1 },
])("Docker pin new preparation refuses missing or invalid reviewed commitment %j", (pin) => {
  const input = fixture();
  expect(() =>
    prepareDevRegistrationProvisioner({ ...input, docker: { ...input.docker, ...pin } }),
  ).toThrow();
});

test("Docker pin historical parser accepts both absent without adding defaults, rejects partial", () => {
  const input = fixture();
  delete input.docker.sha256;
  delete input.docker.size;
  expect(DevRegistrationProvisionerInputSchema.parse(input).docker).toEqual(input.docker);
  expect(() =>
    DevRegistrationProvisionerInputSchema.parse({
      ...input,
      docker: { ...input.docker, size: 23 },
    }),
  ).toThrow();
});

test.each(["sha256", "size"])(
  "Docker pin %s changes static plan and both scripts before enrollment",
  (field) => {
    const input = fixture(),
      original = prepareDevRegistrationProvisioner(input);
    const changed = { ...input.docker, [field]: field === "size" ? 24 : "e".repeat(64) };
    const next = prepareDevRegistrationProvisioner({ ...input, docker: changed });
    expect(next.planSha256).not.toBe(original.planSha256);
    expect(next.sha256).not.toBe(original.sha256);
    expect(next.rollback.sha256).not.toBe(original.rollback.sha256);
    expect(verifyRetainedDevRegistrationProvisioner(next)).toBeUndefined();
    expect(next.plan.docker).toEqual(changed);
    expect(next.plan).not.toHaveProperty("manifestSha256");
  },
);

function c1Input() {
  const input = fixture();
  const [containerEntrypoint, supervisorConfiguration, profileLauncher, dockerEntrypoint] =
    input.startupFiles;
  return {
    ...input,
    configurationFile: "/host/c0.json",
    c1First: {
      format: "c1-first-v1" as const,
      configurationFiles: {
        original: "/host/p.json",
        replacement: "/host/c0.json",
        rollback: "/host/c0r.json",
        selected: "/host/c1.json",
      },
      preparedReceiptFile: "/host/prepared-receipt.json",
      scripts: {
        node: "/host/node",
        replacement: "/host/replace.mjs",
        rollback: "/host/rollback.mjs",
      },
      startupReceiptRoles: {
        containerEntrypoint,
        supervisorConfiguration,
        profileLauncher,
        dockerEntrypoint,
      },
    },
  };
}
test("C1 named receipt mappings and fixed operation paths precede script hashes", () => {
  const input = c1Input(),
    prepared = prepareDevRegistrationProvisioner(input),
    receipt = devRegistrationC1Receipt(prepared);
  expect(receipt.files.containerEntrypoint).toEqual({
    path: input.c1First.startupReceiptRoles.containerEntrypoint.path,
    sha256: input.c1First.startupReceiptRoles.containerEntrypoint.sha256,
  });
  expect(receipt.files.supervisorEntrypoint.path).toBe(prepared.plan.supervisorEntrypoint);
  expect(receipt.supervisorPlanSha256).toBe(prepared.sha256);
  expect(prepared.script).toContain("C1 selected projection differs");
  expect(prepared.rollback.script).toContain("operation==='replace'?'replacement':'rollback'");
  expect(prepared.plan).not.toHaveProperty("manifestSha256");
  expect(prepared.plan.c1First).not.toHaveProperty("configurationSha256");
  expect(() => verifyRetainedDevRegistrationProvisioner(prepared)).not.toThrow();
});
test.each(["role", "duplicate", "path", "parent"])(
  "C1 static %s substitution refuses preparation",
  (change) => {
    const input = c1Input();
    if (change === "role")
      input.c1First.startupReceiptRoles.profileLauncher = {
        ...input.c1First.startupReceiptRoles.profileLauncher,
        sha256: "f".repeat(64),
      };
    if (change === "duplicate")
      input.c1First.startupReceiptRoles.profileLauncher =
        input.c1First.startupReceiptRoles.dockerEntrypoint;
    if (change === "path") input.c1First.configurationFiles.selected = input.configurationFile;
    if (change === "parent") input.parent.executable = "/usr/bin/unreviewed-python";
    expect(() => prepareDevRegistrationProvisioner(input)).toThrow();
  },
);

function c1EnvelopeScript(
  prepared: ReturnType<typeof prepareDevRegistrationProvisioner>,
  change: (value: {
    plan: ReturnType<typeof prepareDevRegistrationProvisioner>["plan"];
    planSha256: string;
    operation: string;
  }) => unknown,
) {
  const reviewed = {
    plan: structuredClone(prepared.plan),
    planSha256: prepared.planSha256,
    operation: "replace",
  };
  return prepared.script.replace(
    /^const reviewed=.*;$/m,
    () => "const reviewed=" + JSON.stringify(change(reviewed)) + ";",
  );
}
test("C1 script verifier returns a fresh exact replacement without evaluating it", () => {
  const prepared = prepareDevRegistrationProvisioner(c1Input());
  const verified = verifyDevRegistrationC1Script(prepared.script);
  expect(verified).toEqual(prepared);
  expect(verified).not.toBe(prepared);
  verified.plan.account.uid++;
  expect(verifyDevRegistrationC1Script(prepared.script)).toEqual(prepared);
});
test.each(["historical-pinned", "historical-pinless", "rollback"])(
  "C1 script verifier rejects %s program",
  (kind) => {
    const prepared = prepareDevRegistrationProvisioner(c1Input());
    const historical = prepareDevRegistrationProvisioner(fixture());
    let script = historical.script;
    if (kind === "rollback") script = prepared.rollback.script;
    if (kind === "historical-pinless") script = v682Postimage(historical).script;
    expect(() => verifyDevRegistrationC1Script(script)).toThrow();
  },
);
test.each([
  "missing",
  "multiple",
  "malformed",
  "whitespace",
  "pretty",
  "duplicate-key",
  "escaped-key",
  "wrong-operation",
  "extra-envelope-key",
  "key-order",
])("C1 script verifier rejects %s envelope", (kind) => {
  const prepared = prepareDevRegistrationProvisioner(c1Input());
  const line = prepared.script.match(/^const reviewed=.*;$/m)![0];
  const raw = line.slice("const reviewed=".length, -1);
  let next = line;
  if (kind === "missing") next = "";
  if (kind === "multiple") next = line + "\n" + line;
  if (kind === "malformed") next = "const reviewed={;";
  if (kind === "whitespace") next = "const reviewed= " + raw + ";";
  if (kind === "pretty") next = "const reviewed=" + JSON.stringify(JSON.parse(raw), null, 2) + ";";
  if (kind === "duplicate-key")
    next = line.replace('"operation":"replace"', '"operation":"replace","operation":"replace"');
  if (kind === "escaped-key") next = line.replace('"plan":', '"\\u0070lan":');
  if (kind === "wrong-operation")
    next = line.replace('"operation":"replace"', '"operation":"rollback"');
  if (kind === "extra-envelope-key")
    next = "const reviewed=" + JSON.stringify({ ...JSON.parse(raw), extra: true }) + ";";
  if (kind === "key-order") {
    const value = JSON.parse(raw);
    next =
      "const reviewed=" +
      JSON.stringify({
        operation: value.operation,
        planSha256: value.planSha256,
        plan: value.plan,
      }) +
      ";";
  }
  expect(() => verifyDevRegistrationC1Script(prepared.script.replace(line, () => next))).toThrow();
});
test.each([
  "gate",
  "suffix",
  "digest",
  "derived-plan",
  "unknown-plan-field",
  "input-data",
  "pinless",
  "partial-pin",
])("C1 script verifier rejects altered %s", (kind) => {
  const prepared = prepareDevRegistrationProvisioner(c1Input());
  let script = prepared.script;
  if (kind === "gate")
    script = script.replace("registrationGateByte[0]!==1", "registrationGateByte[0]!==2");
  else if (kind === "suffix") script += "\nvoid 0;";
  else
    script = c1EnvelopeScript(prepared, (value) => {
      if (kind === "digest") value.planSha256 = "0".repeat(64);
      if (kind === "derived-plan") {
        value.plan.destination += "-unreviewed";
        value.planSha256 = hash(JSON.stringify(value.plan));
      }
      if (kind === "unknown-plan-field")
        return { ...value, plan: { ...value.plan, unreviewed: true } };
      if (kind === "input-data") value.plan.account.stateDirectory += "-unreviewed";
      if (kind === "pinless") {
        delete value.plan.docker.sha256;
        delete value.plan.docker.size;
        value.planSha256 = hash(JSON.stringify(value.plan));
      }
      if (kind === "partial-pin") delete value.plan.docker.sha256;
      return value;
    });
  expect(() => verifyDevRegistrationC1Script(script)).toThrow();
});
test.each(["a", "é"])("C1 script verifier enforces UTF-8 byte bounds for %s", (character) => {
  expect(() =>
    verifyDevRegistrationC1Script(character.repeat(character === "a" ? 1024 * 1024 + 1 : 600000)),
  ).toThrow("byte bound");
});
test("C1 script verifier never evaluates a candidate data expression or appended program", () => {
  const key = "c1-script-verifier-" + randomUUID();
  const prepared = prepareDevRegistrationProvisioner(c1Input());
  const expression =
    "const reviewed=(()=>{globalThis[" + JSON.stringify(key) + "]=true;return {};})();";
  expect(Reflect.has(globalThis, key)).toBe(false);
  try {
    expect(() =>
      verifyDevRegistrationC1Script(
        prepared.script.replace(/^const reviewed=.*;$/m, () => expression),
      ),
    ).toThrow();
    expect(() =>
      verifyDevRegistrationC1Script(
        prepared.script + "\nglobalThis[" + JSON.stringify(key) + "]=true;",
      ),
    ).toThrow();
    expect(Reflect.has(globalThis, key)).toBe(false);
  } finally {
    Reflect.deleteProperty(globalThis, key);
  }
});

// This fixture prepares inert files only. No bootstrap admission, native reader,
// Docker command, grant, registration publication or service is constructed.
const projectionRoots: string[] = [];
afterEach(() => {
  for (const root of projectionRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function configurationProjectionFixture(options: { bootstrapPolicy?: boolean } = {}) {
  // /tmp is normally writable by other accounts and cannot establish ancestry.
  const root = realpathSync(mkdtempSync(nodePath.join(homedir(), ".vorteo-c1-projection-")));
  projectionRoots.push(root);
  chmodSync(root, 0o700);
  const input = c1Input();
  const files = input.c1First.configurationFiles;
  for (const name of ["original", "replacement", "rollback", "selected"] as const)
    files[name] = nodePath.join(root, name + ".json");
  input.configurationFile = files.replacement;
  input.hostReceiptFile = nodePath.join(root, "installed-receipt.json");
  input.c1First.preparedReceiptFile = nodePath.join(root, "prepared-receipt.json");
  const releaseDirectory = nodePath.join(root, "release");
  mkdirSync(releaseDirectory, { mode: 0o700 });
  const node = nodePath.join(releaseDirectory, "node");
  input.c1First.scripts = {
    node,
    replacement: nodePath.join(root, "replacement.mjs"),
    rollback: nodePath.join(root, "rollback.mjs"),
  };
  const prepared = prepareDevRegistrationProvisioner(input);
  const p = prepared.plan;
  const current = InstallationConfigSchema.parse({
    public: {
      version: 1,
      installationId: p.installationId,
      origin: "https://fixture.example",
      environments: [
        { kind: "host", serverId: "host", useTls: true, endpoint: "https://host.example" },
        { kind: "container", serverId: "dev", useTls: true, endpoint: "https://dev.example" },
      ],
    },
    listenPort: 6767,
    webDistDir: "/web",
    stateDir: root,
    ownerPasswordHash: "$2fixture",
    hostAgentTokenHash: "1".repeat(64),
    containerAgentTokenHash: "2".repeat(64),
    host: {
      endpoint: "127.0.0.1:6767",
      password: "fixture-host",
      launchdService: "gui/501/local.vorteo.fixture",
    },
    container: { endpoint: "127.0.0.1:6768", password: "fixture-dev" },
    containerSourceUpdates: {
      sourceRepository: "/source",
      toolingDirectory: "/tooling",
      integrationRef: "refs/heads/main",
      receiptFile: "/host/source.json",
      docker: p.docker.path,
      containerId: p.docker.containerId,
      user: p.account.user,
      node: p.node.path,
      home: p.account.stateDirectory,
      releaseRoot: p.releaseRoot,
      currentReleaseLink: p.selectionPath,
    },
  });
  if (options.bootstrapPolicy) {
    current.ownerPasswordHash = hashSync("inert projection owner", 4);
    current.host.launchdService = `gui/${process.getuid!()}/local.vorteo.${p.installationId}.host`;
    for (const environment of current.public.environments) {
      environment.endpoint = environment.kind === "host" ? "127.0.0.1:6767" : "127.0.0.1:6768";
      environment.useTls = false;
    }
  }
  const originalBytes = Buffer.from(JSON.stringify(current, null, 2) + "\n");
  const documents = prepareDevRegistrationC1Documents({
    provisioner: prepared,
    original: {
      path: files.original,
      bytes: originalBytes,
      sha256: hash(originalBytes.toString()),
      parsed: current,
    },
    replacementScript: {
      path: input.c1First.scripts.replacement,
      bytes: Buffer.from(prepared.script),
      sha256: prepared.sha256,
    },
    rollbackScript: {
      path: input.c1First.scripts.rollback,
      bytes: Buffer.from(prepared.rollback.script),
      sha256: prepared.rollback.sha256,
    },
    hostNode: node,
  });
  for (const document of Object.values(documents))
    writeFileSync(document.path, document.bytes, { mode: 0o600 });
  writeFileSync(input.c1First.scripts.replacement, prepared.script, { mode: 0o600 });
  writeFileSync(input.c1First.scripts.rollback, prepared.rollback.script, { mode: 0o600 });
  const previousFile = nodePath.join(root, "previous.json");
  writeFileSync(previousFile, originalBytes, { mode: 0o600 });
  function pin(name: string, bytes: string) {
    const file = nodePath.join(releaseDirectory, name);
    writeFileSync(file, bytes, { mode: 0o600 });
    return { path: file, sha256: hash(bytes) };
  }
  const nodePin = pin("node", "inert reviewed Host Node bytes");
  chmodSync(node, 0o700);
  pin(".installation-source.json", JSON.stringify({ sourceCommit: "a".repeat(40) }));
  const entrypoint = pin("coordinator.mjs", "inert coordinator fixture bytes");
  const launcher = pin("service.plist", "inert launcher fixture bytes");
  const release = {
    sourceCommit: "a".repeat(40),
    directory: releaseDirectory,
    artifactSha256: await digestBootstrapArtifact(releaseDirectory),
    node: nodePin,
    entrypoint,
    launcher,
  };
  const plan = CoordinatorBootstrapPlanSchema.parse({
    version: 1,
    operation: "coordinator-bootstrap",
    installationId: p.installationId,
    service: options.bootstrapPolicy
      ? current.host.launchdService.replace(/\.host$/, ".installation")
      : "gui/501/local.vorteo.fixture.installation",
    expectedProcess: {
      pid: 1,
      bootId: "inert-fixture-not-native-proof",
      startIdentity: "fixture",
      argumentsSha256: "a".repeat(64),
    },
    previous: {
      ...release,
      configuration: { path: previousFile, sha256: documents.original.sha256 },
    },
    candidate: {
      ...release,
      configuration: { path: documents.selected.path, sha256: documents.selected.sha256 },
    },
    state: {
      directory: root,
      restartJournal: nodePath.join(root, "restart-jobs.json"),
      ownerSessions: nodePath.join(root, "owner-sessions.json"),
    },
    hostRequestsAfter: null,
  });
  return {
    root,
    prepared,
    documents,
    input: {
      plan,
      currentFile: files.original,
      current,
      candidate: structuredClone(documents.selected.parsed),
    },
  };
}
function projectionSnapshot(root: string): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  for (const name of readdirSync(root, { recursive: true, withFileTypes: true }))
    if (name.isFile()) {
      const file = nodePath.join(name.parentPath, name.name);
      result.set(file, readFileSync(file));
    }
  return result;
}
test("C1 configuration projection derives independent configuration from real protected bytes without authority", async () => {
  const f = await configurationProjectionFixture();
  const before = projectionSnapshot(f.root);
  // These verify prepared inert bytes, not a live runtime or admission.
  await verifyBootstrapReleaseArtifacts(f.input.plan.previous, []);
  await verifyBootstrapReleaseArtifacts(f.input.plan.candidate, []);
  const result = inspectDevRegistrationConfiguration(f.input);
  expect(Object.keys(result).sort()).toEqual(["assertCurrent", "configuration", "docker", "paths"]);
  expect(result.configuration).toEqual(f.documents.selected.parsed);
  expect(result.configuration).not.toBe(f.input.candidate);
  expect(result.configuration.container).not.toBe(f.input.candidate.container);
  expect(result.docker).toEqual(f.prepared.plan.docker);
  expect(new Set(result.paths)).toEqual(
    new Set([
      ...Object.values(f.prepared.plan.c1First!.configurationFiles),
      f.input.plan.previous.configuration.path,
      f.prepared.plan.c1First!.preparedReceiptFile,
      f.prepared.plan.c1First!.scripts.replacement,
      f.prepared.plan.c1First!.scripts.rollback,
    ]),
  );
  expect(() => result.assertCurrent()).not.toThrow();
  expect(readFileSync(f.input.currentFile)).toEqual(f.documents.original.bytes);
  expect(readFileSync(f.input.currentFile).toString()).not.toBe(JSON.stringify(f.input.current));
  expect(projectionSnapshot(f.root)).toEqual(before);
  expect(existsSync(f.prepared.plan.hostReceiptFile)).toBe(false);
  expect(existsSync(f.input.plan.state.restartJournal)).toBe(false);
});
test.each([
  "replacement",
  "rollback",
  "selected",
  "preparedReceipt",
  "original",
  "previous",
  "replaceScript",
  "rollbackScript",
] as const)(
  "C1 configuration projection rejects changed %s raw bytes before inspection",
  async (role) => {
    const f = await configurationProjectionFixture();
    const files = {
      ...Object.fromEntries(Object.entries(f.documents).map(([key, value]) => [key, value.path])),
      previous: f.input.plan.previous.configuration.path,
      replaceScript: f.prepared.plan.c1First!.scripts.replacement,
      rollbackScript: f.prepared.plan.c1First!.scripts.rollback,
    };
    writeFileSync(files[role], Buffer.concat([readFileSync(files[role]), Buffer.from(" ")]));
    expect(() => inspectDevRegistrationConfiguration(f.input)).toThrow();
  },
);
test.each(["replacement", "rollback", "selected", "preparedReceipt", "original"] as const)(
  "C1 configuration projection retains %s custody after inspection",
  async (role) => {
    const f = await configurationProjectionFixture();
    const result = inspectDevRegistrationConfiguration(f.input);
    const file = f.documents[role].path;
    renameSync(file, file + ".old");
    writeFileSync(file, f.documents[role].bytes, { mode: 0o600 });
    expect(() => result.assertCurrent()).toThrow();
  },
);
test.each(["plan", "current", "candidate", "paths", "docker", "configuration"])(
  "C1 configuration projection refuses %s mutation after inspection",
  async (role) => {
    const f = await configurationProjectionFixture();
    const result = inspectDevRegistrationConfiguration(f.input);
    if (role === "plan") f.input.plan.candidate.configuration.sha256 = "f".repeat(64);
    if (role === "current") f.input.current.container.password = "changed";
    if (role === "candidate") f.input.candidate.container.password = "changed";
    if (role === "paths") result.paths.push("/unreviewed");
    if (role === "docker") result.docker.path = "/unreviewed/docker";
    if (role === "configuration") result.configuration.container.password = "changed";
    expect(() => result.assertCurrent()).toThrow("input changed");
  },
);
test.each([
  "docker",
  "containerId",
  "user",
  "home",
  "node",
  "releaseRoot",
  "currentReleaseLink",
] as const)("C1 configuration projection refuses mismatched configured %s scope", async (field) => {
  const f = await configurationProjectionFixture();
  const settings = f.input.current.containerSourceUpdates!;
  settings[field] += "-unreviewed";
  expect(() => inspectDevRegistrationConfiguration(f.input)).toThrow("scope differs");
});
test.each([
  "hostNode",
  "linuxNode",
  "credentials",
  "rollbackReference",
  "installedReceipt",
  "configurationPin",
  "scriptPin",
  "installation",
])("C1 configuration projection refuses %s substitution", async (change) => {
  const f = await configurationProjectionFixture();
  const candidate = f.input.candidate;
  if (change === "hostNode") candidate.container.supervisorMaintenance!.node = "/other/host-node";
  if (change === "linuxNode") candidate.containerSourceUpdates!.node = f.prepared.plan.node.path;
  if (change === "credentials") candidate.host.password = "substituted";
  if (change === "rollbackReference")
    candidate.container.supervisorMaintenance =
      f.documents.rollback.parsed.container.supervisorMaintenance;
  if (change === "installedReceipt")
    candidate.container.persistentRegistration!.receiptFile += ".other";
  if (change === "configurationPin") f.input.plan.candidate.configuration.sha256 = "f".repeat(64);
  if (change === "scriptPin") candidate.container.supervisorMaintenance!.sha256 = "f".repeat(64);
  if (change === "installation") f.input.plan.installationId = randomUUID();
  // Even an actual file with a matching outer pin cannot authorize another projection.
  if (["linuxNode", "credentials", "installedReceipt"].includes(change)) {
    const bytes = Buffer.from(JSON.stringify(candidate));
    writeFileSync(f.input.plan.candidate.configuration.path, bytes);
    f.input.plan.candidate.configuration.sha256 = hash(bytes.toString());
  }
  expect(() => inspectDevRegistrationConfiguration(f.input)).toThrow();
});
test.each(["replacement", "rollback"] as const)(
  "C1 configuration projection refuses operation-swapped %s script",
  async (operation) => {
    const f = await configurationProjectionFixture();
    const c = f.prepared.plan.c1First!;
    if (operation === "replacement") {
      writeFileSync(c.scripts.replacement, f.prepared.rollback.script);
      f.input.candidate.container.supervisorMaintenance!.sha256 = f.prepared.rollback.sha256;
    } else writeFileSync(c.scripts.rollback, f.prepared.script);
    expect(() => inspectDevRegistrationConfiguration(f.input)).toThrow();
  },
);
test.each(["writable-parent", "symlink-parent", "writable-file"])(
  "C1 configuration projection refuses %s ancestry",
  async (change) => {
    const f = await configurationProjectionFixture();
    const result = inspectDevRegistrationConfiguration(f.input);
    if (change === "writable-parent") chmodSync(f.root, 0o722);
    if (change === "writable-file") chmodSync(f.documents.selected.path, 0o622);
    if (change === "symlink-parent") {
      const moved = f.root + ".moved";
      renameSync(f.root, moved);
      projectionRoots.push(moved);
      symlinkSync(moved, f.root);
    }
    expect(() => result.assertCurrent()).toThrow();
    expect(() => inspectDevRegistrationConfiguration(f.input)).toThrow();
  },
);

test.each([
  "ownerPasswordHash",
  "hostAgentTokenHash",
  "containerAgentTokenHash",
  "hostPassword",
  "containerPassword",
])(
  "C1 configuration projection rejects changed %s despite matching candidate file pin",
  async (field) => {
    const f = await configurationProjectionFixture();
    const config = f.input.candidate;
    if (field === "ownerPasswordHash") config.ownerPasswordHash = "$2substituted";
    if (field === "hostAgentTokenHash") config.hostAgentTokenHash = "f".repeat(64);
    if (field === "containerAgentTokenHash") config.containerAgentTokenHash = "f".repeat(64);
    if (field === "hostPassword") config.host.password = "substituted";
    if (field === "containerPassword") config.container.password = "substituted";
    const bytes = Buffer.from(JSON.stringify(config));
    writeFileSync(f.input.plan.candidate.configuration.path, bytes);
    f.input.plan.candidate.configuration.sha256 = hash(bytes.toString());
    expect(() => inspectDevRegistrationConfiguration(f.input)).toThrow(
      "selected configuration differs",
    );
  },
);
test.each([
  "existingMaintenance",
  "existingRegistration",
  "missingSourceUpdates",
  "selectedPath",
  "originalPath",
  "parsedPredecessor",
  "predecessorPin",
])("C1 configuration projection rejects %s predecessor or document scope", async (change) => {
  const f = await configurationProjectionFixture();
  if (change === "existingMaintenance")
    f.input.current.container.supervisorMaintenance =
      f.input.candidate.container.supervisorMaintenance;
  if (change === "existingRegistration")
    f.input.current.container.persistentRegistration =
      f.input.candidate.container.persistentRegistration;
  if (change === "missingSourceUpdates") delete f.input.current.containerSourceUpdates;
  if (change === "selectedPath")
    f.input.plan.candidate.configuration.path = f.documents.rollback.path;
  if (change === "originalPath") f.input.currentFile = f.input.plan.previous.configuration.path;
  if (change === "parsedPredecessor") f.input.current.container.password = "substituted";
  if (change === "predecessorPin") f.input.plan.previous.configuration.sha256 = "f".repeat(64);
  expect(() => inspectDevRegistrationConfiguration(f.input)).toThrow();
});
test.each(["hostRequests", "sourceTooling", "nativeHelper", "previewMonitor", "factoryAdoption"])(
  "C1 configuration projection refuses combined %s policy change",
  async (change) => {
    const f = await configurationProjectionFixture();
    if (change === "hostRequests") f.input.plan.hostRequestsAfter = "2026-10-17T00:00:00.000Z";
    if (change === "sourceTooling") f.input.plan.sourceUpdateTooling = true;
    if (change === "nativeHelper") f.input.plan.nativeHelperConfiguration = null;
    if (change === "previewMonitor") f.input.plan.previewMonitorConfiguration = null;
    if (change === "factoryAdoption") f.input.plan.factoryRuntimeAdoptionConfiguration = null;
    expect(() => inspectDevRegistrationConfiguration(f.input)).toThrow(
      "cannot combine policy changes",
    );
  },
);
test.each(["replacement", "rollback", "previous"])(
  "C1 configuration projection retains exact %s bytes after inspection",
  async (role) => {
    const f = await configurationProjectionFixture();
    const result = inspectDevRegistrationConfiguration(f.input);
    const files = {
      replacement: f.prepared.plan.c1First!.scripts.replacement,
      rollback: f.prepared.plan.c1First!.scripts.rollback,
      previous: f.input.plan.previous.configuration.path,
    };
    const file = files[role];
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from(" ")]));
    expect(() => result.assertCurrent()).toThrow();
  },
);

test("bootstrap policy admits only the exact derived initial Dev configuration", async () => {
  const f = await configurationProjectionFixture({ bootstrapPolicy: true });
  const before = projectionSnapshot(f.root);
  const verify = () =>
    verifyBootstrapConfiguration({
      plan: f.input.plan,
      configurationFile: f.input.currentFile,
      daemonId: "host",
    });
  expect(verify()).toBeUndefined();
  expect(projectionSnapshot(f.root)).toEqual(before);
  expect(existsSync(f.prepared.plan.hostReceiptFile)).toBe(false);
});

test("bootstrap policy refuses changed operation inputs on reopening", async () => {
  const f = await configurationProjectionFixture({ bootstrapPolicy: true });
  const verify = () =>
    verifyBootstrapConfiguration({
      plan: f.input.plan,
      configurationFile: f.input.currentFile,
      daemonId: "host",
    });
  expect(verify()).toBeUndefined();
  writeFileSync(f.documents.rollback.path, f.documents.rollback.bytes + "\n");
  expect(verify).toThrow();
});

test("bootstrap policy keeps predecessor configuration in recovery during Dev adoption", async () => {
  const f = await configurationProjectionFixture({ bootstrapPolicy: true });
  f.input.plan.automaticRecovery = "restore-compatible";
  f.input.plan.compatibleRecovery = structuredClone(f.input.plan.candidate);
  expect(() =>
    verifyBootstrapConfiguration({
      plan: f.input.plan,
      configurationFile: f.input.currentFile,
      daemonId: "host",
    }),
  ).toThrow("Recovery must preserve");
});
