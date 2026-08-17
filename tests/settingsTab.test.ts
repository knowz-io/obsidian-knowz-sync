import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  App,
  SettingDefinition,
  SettingDefinitionGroup,
  SettingDefinitionItem,
} from "obsidian";
import KnowzSyncPlugin, { KnowzSettingTab } from "../src/main";
import { promptForVaultName } from "../src/createVaultModal";
import { runObsidianDeviceCodeFlow } from "../src/deviceAuth";
import { KnowzClient } from "../src/knowzClient";
import { SyncEngine } from "../src/syncEngine";
import { noticeMessages, Setting } from "./mocks/obsidian";

vi.mock("../src/deviceAuth", () => ({ runObsidianDeviceCodeFlow: vi.fn() }));
vi.mock("../src/createVaultModal", () => ({ promptForVaultName: vi.fn() }));

const deviceAuthMock = vi.mocked(runObsidianDeviceCodeFlow);
const promptForVaultNameMock = vi.mocked(promptForVaultName);

/**
 * The settings tab is declarative as of plugin 1.0.7: Obsidian renders it from
 * getSettingDefinitions() and indexes each row for the settings search. display() is gone —
 * it is deprecated since app 1.13.0 and is not called at all when definitions are returned.
 *
 * These tests pin the two things that break silently under that API: a row that no longer
 * reaches the search index, and a control whose stored shape has drifted from the shape the
 * control hands back.
 */

function makeApp(markdownFiles: string[]) {
  return {
    workspace: { onLayoutReady: (callback: () => void) => callback() },
    vault: {
      configDir: ".obsidian",
      on: vi.fn(() => ({})),
      getName: () => "TestVault",
      getMarkdownFiles: () => markdownFiles.map((path) => ({ path })),
      cachedRead: async () => "",
      getAbstractFileByPath: () => null,
    },
    metadataCache: { resolvedLinks: {} },
  } as unknown as App;
}

function makeTab(saved: Record<string, unknown> = {}, markdownFiles: string[] = []) {
  const app = makeApp(markdownFiles);
  const plugin = new KnowzSyncPlugin(app, { id: "knowz-sync" } as never);
  vi.spyOn(plugin, "loadData").mockResolvedValue(saved);
  const saveData = vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);
  return { app, plugin, saveData, tab: new KnowzSettingTab(app, plugin) };
}

/** Every leaf definition, flattened out of its groups. */
function flatten(items: SettingDefinitionItem[]): SettingDefinition[] {
  const leaves: SettingDefinition[] = [];
  for (const item of items) {
    if ("type" in item && (item.type === "group" || item.type === "list" || item.type === "page")) {
      leaves.push(...flatten((item.items ?? []) as SettingDefinitionItem[]));
    } else {
      leaves.push(item as SettingDefinition);
    }
  }
  return leaves;
}

/** The render callback of a definition, which only the imperative rows carry. */
function renderOf(definition: SettingDefinition | undefined): (setting: unknown) => void {
  const render = (definition as unknown as { render?: (setting: unknown) => void })?.render;
  if (render === undefined) {
    throw new Error(`${definition?.name ?? "definition"} has no render callback`);
  }
  return render;
}

/** The mock setting tab records update() calls; the real one has no such counter. */
function updateCountOf(tab: KnowzSettingTab): number {
  return (tab as unknown as { updateCount: number }).updateCount;
}

describe("declarative settings definitions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("describes every user-facing setting, so each one is searchable", async () => {
    const { plugin, tab } = makeTab();
    await plugin.loadSettings();

    const names = flatten(tab.getSettingDefinitions()).map((definition) => definition.name);

    expect(names).toEqual([
      "Connect to Knowz",
      "API base URL",
      "Personal API key",
      "Vault ID",
      "Sync now",
      "Push to Knowz",
      "Pull from Knowz",
      "Sync on startup",
      "Excluded paths",
      "Notes that would sync",
    ]);
  });

  it("exposes Sync, Push, and Pull on a connected account", async () => {
    const { plugin, tab } = makeTab({
      apiKey: `ukz_${"a".repeat(32)}`,
      accountName: "Alex",
      vaultId: "vault-1",
    });
    await plugin.loadSettings();
    const names = flatten(tab.getSettingDefinitions()).map((definition) => definition.name);
    expect(names).toEqual(expect.arrayContaining(["Sync now", "Push to Knowz", "Pull from Knowz"]));

    const sync = flatten(tab.getSettingDefinitions()).find((definition) => definition.name === "Sync now");
    const run = vi.spyOn(plugin, "runFullSync").mockResolvedValue(undefined);
    const setting = new Setting();
    renderOf(sync)(setting);
    setting.buttons[0].clickHandler();
    expect(run).toHaveBeenCalledOnce();
  });

  it("gives every row search aliases and a description", async () => {
    const { plugin, tab } = makeTab();
    await plugin.loadSettings();

    for (const definition of flatten(tab.getSettingDefinitions())) {
      expect(definition.desc, `${definition.name} has no description`).toBeTruthy();
      expect(definition.aliases?.length, `${definition.name} has no aliases`).toBeGreaterThan(0);
    }
  });

  it("groups the exclusion settings under a heading", async () => {
    const { plugin, tab } = makeTab();
    await plugin.loadSettings();

    const groups = tab
      .getSettingDefinitions()
      .filter((item) => "type" in item && item.type === "group") as SettingDefinitionGroup[];

    expect(groups.map((group) => group.heading)).toEqual(["What gets synced"]);
  });

  // display() is deprecated since 1.13.0 and reported by the directory's automated review.
  // Re-adding it would both restore that finding and silently dead-code itself, since
  // Obsidian skips it whenever getSettingDefinitions() returns anything.
  it("does not define display()", () => {
    expect(Object.getOwnPropertyNames(KnowzSettingTab.prototype)).not.toContain("display");
  });

  it("counts the notes currently in scope", async () => {
    const { plugin, tab } = makeTab({ excludeGlobs: ["Journal/"] }, [
      "a.md",
      "b.md",
      "Journal/c.md",
    ]);
    await plugin.loadSettings();

    const count = flatten(tab.getSettingDefinitions()).find(
      (definition) => definition.name === "Notes that would sync",
    );

    expect(count?.desc).toBe("2 of 3 notes in this vault match the settings above.");
  });

  it("recounts when the refresh button is pressed", async () => {
    const { plugin, tab } = makeTab({}, ["a.md"]);
    await plugin.loadSettings();

    const count = flatten(tab.getSettingDefinitions()).find(
      (definition) => definition.name === "Notes that would sync",
    );
    const setting = new Setting();
    renderOf(count)(setting);
    setting.buttons[0].clickHandler();

    expect(updateCountOf(tab)).toBe(1);
  });
});

describe("native Knowz onboarding", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    deviceAuthMock.mockReset();
    promptForVaultNameMock.mockReset();
    noticeMessages.length = 0;
  });

  it("connects without copying a credential and populates the vault picker", async () => {
    const { plugin, tab } = makeTab();
    await plugin.loadSettings();
    await plugin.onload();
    deviceAuthMock.mockResolvedValue({ apiKey: `ukz_${"a".repeat(32)}`, accountName: "Alex" });
    vi.spyOn(KnowzClient.prototype, "getConnectionInfo").mockResolvedValue({
      tenantId: "tenant-guid",
      tenantName: "Knowz Dev",
    });
    vi.spyOn(KnowzClient.prototype, "listVaults").mockResolvedValue([
      { id: "vault-1", name: "General" },
      { id: "vault-2", name: "Research" },
    ]);

    const connect = flatten(tab.getSettingDefinitions()).find(
      (definition) => definition.name === "Connect to Knowz",
    );
    const setting = new Setting();
    renderOf(connect)(setting);
    await setting.buttons[0].clickHandler();

    expect(deviceAuthMock).toHaveBeenCalledWith(
      "https://api.knowz.io",
      "TestVault",
      expect.objectContaining({
        request: expect.any(Function),
        sleep: expect.any(Function),
        presentApproval: expect.any(Function),
        shouldCancel: expect.any(Function),
      }),
    );
    expect(plugin.settings).toMatchObject({
      apiKey: `ukz_${"a".repeat(32)}`,
      accountName: "Alex",
      tenantName: "Knowz Dev",
    });
    const vault = flatten(tab.getSettingDefinitions()).find(
      (definition) => definition.name === "Knowz vault",
    ) as unknown as { control: { options: Record<string, string> } };
    expect(vault.control.options).toEqual({
      "": "Choose a vault…",
      "vault-1": "General",
      "vault-2": "Research",
      __create__: "Create new vault…",
    });
    expect(noticeMessages.join(" ")).not.toContain(`ukz_${"a".repeat(32)}`);
  });

  it("refreshes the registered settings tab after a keyboard-command connection", async () => {
    const { plugin } = makeTab();
    await plugin.loadSettings();
    await plugin.onload();
    deviceAuthMock.mockResolvedValue({ apiKey: `ukz_${"a".repeat(32)}`, accountName: "Alex" });
    vi.spyOn(KnowzClient.prototype, "getConnectionInfo").mockResolvedValue({
      tenantId: "tenant-guid",
      tenantName: "Knowz Dev",
    });
    vi.spyOn(KnowzClient.prototype, "listVaults").mockResolvedValue([
      { id: "vault-1", name: "General" },
    ]);

    await plugin.connectToKnowz();

    const registeredTab = (plugin as unknown as { knowzSettingTab: KnowzSettingTab }).knowzSettingTab;
    expect(updateCountOf(registeredTab)).toBe(1);
    expect(flatten(registeredTab.getSettingDefinitions()).map((definition) => definition.name))
      .toContain("Knowz vault");
  });

  it("initializes the CLI repository when a vault is selected", async () => {
    const { plugin, tab } = makeTab({
      apiKey: `ukz_${"a".repeat(32)}`,
      accountName: "Alex",
      tenantName: "Knowz Dev",
    });
    await plugin.loadSettings();
    await plugin.onload();
    vi.spyOn(KnowzClient.prototype, "listVaults").mockResolvedValue([
      { id: "vault-1", name: "General" },
    ]);
    await plugin.refreshVaults();
    const init = vi.spyOn(SyncEngine.prototype, "initializeRepository").mockResolvedValue("repo-1");
    const sync = vi.spyOn(plugin, "runFullSync").mockResolvedValue(undefined);

    await tab.setControlValue("selectedVaultId", "vault-1");

    expect(plugin.settings).toMatchObject({ vaultId: "vault-1", vaultName: "General" });
    expect(init).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledOnce();
  });

  // The name is asked for in a plugin Modal, not window.prompt: Obsidian's guidelines
  // discourage the native dialog and it behaves badly on mobile.
  it("creates a vault from the picker and initializes it", async () => {
    const { plugin, tab } = makeTab({ apiKey: `ukz_${"a".repeat(32)}` });
    await plugin.loadSettings();
    await plugin.onload();
    promptForVaultNameMock.mockResolvedValue("Research");
    vi.spyOn(KnowzClient.prototype, "createVault").mockResolvedValue({
      id: "vault-new",
      name: "Research",
    });
    const init = vi.spyOn(SyncEngine.prototype, "initializeRepository").mockResolvedValue("repo-new");
    const sync = vi.spyOn(plugin, "runFullSync").mockResolvedValue(undefined);

    await tab.setControlValue("selectedVaultId", "__create__");

    expect(promptForVaultNameMock).toHaveBeenCalledWith(plugin.app, "TestVault");
    expect(plugin.settings).toMatchObject({ vaultId: "vault-new", vaultName: "Research" });
    expect(init).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledOnce();
  });

  // Dismissing the name modal must leave the existing binding exactly as it was: the old
  // prompt path returned early on cancel, and nothing downstream may run.
  it.each([
    ["a cancelled modal", null],
    ["a whitespace-only name", "   "],
  ])("changes nothing on %s", async (_case, answer) => {
    const { plugin, tab, saveData } = makeTab({
      apiKey: `ukz_${"a".repeat(32)}`,
      vaultId: "vault-1",
      vaultName: "General",
      repositoryId: "repo-1",
    });
    await plugin.loadSettings();
    await plugin.onload();
    promptForVaultNameMock.mockResolvedValue(answer);
    const create = vi.spyOn(KnowzClient.prototype, "createVault");
    const init = vi.spyOn(SyncEngine.prototype, "initializeRepository");
    saveData.mockClear();

    await tab.setControlValue("selectedVaultId", "__create__");

    expect(create).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
    expect(saveData).not.toHaveBeenCalled();
    expect(plugin.settings).toMatchObject({
      vaultId: "vault-1",
      vaultName: "General",
      repositoryId: "repo-1",
    });
  });

  it("disconnects locally, resets sync identity, and explains server-side revocation", async () => {
    const { plugin, tab } = makeTab({
      apiKey: `ukz_${"a".repeat(32)}`,
      vaultId: "vault-1",
      repositoryId: "repo-1",
      knownFiles: { "note.md": "hash" },
      hasConfirmedFirstSync: true,
    });
    await plugin.loadSettings();
    await plugin.onload();

    const disconnect = flatten(tab.getSettingDefinitions()).find(
      (definition) => definition.name === "Disconnect",
    );
    const setting = new Setting();
    renderOf(disconnect)(setting);
    await setting.buttons[0].clickHandler();

    expect(plugin.settings).toMatchObject({
      apiKey: "",
      vaultId: "",
      repositoryId: "",
      knownFiles: {},
      hasConfirmedFirstSync: false,
    });
    expect(noticeMessages.join(" ")).toContain("revoke");
  });
});

describe("API key control", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // The declarative text control has no masked variant, which is the whole reason this row
  // is rendered imperatively. If it ever becomes a plain `control`, the key goes on screen.
  it("is masked", async () => {
    const { plugin, tab } = makeTab({ apiKey: "ukz_secret" });
    await plugin.loadSettings();

    const definition = flatten(tab.getSettingDefinitions()).find(
      (item) => item.name === "Personal API key",
    );
    const setting = new Setting();
    renderOf(definition)(setting);

    expect(setting.texts[0].inputEl.type).toBe("password");
    expect(setting.texts[0].value).toBe("ukz_secret");
  });

  it("persists through saveSettings, which a render callback has to do itself", async () => {
    const { plugin, tab, saveData } = makeTab();
    await plugin.loadSettings();
    // saveSettings() consults the sync engine, which onload() builds.
    await plugin.onload();
    saveData.mockClear();

    const definition = flatten(tab.getSettingDefinitions()).find(
      (item) => item.name === "Personal API key",
    );
    const setting = new Setting();
    renderOf(definition)(setting);
    await setting.texts[0].changeHandler("  ukz_typed  ");

    expect(plugin.settings.apiKey).toBe("ukz_typed");
    expect(saveData).toHaveBeenCalled();
  });
});

describe("control value binding", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("presents excludeGlobs as one pattern per line and stores it as an array", async () => {
    const { plugin, tab } = makeTab({ excludeGlobs: ["Journal/", "*.private.md"] });
    await plugin.loadSettings();
    await plugin.onload();

    expect(tab.getControlValue("excludeGlobs")).toBe("Journal/\n*.private.md");

    await tab.setControlValue("excludeGlobs", "Work/\n\n# a comment\n*.secret.md");

    expect(plugin.settings.excludeGlobs).toEqual(["Work/", "*.secret.md"]);
  });

  it("round-trips the remaining controls", async () => {
    const { plugin, tab } = makeTab({ vaultId: "vault-guid", syncOnStartup: true });
    await plugin.loadSettings();
    await plugin.onload();

    expect(tab.getControlValue("vaultId")).toBe("vault-guid");
    expect(tab.getControlValue("syncOnStartup")).toBe(true);
    expect(tab.getControlValue("apiBaseUrl")).toBe("https://api.knowz.io");

    await tab.setControlValue("vaultId", "  other-guid  ");
    await tab.setControlValue("syncOnStartup", false);

    expect(plugin.settings.vaultId).toBe("other-guid");
    expect(plugin.settings.syncOnStartup).toBe(false);
  });

  // saveSettings() — not the base class's automatic save — is what registers the vault
  // watchers once credentials are present. Entering a key must not need a restart.
  it("saves through the plugin, so watchers register on first configuration", async () => {
    const { app, plugin, tab, saveData } = makeTab({
      apiKey: "ukz_test",
      apiBaseUrl: "https://api.example.test",
    });
    await plugin.loadSettings();
    await plugin.onload();
    saveData.mockClear();

    await tab.setControlValue("vaultId", "vault-guid");

    expect(saveData).toHaveBeenCalled();
    expect(app.vault.on).toHaveBeenCalled();
  });
});

describe("API base URL validation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function validator(tab: KnowzSettingTab) {
    const definition = flatten(tab.getSettingDefinitions()).find(
      (item) => item.name === "API base URL",
    );
    const control = (definition as { control: { validate: (value: string) => string | void } })
      .control;
    return control.validate;
  }

  it.each([
    ["", "empty"],
    ["not a url", "unparseable"],
    ["ftp://api.knowz.io", "wrong scheme"],
    ["http://api.example.test", "plaintext http to a remote host"],
    ["https://user:pass@api.knowz.io", "credentials embedded in the URL"],
  ])("rejects %j (%s)", async (value) => {
    const { plugin, tab } = makeTab();
    await plugin.loadSettings();

    expect(typeof validator(tab)(value)).toBe("string");
  });

  it.each([["https://api.knowz.io"], ["https://knowz.example.com"], ["http://localhost:5000"]])(
    "accepts %j",
    async (value) => {
      const { plugin, tab } = makeTab();
      await plugin.loadSettings();

      expect(validator(tab)(value)).toBeUndefined();
    },
  );

  it("stores the normalised form, never the raw entry", async () => {
    const { plugin, tab } = makeTab();
    await plugin.loadSettings();
    await plugin.onload();

    await tab.setControlValue("apiBaseUrl", "  https://api.knowz.io/  ");

    expect(plugin.settings.apiBaseUrl).toBe("https://api.knowz.io");
  });
});
