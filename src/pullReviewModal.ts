import { App, Modal, Notice, Setting } from "obsidian";
import type { PullChange } from "./syncEngine";

/**
 * Review surface for leftover Knowz changes. Sync and Pull already auto-apply
 * server-only / server-new notes; this modal is for leftovers and conflicts.
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

    const applyable = this.changes.filter(
      (change) => change.classification === "server-only" || change.classification === "server-new",
    );
    const conflicts = this.changes.filter((change) => change.classification === "both-changed");
    this.contentEl.createEl("p", {
      text:
        `${applyable.length} safe to apply; ${conflicts.length} ` +
        `${conflicts.length === 1 ? "conflict" : "conflicts"}. Conflicts keep your Obsidian note ` +
        "and write the Knowz copy beside it as a .knowz-conflict.md sidecar.",
    });

    for (const change of this.changes) {
      const setting = new Setting(this.contentEl)
        .setName(change.path)
        .setDesc(
          change.classification === "both-changed"
            ? "Conflict: this note changed in both Knowz and Obsidian. Your Obsidian copy is kept."
            : change.classification === "server-new"
              ? `New in Knowz at ${formatUpdatedAt(change.updatedAt)}`
              : `Changed in Knowz at ${formatUpdatedAt(change.updatedAt)}`,
        );
      if (change.classification === "server-only" || change.classification === "server-new") {
        setting.addButton((button) => button.setButtonText("Apply").onClick(async () => {
          await this.apply([change.path]);
        }));
      }
    }

    if (applyable.length > 0) {
      new Setting(this.contentEl).addButton((button) => button
        .setButtonText(`Apply all (${applyable.length})`)
        .setCta()
        .onClick(async () => {
          await this.apply(applyable.map((change) => change.path));
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
