type ElectronShell = {
  openExternal(url: string): Promise<void> | void;
};

type ElectronModule = {
  shell?: ElectronShell;
};

type HostWindow = Window & {
  require?: (name: string) => unknown;
};

// Obsidian's desktop bundle is CommonJS. Some Electron builds expose the loader only as the
// module-scoped `require`, while others mirror it on `window`; mobile exposes neither usable
// Electron module. `typeof` keeps the probe safe when the identifier is absent.
declare const require: ((name: string) => unknown) | undefined;

/**
 * Opens the hosted approval URL in the user's system browser.
 *
 * Obsidian desktop runs inside Electron. A command callback reaches this function after the
 * device-code request resolves, at which point `window.open` is no longer attached to the
 * original user gesture and Electron silently blocks the popup. The host-provided Electron
 * shell is not subject to that popup timer. Mobile has no `window.require`, so it retains the
 * Web API path and the plugin remains mobile-compatible (`isDesktopOnly: false`).
 */
export function openApprovalUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Knowz returned an unsupported approval URL.");
  }

  const hostWindow = window as HostWindow;
  const hostRequire = typeof hostWindow.require === "function"
    ? hostWindow.require
    : typeof require === "function"
      ? require
      : undefined;
  if (hostRequire) {
    try {
      const electron = hostRequire("electron") as ElectronModule;
      if (typeof electron.shell?.openExternal === "function") {
        void electron.shell.openExternal(parsed.toString());
        return;
      }
    } catch {
      // A non-Electron host can expose a different `require`; use the portable fallback.
    }
  }

  window.open(parsed.toString(), "_blank", "noopener,noreferrer");
}
