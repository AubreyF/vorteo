// Catalog-only provider fixture. Unexpected inference must fail.
if (process.argv.includes("--version")) {
  process.stdout.write(`${process.env.CATALOG_CLAUDE_VERSION || "2.1.285"} (Claude Code)\n`);
} else if (process.argv.slice(-2).join(" ") === "auth status") {
  // With a saved setup token the check passes --settings first and expects a first-party OAuth
  // login, so answer as one either way.
  process.stdout.write(
    JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" }),
  );
} else {
  process.stderr.write("Unexpected catalog fixture command\n");
  process.exitCode = 1;
}
