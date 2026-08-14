import { TFile, type App } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { noticeMessages } from "./mocks/obsidian";
import { KnowzClient, type PushResult } from "../src/knowzClient";
import { DEFAULT_SETTINGS, type KnowzPluginSettings } from "../src/settings";
import { SyncEngine, type SyncEngineHost } from "../src/syncEngine";

function makeEngine(contents: Record<string, string>, knownFiles: Record<string, string> = {}) {
  const files = Object.keys(contents).sort().map((path) => {
    const file = new TFile();
    file.path = path;
    return file;
  });
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const settings: KnowzPluginSettings = {
    ...DEFAULT_SETTINGS,
    apiBaseUrl: "https://api.example.test",
    apiKey: "ukz_test",
    vaultId: "vault-guid",
    repositoryId: "repository-guid",
    excludeGlobs: [".obsidian/"],
    knownFiles: { ...knownFiles },
    hasConfirmedFirstSync: true,
  };
  const host: SyncEngineHost = {
    app: {
      vault: {
        getName: () => "TestVault",
        getMarkdownFiles: () => files,
        cachedRead: async (file: TFile) => contents[file.path] ?? "",
        getAbstractFileByPath: (path: string) => fileByPath.get(path) ?? null,
      },
      metadataCache: { resolvedLinks: {} },
    } as unknown as App,
    settings,
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
  return { engine: new SyncEngine(host), host, settings };
}

function result(overrides: Partial<PushResult> = {}): PushResult {
  return {
    filesAdded: 0,
    filesModified: 0,
    filesDeleted: 0,
    filesErrored: 0,
    relationshipsImported: 0,
    ...overrides,
  };
}

/**
 * The server accepts a push, fails individual files, and reports only a count. Before this
 * fix the count was accumulated and never read: sync state advanced for every file and the
 * user was told "sync complete", so the failed notes were never retried and were silently
 * absent from Knowz forever.
 */
describe("SyncEngine partial-failure honesty", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    noticeMessages.length = 0;
    vi.spyOn(KnowzClient.prototype, "initRepository").mockResolvedValue("repository-guid");
    vi.spyOn(KnowzClient.prototype, "getFileManifest").mockResolvedValue({
      files: [],
      totalCount: 0,
    });
  });

  it("does not mark files as synced when the server reported errors", async () => {
    const { engine, settings } = makeEngine({ "a.md": "one", "b.md": "two" });
    vi.spyOn(KnowzClient.prototype, "push").mockResolvedValue(
      result({ filesAdded: 1, filesErrored: 1 }),
    );

    await engine.runFullSync();

    // Neither path may be recorded as known: the server does not say which one failed, so
    // treating both as unsynced is the only choice that cannot lose a note.
    expect(settings.knownFiles).toEqual({});
  });

  it("tells the user the sync was incomplete instead of complete", async () => {
    const { engine } = makeEngine({ "a.md": "one" });
    vi.spyOn(KnowzClient.prototype, "push").mockResolvedValue(result({ filesErrored: 1 }));

    await engine.runFullSync();

    const notice = noticeMessages.join("\n");
    expect(notice).not.toMatch(/sync complete/i);
    expect(notice).toMatch(/1 failed/i);
    expect(notice).toMatch(/retried/i);
  });

  it("still records files as synced on a clean push", async () => {
    const { engine, settings } = makeEngine({ "a.md": "one" });
    vi.spyOn(KnowzClient.prototype, "push").mockResolvedValue(result({ filesAdded: 1 }));

    await engine.runFullSync();

    expect(Object.keys(settings.knownFiles)).toEqual(["a.md"]);
    expect(noticeMessages.join("\n")).toMatch(/sync complete/i);
  });

  it("keeps successful batches when only one batch errors", async () => {
    // 250 files exceeds MAX_BATCH_FILES (200), so this pushes two batches.
    const contents: Record<string, string> = {};
    for (let index = 0; index < 250; index += 1) {
      contents[`note-${String(index).padStart(3, "0")}.md`] = `body ${index}`;
    }
    const { engine, settings } = makeEngine(contents);
    const push = vi.spyOn(KnowzClient.prototype, "push")
      .mockResolvedValueOnce(result({ filesAdded: 200 }))
      .mockResolvedValueOnce(result({ filesAdded: 49, filesErrored: 1 }));

    await engine.runFullSync();

    expect(push).toHaveBeenCalledTimes(2);
    // The clean first batch is retained; only the batch that reported an error is withheld.
    expect(Object.keys(settings.knownFiles)).toHaveLength(200);
    expect(settings.knownFiles["note-000.md"]).toBeDefined();
    expect(settings.knownFiles["note-249.md"]).toBeUndefined();
  });

  it("withholds only the errored paths on an incremental push", async () => {
    const { engine, settings } = makeEngine(
      { "a.md": "one", "b.md": "two" },
      { "a.md": "old-hash" },
    );
    vi.spyOn(KnowzClient.prototype, "push").mockResolvedValue(
      result({ filesModified: 1, filesErrored: 1 }),
    );

    await engine.pushChanges([
      { path: "a.md", action: 1 },
      { path: "b.md", action: 0 },
    ]);

    // a.md keeps its stale hash rather than advancing, so the next sync retries it.
    expect(settings.knownFiles["a.md"]).toBe("old-hash");
    expect(settings.knownFiles["b.md"]).toBeUndefined();
    expect(noticeMessages.join("\n")).toMatch(/failed/i);
  });
});
