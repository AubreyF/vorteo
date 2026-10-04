# Vorteo changelog

Custom changes to vorteo. Paseo's release history remains in its upstream changelog.

## 0.9.0-beta.2.vorteo.44 - 2026-10-04

### Added

- Drag a workspace onto another project in the web or desktop sidebar to recreate one selected chat with an editable handoff
- Choose the destination environment and profile before starting, with a warning when other chats would be left behind
- Keep the original workspace and its files available after recreation

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
