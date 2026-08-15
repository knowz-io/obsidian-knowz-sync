import { App, Modal, Notice, Setting } from "obsidian";
import { openApprovalUrl } from "./browserLauncher";

/**
 * Shows the device-code sign-in prompt while the flow polls for approval.
 *
 * The browser is opened from this modal's button rather than automatically, because the
 * approval URL only exists after an awaited request and a popup opened at that point is
 * blocked by Electron. A click here is a fresh user gesture, so the plain Web `window.open`
 * works on desktop and mobile alike — see `openApprovalUrl`.
 *
 * Showing the code before the browser opens is also the safer order: the user can check that
 * the code in Obsidian matches the one on the approval page before granting access.
 */
export class DeviceApprovalModal extends Modal {
  /** Set once the flow has ended, so closing the modal afterwards is not read as a cancel. */
  private settled = false;

  constructor(
    app: App,
    private readonly userCode: string,
    private readonly verificationUrl: string,
    private readonly verificationUri: string,
    private readonly onCancel: () => void,
  ) {
    super(app);
  }

  /** Close the modal because the flow finished; does not fire `onCancel`. */
  complete(): void {
    this.settled = true;
    this.close();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Connect to Knowz" });
    contentEl.createEl("p", {
      text: "Open the sign-in page and check that it shows this same code before you approve.",
    });
    // A semantic element Obsidian already styles — the plugin ships no stylesheet, and adding
    // one would change the release assets Obsidian installs.
    contentEl.createEl("p").createEl("code", { text: this.userCode });
    contentEl.createEl("p", {
      text: `If the page does not open, visit ${this.verificationUri} and enter the code there.`,
    });
    contentEl.createEl("p", {
      text: "Waiting for approval. This window closes by itself once you approve.",
    });

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Open sign-in page")
          .setCta()
          .onClick(() => {
            try {
              openApprovalUrl(this.verificationUrl);
            } catch (error) {
              new Notice(
                `Could not open the Knowz sign-in page: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }),
      )
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
    // Every dismissal — Cancel, Esc, the close button — lands here. Only a close that the flow
    // did not ask for is a cancellation, and it may only be reported once.
    if (!this.settled) {
      this.settled = true;
      this.onCancel();
    }
  }
}
