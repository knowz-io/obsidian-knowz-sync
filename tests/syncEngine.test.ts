import { TFile, type App } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { noticeMessages } from "./mocks/obsidian";
import { contentHash } from "../src/hash";
import { KnowzClient } from "../src/knowzClient";
import type { KnowzPluginSettings } from "../src/settings";
import {
  buildRelationships,
  classifyPullChanges,
  computeReconcilePlan,
  computeSyncPlan,
  isUnsafeFullSyncPlan,
  pairRenames,
  SyncEngine,
  type SyncEngineHost,
} from "../src/syncEngine";

describe("classifyPullChanges", () => {
  it("classifies server-only, local-only, both-changed, and unchanged notes", () => {
    const manifest = [
      { knowledgeId: "server", path: "server.md", contentHash: "server-new", updatedAt: "now" },
      { knowledgeId: "local", path: "local.md", contentHash: "base-local", updatedAt: "now" },
      { knowledgeId: "both", path: "both.md", contentHash: "server-new", updatedAt: "now" },
      { knowledgeId: "same", path: "same.md", contentHash: "base-same", updatedAt: "now" },
    ];

    expect(classifyPullChanges(
      {
        "server.md": "base-server",
        "local.md": "local-new",
        "both.md": "local-new",
        "same.md": "base-same",
      },
      manifest,
      {
        "server.md": "base-server",
        "local.md": "base-local",
        "both.md": "base-both",
        "same.md": "base-same",
      },
    ).map(({ path, classification }) => ({ path, classification }))).toEqual([
      { path: "both.md", classification: "both-changed" },
      { path: "local.md", classification: "local-only" },
      { path: "same.md", classification: "unchanged" },
      { path: "server.md", classification: "server-only" },
    ]);
  });
});

describe("isUnsafeFullSyncPlan", () => {
  it("flags an empty vault reading while files are already synced", () => {
    // The startup race: getMarkdownFiles() returns [] before layout is ready, so every
    // known file would be planned as a delete.
    expect(isUnsafeFullSyncPlan(0, 4)).toBe(true);
  });

  it("allows a genuinely empty vault that has never synced", () => {
    expect(isUnsafeFullSyncPlan(0, 0)).toBe(false);
  });

  it("allows any sync that can still see files", () => {
    expect(isUnsafeFullSyncPlan(1, 4)).toBe(false);
    expect(isUnsafeFullSyncPlan(4, 0)).toBe(false);
  });

  it("does not fire for the plan that caused the incident once files are visible", () => {
    // 4 known, 4 visible -> normal no-op sync, must not be blocked.
    expect(isUnsafeFullSyncPlan(4, 4)).toBe(false);
  });
});

describe("computeSyncPlan", () => {
  it("classifies added, modified, deleted, and unchanged files", () => {
    const current = { "a.md": "h1", "b.md": "h2-new", "c.md": "h3" };
    const known = { "b.md": "h2-old", "c.md": "h3", "gone.md": "h4" };

    expect(computeSyncPlan(current, known).files).toEqual([
      { path: "a.md", action: 0, contentHash: "h1" },
      { path: "b.md", action: 1, contentHash: "h2-new" },
      { path: "gone.md", action: 2 },
    ]);
  });
});

describe("computeReconcilePlan", () => {
  it("re-adds a disk file missing from the server even when known has the same hash", () => {
    expect(computeReconcilePlan(
      { "orphan.md": "hash-a" },
      {},
      { "orphan.md": "hash-a" },
    ).files).toEqual([
      { path: "orphan.md", action: 0, contentHash: "hash-a" },
    ]);
  });

  it("modifies mismatched and unhashed manifest entries", () => {
    expect(computeReconcilePlan(
      { "changed.md": "new", "unhashed.md": "hash" },
      { "changed.md": "old", "unhashed.md": null },
      { "changed.md": "old", "unhashed.md": "hash" },
    ).files).toEqual([
      { path: "changed.md", action: 1, contentHash: "new" },
      { path: "unhashed.md", action: 1, contentHash: "hash" },
    ]);
  });

  it("deletes only missing manifest paths the plugin previously synced", () => {
    expect(computeReconcilePlan(
      { "converged.md": "same" },
      { "converged.md": "same", "known-gone.md": "old", "foreign-gone.md": "other" },
      { "converged.md": "same", "known-gone.md": "old" },
    ).files).toEqual([
      { path: "known-gone.md", action: 2 },
    ]);
  });
});

describe("pairRenames", () => {
  it("pairs a same-hash delete and add into one rename", () => {
    expect(pairRenames([
      { path: "b.md", action: 0, content: "same", contentHash: "hash" },
      { path: "a.md", action: 2 },
    ], (path) => path === "a.md" ? "hash" : undefined)).toEqual([
      {
        path: "b.md",
        action: 3,
        oldPath: "a.md",
        content: "same",
        contentHash: "hash",
      },
    ]);
  });

  it("leaves mismatches and unpaired changes intact", () => {
    expect(pairRenames([
      { path: "new.md", action: 0, contentHash: "new-hash" },
      { path: "old.md", action: 2 },
      { path: "extra.md", action: 2 },
    ], (path) => path === "old.md" ? "old-hash" : "extra-hash")).toEqual([
      { path: "extra.md", action: 2 },
      { path: "new.md", action: 0, contentHash: "new-hash" },
      { path: "old.md", action: 2 },
    ]);
  });

  it("pairs duplicate hashes deterministically by ordinal path", () => {
    expect(pairRenames([
      { path: "z-new.md", action: 0, contentHash: "same" },
      { path: "z-old.md", action: 2 },
      { path: "a-new.md", action: 0, contentHash: "same" },
      { path: "a-old.md", action: 2 },
    ], () => "same")).toEqual([
      { path: "a-new.md", action: 3, oldPath: "a-old.md", contentHash: "same" },
      { path: "z-new.md", action: 3, oldPath: "z-old.md", contentHash: "same" },
    ]);
  });
});

function makeEngine(
  contents: Record<string, string>,
  knownFiles: Record<string, string> = {},
) {
  const files = Object.keys(contents).sort().map((path) => {
    const file = new TFile();
    file.path = path;
    return file;
  });
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const settings: KnowzPluginSettings = {
    apiBaseUrl: "https://api.example.test",
    apiKey: "ukz_test",
    vaultId: "vault-guid",
    repositoryId: "repository-guid",
    excludeGlobs: [".obsidian/"],
    syncOnStartup: false,
    knownFiles: { ...knownFiles },
    // SyncEngine has no consent gate — that lives in the plugin layer — but the settings
    // type requires the field.
    hasConfirmedFirstSync: true,
  };
  const host: SyncEngineHost = {
    app: {
      vault: {
        getName: () => "TestVault",
        getMarkdownFiles: () => files,
        cachedRead: async (file: TFile) => contents[file.path] ?? "",
        modify: async (file: TFile, content: string) => {
          contents[file.path] = content;
        },
        getAbstractFileByPath: (path: string) => fileByPath.get(path) ?? null,
      },
      metadataCache: { resolvedLinks: {} },
    } as unknown as App,
    settings,
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };

  return { engine: new SyncEngine(host), host, settings };
}

describe("SyncEngine bidirectional hardening", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    noticeMessages.length = 0;
    vi.spyOn(KnowzClient.prototype, "initRepository").mockResolvedValue("repository-guid");
    vi.spyOn(KnowzClient.prototype, "getFileManifest").mockResolvedValue({
      files: [],
      totalCount: 0,
    });
  });

  it("falls back to the local plan and completes when manifest reconciliation fails", async () => {
    const { engine, settings } = makeEngine({ "note.md": "hello" });
    vi.spyOn(KnowzClient.prototype, "getFileManifest").mockRejectedValue(
      new Error("manifest unavailable"),
    );
    const push = vi.spyOn(KnowzClient.prototype, "push").mockResolvedValue({
      filesAdded: 1,
      filesModified: 0,
      filesDeleted: 0,
      filesErrored: 0,
      relationshipsImported: 0,
    });

    await engine.runFullSync();

    expect(push).toHaveBeenCalledWith(
      "repository-guid",
      [expect.objectContaining({ path: "note.md", action: 0, content: "hello" })],
      [],
    );
    expect(Object.keys(settings.knownFiles)).toEqual(["note.md"]);
    expect(noticeMessages.some((message) => message.includes("manifest reconciliation unavailable"))).toBe(true);
    expect(noticeMessages.some((message) => message.includes("Knowz sync complete"))).toBe(true);
  });

  it("aborts an unsafe empty-vault reading before fetching a manifest or pushing deletes", async () => {
    const { engine, settings } = makeEngine({}, { "known.md": "hash" });
    const manifest = vi.spyOn(KnowzClient.prototype, "getFileManifest");
    const push = vi.spyOn(KnowzClient.prototype, "push");

    await engine.runFullSync();

    expect(manifest).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(settings.knownFiles).toEqual({ "known.md": "hash" });
    expect(noticeMessages.some((message) => message.includes("Refusing to delete every synced item"))).toBe(true);
  });

  it("excludes whitespace-only notes from full sync and known state", async () => {
    const { engine, settings } = makeEngine({ "empty.md": "  \n\t" });
    vi.spyOn(KnowzClient.prototype, "getFileManifest").mockResolvedValue({ files: [], totalCount: 0 });
    const push = vi.spyOn(KnowzClient.prototype, "push");

    await engine.runFullSync();

    expect(push).not.toHaveBeenCalled();
    expect(settings.knownFiles).toEqual({});
  });

  it("keeps a known note emptied on disk as a modified-with-empty full-sync change", async () => {
    const emptyContent = "  \n\t";
    const { engine, settings } = makeEngine(
      { "known-empty.md": emptyContent },
      { "known-empty.md": "old-hash" },
    );
    vi.spyOn(KnowzClient.prototype, "getFileManifest").mockResolvedValue({
      files: [{
        knowledgeId: "known-empty-id",
        path: "known-empty.md",
        contentHash: "old-hash",
        updatedAt: "2026-08-14T05:00:00Z",
      }],
      totalCount: 1,
    });
    const push = vi.spyOn(KnowzClient.prototype, "push").mockResolvedValue({
      filesAdded: 0,
      filesModified: 1,
      filesDeleted: 0,
      filesErrored: 0,
      relationshipsImported: 0,
    });

    await engine.runFullSync();

    const expectedHash = await contentHash(emptyContent);
    expect(push).toHaveBeenCalledWith(
      "repository-guid",
      [{
        path: "known-empty.md",
        action: 1,
        content: emptyContent,
        contentHash: expectedHash,
      }],
      [],
    );
    expect(push.mock.calls[0]?.[1]).not.toContainEqual(
      expect.objectContaining({ path: "known-empty.md", action: 2 }),
    );
    expect(settings.knownFiles).toEqual({ "known-empty.md": expectedHash });
  });

  it("aborts when R16 filtering leaves no current files while known files exist", async () => {
    const { engine, settings } = makeEngine(
      { "unknown-empty.md": " \n" },
      { "known.md": "known-hash" },
    );
    const manifest = vi.spyOn(KnowzClient.prototype, "getFileManifest");
    const push = vi.spyOn(KnowzClient.prototype, "push");

    await engine.runFullSync();

    expect(manifest).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(settings.knownFiles).toEqual({ "known.md": "known-hash" });
    expect(noticeMessages.some((message) => message.includes("no syncable Markdown files"))).toBe(true);
  });

  it("pairs a full-sync manifest move into a rename with the new file content", async () => {
    const hash = await contentHash("same content");
    const { engine, settings } = makeEngine({ "new.md": "same content" }, { "old.md": hash });
    vi.spyOn(KnowzClient.prototype, "getFileManifest").mockResolvedValue({
      files: [{ knowledgeId: "old-id", path: "old.md", contentHash: hash, updatedAt: "2026-08-14T05:00:00Z" }],
      totalCount: 1,
    });
    const push = vi.spyOn(KnowzClient.prototype, "push").mockResolvedValue({
      filesAdded: 0,
      filesModified: 1,
      filesDeleted: 0,
      filesErrored: 0,
      relationshipsImported: 0,
    });

    await engine.runFullSync();

    expect(push).toHaveBeenCalledWith(
      "repository-guid",
      [{
        path: "new.md",
        action: 3,
        oldPath: "old.md",
        content: "same content",
        contentHash: hash,
      }],
      [],
    );
    expect(settings.knownFiles).toEqual({ "new.md": hash });
  });

  it("skips an unknown incremental empty note without recording it", async () => {
    const { engine, settings } = makeEngine({ "empty.md": " \n" });
    const push = vi.spyOn(KnowzClient.prototype, "push");

    await engine.pushChanges([{ path: "empty.md", action: 1 }]);

    expect(push).not.toHaveBeenCalled();
    expect(settings.knownFiles).toEqual({});
  });

  it("pushes a known note modified to empty and records the empty-content hash", async () => {
    const emptyContent = " \n";
    const { engine, settings } = makeEngine({ "note.md": emptyContent }, { "note.md": "old-hash" });
    const push = vi.spyOn(KnowzClient.prototype, "push").mockResolvedValue({
      filesAdded: 0,
      filesModified: 1,
      filesDeleted: 0,
      filesErrored: 0,
      relationshipsImported: 0,
    });

    await engine.pushChanges([{ path: "note.md", action: 1 }]);

    const expectedHash = await contentHash(emptyContent);
    expect(push).toHaveBeenCalledWith(
      "repository-guid",
      [{ path: "note.md", action: 1, content: emptyContent, contentHash: expectedHash }],
      [],
    );
    expect(settings.knownFiles).toEqual({ "note.md": expectedHash });
  });

  it("pairs watcher delete/create events as a rename and advances known state only after success", async () => {
    const hash = await contentHash("same content");
    const { engine, settings } = makeEngine({ "new.md": "same content" }, { "old.md": hash });
    const push = vi.spyOn(KnowzClient.prototype, "push").mockResolvedValue({
      filesAdded: 0,
      filesModified: 1,
      filesDeleted: 0,
      filesErrored: 0,
      relationshipsImported: 0,
    });

    await engine.pushChanges([
      { path: "old.md", action: 2 },
      { path: "new.md", action: 0 },
    ]);

    expect(push).toHaveBeenCalledWith(
      "repository-guid",
      [{
        path: "new.md",
        action: 3,
        oldPath: "old.md",
        content: "same content",
        contentHash: hash,
      }],
      [],
    );
    expect(settings.knownFiles).toEqual({ "new.md": hash });
  });

  it("keeps old known state when a paired incremental rename push fails", async () => {
    const hash = await contentHash("same content");
    const { engine, settings } = makeEngine({ "new.md": "same content" }, { "old.md": hash });
    vi.spyOn(KnowzClient.prototype, "push").mockRejectedValue(new Error("push failed"));

    await engine.pushChanges([
      { path: "old.md", action: 2 },
      { path: "new.md", action: 0 },
    ]);

    expect(settings.knownFiles).toEqual({ "old.md": hash });
  });

  it("holds a server-only change for explicit review instead of overwriting it", async () => {
    const baseHash = await contentHash("base");
    const serverHash = await contentHash("changed in Knowz");
    const { engine, settings } = makeEngine({ "note.md": "base" }, { "note.md": baseHash });
    vi.spyOn(KnowzClient.prototype, "getFileManifest").mockResolvedValue({
      files: [{
        knowledgeId: "note-id",
        path: "note.md",
        contentHash: serverHash,
        updatedAt: "2026-08-15T08:00:00Z",
      }],
      totalCount: 1,
    });
    const push = vi.spyOn(KnowzClient.prototype, "push");

    await engine.runFullSync();

    expect(push).not.toHaveBeenCalled();
    expect(settings.knownFiles).toEqual({ "note.md": baseHash });
    expect(engine.getPullChanges()).toEqual([
      expect.objectContaining({ path: "note.md", classification: "server-only" }),
    ]);
    expect(noticeMessages).toContain("1 note changed in Knowz — review before syncing it.");
  });

  it("reports a both-changed note as conflicted and never auto-applies or pushes it", async () => {
    const baseHash = await contentHash("base");
    const serverHash = await contentHash("changed in Knowz");
    const { engine } = makeEngine({ "note.md": "changed locally" }, { "note.md": baseHash });
    vi.spyOn(KnowzClient.prototype, "getFileManifest").mockResolvedValue({
      files: [{
        knowledgeId: "note-id",
        path: "note.md",
        contentHash: serverHash,
        updatedAt: "2026-08-15T08:00:00Z",
      }],
      totalCount: 1,
    });
    const push = vi.spyOn(KnowzClient.prototype, "push");

    await engine.runFullSync();

    expect(push).not.toHaveBeenCalled();
    expect(engine.getPullChanges()).toEqual([
      expect.objectContaining({ path: "note.md", classification: "both-changed" }),
    ]);
    expect(noticeMessages).toContain("1 note has changes in both Knowz and Obsidian — review the conflict.");
  });

  it("applies an explicit server-only change and suppresses the watcher echo", async () => {
    const baseHash = await contentHash("base");
    const serverContent = "changed in Knowz";
    const serverHash = await contentHash(serverContent);
    const { engine, host, settings } = makeEngine({ "note.md": "base" }, { "note.md": baseHash });
    vi.spyOn(KnowzClient.prototype, "getFileManifest").mockResolvedValue({
      files: [{
        knowledgeId: "note-id",
        path: "note.md",
        contentHash: serverHash,
        updatedAt: "2026-08-15T08:00:00Z",
      }],
      totalCount: 1,
    });
    vi.spyOn(KnowzClient.prototype, "getFileContents").mockResolvedValue({
      files: [{
        knowledgeId: "note-id",
        path: "note.md",
        content: serverContent,
        contentHash: serverHash,
        updatedAt: "2026-08-15T08:00:00Z",
      }],
      totalCount: 1,
      maxBatchSize: 100,
    });
    const push = vi.spyOn(KnowzClient.prototype, "push");

    await engine.detectPullChanges();
    await engine.applyPullChanges(["note.md"]);
    await engine.pushChanges([{ path: "note.md", action: 1 }]);

    expect(host.app.vault.cachedRead(
      host.app.vault.getAbstractFileByPath("note.md") as TFile,
    )).resolves.toBe(serverContent);
    expect(settings.knownFiles).toEqual({ "note.md": serverHash });
    expect(push).not.toHaveBeenCalled();
  });
});

describe("buildRelationships", () => {
  it("emits weighted References edges only between synced files", () => {
    const resolved = {
      "a.md": { "b.md": 2, "img.png": 1 },
      "b.md": { "a.md": 1 },
      "missing.md": { "a.md": 1 },
    };

    expect(buildRelationships(resolved, new Set(["a.md", "b.md"]))).toEqual([
      {
        sourcePath: "a.md",
        targetPath: "b.md",
        relationshipType: 1,
        confidence: 0.9,
        weight: 2,
        reason: "Obsidian wikilink",
      },
      {
        sourcePath: "b.md",
        targetPath: "a.md",
        relationshipType: 1,
        confidence: 0.9,
        weight: 1,
        reason: "Obsidian wikilink",
      },
    ]);
  });

  it("drops self-links", () => {
    expect(buildRelationships({ "a.md": { "a.md": 3 } }, new Set(["a.md"]))).toEqual([]);
  });
});
