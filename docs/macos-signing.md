# macOS code signing for Vorteo

Use a **Developer ID Application** identity for a Vorteo app distributed outside the App Store. An existing identity can sign on another Mac when that Mac has both the certificate and its matching private key. A `.cer` file alone cannot sign. Developer ID Installer, Apple Development and Apple Distribution certificates serve different purposes. Apple describes [Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/) and [sharing signing identities](https://developer.apple.com/documentation/xcode/sharing-your-teams-signing-certificates).

## Move an existing identity to the Host Mac

On the Mac that already signs applications:

1. Open Keychain Access, select the login keychain and **My Certificates**. Find **Developer ID Application: Your Organization (TEAMID)**. Expand it and confirm that a private key appears beneath it.
2. Export that identity as a password-protected `.p12`. Select the certificate and its matching private key if needed. Alternatively, in Xcode choose **Settings > Accounts**, select the team, open **Manage Certificates**, then Control-click the certificate and choose **Export Certificate**.
3. Transfer the `.p12` securely to the native Host Mac. Keep it outside repository folders and guest mounts. Enter its export password locally, not in a conversation or agent command.
4. Import it into the Host user's **login** keychain using Keychain Access or by opening the `.p12`. Do not change certificate trust settings. Apple documents [Keychain import and export](https://support.apple.com/guide/keychain-access/import-and-export-keychain-items-kyca35961/mac).

The Host implementation can then check `security find-identity -v -p codesigning`. Give the maintainer the certificate's displayed name or SHA-1 fingerprint and team ID. Do not provide the `.p12`, its password, private key, Apple Account password or recovery codes in chat. Importing the identity on a second Mac does not require revoking the original certificate.

If no private key is present on the source Mac, downloading its certificate again will not recover the key. Locate the original signing Mac or an existing encrypted identity backup. Otherwise create a new Developer ID Application certificate through the team's authorized account workflow. Certificate creation and keychain changes require explicit owner authorization.

When `codesign` first uses the key, macOS may request keychain access. The owner approves that native prompt. Do not grant every application access to the private key, import with blanket access flags, or alter keychain trust to suppress prompts. A tool access grant for `codesign` is not a restriction to one bundle identifier. Prefer the narrowest access that supports the intended build workflow.

## Identity continuity

Keep the same bundle identifiers, team and compatible designated requirements for updates. The [permission helper guide](macos-permission-helper.md) describes the fixed Vorteo identities and installation checks. The certificate authorizes signing; it does not authorize Safari Automation. The owner must approve those separate macOS permissions.

Certificate renewal within a compatible Developer ID requirement can preserve signing identity. A team change or incompatible requirement needs a reviewed migration and new privacy acceptance. macOS can still request consent after an update or policy change; verify actual behavior rather than promising permanent grants.

Notarization is a separate distribution step. Uploading an app to Apple requires owner authorization and an existing `notarytool` keychain profile. Local signing does not require sharing Apple Account credentials with an agent.

## Dedicated local signing option

A dedicated local code-signing identity is an alternative for one Mac. Creation remains subject to explicit owner authorization. It does not confer Developer ID distribution or notarization trust. Do not silently create a certificate or mark it trusted.

For an already authorized, available local identity, the helper build accepts its certificate SHA-1 fingerprint with `--local-signing`. It generates a designated requirement pinned to that exact certificate for each native binary. The installer requires the same explicit flag and retains those requirements during updates. Renewing or replacing that certificate changes the pinned identity and needs a reviewed migration. Apple discusses custom certificate requirements in [Code Signing In Depth](https://developer.apple.com/library/archive/technotes/tn2206/).

Ad hoc signatures cannot provide a stable production identity across changed builds. They are restricted to the helper's isolated preview, which refuses privacy consent prompts.
