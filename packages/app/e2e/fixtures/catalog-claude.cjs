// Catalog-only provider fixture. Unexpected inference must fail.
if (process.argv.includes("--version")) {
  process.stdout.write(`${process.env.CATALOG_CLAUDE_VERSION || "2.1.285"} (Claude Code)\n`);
} else if (process.argv.slice(2).join(" ") === "auth status") {
  process.stdout.write(JSON.stringify({ loggedIn: true }));
} else {
  process.stderr.write("Unexpected catalog fixture command\n");
  process.exitCode = 1;
}
