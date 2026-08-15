import { beforeEach, describe, expect, it, vi } from "vitest";
import KnowzSyncPlugin from "../src/main";
import type { App } from "obsidian";
import { confirmFirstSync } from "../src/confirmSyncModal";
import { SyncEngine } from "../src/syncEngine";

vi.mock("../src/confirmSyncModal", () => ({ confirmFirstSync: vi.fn() }));
const confirmFirstSyncMock = vi.mocked(confirmFirstSync);

/**
 * Regression cover for the startup race that deleted and recreated every synced item on
 * each Obsidian launch: onload() ran the full sync and registered vault watchers before the
 * workspace layout was ready, so getMarkdownFiles() reported an empty vault (every known
 * file became a delete) and the initial index then replayed a `create` for every file.
 */
function makeApp(layoutReadyImmediately: boolean) {
  const pending: Array<() => void> = [];
  const app = {
    workspace: {
      onLayoutReady(callback: () => void) {
        if (layoutReadyImmediately) {
          callback();
        } else {
          pending.push(callback);
        }
      },
    },
    vault: {
      on: vi.fn(() => ({})),
      getName: () => "TestVault",
      getMarkdownFiles: () => [],
      cachedRead: async () => "",
      getAbstractFileByPath: () => null,
    },
    metadataCache: { resolvedLinks: {} },
  } as unknown as App;

  return { app, flushLayoutReady: () => pending.splice(0).forEach((cb) => cb()) };
}

function makePlugin(app: App, saved: Record<string, unknown>) {
  const plugin = new KnowzSyncPlugin(app, { id: "knowz-sync" } as never);
  vi.spyOn(plugin, "loadData").mockResolvedValue(saved);
  vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);
  return plugin;
}

const CONFIGURED = {
  apiBaseUrl: "https://api.example.test",
  apiKey: "ukz_test",
  vaultId: "vault-guid",
  knownFiles: { "a.md": "hash-a" },
};

describe("KnowzSyncPlugin.onload", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not touch the vault or the network until layout is ready", async () => {
    const { app, flushLayoutReady } = makeApp(false);
    const plugin = makePlugin(app, { ...CONFIGURED, syncOnStartup: true });
    const initSpy = vi
      .spyOn(plugin as unknown as { runFullSync: () => Promise<void> }, "runFullSync")
      .mockResolvedValue(undefined);

    await plugin.onload();

    // The window in which the old code deleted everything.
    expect(app.vault.on).not.toHaveBeenCalled();
    expect(initSpy).not.toHaveBeenCalled();

    flushLayoutReady();
    await Promise.resolve();

    expect(app.vault.on).toHaveBeenCalled();
  });

  it("registers a keyboard-accessible native connection command", async () => {
    const { app } = makeApp(false);
    const plugin = makePlugin(app, {});
    const addCommand = vi.spyOn(plugin, "addCommand");

    await plugin.onload();

    expect(addCommand).toHaveBeenCalledWith(expect.objectContaining({
      id: "connect-to-knowz",
      name: "Connect to Knowz",
      callback: expect.any(Function),
    }));
  });

  it("registers watchers once layout is ready", async () => {
    const { app } = makeApp(true);
    const plugin = makePlugin(app, CONFIGURED);

    await plugin.onload();
    await Promise.resolve();

    // create / modify / delete / rename
    expect((app.vault.on as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      "create",
      "modify",
      "delete",
      "rename",
    ]);
  });

  it("stays inert when the plugin is not configured", async () => {
    const { app } = makeApp(true);
    const plugin = makePlugin(app, { apiBaseUrl: "https://api.example.test" });

    await plugin.onload();
    await Promise.resolve();

    expect(app.vault.on).not.toHaveBeenCalled();
  });

  // Previously initializeRepository() ran on every launch regardless of the startup toggle,
  // so merely having the plugin enabled contacted Knowz and created server-side state.
  it("does not contact Knowz on launch when sync on startup is off", async () => {
    const { app } = makeApp(true);
    const plugin = makePlugin(app, { ...CONFIGURED, syncOnStartup: false });
    const init = vi.spyOn(SyncEngine.prototype, "initializeRepository");

    await plugin.onload();
    await Promise.resolve();

    expect(init).not.toHaveBeenCalled();
    // watchers still register, so edits are captured for the next explicit sync
    expect(app.vault.on).toHaveBeenCalled();
  });
});

describe("first-sync consent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    confirmFirstSyncMock.mockReset();
  });

  it("uploads nothing when the user declines", async () => {
    const { app } = makeApp(true);
    const plugin = makePlugin(app, CONFIGURED);
    const run = vi.spyOn(SyncEngine.prototype, "runFullSync").mockResolvedValue(undefined);
    confirmFirstSyncMock.mockResolvedValue(false);

    await plugin.onload();
    await plugin.runFullSync();

    expect(confirmFirstSyncMock).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(plugin.settings.hasConfirmedFirstSync).toBe(false);
  });

  it("syncs and remembers the decision once the user confirms", async () => {
    const { app } = makeApp(true);
    const plugin = makePlugin(app, CONFIGURED);
    const run = vi.spyOn(SyncEngine.prototype, "runFullSync").mockResolvedValue(undefined);
    confirmFirstSyncMock.mockResolvedValue(true);

    await plugin.onload();
    await plugin.runFullSync();
    await plugin.runFullSync();

    expect(run).toHaveBeenCalledTimes(2);
    // asked once, not on every sync
    expect(confirmFirstSyncMock).toHaveBeenCalledTimes(1);
    expect(plugin.settings.hasConfirmedFirstSync).toBe(true);
  });

  it("names the destination host and the file count in the prompt", async () => {
    const { app } = makeApp(true);
    const plugin = makePlugin(app, CONFIGURED);
    vi.spyOn(SyncEngine.prototype, "runFullSync").mockResolvedValue(undefined);
    confirmFirstSyncMock.mockResolvedValue(true);

    await plugin.onload();
    await plugin.runFullSync();

    expect(confirmFirstSyncMock).toHaveBeenCalledWith(
      app,
      expect.objectContaining({ host: "api.example.test", trustedHost: false }),
    );
  });

  it("skips the prompt for an already-confirmed vault", async () => {
    const { app } = makeApp(true);
    const plugin = makePlugin(app, { ...CONFIGURED, hasConfirmedFirstSync: true });
    const run = vi.spyOn(SyncEngine.prototype, "runFullSync").mockResolvedValue(undefined);

    await plugin.onload();
    await plugin.runFullSync();

    expect(confirmFirstSyncMock).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
  });
});
