import { execFile } from "node:child_process";

/**
 * Labels any caller may manage. Everything else, including the installed local.vorteo.* jobs,
 * needs allowProductionLabel, so a test or an experiment can never stop a live host.
 */
export const TEST_LABEL_PREFIX = "test.durable-sessions.";

/** launchd labels end up in a domain path; keep them to characters that cannot escape it. */
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * XML 1.0 cannot represent these characters at all, even escaped. Built from a string so the
 * formatter cannot turn the escapes into invisible literal characters.
 */
// eslint-disable-next-line no-control-regex -- XML forbids exactly these control characters.
const XML_FORBIDDEN = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]");

export interface SessionHostPlistInput {
  label: string;
  nodePath: string;
  entrypointPath: string;
  /** Inserted between node and the entrypoint, such as a loader for a source checkout. */
  nodeArguments?: readonly string[];
  paseoHome: string;
  /** Receives the job's stdout and stderr: startup failures before the host log opens. */
  logPath: string;
  /** Extra variables. PASEO_HOME always comes from paseoHome. */
  environment?: Readonly<Record<string, string>>;
  workingDirectory: string;
}

export class LaunchdLabelError extends Error {
  constructor(readonly label: string) {
    super(`Refusing to manage launchd job ${label}.`);
    this.name = "LaunchdLabelError";
  }
}

export class LaunchctlError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`launchctl ${args[0]} failed${exitCode === null ? "" : ` with exit code ${exitCode}`}.`);
    this.name = "LaunchctlError";
  }
}

function escapeXml(value: string): string {
  if (XML_FORBIDDEN.test(value))
    throw new Error("A launchd plist value contains a character XML cannot represent.");
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stringEntry(key: string, value: string, indent: string): string {
  return `${indent}<key>${escapeXml(key)}</key>\n${indent}<string>${escapeXml(value)}</string>\n`;
}

/**
 * launchd's SIGKILL after a stop request. It must come after the host's own shutdown deadline,
 * which already bounds provider close, so launchd never cuts a graceful stop short.
 */
export const SESSION_HOST_EXIT_TIMEOUT_SECONDS = 30;

/**
 * The launchd job for one session host. KeepAlive restarts the host after any exit, including
 * the deliberate exit at idle for an upgrade; ThrottleInterval bounds a crash loop. The job
 * depends on nothing else: no daemon port, supervisor or worker.
 *
 * The entrypoint path must resolve to the installed release at every start, for example through
 * the installation's current release link. A fixed release path would restart the old code after
 * each upgrade exit.
 *
 * Deliberately absent: ProcessType, because Background throttles CPU and I/O for every Claude
 * tool run, matching the Host daemon job, which sets none; and Umask, because Claude and its
 * tools inherit it and must create files with the usual permissions. Host files use explicit
 * modes, and the host masks only its socket bind.
 */
export function renderSessionHostPlist(input: SessionHostPlistInput): string {
  if (!LABEL_PATTERN.test(input.label)) throw new LaunchdLabelError(input.label);
  const programArguments = [input.nodePath, ...(input.nodeArguments ?? []), input.entrypointPath];
  const environment: Record<string, string> = { ...input.environment, PASEO_HOME: input.paseoHome };
  const environmentEntries = Object.keys(environment)
    .toSorted()
    .map((key) => stringEntry(key, environment[key]!, "\t\t"))
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n<dict>\n` +
    stringEntry("Label", input.label, "\t") +
    `\t<key>ProgramArguments</key>\n\t<array>\n` +
    programArguments.map((arg) => `\t\t<string>${escapeXml(arg)}</string>\n`).join("") +
    `\t</array>\n` +
    `\t<key>EnvironmentVariables</key>\n\t<dict>\n${environmentEntries}\t</dict>\n` +
    stringEntry("WorkingDirectory", input.workingDirectory, "\t") +
    stringEntry("StandardOutPath", input.logPath, "\t") +
    stringEntry("StandardErrorPath", input.logPath, "\t") +
    `\t<key>RunAtLoad</key>\n\t<true/>\n` +
    `\t<key>KeepAlive</key>\n\t<true/>\n` +
    `\t<key>ThrottleInterval</key>\n\t<integer>5</integer>\n` +
    `\t<key>ExitTimeOut</key>\n\t<integer>${SESSION_HOST_EXIT_TIMEOUT_SECONDS}</integer>\n` +
    `</dict>\n</plist>\n`
  );
}

export interface CommandResult {
  stdout: string;
}

/** Runs a command without a shell. Rejects with LaunchctlError on a non-zero exit. */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

export interface LaunchdOptions {
  /** Required for any label outside TEST_LABEL_PREFIX. Tests must never pass it. */
  allowProductionLabel?: boolean;
  /** Replaces the real launchctl and plutil, for tests. */
  run?: CommandRunner;
}

/** The real launchctl and plutil runner, for callers that pass commands of their own. */
export function runLaunchdCommand(file: string, args: readonly string[]): Promise<CommandResult> {
  return runCommand(file, args);
}

function runCommand(file: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        const code = typeof error.code === "number" ? error.code : null;
        reject(new LaunchctlError(args, code, String(stderr)));
        return;
      }
      resolve({ stdout: String(stdout) });
    });
  });
}

function guardLabel(label: string, options: LaunchdOptions): void {
  if (!LABEL_PATTERN.test(label)) throw new LaunchdLabelError(label);
  if (!label.startsWith(TEST_LABEL_PREFIX) && options.allowProductionLabel !== true)
    throw new LaunchdLabelError(label);
}

function guiDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("launchd jobs require a POSIX platform.");
  return `gui/${uid}`;
}

/** launchctl exits with this when the job is not loaded. */
const LAUNCHCTL_NOT_FOUND = 113;

/**
 * Loads and starts the job in a plist. The label is read from the plist itself, so the guard
 * checks what launchd will actually manage rather than what the caller says.
 */
export async function bootstrapJob(plistPath: string, options: LaunchdOptions = {}): Promise<void> {
  const run = options.run ?? runCommand;
  const { stdout } = await run("/usr/bin/plutil", [
    "-extract",
    "Label",
    "raw",
    "-o",
    "-",
    plistPath,
  ]);
  guardLabel(stdout.trim(), options);
  await run("/bin/launchctl", ["bootstrap", guiDomain(), plistPath]);
}

/** Stops and unloads the job. launchd sends SIGTERM, then SIGKILL after its exit timeout. */
export async function bootoutJob(label: string, options: LaunchdOptions = {}): Promise<void> {
  guardLabel(label, options);
  await (options.run ?? runCommand)("/bin/launchctl", ["bootout", `${guiDomain()}/${label}`]);
}

/** Starts the job now; with kill, a running instance is killed first. */
export async function kickstartJob(
  label: string,
  options: LaunchdOptions & { kill?: boolean } = {},
): Promise<void> {
  guardLabel(label, options);
  const args = ["kickstart", ...(options.kill ? ["-k"] : []), `${guiDomain()}/${label}`];
  await (options.run ?? runCommand)("/bin/launchctl", args);
}

/** launchd's description of a loaded job, or null when no such job is loaded. */
export async function printJob(
  label: string,
  options: LaunchdOptions = {},
): Promise<string | null> {
  guardLabel(label, options);
  try {
    const { stdout } = await (options.run ?? runCommand)("/bin/launchctl", [
      "print",
      `${guiDomain()}/${label}`,
    ]);
    return stdout;
  } catch (error) {
    if (error instanceof LaunchctlError && error.exitCode === LAUNCHCTL_NOT_FOUND) return null;
    throw error;
  }
}
