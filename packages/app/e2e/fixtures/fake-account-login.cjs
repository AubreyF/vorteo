const fs = require("node:fs");
const path = require("node:path");
const credential = path.join(process.env.CLAUDE_CONFIG_DIR, "signed-in");
const args = new Set(process.argv.slice(2));
if (args.has("status")) {
  // A setup-token account launches with its saved token (7c8e78ac7); a full sign-in account
  // relies on the CLI's own login for its CLAUDE_CONFIG_DIR.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.startsWith("sk-ant-oat01-")) {
    console.log(
      JSON.stringify({
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
      }),
    );
    process.exit(0);
  }
  const loggedIn = fs.existsSync(credential);
  console.log(JSON.stringify({ loggedIn }));
  process.exit(loggedIn ? 0 : 1);
}
if (args.has("setup-token")) {
  // The daemon runs setup-token in a terminal, pastes the code in bracketed-paste markers and
  // reads the inference-only token from the output.
  process.stdout.write(
    "https://claude.com/cai/oauth/authorize?code=true&scope=user%3Ainference&response_type=code&state=browser-fixture&code_challenge=fixture\r\n",
  );
  process.stdin.once("data", (input) => {
    const code = input
      .toString()
      .replaceAll("\u001b[200~", "")
      .replaceAll("\u001b[201~", "")
      .trim();
    if (code !== "browser-test-code") process.exit(1);
    process.stdout.write(
      "Your OAuth token (valid for 1 year):\r\nsk-ant-oat01-browserfixturetoken0123456789\r\n",
    );
    setTimeout(() => process.exit(0), 100);
  });
} else if (args.has("login")) {
  console.log("https://claude.com/cai/oauth/authorize?state=browser-fixture");
  process.stdin.once("data", (input) => {
    if (input.toString().trim() !== "browser-test-code") process.exit(1);
    fs.writeFileSync(credential, "signed-in");
    process.exit(0);
  });
} else {
  process.exit(1);
}
