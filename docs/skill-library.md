# Skill library

Open **Settings > Skills** to manage the shared personal catalog. The same library is also available from **Skill library** under Agents settings. Add or update a definition once for the installation. Environment exceptions control where it is available.

Choose **Inspect environment inventory** to diagnose installed copies. Filter by name, provider, ownership, or environment. Offline results show their observation time. Add a project directory to include that project's skill roots.

Paths that resolve to the same inspected package appear in one row per environment with combined provider labels. Details lists the discovery paths and lets you select the path to inspect or manage. Filtering by a provider retains all paths in its group. Separate physical copies, different versions, and observations with inspection problems remain separate.

Shared Details shows the stored package contents and executable permissions. Inventory details show instructions, file hashes, package hash, source revision when recorded, resolved discovery links, and inspection problems. **Copy audit** copies that environment's inventory. **History** records local library changes.

## Ownership and consolidation

Keep one canonical copy of each portable personal package per environment, normally under `~/.agents/skills`. Add reviewed discovery links for providers that use their own skill directories. A container owns its own package copy. Do not share writable host instructions through a container mount.

Provider system skills and plugin packages stay in their provider or plugin installation. Their placement under a provider directory expresses who updates and owns them. Moving them into personal storage can break updates and discovery. The library inventories these packages but does not manage or consolidate them. Vorteo orchestration and installation skills also retain their existing owner.

To consolidate personal copies, open Details and choose an identical canonical package. The preview compares the complete inspected package contents. Applying the change retains the original and replaces that discovery location with a link. Different versions remain separate for review. A package referenced by another discovery link cannot be removed until those links are removed.

## Install, update, and restore

Choose **Add skill**. Enter a GitHub repository, full commit SHA, and skill directory. Review the package files and executable permissions, then choose **Save shared skill**. Packages are limited to 256 files and 4 MiB; internal links and unsupported file types are refused. Installation does not execute package scripts or configure credentials.

Choose **Update** to review another commit of the same repository and directory. The review includes deleted files and permission changes. Imported packages without recorded provenance remain inspectable; a new source must be added explicitly. A stale settings revision rejects the save and retains the draft. Review again to incorporate current settings. An expired owner session also retains the draft so you can unlock and retry.

Projection writes each environment's personal copy and provider discovery links. Existing unmanaged packages and intervening local edits are preserved for review. Retained originals and an interrupted-operation journal support recovery without silently discarding new local edits. To restore a sourced definition, review and save its previous commit through the shared catalog.

Removing a shared definition retains installed files and existing task snapshots. New supported-provider launches filter personal packages against the remaining catalog. Local inventory controls cannot remove or restore a managed shared definition independently.

Each environment applies and records changes independently. A success on one environment does not imply success elsewhere. Source receipts identify recorded provenance; they are not signatures or a security certification. Filesystem discovery does not establish provider activation, invocation, dependency availability, or credential readiness. Remote and account-specific provider catalogs may contain additional skills.

## Package transfer contract

Daemons advertising `skillPackageTransfer` can export inspected personal packages and preview
imports through the skill library RPCs. Transfers contain file bytes, executable flags, a content
hash, and recorded source provenance. They contain no environment paths. Import validates the
whole package before staging it, and apply uses the existing preview conflict checks and backups.
Identical personal copies can be adopted after review. Different unmanaged contents, changed local
files, discovery links, and conflicting source identities are preserved for explicit resolution.
Provider, plugin, project, and installation-owned packages cannot be exported through this operation.

Shared catalog management also requires `installationSettingsAuthority`. This capability includes
fresh coordinator checks for personal package edits and new managed task launches. The coordinator
checks both capabilities before migrating or projecting a daemon's settings.

The installation coordinator keeps personal definitions in the shared settings catalog. Verified
package content stays in private installation storage, addressed by its hash. Settings responses
contain identity and provenance, not file bytes or environment paths. Initial migration retains
unique packages from both environments. Different versions and colliding directory names require
review. Older journals wait for both inventories before adding the catalog and preserve existing
shared policy.

The owner preparation endpoint accepts a repository, full commit SHA and skill directory. It
downloads and validates the package once, retains its content privately, and returns the definition
and file bytes for review. Preparation does not edit the catalog or install files in an environment.
A separate revision-checked settings update saves the reviewed definition before projection.

Projection uses the same preview, backup, and apply operations as local library changes. It installs
missing packages and Claude discovery links, then verifies both Codex and Claude discovery. Local
edits or conflicting copies leave the projection pending. Later daemon observations never become
canonical catalog edits.
Applying a personal package change on a managed installation requires a fresh coordinator check.
The preview must match the current definition's content and provenance. Stale previews and
offline authority checks leave local files unchanged. Local removal cannot delete retained shared
packages; availability changes belong to the shared catalog.

## Environment exceptions

In **Settings > Environments**, turn off a personal skill to exclude it from that environment.
Shared definitions remain available in the other environments by default. Exclusions retain
installed files and discovery links so existing tasks can keep their recorded selections.

New tasks read the current installation policy before launch, including tasks created without a
profile. A profile cannot enable a skill excluded from its environment. Matching personal copies
share the exclusion even if their recorded identities differ. Missing approved content prevents
an inherited launch until projection succeeds. An unavailable coordinator prevents new managed
launches; existing tasks keep their frozen selections.

Claude and supported Codex versions enforce exclusions through session skill filters. Other
providers reject launches with environment skill exclusions rather than claiming to enforce them.
These controls govern skill discovery and invocation, not filesystem access or tool permissions.

## Profile policies

A profile can inherit provider defaults with exclusions, allow only selected skills, or disable optional skills. Policies refer to package identities rather than display names. Recorded source packages keep their identity across updates; packages without provenance use content identity, so editing them requires selecting their new identity.

Restricted tasks capture package paths and hashes at creation. Their selection survives profile edits and resumption. If a selected package changes, restore its recorded content or create a new task. Concurrent profiles do not change global provider settings. Unrestricted inherited defaults keep the provider's normal behavior.

Session filtering uses Claude's SDK skill allowlist and Codex's path-specific skill configuration. Codex requires version 0.159.2 or later. Other providers refuse restrictive policies. Missing packages, ambiguous selectors, incomplete discovery, and unsupported plugin selectors also prevent a restricted launch. Inheritance with exclusions queries the provider's default skill catalog before freezing its selection. Account-specific packages that cannot be matched to the inventory require an explicit discovery adapter before they can be selected.

Skill selection controls instruction discovery and invocation. It does not revoke Read, Bash, network, or other tool permissions. Keep those permissions in the profile's permission controls. Provider instructions and the environment's authority rules remain separate.
