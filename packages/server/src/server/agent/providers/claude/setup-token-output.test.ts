import { expect, test } from "vitest";
import { ClaudeSetupTokenOutput } from "./setup-token-output.js";

const token = `sk-ant-oat01-${"synthetic".repeat(8)}`;
const url =
  "https://claude.com/cai/oauth/authorize?scope=user%3Ainference&response_type=code&state=synthetic&code_challenge=synthetic";

test("reads the private setup-token terminal across split chunks and OSC hyperlinks", () => {
  const parser = new ClaudeSetupTokenOutput();
  expect(parser.append(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07\r\n`).verificationUrl).toBe(url);
  expect(parser.append("YourOAuthtoken(validfor1year):\r\n" + token.slice(0, 30)).token).toBeNull();
  expect(parser.append(token.slice(30)).token).toBeNull();
  expect(parser.append("\r\nStore this token securely.").token).toBe(token);
  parser.clear();
  expect(parser.append("unrelated output")).toEqual({ verificationUrl: null, token: null });
});

test("does not accept echoed tokens, API keys or broader OAuth authorization", () => {
  expect(new ClaudeSetupTokenOutput().append(token + "\n").token).toBeNull();
  expect(
    new ClaudeSetupTokenOutput().append(
      "Your OAuth token (valid for 1 year):\nsk-ant-api01-synthetic\n",
    ).token,
  ).toBeNull();
  expect(() =>
    new ClaudeSetupTokenOutput().append(url.replace("user%3Ainference", "user%3Aprofile") + "\n"),
  ).toThrow("could not be completed");
});

test("oversized output fails without including captured secret material", () => {
  const parser = new ClaudeSetupTokenOutput();
  parser.append(token);
  expect(() => parser.append("x".repeat(256 * 1024))).toThrow(
    /^Claude subscription sign-in could not be completed\. Start sign-in again\.$/,
  );
  expect(parser.append("safe").token).toBeNull();
});
