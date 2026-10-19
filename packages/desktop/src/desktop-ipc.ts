import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { isAppNavigationUrl } from "./window/navigation.js";

interface DesktopFrame {
  readonly url: string;
}

interface DesktopSender {
  readonly mainFrame: DesktopFrame;
}

interface DesktopInvocation {
  readonly sender: DesktopSender;
  readonly senderFrame: DesktopFrame | null;
}

const trustedWindows = new WeakMap<DesktopSender, string>();

export function registerTrustedDesktopWindow(contents: DesktopSender, appUrl: string): void {
  trustedWindows.set(contents, appUrl);
}

export function isTrustedDesktopInvocation(event: DesktopInvocation): boolean {
  const appUrl = trustedWindows.get(event.sender);
  return (
    appUrl !== undefined &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame &&
    isAppNavigationUrl(event.senderFrame.url, appUrl)
  );
}

export function handleDesktopCommand<Args extends unknown[]>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isTrustedDesktopInvocation(event)) {
      throw new Error("Desktop commands require the trusted application window.");
    }
    return listener(event, ...(args as Args));
  });
}
