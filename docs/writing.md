# Writing documentation

Keep one owner for each subject. Update the section that became wrong, delete obsolete claims and link from other docs. Explain constraints, decisions and cross-package gotchas; keep implementation details beside the code. Use the [docs index](README.md) to find the owner and register new subjects there.

## Maintain the product README

The root [README](../README.md) describes shipped features for developers deciding whether to use Vorteo. Review it when adding, changing or removing user-facing behavior. Update it in the same change when the overview or onboarding changes; put feature details and minor refinements in [Vorteo customizations](vorteo-customizations.md). Explain an unchanged README in the completion report.

- Verify implementation, tests and delivery status before claiming availability. Keep planned work in the roadmap and do not advertise source-only work awaiting deployment as shipped.
- Describe user workflows and outcomes. Give accounts, switching and profiles appropriate prominence alongside other capabilities. Keep storage and protocol details in their owning docs.
- Keep each Power Tools item to one short paragraph. Omit minor controls, search shortcuts, visual measurements and release-by-release refinements from the overview.
- Integrate features into the relevant section. Keep the overview balanced, credit inherited upstream Paseo capabilities and verify comparisons with other products.
- Preserve working onboarding instructions and author-created media unless the user requests a change. Keep the account-switching animation beside the profile overview, retain its original asset URL and verify it still animates when editing that section. Report broken media; do not silently remove it or substitute a still image.
- Check changed links and read the finished README for repetition and stale claims. Link the update in the completion report, or state why none was needed.

## Maintain the Vorteo customizations inventory

[Vorteo customizations](vorteo-customizations.md) owns the cumulative inventory of differences from Paseo. Keep it extensive as functionality grows. The changelog owns release history; the roadmap owns future work; subject guides own operating instructions and implementation constraints.

Update the inventory in every commit without waiting for a separate user request. Add, revise or remove the affected entries and update the maintenance review with the scope and result. For documentation, tests or tooling changes with no feature impact, record that result in the maintenance review instead of inventing a feature. Use the review as a current checkpoint, not a second chronological changelog.

Group features by category. Order categories by user impact and every bullet list within each category from most significant to least significant. Keep major workflows above minor interface refinements. Consolidate related details rather than appending a new bullet for each fix. Link to owning guides and relevant implementation or tests, and distinguish implemented behavior, source awaiting publication, incomplete integration and planned work. Keep installation-specific deployment receipts outside Git.

For every upstream merge, inspect the incoming source, tests and release notes against this inventory. Record the reviewed upstream commit or release in the upstream comparison section. Identify full parity, partial overlap and remaining differences; update existing claims and credit inherited features. If upstream fully covers a customization, move its entry into the comparison section as upstream-provided. If overlap is partial, retain only the remaining custom behavior as a differentiator. Link evidence and record any retirement work in the roadmap after checking compatibility. Documentation changes do not authorize deleting working custom code.

Review the roadmap whenever delivery or upstream overlap changes a priority. Remove completed implementation tasks, retain unresolved acceptance as acceptance work, and keep detailed designs in their linked plans. Do not infer deployment from source or carry forward old installation status without evidence.

## Voice and publication

Use plain, short sentences and second person. State the rule, then its reason when needed. Preserve useful specifics and the author's voice. Cut repeated explanations, hype, throat-clearing, vague hedges and setup-and-punchline contrasts. Avoid “honest”, “robust”, “seamless”, “powerful”, “simply”, “just” and “delightful”.

Use reusable instructions and placeholders. Keep real deployment paths, hostnames, device IDs, account inventories, credentials, backups and acceptance receipts outside Git. Follow [publication hygiene](publication-hygiene.md) before publishing or rewriting history.
