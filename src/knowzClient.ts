import { requestUrl } from "obsidian";
import { normalizeApiBaseUrl } from "./apiUrl";

export interface CliFileChange {
  path: string;
  action: 0 | 1 | 2 | 3;
  content?: string;
  contentHash?: string;
  oldPath?: string;
}

export interface CliRelationship {
  sourcePath: string;
  targetPath: string;
  relationshipType: 1;
  confidence: number;
  weight: number;
  reason: string;
}

export interface PushResult {
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  filesErrored: number;
  relationshipsImported: number;
}

export interface GitFileManifest {
  files: Array<{
    path: string;
    contentHash: string | null;
    updatedAt: string;
  }>;
  totalCount: number;
}

type ApiEnvelope<T> = {
  success?: boolean;
  data?: T;
  errors?: string[];
  message?: string | null;
};

export class KnowzApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/**
 * Statuses where retrying the identical request could plausibly succeed. A rejected
 * credential, a malformed request, or an oversized payload will be rejected again, and
 * retrying re-sends the full content of every note in the batch to a host that just
 * refused it.
 */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof KnowzApiError)) {
    return true; // network-level failure with no response
  }
  if (error.status === undefined) {
    return true;
  }
  return error.status === 409 || error.status === 429 || error.status >= 500;
}

/**
 * Redirect caveat, verified against obsidian@1.13.1 typings:
 *
 * `RequestUrlParam` exposes no redirect control, so the plugin cannot decline to follow one,
 * and `RequestUrlResponse` carries no final URL, so it cannot even observe that one happened
 * or where it landed. If the configured host issues a cross-host redirect, `X-Api-Key` very
 * likely follows it and the plugin has no way to detect it.
 *
 * There is no client-side fix. What bounds this is (a) the base URL being validated to an
 * https host the user chose, and (b) the key being scoped server-side so that a key leaked
 * this way can do little. Knowz API routes must therefore never issue cross-host redirects.
 */
export class KnowzClient {
  private readonly apiBaseUrl: string;
  private readonly apiKey: string;

  /**
   * @throws InvalidApiUrlError if the configured base URL is not a usable https endpoint.
   * Validating here rather than only in the settings tab means a `data.json` that was
   * hand-edited, restored from a backup, or overwritten by vault sync cannot silently
   * redirect the vault and the API key to another host.
   */
  constructor(config: { apiBaseUrl: string; apiKey: string }) {
    this.apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl);
    this.apiKey = config.apiKey;
  }

  async initRepository(vaultId: string, label: string, knowzignore: string): Promise<string> {
    const data = await this.post<{ repositoryId?: string }>("/api/v1/git/cli/init", {
      vaultId,
      repositoryUrl: label,
      branchName: "main",
      autoEnrichEnabled: true,
      knowzignorePatterns: knowzignore,
    });

    if (!data.repositoryId) {
      throw new KnowzApiError("cli/init response had no repositoryId");
    }

    return data.repositoryId;
  }

  async push(
    repositoryId: string,
    files: CliFileChange[],
    relationships: CliRelationship[],
  ): Promise<PushResult> {
    const body = {
      commitSha: `plugin-${Date.now()}`,
      branchName: "main",
      files,
      relationships,
    };

    try {
      return await this.post<PushResult>(`/api/v1/git/${repositoryId}/push`, body);
    } catch (error) {
      if (!isRetryable(error)) {
        throw error;
      }
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 2_000));
      return this.post<PushResult>(`/api/v1/git/${repositoryId}/push`, body);
    }
  }

  async getFileManifest(repositoryId: string): Promise<GitFileManifest> {
    return this.get<GitFileManifest>(`/api/v1/git/${repositoryId}/files`);
  }

  private async get<T>(path: string): Promise<T> {
    const response = await requestUrl({
      url: `${this.apiBaseUrl}${path}`,
      method: "GET",
      headers: {
        "X-Api-Key": this.apiKey,
      },
      throw: false,
    });
    const envelope = response.json as ApiEnvelope<T>;

    if (response.status >= 400 || envelope?.success === false) {
      throw new KnowzApiError(
        envelope?.errors?.[0] ?? envelope?.message ?? `HTTP ${response.status}`,
        response.status,
      );
    }

    return (envelope?.data ?? envelope) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await requestUrl({
      url: `${this.apiBaseUrl}${path}`,
      method: "POST",
      headers: {
        "X-Api-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      throw: false,
    });
    const envelope = response.json as ApiEnvelope<T>;

    if (response.status >= 400 || envelope?.success === false) {
      throw new KnowzApiError(
        envelope?.errors?.[0] ?? envelope?.message ?? `HTTP ${response.status}`,
        response.status,
      );
    }

    return (envelope?.data ?? envelope) as T;
  }
}
