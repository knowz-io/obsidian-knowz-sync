/**
 * Opens the hosted approval URL in the user's browser.
 *
 * **Call this only from inside a user gesture** — a button's click handler. Obsidian desktop
 * runs inside Electron, which silently blocks a popup opened after an `await`, so the
 * device-code flow deliberately does not open the page itself: it shows the code in a modal
 * and lets the user click through, which restores the gesture. That keeps the plugin on the
 * Web API alone — no Node or Electron module — so it stays mobile-compatible
 * (`isDesktopOnly: false`) and clear of the plugin guideline against opening links through the
 * Electron shell.
 *
 * The URL arrives from the server, so its protocol is checked before it is opened: a
 * `javascript:` or `data:` approval URL would otherwise execute in the host.
 */
export function openApprovalUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Knowz returned an unsupported approval URL.");
  }

  window.open(parsed.toString(), "_blank", "noopener,noreferrer");
}
