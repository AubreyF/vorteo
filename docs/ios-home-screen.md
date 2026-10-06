# iOS Home Screen toolbar blur

Vorteo uses the system safe area once per toolbar. It does not add extra top clearance to avoid the native blur.

## Existing shortcuts

An iOS Home Screen shortcut captures its status bar configuration when installed. A shortcut installed with `black-translucent` can retain the native top blur after a web update, reload or cold relaunch.

Open the current site in Safari and use Share, Add to Home Screen with Open as Web App enabled. Keep the old shortcut while checking the replacement. Verify the toolbar, host connections and saved settings in the new app before removing anything. A replacement can have separate browser storage and may require signing in or reconnecting hosts. Do not clear Safari data to migrate.

## Mechanism and acceptance

WebKit calls the native effect a scroll pocket. Its fixed color extension can suppress the top effect when the status bar belongs to the platform. Vorteo requests the default status bar before installation and provides a full-width, fixed, empty 11px element at the top. Its computed background supplies a theme color; `background-clip: text` prevents the empty element painting a visible stripe. It reserves no document space, intercepts no taps and is hidden from accessibility.

The dimensions come from WebKit's 10px minimum for a fixed background candidate, not a visual padding estimate. This is an implementation workaround rather than a public browser API. Recheck it against each new iOS release.

The document uses the dynamic viewport height. With the default status bar, iOS reserves its own top region. A `100vh` standalone override can size the document to the larger screen instead, producing overflow and allowing keyboard focus to move the toolbar out of view. Do not restore that override to compensate for rotation or add a second safe-area inset.

Original investigations: [Urushi's device and WebKit analysis](https://zenn.dev/uakihir0/articles/260920-ios27-pwa-blur), [FallingNikochan's resolution](https://qiita.com/na-trium-144/items/0add98a80ca2391e3f17).

Acceptance must use a Home Screen app in an iOS simulator or on a physical device. Desktop WebKit and Safari tabs do not prove native scroll-pocket behavior. Compare the original translucent install, a fresh default install, reload and cold relaunch. Toggle the fixed element to confirm that the native blur changes without moving the toolbar. Check portrait, landscape, keyboard dismissal, sidebar and explorer panels, both themes. Keep native screenshots and installation diagnostics outside Git.
