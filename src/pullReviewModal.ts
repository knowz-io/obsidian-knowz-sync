import { App, Modal, Notice, Setting } from "obsidian";
import type { PullChange } from "./syncEngine";

/**
 * Non-destructive review surface for changes detected in Knowz.
 * Conflicts are listed but cannot be applied until N3 defines a conflict policy.
 */
export class PullReviewModal extends Modal {
  constructor(
    app: App,
    private readonly changes: PullChange[],
    private readonly applyChanges: (paths: string[]) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Changes from Knowz" });

    const serverOnly = this.changes.filter((change) => change.classification === "server-only");
    const conflicts = this.changes.filter((change) => change.classification === "both-changed");
    this.contentEl.createEl("p", {
      text:
        `${serverOnly.length} safe to apply; ${conflicts.length} ` +
        `${conflicts.length === 1 ? "conflict" : "conflicts"}. Nothing is written until you choose Apply.`,
    });

    for (const change of this.changes) {
      const setting = new Setting(this.contentEl)
        .setName(change.path)
        .setDesc(
          change.classification === "server-only"
            ? `Changed in Knowz at ${formatUpdatedAt(change.updatedAt)}`
            : "Conflict: this note changed in both Knowz and Obsidian. It was not applied.",
        );
      if (change.classification === "server-only") {
        setting.addButton((button) => button.setButtonText("Apply").onClick(async () => {
          await this.apply([change.path]);
        }));
      }
    }

    if (serverOnly.length > 0) {
      new Setting(this.contentEl).addButton((button) => button
        .setButtonText(`Apply all (${serverOnly.length})`)
        .setCta()
        .onClick(async () => {
          await this.apply(serverOnly.map((change) => change.path));
        }));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async apply(paths: string[]): Promise<void> {
    try {
      await this.applyChanges(paths);
      this.close();
    } catch (error) {
      new Notice(`Could not apply changes from Knowz: ${messageOf(error)}`);
    }
  }
}

function formatUpdatedAt(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? value : timestamp.toLocaleString();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
