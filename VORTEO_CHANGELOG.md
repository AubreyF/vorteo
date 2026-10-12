# Vorteo changelog

Vorteo change history, covering features, fixes, documentation, tests, tooling and upstream integration. Update this file in every commit using the prepared version and a dated entry. See the [commit workflow](docs/release.md#vorteo-release-notes).

The initial baseline is cumulative; older entries do not cover every maintenance commit. Historical version labels are preserved. Paseo release history remains in the [upstream changelog](CHANGELOG.md); the [customizations inventory](docs/vorteo-customizations.md) describes current fork capabilities and limitations.

## 0.11.0-beta.3.vorteo.344 - 2026-10-12

### Maintenance

- Preserve the published responsive sidebar and workspace transition changes alongside owner-controlled automatic daemon maintenance. Retain both source histories and their release notes.

## 0.11.0-beta.3.vorteo.343 - 2026-10-12

### Maintenance

- Integrate the current published readable task status and journal context changes with stable workspace card transitions, responsive sidebars and floating tabs. Preserve both source histories and lifecycle boundaries.

## 0.11.0-beta.3.vorteo.342 - 2026-10-12

### Fixed

- Keep desktop conversation cards in their right-hand dock from the first workspace render. Seed shell geometry from the viewport and retain valid measurements while workspaces are hidden, eliminating the temporary inline placement during navigation.
- Animate card height and opacity without positional transforms or text scaling. Ignore hidden zero-sized measurements so retained cards do not restart from collapsed dimensions.
- Preserve the published Factory history admission correction and canonical c19f source ancestry alongside the responsive sidebars and floating workspace tabs.

## 0.11.0-beta.3.vorteo.341 - 2026-10-12

### Changed

- Adapt sidebars as the viewport changes: close the right-hand cards first, reduce the left sidebar to its project rail next, and use hidden navigation on phone widths. Restore the left sidebar before the right as space returns.
- Preserve saved widths and manual collapse preferences. Explicit opens remain available until the next width change, including Files and Changes navigation.

## 0.11.0-beta.3.vorteo.340 - 2026-10-12

### Changed

- Remove the desktop workspace title row and tab-strip rule. Put the focused environment beside the right-toolbar toggle and let the conversation meet the tabs directly.
- Make workspace tabs taller and wider, with adaptive shrinking and fully rounded corners. Give only the foreground tab the same floating surface, border and shadow as the Latest button.

## 0.11.0-beta.3.vorteo.339 - 2026-10-12

### Maintenance

- Integrate the published coordinator recovery controls with the new sidebar layouts, unified workspace toolbars and compact card actions. Preserve both source histories and existing approval boundaries.

## 0.11.0-beta.3.vorteo.338 - 2026-10-12

### Changed

- Use cleaning icons for card cleanup actions, with tooltips explaining what is deleted or hidden. All shared card-header icon actions provide labeled tooltips.
- Reduce the vertical gap between supporting cards to 8px while preserving column gutters and scroll allocation.
- Combine workspace actions and pane splitting in the primary-content menu. Keep run, preview and other actions at the right edge of the supporting toolbar, and move its collapsed toggle beside the content menu. Use vertical three-dot menus.

## 0.11.0-beta.3.vorteo.337 - 2026-10-12

### Changed

- Cycle the sidebar toolbar button and keyboard shortcut through expanded, compact labeled and minimal rail layouts. Remove the separate Compact button row, remember the layout on this device and retain the expanded resize width.
