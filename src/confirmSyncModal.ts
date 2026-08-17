import { App, Modal, Setting } from "obsidian";

export interface FirstSyncSummary {
  /** Host the notes will be sent to, shown so the user can catch a misconfigured URL. */
  host: string;
  /** How many notes the current settings would upload. */
  fileCount: number;
  /** How many notes already in the Knowz repository would be downloaded. */
  remoteNoteCount: number;
  /** Whether the host is knowz.io or loopback. */
  trustedHost: boolean;
}

/**
 * Shown once, before the first upload.
 *
 * Syncing sends every eligible note in the vault. Entering an API key is not consent to
 * that, so the first push names the destination and the file count and waits for an
 * explicit decision. Resolves true only if the user confirms.
 */
export class ConfirmSyncModal extends Modal {
  private confirmed = false;

  constructor(
    app: App,
    private readonly summary: FirstSyncSummary,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Sync this vault with Knowz?" });

    contentEl.createEl("p", {
      text:
        `${this.summary.fileCount} note${this.summary.fileCount === 1 ? "" : "s"} from this ` +
        `vault will be uploaded to ${this.summary.host}, along with the links between them. ` +
        `${this.summary.remoteNoteCount} note${this.summary.remoteNoteCount === 1 ? "" : "s"} ` +
        "already in Knowz will be downloaded into this vault. Later edits sync both ways.",
    });

    if (!this.summary.trustedHost) {
      contentEl.createEl("p", {
        text:
          `${this.summary.host} is not a knowz.io address. Continue only if you run Knowz ` +
          "yourself at that address.",
        cls: "mod-warning",
      });
    }

    contentEl.createEl("p", {
      text:
        `Only ${this.app.vault.configDir}/, .trash/, .smart-env/, and anything you have ` +
        "excluded in settings are left out.",
    });

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText("Sync with Knowz")
          .setCta()
          .onClick(() => {
            this.confirmed = true;
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve(this.confirmed);
  }
}

export function confirmFirstSync(app: App, summary: FirstSyncSummary): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmSyncModal(app, summary, resolve).open();
  });
}
