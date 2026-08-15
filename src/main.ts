import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  TFile,
  type SettingDefinitionItem,
  type TAbstractFile,
} from "obsidian";
import { InvalidApiUrlError, isTrustedKnowzHost, normalizeApiBaseUrl } from "./apiUrl";
import { confirmFirstSync } from "./confirmSyncModal";
import { runObsidianDeviceCodeFlow } from "./deviceAuth";
import { KnowzClient, type KnowzVault } from "./knowzClient";
import { PullReviewModal } from "./pullReviewModal";
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
  private pullDetectionRegistered = false;
  private availableVaults: KnowzVault[] = [];

  async onload(): Promise<void> {
    await this.loadSettings();
    this.syncEngine = new SyncEngine(this);

    this.addRibbonIcon("refresh-cw", "Sync to Knowz", () => {
      void this.runFullSync();
    });
    this.addCommand({
      id: "sync-now",
      name: "Sync vault",
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
    this.addCommand({
      id: "connect-to-knowz",
      name: "Connect to Knowz",
      callback: () => {
        void this.connectToKnowz();
      },
    });
    this.addCommand({
      id: "review-knowz-changes",
      name: "Review changes from Knowz",
      callback: () => {
        void this.reviewRemoteChanges();
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
    this.startPullDetection();

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
    this.startPullDetection();
  }

  remoteChangeCount(): number {
    return this.syncEngine?.getPullChanges().length ?? 0;
  }

  async reviewRemoteChanges(): Promise<void> {
    try {
      const changes = await this.syncEngine.detectPullChanges();
      if (changes.length === 0) {
        new Notice("No changes from Knowz to review.");
        return;
      }
      new PullReviewModal(this.app, changes, async (paths) => {
        await this.syncEngine.applyPullChanges(paths);
      }).open();
    } catch (error) {
      new Notice(`Could not review changes from Knowz: ${messageOf(error)}`);
    }
  }

  async connectToKnowz(): Promise<void> {
    try {
      const result = await runObsidianDeviceCodeFlow(
        this.settings.apiBaseUrl,
        this.app.vault.getName(),
        {
          request: async (request) => {
            const response = await requestUrl(request);
            return {
              status: response.status,
              json: (response.json ?? {}) as Record<string, unknown>,
            };
          },
          sleep: (milliseconds) => new Promise<void>((resolve) => {
            window.setTimeout(resolve, milliseconds);
          }),
          now: () => Date.now(),
          openBrowser: (url) => {
            window.open(url, "_blank", "noopener,noreferrer");
          },
          showCode: (code, verificationUri) => {
            new Notice(`Knowz sign-in code: ${code}. If the browser does not open, visit ${verificationUri}.`, 15_000);
          },
        },
      );

      // Persist the only copy of the credential before any follow-up request. The key is
      // deliberately never included in a URL, Notice, or log message.
      this.settings.apiKey = result.apiKey;
      this.settings.accountName = result.accountName ?? "";
      this.settings.tenantName = "";
      this.settings.vaultId = "";
      this.settings.vaultName = "";
      this.settings.repositoryId = "";
      this.settings.knownFiles = {};
      this.settings.hasConfirmedFirstSync = false;
      await this.saveSettings();

      const client = this.client();
      try {
        const connection = await client.getConnectionInfo();
        this.settings.tenantName = connection.tenantName;
      } catch (error) {
        new Notice(`Connected to Knowz, but account details could not be loaded: ${messageOf(error)}`);
      }
      try {
        await this.refreshVaults();
      } catch (error) {
        new Notice(`Connected to Knowz, but vaults could not be loaded: ${messageOf(error)}`);
      }
      await this.saveSettings();
      new Notice("Knowz connected. Choose a vault to finish setup.");
    } catch (error) {
      new Notice(`Knowz connection failed: ${messageOf(error)}`);
    }
  }

  async refreshVaults(): Promise<void> {
    if (!this.settings.apiKey.trim()) {
      this.availableVaults = [];
      return;
    }
    this.availableVaults = await this.client().listVaults();
    const selected = this.availableVaults.find((vault) => vault.id === this.settings.vaultId);
    if (selected) {
      this.settings.vaultName = selected.name;
      await this.saveSettings();
    }
  }

  vaultOptions(): Record<string, string> {
    const options: Record<string, string> = { "": "Choose a vault…" };
    if (this.settings.vaultId && !this.availableVaults.some((vault) => vault.id === this.settings.vaultId)) {
      options[this.settings.vaultId] = this.settings.vaultName?.trim() || this.settings.vaultId;
    }
    for (const vault of this.availableVaults) {
      options[vault.id] = vault.name;
    }
    options.__create__ = "Create new vault…";
    return options;
  }

  async selectVault(selection: string): Promise<void> {
    let vault: KnowzVault | undefined;
    if (selection === "__create__") {
      const requestedName = window.prompt("Name for the new Knowz vault", this.app.vault.getName());
      if (requestedName === null || requestedName.trim() === "") {
        return;
      }
      vault = await this.client().createVault(requestedName);
      this.availableVaults = [...this.availableVaults, vault]
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    } else {
      vault = this.availableVaults.find((candidate) => candidate.id === selection);
      if (!vault && selection) {
        vault = { id: selection, name: this.settings.vaultName?.trim() || selection };
      }
    }

    this.settings.vaultId = vault?.id ?? "";
    this.settings.vaultName = vault?.name ?? "";
    this.settings.repositoryId = "";
    this.settings.knownFiles = {};
    this.settings.hasConfirmedFirstSync = false;
    await this.saveSettings();
    if (vault) {
      await this.syncEngine.initializeRepository();
      new Notice(`Knowz vault selected: ${vault.name}.`);
    }
  }

  async disconnectFromKnowz(): Promise<void> {
    this.settings.apiKey = "";
    this.settings.accountName = "";
    this.settings.tenantName = "";
    this.settings.vaultId = "";
    this.settings.vaultName = "";
    this.settings.repositoryId = "";
    this.settings.knownFiles = {};
    this.settings.hasConfirmedFirstSync = false;
    this.availableVaults = [];
    await this.saveSettings();
    new Notice(
      "Disconnected locally. To revoke the key on the server, open Knowz Settings → API keys.",
    );
  }

  private client(): KnowzClient {
    return new KnowzClient({
      apiBaseUrl: this.settings.apiBaseUrl,
      apiKey: this.settings.apiKey,
    });
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

  private startPullDetection(): void {
    if (
      this.pullDetectionRegistered ||
      !this.settings.repositoryId ||
      !this.settings.hasConfirmedFirstSync
    ) {
      return;
    }

    this.pullDetectionRegistered = true;
    void this.checkPullChanges();
    this.registerInterval(window.setInterval(() => {
      void this.checkPullChanges();
    }, 5 * 60 * 1_000));
  }

  private async checkPullChanges(): Promise<void> {
    try {
      await this.syncEngine.detectPullChanges();
    } catch (error) {
      new Notice(`Knowz pull check failed: ${messageOf(error)}`);
    }
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
    return isMarkdown && !isExcluded(path, this.settings.excludeGlobs, this.app.vault.configDir);
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

export class KnowzSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: KnowzSyncPlugin) {
    super(app, plugin);
  }

  /**
   * Every setting, described declaratively so Obsidian renders it and indexes it for the
   * settings search. This replaces display(), which is deprecated as of app 1.13.0 and is
   * not called at all when this returns a non-empty array — hence minAppVersion 1.13.0.
   *
   * Obsidian re-reads this on every render, so values derived from vault state (the note
   * count below) are recomputed each time the tab is opened or update() is called.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const syncable = this.plugin.syncablePaths().length;
    const total = this.plugin.app.vault.getMarkdownFiles().length;

    const advanced: SettingDefinitionItem = {
      type: "page",
      name: "Advanced manual setup",
      desc: "Self-hosted endpoint and manual credential fields",
      items: [
      {
        name: "API base URL",
        desc: "The Knowz API URL, such as https://api.knowz.io",
        aliases: ["endpoint", "server", "host", "self-hosted", "url", "instance"],
        control: {
          type: "text",
          key: "apiBaseUrl",
          placeholder: "https://api.knowz.io",
          // Every note and the API key are sent to this host, so anything that isn't a
          // usable https endpoint is refused inline rather than stored and failed on at
          // request time. Returning a message rejects the change.
          validate: (value: string) => {
            try {
              normalizeApiBaseUrl(value);
            } catch (error) {
              if (error instanceof InvalidApiUrlError) {
                return error.message;
              }
              throw error;
            }
          },
        },
      },
      {
        name: "Personal API key",
        desc:
          `Stored unencrypted in ${this.app.vault.configDir}/plugins/knowz-sync/data.json — ` +
          "use a non-admin API key with an expiry, and add that file to .gitignore if this " +
          "vault is in git",
        aliases: ["token", "credential", "authentication", "sign in", "password", "ukz"],
        // Rendered imperatively because the declarative text control has no masked variant,
        // and a credential must not sit on screen in clear text. The row is still named and
        // described declaratively, so it is indexed by the settings search like the rest.
        render: (setting) => {
          setting.addText((text) => {
            text.inputEl.type = "password";
            text
              .setPlaceholder("ukz_…")
              .setValue(this.plugin.settings.apiKey)
              .onChange(async (value) => {
                this.plugin.settings.apiKey = value.trim();
                this.plugin.settings.accountName = "";
                this.plugin.settings.tenantName = "";
                // A render callback is outside the automatic control binding, so this has
                // to persist explicitly.
                await this.plugin.saveSettings();
              });
          });
        },
      },
      {
        name: "Vault ID",
        desc: "The destination Knowz vault GUID",
        aliases: ["destination", "workspace", "guid", "target"],
        control: { type: "text", key: "vaultId" },
      },
      ],
    };

    const syncDefinitions: SettingDefinitionItem[] = [
      {
        name: "Sync on startup",
        desc: "Run a full sync whenever Obsidian starts",
        aliases: ["automatic", "launch", "boot", "open"],
        control: { type: "toggle", key: "syncOnStartup" },
      },
      {
        type: "group",
        heading: "What gets synced",
        items: [
          {
            name: "Excluded paths",
            desc:
              "One pattern per line. A folder name excludes that folder and everything in " +
              "it (Journal/). A pattern with no slash matches a file name anywhere " +
              "(*.private.md). Use * within a folder, ** across folders, and ? for one " +
              "character. Lines starting with # are ignored. Everything not excluded here " +
              "is uploaded.",
            aliases: ["exclude", "ignore", "privacy", "glob", "filter", "skip", "omit"],
            control: {
              type: "textarea",
              key: "excludeGlobs",
              rows: 8,
              placeholder: ".trash/\nJournal/\n*.private.md",
            },
          },
          {
            name: "Notes that would sync",
            desc: `${syncable} of ${total} notes in this vault match the settings above.`,
            aliases: ["count", "preview", "scope", "how many"],
            render: (setting) => {
              setting.addButton((button) =>
                // update() re-runs getSettingDefinitions(), which recounts against the
                // exclusions as they now stand.
                button.setButtonText("Refresh").onClick(() => {
                  this.update();
                }),
              );
            },
          },
        ],
      },
    ];

    if (!this.plugin.settings.apiKey.trim()) {
      return [
        {
          name: "Connect to Knowz",
          desc: "Sign in in your browser, then return here to choose a Knowz vault",
          aliases: ["connect", "sign in", "login", "authorize", "account"],
          render: (setting) => {
            setting.addButton((button) => button
              .setButtonText("Connect to Knowz")
              .setCta()
              .onClick(async () => {
                await this.plugin.connectToKnowz();
                this.update();
              }));
          },
        },
        advanced,
        ...syncDefinitions,
      ];
    }

    const identity = [this.plugin.settings.accountName, this.plugin.settings.tenantName]
      .filter((part) => part?.trim())
      .join(" · ") || "Connected to Knowz";
    return [
      {
        name: "Connected account",
        desc: identity,
        aliases: ["account", "tenant", "workspace", "identity", "signed in"],
      },
      {
        name: "Knowz vault",
        desc: "Choose where this Obsidian vault syncs, or create a new Knowz vault",
        aliases: ["vault", "destination", "workspace", "create", "target"],
        control: { type: "dropdown", key: "selectedVaultId", options: this.plugin.vaultOptions() },
      },
      {
        name: "Refresh vault list",
        desc: "Reload the Knowz vaults available to this account",
        aliases: ["reload", "refresh", "vaults", "update"],
        render: (setting) => {
          setting.addButton((button) => button.setButtonText("Refresh").onClick(async () => {
            try {
              await this.plugin.refreshVaults();
              this.update();
            } catch (error) {
              new Notice(`Could not refresh Knowz vaults: ${messageOf(error)}`);
            }
          }));
        },
      },
      {
        name: "Changes from Knowz",
        desc:
          `${this.plugin.remoteChangeCount()} ` +
          `${this.plugin.remoteChangeCount() === 1 ? "note needs" : "notes need"} review before being written to Obsidian`,
        aliases: ["pull", "download", "remote", "review", "conflict", "changed"],
        render: (setting) => {
          setting.addButton((button) => button.setButtonText("Review").onClick(async () => {
            await this.plugin.reviewRemoteChanges();
            this.update();
          }));
        },
      },
      {
        name: "Disconnect",
        desc: "Clear the local key and vault binding; this does not revoke the server-side key",
        aliases: ["disconnect", "sign out", "logout", "revoke", "remove account"],
        render: (setting) => {
          setting.addButton((button) => button.setButtonText("Disconnect").onClick(async () => {
            await this.plugin.disconnectFromKnowz();
            this.update();
          }));
        },
      },
      advanced,
      ...syncDefinitions,
    ];
  }

  /**
   * Reads the value behind each `control` key. Overridden for every key rather than left to
   * the base class because excludeGlobs is stored as an array and presented as one pattern
   * per line.
   */
  getControlValue(key: string): unknown {
    switch (key) {
      case "apiBaseUrl":
        return this.plugin.settings.apiBaseUrl;
      case "vaultId":
        return this.plugin.settings.vaultId;
      case "selectedVaultId":
        return this.plugin.settings.vaultId;
      case "syncOnStartup":
        return this.plugin.settings.syncOnStartup;
      case "excludeGlobs":
        return this.plugin.settings.excludeGlobs.join("\n");
      default:
        return super.getControlValue(key);
    }
  }

  /**
   * Persists a changed control. Overriding this replaces Obsidian's automatic save, which is
   * wanted here: saveSettings() also registers the vault watchers the moment credentials
   * become present, so a first-time setup starts tracking edits without a restart.
   */
  async setControlValue(key: string, value: unknown): Promise<void> {
    switch (key) {
      case "apiBaseUrl": {
        // validate() has already refused anything normalizeApiBaseUrl would throw on, so
        // what is stored is always the normalised form a request path can be appended to.
        const previousHost = hostOrNull(this.plugin.settings.apiBaseUrl);
        const normalized = normalizeApiBaseUrl(String(value));
        const host = new URL(normalized).host;

        // Warned, not blocked: self-hosted and enterprise deployments run on customer
        // domains. Only on an actual change of host, so retyping does not re-warn.
        if (!isTrustedKnowzHost(normalized) && host !== previousHost) {
          new Notice(
            `Knowz: syncing to ${host}, which is not a knowz.io address. Use this only ` +
              "for a Knowz instance you run yourself.",
          );
        }

        this.plugin.settings.apiBaseUrl = normalized;
        break;
      }
      case "vaultId":
        this.plugin.settings.vaultId = String(value).trim();
        this.plugin.settings.vaultName = "";
        this.plugin.settings.repositoryId = "";
        break;
      case "selectedVaultId":
        await this.plugin.selectVault(String(value));
        this.update();
        return;
      case "syncOnStartup":
        this.plugin.settings.syncOnStartup = Boolean(value);
        break;
      case "excludeGlobs":
        this.plugin.settings.excludeGlobs = parseExcludePatterns(String(value));
        break;
      default:
        await super.setControlValue(key, value);
        return;
    }

    await this.plugin.saveSettings();
  }
}

/** The host of a stored URL, or null if it was never set to anything parseable. */
function hostOrNull(raw: string): string | null {
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
