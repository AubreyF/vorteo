# Skill library

In Vorteo mode, open **Settings > Skills**. The same library is also available from **Skill library** under an environment's Agents settings. The library groups observations from your connected environments in one view. Filter by name, provider, ownership, or environment. Offline results show their observation time. Add a project directory to include that project's skill roots.

Paths that resolve to the same inspected package appear in one row per environment with combined provider labels. Details lists the discovery paths and lets you select the path to inspect or manage. Filtering by a provider retains all paths in its group. Separate physical copies, different versions, and observations with inspection problems remain separate.

Details show instructions, file hashes, package hash, source revision when recorded, resolved discovery links, and inspection problems. **Copy audit** copies that environment's inventory. **History** records library changes and offers restoration of retained previous packages.

## Ownership and consolidation

Keep one canonical copy of each portable personal package per environment, normally under `~/.agents/skills`. Add reviewed discovery links for providers that use their own skill directories. A container owns its own package copy. Do not share writable host instructions through a container mount.

Provider system skills and plugin packages stay in their provider or plugin installation. Their placement under a provider directory expresses who updates and owns them. Moving them into personal storage can break updates and discovery. The library inventories these packages but does not manage or consolidate them. Vorteo orchestration and installation skills also retain their existing owner.

To consolidate personal copies, open Details and choose an identical canonical package. The preview compares the complete inspected package contents. Applying the change retains the original and replaces that discovery location with a link. Different versions remain separate for review. A package referenced by another discovery link cannot be removed until those links are removed.

## Install, update, and restore

Choose **Install** for the desired environment. Enter a GitHub repository, full commit SHA, and skill directory. Review every proposed file before applying. Packages are limited to 256 files and 4 MiB; internal links and unsupported file types are refused. Installation does not execute package scripts or configure credentials.

Installation writes a canonical personal package. Use Details to preview provider discovery links. To update a library-managed package, inspect another commit of the same repository and directory. Existing unmanaged packages are preserved. Changes made after a preview invalidate it. Retained originals and an interrupted-operation journal support recovery without silently discarding new local edits.

Each environment applies and records changes independently. A success on one environment does not imply success elsewhere. Source receipts identify recorded provenance; they are not signatures or a security certification. Filesystem discovery does not establish provider activation, invocation, dependency availability, or credential readiness. Remote and account-specific provider catalogs may contain additional skills.

## Profile policies

A profile can inherit provider defaults with exclusions, allow only selected skills, or disable optional skills. Policies refer to package identities rather than display names. Recorded source packages keep their identity across updates; packages without provenance use content identity, so editing them requires selecting their new identity.

Restricted tasks capture package paths and hashes at creation. Their selection survives profile edits and resumption. If a selected package changes, restore its recorded content or create a new task. Concurrent profiles do not change global provider settings. Unrestricted inherited defaults keep the provider's normal behavior.

Session filtering uses Claude's SDK skill allowlist and Codex's path-specific skill configuration. Codex requires version 0.159.2 or later. Other providers refuse restrictive policies. Missing packages, ambiguous selectors, incomplete discovery, and unsupported plugin selectors also prevent a restricted launch. Inheritance with exclusions queries the provider's default skill catalog before freezing its selection. Account-specific packages that cannot be matched to the inventory require an explicit discovery adapter before they can be selected.

Skill selection controls instruction discovery and invocation. It does not revoke Read, Bash, network, or other tool permissions. Keep those permissions in the profile's permission controls. Provider instructions and the environment's authority rules remain separate.
