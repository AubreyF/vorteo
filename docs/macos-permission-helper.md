# Native macOS permission helper

The optional helper provides a signed native **Vorteo** identity for narrowly scoped Host Safari automation. It supports tab discovery and selection, bounded public UI snapshots, navigation to configured destinations, and interaction with previously identified elements. It preserves Safari sessions. The calling Host integration owns the actual plugin or tunnel setup.

Source tests do not establish live privacy acceptance. Production signing, owner consent, Safari JavaScript enablement, TCC attribution and changed-build grant persistence require verification on the target Mac. Installation enables neither daemon integration nor login autostart.

## Identity and consent

The app uses `com.vorteo.macos-helper`, displays Vorteo, and installs at `~/Applications/Vorteo Permission Helper.app`. Its client uses `com.vorteo.macos-helper.client`. Launch through Launch Services using the installer, never by spawning the main executable under Node. The Electron desktop identity remains separate.

Hardened runtime remains enabled. The app carries only `com.apple.security.automation.apple-events` and an `NSAppleEventsUsageDescription`. The native client has no Automation entitlement. Supported operations request Safari Automation only. They do not require Accessibility, Screen Recording, Full Disk Access or System Events. Apple documents the [Apple Events entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events), [usage description](https://developer.apple.com/documentation/bundleresources/information-property-list/nsappleeventsusagedescription), and [native application launch](<https://developer.apple.com/documentation/appkit/nsworkspace/openapplication(at:configuration:completionhandler:)>).

Use Developer ID Application signing for distribution. A dedicated local identity is also supported for an explicitly authorized single-Mac installation. See [macOS signing setup](macos-signing.md), including transferring an existing certificate with its private key. No certificate creation, import or trust change happens automatically. The installer preserves the original signing requirements and capability, and rejects incompatible replacements. Signing strategy migration requires separate review.

Ad hoc signing is restricted to an isolated preview with separate identifiers, state and application path. The preview refuses consent prompts. A stable signature improves continuity; macOS may still require consent again after identity, policy or system changes.

## Build and install

On managed installations, use the installation coordinator's required tracked approval workflow for runtime activation. The commands below are lifecycle primitives, not permission to bypass Installation controls. This package does not add a coordinator request type for helper installation. If the required operation is unsupported, prepare that managed workflow before changing the runtime.

Run on native macOS with Xcode command-line tools. Use a new output directory outside Git and guest mounts. Build receipts record source provenance, version, architecture and signature beside the app.

```sh
node packages/macos-helper/build.mjs /private/task-artifacts/helper-build 'Developer ID Application: Your Organization (TEAMID)'
node packages/macos-helper/install.mjs install '/private/task-artifacts/helper-build/Vorteo Permission Helper.app'
node packages/macos-helper/install.mjs diagnostics
```

For an authorized existing local identity, use its certificate SHA-1 fingerprint and append `--local-signing` to build and all signature-validating installer commands. Its designated requirements pin that certificate. A new certificate therefore requires migration. Local signing is not a notarized distribution.

For distribution, obtain permission to upload the app to Apple, configure an existing `notarytool` keychain profile, then run `node packages/macos-helper/notarize.mjs '<signed-app>' '<profile>'`. The script archives, submits, staples and assesses the app. It does not handle plaintext account credentials or disable Gatekeeper.

Choose **Allow Safari Automation** in the Vorteo menu bar, or invoke `safari.request-consent` through the authorized adapter. Approve the native prompt. Verify **System Settings > Privacy & Security > Automation > Vorteo > Safari**. A denial returns a status; no operation resets privacy grants.

UI reads and interactions also require Safari's separate **Allow JavaScript from Apple Events** setting. In current Safari, enable web developer features in **Settings > Advanced**, then enable **Settings > Developer > Automation > Allow JavaScript from Apple Events**. Older versions expose this in the Develop menu. Apple documents the [Developer settings](https://developer.apple.com/documentation/safari-developer-tools/developer-settings). Only the owner enables it. A missing preference key is inconclusive; a real bounded read after Automation consent determines whether the setting works. The helper reports `safari_javascript_consent_required` when Safari explicitly identifies this restriction. Other Apple event errors expose only their numeric code.

## Trusted browser scope

Private state lives under `~/.local/share/vorteo-macos-helper`, mode `0700`. The configuration, policy and Unix socket are `0600`. Keep them and the app outside guest-writable mounts. There is no TCP, web or Dev endpoint.

The installer deliberately does not create `browser-policy.json`. The trusted Host operator prepares this file, owned by the Host user and mode `0600`, from [the example](../packages/macos-helper/browser/policy.example.json). Its fields are:

| Field            | Scope                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `allowedOrigins` | Exact canonical HTTPS origins, initially `https://chatgpt.com` and `https://platform.openai.com`. No wildcards.                  |
| `tabs`           | Explicit `{windowId, tabIndex}` pairs selected from discovery. Empty by default; discovery alone grants no interaction.          |
| `destinations`   | Named `{id, url}` entries for exact approved navigation destinations. Each origin must be allowed.                               |
| `allowedText`    | Exact public UI phrases permitted in snapshots, at most 200 phrases of 160 characters. Never add secrets or account identifiers. |
| `actions`        | Enabled actions from `read`, `select`, `navigate`, `click`, `fill`, `choose`.                                                    |

The calling Host integration must inspect actual official authentication redirects and verify their ownership before adding any required origins or destinations. None are guessed or enabled by default. A redirect outside the policy blocks the next operation. Do not broaden the allowlist to work around an unexpected page.

Discovery returns at most 80 matching tabs with window ID, tab index and origin. It exports no raw URL or title. Add only the intended tab references to the private policy. Tab indexes can change when tabs move or close; rediscover and review scope before continuing. Current origin is checked again for every operation. The native handler compares the URL immediately before acting, and the fixed page program checks `location.origin` before accessing the DOM.

## Host adapter

Import `invokeHelper` from the installed private `host.mjs`, or use the installed `invoke.mjs`. The stable dispatcher loads the selected app's signature-sealed adapter in a fresh Node process on every request. Requests and sensitive fill values travel through stdin, never shell arguments or environment variables.

```js
const { invokeHelper } = await import("/private/host-runtime/host.mjs");
const discovered = await invokeHelper("safari.discover");
// After the Host operator authorizes the intended tab in browser-policy.json:
const tab = { windowId: 123, tabIndex: 2 };
const snapshot = await invokeHelper("safari.read", { parameters: tab });
if (snapshot.ok) {
  const create = snapshot.data.elements.find((item) => item.label === "Create");
  if (create && !create.disabled) {
    await invokeHelper("safari.click", {
      parameters: { ...tab, pageId: snapshot.data.pageId, element: create.handle },
    });
  }
}
```

| Operation                                                    | Parameters and result                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `status`, `safari.request-consent`, `safari.summary`, `quit` | No parameters. Summary returns counts only.                                                                               |
| `safari.discover`                                            | No parameters. Returns allowed-origin tab references.                                                                     |
| `safari.read`                                                | `windowId`, `tabIndex`. Returns `origin`, `pageId`, `readyState`, up to 20 headings and 80 visible controls.              |
| `safari.select`                                              | Tab reference. Makes that tab current and activates Safari.                                                               |
| `safari.navigate`                                            | Tab reference plus configured `destination` ID. Starts navigation.                                                        |
| `safari.click`                                               | Tab reference plus snapshot `pageId` and element handle.                                                                  |
| `safari.fill`                                                | Same reference plus `value`, at most 4096 UTF-8 bytes. Supports text, email, password, URL, search and textarea controls. |
| `safari.choose`                                              | Same reference plus an approved public option label in `value`. Supports native select controls.                          |

Snapshots expose control type, approved label, disabled/checked state and approved option labels. They omit field values, arbitrary body text, raw URLs, option values, cookies, storage, generated keys and account names. Unapproved text becomes `[withheld]`. Native decoding filters labels again and discards unknown fields. A public phrase that happens to match a private value is indistinguishable, so keep `allowedText` limited to reviewed UI copy. Do not log fill parameters or onboarding credentials.

Element handles are tied to the last snapshot, the same visible connected node, its identifying text, control type, destination, form action and option definitions. Disabled, ARIA-disabled and inert controls cannot be acted on. Every interaction invalidates all handles. Read state again before another action. Anchors must match exact configured destinations; buttons can trigger application redirects, so recheck the next origin. Cross-origin frames and shadow DOM are unsupported. Fixed DOM events may not satisfy pages requiring trusted physical input; report that limitation to the calling Host integration rather than adding a generic execution endpoint. The helper accepts no caller JavaScript, AppleScript, selectors or shell commands.

Both native peers check the same Unix user and the connection's kernel audit token against the retained code requirement using [SecCodeCopyGuestWithAttributes](<https://developer.apple.com/documentation/security/seccodecopyguestwithattributes(_:_:_:_:)>) and signature validation. The helper additionally requires a private capability. Frames, snapshots and deadlines are bounded; errors are sanitized. This rejects arbitrary processes that lack the signed client and capability. It does not isolate other processes with full access to the owner's account: those can read the capability and launch the approved client. Keep untrusted workloads in Dev.

A timed-out write has an unknown outcome. Inspect state before retrying; never automatically replay clicks or navigation. The helper cannot approve installation maintenance. To revoke browser access, remove the policy or actions, turn off the native Safari Automation grant, and uninstall as needed.

## Upgrade, rollback and recovery

Install a new independently built bundle using the same signing strategy. Validation precedes shutdown. Only this helper is stopped through authenticated IPC; agent daemons remain running. A private lock serializes lifecycle changes. Inspect an abandoned operation before removing its lock.

The native app and evolving Host adapter are one signed release. Only stable dispatchers live separately in the runtime directory. Selecting or exchanging bundles also selects the corresponding protocol adapter, without a cached module surviving rollback. The installer refuses old bundles missing the sealed adapter; it does not silently roll back to an incompatible legacy layout.

```sh
node packages/macos-helper/install.mjs rollback
node packages/macos-helper/install.mjs launch
node packages/macos-helper/install.mjs uninstall
```

One previous bundle is retained at the adjacent `.previous` path. Rollback validates its original requirements and exchanges the bundles. The capability and policy remain private and unchanged. A future incompatible policy migration must be reviewed with rollback in mind. `launch` removes a stale socket only after confirming the helper is absent and launches a fresh native instance through Launch Services. It never kills a process for recovery. After failed selection or readiness, inspect diagnostics and use the retained rollback. IPC readiness does not establish Safari permission.

Uninstall removes the app, previous app and private runtime, including browser policy and capability. It does not erase TCC records, signing identities, Safari sessions, credentials or native threads. Review macOS settings to revoke grants. Any future agent daemon deployment uses the exact owner-approved installation-maintenance workflow after preparation and checks.

## Verification

Run repository lint and typecheck plus focused source tests:

```sh
npx vitest run packages/macos-helper/install.test.mjs packages/macos-helper/host.test.mjs packages/macos-helper/browser.test.mjs packages/macos-helper/dispatch.test.mjs --bail=1
```

Installer fixtures verify staged signature and content binding before any lifecycle action. Browser tests run the actual fixed page program in a local Chromium DOM fixture. They verify filtering, data-only fill, origin checks, destination rejection and stale handles. The adapter test uses distinct release protocols to verify compatible selection through rollback. These tests do not prove live Safari behavior.

```sh
node packages/macos-helper/build.mjs /private/task-artifacts/helper-preview - --preview
node packages/macos-helper/install.mjs install '/private/task-artifacts/helper-preview/Vorteo Permission Helper.app' --preview
node --test packages/macos-helper/native.acceptance.mjs
node packages/macos-helper/install.mjs uninstall --preview
```

Native preview checks prove signature/capability rejection, protocol enforcement, unconfigured-tab rejection before consent, preview consent refusal and helper lifecycle behavior. A changed ad hoc build is rejected by the retained requirement. They do not request production consent.

For live production acceptance, retain private signature and entitlement receipts. Correlate helper PID, event time and `AUTHREQ_ATTRIBUTION` in `com.apple.TCC` AppleEvents logs with the actual helper identifier and executable. After explicit owner consent and Safari JavaScript enablement, require a successful scoped read of an authorized tab without secrets in its output. Verify caller rejection. Quit, launch and repeat; then install a separately built compatible changed production version and repeat, recording any new prompts. Matching names or source tests cannot prove grant persistence. Preserve evidence for any remaining Node switch-reversion cause separately.

Diagnostics expose signing requirements, identifiers, Gatekeeper assessment and helper/socket presence, without browser data or capabilities. Keep all build, signing and acceptance evidence outside Git. The root README remains focused on shipped onboarding until production acceptance is complete.
