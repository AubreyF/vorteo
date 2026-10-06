# Vorteo changelog

Custom changes to vorteo. Paseo's release history remains in its upstream changelog.

## 0.11.0-beta.3.vorteo.125 - 2026-10-05

### Changed

- Simplify the profile chooser with Host first, environment risk descriptions, matching tile heights and rounded orange selection borders
- Move Activate Profile and Switch to Profile below the scrolling profile card and hide the action for the active selection
- Remove account search and restore the ghost Manage profiles button
- Show the selected profile name in the closed chooser instead of always showing Choose profile

## 0.11.0-beta.3.vorteo.124 - 2026-10-05

### Changed

- Keep the selected project when choosing a profile from another environment, without selecting or adding the project again
- Move a workspace and all its chats to any project while preserving its history, environment and working directory

## 0.11.0-beta.3.vorteo.123 - 2026-10-05

### Changed

- Show messages waiting to synchronize as standard queue rows with a warning icon and a “Queued on this device” tooltip

## 0.11.0-beta.3.vorteo.122 - 2026-10-05

### Changed

- Choose Host or Dev container in the profile switcher without a duplicate dropdown above the New workspace composer

## 0.11.0-beta.3.vorteo.121 - 2026-10-05

### Fixed

- Match accordion header hover height to card rows, with shared header sizing for subagents, goals, tasks and queued messages.

## 0.11.0-beta.3.vorteo.120 - 2026-10-05

### Changed

- Added expanding and collapsing chevrons to installation history, shared workflows, password help, and request details

## 0.11.0-beta.3.vorteo.119 - 2026-10-05

### Fixed

- Show shared skill packages once per environment with combined provider labels
- Keep each discovery path available in Details for inspection and reviewed changes

## 0.11.0-beta.3.vorteo.118 - 2026-10-05

### Added

- Create a workspace or add a project in the destination environment directly from a profile handoff
- Select the matching project automatically when continuing between host and container workspaces

## 0.11.0-beta.3.vorteo.116 - 2026-10-05

### Changed

- Moved installation controls into General settings with visible host and container approval status, restart progress, and inline confirmation
- Kept restart history, password help, and shared workflows available inline without opening a modal

## 0.11.0-beta.3.vorteo.114 - 2026-10-05

### Fixed

- Restored orange selected outlines and left-side checks in the profile selector
- Show saved profiles and their model and reasoning summaries without overriding them with current chat settings
- Omit disabled accounts and keep account connection buttons in Settings
- Remove the header divider and match desktop outer padding to column gaps
- Label the composer dropdown Choose profile to match its menu title

## 0.11.0-beta.3.vorteo.113 - 2026-10-05

### Fixed

- Made the cross-environment skill library directly accessible from Settings > Skills on wide and compact layouts

## 0.11.0-beta.3.vorteo.111 - 2026-10-05

### Fixed

- Fixed native top toolbar blur in newly installed iOS Home Screen apps without extra toolbar padding
- Kept the toolbar visible after keyboard dismissal by sizing Home Screen apps to their available viewport

## 0.11.0-beta.3.vorteo.110 - 2026-10-05

### Fixed

- Limited restart approvals to one current request per environment and moved expired and completed requests into collapsed history
- Allowed installation restart checks to wait for slower daemon connections and provider status responses

### Changed

- Moved the sidebar three-dot menu before History, Schedules, and Settings

## 0.11.0-beta.3.vorteo.108 - 2026-10-05

### Fixed

- Kept text in place when scrolling upward past an image whose measured height shrinks

## 0.11.0-beta.3.vorteo.106 - 2026-10-05

### Fixed

- Applied profile exclusions to equivalent skill copies with different provenance records and refused newly conflicting Claude selectors on resume

## 0.11.0-beta.3.vorteo.105 - 2026-10-05

### Added

- Added a shared skills inventory with environment status, instruction details, hashes, provenance and audit export
- Added reviewed pinned installations, provider discovery links, duplicate consolidation, removal and restoration with conflict checks
- Added profile skill inheritance with exclusions, selected-only and no-optional modes with frozen selections for supported Claude and Codex runtimes

## 0.11.0-beta.3.vorteo.103 - 2026-10-05

### Changed

- Kept Search as a left-aligned icon and placed History, Schedules, Settings and More on the right
- Added Option+Space alongside Command+K as the default macOS Search shortcuts, with configured shortcuts in the tooltip

## 0.11.0-beta.3.vorteo.102 - 2026-10-05

### Changed

- Choose environments, provider accounts and profile details in three desktop cards or collapsible mobile sections
- Compact outline Search and Manage profiles controls, with mobile management in Settings
- Matching green Dev container and gold Host icons, with provider icons beside accounts

### Added

- Reviewed handoffs with a destination workspace picker when continuing a chat in another environment

## 0.11.0-beta.3.vorteo.101 - 2026-10-05

### Fixed

- Matched bottom card and composer borders and corners to question cards, and removed excess space below subagent rows

## 0.11.0-beta.3.vorteo.100 - 2026-10-05

### Changed

- Continued Vorteo numbering across upstream Paseo updates, accounting for 99 prior version increments
- Interleaved Vorteo and Paseo release notes by date with source labels and one Show more control

## 0.11.0-beta.3.vorteo.17 - 2026-10-05

### Fixed

- Added a prominent Download button when a binary file cannot be previewed in Vorteo mode

## 0.11.0-beta.3.vorteo.14 - 2026-10-05

### Changed

- Tightened sidebar Search corners, added space before History, and aligned the settings Back outline button with Search
- Kept History and Schedules visible, removed Usage from the sidebar, and removed Sidebar preferences in Vorteo mode

## 0.11.0-beta.3.vorteo.13 - 2026-10-05

### Fixed

- Keep draft accounts and workflows together when reopening or restoring a task. Wait for account selection to load before applying its default workflow.
- Unified spacing between question, approval, subagent, task, queue and goal cards above the message box

## 0.11.0-beta.3.vorteo.10 - 2026-10-05

### Fixed

- Saved installation owner access reliably on Windows
- Preserved Vorteo application naming in Darwin Nix desktop packages

## 0.11.0-beta.3.vorteo.8 - 2026-10-05

### Changed

- Integrated the upstream update with the published browser tooling, workspace recreation and installation instructions
- Documented plugin usage sources and pinned usage windows alongside Vorteo account controls

### Added

- Owner access that survives reloads for seven days per browser, with explicit locking and separate approval for every restart

### Fixed

- Revoked Hub execution authority before waiting for daemon shutdown tasks
- Included custom release notes in Nix builds

## 0.11.0-beta.3.vorteo.3 - 2026-10-04

### Changed

- Integrated Paseo's plugin registry, usage sources, provider updates and mobile improvements
- Preserved Vorteo account, profile, goal, quota and installation workflows with the updated client and daemon

### Fixed

- Kept goal permission updates consistent with the selected workflow
- Preserved account usage in context details for Vorteo hosts

## 0.9.0-beta.2.vorteo.45 - 2026-10-05

### Added

- Chromium libraries and fonts in new container builds, with setup and browser checks for existing Debian 12 development containers

### Fixed

- Disposable browser-test daemons no longer inherit the installation password unless a test explicitly supplies one

## 0.9.0-beta.2.vorteo.44 - 2026-10-04

### Added

- Drag a workspace onto another project in the web or desktop sidebar to recreate one selected chat with an editable handoff
- Choose the destination environment and profile before starting, with a warning when other chats would be left behind
- Keep the original workspace and its files available after recreation

### Changed

- Remembered owner access for seven days per browser, with an explicit Lock controls action
- Showed the generated owner password's recovery path and explained its origin and trust boundary
- Kept restart approval separate from unlocking and restoring owner access
- Added a direct link to Installation controls and matched its cards to Settings
- Replaced sidebar environment subtitles with a golden host and key icon before host titles
- Improved spacing between the host icon and the message profile selector label

## 0.9.0-beta.2.vorteo.43 - 2026-10-04

### Added

- Added Vorteo release notes alongside Paseo's upstream notes in What's new
- Bundled Vorteo's release history with the app so it remains available offline

### Changed

- Changed new custom version suffixes from `vorton` to `vorteo`, preserving the existing counter

## 0.9.0-beta.2.vorton.42 - 2026-10-04

### Changed

- Reorganized Installation settings around environment status and owner access
- Explained owner access requirements beside installation controls

## 0.9.0-beta.2.vorton.40 - 2026-10-03

This baseline summarizes custom features and fixes present through this version, including earlier Vorteo builds.

### Accounts and profiles

- Added multiple isolated Codex and Claude accounts with account switching per task
- Added browser sign-in, reconnect, rename, disable and removal for subscription accounts
- Added account usage and reset times beside profiles
- Added reusable profiles with model, reasoning, permissions and instructions
- Shared provider preferences across sibling accounts and protected installation environments
- Added editable context handoffs when switching profiles on an existing task
- Added discovered Pi model details and local worker connection status
- Preserved migrated workflow identities and local worker teams

### Agent workflows

- Added native goals with optional token budgets, progress, pause and resume controls
- Added durable message queues with attachments, reordering and cross-device editing
- Preserved unsaved queue text and attachment edits across reloads
- Separated queue pausing from stopping an active goal
- Added bounded local worker teams for Pi profiles
- Added schedule quota admission and recovery

### Installation and updates

- Added container installation with private HTTPS access and optional custom domains
- Added protected native host execution with owner-approved installation restarts
- Added private workspace previews and shared host folders
- Added source update checks and editable host update and upstream merge tasks
- Preserved installation connections across reloads and domain migration

### Interface

- Added Vorteo branding and app icons
- Added customizable sidebar navigation and task activity badges
- Added compact account pickers and touch controls for phones and tablets
- Added iOS Home Screen toolbar clearance below the system status-bar blur
- Returned archived workspaces to the empty New workspace page
