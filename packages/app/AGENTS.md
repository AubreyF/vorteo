# App instructions

These rules supplement the [root guide](../../AGENTS.md) for app and interface changes. Read [design](../../docs/design.md) and [QA](../../docs/qa.md) before editing UI.

## Route to the owning guide

| Change                                          | Read first                                                                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routes, startup, remembered or active workspace | [Expo Router](../../docs/expo-router.md)                                                                                                                        |
| Forms, menus, popovers or styles                | [Forms](../../docs/forms.md), [menus](../../docs/menus.md), [floating panels](../../docs/floating-panels.md), [Unistyles](../../docs/unistyles.md), as relevant |
| Hover interactions                              | [Hover](../../docs/hover.md), with the native/touch rule below                                                                                                  |
| Mobile panels or sidebar                        | [Mobile panels](../../docs/mobile-panels.md), [explorer sidebar](../../docs/explorer-sidebar.md)                                                                |

## Platform behavior

The app runs on iOS, Android, browser web and Electron. Default to cross-platform code.

| Need                            | Use                                                  |
| ------------------------------- | ---------------------------------------------------- |
| DOM or browser APIs             | `isWeb` from `@/constants/platform`                  |
| Native APIs                     | `isNative` from `@/constants/platform`               |
| Desktop bridge or Electron APIs | `getIsElectron()` from `@/constants/platform`        |
| Compact or wide layout          | `useIsCompactFormFactor()` from `@/constants/layout` |

- Guard DOM access with `isWeb`; never redefine platform gates locally. Use `Platform.OS` only for a specific OS requirement, not as a layout proxy.
- Prefer `.web.*` and `.native.*` modules for substantially different implementations. Use `.electron.*` for Electron-only behavior; Electron resolves those before `.web.*`. Keep inline gates small.
- Pointer and hover events do not provide native touch access. Essential controls must remain visible on native and compact layouts, such as `isHovered || isNative || isCompact`. The hover guide's pointer pattern is for web; do not rely on it on native.

## Vorteo behavior and delivery

- Vorteo has one product behavior. Do not add Paseo or Standard mode switches, saved product-mode preferences, or alternate rendering branches. Preserve runtime capability checks, permissions and platform differences.
- Settings belong to the installation. Profiles and other shared resource definitions are independent of environments; explicit exclusions control where they are available. Credentials, paths and running work retain their environment ownership.
- Detect touch independently of width. Keep essential actions visible without hover, primary targets at least 44 CSS pixels, and hover cards from intercepting navigation taps. Preserve pinch zoom, keyboard focus, scrolling and independently selectable permissions.
- Verify the single product behavior on desktop and compact layouts, run focused tests and deliver authorized interface changes to the existing primary installation through [instance continuity](../../docs/instance-continuity.md). Respect the root restart-permission rule and the user's requested delivery stage.
- Publish each coherent, validated interface revision while continuing queued work. Tell the owner when a reload will show it. Prefer static web publication without restarting Host or Dev. If static publication is unavailable, follow the root guide’s managed Host source-update fallback instead of stopping at a handoff. Submit validated source for exact installation approval; never substitute a plain restart for an update.
- Ask for physical-device verification when emulation cannot prove behavior. Never launch macOS Playwright WebKit.

## Conversation card layout contract

- Use `TaskCard` and its direct `TaskCardHeader` child for every conversation card. The shared component owns the 12px outer inset, 20px heading icon column, 32px desktop or 44px touch heading, and vertical centering. Do not add card-specific header padding, top margins, wrapping or height overrides.
- Pass `TaskCardIcon` (or the same 20px task flower) into `CardDisclosure`, followed by its title, arrow and count. The disclosure includes the icon and fills all available heading whitespace before separate actions; use its trailing slot for passive status. Use `TaskCardTitle` for headings without a disclosure. Use `TaskCardAction` for every right-side heading control, including icon-only and info buttons. It owns the outlined border, radius, typography and 32px desktop / 44px touch sizing; do not add local style or variant overrides. Use `TaskCardInfo` for heading explanations. Group multiple controls with `TaskCardActions`; never offset them independently. Keep long prompts and navigation in the scrollable body.
- Sub-agent rows stay on one line with metadata immediately before their actions, without horizontal separators. Keep transient status in the heading and the fixed heading outside the scroll body.
- UI changes to these cards must pass the rendered geometry checks in `e2e/browser/scrolling-agent-cards.spec.ts` at desktop and compact widths. Extend those checks when adding a card. Inspect screenshots before delivery; do not update expectations merely to accommodate drift.
