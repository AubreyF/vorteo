import stripAnsi from "strip-ansi";

export class ClaudeSetupTokenError extends Error {
  constructor() {
    super("Claude subscription sign-in could not be completed. Start sign-in again.");
    this.name = "ClaudeSetupTokenError";
  }
}

export interface SetupTokenOutput {
  verificationUrl: string | null;
  token: string | null;
}

/** Never forward this terminal's output: the successful command prints a bearer token. */
export class ClaudeSetupTokenOutput {
  private output = "";

  append(chunk: string): SetupTokenOutput {
    this.output += chunk;
    if (this.output.length > 256 * 1024) {
      this.clear();
      throw new ClaudeSetupTokenError();
    }
    const plain = stripAnsi(this.output);
    const link = plain.match(
      /https:\/\/(?:claude\.ai\/oauth|claude\.com\/cai\/oauth)\/authorize\?[\x21-\x7e]+(?=[\r\n\t ])/,
    );
    let verificationUrl: string | null = null;
    if (link) {
      const url = new URL(link[0]);
      // Both pinned CLIs request only inference for setup-token. A broader login is not this flow.
      const setupFlow =
        url.searchParams.get("scope") === "user:inference" &&
        url.searchParams.get("response_type") === "code" &&
        url.searchParams.has("state") &&
        url.searchParams.has("code_challenge");
      if (!setupFlow) throw new ClaudeSetupTokenError();
      verificationUrl = url.href;
    }
    // Ink emits cursor positioning between words. After ANSI removal spaces can disappear.
    // Require the completed token line, not a prefix from a split output chunk.
    const token = plain.match(
      /Your\s*OAuth\s*token\s*\(valid\s*for[^)]{1,100}\):\s*\r?\n?\s*(sk-ant-oat01-[A-Za-z0-9_-]{20,32768})(?=[\r\n])/,
    );
    return { verificationUrl, token: token?.[1] ?? null };
  }

  clear(): void {
    this.output = "";
  }
}
