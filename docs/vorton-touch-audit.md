# Vorteo touch usability audit

September 10, 2026. Scope: sidebar navigation and workspace actions, footer overflow, dropdowns, tooltips, appearance, keyboard focus, viewport height, and existing configuration launch gates.

## Changes

- Detect coarse pointer capability independently of viewport width. A wide iPad must not receive desktop hover interactions merely because its viewport is wide.
- Keep workspace creation and row actions visible on touch devices. Prevent workspace hover cards and tooltip triggers from intercepting the first tap intended for an action.
- Give semantic controls and dropdown triggers minimum 44 CSS pixel targets. Sidebar rows and their action buttons use that minimum on touch devices and in narrow windows with the full-screen sidebar. Increase the hitboxes themselves, preserving the spacing between rows. Reserve space for trailing actions and increase footer slot spacing, preserving overflow icons.
- Apply a minimum UI base font size of 16 and message font size of 17 on Vorteo touch devices. Preserve larger user settings and restore saved sizes when disabled. Input text has a 16 pixel minimum.
- Provide visible keyboard focus and retain pinch zoom. Use dynamic viewport height in browser tabs and the large viewport in standalone mode. Preserve Apple installation metadata; runtime removal did not establish a fix for the reported iPhone gap.
- Keep informational tooltips tappable. Touch pointer exit must not immediately dismiss them. Action tooltips remain bypassed so navigation takes one tap.
- The September 10 layout kept preset and permission selectors on one row. Current Vorteo permissions live in the profile editor; use [launch presets](agent-presets.md) for the current control placement. The measurements below describe that historical build.
- Separate dictation from submit with a 44 pixel outlined microphone at the top right of the message field. The recording panel fills the existing composer footprint; edit occupies the microphone position, cancel stays bottom left, and submit stays bottom right. Keep its passive volume display out of button hit testing. Hide the desktop focus hint on touch devices; the browser does not provide reliable hardware-keyboard presence detection.
- On compact Vorteo touch layouts, separate messaging from the conversation with a full-width top rule. The idle input has no visible outline, rounded container, or contrasting background. Keep the green recording state and desktop surfaces.
- Give running mobile chats an explicit Queue action above Send. Queueing a recording must retain that intent if the active turn finishes during transcription. An empty running composer shows Stop without a second disabled Send control. Keep the preset inspector on desktop; mobile details remain accessible through Manage presets.
- Retain capability, permission and platform checks for presets, usage, launches and audio.

## Product behavior

Follow the [single product behavior contract](agent-presets.md#review-boundaries). The profile selector is always available. Compact viewports use the full mobile controls and appearance, including desktop PWA windows with a mouse. Wide viewports retain touch enhancements when a coarse pointer is available. Use the shared compact breakpoint, never a user agent, to select mobile layout. Migration discards legacy mode preferences while preserving credentials, profiles, workspaces and running tasks.

Agent instructions in CLAUDE.md, also reached through AGENTS.md, require this contract and publication to the real private instance for every interface request. Use [instance continuity](instance-continuity.md) for publication.

## Verification and limits

These dated results are historical evidence, not acceptance of the current checkout or a new deployment. Repeat affected checks using the [handoff checklist](host-handoff.md#acceptance).

The September 10 composer and recording changes passed 23 focused tests for tooltip interaction, permission captions, metadata preservation, and independent recording actions. Workspace typechecks and focused lint passed. Repository lint still reports unrelated errors in pending persistence and workspace-title work.

Earlier Chromium touch emulation checked 320, 375, 402, and 430 pixel phone widths, landscape/portrait transitions, and wide-screen Vorteo off/on behavior. Preset and permission controls stay on one row; abbreviations expand when space returns. Dictation and submit have separate 44 pixel targets. Synthetic microphone recording preserved both 120 and 217 pixel composer heights, matched edit/submit coordinates exactly, and preserved the draft after cancellation. Vorteo retained its original 75 pixel recording panel. A real context meter opens its details by tapping and dismisses on a second tap. Physical iPhone and iPad dictation, keyboard, pinch zoom, and Home Screen viewport acceptance remain device checks. No macOS Playwright WebKit was launched.

The September 9 iPhone screenshot still showed a bottom gap after the CSS-only viewport update. That update was deployed but uncommitted. Its tests checked mode cleanup, not screen geometry. The screenshot proportions match the 62 CSS pixel Home Screen window gap reported in [WebKit 301994](https://bugs.webkit.org/show_bug.cgi?id=301994#c12). In that report even `visualViewport.height` is too short, so measuring it cannot recover the missing screen area. Do not treat a passing desktop viewport test as proof this is fixed.

The iPhone 17 Pro report includes iOS 27 and a gap that changes after rotation. The revised standalone rule uses `100vh` rather than `100dvh`, following the viewport-unit distinction reported in [WebKit 254868](https://bugs.webkit.org/show_bug.cgi?id=254868). This does not prove that iOS exposes the full compositor surface. App diagnostics in Vorteo include startup/recent viewport measurements, safe-area insets, root dimensions, and the loaded entry script. Use those measurements to distinguish a short document from a short system window. Do not require shortcut reinstallation or claim physical-device acceptance from Chromium results.

The later composer screenshot exposed another gap: the chat wrapper added the bottom safe-area inset outside the field, in addition to the composer's margin. The revised mobile layout keeps bottom and side margins equal and places recording controls at matching corner insets. Its green background extends through those margins to the screen edges. Safe-area insets describe an unobstructed rectangle, not the physical display's corner radius; do not infer device curvature from them. Keep top and bottom padding explicit: Unistyles expands `paddingVertical` after a dynamic `paddingBottom` override and can restore the old value. Browser verification must supply nonzero safe-area insets and compare recording positions as well as the field boundary. Physical-device checks still own home-gesture interference and any gap outside the browser's reported viewport.

Inspect the live viewport metadata, not only `public/index.html`: `use-compact-web-viewport-zoom-lock.ts` rewrites it after mount. Verify that compact layouts preserve pinch zoom. Verify the loaded entry script against the published release when investigating stale code. Closing an app does not clear its persistent caches.

Publishing updates only web assets. It does not activate source-only daemon changes or restart running tasks. Follow docs/instance-continuity.md for the tested local and in-container publishing workflows.
