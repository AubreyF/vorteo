import { expect, test } from "vitest";
import {
  ClaudeSetupTokenLoginSession,
  type SetupTokenProcess,
  type SetupTokenSpawnInput,
} from "./setup-token-login.js";
import type { ClaudeSetupToken } from "./setup-token-store.js";

class FakeProcess implements SetupTokenProcess {
  writes: string[] = [];
  private readers: Array<(data: string) => void> = [];
  private exits: Array<(event: { exitCode: number }) => void> = [];
  write(data: string) {
    this.writes.push(data);
  }
  onData(listener: (data: string) => void) {
    this.readers.push(listener);
    return { dispose() {} };
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.exits.push(listener);
    return { dispose() {} };
  }
  kill() {
    this.exit(143);
  }
  emit(data: string) {
    for (const listener of this.readers) listener(data);
  }
  exit(exitCode: number) {
    for (const listener of this.exits) listener({ exitCode });
  }
}
const url =
  "https://claude.com/cai/oauth/authorize?scope=user%3Ainference&response_type=code&state=synthetic&code_challenge=synthetic";
const token = `sk-ant-oat01-${"synthetic".repeat(8)}`;

function fixture(saveToken: (value: ClaudeSetupToken, signal: AbortSignal) => Promise<void>) {
  const child = new FakeProcess();
  const launches: SetupTokenSpawnInput[] = [];
  const completed: boolean[] = [];
  const session = new ClaudeSetupTokenLoginSession({
    scope: "/existing/account/history",
    executable: "/claude",
    args: [],
    runtimeSettings: {
      env: {
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "must-not-inherit",
        ANTHROPIC_API_KEY: "must-not-inherit",
      },
    },
    saveToken,
    spawn(input) {
      launches.push(input);
      return child;
    },
  });
  return { child, launches, completed, session };
}

async function challenge(f: ReturnType<typeof fixture>) {
  const started = f.session.start((success) => f.completed.push(success));
  await expect.poll(() => f.launches.length).toBe(1);
  f.child.emit(url + "\r\n");
  expect(await started).toEqual({ verificationUrl: url, userCode: "", inputRequired: true });
}

test("private setup flow stores only a captured token and exposes no stale account label", async () => {
  const saved: ClaudeSetupToken[] = [];
  const f = fixture(async (value) => {
    saved.push(value);
  });
  try {
    await challenge(f);
    expect(f.launches[0].args).toEqual(["setup-token"]);
    expect(f.launches[0].env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBeUndefined();
    expect(f.launches[0].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(f.launches[0].env.CLAUDE_CONFIG_DIR).not.toBe(f.session.scope);
    await f.session.submitCode("synthetic-code#synthetic-state");
    expect(f.child.writes).toEqual(["\x1b[200~synthetic-code#synthetic-state\x1b[201~\r"]);
    f.child.emit(`YourOAuthtoken(validfor1year):\r\n${token}\r\n`);
    await expect.poll(() => f.completed).toEqual([true]);
    expect(saved).toEqual([{ version: 1, accessToken: token, createdAt: expect.any(Number) }]);
    expect(await f.session.readAccountLabel()).toBeNull();
  } finally {
    await f.session.dispose();
  }
});

test("success exit without token and persistence failure never report connected", async () => {
  const f = fixture(async () => {
    throw new Error(token);
  });
  try {
    await challenge(f);
    f.child.emit(`Your OAuth token (valid for 1 year):\n${token}\n`);
    await expect.poll(() => f.completed).toEqual([false]);
  } finally {
    await f.session.dispose();
  }
  const g = fixture(async () => {
    throw new Error("must not save");
  });
  try {
    await challenge(g);
    g.child.exit(0);
    expect(g.completed).toEqual([false]);
  } finally {
    await g.session.dispose();
  }
});

test("cancelled flow does not persist late output or accept code injection", async () => {
  const saved: ClaudeSetupToken[] = [];
  const f = fixture(async (value) => {
    saved.push(value);
  });
  await challenge(f);
  await expect(f.session.submitCode("code\nextra")).rejects.toThrow("could not be completed");
  await f.session.cancel();
  f.child.emit(`YourOAuthtoken(validfor1year):\n${token}\n`);
  expect(saved).toEqual([]);
  expect(f.completed).toEqual([]);
  await expect(f.session.submitCode("late")).rejects.toThrow();
});
