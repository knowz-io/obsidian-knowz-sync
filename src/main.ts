import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, type TAbstractFile } from "obsidian";
import { InvalidApiUrlError, isTrustedKnowzHost, normalizeApiBaseUrl } from "./apiUrl";
import { confirmFirstSync } from "./confirmSyncModal";
import {
  DEFAULT_SETTINGS,
  isExcluded,
  parseExcludePatterns,
  type KnowzPluginSettings,
} from "./settings";
import { SyncEngine } from "./syncEngine";
import { ChangeQueue, type ChangeAction } from "./watcher";

export default class KnowzSyncPlugin extends Plugin {
  settings: KnowzPluginSettings = { ...DEFAULT_SETTINGS };
  private syncEngine!: SyncEngine;
  private readonly changeQueue = new ChangeQueue();
  private debounceTimer: number | null = null;
  private watchersRegistered = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.syncEngine = new SyncEngine(this);

    this.addRibbonIcon("refresh-cw", "Sync to Knowz", () => {
      void this.runFullSync();
    });
    this.addCommand({
      id: "sync-now",
      name: "Sync vault to Knowz",
      callback: () => {
        void this.runFullSync();
      },
    });
    this.addCommand({
      id: "preview-sync",
      name: "Preview which notes would sync",
      callback: () => {
        this.previewSync();
      },
    });
    this.addSettingTab(new KnowzSettingTab(this.app, this));

    // Vault watchers and the startup sync must wait for the workspace layout. Before it is
    // ready, getMarkdownFiles() reports an empty vault and the initial index replays a
    // `create` event for every file — so an early full sync deletes every known item and the
    // early watchers re-add them all under new IDs.
    this.app.workspace.onLayoutReady(() => {
      void this.startSyncing();
    });
  }

  onunload(): void {
    // A queued incremental sync would otherwise still fire ~15s after the user disabled the
    // plugin, uploading notes from a plugin they had just turned off.
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private async startSyncing(): Promise<void> {
    if (!this.syncEngine.isConfigured()) {
      return;
    }

    this.registerVaultWatchers();

    // Repository initialization is no longer done eagerly on every launch. It is a network
    // call that creates server-side state, and doing it unprompted meant simply having the
    // plugin enabled contacted Knowz at startup. ensureRepository() performs it lazily on
    // the first sync the user actually asks for.
    if (!this.settings.syncOnStartup) {
      return;
    }

    await this.runFullSync();
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<KnowzPluginSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      excludeGlobs: saved?.excludeGlobs ?? [...DEFAULT_SETTINGS.excludeGlobs],
      knownFiles: saved?.knownFiles ?? {},
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    if (this.syncEngine.isConfigured()) {
      this.registerVaultWatchers();
    }
  }

  async runFullSync(): Promise<void> {
    if (!(await this.ensureFirstSyncConfirmed())) {
      return;
    }
    await this.syncEngine.runFullSync();
  }

  /** Notes that the current exclusion settings would upload. */
  syncablePaths(): string[] {
    return this.app.vault
      .getMarkdownFiles()
      .map((file) => file.path)
      .filter((path) => this.isSyncablePath(path))
      .sort();
  }

  private previewSync(): void {
    const paths = this.syncablePaths();
    const total = this.app.vault.getMarkdownFiles().length;
    const sample = paths.slice(0, 10).join("\n");
    new Notice(
      `Knowz would sync ${paths.length} of ${total} notes to ` +
        `${this.settings.apiBaseUrl}.\n\n${sample}` +
        (paths.length > 10 ? `\n…and ${paths.length - 10} more.` : ""),
      15_000,
    );
  }

  /**
   * Gate on the first upload. Returns false if the user declines, in which case nothing is
   * sent. Once confirmed the answer is persisted and never asked again.
   */
  private async ensureFirstSyncConfirmed(): Promise<boolean> {
    if (this.settings.hasConfirmedFirstSync) {
      return true;
    }

    let host = this.settings.apiBaseUrl;
    try {
      host = new URL(normalizeApiBaseUrl(this.settings.apiBaseUrl)).host;
    } catch {
      new Notice("Set a valid Knowz API URL in settings before syncing.");
      return false;
    }

    const confirmed = await confirmFirstSync(this.app, {
      host,
      fileCount: this.syncablePaths().length,
      trustedHost: isTrustedKnowzHost(this.settings.apiBaseUrl),
    });

    if (!confirmed) {
      return false;
    }

    this.settings.hasConfirmedFirstSync = true;
    await this.saveSettings();
    return true;
  }

  private registerVaultWatchers(): void {
    if (this.watchersRegistered) {
      return;
    }
    this.watchersRegistered = true;

    this.registerEvent(this.app.vault.on("create", (file) => this.queueVaultChange(file, 0)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.queueVaultChange(file, 1)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.queueVaultChange(file, 2)));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => this.queueVaultChange(file, 3, oldPath)),
    );
  }

  private queueVaultChange(file: TAbstractFile, action: ChangeAction, oldPath?: string): void {
    if (this.syncEngine.isFullSyncInFlight || !(file instanceof TFile)) {
      return;
    }

    if (action === 3 && oldPath) {
      const oldEligible = this.isSyncablePath(oldPath);
      const newEligible = this.isSyncablePath(file.path);
      if (oldEligible && !newEligible) {
        this.changeQueue.add(oldPath, 2);
      } else if (!oldEligible && newEligible) {
        this.changeQueue.add(file.path, 0);
      } else if (oldEligible && newEligible) {
        this.changeQueue.add(file.path, 3, oldPath);
      } else {
        return;
      }
    } else {
      if (!this.isSyncablePath(file.path)) {
        return;
      }
      this.changeQueue.add(file.path, action);
    }

    this.scheduleIncrementalSync();
  }

  private isSyncablePath(path: string): boolean {
    const lowerPath = path.toLowerCase();
    const isMarkdown = lowerPath.endsWith(".md") || lowerPath.endsWith(".markdown");
    return isMarkdown && !isExcluded(path, this.settings.excludeGlobs);
  }

  private scheduleIncrementalSync(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.flushIncrementalSync();
    }, 15_000);
  }

  private async flushIncrementalSync(): Promise<void> {
    if (this.syncEngine.isFullSyncInFlight) {
      return;
    }

    // Never upload before the user has agreed to the first sync. Changes stay queued.
    if (!this.settings.hasConfirmedFirstSync) {
      return;
    }

    const changes = this.changeQueue.drain();
    await this.syncEngine.pushChanges(changes);
  }
}

class KnowzSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: KnowzSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("The Knowz API URL, such as https://api.knowz.io")
      .addText((text) =>
        text
          .setPlaceholder("https://api.knowz.io")
          .setValue(this.plugin.settings.apiBaseUrl)
          .onChange(async (value) => {
            // Every note and the API key are sent to this host, so reject anything that
            // isn't a usable https endpoint rather than storing it and failing later.
            let normalized: string;
            try {
              normalized = normalizeApiBaseUrl(value);
            } catch (error) {
              if (error instanceof InvalidApiUrlError) {
                new Notice(`Knowz: ${error.message}`);
                return;
              }
              throw error;
            }

            if (!isTrustedKnowzHost(normalized)) {
              new Notice(
                `Knowz: syncing to ${new URL(normalized).host}, which is not a knowz.io ` +
                  "address. Use this only for a Knowz instance you run yourself.",
              );
            }

            this.plugin.settings.apiBaseUrl = normalized;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Personal API key")
      .setDesc(
        "Stored unencrypted in .obsidian/plugins/knowz-sync/data.json — use a non-admin API key with an expiry, and add that file to .gitignore if this vault is in git",
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("ukz_…")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Vault ID")
      .setDesc("The destination Knowz vault GUID")
      .addText((text) =>
        text.setValue(this.plugin.settings.vaultId).onChange(async (value) => {
          this.plugin.settings.vaultId = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Run a full sync whenever Obsidian starts")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("What gets synced").setHeading();

    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc(
        "One pattern per line. A folder name excludes that folder and everything in it " +
          "(Journal/). A pattern with no slash matches a file name anywhere (*.private.md). " +
          "Use * within a folder, ** across folders, and ? for one character. Lines starting " +
          "with # are ignored. Everything not excluded here is uploaded.",
      )
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text
          .setPlaceholder(".obsidian/\n.trash/\n*.private.md")
          .setValue(this.plugin.settings.excludeGlobs.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.excludeGlobs = parseExcludePatterns(value);
            await this.plugin.saveSettings();
          });
      });

    const syncable = this.plugin.syncablePaths().length;
    const total = this.plugin.app.vault.getMarkdownFiles().length;
    new Setting(containerEl)
      .setName("Notes that would sync")
      .setDesc(`${syncable} of ${total} notes in this vault match the settings above.`)
      .addButton((button) =>
        button.setButtonText("Refresh").onClick(() => {
          this.display();
        }),
      );
  }
}
