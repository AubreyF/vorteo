# Publication hygiene

Public source contains reusable code and examples. Keep installation state outside the checkout: actual environment files, populated credential directories, Tailscale identity state, hostnames and device IDs, machine paths, account inventories, workspace IDs, deployment receipts and backups. An ignored file is not protected if it was already tracked, copied into another file or included in an earlier commit.

Before publishing, verify the repository's current visibility and destination. Review the staged files and all outgoing history. Run `npm run security:secrets` with Gitleaks 8.30.1 installed. This checks reachable history using the repository rules. The pre-push hook runs the same check and fails if the scanner is unavailable. CI runs it independently on a complete checkout. Findings are redacted. The only exceptions are exact public test vectors, one historical generated-code expression and five pre-existing upstream address examples limited to their original files and commits; do not add broad file or commit exclusions to silence a finding.

The normal workflow checks credentials, not every kind of personal information. Review documentation and configuration examples manually. Never print a token to investigate a match, run live credential verification against third parties, or upload a private scan report to a public issue or CI artifact.

## If data was committed

Preserve active work and a private backup first. Remove the material from every affected branch and tag, including historical versions. Use an isolated rewrite rather than resetting an active checkout. Re-scan both the candidate tree and rewritten history, then publish with explicit expected-old-revision checks. Retain unrelated work and upstream history.

If a real credential was published, revoke or rotate it through its provider. Rewriting Git history does not revoke a credential or erase other clones, forks, cached commits, pull-request views, build artifacts or registry layers. Follow the hosting provider's sensitive-data removal process for those surfaces. Do not claim a scan proves that no possible secret exists or that previously published information has been erased everywhere.

Keep audit evidence privately: tool versions, scope, redacted findings and their disposition, rewritten ref mapping, validation results and any remaining hosting-provider action. Do not copy an installation incident report into public documentation.
