import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  SupervisorEffectSchema,
  type SupervisorEffect,
} from "@getpaseo/protocol/execution-installation";
import { DaemonMaintenanceProcessSchema } from "@getpaseo/protocol/maintenance-interruption";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";
import { DEV_REGISTRATION_NATIVE_PRIMITIVES } from "./dev-registration-native-primitives.js";
import type { PreparedDevRegistrationProvisioner } from "./dev-registration-provisioner.js";

/** Separate fixed read-only program. No writer, service operation or arbitrary
 * command is present. Privileged invocation is NOT provided by this module. */
export const DEV_REGISTRATION_NATIVE_OBSERVATION_SCRIPT = String.raw`
import os,sys,json,hashlib,stat,time,pwd,platform,base64,uuid
request=json.load(sys.stdin)
p=request['plan'];deadline=time.monotonic()+10
retained={};records={}
def check(ok,reason):
    if time.monotonic()>deadline: raise RuntimeError('Native observation deadline exceeded')
    if not ok: raise RuntimeError(reason)
${DEV_REGISTRATION_NATIVE_PRIMITIVES}
def encode(value): return json.dumps(value,separators=(',',':'),ensure_ascii=False).encode()
def retain(file):
    protected(file)
    current=file
    while True:
        metadata=os.lstat(current)
        check(os.path.realpath(current)==current and metadata.st_uid==0 and not metadata.st_mode&0o022 and (stat.S_ISREG(metadata.st_mode) or stat.S_ISDIR(metadata.st_mode)),'Retained native ancestry is unsafe')
        value=identity(metadata)
        check(current not in retained or retained[current]==value,'Retained native ancestry changed')
        retained[current]=value
        parent=os.path.dirname(current)
        if parent==current: break
        current=parent
    check(len(retained)<=256,'Native custody path bound exceeded')
def assert_retained():
    for file,value in retained.items():
        check(os.path.realpath(file)==file and identity(os.lstat(file))==value,'Native custody changed')
def captured(file):
    retain(file)
    data=read(file,65536)
    assert_retained()
    record=protected_record(file)
    check(encode(record)==data,'Native record bytes are not exact writer format')
    value=dict(path=file,sha256=digest(data),bytesBase64=base64.b64encode(data).decode(),identity=[str(value) for value in retained[file]],record=record)
    check(file not in records or records[file]==value,'Native record changed')
    records[file]=value
    return value
def current_boot():
    with open('/proc/sys/kernel/random/boot_id') as stream: raw=stream.read(4097)
    check(len(raw)<=4096,'Oversized native boot identity')
    boot=raw.strip()
    check(boot==p['parent']['bootId'],'Native observation crossed boot')
    return boot
def root_exit(executor):
    # Boot verification precedes even interpreting ENOENT. Recheck after every
    # native read; a changed boot or racing PID is unresolved, never root exit.
    current_boot()
    def birth():
        current_boot()
        try:
            with open('/proc/'+str(executor['pid'])+'/stat') as stream: raw=stream.read(65537)
        except FileNotFoundError:
            current_boot();return None
        current_boot()
        check(len(raw)<=65536 and raw.startswith(str(executor['pid'])+' ('),'Malformed native root stat')
        check(raw.rfind(')')>raw.find('('),'Malformed native root command boundary')
        fields=raw[raw.rfind(')')+2:].strip().split()
        check(len(fields)>=20 and fields[0] in ('R','S','D','Z','T','t','X','x','K','W','P','I') and fields[1].isdigit() and fields[19].isdigit(),'Malformed native root birth')
        return fields[19]
    first=birth();second=birth()
    check(first==second,'Native root lifetime raced')
    check(first is None or first!=executor['startIdentity'],'Native root executor remains present')
    return dict(rootExecutor=executor,bootId=current_boot(),evidence='absent' if first is None else 'reused',observedBirth=first)
def target(file,limit=268435456):
    retain(file);data=read(file,limit);assert_retained()
    return dict(path=file,sha256=digest(data),size=len(data),identity=[str(value) for value in retained[file]])
def collect():
    check(os.getuid()==0 and os.geteuid()==0 and os.getgid()==0 and os.getegid()==0 and sys.platform=='linux','Native read-only observation requires declared Linux capability')
    check(os.path.realpath(sys.executable)==p['systemPython']['path'],'Observed Python differs')
    retain(p['systemPython']['path']);python_bytes=pin(p['systemPython'],True);assert_retained()
    check({'aarch64':'arm64','x86_64':'x64'}.get(platform.machine())==p['linuxArtifact']['arch'],'Observed platform differs')
    account=pwd.getpwnam(p['account']['user'])
    check((account.pw_uid,account.pw_gid,account.pw_dir)==(p['account']['uid'],p['account']['gid'],p['account']['home']),'Observed account differs')
    check(request['container']['containerId']==p['docker']['containerId'] and request['container']['startup']==p['startup'],'Host-observed container tuple differs')
    check(digest(encode(p))==request['planSha256'],'Reviewed native plan differs')
    claim=request['claim'];binding=claim['binding'];operation=binding['operation']
    check(operation in ('replace','rollback') and claim['consumedAt'] and claim['child'],'Consumed native observation claim absent')
    check(digest(encode(claim))==request['claimSha256'],'Consumed native claim differs')
    check(binding['registrationPlanSha256']==request['planSha256'] and binding['preparationNonce']==p['preparationNonce'],'Native observation preparation differs')
    check(binding['sourceCommit']==p['linuxArtifact']['sourceCommit'] and binding['artifactSha256']==p['linuxArtifact']['artifactSha256'],'Native observation artifact differs')
    check(claim['child']['reservationSha256']==digest(encode(dict(binding=binding,reservedAt=claim['reservedAt']))),'Consumed child reservation differs')
    check(str(uuid.UUID(p['preparationNonce']))==p['preparationNonce'],'Native preparation nonce differs')
    check(request['writableMounts']==request['container']['writableMounts'],'Host-observed writable mounts differ')
    check(p['destination']=='/opt/vorteo-persistent-registration/'+p['preparationNonce'],'Native observation destination differs')
    check(p['nativeReceiptFile']==p['destination']+'/provisioning-result.json' and p['protectedNode']==p['destination']+'/node','Native observation addresses differ')
    current_boot()
    witness_path=p['destination']+('/attempt.json' if operation=='replace' else '/rollback-attempt.json')
    witness=captured(witness_path);record=witness['record']
    executor=record['rootExecutor']
    check(set(executor)=={'pid','parentPid','uid','gid','bootId','startIdentity','executable','argumentsSha256'},'Malformed retained root identity')
    check(type(executor['parentPid']) is int and executor['parentPid']>=0 and type(executor['uid']) is int and type(executor['gid']) is int,'Malformed retained root credentials')
    check(type(executor['argumentsSha256']) is str and len(executor['argumentsSha256'])==64 and all(char in '0123456789abcdef' for char in executor['argumentsSha256']),'Malformed retained root arguments')
    check(type(executor['pid']) is int and executor['pid']>0 and executor['uid']==0 and executor['gid']==0 and executor['executable']==p['systemPython']['path'] and executor['bootId']==p['parent']['bootId'],'Retained root executor differs')
    check(type(executor['startIdentity']) is str and executor['startIdentity'].isdigit(),'Retained root birth differs')
    if operation=='replace':
        expected=dict(planSha256=request['planSha256'],claimSha256=request['claimSha256'],jobId=binding['requestId'],phase='prepared',scriptSha256=binding['supervisorPlanSha256'],rootExecutor=executor)
    else:
        check(binding['original'] is not None,'Rollback predecessor absent')
        expected=dict(jobId=binding['requestId'],planSha256=request['planSha256'],claimSha256=request['claimSha256'],originalClaimSha256=binding['original']['claimSha256'],operation='rollback',scriptSha256=binding['supervisorPlanSha256'],rootExecutor=executor)
    check(record==expected,'Retained native witness differs')
    exited=root_exit(executor);assert_retained()
    # No mutable result, selector, pointer or target bytes are read above this gate.
    outcome_path=p['nativeReceiptFile'] if operation=='replace' else p['destination']+'/rollback-result.json'
    outcome=captured(outcome_path)
    expected=dict(planSha256=request['planSha256'],claimSha256=request['claimSha256'],operation=operation,phase='started-unverified',jobId=binding['requestId'],scriptSha256=binding['supervisorPlanSha256'],rootExecutor=executor)
    check(outcome['record']==expected,'Retained native outcome differs')
    check(p['runtime']==p['destination']+'/runtime' and p['supervisorEntrypoint']==p['runtime']+'/packages/server/dist/scripts/supervisor-entrypoint.js','Native target paths differ')
    check([item['path'] for item in p['files']]==[p['destination']+'/factory-main-entry.mjs',p['destination']+'/factory-launch.py'],'Native Factory paths differ')
    check(p['originalPointer']['path']=='/etc/paseo-server-entry','Native pointer path differs')
    targets=[target(p['originalPointer']['path'],4096),target(p['protectedNode']),target(p['supervisorEntrypoint'])]
    for file in p['files']: targets.append(target(file['path']))
    parent=process(p['parent']['pid']);check(parent==p['parent'],'Observed native parent changed')
    check(root_exit(executor)==exited,'Native exit evidence changed')
    for file,record in list(records.items()): check(captured(file)==record,'Native retained record changed')
    check(process(p['parent']['pid'])==parent,'Native parent changed after native recheck')
    assert_retained();current_boot()
    runtime=dict(python=dict(path=os.path.realpath(sys.executable),sha256=digest(python_bytes)),platform='linux',arch={'aarch64':'arm64','x86_64':'x64'}[platform.machine()],account=dict(user=account.pw_name,uid=account.pw_uid,gid=account.pw_gid,home=account.pw_dir))
    return dict(runtime=runtime,kind='root-exited',claimSha256=request['claimSha256'],planSha256=request['planSha256'],rootExit=exited,witness=witness,outcome=outcome,targets=targets,parent=parent,ancestry=[dict(path=file,identity=[str(item) for item in value]) for file,value in retained.items()])
try:
    print(json.dumps(collect(),separators=(',',':')))
except Exception:
    print(json.dumps(dict(kind='unresolved',reason='Native witness, lifetime or protected evidence unavailable'),separators=(',',':')))
`;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const rootProcess = DaemonMaintenanceProcessSchema.extend({ uid: z.literal(0), gid: z.literal(0) });
const retainedFile = z.strictObject({
  path: z.string().startsWith("/"),
  sha256: digestSchema,
  bytesBase64: z.string().max(90000),
  identity: z.array(z.string()).length(9),
  record: z.unknown(),
});
export const DevRegistrationNativeFactsSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unresolved"), reason: z.string().max(200) }),
  z.strictObject({
    kind: z.literal("root-exited"),
    claimSha256: digestSchema,
    planSha256: digestSchema,
    rootExit: z.strictObject({
      rootExecutor: rootProcess,
      bootId: z.string(),
      evidence: z.enum(["absent", "reused"]),
      observedBirth: z.string().nullable(),
    }),
    witness: retainedFile,
    outcome: retainedFile,
    targets: z
      .array(
        z.strictObject({
          path: z.string().startsWith("/"),
          sha256: digestSchema,
          size: z.number().int().nonnegative(),
          identity: z.array(z.string()).length(9),
        }),
      )
      .length(5),
    runtime: z.strictObject({
      python: z.strictObject({ path: z.string(), sha256: digestSchema }),
      platform: z.literal("linux"),
      arch: z.enum(["arm64", "x64"]),
      account: z.strictObject({
        user: z.string(),
        uid: z.number().int(),
        gid: z.number().int(),
        home: z.string(),
      }),
    }),
    parent: DaemonMaintenanceProcessSchema.extend({ gid: z.number().int().nonnegative() }),
    ancestry: z
      .array(
        z.strictObject({
          path: z.string().startsWith("/"),
          identity: z.array(z.string()).length(9),
        }),
      )
      .min(1)
      .max(256),
  }),
]);

export interface DevRegistrationNativeObservationInput {
  provisioner: PreparedDevRegistrationProvisioner;
  effect: SupervisorEffect;
  /** Actual fresh Docker facts supplied by the protected Host caller. Its
   * independent Host-child exit gate must precede invocation of this backend. */
  container: {
    containerId: string;
    startup: PreparedDevRegistrationProvisioner["plan"]["startup"];
    writableMounts: string[];
    assertCurrent(): void;
  };
}
export interface DevRegistrationNativeObservationInvocation {
  program: string;
  programSha256: string;
  python: PreparedDevRegistrationProvisioner["plan"]["systemPython"];
  containerId: string;
  input: string;
  timeoutMs: 10000;
  maxOutputBytes: 1048576;
}
export interface DevRegistrationNativeObservationPorts {
  /** Only a separately reviewed fixed Host capability may implement these.
   * It must bind actual container/tool custody, not execute caller commands. */
  read(invocation: DevRegistrationNativeObservationInvocation): Promise<string>;
  readSync(invocation: DevRegistrationNativeObservationInvocation): string;
  now(): number;
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function requireNative(ok: boolean, message: string): asserts ok {
  if (!ok) throw new BootstrapRequestConflict(message);
}
function assertRootExitEvidence(
  facts: Extract<z.infer<typeof DevRegistrationNativeFactsSchema>, { kind: "root-exited" }>,
): void {
  const root = facts.rootExit.rootExecutor;
  const evidence = facts.rootExit;
  requireNative(
    (evidence.evidence === "absent" && evidence.observedBirth === null) ||
      (evidence.evidence === "reused" &&
        evidence.observedBirth !== null &&
        /^\d+$/.test(evidence.observedBirth) &&
        evidence.observedBirth !== root.startIdentity),
    "Native root-exit evidence is inconsistent",
  );
}
function containerData(input: DevRegistrationNativeObservationInput) {
  const { containerId, startup, writableMounts } = input.container;
  return { containerId, startup, writableMounts };
}

/** Requires a real protected fixed invoker. There is deliberately no default
 * privileged implementation, capability enablement, settlement or readiness. */
export async function collectDevRegistrationNativeObservation(
  input: DevRegistrationNativeObservationInput,
  ports: DevRegistrationNativeObservationPorts,
) {
  const captured = structuredClone({
    provisioner: input.provisioner,
    effect: input.effect,
    container: containerData(input),
  });
  const checkContainer = input.container.assertCurrent,
    read = ports.read,
    readSync = ports.readSync,
    now = ports.now;
  const containerRef = input.container;
  function unchanged() {
    return (
      input.container === containerRef &&
      isDeepStrictEqual(captured, {
        provisioner: input.provisioner,
        effect: input.effect,
        container: containerData(input),
      }) &&
      input.container.assertCurrent === checkContainer &&
      ports.read === read &&
      ports.readSync === readSync &&
      ports.now === now
    );
  }
  function assertInput() {
    requireNative(unchanged(), "Native observation inputs or callbacks changed");
    const result: unknown = checkContainer();
    requireNative(result === undefined, "Native observation container custody must be synchronous");
    requireNative(unchanged(), "Native observation inputs changed after custody check");
  }
  const effect = SupervisorEffectSchema.parse(captured.effect);
  requireNative(
    effect.phase !== "reserved" && Boolean(effect.consumedAt && effect.child),
    "Native observation requires exact consumed child",
  );
  const plan = captured.provisioner.plan,
    binding = effect.binding;
  const script =
    binding.operation === "replace" ? captured.provisioner : captured.provisioner.rollback;
  requireNative(
    hash(JSON.stringify(plan)) === captured.provisioner.planSha256 &&
      binding.registrationPlanSha256 === captured.provisioner.planSha256 &&
      binding.supervisorPlanSha256 === script.sha256 &&
      hash(script.script) === script.sha256,
    "Native observation reviewed script or plan differs",
  );
  requireNative(
    captured.container.containerId === plan.docker.containerId &&
      isDeepStrictEqual(captured.container.startup, plan.startup),
    "Native observation actual container tuple differs",
  );
  const claim = {
    binding: effect.binding,
    reservedAt: effect.reservedAt,
    consumedAt: effect.consumedAt,
    child: effect.child,
  };
  const request = {
    plan,
    planSha256: captured.provisioner.planSha256,
    claim,
    claimSha256: hash(JSON.stringify(claim)),
    container: captured.container,
    writableMounts: captured.container.writableMounts,
  };
  const invocation: DevRegistrationNativeObservationInvocation = {
    program: DEV_REGISTRATION_NATIVE_OBSERVATION_SCRIPT,
    programSha256: hash(DEV_REGISTRATION_NATIVE_OBSERVATION_SCRIPT),
    python: structuredClone(plan.systemPython),
    containerId: plan.docker.containerId,
    input: JSON.stringify(request),
    timeoutMs: 10000,
    maxOutputBytes: 1048576,
  };
  function parse(stdout: string) {
    requireNative(
      typeof stdout === "string" && Buffer.byteLength(stdout) <= invocation.maxOutputBytes,
      "Native observation output exceeds bound",
    );
    const facts = DevRegistrationNativeFactsSchema.parse(JSON.parse(stdout));
    if (facts.kind === "root-exited") {
      requireNative(
        facts.claimSha256 === request.claimSha256 &&
          facts.planSha256 === request.planSha256 &&
          facts.rootExit.bootId === plan.parent.bootId &&
          facts.rootExit.rootExecutor.bootId === plan.parent.bootId &&
          facts.rootExit.rootExecutor.executable === plan.systemPython.path,
        "Native observation facts differ from exact invocation",
      );
      const root = facts.rootExit.rootExecutor;
      const original = binding.original;
      const witnessPath =
        plan.destination +
        (binding.operation === "replace" ? "/attempt.json" : "/rollback-attempt.json");
      const outcomePath =
        binding.operation === "replace"
          ? plan.nativeReceiptFile
          : plan.destination + "/rollback-result.json";
      const replacementWitness = {
        planSha256: request.planSha256,
        claimSha256: request.claimSha256,
        jobId: binding.requestId,
        phase: "prepared",
        scriptSha256: binding.supervisorPlanSha256,
        rootExecutor: root,
      };
      const rollbackWitness = {
        jobId: binding.requestId,
        planSha256: request.planSha256,
        claimSha256: request.claimSha256,
        originalClaimSha256: original?.claimSha256,
        operation: "rollback",
        scriptSha256: binding.supervisorPlanSha256,
        rootExecutor: root,
      };
      const witness = binding.operation === "replace" ? replacementWitness : rollbackWitness;
      const outcome = {
        planSha256: request.planSha256,
        claimSha256: request.claimSha256,
        operation: binding.operation,
        phase: "started-unverified",
        jobId: binding.requestId,
        scriptSha256: binding.supervisorPlanSha256,
        rootExecutor: root,
      };
      requireNative(
        facts.witness.path === witnessPath &&
          facts.outcome.path === outcomePath &&
          isDeepStrictEqual(facts.witness.record, witness) &&
          isDeepStrictEqual(facts.outcome.record, outcome),
        "Native observation witness or outcome binding differs",
      );
      assertRootExitEvidence(facts);
      requireNative(
        isDeepStrictEqual(facts.runtime, {
          python: { path: plan.systemPython.path, sha256: plan.systemPython.sha256 },
          platform: "linux",
          arch: plan.linuxArtifact.arch,
          account: {
            user: plan.account.user,
            uid: plan.account.uid,
            gid: plan.account.gid,
            home: plan.account.home,
          },
        }) && isDeepStrictEqual(facts.parent, plan.parent),
        "Native runtime or parent facts differ",
      );
      const targets = [
        plan.originalPointer.path,
        plan.protectedNode,
        plan.supervisorEntrypoint,
        ...plan.files.map((file) => file.path),
      ];
      requireNative(
        isDeepStrictEqual(
          facts.targets.map((file) => file.path),
          targets,
        ),
        "Native target addresses differ",
      );
      for (const file of [facts.witness, facts.outcome, ...facts.targets]) {
        requireNative(
          facts.ancestry.some(
            (entry) => entry.path === file.path && isDeepStrictEqual(entry.identity, file.identity),
          ),
          "Native captured file custody is absent",
        );
      }
      for (const file of [facts.witness, facts.outcome]) {
        const bytes = Buffer.from(file.bytesBase64, "base64");
        requireNative(
          hash(bytes.toString("utf8")) === file.sha256 &&
            isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), file.record),
          "Native captured record bytes differ",
        );
      }
    }
    return facts;
  }
  assertInput();
  const payload = structuredClone(invocation);
  const stdout = await read(payload);
  requireNative(isDeepStrictEqual(payload, invocation), "Native invocation changed during read");
  const facts = parse(stdout);
  assertInput();
  const observedAt = now();
  requireNative(unchanged(), "Native observation inputs changed after timestamp");
  const proof = {
    facts: structuredClone(facts),
    assertCurrent() {
      const started = now();
      assertInput();
      requireNative(
        started >= observedAt && started - observedAt < 30000,
        "Native observation evidence expired",
      );
      requireNative(now() - started < 2000, "Native observation synchronous budget exhausted");
      const recheckInvocation = structuredClone(invocation);
      const current = parse(readSync(recheckInvocation));
      requireNative(
        isDeepStrictEqual(recheckInvocation, invocation),
        "Native invocation changed during recheck",
      );
      assertInput();
      requireNative(
        now() >= started && now() - started < 12000 && now() - observedAt < 30000,
        "Native observation synchronous recheck expired or exceeded budget",
      );
      requireNative(
        unchanged() && isDeepStrictEqual(current, facts) && isDeepStrictEqual(proof.facts, facts),
        "Native observation facts changed",
      );
    },
  };
  return proof;
}
