// Runner modules that custody reads by name at runtime, relative to the built
// execution-installation directory. Static tracing cannot see these names, so a
// standalone coordinator bundle ships each one explicitly. No imports: bundle
// tests read this list without any built package.

export const selectedServiceRunnerModules = [
  "coordinator-bootstrap-runner.js",
  "coordinator-bootstrap-maintenance-service-runner.js",
] as const;

export const unclaimedExecutorModules = [
  "coordinator-bootstrap-runner.js",
  "coordinator-bootstrap-maintenance-service-runner.js",
  "coordinator-bootstrap-maintenance-service-claim.js",
  "coordinator-bootstrap-maintenance-service-binding.js",
  "coordinator-bootstrap-maintenance-recovery-binding.js",
  "coordinator-bootstrap-maintenance-service-native.js",
  "coordinator-bootstrap-maintenance-recovery-native.js",
  "coordinator-bootstrap-journal.js",
  "maintenance/service-admission.js",
  "lifecycle-journal.js",
  "../private-files.js",
] as const;

/** Loaded only for recovery access and recovery launchers. */
export const recoveryAccessModule = "coordinator-bootstrap-maintenance-recovery-access.js";

export const runtimeNamedRunnerModules = [
  ...new Set<string>([
    ...selectedServiceRunnerModules,
    ...unclaimedExecutorModules,
    recoveryAccessModule,
  ]),
];
