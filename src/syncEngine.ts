// TFile is a value import, not type-only: it is used for an instanceof narrowing check.
import { Notice, TFile, type App } from "obsidian";
import { contentHash } from "./hash";
import {
  KnowzClient,
  type CliFileChange,
  type CliRelationship,
  type PushResult,
} from "./knowzClient";
import { isExcluded, type KnowzPluginSettings } from "./settings";
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

  constructor(private readonly host: SyncEngineHost) {}

  get isFullSyncInFlight(): boolean {
    return this.fullSyncInFlight;
  }

  isConfigured(): boolean {
    const { apiBaseUrl, apiKey, vaultId } = this.host.settings;
    return Boolean(apiBaseUrl.trim() && apiKey.trim() && vaultId.trim());
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
    if (this.fullSyncInFlight) {
      new Notice("A Knowz full sync is already running.");
      return;
    }

    this.fullSyncInFlight = true;
    const settings = this.host.settings;

    try {
      const repositoryId = await this.ensureRepository();
      const markdownFiles = this.host.app.vault
        .getMarkdownFiles()
        .filter((file) =>
          !isExcluded(file.path, settings.excludeGlobs, this.host.app.vault.configDir))
        .sort((left, right) => left.path.localeCompare(right.path));

      if (isUnsafeFullSyncPlan(markdownFiles.length, Object.keys(settings.knownFiles).length)) {
        new Notice(
          "Knowz sync aborted: the vault reported no Markdown files while " +
            `${Object.keys(settings.knownFiles).length} are already synced. Refusing to delete ` +
            "every synced item. Try again once the vault has finished loading.",
        );
        return;
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
        return;
      }

      let plan: { files: CliFileChange[] };
      try {
        const response = await this.client().getFileManifest(repositoryId);
        const manifest = Object.fromEntries(
          response.files.map((file) => [file.path, file.contentHash]),
        );
        plan = computeReconcilePlan(current, manifest, settings.knownFiles);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(
          `Knowz manifest reconciliation unavailable; continuing with local sync state: ${message}`,
        );
        plan = {
          files: pairRenames(
            computeSyncPlan(current, settings.knownFiles).files,
            (path) => settings.knownFiles[path],
          ),
        };
      }

      const plannedFiles = plan.files.map((file) =>
        file.action === 0 || file.action === 1 || file.action === 3
          ? { ...file, content: contents.get(file.path) ?? "" }
          : file,
      );
      const relationships = buildRelationships(
        this.host.app.metadataCache.resolvedLinks,
        new Set(Object.keys(current)),
      );
      const { total: result, unconfirmedPaths } = await this.pushBatches(
        repositoryId,
        plannedFiles,
        relationships,
      );

      settings.knownFiles = withoutUnconfirmed(current, unconfirmedPaths);
      await this.host.saveSettings();
      new Notice(
        result.filesErrored > 0
          ? `Knowz sync incomplete: ${result.filesAdded} added, ${result.filesModified} modified, ` +
              `${result.filesDeleted} deleted, ${result.filesErrored} failed. ` +
              "The failed notes will be retried on the next sync."
          : `Knowz sync complete: ${result.filesAdded} added, ${result.filesModified} modified, ` +
              `${result.filesDeleted} deleted, ${result.relationshipsImported} relationships imported.`,
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

      const pairedFiles = pairRenames(files, (path) => settings.knownFiles[path]);

      const syncedFiles = this.host.app.vault
        .getMarkdownFiles()
        .filter((file) => !isExcluded(file.path, settings.excludeGlobs, this.host.app.vault.configDir));
      const relationships = buildRelationships(
        this.host.app.metadataCache.resolvedLinks,
        new Set(syncedFiles.map((file) => file.path)),
      ).filter((relationship) => changedSources.has(relationship.sourcePath));
      const { total: result, unconfirmedPaths } = await this.pushBatches(
        repositoryId,
        pairedFiles,
        relationships,
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

  private async ensureRepository(): Promise<string> {
    if (!this.initializedThisSession || !this.host.settings.repositoryId) {
      return this.initializeRepository();
    }

    return this.host.settings.repositoryId;
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

  private client(): KnowzClient {
    return new KnowzClient({
      apiBaseUrl: this.host.settings.apiBaseUrl,
      apiKey: this.host.settings.apiKey,
    });
  }
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
