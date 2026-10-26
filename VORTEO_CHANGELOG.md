# Vorteo changelog

Vorteo change history, covering features, fixes, documentation, tests, tooling and upstream integration. Update this file in every commit using the prepared version and a dated entry. See the [commit workflow](docs/release.md#vorteo-release-notes).

The initial baseline is cumulative; older entries do not cover every maintenance commit. Historical version labels are preserved. Paseo release history remains in the [upstream changelog](CHANGELOG.md); the [customizations inventory](docs/vorteo-customizations.md) describes current fork capabilities and limitations.

## 0.11.0-beta.3.vorteo.868 - 2026-10-26

### Maintenance

- Merge the CLI provider test update: the Codex model check no longer requires a codex-named model, matching upstream and the current Codex catalog

## 0.11.0-beta.3.vorteo.867 - 2026-10-26

### Maintenance

- Merge command-name check review fixes: too-deep command folders count as unknown, dependency folders are skipped outside command trees, file and dangling symlinks no longer drop all built-ins, and chmod tests skip on Windows

## 0.11.0-beta.3.vorteo.858 - 2026-10-26

### Fixed

- A custom command saved under a commands subfolder named node_modules or .git is no longer skipped by the resume check for Claude's bundled skills, so it can't take a bundled skill's name. Those folders are still skipped elsewhere in plugin folders.

## 0.11.0-beta.3.vorteo.857 - 2026-10-26

### Maintenance

- Skip the three skill policy tests that make a path unreadable with chmod on Windows, where chmod cannot remove read access. They failed main's Windows CI because the fail-closed path never ran there; behaviour is unchanged.

## 0.11.0-beta.3.vorteo.856 - 2026-10-25

### Fixed

- The resume check for Claude's bundled skills no longer drops them all because of a symlink to a file or a dangling symlink inside a skill or plugin folder, and it skips node_modules and .git folders inside plugins. A commands folder nested deeper than the check reads now counts as unknown and keeps no bundled skills, instead of being silently ignored.

## 0.11.0-beta.3.vorteo.866 - 2026-10-26

### Maintenance

- Merge desktop build heap and Nix fixes: the desktop package build gets the 8 GB export heap, upstream's Nix hash bot skips this fork, and the Nix daemon trace leaves out Electron's installer

## 0.11.0-beta.3.vorteo.865 - 2026-10-26

### Fixed

- The Nix package builds again on Linux. The daemon trace followed Playwright's unused Electron launcher into the npm Electron package's installer, so the package shipped its prebuilt zip addons, and auto-patchelf could not find musl for the x64 musl addon. The trace now leaves out the npm Electron package, which drops about 200 installer files from the daemon closure.

## 0.11.0-beta.3.vorteo.864 - 2026-10-26

### Fixed

- Desktop builds run the Electron web export with an 8 GB worker heap. The Desktop Packages workflow ran out of memory at the default limit of about 4 GB on every main commit since at least 67375bccd. Desktop release builds use the same script.

### Maintenance

- Nix Update Hash runs only in the upstream repository. It needs upstream's bot app to commit hash updates to main, which this fork does not have and where only Builds writes main.

## 0.11.0-beta.3.vorteo.863 - 2026-10-26

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.862 - 2026-10-26

### Maintenance

- Merge browser test repair after the redesigns: about 70 failing Playwright cases repaired or retired with named commits, and product regressions marked fixme

## 0.11.0-beta.3.vorteo.861 - 2026-10-25

### Maintenance

- Remove five screenshots that app browser unit tests wrote and an earlier commit included by mistake, and restore the tracked phone connection-check screenshot to main's version. Git now ignores those generated screenshot names.

## 0.11.0-beta.3.vorteo.860 - 2026-10-25

### Maintenance

- Make three appearance browser tests reliable on CI without loosening their checks:
  - The compact font layout test measures the label and input after the settings page stops scrolling to Appearance.
  - The 1133px interface zoom drag is measured and made again if late-loading settings panes move the slider first.
  - The palette button test gets a 300-second budget; it takes about 90 seconds locally and reached 180 seconds on CI.

## 0.11.0-beta.3.vorteo.859 - 2026-10-25

### Maintenance

- Merge main at b08980d36 into the browser test repair branch, taking main's manifests.

## 0.11.0-beta.3.vorteo.858 - 2026-10-25

### Maintenance

- Repair the composer and agent stream browser tests:
  - The first prompt test runs with reduced motion, since the prompt's rise is deliberate (ab83bcdea).
  - The jump button is found by its test ID, since host-connected chats label it "Jump to latest" (5ccf27a5b).
  - The compact Plus menu check follows the 8px menu inset (6ee6bfd23).
  - The blank-line composer probe starts from the key press, since Shift+Enter fires no input event (1167acf35).
  - Queued prompts are confirmed through the host's history (29d3f5111).
  - The stopped-thread queue test pauses the queue itself, since Stop no longer pauses it (614c0e44f).
  - Connection failures appear as "Reconnecting host" toasts (471d7f22a), and the workspace restart test seeds a profile.
- Retire the overlapping queued-send recovery test: the host owns the queue since 29d3f5111, and a2a7c4937 blocks a second immediate send.
- Mark two known regressions: retrying a failed first agent in a new workspace fails with a request key conflict, and hosts without profile launch cannot create anything since 471d7f22a.
- Repair the remaining card tests:
  - Full-width collapsed headers keep their count chip fill (bd1db0362), compact goal badges round to hours (0153f4c69), and the context window card joins the card checks (7723a55f6).
  - Task conflicts report through a toast (68faa7a52), and queue checks look in the conversation (b5ee41fb8).
  - The terminal theme test reads the font from xterm's options, since the WebGL renderer has no text rows.
  - The phone scripts test confirms the script's output, and checks the exit badge only under zsh, which is the only shell that reports exit codes.
- Two layout differences go to owner review.
- Shared helpers: scrolling to the newest history retries until the view settles, and the pagination test no longer opts out of the worktree notice handler.

## 0.11.0-beta.3.vorteo.857 - 2026-10-25

### Maintenance

- The browser test notice handler gives up after two seconds when the worktree setup notice disappears before its dismiss click, instead of holding the test until it times out.
- The local plugin journey test gets a 120-second budget; its five Settings phases take about 37 seconds locally and overran 60 seconds on CI.

## 0.11.0-beta.3.vorteo.856 - 2026-10-25

### Maintenance

- Merge main at 67375bccd into the browser test repair branch, taking main's manifests.
- Re-enable two browser tests whose product fixes are now on main. Legacy favourites saved beside the old mode setting migrate again (a6a91bc4a). Reloading a saved layout with thousands of empty Explorer drafts no longer freezes the page (9711e1710).

## 0.11.0-beta.3.vorteo.855 - 2026-10-25

### Maintenance

- Repair the layout and appearance browser tests:
  - Demo cards follow the "2 / 4" count (6717047e5), 44px headings (0fd42877e), the softer sidebar divider (6ee6bfd23), the demo subagents (ce0345cfc), edge-to-edge toolbar buttons (87db69fbd) and Settings staying in the toolbar (7a4c33777).
  - Desktop task rows are 32px tall (2cf5e0cbb), and the display font check reads its CSS variable, since desktop has no title header (195e1c044).
  - Branded loader tests block development bundles too, so the app cannot boot before the logo check. Settings and theme picker tests wait for scrolling and sliders to settle.
- Mark known regressions: phone navigation starts below 500px instead of 720px (94087127e), and subagent rows nest buttons inside a button. Three geometry differences go to owner review.
- Repair other browser tests:
  - The chat outline split test uses a width where a split pane is narrower than the rail's minimum.
  - Startup diagnostics show the connection advice from 24e167c54.
  - The sidebar toolbar target check rounds 43.99999px boxes.
  - Workspace task flowers report percentages (fc8b28074).
  - Task dependency errors arrive as toasts (68faa7a52).
  - The queue sits in the conversation (b5ee41fb8).
  - Closed sidebar cards stack as full-width headers (bd1db0362).

## 0.11.0-beta.3.vorteo.854 - 2026-10-25

### Maintenance

- Repair the settings, provider and sidebar browser tests:
  - Claude sign-in tests follow `claude setup-token` and the "Claude is not connected" wording (7c8e78ac7). The fake login CLI gains a setup-token mode.
  - Metadata settings use the "Metadata generation" section (537b619e2).
  - Provider outlines sit on the control itself (0153f4c69).
  - Startup status replaces the old connecting headings (471d7f22a).
  - The crash check uses the Vorteo wording (e0f82d126), which the old check could never see.
  - Root error recovery reports Metro's error body when its fixture fails to compile.
- Retire the Standard-mode halves of the Claude authentication and provider management tests, citing 471d7f22a.
- Mark the legacy favourites migration as a known regression. Since 471d7f22a the strict preferences schema rejects the old `vortonMode` field, so upgraded installs lose their favourites and the migration is marked done.

## 0.11.0-beta.3.vorteo.853 - 2026-10-25

### Maintenance

- Repair the files, Explorer and plugin browser tests:
  - Count only visible tree matches, since a hidden Files card can stay mounted (60f4899a6).
  - Expect toasts for failed actions (68faa7a52).
  - Follow the Dark Star default colors (60f4899a6) and the host line in tab tooltips (d9b7a2d60).
  - Expect the single-script play button (fa9a1859d) and the checklist count badge label (9883656f9).
  - Read workspace titles from the sidebar row (195e1c044).
  - Re-home the Explorer upgrade tests onto the supporting cards and the icon rail (ab60c1e39).
- Retire explorer-plugin-menu.spec.ts and its helper, citing 60f4899a6: supporting cards replaced the Explorer tab dock and its + menu.
- Mark the canvas diff thumb drag as a known regression: at 1400px the supporting cards' resize handle covers the overlay scrollbar's grab area.

## 0.11.0-beta.3.vorteo.852 - 2026-10-25

### Maintenance

- CI Playwright runs drop the temporary `--reporter=line --retries=0` diagnostics. They keep artifact uploads for cancelled shards and the five-minute Metro warm-up limit.
- Queue tests no longer expect 44px status targets in a narrow mouse-driven window. Since 2cf5e0cbb, rows take 44px targets on touch devices, and touch is detected independently of width.
- The queue orbit test drops its phone-width tooltip press, a known regression where a press no longer opens explanations, and keeps its other checks.

## 0.11.0-beta.3.vorteo.851 - 2026-10-25

### Maintenance

- Merge main through 71925c85e: interrupted startup scripts recover, and connection errors are classified. This branch keeps its own version line; main only changed version numbers in the manifests.

## 0.11.0-beta.3.vorteo.850 - 2026-10-25

### Maintenance

- Retired, citing 471d7f22a, which moved model, mode and permissions into profiles:
  - new-workspace-codex-mode-preferences.spec.ts, which tested remembering a composer mode in drafts.
  - bottom-sheet-reopen.spec.ts, which tested the composer's model sheets. The provider settings stack on the schedule picker covers phone sheet reopening.
  - The draft-tab case of the composer density test.
  - The model and mode assertions of the slash clear test.
- Tests reach the app-wide New workspace entry through the sidebar's More menu (ab60c1e39).

## 0.11.0-beta.3.vorteo.849 - 2026-10-25

### Maintenance

- Retire composer-diff-stat.spec.ts, citing 471d7f22a: the composer diff pill showed only in the Standard mode it removed.
- The diff counter test checks the toolbar counter with the supporting cards open.
  - Its height alignment with the scripts button awaits owner review: 26px against 44px.
  - Its phone placement is a known regression: phones show no counter since 195e1c044.
- The Cmd+E test expects the Changes card, which keeps its saved collapse state.
- The New tab no-flash test waits for the tab count to settle before sampling.

## 0.11.0-beta.3.vorteo.848 - 2026-10-25

### Maintenance

- Merge main through 24e167c54, which shows connection diagnostics during startup. This branch keeps its own version line; main only changed version numbers in the manifests.
- Tests for the Changes shortcut, Cmd+E, the new tab Explorer shortcut and composer Explorer navigation look for the supporting cards. Files and Changes became supporting cards in 60f4899a6, 2e2921f79 and 73be0edc5.

## 0.11.0-beta.3.vorteo.847 - 2026-10-25

### Maintenance

- Mark two New workspace regressions as known failures: choosing another host clears the selected project (99eca19a7 behaviour), and plain /new with stale offline hosts no longer preselects a project.
- The pasted pull request helper uses the platform paste shortcut, so the tests also paste on macOS.

## 0.11.0-beta.3.vorteo.846 - 2026-10-25

### Maintenance

- Each browser test starts from the default sidebar: project grouping, no filters and nothing collapsed. That state now syncs through the host, so one test's choices carried into the next.
- The workspace header helper finds the open workspace's sidebar row from the route, since status-grouped rows expose no selected state, and skips the project name that status rows do not show.
- The cross-workspace subagent test expects the parent's workspace to show its running child, since delegated agents stay under their originating task (471d7f22a).

## 0.11.0-beta.3.vorteo.845 - 2026-10-25

### Maintenance

- Sidebar helpers wait for a visible project row and accept the display preferences sheet on touch layouts, since the shell keeps a hidden copy of the other layout's sidebar.
- Sidebar reorder tests:
  - Open the phone sidebar through the shared helper.
  - Expect a refused move as a toast (68faa7a52).
- The pin shortcut tests restore project grouping and expand a Pinned section left collapsed. Sidebar grouping and section collapse now sync through the host, so they carried between tests.
- Mark the touch title width test for owner review: diff stats now take 52px of title space on touch rows.
- The question pagination test now records its 2px input-to-actions gap as a regression against 9b6263e7c; its insets still await owner review.

## 0.11.0-beta.3.vorteo.844 - 2026-10-25

### Maintenance

- Subagent tests follow 2cf5e0cbb and 0d18398e7. Rows show only status, title and actions, with profile, model and status in the row's tooltip; groups are titled Subagents and System sub-agents; the card's cleanup action shows progress in its tooltip. Duplicate row copies are narrowed to the visible one.
- The title suggestions test opens rename from the row's context menu when touch rows have no overflow button (2415534c8).
- Mark two product regressions as known failures:
  - Subagents opened from a right-pane parent now open in the main pane.
  - Card explanations no longer open on keyboard focus or on a press at phone width; hover still works.

## 0.11.0-beta.3.vorteo.843 - 2026-10-25

### Maintenance

- Retire workspace-draft-thinking-preferences.spec.ts, citing 471d7f22a. Per-model thinking and per-provider mode memory belonged to the draft composer's controls; profiles now carry model, thinking and mode, and remembered profiles are covered by the New workspace model memory test.
- The upstream settings test accepts the About address, which the single settings page keeps while showing General.
- Remove a duplicated changelog entry for 0.11.0-beta.3.vorteo.835, which made the Help changelog test find two releases with one version.

## 0.11.0-beta.3.vorteo.842 - 2026-10-25

### Maintenance

- The plan card test expects the fixed 44px card heading from 0fd42877e with width-adaptive insets: 48px on desktop and 50px on phones. Its desktop scrolling check uses a shorter window, since the sidebar column now gives the card enough room for the whole plan; it also waits out re-renders after resizing.
- Mark two geometry drifts for owner review, with measured values: question card action insets and gaps, and the sidebar project row's unbalanced padding.

## 0.11.0-beta.3.vorteo.841 - 2026-10-25

### Maintenance

- Queue tests:
  - Expect the card title Queue (0d18398e7).
  - Read the visible copy of the card.
  - Retire the Vorton-off reload, citing 471d7f22a.
- Mark the queue heading height test for owner review: the card grows from 90.5px to 128px while a held status shows, and the phone drag handle exposes no pressed state.
- The open questions sidebar test seeds a usage report, so the Quota card no longer depends on the machine's accounts.

## 0.11.0-beta.3.vorteo.840 - 2026-10-25

### Maintenance

- Provider settings stacking tests open provider settings from a new schedule's model picker, since the composer's model selector went with the Paseo mode in 471d7f22a. Closing provider settings in the schedule form returns focus to the picker's Back button rather than the settings button; the test checks that focus stays in the selector and the gap is reported.

## 0.11.0-beta.3.vorteo.839 - 2026-10-25

### Maintenance

- Codex speed tests check the profile editor's Speed feature on desktop and phones; the composer speed control went with the Paseo mode in 471d7f22a.
- Profile editor helpers follow the phone sheet, whose header carries the editor's test ID while its form and buttons sit in its scroll and footer parts. Select options are found in the phone sheet as well as the desktop popover.

## 0.11.0-beta.3.vorteo.838 - 2026-10-25

### Maintenance

- Retire the Standard mode queue test and the Standard half of the title suggestions test, citing 471d7f22a.
- Skill library tests open Skills as a pane of the single settings page.
- Locators narrowed to one element:
  - The outer subagents card, since group bodies reuse its test ID.
  - The visible journal card, which also appears among the history cards.
  - The plugin source Docs link, since metadata generation has its own.

## 0.11.0-beta.3.vorteo.837 - 2026-10-25

### Maintenance

- Workspace actions open from the pane menu on desktop or the title menu's sheet on phones in import session tests; the shared helper recognises the sheet's content.
- Mark the desktop import session test as a known failure: since 471d7f22a New workspace shows Import session only on compact layouts.

## 0.11.0-beta.3.vorteo.836 - 2026-10-25

### Maintenance

- Usage tests read the context window sheet and the usage card. Since b7e249fef the sidebar Quota card also names accounts and loads usage with the app shell.
- Provider removal uses the Delete button on a custom provider's row and its credentials message; 471d7f22a removed the provider actions menu.
- Retire the Standard mode check in the Claude CLI warning test, citing 471d7f22a.
- The Model B sidebar test finds New workspace in the More menu (ab60c1e39).

## 0.11.0-beta.3.vorteo.835 - 2026-10-25

### Maintenance

- The worktree-notice dismissal no longer waits for every notice to disappear, so a second project's notice no longer stalls a test.
- Plugin settings tests expect the single settings page's plugins address.
- Plugin tests read the open workspace's title from the header on phones or the selected sidebar row on desktop, where 195e1c044 removed the title header.
- Mark three product regressions as known failures:
  - Plugin header buttons on phones (195e1c044); the phone checks split into their own tests.
  - Empty workspaces on a host without profiles; a new test covers this.
  - The per-host project rename (537b619e2).

## 0.11.0-beta.3.vorteo.834 - 2026-10-25

### Maintenance

- Settings tests follow the single settings page:
  - Each host's section appears under several panes, a hidden earlier settings screen can stay mounted, and a host's connection error shows twice, so tests use the visible or first match.
  - Host details are checked under Environments.
- Sidebar project grouping tests:
  - Choose a host in New workspace's Environment step.
  - Create an empty workspace with the composer's Create button.
  - Seed the mock profile on the secondary test host, since New workspace creates only with a profile.
- Mark the per-host project rename test for owner review: Settings lists only the first host's projects since 537b619e2.

## 0.11.0-beta.3.vorteo.833 - 2026-10-25

### Maintenance

- Profile recreation tests go through the switch sheet's new task choice to the handoff modal. 70639f19a added in-place switching first.
- Retired with their UI, citing the removing commit:
  - The profile picker's per-account reasoning choice and unavailable-reasoning message (d6cbd181c).
  - The compact picker's accounts page and back button (58a0cbbc9); collapsible sections replace them.
  - The composer's mode button (471d7f22a).
- The shared scope label is checked in the defaults editor, and preferred reasoning is reached through its collapsed row.
- The remembered-account draft test uses a selectable mock model, since the picker offers only profiles whose model is selectable.

## 0.11.0-beta.3.vorteo.832 - 2026-10-25

### Maintenance

- The desktop plugin links check expects the old `window.open` workaround to open no window. Since cd90c8f78 the application renderer denies new windows so none inherits its preload; plugins open links through the external opener bridge, which the check still covers.

## 0.11.0-beta.3.vorteo.831 - 2026-10-25

### Maintenance

- Re-home the composer model picker tests. The draft and running-agent composers lost their model picker with the Paseo mode in 471d7f22a; profiles now carry the model.
  - Profile picker tests choose and confirm a profile on a running agent.
  - Cross-provider model search and virtualization run on the schedule form's model picker.
  - Model memory, recovery and the modeless preference repair choose profiles on New workspace.
  - Plugin provider icons are checked on the Account card.
- Retired, citing 471d7f22a: provider-usage-model-selector.spec.ts, which asserted the removed Paseo picker; pinned profile rows inside the model picker; the composer naming the model; and the model row's create-profile action, which has no profile-picker equivalent.
- Mark two possible product regressions as known failures: an empty host cannot reach profile settings from the picker, and profiles cannot be chosen while the host catalog reports their provider unavailable.
- The fake Claude CLI answers `auth status` as a first-party login, including when a setup token adds `--settings`, matching the authentication check from 7c8e78ac7.

## 0.11.0-beta.3.vorteo.830 - 2026-10-24

### Maintenance

- The test setup's worktree-setup notice dismissal dispatches its click directly, so an open overlay such as the command center no longer blocks it and times the test out.
- Sidebar display-preference tests open View preferences from the More menu, where the sidebar toolbar redesign (ab60c1e39) moved it.
- The label creation failure test expects the toast that replaced inline errors in 68faa7a52.

## 0.11.0-beta.3.vorteo.829 - 2026-10-24

### Maintenance

- Retire the Explorer tab dock tests: explorer-sidebar.spec.ts and the Explorer pane tab placement test. Files and Changes became supporting cards beside the conversation in 60f4899a6, 2e2921f79 and 73be0edc5. The split pane tests now use the primary pane menu's Split right item.
- Mark the saved Explorer layout recovery test as a known failure: reloading a workspace whose saved layout has a hidden Explorer and 2,250 saved drafts now freezes the page. The product fix follows separately.

## 0.11.0-beta.3.vorteo.828 - 2026-10-24

### Maintenance

- Context window tests wait on the single loading pulse that replaced separate usage loading lines in 662ea77a7, and hover the composer's meter rather than the details donut with the same name.
- Workspace setup tests open Show setup from the shared workspace actions menu and start a workspace's only script from its single play button (fa9a1859d), opening the Explorer first where that button lives on desktop.
- Launcher tests accept the single settings page's Terminal profiles address.

## 0.11.0-beta.3.vorteo.827 - 2026-10-24

### Maintenance

- Appearance theme tests look for the theme save error among the page's alerts, since Settings also shows plugin trust notices, and give the palette walk three minutes.
- Mark two theme picker geometry tests for owner review: sidebar theme bubble centres measure up to 8.7px apart instead of within 1px, and the touch swatch measures 44.3px wide instead of 48px, with no recorded design change since 1d041fbea.

## 0.11.0-beta.3.vorteo.826 - 2026-10-24

### Maintenance

- Sidebar tests close the phone sidebar from its toolbar's collapse toggle, open a row's actions from its context menu when no overflow button shows, toggle the desktop sidebar between its collapse button and the icon rail's Expand button (ab60c1e39), and check the Files card and sidebar instead of the New workspace row, which moved to the More menu.
- Mark the sidebar scroll test as a known failure: since the icon rail (ab60c1e39) collapsing and expanding the sidebar resets its project list scroll. The product fix follows separately.

## 0.11.0-beta.3.vorteo.825 - 2026-10-24

### Maintenance

- Browser tests open workspace actions from the title menu on phones and from the primary pane menu on desktop, where 195e1c044 combined them with pane splitting. The workspace menu parity, wide touch menu and wide touch Standing tests pass again; the earlier wide touch known-failure mark is removed.

## 0.11.0-beta.3.vorteo.824 - 2026-10-24

### Maintenance

- Agent skills tests save their sandbox daemon as the first host, because Agent behavior settings manage the installation's first host since 471d7f22a, and expect a failed save to show the daemon's own error in the sheet, as 68faa7a52 made it.

## 0.11.0-beta.3.vorteo.823 - 2026-10-24

### Maintenance

- Open question tests expect a refused answer as a toast, which 68faa7a52 made the way failed actions are reported, and check that the question stays for a retry.

## 0.11.0-beta.3.vorteo.822 - 2026-10-24

### Maintenance

- Mark five command center agent control tests as known failures: since 471d7f22a the command center offers no Mode commands for an agent. The product fix follows separately.
- Retire the test for the composer's own thinking selector, which 471d7f22a replaced with the profile picker; the command center keeps its Thinking commands.

## 0.11.0-beta.3.vorteo.821 - 2026-10-24

### Maintenance

- Mark two more workspace standing tests as known failures: the Standing section's disclosure arrow sits 14px off the workspace status dot column with no recorded design change (geometry drift, owner review), and wide touchscreens may have no way into workspace actions since 2415534c8, pending an owner check on a device.

## 0.11.0-beta.3.vorteo.820 - 2026-10-24

### Maintenance

- Workspace standing tests close a menu with as many Escape presses as its open tooltip needs, use the labels submenu's copy of each toggle, read the icon-only Scheduled badge from its accessible name, align custom label chips with status icons by centre, and open workspace actions from the title menu on phones, where rows have no overflow button since 2415534c8.
- Mark two workspace standing tests as known failures: the phone Git Archive test needs the Explorer's Changes view, which phones cannot open since 56b01ba3a, and archiving a protected, scheduled workspace reports only the protection blocker since 84f489a59. Product fixes follow separately.

### Known limitations

- The first workspace standing test still fails on a disclosure arrow alignment check, and the wide touchscreen test cannot yet open the workspace menu by long press.

## 0.11.0-beta.3.vorteo.819 - 2026-10-24

### Maintenance

- The desktop appearance font size check watches the same Theme label it measured first, since the single settings page has other "Theme" text.

## 0.11.0-beta.3.vorteo.818 - 2026-10-24

### Maintenance

- Plugin sidebar item tests place footer rows above the footer separator, since the footer icon line moved to the toolbar, and compare grouped row spacing with the separator gap instead of a fixed limit.
- Retire the plugin sidebar steps that used removed features: the built-in New workspace header row and its shortcut hint, ordering against that row, and hiding or listing plugin rows in the Sidebar settings pane (9332fbd2d, 471d7f22a). Remove the now unused sidebar settings test helpers.

## 0.11.0-beta.3.vorteo.817 - 2026-10-24

### Maintenance

- Usage screen tests open Usage by its address, since the sidebar Usage row and icon are gone, and check report windows, provider window durations and source logos on the screen itself.
- Retire the tests for the sidebar Usage summary, its pins and the sidebar footer rows: usage-sidebar-item.spec.ts, sidebar-nav-settings.spec.ts, and the pin, pin glyph and sidebar-host tests in usage-screen.spec.ts. 9332fbd2d hid the sidebar Usage item and 471d7f22a removed its switch, icon and the Sidebar settings pane.

## 0.11.0-beta.3.vorteo.816 - 2026-10-24

### Maintenance

- The desktop shortcut unassign test allows two minutes, since its Settings and Help round trips ran past one minute on a shared Linux runner.

## 0.11.0-beta.3.vorteo.815 - 2026-10-24

### Maintenance

- Merge main f15d7a549 into the browser test repair branch. Only release notes conflicted; every entry from both sides is kept.

## 0.11.0-beta.3.vorteo.814 - 2026-10-24

### Maintenance

- The demo compact theme tests open README.md from the inline Files card that phones show since 56b01ba3a, instead of the removed phone Explorer toggle.
- Mark three phone Changes tests as known failures: since 56b01ba3a phones have no way to open the Explorer's Changes view. The product fix follows separately.

## 0.11.0-beta.3.vorteo.813 - 2026-10-23

### Maintenance

- The desktop Settings memory check rotates through every section the Settings sidebar lists on the single settings page, instead of 24 separate pages that 537b619e2 merged.

## 0.11.0-beta.3.vorteo.812 - 2026-10-23

### Maintenance

- Browser tests open Projects through the Workspaces & projects section and accept its current addresses, on desktop and phone widths.
- Chat outline tests use a 2400-pixel viewport, because the workspace card column now narrows the conversation below the rail's minimum at 1440, and look for task cards in the workspace card column.

## 0.11.0-beta.3.vorteo.811 - 2026-10-23

### Maintenance

- Desktop renderer tests open Help from the sidebar More menu, open the Explorer before using Open in editor, and find App updates in General's About pane.
- The workspace title check reads the phone header, or on desktop, which has no workspace header since 60f4899a6, the selected sidebar row under its project.
- Mark two desktop update tests as known failures: since 72919fc59 the App updates row squeezes its title when Check and Update both show. The product fix follows separately.
- CI gives Metro's first bundle up to five minutes to warm up, since a shared runner hit the two-minute limit.

## 0.11.0-beta.3.vorteo.810 - 2026-10-23

### Maintenance

- Browser tests choose a model by applying a mock profile that pins it, because the composer no longer has a model control.
- Browser test setup dismisses the "Set up worktree scripts" notice whenever it appears, since it covers the composer's bottom-right actions; specs about the notice opt out.
- The queueing test helper follows the composer's current default action.
- Mark four message submission tests that choose steer or interrupt in Settings as known failures: since 471d7f22a the composer ignores the Default send setting. The product fix follows separately.

## 0.11.0-beta.3.vorteo.809 - 2026-10-23

### Maintenance

- Browser tests open Changes through the Explorer's Changes card instead of the removed Explorer sidebar, reach a host's settings by choosing its Environments tab without reloading the page, and open the phone sidebar from the header's menu button.

### Known limitations

- Three compact Changes tests still use the phone Explorer toggle that the mobile toolbar simplification removed, and two desktop Changes tests still fail.

## 0.11.0-beta.3.vorteo.808 - 2026-10-23

### Maintenance

- Browser tests give every test daemon one shared mock profile, because New workspace no longer starts a chat without a profile. Profile settings and picker tests opt out to keep their empty starting state.
- Browser tests choose the New workspace host in the Environment step instead of the removed host picker. Tests that switch hosts start a reachable second daemon, since unreachable hosts are shown disabled.
- Browser tests open Help from the sidebar More menu, check the toolbar icon line instead of the removed footer icons, and date the changelog retry fixture ahead of real releases.
- Retire three sidebar settings tests for reordering and hiding sidebar items and footer rows. That customization was removed in 9332fbd2d, and the pane stopped rendering in 471d7f22a.
- Mark the New workspace Ctrl+P project picker test as a known failure: the shortcut no longer opens the picker. The product fix follows separately.

### Known limitations

- The sidebar footer usage test, three profile picker tests, the legacy favourites migration test and the host version test still fail. The New workspace preselect and host project preservation suites each have one failing case left.

## 0.11.0-beta.3.vorteo.807 - 2026-10-23

### Maintenance

- Temporary diagnostic: browser test shards in CI run without retries and print each failure as it happens, so a shard that hits its time limit still reports why its tests failed. A later commit restores retries and the list output.
- Browser test shards upload their results when they hit the time limit, not only when they fail.
- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.861 - 2026-10-26

### Maintenance

- Merge Claude command-name checks on resume: commands named like built-in skills turn those built-ins off, as skills already did

## 0.11.0-beta.3.vorteo.860 - 2026-10-26

### Maintenance

- Merge container web build heap and fork deploy guards: the server pack's web export gets the 8 GB export heap, and upstream Cloudflare deploys skip this fork

## 0.11.0-beta.3.vorteo.859 - 2026-10-25

### Maintenance

- The app and relay deploy workflows run only in the upstream repository, like the website deploy. They need upstream's Cloudflare token and would fail here whenever their paths changed.

## 0.11.0-beta.3.vorteo.858 - 2026-10-25

### Fixed

- The container image build's web export now runs with the same 8 GB worker heap as Host installs. The server package's web UI build ran out of memory at about 4 GB in the container smoke builds on several main commits.

### Maintenance

- The Deploy Website workflow runs only in the upstream repository. This fork has no Cloudflare token, so the job failed on every main push.

## 0.11.0-beta.3.vorteo.858 - 2026-10-26

### Maintenance

- Merge registry-only reviewed settings: a reviewed coordinator setting no longer needs a legacy plan field

## 0.11.0-beta.3.vorteo.852 - 2026-10-25

### Maintenance

- Reviewed coordinator settings no longer need a legacy plan field. A setting added after the registry, such as the coordinator telemetry opt-in, changes only through `configurationChanges`. Existing settings keep their legacy fields unchanged, and tests cover a registry-only setting.

## 0.11.0-beta.3.vorteo.857 - 2026-10-25

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.856 - 2026-10-25

### Maintenance

- Merge Windows CI exclusions: POSIX-only runtime custody and Host launcher suites, and the restart settings drift test, skip on Windows

## 0.11.0-beta.3.vorteo.852 - 2026-10-25

### Maintenance

- Windows CI skips the coordinator runtime custody and Host launcher update suites, and the restart settings drift test. They exercise Host-only code with POSIX ownership, user IDs and `/`-rooted paths, and failed nine tests on the Windows server job.

## 0.11.0-beta.3.vorteo.855 - 2026-10-25

### Maintenance

- Merge restricted Claude launch fix: restricted selections leave unpackaged provider defaults out instead of refusing the launch, and restricted Claude sessions keep Claude's built-in skills

## 0.11.0-beta.3.vorteo.854 - 2026-10-25

### Maintenance

- Merge test fixture orphan audit: long-running test fixtures exit when their test worker goes away

## 0.11.0-beta.3.vorteo.851 - 2026-10-25

### Maintenance

- Four more coordinator test fixtures that loop forever now exit when their link to the test process closes, so a test worker that dies mid-test no longer leaves them running. A fifth, which must run as an orphan, now exits on its own after two minutes. A sixth already had its own time limit and is unchanged.

## 0.11.0-beta.3.vorteo.853 - 2026-10-25

### Maintenance

- Merge preclaim test fixture cleanup: detached fixture processes exit when the test worker's IPC channel closes

## 0.11.0-beta.3.vorteo.851 - 2026-10-25

### Maintenance

- The preclaim native-proof test's disposable executor and coordinator exit when their link to the test process closes. A test worker that died mid-test left one such pair running for about 12 hours.

## 0.11.0-beta.3.vorteo.852 - 2026-10-25

### Maintenance

- Merge installer tooling pins: the coordinator pins all six install tooling files, and icon context paths stay explicitly relative

## 0.11.0-beta.3.vorteo.849 - 2026-10-25

### Fixed

- Selecting Host update tooling from a release now requires every script the installer imports: the preparer, publisher and artifact helper, plus the preload, web export and dependency cache modules. A release that lacks any of them is refused at review.
- The Lucide import plugin prefixes `./` to any relative path that does not start with `./` or `../`, so a path into a dot-named folder is never emitted as a bare specifier.

## 0.11.0-beta.3.vorteo.851 - 2026-10-25

### Fixed

- Show expanded startup diagnostics and begin automatic checks after ten seconds using one shared delay.
- Move and shrink the original V mark while the diagnostic content fades and slides into place on the same timeline. Reduced motion settles immediately, with no new downloaded assets or dependencies.

## 0.11.0-beta.3.vorteo.855 - 2026-10-25

### Fixed

- A custom command named like one of Claude's bundled skills can no longer take its place in a restricted session. Claude lists commands as skills and its allowlist matches them by name, so a resumed session now reads project, home, account and plugin command folders and turns off any bundled name a command uses. This is conservative: a plugin that is present but not loaded for an account can still turn a name off, which on the Host currently drops code-review for account sessions.

### Maintenance

- Skill policy tests use an empty home folder and stop the project folder walk at the test folder, so the developer's own skills, plugins and commands no longer affect them. New tests cover the synced skill layout, unreadable folders inside plugin roots, command claims, and the Claude session passing its own config folder to the resume check.

## 0.11.0-beta.3.vorteo.854 - 2026-10-25

### Fixed

- A skill the inventory cannot fully read, for example one with a symlinked file or too many files, can no longer borrow a bundled skill's name on resume. Its frontmatter name is read directly, and if that also fails the session keeps no bundled skills. The skill library notes that resume compares package contents only in the standard skill folders.

## 0.11.0-beta.3.vorteo.853 - 2026-10-25

### Fixed

- A restricted Claude session that resumes now also checks the account's own Claude configuration folder, including installed, marketplace and synced plugins, before keeping a bundled skill's name. Same-named copies of shared skills in that folder do not refuse the resume. A plugin skill or a skill with a different folder name that claims the name after launch turns it off. If a skill folder cannot be read, the session keeps no bundled skills and still launches.

## 0.11.0-beta.3.vorteo.852 - 2026-10-25

### Fixed

- Restricted Claude sessions keep Claude's bundled skills, such as claude-api, dataviz, simplify, loop and keybindings-help, instead of losing them. Only skills Claude itself labels as built in are kept, by name, and a name is turned off when a plugin, account or personal skill also uses it. Checked against Claude 2.1.285 on the Host: a restricted session kept every bundled skill except code-review, whose name an installed plugin shares. If Claude's skill report is partial, slow or fails, the session launches without bundled skills rather than failing. Older daemons ignore the new snapshot field and leave these skills out.

## 0.11.0-beta.3.vorteo.851 - 2026-10-25

### Fixed

- Claude tasks no longer fail to launch when a personal skill is missing from the shared library or a skill is excluded. Those launches restrict skills, and Claude's own built-in commands and bundled skills have no files to verify, so every one was refused. Restricted sessions now leave those unverifiable defaults out instead.

## 0.11.0-beta.3.vorteo.850 - 2026-10-25

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.849 - 2026-10-25

### Maintenance

- Merge install web export fixes: Host install exports get script preloads and the build tag, an 8 GB worker heap, and a portable lucide context import

## 0.11.0-beta.3.vorteo.848 - 2026-10-25

### Fixed

- Host installs publish the interface with the same script preloads and build metadata as guarded web builds. Before, every Host install republished it without the per-script preloads added for weak networks.
- The web export in Host installs and guarded web builds runs with an 8 GB worker heap. One Host install failed when a Metro transform worker ran out of memory at the default limit of about 4 GB.
- Web builds no longer fail when Metro reuses transform output from another build of the same commit. The Lucide import plugin wrote an absolute path to the icon context module into cached output, which pointed later builds at another build's folder. It now writes a path relative to the importing file.

## 0.11.0-beta.3.vorteo.847 - 2026-10-25

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.846 - 2026-10-25

### Maintenance

- Merge renewal runtime custody boundaries: coordinator renewals hash the runtime at admission, freeze, unload, start and release instead of before every step

## 0.11.0-beta.3.vorteo.843 - 2026-10-25

### Changed

- Coordinator renewal custody checks hash the coordinator's whole runtime five times instead of about thirty: at admission and immediately before freeze, unload, start and release. Each check compares against the hash admission accepted and fails closed. Every other step keeps its setup, pinned-file, journal and lock checks, and the renewal is re-derived once, at the claim, instead of six times. The separate candidate release checks are unchanged. Expected saving is 200 to 300 seconds per renewal. Watchdog and maintenance runners are unchanged.

## 0.11.0-beta.3.vorteo.845 - 2026-10-25

### Maintenance

- Merge restart settings drift test: every reviewed restart operation's plan comes from a registered setting with the same name, supervisor maintenance excepted

## 0.11.0-beta.3.vorteo.844 - 2026-10-25

### Maintenance

- Complete the shared Lucide fixture for common icons imported by the deferred plugin-icon adapter, restoring collection of four browser and project-screen test files without changing assertions or production behavior.

## 0.11.0-beta.3.vorteo.843 - 2026-10-25

### Added

- Add an explicit browser Data saver preference before optional font loading and in General settings; preserve saved fonts, diagram source, messages and attachment behavior.
- Keep common plugin icons immediate and defer the remaining catalogue, with visible loading, failure and bounded retry controls.

### Changed

- Replace the startup bitmap with the existing V silhouette in inline SVG, retaining the minimal spinner and delayed diagnostics transition.
- Resolve web icon imports and their original provider context without eagerly loading the catalogue; guard the package export layout and preserve native imports.
- Cover provider defaults, icon aliases and optional download state alongside startup, font restoration and diagram consent regressions.

## 0.11.0-beta.3.vorteo.839 - 2026-10-25

### Maintenance

- A test keeps the reviewed restart operations and the reviewed coordinator settings in step. Each operation's plan must come from the registered setting of the same name, at that setting's configuration path, with supervisor maintenance as the one named exception.

## 0.11.0-beta.3.vorteo.842 - 2026-10-25

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.841 - 2026-10-25

### Maintenance

- Merge background Host release retention: old releases are removed after readiness is verified, plain deletion first, with the outcome recorded in the job folder

## 0.11.0-beta.3.vorteo.840 - 2026-10-25

### Fixed

- Host release cleanup always keeps the releases that hold the coordinator's update tooling. Reviewed tooling selection points the Host updater at an old release's scripts folder, and the first backlog cleanup removed that release, so every later Host install failed at its first step until the folder was restored from git.

## 0.11.0-beta.3.vorteo.839 - 2026-10-25

### Fixed

- Cleaning up old Host releases no longer makes a successful Host install report failure. The first cleanup after release retention shipped deleted a backlog of about 40 old releases inside the install, past its 10-minute readiness deadline, so a verified install was marked failed. Cleanup now starts after the install reports its result, records its outcome in `retention.json` in the job's folder, and never runs twice at once.
- Old releases are deleted directly. The slower path that first clears immutable file flags, about half a minute per release, runs only for a release that refuses plain deletion.

## 0.11.0-beta.3.vorteo.839 - 2026-10-25

### Maintenance

- Merge draft and agent history test import fix: the two tests mock the host runtime instead of importing it during setup

## 0.11.0-beta.3.vorteo.840 - 2026-10-25

### Maintenance

- Merge draft and agent history test import fix: the two tests mock the host runtime instead of importing it during setup

## 0.11.0-beta.3.vorteo.821 - 2026-10-25

### Tests

- The live draft and agent history tests mock the host runtime instead of loading it. Its module graph, the daemon runtime and protocol validators, took about 10 seconds to transform, so the draft test's setup missed its 10 second limit even on a lightly loaded Mac. Neither test uses a host client. The draft test now takes about 4 seconds and the history test under half a second, both with plain static imports.

## 0.11.0-beta.3.vorteo.839 - 2026-10-25

### Maintenance

- Merge favourites migration fix: legacy model favourites saved beside the old mode setting migrate, stored preferences are never deleted, and a host is marked migrated only after its favourites are imported

## 0.11.0-beta.3.vorteo.820 - 2026-10-25

### Fixed

- The one-time import of device-local model favourites into host profiles no longer deletes saved new-task preferences. Since 0.11.0-beta.3.vorteo.135 (471d7f22a), preferences saved before Paseo mode was removed still carried `vortonMode`; the import rejected them, removed the whole entry and marked the host done without importing anything. It now reads that shape and keeps the entry. A value it still cannot read is copied to a backup key and the host is retried on a later start, and a host is marked done only after its favourites are imported. Favourites already lost this way have no copy on the device; hosts imported before that change still hold them as `legacy_favorite:` profiles.

## 0.11.0-beta.3.vorteo.838 - 2026-10-25

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.837 - 2026-10-25

### Maintenance

- Merge the published startup diagnostics and recovery interface into the combined Host batch

## 0.11.0-beta.3.vorteo.820 - 2026-10-25

### Fixed

- Startup diagnostics run automatically after 15 seconds, independently of the interface download and document load events. Bounded, deduplicated checks resume after offline or background delays, cancel after startup, and distinguish endpoint health from daemon authentication and session readiness.
- The default V spinner transitions into a compact, scrollable diagnostic panel with reduced-motion support. Pending script downloads stay indeterminate because browsers do not expose live script byte progress; completed timings, observed script events, safe build provenance and existing public restart-request counts retain their limits and freshness.
- Production exports preload the existing entry script without changing its execution order, integrity or cross-origin policy. Optional font CSS no longer blocks the inline diagnostic bootstrap.

## 0.11.0-beta.3.vorteo.836 - 2026-10-25

### Maintenance

- Remove six extra byte-identical copies of four vorteo.758 release notes that branch merges carried onto main on 2026-10-22. One copy of each note remains.

## 0.11.0-beta.3.vorteo.835 - 2026-10-25

### Maintenance

- Merge Host startup contract ancestor rule: folders above the release root are checked for replacement and permission changes but not timestamps, so ordinary writes in the home folder no longer refuse a bootstrap inspection; a node_modules lookup is still refused directly

## 0.11.0-beta.3.vorteo.818 - 2026-10-25

### Fixed

- The Host module contract check no longer refuses a coordinator update because an unrelated file changed in a folder above the release, such as the home folder, where agents rewrite dotfiles. Folders above the release are pinned by device, inode, owner, group and mode, the same as other service custody. Inside the release they keep their full identity. A module lookup appearing anywhere is still refused directly.

## 0.11.0-beta.3.vorteo.834 - 2026-10-25

### Maintenance

- Merge atomic session host markers: the upgrade and restart markers are written to a temporary file and renamed, so a visible marker always has its full content, and the module contract tests no longer depend on changes above their fixtures

## 0.11.0-beta.3.vorteo.818 - 2026-10-25

### Fixed

- The session host writes its upgrade and restart markers through a temporary file and a rename, so anything that sees a marker also sees its whole content. A reader could previously find the upgrade marker empty while it was still being written.

### Tests

- Initial Host module contract tests freeze the stat of directories above their fixture. The contract pins every ancestor's identity, and other processes keep creating entries in the shared temp and home folders, which failed these tests on every retry.

## 0.11.0-beta.3.vorteo.833 - 2026-10-25

### Maintenance

- Merge worker output drain: the supervisor keeps a worker's last stdout and stderr in daemon.log when the worker exits before its output is read, and two install-gate tests no longer depend on load or home directory changes

## 0.11.0-beta.3.vorteo.819 - 2026-10-24

### Tests

- The supervisor test for output that arrives after the worker exits runs only on POSIX, like the existing descendant stdio test. On Windows CI the child's late write never reached the supervisor, so the scenario cannot be staged there; the log stayed intact.

## 0.11.0-beta.3.vorteo.818 - 2026-10-24

### Fixed

- The supervisor no longer loses the end of daemon.log when it exits right after its worker. The worker's exit can be reported before its last output arrives; the supervisor then closed the log, and the late output wrote after the close, which discarded the exit lines still buffered with it. A crashing worker's stack trace could vanish this way. The supervisor now waits up to a second for the worker's output to close before closing the log, and ignores writes once closing begins. Restarts are unchanged.

### Tests

- The maximum-count activation test gets a timeout sized to its 96 locked journal transactions, about 7 seconds idle.
- Dev selector custody tests freeze the stat of directories above their fixtures. The fixtures must live in the home directory, which other processes keep changing, and custody correctly fails when an ancestor changes mid-inspection.

## 0.11.0-beta.3.vorteo.832 - 2026-10-25

### Maintenance

- Merge precompiled built-in plugins: releases compile built-in plugins at build time and the daemon uses them when their digests verify, instead of running esbuild at every start

## 0.11.0-beta.3.vorteo.818 - 2026-10-24

### Changed

- Built-in plugins are compiled when the release is built, so the daemon no longer runs esbuild for them at every start. Each release stores a prebuilt bundle beside every built-in plugin. The daemon uses it only when the bundle's digest and the plugin's source and daemon version still match, and otherwise compiles from source as before. On an idle Mac the plugin phase of a boot drops from about 1 second to about 0.3 seconds; under heavy load, compiling had stretched daemon starts to tens of seconds.

## 0.11.0-beta.3.vorteo.831 - 2026-10-25

### Maintenance

- Merge git process-tree kill: a timed-out git command is killed with its whole process tree, and silent-remote tests ignore the resulting connection resets

## 0.11.0-beta.3.vorteo.819 - 2026-10-24

### Tests

- Silent-remote test servers ignore connection resets. Now that a timed-out fetch's helper is killed, Windows resets its connection, and the unhandled reset failed the server test run even though every test passed.

## 0.11.0-beta.3.vorteo.818 - 2026-10-24

### Fixed

- A git command that times out is killed with its whole process tree. Before, a timed-out fetch or clone over HTTP left its git-remote-http helper running until the remote gave up; on Windows it also kept the repository folder locked.

## 0.11.0-beta.3.vorteo.830 - 2026-10-25

### Maintenance

- Merge batched source contribution git calls: combining a repository-sized batch runs about 430 git processes instead of 1,700, and two timing tests are repaired

## 0.11.0-beta.3.vorteo.818 - 2026-10-24

### Fixed

- Combining source contributions runs a handful of batched git commands instead of several per file. A repository-sized batch spawned about 1,700 git processes and took 26 seconds even on an idle Mac, and over a minute under load; it now spawns about 430 and takes 8 seconds. Release metadata reads every manifest in one git process when the caller supports it.

### Tests

- The Claude zero-token result test no longer fails when the turn outlasts one timer tick. The extra timeline item was the echo of the submitted prompt, not a duplicated assistant reply.
- Worktree manager tests retry temporary directory cleanup. On Windows, the git HTTP helper left by a timed-out fetch briefly keeps the repository open.

## 0.11.0-beta.3.vorteo.829 - 2026-10-25

### Maintenance

- Merge legacy layout freeze fix: restoring an old layout drops empty Explorer drafts instead of mounting thousands of composers, and touch and zoom listeners are shared

## 0.11.0-beta.3.vorteo.818 - 2026-10-24

### Fixed

- Reloading a workspace whose saved Explorer pane collected thousands of empty drafts no longer freezes the page. Every Explorer tab now renders as a supporting card, so each draft mounted a full composer. Restore drops Explorer drafts that hold no saved text, attachments, setup or tab state, and keeps the ones that do. Drafts in ordinary panes are untouched, and when saved drafts cannot be read every Explorer draft is kept. Touch detection and interface zoom now share one window listener each instead of adding one per mounted component.

## 0.11.0-beta.3.vorteo.828 - 2026-10-25

### Maintenance

- Merge macOS-only immutable flag clearing: release removal no longer runs chflags on Linux and Windows

## 0.11.0-beta.3.vorteo.818 - 2026-10-25

### Fixed

- Removing a release tree no longer needs macOS file-flag tooling on other systems. Clearing immutable flags ran `/usr/bin/chflags` everywhere, so on Linux and Windows every removal failed and Host release retention's test removed nothing. Only macOS can set those flags, so clearing them elsewhere now does nothing. The macOS Host was unaffected.

## 0.11.0-beta.3.vorteo.827 - 2026-10-25

### Maintenance

- Merge Windows exclusions: the POSIX-only Docker restart and Factory check suites are skipped on Windows

## 0.11.0-beta.3.vorteo.818 - 2026-10-25

### Maintenance

- Windows server CI skips the Docker restart and Factory check suites. Both verify owner-controlled scripts by POSIX ownership, mode and inode, and run only on the macOS Host.

## 0.11.0-beta.3.vorteo.826 - 2026-10-25

### Maintenance

- Merge symlinked script runs: scripts run through the current release symlink compare real module paths instead of exiting silently

## 0.11.0-beta.3.vorteo.818 - 2026-10-24

### Fixed

- Scripts run through a symlinked path, such as `~/.local/share/vorteo-host/current/scripts/install-execution-host.mjs`, run again instead of exiting silently with status 0. Node loads the entry module by its real path, so the main-module check now compares real paths on both sides. `install-execution-host.mjs` uses the shared `isMainModule` helper, which the other release scripts already use.

## 0.11.0-beta.3.vorteo.825 - 2026-10-25

### Maintenance

- Merge shared restart operations table: supervisor maintenance, Factory adoption, the Docker restart and the Host launcher update share one rule table with unchanged refusal messages and wire fields

## 0.11.0-beta.3.vorteo.815 - 2026-10-24

### Maintenance

- The four reviewed restart operations (supervisor maintenance, Factory adoption, the Docker restart and the Host launcher update) now share one table in the coordinator instead of repeating about a dozen rules each in the restart queue, server, app and CLI. Requests, decisions, dispatch, contribution refusals, automatic approval and the older-client view are checked once per table entry. A new operation is never approved automatically unless its entry says so. Behaviour, wire fields and refusal messages are unchanged.
- Fix a stale server test expectation: the Host CLI has sent the Docker restart and Host launcher review flags with restart and contribution requests since those operations were added.

## 0.11.0-beta.3.vorteo.824 - 2026-10-25

### Maintenance

- Merge shared configuration change shape: reviewed coordinator plans change registered settings through one configurationChanges field checked against a protocol settings registry

## 0.11.0-beta.3.vorteo.815 - 2026-10-24

### Changed

- Reviewed coordinator updates change coordinator settings through one plan field, `configurationChanges`, checked against a shared registry of reviewable settings. Each new setting needs one registry entry, its review text and a test, instead of about fifteen edits across the protocol, server, client, app and owner script. The five places that must refuse configuration changes now share one check.
- Clients negotiate review by setting name. A client that cannot describe a listed setting sees only cancellation and cannot approve it. The older per-setting plan fields keep working, verify identically, and stay accepted until their compatibility dates.

## 0.11.0-beta.3.vorteo.823 - 2026-10-25

### Maintenance

- Merge four timing fixes: large validators and draft modules load outside test timeouts, built-in plugins start concurrently so daemons boot about twice as fast, and small artifact digests hash on the scan thread

## 0.11.0-beta.3.vorteo.815 - 2026-10-24

### Changed

- The daemon starts its built-in plugins concurrently instead of one after another. It accepts connections only once they have all started, so each daemon start or restart waited for every plugin's compile and launch in turn; a test daemon now boots in about 7 seconds instead of 16.
- Artifact verification hashes small artifacts on its scan worker instead of starting a separate reader thread, halving the threads started per verification. Large release trees still use parallel readers.

### Maintenance

- Fix four tests that timed out in full runs. Two loaded large modules inside their timeout: the protocol snapshot test imported the 9.6 MB generated validator, and the composer draft test imported its hook in a setup hook. Both now import at module load. The native helper replacement and compiled held restart tests sped up from the two changes above.

## 0.11.0-beta.3.vorteo.822 - 2026-10-25

### Maintenance

- Merge renewal step timing: the runner diagnostic file records count and duration per phase and executor operation

## 0.11.0-beta.3.vorteo.815 - 2026-10-24

### Added

- Coordinator runner diagnostics record how long each runner phase and each executor operation (freeze, unload, selection, start, verification and others) took, in a bounded `timings` map in the runner's diagnostic file. A renewal that takes minutes now shows where the time went. Logging only; nothing a renewal does changes.

## 0.11.0-beta.3.vorteo.821 - 2026-10-25

### Maintenance

- Merge release-note dedupe: the combine step skips byte-identical incoming notes and accepts branches cut before duplicate copies were removed; AGENTS.md asks threads to wait for Builds' install checks before heavy suites

## 0.11.0-beta.3.vorteo.817 - 2026-10-25

### Documentation

- Keep the agent guide within its 32 KiB budget: the Builds gate marker rule is now one line that links to a new development doc section with the marker's fields, the wait rule and the shell check.

## 0.11.0-beta.3.vorteo.816 - 2026-10-24

### Fixed

- Combining source contributions accepts a side that removed extra byte-identical copies of a release note, as long as one copy remains. A branch cut before a duplicate cleanup still combines, and deleting or editing any note is still refused.

## 0.11.0-beta.3.vorteo.815 - 2026-10-24

### Fixed

- Combining source contributions no longer copies a release note that is byte-identical to one already accepted, or repeated within the contribution. Repeated version headings with different notes still combine. Six exact copies of two vorteo.758 notes reached `main` this way on 2026-10-22, carried in from branch merges.

### Documentation

- The agent guide tells threads to check Builds' install gate marker before a full or heavy test suite, with a one-line shell check.

## 0.11.0-beta.3.vorteo.820 - 2026-10-25

### Maintenance

- Merge commit-hook declaration freshness: protocol and client declarations rebuild before typecheck when their sources are newer

## 0.11.0-beta.3.vorteo.815 - 2026-10-24

### Fixed

- The pre-commit hook no longer fails typecheck on stale protocol or client declarations after a branch switch. It rebuilds them first, only when their sources are newer than the last successful build, which costs nothing on a clean commit.

## 0.11.0-beta.3.vorteo.819 - 2026-10-25

### Fixed

- Startup health checks distinguish invalid responses, rejected network requests and actual eight-second timeouts. Script download errors and JavaScript execution errors have separate safe diagnostics, with hashed script paths, transfer timing, exception class and allowlisted engine messages instead of private exception text.
- After a confirmed entry-script download failure, the loader can retry that exact script once without reloading the page. It preserves integrity, nonce, cross-origin and referrer restrictions, and does not offer download retry for execution errors. Reports include the current origin, expected-origin match and service-worker control state; unknown causes remain unknown.

## 0.11.0-beta.3.vorteo.818 - 2026-10-25

### Added

- The delayed startup screen now offers the existing connection checker, separating endpoint health, WebSocket transport, app authentication and thread-directory readiness. It includes elapsed time and reload; a connected directory does not claim a selected workspace is ready.
- The initial HTML loader can check its installation endpoint and copy a sanitized report even when the app bundle has not started. Failed script loads remain visible, and clipboard denial leaves a selectable report. Unknown daemon and session states remain unknown.

## 0.11.0-beta.3.vorteo.817 - 2026-10-25

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.816 - 2026-10-22

### Maintenance

- Merge the Dev worktree link repair: a listing-first command rewrites older Dev worktree links from the container path to the Projects folder path, with backups, skipping kept paths

## 0.11.0-beta.3.vorteo.807 - 2026-10-23

### Added

- `install-execution-host.mjs repair-projects-folder-worktree-links` repairs git worktree links that Dev wrote through its old container path before links were rewritten. The Host sees those worktrees as prunable, so a Host `git worktree prune` would orphan them for Dev too. By default it only lists what it would change; `--apply` rewrites each link to the Projects folder's logical path atomically, after a backup beside it. It skips kept paths such as freed, links already in logical form, worktrees outside the Projects folder and links whose worktree is missing, and reports container-only worktrees that a Host prune would orphan. A second run changes nothing.

## 0.11.0-beta.3.vorteo.815 - 2026-10-22

### Maintenance

- Merge Host release retention and dependency cloning: Host builds clone dependencies from a private integrity-checked cache, and old Host release folders are pruned after each verified install, keeping current, previous, every release a plan or unfinished job names, and the newest three

## 0.11.0-beta.3.vorteo.811 - 2026-10-23

### Changed

- Approved Host builds clone dependencies from a private copy-on-write cache instead of running a full `npm ci`, so releases share their unchanged 2.4 GB of `node_modules`. Only Host builds fill that cache, with an integrity-checked install.

### Fixed

- Old Host releases no longer pile up (43 releases, about 137 GB on 2026-10-23). After each verified Host install, the coordinator removes job folders that no plan or unfinished job references, keeping the selected, previous and three newest releases.

## 0.11.0-beta.3.vorteo.814 - 2026-10-23

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.813 - 2026-10-22

### Maintenance

- Merge the CLI worktree fix: paseo worktree ls and archive send the current folder, or --cwd or --repo, so they work again

## 0.11.0-beta.3.vorteo.807 - 2026-10-23

### Fixed

- `paseo worktree ls` and `paseo worktree archive` work again. Since upstream commit a94bc0720 the daemon refuses a worktree list without a repository, and both commands sent none, so they always failed with "cwd or repoRoot is required". They now list the worktrees of the current directory's repository.
- Both commands accept `--cwd <path>`, matching `paseo worktree create`, and `--repo <path>`, which names the repository root and takes precedence. Relative paths resolve against the current directory.

### Maintenance

- Unit tests check the list request for the default directory, `--cwd` and `--repo`; the CLI worktree end-to-end test checks both options in help.

## 0.11.0-beta.3.vorteo.812 - 2026-10-22

### Maintenance

- Merge automatic closure of failed coordinator updates: an automatic successor may close an automatic update that failed before promotion for the same coordinator process; owner-reviewed failures still need review

## 0.11.0-beta.3.vorteo.807 - 2026-10-23

### Fixed

- An automatic coordinator update that failed before promotion, and so never froze or replaced the running coordinator, no longer waits for a hand-built successor. An automatic renewal can name it in `recoveredFrom` and is approved under Host coordinator permission, after the coordinator proves under its journal lock that the failure was never promoted and that the successor expects the same coordinator process. Owner-reviewed failures, failures after promotion, claimed recoveries and configuration changes still need the owner, so a reviewed change is never dropped.

## 0.11.0-beta.3.vorteo.811 - 2026-10-22

### Maintenance

- Merge the Host launcher update, Factory checks around Dev restarts and the tracked Docker restart: each is a plan-bound job that stays off until an owner-reviewed coordinator renewal adds its plan, is never approved automatically, verifies its result and restores on failure

## 0.11.0-beta.3.vorteo.802 - 2026-10-23

### Maintenance

- Update the app installation client tests for the restart query flags that negotiate the Docker restart and Host launcher review. Non-restart requests are unchanged.

## 0.11.0-beta.3.vorteo.801 - 2026-10-23

### Added

- A one-time, owner-approved Host launcher update adds managed release selection to the Host's launchd plist, so later worker-only Host restarts load the selected build instead of the one the supervisor started from. It finishes turns, keeps the previous plist as a fallback, reloads the service once, and verifies the server identity, a new supervisor, the selected version and both settings in the live process. Any failure restores the previous plist. Reviewed coordinator plans and renewals accept `hostLauncherUpdateConfiguration` to set its plan.

## 0.11.0-beta.3.vorteo.800 - 2026-10-23

### Added

- Once configured through a reviewed coordinator renewal, the coordinator runs Factory's read-only lock acceptance check around every restart that replaces the Dev worker. A restart is refused with nothing changed if Factory isn't in a known good state. It's reported as failed, naming the difference, if it moved Factory's controller, owner pause or custody records in a way its class doesn't allow. Builds no longer has to take and compare Factory snapshots by hand.

### Changed

- The tracked Docker restart also requires Factory's supervisor to be a new process afterwards.

## 0.11.0-beta.3.vorteo.799 - 2026-10-23

### Added

- The installation coordinator can run a tracked Docker Desktop restart for Dev. A trusted Host request with `--engine-restart-plan` creates a Dev restart bound to the exact configured plan. After the owner or a delegated lead chooses Finish turns and restart Docker, it checks the engine, the pinned Dev and gateway containers and Factory's lock acceptance, restarts Docker once, and verifies that every container returned under its ID, Dev is healthy, a new Dev worker answers and Factory's controller epoch advanced. It is never approved automatically and never retried.
- Reviewed coordinator plans and renewals accept `engineRestartConfiguration` to set or remove that plan. Clients that do not negotiate the field see it hidden and can only cancel.

## 0.11.0-beta.3.vorteo.810 - 2026-10-23

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.809 - 2026-10-22

### Maintenance

- Merge the Host restart check: a Host update whose restarted daemon still runs the previous build fails before publishing, keeps the new release selected and refuses replay

## 0.11.0-beta.3.vorteo.799 - 2026-10-23

### Fixed

- A Host source update no longer reports success when the Host comes back on the previous build. An idle or held restart replaces only the daemon worker, and the running supervisor starts that worker from the release it was launched from, so on 2026-10-21 the update to vorteo.729 succeeded while the daemon still ran 726. After the restart the install now compares the version the Host daemon reports with the new release. On a mismatch it fails before publishing the interface, keeps the new release selected so a full Host restart loads it, and refuses to replay. When the version cannot be read, readiness alone still decides, as before.

## 0.11.0-beta.3.vorteo.808 - 2026-10-22

### Maintenance

- Merge the pruner resilience fix: removing an abandoned web build retries briefly, and a build that still cannot be removed is reported and skipped instead of stopping the prune

## 0.11.0-beta.3.vorteo.800 - 2026-10-23

### Maintenance

- Move the web build pruner's per-build decision into its own helper so the prune loop stays within the lint complexity limit. Behavior is unchanged.

## 0.11.0-beta.3.vorteo.799 - 2026-10-23

### Fixed

- The web build pruner no longer stops at the first build it cannot delete. A directory that stays non-empty mid-removal, for example while another cleanup deletes the same tree, is retried with backoff, then reported and skipped while the rest of the prune continues. On 2026-10-23 one such build crashed the whole run.

## 0.11.0-beta.3.vorteo.807 - 2026-10-22

### Maintenance

- Merge the Windows path fixes: Projects folder aliases, separators, case and 8.3 short names compare correctly on Windows, git trust sends long forward-slash paths, and project exclusions apply on Windows

## 0.11.0-beta.3.vorteo.799 - 2026-10-22

### Fixed

- Project exclusions now apply on Windows. Policy keys and working folders compare with either separator and without case for Windows paths, keys written through a symlink or an 8.3 short name also match the real folder, and the coordinator accepts Windows root paths as keys.
- The Projects folder accepts folders inside it on Windows. Containment compares real paths from the native resolver on both sides, so an 8.3 short temp path such as `RUNNER~1` no longer reads as outside the folder.
- Projects folder aliases map Windows paths with either separator and without case, and project keys with Windows paths map too. POSIX aliases and earlier locations from another daemon stay as written on Windows instead of being placed on the current drive.
- The per-command and agent `safe.directory` entries name the repository's long real path with forward slashes on Windows, the form git there reports and compares.

## 0.11.0-beta.3.vorteo.806 - 2026-10-23

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.805 - 2026-10-22

### Maintenance

- Merge the two-option Add project flow: Choose a folder in the Projects folder or Clone from GitHub, with a folder browser that creates folders inline

## 0.11.0-beta.3.vorteo.799 - 2026-10-22

### Maintenance

- Merge main into the two-option Add project branch. Main contributed the live Projects folder work (aliases, kept paths, git trust, projects in every environment and per-project exclusions) and the settings and provider pages; there were no textual code conflicts. Both sides had added the Projects folder to the stored server info, so the duplicate is dropped, and Add project now reads the folder through main's shared helper and formats folder errors with main's error wording. Both changelog and customization histories are kept in full.

## 0.11.0-beta.3.vorteo.767 - 2026-10-22

### Added

- Clone from GitHub on hosts with a Projects folder clones into Projects/<repository> with one click. Change location opens the same folder browser, whose footer button reads Clone here, and New folder works there too. The clone runs on the installation's Host daemon.

### Maintenance

- Tests cover the default clone destination, changing it in the folder browser, cloning into a nested or new folder, and the earlier methods on hosts without a Projects folder. This supersedes the work-in-progress note in 0.11.0-beta.3.vorteo.766.

### Known limitations

- Not installed. The browser end-to-end checks for this flow have not been run, so layout and keyboard behaviour are unverified in a real browser.

## 0.11.0-beta.3.vorteo.766 - 2026-10-22

### Added

- Add project offers two choices on hosts with a Projects folder: Choose a folder and Clone from GitHub. There is no host step and no Search for directory, New project folder or Choose in Finder option. Hosts without a Projects folder keep the earlier flow.
- The folder browser starts in the Projects folder with a breadcrumb. Its list only moves between folders; a fixed footer names what it will add, and Add is disabled at the Projects folder itself. New folder creates a folder in place without making it a project and opens it. Git checkouts have an inline Add button, registered projects show a Project badge, and the last folder is remembered per host.

## 0.11.0-beta.3.vorteo.804 - 2026-10-22

### Maintenance

- Merge the Playwright helper fix: waiting for a connected host checks Settings > Environments > Connections, and opening Settings waits for the toolbar button

## 0.11.0-beta.3.vorteo.800 - 2026-10-22

### Fixed

- The browser test helper that opens Settings waits up to five seconds for the toolbar Settings button before falling back to the overflow menu, which no longer lists Settings. Specs that opened Settings right after a reload used to time out.

## 0.11.0-beta.3.vorteo.799 - 2026-10-22

### Fixed

- Browser tests that wait for a second host no longer time out. `waitForConnectedHost` now checks the host's endpoint in Settings > Environments > Connections and returns to the workspace, instead of opening the sidebar Hosts control that was removed on 2026-10-06. This affects the Add project, host appearance and project grouping specs.
- The sidebar footer check no longer expects the removed Hosts control.

## 0.11.0-beta.3.vorteo.803 - 2026-10-22

### Maintenance

- Merge the Main CI repair: onboarding no longer requests a retired pairing offer, the sidebar stops re-rendering on every status change, test daemons honor PASEO_SYSTEM_PROJECT, provider key order no longer reads as a change, plugin calls survive reconnects, plugin dark themes get status colors, What's New keys are unique, account routes mount behind one provider-neutral function; stale tests repaired or retired and CI jobs build what they test

## 0.11.0-beta.3.vorteo.802 - 2026-10-23

### Maintenance

- Windows server CI skips the whole session host directory, which is POSIX-only by design, so new session host suites no longer need listing one by one. A provider secret test that checks private file modes is skipped on Windows.

## 0.11.0-beta.3.vorteo.801 - 2026-10-22

### Maintenance

- Restore the connection check phone screenshot, which a local browser test run rewrote and the previous commit picked up by mistake.

## 0.11.0-beta.3.vorteo.800 - 2026-10-22

### Maintenance

- Repair macOS-only server tests that Linux CI never runs. Two native recovery suites found the process inspector script from the working directory, and the port allocator test compared a temporary path with its canonical form behind the macOS /var symlink.

## 0.11.0-beta.3.vorteo.799 - 2026-10-22

### Maintenance

- Merge main at 0.11.0-beta.3.vorteo.797 into the CI repair branch. The provider-neutral installation account mount now also covers the Host-refreshed Claude sign-in and provider secret deliveries, sharing one catalog refresh callback.

## 0.11.0-beta.3.vorteo.790 - 2026-10-22

### Maintenance

- Settle a timing-dependent agent skills test. It created a new query client on every render and kept stale shared settings after a save, so a refetch could report the old selection.

## 0.11.0-beta.3.vorteo.789 - 2026-10-22

### Fixed

- Plugin calls no longer fail with "Plugin daemon identity is unavailable" while a plugin's connection to its daemon reconnects. The plugin process keeps the identity of the one daemon it serves.

### Maintenance

- A CLI lifecycle test waits for the daemon lock file's contents, which are written after the file is created, as product readers already do.

## 0.11.0-beta.3.vorteo.788 - 2026-10-22

### Fixed

- New Codex threads on accounts with remote plugins no longer fail with "Provider skill catalog changed during this task". Codex finishes syncing remote plugin skills after its first skill listing, so the next listing grew, for example from 20 to 64 entries on Codex 1. The check now compares only the selected skills. Each turn still sends a filter rebuilt from the current listing, which keeps plugin skills that appear later disabled.

- Merge main at 0.11.0-beta.3.vorteo.787 into the CI repair branch so it integrates cleanly with the next batch.

## 0.11.0-beta.3.vorteo.784 - 2026-10-22

### Fixed

- Removing a full sign-in Claude account no longer runs Claude's sign-out when the account has no configuration directory of its own. A daemon started from an agent shell inherits another account's directory, so that sign-out could have signed out a different account.

- Stop two server test races. The Host module contract pins every ancestor directory, so its tests retry when a parallel suite touches a shared ancestor mid-inspection. A message queue test waits for its last write before deleting its directory.
- The browser test helper opens New workspace from the sidebar overflow menu, since it is no longer a default sidebar row.

## 0.11.0-beta.3.vorteo.785 - 2026-10-22

### Fixed

- `PASEO_SYSTEM_PROJECT=0` now reaches the daemon. The configuration allowlist dropped it, so every test daemon, including the browser test harness, seeded the System project and its standing agent.
- A daemon config reload no longer reports and reapplies provider settings that only changed key order.

### Maintenance

- CI stops a hung Playwright shard after 90 minutes and the app job after 30, instead of holding runners for hours. The app browser run pre-bundles `react/jsx-dev-runtime` so Vite no longer reloads mid-run.
- Retire the desktop relay pairing E2E spec; the pairing modal it drove was removed with device pairing.
- CLI lifecycle tests expect a daemon whose address is held by another process to wait as not ready, as listen reclaim intends, and stop it.

## 0.11.0-beta.3.vorteo.783 - 2026-10-22

### Maintenance

- Combine 1 source contributions; retain their release notes below

- Skip server suites for POSIX-only Vorteo features on Windows CI: the installation coordinator, session host, Host account delivery and Host process custody, plus `*.posix.test.ts` as the testing guide already promised. Upstream suites keep running there; individual Vorteo cases inside them that need POSIX modes, signals or symlink swaps are gated case by case.
- Two bootstrap suites now start daemons without the System project, like every other test daemon. On Windows a handle stayed open on its directory after the daemon stopped.
- The preview monitor test retains its own Node copy, and the Dev installer check runs only for Dev's in-root release layout, matching Linux CI.

## 0.11.0-beta.3.vorteo.783 - 2026-10-22

### Fixed

- Running `paseo` onboarding no longer crashes after starting the daemon. It still asked for a device pairing offer, which the daemon has refused since pairing was retired; it now ends with direct-connection guidance.
- A workspace status change no longer re-renders the whole sidebar. The sidebar subscribed to every host's workspace map to place managed worktrees; it now subscribes to the placements themselves.
- What's New keeps distinct list keys when parallel branches publish the same version on the same date.

### Changed

- Plugin dark themes use the same lifted status colors as the built-in appearances, restoring the parity their tests require.

### Maintenance

- Repair app, browser, CLI and desktop tests for CI. Two browser suites hung CI's app job forever: their layout mock awaited a module that now imports itself back through the zoom and shortcut stores. Other suites now wait for entering animations, use desktop viewports where menus became compact sheets, follow retired pairing, the System project, neutral label colors and the status ring, and stop writing screenshots outside the workspace.

## 0.11.0-beta.3.vorteo.774 - 2026-10-22

### Added

- Switch a thread to another account or profile without leaving it. Choosing a profile on another account for an existing thread now offers Switch in this thread by default, with a warning that switching uses extra tokens; New task instead keeps the reviewed successor. The quota notice gains a Switch account button.
- The daemon closes the thread's native session, starts one on the target account with up to 30 recent messages as session instructions, clears the quota pause and keeps the thread's ID, goal, checklist, journal and questions. Busy threads are refused.
- A compaction-style marker names both accounts and models. History before each switch is retained, so reloads replay every segment in order.
- Requires the daemon's `agentProfileSwitch` capability; older interfaces don't receive the marker. Tool results and provider-private state don't carry over, and automatic pooled switching remains planned. See the [profile switching plan](docs/plans/profile-switching.md).

- Merge main at 0.11.0-beta.3.vorteo.781 into the CI repair branch so it integrates cleanly with the next batch; the authorization test keeps main's stronger unknown-observation check.

## 0.11.0-beta.3.vorteo.777 - 2026-10-22

### Maintenance

- Repair the installation test suites that failed on Linux CI. Server tests now use a private temporary root when the system one is shared, because installation custody rightly refuses world-writable ancestors such as Linux /tmp. Tests that read the native macOS launcher, LaunchAgents or Host observer run only on macOS. The server test job builds the server, which the supervisor suites execute. A retained v682 Dev provisioner is now a captured fixture rather than a reconstruction from today's generator, and still verifies.

## 0.11.0-beta.3.vorteo.776 - 2026-10-22

### Maintenance

- Repair the server test suites that failed CI on Linux. The server's own Factory contract imports now resolve to source in tests, so suites load without a server build. Test fakes gain the archive guards, origin admission and per-client capability checks the server now calls. Tests follow deliberate changes: uncertain config writes, saved compaction summaries, shared skill selection, retired device pairing. Built-in plugin fixtures use canonical temporary paths, which the Factory custody checks require on macOS.

### Changed

- Installation account delivery routes mount through one provider-neutral function, keeping Claude-specific wiring out of the daemon bootstrap.

## 0.11.0-beta.3.vorteo.775 - 2026-10-22

### Maintenance

- Format the Builds push guard script and its test, which failed the CI format check on main.

## 0.11.0-beta.3.vorteo.798 - 2026-10-22

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.797 - 2026-10-22

### Maintenance

- Merge the Projects folder follow-up: Dev git trusts repositories inside the Projects folder, membership keys and Host sidebar keys move to the folder path

## 0.11.0-beta.3.vorteo.796 - 2026-10-22

### Fixed

- Dev's git no longer refuses repositories in the Projects folder as dubiously owned. Each daemon git command inside the folder or its aliases trusts that repository's exact physical top level for that command only, found without running git; worktree creation and git status in new worktrees work again. Repositories elsewhere get no override.
- Agents and terminals in Dev trust new projects and Paseo-owned worktrees too: the daemon appends each exact physical path reached through an alias to its user's global `safe.directory`, once, with no wildcard.
- Workspaces whose membership key still named the old container path rejoin their project in the sidebar. The startup registry move and every registry write now map `projectMembership.key` to the logical path, respecting kept paths, and the move repairs registries migrated earlier.
- Projects whose keys moved keep their saved sidebar order, collapse state, filters and folders. The daemon rewrites saved project keys under a Projects folder alias once when it opens `sidebar-state.json`, after a backup, keeping the new key's value when both exist.

### Changed

- `configure-projects-folder` gives the Host the same earlier paths, aliases and kept paths as Dev, including the mount it finds, so shared keys that Dev recorded map alike on the Host. Run it again with the same flags before the Host update.

## 0.11.0-beta.3.vorteo.796 - 2026-10-22

### Maintenance

- Merge the settings redesign: About folded into General, diagnostics into Connected hosts, provider pages in Accounts and profiles, and API keys shared across environments

## 0.11.0-beta.3.vorteo.783 - 2026-10-22

### Fixed

- Opening Settings at a section keeps that section in view while content above it finishes loading, even when several sections grow at once. A jump that lands short because sections below are still mounting completes once they appear instead of leaving the page wherever it stopped.

### Tests

- Settings navigation tests expect Diagnostics under General, and the sticky environment tabs check waits for wheel scrolling to settle before measuring.

## 0.11.0-beta.3.vorteo.782 - 2026-10-22

### Changed

- Settings no longer has a separate About section. App version, What's new and a new GitHub row sit in an About card inside General. Connected hosts moves to General and now holds the connection check (from Environments) and the diagnostics rows (from Maintenance) in one card. Sending moves to Chat & editor, and New workspace defaults move to Workspaces & projects. Old About and Diagnostics links open the new locations.
- Accounts & profiles lists each provider as a row that opens the provider's own page. The page shows its connections with one combined status ("Ready everywhere", or only the environment that differs), quota bars on each connection, Profiles with a star for the default, Model defaults, and a quiet "Remove from Vorteo" row at the bottom. The per-provider tab row, the separate Plan usage list and the Host / Dev container tabs in the Manage sheet are gone; Environment access in each connection's menu holds the rare per-environment opt-out. Add provider and Add connection install and sign in on Host by default.

### Added

- The installation coordinator stores provider API keys and tokens once and delivers them into every bound environment's provider configuration, withdrawing them from excluded and removed environments. Delivery starts on save and retries every 5 seconds. Owner routes under `/api/installation/owner/provider-secrets/` set and clear keys and report status for each environment, returning only names, last four characters and timestamps. Daemons advertise `providerSecretDelivery`. On first sync a key found in exactly one form is adopted; differing values are reported as conflicts and never overwritten silently.
- Each connection on a provider page has an API keys sheet showing which environments have the current keys. Codex connections show which environments still need their own sign-in; Codex refresh grants are not copied between environments.
- Host-owned refresh for full sign-in Claude accounts remains opt-in through `claudeHostRefresh: true`.

### Tests

- The packaged installation browser test opens provider pages and connection menus instead of the removed Manage sheet, installs runtimes on Host by default and in the Dev container explicitly, and removes a provider from its page. Environment access keeps showing Connect for an environment that is turned off, so a restored connection can sign in again.

## 0.11.0-beta.3.vorteo.795 - 2026-10-22

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.794 - 2026-10-22

### Maintenance

- Merge the coordinator cleanup that cancels coordinator updates a newer Host install made stale

## 0.11.0-beta.3.vorteo.789 - 2026-10-22

### Maintenance

- The reconciliation ledger test now lists the stale coordinator update cancellation among the coordinator loop's allowed operations. Like automatic-approval revocation, it can only cancel undispatched requests; preparation, owner decisions and dispatch claims stay off the loop's surface.

## 0.11.0-beta.3.vorteo.788 - 2026-10-22

### Fixed

- A coordinator update prepared for a Host release that a later Host install replaced no longer waits in front of the owner. The coordinator cancels such pending or approved-but-not-started updates by itself, keeps updates prepared on the newly selected release, and never touches recovery successors, supervision plans or restart jobs. On 2026-10-22 one such update went stale at 07:28 UTC and needed a manual cancel.
- When installation work is refused because a coordinator update is running, the message now names that update. The documented prefix is unchanged.

## 0.11.0-beta.3.vorteo.793 - 2026-10-22

### Maintenance

- Merge the Projects folder: projects live in one folder every environment can use at the same path, with per-project exclusions and kept paths

## 0.11.0-beta.3.vorteo.789 - 2026-10-22

### Added

- Projects folder settings accept `keepPaths`, exact recorded paths that the Dev registry move and the daemon's path mapping leave untouched. `configure-projects-folder --keep-path <path>` records them. This keeps a project root that an older Factory binding compares by string, such as Dev's freed project, dispatchable after the move. Paths below a kept path, and siblings that only share its prefix, still move to the Projects folder.

## 0.11.0-beta.3.vorteo.788 - 2026-10-22

### Maintenance

- Merge current main into the Projects folder branch. Settings > Projects keeps one row per project and uses the readable error wording from main, and switching a thread to another account now also applies the project's exclusions. Every release-note entry from both sides is kept.

## 0.11.0-beta.3.vorteo.768 - 2026-10-22

### Added

- Projects folder aliases. `projects-folder.json` accepts `aliases`, other absolute paths of the same folder; `migrateFrom` entries and the root's real path count as aliases too. An existing Dev container can now use the shared Projects folder through a symlink at the folder's own path to its older mount, without being recreated.
- Daemons record every project, workspace, worktree and main checkout path, and local project keys, by the folder's logical path, mapping alias paths from clients, git and new worktrees. The startup registry move covers alias paths and stays idempotent. Browsing and `server_info.projectsRoot` always use the logical root.
- New worktrees in the Projects folder have their git link files rewritten from an alias path to the logical path, so a worktree created by Dev opens on the Host. Worktree folders are named from the logical repository path, and worktrees named from an alias path stay listed.
- `configure-projects-folder` accepts a container that reaches the folder's own path through a symlink to its mount, found by read-only inspection, and records the mount path as an alias. Without the symlink it writes nothing to Dev and prints the root command to create it and a command to verify it. `--alias` adds further aliases.

### Changed

- The Projects folder guide describes the no-recreate setup for existing Dev containers: create the symlink, verify, configure, update both daemons, verify and roll back.

### Known limitations

- Processes inside Dev, such as agents, terminals and `pwd`, may still print the physical alias path. Agent records outside the project and workspace registries are not rewritten. Git before 2.46 needs one `safe.directory` entry per repository, named by its alias path. Nothing is installed yet.

## 0.11.0-beta.3.vorteo.767 - 2026-10-22

### Added

- Project exclusions. A project's settings page has an Exclusions section, available once Installation controls are unlocked, that turns off the Host or Dev container, accounts, profiles or skills for that project. The installation stores them by project root path, never in `paseo.json`, and refuses a change that leaves the project without an environment.
- Daemons refuse an agent launch in an excluded environment or with an excluded account or profile, naming the project's Exclusions setting, and leave excluded skills out. Creating a workspace in an excluded environment is refused too.
- Environment and profile menus hide what the project excludes, using a copy of the policies the coordinator keeps in each daemon's config.

### Known limitations

- Plugins cannot be excluded per project. Daemons and coordinators need updating before exclusions apply; older ones keep working without them. Nothing is installed yet.

## 0.11.0-beta.3.vorteo.766 - 2026-10-22

### Added

- Projects in a shared Projects folder work in every environment without setup. When the Host and the Dev container advertise the same Projects folder, starting a workspace or moving a draft to an environment that has no copy of the project uses the identical path there and adds the project on demand, with no folder prompt.
- The sidebar and new-workspace picker show one project for placements at the same path inside the shared Projects folder, even without a git remote. Stored project keys are unchanged.
- Settings > Projects lists each project once and opens one settings page, the Host's placement when there is one, because both environments edit the same `paseo.json`.
- Moving a draft to another environment shows a one-line reminder that dependencies installed in the other environment, such as `node_modules`, may need reinstalling.

### Known limitations

- Daemons without a matching Projects folder keep the earlier folder mapping and folder chooser. Nothing is installed yet.

## 0.11.0-beta.3.vorteo.765 - 2026-10-22

### Added

- Projects folder for installations. A daemon given `$PASEO_HOME/projects-folder.json` or `PASEO_PROJECTS_ROOT` accepts new projects from Add project, Open project, new folders and GitHub clones only strictly inside that folder; symlinks and `..` cannot leave it and the folder itself is refused. Projects registered earlier keep working wherever they are.
- Folder browsing and directory search start in the Projects folder, and listings mark git checkouts and registered projects. A folder can now be created without adding it as a project, on hosts that advertise `projectsRoot`.
- New Paseo-owned worktrees go in the Projects folder's hidden `.vorteo/worktrees` unless `worktrees.root` is set. Worktrees in the previous location stay recognized for listing, archiving and cleanup.
- The Dev daemon moves registry paths from an earlier container path of the folder to its identical path once at startup, after backing up `projects.json` and `workspaces.json`.
- `PASEO_PROJECTS_FOLDER` makes the container installer mount the folder at its own path, and `install-execution-host.mjs configure-projects-folder` writes both daemons' settings and the Dev git trust for existing installations.

### Known limitations

- The Add project interface does not use the Projects folder yet, and nothing is installed. Recreating the Dev container for the identical-path mount discards releases installed in its writable layer.

## 0.11.0-beta.3.vorteo.792 - 2026-10-22

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.791 - 2026-10-22

### Maintenance

- Merge the coordinator renewal fix that lets a reviewed renewal turn Host-owned Claude refresh on

## 0.11.0-beta.3.vorteo.788 - 2026-10-22

### Fixed

- The Host Claude refresh setting can actually be turned on. Every coordinator replacement now runs as a renewal, and renewals refused all configuration changes, so the reviewed `claudeHostRefreshConfiguration` field from vorteo.768 had no usable path. Owner-reviewed renewals now accept that one field, as they already accept Factory adoption, with a candidate configuration that differs only by `claudeHostRefresh`. Recovery keeps the previous configuration, and automatic coordinator updates still refuse the change.

## 0.11.0-beta.3.vorteo.790 - 2026-10-22

### Maintenance

- Merge the session host tool relay: hosted providers reach agent tools through the session host, and a call cut off mid-run is never repeated

## 0.11.0-beta.3.vorteo.768 - 2026-10-22

### Validation

- The relay end-to-end scenario no longer depends on timing. The scripted provider used to make its tool call three seconds after the worker was killed, and on a fast machine the replacement worker was already listening by then, so the hold the scenario proves never happened. The provider now waits for a trigger file the test writes right after the kill, so the call always goes out while no worker listens.

## 0.11.0-beta.3.vorteo.767 - 2026-10-22

### Fixed

- The tool relay never answers a notification. A notification refused with a failed status or held past the bound used to get an error line with a null id, which JSON-RPC forbids and a provider's client might mishandle; the relay now only logs the drop. The relay also aborts a connection's in-flight requests at the daemon when the provider's connection closes, so a long tool call such as waiting on an agent stops running once its session is gone.

### Validation

- Relay tests cover a notification refused with a failed status and one held past the bound, neither producing a line while the requests around them are answered, and a held tool call whose provider connection closes, which the stand-in daemon sees closed before any reply.

## 0.11.0-beta.3.vorteo.766 - 2026-10-22

### Fixed

- The tool relay decides each tool call's fate from its own reply. The daemon sends its reply headers the moment a call arrives, so almost every call interrupted by a worker restart dies as a broken reply stream, and the relay reported those as "tools unavailable", which told the model the call never ran. The relay now speaks to the daemon's endpoint directly, one request per message, reading the JSON or SSE reply itself: a tool call whose stream breaks, ends without a reply or gets a failed status is answered as unknown outcome, while a read-only request is repeated. A failure on one call no longer touches the other calls in flight on the same connection, so each request gets exactly one reply. A rejected token is held within the bound, since it comes from a worker that has not learned the host's token yet.

### Validation

- Relay tests run against a stand-in daemon that sends SSE headers first, as the real one does: a tool call whose stream breaks after the headers, one dropped before them, one whose stream ends without a reply and one refused with a failed status are each answered as unknown and seen once; a read-only request dropped the same ways is repeated and answered; two calls in flight where one fails with a status, or is refused and held while the daemon stops listening, leave the other streaming and answered exactly once; a token rejected twice is delivered on the third attempt; a token never accepted fails at the hold bound.

## 0.11.0-beta.3.vorteo.765 - 2026-10-22

### Fixed

- The tool relay no longer repeats a tool call that may have run. A worker that received a relayed call and died before answering made the relay resend it to the next worker, which could run the tool twice: a second prompt sent, a second agent created, a duplicate journal entry. The relay now repeats a message only when repeating it does no work (notifications and read-only methods such as initialize, ping and the list and read methods) or when the connection was refused or unreachable, so the request certainly never arrived. A tool call that fails any other way after it may have reached a daemon gets an error at once saying the daemon restarted during the call and its outcome is unknown, so the caller checks before repeating it.

### Validation

- Relay tests cover a tool call the daemon accepted and dropped before answering, which is answered with the unknown-outcome error and seen by the daemon exactly once while the connection stays usable; a read-only request dropped the same way, which is repeated and answered; and a tool call held through a refused connection and delivered once to the daemon that appears.

## 0.11.0-beta.3.vorteo.764 - 2026-10-22

### Features

- Tool relay for hosted sessions. A provider running in the durable session host now reaches the daemon's agent tools through the host instead of connecting to the daemon directly. The host serves one private socket per hosted session and gives the provider the shipped stdio-to-socket bridge as its tool server; each tool message becomes a request to the daemon's tool endpoint with the host's own token. While no worker listens, which lasts seconds after a worker kill or during a graceful swap, the host holds the message and retries until a worker answers or a minute passes, so a tool call made at that moment completes instead of failing the model's turn. A message is repeated only when repeating it does no work or when the connection was refused, so the request never arrived; a tool call that fails any other way is answered with an unknown-outcome error, since the tool may already have run. The worker recognises the relay form when it stores or resumes a session, so a relay socket of an earlier host never reaches a provider. A release without the bridge runs hosted providers with their direct connection, as before.

### Validation

- Unit tests cover the relay against a stand-in daemon: a request, an SSE reply and a notification pass through unchanged, a message is held while nothing listens and delivered once to the daemon that appears, a held request gets an error at the hold bound, a failure after reply bytes is not retried, a rejected token is answered at once, malformed lines and queue caps close the connection, reopening a session replaces its socket, a too-long socket path falls back, and the shipped bridge carries a request end to end. The host's session factory is covered for the relay replacing only the injected server at create and resume, a stale relay dropped from a saved handle, no relay without the direct server, and a failed open leaving no relay behind. The isolated end-to-end suite gains a scenario in which the scripted provider lists the daemon's tools three seconds after the worker is killed: the host log shows the hold, the call returns the tool list once the replacement worker attaches, and the turn finishes uninterrupted.

## 0.11.0-beta.3.vorteo.789 - 2026-10-22

### Maintenance

- Merge the Codex fix that keeps frozen skill selections valid while remote plugins sync

## 0.11.0-beta.3.vorteo.788 - 2026-10-22

### Fixed

- New Codex threads on accounts with remote plugins no longer fail with "Provider skill catalog changed during this task". Codex finishes syncing remote plugin skills after its first skill listing, so the next listing grew, for example from 20 to 64 entries on Codex 1. The check now compares only the selected skills. Each turn still sends a filter rebuilt from the current listing, which keeps plugin skills that appear later disabled.

## 0.11.0-beta.3.vorteo.787 - 2026-10-22

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.786 - 2026-10-22

### Maintenance

- Merge automatic resume after usage limits

## 0.11.0-beta.3.vorteo.782 - 2026-10-22

### Added

- Threads stopped by a Claude or Codex usage limit now continue automatically after the limit resets. The daemon waits two minutes past the reported reset, then queues one continuation per account every two minutes, oldest first, asking the thread to check what it already finished. Waits longer than a day are mentioned in the continuation. A spent reset credit ends the wait too. After three repeated limits the thread stays held for you.
- Held threads show when they will resume, with Resume now and Don't resume. Each account has a Resume after usage limits switch in Settings, on by default.
- Threads continued elsewhere, archived threads, opted-out threads and threads with a paused message queue are never resumed. The hourly blocked-work review and agent-target schedules skip accounts known to be limited.

### Fixed

- Claude usage limits no longer look like finished turns. Claude's rejected usage window and its synthetic rate-limit reply now end the turn as a usage limit with the reported reset time and window.

### Changed

- A usage limit no longer pauses a thread that has no workers, so you can still message it. Worker teams keep their pause, which the resume clears. Quota reserve stops are unchanged and still need an explicit continuation.

### Known limitations

- The account switch is saved per environment, not installation-wide.
- Codex and setup-token Claude accounts without a usage reading rely on a 30-minute probe when the provider reports no reset time.
- The raw order of Claude's rate-limit event and result was not captured live; detection is tested against the recorded synthetic reply.

## 0.11.0-beta.3.vorteo.785 - 2026-10-22

### Maintenance

- Merge the Claude sign-out guard for accounts without their own directory

## 0.11.0-beta.3.vorteo.784 - 2026-10-22

### Fixed

- Removing a full sign-in Claude account no longer runs Claude's sign-out when the account has no configuration directory of its own. A daemon started from an agent shell inherits another account's directory, so that sign-out could have signed out a different account.

## 0.11.0-beta.3.vorteo.784 - 2026-10-22

### Maintenance

- Merge the Codex fix that lets account-isolated threads launch with built-in skills

## 0.11.0-beta.3.vorteo.782 - 2026-10-22

### Fixed

- New Codex threads on isolated accounts no longer fail with "Provider did not discover selected skill imagegen". Each Codex account has its own home, so its built-in skills such as imagegen, openai-docs and skill-creator are listed from that home instead of the path the daemon recorded. A selected skill now also matches a copy with the same name and byte-identical package content. A copy whose content differs is still refused.

## 0.11.0-beta.3.vorteo.783 - 2026-10-22

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.782 - 2026-10-22

### Maintenance

- Merge in-thread account and profile switching

## 0.11.0-beta.3.vorteo.775 - 2026-10-22

### Maintenance

- The client hello test expects the new profile switch timeline capability, which the client now advertises by default

## 0.11.0-beta.3.vorteo.774 - 2026-10-22

### Added

- Switch a thread to another account or profile without leaving it. Choosing a profile on another account for an existing thread now offers Switch in this thread by default, with a warning that switching uses extra tokens; New task instead keeps the reviewed successor. The quota notice gains a Switch account button.
- The daemon closes the thread's native session, starts one on the target account with up to 30 recent messages as session instructions, clears the quota pause and keeps the thread's ID, goal, checklist, journal and questions. Busy threads are refused.
- A compaction-style marker names both accounts and models. History before each switch is retained, so reloads replay every segment in order.
- Requires the daemon's `agentProfileSwitch` capability; older interfaces don't receive the marker. Tool results and provider-private state don't carry over, and automatic pooled switching remains planned. See the [profile switching plan](docs/plans/profile-switching.md).

## 0.11.0-beta.3.vorteo.781 - 2026-10-22

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.780 - 2026-10-22

### Maintenance

- Merge the Main CI repair thread's fix for seven stale tests that held this batch

## 0.11.0-beta.3.vorteo.774 - 2026-10-22

### Maintenance

- Repair seven stale tests that held the Host batch. The coordinator launcher test now finds the process inspector script from its own location instead of the working directory, so it passes when CI runs server tests from the server package. The queued attachment summary test stubs card resizing, which pulled in the gesture handler. The plugin settings test pins a desktop width, because jsdom reports a zero-width window and the actions menu then opened as a compact sheet. No product behaviour changed.

## 0.11.0-beta.3.vorteo.779 - 2026-10-22

### Maintenance

- Merge plain-language connection errors and passing toasts for failed actions

## 0.11.0-beta.3.vorteo.765 - 2026-10-22

### Changed

- Failed one-off actions now report through a toast that clears itself instead of red text that stays in the control. This covers the Tasks card, Open questions, goals, the message queue, workspace and label menus, recovery, setup runs, rename and project move, and connection failures in settings saves. The control keeps your input so you can retry.
- Connection failures read "Lost connection to the host. Try again once it reconnects." everywhere instead of raw text such as "Transport closed (code 1006)", and host messages lose their `requestType=… code=…` suffix.
- The Tasks card no longer opens itself to show an error. The composer shows connection failures as a toast and clears a host rejection when you edit the draft or the host reconnects. The new-workspace screen and setup dialog no longer show the same error twice.

### Maintenance

- Durable states stay inline with readable wording: queue delivery failures and pending recoveries, history and goal load errors, pane load errors, validation, and settings and installation status. Offline screens no longer repeat the raw connection error under "Reconnecting".

## 0.11.0-beta.3.vorteo.778 - 2026-10-22

### Maintenance

- Merge nested sidebar folders, stored in the shared sidebar state

## 0.11.0-beta.3.vorteo.766 - 2026-10-22

### Added

- Sidebar folders. Group projects into nested folders from New folder in the sidebar's More menu, and group a project's workspaces into nested folders from the project menu's New workspace folder. Folders fold, show a count while folded, and can be renamed, moved or deleted from their own menu. Deleting a folder moves its contents up one level; nothing is archived and nothing changes on disk.
- Move to folder in project and workspace menus works on phones as well as desktop. On web and desktop, drag a row onto a folder to put it inside, or drop it between rows to place it there; a dropped row joins the folder of the row below it.
- Folders follow you across devices through the Host and appear only when the Host advertises `sidebarFolders`. Status grouping ignores folders, Pinned is unchanged, Factory and Standing stay as they are inside each project, and filters hide folders left empty. Keyboard shortcuts skip workspaces inside folded folders.

### Changed

- Sortable lists report which row was dragged, so adjacent swaps are no longer ambiguous.

### Known limitations

- The compact project rail and its flyout list projects without root folders. Factory and Standing workspaces stay in their sections even when moved to a folder.

## 0.11.0-beta.3.vorteo.765 - 2026-10-22

### Added

- The Host stores nested sidebar folders in the shared sidebar state and advertises `sidebarFolders`. Root folders hold projects; project folders hold that project's workspaces. A removed folder hands its contents to its parent, and conflicting moves are repaired the same way on every device, so concurrent edits cannot form a cycle or put a project inside a project folder.
- Folder moves also rewrite the flat project and workspace orders, so clients without folder support keep a matching order. The app does not show folders yet; that follows in the next change.

## 0.11.0-beta.3.vorteo.777 - 2026-10-22

### Maintenance

- Merge durable sessions host generations: the session host moves to a newer release once it runs no session, and the pending upgrade goes only to interfaces that declare it

## 0.11.0-beta.3.vorteo.763 - 2026-10-22

### Fixed

- Interfaces from release 761 keep parsing the session host status while an upgrade is pending. They declare restart and indicator support but parse strictly and do not know the pending upgrade field, so the coordinator now sends that field only to a client that declares `upgrade: true`, which the interface does from this release. The interface also reads the owner's session host query with schemas that ignore unknown keys at every level, so a later coordinator addition reaches it without a flag; the gating flags remain for interfaces older than this release.

### Validation

- The contract test freezes the 761 strict schemas and checks that a client declaring restarts and the indicator parses a status with an upgrade pending and never sees the field, that a client declaring every flag sees it, and that each flag withholds only its own addition. An interface client test checks the query declares all three flags and that a reply with unknown keys in the overview, a job, its plan and host, and the status detail still parses.

## 0.11.0-beta.3.vorteo.762 - 2026-10-22

### Features

- Session host generations. The host compares its own release with the one the installation's current link selects, once a minute by default, and when a newer release is installed it marks an upgrade as pending and exits as soon as no session runs; launchd relaunches it on the installed release, and workers wait for its return instead of starting providers locally. While the upgrade is pending, workers release hosted sessions that have been idle for five minutes, so the host reaches zero sessions without cutting any running turn or pending permission; a released agent resumes on demand, hosted again on the new host. Idle sessions stay warm whenever no upgrade is pending. The durable sessions setting file accepts optional `idleReleaseMs` and `releaseCheckMs` tunables, and the session host status reports a pending upgrade. The owner-approved restart remains for moving a host immediately.

### Validation

- Tests cover the host writing the upgrade marker and exiting at zero sessions with the restart marker left for workers, the next host clearing both markers, the selection of releasable agents, the worker releasing an idle hosted session only while an upgrade is pending and the agent resuming hosted afterwards, the connector flag, and the status field in the coordinator and the app. An isolated end-to-end scenario runs the host through a release link, repoints the link at a newer release while an agent sits idle, and sees the host relaunch on that release within seconds with both markers cleared and the agent's next turn hosted on the new host.

## 0.11.0-beta.3.vorteo.776 - 2026-10-22

### Maintenance

- Merge the Claude Host refresh review copy and the provider docs split

## 0.11.0-beta.3.vorteo.769 - 2026-10-22

### Changed

- Clarify the coordinator review text for Claude Host-owned refresh. Turning it on now says what it does for Dev's long turns; turning it off says Dev loses full sign-in accounts once their current access expires and new ones can no longer be added.
- Split the providers guide's Host-owned refresh setup into enabling, the two-step rollout and requirements, and describe what turning it off does.

## 0.11.0-beta.3.vorteo.775 - 2026-10-22

### Maintenance

- Merge Installation platform's tracked Claude refresh setting for coordinator updates, and its fixes for seven tests that failed on the installed source

## 0.11.0-beta.3.vorteo.769 - 2026-10-22

### Maintenance

- Fix seven tests that failed on the installed source without any change. Two runner tests compared stderr exactly and broke when Node 26 warned that tsx uses `module.register()`; they now run with `--no-deprecation`. The unknown-observation test was stale after unclaimed recovery fencing; it now tries the actual masquerade as success and also checks the claimed-request refusal. The installer approval-link test expected the status read without `sourceBatches=1`. The Dev release-link test runs only on Linux, where its helper's `/proc` reads exist, with a canonical temporary root. The two web-setup tests get a 60-second budget for their real Git work under load.

## 0.11.0-beta.3.vorteo.774 - 2026-10-22

### Maintenance

- Fix the CI format check: format the Builds guard scripts, and stop combined source batches from adding a second blank line to the changelog

## 0.11.0-beta.3.vorteo.768 - 2026-10-22

### Added

- Coordinator updates can carry the Host-owned Claude refresh setting. A reviewed plan sets `claudeHostRefreshConfiguration` to `true` or `null`, the coordinator accepts exactly that change to its configuration, and Installation controls describe it before approval. Automatic updates and renewals still refuse configuration changes, and clients that cannot show the change cannot approve it but can still cancel. Turning it on takes a coordinator and Host update that know the field, then one owner-reviewed coordinator update.

## 0.11.0-beta.3.vorteo.773 - 2026-10-22

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.772 - 2026-10-22

### Maintenance

- Merge installation platform batch 2: web builds stop leaking disk and clone a shared dependency install, journal writers wait briefly for the bootstrap lock, and the coordinator shares daemon connections

## 0.11.0-beta.3.vorteo.767 - 2026-10-22

### Fixed

- The installation coordinator no longer opens a fresh Host daemon connection for every settings, profile and restart-impact check. It opened about 1.4 a second, 33,723 in six and a half hours on 2026-10-22, and each one made the daemon run a full hello and session sync. Those periodic reads now share one connection per environment, replaced when it drops and closed after a minute unused. Restart, hold and update operations keep fresh connections because they must observe a new daemon.

## 0.11.0-beta.3.vorteo.766 - 2026-10-22

### Fixed

- Automatic coordinator updates no longer fail when another process briefly holds the installation journal lock. This morning's automatic coordinator update failed at its promotion step for exactly this reason: the lock refused at once, and the coordinator's own two-second loop and Host status reads hold it often under load. Journal writers now wait up to three seconds with backoff before reporting the journal busy, so owner and Nova decisions stop failing the same way. Nested use within one process still refuses at once.
- Web build pruning runs in a detached, low-priority process instead of inside the build. Deleting the roughly 300 leftover builds took over an hour and would have stalled the next build. `scripts/prune-instance-builds.mjs` runs the same cleanup by hand, and a lock keeps concurrent builds from repeating it.

### Maintenance

- The restart test "new requests cannot join a restart after dispatch starts" asked too early: since the queue began releasing finished holds before dispatching, a request made in the same tick still joins the approved restart, as designed. The test now waits for dispatch to begin.

## 0.11.0-beta.3.vorteo.765 - 2026-10-22

### Fixed

- Web builds no longer leave about 3 GB behind each. Once the export is sealed, a build deletes its source snapshot and dependencies and keeps only the export; a failed build deletes its whole directory. Each build also prunes abandoned builds and exports beyond the newest five or older than a week, skipping any build whose process is still running. 345 leftover builds filled the Host disk on 2026-10-22.

### Changed

- On macOS, task worktrees, workspace setup and web builds clone a cached dependency install of the same lockfile with APFS copy-on-write instead of running a full `npm ci`. Each checkout still gets its own `node_modules`, so workspace packages resolve inside it, and clones use almost no extra disk. Our own version bumps do not invalidate the cache. A cache miss or failed clone runs `npm ci` as before; `VORTEO_DEPENDENCY_CACHE=0` turns the cache off.

## 0.11.0-beta.3.vorteo.771 - 2026-10-22

### Maintenance

- Merge the full Claude sign-in choice for installation accounts (hidden until the coordinator runs Host refresh and every environment supports it)

## 0.11.0-beta.3.vorteo.766 - 2026-10-22

### Fixed

- Offer Full sign-in for a new Claude account only when the coordinator positively confirms its Host-refresh routes. A maintenance reply, network failure or missing route now hides the choice, so no account is created with a sign-in type the installation cannot refresh.
- Stop recomputing the environment list on every render of the Add Claude account sheet.

## 0.11.0-beta.3.vorteo.765 - 2026-10-22

### Added

- Add Claude account in an installation offers a Sign-in type choice: Full sign-in (usage visible, the Host keeps the sign-in fresh for Host and Dev) or Setup token. The choice appears only when the coordinator has Host-owned refresh enabled and every environment's daemon supports full sign-in, because older daemons reject shared settings that carry it.
- Full sign-in accounts use the coordinator's Host-refresh sign-in routes. Their panel names the signed-in Claude account and asks for sign-in again when the Host loses the grant.
- An existing setup-token account cannot be converted; add a new full sign-in account instead. Host-owned refresh remains off until the installation enables it.

## 0.11.0-beta.3.vorteo.770 - 2026-10-22

### Maintenance

- Merge the published web interface source so the Host update descends from it

## 0.11.0-beta.3.vorteo.762 - 2026-10-22

### Maintenance

- Merge GitHub main, including the fix that keeps sent messages cleared after a connection drop, into the live interface source, which already carries the sidebar card spacing changes. Entries from both lines keep their original version labels.

## 0.11.0-beta.3.vorteo.769 - 2026-10-22

### Maintenance

- Merge the Nova bridge MCP handshake fix

## 0.11.0-beta.3.vorteo.765 - 2026-10-22

### Fixed

- Let the Nova bridge accept the standard MCP initialize handshake used by OpenAI's Secure MCP Tunnel client. Initialize, ping, tool listing and tool calls are served statelessly behind the same bearer token; modern requests keep their existing path.
- Answer OAuth metadata probes with a plain 404 before authentication, so the tunnel client recognizes the bridge as a server without OAuth instead of reporting broken metadata.
- Proactive events remain available only to modern protocol clients. Live ChatGPT connection and revocation acceptance remain open. This ports the fix tested on 2026-10-20 (`vorteo.556` on an unpublished branch) onto current main unchanged.

## 0.11.0-beta.3.vorteo.768 - 2026-10-22

### Maintenance

- Merge durable sessions phase 2 with its client compatibility fix: tracked session host restart, detached-turn durability and the hosted indicator

## 0.11.0-beta.3.vorteo.761 - 2026-10-22

### Fixed

- Older interfaces keep working with a coordinator that knows session host restarts and the hosted indicator. They parse the owner's session host query strictly, so the coordinator now sends restart jobs and the stopped host's record only to an interface that declares restart support, and the installed release and per-provider counts only to one that declares the indicator; a client that sends an empty query gets exactly the shape it always parsed. The interface also treats a session host query it cannot parse like any other card failure: the card keeps its last state and shows the error, and the restart and helper lists with their approval buttons still load.

### Validation

- A contract test freezes the pre-change strict schemas and checks that, with a finished restart job in the ledger and the new status fields present, an empty query parses with them while a query declaring both flags parses with the current schemas and carries everything; declaring one flag withholds only the other addition. A panel model test covers the query failure leaving the rest of Installation controls intact.

## 0.11.0-beta.3.vorteo.760 - 2026-10-22

### Features

- Agents whose provider session runs in the durable session host are marked: the agent snapshot carries an optional hosted flag, and the agent list shows a "Survives restarts" badge beside them, so the owner can tell at a glance which turns a daemon restart will not interrupt. Older daemons omit the flag and older interfaces ignore it.
- The session host status in Installation controls and the Host client now names the installed release beside the host's own release, and breaks hosted sessions down by provider, so a host still running an older release than the installation is visible.

### Validation

- Tests cover the hosted flag on the agent payload for hosted, local and sessionless agents, the status fields and their display, and every locale carries the new badge label.

## 0.11.0-beta.3.vorteo.759 - 2026-10-22

### Fixed

- A hosted turn that finishes while no worker is attached, as during a long Host update or a slow restart, no longer loses the end of its output. The next worker used to close such a session as idle at startup without ever applying the events recorded after the previous worker's last acknowledgement. It now adopts a session that still holds unapplied events, loads the agent, applies them, and leaves the session hosted and idle. Found by the isolated end-to-end suite running under heavy machine load, where the gap between workers outlasted the scripted turn.

### Validation

- A unit test covers a turn that ends during the worker gap and shows its final text reaching the next worker's timeline. The end-to-end wait for a turn now names the agent's status and chunk list when it times out.

## 0.11.0-beta.3.vorteo.758 - 2026-10-22

### Validation

- The hosted session suite covers a marked session host restart whose new host already holds the lock but does not listen yet: the worker keeps waiting and the session opens in the host, which closes the one path the independent review found untested.

## 0.11.0-beta.3.vorteo.757 - 2026-10-22

### Fixed

- Independent review follow-ups for the tracked session host restart: the owner query reports restart support only to an app that asks for it, so an older interface that parses the reply strictly keeps working; the restart marker is removed with the job and ignored once it is older than a restart could take, so an interrupted restart cannot leave workers waiting for a host that never comes; a marked restart keeps waiting while its new host is between taking its lock and listening; a stop that finds no running process falls back to starting the job; the restart detail says when the stopped host was not answering; and the interruption warning shows only when a restart can be requested.

### Validation

- Unit tests cover the marker's age limit, its removal with the job, the opt-in owner query field, and the corrected texts. The session host job, workflow, connector, hosted session and service suites pass, as do the app review and client suites.

## 0.11.0-beta.3.vorteo.756 - 2026-10-22

### Features

- Installation controls and the Host client can request a tracked session host restart. The coordinator plans it like install and removal, the owner approves the exact plan, and the restart stops the host through launchd and waits for a new process on the installed release, killing a host that ignores the stop once verified. The request names how many hosted turns it interrupts; each continues on the new host because the worker waits on a restart marker the coordinator writes and the new host removes. This is how a session host moves to a newer release, which a Host update alone never does.

### Validation

- Unit tests cover the restart through a fake launchd, a host that ignores the stop, a replacement that never answers, the refusals, the worker's wait on the restart marker, the host removing the marker at start, the client's capability gate and the owner-facing texts. A new end-to-end scenario performs the coordinator's steps against a real launchd job: the marker, the stop signal, and the interrupted turn's continuation opening on the new host. The ledger suite has one failure that predates this change and reproduces with it reverted.

## 0.11.0-beta.3.vorteo.767 - 2026-10-22

### Maintenance

- Merge the multi-provider Quotas card and usage pace projection

## 0.11.0-beta.3.vorteo.765 - 2026-10-22

### Added

- Claude and Codex usage windows now carry a pace projection. When the average rate since a window opened would exhaust it before its reset, the window reports when it runs out. Projections start once a tenth of the window, and at least 15 minutes, has passed.

### Changed

- The left sidebar's quota card is titled Quotas when more than one account reports and shows every enforced window as its own remaining-percent bar, plus a bar for each balance with a known limit. Each reset shows its absolute date, time and time zone with a countdown; hovering shows the same moment in UTC.
- Each account shows its plan, running agent count, the profile selector's Reconnect or reset-credit control, provider details and its sign-in source. A Limiting tag marks the window that will stop work first, and code review is labeled as a separate allowance.
- Accounts that are failing, below 15% or on pace to run out open expanded; healthy accounts collapse to one summary line. Each account remembers being opened or closed on the device.
- Known limitation: pace projections cover Claude and Codex only, because other providers do not report their window length.

## 0.11.0-beta.3.vorteo.766 - 2026-10-22

### Maintenance

- Merge GitHub main and the removal of the floating update notice

## 0.11.0-beta.3.vorteo.765 - 2026-10-22

### Changed

- Remove the floating "Vorteo update available" notice. The interface no longer polls GitHub in the background; Settings → General still shows how this build compares with main and offers Check now.

## 0.11.0-beta.3.vorteo.763 - 2026-10-22

### Changed

- Vorteo :: Builds is the only writer of shared state. AGENTS.md defines the handoff, and the installation client's request commands, web builds for publication, publish-main and pushes to main refuse to run outside Builds (VORTEO_BUILDS=1), guarding against accidental parallel writes. The coordinator's own interface publication step is unaffected, and the client keeps its check inline so copied clients still run on their own.

## 0.11.0-beta.3.vorteo.762 - 2026-10-22

### Fixed

- The agent guide and installation-maintenance skill no longer tell every agent that restarts need the owner's own click. Approval decisions are automatic where the owner's policy allows, otherwise made by the owner or by the installation lead the owner has delegated approvals to, and other agents hand requests to that lead. Shared instruction changes stay with the owner. Agents had been routing Dev updates to the owner because of the old wording.

## 0.11.0-beta.3.vorteo.761 - 2026-10-22

### Maintenance

- Merge GitHub main again (installers write the System checkout setting, new workspaces branch from origin when local main is only behind) so the Host update still contains everything on main. The installation-maintenance skill keeps main's rewrite, with the client sentence updated for invalid contributions.

## 0.11.0-beta.3.vorteo.760 - 2026-10-22

### Maintenance

- Merge the published web interface source (owners drag card heights and answer Yes beside the recommendation) so the Host update descends from the published web commit. Label `vorteo.758` exists on both lines; both notes are kept.

## 0.11.0-beta.3.vorteo.759 - 2026-10-22

### Maintenance

- Merge GitHub main (sidebar global cards below navigation, file preview downloads, Vorteo System as an ordinary project backed by its checkout) into the reviewed Host contribution that ports three Dev-only fixes and reports invalid source batch contributions. Labels `vorteo.756` and `vorteo.757` exist on both lines; both sets of notes are kept.

## 0.11.0-beta.3.vorteo.757 - 2026-10-22

### Fixed

- The installation agent tool reports invalid source batch contributions as well as conflicting ones, naming the requester and the rejection, so a batch blocked by an invalid contribution (such as a release-note heading the coordinator refused) no longer looks silently pending. The installation-maintenance skill says to ask the owning task to correct a contribution that is not yours.

## 0.11.0-beta.3.vorteo.756 - 2026-10-22

### Fixed

- Port three fixes that shipped only to Dev (source `0a4ab444`, 2026-10-19 and 2026-10-20) to the Host source, so GitHub main carries everything Dev runs: schedule ticks no longer overlap or admit stale work, schedule tick admission waits are bounded, and Codex workers accept the read-only Factory qualifier workspace profile.

## 0.11.0-beta.3.vorteo.758 - 2026-10-22

### Added

- Drag the bottom edge of an expanded card to make it taller or shorter. This works for the thread's right-hand cards and the left sidebar's Open questions and Quota cards. Heights are remembered on the device; a double press on the edge returns the card to automatic sizing. Right-hand cards you resized keep their height first, and the other cards share what remains.

### Changed

- # Open questions show a Yes button to the right of the recommended answer instead of Use recommended inside it at the bottom.

## 0.11.0-beta.3.vorteo.758 - 2026-10-22

### Changed

- Show Vorteo System as an ordinary sidebar project instead of a separate section. It shows the Vorteo mark until you pick another icon, drags with your other projects, and offers new workspaces. Remove project stays visible but disabled with the reason, and its settings explain the project and lock only its name.
- Let `system.json` name the installation's own checkout as `source.checkout`. It becomes the System project's root on every start, so new workspaces are worktrees of the code the installation was built from. Set up Vorteo source refuses to clone while a checkout is configured.

### Added

- Let `system.json` `absorb` existing projects and workspaces into the System project by ID. Every workspace moves, archived ones included, keeping its ID, folder and history, and each listed project left empty is archived. Later starts find nothing left to move. Installers do not write these settings yet.
  > > > > > > > > > Temporary merge branch 2

## 0.11.0-beta.3.vorteo.758 - 2026-10-22

### Changed

- Show Vorteo System as an ordinary sidebar project instead of a separate section. It shows the Vorteo mark until you pick another icon, drags with your other projects, and offers new workspaces. Remove project stays visible but disabled with the reason, and its settings explain the project and lock only its name.
- Let `system.json` name the installation's own checkout as `source.checkout`. It becomes the System project's root on every start, so new workspaces are worktrees of the code the installation was built from. Set up Vorteo source refuses to clone while a checkout is configured.

### Added

- Let `system.json` `absorb` existing projects and workspaces into the System project by ID. Every workspace moves, archived ones included, keeping its ID, folder and history, and each listed project left empty is archived. Later starts find nothing left to move. Installers do not write these settings yet.

## 0.11.0-beta.3.vorteo.758 - 2026-10-22

### Added

- Drag the bottom edge of an expanded card to make it taller or shorter. This works for the thread's right-hand cards and the left sidebar's Open questions and Quota cards. Heights are remembered on the device; a double press on the edge returns the card to automatic sizing. Right-hand cards you resized keep their height first, and the other cards share what remains.

### Changed

- Open questions show a Yes button to the right of the recommended answer instead of Use recommended inside it at the bottom.

## 0.11.0-beta.3.vorteo.758 - 2026-10-22

### Added

- Drag the bottom edge of an expanded card to make it taller or shorter. This works for the thread's right-hand cards and the left sidebar's Open questions and Quota cards. Heights are remembered on the device; a double press on the edge returns the card to automatic sizing. Right-hand cards you resized keep their height first, and the other cards share what remains.

### Changed

- # Open questions show a Yes button to the right of the recommended answer instead of Use recommended inside it at the bottom.

## 0.11.0-beta.3.vorteo.758 - 2026-10-22

### Changed

- Show Vorteo System as an ordinary sidebar project instead of a separate section. It shows the Vorteo mark until you pick another icon, drags with your other projects, and offers new workspaces. Remove project stays visible but disabled with the reason, and its settings explain the project and lock only its name.
- Let `system.json` name the installation's own checkout as `source.checkout`. It becomes the System project's root on every start, so new workspaces are worktrees of the code the installation was built from. Set up Vorteo source refuses to clone while a checkout is configured.

### Added

- Let `system.json` `absorb` existing projects and workspaces into the System project by ID. Every workspace moves, archived ones included, keeping its ID, folder and history, and each listed project left empty is archived. Later starts find nothing left to move. Installers do not write these settings yet.
  > > > > > > > > > Temporary merge branch 2

## 0.11.0-beta.3.vorteo.758 - 2026-10-22

### Changed

- Show Vorteo System as an ordinary sidebar project instead of a separate section. It shows the Vorteo mark until you pick another icon, drags with your other projects, and offers new workspaces. Remove project stays visible but disabled with the reason, and its settings explain the project and lock only its name.
- Let `system.json` name the installation's own checkout as `source.checkout`. It becomes the System project's root on every start, so new workspaces are worktrees of the code the installation was built from. Set up Vorteo source refuses to clone while a checkout is configured.

### Added

- Let `system.json` `absorb` existing projects and workspaces into the System project by ID. Every workspace moves, archived ones included, keeping its ID, folder and history, and each listed project left empty is archived. Later starts find nothing left to move. Installers do not write these settings yet.

## 0.11.0-beta.3.vorteo.758 - 2026-10-22

### Added

- Drag the bottom edge of an expanded card to make it taller or shorter. This works for the thread's right-hand cards and the left sidebar's Open questions and Quota cards. Heights are remembered on the device; a double press on the edge returns the card to automatic sizing. Right-hand cards you resized keep their height first, and the other cards share what remains.

### Changed

- Open questions show a Yes button to the right of the recommended answer instead of Use recommended inside it at the bottom.

## 0.11.0-beta.3.vorteo.764 - 2026-10-22

### Changed

- Restyle the theme and zoom controls after Freed's view menu. The six theme bubbles share one row; hovering one makes it taller with a soft shadow, and the selected theme stands as a circle. Zoom shows its percentage beside the label and keeps the smaller step, slider and larger step inside one bordered group.
- Cmd or Ctrl with plus, minus and zero now change Vorteo's interface zoom instead of the browser's, so toolbars reflow instead of cropping. The desktop View menu does the same.
- Block browser pinch zoom on phones and tablets. It cropped the toolbars without reflowing them; use the Zoom control instead.

## 0.11.0-beta.3.vorteo.763 - 2026-10-22

### Maintenance

- Merge the live interface source (resizable cards, the Open questions Yes button and mobile card spacing) into main, so the next Host update keeps everything already published. That branch labelled its entries `vorteo.758` and `vorteo.759`, which main also used for different commits; both historical entries are kept.

## 0.11.0-beta.3.vorteo.762 - 2026-10-22

### Fixed

- Submitting the first message in a new agent draft no longer leaves the Environment, Account and Profile picker above the composer while the message already shows at the top. The picker tucks into the composer as the message fades up into place, comes back if creation fails, and never appears for a draft opened mid-launch. Reduced-motion settings skip the animation.

## 0.11.0-beta.3.vorteo.761 - 2026-10-22

### Fixed

- Stop sent messages from bouncing back into the composer when a slow connection drops mid-send. When the reply is lost after the message left the client, such as after "Liveness check timed out", the composer now waits up to a minute for the reconnected timeline. It clears the draft if the host received the message, and otherwise restores it with "Connection lost while sending" instead of the raw timeout.

## 0.11.0-beta.3.vorteo.760 - 2026-10-22

### Fixed

- New workspaces no longer start from a stale local branch. When a request names `main` or another unqualified branch, the daemon fetches `origin/main` and branches from it if the local branch is only behind; a local branch with unpushed commits still wins. The primary checkout had sat 865 commits behind because all work is pushed from other worktrees.

### Added

- The daemon merges script entries from an untracked `paseo.local.json` over `paseo.json` and advertises this as `localProjectConfig`, which `paseo daemon status --json` reports. Project settings still edit `paseo.json` alone.
- The preview helper writes its launch wrapper to `paseo.local.json` when the daemon supports it, so starting a preview no longer dirties a shared checkout. Older daemons keep the previous `paseo.json` write. The HTTPS broker reads the merged configuration. The installed helper and broker need reinstalling to use this.

### Maintenance

- The agent guide treats the primary checkout as read-only. Git ignores `paseo.local.json`, `.runtime/`, Vitest attachments and browser test screenshots.

## 0.11.0-beta.3.vorteo.759 - 2026-10-22

### Added

- Write the Vorteo System checkout setting from the installers. The Host installer records the checkout it runs from and the installed commit. Dev update setup records the same checkout as the container sees it, or explains why it cannot. `install-execution-host.mjs configure-system-source --root <root>` updates both for existing installations, keeping every other setting.

### Fixed

- Correct the installation-maintenance skill and agent guidance: Host-originated restarts and source updates are approved automatically for both Host and Dev when the owner's policy allows it, while Dev-originated requests, mixed batches and listed request types stay manual. The skill now explains how to follow an automatic decision and what a coordinator recovery refusal means.

## 0.11.0-beta.3.vorteo.758 - 2026-10-22

### Changed

- Show Vorteo System as an ordinary sidebar project instead of a separate section. It shows the Vorteo mark until you pick another icon, drags with your other projects, and offers new workspaces. Remove project stays visible but disabled with the reason, and its settings explain the project and lock only its name.
- Let `system.json` name the installation's own checkout as `source.checkout`. It becomes the System project's root on every start, so new workspaces are worktrees of the code the installation was built from. Set up Vorteo source refuses to clone while a checkout is configured.

### Added

- Let `system.json` `absorb` existing projects and workspaces into the System project by ID. Every workspace moves, archived ones included, keeping its ID, folder and history, and each listed project left empty is archived. Later starts find nothing left to move. Installers do not write these settings yet.

## 0.11.0-beta.3.vorteo.759 - 2026-10-22

### Fixed

- On mobile, the sidebar's Open questions and Quota cards keep the 8px card gap from the list above and from the sync notice, restart banner or footer below, instead of touching the banner.

## 0.11.0-beta.3.vorteo.758 - 2026-10-22

### Added

- Drag the bottom edge of an expanded card to make it taller or shorter. This works for the thread's right-hand cards and the left sidebar's Open questions and Quota cards. Heights are remembered on the device; a double press on the edge returns the card to automatic sizing. Right-hand cards you resized keep their height first, and the other cards share what remains.

### Changed

- Open questions show a Yes button to the right of the recommended answer instead of Use recommended inside it at the bottom.

## 0.11.0-beta.3.vorteo.757 - 2026-10-22

### Maintenance

- Merge the file preview Download change from GitHub main into the live interface source, which already carries the sidebar cards change. Both commits used `vorteo.756`; both historical entries are kept.

## 0.11.0-beta.3.vorteo.756 - 2026-10-22

### Changed

- On desktop, the left sidebar's Open questions and Quota cards now sit below the navigation card as separate cards instead of nesting inside it. The mobile sidebar keeps them in its full-height sheet.

## 0.11.0-beta.3.vorteo.756 - 2026-10-22

### Changed

- Show Download in the file preview toolbar for every file, not only images, placed immediately after Copy all. Editable text files download the saved copy on disk; unsaved edits are not included. Binary previews keep their larger Download button in the body.

## 0.11.0-beta.3.vorteo.755 - 2026-10-22

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.754 - 2026-10-22

### Fixed

- Let the installation coordinator accept a release-note entry whose well-formed heading has no notes. Installed history contains two such entries, `vorteo.740` and one `vorteo.732`, so every Dev update from current source was refused with "Release-note heading requires review". Malformed headings and edited history are still refused. Takes effect once the coordinator runs this build.

## 0.11.0-beta.3.vorteo.753 - 2026-10-22

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.752 - 2026-10-22

### Maintenance

- Merge the Vorteo System project from GitHub main into the installed Host source (`vorteo.751`, durable sessions phase 2), so the Host update descends from both and GitHub main can fast-forward to it after installation. GitHub main and the installed source each used `vorteo.748` for a different commit; both historical entries are kept.

## 0.11.0-beta.3.vorteo.748 - 2026-10-22

### Added

- Add the Vorteo System project. Every daemon creates one protected project at startup under `$PASEO_HOME/system` and keeps its standing upkeep workspaces there, starting with the Optimization Runner on the Host and single-daemon installs. Existing installations get it with their next update.
- System items are enforced in the project and workspace registries: no client or tool can archive, remove, move, rename or unprotect them, or delete a thread in a system workspace. The project keeps its own key, so a Vorteo clone never merges it into another project group.
- Adopt an existing workspace into a system role by exact ID from `$PASEO_HOME/system/system.json`. It keeps its ID, threads, journal, checklist and schedules.
- Set up Vorteo source from Maintenance settings: the daemon clones the repository named in `system.json` into the System project and adds an ordinary Vorteo source workspace for your own changes. Requests cannot name another repository.
- Show a Vorteo System section in the sidebar, lock its system workspaces' menus with a "Managed by Vorteo System" note, leave them out of the dock badge and favicon state, and add a Vorteo System card under Maintenance.

### Fixed

- Reconciliation no longer archives protected, system or Factory workspaces whose folders are missing, and one refused archive no longer fails the whole pass.

### Maintenance

- Test daemons start without the System project so fixture counts stay exact; server tests opt in with `systemProjectEnabled` and browser specs with `PASEO_SYSTEM_PROJECT=1`.
- Known limitation: the Vorteo source clone does not follow later updates yet.

## 0.11.0-beta.3.vorteo.751 - 2026-10-22

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.750 - 2026-10-22

### Fixed

- The session host stops provider processes left by an earlier host only after it holds the host lock, so a second host started by mistake can no longer stop the live host's Codex app-servers. A recorded process is stopped only while its command line still names both the launched binary and the app-server, and its whole process group is signalled so the tools it started go with it.
- A hosted Codex session that resumes on demand, as after a worker restart, carries its account descriptor to the host like a new one, so a derived Codex account no longer reopens on the default provider.
- A command the hosted session reports as unhandled now shows an error instead of being swallowed, and a host between taking its lock and listening is given a moment before a session falls back to the worker.

### Validation

- Unit tests cover a second host refused by the lock leaving a recorded live provider untouched, the account descriptor on resume, group signalling and the marker rule. The session host suites and the eight end-to-end scenarios pass. Independent review of the phase 2 commits raised these findings.

## 0.11.0-beta.3.vorteo.749 - 2026-10-22

### Fixed

- A session whose host was killed waits for launchd to bring the host back, up to a return window of fifteen seconds, before it would start in the worker. The continuation of a turn the dead host was running therefore opens on the restarted host and stays durable, instead of running a local provider because the host was not listening yet in the seconds after the kill. A host that was stopped cleanly removes its socket and is not waited for.
- The session host entrypoint builds again now that it loads the Codex adapter: the installation settings reader no longer passes a browser-only cache option to Node's fetch, which the Node-typed entrypoint build rejected. Behaviour is unchanged; Node keeps no HTTP cache.

### Validation

- The isolated durable sessions end-to-end suite runs a Codex-shaped scripted provider as well as the Claude-shaped one. Two new scenarios prove a goal set before a worker kill still reads through the replacement worker once the hosted turn completes, and that `/compact` and `/goal` run out of band in the host for a worker started after a supervisor restart without starting a turn. Failing scenarios now print the installation's daemon, host, audit and launchd logs and can keep the installation's files for inspection. The scripted provider's goal states now carry every field of the wire schema, which the first Codex scenarios exposed. All eight scenarios pass.

## 0.11.0-beta.3.vorteo.748 - 2026-10-22

### Features

- Durable sessions phase 2: Codex sessions run in the session host when durable sessions are enabled, for builtin and account providers. The worker sends the account descriptor in the open request so the host builds the same client, Codex goal state and the `/goal` and `/compact` commands cross to the host, and the hosted session reports its own capabilities. Claude hosting is unchanged.
- The session host records each detached Codex app-server process it spawns and, at its next start, stops any recorded process that still runs the app-server, so a host killed by its watchdog or a crash never leaves a second writer beside a continued agent.

### Validation

- New unit tests cover the child registry, Codex goals and commands through the host, per-session capabilities and the account descriptor reaching the host, and a recorded orphan stopped at host start. The existing session host suites pass unchanged on the installed source. Codex end-to-end and live acceptance follow in later commits.

## 0.11.0-beta.3.vorteo.747 - 2026-10-22

### Maintenance

- Combine 2 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.746 - 2026-10-22

### Fixed

- Treat Claude Code's hidden internal commands, whose names start with `__` (such as `__remote-workflow` since 2.1.285), as commands instead of skills. Restricted skill policies count every listed skill as a native default that needs an inspectable package, so this command made restricted Claude launches fail. Other built-in commands and bundled skills without packages still block restricted launches until a follow-up fix.

### Documentation

- Correct the release that first keeps the daemon running on invalid `headlessHost` settings: Host releases before `vorteo.736` refuse to start on them, not before `vorteo.731`.

## 0.11.0-beta.3.vorteo.745 - 2026-10-22

### Maintenance

- Merge the published Host release with the left-sidebar Open questions and Quota cards into GitHub main, so main contains the live interface source and later Host updates from main keep its history.

## 0.11.0-beta.3.vorteo.744 - 2026-10-22

### Changed

- Let the Host delivery script fast-forward to a newer installed release that already contains the delivery branch, and resolve manifest conflicts that differ only in Vorteo version strings, which every commit produces. Other dependency conflicts still stop for review.

### Fixed

- Show `origin/main` in full in the delivery script's progress message instead of cutting it to nine characters

## 0.11.0-beta.3.vorteo.743 - 2026-10-22

### Maintenance

- Merge two newer GitHub main commits into the Host delivery branch so it fast-forwards main.

## 0.11.0-beta.3.vorteo.742 - 2026-10-22

### Maintenance

- Merge GitHub main into the installed Host source with the new Host delivery script, so GitHub carries every installed change and the Host can take main's newer commits. Version-only manifest conflicts kept the installed side; the browser settings guide took main's added note about older daemons.

## 0.11.0-beta.3.vorteo.742 - 2026-10-22

### Added

- Show an Open questions card in the left sidebar with every waiting question from every thread in every project, on all connected hosts. Each question names its thread and project, and its host when questions come from more than one. Threads blocking the most tasks come first, then the longest waiting. Answer in place, or choose Open to go to the thread. The right-hand card still shows only the current tab's questions.
- Show a Quota card in the left sidebar listing each account's remaining usage and reset time, with failing accounts and accounts below 15% first. Choosing an account opens Usage.
- Both cards hide while they have nothing to show, remember whether they are collapsed and keep their bodies to a capped height so the workspace list keeps its room. On windows shorter than 720px, only one card is open at a time.

### Validation

- Model tests cover cross-thread collection, ordering, host labels and quota ordering. Browser tests answer questions from two projects through the sidebar at phone and desktop widths, confirm answers reach the asking thread, collapse state survives a reload and short screens open one card at a time; the existing inline open-questions tests pass at all three widths. Typecheck and lint pass.

## 0.11.0-beta.3.vorteo.741 - 2026-10-22

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.740 - 2026-10-21

## 0.11.0-beta.3.vorteo.737 - 2026-10-22

### Changed

- Show installation health as one summary line with its badge and check time. Service readiness, activation steps and the recovery page move behind Health details; services that need attention stay visible.
- Offer Refresh buttons in Installation only after an error. Health, recovery page and maintenance request status already refresh every few seconds.
- Hide Maintenance requests when there are none.
- Shorten the recovery page explanation, fold Request readiness behind a toggle and move the automatic-authorization note into each permission's tooltip.

### Validation

- Installation component tests cover the folded health details, error-only refresh buttons and the hidden empty request queue; the packaged installation check opens Request readiness before reading it.

## 0.11.0-beta.3.vorteo.736 - 2026-10-22

### Fixed

- Report a conflicted source batch to agents instead of asking them to reload Vorteo. The coordinator's fallback status for clients without batch support now shows its own detail, such as "Contributions need correction before this batch can be approved", while a batch is preparing or conflicted; the reload prompt stays for ready batches an old owner tab cannot review
- `installation-agent restart-status` requests batch details, and it and `request-restart` print each conflicting contribution, the file it conflicts in and the `--replaces` command that corrects it. A conflicted batch can never be approved, automatically or by the owner, until it is corrected

### Maintenance

- The installation maintenance skill explains conflicted batches and how to replace a contribution. These changes take effect after a coordinator renewal and a refreshed agent tool; a Host update alone does not install them

## 0.11.0-beta.3.vorteo.735 - 2026-10-21

### Added

- Let headless browser allowed hosts name a port range, such as `<preview-host>.ts.net:32768-32799`, so agents can screenshot any managed preview on that name without opening the host's other services or restarting for each new preview

### Fixed

- Keep the daemon starting when `daemon.browserTools.headlessHost` contains an unknown key or a wrongly typed value. The headless browser validates its settings itself and stays off with a logged error, so a misspelled denial can never start an unrestricted browser

### Documentation

- Describe running the headless browser in the Dev container, inside the container's network, with the safety settings it needs and a rootless Chromium library setup for older containers
- Update the README, agent skills and browser trust plan for Host and Dev browser access, and note that older daemons still stop on an invalid `headlessHost` entry
- Add a deferred roadmap plan for signed-in browser profiles granted to specific Host workspaces

## 0.11.0-beta.3.vorteo.734 - 2026-10-22

### Added

- Add task delivery scripts adapted from Freed's agent lifecycle: `task-worktree.mjs` creates an isolated worktree from freshly fetched `origin/main`; `publish-main.mjs` refuses dirty trees, moved bases and a missing Gitleaks, then proves the remote holds the pushed commit; `archive-readiness.mjs` confirms work is committed and on `main`, counting cherry-picked and squashed commits, and optionally installed
- Add `worktree-cleanup.mjs`, a dry-run-first cleanup that removes only idle worktrees whose work is on `main` and keeps dirty, unpublished, locked, recently used and other-environment worktrees
- Add `prepare-host-delivery.mjs`, which builds Host updates from the installed source, pending published interface records and `main`, keeping both sides of release-note conflicts
- Cap the always-loaded agent instructions at 32 KiB, and the app guide at 8 KiB, with a CI check that also verifies their links

### Documentation

- Document the delivery scripts in a task delivery guide and point the agent guide at them
- Ask agents to read current rules from `origin/main`, work in task worktrees, offer to archive once the readiness check passes, publish installed source to `main` the same day, record debt in one deduplicated issue, give journal decisions statuses, and treat missing evidence as inconclusive

### Known limitations

- The daemon's archive tool does not yet run the readiness check itself; agents run the script before archiving

## 0.11.0-beta.3.vorteo.733 - 2026-10-21

### Fixed

- Stop listing every past coordinator recovery in full under Maintenance. Recoveries whose executor cleanup was verified, that stopped before effects or that were canceled now leave the review; only recoveries that still need you stay there.

### Changed

- Combine restart, coordinator update and coordinator recovery history into one collapsed History in Installation. Finished recoveries show one line with their outcome and time, with the full plan behind Exact recovery details.
- Show Refresh recovery status only after a status error; recovery status already refreshes every few seconds.
- Rename Shared workflows to Profile sharing in Installation.

### Validation

- Installation review component tests cover finished recoveries staying out of the review, canceled recoveries moving to history and coordinator history rendering outside the review.

## 0.11.0-beta.3.vorteo.732 - 2026-10-22

## 0.11.0-beta.3.vorteo.739 - 2026-10-22

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.738 - 2026-10-21

### Fixed

- Draw the Context window donut on web. Its track and segments were themed SVG circles, which render nothing there; the donut is now one themed graphic with plain colours, like the usage ring
- Show one loading pulse in the Context window details instead of separate "Loading the breakdown", "Loading usage..." and "Loading plan usage..." lines. The breakdown, account usage and plan usage now appear together once all three have loaded, in the card, the meter popover and the compact sheet

## 0.11.0-beta.3.vorteo.737 - 2026-10-21

### Fixed

- Keep History, Schedules and Settings in the left sidebar toolbar until they would actually overlap. The toolbar hid them at fixed widths, so a 330px sidebar moved Settings into the actions menu with room to spare. It now measures its own width and moves a button into the menu only when it no longer fits.

## 0.11.0-beta.3.vorteo.736 - 2026-10-21

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.735 - 2026-10-21

### Fixed

- Keep the daemon starting when `daemon.browserTools.headlessHost` contains an unknown key or a wrongly typed value, such as a typo or a setting from another release. The headless browser validates its settings itself and stays off with a logged error, so a misspelled denial can never start an unrestricted browser

## 0.11.0-beta.3.vorteo.734 - 2026-10-21

### Added

- Let headless browser allowed hosts name a port range, such as `<preview-host>.ts.net:32768-32799`, so agents can screenshot any managed preview on that name without opening the host's other services or restarting for each new preview

### Documentation

- Describe running the headless browser in the Dev container, inside the container's network, with the safety settings it needs and a rootless library setup for older containers
- Teach agents how browser tools work, what `browser_no_host` and `browser_denied` mean, and how to check a local preview without bypassing the browser policy; update the README browser entry for Host and Dev

## 0.11.0-beta.3.vorteo.733 - 2026-10-21

### Fixes

- Coordinator maintenance no longer treats an unrelated process that later reused the previous updater's PID as that updater still running. Renewal and recovery now prove the updater exited with the reviewed retained-process check: native absence, or a stable later birth at the same PID under the same boot and user. A reused PID no longer blocks coordinator renewal or recovery.

## 0.11.0-beta.3.vorteo.732 - 2026-10-21

### Changed

- Make right-hand card rows as dense as the sidebar. Subagent, task and queue rows are 32px tall on desktop and 44px on touch, 2px apart, with smaller row buttons. Shared row metrics keep both columns aligned.
- Tighten the gap between each card row's first icon and its text to match the gap between a sidebar status circle and its workspace name. Row text now lines up with the card's heading title.
- Show only the status icon, title and actions in Subagents and System sub-agents rows. Profile, model, effort, status, token use, context and cost appear in the row's tooltip. On phones, the first tap on a row shows the tooltip and the second opens the thread.
- Reorder tasks by dragging anywhere on the row. The drag handle is gone, and the check mark sits beside the task text. Touch drags start after a short hold so the card still scrolls.

## 0.11.0-beta.3.vorteo.731 - 2026-10-21

### Maintenance

- Combine 1 source contributions; retain their release notes below

### Fixed

- Keep History, Schedules and Settings in the left sidebar toolbar until they would actually overlap. The toolbar hid them at fixed widths, so a 330px sidebar moved Settings into the actions menu with room to spare. It now measures its own width and moves a button into the menu only when it no longer fits.

### Maintenance

- Port both changes from the installed Host source, where they shipped as vorteo.732 and vorteo.737.

## 0.11.0-beta.3.vorteo.731 - 2026-10-22

### Documentation

- Add four task authorization levels for agents, adapted from Freed: 1 Inspect, 2 Build and preview, 3 Ship to main, 4 Ship and install. Clear requests such as "preview", "push" and "ship it" map to a level without asking; otherwise agents ask once through Open questions and keep doing Level 1 and 2 work while waiting
- Keep restart approval, publication hygiene and external-post rules independent of levels, limit each level to its task, and carry the level into handoffs and subagents without raising it
- Map existing delivery phrases and the interface publication rule to their levels in the agent guide

## 0.11.0-beta.3.vorteo.730 - 2026-10-21

### Added

- Add a Context window card to the right-hand details cards, beside Questions, Checklist and Journal. It shows whenever an agent has reported usage, starts collapsed and remembers its expanded state like the other cards. Its body is the same component the context meter's popover and compact sheet render, so the three always match
- Show what fills the context window: a donut, then each category's tokens and share of the window, with deferred tool schemas listed outside the window. Claude agents report categories such as messages, system tools, MCP tools, skills and the compaction buffer, plus expandable lists of MCP tools, memory files, skills and custom agents. Other providers report totals only and show used and free space with a note saying so
- Add the `agent.context.get_breakdown` request, gated by the `agentContextBreakdown` daemon feature. Older clients never send it and older daemons leave the totals-only view in place
- One loading pulse stands in for the breakdown, account usage and plan usage until all three have loaded, so the details appear together
- Limitation: reading Claude's breakdown costs a request, which is why upstream stopped reading it after every turn. The app reads it only while the card is expanded or the popover is open, then once after each finished turn while it stays visible
- Limitation: the breakdown needs a running Claude query. An agent restored without one shows totals until its next turn
- Limitation: Claude marks deferred rows but not free space or the compaction buffer, so those two are recognized by the names the CLI gives them
- Limitation: item groups expand in the card and the compact sheet. The desktop hover popover lists them without expansion, because it cannot be pressed

## 0.11.0-beta.3.vorteo.729 - 2026-10-21

### Maintenance

- Combine 1 source contributions; retain their release notes below

### Maintenance

- Bring the Context window card from the installed Host lineage (vorteo.730 and the vorteo.737 donut and loading fix there) to main as one commit

## 0.11.0-beta.3.vorteo.729 - 2026-10-21

### Fixed

- Reject writable guest mount overlap with the Linux Host user-bus runtime directory, including ancestor and descendant mounts. Same-UID guests cannot be excluded by directory permissions alone.
- Recheck running process state after all identity reads, refusing a stopped, traced or exited process instead of returning a running observation.

### Maintenance

- Adapt newly added macOS maintenance and session-host consumers to the tagged Host configuration through the launchd-only accessor; systemd operations still refuse explicitly.
- Integrate the Linux Host foundation with current main and preserve both release histories. The adapters remain inert; Linux Host provisioning and recovery are still pending.
- Add deterministic process-state and real-filesystem mount-isolation regression tests. Run configuration and adapter contracts in the existing macOS CI job as well as the server jobs on Linux and Windows.
- Document standard build, package and local-update delivery, including the distinction between installing the foundation and enabling Linux Host support.

### Merged from the Linux Host foundation (0.11.0-beta.3.vorteo.556 on the contributor branch, 2026-10-18)

#### Added

- Add inert Linux Host source adapters: a `systemd --user` service reader that pins the account's user manager through the system manager, a procfs process inspector matching the macOS observation format, and a service ownership check bound to the manager's main PID, parent and cgroup. Nothing selects them yet, so installed Hosts are unchanged.
- Accept a tagged `systemdService` Host descriptor in installation configuration beside `launchdService`. A macOS Host still requires launchd, and Host restarts still support only launchd.

#### Maintenance

- Add the [Linux Host plan](docs/plans/execution-environments/linux-host.md) with its trust anchors, prerequisites, blockers and remaining work. The watchdog's audit-token signal binding has no Linux equivalent yet, so recovery chains cannot be ported until a pidfd design exists.
- Cover the adapters with captured `busctl` fixtures, live procfs tests and a local systemd end-to-end test. Darwin-only installation tests were not run on macOS for this change.

## 0.11.0-beta.3.vorteo.728 - 2026-10-21

### Maintenance

- Record the published interface update for the focused-tab card fix in installation history. Main already carries the fix, so the code is unchanged; both release notes are kept.

## 0.11.0-beta.3.vorteo.727 - 2026-10-21

### Maintenance

- Merge GitHub main into the installed Host source so the Host receives main's newer commits, including the focused-tab card column fix. Where both lines changed Settings, keep main's version, which already integrated the installed redesign and moved the connection check into Environments, Connections. The resulting code matches GitHub main.

## 0.11.0-beta.3.vorteo.726 - 2026-10-21

### Maintenance

- Merge a second GitHub main commit that landed during the first merge. Its fix keeps each conversation's cards in the right-hand column only while that tab is focused.
- The installed line had already moved the queue out of the task cards, so the queue portal edit from main does not apply there; conversation cards still go through the focused-tab portal.

### Merged from GitHub main (0.11.0-beta.3.vorteo.563 there, 2026-10-21)

#### Fixed

- Show only the current tab's cards in the right-hand column. Switching between conversation tabs could leave the previous tab's Open questions, Tasks, Journal, Subagents and queue cards stacked above the current tab's. The column now checks which tab is focused when it draws each conversation's cards.

#### Maintenance

- Give explicit types to agent and worktree list callbacks in the CLI archive, detach, reload, stop and worktree list commands. The type checker dropped their inferred types once the protocol grew, which failed `npm run typecheck` on main. Runtime behavior is unchanged.

#### Validation

- New tests plant a leftover card entry from another tab and confirm it stays hidden, including after focus moves; both fail without the fix. Supporting card group tests pass. Typecheck and lint pass. The supporting view cards suite fails identically on main.

## 0.11.0-beta.3.vorteo.725 - 2026-10-21

### Maintenance

- Merge GitHub main into the installed Host source (release 724) so main carries every installed change. The two lines had numbered versions independently, so main's six commits keep their own labels below and the installed history keeps its labels unchanged.
- Main's headless browser and Add project commits were already installed through earlier integrations; the merge brings no new code for them. The Settings redesign is new to this line and is not yet installed on Host.
- Keep the installation connection check in the redesigned Settings by showing it at the top of Environments, Connections, with a searchable "Connection check" entry. It previously sat in the General page, which the redesign replaced.
- Keep both the paseo skill's preview-sharing guidance and main's browser tools section.
- Add Settings search entries for the installed Agent instruction changes and Session host rows, which main's new catalog did not yet know about, and exclude the instruction review's sub-headings from the row scanner.

### Merged from GitHub main (0.11.0-beta.3.vorteo.562 there, 2026-10-20)

#### Changed

- Show Settings as one continuous page of eleven sections instead of 24 separate pages: General, Accounts & profiles, Agent behavior, Chat & editor, Terminal, Appearance, Workspaces & projects, Environments, Plugins & integrations, Maintenance and About. The sidebar follows the section in view, and choosing a section scrolls to it.
- Move Language to Appearance, version details to About, and installation controls, Vorteo and Paseo update tools and Diagnostics to Maintenance. Restart approval links and the sidebar version footer open Maintenance.
- Lead General with a Needs attention list when something needs action: restart requests waiting for approval, an available Vorteo update and enabled accounts in an error state. New workspace defaults leave out accounts that are not installed.
- List every provider's profiles together under Accounts & profiles, with an All filter first. Older migrated copies fold under the current profile with the same name and show how they differ; they are kept because older launches and workers still use them.
- Show each shared account's quota beside its status, and open the profile editor as a staged full-height panel at the right edge on desktop.
- Say Profile instead of preset, workflow or configuration in profile settings.
- Keep environment tabs inside the Environments section, sticking to the top while that environment's details scroll on web.

#### Added

- Search every setting from the Settings sidebar, or above the list on phones, and press `/` on web to focus it. Results forgive typos, show their section and where the value is stored, filter the page to matching sections and tint matching rows on web. Arrow keys move through results; Enter jumps to the row and flashes it.
- Open a specific setting with `/settings/<section>?setting=<id>`. Previous `/settings/<page>` addresses open the section that absorbed them.

#### Fixed

- Keep provider row controls beside the details button instead of inside it, which was invalid HTML and could trap keyboard focus.
- Stop the Vorteo updates card from showing "Checking GitHub..." twice.
- Open Settings from the sidebar overflow menu in the shared browser test helper.

#### Validation

- Catalog tests fail when a settings row label has no search entry; search, duplicate grouping and profile unit tests pass. Settings navigation, profile, updates and provider browser checks pass for the changed behavior. Provider management at both widths, provider removal, the old Claude CLI warning, the legacy favourites migration and two composer profile-picker checks fail identically on main.

### Merged from GitHub main (0.11.0-beta.3.vorteo.561 there, 2026-10-20)

#### Changed

- Rebuild Add project around one folder browser. Open a folder, New project folder and the GitHub clone destination share it on hosts that can list folders, replacing the separate directory search page, the Browse host folders toggle and the choose-parent-then-name pages
- Create a project folder by browsing into its parent and typing a name, so the parent always exists and the late "Parent directory not found" error no longer appears
- List shared host folders by their host path and container storage by name, so the container user's home never appears as `~` or `/home/paseo`; `~` in typed paths means the host home
- Navigate with Right Arrow to open a folder and Backspace in an empty field to go up; a pasted path opens directly, and top-level text still searches folders by name
- Show creation errors in terms of the browsed folder instead of container paths

#### Fixed

- Open the sidebar overflow menu before choosing Add project in browser test helpers

#### Documentation

- Describe the folder browser in the Docker guide and customizations inventory, and add roadmap items for renaming the container user to `vorteo` and for whole-filesystem browsing on native hosts

#### Known limitations

- Native hosts browse only inside the home folder; other locations must be typed
- Browser tests that add a second host or use the global new workspace action still target moved sidebar controls and fail independently of this change

### Merged from GitHub main (0.11.0-beta.3.vorteo.560 there, 2026-10-20)

#### Documentation

- State in the README that the Host agents' browser cannot reach this machine, private networks or the tailnet unless a specific address is allowed
- Teach agents how browser tools work, what `browser_no_host` and `browser_denied` mean, and how to check a local preview without bypassing the browser policy

### Merged from GitHub main (0.11.0-beta.3.vorteo.559 there, 2026-10-19)

#### Fixed

- Refuse NAT64 forms of private IPv4 addresses and all 6to4 and Teredo addresses in the headless browser, since they can embed private destinations

### Merged from GitHub main (0.11.0-beta.3.vorteo.558 there, 2026-10-19)

#### Fixed

- Refuse loopback, private, link-local, CGNAT/tailnet and local destinations in the headless browser by default, including after DNS resolution and redirects, with `allowedHosts` and `--allow-host` for explicit exceptions such as a local preview
- Validate every message between the daemon and the browser host process, so a malformed or hostile message is dropped instead of crashing the daemon
- Start the browser host process with a minimal environment, keeping SSH agent sockets and tokens out of it

#### Documentation

- Note that Chromium comes from the Playwright cache, outside release custody

### Merged from GitHub main (0.11.0-beta.3.vorteo.557 there, 2026-10-19)

#### Changed

- Run the Host daemon's headless Chromium in a separate supervised process that starts on the first browser request, restarts after a crash with backoff and stops with the daemon. `paseo browser host` uses the same process, so neither the daemon nor the CLI loads Playwright.

#### Validation

- A source trace test confirms the daemon worker and CLI entries never reach Playwright, with a positive control on the browser host entry.

### Fixed

- Show only the current tab's cards in the right-hand column. Switching between conversation tabs could leave the previous tab's Open questions, Tasks, Journal and Subagents cards stacked above the current tab's. The column now checks which tab is focused when it draws each conversation's cards.

### Maintenance

- Give explicit types to agent and worktree list callbacks in the CLI archive, detach, reload, stop and worktree list commands. The type checker dropped their inferred types once the protocol grew, which failed `npm run typecheck` on main. Runtime behavior is unchanged.

### Validation

- New tests plant a leftover card entry from another tab and confirm it stays hidden, including after focus moves; both fail without the fix. Supporting card group tests pass. Typecheck and lint pass. The supporting view cards suite fails identically on main.

## 0.11.0-beta.3.vorteo.726 - 2026-10-20

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.725 - 2026-10-20

### Changed

- Show Settings as one continuous page of eleven sections instead of 24 separate pages: General, Accounts & profiles, Agent behavior, Chat & editor, Terminal, Appearance, Workspaces & projects, Environments, Plugins & integrations, Maintenance and About. The sidebar follows the section in view, and choosing a section scrolls to it.
- Move Language to Appearance, version details to About, and installation controls, Vorteo and Paseo update tools and Diagnostics to Maintenance. Restart approval links and the sidebar version footer open Maintenance.
- Lead General with a Needs attention list when something needs action: restart requests waiting for approval, an available Vorteo update and enabled accounts in an error state. New workspace defaults leave out accounts that are not installed.
- List every provider's profiles together under Accounts & profiles, with an All filter first. Older migrated copies fold under the current profile with the same name and show how they differ; they are kept because older launches and workers still use them.
- Show each shared account's quota beside its status, and open the profile editor as a staged full-height panel at the right edge on desktop.
- Say Profile instead of preset, workflow or configuration in profile settings.
- Keep environment tabs inside the Environments section, sticking to the top while that environment's details scroll on web.

### Added

- Search every setting from the Settings sidebar, or above the list on phones, and press `/` on web to focus it. Results forgive typos, show their section and where the value is stored, filter the page to matching sections and tint matching rows on web. Arrow keys move through results; Enter jumps to the row and flashes it.
- Open a specific setting with `/settings/<section>?setting=<id>`. Previous `/settings/<page>` addresses open the section that absorbed them.

### Fixed

- Keep provider row controls beside the details button instead of inside it, which was invalid HTML and could trap keyboard focus.
- Stop the Vorteo updates card from showing "Checking GitHub..." twice.
- Open Settings from the sidebar overflow menu in the shared browser test helper.
- Keep the installation connection check at the top of General, above Needs attention.

### Validation

- Catalog tests fail when a settings row label has no search entry; search, duplicate grouping and profile unit tests pass. Settings navigation, profile, updates and provider browser checks pass for the changed behavior. Provider management at both widths, provider removal, the old Claude CLI warning, the legacy favourites migration and two composer profile-picker checks fail identically on main.

## 0.11.0-beta.3.vorteo.724 - 2026-10-20

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.723 - 2026-10-20

### Maintenance

- Merge the installed Host source (the Add project folder browser) into the pending batch. Both release note histories are kept; the customizations review keeps all three October 20 entries.

## 0.11.0-beta.3.vorteo.722 - 2026-10-20

### Maintenance

- Combine the reviewed agent instruction change requests and ACP session instructions with the preview link guidance and the card column fix for one Host update. Feature behavior is unchanged by the merge.

## 0.11.0-beta.3.vorteo.721 - 2026-10-20

### Fixes

- Instruction change requests refuse text with characters that render as nothing (zero-width, bidirectional and Unicode tag characters, private-use and control characters other than newline, carriage return and tab) and the reserved session instruction tag, so a reviewed diff always shows everything an approval applies. Long prompts align only the changed middle, so local edits stay readable.

## 0.11.0-beta.3.vorteo.720 - 2026-10-20

### Fixes

- Instruction change requests show "From Dev (untrusted)" or "From Host" from the submitting credential, limit agent-chosen requester names to one line, and lead with the added and removed lines. Each environment has its own pending limit, and proposals the settings would refuse are rejected at submission.
- An unreadable or newer instruction request store is set aside instead of stopping the coordinator, and Installation controls stays usable when the request list cannot be read.
- ACP agents keep their session instructions after a failed first prompt, a first-turn slash command still runs as a command, and history replay hides the instruction block even when a provider trims it.

## 0.11.0-beta.3.vorteo.719 - 2026-10-20

### Fixes

- ACP agents (Cursor, Copilot, Kimi, Kiro and generic ACP providers) now receive the agent's system prompt and the shared agent instructions. ACP has no system prompt channel, so a new session's first message carries them in a marked block that resumed history hides.

## 0.11.0-beta.3.vorteo.718 - 2026-10-20

### Features

- Agents can propose changes to the shared agent instructions with `installation-agent.mjs read-instructions` and `request-instructions`. Installation controls shows the current and proposed text. Nothing changes until the owner presses Apply, which applies exactly the reviewed text and is refused if the instructions changed after the agent read them.

### Fixes

- Remove the empty space below the right-hand cards when collapsed tiles share a row. On web, each tile reported its row in its DOM parent's coordinates, and tiles inside layout-transparent groups used a different origin, so the card column counted an extra row and left up to about 58px unused instead of giving it to Tasks and Files.
- The card column now measures every collapsed tile against the grid in one batched pass after any tile or column resize. Web layout events fire only when a node's own size changes, so a tile pushed down by a sibling used to keep a stale row. State changes only when tiles change lines or a line's height changes, so reallocation cannot loop.
- Collapsed tiles whose tops differ by less than half a tile height still share a line, and a joined line reserves its full extent so a real offset is never clipped. Native tiles keep reporting their own layout position.

## 0.11.0-beta.3.vorteo.717 - 2026-10-20

### Fixes

- Completing a checklist item is refused while any of its acceptance checks is undone, so a completed item never carries failed checks.
- Sending an empty check list drops the progress those checks derived, and `progress: null` stops tracking progress.
- Only plain folder workspaces move their local project along with a group; repository checkouts stay with their repository's project, like worktrees.
- New workspace preselects the only project on a host instead of asking.
- Checks with identical text get distinct keys in the task details sheet.

### Maintenance

- Demo data adds two simulated workers under the first thread so the subagent tiles appear.

## 0.11.0-beta.3.vorteo.718 - 2026-10-20

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.717 - 2026-10-20

### Changed

- Rebuild Add project around one folder browser. Open a folder, New project folder and the GitHub clone destination share it on hosts that can list folders, replacing the separate directory search page, the Browse host folders toggle and the choose-parent-then-name pages
- Create a project folder by browsing into its parent and typing a name, so the parent always exists and the late "Parent directory not found" error no longer appears
- List shared host folders by their host path and container storage by name, so the container user's home never appears as `~` or `/home/paseo`; `~` in typed paths means the host home
- Navigate with Right Arrow to open a folder and Backspace in an empty field to go up; a pasted path opens directly, and top-level text still searches folders by name
- Show creation errors in terms of the browsed folder instead of container paths

### Fixed

- Open the sidebar overflow menu before choosing Add project in browser test helpers

### Documentation

- Describe the folder browser in the Docker guide and customizations inventory, and add roadmap items for renaming the container user to `vorteo` and for whole-filesystem browsing on native hosts

### Known limitations

- Native hosts browse only inside the home folder; other locations must be typed
- Browser tests that add a second host or use the global new workspace action still target moved sidebar controls and fail independently of this change

## 0.11.0-beta.3.vorteo.716 - 2026-10-20

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.715 - 2026-10-20

### Fixed

- Session host status queries count only a missing listener or a greeting that never arrives as silence. A host that answers in another protocol version, rejects the request or never sends its session list is alive, so removal never force-stops it, for example while the coordinator and the Host run releases with different session host protocols. The session list wait is now bounded, so a stalled host cannot hang status or the lifecycle queue.

## 0.11.0-beta.3.vorteo.714 - 2026-10-20

### Changed

- The lifecycle queue registers the session host release guard itself whenever source updates select Host releases, on every platform, so no coordinator entry point can select a Host release unguarded.
- An approved session host operation says it waits for pending restarts and other lifecycle work. A failed install names a watchdog kill during the install check, and the removal card says removal is refused while hosted sessions run.

## 0.11.0-beta.3.vorteo.713 - 2026-10-20

### Fixed

- Session host removal never force-stops a host that refuses the coordinator's connection, as it does at its connection limit, because refusing proves the host is alive and may still serve workers. After five minutes of refusals the removal fails without changes.

## 0.11.0-beta.3.vorteo.712 - 2026-10-20

The installation coordinator owns the durable session host's launchd job as tracked, owner-approved lifecycle work. Installing the job never turns durable sessions on.

### Added

- Install, inspect and remove the session host's launchd job, `local.vorteo.<installation id>.session-host`, through the coordinator. It derives each plan from its own configuration: the current release's session host entrypoint through the current link, with only `HOME`, `PASEO_HOME` and `PATH`. Requests join the existing lifecycle journal, and only an owner decision naming the exact operation and plan digest approves one; restart decisions and the trusted Host approval policy never do. Dispatch recomputes the plan and changes nothing when it differs, and a coordinator restart never replays an approved or running operation.
- Install writes the plist with mode 0600 and requires the new host to answer with launchd's pid within 60 seconds and without a watchdog kill, or removes the job again. An identical installed job counts as installed.
- Removal is refused while the durable sessions setting is on or the host runs sessions. A host that stops answering is stopped only after the workers' five-minute alive window with the setting still off, and the receipt records the forced stop. A process that survives bootout is killed only after its command is verified as the session host.
- Host routes for status and requests, owner routes to query, request and decide, the `sessionHostJob` capability for the Host client, and session host counts in the restart summary. Dev sees only whether the job exists.
- Installation controls show the job's status and full plan with Install, Remove, Approve and Cancel, and a pending request raises the sidebar notice. The maintenance client adds `request-session-host --install|--remove` and `session-host-status` for the Host client, documented in the maintenance skill.

### Changed

- While the session host job is installed, source updates and supervisor maintenance refuse to select a Host release without the session host entrypoint, and `install-execution-host.mjs remove` refuses to run.
- A worker declares a hosted session lost as soon as reattach fails while no live process holds the host lock, because its lock is gone or names an exited process. A lock that cannot be read still counts as alive.

### Maintenance

- Tests use fake launchd effects and an isolated home, plus one opt-in real launchd round trip with a test label (`DURABLE_SESSIONS_LAUNCHD_E2E=1`). Coordinators without session host support reject the lifecycle journal once a session host record exists, so keep a supporting coordinator as the rollback target. The job reaches an installation only through a coordinator update; live installation, real Claude acceptance and the rollback rehearsal remain.

## 0.11.0-beta.3.vorteo.711 - 2026-10-20

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.710 - 2026-10-20

Host-owned refresh for full sign-in Claude accounts, off by default and independently reviewed with its fixes. Dev receives only short-lived access tokens; the Host account's own CLI keeps the only refresh grant.

### Added

- Prepare daemons for Host-owned Claude refresh. Shared Claude account definitions can carry a full sign-in type, and settings projection creates such bindings only on daemons that advertise `claudeFullSignIn`. The Host returns only a full sign-in account's exact configuration path to the coordinator, never a credential. Dev writes access-only token projections into the account's `.credentials.json` under the CLI's storage lock, keeps the CLI's other storage keys, applies generation and rotation order, and journals digests only.
- Add Host-owned refresh for full sign-in Claude accounts in installations, off by default behind the coordinator setting `claudeHostRefresh`. Owner routes under `/api/installation/owner/claude/oauth` mark a definition full sign-in, sign the Host account in with `claude auth login --claudeai` in its exact configuration directory, and sign it out. The Host account's own CLI storage keeps the only grant.
- While a non-excluded Dev environment can use the account and its token expires within four minutes, the coordinator makes one tiny official CLI request: print mode, Haiku, no tools, one turn and no session persistence. The CLI refreshes under its own locks. Dev receives only the access token, expiry, scopes and plan, numbered by generation and rotation. Coordinator state holds digests, expiry and identity only.
- Dev usage for a projected account whose token expired says it is waiting for the Host instead of asking for sign-in.

### Changed

- Setup-token delivery and setup-token sign-in refuse full sign-in definitions.
- Refresh only for a Dev that received the current token, and retry undelivered tokens after 30 seconds, doubling to five minutes. Reconcile accounts concurrently and limit the refresh request to 60 seconds.

### Fixed

- Refuse to mark a Claude definition full sign-in until every daemon advertises `claudeFullSignIn`. An older daemon would otherwise reject the whole settings authority, not just this account.
- Stop relaunching the CLI every minute for a revoked or expired Host grant. Failed refreshes back off from one minute to five. After three failures an expired grant counts as lost: Dev is withdrawn and the status asks for sign-in again until a newer Host token or a new sign-in appears.
- Trust a Host or Dev credentials file only when it is a regular file of bounded size, owned by this user and not writable by others.

### Known limitations

- Nothing sends these requests until the coordinator side lands behind its setting. Projections are refused on macOS daemons. Lock and file names come from static analysis of Claude Code 2.1.284.
- The app has no controls yet. A changed identity on reconnect is recorded, not blocked. Back up coordinator state and Dev projection journals together.
- Unverified until the owner's live sign-in check: the macOS Keychain location of the Host grant, granted scopes, token lifetime and how quickly a running Dev CLI picks up a new token.

### Validation

- 7 new synthetic tests; 129 installation account, settings and provider-login tests pass.
- 18 new synthetic tests: refresher 8, Host CLI 6, runtime 3 and usage 1. With two workers, 663 of 665 focused tests pass. The packaged CLI checksum failure is environment-only. One timing-sensitive agent test failed under a load average near 300 and passes alone.
- A regression test covers each fix. 31 Host-refresh tests pass; the focused server typecheck, lint and format are clean.

## 0.11.0-beta.3.vorteo.709 - 2026-10-20

### Fixed

- Older apps can edit checklist items that carry progress. They parse items without `progress` and `checks`, so the conflict check compares those fields only when the editor sent them; every other field keeps exact conflict detection.
- Agent checklist guidance and the update tool now say that each update's `checks` replaces the whole list, so agents send every check instead of erasing the others.

## 0.11.0-beta.3.vorteo.708 - 2026-10-20

Checklist progress and project placement, independently reviewed, on top of durable sessions.

### Added

- Checklist items can carry acceptance checks and a 0 to 100 progress value. Passed checks decide progress; estimates round to 5 points and stay at or below 90 until the item is completed.
- Task rows show a muted percentage for partly done work, marked as an estimate when no checks exist, and the details sheet shows a progress bar with each check.
- Workspace progress adds partial credit per item across threads. Petals fill partway, and the tooltip and screen-reader text use the credit-based percentage with a blocked count.
- Agent checklist instructions explain checks first, capped estimates and milestone updates.
- Moving a workspace into a group also moves its local project when the group has exactly one on that host. Worktrees stay with their repository; older daemons keep the group-only move.

### Fixed

- A sidebar row's plus opens New workspace with that row selected, beside the active workspace when it belongs to the row.
- New workspace keeps a remembered shared group instead of resolving it to another project that shares its local folder, and borrows that workspace's folder when the group has none of its own on this host.
- New workspace falls back to your last manual project choice and otherwise asks, instead of selecting the first project in the list.
- Cards below the conversation, including Messages, and turn footers follow a resized text column instead of the default content width.
- Sidebar project rows no longer re-render when the active workspace changes, and project selection no longer re-renders repeatedly when no project is selected.

### Maintenance

- Integrate the checklist progress branch after durable sessions. Only version metadata and release notes conflicted; every installed release-note entry is kept byte-identical.

## 0.11.0-beta.3.vorteo.707 - 2026-10-19

Durable sessions phase 1, off by default. Claude sessions on the Host can run in a separate session host process that keeps their turns running while the Host worker restarts. Nothing changes until the session host job is installed and `$PASEO_HOME/durable-sessions.json` is enabled. Every milestone was independently reviewed.

### Added

- The durable sessions end-to-end test answers a permission asked before a worker kill after the replacement worker attaches: the request is shown once and the hosted turn finishes. It also proves that the replacement worker of a password-protected daemon accepts the session host's tool token at the agent endpoint and still rejects a wrong one.
- An end-to-end test runs the real supervisor, daemon worker and launchd-managed session host in an isolated test installation, with its own home under /tmp, its own port and a test-only launchd label, and a scripted fake Claude in the host. A hosted turn survives a killed worker, a supervisor restart and a daemon upgrade from one release to another while the host keeps the old release, with every streamed chunk shown exactly once, no error and no continuation. When the host itself is killed, launchd restarts it and exactly one continuation finishes the work on a fresh session. Run it with `DURABLE_SESSIONS_E2E=1`.
- A real-Claude variant of the killed-worker case on Claude Haiku runs only with `DURABLE_SESSIONS_REAL_CLAUDE=1`.
- The session host runs as its own service process for a launchd job that depends on neither the daemon, its port nor its workers. It writes a fresh token only after it holds the host lock, keeps the tool server token in memory and logs to a size-capped private file. When a newer worker needs a newer protocol, the host exits once no session runs so launchd starts the installed release; an older worker never causes an exit.
- A watchdog on its own thread kills the host when its main thread stops responding, or when the host fails its own hello probe for 30 seconds, as with a deleted socket, a replaced token or exhausted connection slots. A session therefore counts as lost only once its host is gone. launchd job helpers manage only test labels unless a caller explicitly allows an installed one.
- Restarts no longer interrupt durably hosted Claude turns. The restart drain does not count, steer or interrupt attached hosted sessions and queues no continuation for them; worker shutdown detaches them instead of closing them, and the next worker takes them over mid-turn.
- If the session host itself stops mid-turn, the worker cancels the turn, reopens the agent on a fresh session (hosted again when a host answers, otherwise in the worker) and queues a continuation message, as a restart would. Agents whose sessions vanished with a restarted host continue the same way when the next worker starts.
- A worker that starts while hosted Claude sessions are still running a turn or waiting on a permission takes them over before it accepts clients. It rebuilds each timeline from the provider's saved history plus the events its predecessor had already applied, then applies the rest live, so no row appears twice and none goes missing. A turn still running is shown as running and finishes in the new worker; a permission asked before the restart is shown once and can be answered.
- Idle hosted sessions are closed at startup and resume on demand like any other agent, which keeps the host from accumulating them. Sessions whose host restarted are reported as lost for the restart fallback.
- Hosted providers call the agent tool endpoint with a token owned by the session host, which every worker accepts, so tool calls keep working after a worker restart even with a daemon password.
- Run Claude agent sessions in the durable session host, behind a setting that is off by default. When `$PASEO_HOME/durable-sessions.json` contains `{"enabled": true}` and the host answers, new and resumed Claude sessions run in the host and the worker drives them through a proxy. The proxy mirrors what the agent manager reads synchronously (session id, persistence, pending permissions and features), applies each state change before the event that caused it, pages saved history, and forwards turns, steering, interrupts, permission answers, modes, model, thinking, features, commands and rewind. A dropped connection reattaches without failing the turn.
- Command discovery, internal, non-persistent, history-only and quota-governed sessions stay in the worker, and so does every session when the host is unavailable. A session the host still runs is never started a second time.

### Fixed

- Test cleanup and the leftover check now find this run's processes by the run's temporary root in their command line or environment, read environments that span several lines, and never touch the shell or test runner that started the test.
- The release scenario is named for what it proves: a host on one release label serving a worker on another with the same protocol. A real upgrade is left to installed acceptance.
- A permission answer, steer or other call to a hosted session whose host is alive but silent now fails after the one-minute reattach window with a message that the call can be retried, instead of waiting up to five minutes. The session is not reloaded, so the turn keeps running in the host and the call succeeds once the host answers again.
- The session host replaces its watchdog thread if the thread ends, backing off while replacements keep ending, so a host that later stalls is still killed and replaced rather than running unguarded.
- A hosted session keeps reattaching past its one-minute window for up to five minutes while the session host process is still alive, instead of giving up its turn beside a host that may still run it. A host that is gone still ends the wait at once.
- The session host watchdog now tolerates 90 seconds of failed hello probes before it kills the host, so heavy machine load alone cannot end every hosted turn at once. A main thread blocked for 30 seconds is still killed.
- The session host launchd job waits 30 seconds after a stop request before launchd kills it, longer than the host's own 20-second shutdown deadline.
- A hosted session that is reconnecting when a restart begins is treated as hosted: the restart neither counts, steers nor interrupts it, and shutdown releases it to the next worker without closing it.
- Loading an agent whose host is alive but not answering waits up to the reattach window and then fails with a clear message, instead of starting a second provider on the same conversation. Startup no longer reports the sessions of such a host as lost.
- With the setting off, startup also asks a running host when no applied record exists, so a session whose worker died before its first record is taken over. A lost session's record is removed once its agent moves to a fresh session, and a host lost during a restart drain queues the continuation without trying to reopen the agent.
- An adopted session holds live events for as long as its history takes to read; the safety release starts only after reading finishes. Detaching tells the host, so its audit log records the handoff.
- Stored agent records no longer keep the injected tool server or its run-scoped token for any provider.
- The host applies a private file mask only while it creates its socket, so files that Claude and its tools create keep their usual permissions.
- Takeover planning now runs before the scheduler or any other service can load agents. Loading an agent whose session the host still runs takes it over instead of failing, even after the setting is turned off, so two providers never run one conversation. A transient load failure releases the session for a later load; only a missing agent or unavailable provider closes it.
- Held live events are released only after the agent manager has committed the rebuilt history, fixing a race that could show live rows before history rows.
- A worker that was replaced no longer deletes its successor's applied record when it closes, and persisted handles of hosted sessions no longer carry the tool server's bearer token.
- A hosted session whose connection drops keeps trying to reattach for up to a minute with backoff, skipping the connector's retry pause, instead of failing the turn after one attempt. Only a host that no longer runs the session ends the turn; a slow or saturated host does not.
- A session fenced by a newer worker cancels its own view of the running turn, so nothing in the old worker waits on a turn it can no longer see. The provider is not touched.
- Undeliverable or unreadable events and an overflowing pre-subscriber buffer produce one notice per attachment instead of one per event. An event type unknown to an older worker is skipped with that notice rather than failing the session.

### Validation

- All six scenarios pass in 217 seconds with no leftover jobs, directories or processes. The tool token scenario fails when the worker stops accepting the host's token.
- Eighty-two focused session host tests pass with one opt-in skip. New tests cover a permission answer retried after a silent host returns and a hang killed by a replaced watchdog thread; both fail without their change.
- The four scenarios pass in 167 seconds on this branch and leave no test jobs, directories or processes behind. The real-Claude variant has not run yet.
- Focused session host, restart, listen reclaim and worker watchdog tests pass after the merge, except one restart queue test that already fails at the shared base.
- Thirty-eight focused restart, launchd, watchdog and hosted session tests pass, with the opt-in launchd round trip skipped. New restart tests cover a session waiting past its window for a live host and one given up after the longer window; the first fails without the change.
- 120 focused session host, authentication, tool configuration and projection tests pass, plus 340 in the agent manager, persistence and storage suites, and the opt-in launchd round trip passes with a test label and leaves nothing behind. New restart tests cover a session reconnecting during a restart, a session without its first record with the setting off, a host lost during a restart drain and a live but silent host.
- Eight restart tests pass, covering a graceful restart through the drain and detach, a worker crash, takeover without startup planning, a running session after the setting is turned off, a host that dies mid-turn, a permission across the restart, idle sessions closed at startup and lost sessions. Together with the session host, manager, queue and registry suites, 443 tests pass.
- Sixty-six focused tests pass, including a worker killed mid-turn whose replacement shows the identical timeline and finishes the turn, a permission answered after the restart, idle sessions closed at startup, sessions of a restarted host reported lost, history paging, the host token at the tool endpoint and private applied records.
- Thirty-eight focused tests pass, adding a reconnect whose first attempts fail while the turn still completes, a fenced session settling its turn, and one notice for several undeliverable events.
- Thirty-five focused tests pass: the session host protocol suite, hosted Claude sessions with a controllable fake provider (state mirroring, permissions, history paging, reconnects, host loss, eligibility, the setting) and a fake Claude agent driven end to end through the agent manager with the setting on and off.
- Twenty-four focused session host tests pass repeatedly. They cover a worker lost mid-turn, stale-worker fencing including acknowledgements, bounded, host-wide and acknowledged replay fallback, rejected tokens and versions, frame limits before and after hello, oversized events, a worker that stops reading, connection and refusal caps, concurrent opens, stale locks and sockets from exited hosts, bounded shutdown, a per-session sequence gap, private files with token rotation across host restarts, and an audit log free of secrets.

### Maintenance

- Test children receive an explicit environment instead of inheriting the agent's, the live installation's ports are refused, and cleanup checks for leftover jobs, directories and processes, including orphaned stand-in Claude processes.
- Merged the reviewed restart orphan fix into the durable sessions branch: workers kill themselves when their supervisor is gone, a starting worker reclaims its listen address from a frozen predecessor after re-verifying the holder before each signal, restart dispatch has a readiness deadline, and a real supervisor reproduces the frozen restart. The session host is unaffected, since it never listens on TCP, does not run a daemon worker script and is its own launchd job.
- Worker shutdown names a "detach hosted sessions" step before "close agents", so a stalled shutdown reports where hosted sessions were released.
- Documented that a killed host's lock is left behind on purpose, since its dead process id tells workers the host is gone, and that the job's entrypoint must resolve to the installed release at every start.
- The audit and service logs share one rotating appender, and the scripts build includes the session host entrypoint.
- Still missing: installation steps for the launchd job and an isolated end-to-end run of the real daemon, so the setting stays off.
- Sessions gain optional runtime members for durable hosting, detaching and history commitment, forwarded by the provider registry. The session host protocol gains a release request. Restart readiness logs hosted sessions attached as n/n at startup.
- Still missing: the session host's own service process and launchd job, so the setting stays off.
- Each hosted agent's last applied event is written to a private file before the host is told it was applied. The host keeps acknowledged events for later rebuilds within its retention limits, and gains paged history reads for the attached worker and a session list for startup. The list leaves out snapshots that would not fit one frame.
- Sessions attached at startup are adopted whichever way their agent loads, even if the setting was turned off since, so their turns can finish. Interrupts asked for while reconnecting are delivered on reattach instead of waiting out the reconnect window, reconnect backoff never keeps a stopping worker alive, and a close cut off mid-call is logged.
- Still missing: worker shutdown closes hosted sessions instead of detaching them, the host has no launchd service, and restart readiness does not skip hosted sessions, so the setting stays off.
- The setting lives outside config.json because config.json is parsed strictly: an unknown key would stop an older release from starting after a rollback.
- The session host protocol carries the full session call contract with a result schema per method. Attach results include a provider state snapshot, and a worker can attach at the newest event. Provider errors keep their name and message when serialized, and a closed connection is forgotten before its sessions reattach.
- Not yet useful to enable: workers do not reattach hosted sessions at startup, the host has no launchd service, and restart readiness does not skip hosted sessions.
- Harden the durable session host prototype for phase 1. Frames are size-capped (4 KiB before hello, 32 MiB after) and validated in both directions, including typed call results. An unauthenticated connection must say hello within 5 seconds, connections are capped, and a peer that keeps sending refused calls or acknowledgements is dropped.
- A worker that stops reading, such as one hung in shutdown, is dropped at a live-output limit twice the frame cap while its sessions keep running; replay is flow-controlled so a large catch-up is not dropped. Only the current attachment can acknowledge events, and reattaching below the acknowledged or retained range falls back to restart continuation instead of silently skipping events. Retention is bounded per session and across the host, oldest events first. Oversized or unserializable provider events become markers so sequence numbers stay contiguous. The client fails closed on malformed frames, detaches only the affected session after a sequence gap, and reports a missing host separately from a dropped connection.
- The host directory must be a real directory owned by the user with mode 0700; the socket, token, lock and audit files are 0600. Each host start writes a fresh token, and workers refuse a token file other users could read. A lock file keeps two hosts from serving one socket; a lock or socket left by an exited host is replaced. An audit log records authentication, attach, fencing and disconnect outcomes without tokens, prompts or configuration. A failed close keeps the session hosted so it can be retried, and host shutdown bounds each provider close.
- Not integrated: no daemon, supervisor, launchd or provider changes, and no setting enables the host yet.

## 0.11.0-beta.3.vorteo.706 - 2026-10-19

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.705 - 2026-10-19

Restart-orphan fix for the 2026-10-19 Host outage, where a daemon worker froze during shutdown, outlived its supervisor and held the listen port for ten hours.

### Fixed

- Kill a daemon worker that outlives its supervisor or its shutdown deadline. A watchdog thread with its own event loop kills the worker 15 seconds after a shutdown request, or after the supervisor disappears, even when the main event loop is frozen, and logs the shutdown step it was waiting on. Every shutdown step, including the headless browser host, is named in the log.
- Reclaim the listen address from a frozen predecessor. A starting worker identifies the holder; a previous daemon worker of this installation, run by the same user, gets SIGTERM and then SIGKILL, with its pid, uid, start time and arguments re-verified before each signal so a reused pid is never signalled. Any other holder is reported and retried with exponential backoff up to a minute.
- Give each dispatched restart a 10-minute readiness deadline. After it the job fails without replay and releases any continuation hold, and a late outcome is logged but never applied. Readiness probes are bounded, and the coordinator logs each dispatch step.
- Keep the supervisor alive until its worker force-kill timer fires, give the Host launchd job a 30-second `ExitTimeOut`, and make a terminal worker exit when its daemon worker is gone.

### Validation

- A real supervisor and worker pair reproduces the outage with a turn under a continuation hold whose teardown freezes the event loop. The old worker is killed at its deadline and a replacement binds the port; both tests fail without the fix.

## 0.11.0-beta.3.vorteo.705 - 2026-10-19

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.704 - 2026-10-19

Combined release on top of the coordinator readiness fix: delegated request labels, Claude full sign-in accounts, a headless browser host for Host agents, and off-by-default release seals and coordinator bundle. Every included branch was independently reviewed.

### Added

- Give Host agents browser tools through a disposable headless Chromium, run by the Host daemon when `daemon.browserTools.headlessHost` is enabled or by `paseo browser host`. Each run uses an empty profile and blocks denied origins, including redirects, popups, fetches and WebSockets. The protected interface still refuses automation.
- Add a full web sign-in Claude account type beside setup-token accounts. Sign-in runs the official `claude auth login --claudeai` in the account's own configuration directory, where the CLI stores and refreshes the grant. A non-secret binding marker records the type; existing bindings stay setup-token, and a retried creation cannot change it.
- Show usage for full sign-in accounts from only that account's own credentials: the per-directory Keychain item the pinned CLI derives on macOS, then its `.credentials.json` fallback, or the file alone on Linux. Setup-token accounts stay unavailable.
- Show Host-agent requests from owner-delegated requesters as "Being handled by <requester>" with their reason and a Cancel action in the sidebar and Installation controls, instead of an approval toast. Owner decisions remain available, and the locked summary no longer prompts for them.
- Let an owner-delegated setting give automatically approved Host source updates the same full service restart as an owner approve, after the cancellation window and the finish-turns hold, with exact grant binding and no replay.
- Optionally build a standalone coordinator bundle during release preparation, off unless `VORTEO_COORDINATOR_BUNDLE=enabled`. It runs right after the installation receipt is written. It traces the coordinator service and every runner module that custody reads or launches by runtime-built name, including the recovery access entrypoint. Only that closure, the receipt and the owner scripts are copied into `<release>/coordinator`, with a file manifest. A build of current source yields 847 entries and 30 MB, against 3.6 GB for the full release. Nothing consumes the bundle yet.
- Refuse a bundle with missing inputs, unreviewed trace warnings or escaping links. Its verifier must load and digest the bundle under Node's permission model with reads confined to the bundle.
- Add optional release seals, off unless both the coordinator and the Host run with `VORTEO_RELEASE_SEALS=enabled`, and macOS only. Preparation refuses tool caches directly under `node_modules` or at the release root, linked `node_modules` and descriptors open for writing. It then makes the release immutable, digests it in full and records its manifest and per-entry metadata beside it. The admission receipt binds the seal digests. Approval checks metadata instead of re-reading bytes; a change falls back to a full byte check and names the changed path. The v1 digest and wire format are unchanged.
- Add `removeBootstrapRelease` for cleanup of sealed releases, and document manual cleanup with `chflags -R nouchg`.

### Changed

- Run the Host daemon's headless Chromium in a separate supervised process that starts on the first browser request, restarts after a crash with backoff and stops with the daemon. `paseo browser host` uses the same process, so neither the daemon nor the CLI loads Playwright and the Host startup module contract keeps its existing rules.
- Share one browser automation engine between the desktop app and the headless host, and merge current main into the browser host work.

### Fixed

- Refuse NAT64 forms of private IPv4 addresses and all 6to4 and Teredo addresses in the headless browser, since they can embed private destinations
- Refuse loopback, private, link-local, CGNAT/tailnet and local destinations in the headless browser by default, including after DNS resolution and redirects, with `allowedHosts` and `--allow-host` for explicit exceptions such as a local preview
- Validate every message between the daemon and the browser host process, so a malformed or hostile message is dropped instead of crashing the daemon
- Start the browser host process with a minimal environment, keeping SSH agent sockets and tokens out of it
- Remove web tooltips directly on dismissal so interrupted animations cannot leave small floating boxes behind. Preserve hover, keyboard focus and native tooltip fades; add browser regression coverage with the real animation library.
- Sign a full web sign-in Claude account out with its own CLI (`auth logout` in its configuration directory) before removal deletes the directory. On macOS its Keychain item otherwise outlives the directory. Sign-out failure does not block removal; the removal response carries a warning naming the item and the daemon logs it.
- Report an expired full sign-in access token that still has a refresh grant as refreshing on the account's next turn, not as a lost sign-in. The CLI refreshes only when it runs, so usage reads no longer ask for sign-in while the grant is valid. Grants without a refresh token still defer to the usage endpoint.
- Launch full sign-in accounts without inherited secure-storage, OAuth, gateway or cloud-provider overrides, so they cannot use another account's storage. Read the type marker only from bindings, never from the daemon's own environment.
- Let release scan workers inherit the parent's execArgv unchanged unless main-input options had to be removed. Node rejects V8 and process-level options such as `--max-old-space-size` in an explicit worker execArgv, which broke scans in development daemons. A parent that combines such an option with `--input-type` remains unsupported.

### Documentation

- Note that Chromium comes from the Playwright cache, outside release custody

### Validation

- A source trace test confirms the daemon worker and CLI entries never reach Playwright, with a positive control on the browser host entry.
- Synthetic tests with a fake CLI cover sign-out arguments and directory, failure without blocking deletion, setup-token accounts and stale reviews; 29 removal and account tests pass.
- Synthetic tests cover expired, still-valid and refresh-less records; the quota suites pass.
- With the marker set in the shell, 559 of 560 focused Claude, provider-login, quota and installation-account tests pass; the remaining packaged CLI payload check fails identically without this change.
- The guarded file skips in a sandbox with no OpenRouter key and an empty Claude configuration; format and lint pass.
- 17 new synthetic-credential tests pass. 537 of 538 focused Claude unit tests pass; the packaged CLI payload check fails identically on the base commit in this worktree. Workspace typecheck, lint and format pass.
- Delegation, coordinator and Installation model tests cover handled, running, grace and overdue requests and the mid-preparation setting change.
- Focused coordinator, delegation and Installation model tests pass, with a real-browser check of the delegated banner against the packaged coordinator and web interface.
- Builder tests cover the exact closure with links, assets and owner scripts, agreement with the runner contract's runtime-named modules, a missing receipt, warning refusal, a verifier reading outside the bundle, output reuse and the disabled default. They need no built workspace package.
- Seal tests cover digest equality with the sequential implementation, write refusal, sweep-only acceptance, the default-off setting, named content and cache changes, metadata-only fallback, forged and unbound seals, a mismatched manifest, open writers, policy refusals, resealing, unsealing, removal and the non-macOS refusal. A source-update test seals a prepared candidate and refuses later writes.
- A parent started with `--max-old-space-size=64` digests successfully, and that test fails with an always-explicit execArgv. The `--input-type=module --eval` child tests still pass.

### Known limitations

- The app does not display the removal warning yet. Whether logout revokes the grant at Anthropic is unverified.
- When real-provider runs are enabled, this test still uses the machine's default Claude login rather than OpenRouter.
- Managed installations still refuse environment-local sign-in, and the app does not offer the type yet. Installation-wide use needs Host-owned refresh with short-lived Dev tokens. Live sign-in, granted scopes and usage acceptance are unverified.

### Maintenance

- Combine the installed coordinator readiness fix (installation-integration at e52d1bd2b) into the post-Factory integration; retain its release notes below with their original version labels. The customizations log keeps both sides' entries.
- Combine the Host headless browser host (browser-host-on-installed) into the post-Factory integration; retain its release notes below with their original version labels. The customizations log keeps both sides' maintenance entries.
- Combine Claude full sign-in v2 into the post-Factory integration; retain its release notes below with their original version labels.
- Clear the managed-installation client marker in the server test setup. Agent shells on a managed Host inherit it, which made Claude setup-token, session, authentication and usage suites fail; suites that test managed behavior still stub it explicitly.
- Skip the nested subagent ownership real-provider test unless an OpenRouter key is configured, using the same guard as the other Claude real e2e tests. Running the file directly or through `test:e2e:all` no longer spends this machine's default Claude login.
- Combine delegated approvals v2 with release verification speedup, scan worker fixes, release seals and coordinator bundle stage 1; retain their release notes below. Delegated approval entries keep their original version labels.
- Show delegated requests as handled only while they are automatically approved, running, or pending within a grace window (default 15 minutes, at most an hour). After that the owner gets the normal prompt and toast, noting that the delegate is taking longer than expected.
- Use a full service restart for an automatic Host update only when its grant was issued under the current owner setting, so enabling it during preparation never upgrades an existing grant.
- Document that delegated requester labels are display only and not authentication.

## 0.11.0-beta.3.vorteo.699 - 2026-10-19

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.698 - 2026-10-19

### Fixes

- Count any unreadable or malformed coordinator runner file, including deeply nested JSON, as no executor activity, so a diagnostic file can never stop the automatic watchdog.

### Validation

- The runner-file filter regression now includes a deeply nested JSON file.

## 0.11.0-beta.3.vorteo.697 - 2026-10-19

### Fixes

- Wait up to two minutes for launchd to start the startup recovery service after registration, checking once a second. Each check now confirms only the execution lock and the exact claimed request; full ownership verification, which rehashes the release tree for 8 to 17 seconds, still runs immediately before registration and after readiness. Previously the 15-second wait fitted only one or two checks, so a healthy request failed when launchd took 20 to 58 seconds to start the service.
- Let the automatic watchdog treat advancing activity in the bound executor's own runner file as progress while the request stays claimed. Activity can postpone fencing for at most 15 minutes after the watchdog starts waiting; stage changes keep their existing 180-second reset. Unreadable, foreign or ambiguous runner files count as no activity.

### Validation

- Simulated-clock regressions cover a 58-second launchd start with full checks only before and after the wait, the two-minute bound, ownership loss during the wait, an executor whose activity advances for 300 seconds without a stage change, the 15-minute cap, the unchanged 180-second stage timeout and rejection of foreign runner files. The new cases fail on the previous source.

## 0.11.0-beta.3.vorteo.696 - 2026-10-19

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.695 - 2026-10-18

### Fixes

- Start release scan and reader workers without the parent's main-input options. Bounded verification children run as `--input-type=module --eval`, and workers inheriting `--input-type` failed at once, so the executor's retained-renewal check refused every coordinator dispatch in 0.3 s. `--eval`, `--print` and `--experimental-default-type` are dropped as well, in inline and separate forms.

### Validation

- Regression tests run a full digest with parallel readers inside `--input-type=module --eval` children, in both forms, using the retained-renewal launcher's flags, reduced environment and stdout handshake. They fail without the fix. The real retained-renewal child, run from this build against the live renewal file, now passes (exit 0 in 9.5 s, where v695 exited 1 in 0.35 s).

## 0.11.0-beta.3.vorteo.695 - 2026-10-19

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.694 - 2026-10-18

Adds the Host renewal context refresh to the vorteo.693 integration. Its branch numbered its entries vorteo.692 and vorteo.693 independently; neither was installed, so they are kept here verbatim under this version.

### Renewal context refresh (renewal branch vorteo.692)

#### Fixes

- Re-derive the Host's coordinator renewal context after a coordinator request completes, or when the selected configuration changes, instead of refusing later requests until the Host restarts. Derivation reuses the unchanged initialization with every custody and identity check. Concurrent operations wait for one derivation. An operation already running still refuses a context change that happens while it runs.

#### Validation

- Tests cover preparing and approving request B after request A completes without a Host restart, a refused mid-operation change followed by re-derivation, single-flight concurrency, an unavailable derivation retried by the next operation, status-read refresh, and which history changes trigger re-derivation.

### Renewal refresh fixes (renewal branch vorteo.693)

#### Fixes

- After a failed renewal re-derivation, status reads retry only once coordinator history or the selected configuration changes again. Polling no longer chains full derivations right after a coordinator replacement, explicit operations still retry, and the failure reason stays visible.
- Forward availability from the current ordinary review through claimed-recovery refresh, and release a replaced service's subscription.

#### Validation

- Tests cover repeated status reads after a failed derivation, retry after a later context change, and claimed-recovery subscription forwarding and release.

### Validation

- Integrated source passes the workspace typecheck, repository lint, server and CLI builds, 723 renewal, Host, artifact, scan, launch and runner cases, 165 claimed review and owner session cases, 905 of 907 continuation and question cases and the Open questions browser spec at three widths. The two failing cases also fail on vorteo.689.

## 0.11.0-beta.3.vorteo.693 - 2026-10-18

Adds release verification speedup A to the vorteo.692 integration. Its branch numbered its entries vorteo.690 and vorteo.691 independently; neither was installed, so they are kept here verbatim under this version.

### Release verification speedup (speedup branch vorteo.690)

#### Fixes

- Verify coordinator and Host release trees on worker threads with bounded parallel reads. Digests stay byte-identical, so existing coordinators keep accepting them. A full installed release takes 8 to 13 seconds rather than more than two minutes, and the Host event loop stays responsive while it runs.
- Hash each distinct release tree at most once per review action, plan verification or dispatch. Later checks in the same operation re-assert every retained path's metadata off the event loop, never across operations or processes.
- Keep each caller's deadline and cancellation separate within shared verification. One caller's timeout no longer rejects other callers, and a rejected or abandoned scan is never reused.

#### Validation

- Equivalence tests compare the new and sequential implementations on fixture trees covering chunk boundaries, modes, links, hard links, special files, permission failures and limits. Both produce the same digest on the installed release.

### Release verification fixes (speedup branch vorteo.691)

#### Fixes

- Re-read coordinator candidate bytes in full at dispatch after an owner decision. Proofs collected before the password check and approval re-verification no longer carry into launch, which keeps the hash-to-use window short.
- Update a shared tree scan's reuse state before its result settles, so no caller can join a rejection that is about to be discarded.
- Keep retained tree metadata in one compact form, roughly halving retained proof memory.

#### Validation

- A regression test shows dispatch performs a fresh byte scan after an owner decision, including inside an enclosing reuse operation. It fails when dispatch joins the earlier proof.

### Validation

- Integrated source passes the workspace typecheck, repository lint, server and CLI builds, 489 artifact, scan, Host, launch, renewal and runner cases, 905 of 907 continuation and question cases and the Open questions browser spec at three widths. The two failing cases also fail on vorteo.689.

## 0.11.0-beta.3.vorteo.692 - 2026-10-18

Integrates the restart continuation fixes (vorteo.690 below) with the Open questions card. The card branch numbered its entries vorteo.690 and vorteo.691 independently; neither was installed, so they are kept here verbatim under this version.

### Open questions card (card branch vorteo.690)

#### Features

- Add an Open questions card above Tasks. Agents ask blocking questions with a required recommended default, optional blocked tasks and an optional default time; the owner answers inline with Use recommended or typed text. Answers are saved once, journaled and delivered to the asking thread as a message.
- Show a calm count of open questions on workspace sidebar rows.

#### Validation

- Focused question model, daemon MCP and RPC, and app model tests pass, with a real-browser check at phone, tablet and desktop widths against a disposable daemon.

### Open questions fixes (card branch vorteo.691)

#### Fixes

- Deliver every saved open-question answer exactly once: answers are marked delivered only after their message is durably queued, and a thread queues any undelivered answer when it loads. Journaling is best effort after delivery.
- Accept answers only from the Vorteo app or a browser, record which client answered, and show it in answered rows.
- Require the recommended-default time to be at least 15 minutes ahead and let agents clear it. Omit withdrawn questions from snapshots and keep the newest 20 closed questions once delivered.

#### Validation

- Question model, reload delivery, daemon end-to-end and browser checks at three widths pass.

### Documentation

- Describe the manual lifecycle journal recovery for rolling back to vorteo.689 while an idle restart capture is held.

### Validation

- Integrated source passes the workspace typecheck, repository lint, server and CLI builds, 905 of 907 focused server cases, 228 client cases, 40 app cases and the Open questions browser spec at three widths. The two failing cases also fail on vorteo.689.

## 0.11.0-beta.3.vorteo.690 - 2026-10-18

### Fixes

- Keep restart continuation from freezing lifecycle work. Targets without durable continuation keep legacy restarts without recording intent, release falls back to the legacy drain, and only undispatched or running captures fence other work.
- Let a replacement daemon recapture and release a held cause from an earlier lifetime, so tasks continue after crashes and unverified restarts without replaying uncertain deliveries.
- Clear and retry failed captures. Idle-only restarts capture under a fresh cause per attempt and release it while waiting, so waiting never pauses goals or closes admission.
- Drop the queued continuation nudge when a capture is cancelled within its own daemon lifetime, unless the agent was asked to stop and save work.
- Clear per-attempt capture causes when holds are released and omit them from restart replies, keeping journals readable after a rollback to v689. Log when a daemon is treated as lacking continuation support.

### Validation

- Focused restart, manager, queue, session and coordinator server suites pass apart from two failures that also occur on v689.

## 0.11.0-beta.3.vorteo.689 - 2026-10-18

### Fixes

- Preserve running goal and no-goal tasks before tracked daemon restarts, including force restarts. Release their saved continuations only after verified replacement readiness or cancellation by the original daemon.
- Keep paused, stopped, exhausted and uncertain work fenced during recovery. Reject stale restart causes and retain unresolved capture intent across adapter changes.
- Give coordinator preparation POSTs one sixteen-minute connection, headers and body deadline using the standalone client’s built-in HTTP transport. Clean up on completion or failure without replaying uncertain requests.
- Reuse retained release proofs within coordinator plan verification when candidate and fallback share a runtime. Separate configuration checks and final custody assertions remain required.

### Validation

- Combined source passes all workspace typechecks, repository lint and 42 focused manager and transport cases. Startup-contract validation passes; tracked installation acceptance remains pending.

## 0.11.0-beta.3.vorteo.688 - 2026-10-18

### Fixes

- Show Force restart now on pending plain Host requests, with the existing interruption confirmation.

## 0.11.0-beta.3.vorteo.687 - 2026-10-18

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.686 - 2026-10-18

### Maintenance

- Integrate the served web tooltip dismissal fix with the prepared installation runtime source, retaining both complete parent release histories. This merge preserves existing interface behavior and does not activate maintenance.
- Restore three historical release entries and retain the later source annotations below instead of editing published history.
- Select Node timer types explicitly in three maintenance deadline functions so the combined app and server source typechecks with React Native declarations. Keep the existing deadlines, timer cleanup and event-loop behavior.

### Retained maintenance source notes

These annotations were previously appended to older entries. Their validation statements describe retained source evidence, not new validation or installed behavior in this merge.

- Add controller and recovery-launcher jobs to the existing lifecycle journal with exact standing approval, a visible cancellation interval and one reserved generation. Native execution consumes a durable intent; lost replies and reopened generations permit observation only.
- Expose owner-only maintenance status and exact cancellation in General controls, with public sidebar counts that omit private evidence. Distinguish recorded outcomes from current service health.
- Validate native evidence, source and artifact identity, approved revisions, shared lifecycle exclusion and observation chronology under the existing journal lock.
- Bound native callback waits and retries so an unavailable response cannot wedge queue reconciliation. Reconcile revocation before retry limits and retain uncertain execution without replay.
- Preserve plain restart timing when optional native verification is absent. Clear busy state and private maintenance data on expired owner access, allowing sign-in again.
- Focused queue, admission, owner HTTP, client, model and responsive browser checks pass. Persistent native startup, production execution, recovery and installed acceptance remain incomplete. This source checkpoint enables no native maintenance capability.
- Wire standing daemon decisions through the existing shared lifecycle journal, independently inspected native identity and protected source provenance. Recheck built candidates before hold and selection.
- Support a reserved initial migration against older drain APIs through a durable acknowledgment tied to the daemon lifetime. Lost acknowledgments remain fenced, and release invalidates the retained authority before its RPC.
- Project fresh native Host observations into installation health and expire unavailable observations. Refuse Dev identity until its persistent profile launcher is independently proven.
- Prepare later coordinator standing approvals and one-shot launch reservations with a synchronous custody recheck under the existing lifecycle lock.
- Retain the tested dual-slot launcher and startup-verification checkpoint without registering its unfinished runner role.
- Focused tests cover shared-lock admission, source custody, initial migration, cancellation, changed process lifetime and stale health. Packaged browser fixtures use the compiled native coordinator boundary. Persistent recovery, Dev profile registration and installed acceptance remain open; this checkpoint does not activate maintenance.

## 0.11.0-beta.3.vorteo.685 - 2026-10-17

### Maintenance

- Prepare separate immutable Dev predecessor, replacement, rollback and selected-coordinator configurations. Verify their exact deterministic projection under coordinator policy, retain approved Docker and Host Node bindings, and publish only the registration receipt. Historical attempts remain observation-only.
- Resolve selected successor configuration through approved coordinator history without rewriting the original admission anchor. Retain native, configuration and release custody after callbacks, carry absolute and monotonic collection bounds through nested reads, and preserve raw read ownership after timeout.
- Require independent registration readiness for ordinary Dev work, including manual restart approval, outbound dispatch, profile/settings synchronization and credential delivery. Credential withdrawal remains available. Configured source updates, Factory adoption and generic supervisor execution refuse before mutation because their transition proofs remain unavailable.
- Add configuration projection, publication-custody, successor-budget, readiness and HTTP approval regressions. Native launch and workload closure, Dev final root admission and settlement, combined activation and installed acceptance remain unfinished. Nothing is installed or enabled.

## 0.11.0-beta.3.vorteo.684 - 2026-10-17

### Maintenance

- Prepare initial Host construction from the approved selected coordinator, complete retained runtime and independently audited controller. Retain the original child and descriptor writer, bind its protected claim to an independent native observation, and queue release only through the existing constructor and admission. Bounded notices are hints; delivery and settlement remain unknown.
- Reopen recovery registration through owner enrollment controls before a coordinator request exists, including after revocation. Preserve the original generation and revision without new registration, provisioning or coordinator dispatch. Retain control files before reads and complete runtime custody through invocation and observation.
- Add real-journal launcher admission and replay cases, unseeded owner HTTP enrollment composition, preparation substitution regressions and large-executable file verification. Native effects remain synthetic in these tests; the fixed Host child, genuine workload closure, native acceptance and installed activation remain unfinished. No capability is enabled.

## 0.11.0-beta.3.vorteo.683 - 2026-10-17

### Maintenance

- Bind initial Host launch arrangements to the approved coordinator runtime and actual reserved generation. Mint local constructor and child handles only after exclusive intent or claim synchronization; burn construction before spawn and require the original active child span for effects. Historical records remain observation-only.
- Replace initial Host asynchronous command dispatch with separate durable interruption, retirement and bootstrap queue attempts under fresh locked admission. Keep original-incumbent scope distinct from the sealed fallback, retain native owner and proof callbacks, and require exact bootstrap evidence before modern candidate observation. Queueing proves neither delivery nor workload closure; production native owners remain unavailable.
- Share retained child, descriptor-gate and bounded-output mechanics with the Dev launcher while preserving its registration authority checks. Add a fixed read-only Host invoker for protected Dev root-exit observation, with approved runtime membership, exact Host-child exit, endpoint and container custody, bounded reads and retained local I/O ownership. It supplies no workload settlement or readiness proof.
- Require reviewed Docker executable bytes and size for new Dev registration preparation and fresh replacement or rollback. Preserve exact historical scripts for verification and route retained effects to observation without repinning. Native transport, final root admission, workload settlement and installed activation remain unfinished; no capability is enabled.

## 0.11.0-beta.3.vorteo.682 - 2026-10-17

### Maintenance

- Fence each Host continuation command with an exclusive durable queue-attempt record and fresh locked admission immediately before synchronous enqueue. Retain the original native owner, channel and command bindings across callbacks and share canonical record validation with observers. A queue attempt proves neither delivery nor workload settlement; native command factories remain unavailable.
- Bind candidate continuation to protected restoration evidence and a separately captured late predecessor, preserving the original reviewed plan. Consume the exact child before returning a local one-use publication continuation, retain separate command fences, and require exact child exit, bootstrap-attempt evidence and ordinary strict candidate readiness before completion. Route retained continuation observation before initial-generation lookup. Native launch election, closure, proof composition and installed acceptance remain unfinished.

## 0.11.0-beta.3.vorteo.681 - 2026-10-17

### Maintenance

- Compose fenced Host legacy restoration with the existing continuation ledger, addressed file publications and a separate bootstrap attempt. Retain immutable proof callbacks, recheck absence after final admission synchronization, and observe fresh legacy readiness without completing candidate activation. Native launch election, proof factories and production command wiring remain required.
- Add exact enrolled Host service-absence inspection without widening maintenance-label permissions. Bind both asynchronous and synchronous launchd reads to the enrolled account, domain and label; registration absence does not prove runtime or workload cleanup.
- Collect protected Dev registration witnesses and outcomes with a separate fixed read-only native program. Check same-boot root-executor exit before mutable outcomes and retain witness custody; new rollback attempts now record their root lifetime before effects. Privileged invocation, authenticated readiness and workload settlement remain unavailable.

## 0.11.0-beta.3.vorteo.680 - 2026-10-17

### Maintenance

- Construct read-only Dev registration executor proofs from the protected Host runtime, complete reviewed release, exact gated script and actual audited controller and child lifetimes. Retain callback identity, file custody, freshness and bounded synchronous native rechecks. No production caller, root dispatch or settlement authority is supplied.
- Recheck the exact active consumed Host continuation claim inside shared lifecycle admission before and after a synchronous addressed action. Refuse reserved, observed, superseded or changed child bindings and expire the retained assertion when admission returns. Publication and bootstrap still require the existing native owner's independent one-use fences; uncertain synchronization never permits replay.

## 0.11.0-beta.3.vorteo.679 - 2026-10-17

### Maintenance

- Track one Host restoration and at most one linked candidate generation inside the existing enrollment ledger. Preserve the original failed dispatch, fence historical completion from restoration reservation, and keep legacy restoration incomplete until the fresh candidate independently succeeds. Shared lifecycle and activation-child admission retain unresolved lineage exclusion.
- Add a retained Dev registration child launcher with a reviewed pre-body descriptor gate, minimal environment, independent Host runtime and child-proof dependencies, bounded diagnostics and one local release attempt. Include the gate in whole-script hashes before enrollment; queued delivery, native root admission and workload settlement remain unverified. Add a synchronous audited-process read using the existing verified native inspector for later lock-held child custody. Production callers and native factories remain unfinished, and no capability is enabled.
- Keep reviewed Host schemas, plan validation and canonical publication records in a data-only module. Separate the gated native launcher from the legacy supervisor utility so app typechecking does not import native execution code.

## 0.11.0-beta.3.vorteo.678 - 2026-10-17

### Maintenance

- Collect initial Host publication state after exact child exit, retaining protected control files, missing addressed records, launcher bytes and the selector's lifetime, literal text and canonical target. Incomplete images remain unresolved without runtime or readiness collection; complete candidates still require strict independent verification.
- Retain one raw Host observation read across timeouts, including anchor construction and candidate collection. Refuse another scan before constructing tools until the original read settles, discard late results and retain caller cancellation in successful proofs. This adds read-only recovery inspection; fallback effects and installed acceptance remain unfinished.

## 0.11.0-beta.3.vorteo.677 - 2026-10-17

### Maintenance

- Separate fixed Dev registration artifacts from later enrollment authority, removing the script/manifest digest cycle. Reserve the controller before one gated launch and consume the exact child claim before release; observing a child after a lost acknowledgment cannot create consumption authority.
- Guard both lifecycle snapshots in ordinary restart writers and maintenance-service claims. Unsettled registration retains exclusion even on failed or succeeded parents; only independently verified terminal settlement releases the fence. Keep the private effect record out of legacy and owner restart replies.
- Retain immutable observation, readiness and child-claim data across synchronous custody callbacks before persistence, publication and gate release. The execution path still requires trusted injected ports; native child launch, final root admission, workload settlement and installed registration remain unavailable.

## 0.11.0-beta.3.vorteo.676 - 2026-10-17

### Maintenance

- Connect initial Host observation to the selected coordinator's existing drain. Retain drain ownership through slow callbacks, keep discovery behind activation, and observe claimed generations after revocation without constructing an effect executor. Missing claims remain unresolved; missing production interruption and child-launch custody leave pending work untouched.
- Check the exact protected Host plan, interruption limits and lifecycle competitors before reservation. Share canonical publication records between the publisher, candidate observer and partial-publication classifier, preserving existing bytes and one-use attempt fences.
- Add pure classification of addressed initial Host publication states, retaining captured control-file bytes and rejecting duplicate JSON keys, unrelated paths and substituted selector text. Classification grants no restoration authority. Production effects, fallback continuation and installed acceptance remain unfinished.

## 0.11.0-beta.3.vorteo.675 - 2026-10-17

### Maintenance

- Bound initial Host retirement verification to one thirty-second read-only collection after a consumed bootout. Require both exact process lifetimes to exit and the service to be absent before publication; timeout retains uncertainty and revocation blocks the next effect. A failed disposable native attempt is preserved separately from passing source checks.
- Admit exact reserved supervisor replacements through the existing activation-child validator and shared lifecycle journal, preserving daemon source-update behavior. Bind the reviewed supervisor script, immutable request plan, enrolled candidate and standing decision through queue progress.
- Integrate the disabled supervisor worker-launch adapter and authenticated read-only cause lookup. Retain one request across lost replies, distinguish transport and worker identity, require native settlement before a successor, and preserve borrowed lifetime descriptors. Lookup cannot submit or dispatch and remains available for retained observation while startup is fenced. Production launch, native attachment, root custody and descriptor transfer remain unavailable.
- Prepare Dev rollback for a newly recorded registration attempt whose candidate service is stopped. Require exact original-job and publication records, repeated native absence checks and pointer identity before restoring the declared original pointer. Existing attempts without these records refuse; production effect admission, late claim binding, descendant settlement and restored readiness remain unfinished.

## 0.11.0-beta.3.vorteo.674 - 2026-10-17

### Maintenance

- Separate prepared Host runtime verification from the live incumbent launcher precondition. Initial effects still retain and verify the original launcher before and after preparation; observation verifies the pinned immutable fallback launcher and original semantics after publication.
- Add read-only candidate collection using exact claim-bound publication attempts, phase receipt, live candidate plist and selector, complete prepared runtime custody, strict native daemon inspection and fresh mount bindings. Retain bounded synchronous service, loaded-environment and process-lifetime checks through the final observation. Add substitution coverage for every publication record and another claim. The collector must remain behind executor-exit verification; native transition, active-provider custody, fallback continuation and installed delivery remain unfinished.

- Integrate reviewed Dev registration source: optional protected receipt reference, strict startup/file/selector and account bindings, exact registration preparation preserving Factory behavior, guarded receipt/config publication, and streamed Node verification. Preserve existing selector, release root, account and home. No production registration caller, root worker-launch capability or native execution is enabled; lifecycle admission, retirement and rollback acceptance remain open.

- Integrate worker-launch requester and shared-journal admission preparation using optional hints, exact protected profile and cause binding, locked one-use consumption, causal deduplication and observation-only reopening. Legacy replies omit the new fields and legacy digests stay unchanged. Production advertises unavailable; protected Linux execution and active-provider interruption remain unimplemented.

## 0.11.0-beta.3.vorteo.673 - 2026-10-17

### Maintenance

- Compose the claimed initial Host transition with exact retirement custody, verified native absence, fenced launcher and selector publication, and candidate readiness. Recheck absence immediately before bootstrap and bind the written readiness receipt to an immutable observation snapshot.
- Add independent observation after executor exit, including lost bootstrap replies, grant revocation and repeated reopening without service replay. Preserve exact result bytes and retry their synchronization. Focused tests use injected native ports; production proof construction, interruption custody, fallback continuation and installed transition acceptance remain unfinished.

## 0.11.0-beta.3.vorteo.672 - 2026-10-17

### Maintenance

- Bind an initial Host migration's durable intent to one exclusive native child claim under current enrollment and shared lifecycle exclusion. Retain uncertain claim writes as replay fences.
- Connect that claim to launcher-first, selector-second publication through the existing file publisher. Both attempts bind the same claim; synchronous native and prepared-file custody, exact final selector lifetime, launcher bytes and addressed artifacts must remain valid. Preserve partial publication for independent reconciliation rather than replay. This prepares the file phase, not native service transition or installed activation.

## 0.11.0-beta.3.vorteo.671 - 2026-10-17

### Maintenance

- Bind initial Host migration to the configured managed release root, an exact candidate-only launcher environment change and an immutable copy of the original fallback launcher. Preserve all other launcher settings and reject releases outside their declared root.
- Support a protected Host release selector outside the release directory while retaining canonical root, parent and selector custody. Add focused substitution and launcher-binding coverage plus compiled supervisor selection checks. These changes prepare migration; no installed service or standing authority changes.

## 0.11.0-beta.3.vorteo.670 - 2026-10-17

### Maintenance

- Add fenced symlink publication to the existing maintenance file publisher for the Host release selector. Persist the addressed attempt before atomic selection, retain exact previous target, directory and staged-link custody, and reject replaced attempt files before publication.
- Preserve substituted files during cleanup and retain the selected target after uncertain directory synchronization. Focused filesystem cases cover replay, substitution, path and custody failures. This supplies a file-selection primitive, not lifecycle authority or installed Host migration.

## 0.11.0-beta.3.vorteo.669 - 2026-10-17

### Maintenance

- Persist an initial Host migration intent for the exact existing activation reservation under shared lifecycle exclusion. Bind current enrollment, reviewed plan, native precondition, artifact custody and fresh observation before creating a private exclusive file and synchronizing it and its directory.
- Refuse conflicting lifecycle work, stale or substituted proofs, revoked authority, duplicate intent creation and symlink substitution. An uncertain synchronization retains the intent as a replay fence. This slice writes no service commands and does not establish migration execution, complete startup compatibility or final activation readiness.

## 0.11.0-beta.3.vorteo.668 - 2026-10-17

### Maintenance

- Generate a bounded data-only initial Host module contract after compiled server and CLI builds. Trace supervisor, daemon and forked worker modules without filesystem-glob expansion or warning exclusions; retain package-resolution metadata and workspace links. Unknown warnings and changes to audited optional-load implementations refuse generation.
- Replace the initial migration's hand-picked module comparisons with exact trusted-build contract matching and retained reference/candidate custody. Record lookup absences and package-scope metadata, reject nearer-package shadows and optional dependencies becoming present, and retain those predicates through final custody. Add real-filesystem regressions for module, metadata, link and declaration substitution and cancellation. This proves module-file compatibility only; filesystem assets, external configuration, runtime readiness, native effect admission and installed migration remain separate unfinished gates.

## 0.11.0-beta.3.vorteo.667 - 2026-10-17

### Maintenance

- Bind initial Host migration plans to an addressed sealed-copy provenance document. Verify the legacy source, critical incumbent hashes, complete destination file/link inventory, both sides' bytes and retained source, manifest and runtime custody. Candidate startup-contract checks remain separate from legacy fallback restoration.
- Add focused plan and real-filesystem copy regressions for changed, missing, duplicate and escaping inventory, source substitutions, internal links, retained custody and cancellation. Source-copy hard links require every physical name inside the protected inventory; ordinary external dependencies remain single-link. A compiled read-only check verifies the actual sealed legacy copy. This proves copy integrity only; dependency completeness, compatible execution, tracked migration and installed acceptance remain open. Legacy restoration must keep activation in recovery required.

## 0.11.0-beta.3.vorteo.666 - 2026-10-17

### Maintenance

- Connect initial Host migration plans to complete candidate/fallback release custody and a pinned compiled launch contract. Compare the helpers actually imported by supervisor scripts separately from worker-side copies, including argument preservation, selectors, locks and private-file persistence. Preserve exact persistent launcher bytes before runtime inspection.
- Add two plan regressions and a disposable compiled artifact check covering coherently repinned helper/worker substitutions, changed fallback launcher, mount overlap, cancellation and retained custody. These checks establish artifact integrity and the compared contract only. Complete startup compatibility, runnable fallback, fresh native admission, single-use intent and installed migration remain open.

## 0.11.0-beta.3.vorteo.665 - 2026-10-17

### Maintenance

- Retain complete release proofs across source-receipt verification, external runtime dependencies and the full artifact tree. Capture declarations and limits before collection, reject changes during final synchronous custody and preserve the original caller cancellation after successful collection.
- Preserve the existing verification API while making its custody proof available to initial migration preparation. Seventeen owning cases cover dependency, receipt, directory, declaration, cancellation and final-deadline changes. Compatibility, fresh native admission and installed migration remain unfinished.

## 0.11.0-beta.3.vorteo.664 - 2026-10-17

### Maintenance

- Expose retained custody for complete verified runtime artifacts, preserving the existing artifact digest. Final synchronous assertions reject changed dependencies, directory entries and canonical roots while retaining the original caller cancellation signal.
- End the collection deadline after successful verification without extending admission freshness. Fourteen artifact cases cover scanner behavior, later substitutions and cancellation-option replacement. This supplies an internal prerequisite for initial Host migration; compatibility checks, locked intent and installed delivery remain unfinished.

## 0.11.0-beta.3.vorteo.663 - 2026-10-17

### Maintenance

- Define the exact initial Host supervisor migration plan, including its service-custody precondition, stable identity, candidate, distinct compatible fallback and interruption limits. Both releases preserve the pinned Node and installation configuration and name the canonical supervisor entry.
- Bind that plan to the active enrollment, exact reserved step and generation, reviewed release digests and completed dependencies. Revocation, pause, disabled Host scope, competing reservations and terminal steps refuse. This read-only scope validator does not verify runtime artifacts, consume intent or authorize service effects.

## 0.11.0-beta.3.vorteo.662 - 2026-10-17

### Maintenance

- Add a distinct initial Host supervisor migration precondition inspector. It pins protected configuration and observed launch files, exact registered environment, actual supervisor lifetime and overwritten argument digest, authenticated worker instance and parent relationship, and selected source. It returns a digest and bounded synchronous custody proof without ordinary standing evidence, reservations or effects.
- Keep an unsupported legacy worker-instance field explicitly null, bound to authenticated capability evidence and an independently verified kernel lifetime. Advertised inspection failures remain refusals.
- Recheck protected files, proof identity and freshness after native custody commands. Owning regressions preserve the ordinary strict supervisor check and reject file, registration, process and expiry changes. Incumbent evidence establishes service custody and observed files, not running-runtime provenance. Candidate/fallback integrity, activation binding and installed migration remain unfinished.

## 0.11.0-beta.3.vorteo.661 - 2026-10-17

### Fixed

- Preserve native launch arguments for managed supervisors and the existing installation-client and bootstrap profiles. Changing a process title erases the executable and entrypoint evidence used by maintenance inspection. Unmanaged supervisors retain their existing display title, and these markers grant no authority.
- Exercise the compiled supervisor through worker replacement and three installation profiles, checking the actual OS parent command and stable supervisor PID. Canonicalize the temporary selector root and keep the Linux-only installer collector on Linux while retaining native argument checks on macOS.
- Preserve the original title failures and fixture failures as evidence. Source and disposable process validation do not establish installed Host or Dev registration, provisioning, or final activation readiness.

## 0.11.0-beta.3.vorteo.660 - 2026-10-17

### Fixed

- Match an initial supervisor maintenance request to its enrolled supervisor step while retaining the existing container-daemon queue target. Use the same effective target for enrollment identity, operation and exact reserved activation-step checks.
- Extend the initial migration regression to cover supervisor admission and reject daemon-step or daemon-identity substitution. Native supervisor evidence and persistent Dev registration remain unavailable until independently verified; this correction does not enable either.
- The preceding compiled package passed fresh-process queue observation of a revoked running rollback without effect construction or execution. Its disposable cleanup passed; installed coordinator restart, reboot, private HTTPS and remote owner acceptance remain open.

## 0.11.0-beta.3.vorteo.659 - 2026-10-17

### Fixed

- Construct retained maintenance observation from the protected installation configuration, enrolled coordinator identity and native admission anchor. A fresh consumer can obtain inspection tools without resolving an unresolved selected maintenance executor. Recollect mount evidence for every observation and retain anchor custody through the final locked write, including after revocation.
- Keep observation tools separate from effect discovery and cached executors. Fresh inspection and execution retain canonical role resolution and reserved proof checks; construction and native read exclusion survive caller timeouts. Production remains replacement-only.
- Disposable native evidence from the preceding source completed four single-execution queue requests through controller recovery, page replacement, linked page recovery and rollback using actual persisted absence receipts. Cold-process native acceptance and installed activation remain open; no README delivered-feature claim is added.

## 0.11.0-beta.3.vorteo.658 - 2026-10-17

### Maintenance

- Retain an exclusive private diagnostic for the initial recovery-page registration child. Derive its name from validated enrollment identifiers and a fresh nonce. Registration still launches only once per durable reservation; read-only reopening creates no automatic diagnostic stream.
- Preserve controlled recovery conflict messages in private runner stderr and keep unknown errors generic. Real subprocess cases verify both outputs without creating enrollment state. Launch, custody, approval and uncertainty behavior are unchanged.
- Preserve two unsuccessful linked-launcher fixtures and their cleanup evidence. Neither proves the original refusal's cause or installed readiness; linked native acceptance remains open.

## 0.11.0-beta.3.vorteo.657 - 2026-10-17

### Maintenance

- Add explicit opt-in routing for linked recovery-launcher recovery and rollback through the verified controller. Require the existing linked-recovery mode and exact predecessor link, preserve reserved executor-role checks, and keep production disabled.
- Test controller-only routing, disabled refusal, missing-link refusal and wrong reserved executor rejection for both operations. Native consumed-replacement absence passed separately; compiled linked launcher dispatch and installed activation remain open.

## 0.11.0-beta.3.vorteo.656 - 2026-10-17

### Fixed

- Collect independently verified native absence for an exact consumed maintenance generation, including replacement and linked recovery. Verify executor exit before counter-role discovery or runtime hashing, preserve full history and partial file receipts, and retain synchronous absence, inventory and identity custody.
- Address the unknown observation to its retained reservation with null observed source and artifact. Keep the generation running and its consumed intent unchanged; a successor still requires fresh linked admission. A live service continues through strong readiness verification, and inspection errors never count as absence.
- Exercise original and linked consumed absence in the owning fixture, including live-executor, reappearing-service and changed-history refusal. Correct older controller-readiness fixtures to name the controller role. This is source validation, not installed recovery or final activation readiness.

## 0.11.0-beta.3.vorteo.655 - 2026-10-17

### Maintenance

- Add an explicit construction opt-in for controller-driven recovery-launcher replacement, retaining exact reserved executor binding and replacement linkage checks. Production leaves it unset. Launcher recovery and rollback remain refused, and operation advertisement is unchanged.
- Test disabled refusal and enabled controller inspection without native effects. This prepares compiled launcher replacement acceptance; it does not enable installed maintenance or establish final activation readiness.

## 0.11.0-beta.3.vorteo.654 - 2026-10-17

### Fixed

- Verify recovery-launcher readiness through its selected native process, exact loopback socket and reviewed page assets. Keep controller descriptor readiness unchanged. Package data-only asset lengths and hashes from the actual compiled page, retain protected metadata custody before reads, and compare response bytes without executing target modules in the observer.
- Combine caller cancellation with bounded native HTTP probes and retain the existing five-second listener freshness. Legacy pages without metadata require an exact match to the observer's known asset module. Registration and bookmark inspection use selected asset proof too.
- The preceding disposable compiled queue recovered one consumed controller generation after timeout and revocation without replay. Launcher replacement, Dev and installed activation acceptance remain open; no recovery capability or installation is enabled by this source change.

## 0.11.0-beta.3.vorteo.653 - 2026-10-17

### Maintenance

- Record fixed private recovery phases around consumed intent, slot publication, executor verification, native bootstrap and candidate observation. These diagnostics locate uncertain native waits without changing admission, deadlines, replay fencing or outcomes.
- The preceding compiled queue fixture consumed intent and preserved one generation through revocation and five observations, but did not establish readiness. Its native timeout and complete fixture cleanup remain retained evidence. Full queue and installed acceptance remain open.

## 0.11.0-beta.3.vorteo.652 - 2026-10-17

### Fixed

- Preserve selected maintenance startup across queue check bookkeeping without ignoring authority, evidence, intent, status or resolution. Recovery startup retains its exact ancestor proof through final native verification; successful collection clears its deadline.
- Revalidate fresh enrollment and retained selection synchronously after asynchronous reads and again in final custody. Existing retained-selection validators permit revocation for observation while refusing changed grant identity or manifest. Effect admission remains separate and lock-held.
- Retain setup, selection, plan and initial intent custody before reading. Keep the public startup result data-only, and assert both internal proofs after the last native await. Add real-file interleavings for bookkeeping, revocation, selection, intent, manifest and ancestor changes.
- Report controlled controller startup refusals in its private diagnostic while keeping unknown errors generic. The prior full-queue native attempt consumed intent but did not establish candidate readiness; exact scoped cleanup and final native inventory passed. Nothing is installed, and full queue acceptance remains open.

## 0.11.0-beta.3.vorteo.651 - 2026-10-17

### Fixed

- Preserve native claim and recovery custody across queue status-check bookkeeping. Only the exact current request's revision, detail and reconciliation may change; authority, reservation, evidence, intent, status, resolution, ancestors and other records remain exact.
- Readdress fresh evidence to the current revision inside the existing lifecycle transaction, without changing its timestamp or native proof. Admission and intent use the same digest, and the claim preserves the latest bookkeeping. Current grant, global exclusion, freshness and native custody remain required.
- Retain strict claim behavior for existing callers. Native invocation and postclaim checks preserve the same narrow bookkeeping boundary. Full queue/native acceptance and installed delivery remain open; the preceding fixture refused before intent and was cleaned up without replay.

## 0.11.0-beta.3.vorteo.650 - 2026-10-17

### Changed

- Route maintenance service tools through one adapter behind the existing queue. Replacement uses the controller; explicitly enabled linked controller recovery uses the registered recovery page. Reserved work keeps its addressed executor, and launcher-target effects remain refused pending readiness acceptance.
- Keep one constructor across roles and retain native inspection, observation and dispatch ownership until the underlying call settles, including after caller timeout. Late results cannot become admission evidence or permit overlapping adapter construction and effects.
- Preserve consumed legacy observation through cached tools without construction or new authority. Production discovery remains replacement-only. Forty producer and routing cases pass; full queue/native composition, Dev registration and installed activation remain open. Nothing is installed.

## 0.11.0-beta.3.vorteo.649 - 2026-10-17

### Fixed

- Defer external unclaimed recovery inspection while a protected generation diagnostic records a child whose PID has not been proved absent. Check the exact current reservation before and after this refusal gate, before opening shared runtime artifacts.
- Treat malformed, duplicate or unsafe diagnostic records as uncertainty. Missing records and verified PID absence grant no authority; full retained contract, native absence and locked terminal fencing remain required. Consumed observation retains its exact executor-lifetime check.
- Thirty producer cases pass, including recorded live or reused PIDs, inconclusive native checks, exited and missing diagnostics, invalid records and symlinks. The native fixture passed unclaimed fencing and delayed-child refusal but its fresh successor refused before intent; full native recovery remains unaccepted. The missing-entry window and other-reader interference remain open. Nothing is installed.

## 0.11.0-beta.3.vorteo.648 - 2026-10-17

### Fixed

- Reconcile an unclaimed service recovery only after fresh native absence and verification of its reserved runner's claim-before-effects contract. Persist failed status and addressed absence atomically; a winning claim refuses that write, while a winning terminal write refuses a late claim.
- Preserve consumed executor exit checks through mixed consumed and unclaimed recovery ancestry. New linked generations still require current authority and fresh native custody; ordinary unknown outcomes remain running and consumed legacy observation retains its requirements.
- Keep native-only reconciliation markers out of stored observations. Verify protected executor setup, plan, runtime and claim dependencies, retain custody before authoritative reads, and clear successful collection deadlines.
- Cover journal races, reopening after revocation, changed retained runner bytes and continued legacy observation. Compiled native acceptance of unclaimed fencing, full queue composition, Dev registration and installed activation remain open. Nothing is installed by this source change.

## 0.11.0-beta.3.vorteo.647 - 2026-10-16

- Verify the enrolled coordinator's selected release, registered native lifetime and retained installer/transfer proofs before exempting it from recovery runtime absence checks. Keep the two-executor limit and refuse unrelated readers.
- Recheck coordinator custody under existing lifecycle exclusion without nesting enrollment locks. Unrelated selected Node files need no live coordinator witness; revocation preserves read-only custody checks.
- Seven witness cases, twenty-nine producer/inventory cases and eleven recovery cases pass. Actual shared-runtime native recovery and installed acceptance remain open; no recovery capability or service is enabled.

## 0.11.0-beta.3.vorteo.646 - 2026-10-16

### Fixed

- Refuse fresh external maintenance-role discovery while its exactly selected recovery generation remains running. The gate follows full wrapper, selection and history validation, suppressing new health and producer artifact reads until reconciliation finishes. Candidate startup and the executing child's readiness keep their direct verified paths.
- Allow an explicitly reviewed Standard scheduling policy only for controller slots using the canonical runner. Interactive remains limited to standalone owner pages, omitted policy retains Background, and previous launcher bytes remain unchanged. This enables a scheduling experiment after three-minute background startup failed to establish readiness; it is not a claimed throttle fix.
- Cover controller scheduling digests, retained bytes, KeepAlive and invalid roles, plus running-recovery discovery refusal alongside direct startup success and resolved recovery/rollback discovery. This is not global reader exclusion: earlier readers, other shared-runtime readers and failed-but-live executors remain separate acceptance work. No installed service or capability changes.

## 0.11.0-beta.3.vorteo.645 - 2026-10-16

### Fixed

- Continue read-only reconciliation for a running native service reservation after its three-check counter saturates. Each callback keeps its deadline and retained generation; subsequent checks honor the persisted forty-five-second backoff without executing again. Pending and approved inspection retain the three-check limit.
- Show sustained uncertainty as continuing status checks, preserving approval, reservation and intent. A whole-queue regression times out execution, refuses repeated observations, reopens after grant revocation, respects backoff and settles the same generation when readiness appears. One execution is retained throughout; no installed service or capability changes.

## 0.11.0-beta.3.vorteo.644 - 2026-10-16

### Maintenance

- Load the daemon client only when native renewal actually needs a Host process lookup. Persistent controller imports no longer pull the client and its large generated WebSocket validator through renewal. Connection authentication, status lookup and close behavior are unchanged.
- Preserve native startup failure evidence separately: controller selection and launch succeeded in disposable recovery, but readiness was not established. Cold import tracing proves the eager dependency, not the cause of the native readiness failure. Full native recovery and installed activation remain open; no service or capability changes.

## 0.11.0-beta.3.vorteo.643 - 2026-10-16

### Fixed

- Defer external recovery observation artifact reads until the consumed intent's exact executor lifetime is proven exited. An observer hashing the target executable could otherwise interfere with the running child's native absence inventory. Live or unproven executors refuse observation without reading readiness or changing history.
- Keep the executing child's post-bootstrap readiness collection under its existing retained claim, native custody and final readiness verifier. It does not use the external exit-first path or acquire permission to skip an exit check.
- Reproduce artifact inspection before exit proof and cover same-generation readiness after exit and revocation. Eleven focused recovery cases pass with native ports simulated. Concurrent health/discovery artifact readers, full compiled linked recovery and installed activation remain open; no installed service or capability changes.

## 0.11.0-beta.3.vorteo.642 - 2026-10-16

### Fixed

- Stop internal collection timers after successful native maintenance inspection. Completed proofs retain their custody checks and existing admission freshness; failure, timeout and synchronous budget overruns still abort. Parent inspection, child inspection and recovery absence collection share this behavior without extending execution deadlines.
- Resolve controllers selected by a completed recovery or rollback through their exact recovery wrapper digest and retained slot. Startup still verifies consumed intent, all ancestors and the ready resolution leaf, and discovery rejects a changed selection. Ordinary dispatch remains replacement-only by default.
- Add successful-proof lifetime, hanging collection, custody change and monotonic-overrun regressions, plus resolved controller recovery/rollback discovery with missing and forged history refusal. Full compiled linked recovery, Dev registration and installed activation remain open. No installed service or capability changes.

## 0.11.0-beta.3.vorteo.641 - 2026-10-16

### Maintenance

- Retain private per-generation stderr for native service launches. Exclusive creation refuses an existing file or symlink, records the guarded launch attempt and leaves the detached child running after a parent timeout. Diagnostics grant no authority and do not change the effect journal, deadline or replay rules.
- Record recovery child entry and verified invocation/evidence stages. Recovery-entry failures retain controlled policy messages or an error class, avoiding parser source bytes. Public failure responses remain generic; private diagnostics are not returned through owner or agent endpoints.
- Add actual subprocess checks for private file permissions, refusal preservation, duplicate launch refusal, symlink safety and continued child observation after a descriptor-close failure. Full compiled recovery dispatch remains unaccepted after a retained timeout before effect intent; no installed service, capability or README availability claim changes.

## 0.11.0-beta.3.vorteo.640 - 2026-10-16

### Fixed

- Accept separately addressed native approval and reservation evidence. Each queue transition inspects a different current revision, so requiring identical evidence digests rejected valid replacement, recovery and rollback reservations.
- Validate both retained dispatch proofs independently for unique address, digest, request, plan, identity and reviewed candidate. Approval proof remains bound to its reviewed revision; reservation proof can follow later bookkeeping. Preserve grant, manifest, proposal, approved revision, cancellation interval and reserved executor checks. Legacy consumed observation gains no new dispatch requirement.
- Reproduce the refusal with real queue transitions and a file journal, then cover separate recovery and rollback proofs, missing or altered evidence, duplicate receipts, changed executor refusal and legacy observation. Native-port fixtures now retain distinct inspection records instead of fabricating one shared digest. Full compiled recovery dispatch and installed activation remain open; no service or capability changes.

## 0.11.0-beta.3.vorteo.639 - 2026-10-16

### Maintenance

- Let the existing native service producer resolve an explicitly configured recovery-launcher role. Its default remains controller-bound and replacement-only. A selected page must declare exact service execution, match protected enrollment and runtime custody, and contain the same compiled page and child runner before inspection or launch.
- Restrict new effects through the recovery-page producer to exact linked controller recovery or rollback. Retained observation stays separate from new-effect eligibility and active grants. Parent and child continue binding the reserved executor, and the existing total invocation deadline, one launch and durable child intent remain unchanged.
- Add a file-journal producer regression for listener-only refusal before native setup, and retain thirteen existing producer and subprocess checks. Full compiled page-producer dispatch, queue composition and final activation remain open; no installed service, capability or route changes. README recovery delivery remains pending.

## 0.11.0-beta.3.vorteo.638 - 2026-10-16

### Maintenance

- Add an explicit reviewed recovery-page service-executor contract. A selected standalone page can supply native executor proof only when its pinned setup declares version one and the fully digested runtime metadata supports it. Older listener-only setups remain refused. Final custody includes the runtime metadata as well as native process, launcher, selector and pinned files.
- Route the standalone entry point's exact service-generation arguments to the existing native child. Listener startup keeps its separate path without loading lifecycle history; execution still requires the child's exact retained reservation, runtime and process identity, fresh evidence and shared-lock effect admission. Page supervision does not retry service work.
- Add protected-filesystem and HTTP checks for supported and unsupported contracts, default controller-role refusal, metadata mutation, missing execution custody and listener availability with broken journals. Native process ports are simulated. Producer role discovery and compiled complete recovery dispatch remain unfinished, recovery is unadvertised, and nothing is installed. README recovery delivery remains open.

## 0.11.0-beta.3.vorteo.637 - 2026-10-16

### Fixed

- Reconcile exact retained enrollment consent through a no-change update under the existing lifecycle lock before acknowledging success. A previous rename with failed directory synchronization cannot produce an idempotent success until journal synchronization succeeds. Return current revocation and activation progress without replacing consent or repeating authentication.
- Add a real file-journal regression that fails directory synchronization after publication, refuses the retry, then succeeds with byte-identical enrollment after synchronization recovers. Thirteen focused consent and provisioning cases cover the change; native proposal inspection remains an explicit fixture port. This is source only, not a complete final consent gate or installed activation; README recovery delivery remains open.

## 0.11.0-beta.3.vorteo.636 - 2026-10-16

### Maintenance

- Add a distinct owner-authenticated HTTP operation that saves only the exact enrollment consent. Unsupported controls refuse the operation instead of treating it as immediate enrollment. Retained review identifiers and manifest digest remain required; foreign origins, invalid owner authentication and changed decisions are refused.
- Serialize consent storage with the existing enrollment and provisioning control. The one-operation controller rereads its protected exact review before recording consent and returns an explicit acknowledgment that activation has not started. Existing enrollment response bytes and effectful enrollment behavior remain unchanged.
- Add real HTTP authentication, duplicate-submit, cross-operation exclusion, unsupported-control and private-error checks. These tests do not establish the complete native save-consent composition, readiness-gated continuation, a frozen final manifest or a usable owner approval page. Nothing is installed; README recovery availability remains pending delivery.

## 0.11.0-beta.3.vorteo.635 - 2026-10-16

### Maintenance

- Separate exact owner-authenticated enrollment persistence from provisioning. The consent operation verifies the pinned review, native context and owner configuration, then records the unchanged manifest with pending initial steps. It does not prepare admission files, lifecycle requests or service effects. Reopening preserves the original consent, progress and revocation.
- Keep the existing combined enrollment action effectful: it calls the consent operation and then its existing grant-checked provisioning path. No current button becomes a save-only action implicitly.
- Add consent-only real file-journal and bcrypt checks for invalid authentication, context changes, changed manifests, lost responses and retained revocation. Native proposal observation is an explicit fixture port. These checks do not establish a remote save-consent control, readiness-gated continuation, a complete final manifest or installed activation. README recovery availability remains pending tracked delivery.

## 0.11.0-beta.3.vorteo.634 - 2026-10-16

### Maintenance

- Use one target-evidence inspector in the selected native producer and one-generation child. Replacement verifies the running target; recovery and rollback require protected retained history, independent absence and the selected executor's current-boot witness. Aborted inspection cannot return admission evidence.
- Make the producer consume the child's exact request, approved revision, generation and plan binding before launch, including recovery wrappers. Preserve the refreshed selected executor check, total execution deadline, locked intent admission and observation-only handling after uncertain replies.
- Keep operation advertisement replacement-only and recovery listeners outside generic executor authority. Focused filesystem/native-port and producer subprocess checks validate source composition; explicit launcher-role integration, compiled combined recovery, Dev custody, installed delivery and remote acceptance remain open. No service, route, credentials or approval changes. README recovery availability remains pending delivery.

## 0.11.0-beta.3.vorteo.633 - 2026-10-16

### Maintenance

- Let an unconsumed replacement reservation observe only its independently verified previous slot, with evidence collected after reservation. Reconciliation uses the existing exact journal transaction and shared native admission, including after grant revocation. It never dispatches or treats the candidate as successful without an intent.
- Add real file-journal races: previous readiness can terminalize the unclaimed replacement and block a late child claim; a child claim that wins first prevents terminalization and retains its intent. Candidate evidence without an intent is refused. Native process ports are simulated and no service command is issued in these cases.
- Preserve consumed-intent observation and previous-executor exit requirements. Absent or unready targets, first installation without a previous slot and unclaimed recovery wrappers still need their exact reconciliation paths. This is source only; final combined activation and installed acceptance remain open. README recovery availability is unchanged.

## 0.11.0-beta.3.vorteo.632 - 2026-10-16

### Maintenance

- Route an exact reserved recovery or rollback generation through the existing native service child. Load its protected recovery plan, verify original artifacts and child custody, inspect target absence and retained history, then use the existing shared admission and exclusive effect claim. Replacement keeps its controller-only execution role.
- Validate the approved revision independently of the later journal revision and reject a consumed generation before another child effect. Twenty focused filesystem and native-port cases pass, with workspace types, lint and server/CLI compilation. Process ports are simulated; this does not establish compiled recovery dispatch or installed acceptance.
- Keep recovery dispatch unadvertised until selected executor roles, preclaim reconciliation and compiled acceptance are complete. No installed service, selection, route, credentials or owner decision changes. The final combined activation and primary README recovery feature remain pending.

## 0.11.0-beta.3.vorteo.631 - 2026-10-16

### Maintenance

- Refuse readiness returned after its existing thirty-second observation budget even when synchronous native validation delays timer delivery. Compare the monotonic clock after the awaited result, abort the observation signal on refusal and preserve the consumed operation without replay.
- Add a regression that models native validation exhausting the budget before the timer runs. It must reject the late result, abort its signal, leave the lifecycle journal unchanged and issue no additional native command. This is deadline logic with simulated native ports, not active-provider cleanup or installed acceptance.
- No service, route, selection, credentials or standing authority changes. Permanent recovery delivery and the primary README feature remain open.

## 0.11.0-beta.3.vorteo.630 - 2026-10-16

### Maintenance

- Add observation-only reopening for consumed native recovery and rollback generations. The existing producer routes retained recovery observations through exact generation, selected slot, protected artifact and native lifetime checks without granting new dispatch support or requiring an active grant. A total thirty-second observation bound discards late results; final custody checks reject changed journals and files.
- Preserve an independently verified selected process with readiness false as an unready observation. Successful execution still requires readiness. A rollback job identifies its restored slot as that new job's candidate, without rewriting the failed predecessor as successful.
- Hash the verified reviewed launcher shape for native registration evidence. The actual HTTP readiness regression exposed a mismatch caused by plist dictionary key order; exact decoded equality and launcher byte digests remain required. Retained evidence is never rewritten.
- Focused filesystem and actual HTTP cases cover lost start replies, revocation, recovery and rollback slots, unready observation, refusal of unready execution, journal changes and timeout. Native process ports are simulated. Compiled native recovery dispatch, installed delivery, permanent private HTTPS and remote owner acceptance remain open; the README recovery feature remains a delivery gate.

## 0.11.0-beta.3.vorteo.629 - 2026-10-16

### Maintenance

- Give the independent recovery page explicit repair-required and unverified rollback messages. A retained fallback receipt is labeled as a recorded result, separate from candidate success and current application usability.
- Disable new rollback preparation until authenticated retained status is available, while a request remains unresolved, and after a failed refresh. Lock and rejected authentication clear private state. Existing server admission, exact approval and replay checks remain unchanged.
- Validate these controls in a real Chromium fixture with owner authentication and file-backed retained history. Native effects are disabled in this browser case; it does not establish native fallback-failure recovery or installed availability. Permanent routing, remote owner acceptance and the primary README feature remain delivery gates.

## 0.11.0-beta.3.vorteo.628 - 2026-10-16

### Maintenance

- Make the existing two-minute retained-renewal verification timeout use SIGKILL for its isolated read-only child. A child that ignores SIGTERM must not leave the native installer or recovery runner waiting indefinitely. The child receives no execution lock or effect authority; verification, approval and replay checks remain unchanged.
- Add a real subprocess regression whose reader proves it ignored SIGTERM. It must be refused within the existing deadline, leave no reader process, and preserve fixture journal bytes. A fixture-owned emergency exit bounds failed-test cleanup without changing the production timeout.
- No installed service, route, credential or selection changes. README recovery availability remains pending tracked delivery and owner acceptance.

## 0.11.0-beta.3.vorteo.627 - 2026-10-16

### Maintenance

- Prepare newly reviewed independent rollback startup runners with responsive macOS scheduling. The policy remains pinned by the reviewed launcher digest; retained launchers keep their exact Background bytes. Artifact limits, exclusive ownership and replay fences are unchanged.
- A real disposable executor crash after selection recovered through its existing watchdog in about ten seconds. A second native case killed that watchdog after fallback bootstrap and exposed startup artifact verification failure under Background scheduling. The same read-only artifact check passed in a foreground process. The scheduling correction still requires compiled native acceptance; nothing is installed by this commit.
- Focused launcher checks cover retained bytes, the new reviewed policy and refusal of changed startup settings. The primary README recovery feature remains pending installed delivery and remote owner acceptance.

## 0.11.0-beta.3.vorteo.626 - 2026-10-16

### Tests

- Exercise a real subprocess dying after the rollback attempt and fixture selection are durably written. Reopening preserves the original approval, plan, generation and attempt marker without repeating rollback effects.
- Verify that independently confirmed fallback readiness records rollback, while unverified readiness remains recovery-required. Seven focused crash and adjacent reconciliation cases pass. Journal storage and subprocess termination are real; native service commands and custody ports remain simulated, so full service and installed acceptance are still open.
- No production behavior or README availability claim changes.

## 0.11.0-beta.3.vorteo.625 - 2026-10-16

### Documentation

- Reconcile the installation architecture with implemented independent rollback reviews, authenticated application diagnostics and the dedicated supervision handoff. Preserve the distinction between disposable native acceptance, installed delivery and remote owner acceptance.
- Document the existing 120-second isolated preparation bound and temporary authenticated SSH forwarding for loopback operator reviews. Native acceptance measured refusal after 120.007 seconds with a deliberately hung child that ignored graceful termination; the exact child was gone and fixture history stayed unchanged. This covers the production parent timeout boundary, not full plan verification, the broader failure matrix or installed recovery.
- No service, private route, credential or runtime selection changes in this documentation update. The primary README feature paragraph remains pending delivered recovery and remote acceptance.

## 0.11.0-beta.3.vorteo.624 - 2026-10-16

### Maintenance

- Add authenticated application-path diagnostics to the independent recovery page. Checks cover installation health, the owner API, the application document and entry scripts, without reading maintenance history or creating an app session. Green health is reported separately from missing scripts or rejected authentication; full browser usability remains unverified.
- Bound probe time and response bytes, refuse redirects and browser-selected destinations, and send owner authentication only to the configured application after matching installation health. Concurrent checks share exclusion, failed authentication and Lock clear private results, and reports omit credentials and response bodies.
- This remains source awaiting tracked installation and remote owner acceptance. It does not change the running installation, approve maintenance or enable the permanent recovery address. The primary README feature paragraph remains a delivery requirement.

## 0.11.0-beta.3.vorteo.623 - 2026-10-16

### Maintenance

- Add an owner-authenticated recovery-bookmark query. Native discovery verifies the selected recovery listener, protected assets and exact private HTTPS route before returning its non-secret origin. Missing, foreign, stale or failed proof returns no address. One in-flight inspection and a ten-second response deadline prevent repeated refreshes from multiplying a hung reader.
- Add General installation controls for opening and copying a verified recovery address, with bookmark guidance, expiry and explicit action failures. Older coordinators retain their existing HTTP and WebSocket contracts. These controls await tracked installation and remote owner acceptance; no service, route or standing authority is enabled by discovery.

## 0.11.0-beta.3.vorteo.622 - 2026-10-16

### Maintenance

- Permit an explicitly reviewed interactive macOS process policy for a standalone owner recovery-page slot. The registered Background-page fixture exposed slow native artifact inspection and socket-check timeouts; native comparison of the new policy remains required. The policy enters the immutable plan digest and is refused for ordinary controller or execution-launcher slots.
- Preserve the exact Background launcher for retained slots without a scheduling field, including an unchanged previous slot during replacement. Focused checks cover the reviewed digest, candidate policy, previous launcher bytes and role restrictions.
- This remains source awaiting native acceptance and installation. The permanent page, remote owner rollback, private HTTPS routing, General bookmark discovery and README feature delivery are still unfinished.

## 0.11.0-beta.3.vorteo.621 - 2026-10-16

### Fixed

- Wait for independently verified recovery-listener startup after native service registration, within the existing sixty-second activation budget. Repeat only observation while the executable, arguments or loopback socket settle; never repeat registration or selection effects.
- Keep exact grant and native custody checks before private routing. Startup timeout retains the same intent without configuring a route, and revocation during the wait refuses the next effect. Focused regressions cover temporary process/socket refusal, expiration, replay refusal and revocation.
- This corrects a startup race found in disposable native acceptance. Permanent page rollback, actual private HTTPS installation, remote owner testing and the broader failure matrix remain unfinished. No installed service or README availability claim changes.

## 0.11.0-beta.3.vorteo.620 - 2026-10-16

### Maintenance

- Connect standalone recovery controls to exact manual coordinator rollback preparation, approval and cancellation. The owner reviews the current, target and fallback sources plus the full pinned plan. Reopening reconstructs only an undecided manual review from retained history and protected setup; approved or uncertain work is never redispatched.
- Keep recovery-page startup independent of enrollment and lifecycle parsing. Effectful modules load only behind owner authentication. The HTTP preparation request accepts no browser-selected plan or runtime, excludes concurrent preparation and preserves safe domain errors.
- Show lost decision replies as unverified, prevent automatic resubmission, and clear private state and the password on Lock. The independent path uses a twenty-five-second dispatch observation deadline without killing or retrying a child; that deadline does not prove execution stopped.
- Focused reopening and HTTP tests plus an isolated Chromium flow cover authentication, exact review, a recorded approval with a lost reply, reload without replay, cancellation and Lock. Native listener asset checks still pass. Native rollback preparation and effect acceptance, real private HTTPS routing, the remaining failure matrix and installed owner review remain open. README and General availability claims are unchanged.

## 0.11.0-beta.3.vorteo.619 - 2026-10-16

### Maintenance

- Add independent coordinator rollback preparation using the selected recovery listener's native custody and the existing manual request, decision and execution path. The target comes only from the successful coordinator's explicitly reviewed compatible fallback. Preparation preserves configuration and history, refuses unresolved work, and does not consult basic health as permission to deny owner recovery.
- Pin the independent executor separately from the rollback target through the existing startup-recovery descriptor. Preparation has a two-minute response deadline and a final expiry check before request persistence; a late preparation cannot create new approval authority. Prepared files are synchronized and retained after failure.
- Nine selection regressions cover exact retained compatibility, open reviews, uncertain and rolled-back history, missing fallback, changed configuration, reused source, altered plan digest and another installation. Eight existing independent-runtime cases still pass. Native preparation and reopening, permanent HTTP controls, remote-browser acceptance and installed delivery remain unfinished. README and General availability claims are unchanged.

## 0.11.0-beta.3.vorteo.618 - 2026-10-16

### Maintenance

- Separate native recovery-page review custody from lifecycle executor authority. The review proof binds the protected selected plan, launcher, process lifetime and assets, remains observable after revocation, and grants no execution permission. The native composition requires the actual selected listener process and runtime module.
- Require the exact standalone HTML and JavaScript during native listener verification. A matching title or a long substituted script no longer passes inspection. Focused cases cover changed assets, revoked observation, changed native custody and continued executor refusal.
- This is an uninstalled prerequisite for permanent owner rollback controls. Exact rollback preparation and decisions, private HTTPS delivery and remote owner acceptance remain unfinished. README and General availability claims are unchanged.

## 0.11.0-beta.3.vorteo.617 - 2026-10-16

### Fixed

- Require the pinned independent coordinator executor to declare its versioned runtime contract before review or dispatch. A valid artifact hash alone cannot establish that an older installer supports a separate target release. The declaration is part of the existing hashed server package metadata; it grants no authority or installed availability.
- A focused regression retains valid older runtime bytes while omitting contract support and verifies refusal. Runtime identity, exact manual approval, artifact custody and native acceptance remain separate requirements. Permanent rollback controls and installed delivery remain unfinished; README and General availability claims are unchanged.

## 0.11.0-beta.3.vorteo.616 - 2026-10-16

### Maintenance

- Permit an exact manually reviewed coordinator replacement to use the independent executor already pinned by its existing startup-recovery descriptor. The executor's setup, Node, scripts and complete runtime remain hash-verified and separate from the target release. This removes the candidate-runtime dependency that prevented a newer repair runtime from installing an older compatible coordinator.
- Ordinary runners remain candidate-bound. A separate executor refuses borrowed renewal, enrollment or automatic authority, another request, changed prepared setup, changed runtime bytes and guest-writable paths. No shared journal field, queue, credential or installed service changes.
- Focused filesystem and legacy startup-review regressions cover these bindings. This is an uninstalled execution prerequisite, not completed permanent rollback controls or native rollback acceptance. Exact owner review, native custody, exclusive claims and existing startup recovery still apply; README and General availability claims remain unchanged.

## 0.11.0-beta.3.vorteo.615 - 2026-10-16

### Maintenance

- Require the initial independent recovery page to be a verified prerequisite of combined coordinator activation. The protected enrollment controller validates its reviewed native plan, runtime and setup before reserving the existing activation step and launching one exact child. No new queue, authority store or credential is introduced.
- Reopening a reserved generation uses an explicit observation-only native role, including when no child intent exists. Lost launch replies never authorize another registration attempt. Native custody and lifecycle exclusion are checked under the shared reservation lock; child exit alone does not permit coordinator migration.
- Focused regressions cover ordered activation, lost replies before and after intent, revocation before reservation, asynchronous custody refusal, missing prerequisites and unchanged retained state after refusal. This is source integration, not installed recovery or full combined native acceptance. Private HTTPS delivery, exact rollback controls, remote owner acceptance and README/General availability remain unfinished.

## 0.11.0-beta.3.vorteo.614 - 2026-10-16

### Maintenance

- Add a bounded one-generation native recovery-registration role. Four enrollment identifiers select the protected initial plan; verify its runtime, exact native arguments, process custody, writable mounts and current reserved activation before registration. This adds no queue, dispatcher or execution credential.
- Reopen retained effects through observation only, including after revocation. Retain synchronized addressed native receipts and settle the existing activation under shared exclusion with a synchronous final custody check. Verified reconciliation preserves failed history instead of resetting a generation.
- Focused orchestration and journal tests cover one-time effects, lost start and route replies, revocation, malformed intents, another generation, immutable invocation fields and changed or asynchronous custody. This is source wiring, not compiled native acceptance or installed recovery. Combined activation invocation, compatible rollback controls and owner remote-browser acceptance remain open; README and General availability claims are unchanged.

## 0.11.0-beta.3.vorteo.613 - 2026-10-16

### Fixed

- Verify that the independent recovery listener can bind its reviewed loopback port before consuming initial registration authority, publishing its launcher or starting a service. Repeat the bounded kernel availability probe at the native command boundary; a conflict or incomplete probe refuses registration without disturbing the existing listener.
- Native socket and enrollment-journal regressions cover occupied and released ports, invalid port values and refusal before intent or selection publication. This does not install the recovery page or change any route. Production invocation, rollback controls, General bookmark discovery and remote owner acceptance remain open; README availability claims are unchanged.

## 0.11.0-beta.3.vorteo.612 - 2026-10-16

### Fixed

- Recover a manual-to-supervised coordinator handoff interrupted before its first freeze. The exact rollback generation may consume its first audited freeze intent, preserve unchanged state and retire the frozen process before starting the reviewed compatible fallback. Existing or uncertain freeze attempts remain non-repeatable.
- Treat an independently verified changed boot as proof that the original manual lifetime ended. Reused numeric PIDs are neither inspected as the original process nor signaled; missing or inconsistent boot proof still refuses recovery.
- Ten focused cases pass, including real disposable native freeze and retirement from both normal dispatch and interrupted recovery. These are source and fixture checks, not installed supervision, real reboot acceptance or a new owner approval. The README continues to omit uninstalled recovery claims.

## 0.11.0-beta.3.vorteo.611 - 2026-10-16

### Maintenance

- Add the protected supervision-review parent for one exact recorded request. Reuse the installation owner password, existing request journal and one launch reservation; verify native parent custody under shared exclusion before forking the existing executor. Reopening a reserved launch observes instead of forking again.
- Keep native helper and runner code inside the reviewed runtime. Bound parent acknowledgement observation to twenty-five seconds without killing or retrying the installer; preserve existing observation defaults for other callers.
- Show the target, running source, replacement, compatible fallback and explicit frozen SIGKILL in the independent review. Keep cancellation available before claim, clear passwords after decisions, and label a reserved launch unverified rather than completed. Canceled requests retain audit data without displaying an active launch.
- Eleven focused authentication, cancellation, reservation and deadline cases pass. Review scripts are syntax-checked, and an isolated Chromium fixture verifies visible release details, authentication failure, password clearing, one-time submission and cancellation. Types, lint and compilation pass. Full compiled native handoff and rollback acceptance remain open; no real review, route or service was installed.

## 0.11.0-beta.3.vorteo.610 - 2026-10-16

### Fixed

- Match supervision watchdog identity to the Node arguments actually executed by the ownership launcher. Its automatic-recovery option belongs to Python and is consumed before exec, so requiring it in the Node process would incorrectly reject recovery. Update retained-reopening coverage to use that exact boundary. An owned macOS process also verifies the kernel argument digest after the real launcher exec. Compiled native delivery acceptance remains open; no installed process changed.

## 0.11.0-beta.3.vorteo.609 - 2026-10-16

### Maintenance

- Wire protected supervision setup into the existing coordinator executor and watchdog. Before claim, verify the reserved setup digest, exact native runner arguments, selected configuration and original parent lifetime. After claim, retain observation and recovery without requiring the review process to remain alive.
- Route only that explicit mode through audited manual-process control; ordinary installation dispatch still refuses it. Require its durable launch reservation at claim and preserve existing generation, ownership, state-transfer, selection and watchdog checks.
- Run full supervision preparation in a separate read-only process with a two-minute bound and exact input acknowledgement. It receives no execution-lock descriptor and does not enter the legacy retained renewal derivation.
- Ten focused cases cover setup and parent substitution, claimed reopening, missing launch reservation and verifier acknowledgement; two native supervision regressions also pass. Workspace types, lint and compilation pass. Full compiled runner acceptance, production parent and exact owner review packaging remain open; nothing is installed or advertised.

## 0.11.0-beta.3.vorteo.608 - 2026-10-16

### Maintenance

- Connect the supervision control port to the audited native helper with the inherited execution descriptor and exact retained request, revision and generation. Validation and helper execution share a twenty-five-second deadline; late validation cannot launch an effect, and failures require retained observation rather than retry.
- Permit native preparation of the explicitly reviewed manual-restoration path using independent service absence and exact process identity. Recheck canceled migration history before and after preparation; ordinary migration still requires its registered service.
- Four control cases cover the exact native invocation, generation changes, deadline expiry and private error redaction. The full admission fixture verifies manual restoration, unexpected service registration and missing canceled history. Production runner selection, compiled end-to-end acceptance, owner review packaging and installed supervision remain open; no capability is enabled.

## 0.11.0-beta.3.vorteo.607 - 2026-10-16

### Maintenance

- Reserve one supervision runner launch in the existing bootstrap journal before forking. Bind the original approved revision, protected setup digest and native parent identity while rereading current requests and lifecycle exclusion under the shared lock.
- Require a synchronous native custody check before persistence. Preserve the immutable reservation and reviewed plan through progress and cancellation; reopening a lost launch response refuses a second reservation. Ordinary journal writes cannot mint this authority.
- Focused regressions cover reopening, duplicate and forged reservations, lock contention, asynchronous or changed custody, unchanged history and owner cancellation before dispatch. Production runner integration, exact review packaging and installed supervision remain unfinished. No installed capability is enabled.

## 0.11.0-beta.3.vorteo.606 - 2026-10-16

### Maintenance

- Add the internal audited supervision effect helper under the existing coordinator execution lock. Bind every effect to the current approved revision, generation, canceled migration, failed ancestry, selected files and kernel process lifetime; consume an exclusive attempt before signaling.
- Require a frozen coordinator without children and unchanged fsynced state before retirement. Bound the helper with a twenty-five-second deadline and report fixed failure categories without private command output. State transfer checks allow sixteen MiB while legacy dependency-read defaults remain unchanged.
- A disposable macOS process verifies expired and wrong-generation refusal, actual freeze, replay refusal, missing and changed transfer refusal, recovery-stage retirement, unchanged session bytes and exact-lifetime cleanup. Production controller invocation, independent review packaging and installed supervision remain unfinished; no installed capability is enabled.

## 0.11.0-beta.3.vorteo.605 - 2026-10-16

### Maintenance

- Retain manually restored coordinator history through an explicit supervision recovery plan, bound to the exact canceled migration and failed predecessor. Require a fresh owner decision, unchanged configuration and a reader-aware compatible replacement instead of reusing the old approval or claiming the migration succeeded.
- Preserve the exact canceled ancestor during startup without parsing unrelated newer pending proposals. Add a process-bound native lifecycle interface for verified freeze, state preservation and frozen-process retirement; ordinary native dispatch refuses this mode until the dedicated executor is supplied.
- Focused journal, native-port and registered-service regressions pass. Audited native effect dispatch, independent review packaging, full rollback acceptance and installed supervision remain unfinished. No live request, service, capability or README availability claim changes.

## 0.11.0-beta.3.vorteo.604 - 2026-10-16

### Maintenance

- Add read-only preparation for restoring coordinator supervision after manual recovery. Require repeated native service absence and exact process birth, boot, owner, parent, executable and launch arguments without fabricating a loaded service.
- Preserve ordinary registered-service admission and its strict checks. This preparation grants no lifecycle authority; tracked handoff execution, interrupted recovery and installed supervision remain unfinished. The README has no new availability claim.

## 0.11.0-beta.3.vorteo.603 - 2026-10-16

- Add native recovery registration adapters with protected process inspection, exact loopback socket ownership, bounded page asset checks and complete routing custody. Require a private immutable Node runtime for orphan detection and verify actual activation lineage before excluding any process.
- Recheck retained intent and current grant before native commands, preserve read-only construction after revocation and carry the activation deadline through final dispatch validation. Collect fresh listener evidence after artifact preparation, preserve the configured Host header in native HTTP requests and select headless Tailscale CLI mode explicitly.
- Seventeen native-helper cases, fourteen owning cases and compiled read-only acceptance pass without changing installed routing or services. Production invocation, full native registration, compatible rollback and owner remote-browser acceptance remain open; no installed capability or README feature claim is enabled.

## 0.11.0-beta.3.vorteo.602 - 2026-10-16

- Add initial independent recovery registration through the existing exact enrollment activation intent. Publish immutable selected files before native service and private HTTPS routing effects; recheck grant, generation and synchronous native custody under shared exclusion while keeping native commands outside the lock.
- Bound the complete activation to sixty seconds and read-only reconciliation to ten seconds. Lost replies, timeout and partial writes retain their generation without replay; observation after revocation verifies the selected native lifetime, listener and complete routing result without claiming remote owner acceptance.
- Twelve focused temporary-filesystem and simulated-native regressions pass. Production native ports, invocation wiring, compiled registration, rollback controls and installed remote-browser acceptance remain unfinished. No installed capability or README feature claim is enabled.

## 0.11.0-beta.3.vorteo.601 - 2026-10-16

- Bind optional private recovery routing preparation to the existing launcher plan, protected Tailscale executable, complete previous Serve snapshot and exact candidate setup. Preserve all existing and unknown routing settings; refuse occupied ports, configuration drift and mismatched private machine identity.
- Verify the pinned routing CLI with explicit Host-or-root custody for system-installed binaries. Keep Host-only ownership as the existing dependency default, with digest, canonical path, write protection, mount exclusion and streaming limits preserved.
- Add focused preparation regressions without performing any live routing or lifecycle operation. Native route execution, uncertainty reconciliation, installed registration, rollback and remote-browser acceptance remain unfinished. General bookmark discovery and README feature advertising remain delivery requirements.

## 0.11.0-beta.3.vorteo.600 - 2026-10-16

- Bind standalone recovery access to the existing exact launcher plan. Verify its native identity, source, owner configuration and shared lifecycle directory; compatible access slots retain their bookmarked origin and port. Reject access configuration paired with the older entry point.
- Render exact standalone arguments with throttled OS supervision for the read-only page. Preserve existing controller launch behavior and reject the access listener as an effect executor until native execution support is implemented and accepted.
- All 87 launcher tests, 15 control HTTP tests, workspace types, lint and server compilation pass. Permanent HTTPS routing, installed registration, rollback controls and remote-browser acceptance remain unfinished. README feature copy and General bookmark discovery remain delivery requirements.

## 0.11.0-beta.3.vorteo.599 - 2026-10-16

- Add a standalone read-only recovery entry point using protected recovery-launcher configuration and a fixed loopback port. Start its page independently of enrollment, lifecycle parsing and the primary coordinator entry point; defer inspection until owner authentication.
- Share the existing private configuration reader and error identities without changing their custody checks. Preserve the existing launcher setup and add optional recovery access configuration. Read-only access cannot prepare, approve or dispatch maintenance.
- Fifteen control HTTP cases, two focused configuration checks, full workspace types, lint and server compilation pass. Disposable compiled fixtures preserve broken journal bytes and remain renderable with journal/review modules absent. Permanent HTTPS registration, supervision, rollback controls and installed remote-browser acceptance remain open; the README feature claim stays pending.

## 0.11.0-beta.3.vorteo.598 - 2026-10-16

- Add a self-contained recovery status page to the existing maintenance listener when a separate protected HTTPS origin is explicitly configured. Page rendering does not read owner configuration, maintenance journals, service status or primary app assets.
- Authenticate recovery inspection with the existing owner password, without relying on main-app cookies or session storage. Enforce the configured host and distinct origin, restrict script loading, bound browser inspection and clear access on lock or page exit.
- Fourteen owning HTTP checks, workspace typecheck and lint pass. Permanent HTTPS provisioning, supervised installation, rollback controls and remote-browser acceptance remain unfinished. The primary README feature paragraph and General bookmark discovery will accompany delivered recovery, not this source foundation.

## 0.11.0-beta.3.vorteo.597 - 2026-10-16

- Keep exact native coordinator migration cancellation available after approval until execution is claimed. Require the displayed revision and owner authentication, preserve separate one-shot cancellation and approval fences, and reject claimed or stale requests.
- Thirteen focused HTTP checks cover both native review scopes. This repair does not restart services, repeat dispatch or mark an interrupted migration successful. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.596 - 2026-10-16

- Isolate retained renewal verification for native bootstrap roles in a bounded read-only child. Preserve the existing native, artifact and history checks, require an exact input-digest acknowledgement and successful exit, and reject timeout without repeating lifecycle effects.
- The verifier child receives no execution lock or lifecycle operation. Other coordinator and maintenance-control roles retain their existing behavior. Server compilation passes; optional suites are omitted under the owner's emergency restoration instruction. Installed recovery and replacement acceptance remain open. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.595 - 2026-10-16

- Permit tracked preclaim retirement of the exact reviewed coordinator runner launched by its already-admitted maintenance controller. Bind that parent to the protected admission, runtime, installation, argv, owner and boot while preserving the original Host renewal identity and exact owner recovery approval.
- Preserve legacy Host-parent admission and refuse unrelated parents. This is a restoration repair; the stalled approved migration is unchanged until its separate recovery decision. No optional test suite was run under the owner's emergency instruction. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.594 - 2026-10-15

- Allow a corrected owner password after a definite authentication refusal in either independent native review scope, while retaining one-shot behavior for uncertain replies. Migration approval still uses the exact native service and does not acquire the preclaim cancellation exception.
- Extend the eleven owning HTTP checks to verify definite refusal leaves no decision and enables correction in both scopes. No native dispatch, configuration or standing authority changes; installed coordinator delivery remains pending. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.593 - 2026-10-15

- Give the existing one-operation maintenance controller an independent loopback owner page when the normal installation interface is unavailable. Reuse the preclaim admission presentation and exact native review service, with separate runtime admission and migration decisions. Existing canonical maintenance APIs and enrollment roles remain unchanged.
- Eleven owning HTTP checks pass, covering both review scopes, authentication refusal, origin and digest rejection, separate consent and no replay after lost replies. Native provisioning and dispatch still enforce their original protected configuration and lifecycle gates. This prepares a supported restoration route; no coordinator replacement is claimed. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.592 - 2026-10-15

- Keep independent preclaim cancellation available against the displayed revision until native execution is claimed, while preserving one-shot approval and cancellation after uncertain replies. Definite authentication refusal permits a corrected password without repeating a recorded decision.
- Seven focused HTTP checks cover separate approval and cancellation, stale revisions, authentication refusal and claimed-execution refusal. Compiled disposable retirement and reopening passed with preserved history; the retained installation executor remains unchanged until exact owner approval. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.591 - 2026-10-15

- Add an independent preclaim controller role and separate owner provisioning and exact recovery pages. Recovery children bind to the admitted controller birth and immutable runtime while retaining the genuine selected Host snapshot. Existing journals, cancellation fencing, single-use launch attempts and observation remain in use.
- Recognize the reviewed preclaim runner release only with its complete artifact and control-flow digests. Read-only native acceptance verified the retained target's setup, audited process, isolated group, selected coordinator and lock without changing its journal or sending signals.
- Owning preclaim, parent-binding and HTTP checks pass, and a browser fixture verifies authentication refusal, separate consent and no decision replay after a lost reply. Compiled native retirement and controller reopening remain unaccepted; no live recovery or capability enablement is claimed. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.590 - 2026-10-15

- Add owner-authenticated admission for an exact independent preclaim repair runtime, using existing addressed repair artifacts. Provisioning preserves the original unclaimed approval and creates no recovery decision or process effect; claimed-generation consent cannot substitute for preclaim consent.
- Reuse protected runtime and installation verification across both repair kinds. Twenty-seven focused checks cover authentication, immutable admission, changed approvals, substituted policy and runtime bytes, repeat provisioning and existing claimed repair behavior. Native controller routing, exact runner compatibility and installed recovery remain unfinished; no capability is enabled. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.589 - 2026-10-15

- Validate preclaim recovery history without requiring its failed predecessor to have completed ordinary renewal. Preserve the strict terminal-release selector and the independent retained native checks before recovery review or effects.
- Twenty-nine focused history and preclaim checks pass, including an exact unpromoted failure, unresolved or substituted ancestry and unchanged journals. This correction is source only; independent recovery delivery and installed acceptance remain open. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.588 - 2026-10-15

- Capture Claude's exact SDK query, input and child before asynchronous close. Concurrent and repeated close calls share the retained result; termination timeout preserves the child handle and reports incomplete cleanup instead of success.
- Close admission synchronously and check again immediately before SDK process creation, preventing a late spawn after the session closes. Isolated runtime-exit, spawn and interruption regressions pass without live account dependencies. Query retirement, full native descendant proof and installed maintenance acceptance remain open; README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.587 - 2026-10-15

- Retain OpenCode helper generations and their managed records when cleanup is unverified. Concurrent or repeated shutdowns share one termination attempt; known failed cleanup blocks new acquisitions until the owned process actually exits.
- Preserve normal acquisition during ordinary cleanup in progress. Check cleanup state again before spawn and lease return, and observe shutdown failures without unhandled background rejections. Twenty-two focused tests pass, including release and shutdown failures, retained records, no repeated termination, and resumption after process exit. Complete native descendant cleanup and installed acceptance remain open; README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.586 - 2026-10-15

- Preserve JSONL provider cleanup failures across concurrent and repeated close calls. A disposed transport no longer proves its child exited; termination timeout rejects explicitly and the retained result prevents another signal sequence.
- Let explicit close clean a live child after transport failure. Automatic stdin-error cleanup logs its retained failure without losing it or creating an unhandled rejection. Twenty focused transport tests pass, including timeout and repeated-close cases. No installed service changes; complete provider descendant cleanup and maintenance dispatch acceptance remain open. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.585 - 2026-10-15

- Preserve managed helper records when termination reports an unverified exit. Reopening keeps that evidence until a later inspection proves the process absent; a timed-out kill is no longer counted as successful cleanup.
- Distinguish the exact empty POSIX no-match response from permission errors, command failures, signals and truncated execution. Sixteen focused registry and process-table tests pass, including actual inspection of an exited disposable process. No new cleanup store or installation effect is introduced; full provider descendant cleanup and installed acceptance remain open. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.584 - 2026-10-15

- Refuse maintenance worker replacement when inherited worker streams remain open beyond the retained termination deadline. Worker exit alone no longer starts a maintenance replacement behind a descendant that retains those streams; late closure cannot revive the failed attempt.
- Preserve legacy restart behavior and the existing absolute termination budget. Real disposable-process coverage verifies refusal and descendant cleanup. Closed streams remain only a necessary check, not proof that every provider process exited; full native cleanup and installed acceptance remain open. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.583 - 2026-10-15

- Add internal cooperative restart interruption bound to the exact held worker and generation. Preserve restart-owned goal continuation, require observed turn settlement, retain uncertain attempts without repeating provider cancellation, and reject changed holds or expired budgets.
- Keep this preparation separate from native provider-process cleanup and restart authority. The new path is not exposed or enabled; dispatch wiring, cleanup proof and installed acceptance remain open. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.582 - 2026-10-15

- Extend the compiled idle-restart fixture through durable queue recovery. After real supervisor acceptance and worker replacement, reopen the actual lifecycle journal twice, preserve uncertainty, then verify the new worker lifetime and old process exit without another dispatch.
- Keep registration and authority admission outside this fixture's acceptance claim. Native registration, active-provider cleanup, Dev and installed acceptance remain unfinished; no installed service or existing migration request changes. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.581 - 2026-10-15

### Fixed

- Keep unrelated pending plans from disabling the promoted coordinator's startup and web interface when a newer Host adds plan fields. Startup readers validate promoted records, exact recovery ancestors and their promotion evidence; other pending bodies remain untouched.
- Preserve strict full journal reads and lifecycle effect admission. Unsupported required ancestry, promotion evidence and promoted records still refuse startup. Focused filesystem and real HTTP tests cover both availability and refusal. This source change does not alter the existing live migration request or installed runtime; README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.580 - 2026-10-15

### Changed

- Add a loopback-only owner review surface for an exact existing coordinator migration when the primary coordinator cannot serve its interface. The bridge uses the existing authenticated Host review service, pins request identity and revision, and never prepares another plan or supplies owner approval.
- Require an explicit owner password and button decision, reject cross-origin or changed requests, and retain observation without retry after an uncertain reply. Focused real HTTP and disposable browser checks pass. Starting the review listener changes no daemon selection or installation journal; the migration still requires its exact owner decision.

## 0.11.0-beta.3.vorteo.579 - 2026-10-15

### Changed

- Wire independent interruption observation into the existing queue. It checks the exact selected source and worker lifetime, independently proves the previous worker exited and repeats native inspection after source verification. Revocation permits observation without granting another effect.
- Host update observation additionally verifies the reviewed runtime artifact, completed activation receipt, published build and interface bytes. Failed publication, changed assets, substituted source or changing native custody retain uncertainty without retrying a restart or publisher.

### Validation and delivery

- Focused filesystem and native-port regressions cover live old workers, PID reuse, boot changes, revocation, changing replacements and publication mismatches. Compiled queue acceptance, Dev launcher registration, active-provider cleanup and installed acceptance remain open. README overview and onboarding are unchanged; this source checkpoint changes no installed service.

## 0.11.0-beta.3.vorteo.578 - 2026-10-15

### Changed

- Construct interruption reservations from a newly inspected authenticated worker and exact observed hold, current enrollment limits and verified candidate. Preparation records no effect and rejects released holds, revoked or paused authority, missing evidence and elapsed deadlines.
- Retain hold identity through native inspection and reject a release or hold change during collection. Independent outcome verification and production dispatch wiring remain unfinished; no unattended effect is enabled. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.577 - 2026-10-15

### Changed

- Add queue support for exact interruption reservations before dispatch. Uncertain attempts survive reopening, block competing lifecycle work and permit observation after revocation without another restart. Observation retries retain bounded backoff across reopening.
- Read the retained running request, approved source and generation before acknowledged execution. Source-update callbacks use that same held restart path. Enrolled worker operations refuse legacy fallback when transport or independent observation is unavailable; native plan operations and the exact initial migration retain their own admission paths.

### Validation and delivery

- Focused queue and shared-journal tests cover lost replies, revocation, retry-budget changes, target exclusion and retained request binding. Production reservation construction and independent native outcome verification are not yet connected, so this does not enable unattended effects or bounded forced interruption. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.576 - 2026-10-15

### Changed

- Define immutable interruption reservations in the existing lifecycle journal, binding the approved revision, grant, hold generation, native worker lifetime, candidate and enrolled deadlines. Locked admission rejects changed bindings and replay while retaining observations after revocation.
- Retain authenticated worker lifetime in native inspection and bind candidate summaries to verified artifact receipts. Failed candidate revalidation clears the older cached proof. Private interruption evidence is omitted from legacy responses.

### Validation and delivery

- Real journal tests cover reopening, substitution, revocation and unchanged storage on refusal. Native inspection and candidate-integrity regressions pass, along with types, lint and client build. Queue dispatch and observation consumers, active-provider cleanup and installed acceptance remain open; no new effect is enabled. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.575 - 2026-10-15

### Validation

- Verify acknowledged held idle restart through the compiled client, real worker and real supervisor in an isolated fixture. The exact supervisor receipt precedes success, replacement changes both process and worker lifetime, and cleanup verifies both workers exited.
- The fixture uses a private home and loopback listener without provider credentials or installation changes. Queue reservation integration, active-provider cleanup and installed delivery remain open. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.574 - 2026-10-15

### Changed

- Connect held idle restart requests to the running supervisor acknowledgement channel. Bind the request and generation to the observed worker lifetime, retain the absolute checkpoint and shutdown deadline, and report acceptance only after the supervisor accepts the exact attempt.
- Fence hold release after dispatch admission. Clients reject legacy acknowledgements as proof and require the running supervisor capability before sending the new optional request fields. Existing restart messages remain compatible.

### Validation and delivery

- Twenty-two focused client, session and hold/checkpoint tests pass; full workspace types, lint and client build pass. Queue reservations, forced provider cleanup, compiled worker acceptance and installed delivery remain open. The new transport covers idle held workers and does not advertise bounded forced interruption. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.573 - 2026-10-15

### Changed

- Add exact hold and absolute deadline checks to maintenance checkpointing. A cancelled hold or elapsed budget reports an incomplete checkpoint; late persistence cannot advance the attempt. Capture the reviewed inputs before awaiting persistence and preserve existing unbounded legacy calls.

### Validation and delivery

- Five focused checkpoint regressions, full workspace types and lint pass. The acknowledged restart RPC, durable interruption reservation and provider cleanup remain unfinished; this checkpoint contract is not installed or advertised as bounded interruption. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.572 - 2026-10-15

### Changed

- Apply the supervisor's absolute maintenance deadline to worker shutdown. All daemon cleanup stages share that budget, duplicate requests cannot extend it, and an expired budget reports incomplete cleanup. Legacy shutdown retains its ten-second limit.

### Validation and delivery

- Four worker budget regressions and thirteen existing supervisor/transport cases pass. Full workspace types and lint pass. Exact held-instance dispatch, checkpoint budgeting and provider cleanup remain unfinished; bounded interruption is not advertised or installed. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.571 - 2026-10-15

### Added

- Add private supervisor acknowledgement for an exact maintenance request, generation, worker and absolute termination deadline. Duplicate accepted intents retain the same decision during shutdown and do not repeat effects or extend the budget.
- Add worker transport checks for the running supervisor handshake, current parent and exact acknowledgement. Lost replies remain uncertain; an explicit refusal permits a different tracked generation without replaying the previous one.

### Validation and delivery

- Thirteen focused supervisor and transport cases pass, including disposable subprocess deadline checks. Public restart capabilities remain unchanged. Worker/session integration, durable interruption admission, checkpoint budgeting and provider cleanup are unfinished; bounded interruption is not advertised or installed. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.570 - 2026-10-15

### Maintenance

- Preserve the installed Host and published interface ancestry in the reliability source. Retain both release histories and the newer native recovery implementation; incoming package differences are workspace version metadata only.
- Installed Host Claude acceptance is complete. Coordinator, Dev and autonomous maintenance installation remain separate and unfinished. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.569 - 2026-10-15

### Added

- Execute one reviewed recovery or rollback generation for a proven absent maintenance service through the existing lifecycle journal. Recheck retained history and native custody before recording the effect intent, publishing the exact slot and starting the service once.
- Verify recovery readiness against the consumed generation, selected artifacts and native boot. Lost startup replies retain uncertainty and cannot replay effects.

### Validation and delivery

- All 74 launcher tests, server types, lint and server/CLI build pass. Native commands use simulated ports in the recovery cases; production recovery routing, launcher execution and compiled recovery acceptance remain open. Recovery stays unadvertised. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.568 - 2026-10-15

### Fixed

- Retain the reviewed Host or Dev candidate selection and activation intent after an unconfirmed restart or failed readiness check. An exception cannot prove that startup stopped; native reconciliation must precede selector rollback.
- Refuse installation replay before preparation at the public entrypoint, including requests without a preparation flag. Preserve the inner target-specific activation fences.
- Verify retained recovery startup after ancestor resolution without reopening fresh recovery authority. Pin the selected recovery wrapper, original slot and exact addressed readiness evidence.

### Added

- Integrate bounded native runtime-file inventory, explicit recovery-launcher executor identity and verified one-generation child custody. Same-boot absence requires independent process evidence, while changed-boot witnesses remain tied to the selected executor.

### Validation and delivery

- Host and Dev uncertainty regressions, native inventory, recovery startup and read-only child identity checks pass. Server build, types and lint pass. Native recovery effects, compiled recovery acceptance, bounded daemon interruption and installed activation remain open; no recovery capability or live installation is enabled by this checkpoint.

## 0.11.0-beta.3.vorteo.567 - 2026-10-15

### Added

- Bind controller recovery and rollback to each immediate consumed predecessor in the existing lifecycle journal, with original runtime slots and a chain-wide retry limit. Permit the enrolled recovery launcher only for these exact linked operations.
- Record verified recovery and resolution of every ancestor in one transaction. Preserve original approvals, execution intents, observations and evidence; historical attempts remain failed rather than becoming false successes.
- Integrate protected native recovery history, explicit role discovery, bounded service-absence checks and custody-bound boot witnesses. Failed inspection stays uncertain; ambiguous same-boot target lifetimes remain refused.

### Fixed

- Follow the valid recovery generation while retaining all ancestors and competing lifecycle work. Capability checks select the next job without hiding retained history, and reopened generations remain observable after revocation or reduced executor support.

### Validation and delivery

- Focused journal and queue checks cover recovery links, sibling exclusion, revocation, atomic history resolution, lost replies and compatible observation. Native prerequisite and existing restart tests pass with types and lint. Recovery and rollback remain unadvertised until native execution acceptance; nothing is installed by this source checkpoint. Actual reboot acceptance and launcher recovery remain open.

## 0.11.0-beta.3.vorteo.566 - 2026-10-15

### Maintenance

- Preserve the published conversation queue placement and draft-retention changes alongside installation maintenance. Retain both source histories; this merge performs no publication or runtime activation.

## 0.11.0-beta.3.vorteo.565 - 2026-10-15

### Added

- Connect verified native service discovery to coordinator reconciliation. Availability requires protected registration and compatible runner artifacts; grant and exact reservation admission still control every effect.
- Feed controller readiness into owner installation status through protected native identity, selected runtime and its process-owned health listener. Bound inspection, discard late results and clear failed health to unknown; launcher readiness remains unknown.

### Fixed

- Read current enrollment authority after asynchronous health inspection so concurrent revocation is reflected without declaring a running service unhealthy.

### Validation and delivery

- Focused owner HTTP, timeout and native adapter tests pass with full types, lint and server build. Disposable compiled producer and health checks verify replacement, retained observation, replay refusal and readiness after revocation. Enrollment setup and Docker/daemon endpoints are simulated in those native checks; installed activation, launcher recovery and complete rollout remain open.

## 0.11.0-beta.3.vorteo.564 - 2026-10-15

### Fixed

- Refresh selected maintenance-controller registration before inspection and bind the executor's selected runtime to reservation and child intent. Preserve compatible replacement without treating mutable queue bookkeeping as runtime identity.
- Bound the complete native execution wait, including validation and observation. Refuse a late launch and discard late results without killing or retrying a child.
- Discover the native executor through existing coordinator reconciliation without blocking daemon work. Serialize read-only construction, reject expired results and retry settled registration failures.

### Validation and delivery

- Focused tests cover executor evidence, native replacement, total deadlines, read-only discovery and retained observation. Compiled producer acceptance and production wiring remain open; capability stays disabled.

## 0.11.0-beta.3.vorteo.563 - 2026-10-15

### Maintenance

- Integrate the published connection diagnostics with the prepared maintenance source, preserving both histories and the existing runtime boundaries. No service capability or installation is activated by this merge.

## 0.11.0-beta.3.vorteo.562 - 2026-10-16

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.562 - 2026-10-15

### Fixed

- Bind new controller and launcher maintenance effects to the selected executor's native identity, runtime, setup and artifacts. Require target and executor evidence from the same boot, and preserve the reserved executor through native intent admission.
- Keep legacy receipts readable for observation after revocation. Mutable queue bookkeeping does not change executor identity.

### Validation and delivery

- Focused journal tests cover missing executor proof, changed custody, cross-boot evidence, changed executor after reservation and legacy observation. Native producer refresh and installed acceptance remain open; capability remains disabled.

## 0.11.0-beta.3.vorteo.559 - 2026-10-15

### Added

- Connect the exact enrollment decision to coordinator provisioning, native claim reservations and observation of the reviewed candidate.
- Retain private native identity descriptors through atomic publication and reconcile interrupted publication without replacing an enrolled identity.
- Bind standing queue decisions to source provenance, target identity and exact activation children. Reserve holds before effects, reconcile lost replies and preserve exact manual supersession after revocation.
- Verify Host runtime and interface bytes, and Dev runtime bytes, before a hold and before selection. Bound artifact verification and cancel active checks when the owner cancels a queued request.

### Validation and delivery

- Focused queue, enrollment and artifact tests and disposable Linux candidate checks cover changed bytes, source mismatch, lost replies, revocation and external aliases. This checkpoint is source only; native admission wiring, persistent recovery and installed acceptance remain open.

## 0.11.0-beta.3.vorteo.558 - 2026-10-15

### Added

- Put a connection check at the top of General settings. Test the current device's routes to the installation, Host and Dev without typing addresses or sending daemon credentials.
- Show network health separately from app authentication and initialization, with endpoint addresses, check times and bounded failures.
- Verify real HTTP behavior and compact and desktop rendering. Keep daemon restart and maintenance approval separate from this interface change.

## 0.11.0-beta.3.vorteo.557 - 2026-10-15

### Added

- Define exact installation enrollment, standing maintenance scope and durable activation steps, with revocation and retained recovery observations.
- Synchronize enrollment storage before selection and reconcile uncertain writes without repeating effects. Bound retained state and preserve failed generations.
- Add owner-only enrollment status, guarded client refresh and a responsive installation health component. Cached health expires, and readiness requires fresh observations of the enrolled native target.
- Bind native identity to protected Host registration or an immutable container and numeric user/group identity, independently of process and release observations.

### Maintenance

- Cover storage failures, recovery, revocation, lock contention, owner access and dashboard rendering with focused tests.
- Keep native execution, dashboard mounting and managed installation acceptance open. Document pre-login recovery as future work; this source checkpoint does not activate maintenance authority.

## 0.11.0-beta.3.vorteo.556 - 2026-10-15

### Fixed

- Resolve coordinator recovery chains containing multiple recovered claims and unpromoted failures while preserving the actual selected release and exact immediate predecessor.
- Verify historical recovery receipts and every required executor exit. Reject missing or changed proof, stale references and conflicting history without rewriting earlier approvals or failures.
- Keep managed installation and operating acceptance separate from source validation.

## 0.11.0-beta.3.vorteo.555 - 2026-10-15

### Fixed

- Center account reset labels within the button border and reserve the full touch target in account rows.
- Show whole hours rounded down in compact Goal badges instead of accumulating minutes.
- Shorten the compact composer to balance spacing between microphone, Queue and Send controls.

## 0.11.0-beta.3.vorteo.554 - 2026-10-15

### Maintenance

- Combine shared lifecycle admission with independently pinned repeated repair admissions and reviewed historical runner support. Preserve both source histories and exact approval boundaries.
- Keep Factory recovery artifacts unchanged. This source composition does not admit a repair runtime, dispatch recovery or release publication holds.

## 0.11.0-beta.3.vorteo.553 - 2026-10-15

### Fixed

- Admit the separately reviewed newer claimed runner by exact source, module and ownership-helper digests, preserving the previous runner pins.
- Keep unknown sources and altered runner bytes rejected. Recovery still requires full artifact, native identity, selected-service and retained-history verification plus its own visible approval.
- Verify both fencing orderings against the installed journal in disposable storage. Installed recovery acceptance remains open.

## 0.11.0-beta.3.vorteo.552 - 2026-10-15

### Maintenance

- Combine repeated repair admission with completed-history target selection and partial Host publication receipts, preserving both source histories.
- Keep independent repair delivery and installed acceptance open. This source integration does not dispatch recovery or restart services.

## 0.11.0-beta.3.vorteo.552 - 2026-10-15

### Fixed

- Serialize daemon lifecycle admission and coordinator claims through the existing protected journal lock. Active installation work blocks a new claim or promotion; an unresolved coordinator execution blocks new installation work.
- Preserve cancellation, interrupted-operation receipts and completed hold release. Owner review reports the recovery blocker without dispatching a restart. Tests cover both admission orders, legacy overlap, shared locking and the real HTTP response.
- Use canonical private fixture state for the stricter shared journal reader. Deployment requires compatible queue and bootstrap readers together; existing live recovery remains separately owned.

## 0.11.0-beta.3.vorteo.551 - 2026-10-15

### Fixed

- Exclude completed claimed recoveries from active target selection while retaining full terminal-history verification. A completed historical recovery no longer competes with the current claim during Host recovery initialization.
- Test target selection, forged completion evidence and competing claims. This correction is prepared source; managed delivery and installed recovery acceptance remain open.

## 0.11.0-beta.3.vorteo.550 - 2026-10-15

### Fixed

- Persist Host daemon readiness before publishing the interface, and retain a separate interface-failure receipt with the prepared export path. A partial update no longer leaves its only phase receipt at activation intent.
- Keep errors explicit when readiness or publication-result storage fails after a verified restart. Test publication failure, unavailable receipt storage and refusal to replay; installed acceptance remains open.

## 0.11.0-beta.3.vorteo.550 - 2026-10-15

### Fixed

- Allow separately pinned repair admissions for later coordinator incidents while preserving earlier immutable receipts and plans.
- Resolve the proposal, controller and admitted runtime through the same digest-addressed directory. Invalid new records cannot fall back to historical authority.
- Verify owner authentication, legacy receipt preservation and refusal of altered or unsafe admission paths. Controller startup, installed routing and live recovery acceptance remain open.

## 0.11.0-beta.3.vorteo.549 - 2026-10-15

### Maintenance

- Combine installation reliability with the prepared sidebar, queue, replica cache, managed Claude CLI and toolbar source histories.
- Preserve the pinned provider dependency and both documentation inventories while advancing shared package versions. Source integration does not publish assets, install services or release the maintenance hold.

## 0.11.0-beta.3.vorteo.548 - 2026-10-15

### Fixed

- Recover an exact previous coordinator that starts after reboot, using fresh native identity and the approved compatible rollback. Freeze that writer before preserving journals and verify its exit before replacement.
- Refuse unrelated processes or stale boot identities. Resume the same verified writer when a busy journal prevents preservation, retaining the exhausted rollback budget and recovery requirement.
- Extend native adapter tests for successful recovery and refusal paths. Installed reboot acceptance and delivery remain open.

## 0.11.0-beta.3.vorteo.547 - 2026-10-15

### Maintenance

- Exercise Host activation after the published interface changes during the preparation window. Verify refusal before selection, restart or activation intent.
- Verify that a failed activation receipt prevents another restart through the same prepared update. Runtime behavior is unchanged; managed delivery and installed acceptance remain open.

## 0.11.0-beta.3.vorteo.546 - 2026-10-15

### Added

- Retain private coordinator runner phase evidence for renewal validation, ownership checks and watchdog readiness, with separate files for each attempt and bounded event history.
- Preserve the first failure category without exception text or stacks. Keep diagnostics outside lifecycle authority and allow recovery to continue when diagnostic storage fails.
- Test interrupted runners, pending validation, bounded records and unavailable storage. Document diagnostic limits; installed acceptance and delivery remain open.

## 0.11.0-beta.3.vorteo.545 - 2026-10-15

### Added

- Add scoped coordinator preparation and status commands with exact retained IDs, explicit owner-review support and coordinator review links. Lost replies can be inspected without contacting the Host daemon or exposing protected plans and credentials.
- Report connected Host maintenance capabilities and block new routine preparation while a retained operation is unfinished. Preserve exact manually reviewed recovery and recognize completed recovery ancestry. Keep authorization separate from runtime readiness and refuse unsupported automatic submission without a manual retry.
- Document the scoped workflow and validate HTTP status, CLI submission and capability negotiation. Installed acceptance and delivery remain open.

## 0.11.0-beta.3.vorteo.544 - 2026-10-15

### Fixed

- Negotiate retained startup plans in preclaim and claimed coordinator recovery reviews. Older clients can read projected requests and cancel, but cannot approve hidden startup evidence.
- Refuse preparation against Hosts that cannot review a retained startup plan. Show the original recovery service and pinned launcher details without implying permission to repeat the original update.
- Validate recovery transport, client negotiation and desktop and phone review controls. Installed acceptance and delivery remain open.

## 0.11.0-beta.3.vorteo.543 - 2026-10-15

### Fixed

- Report automatic Host requester authority separately for each daemon target. The legacy aggregate no longer implies that both daemons allow automation when only one permission is enabled.
- Verify separate permissions against tracked request decisions and preserve manual approval for Dev requesters. This source checkpoint does not deploy the changes.

## 0.11.0-beta.3.vorteo.542 - 2026-10-15

### Maintenance

- Add a negotiated public coordinator authorization view without private credential bindings or retry records. Older clients retain their existing response shape.
- Show automatic checks, retry exhaustion, cancellation timing and unconfirmed launches in Installation controls. Waiting automatic requests no longer imply owner approval is needed; execution receipts take precedence over inferred status.
- Keep cancellation accessible on desktop and phone layouts, and replace contradictory elapsed-time labels for automatic requests. Verify protocol negotiation, status transitions and rendered layouts.
- Scoped client commands, remaining recovery compatibility checks and installed acceptance remain unfinished. No runtime delivery is included in this source checkpoint.

## 0.11.0-beta.3.vorteo.541 - 2026-10-15

### Maintenance

- Connect automatic coordinator reconciliation to the existing maintenance tick, with one native call in flight and durable limits of three attempts per approval or dispatch phase.
- Preserve retry counts across coordinator restarts, the cancellation interval before dispatch, and the one-launch reservation. Late replies cannot overwrite newer approval or execution receipts.
- Omit private authorization and retry state from nested recovery responses as well as the main request list, preserving older review clients.
- Verify retry exhaustion, lost connections, phase changes and response compatibility. Public authorization status, scoped client commands and installed acceptance remain unfinished; automatic coordinator readiness is not advertised.

## 0.11.0-beta.3.vorteo.540 - 2026-10-15

### Maintenance

- Add scoped coordinator submission through the existing authenticated Host connection. Host requests can carry an exact protected proof when the separate coordinator permission is enabled; Dev requests and explicit owner-review requests remain manual.
- Return only the submitted request's review receipt. Unsupported authenticated submission fails without retrying as manual, and the Host connection closes after either success or failure.
- Add requester, proof, receipt and HTTP authentication tests. Automatic dispatch scheduling, public authorization status, scoped client commands and installed acceptance remain unfinished; coordinator automation is not advertised as ready.

## 0.11.0-beta.3.vorteo.539 - 2026-10-15

### Maintenance

- Reconcile coordinator automatic grants against the protected request ledger before acknowledging permission changes and during the existing maintenance tick. Credential rotation cancels stale queued grants without launching a replacement.
- Keep coordinator observation and revocation separate from native Host preparation, approval and dispatch. Refuse a changed installation, service or state directory.
- Verify credential revocation and HTTP failure handling. Automatic submission, dispatch scheduling, public status and installed acceptance remain unfinished.

## 0.11.0-beta.3.vorteo.538 - 2026-10-15

### Maintenance

- Record authenticated coordinator provenance atomically with preparation. Remove the later stamping operation so retries cannot convert an existing manual request to automatic authority.
- Bind scoped submission proofs to the exact request, reason, plan, policy activation and installation credentials. The native Host verifies the proof and current permission before committing preparation; generic daemon sessions cannot mint that authority.
- Retain a private monotonic preference timestamp so rapid disable and re-enable cannot revive an earlier activation. Public preference responses remain unchanged.
- Add proof, revocation, idempotency and client capability tests. The scoped HTTP route, timer integration, public authorization status and installed acceptance remain unfinished.

## 0.11.0-beta.3.vorteo.537 - 2026-10-15

### Maintenance

- Connect the internal coordinator reconciliation operation through a capability-gated Host RPC and client method. It accepts only an existing request identity, requires daemon-management access and cannot mint Host provenance or accept caller-supplied authority.
- Preserve old review responses by withholding internal authorization metadata. Focused tests cover unsupported Hosts, message correlation, permission refusal and attempts to reconcile an unauthenticated request.
- This transport step does not enable automatic coordinator submission. The scoped HTTP route, public authorization status, timer integration and installed acceptance remain unfinished.

## 0.11.0-beta.3.vorteo.536 - 2026-10-15

### Maintenance

- Reserve automatic coordinator dispatch in the protected request ledger before launching its executor. Lost replies cannot reserve another launch, and cancellation or permission revocation still prevents an undispatched native claim.
- Add internal automatic reconciliation to the existing Host maintenance service, preserving candidate validation and the manual approval path. Keep it unavailable during maintenance initialization or recovery refresh.
- Extend reservation and compatibility tests, and resolve Host test scripts relative to the test module so focused runs work from isolated worktrees. Scoped submission, public authorization status, timer integration and installed acceptance remain unfinished; automatic coordinator maintenance is not advertised.

## 0.11.0-beta.3.vorteo.535 - 2026-10-15

### Fixed

- Bind renewal startup recovery to the prepared setup before approval, then resolve the exact retained execution snapshot from its generation. The previous path comparison required the plan to pin a snapshot containing its own future approval revision and digest.
- Verify the prepared bytes, snapshot digest, approval identity and generation before recovery. Changed setup, substituted snapshots and mismatched generations are refused. Installed reboot acceptance remains open.

## 0.11.0-beta.3.vorteo.534 - 2026-10-15

### Maintenance

- Add protected coordinator authorization records bound to the current permission and installation credentials. Automatic approval requires compatible independent recovery, retains a thirty-second cancellation interval, and rechecks authority before claim.
- Preserve manual review and hide internal authorization metadata from older review clients. Tests cover cancellation during validation, revocation, credential changes and refusal of configuration or other service changes.
- This is an internal authorization foundation. Authenticated submission, managed automatic dispatch and installed acceptance remain unfinished; no new capability is advertised. Renewal startup recovery also needs its prepared setup and execution snapshot reconciled before delivery.

## 0.11.0-beta.3.vorteo.533 - 2026-10-15

### Changed

- Connect the separate supervisor permission to tracked Host maintenance requests. Bind automatic decisions to the configured plan, retain the cancellation interval, recheck plan and credential revocation before dispatch, and preserve explicit manual review.
- Fence automatic Dev maintenance after an uncertain supervisor result until a manually reviewed recovery succeeds. Retain the failed receipt and its recovery link across queue restarts.
- Report supervisor readiness and authority separately from daemon permissions, and support explicit manual supervisor requests in the scoped client.

### Maintenance

- Extend queue and HTTP tests for supervisor opt-in, revocation, plan changes, failed-operation recovery and legacy boundaries. Coordinator automatic authorization and installed acceptance remain open.

## 0.11.0-beta.3.vorteo.532 - 2026-10-15

### Fixed

- Allow read-only inspection of request-specific recovery services while retaining the Host account boundary. Startup registration previously used a label the inspector rejected.
- Resolve Apple's system-selected Python executable before verifying recovery startup. The launcher rewrites the executable and first process argument, so comparing against the wrapper path rejected valid startup.

### Maintenance

- Verify recovery-label refusal boundaries and actual interpreter identity in focused native tests. A disposable launchd job also passed identity checks and was removed; installed reboot recovery and automatic controller authorization remain open.

## 0.11.0-beta.3.vorteo.531 - 2026-10-15

### Fixed

- Recover an approved coordinator replacement after reboot when launchd retains the exact previous job without a process. Verify its loaded arguments and selected launcher before preserving idle state and unloading it; busy state, unrelated jobs and a job starting during observation refuse recovery.

### Maintenance

- Extend focused recovery coverage for retained stopped jobs. Native startup acceptance, automatic controller authorization and managed delivery remain open.

## 0.11.0-beta.3.vorteo.530 - 2026-10-14

### Changed

- Give startup recovery three persisted read-only dependency observations with five, fifteen and forty-five second delays. Require an approved, unchanged recovery generation before observing; exhausting the budget never retries a lifecycle operation.
- Retain startup diagnostics in a private request-specific log selected by the approved launcher.

### Maintenance

- Verify dependency readiness, exhaustion across observer restarts, and unchanged executor-exit observation behavior. Native startup-service acceptance and automatic controller authorization remain open.

## 0.11.0-beta.3.vorteo.529 - 2026-10-14

### Fixed

- Recognize an already completed coordinator rollback after its terminal receipt was lost. Verify the exact recovery runtime and launcher without repeating a lifecycle action or resetting its attempt budget.
- Preserve coordinator state after reboot when native boot identity proves the former writer ended and service absence excludes a replacement writer. Refuse busy, malformed or changed state.

### Maintenance

- Cover lost rollback receipts, changed observation ownership, reboot before and after preservation, and state refusal with focused watchdog and native adapter tests.
- Real startup-service acceptance, remaining boot interruptions, automatic controller authorization and managed delivery remain open.

## 0.11.0-beta.3.vorteo.528 - 2026-10-14

### Changed

- Bind optional coordinator startup recovery to the exact reviewed request, protected runner and startup configuration. Register it within the tracked execution fence before freezing the coordinator.
- Retain registration intent, reject repeated registration after an uncertain result, and remove only exact completed startup hooks.
- Distinguish native boot identity during recovery, refuse signals to pre-reboot PIDs, and preserve the one-rollback limit.
- Negotiate startup recovery review with compatible clients. Preserve older clients' cancellation without allowing approval of hidden startup settings.

### Maintenance

- Verify recovery identity, request binding, legacy review, registration failure, cleanup and client negotiation with focused tests.
- Native startup acceptance, early interruption recovery, completed rollback reconciliation and automatic controller execution remain open. Recovery begins after account login; this checkpoint does not claim pre-login recovery or deployed behavior.

## 0.11.0-beta.3.vorteo.527 - 2026-10-14

### Changed

- Separate Host, Dev, coordinator and supervisor maintenance permissions, with accessible explanations and independent readiness messages.
- Restrict automatic authorization to authenticated Host requests. Keep Dev and mixed-origin batches manual, revoke retained Dev grants, and preserve unaffected daemon permissions when one is disabled.
- Preserve existing daemon permissions during migration and leave new controller permissions off. Keep legacy preference responses readable by older clients.
- Verify an already completed coordinator replacement after executor failure before considering recovery; reject changed dispatch ownership during observation.

### Maintenance

- Verify permission isolation, owner authentication, stale edits, revocation, desktop and phone tooltip access, and persistence across browser reload.
- Automatic coordinator and supervisor execution, independent reboot recovery and installed acceptance remain unfinished. This checkpoint is prepared source, not a deployment.

## 0.11.0-beta.3.vorteo.526 - 2026-10-14

### Changed

- Show maintenance authority and readiness for every Host and Dev requester/target path, including unsupported coordinator behavior and distinct executor cleanup status.
- Bind automatic grants to policy and credential revisions, preserve a cancellation interval across queue recovery, and prepare approved source before holding turns.
- Retain durable preparation and activation receipts, refuse changed installed sources and repeated activation, and use atomic idle admission for automatic updates.
- Retain bounded coordinator failure diagnostics and a persisted three-attempt exit-observation budget; allow up to two minutes for replacement readiness.

### Maintenance

- Add queue cancellation, credential rotation, interrupted preparation and recovery tests; verify preference persistence and revocation in desktop and phone browser fixtures.
- Document readiness, operator actions and rollout limits. Reboot-persistent recovery and live installation acceptance remain unfinished; these changes are source preparation only.

## 0.11.0-beta.3.vorteo.530 - 2026-10-15

### Fixed

- Match GitHub and Commit toolbar controls to the adjacent 40px controls, with aligned centers, rounded hover backgrounds and no solid borders or split divider.

## 0.11.0-beta.3.vorteo.529 - 2026-10-14

### Maintenance

- Integrate the accepted managed Claude CLI contribution with the current interface, independent queue controls and replica cache changes, preserving all source histories and release notes.
- Keep source integration separate from installed package, account and profile acceptance; no runtime or credential change is included.

## 0.11.0-beta.3.vorteo.528 - 2026-10-14

### Maintenance

- Integrate the reviewed replica cache write deduplication and reconnect test maintenance while preserving canonical sidebar sizing, independent queue controls and all source histories.
- Retain unchanged-refresh eviction priority and recovery tails; ordinary streaming cache budgets and responsive resize costs remain unresolved.

## 0.11.0-beta.3.vorteo.527 - 2026-10-14

### Maintenance

- Reconcile the published sidebar card sizing and queue independence source histories while preserving both implementations and all release notes. Runtime activation remains a separate delivery step.

## 0.11.0-beta.3.vorteo.526 - 2026-10-15

### Fixed

- Keep message-queue delivery independent from manual Stop: stopping a goal leaves an active queue running and preserves an explicitly paused queue.
- Revoke automatic goal resumption on Stop without changing queued messages, including when the provider cannot confirm the goal pause.

## 0.11.0-beta.3.vorteo.526 - 2026-10-14

### Fixed

- Let Files and other embedded sidebar panels use the available card height instead of a fixed 360px body.
- Keep single-line grid buttons exactly as tall as full-width accordion headers by sharing the parent grid inset. Wrapped icon and count buttons can still grow taller.
- Check header heights and full-height Files allocation in the browser at three sidebar widths.

## 0.11.0-beta.3.vorteo.526 - 2026-10-14

### Fixed

- Select the release-pinned Claude Code 2.1.284 package for managed default and appended commands, including daemon queries and coordinator login construction.
- Refuse missing, mismatched or substituted package payloads without falling back to PATH. Preserve standalone launches and explicit replacement commands.

### Maintenance

- Reconcile the accepted Claude contribution with current installed source and interface ancestry, retaining package exports and current workspace versions. Installed account and profile acceptance remains open.

## 0.11.0-beta.3.vorteo.525 - 2026-10-15

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.524 - 2026-10-14

### Maintenance

- Integrate coordinator recovery corrections with the current published interface, preserving both histories and existing theme behavior.
- Keep Host installation and coordinator replacement separately reviewed through tracked controls.

## 0.11.0-beta.3.vorteo.524 - 2026-10-14

### Fixed

- Skip identical replica cache storage writes while preserving refresh recency, cross-host eviction priority, baseline replacement and timeline recovery tails.

### Maintenance

- Cover separate and shared persistence batches, unchanged baseline survivors after reload and mixed deletions in cache regressions.
- Match browser reconnect assertions to the existing Reconnecting host label. Ordinary streaming write budgets and responsive resize costs remain unresolved.

## 0.11.0-beta.3.vorteo.523 - 2026-10-14

### Fixed

- Restore balanced left and right margins on top-level sidebar projects while preserving workspace indentation on tablet and desktop layouts.

## 0.11.0-beta.3.vorteo.522 - 2026-10-14

### Improved

- Restore saved startup colors before the first paint, then fade the large loader into the themed interface over 350ms without delaying initialization.
- Preserve the dark fallback when browser storage is unavailable, respect reduced motion, and keep temporary theme previews out of the startup cache.
- Match the welcome screen's background decoration to the selected theme alongside its existing themed controls.

## 0.11.0-beta.3.vorteo.521 - 2026-10-14

### Added

- Add whole-interface zoom beside the theme swatches in browser Settings and the sidebar menu, with a 75% to 200% slider, smaller/larger steps and a 100% reset.
- Remember zoom on the current browser and scale text, icons and controls together. Keep responsive layouts, anchored overlays, resizing and scroll positions in logical interface coordinates.

## 0.11.0-beta.3.vorteo.520 - 2026-10-14

### Fixed

- Reduce unused default composer height on touch tablets while retaining full-sized controls and draft growth.
- Align recording and text-entry bottom controls with their side insets.

- Prepare separately reviewed coordinator successors after an exact failed generation that never acquired promotion authority, preserving the original approval and failure.
- Verify the unchanged coordinator and reject promoted failures, competing repairs, altered history and changed process identity. Order retained sidecar ancestry by exact recovery references.
- Cover real admission, durable claims, selection and compatible rollback with disposable fixtures; live recovery remains subject to tracked delivery and approval.

## 0.11.0-beta.3.vorteo.519 - 2026-10-14

### Fixed

- Give details-card bodies a shared 8px bottom clearance, including Queue, Tasks, subagents, Goal, Journal and embedded file/change panels.
- Preserve tight heading spacing while keeping the final entry clear of the card edge.

- Validate completed repair runtimes against their exact retained history so later coordinator claims do not create a circular validation dependency.
- Keep current dispatch validation on the complete history and reject changed or missing historical authority. Failed live generations still require managed recovery.

## 0.11.0-beta.3.vorteo.518 - 2026-10-14

### Maintenance

- Preserve the installed compact card and accordion refinements while adding the recording queue control.

### Fixed

- Keep coordinator approval responses open through long protected-release verification instead of abandoning them after fifteen minutes.
- Preserve exact decision identity and cancellation behavior; delayed responses never resend approval.

## 0.11.0-beta.3.vorteo.517 - 2026-10-14

### Fixed

- Show Queue while recording on tablets and desktops, immediately left of Submit along the bottom action row.
- Preserve independent queue, send, edit and cancel actions and disable duplicate actions during transcription.

### Maintenance

- Preserve the installed project-child indentation while integrating compact card hover labels, balanced button spacing and full-width collapsed sidebar headers.

- Allow maintenance clients to wait longer for coordinator preparation without changing capability checks or approval rules.
- Cover delayed preparation success and validation errors without sending another request or decision.

## 0.11.0-beta.3.vorteo.516 - 2026-10-14

### Fixed

- Show compact details-card tooltips when using a mouse or trackpad on narrow and touch-capable screens, while preserving long-press labels.
- Shorten stacked compact card buttons while keeping their hover insets balanced and touch targets at least 44 pixels tall.

### Changed

- Show full-width accordion headers and actions when every sidebar card is collapsed; retain grids for mixed sidebar layouts and embedded footers.
- Preserve the installed theme-aware logos, reset alignment and startup recovery contrast.
- Restore visible project-child indentation for workspace rows and their New workspace and Show more controls, including touch tablets.

### Maintenance

- Integrate the coordinator PID-reuse correction with the published theme-aware logos, reset alignment and sidebar changes, preserving their behavior and release history.
- Keep coordinator and Dev installation approval separate from this source integration.

## 0.11.0-beta.3.vorteo.515 - 2026-10-14

### Fixed

- Keep early startup recovery text readable against the remembered theme background.

## 0.11.0-beta.3.vorteo.514 - 2026-10-14

### Maintenance

- Preserve the installed embedded-card spacing and viewport limits while integrating reset-label alignment and theme-aware logos.

## 0.11.0-beta.3.vorteo.513 - 2026-10-14

### Changed

- Match embedded Vorteo marks to the selected theme: original rainbow artwork for Starship, shaded white for Dark Star, and palette gradients for Scriptorium, Midas, Ember and Neon.
- Share logo selection across page loaders, welcome and project screens, and retain validated palette colors for the early startup loader.

- Show full-width accordion headers with actions when every sidebar details card is collapsed.
- Keep compact grids for mixed sidebar layouts and embedded footer cards.

## 0.11.0-beta.3.vorteo.512 - 2026-10-14

### Fixed

- Center compact account reset outlines with their labels when touch accessibility enlarges the button target.
- Keep reset-dialog browser screenshots inside the test workspace.

### Changed

- Restore the half-viewport height limit for cards embedded in the main content region while allowing sidebar cards to fill available height.
- Remove redundant fade clearance below embedded cards to reduce the gap above the message box.

## 0.11.0-beta.3.vorteo.511 - 2026-10-14

### Maintenance

- Preserve installed details-card refinements while integrating the mobile New workspace layout and radar loading rings.

## 0.11.0-beta.3.vorteo.510 - 2026-10-14

### Maintenance

- Reconcile the validated mobile workspace layout and radar loading rings with the installed coordinator history and Dev repair controls, preserving both source histories.
- Preserve the latest installed recovery controls while delivering the card footer, tooltip, count and height refinements.

## 0.11.0-beta.3.vorteo.506 - 2026-10-14

### Changed

- Enlarge the page-loading ring by 25% while preserving the shaded V size.
- Use a shared radar fade for loading rings, including sidebar activity dots and queued-message saving indicators.

### Fixed

- Place the mobile New workspace title and selected project in the standard two-line header, clear of the menu button.
- Fill the available mobile height without blank metadata spacer rows or duplicate bottom safe-area padding.
- Integrate footer placement, collapsed-card tooltips, single-line counts and full sidebar height allocation with the latest installed source.
- Preserve the reviewed managed-worker and recovery updates.

### Maintenance

- Match the packaged Dev repair assertion to the rendered guidance. Desktop and phone checks verify preparation, duplicate-action prevention, available cancellation and separate installation approval.

## 0.11.0-beta.3.vorteo.509 - 2026-10-14

### Maintenance

- Combine 1 source contributions; retain their release notes below

### Fixed

- Allow coordinator successor validation when a retired executor's process number has been reused, using two matching native observations of a strictly later birth in the same boot.
- Keep failed inspection, changed command arguments, unstable observations and mismatched process ownership from counting as proof of exit.

## 0.11.0-beta.3.vorteo.508 - 2026-10-14

### Fixed

- Let a promoted coordinator successor read its exact recovered predecessor from pending history without promoting that predecessor or admitting unrelated pending work.
- Reject missing or changed recovery references and preserve journal bytes while evaluating startup and release fences.

## 0.11.0-beta.3.vorteo.507 - 2026-10-14

### Maintenance

- Reconcile validated Dev repair controls with the prepared capacity update and latest published card layout, preserving both source and release histories.
- Keep this preparation isolated from the pending Host update. Installed repair acceptance still requires compatible coordinator delivery and Dev recovery.

## 0.11.0-beta.3.vorteo.505 - 2026-10-14

### Fixed

- Refuse Dev repair preparation at the client when coordinator support becomes unavailable, before sending a request.

### Maintenance

- Extend packaged desktop and phone coverage for repair preparation, continued cancellation and separate installation approval.

- Combine 1 source contributions; retain their release notes below

### Changed

- Keep card counts on one line, remove collapsed count backgrounds and show minutes in narrow goal buttons.
- Allocate sidebar height by collapsed grid row so expanded cards fill the remaining space. Remove the half-viewport limit for embedded cards.
- Add bottom padding to Goal and Journal.

## 0.11.0-beta.3.vorteo.504 - 2026-10-14

### Added

- Add owner-started Dev source repair preparation in Installation controls. Capture the installed Host source and queued contributions, persist preparation history, and require a separate exact installation review.

### Fixed

- Discard late repair results after cancellation or changed contributions, and report interrupted preparation without replaying it. Preserve finite and uncapped worker profile source in the same delivery ancestry.

### Maintenance

- Reconcile reviewed managed-worker capacity with the installed Host recovery release, preserving both source histories and the current interface.
- Prepare Host delivery only. Dev recovery, coordinator compatibility, explicit profile selection and a reviewed successor remain required before uncapped operation.

### Changed

- Add collapsed-card tooltips on hover, keyboard focus and long press.
- Move every details card into the focused conversation's footer when the sidebar closes, including files and changes. Restore the sidebar placement when it opens.
- Keep collapse preferences across these moves, so minimized cards remain a compact grid row. Keep queue actions active at their visible destination.

## 0.11.0-beta.3.vorteo.503 - 2026-10-14

### Added

- Add an explicit Uncapped option to managed-worker profiles on compatible installations. Keep finite limits, quota handling and frozen running-task policies intact.
- Require every configured environment to support uncapped profiles before saving or projecting that policy.

### Fixed

- Preserve uncapped policies when older editors omit the new field, while honoring intentional defaults resets and explicit finite overrides.

### Maintenance

- Validate finite and uncapped admission, profile editing, synchronization and quota boundaries. Existing tasks require the reviewed successor workflow to change their frozen worker policy.

### Changed

- Tile adjacent collapsed details cards into responsive rows in the sidebar and conversation footer. Expanded cards occupy a full row.
- Hide heading actions, then titles, as collapsed tiles narrow. Keep icons and counts visible, with full controls restored on expansion.

## 0.11.0-beta.3.vorteo.502 - 2026-10-14

### Development

- Added inert Dev repair bundle preparation from captured installed source, rejecting lost contributions and changed source selection; owner controls are not yet connected

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.501 - 2026-10-14

### Maintenance

- Preserve Theme's retained-panel validation follow-up in the recovery delivery integration

## 0.11.0-beta.3.vorteo.500 - 2026-10-14

### Maintenance

- Preserve the published loading-indicator refinement alongside coordinator recovery and Dev source-queue corrections

## 0.11.0-beta.3.vorteo.499 - 2026-10-14

### Fixed

- Validate coordinator successors against protected claimed-recovery receipts when the retired updater never created a legacy executor record; retain native exit checks and reject changed recovery evidence

### Tests

- Verify the loader becomes invisible when retained content finishes loading, and confirm the conversation appears. Preserve failure screenshots before fixture cleanup. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.498 - 2026-10-14

### Fixed

- Reconciled stale source conflicts when a later validated contribution contains the exact original commit, retaining provenance and rejecting damaged bundles

### Changed

- Preserve the standard white V's light shading in the startup loader and center the same stationary mark inside medium page-loading rings.
- Keep small status spinners unchanged. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.497 - 2026-10-14

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.496 - 2026-10-14

### Fixed

- Allowed installed coordinator recovery controls to validate their own runtime modules while retaining selected-release and process checks

## 0.11.0-beta.3.vorteo.495 - 2026-10-14

### Fixed

- Moved coordinator recovery and repair setup notices into the sidebar status rows so they no longer cover message controls

## 0.11.0-beta.3.vorteo.494 - 2026-10-14

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.493 - 2026-10-14

### Fixed

- Keep repair setup available if pending-review verification fails after runtime admission. A retry reuses the same protected receipt without repeating recovery effects or hiding the unfinished setup.
- Preserve the existing interface and repair review behavior. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.492 - 2026-10-14

### Added

- Enable protected coordinator repair setup from existing Installation controls, with a sidebar notice and exact source and artifact details. Owner authentication admits only the pinned proposal and prepares a pending recovery review without stopping processes.
- Keep recovery approval separate from setup and refuse changed proposal bytes, stale claims and unauthenticated requests. Preserve retained admission and approval history on reconnection.
- Validate setup authentication and desktop and compact controls. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.491 - 2026-10-14

### Added

- Add owner-authenticated provisioning for a protected coordinator repair runtime when the installed Host cannot recover a claimed executor. Bind repair review to the exact original approval, process identity and immutable artifact.
- Show independently provisioned repair requests in existing Installation controls and the sidebar. Preserve cancellation before dispatch and observation-only reconciliation after uncertain completion.

### Fixed

- Fence an unpromoted coordinator claim under the existing journal lock before bounded recovery effects, preserving approval history, selected configuration and successor verification.
- Integrate the current interface changes and both branches' release history. Native disposable recovery, retained-effect observation and successor checks pass; installation acceptance remains separate. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.490 - 2026-10-14

### Fixed

- Round question-card action buttons to match the top controls and center their icons and labels within a shared 44px minimum height.
- Verify action geometry and submission at phone, iPad and desktop widths. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.489 - 2026-10-14

### Fixed

- Keep the inline queue controller active when the details sidebar is hidden so queued-message actions remain usable.
- Check that Send stays enabled after moving the queue between locations. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.488 - 2026-10-14

### Fixed

- Remount the queue portal when its destination changes so opening and closing the details sidebar moves the queue to the correct location.
- Packaged browser checks cover both directions. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.487 - 2026-10-14

### Changed

- Keep queued messages at the bottom of the conversation when the desktop details sidebar is closed, with other details remaining in their sidebar.
- Show saving progress in the row and sending progress around its Send arrow. Preserve action positions and remove transient progress text from the heading and below rows.
- Add queue visibility and stable-height progress coverage. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.486 - 2026-10-14

### Fixed

- Remove duplicate bottom safe-area padding from web thread and draft composers so their bottom edges align with the sidebar on iPad. Preserve native safe-area padding and the desktop 8px margin.
- Reproduce the previous 20px offset using browser safe-area emulation and check tablet portrait, landscape and short desktop windows. README overview and onboarding are unchanged.

### Added

- Add separately reviewed recovery for a claimed coordinator executor, with exact native identity checks, atomic exclusion against promotion and durable one-shot effects.
- Expose capability-gated recovery review and observation controls. Preserve original approval history and reject implicit approval from older clients.
- Require the verified recovery witness in successor renewal and watchdog checks, and refresh maintenance readiness after recovery.
- Retain recovery-required status when coordinator ownership validation fails.
- Keep status readers out of the executor's mutation lock while preserving protected-directory checks.
- Resolve the browser provider beside the shared test runner on fresh workspace installs.

### Validation and limits

- Validate disposable native recovery and retained observation without replay, plus current-source owning, client and desktop/compact browser checks.
- Safe managed installation and live Factory activation remain unfinished. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.485 - 2026-10-13

### Fixed

- Preserve the shared 8px composer bottom inset at narrow desktop widths, including short windows, while retaining the wider iPad layout.
- Check the inset at narrow and wide desktop sizes across window heights. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.484 - 2026-10-13

### Maintenance

- Check the shared 44px touch minimum in the tablet Commit-button regression. The packaged tablet, wide-desktop and phone flow passes; application behavior is unchanged.
- README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.483 - 2026-10-13

### Fixed

- Keep the outward sidebar grip above the adjacent scrolling pane so touch hits resize the sidebar.
- Retain the tablet layout checks against the packaged interface. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.482 - 2026-10-13

### Changed

- Widen and lower the narrow-desktop composer, align it with the first tab, and show workspace context in taller selected tabs when navigation is collapsed.
- Preserve the conversation fade behind taller tabs and increase icon-to-text spacing.
- Support browser touch and pen resizing with handles centered in sidebar gutters.
- Give the Commit split button sufficient content height, padding and rounded corners.

### Maintenance

- Add tablet touch, alignment, clipping and responsive regression coverage. README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.481 - 2026-10-13

### Maintenance

- Reveal supporting cards after reload in the desktop checklist regression so it checks visible controls and persisted counts.

## 0.11.0-beta.3.vorteo.480 - 2026-10-13

### Fixed

- Show completed / total task counts and read / total journal counts without visible status suffixes.
- Preserve the fixed disclosure-button height on native platforms so card titles and count text render correctly.
- Verify journal progress against read rows in desktop and phone browser checks.

## 0.11.0-beta.3.vorteo.479 - 2026-10-13

### Maintenance

- Require early recommendations to split sprawling agent work into focused workspaces with explicit outcomes, preserved handoffs and coordinated delivery. Accept owner-confirmed daily use as acceptance for the reported behavior.

## 0.11.0-beta.3.vorteo.478 - 2026-10-13

### Validation

- Correct the demo browser check to include the shared outer inset in the desktop tab-row height. The full navigation, theme selection and keyboard rail flow passes against the existing production interface; product behavior is unchanged.

## 0.11.0-beta.3.vorteo.477 - 2026-10-13

### Appearance

- Add 12px above question answer controls and below the action row, keeping prompts, inputs and buttons clear of each other and the card edge. Verify desktop and phone spacing alongside question navigation and submission.

## 0.11.0-beta.3.vorteo.476 - 2026-10-13

### Appearance

- Show the matching left-pointing open arrow on the right sidebar toggle while collapsed. Keep the plain panel icon while expanded.

## 0.11.0-beta.3.vorteo.475 - 2026-10-13

### Appearance and validation

- Fit short project popups to their measured content while keeping long lists scrollable.
- Update compact sidebar sizing and browser checks for the 56px rail, current navigation menu placement, and workspace action labels. Verify project popup indicators, tail alignment, nested Rename dialog and touch navigation.

## 0.11.0-beta.3.vorteo.474 - 2026-10-13

### Appearance

- Widen the compact sidebar to 56px and give project popups an anchored tail. Reuse the complete sidebar project list, including workspace status, task flowers, metadata, managed groups and row actions. Clicked popups stay open while their menus and dialogs are used.

## 0.11.0-beta.3.vorteo.473 - 2026-10-13

### Validation

- Refresh the column resize check for aligned composer and sidebar bottoms and the shared toolbar toggle location. The resize-handle interface change is unchanged.

## 0.11.0-beta.3.vorteo.472 - 2026-10-13

### Appearance

- Anchor the right sidebar resize target and highlight to the card body, below its toolbar. Verify the handle stays aligned with the card stack during resizing.

## 0.11.0-beta.3.vorteo.471 - 2026-10-13

### Appearance

- Give Journal prose the same right inset as Goal text. Share that clearance with task errors and queue status and recovery text while preserving timeline and control alignment.

## 0.11.0-beta.3.vorteo.470 - 2026-10-13

### Appearance

- Let shared card drag columns retain their compact width on mobile web instead of inheriting the global 44px button minimum. Preserve their full height and drag gesture handling; other touch controls keep their existing minimum size.

## 0.11.0-beta.3.vorteo.469 - 2026-10-13

### Validation

- Check mobile task handle spacing in the editable-checklist fixture, where drag handles exist, alongside its keyboard reorder exercise. Keep queue media spacing in the shared card fixture; interface behavior is unchanged from the preceding candidate.

## 0.11.0-beta.3.vorteo.468 - 2026-10-13

### Appearance

- Bring mobile task checkboxes and queue attachment tiles 10px closer to their drag handles. Share the leading group and handle geometry, preserve heading centerlines and full-height controls, and cover both rows in the production browser layout check.

## 0.11.0-beta.3.vorteo.467 - 2026-10-13

### Appearance

- Remove the visible loading caption and give the thin ring a bright leading edge with a fading radar sweep. Keep the stationary V, accessible loading label, reduced motion and delayed recovery help.

## 0.11.0-beta.3.vorteo.466 - 2026-10-13

### Appearance

- Add 4px of clearance below the left sidebar toolbar buttons, moving the divider down without moving the controls.

## 0.11.0-beta.3.vorteo.465 - 2026-10-13

### Appearance

- Tighten the Files sorting toolbar around its existing controls and reduce the file list top inset to 2px.

## 0.11.0-beta.3.vorteo.464 - 2026-10-13

### Validation

- Check alignment of visible heading elements while allowing labels and chevrons to disappear in compact disclosures. Desktop and phone card interactions, narrow expansion and restored spacing pass.

## 0.11.0-beta.3.vorteo.463 - 2026-10-13

### Appearance

- Restore the 8px gap between details cards. Shared disclosure headings hide labels and chevrons when space is tight, and retain trailing chips only when they fit beside the icon.
- Check narrow heading expansion, overlap and restoration while resizing the actual sidebar.

## 0.11.0-beta.3.vorteo.462 - 2026-10-13

### Appearance

- Give the early app loading screen a 160px hairline ring around the white Vorteo silhouette. Embed the mark so it appears before assets load, preserve delayed recovery help, and stop rotation for reduced motion.

## 0.11.0-beta.3.vorteo.461 - 2026-10-13

### Appearance

- Thin shared small loading spinners to a 1px stroke, including the coordinator update row, while preserving their size and animation.

## 0.11.0-beta.3.vorteo.460 - 2026-10-13

### Appearance

- Share row layout across task, queue and inline subagent cards. Give subagent and bulk-action icons a fixed leading column aligned with the heading, with consistent spacing before their labels.
- Check subagent icon centerlines and label clearance in desktop and phone browser layouts.

## 0.11.0-beta.3.vorteo.459 - 2026-10-13

### Validation

- Measure actual sidebar toolbar controls when checking adjacent targets; exclude hidden menu triggers.

## 0.11.0-beta.3.vorteo.458 - 2026-10-13

### Appearance

- Place adjacent sidebar toolbar buttons edge to edge within each group, retaining the flexible space between the left and right groups.

## 0.11.0-beta.3.vorteo.457 - 2026-10-13

### Appearance

- Keep truncated-text tooltip anchors passive so clicks reach their parent row. Verify subagent navigation as well as tooltip dismissal.

## 0.11.0-beta.3.vorteo.456 - 2026-10-13

### Appearance

- Reveal truncated task titles, queued messages, subagent labels and metadata, card headings and file/folder names in non-interactive hover tooltips. Include available task context and preserve row actions and touch behavior.

## 0.11.0-beta.3.vorteo.455 - 2026-10-13

### Appearance

- Use the four-task flower’s narrow petals and center gap for three-task flowers.

## 0.11.0-beta.3.vorteo.454 - 2026-10-13

### Appearance

- Keep Queue status before its count so every heading chip occupies the trailing edge of the disclosure.
- Update journal inset checks for the shared 44px geometry and wait for the visible goal notice before measuring it during viewport changes.

## 0.11.0-beta.3.vorteo.453 - 2026-10-13

### Appearance

- Align static question-card heading icons with the shared 44px heading centerline.
- Update the design guide to document fixed control heights, right-aligned heading chips and fully rounded hover corners.

## 0.11.0-beta.3.vorteo.452 - 2026-10-13

### Appearance

- Give sidebar card heading buttons a fixed 44px height and the containing card's 16px radius on all four corners, whether expanded or collapsed.
- Align count chips at the right inside each heading's hover target. Show goal elapsed time in the same chip on desktop and mobile.
- Preserve the shared icon centerline for sidebar projects, journal markers and row handles; validate heading geometry and chip alignment in browser checks.

## 0.11.0-beta.3.vorteo.451 - 2026-10-13

### Appearance

- Keep expanded General settings details, coordinator history, shared workflows and restart history inside shaded regions beneath their parent. Remove internal section dividers and use a second shade for nested details.
- Keep linked historical restart requests inside expanded history while preserving their focus and approval boundaries. Add desktop and phone hierarchy checks.

## 0.11.0-beta.3.vorteo.450 - 2026-10-13

### Appearance

- Remove extra vertical padding around queue row actions. Keep sidebar action tooltips hover-only so touch opens menus directly.
- Update browser checks for the tighter body clearance and verify project and workspace menu tooltips alongside sidebar alignment, hover feedback and Settings placement.

## 0.11.0-beta.3.vorteo.449 - 2026-10-13

### Appearance

- Equalize card heading insets at 2px, 3px and 4px, reduce heading-to-content and card gaps, and remove extra subagent row padding without shrinking touch targets.
- Give sidebar toolbar controls matching sizes, align their first icon with project icons, and detach toolbar height from central tabs. Restore overflow and New workspace hover feedback, add row menu tooltips, and omit duplicate Settings entries and empty menu groups.

## 0.11.0-beta.3.vorteo.448 - 2026-10-13

### Tests

- Supply the shared button opacity token in the script-toolbar test theme so the direct ghost control runs through the real button component.

## 0.11.0-beta.3.vorteo.447 - 2026-10-13

### Appearance

- Keep workspace tabs at the Latest control's 44px height and pill radius. Use borderless run controls with hover feedback, and align the upper-right toolbar's top and right insets. Tab centers continue to follow sidebar spacing without stretching the buttons.

## 0.11.0-beta.3.vorteo.446 - 2026-10-13

### Security

- Update node-forge to 1.4.0 with a scoped EAS override. Disposable certificate tests verify Expo signing against Node's verifier and EAS archive reading, including incorrect-password rejection. One upstream signature-verification advisory remains unresolved; this is not a complete certificate-security repair. Installed applications and services remain unchanged.

## 0.11.0-beta.3.vorteo.445 - 2026-10-13

### Security

- Scope xmldom 0.8.15 to the older Expo property-list package. Validate EAS file reading and writing, synthetic provisioning metadata, malformed input rejection and identifier matching without network requests or credentials. The override removes the remaining older XML parser copy; installed applications and services remain unchanged.

## 0.11.0-beta.3.vorteo.444 - 2026-10-13

### Security

- Update eight compatible XML parser copies to xmldom 0.8.15. Property-list round trips preserve values and escaping; parser checks reject the CDATA markup injection reproduced in the old dependency. The older Expo property-list parser remains under review. These source updates do not change installed applications or services.

## 0.11.0-beta.3.vorteo.443 - 2026-10-13

### Fixes

- Preserve logging when optional pretty formatting rejects an entry. Write the already-serialized, redacted JSON as a fallback and continue formatting subsequent messages. Regression checks cover stdout and file destinations, retained entries and authorization redaction. JSON defaults are unchanged; installed daemon delivery remains pending.

## 0.11.0-beta.3.vorteo.442 - 2026-10-13

### Security

- Refresh fast-copy to 4.1.2 for the optional pretty-log formatter. Nested values retain copy isolation; excessive depth produces the library's explicit limit error instead of stack exhaustion. Existing logger configuration and redaction tests pass. This does not add recovery from rejected log entries or update the installed daemon.

## 0.11.0-beta.3.vorteo.441 - 2026-10-13

### Security

- Add a local Braces 3.0.3 patch that bounds parser nesting and recursive syntax-tree traversal. Excessively nested patterns now fail with a deliberate syntax error before exhausting the stack. Normal ranges, alternatives, escaping, quotes and file discovery pass regression checks. The standard postinstall workflow reapplies the patch; version-based audits still report the upstream dependency. Installed services are unchanged.

## 0.11.0-beta.3.vorteo.440 - 2026-10-13

### Security

- Scope minimatch 5.1.9 to EAS while upstream retains its older exact pin. Provisioning-profile identifier validation preserves exact and wildcard matches and rejects mismatches. A bounded worker reproduces the old matcher stall and verifies the updated matcher returns; its brace-expansion dependency also passes allocation-limit checks. No installed services or credentials are changed.

## 0.11.0-beta.3.vorteo.439 - 2026-10-13

### Security

- Refresh compatible file-pattern dependencies. Focused checks cover inherited POSIX class names, bounded brace expansion, file discovery, exclusions and hidden files. EAS's pinned matcher and the separate Braces dependency remain under review. These source changes do not update installed services.

## 0.11.0-beta.3.vorteo.438 - 2026-10-13

### Security

- Refresh compatible js-yaml, smol-toml and compression dependencies. Bounded checks cover YAML merge budgets, desktop update metadata parsing, Knip's TOML loader and native compression cleanup after a client disconnect. The old compression version fails the cleanup regression. Source preparation does not update the installed desktop application or development services.

## 0.11.0-beta.3.vorteo.437 - 2026-10-13

### Security

- Scope patched Undici 7.30.0 and Sharp 0.35.5 to Miniflare while its upstream releases retain affected pins. Validate all three Miniflare consumers through local requests, PNG inspection and resizing, SVG conversion and malformed metadata rejection. Website production build and invalid WebSocket handshake regression pass; other operating systems and installation remain unverified.

## 0.11.0-beta.3.vorteo.436 - 2026-10-13

### Security

- Refresh Expo's compatible Undici dependency and wait-on's Axios dependency. A bounded worker regression reproduces the old invalid WebSocket handshake crash and verifies safe rejection after the update; normal JSON and readiness checks pass. Miniflare's separately pinned clients remain under review. No installed service is updated.

## 0.11.0-beta.3.vorteo.435 - 2026-10-13

### Fixes

- Keep diagram controls visible on touch and compact layouts with 44-pixel targets. Empty toolbar overlays no longer intercept canvas input. Add a real-browser touch regression for fullscreen opening and closing without hover.

## 0.11.0-beta.3.vorteo.434 - 2026-10-13

### Maintenance

- Reconcile the tested security candidate with the installed repair-notification fix, preserving both histories. Prepare compatible Markdown and diagram runtime changes for static publication; desktop and server fixes still require their separate supported installation workflows.

## 0.11.0-beta.3.vorteo.433 - 2026-10-13

### Security

- Update the compatible fast-uri dependency to 3.1.8. Tests flag ambiguous authorities and preserve local schema references and validation. Reviewed schema consumers use synchronous compilation without remote loaders; no application SSRF path was established. Installation remains pending.

## 0.11.0-beta.3.vorteo.432 - 2026-10-13

### Security

- Refresh compatible Express, body-parser and qs dependencies. Loopback checks preserve normal JSON requests, reject malformed and oversized bodies, and fail closed on an invalid configured limit. Query checks cover prototype keys and nullable comma arrays. No daemon was started or updated.

## 0.11.0-beta.3.vorteo.431 - 2026-10-13

### Security

- Pin the server and Nova bridge MCP SDK to 1.32.1, which includes the OAuth authorization-server validation fix. Recheck the internal schema helpers and run MCP server, bridge and tool regressions. No current application OAuth-provider configuration was found; installation remains pending.

## 0.11.0-beta.3.vorteo.430 - 2026-10-13

### Security

- Update DOMPurify to 3.4.17 and regenerate the embedded Mermaid runtime so diagrams use the updated sanitizer. Diagram policy, sizing, streaming and iframe checks pass. No application use of the advisories' in-place sanitization mode was established; installation remains pending.

## 0.11.0-beta.3.vorteo.429 - 2026-10-13

### Security

- Update chat search and the default Markdown renderer to markdown-it 14.3.2 and linkify-it 5.0.2, matching the main message renderer. Search, parser and browser checks preserve formatting and reject active markup. Installation and the broader security review remain open.

## 0.11.0-beta.3.vorteo.428 - 2026-10-13

### Security

- Scope EAS CLI's tar dependency to 7.5.22 and preserve its upload helper's CommonJS interop through the existing postinstall patch workflow. Test the actual archive creation and JavaScript extraction helpers with synthetic files and a stubbed upload transport. All tar consumers now resolve the patched version; deployment and broader security review remain open.

## 0.11.0-beta.3.vorteo.427 - 2026-10-13

### Security

- Override only oxfmt's Tinypool dependency to 2.1.2, preserving the existing formatter version. A bounded worker test reproduces inherited filename selection before the update and rejects it afterward. TypeScript, Markdown, YAML, JSON and HTML formatting samples remain byte-identical.

## 0.11.0-beta.3.vorteo.426 - 2026-10-13

### Security

- Require Vitest and its browser/UI companions at 4.1.11 or later within version 4. Keep usage-test screenshots inside the project because the patched browser runner now enforces file-access restrictions. Existing security-related unit tests and desktop/phone Chromium usage checks pass; this is development tooling and does not change the installed interface.

## 0.11.0-beta.3.vorteo.425 - 2026-10-13

### Security

- Update electron-builder to 26.15.3 and resolve electron-updater to 6.8.9 with builder-util-runtime 9.7.0. Verify sensitive headers are removed across redirect origin changes while same-origin authentication remains intact. Desktop updater tests, compilation and an unsigned disposable packaging check pass; application installation and signed release validation remain separate.

## 0.11.0-beta.3.vorteo.424 - 2026-10-13

### Security

- Backport image parser progress guards for Metro's image-size dependency through the existing postinstall patch workflow. Both Metro copies reject malformed ICNS, JXL and HEIF data disguised as PNG files, with ordinary image dimensions preserved. The bounded baseline reproduces an ICNS stall; this build-tool fix is prepared source and does not update the installed app.

## 0.11.0-beta.3.vorteo.423 - 2026-10-13

### Security

- Update the compatible Concurrently dependency to 9.2.5, shell-quote to 1.12.0 and six tooling tar dependencies to 7.5.22. Add bounded argument-quoting and archive-extraction checks through their actual consumers. EAS CLI's separate tar dependency remains affected; this preparation does not update the installed application.

## 0.11.0-beta.3.vorteo.421 - 2026-10-13

### Security

- Resolve Seroval to 1.6.9 and proxy-addr to 2.0.8 without changing unrelated dependencies. Add bounded regressions for malformed typed-array deserialization and IPv4 trust under short mapped IPv6 subnets, alongside valid serialization and proxy configuration checks. The website production build and focused server/website tests pass; deployment remains separate from source preparation.

## 0.11.0-beta.3.vorteo.420 - 2026-10-13

### Security

- Prompt embedded desktop sites for camera, microphone, location and notification access, with an optional remembered Allow or Block choice. Isolate choices by permission and site context; discard responses after navigation or reset. Add a Settings reset control that retains sign-ins, atomic local persistence and unit and real Electron coverage using synthetic media devices. Desktop delivery remains pending; the installed web interface is unchanged.

## 0.11.0-beta.3.vorteo.419 - 2026-10-13

### Security

- Validate every desktop command sender against the registered application window, its main frame and current document authority before invoking handlers. Keep embedded-browser keyboard messages on their existing registered-guest boundary. Add unit and real Electron checks for rejected senders without command side effects; desktop delivery remains pending.

## 0.11.0-beta.3.vorteo.418 - 2026-10-13

### Security

- Restrict desktop application navigation and redirects to the application authority, and deny new windows from the privileged renderer. External links continue through the validated opener; embedded browser tabs retain their separate navigation policy. Add URL-policy tests and a disposable Electron regression. Desktop installation remains pending its supported delivery workflow.

## 0.11.0-beta.3.vorteo.417 - 2026-10-13

### Security

- Raise direct WebSocket dependency requirements to the patched release line and resolve the shared transport to ws 8.22.0. Add a bounded loopback regression for excessive fragments and ordinary fragmented messages. Host and desktop installation remains subject to the tracked lifecycle workflow; static interface publication does not update their transports.

### Fixed

- Keep source updates awaiting agent repair or preparation out of maintenance notifications. Preserve their status and cancellation in Installation controls, and notify when an update becomes ready for approval.

## 0.11.0-beta.3.vorteo.416 - 2026-10-13

### Changed

- Reuse assistant Markdown parser rules across virtualized message rows, avoiding repeated linkifier compilation during scrolling. Keep completed and streaming parsers separate, with document references isolated between parses.

## 0.11.0-beta.3.vorteo.415 - 2026-10-13

### Maintenance

- Measure the bottom edge of a loaded image that shrinks across the timeline reading line. Keep detecting actual text jumps in either direction instead of reporting preserved text as a scroll failure.

## 0.11.0-beta.3.vorteo.414 - 2026-10-13

### Fixed

- Reserve host-route sidebar space while saved hosts load, preventing the desktop content column from jumping sideways during startup. Preserve unknown-host redirects and mobile navigation.

### Maintenance

- Cover cold and warm startup column stability at desktop, tablet and phone widths. Verify saved hosts through Connections settings instead of the removed sidebar host picker.

## 0.11.0-beta.3.vorteo.413 - 2026-10-13

### Fixed

- Prepare scrolled diff text without repeatedly rebuilding the React interface. Retain interactive headers, review controls and bounded canvas rendering.

## 0.11.0-beta.3.vorteo.412 - 2026-10-12

### Maintenance

- Integrate the stopped-thread queue, image download and fallback icon changes with the final question-card test correction. Preserve the published usage message and all v410 behavior.

## 0.11.0-beta.3.vorteo.411 - 2026-10-12

### Fixed

- Allow Command-to-queue and the compact Queue button while a thread is stopped, without starting it. Ordinary Send still resumes the thread.
- Add a compact image Download button with pending feedback and persistent failure messages. Preserve Markdown copy controls.
- Replace the four fallback browser icons with Vorteo artwork through an exact-byte migration. Retain previous icons for rollback and preserve versioned assets and open-client chunks.

### Maintenance

- Keep fixed-header scrolling checks limited to bounded cards; question cards are validated through page scrolling and answer submission instead.

## 0.11.0-beta.3.vorteo.410 - 2026-10-12

### Fixed

- Show "Usage not provided" for setup-token connections without quota information while preserving authentication rejection and ordinary usage failure messages.

### Maintenance

- Verify oversized question cards scroll with the conversation and retain answer navigation and submission at desktop and mobile widths.

## 0.11.0-beta.3.vorteo.409 - 2026-10-12

### Fixed

- Question cards grow with their contents and scroll with the conversation on all viewport widths, instead of trapping answers inside a nested scrolling body.

## 0.11.0-beta.3.vorteo.408 - 2026-10-12

### Maintenance

- Update card browser checks for restrained vertical header spacing and the existing width-dependent row insets. The production checks pass without changing runtime behavior.

## 0.11.0-beta.3.vorteo.407 - 2026-10-12

### Fixed

- Use the shared card action size for queued-message menus so their centers align with the heading controls and adjacent row actions.

## 0.11.0-beta.3.vorteo.406 - 2026-10-12

### Maintenance

- Match the journal timestamp assertion to the larger desktop heading icon column. Runtime behavior is unchanged.

## 0.11.0-beta.3.vorteo.405 - 2026-10-12

### Fixed

- Persist explicit tag-color intent even when the chosen hue matches the legacy default. Add a reload regression and update browser geometry assertions for 40px controls.

## 0.11.0-beta.3.vorteo.404 - 2026-10-12

### Changed

- Use neutral sidebar tags, diff counts and completed task petals. Place text badges before trailing icons and mute automatically managed workspaces and secondary metadata.
- Restore 40px desktop card and sidebar toolbar controls. Keep header vertical insets at 2px, 3px and 4px while horizontal spacing retains its three tiers and shared animation.
- Prepare explicit tag-color persistence with a Host capability flag. Legacy catalogs display neutral without rewriting their stored colors; choosing custom colors requires the updated Host.

## 0.11.0-beta.3.vorteo.403 - 2026-10-12

### Fixed

- Keep modal actions in a fixed footer while long forms scroll independently. Task, goal, account, host, plugin, skill and settings dialogs retain visible bottom actions at short desktop and compact viewport heights.
- Prevent modal headers and footers from shrinking, preserve safe-area clearance, and avoid doubled action-row padding. Add browser checks for visible, clickable Save controls before and after scrolling a long task form.

## 0.11.0-beta.3.vorteo.402 - 2026-10-12

### Maintenance

- Update plan-card browser checks to open the supporting sidebar after desktop resizing, target the visible card, and include shared header insets. Preserve failure screenshots before fixture cleanup.

## 0.11.0-beta.3.vorteo.401 - 2026-10-12

### Security

- Update the application's Markdown parser and Mermaid renderer to patched releases, and regenerate the embedded diagram runtime. Existing HTML, resource and unsafe-link restrictions remain in place.
- Reference-link destinations follow current Markdown syntax: wrap paths containing spaces in angle brackets. Invalid unbracketed definitions remain visible as text.

## 0.11.0-beta.3.vorteo.400 - 2026-10-12

### Maintenance

- Open Files and Changes through their supporting cards in browser checks, and measure review editor latency through the desktop comment action.

## 0.11.0-beta.3.vorteo.399 - 2026-10-12

### Maintenance

- Align Starship browser assertions with the existing selected-row palette. Theme, terminal and contributed-theme checks pass without changing interface colors.

## 0.11.0-beta.3.vorteo.398 - 2026-10-12

### Changed

- Skip unchanged typography updates during theme previews and switching, avoiding repeated stylesheet rebuilds while retaining custom settings and contributed theme replacements.
- Measure terminal throughput only after completed output reaches the terminal, and report cache writes by record type for performance diagnosis.

## 0.11.0-beta.3.vorteo.397 - 2026-10-12

### Fixed

- Restore shared styles when a pending view attaches after its CSS rule was released, preventing labels from falling back to black. Preserve theme subscriptions and normal rule cleanup across the interface.

## 0.11.0-beta.3.vorteo.396 - 2026-10-12

### Fixed

- Apply the larger target and single-script management controls to the shared split-pane toolbar menu.

## 0.11.0-beta.3.vorteo.395 - 2026-10-12

### Changed

- Enlarge workspace menu and explorer hit targets and make the single-script toolbar button act directly; retain script management in the workspace menu.

## 0.11.0-beta.3.vorteo.394 - 2026-10-12

### Changed

- Increase shared screen headings, including Schedules and History, from the base to the extra-large type size.

## 0.11.0-beta.3.vorteo.393 - 2026-10-12

### Changed

- Add mobile menu page insets and soften internal card, sidebar and menu rules across all themes while preserving outer borders.

## 0.11.0-beta.3.vorteo.392 - 2026-10-12

### Tests

- Include the inline Files card when validating mobile card spacing.

## 0.11.0-beta.3.vorteo.391 - 2026-10-12

### Changed

- Keep the goal queue-priority notice beneath the heading while the objective scrolls, with the conditional divider below the notice. Remove the waiting-for-messages heading suffix.

## 0.11.0-beta.3.vorteo.390 - 2026-10-12

### Fixed

- Keep narrow composer Queue controls above the text input hit area; preserve fixed Queue and Send click actions and highlight Queue while Command is held. Command+Enter queues in narrow web layouts.

## 0.11.0-beta.3.vorteo.389 - 2026-10-12

### Changed

- Simplify the mobile workspace toolbar to navigation and workspace menus, move script controls into the menu, and show Files inline before Queue.

## 0.11.0-beta.3.vorteo.388 - 2026-10-12

### Fixed

- Align the desktop message card with the sidebar bottom edges using the shared outer inset.

## 0.11.0-beta.3.vorteo.387 - 2026-10-12

### Changed

- Move Host connection and sidebar sync notices into a neutral, clickable sidebar footer tile, including the compact rail and mobile overlay.

## 0.11.0-beta.3.vorteo.386 - 2026-10-12

### Fixed

- Hide count chips for empty cards, including Journal, while retaining progress chips for nonempty task lists.

## 0.11.0-beta.3.vorteo.385 - 2026-10-12

### Fixed

- Apply the trailing workspace inset through the shared desktop and touch row-density styles.

## 0.11.0-beta.3.vorteo.384 - 2026-10-12

### Fixed

- Balance sidebar trailing controls by moving the top menu six pixels right and workspace indicators two pixels left.

## 0.11.0-beta.3.vorteo.383 - 2026-10-12

### Fixed

- Match card title and toolbar hover radii to the outer 16px card radius while keeping joined expanded edges square.

## 0.11.0-beta.3.vorteo.382 - 2026-10-12

### Fixed

- Synchronize workspace tab heights and toolbar centerlines with the left sidebar spacing animation across all three padding tiers.

## 0.11.0-beta.3.vorteo.381 - 2026-10-12

### Changed

- Snap the left sidebar to its compact rail at 160px instead of 96px while dragging.

## 0.11.0-beta.3.vorteo.380 - 2026-10-12

### Fixed

- Keep queued-message status indicators on the same centerline as their drag handles.

## 0.11.0-beta.3.vorteo.379 - 2026-10-12

### Fixed

- Align task and queue grab handles and journal timelines beneath their heading icons across card spacing levels.

## 0.11.0-beta.3.vorteo.378 - 2026-10-12

### Tests

- Check the retained top-corner radius and squared lower corners, with enough visible Files content to validate the single scroll divider.

## 0.11.0-beta.3.vorteo.377 - 2026-10-12

### Fixed

- Square expanded card title hover backgrounds along their lower edge, retaining both top corners when the title fills the header.
- Show one scroll-dependent separator below supporting pane controls instead of adding a second rule below the card title.

## 0.11.0-beta.3.vorteo.376 - 2026-10-12

### Fixed

- Extend sidebar toolbar and footer separators through interior padding so rules meet the card border.

## 0.11.0-beta.3.vorteo.375 - 2026-10-12

### Changed

- Make the entire sidebar maintenance footer open its review page, freeing space previously occupied by the separate review button.

## 0.11.0-beta.3.vorteo.374 - 2026-10-12

### Tests

- Validate goal header spacing against the three fixed padding levels, including the new compact inset.

## 0.11.0-beta.3.vorteo.373 - 2026-10-12

### Changed

- Give compact sidebar cards a little more interior space while preserving medium and spacious padding.

## 0.11.0-beta.3.vorteo.372 - 2026-10-12

### Changed

- Use three shared interior spacing levels for sidebars and inline cards, with smooth transitions that settle exactly at compact, medium or spacious padding. Reduced-motion mode switches immediately.

## 0.11.0-beta.3.vorteo.371 - 2026-10-12

### Changed

- Keep the divider beneath the left sidebar toolbar visible at every scroll position. Supporting cards retain their scroll-dependent dividers.

## 0.11.0-beta.3.vorteo.370 - 2026-10-12

### Changed

- Match the pre-launch loading ring to the thinner small indicators used inside the application.

## 0.11.0-beta.3.vorteo.369 - 2026-10-12

### Changed

- Refine loading indicators throughout Vorteo with lighter strokes and larger, thin-ring page loaders. Small status and queue rings keep their existing footprints; profile and project loading indicators share the same treatment.

## 0.11.0-beta.3.vorteo.368 - 2026-10-12

### Changed

- Toggle directly between the normal sidebar and compact icon rail, retaining fluid drag sizing and snapping. Ignore the retired intermediate-width preference. Mobile-width windows keep the existing toolbar button and full overlay menu regardless of input device.

## 0.11.0-beta.3.vorteo.367 - 2026-10-12

### Fixed

- Remove the extra fixed inset from left-sidebar project and status lists. Compact highlights reach the panel edges, and both sidebars use the same width-based spacing.

## 0.11.0-beta.3.vorteo.366 - 2026-10-12

### Changed

- Order the collapsed sidebar as expand, search, schedules, history and project tiles. Keep only its overflow menu at the bottom, with Settings and Add project inside.

## 0.11.0-beta.3.vorteo.365 - 2026-10-12

### Changed

- Let the left sidebar resize into a narrower icon rail and snap near its minimum. Reduce secondary row metadata as the sidebar narrows.
- Keep compact navigation available, group sidebar actions and appearance controls, and increase shared menu row spacing.
- Add interactive project workspace previews, missing rail tooltips and a reduced-motion-aware blur during theme transitions.

## 0.11.0-beta.3.vorteo.364 - 2026-10-12

### Changed

- Tighten New workspace chooser gaps, match card corners to the composer, and increase both surfaces' height. Show environment, account and profile options in single rows.

## 0.11.0-beta.3.vorteo.363 - 2026-10-12

### Changed

- Move workspace rows' trailing icons four pixels right in both project and status sidebar groupings.

## 0.11.0-beta.3.vorteo.362 - 2026-10-12

### Removed

- Remove focus mode, its keyboard shortcut and command-menu entries. Discard legacy focus-mode preferences while preserving sidebar and card settings.

## 0.11.0-beta.3.vorteo.361 - 2026-10-12

### Changed

- Move workspace environment context from the upper-right toolbar into the first position on each tab tooltip’s second line, before agent ID and activity.

## 0.11.0-beta.3.vorteo.360 - 2026-10-12

### Fixed

- Keep floating tab borders visible beneath close-button hover shading and move the close icon slightly inward.

## 0.11.0-beta.3.vorteo.359 - 2026-10-12

### Changed

- Square the top-right and bottom-left corners of expanded card toggle highlights throughout Vorteo; restore rounded corners when folded.

## 0.11.0-beta.3.vorteo.358 - 2026-10-12

### Maintenance

- Preserve the installed Host release ancestry while delivering the accumulated interface updates.

## 0.11.0-beta.3.vorteo.357 - 2026-10-12

### Changed

- Share the upper workspace toolbar across central content and right-hand cards. Keep the vertical menu leftmost and explorer toggle rightmost, and reserve tab-row space when controls extend left of a narrow card column. Constrained middle controls scroll without displacing the edge controls.

## 0.11.0-beta.3.vorteo.356 - 2026-10-12

### Changed

- Give compact sidebar maintenance notices more interior padding and space after the spinner while retaining their two-line layout.

## 0.11.0-beta.3.vorteo.355 - 2026-10-12

### Changed

- Remember separate device-local open and closed card states for the right-hand stack and inline primary-content layout. Resizing restores the destination layout's choices across workspaces and reloads; existing saved choices seed both layouts once on upgrade.

## 0.11.0-beta.3.vorteo.354 - 2026-10-12

### Changed

- Use Dark Star typography across all six built-in Vorteo themes, including theme previews and font defaults. Preserve each palette, explicit font overrides and monospace code. Freed and Vorton are unchanged.

## 0.11.0-beta.3.vorteo.353 - 2026-10-12

### Changed

- Show a matching border below sidebar and supporting-card headers only while their contents are scrolled away from the top. Divider visibility does not change layout or button positions.
- Track nested file and diff scrolling as well as standard card lists, preserving collapsed card behavior.

## 0.11.0-beta.3.vorteo.352 - 2026-10-12

### Changed

- Adapt both sidebar interiors and supporting card headers to available panel width. Spacious cards gain matching button clearance and body padding; narrow cards stay compact and preserve touch targets.
- Apply the same spacing to cards displayed in the central column, retaining each hidden panel's last measured spacing during workspace changes.

### Fixed

- Reclaim the empty touch menu slot at the trailing edge of workspace rows when their menu is hidden.
- Keep the web app shell within the visible keyboard viewport so workspace navigation remains accessible while composing. Release the adjustment for blur and pinch zoom.

## 0.11.0-beta.3.vorteo.351 - 2026-10-12

### Changed

- Double the welcome screen's Matrix rain speed while preserving its subtle contrast and stationary characters.
- Hide update, Host, sync and maintenance notices throughout welcome and connection setup. Operational screens retain their notices.

## 0.11.0-beta.3.vorteo.350 - 2026-10-12

### Fixed

- Make journal star and circle marker frames transparent, with timeline segments ending at each marker instead of showing through it.
- Lift Starship light's shared sidebar and card surface above the page background for clearer separation. Other theme palettes remain unchanged.

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.349 - 2026-10-12

### Fixed

- Clear stale coordinator connection errors after a successful automatic refresh while preserving unconfirmed decision errors.
- Separate completed coordinator requests into collapsed history and show a live elapsed counter for current requests. Exact owner approval and cancellation controls are unchanged.

## 0.11.0-beta.3.vorteo.348 - 2026-10-12

### Changed

- Remember each supporting card’s expanded state on the device and apply it across workspaces and reloads. Goal, Tasks, Journal, Queue, managed and provider subagents, Files and Changes retain independent choices without server synchronization.
- Keep Files and Changes folded during workspace selection when that is the saved preference. Explicit navigation commands and queue review actions still reveal the requested card.

### Maintenance

- Verify disclosure preferences across cold and retained workspace transitions, reloads and phone layout. Scope subagent navigation checks to their card rows when the same title also appears in a workspace tab.

## 0.11.0-beta.3.vorteo.347 - 2026-10-12

### Maintenance

- Restore the responsive supporting sidebar after browser-test reloads before checking journal history. Runtime behavior is unchanged.

## 0.11.0-beta.3.vorteo.346 - 2026-10-12

### Changed

- Reduce routine interface color: quota and completed tasks use the shared blue accent, active tasks use text color, and incomplete tasks, Host icons, merged requests and successful checks use neutral tones. Context meters remain neutral at every usage level.
- Tighten shared card bodies, balance heading icon insets, align journal markers with timestamps and list grips, and match card gaps to viewport gutters. List rows extend to card edges with actions aligned beneath header controls.
- Include plugin action rows in the supporting column height budget so queued messages cannot overlap Files or Changes in short windows.
- Combine journal totals and unread counts in one chip, shorten card titles and elapsed goal time, and replace standard sidebar label badges with neutral icons and tooltips. Custom workspace labels retain their text and identity colors.

## 0.11.0-beta.3.vorteo.345 - 2026-10-12

### Fixed

- Restore complete release-note history omitted during interface integration. Validate every retained entry from both source parents against the installed coordinator reader before delivery.

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

### Added

- Owner-unlocked automatic maintenance preference for tracked Host and Dev daemon updates and restarts, with persistent revision checks and visible saved or failed state.

### Fixed

- Disabling automatic maintenance cancels undispatched automatic requests and remains available when restart support is unavailable. Exact owner-only maintenance and recovery fences remain enforced.
- Preference failures remain visible during background refresh, and old coordinators retain their existing controls without exposing unsupported preference writes.

## 0.11.0-beta.3.vorteo.340 - 2026-10-12

### Changed

- Remove the desktop workspace title row and tab-strip rule. Put the focused environment beside the right-toolbar toggle and let the conversation meet the tabs directly.
- Make workspace tabs taller and wider, with adaptive shrinking and fully rounded corners. Give only the foreground tab the same floating surface, border and shadow as the Latest button.

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.339 - 2026-10-12

### Maintenance

- Integrate the published coordinator recovery controls with the new sidebar layouts, unified workspace toolbars and compact card actions. Preserve both source histories and existing approval boundaries.

### Added

- Journal entries accept optional machine context for IDs, paths and recovery details without displaying it in the card. Persistence and retry checks preserve both fields.

### Changed

- Agent and journal tool instructions require summaries of at most three sentences and fewer than 60 words, with the result and its meaning first. Task, goal and blocker text uses plain language and keeps technical references in metadata.

### Fixed

- Blocked task explanations no longer display prerequisite IDs when an agent has not supplied a reason.

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.338 - 2026-10-12

### Changed

- Use cleaning icons for card cleanup actions, with tooltips explaining what is deleted or hidden. All shared card-header icon actions provide labeled tooltips.
- Reduce the vertical gap between supporting cards to 8px while preserving column gutters and scroll allocation.
- Combine workspace actions and pane splitting in the primary-content menu. Keep run, preview and other actions at the right edge of the supporting toolbar, and move its collapsed toggle beside the content menu. Use vertical three-dot menus.

### Fixed

- Admit coordinator preparation recovery after an older failed generation was resolved by an exact successful recovery chain. Preserve historical receipts and reject unresolved or mismatched chains at initialization and dispatch.

## 0.11.0-beta.3.vorteo.337 - 2026-10-12

### Changed

- Cycle the sidebar toolbar button and keyboard shortcut through expanded, compact labeled and minimal rail layouts. Remove the separate Compact button row, remember the layout on this device and retain the expanded resize width.

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.336 - 2026-10-12

### Maintenance

- Make maintenance browser checks select the explicit Dismiss action separately from the close icon and inspect the visible sidebar after navigation. No interface behavior changes.

- Preserve published sidebar maintenance placement and queued-message ordering in coordinator recovery delivery.
- Keep the recovery notice in the floating action area without duplicating it in passive sidebar placements.

## 0.11.0-beta.3.vorteo.344 - 2026-10-12

### Maintenance

- Preserve the published responsive sidebar and workspace transition changes alongside owner-controlled automatic daemon maintenance. Retain both source histories and their release notes.

## 0.11.0-beta.3.vorteo.335 - 2026-10-12

### Maintenance

- Integrate published compact notices and Electron appearance regressions with coordinator recovery, preserving both source histories.
- Retain exact tracked cancellation, recovery and rollback checks for managed runtime delivery.

### Changed

- Keep Queued messages below Files, Changes and other supporting cards.
- Move approved and running maintenance into compact two-line sidebar status rows with a spinner and Review action. Approval and recovery notices remain floating with Review and Dismiss buttons. Dismissal leaves the underlying request unchanged.

## 0.11.0-beta.3.vorteo.334 - 2026-10-12

### Changed

- Shorten floating notices with tighter padding and actions beside short descriptions. Keep 44px action targets and wrapping for longer content.

## 0.11.0-beta.3.vorteo.333 - 2026-10-12

### Maintenance

- Reconcile the published interface with coordinator recovery source, preserving both release histories and installed source ancestry.
- Retain current appearance, workspace hydration and composer fixes alongside exact owner-reviewed recovery. Runtime installation and coordinator recovery remain separate tracked operations.

## 0.11.0-beta.3.vorteo.333 - 2026-10-11

### Maintenance

- Update the Electron font-size regression to select Dark Star and open Settings from the minimal sidebar rail.

## 0.11.0-beta.3.vorteo.332 - 2026-10-11

### Fixed

- Keep floating notices visible above native draft editors by measuring the message field and its controls, excluding draft setup sections.
- Load fresh workspace data from the active route without requiring the native sidebar to be opened first.

### Maintenance

- Extend compact notice coverage to both existing conversations and new drafts, including multiline typing and navigation cleanup.

## 0.11.0-beta.3.vorteo.331 - 2026-10-11

### Fixed

- Keep native agent and draft composer controls above the keyboard by preserving their bottom safe-area padding.
- Position compact floating notices above the active composer's measured height and keyboard clearance. Release the reserved space when navigating away.

### Maintenance

- Added compact notice regression coverage for multiline drafts and navigation. Verified notice and Send-button clearance in the iOS Release simulator.

## 0.11.0-beta.3.vorteo.330 - 2026-10-11

### Fixed

- Keep focused settings fields visible above the iOS keyboard using the shared page layout's native keyboard insets.

## 0.11.0-beta.3.vorteo.329 - 2026-10-11

### Fixed

- Align all three workspace toolbars in Electron by reserving window-control clearance above the columns. Keep the minimal project rail at 64px on macOS.

### Maintenance

- Verified real Electron layout, theme and minimal-rail persistence, plus desktop and compact browser layout. Native window minimize acceptance remains open.

## 0.11.0-beta.3.vorteo.328 - 2026-10-11

### Fixed

- Preserve native theme swatch dimensions by rendering their artwork outside the button's text wrapper.
- Render the six theme previews with native SVG gradients and Starship details instead of flat accent colors.
- Update native font-field placeholder colors when the theme changes without replacing the editor or its draft.

## 0.11.0-beta.3.vorteo.327 - 2026-10-11

### Maintenance

- Preserve the installed release in the appearance integration's ancestry and retain its release notes. Application behavior remains unchanged from the preceding integration; deployment and owner acceptance remain pending.

## 0.11.0-beta.3.vorteo.326 - 2026-10-11

### Changed

- Integrate the six-theme appearance, floating navigation, isolated demo and iOS scene startup with current main, preserving the coordinator and shared sidebar fixes.
- Keep demo sidebar preferences isolated from installation synchronization. Place synchronization notices in the floating update stack.
- Preserve shared workspace actions, labels and rename dialogs in the single central overflow menu when the right-hand cards are hidden.

### Maintenance

- Retain both source histories and their release notes. Installed publication and owner visual acceptance remain pending.

### Added

- Review recovery of an unclaimed coordinator executor with exact process identity, retained approval, owner cancellation and a separate approval for termination.
- Verify uncertain recovery outcomes from their retained execution generation without repeating process effects.
- Display recovery status and cancellation provenance in Installation controls, with capability checks that refuse approval through older clients.

### Fixed

- Preserve independently recorded owner cancellation when recovering its original executor. Reject changed approval, revision, plan, process or protected evidence.
- Keep cancellation atomic with the original claim and retain effect intents before native execution so lost responses cannot cause replay.
- Retain the installed source merge and both release-note histories in the integration ancestry.
- Cover journal races, native process and lock verification, observation after runner interruption, and authenticated server and browser review. Installed recovery and Factory activation remain separate acceptance steps.

## 0.11.0-beta.3.vorteo.325 - 2026-10-11

### Fixed

- Keep a coordinator executor running if its Host observer disconnects before the dispatch acknowledgement. The durable journal remains authoritative.
- Cover connected and disconnected acknowledgement pipes with real child processes.

## 0.11.0-beta.3.vorteo.324 - 2026-10-11

### Maintenance

- Reuse one read buffer per coordinator artifact scan to reduce allocation overhead while retaining complete file reads and validation.
- Verify digest compatibility across chunk boundaries, empty files and concurrent scans with different content.

## 0.11.0-beta.3.vorteo.323 - 2026-10-11

### Added

- Review an explicit source update tooling selection from the exact candidate release through coordinator maintenance. Omission preserves the current tooling.
- Require compatible clients to display the selection before approval, and reject unsupported preparation before sending it.
- Validate protected tooling files without executing them. Cover combined Factory and tooling admission, exact claims, successful selection and recovery of the complete previous configuration.

### Fixed

- Describe renewed configuration validation accurately when Factory and tooling selections are composed. Policy, helper and monitor changes remain unavailable through renewal.

## 0.11.0-beta.3.vorteo.322 - 2026-10-11

### Fixed

- Allow a renewed coordinator runner to review an explicit Factory adoption or recovery plan change through the existing configuration validator and exact approval button.
- Keep candidate and compatible recovery on the selected Host code, preserve the previous configuration for rollback, and reject unrelated policy, helper, monitor or credential changes.
- Test declared and mismatched plan digests, omitted changes, retained rollback and refusal of unrelated configuration changes.

## 0.11.0-beta.3.vorteo.321 - 2026-10-11

### Fixed

- Resolve Factory installation and coordinator binding through native shared-profile selection on the retained account, without requiring local profile copies.
- Preserve exact coordinator snapshots and reject missing, ambiguous, changed or mismatched profiles. Cover shared-profile installation and restoration with focused regressions.

## 0.11.0-beta.3.vorteo.320 - 2026-10-11

### Maintenance

- Combine 2 source contributions; retain their release notes below

### Added

- Verify protected Nova bridge release manifests against the selected standalone bundle and consumed configuration before startup.
- Report authenticated release commitments, startup identity and draining status; reject new MCP work while shutting down.
- Test file substitution, ownership, size bounds, readiness identity and draining. Managed activation and account revocation acceptance remain separate work.

## 0.11.0-beta.3.vorteo.319 - 2026-10-11

### Fixed

- Renew coordinator maintenance preparation from the selected immutable Host release and verified terminal receipt, retaining the original installation authority and exact approval workflow.
- Bind maintenance execution and recovery to retained release evidence, and refuse ambiguous transfers or incompatible lifecycle history.
- Keep Host startup available during background maintenance validation and notify connected clients when verification finishes; maintenance actions remain disabled until then.
- Preserve configured installation workers' process arguments for native identity verification, and isolate availability notifications so one client failure cannot suppress others.
- Show unavailable maintenance diagnostics without stale approval controls. Allow a recovered connection to refresh while an older request remains unresolved, ignoring its late response and finalizer.
- Cover renewal, unavailable maintenance and deferred refresh recovery with focused tests and desktop and phone browser checks. Live installation still requires tracked approval and acceptance.

## 0.11.0-beta.3.vorteo.318 - 2026-10-11

### Fixed

- Retain exact interface source history in the configured protected repository before selecting a bound web release, and verify it through an independent reader.
- Add explicit durable publication binding setup with failure and retry checks. Existing publishers must be upgraded before this protection can be claimed for an installation.

## 0.11.0-beta.3.vorteo.317 - 2026-10-11

### Maintenance

- Integrate shared sidebar state and workspace menu parity while preserving both source histories, offline-edit recovery, Review checklist support and the Nova workspace.
- Retain creation tests that distinguish requested agents from internal workspace-naming helpers without changing production naming.

## 0.11.0-beta.3.vorteo.314 - 2026-10-11

### Maintenance

- Reconcile workspace menu parity with public main through a merge that retains both source histories and release notes.
- Preserve the Nova bridge workspace, Review checklist behavior and current Factory grouping without changing installation validators or activating runtime updates.

- Integrate shared sidebar state with published Nova subscription safeguards and exact-profile delegation, preserving both source histories and Review checklist behavior.

## 0.11.0-beta.3.vorteo.316 - 2026-10-11

### Maintenance

- Scope creation fixture counters and readiness gating to non-internal sessions. Keep exact-one creation and prompt assertions while allowing production workspace naming helpers to run through the same fake clients.

## 0.11.0-beta.3.vorteo.315 - 2026-10-11

### Fixed

- Preserve pending sidebar edits across synchronizer remounts. Ignore late acknowledgements from stopped instances and serialize outbox reads and writes across instance lifetimes, including saves queued before stop.

## 0.11.0-beta.3.vorteo.312 - 2026-10-11

### Maintenance

- Integrate shared sidebar synchronization with the published source, retaining the Nova bridge workspace and dependencies, native Factory grouping, Review checklist capability, and published interface changes. Preserve both source histories and resolve release metadata explicitly.

### Fixes

- Forward exact launch profiles through Host-to-Dev task creation, retaining account checks and retry identity while rejecting model overrides.

## 0.11.0-beta.3.vorteo.296 - 2026-10-11

### Maintenance

- Update sidebar drag acceptance coverage to use the current row layout without relying on removed scrim elements or opening branch popovers. Disconnect the test WebSocket explicitly to verify offline recovery.

### Fixed

- Keep the message field beneath the conversation as columns resize and let floating cards extend alongside it to the bottom of the view.
- Record the current preference to deliver Vorteo changes to the existing instance for reload and owner review.

### Changed

- Group explicitly tagged Factory workspaces in Factory before runtime adoption and show an icon-only Factory marker. Preserve lifecycle protection and match keyboard navigation to section order.

- Preserve source-update outcomes for older clients instead of describing successful, failed or running updates as pending approval.

## 0.11.0-beta.3.vorteo.295 - 2026-10-11

### Added

- Synchronize project order, workspace and pinned order, expanded sidebar sections, grouping and filters across connected devices through the Host daemon.
- Retain offline sidebar edits until reconnect, preserve unrelated changes from other devices, and show synchronization failures with Retry.

### Maintenance

- Validate durable shared state, first-device initialization, stale-cache reconnects, queued edits, and independent client updates. Keep automatic local reconciliation out of shared user edits.

- Preserve the installed Host update and both release histories while integrating the optional icon-cache startup fix.

- Isolate fresh-home checklist and goal RPC tests from inherited installation launcher configuration, restoring standalone test admission without changing production guards. All three RPC tests pass; reconnect coverage does not establish daemon restart continuity.

## 0.11.0-beta.3.vorteo.313 - 2026-10-11

### Fixed

- Keep canceled Nova subscriptions canceled when callback verification finishes late, including cached refreshes and concurrent attempts.
- Bound callback verification caching, signing-key overlap and complete UTF-8 webhook bodies; send factual event data without behavioral instructions.
- Add subscription, signing and delivery boundary regressions. Live account connection and runtime activation remain separate.

## 0.11.0-beta.3.vorteo.311 - 2026-10-11

### Fixes

- Let trusted Host requests require owner review and preserve that requirement through source repairs, retries and recovery. Refuse unsupported clients before submission.

## 0.11.0-beta.3.vorteo.310 - 2026-10-11

### Maintenance

- Integrate workspace chooser geometry with shared-profile compatibility and timeline recovery, preserving both complete release histories.

## 0.11.0-beta.3.vorteo.309 - 2026-10-11

### Maintenance

- Integrate isolated goal and checklist RPC setup while retaining the newer Review compatibility assertions and complete source history.

## 0.11.0-beta.3.vorteo.308 - 2026-10-11

### Maintenance

- Integrate validated shared-model compatibility and timeline catch-up with the published interface, monitor workflow and private bridge, preserving every historical release entry.

- Give the profile column a distinct browser test identifier so workspace geometry checks preserve existing profile-card checks

## 0.11.0-beta.3.vorteo.307 - 2026-10-11

### Maintenance

- Preserve the published Factory and Review interface alongside tracked monitor maintenance, the private Nova bridge and both source histories.

### Changed

- Remove the new workspace profile header, align the selector and message card edges, and use matching card gaps and desktop heights

## 0.11.0-beta.3.vorteo.306 - 2026-10-11

### Added

- Add six Vorton themes with Dark Star as the default, bundled typography, compact Freed theme previews and accessible tooltips.
- Add an isolated demonstration with sample projects, conversations, tasks, journal entries, files and changes. Demo edits persist within the browser tab and reset without changing real installation settings.
- Add Create New installation, Connect to Host and Demo welcome actions with subtle stationary Matrix rain.
- Support native Host workspaces in the Preview Broker and live development previews.

### Changed

- Float the left sidebar and individual supporting cards over one page background. Align the three toolbars, move PR actions above the right cards, widen workspace tabs and retain a compact navigation rail when the left sidebar collapses.
- Put compact theme tiles in the sidebar overflow menu and use consistent resize controls, rounded tab tops and one central workspace menu.
- Move installation updates and approval notices into persistent floating notifications while preserving their tracked controls.
- Keep automatic goal waits blocked and reserve pause for owner action. Revisit eligible blocked goals through the existing review queue.

### Fixed

- Preserve mounted editors and terminals during theme changes, and restore the previous appearance when preference storage fails.
- Keep the configured single-password connection flow and clear abandoned password drafts.
- Migrate generated iOS startup to the scene lifecycle required by iOS 27 while retaining existing Expo module callbacks and paste input.
- Preserve all five Barlow Condensed weights on iOS and allow native exports to use a private Metro cache alongside live previews.

### Maintenance

- Document preview isolation, appearance conventions and delivery checks. iOS 27 Debug and Release startup and custom links pass simulator checks; physical-device visual and notification acceptance remain open. Installed goal recovery still needs daemon delivery and verification.

- Prepare and review exact preview-monitor replacements through the installation coordinator, retaining displaced bytes and fencing uncertain outcomes.
- Negotiate monitor configuration review with older clients while preserving cancellation and exact approval checks.
- Recognize managed supervisor and Node worker identity when the preview monitor checks the Dev daemon.

## 0.11.0-beta.3.vorteo.305 - 2026-10-11

### Fixed

- Center the Review badge within its phone touch target. Exercise checklist scrolling with enough rows to exceed the full-height desktop card.

## 0.11.0-beta.3.vorteo.304 - 2026-10-11

### Maintenance

- Preserve the published compact journal alongside native Factory grouping and Review tasks. Verify Review editing, persistence and completion at desktop and phone widths.

## 0.11.0-beta.3.vorteo.303 - 2026-10-11

### Added

- Add Review for checklist tasks awaiting review or approval, with an editor choice, eye icon and badge. Review stays incomplete and inactive.

### Fixed

- Keep older clients compatible with Review tasks and preserve release-note ordering across merged histories.

## 0.11.0-beta.3.vorteo.302 - 2026-10-11

### Maintenance

- Preserve the published compact conversation headers alongside native Factory sidebar grouping and both release histories.

- Verify compact journal row geometry directly in the desktop and phone visibility checks.

## 0.11.0-beta.3.vorteo.301 - 2026-10-11

### Fixed

- Use native Factory membership for the Factory sidebar section and protected icon-only marker. Custom labels no longer determine Factory membership or grouping.

### Maintenance

- Keep journal visibility test entries outside the viewport after widening the text area.

### Added

- Add a private Nova bridge package for scoped Host and Dev tools, durable operation receipts and proactive event delivery. Runtime activation and account acceptance remain separate.
- Record top-level agent-tool prompts with canonical machine origin and message IDs while preserving owner-authored message evidence.

- Choose a shared profile default supported by every included environment, preserving saved models and aliases with compatibility warnings.
- Catch up missing response chunks after an empty timeline bootstrap instead of accepting a later chunk as the beginning.
- Resolve saved model aliases consistently in shared profile lists and Host/Dev account pickers without rewriting the saved reference.

## 0.11.0-beta.3.vorteo.300 - 2026-10-11

### Maintenance

- Preserve the installed conversation layout and complete release histories alongside accurate legacy update outcomes.

### Changed

- Move journal timestamps above entry text and narrow the left gutter to the timeline and markers.

## 0.11.0-beta.3.vorteo.299 - 2026-10-11

### Maintenance

- Preserve installed workspace profile defaults while integrating compact card headers.

### Changed

- Hide workspace row overflow buttons on touch devices and use vertical overflow icons throughout the app.
- Share workspace management actions between sidebar and title menus, retaining Factory controls, protection, labels, import and setup actions.
- Explain Dev delivery options in agent instructions and invite owners to move build tasks to Host for live interface previews.
- Exercise desktop menu parity and compact title actions, and restore pane viewing before the read-state test checks ordinary completion on departure.

### Tests

- Await the completed source-batch query directly in legacy outcome regressions, avoiding a polling deadline around owner authentication.

## 0.11.0-beta.3.vorteo.298 - 2026-10-11

### Changed

- Show a compact profile chooser above the new workspace message field and apply draft selections without a separate activation button
- Add General preferences for the default workspace environment and account, with a separate default profile for each account
- Preserve the installed Factory sidebar and full-height conversation layout while integrating workspace preferences

- Compact conversation card headers with flush ghost buttons, shared card corner radii and preserved touch targets.

### Maintenance

- Integrate accurate legacy update outcomes with workspace defaults and the installed Factory sidebar, preserving both release histories.

## 0.11.0-beta.3.vorteo.297 - 2026-10-11

### Maintenance

- Preserve the published Factory sidebar grouping while integrating the aligned composer and full-height card column.

### Changed

- Show a compact profile chooser above the new workspace message field and apply draft selections without a separate activation button
- Add General preferences for the default workspace environment and account, with a separate default profile for each account
- Preserve the installed Factory sidebar update when integrating workspace preferences

## 0.11.0-beta.3.vorteo.294 - 2026-10-11

### Fixed

- Continue application startup after two seconds if the optional project icon cache cannot be read. Preserve stored data and ignore late reads rather than replacing fresh icons.

## 0.11.0-beta.3.vorteo.294 - 2026-10-10

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.293 - 2026-10-10

### Maintenance

- Integrate the shared Claude connection panel and retained-home synchronization fix with published coordinator recovery, preserving both complete release histories.

## 0.11.0-beta.3.vorteo.292 - 2026-10-10

### Fixed

- Connect managed Claude accounts through one shared panel without Host or Dev tabs. Show aggregate synchronization and disconnect status while retaining Models and profiles access.
- Restrict owned legacy Claude account directories to private permissions during delivery without replacing history. Reject symbolic links and refuse permission widening.

### Maintenance

- Cover shared connection routing, pending delivery, retained history and desktop and compact management controls with focused checks. Live provider acceptance remains separate.

- Preserve both v291 histories while integrating the published browser-test readiness correction with reviewed coordinator recovery.

## 0.11.0-beta.3.vorteo.291 - 2026-10-10

### Maintenance

- Integrate reviewed coordinator recovery with deployed interface ancestry and blocked-task reassessment, retaining both source histories and release notes.

- Reacquire checklist badges after column layout settles before checking keyboard tooltip access. Focus, explanation visibility and task-state assertions remain unchanged.

## 0.11.0-beta.3.vorteo.290 - 2026-10-10

### Maintenance

- Integrate blocked-task explanations and periodic reassessment with deployed card headings and workspace fixes, preserving both release histories.

## 0.11.0-beta.3.vorteo.289 - 2026-10-10

### Changed

- Preserve the deployed workspace creation, installation and Factory updates while integrating consistent bordered card heading actions and inset heading hover backgrounds.
- Keep heading geometry checks independent of card animations and verify desktop card limits against the available column height.

## 0.11.0-beta.3.vorteo.288 - 2026-10-10

### Maintenance

- Combine 4 source contributions; retain their release notes below

### Fixed

- Preserve completed coordinator maintenance history while allowing the next reviewed update.
- Bind compatible recovery to a separately reviewed executable and keep pending requests readable by the previous coordinator.
- Protect journal promotion with independent recovery, crash-released locking and durable state preservation.
- Leave busy-state recovery explicitly unresolved after one verified resume, with no automatic retry and visible legacy restart limitations.
- Add recovery, journal durability, legacy-client and native lifecycle regressions; installed activation remains pending.

## 0.11.0-beta.3.vorteo.287 - 2026-10-10

### Added

- Expose pause, resume and stop through the installed native Factory adapter and built-in interface. Bind actions to the selected host, project, installation and revision; show refused or uncertain outcomes without automatic retries. Startup-owned control ports and live operating acceptance remain required.
- Cover native control provenance, changed identities, lost responses and desktop/compact control rendering through the plugin loaders and isolated daemon.

### Fixed

- Inset conversation card heading hover backgrounds from the card border while keeping the icon inside the target and preserving heading alignment.
- Standardize every conversation card heading action on a shared bordered button, including journal clearing, task controls, goals, queue controls and sub-agent info/cleanup. Preserve common desktop and touch sizes and verify rendered border consistency.

- Explain blocked tasks on hover, keyboard focus and touch, and periodically reassess eligible idle threads using their retained sessions.
- Preserve queued messages, manual pauses, goal budgets and restart holds during automatic review preparation. Keep review cooldowns across daemon reloads.
- Wait for an archive queued behind session restoration before returning a protected thread load.

### Maintenance

- Cover retained-session review, archive races, owner-action preemption and queue preservation with focused regressions. Document reassessment eligibility and limits.

## 0.11.0-beta.3.vorteo.286 - 2026-10-10

### Added

- Let reconciled native Factory startup restore observation for an exact completed installation without rebinding coordinators or admitting execution. Verify method provenance and reject reconciliation holds raised during restoration. Private startup wiring and operating acceptance remain separate.

## 0.11.0-beta.3.vorteo.285 - 2026-10-10

### Added

- Add an exact-plan Factory startup adoption request to Installation controls, with Host-only submission, owner approval, cancellation, staged-source verification and no automatic replay.
- Allow trusted controller startup to reuse its retained native accounting directory without changing the daemon home.
- Bind adoption configuration changes to a reviewed coordinator maintenance plan. Preserve failed-adoption recovery fences and require a fresh linked approval before lifecycle dispatch; shared errors omit private script diagnostics.

## 0.11.0-beta.3.vorteo.280 - 2026-10-09

### Fixed

- Assign logical project membership before publishing a new workspace, including Host creation, profile handoffs and agent-created child workspaces.
- Refuse project-bound creation on daemons that cannot preserve the selected project from the first update.

### Improved

- Integrate clearer goal waiting and queued-message recovery controls while preserving conversation columns, heading hover regions and all release history.

## 0.11.0-beta.3.vorteo.286 - 2026-10-09

### Fixed

- Update conversation scroll fades through the existing scroll and resize measurements, preserving retained-tab reading positions without a second viewport observer.

## 0.11.0-beta.3.vorteo.285 - 2026-10-09

### Changed

- Center conversation text against the full content region until it reaches a 32px card gutter. Match the right edge inset to the 16px card gap and allow the cards column to shrink to 220px.
- Share available vertical space among open cards, keeping short cards at their content height and long card bodies scrollable. Animate card appearance, removal and resizing with exponential easing and reduced-motion support.
- Hide the web conversation scrollbar and fade only the scroll edges with more content. Preserve compact footer cards, column width persistence and action approvals.

### Maintenance

- Cover centering, height allocation, narrow width persistence and responsive card behavior in focused tests; document the revised column behavior.

## 0.11.0-beta.3.vorteo.284 - 2026-10-09

### Fixed

- Keep questions in the left conversation column while other cards remain on the right.

## 0.11.0-beta.3.vorteo.283 - 2026-10-09

### Fixed

- Managed installations welcome new devices with one owner-password field that connects Host and Dev automatically
- Removed the misleading Tailscale connection button from installation onboarding

## 0.11.0-beta.3.vorteo.282 - 2026-10-09

### Improved

- Integrate journal unread markers and retained seen history with the current goal controls and conversation navigation repair.

## 0.11.0-beta.3.vorteo.280 - 2026-10-10

### Added

- Journal entries use red Spark markers on a gray timeline, with a count of unread entries. Viewing an entry briefly turns its Spark into a gray dot with a subtle contraction and halo; reduced motion skips the animation.
- Seen state survives reload on the current device and stays separate from Clear journal. Entries skipped while scrolling or hidden in a collapsed card stay unread. Storage errors offer Retry.

### Maintenance

- Added focused visibility and persistence tests plus desktop and compact browser coverage for scrolling, reload, collapsed cards, background windows and storage recovery. Native physical-device acceptance remains pending.

## 0.11.0-beta.3.vorteo.281 - 2026-10-09

### Fixed

- Keep conversation navigation marks visible when a narrow text column has enough surrounding space, including shorter marks for agent messages.

## 0.11.0-beta.3.vorteo.279 - 2026-10-09

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.278 - 2026-10-09

### Fixed

- Share in-flight verification for concurrent approvals of the same coordinator request, retaining independent authentication and guarded decision writes.
- Explain long-running coordinator decision checks in both Installation controls and the sidebar, and discourage duplicate submissions.

## 0.11.0-beta.3.vorteo.277 - 2026-10-09

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.276 - 2026-10-09

### Maintenance

- Integrate reviewed conversation columns and shared heading hover regions with the deployed interface, preserving journal controls, Copy all, neutral blocked icons and workspace recovery. Retain both source histories and all release entries.

## 0.11.0-beta.3.vorteo.271 - 2026-10-09

### Changed

- Clarify agent delivery instructions: prefer static interface publication, but submit a supported managed Host source update for exact approval when static publication is unavailable. Explain restart disruption, preserve preview scope, and require a concrete failure before handing delivery back to Host.

### Maintenance

- Merge the accepted Dev blocked-checklist source into published Factory history, preserving both parent implementations and every historical release entry.
- Retain current Factory safeguards and checklist compatibility without changing runtime behavior.

### Improved

- Add Clear journal and Show history controls that retain permanent entries, preserve newly appended entries, and remember the cleared view on this device. Align entry text with inset timestamps without changing date spacing.

## 0.11.0-beta.3.vorteo.270 - 2026-10-09

### Fixed

- Give conversation card headings one consistent hover and click region, including the icon and all available whitespace before separate actions. Messages retains its passive status inside that region. Preserve heading alignment and touch target heights.
- Verify heading geometry, matching hover colors, and disclosure clicks at both ends across desktop and compact layouts. Update the shared card contract and customization inventory.

- Keep worker conversations visible in their own execution workspaces while retaining parent grouping. Opening a worker tab there no longer redirects to the parent workspace.

### Maintenance

- Retain completed Factory workers and defer opt-in age-based archival until a future update.

### Added

- Add Copy all to text-file toolbars, including current edits and empty files, with translated labels and responsive controls at compact widths.

### Changed

- Explain goal continuation while queued messages take priority, with a smaller parenthesized status, labeled goal time, and pause help available on desktop and touch layouts.
- Keep the full goal status and touch controls readable on compact screens by placing goal time and Clear goal in the expanded card.
- Name the message card Queued messages. Show delivery failures and uncertain delivery in the goal card with actions to review messages or recover the goal.

## 0.11.0-beta.3.vorteo.269 - 2026-10-09

### Added

- Split wide thread content into independently scrolling, resizable text and card columns. Cards stay pinned right, text stays centered in the remaining space, and preferred widths survive reloads. Both columns fade above the unchanged composer.

### Changed

- Choose the two-column layout from the primary region's width, so opening a sidebar or widening the left sidebar restores the existing single-column arrangement below 1,080 CSS pixels.
- Order thread cards as Goal, Tasks, Journal, Subagents, then Messages in both layouts. Preserve card body scrolling, fixed headers and queue drag handling.
- Update the README and customization inventory, and cover column geometry, saved widths, both sidebar transitions, nested scrolling and card interactions with focused unit and browser tests. Native touch behavior still needs physical-device acceptance.

### Fixed

- Use a neutral circle-alert icon for blocked tasks in checklist cards and task rows.

## 0.11.0-beta.3.vorteo.274 - 2026-10-09

### Fixed

- Preserve protected, standing and Factory workspace metadata across reloads. Refresh older incomplete workspace caches without discarding agent conversations or message history.

## 0.11.0-beta.3.vorteo.273 - 2026-10-09

### Fixed

- Keep protected, standing and Factory-managed workspaces in their registered project instead of grouping them under a supervising agent's project.
- Show a blocked icon and explanation when dragging a protected workspace into another project.
- Integrate published worker-tab recovery so existing agents remain visible in their own workspaces, while retaining Copy all and journal controls.

## 0.11.0-beta.3.vorteo.272 - 2026-10-09

### Fixed

- Describe both clearing and restoring the journal view accurately for assistive technology.

## 0.11.0-beta.3.vorteo.268 - 2026-10-09

### Fixed

- Sidebar update and maintenance cards share one scrolling stack capped at 33% of the viewport, consistent review actions, and equal top and right dismiss-button spacing. Short stacks retain their natural height.

## 0.11.0-beta.3.vorteo.267 - 2026-10-09

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.266 - 2026-10-09

### Maintenance

- Integrate the published card-header hover padding with automatic coordinator recovery, preserving both source histories and release notes.

## 0.11.0-beta.3.vorteo.264 - 2026-10-09

### Maintenance

- Preserve the currently published installation controls and journal integration while delivering padded card heading hover backgrounds.

### Fixed

- Add approval-bound automatic coordinator recovery: independently fence stalled updater processes, restore the verified previous release once, and retain task state and failed-update history. Show restoration progress and outcome in installation controls.

## 0.11.0-beta.3.vorteo.261 - 2026-10-09

### Fixed

- Give card disclosure hover backgrounds horizontal padding while preserving title alignment with the other card headings.

### Maintenance

- Integrate the exact installed Host batch before publishing the clearer installation review, preserving deployed implementation and complete release history.

## 0.11.0-beta.3.vorteo.265 - 2026-10-09

### Fixed

- Restore the previous coordinator when a failed replacement has already exited, verifying the loaded service arguments before removing its stopped job.

## 0.11.0-beta.3.vorteo.263 - 2026-10-09

### Maintenance

- Integrate the reviewed append-only thread journal with the deployed installation interface and goal controls. Preserve all historical release entries and keep journal rendering gated by daemon support.

## 0.11.0-beta.3.vorteo.260 - 2026-10-09

### Added

- Add persistent thread journals for critical decisions and verified progress, with caller-scoped read and append tools, server timestamps, fixed append order and safe retries.
- Show journal entries in a shared accordion card with compact left timestamps, selectable text and live updates. Preserve entries across reloads and reject edits, backdating and reordering.

### Fixes

- Explain that the requesting agent repairs blocked installation updates, while the owner can leave them queued or cancel an unwanted update. Keep technical diagnostics in Details and disabled-action explanations.
- Use the shared compact sidebar action layout for coordinator and daemon update reviews.

## 0.11.0-beta.3.vorteo.262 - 2026-10-09

### Fixes

- Refresh coordinator status while an approval is being processed. Show recorded approval and allow cancellation before dispatch without waiting for the original response; ignore late responses after a newer decision.

## 0.11.0-beta.3.vorteo.259 - 2026-10-09

### Maintenance

- Publish the validated blocked checklist status and retain the complete installed release history, including concurrent goal-edit and interface corrections.

- Combine 2 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.258 - 2026-10-09

### Maintenance

- Preserve the accepted goal-edit source and complete release history in the checklist correction so the installed coordinator can accept the integrated contribution.

## 0.11.0-beta.3.vorteo.257 - 2026-10-09

### Fixed

- Keep thread goal edits usable while native usage accounting advances, without accepting stale owner edits or bypassing continuation holds
- Expose optional goal edit revisions and cover accounting, same-value writes, pause/resume cycles and caller-bound tool forwarding

### Maintenance

- Integrate the blocked checklist status with the published interface source while preserving every complete installed release-note entry and the original checklist notes.
- Retain the published helper query, accordion hover and existing Factory source unchanged.

## 0.11.0-beta.3.vorteo.254 - 2026-10-09

### Added

- Add a discretionary blocked checklist status to agent tools and task editing. Retain blocked items as incomplete across saved state, history refresh and client reloads.
- Show blocked task badges and preserve compatibility with older clients through capability negotiation.

### Maintenance

- Select Node timer overloads in login services so full workspace typechecking remains valid with generated Expo route types.

### Changed

- Teach agents to set and clear blocked status independently of prerequisite links and keep blocked work below completed and active items.

- Preserve the two installed maintenance release-note entries during managed integration. Factory implementation and published source remain unchanged.

### Fixed

- Restore hover highlights on conversation card accordion headings without changing their layout
- Reuse the reviewed Node timer typing fix so browser fixture imports pass typechecking

## 0.11.0-beta.3.vorteo.256 - 2026-10-09

### Maintenance

- Preserve the deployed accordion hover and Node timer typing corrections while integrating the helper query retry fix.

## 0.11.0-beta.3.vorteo.255 - 2026-10-09

### Maintenance

- Integrate the native helper query retry correction with current published source, preserving Factory changes and all historical release entries.

## 0.11.0-beta.3.vorteo.253 - 2026-10-09

### Added

- Package the existing Factory qualification, delivery and Builds pipeline behind native scheduling, account, custody and governed-stage ports.
- Add guarded setup and one-shot installation controls in the client and CLI, with persistent reconciliation holds after partial outcomes.
- Identify native Factory-managed workspaces with an icon and badge, and block ordinary archive and unprotect actions.

### Fixed

- Fence supported settings writers and origin admission, preserving unrelated settings and typed uncertainty after persistence.
- Preserve native inspection revocation, prepaid authorization expiry, paired admission holds and retained recovery records.

### Maintenance

- Integrate current coordinator bootstrap, account setup and worker sidebar changes without starting another controller or changing live custody.
- Preserve standard Factory contract compilation, generated asset copying and complete historical release notes. Live installation, authentication and controller acceptance remain required.

- Retry unsupported native helper queries once per minute while preserving owner authentication and automatic discovery after coordinator upgrades
- Update installation client assertions for the existing trusted Host approval capability query

- Combine 2 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.252 - 2026-10-09

### Added

- Prepare and inspect native helper installations through Host-scoped commands and exact owner review
- Preserve helper installation, cancellation and recovery receipts in the shared lifecycle journal
- Verify protected artifacts, signing identities, private state and replacement processes before reporting installation success
- Bind helper configuration changes to reviewed coordinator plans while preserving the existing Host Docker pairing

### Fixed

- Retain helper recovery errors across interface refreshes and show maintenance status while controls are locked
- Show signing identities and the correct retained release in helper rollback details

### Maintenance

- Cover lifecycle recovery, scoped HTTP and client commands, and desktop and phone review flows with isolated tests
- Keep helper activation disabled until compatible coordinator rollback, signing and tracked installation acceptance are complete

## 0.11.0-beta.3.vorteo.251 - 2026-10-09

### Fixed

- Allow complete native artifact verification before coordinator bootstrap acknowledgement times out
- Keep owner review requests observable during long verification without replaying uncertain operations

## 0.11.0-beta.3.vorteo.250 - 2026-10-08

### Fixed

- Verify npm executable hard links within sealed coordinator releases while rejecting external aliases
- Bind internal link topology and recheck file identities before accepting the artifact digest

## 0.11.0-beta.3.vorteo.249 - 2026-10-08

### Maintenance

- Discover protected coordinator bootstrap setup beside the private Host installation client without changing the loaded launcher
- Reject non-Host clients and insecure setup; discovery does not approve or dispatch maintenance

## 0.11.0-beta.3.vorteo.248 - 2026-10-08

### Maintenance

- Integrate the deployed interface and installed Host ancestry with coordinator bootstrap and Claude connection preparation
- Preserve delivered queue recovery, conversation card geometry, task progress and sidebar refinements
- Retain both branches' complete release histories; installation and live bootstrap acceptance remain pending

## 0.11.0-beta.3.vorteo.225 - 2026-10-08

### Fixed

- Keep the profile selector open when switching Host and Dev container, without a Host confirmation dialog.
- Keep active managed-worker workspaces visible in the sidebar, including workspaces with no terminals or running scripts. Preserve their project grouping and task relationships.

### Maintenance

- Specify the one-time tracked coordinator bootstrap, including independent owner authentication, exclusive journal ownership, cancellation, bounded recovery and live acceptance requirements
- Record the verified distinction between a service-unload command returning and the previous process actually exiting; production activation remains pending

## 0.11.0-beta.3.vorteo.247 - 2026-10-08

### Maintenance

- Connect protected Host bootstrap setup to the review capability and exact approved runner launch
- Verify the prepared runtime before accepting requests, acknowledge durable dispatch, and refuse automatic launch retries
- Preserve cancellation before dispatch and keep the capability disabled when Host setup is absent or invalid
- Validate native replacement and crash recovery with disposable services; production installation and full client acceptance remain pending

## 0.11.0-beta.3.vorteo.246 - 2026-10-08

### Maintenance

- Add capability-gated coordinator bootstrap review in Installation settings and a persistent sidebar callout
- Bind owner decisions to the displayed request revision and plan digest, clear submitted passwords and preserve last known status on disconnect
- Show concise maintenance copy, collapsed source details, cancellation before dispatch and disabled-action explanations
- Cover stale reviews and delayed status races in model tests; browser acceptance and Host activation remain pending

## 0.11.0-beta.3.vorteo.245 - 2026-10-08

### Maintenance

- Add a protected native bootstrap runner bound to approved candidate artifacts and immutable Host setup
- Persist executor identity and require the watchdog launcher's readiness handshake before freezing the coordinator
- Route abandoned executions through the existing generation-bound recovery policy without replaying installation
- Keep full runner acceptance, Host launch admission, visible controls and live activation pending

## 0.11.0-beta.3.vorteo.244 - 2026-10-08

### Maintenance

- Compose native coordinator handoff operations with protected setup, kernel ownership and exact approved-plan checks
- Restrict readiness requests to the configured loopback listener, rejecting redirects, oversized responses and unavailable endpoints
- Recheck readiness before the durable startup-fence release and bound repeated native observations
- Keep watchdog launch, visible approval controls and live bootstrap acceptance pending

## 0.11.0-beta.3.vorteo.243 - 2026-10-08

### Maintenance

- Verify inherited bootstrap ownership against the kernel lock and canonical private lock inode
- Reject unlocked descriptors, descriptors owned by another process and changed verifier bytes
- Extend disposable process tests for ownership across execution and release after process death
- Keep executor launch wiring, visible review controls and live bootstrap acceptance pending

## 0.11.0-beta.3.vorteo.242 - 2026-10-08

### Maintenance

- Preserve coordinator handoff state with a durable generation-bound hash receipt, without copying or restoring journals and owner sessions
- Refuse transfer when requests are active, preparation children remain, state changes or files are not private and owned
- Check preserved state again before unload and replacement readiness; retain absent initial stores without creating them
- Keep native executor wiring, visible review controls and live activation pending

## 0.11.0-beta.3.vorteo.241 - 2026-10-08

### Maintenance

- Verify replacement coordinator readiness against repeated native identity observations and the approved executable and arguments
- Require matching installation, process and handoff generation in fenced health responses; reject process changes during verification
- Recheck candidate artifacts, selected launcher and dispatch ownership before accepting readiness
- Keep native runner wiring, visible review controls and live bootstrap acceptance pending

## 0.11.0-beta.3.vorteo.240 - 2026-10-08

### Maintenance

- Bind native freeze, resume, unload, selection and startup adapters to exact bootstrap stages and ownership
- Require explicit kernel process-exit and service-removal evidence before replacement startup
- Atomically select verified launcher bytes without overwriting candidate or rollback artifacts; recheck release bytes before startup
- Keep replacement readiness verification, native runner wiring and visible review controls pending before activation

## 0.11.0-beta.3.vorteo.239 - 2026-10-08

### Maintenance

- Add generation-bound watchdog recovery that resumes only verified pre-transfer freezes and refuses ambiguous executor death
- Preserve recovery-required state after unload intent without replaying service operations
- Add a native ownership launcher whose kernel lock survives Node execution and releases on process death, verified with disposable fixtures
- Keep native lifecycle adapters, watchdog launching and visible review controls pending before activation

## 0.11.0-beta.3.vorteo.238 - 2026-10-08

### Maintenance

- Fence replacement coordinator startup by the exact bootstrap generation and approved installation paths
- Keep the restart journal, queue dispatch and account synchronization inert while serving bounded readiness status
- Refuse changed or missing handoff records and journal changes before release; retain ordinary startup behavior outside bootstrap
- Resolve the Dev HTTP test helper from its source location so tests work from the server workspace
- Keep native bootstrap execution, watchdog and owner review controls pending before activation

## 0.11.0-beta.3.vorteo.237 - 2026-10-08

### Maintenance

- Bind bootstrap dispatch to one durable generation and record operation intent before each execution step
- Reject active installation work and preparation children before coordinator transfer; verify stopped native process observations in disposable fixtures
- Resume the verified previous process after pre-transfer failures and require observed recovery after unload begins
- Keep native executor adapters, watchdog, visible approval controls and production activation pending

## 0.11.0-beta.3.vorteo.236 - 2026-10-08

### Maintenance

- Construct bootstrap review services from private Host setup, with fixed daemon identity and protected collector paths
- Reject exposed setup, changed collector configuration and changed state locations; verify that prepared requests remain pending
- Integrate this setup with the accepted Claude source while leaving production capability wiring and lifecycle activation pending

## 0.11.0-beta.3.vorteo.235 - 2026-10-08

### Maintenance

- Integrate Claude setup-token connections with the prepared coordinator bootstrap source, preserving both v227 histories and the browser icon test repairs
- Keep coordinator activation and live Host/Dev subscription acceptance pending the tracked installation workflow

## 0.11.0-beta.3.vorteo.234 - 2026-10-08

### Maintenance

- Combine bootstrap configuration, release, source receipt, launcher and process checks with repeated mount and artifact verification
- Parse captured launcher bytes through the native plist parser without exposing configuration values in errors
- Verify matching plans and reject runtime or mount changes during collection in isolated fixtures; production wiring and lifecycle activation remain unfinished

## 0.11.0-beta.3.vorteo.233 - 2026-10-08

### Maintenance

- Restore missing task-card icon exports in the browser test stub so task-card imports do not block component validation
- Add a native read-only service collector that verifies the process inspector's bytes and executes the captured source with fixed system tools
- Reject guest-writable inspector paths, incorrect digests and foreign service owners; verify that a later helper-file replacement cannot change executed code
- Preserve coordinator launcher environment, logging and lifetime settings while permitting only approved executable and configuration arguments; complete admission and lifecycle activation remain unfinished

## 0.11.0-beta.3.vorteo.232 - 2026-10-08

### Maintenance

- Bind the loaded coordinator service PID to the prepared kernel process identity, Host ownership, launchd parent and exact executable arguments
- Reject malformed or ambiguous service records and repeat service/process observations to catch replacement during verification
- Cover changed PID at each read and changed process birth identity; trusted collector wiring and lifecycle admission remain unfinished

## 0.11.0-beta.3.vorteo.231 - 2026-10-08

### Maintenance

- Add a read-only macOS process inspector for coordinator bootstrap, reporting kernel boot/start identity, owner, executable and argument digest without exposing arguments or environment values
- Recheck executable and arguments as well as process birth identity during inspection; reject missing processes with a sanitized failure
- Validate a disposable process and the installed coordinator without lifecycle changes; trusted helper admission and loaded-service integration remain unfinished

## 0.11.0-beta.3.vorteo.230 - 2026-10-08

### Maintenance

- Verify prepared coordinator release files against approval digests, including the executable, entrypoint, configuration, launcher and complete runtime tree
- Require candidate configuration to preserve installation credentials, service targets and state paths, allowing only the restart policy named in the plan
- Recheck dependency identities and configuration observations before returning; loaded-service admission and lifecycle activation remain unfinished

## 0.11.0-beta.3.vorteo.229 - 2026-10-08

### Maintenance

- Inspect bootstrap container mounts through an explicit local Docker socket, with bounded commands and exact container identity checks
- Require named-volume evidence and reject driver options that could conceal Host bind mounts; reject incomplete inspection results
- Verify Host configuration and state mount exclusion with read-only installation diagnostics; production bootstrap admission and activation remain unfinished

## 0.11.0-beta.3.vorteo.228 - 2026-10-08

### Maintenance

- Add optional coordinator bootstrap review RPCs and client methods, with daemon-management permissions, capability gating and sanitized errors
- Bind private coordinator configuration to the actual Host daemon and fixed installation service; reject exposed configuration and state directories
- Verify that disconnected approval requests are not replayed and owner proof does not enter client logs; production admission, plan verification and lifecycle execution remain unfinished

## 0.11.0-beta.3.vorteo.227 - 2026-10-08

### Added

- Connect Claude subscriptions once per managed installation through the official setup-token command, with private capture and authenticated delivery to Host and Dev
- Persist credential generations and disconnect records, retry offline delivery, and honor explicit environment exclusions without copying refresh grants

### Fixed

- Isolate subscription credentials from native Claude grants while preserving existing account history and conversation IDs during renewal
- Refuse incomplete or revoked credential delivery and environment-local sign-in on managed daemons
- Keep usage and reset controls from reading another native account, and clear only inherited native-login warnings after setup-token transition

### Maintenance

- Add synthetic CLI/SDK compatibility evidence, focused authentication, recovery, HTTP and UI tests, and document token lifetime, identity and usage limitations
- Installation delivery and live subscription acceptance remain pending; no private refresh endpoint or SDK callback is adopted

- Add inert coordinator bootstrap request contracts, independent owner authentication, exact revision checks and durable private request storage
- Validate complete prepared runtime artifacts, including dependencies, permissions and internal links, and reject paths overlapping writable container mounts
- Cover stale approval, concurrent cancellation and preparation, credential changes and artifact integrity in isolated tests; Host API, interface and lifecycle activation remain unfinished

## 0.11.0-beta.3.vorteo.226 - 2026-10-08

### Maintenance

- Integrate the coordinator bootstrap design with the published environment selector and worker workspace fixes, preserving both version 225 release entries

## 0.11.0-beta.3.vorteo.242 - 2026-10-09

### Fixed

- Give conversation cards one shared inset, heading height, icon column, title typography and centered action row. Remove the sub-agent left offset and Goal action top margin; keep Clear finished equally inset from the top and right.
- Put disclosure arrows after titles and before counts, including Plans. Keep question navigation and full prompts below a fixed Questions heading.
- Prevent per-card content inset overrides. Document the layout contract in app instructions and the design guide, and check rendered alignment, visible titles, clearance, overflow and fixed headers at desktop and phone widths.

## 0.11.0-beta.3.vorteo.241 - 2026-10-09

### Fixed

- Restore workspace three-dot menus to the far-right edge. Hover menus cover the task flower instead of appearing to its left; touch menus retain their reserved action space.
- Update the sidebar flower browser check to verify menu alignment and pointer targeting.

## 0.11.0-beta.3.vorteo.240 - 2026-10-09

### Changed

- Move the gold Host environment icon from beside workspace names to the trailing metadata group, after line-change counts and before the preview globe, badges, labels and task flower.

## 0.11.0-beta.3.vorteo.239 - 2026-10-09

### Fixed

- Keep conversation card headings outside their scrolling bodies while capping the complete card at half the viewport height. Apply the shared heading slot to tasks, messages, goals, sub-agents, questions, permissions and plans.
- Give managed and provider sub-agent groups separate bounded cards. Preserve collapsed body state and compact spacing.
- Extend desktop and phone browser checks for fixed headings, body scrolling and viewport resizing.

## 0.11.0-beta.3.vorteo.238 - 2026-10-09

### Changed

- Keep sub-agent names, status and profile/model/effort metadata on one line, with metadata immediately before right-edge actions. Remove row dividers and preserve action space on narrow screens.
- Add desktop and phone checks for row alignment, single-line metadata and overflow.

## 0.11.0-beta.3.vorteo.237 - 2026-10-09

### Fixed

- Preserve dropped task, message and provider order during asynchronous saves with a shared web/native handoff. Keep row content current and restore authoritative order on failure.
- Remove routine message reorder status while preserving rejection and recovery controls. Detect retained queue operations instead of treating their flush as a confirmed reorder.
- Add delayed-response, mouse rejection and desktop/phone frame checks for stable list positions; document the async drop contract.

## 0.11.0-beta.3.vorteo.236 - 2026-10-09

### Changed

- Make Messages and Goals collapsible while preserving their mounted contents and header actions. Collapsing does not pause execution.
- Share disclosure headings across managed and provider tasks, messages, goals and sub-agents, with the arrow after the title and before the count. Add desktop and phone collapse and ordering checks.

## 0.11.0-beta.3.vorteo.235 - 2026-10-09

### Fixed

- Keep transient queue operations, settings saves and compaction action feedback in stable single-line heading slots before action buttons. Reordering no longer adds and removes a progress row beneath queued messages.
- Preserve persistent errors and recovery controls. Add desktop and phone checks for unchanged queue card height, plus missing icon exports needed by browser test fixtures.

## 0.11.0-beta.3.vorteo.234 - 2026-10-09

### Maintenance

- Integrate shared footer layouts with queue recovery containment, preserving both changes and their release history.

## 0.11.0-beta.3.vorteo.233 - 2026-10-09

### Changed

- Standardize modal and card bottom actions with a shared right-aligned footer, spacing above and responsive wrapping. Keep task and label deletion and host removal red and on the far left, separated from ordinary actions.
- Document footer conventions and check task editor alignment, spacing and delete color at desktop and phone widths. Keep Close and Save together when the task footer wraps, and update label/profile browser navigation to the current interface.

### Fixed

- Keep queue recovery controls inside the Messages card when the server queue is empty. Retained local copies no longer display active synchronization errors.
- Retire rejected send-now controls whose target has left the queue, preserving message content, attachments and concurrent retries. Disable new immediate sends while delivery or local queue changes remain unresolved.
- Cover reconnect cleanup, retained edits, empty-queue recovery and desktop/mobile card layout with focused tests and a browser regression.

## 0.11.0-beta.3.vorteo.232 - 2026-10-09

### Maintenance

- Correct the sidebar activity badge browser check to inspect the accessible text inside the badge.

## 0.11.0-beta.3.vorteo.231 - 2026-10-09

### Changed

- Remove the sidebar goal badge and show the sub-agent count only for active work. Managed workers count while their turn is open, including waiting for input; provider workers count while running. Finished unarchived workers no longer keep the badge visible.

## 0.11.0-beta.3.vorteo.230 - 2026-10-09

### Added

- Add a Clear completed button to task headings when completed editable checklist items exist. Cleanup preserves unfinished and provider-owned tasks, removes dependency links, stops on concurrent-edit conflicts, and reports errors.

## 0.11.0-beta.3.vorteo.229 - 2026-10-09

### Changed

- Remove outlines from active blue task petals. Make one-, two- and three-task petals wider and fuller, bringing radial tips closer to the center while keeping a single petal centered upright.

## 0.11.0-beta.3.vorteo.228 - 2026-10-09

### Changed

- Add space around the slash in task heading count badges for managed and provider task cards.

## 0.11.0-beta.3.vorteo.227 - 2026-10-09

### Fixed

- Show active task rows with a white foreground outline spinner, using the shared status-ring animation in managed and provider task lists. Keep the completion control clickable while a task is active.
- Cover pending, active and completed row transitions at desktop and narrow widths.

## 0.11.0-beta.3.vorteo.226 - 2026-10-09

### Fixed

- Keep task flowers to the right of sidebar row actions on hover and touch, so the action menu cannot cover the progress indicator.

## 0.11.0-beta.3.vorteo.225 - 2026-10-09

### Changed

- Replace task-completion donuts with smaller rounded flower petals in sidebar rows and task-card headers. Show green completion, blue activity with an outline halo, and gray pending work; cap the display at twelve petals and summarize larger checklists proportionally.
- Center a single upright petal within its icon slot and keep sidebar flowers after all labels and badges.
- Hide empty task cards, move reorder handles to the left, and use the message edit pencil for task details.
- Expose exact completion and active counts on hover and keyboard focus. The new active-count text uses English fallback in other locales.

## 0.11.0-beta.3.vorteo.224 - 2026-10-08

### Fixed

- Keep the profile selector open when switching Host and Dev container, without a Host confirmation dialog.
- Keep active managed-worker workspaces visible in the sidebar, including workspaces with no terminals or running scripts. Preserve their project grouping and task relationships.

### Changed

- Add an opt-in protected policy for automatic approval of authenticated Host restart requests, using the existing finish-turns hold, durable journal and cancellation controls
- Keep Dev requests and mixed-origin source batches under manual review; identify Dev origin and its reason in installation controls
- Bind automatic approval to the exact request revision and source digest, preserve legacy client responses, and test repeated recovery without replay

## 0.11.0-beta.3.vorteo.223 - 2026-10-08

### Changed

- Let agents read and revise their own existing goals, including authorized resumption of blocked work, while preserving usage, budgets and restart holds
- Reject stale goal edits, foreign-thread selection and indirect limit bypasses; document the goal-tool extension in the README

## 0.11.0-beta.3.vorteo.223 - 2026-10-09

### Maintenance

- Combine 2 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.222 - 2026-10-08

### Maintenance

- Integrate task status guidance with the published conversation card and attribution fixes, preserving both version 221 release entries

## 0.11.0-beta.3.vorteo.221 - 2026-10-08

### Maintenance

- Update queue component test fixtures for shared card scrolling and heading icons
- Integrate the live conversation card refinements with published account readiness, saved history and delegated message attribution fixes; retain both branches’ release notes

## 0.11.0-beta.3.vorteo.221 - 2026-10-09

### Changed

- Require agents to mark checklist work in progress before starting, update status at work transitions, and complete items only after acceptance checks. Clarify pending and blocked work, parallel activity, and stale-state reconciliation in shared launch guidance, tool help, and repo/skill instructions.

## 0.11.0-beta.3.vorteo.220 - 2026-10-09

### Changed

- Add distinct heading icons to conversation detail cards: messages, targets, subagents, plans, questions and permissions. Keep task progress charts and show a pie icon for an empty checklist.

### Added

- Guard daemon and CLI configuration writes against competing supported writers and stale saved records
- Add origin inspection and one-shot admission with exact serving identity and separate active and persisted preconditions

### Maintenance

- Preserve current main and installed release-note history alongside reviewed Factory source; controller startup and live origin admission require separate review

## 0.11.0-beta.3.vorteo.219 - 2026-10-09

### Changed

- Remove horizontal separators between queued messages and pending recovery rows.

## 0.11.0-beta.3.vorteo.218 - 2026-10-09

### Fixed

- Center single-row and collapsed card headers with equal vertical padding. Remove the empty task list container and its trailing gap.

## 0.11.0-beta.3.vorteo.217 - 2026-10-09

### Changed

- Rename the message queue card heading to Messages.

## 0.11.0-beta.3.vorteo.216 - 2026-10-09

### Changed

- Collapse thread tasks into an accordion with a progress tag, an add icon, completion checkboxes, details icons and the same drag handles as queued messages. Keep task rows on one line without separators.
- Limit task, goal, queue, subagent, plan, question and permission cards to half the viewport height and scroll their contents internally.
- Let sortable drag handles own their keyboard controls instead of triggering the global voice shortcut.
- Make guarded interface-only publication the default for validated UI revisions during ongoing work. Preserve daemon installation approvals for changes that require daemon updates.

## 0.11.0-beta.3.vorteo.215 - 2026-10-09

### Maintenance

- Combine 6 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.214 - 2026-10-09

### Added

- Add discretionary blocked checklist status to Dev agent tools and persisted tasks, independent of prerequisite links.
- Advertise blocked status support and deliver incomplete pending items to older clients without changing saved task state.

### Changed

- Update checklist instructions for blocked work and retain blocked status in client caches and task drafts. The shared interface is delivered by the separate Host update.

## 0.11.0-beta.3.vorteo.214 - 2026-10-08

### Changed

- Integrate explicit sender provenance and shorter conversation rail marks for agent messages. Preserve previously deployed interface changes and historical release notes.

### Added

- Add an optional native macOS permission helper with authenticated local IPC and scoped Safari reads and interactions. Include signing, installation, rollback and diagnostics tooling without enabling them automatically.
- Bind staged helper identity and content to the validated build before changing the installed helper. Add isolated installer, adapter and browser tests.
- Document remaining production signing, managed installation, consent and permission-persistence acceptance. Source publication does not install the helper or establish live Safari access.

## 0.11.0-beta.3.vorteo.219 - 2026-10-08

### Fixed

- Preserve agent-message attribution through coordinator delegation and task creation so conversation navigation can distinguish these prompts from owner messages. Delegated prompts no longer create owner-message evidence, and retries cannot change a saved message's attribution.

## 0.11.0-beta.3.vorteo.218 - 2026-10-08

### Fixed

- Keep saved threads visible after moving their workspace to another project and archiving the original backing project. Agent and workspace directories now share the same active-membership policy; archived workspaces and threads remain excluded.

## 0.11.0-beta.3.vorteo.217 - 2026-10-08

### Tested

- Verify that creating and updating unfinished checklist items during a restart hold neither starts a turn nor prevents idle readiness. Existing goal and message-queue restart safeguards remain in effect.

## 0.11.0-beta.3.vorteo.216 - 2026-10-08

### Fixed

- Let paired Linux managed workers load their existing private installation client when an older supervisor omitted its environment variable. Validate file ownership, permissions, credential scope and transport before starting.
- Preserve explicit launcher configuration and exact coordinator admission checks. The repair uses a reviewed worker update without replacing the supervisor or changing Host and standalone launch behavior.

## 0.11.0-beta.3.vorteo.215 - 2026-10-08

### Fixed

- Keep shared account synchronization pending when an included environment lacks an enabled Codex or Claude account binding. Continue applying unrelated settings and preserve explicit exclusions through recovery.
- Clarify the pending account message and record the installation-wide connection contract for future implementation. This guard does not yet synchronize authentication or credential refresh.

## 0.11.0-beta.3.vorteo.213 - 2026-10-08

### Changed

- Distinguish agent-sent prompts with shorter conversation navigation marks. Preserve explicit provenance for local agent tool sends, worker creation and steering without guessing the sender of older messages.
- Cover optional protocol compatibility, saved history, dispatch and desktop navigation after reload. The README overview and onboarding are unchanged.

## 0.11.0-beta.3.vorteo.212 - 2026-10-08

### Fixed

- Recognize verified Claude account authentication when quota reporting cannot read saved macOS credentials. Explicit authentication failures still show Reconnect.
- Integrate desktop and compact sign-in, reload and sign-out coverage while preserving existing installation changes.

## 0.11.0-beta.3.vorteo.211 - 2026-10-08

### Fixed

- Integrate reviewed goal padding, independently expandable subagent sections and right-aligned question actions while preserving installed project, history, task retry and queue refresh behavior.

- Hide Connect for Claude accounts whose configured CLI has verified authentication, including macOS accounts with saved credentials that usage reporting cannot read. Keep explicit authentication recovery and unavailable quota separate.
- Cover successful sign-in without a credential file, reload, and subsequent sign-out at desktop and compact widths. Document the account and environment boundaries.

## 0.11.0-beta.3.vorteo.210 - 2026-10-08

### Fixed

- Integrate shared queue refresh after rejected operations while preserving local unsynchronized changes and attachment copies. Retain the installed project, history and creation retry fixes.

- Add room below goal content and align its controls. Give managed and provider subagents independent sections and scoped cleanup actions.
- Add vertical room to question forms and align wrapping Dismiss, Next and Submit actions to the right at desktop and compact widths.
- Integrate the reviewed spacing commits while preserving project selection, saved history, agent retry and queue refresh fixes.

- Integrate the published moved-workspace history repair. Active agent and workspace directories share membership policy, preserving saved threads after their original backing project is archived while retaining archive exclusions.

## 0.11.0-beta.3.vorteo.209 - 2026-10-08

### Fixed

- Allow edited agent drafts to retry confirmed pre-creation failures with their reserved identity. Preserve conflict protection for ambiguous or completed attempts and retain installed source and prior history repairs.

## 0.11.0-beta.3.vorteo.208 - 2026-10-08

### Fixed

- Preserve logical project selection when projects share a Host directory. List projects before their selected environment has a placement, and use existing folder mapping or folder selection at submission.
- Keep saved threads and schedule associations visible after restart. Read saved history without starting an unavailable provider.
- Integrate these repairs with the approved Host source and current interface.

- Refresh the shared message queue from rejected operation responses while retaining unsynchronized local changes and attachments. Do not replay a rejected operation automatically.

- Restore installation profile admission for paired managed Dev workers by discovering their validated private pairing client when supervisor inheritance is missing. Retain exact coordinator identity checks and the installed Factory source.

## 0.11.0-beta.3.vorteo.207 - 2026-10-08

### Fixed

- Keep restart explanations tappable by separating their hit target from the disabled approval button. Preserve the approved Host source and prior interface changes during integration.

- Allow an edited agent draft to retry after a confirmed pre-creation rejection while retaining its reserved agent identity. Keep changed requests blocked after execution, ambiguous failure, or workspace changes.

### Changed

- Preserve explicit provenance for local agent sends, worker creation and steering, and draw shorter conversation navigation marks for these messages. Integrate the reviewed source without changing Factory code or existing release notes.

## 0.11.0-beta.3.vorteo.206 - 2026-10-08

### Maintenance

- Preserve the approved Host update ancestry while integrating restart action explanations.

### Fixed

- Preserve logical project selection when projects share a Host directory. List projects before their selected environment has a placement, and use existing folder mapping or folder selection at submission.
- Keep unarchived saved threads visible when their provider is unavailable, preserving workspace history and schedule badge associations after restart. Read saved history without starting an unavailable provider.

- Allow edited agent drafts to retry confirmed pre-creation failures with their reserved identity. Preserve conflict protection for ambiguous or completed attempts and retain installed source and prior history repairs.

## 0.11.0-beta.3.vorteo.203 - 2026-10-08

### Maintenance

- Combine 2 source contributions; retain their release notes below

### Fixed

- Explain disabled installation and restart actions with the blocker and recovery steps on hover, keyboard focus and touch, without allowing approval through the tooltip.

### Added

- Connect the native Factory setup and initial installation RPC to the same startup-owned adapter, with fresh identity and revision checks and durable reconciliation holds after uncertain dispatch.
- Add CLI setup observations and guarded initial installation with explicit serving identity, revision and operation correlation. Transport loss never retries the mutation.
- Add initial installation controls that recheck the displayed native setup revision, send one correlated request and retain uncertain results across panel remounts without automatic retry. Fixtures cannot dispatch installation.
- Preserve incoming installation policy requiring the matching control button approval before restart or update execution.
- Preserve incoming project-folder/profile-environment selection fixes and their acceptance tests from current main.
- Preserve current main checklist and installation controls, the real installed Dev source ancestry and every parent release-note block alongside independently reviewed Factory and interface source.
- Keep default observer installation separate from retained-controller adoption. Controller custody, browser origin admission, installed RPC and authenticated client acceptance remain required.

## 0.11.0-beta.3.vorteo.205 - 2026-10-08

### Maintenance

- Integrate compact tooltip interaction with the deployed restart explanations.

### Fixed

- Keep restart explanations tappable by separating their hit target from the disabled approval button.

- Keep unarchived saved threads and scheduled workspace associations visible when a provider is unavailable. Read durable history without starting the provider.
- Preserve logical project identity and resolve the chosen environment folder at submission. Retain the installed Dev source and Factory integration.

## 0.11.0-beta.3.vorteo.204 - 2026-10-08

### Fixed

- Keep tapped tooltips open on compact screens when synthetic hover events follow the tap. Verify restart explanations after keyboard focus transitions.

### Maintenance

- Integrate disabled restart explanations and button approval instructions with the deployed installation source.

- Combine 2 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.202 - 2026-10-08

### Documentation

- Submit prepared maintenance requests without verbal approval prompts. Require the owner's exact button approval, including coordinator maintenance, and report unsupported request types without bypassing the managed workflow.

### Maintenance

- Integrate project environment selection and source batch corrections with the installed interface and pending checklist delivery ancestry.

## 0.11.0-beta.3.vorteo.201 - 2026-10-08

### Tests

- Wait for project membership persistence when verifying new workspace creation after a profile environment switch.

## 0.11.0-beta.3.vorteo.200 - 2026-10-08

### Tests

- Reopen the existing profile menu after an environment change in shared-project workspace acceptance, matching the composer's environment transition.

## 0.11.0-beta.3.vorteo.199 - 2026-10-08

### Fixed

- Retain unambiguous native project folders in shared project groups so the existing profile environment selector can start new workspace drafts. Keep the chosen shared project membership when creating the workspace.

### Maintenance

- Reconcile checklist installation ancestry with the live interface while preserving all published implementation and historical notes.

## 0.11.0-beta.3.vorteo.198 - 2026-10-08

### Fixed

- Reconcile intact release-note entries across concurrent source deliveries without requiring historical entries to remain a contiguous suffix. Edited or deleted history still requires explicit correction.
- Merge divergent contributions from their verified shared ancestor instead of replaying changes since an older bundle prerequisite. Ambiguous ancestry still requires explicit integration.
- Recheck pending source conflicts after coordinator recovery without approving or replaying installation. Show blocked update status and its cause in the sidebar.

### Maintenance

- Integrate accepted checklist controls and independent supervisor requests while preserving the live interface history and queued source contributions.

## 0.11.0-beta.3.vorteo.197 - 2026-10-08

### Maintenance

- Integrate persistent checklist delivery with installed source history, preserving historical release notes and the validated public implementation.

### Fixed

- Keep supervisor repair requests separate from pending source-update batches, preserving both contributions and owner controls. Approvals for the same environment still execute one at a time.

- Retain the live interface source in installation ancestry before building tracked supervisor controls. Preserve deployed implementation and release notes.

## 0.11.0-beta.3.vorteo.193 - 2026-10-08

### Fixed

- Refuse Dev updater bootstrap when the managed supervisor or worker lacks the installation-owned profile client binding. Explain the required launcher repair and reviewed supervisor restart.

### Maintenance

- Cover missing and mismatched profile client paths and document acceptance of the inherited launcher environment.

- Integrate managed preview recovery and exact-source Host build preparation with the installed Dev and interface histories. Retain their existing features and release notes.

## 0.11.0-beta.3.vorteo.192 - 2026-10-08

### Fixed

- Prepare Host updates by transferring only the approved source commit into a fresh repository. Avoid local clone object-copy races and unrelated branch references while preserving bundle and ancestry checks.

### Maintenance

- Verify that native build preparation retains no unrelated refs or shared object-store dependency and leaves the live interface unchanged.

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.191 - 2026-10-08

### Fixed

- Recognize managed Dev workers during preview recovery without changing their process arguments. Verify the selected release, executable, supervisor, ownership and stable process identity.

### Maintenance

- Add regression coverage for managed and legacy worker identity, release changes, ambiguous matches and PID reuse.

- Integrate managed Dev source updates with the installed release and accepted checklist contribution, preserving both source histories and prior release notes.

## 0.11.0-beta.3.vorteo.196 - 2026-10-08

### Added

- Add persistent, caller-scoped checklist read and mutation tools across providers, with stable task IDs, status, completion criteria, ownership, dependencies, metadata, deletion and ordering.
- Add manual task creation, editing, completion, reopening, deletion and ordering to the thread checklist card, with blocked-task errors and stale-edit protection.

### Fixed

- Preserve managed tasks through native provider events, history refreshes, concurrent storage writes and agent reloads. Broadcast checklist changes only after persistence succeeds.
- Retain Claude task details, dependency changes and metadata through native task updates and list refreshes; ignore failed tool writes and reconcile missing tasks.

### Changed

- Carry accepted pending checklist items and their completion criteria through planning, implementation and handoff instructions. Preserve native provider task ownership.
- Gate manual controls and client mutations on daemon capability; older installations retain their native checklist display.

### Maintenance

- Cover durable writes, lifecycle restoration, tool scope, live RPC updates and desktop and phone manual controls. Verify workspace completion across unopened threads and reloads. Updated daemon and interface installation remains required.

- Integrate tracked supervisor maintenance and profile launcher validation with the installed source history, retaining preview recovery and Host build repairs.

## 0.11.0-beta.3.vorteo.195 - 2026-10-08

### Fixed

- Route Dev supervisor repairs through visible, cancellable installation requests with exact-plan approval and verified replacement readiness. Keep ordinary worker restarts separate and refuse guest maintenance requests.
- Exclude inactive archived history from restart preparation while preserving active work, unknown failures and interruption safeguards.

### Maintenance

- Cover approval binding, cancellation, legacy clients, changed scripts and interrupted dispatch. Document protected Host preparation and the managed supervisor repair workflow.

### Added

- Bundle Factory project status, read-only setup observations and a client overview with exact host and project identity checks.
- Add native Factory membership protection, durable installation checkpoints and a retained-owner installation adapter that preserves reconciliation holds after partial effects.
- Add guarded workspace and retained-agent recovery boundaries and native account-contract observation without another sampler or scheduler.
- Enforce explicit prerelease plugin requirements while preserving ordinary stable-range matching.
- Preserve reviewed server contract compilation and generated asset copying in the standard build.
- Keep compact issue details clear of delivery rows and retain failed setup observations with explicit warnings.
- Preserve current main preview identity, launcher binding and visible coordinator controls alongside reviewed Factory source.
- Keep installation, controller adoption, execution admission and authenticated client acceptance separate. Loading source does not start another controller or authorize recovery.

## 0.11.0-beta.3.vorteo.194 - 2026-10-08

### Maintenance

- Require coordinator-tracked, visible and cancellable workflows for all Host and Dev daemon holds, restarts and supervisor maintenance. Prohibit direct lifecycle RPCs and shell restart bypasses even when chat approval exists.
- Require unsupported maintenance operations to be implemented in the managed workflow before draining or interrupting tasks.

## 0.11.0-beta.3.vorteo.190 - 2026-10-08

### Fixed

- Build Dev updates through the existing server and CLI build chain instead of calling a nonexistent script.
- Preserve managed worker process arguments and verify the pinned Node executable so installation can confirm the running release after startup.

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.189 - 2026-10-08

### Added

- Expose installation capability discovery and scoped Dev source updates through the installed maintenance client, with separate Host and Dev batches and exact owner approval.
- Build approved Dev source inside its existing container, select releases on worker restart, and verify the replacement executable while retaining the supervisor.
- Add Host bootstrap validation, private configuration backup and guest client and skill refresh for the managed Dev updater.

### Changed

- Require updated approval copy for Dev source installation and bind contribution retries and replacements to their target and requester.
- Teach planning and maintenance instructions to use supported installation operations before preparing a Host handoff.

### Maintenance

- Cover target isolation, authorization, release selection, failed builds, activation checks, retained rollback releases and client compatibility. Existing installations still require bootstrap and live acceptance; coordinator and supervisor replacement remain Host maintenance operations.

### Fixed

- Keep force restart out of initial approval and sidebar notices. Reveal it only after the operator marks an approved queued restart as stuck, with a separate interruption confirmation.
- Integrate the restart escalation interface with the installed release, preserving restart recovery and source-update behavior.

## 0.11.0-beta.3.vorteo.188 - 2026-10-08

### Added

- Show workspace checklist completion across all unarchived threads, including unopened threads, with a donut beside the workspace row and progress on each thread's bottom card.
- Persist native checklist snapshots in daemon records and the client cache so completion survives reloads.

### Changed

- Prepare implementation checklist items with completion criteria in plans and carry accepted plans into new threads through launch and handoff instructions.

### Maintenance

- Cover aggregation, native task persistence, client cache recovery and browser reload behavior. Older threads populate snapshots when their history loads or a provider updates its checklist.

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.187 - 2026-10-08

### Fixed

- Keep force restart out of initial approval and sidebar notices. Reveal it only after the operator marks an approved queued restart as stuck, with a separate interruption confirmation.

## 0.11.0-beta.3.vorteo.187 - 2026-10-07

### Maintenance

- Integrate restart recovery and compact review with the currently installed source, preserving both release histories.

## 0.11.0-beta.3.vorteo.186 - 2026-10-07

### Fixed

- Keep restart review to a short paragraph with technical details collapsed, and label source installation Updating while builds are running.
- Recover restart-held goals without queued messages and retain durable continuation for ordinary threads asked to finish. Preserve manual pauses, block new goal activation during a hold, and distinguish restart pauses in the interface.

## 0.11.0-beta.3.vorteo.186 - 2026-10-08

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.185 - 2026-10-07

### Fixed

- Show current source-update submissions once in installation review. Keep superseded submissions in collapsed history while retaining current conflicts and the exact approval digest.

## 0.11.0-beta.3.vorteo.184 - 2026-10-07

### Fixed

- Accept source contributions that already integrate the published interface, preserving their reviewed release history instead of merging it again against an older runtime. Divergent contributions retain metadata conflict checks and every update still requires exact-source approval.
- Cover an installed interface with reconciled historical notes and a submitted descendant, including preserved ancestry and refusal of an unresolved divergent contribution.

## 0.11.0-beta.3.vorteo.183 - 2026-10-07

### Maintenance

- Integrate the latest main publication with the reviewed workspace and profile refinements. Preserve both source histories and reconcile release notes and version metadata without changing the validated implementation.

## 0.11.0-beta.3.vorteo.182 - 2026-10-07

### Changed

- Show the selected account beside both expanded and compact profile captions.
- Restore environment, account and profile selection in three desktop columns and compact sections while retaining draft text, files and directory choices.
- Balance conversation-card top spacing at four pixels and match accordion controls to adjacent actions on desktop and touch layouts.
- Align Standing disclosure arrows with workspace status indicators and use the standard collapsed count badge.

### Fixed

- Block workspace and thread archival for explicit protection and active or paused schedules. Explain the blockers with a disabled lock action and guard archive shortcuts.
- Refuse blocked agent archive requests before cancelling the running turn, and preflight companion workspaces before archival.
- Preserve current main changes, preview-globe styling and verified-preview recovery source. Add the label icon to browser test fixtures.

### Added

- Integrate reviewed Dev source uploads and digest-bound Host daemon and interface installation into main, preserving current preview and interface changes.

### Maintenance

- Preserve the installed source-update commit in main history and reconcile version metadata and release notes.

## 0.11.0-beta.3.vorteo.181 - 2026-10-07

### Fixed

- Keep sidebar preview globes neutral across healthy and unhealthy services, and inset them four pixels from the right edge to align with neighboring content. Service health remains available in accessible labels.

## 0.11.0-beta.3.vorteo.180 - 2026-10-07

### Added

- Combine pending Host source contributions into one reviewed release with immutable receipts, preserved provenance and one exact-source installation approval
- Freeze approved batches and queue later submissions separately; retain conflicts for explicit correction

### Changed

- Separate Vorteo workers from provider subagents, explain missing model metadata and distinguish dismissal from archival
- Smooth the sidebar action overlay with an eased fade that matches its row background

### Fixed

- Share plain restart requests per target and show Host and Dev controls together with explicit force confirmation
- Restore account reset counters when shared profiles name a provider family
- Preserve newer published interface source and reconcile generated release versions, internal pins, lock entries and appended release notes during inert preparation

### Maintenance

- Integrate Standing and schedule controls, pull request activity, card spacing and repository links with the reviewed Host update workflow

- Cover Git integration, release metadata, hostile configuration, concurrency, recovery and approval races; coordinator installation remains separate from source validation

### Added

- Opt-in recovery of previously verified workspace previews after daemon restarts, retaining their private HTTPS reservations and rechecking service, listener and certificate identity.
- Bounded retry coverage and installer controls that preserve existing policy when omitted. Explicit stops, archived or changed workspaces, and unrecognized replacement processes remain protected.

### Maintenance

- Update preview operation, host acceptance and customization documentation. Real restart acceptance remains a separate installation check.

## 0.11.0-beta.3.vorteo.179 - 2026-10-07

### Fixed

- Remove redundant top padding from goal, task progress, message queue and subagent cards while preserving header heights and touch targets.
- Update desktop and compact conversation-card spacing assertions and the shared design guidance.

## 0.11.0-beta.3.vorteo.178 - 2026-10-07

### Changed

- Replace the Star, Sponsor and Community footers in Settings and Open Project with one GitHub icon and link to `AubreyF/vorteo`

## 0.11.0-beta.3.vorteo.177 - 2026-10-07

### Changed

- Extend the sidebar PR link with Awaiting merge for GitHub auto-merge or queue membership and Merging while a client-submitted merge is pending.
- Align Standing headings with workspace dots, match workspace title size, show the count as a badge only while collapsed, and use a full-row highlight with a leading disclosure arrow.
- Derive Standing membership from workspace schedules and archive protection, retaining paused schedules with a Paused badge.
- Open workspace-scoped schedules from Tag As and sidebar badges, with explicit thread selection for new schedules.
- Keep existing custom labels visible and distinguish reserved names; remove the empty custom-label heading.
- Cover schedule state, thread schedule creation, protection and menu behavior with focused tests.

### Added

- Submit committed source from Dev for owner-reviewed Host daemon and interface installation, with approval bound to the revision and bundle digest

### Fixed

- Reject idle, finish-current-turns and replay actions for source updates; build native dependencies after installation approval

### Maintenance

- Document protected Host setup, source provenance, stable release selection and partial-update recovery

## 0.11.0-beta.3.vorteo.176 - 2026-10-07

### Fixed

- Name the Host and Dev daemons explicitly in restart banners and keep the banner's top divider visible while messages scroll

### Maintenance

- Require agents to check supported installation-maintenance and preview operations before preparing host continuity prompts, while preserving owner restart approval
- Cover queued daemon labels and the stationary banner divider in the installation browser suite

## 0.11.0-beta.3.vorteo.176 - 2026-10-08

### Added

- Show workspace checklist completion across all unarchived threads, including unopened threads, with a donut beside the workspace row and progress on each thread's bottom card.
- Persist native checklist snapshots in daemon records and the client cache so completion survives reloads.

### Changed

- Prepare implementation checklist items with completion criteria in plans and carry accepted plans into new threads through launch and handoff instructions.

### Maintenance

- Cover aggregation, native task persistence, client cache recovery and browser reload behavior. Older threads populate snapshots when their history loads or a provider updates its checklist.

## 0.11.0-beta.3.vorteo.175 - 2026-10-07

### Fixed

- Migrate legacy Protected labels into real archive protection and use one built-in lock badge
- Reserve Protected against custom label creation and preserve migration recovery across interrupted writes

## 0.11.0-beta.3.vorteo.174 - 2026-10-07

### Maintenance

- Select the saved profile explicitly in packaged task-environment and conversation-handoff browser tests after choosing its account

## 0.11.0-beta.3.vorteo.173 - 2026-10-07

### Added

- Integrate task environment selection, retained drafts and uploads, companion workspace associations and mixed-environment task tabs with the current installation source

### Fixed

- Preflight protection for every associated workspace before cross-environment archival

## 0.11.0-beta.3.vorteo.172 - 2026-10-07

### Added

- Expand compaction markers to inspect, copy and export saved summaries, with available token counts and retained-entry metadata
- Preserve readable provider summaries through timeline replay and cache reloads, and explain missing or unavailable summaries

## 0.11.0-beta.3.vorteo.171 - 2026-10-07

### Fixed

- Match sidebar menu overlays and fades to selected, hovered, pressed and idle row backgrounds in every workspace grouping

## 0.11.0-beta.3.vorteo.170 - 2026-10-07

### Changed

- Fade sidebar badges beneath the overlaid workspace menu and round the button corners on hover without moving the badges

## 0.11.0-beta.3.vorteo.169 - 2026-10-07

### Changed

- Give sidebar counters, goal badges, Scheduled, Protected and custom labels matching vertical padding between the previous tall and compact sizes

## 0.11.0-beta.3.vorteo.168 - 2026-10-07

### Changed

- Open the full changelog from Settings on the Vorteo GitHub repository

### Maintenance

- Require staged, dated changelog entries for every commit before changing version manifests
- Document changelog scope and link version history from the README

## 0.11.0-beta.3.vorteo.167 - 2026-10-07

### Changed

- Match workspace labels to activity badge height and use a lock for Protected
- Keep built-in Standing and Protected names out of custom labels
- Overlay sidebar menus without shifting row contents

## 0.11.0-beta.3.vorteo.166 - 2026-10-07

### Changed

- Show worker profile codes and model configuration, remove duplicate native task names, and let finished native workers be hidden individually

- Use full-width tab baselines and rounded top corners across environment and provider settings

- Place Environments, Providers and Agent profiles directly below General in Settings.
- Show one provider family at a time in Agent profiles, filter skills by provider discovery, and keep delegation settings on individual profiles.
- Preserve explicitly selected worker accounts across installation environments. Account editing becomes available after the coordinator and every environment support it.

### Fixed

- Finish account sign-in with a clear success message and Done button instead of leaving the connection panel saying usage is refreshing.
- Use an available account catalog for shared provider defaults so a disabled base provider does not hide mode and model choices.

## 0.11.0-beta.3.vorteo.165 - 2026-10-07

### Changed

- Show prepaid balances and Using prepaid in account selection when included usage runs out, while keeping the reset time visible.

### Fixed

- Keep reset button text gray even when account usage is nearly exhausted.
- Display Codex usage credits as credits rather than dollars.

## 0.11.0-beta.3.vorteo.164 - 2026-10-06

### Changed

- Restart notices show one sentence about the change, with older long descriptions under Details.
- Sidebar restart headings distinguish queued and restarting states, show a progress spinner, and keep individual task details in Installation controls.

## 0.11.0-beta.3.vorteo.163 - 2026-10-06

### Changed

- Align compact Protected, Scheduled and custom label badges on the workspace title row. Reveal the menu at the far right by sliding trailing content left on hover; retain visible touch controls.

## 0.11.0-beta.3.vorteo.162 - 2026-10-06

### Added

- Finish current turns before restart: hold new work, warn active threads, preserve goal intent, and restart once their current turns have finished.
- Cancel a restart hold or request a canceled restart again with fresh approval.
- Escalate a queued restart to an immediate restart only after separate confirmation.

## 0.11.0-beta.3.vorteo.159 - 2026-10-06

### Changed

- Combine Standing, Protected and custom labels under Tag As in workspace menus. Add lifecycle and project-move icons, keep Create Label last, and distinguish custom labels that share lifecycle names.

## 0.11.0-beta.3.vorteo.157 - 2026-10-06

### Changed

- Lead restart requests with their explanation, hide technical notes under Details, and remove request IDs, requester metadata and expiry boilerplate.

## 0.11.0-beta.3.vorteo.156 - 2026-10-06

### Changed

- Keep installation access, restart requests and expandable history in one card without duplicate environment summaries.

## 0.11.0-beta.3.vorteo.155 - 2026-10-06

### Changed

- Show each provider family once, with its accounts inside and shared enable controls. Keep local sign-in and credential management in an explicit dialog.
- Reveal older What's new entries automatically while scrolling.
- Explain Vim editing modes and basic shortcuts in Editor preferences.
- Place Providers directly below Environments and remove the gap above Environments.
- Replace QR and pairing-link onboarding with direct Tailscale connections while preserving existing connection authentication.

### Fixed

- Remove and restore shared providers without deleting credentials, saved profiles or task histories.
- Save shared settings without waiting behind slow environment synchronization, and report unconfirmed operations within ten seconds.

## 0.11.0-beta.3.vorteo.154 - 2026-10-06

### Changed

- Share one saved profile across accounts, choose the account separately, and consolidate exact duplicate profiles
- Run same-provider subagents on the parent’s selected account while retaining worker model and reasoning settings and support for local Pi workers

### Fixed

- Hide incompatible profiles from the launch picker and distinguish catalog loading failures from unavailable models, with Retry and specific details in Manage profiles

## 0.11.0-beta.3.vorteo.153 - 2026-10-06

### Added

- Mark ongoing workspaces Standing and keep them in a collapsible section within each project.
- Protect workspaces against accidental workspace, chat, and project archives. Standing enables protection automatically; remove protection explicitly when the work is finished.
- See a simple Scheduled badge on workspaces targeted by agent schedules, including paused schedules, and open Schedules from the badge.

## 0.11.0-beta.3.vorteo.152 - 2026-10-06

### Fixed

- Keep moved worker workspaces in their chosen project so automatic sidebar grouping does not hide the destination

## 0.11.0-beta.3.vorteo.151 - 2026-10-06

### Fixed

- Keep empty projects visible through sidebar refreshes on daemons without a separate project list

## 0.11.0-beta.3.vorteo.152 - 2026-10-07

### Changed

- Select a new task's environment separately from its account and profile, keeping the draft in place
- Keep Host and Dev container tasks in one visible workspace, with environment labels on task tabs
- Reuse exact shared-folder mappings or an explicitly chosen destination folder instead of guessing from another workspace

### Fixed

- Preserve drafts on connection and attachment-transfer failures when starting a task in another environment
- Route conversation loading and task actions to the task's environment after reload

## 0.11.0-beta.3.vorteo.150 - 2026-10-06

### Changed

- Keep environment tabs visible above scrolling settings, showing one environment at a time on desktop and mobile

## 0.11.0-beta.3.vorteo.149 - 2026-10-06

### Changed

- Use a borderless ghost Back button in Settings with a visible hover background

## 0.11.0-beta.3.vorteo.148 - 2026-10-06

### Changed

- Align mobile profile chooser labels and selections across a common center split, show selection colons, and fit profile tiles into two columns when space allows

## 0.11.0-beta.3.vorteo.147 - 2026-10-06

### Fixed

- Keep worker worktrees with independent follow-ups under their originating project without hiding tasks, terminals or running scripts
- Fold unused inherited script definitions beneath the originating task instead of retaining duplicate worker projects

## 0.11.0-beta.3.vorteo.146 - 2026-10-06

### Fixed

- Keep account names in the same natural order across Host and Dev container, independent of provider registration order

## 0.11.0-beta.3.vorteo.145 - 2026-10-06

### Changed

- Tint selected profile tiles orange, match circled heading colors, and shorten reset badges with hover feedback confined to their borders

## 0.11.0-beta.3.vorteo.144 - 2026-10-06

### Changed

- Tighten message queue padding and share compact content insets across bottom conversation cards

## 0.11.0-beta.3.vorteo.143 - 2026-10-06

### Changed

- Widen profile activation and switching buttons to align with their card, match its rounded corners and add a forward arrow

## 0.11.0-beta.3.vorteo.142 - 2026-10-06

### Changed

- Stagger account entrances and gently sweep profiles and their details into view when chooser selections change
- Respect reduced-motion preferences and keep usage refreshes from replaying chooser animations

## 0.11.0-beta.3.vorteo.141 - 2026-10-06

### Changed

- Restore hover and pressed feedback on selected and unselected profile chooser tiles
- Tighten line spacing, retain equal tile heights, and halve the tiles' right padding

## 0.11.0-beta.3.vorteo.140 - 2026-10-06

### Fixed

- Omit the percent sign at 100 in the usage ring so the label fits; retain it at 99 and below

## 0.11.0-beta.3.vorteo.139 - 2026-10-06

### Fixed

- Validate Host startup before dispatching an approved restart. Report invalid field paths and recovery instructions without exposing configuration values.
- Keep configuration validation in the selected supervisor release so older bootstrap code cannot reject newer provider settings.
- Preserve restored Host provider bindings during shared settings migration, including legacy Codex sessions.

### Changed

- Add circled step numbers to Environment, Account and Profile headings on desktop and mobile

## 0.11.0-beta.3.vorteo.137 - 2026-10-06

### Changed

- Restore background highlights and increase corner rounding for selected environment, account and profile tiles
- Compact reset badges, balance chooser header spacing and give the account column more width

## 0.11.0-beta.3.vorteo.135 - 2026-10-06

### Changed

- Use one Settings navigation and one shared profile catalog for Host and Dev container, with explicit profile and resource exclusions
- Share provider policy, instructions, metadata choices, terminal definitions, skills, plugins and browser-tool defaults while preserving local credentials and paths
- Remove the alternate Paseo mode and its behavior switches; installing Vorteo does not install a separate Paseo application
- Keep delegated agents under their originating task and project when they run in separate worktrees

### Fixed

- Preserve existing account and worker references during profile consolidation, including accounts initially present in only one environment
- Enforce current environment exclusions for new tasks and internal metadata generation, while existing tasks retain their saved launch configuration
- Keep instruction drafts after failed or conflicting saves and show retryable errors for shared settings
- Route managed environment maintenance to the installation's existing restart approval controls

## 0.11.0-beta.3.vorteo.134 - 2026-10-05

### Changed

- Messages waiting to synchronize show a muted orbit that fades in, then fades out before the grab handle appears. Quick acknowledgements can skip the orbit without flashing.

## 0.11.0-beta.3.vorteo.133 - 2026-10-05

### Added

- Keep restart requests until decided and show requested and queued restarts in a persistent sidebar banner
- Queue owner-approved restarts until all active tasks finish, with elapsed waiting time and cancellation

## 0.11.0-beta.3.vorteo.132 - 2026-10-05

### Fixed

- Explain when an older Claude Code CLI hides newer models, with the installed version, model requirements and update instructions in provider settings and the account and model pickers
- Clear CLI compatibility warnings after upgrading and refreshing the provider

## 0.11.0-beta.3.vorteo.131 - 2026-10-05

### Changed

- Open the profile chooser immediately and show loading indicators inside its account and profile sections
- Match environment, account and profile tile heights, typography and line spacing
- Place remaining usage at the account tile's upper right, with reset timing and credits on the second line

## 0.11.0-beta.3.vorteo.130 - 2026-10-05

### Added

- Link maintenance tasks directly to the exact restart approval in General settings, preserving owner unlock and showing expired or missing requests without selecting another request

## 0.11.0-beta.3.vorteo.129 - 2026-10-05

### Changed

- Animate profile activation and switching actions and reclaim their space when hidden
- Widen environment descriptions, move resets to the profile header, and give account rows more breathing room
- Use a two-column profile grid on wide screens and indent formatted permission and worker details

## 0.11.0-beta.3.vorteo.127 - 2026-10-05

### Changed

- Simplify the profile chooser with Host first, environment risk descriptions, matching tile heights and rounded orange selection borders
- Move Activate Profile and Switch to Profile below the scrolling profile card and hide the action for the active selection
- Remove account search and restore the ghost Manage profiles button
- Show the selected profile name in the closed chooser instead of always showing Choose profile

## 0.11.0-beta.3.vorteo.126 - 2026-10-05

### Added

- Drag providers in Settings to save their order and use it in the profile picker

### Fixed

- Allow deleting Antigravity and Muse Code and keep deleted plugin providers removed after restart

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

## 0.11.0-beta.3.vorteo.211 - 2026-10-09

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.209 - 2026-10-09

### Maintenance

- Combine 4 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.213 - 2026-10-09

### Maintenance

- Combine 1 source contributions; retain their release notes below

## 0.11.0-beta.3.vorteo.212 - 2026-10-09

### Changed

- Apply accepted task-status guidance to the installed Dev source: require in-progress updates before execution, current status at work transitions, and verified completion. Preserve installed Factory code and complete release history from both source branches.

## 0.11.0-beta.3.vorteo.563 - 2026-10-16

### Fixed

- Remove web tooltips directly on dismissal so interrupted animations cannot leave small floating boxes behind. Preserve hover, keyboard focus and native tooltip fades; add browser regression coverage with the real animation library.

## 0.11.0-beta.3.vorteo.561 - 2026-10-15

### Changed

- Keep the message queue at the bottom of the primary conversation whether the details sidebar is open or closed. Preserve inline editing across sidebar toggles and keep queue review, saving and sending controls in that location.

## 0.11.0-beta.3.vorteo.560 - 2026-10-15

### Changed

- Expand General connection diagnostics with independent health HTTP, WebSocket handshake, cross-origin response and enforced browser content-policy evidence. Keep hidden DNS, TLS, VPN and device-permission failures explicitly unknown.
- Compare saved app addresses and authentication with the installation endpoints; include device network hints, exposed local-network permission and interface source in a copyable report without credentials or storage contents.
- Provide one-click browser error pages and a selectable report when clipboard access fails. Validate real HTTP, WebSocket, cross-origin failure and responsive rendering without daemon changes.
