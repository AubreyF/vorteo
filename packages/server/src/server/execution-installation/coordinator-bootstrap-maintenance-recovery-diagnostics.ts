import { z } from "zod";
import {
  ExecutionInstallationSchema,
  InstallationUnlockSchema,
} from "@getpaseo/protocol/execution-installation";
import { type RecoveryApplicationDiagnostics } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap-errors.js";

type Check = RecoveryApplicationDiagnostics["checks"][number];
interface ProbeInput {
  origin: string;
  signal: AbortSignal;
}

function failed(id: Check["id"], detail: string, httpStatus: number | null = null): Check {
  return { id, state: "failed", detail, httpStatus };
}
function unknown(id: Check["id"]): Check {
  return {
    id,
    state: "unverified",
    detail: "The response could not be verified within the diagnostic limits.",
    httpStatus: null,
  };
}

/** Read bodies under the same cancellation deadline, with explicit byte limits.
 * No response text, credentials or parser error enters the diagnostic report. */
async function boundedText(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new BootstrapRequestConflict("Diagnostic response has no body");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit)
        throw new BootstrapRequestConflict("Diagnostic response exceeded byte limit");
      parts.push(part.value);
    }
    return Buffer.concat(parts).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function request(input: ProbeInput, pathname: string, init: RequestInit = {}) {
  input.signal.throwIfAborted();
  return fetch(input.origin + pathname, {
    ...init,
    signal: input.signal,
    redirect: "error",
    cache: "no-store",
    credentials: "omit",
  });
}

async function health(input: ProbeInput, installationId: string): Promise<Check> {
  try {
    const response = await request(input, "/api/installation/health");
    if (response.status !== 200) {
      await response.body?.cancel();
      return failed("health", "Basic health did not return HTTP 200.", response.status);
    }
    const body = z
      .object({ installationId: z.string().uuid() })
      .safeParse(JSON.parse(await boundedText(response, 64 * 1024, input.signal)));
    if (!body.success || body.data.installationId !== installationId)
      return failed(
        "health",
        "Basic health belongs to another or unverified installation.",
        response.status,
      );
    return {
      id: "health",
      state: "reached",
      detail:
        "Basic health returned the expected installation. This does not establish interface usability.",
      httpStatus: response.status,
    };
  } catch {
    return unknown("health");
  }
}

async function ownerApi(
  input: ProbeInput,
  installation: z.infer<typeof ExecutionInstallationSchema>,
  credential: string,
  verifiedHealth: Check,
): Promise<Check> {
  if (verifiedHealth.state !== "reached")
    return {
      ...unknown("owner-api"),
      detail:
        "Owner authentication was not sent because the expected installation health was not verified.",
    };
  try {
    const response = await request(input, "/api/installation/owner/connections", {
      method: "POST",
      headers: {
        Origin: input.origin,
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return failed(
        "owner-api",
        "The authenticated application API did not return HTTP 200.",
        response.status,
      );
    }
    const body = InstallationUnlockSchema.safeParse(
      JSON.parse(await boundedText(response, 64 * 1024, input.signal)),
    );
    const matches =
      body.success &&
      body.data.installationId === installation.installationId &&
      installation.environments.every((expected) =>
        body.data.connections.some(
          (actual) =>
            actual.kind === expected.kind &&
            actual.serverId === expected.serverId &&
            actual.endpoint === expected.endpoint &&
            actual.useTls === expected.useTls,
        ),
      );
    if (!matches)
      return failed(
        "owner-api",
        "The authenticated API did not verify the configured installation and environments.",
        response.status,
      );
    return {
      id: "owner-api",
      state: "reached",
      detail:
        "The authenticated application API verified this installation and both environment bindings. No app session was created.",
      httpStatus: response.status,
    };
  } catch {
    return unknown("owner-api");
  }
}

function scriptPaths(document: string, origin: string): string[] {
  const paths = new Set<string>();
  for (const match of document.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const url = new URL(match[1], origin);
    if (url.origin !== origin || url.username || url.password)
      throw new BootstrapRequestConflict("Diagnostic script is outside the application origin");
    paths.add(url.pathname + url.search);
    if (paths.size > 8) throw new BootstrapRequestConflict("Too many diagnostic entry scripts");
  }
  return [...paths];
}

async function applicationDocument(input: ProbeInput): Promise<[Check, Check]> {
  try {
    const response = await request(input, "/");
    if (response.status !== 200) {
      await response.body?.cancel();
      return [
        failed("document", "The application document did not return HTTP 200.", response.status),
        unknown("scripts"),
      ];
    }
    const body = await boundedText(response, 1024 * 1024, input.signal);
    if (!/<html\b/i.test(body))
      return [
        failed("document", "The application response is not an HTML document.", 200),
        unknown("scripts"),
      ];
    const document: Check = {
      id: "document",
      state: "reached",
      detail: "The application HTML document is reachable from the recovery machine.",
      httpStatus: 200,
    };
    const paths = scriptPaths(body, input.origin);
    if (!paths.length)
      return [
        document,
        failed(
          "scripts",
          "The document contains no application entry scripts. Basic health can still be green.",
        ),
      ];
    for (const pathname of paths) {
      const script = await request(input, pathname);
      if (
        script.status !== 200 ||
        !/(java|ecma)script/i.test(script.headers.get("content-type") ?? "")
      ) {
        await script.body?.cancel();
        return [
          document,
          failed(
            "scripts",
            "An application entry script is missing or has the wrong response type.",
            script.status,
          ),
        ];
      }
      const text = await boundedText(script, 32 * 1024 * 1024, input.signal);
      if (!text.trim() || /^\s*(<!doctype|<html)/i.test(text))
        return [
          document,
          failed(
            "scripts",
            "An entry script returned empty content or an HTML fallback.",
            script.status,
          ),
        ];
    }
    return [
      document,
      {
        id: "scripts",
        state: "reached",
        detail:
          "Entry scripts are reachable. JavaScript execution, rendering and the owner's remote network remain unverified.",
        httpStatus: 200,
      },
    ];
  } catch {
    return [unknown("document"), unknown("scripts")];
  }
}

/** Only the protected configuration chooses destinations. This read-only probe
 * never loads enrollment/lifecycle state, unlocks sessions or changes selection. */
export async function inspectRecoveryApplication(input: {
  installationId: string;
  configuration: unknown;
  ownerCredential: string;
  signal: AbortSignal;
}): Promise<RecoveryApplicationDiagnostics> {
  const installation = z
    .object({ public: ExecutionInstallationSchema })
    .parse(input.configuration).public;
  const origin = new URL(installation.origin);
  const localHttp =
    origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname);
  if (
    installation.installationId !== input.installationId ||
    origin.origin !== installation.origin ||
    !(origin.protocol === "https:" || localHttp)
  )
    throw new BootstrapRequestConflict("Diagnostic application identity or origin is unverified");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(8000)]);
  signal.throwIfAborted();
  const probe = { origin: installation.origin, signal };
  const [basic, document] = await Promise.all([
    health(probe, input.installationId),
    applicationDocument(probe),
  ]);
  const authenticated = await ownerApi(probe, installation, input.ownerCredential, basic);
  return {
    version: 1,
    installationId: input.installationId,
    applicationOrigin: installation.origin,
    checkedAt: new Date().toISOString(),
    scope: "recovery-host",
    browserUsability: "unverified",
    checks: [basic, authenticated, ...document],
  };
}
