#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

// This is an explicit Host provisioning command, not a package hook or update
// payload. Password bytes enter only through stdin and are never persisted.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { provisionClaimedRepair } = await import(
  path.join(
    root,
    "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-claimed-provisioning.js",
  )
);
const { readProtectedDocument } = await import(
  path.join(
    root,
    "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-artifact.js",
  )
);
const {
  BootstrapAdmissionSetupSchema,
  inspectBootstrapWritableMountRoots,
  readBootstrapHostBinding,
} = await import(
  path.join(
    root,
    "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-host.js",
  )
);
const { BootstrapRunnerSetupSchema } = await import(
  path.join(
    root,
    "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
  )
);

async function run() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args.some((arg) => !path.isAbsolute(arg)))
    throw new Error(
      "Usage: provision-claimed-repair.mjs <installation-root> <plan-file> <receipt-file>; owner password on stdin",
    );
  const [installationRoot, planFile, receiptFile] = args;
  const plan = JSON.parse((await readProtectedDocument(planFile)).toString("utf8"));
  const receipt = JSON.parse((await readProtectedDocument(receiptFile)).toString("utf8"));
  const setup = BootstrapRunnerSetupSchema.parse(
    JSON.parse(
      (
        await readProtectedDocument(
          path.join(installationRoot, "coordinator-bootstrap-runner.json"),
        )
      ).toString("utf8"),
    ),
  );
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse((await readProtectedDocument(setup.admissionSetupFile)).toString("utf8")),
  );
  const binding = readBootstrapHostBinding(admission.configurationFile, setup.daemonId);
  if (
    binding.stateDirectory !== path.join(installationRoot, "state/coordinator") ||
    binding.binding.installationId !== receipt.installationId
  )
    throw new Error("Repair provisioning anchor belongs to another installation");
  // Docker inspection supplies exposure facts. They are never accepted from
  // the proposal, and this command does not provide test-port overrides.
  const writableMountRoots = await inspectBootstrapWritableMountRoots(admission);
  let password = Buffer.alloc(0);
  try {
    for await (const chunk of process.stdin) {
      const next = Buffer.concat([password, chunk]);
      password.fill(0);
      password = next;
      if (password.length > 4096) throw new Error("Owner password input exceeds its limit");
    }
    const result = await provisionClaimedRepair({
      installationRoot,
      plan,
      receipt,
      ownerPassword: password.toString("utf8").replace(/\r?\n$/, ""),
      writableMountRoots,
    });
    process.stdout.write(
      JSON.stringify({
        operation: "provision-claimed-repair",
        admission: result.admission,
        original: result.receipt.original,
        recoveryDispatched: false,
        daemonRestarted: false,
      }) + "\n",
    );
  } finally {
    password.fill(0);
  }
}

try {
  await run();
} catch {
  // Retain detailed diagnostics in the owning API tests; command output must
  // not expose private configuration or malformed credential input.
  process.stderr.write("Claimed repair provisioning refused; no recovery was dispatched.\n");
  process.exitCode = 1;
}
