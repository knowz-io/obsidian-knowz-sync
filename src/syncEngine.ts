// TFile is a value import, not type-only: it is used for an instanceof narrowing check.
import { Notice, TFile, type App } from "obsidian";
import { contentHash } from "./hash";
import {
  KnowzApiError,
  KnowzClient,
  type CliFileChange,
  type CliRelationship,
  type GitFileManifest,
  type PushResult,
} from "./knowzClient";
import { isConflictSidecar, isExcluded, type KnowzPluginSettings } from "./settings";
import type { PendingChange } from "./watcher";

const MAX_BATCH_FILES = 200;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;

type ResolvedLinks = Record<string, Record<string, number>>;

export interface SyncEngineHost {
  app: App;
  settings: KnowzPluginSettings;
  saveSettings(): Promise<void>;
}

interface PushOutcome {
  total: PushResult;
  /** Paths in a batch the server reported errors for; must not be recorded as synced. */
  unconfirmedPaths: Set<string>;
}

export type PullClassification =
  | "unchanged"
  | "server-only"
  | "server-new"
  | "local-only"
  | "both-changed";

export interface PullChange {
  knowledgeId: string;
  path: string;
  serverHash: string;
  localHash: string;
  knownHash: string;
  updatedAt: string;
  classification: PullClassification;
}

export function classifyPullChanges(
  disk: Record<string, string>,
  manifest: GitFileManifest["files"],
  known: Record<string, string>,
): PullChange[] {
  const changes: PullChange[] = [];

  for (const entry of [...manifest].sort((left, right) => comparePaths(left.path, right.path))) {
    if (entry.contentHash === null || !(entry.path in known) || !(entry.path in disk)) {
      continue;
    }

    const knownHash = known[entry.path];
    const localHash = disk[entry.path];
    const serverChanged = entry.contentHash !== knownHash;
    const localChanged = localHash !== knownHash;
    const classification: PullClassification = serverChanged
      ? (localChanged ? "both-changed" : "server-only")
      : (localChanged ? "local-only" : "unchanged");
    changes.push({
      knowledgeId: entry.knowledgeId,
      path: entry.path,
      serverHash: entry.contentHash,
      localHash,
      knownHash,
      updatedAt: entry.updatedAt,
      classification,
    });
  }

  return changes;
}

export interface BidirectionalPlan {
  pull: PullChange[];
  push: CliFileChange[];
  conflicts: PullChange[];
}

export function conflictSidecarPath(path: string): string {
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const stem = dot >= 0 ? name.slice(0, dot) : name;
  const extension = dot >= 0 ? name.slice(dot) : ".md";
  return `${directory}${stem}.knowz-conflict${extension}`;
}

export function planBidirectionalSync(
  disk: Record<string, string>,
  manifest: GitFileManifest["files"],
  known: Record<string, string>,
): BidirectionalPlan {
  const pull: PullChange[] = [];
  const push: CliFileChange[] = [];
  const conflicts: PullChange[] = [];
  const manifestByPath = new Map(manifest.map((entry) => [entry.path, entry]));

  for (const entry of [...manifest].sort((left, right) => comparePaths(left.path, right.path))) {
    const onDisk = entry.path in disk;
    const isKnown = entry.path in known;
    const localHash = disk[entry.path] ?? "";
    const knownHash = known[entry.path] ?? "";

    if (!onDisk && !isKnown) {
      if (entry.contentHash !== null) {
        pull.push(toPullChange(entry, "", "", "server-new"));
      }
      continue;
    }

    if (!onDisk && isKnown) {
      push.push({ path: entry.path, action: 2 });
      continue;
    }

    if (onDisk && isKnown) {
      if (entry.contentHash === null) {
        push.push({ path: entry.path, action: 1, contentHash: localHash });
        continue;
      }
      const serverChanged = entry.contentHash !== knownHash;
      const localChanged = localHash !== knownHash;
      if (serverChanged && localChanged) {
        conflicts.push(toPullChange(entry, localHash, knownHash, "both-changed"));
        push.push({ path: entry.path, action: 1, contentHash: localHash });
      } else if (serverChanged) {
        pull.push(toPullChange(entry, localHash, knownHash, "server-only"));
      } else if (localChanged) {
        push.push({ path: entry.path, action: 1, contentHash: localHash });
      }
      continue;
    }

    if (entry.contentHash === null || entry.contentHash !== localHash) {
      conflicts.push(toPullChange(entry, localHash, "", "both-changed"));
      push.push({ path: entry.path, action: 0, contentHash: localHash });
    }
  }

  for (const path of Object.keys(disk).sort(comparePaths)) {
    if (!manifestByPath.has(path)) {
      push.push({ path, action: 0, contentHash: disk[path] });
    }
  }

  for (const path of Object.keys(known).sort(comparePaths)) {
    if (!(path in disk) && !manifestByPath.has(path)) {
      push.push({ path, action: 2 });
    }
  }

  return {
    pull,
    push: pairRenames(
      push,
      (path) => manifestByPath.get(path)?.contentHash ?? known[path] ?? disk[path],
    ),
    conflicts,
  };
}

function toPullChange(
  entry: GitFileManifest["files"][number],
  localHash: string,
  knownHash: string,
  classification: PullClassification,
): PullChange {
  return {
    knowledgeId: entry.knowledgeId,
    path: entry.path,
    serverHash: entry.contentHash ?? "",
    localHash,
    knownHash,
    updatedAt: entry.updatedAt,
    classification,
  };
}

function withoutUnconfirmed(
  hashes: Record<string, string>,
  unconfirmedPaths: Set<string>,
): Record<string, string> {
  if (unconfirmedPaths.size === 0) {
    return hashes;
  }
  return Object.fromEntries(
    Object.entries(hashes).filter(([path]) => !unconfirmedPaths.has(path)),
  );
}

export function computeSyncPlan(
  current: Record<string, string>,
  known: Record<string, string>,
): { files: CliFileChange[] } {
  const files: CliFileChange[] = [];

  for (const path of Object.keys(current).sort()) {
    if (!(path in known)) {
      files.push({ path, action: 0, contentHash: current[path] });
    } else if (known[path] !== current[path]) {
      files.push({ path, action: 1, contentHash: current[path] });
    }
  }

  for (const path of Object.keys(known).sort()) {
    if (!(path in current)) {
      files.push({ path, action: 2 });
    }
  }

  return { files };
}

export function computeReconcilePlan(
  disk: Record<string, string>,
  manifest: Record<string, string | null>,
  known: Record<string, string>,
): { files: CliFileChange[] } {
  const files: CliFileChange[] = [];

  for (const path of Object.keys(disk).sort(comparePaths)) {
    if (!(path in manifest)) {
      files.push({ path, action: 0, contentHash: disk[path] });
    } else if (manifest[path] === null || manifest[path] !== disk[path]) {
      files.push({ path, action: 1, contentHash: disk[path] });
    }
  }

  for (const path of Object.keys(manifest).sort(comparePaths)) {
    if (!(path in disk) && path in known) {
      files.push({ path, action: 2 });
    }
  }

  return {
    files: pairRenames(files, (path) => manifest[path] ?? known[path]),
  };
}

export function pairRenames(
  files: CliFileChange[],
  hashOfDeletedPath: (path: string) => string | undefined,
): CliFileChange[] {
  const additionsByHash = new Map<string, CliFileChange[]>();
  for (const file of files.filter((candidate) => candidate.action === 0).sort(compareFilePaths)) {
    if (!file.contentHash) continue;
    const candidates = additionsByHash.get(file.contentHash) ?? [];
    candidates.push(file);
    additionsByHash.set(file.contentHash, candidates);
  }

  const renamedByNewPath = new Map<string, string>();
  const pairedDeletedPaths = new Set<string>();
  for (const deleted of files.filter((candidate) => candidate.action === 2).sort(compareFilePaths)) {
    const deletedHash = hashOfDeletedPath(deleted.path);
    if (!deletedHash) continue;
    const candidates = additionsByHash.get(deletedHash);
    const added = candidates?.shift();
    if (!added) continue;
    renamedByNewPath.set(added.path, deleted.path);
    pairedDeletedPaths.add(deleted.path);
  }

  return [...files]
    .sort(compareFilePaths)
    .flatMap((file): CliFileChange[] => {
      if (file.action === 2 && pairedDeletedPaths.has(file.path)) {
        return [];
      }

      const oldPath = file.action === 0 ? renamedByNewPath.get(file.path) : undefined;
      if (!oldPath) {
        return [file];
      }

      return [{
        ...file,
        action: 3,
        oldPath,
      }];
    });
}

/**
 * Guards the destructive edge of a full sync. An empty vault reading alongside a non-empty
 * sync state is never a real "user deleted everything" — a genuine mass delete arrives as
 * per-file watcher events. It means the vault index was read before it was ready, and
 * pushing that plan would delete every synced item.
 */
export function isUnsafeFullSyncPlan(markdownFileCount: number, knownFileCount: number): boolean {
  return markdownFileCount === 0 && knownFileCount > 0;
}

export function buildRelationships(
  resolvedLinks: ResolvedLinks,
  syncedPaths: Set<string>,
): CliRelationship[] {
  const relationships = new Map<string, CliRelationship>();

  for (const sourcePath of Object.keys(resolvedLinks).sort()) {
    if (!syncedPaths.has(sourcePath)) {
      continue;
    }

    for (const [targetPath, count] of Object.entries(resolvedLinks[sourcePath] ?? {}).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (!syncedPaths.has(targetPath) || sourcePath === targetPath) {
        continue;
      }

      const key = `${sourcePath}\0${targetPath}`;
      relationships.set(key, {
        sourcePath,
        targetPath,
        relationshipType: 1,
        confidence: 0.9,
        weight: count,
        reason: "Obsidian wikilink",
      });
    }
  }

  return [...relationships.values()];
}

export class SyncEngine {
  private initializedThisSession = false;
  private fullSyncInFlight = false;
  private pullChanges: PullChange[] = [];
  private lastPullNoticeSignature = "";

  constructor(private readonly host: SyncEngineHost) {}

  get isFullSyncInFlight(): boolean {
    return this.fullSyncInFlight;
  }

  isConfigured(): boolean {
    const { apiBaseUrl, apiKey, vaultId } = this.host.settings;
    return Boolean(apiBaseUrl.trim() && apiKey.trim() && vaultId.trim());
  }

  getPullChanges(): PullChange[] {
    return this.pullChanges.map((change) => ({ ...change }));
  }

  async detectPullChanges(): Promise<PullChange[]> {
    const plan = await this.planFromServer();
    this.storePullChanges([...plan.pull, ...plan.conflicts], true);
    return this.getPullChanges();
  }

  async applyPullChanges(paths: string[]): Promise<void> {
    const requested = [...new Set(paths)].sort(comparePaths);
    if (requested.length === 0) {
      return;
    }

    const pending = new Map(this.pullChanges.map((change) => [change.path, change]));
    const selected: PullChange[] = [];
    for (const path of requested) {
      const change = pending.get(path);
      if (!change || (change.classification !== "server-only" && change.classification !== "server-new")) {
        throw new Error(`${path} is not a server-only change that can be applied safely`);
      }
      selected.push(change);
    }

    const written = await this.writeRemoteNotes(selected);
    const applied = new Set(written);
    this.pullChanges = this.pullChanges.filter((change) => !applied.has(change.path));
    this.lastPullNoticeSignature = "";
    new Notice(
      `${written.length} ${written.length === 1 ? "note" : "notes"} applied from Knowz.`,
    );
  }

  async initializeRepository(): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error("Configure the Knowz API URL, personal API key, and vault ID first.");
    }

    const settings = this.host.settings;
    const repositoryId = await this.client().initRepository(
      settings.vaultId,
      `obsidian://${this.host.app.vault.getName()}`,
      settings.excludeGlobs.map(toKnowzignorePattern).join("\n"),
    );

    settings.repositoryId = repositoryId;
    this.initializedThisSession = true;
    await this.host.saveSettings();
    return repositoryId;
  }

  async runFullSync(): Promise<void> {
    await this.runDirectedSync("sync");
  }

  async runPushSync(): Promise<void> {
    await this.runDirectedSync("push");
  }

  async runPullSync(options?: { quiet?: boolean }): Promise<void> {
    await this.runDirectedSync("pull", options?.quiet ?? false);
  }

  private async runDirectedSync(mode: "sync" | "push" | "pull", quiet = false): Promise<void> {
    if (this.fullSyncInFlight) {
      new Notice("A Knowz full sync is already running.");
      return;
    }

    this.fullSyncInFlight = true;
    const settings = this.host.settings;

    try {
      const snapshot = await this.readSyncableDisk();
      if (!snapshot) {
        return;
      }

      const { current, contents } = snapshot;
      const repositoryId = await this.ensureRepository();
      let plan: BidirectionalPlan;
      try {
        const response = await this.withLiveRepository(
          repositoryId,
          (liveId) => this.client().getFileManifest(liveId),
        );
        plan = planBidirectionalSync(current, response.files, settings.knownFiles);
      } catch (error) {
        if (isMissingRepository(error)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        new Notice(
          `Knowz manifest reconciliation unavailable; continuing with local sync state: ${message}`,
        );
        plan = {
          pull: [],
          conflicts: [],
          push: pairRenames(
            computeSyncPlan(current, settings.knownFiles).files,
            (path) => settings.knownFiles[path],
          ),
        };
      }

      this.storePullChanges([...plan.pull, ...plan.conflicts], true);

      let pulled = 0;
      if (mode !== "push") {
        pulled = (await this.writeRemoteNotes(plan.pull)).length;
      }
      if (mode !== "pull" || plan.conflicts.length > 0) {
        await this.writeConflictSidecars(plan.conflicts);
      }

      if (mode === "pull") {
        this.pullChanges = this.pullChanges.filter((change) => change.classification === "both-changed");
        await this.host.saveSettings();
        if (!quiet || pulled > 0 || plan.conflicts.length > 0) {
          new Notice(this.directionNotice("pull", pulled, plan.conflicts.length, null));
        }
        return;
      }

      const plannedFiles = plan.push.map((file) =>
        file.action === 0 || file.action === 1 || file.action === 3
          ? { ...file, content: contents.get(file.path) ?? "" }
          : file,
      );
      const relationships = buildRelationships(
        this.host.app.metadataCache.resolvedLinks,
        new Set(Object.keys(current)),
      );
      const { total: result, unconfirmedPaths } = await this.withLiveRepository(
        this.host.settings.repositoryId || repositoryId,
        (liveId) => this.pushBatches(liveId, plannedFiles, relationships),
      );

      const nextKnown = { ...settings.knownFiles, ...current };
      for (const change of plan.pull) {
        const confirmed = settings.knownFiles[change.path];
        if (confirmed !== undefined) {
          nextKnown[change.path] = confirmed;
        }
      }
      for (const file of plan.push) {
        if (file.action === 2 && !unconfirmedPaths.has(file.path)) {
          delete nextKnown[file.path];
          if (file.oldPath) {
            delete nextKnown[file.oldPath];
          }
        }
        if (file.action === 3 && file.oldPath && !unconfirmedPaths.has(file.path)) {
          delete nextKnown[file.oldPath];
        }
      }
      for (const path of unconfirmedPaths) {
        const previous = settings.knownFiles[path];
        if (previous === undefined) {
          delete nextKnown[path];
        } else {
          nextKnown[path] = previous;
        }
      }
      settings.knownFiles = nextKnown;
      await this.host.saveSettings();
      this.pullChanges = this.pullChanges.filter((change) => change.classification === "both-changed");
      new Notice(
        result.filesErrored > 0
          ? `Knowz sync incomplete: pulled ${pulled}, ${result.filesAdded} added, ${result.filesModified} modified, ` +
              `${result.filesDeleted} deleted, ${result.filesErrored} failed. ` +
              "The failed notes will be retried on the next sync."
          : this.directionNotice(mode, pulled, plan.conflicts.length, result),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Knowz sync failed: ${message}`);
    } finally {
      this.fullSyncInFlight = false;
    }
  }

  async pushChanges(changes: PendingChange[]): Promise<void> {
    if (changes.length === 0 || this.fullSyncInFlight) {
      return;
    }

    const settings = this.host.settings;
    const nextKnown = { ...settings.knownFiles };
    const files: CliFileChange[] = [];
    const changedSources = new Set<string>();

    try {
      const repositoryId = await this.ensureRepository();
      for (const change of changes) {
        if (change.action === 2) {
          files.push({ path: change.path, action: 2 });
          delete nextKnown[change.path];
          continue;
        }

        const file = this.host.app.vault.getAbstractFileByPath(change.path);
        if (!(file instanceof TFile)) {
          files.push({ path: change.oldPath ?? change.path, action: 2 });
          delete nextKnown[change.oldPath ?? change.path];
          continue;
        }

        const content = await this.host.app.vault.cachedRead(file);
        const hash = await contentHash(content);
        const knownPath = change.action === 3 && change.oldPath
          ? change.oldPath
          : change.path;
        const wasKnown = knownPath in settings.knownFiles;
        if (content.trim() === "" && !wasKnown) {
          continue;
        }
        if ((change.action === 0 || change.action === 1) && settings.knownFiles[change.path] === hash) {
          continue;
        }
        const action = change.action === 0 || change.action === 1
          ? (change.path in settings.knownFiles ? 1 : 0)
          : change.action;
        files.push({
          path: change.path,
          action,
          oldPath: action === 3 ? change.oldPath : undefined,
          content,
          contentHash: hash,
        });
        if (action === 3 && change.oldPath) {
          delete nextKnown[change.oldPath];
        }
        nextKnown[change.path] = hash;
        changedSources.add(change.path);
      }

      if (files.length === 0) {
        return;
      }

      const manifest = await this.withLiveRepository(
        repositoryId,
        (liveId) => this.client().getFileManifest(liveId),
      );
      const diskForDetection = Object.fromEntries(
        files
          .filter((file): file is CliFileChange & { contentHash: string } => Boolean(file.contentHash))
          .map((file) => [file.path, file.contentHash]),
      );
      const planned = planBidirectionalSync(
        diskForDetection,
        manifest.files,
        settings.knownFiles,
      );
      const pullChanges = [...planned.pull, ...planned.conflicts];
      this.storePullChanges(pullChanges, false);
      const protectedPullPaths = new Set(
        pullChanges
          .filter((change) => change.classification === "server-only" || change.classification === "both-changed")
          .map((change) => change.path),
      );
      for (const path of protectedPullPaths) {
        const previous = settings.knownFiles[path];
        if (previous === undefined) {
          delete nextKnown[path];
        } else {
          nextKnown[path] = previous;
        }
      }

      const pairedFiles = pairRenames(files, (path) => settings.knownFiles[path])
        .filter((file) => !protectedPullPaths.has(file.path) && !protectedPullPaths.has(file.oldPath ?? ""));

      const syncedFiles = this.host.app.vault
        .getMarkdownFiles()
        .filter((file) => !isExcluded(file.path, settings.excludeGlobs, this.host.app.vault.configDir));
      const relationships = buildRelationships(
        this.host.app.metadataCache.resolvedLinks,
        new Set(syncedFiles.map((file) => file.path)),
      ).filter((relationship) => changedSources.has(relationship.sourcePath));
      const { total: result, unconfirmedPaths } = await this.withLiveRepository(
        this.host.settings.repositoryId || repositoryId,
        (liveId) => this.pushBatches(liveId, pairedFiles, relationships),
      );

      // A path the server could not confirm keeps whatever hash it had before, so the next
      // sync sees it as still-changed and pushes it again.
      for (const path of unconfirmedPaths) {
        const previous = settings.knownFiles[path];
        if (previous === undefined) {
          delete nextKnown[path];
        } else {
          nextKnown[path] = previous;
        }
      }

      settings.knownFiles = nextKnown;
      await this.host.saveSettings();
      new Notice(
        result.filesErrored > 0
          ? `Knowz incremental sync incomplete: ${result.filesAdded} added, ` +
              `${result.filesModified} modified, ${result.filesDeleted} deleted, ` +
              `${result.filesErrored} failed. The failed notes will be retried on the next sync.`
          : `Knowz incremental sync complete: ${result.filesAdded} added, ` +
              `${result.filesModified} modified, ${result.filesDeleted} deleted.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Knowz incremental sync failed: ${message}`);
    }
  }

  private async ensureRepository(force = false): Promise<string> {
    if (!force && this.initializedThisSession && this.host.settings.repositoryId) {
      return this.host.settings.repositoryId;
    }

    return this.initializeRepository();
  }

  private async withLiveRepository<T>(
    repositoryId: string,
    operation: (repositoryId: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await operation(repositoryId);
    } catch (error) {
      if (!isMissingRepository(error)) {
        throw error;
      }
      const recovered = await this.ensureRepository(true);
      return operation(recovered);
    }
  }

  private async pushBatches(
    repositoryId: string,
    files: CliFileChange[],
    relationships: CliRelationship[],
  ): Promise<PushOutcome> {
    const batches = batchFiles(files);
    if (batches.length === 0 && relationships.length > 0) {
      batches.push([]);
    }

    const total: PushResult = {
      filesAdded: 0,
      filesModified: 0,
      filesDeleted: 0,
      filesErrored: 0,
      relationshipsImported: 0,
    };
    // The push response reports how many files failed but not which ones, so a batch that
    // reports any error has all of its paths withheld from sync state. Withholding a file
    // that actually succeeded costs one redundant upload next sync; recording a file that
    // actually failed loses it permanently.
    const unconfirmedPaths = new Set<string>();
    let remainingRelationships = [...relationships];

    for (let index = 0; index < batches.length; index += 1) {
      const isFinalBatch = index === batches.length - 1;
      const batchPaths = new Set((batches[index] ?? []).map((file) => file.path));
      const batchRelationships = isFinalBatch
        ? remainingRelationships
        : remainingRelationships.filter((relationship) => batchPaths.has(relationship.sourcePath));
      if (!isFinalBatch && batchRelationships.length > 0) {
        const sent = new Set(batchRelationships);
        remainingRelationships = remainingRelationships.filter((relationship) => !sent.has(relationship));
      }
      const result = await this.client().push(repositoryId, batches[index] ?? [], batchRelationships);
      total.filesAdded += result.filesAdded;
      total.filesModified += result.filesModified;
      total.filesDeleted += result.filesDeleted;
      total.filesErrored += result.filesErrored;
      total.relationshipsImported += result.relationshipsImported;

      if (result.filesErrored > 0) {
        for (const file of batches[index] ?? []) {
          unconfirmedPaths.add(file.path);
          if (file.oldPath) {
            unconfirmedPaths.add(file.oldPath);
          }
        }
      }
    }

    return { total, unconfirmedPaths };
  }

  private async planFromServer(): Promise<BidirectionalPlan> {
    const snapshot = await this.readSyncableDisk();
    if (!snapshot) {
      return { pull: [], push: [], conflicts: [] };
    }
    const repositoryId = await this.ensureRepository();
    const manifest = await this.withLiveRepository(
      repositoryId,
      (liveId) => this.client().getFileManifest(liveId),
    );
    return planBidirectionalSync(snapshot.current, manifest.files, this.host.settings.knownFiles);
  }

  private async readSyncableDisk(): Promise<{ current: Record<string, string>; contents: Map<string, string> } | null> {
    const settings = this.host.settings;
    const markdownFiles = this.host.app.vault
      .getMarkdownFiles()
      .filter((file) =>
        !isExcluded(file.path, settings.excludeGlobs, this.host.app.vault.configDir)
        && !isConflictSidecar(file.path))
      .sort((left, right) => left.path.localeCompare(right.path));

    if (isUnsafeFullSyncPlan(markdownFiles.length, Object.keys(settings.knownFiles).length)) {
      new Notice(
        "Knowz sync aborted: the vault reported no Markdown files while " +
          `${Object.keys(settings.knownFiles).length} are already synced. Refusing to delete ` +
          "every synced item. Try again once the vault has finished loading.",
      );
      return null;
    }

    const contents = new Map<string, string>();
    const current: Record<string, string> = {};
    for (const file of markdownFiles) {
      const content = await this.host.app.vault.cachedRead(file);
      if (content.trim() === "" && !(file.path in settings.knownFiles)) {
        continue;
      }
      contents.set(file.path, content);
      current[file.path] = await contentHash(content);
    }

    if (Object.keys(current).length === 0 && Object.keys(settings.knownFiles).length > 0) {
      new Notice(
        "Knowz sync aborted: filtering found no syncable Markdown files while " +
          `${Object.keys(settings.knownFiles).length} are already synced. Refusing to delete ` +
          "synced items from this incomplete disk view.",
      );
      return null;
    }

    return { current, contents };
  }

  private async writeRemoteNotes(changes: PullChange[]): Promise<string[]> {
    const writable = changes.filter(
      (change) => change.classification === "server-only" || change.classification === "server-new",
    );
    if (writable.length === 0) {
      return [];
    }

    const repositoryId = await this.ensureRepository();
    const response = await this.withLiveRepository(
      repositoryId,
      (liveId) => this.client().getFileContents(
        liveId,
        writable.map((change) => change.path),
      ),
    );
    const byPath = new Map(response.files.map((file) => [file.path, file]));
    const written: string[] = [];

    for (const change of writable) {
      const remote = byPath.get(change.path);
      if (!remote || remote.knowledgeId !== change.knowledgeId) {
        throw new Error(`Knowz did not return the expected note for ${change.path}`);
      }
      if (remote.isEncrypted) {
        new Notice(`Skipped encrypted Knowz note: ${change.path}`);
        continue;
      }
      const hash = await contentHash(remote.content);
      if (hash !== change.serverHash || (remote.contentHash !== null && remote.contentHash !== hash)) {
        throw new Error(`${change.path} changed again in Knowz; review the refreshed version`);
      }
      await this.writeVaultFile(change.path, remote.content);
      this.host.settings.knownFiles[change.path] = hash;
      written.push(change.path);
    }

    if (written.length > 0) {
      await this.host.saveSettings();
    }
    return written;
  }

  private async writeConflictSidecars(conflicts: PullChange[]): Promise<void> {
    if (conflicts.length === 0) {
      return;
    }

    const repositoryId = await this.ensureRepository();
    const response = await this.withLiveRepository(
      repositoryId,
      (liveId) => this.client().getFileContents(
        liveId,
        conflicts.map((change) => change.path),
      ),
    );
    const byPath = new Map(response.files.map((file) => [file.path, file]));

    for (const change of conflicts) {
      const remote = byPath.get(change.path);
      if (!remote || remote.isEncrypted) {
        continue;
      }
      const sidecar = conflictSidecarPath(change.path);
      const body =
        `<!-- Knowz conflict copy of ${change.path}. The original note kept your Obsidian edits. -->\n\n` +
        remote.content;
      await this.writeVaultFile(sidecar, body);
    }
  }

  private async writeVaultFile(path: string, content: string): Promise<void> {
    const vault = this.host.app.vault as App["vault"] & {
      create?(path: string, data: string): Promise<TFile>;
      createFolder?(path: string): Promise<unknown>;
    };
    await this.ensureParentFolders(path);
    const existing = vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await vault.modify(existing, content);
      return;
    }
    if (!vault.create) {
      throw new Error(`${path} no longer exists in this Obsidian vault`);
    }
    await vault.create(path, content);
  }

  private async ensureParentFolders(path: string): Promise<void> {
    const vault = this.host.app.vault as App["vault"] & {
      createFolder?(path: string): Promise<unknown>;
    };
    const parts = path.split("/").slice(0, -1);
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (vault.getAbstractFileByPath(prefix) || !vault.createFolder) {
        continue;
      }
      try {
        await vault.createFolder(prefix);
      } catch {
        // Another create may have won the race; the next write will fail if the folder is truly missing.
      }
    }
  }

  private directionNotice(
    mode: "sync" | "push" | "pull",
    pulled: number,
    conflicts: number,
    result: PushResult | null,
  ): string {
    const conflictText = conflicts > 0
      ? `, ${conflicts} ${conflicts === 1 ? "conflict" : "conflicts"} saved as .knowz-conflict.md`
      : "";
    if (mode === "pull" || !result) {
      return `Knowz pull complete: ${pulled} ${pulled === 1 ? "note" : "notes"} written${conflictText}.`;
    }
    if (mode === "push") {
      return `Knowz push complete: ${result.filesAdded} added, ${result.filesModified} modified, ` +
        `${result.filesDeleted} deleted${conflictText}.`;
    }
    return `Knowz sync complete: pulled ${pulled}, ${result.filesAdded} added, ${result.filesModified} modified, ` +
      `${result.filesDeleted} deleted, ${result.relationshipsImported} relationships imported${conflictText}.`;
  }

  private client(): KnowzClient {
    return new KnowzClient({
      apiBaseUrl: this.host.settings.apiBaseUrl,
      apiKey: this.host.settings.apiKey,
    });
  }

  private storePullChanges(detected: PullChange[], replace: boolean): void {
    const relevant = detected.filter(
      (change) =>
        change.classification === "server-only"
        || change.classification === "server-new"
        || change.classification === "both-changed",
    );
    if (replace) {
      this.pullChanges = relevant;
    } else {
      const detectedPaths = new Set(detected.map((change) => change.path));
      this.pullChanges = [
        ...this.pullChanges.filter((change) => !detectedPaths.has(change.path)),
        ...relevant,
      ].sort((left, right) => comparePaths(left.path, right.path));
    }

    const signature = this.pullChanges
      .map((change) => `${change.path}:${change.serverHash}:${change.classification}`)
      .join("|");
    if (!signature || signature === this.lastPullNoticeSignature) {
      return;
    }
    this.lastPullNoticeSignature = signature;

    const conflicts = this.pullChanges.filter((change) => change.classification === "both-changed").length;
    if (conflicts > 0) {
      new Notice(
        `${conflicts} ${conflicts === 1 ? "note has" : "notes have"} changes in both Knowz and Obsidian — Knowz ${conflicts === 1 ? "copy" : "copies"} saved as .knowz-conflict.md.`,
      );
    }
  }
}

function isMissingRepository(error: unknown): boolean {
  return error instanceof KnowzApiError && error.status === 404;
}

function batchFiles(files: CliFileChange[]): CliFileChange[][] {
  const batches: CliFileChange[][] = [];
  let batch: CliFileChange[] = [];
  let batchBytes = 0;

  for (const file of files) {
    const fileBytes = new TextEncoder().encode(JSON.stringify(file)).byteLength;
    if (
      batch.length > 0 &&
      (batch.length >= MAX_BATCH_FILES || batchBytes + fileBytes > MAX_BATCH_BYTES)
    ) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }

    batch.push(file);
    batchBytes += fileBytes;
  }

  if (batch.length > 0) {
    batches.push(batch);
  }

  return batches;
}

function toKnowzignorePattern(glob: string): string {
  if (glob.endsWith("**")) {
    return glob;
  }
  return `${glob.endsWith("/") ? glob : `${glob}/`}**`;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFilePaths(left: CliFileChange, right: CliFileChange): number {
  const pathOrder = comparePaths(left.path, right.path);
  return pathOrder !== 0 ? pathOrder : left.action - right.action;
}
