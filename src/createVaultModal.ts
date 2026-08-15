import { App, Modal, Setting } from "obsidian";

/**
 * Asks for the name of a new Knowz vault.
 *
 * This replaces the browser's native prompt dialog, which Obsidian's guidelines discourage
 * and which behaves badly on mobile, where this plugin also runs.
 *
 * The caller awaits the answer, so the modal must resolve exactly once no matter how it is
 * closed. Every exit — Cancel, Esc, the close button, and Create — goes through onClose,
 * which answers with the trimmed name if the user submitted one and null otherwise. A blank
 * name is answered as null, matching the old prompt behaviour of doing nothing.
 */
export class CreateVaultModal extends Modal {
  private name: string;
  private submitted = false;
  private answered = false;

  constructor(
    app: App,
    defaultName: string,
    private readonly resolve: (name: string | null) => void,
  ) {
    super(app);
    this.name = defaultName;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Create a Knowz vault" });
    contentEl.createEl("p", {
      text: "This Obsidian vault will sync into the new Knowz vault.",
    });

    new Setting(contentEl).setName("Vault name").addText((text) => {
      text.setValue(this.name).onChange((value) => {
        this.name = value;
      });
      text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.submit();
        }
      });
    });

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText("Create vault")
          .setCta()
          .onClick(() => {
            this.submit();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.answered) {
      return;
    }
    this.answered = true;
    const name = this.name.trim();
    this.resolve(this.submitted && name !== "" ? name : null);
  }

  private submit(): void {
    this.submitted = true;
    this.close();
  }
}

/** Opens the modal and resolves the entered name, or null if the user did not name one. */
export function promptForVaultName(app: App, defaultName: string): Promise<string | null> {
  return new Promise((resolve) => {
    new CreateVaultModal(app, defaultName, resolve).open();
  });
}
