/**
 * Server suites skipped on Windows.
 *
 * `*.posix.test.ts` files need POSIX behavior (see docs/testing.md). The named suites cover
 * Vorteo features that only run on the native macOS Host or the Linux Dev container: the
 * installation coordinator, the session host, Host account delivery and Host process custody.
 * They rely on POSIX ownership, modes, process identity and launchd or systemd, so Windows
 * cannot exercise them. Keep this list to suites whose subject is POSIX-only.
 */
export const WINDOWS_EXCLUDED_SUITES = [
  "**/*.posix.test.ts",
  // Every session host suite is POSIX-only: it runs only on the macOS Host and Linux Dev.
  "src/server/session-host/**",
  "scripts/build-coordinator-bundle.test.ts",
  "src/server/agent/providers/claude/packaged-cli.test.ts",
  "src/server/agent/providers/claude/setup-token-query.test.ts",
  "src/server/browser-tools/engine/headless-host-contract-trace.test.ts",
  "src/server/execution-installation/accounts/claude-oauth-host.test.ts",
  "src/server/execution-installation/accounts/claude-setup-authority.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-artifact-scan.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-artifact.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-claimed-recovery.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-host.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-journal-lock.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-launch-dispatch.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-maintenance-absence.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-maintenance-admission.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-maintenance-child.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-maintenance-control.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-maintenance-launcher.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-maintenance-recovery-native-ports.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-maintenance-service-producer.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-maintenance-service-status.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-preclaim-journal.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-preclaim-recovery.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-renewal.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-runner.test.ts",
  "src/server/execution-installation/coordinator-bootstrap-runtime-custody.test.ts",
  "src/server/execution-installation/coordinator-bootstrap.test.ts",
  "src/server/execution-installation/dev-source-repair.test.ts",
  // Docker restart and Factory checks verify owner-controlled physical scripts by POSIX
  // ownership, mode and inode; they run only on the macOS Host.
  "src/server/execution-installation/engine-restart.test.ts",
  "src/server/execution-installation/factory-gate.test.ts",
  // The Host launcher update swaps an owner-controlled launchd plist on the macOS Host.
  "src/server/execution-installation/host-launcher-update.test.ts",
  "src/server/execution-installation/maintenance/authorization.test.ts",
  "src/server/execution-installation/maintenance/dev-registration-execution.test.ts",
  "src/server/execution-installation/maintenance/dev-registration-native-executor.test.ts",
  "src/server/execution-installation/maintenance/dev-registration-provisioner.test.ts",
  "src/server/execution-installation/maintenance/dev-registration.test.ts",
  "src/server/execution-installation/maintenance/host-service-inspection.test.ts",
  "src/server/execution-installation/maintenance/host-supervisor-initial-command-admission.test.ts",
  "src/server/execution-installation/maintenance/host-supervisor-native-launch.test.ts",
  "src/server/execution-installation/maintenance/host-supervisor-recovery-inspection.test.ts",
  "src/server/execution-installation/maintenance/host-supervisor-recovery.test.ts",
  "src/server/execution-installation/maintenance/native-daemon-inspection.test.ts",
  "src/server/execution-installation/maintenance/worker-launch-lookup.test.ts",
  "src/server/execution-installation/maintenance/worker-launch.test.ts",
  "src/server/execution-installation/native-helper-artifact.test.ts",
  "src/server/execution-installation/native-helper-command.test.ts",
  "src/server/execution-installation/native-helper-executor.test.ts",
  "src/server/execution-installation/native-helper-installer-process.test.ts",
  "src/server/execution-installation/native-helper-state.test.ts",
  "src/server/execution-installation/preview-monitor-executor.test.ts",
  "src/server/execution-installation/preview-monitor-maintenance.test.ts",
  "src/server/execution-installation/preview-monitor-workflow.test.ts",
  "src/server/execution-installation/restarts.test.ts",
  "src/server/execution-installation/session-host-job.test.ts",
  "src/server/execution-installation/session-host-workflow.test.ts",
  "src/server/execution-installation/settings/instruction-requests.test.ts",
  "src/server/execution-installation/settings/runtime.test.ts",
  "src/server/execution-installation/supervisor-maintenance.test.ts",
  "src/server/listen-reclaim.test.ts",
  "src/server/worker-watchdog.test.ts",
  "src/services/provider-login/claude-full-signin.test.ts",
];
