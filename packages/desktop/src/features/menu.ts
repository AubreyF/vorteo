import { handleDesktopCommand } from "../desktop-ipc.js";
import { app, Menu, BrowserWindow } from "electron";
import { getActivePaseoBrowserWebContentsForHostWindow } from "./browser-webviews/index.js";

interface ShowContextMenuInput {
  kind?: "terminal";
  hasSelection?: boolean;
}

interface ApplicationMenuOptions {
  onNewWindow: () => void;
}

function withBrowserWindow(
  callback: (win: BrowserWindow) => void,
): (_item: Electron.MenuItem, baseWin: Electron.BaseWindow | undefined) => void {
  return (_item, baseWin) => {
    const win = baseWin instanceof BrowserWindow ? baseWin : BrowserWindow.getFocusedWindow();
    if (win) callback(win);
  };
}

interface ReloadableWebContents {
  isLoadingMainFrame(): boolean;
  stop(): void;
  reload(): void;
  reloadIgnoringCache(): void;
}

interface ReloadableWindow {
  webContents: ReloadableWebContents & { id: number };
}

interface ReloadActiveBrowserOrWindowInput {
  win: ReloadableWindow;
  getActiveBrowserContentsForHostWindow: (
    hostWebContentsId: number,
  ) => ReloadableWebContents | null;
  ignoreCache?: boolean;
}

export function reloadActiveBrowserOrWindow({
  win,
  getActiveBrowserContentsForHostWindow,
  ignoreCache = false,
}: ReloadActiveBrowserOrWindowInput): void {
  const browserContents = getActiveBrowserContentsForHostWindow(win.webContents.id);
  if (browserContents) {
    if (ignoreCache) {
      browserContents.reloadIgnoringCache();
      return;
    }
    if (browserContents.isLoadingMainFrame()) {
      browserContents.stop();
      return;
    }
    browserContents.reload();
    return;
  }

  if (ignoreCache) {
    win.webContents.reloadIgnoringCache();
    return;
  }
  win.webContents.reload();
}

function sendInterfaceZoomKey(win: BrowserWindow, key: "=" | "-" | "0") {
  void win.webContents.executeJavaScript(
    `window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, metaKey: true, ctrlKey: true }))`,
  );
}

function buildApplicationMenuTemplate(
  options: ApplicationMenuOptions,
  capturing: boolean,
): Electron.MenuItemConstructorOptions[] {
  const isMac = process.platform === "darwin";
  const zoomEnabled = !capturing;

  return [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => {
            options.onNewWindow();
          },
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        // The renderer owns zoom: it rescales layout instead of the window and
        // keeps the zoom control in sync. Accelerators stay visible but reach the
        // page as ordinary key events; menu clicks send the same key.
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+=",
          registerAccelerator: false,
          enabled: zoomEnabled,
          click: withBrowserWindow((win) => sendInterfaceZoomKey(win, "=")),
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          registerAccelerator: false,
          enabled: zoomEnabled,
          click: withBrowserWindow((win) => sendInterfaceZoomKey(win, "-")),
        },
        {
          label: "Actual Size",
          accelerator: "CmdOrCtrl+0",
          registerAccelerator: false,
          enabled: zoomEnabled,
          click: withBrowserWindow((win) => sendInterfaceZoomKey(win, "0")),
        },
        { type: "separator" },
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: withBrowserWindow((win) => {
            reloadActiveBrowserOrWindow({
              win,
              getActiveBrowserContentsForHostWindow: getActivePaseoBrowserWebContentsForHostWindow,
            });
          }),
        },
        {
          label: "Force Reload",
          accelerator: "CmdOrCtrl+Shift+R",
          click: withBrowserWindow((win) => {
            reloadActiveBrowserOrWindow({
              win,
              getActiveBrowserContentsForHostWindow: getActivePaseoBrowserWebContentsForHostWindow,
              ignoreCache: true,
            });
          }),
        },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [{ type: "separator" as const }, { role: "front" as const }]
          : [{ role: "close" as const }]),
      ],
    },
  ];
}

let applicationMenuOptions: ApplicationMenuOptions | null = null;
let capturingShortcut = false;

function rebuildApplicationMenu(): void {
  if (!applicationMenuOptions) return;
  const menu = Menu.buildFromTemplate(
    buildApplicationMenuTemplate(applicationMenuOptions, capturingShortcut),
  );
  Menu.setApplicationMenu(menu);
}

export function setupApplicationMenu(options: ApplicationMenuOptions): void {
  applicationMenuOptions = options;
  rebuildApplicationMenu();

  handleDesktopCommand("paseo:menu:showContextMenu", (event, input?: ShowContextMenuInput) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }

    if (input?.kind !== "terminal") {
      return;
    }

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Copy",
        role: "copy",
        enabled: input.hasSelection === true,
      },
      {
        label: "Paste",
        role: "paste",
      },
      {
        type: "separator",
      },
      {
        label: "Select All",
        role: "selectAll",
      },
    ]);

    contextMenu.popup({ window: win });
  });

  // Disable the zoom accelerators while capturing a shortcut so combos like
  // Cmd+- / Cmd+= reach the renderer instead of zooming the window.
  handleDesktopCommand("paseo:menu:set-capturing-shortcut", (_event, capturing?: boolean) => {
    capturingShortcut = capturing === true;
    rebuildApplicationMenu();
  });

  // If the renderer reloads mid-capture (e.g. Cmd+R) the renderer-side effect
  // never gets to send `false`, so reset the flag from the main process when a
  // main window finishes loading. Workspace browser webviews are not
  // BrowserWindows, so they don't trigger this.
  app.on("browser-window-created", (_event, win) => {
    win.webContents.on("did-finish-load", () => {
      if (!capturingShortcut) return;
      capturingShortcut = false;
      rebuildApplicationMenu();
    });
  });
}
