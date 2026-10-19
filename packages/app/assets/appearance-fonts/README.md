# Native appearance fonts

These TrueType files provide Barlow, Barlow Condensed, Manrope and Space Grotesk
at weights 300, 400, 500, 600 and 700. Each family's SIL Open Font License is
retained beside the assets. `manifest.json` records the Google Fonts repository
revision, original source paths and hashes, and generated asset hashes.

Barlow and Barlow Condensed retain the source font bytes. Manrope and Space
Grotesk are static instances of the source variable fonts, generated with
fonttools 4.60.1. Instancing uses the `wght` axis with `updateFontNames=False`;
family, subfamily and PostScript name records identify each static face.
Original timestamps are retained. Static faces avoid relying on native variable
font weight selection.

`../../native-appearance-fonts.cjs` supplies Expo's font plugin configuration.
iOS embeds all faces through `UIAppFonts`. Android embeds a font resource family
with explicit weight mappings and registers its authored name before JavaScript
runs. No runtime font download is required.

Changing these assets or their registration requires rebuilding the native app.
A web publication does not update an existing native binary. Expo Go does not
apply this build-time plugin. Native typography acceptance requires a development
or release build containing these assets, with rendered weight and family checks
on iOS and Android. Web screenshots do not establish native fidelity.

Apple system families in the theme stacks remain platform fonts; they are not
redistributed here. The native resolver selects the first bundled or supported
iOS family in authored order. Android uses its generic serif or default family
when no bundled face exists in a stack.

Run `node --test scripts/native-appearance-fonts.test.mjs` from the repository
root to verify asset hashes, retained licenses and Android weight resource
generation. Expo config introspection also exposes the generated iOS
`UIAppFonts` list.

To reproduce the files, retrieve each `files[].source` from the pinned Google
Fonts revision in the manifest, saving it under `files[].file` in a separate
source directory. In a Python environment with `fonttools==4.60.1`, run:

```sh
python scripts/generate-appearance-fonts.py /path/to/font-sources /path/to/new-output
```

The generator verifies every input hash before writing, refuses an existing
output directory, and verifies every generated file against the committed hash.
It does not modify the checked-in assets or update expected hashes automatically.
