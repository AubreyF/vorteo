// Catalog-only provider fixture. Unexpected inference must fail.
if (process.argv.slice(2).join(" ") === "auth status") {
  process.stdout.write(JSON.stringify({ loggedIn: true }));
} else {
  process.stderr.write("Unexpected catalog fixture command\n");
  process.exitCode = 1;
}
