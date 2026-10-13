import { BrowserWindow, dialog, type Session, type WebContents } from "electron";
import {
  decideBrowserPermissions,
  permissionOrigin,
  requestedPermissions,
  type BrowserPermission,
  type BrowserPermissionStore,
  type PermissionSite,
} from "./browser-permissions.js";

const labels: Record<BrowserPermission, string> = {
  camera: "use your camera",
  microphone: "use your microphone",
  location: "access your location",
  notifications: "show notifications",
};

export function browserPermissionDialog(site: PermissionSite, permission: BrowserPermission) {
  return {
    type: "question" as const,
    title: "Site permission",
    message: `${site.origin} wants to ${labels[permission]}.`,
    detail:
      (site.origin === site.topOrigin ? "" : `Embedded in ${site.topOrigin}.\n\n`) +
      "You can reset saved decisions in Settings, under Browser data.",
    buttons: ["Block", "Allow"],
    defaultId: 0,
    cancelId: 0,
    checkboxLabel: "Remember for this site",
    checkboxChecked: false,
    noLink: true,
  };
}

export function installBrowserPermissionHandlers(profile: Session, store: BrowserPermissionStore) {
  const pending = new WeakSet<WebContents>();
  profile.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (!contents || contents.isDestroyed()) return false;
    const origin = permissionOrigin(requestingOrigin);
    const topOrigin = permissionOrigin(contents.getURL());
    if (!origin || !topOrigin) return false;
    const permissions = requestedPermissions(
      permission,
      details.mediaType ? [details.mediaType] : undefined,
    );
    return (
      permissions.length > 0 &&
      permissions.every((item) => store.get({ origin, topOrigin }, item) === true)
    );
  });
  profile.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!contents || contents.isDestroyed() || pending.has(contents)) {
      callback(false);
      return;
    }
    const origin = permissionOrigin(details.requestingUrl);
    const topOrigin = permissionOrigin(contents.getURL());
    const permissions = requestedPermissions(
      permission,
      "mediaTypes" in details ? details.mediaTypes : undefined,
    );
    if (
      !origin ||
      !topOrigin ||
      !permissions.length ||
      ("securityOrigin" in details &&
        details.securityOrigin &&
        permissionOrigin(details.securityOrigin) !== origin)
    ) {
      callback(false);
      return;
    }
    // Any frame navigation invalidates an outstanding prompt, including a frame
    // that changes document without changing origin. Do not grant its replacement.
    let current = true;
    const generation = store.generation;
    const cancellation = new AbortController();
    const invalidate = () => {
      current = false;
      cancellation.abort();
    };
    contents.on("did-start-navigation", invalidate);
    contents.on("destroyed", invalidate);
    pending.add(contents);
    const site = { origin, topOrigin };
    void (async () => {
      try {
        const allow = await decideBrowserPermissions({
          store,
          site,
          permissions,
          isCurrent: () => current && !contents.isDestroyed(),
          prompt: async (item) => {
            const owner = BrowserWindow.fromWebContents(contents.hostWebContents ?? contents);
            const options = { ...browserPermissionDialog(site, item), signal: cancellation.signal };
            const result = owner
              ? await dialog.showMessageBox(owner, options)
              : await dialog.showMessageBox(options);
            return { allow: result.response === 1, remember: result.checkboxChecked };
          },
        });
        callback(allow && current && generation === store.generation && !contents.isDestroyed());
      } catch {
        callback(false);
        if (current && !contents.isDestroyed()) {
          await dialog
            .showMessageBox({
              type: "error",
              title: "Permission not saved",
              message:
                "Vorteo couldn't save this permission. Access was blocked. Please try again.",
            })
            .catch(() => {});
        }
      } finally {
        pending.delete(contents);
        contents.removeListener("did-start-navigation", invalidate);
        contents.removeListener("destroyed", invalidate);
      }
    })();
  });
}
