import { requestUrl } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowzApiError, KnowzClient } from "../src/knowzClient";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

const requestUrlMock = vi.mocked(requestUrl);

describe("KnowzClient", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("unwraps data.repositoryId from the captured cli/init fixture", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: {
        success: true,
        data: {
          repositoryId: "00000000-0000-0000-0000-000000000001",
          success: true,
          connectionTested: false,
          message: "CLI repository configured successfully",
        },
        errors: [],
      },
    } as never);
    const client = new KnowzClient({ apiBaseUrl: "https://api.example.test", apiKey: "ukz_test" });

    const repositoryId = await client.initRepository(
      "00000000-0000-0000-0000-000000000002",
      "obsidian://poc-vault",
      ".obsidian/**\n.trash/**\n.smart-env/**",
    );

    expect(repositoryId).toBe("00000000-0000-0000-0000-000000000001");
    expect(requestUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.example.test/api/v1/git/cli/init",
        method: "POST",
        headers: {
          "X-Api-Key": "ukz_test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          vaultId: "00000000-0000-0000-0000-000000000002",
          repositoryUrl: "obsidian://poc-vault",
          branchName: "main",
          autoEnrichEnabled: true,
          knowzignorePatterns: ".obsidian/**\n.trash/**\n.smart-env/**",
        }),
        throw: false,
      }),
    );
  });

  it("surfaces errors[0] from a failed API envelope", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 409,
      json: { success: false, errors: ["fixture conflict"], message: null },
    } as never);
    const client = new KnowzClient({ apiBaseUrl: "https://api.example.test", apiKey: "ukz_test" });

    await expect(client.initRepository("vault", "obsidian://vault", "")).rejects.toThrow(
      new KnowzApiError("fixture conflict"),
    );
  });

  it("unwraps push counters from data", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: {
        success: true,
        data: {
          filesAdded: 3,
          filesModified: 0,
          filesDeleted: 0,
          filesErrored: 0,
          relationshipsImported: 3,
        },
        errors: [],
      },
    } as never);
    const client = new KnowzClient({ apiBaseUrl: "https://api.example.test", apiKey: "ukz_test" });

    const result = await client.push("repository", [], []);

    expect(result).toEqual({
      filesAdded: 3,
      filesModified: 0,
      filesDeleted: 0,
      filesErrored: 0,
      relationshipsImported: 3,
    });
  });

  it("unwraps the pinned repository file manifest including null hashes", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: {
        success: true,
        data: {
          files: [
            {
              knowledgeId: "knowledge-a",
              path: "Projects/Knowz Integration.md",
              contentHash: "sha256:aaa",
              updatedAt: "2026-08-14T05:00:00Z",
            },
            {
              knowledgeId: "knowledge-b",
              path: "Inbox/Unhashed.md",
              contentHash: null,
              updatedAt: "2026-08-14T05:01:00Z",
            },
          ],
          totalCount: 2,
        },
        errors: [],
      },
    } as never);
    const client = new KnowzClient({ apiBaseUrl: "https://api.example.test", apiKey: "ukz_test" });

    const manifest = await client.getFileManifest("repository-guid");

    expect(manifest).toEqual({
      files: [
        {
          knowledgeId: "knowledge-a",
          path: "Projects/Knowz Integration.md",
          contentHash: "sha256:aaa",
          updatedAt: "2026-08-14T05:00:00Z",
        },
        {
          knowledgeId: "knowledge-b",
          path: "Inbox/Unhashed.md",
          contentHash: null,
          updatedAt: "2026-08-14T05:01:00Z",
        },
      ],
      totalCount: 2,
    });
    expect(requestUrlMock).toHaveBeenCalledWith({
      url: "https://api.example.test/api/v1/git/repository-guid/files",
      method: "GET",
      headers: { "X-Api-Key": "ukz_test" },
      throw: false,
    });
  });

  it("fetches repository-scoped note content in one bounded batch", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: {
        success: true,
        data: {
          files: [{
            knowledgeId: "knowledge-a",
            path: "Projects/Knowz Integration.md",
            content: "# Updated in Knowz",
            contentHash: "sha256:new",
            updatedAt: "2026-08-15T08:00:00Z",
          }],
          totalCount: 1,
          maxBatchSize: 100,
        },
      },
    } as never);
    const client = new KnowzClient({ apiBaseUrl: "https://api.example.test", apiKey: "ukz_test" });

    await expect(client.getFileContents("repository-guid", ["Projects/Knowz Integration.md"]))
      .resolves.toEqual({
        files: [{
          knowledgeId: "knowledge-a",
          path: "Projects/Knowz Integration.md",
          content: "# Updated in Knowz",
          contentHash: "sha256:new",
          updatedAt: "2026-08-15T08:00:00Z",
        }],
        totalCount: 1,
        maxBatchSize: 100,
      });
    expect(requestUrlMock).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://api.example.test/api/v1/git/repository-guid/files/content",
      method: "POST",
      body: JSON.stringify({ paths: ["Projects/Knowz Integration.md"] }),
    }));
  });

  it("surfaces errors[0] from a failed manifest envelope", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 503,
      json: { success: false, errors: ["manifest temporarily unavailable"], message: "fallback" },
    } as never);
    const client = new KnowzClient({ apiBaseUrl: "https://api.example.test", apiKey: "ukz_test" });

    await expect(client.getFileManifest("repository-guid")).rejects.toThrow(
      new KnowzApiError("manifest temporarily unavailable"),
    );
  });

  it("lists accessible vaults through the authenticated vault endpoint", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: { success: true, data: [
        { id: "vault-2", name: "Work", displayName: "Work" },
        { id: "vault-1", name: "General", displayName: "General" },
      ] },
    } as never);
    const client = new KnowzClient({ apiBaseUrl: "https://api.example.test", apiKey: "ukz_test" });

    await expect(client.listVaults()).resolves.toEqual([
      { id: "vault-1", name: "General" },
      { id: "vault-2", name: "Work" },
    ]);
    expect(requestUrlMock).toHaveBeenCalledWith({
      url: "https://api.example.test/api/v1/vaults",
      method: "GET",
      headers: { "X-Api-Key": "ukz_test" },
      throw: false,
    });
  });

  it("creates a vault with an explicit Obsidian description", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: { success: true, data: { id: "vault-new", name: "Research" } },
    } as never);
    const client = new KnowzClient({ apiBaseUrl: "https://api.example.test", apiKey: "ukz_test" });

    await expect(client.createVault("Research")).resolves.toEqual({ id: "vault-new", name: "Research" });
    expect(requestUrlMock).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://api.example.test/api/v1/vaults",
      method: "POST",
      body: JSON.stringify({
        name: "Research",
        displayName: "Research",
        description: "Created by Knowz AI Sync for Obsidian",
      }),
    }));
  });

  it("validates the minted key and returns the connected tenant identity", async () => {
    requestUrlMock.mockResolvedValueOnce({
      status: 200,
      json: {
        success: true,
        data: {
          isValid: true,
          tenant: { tenantId: "tenant-guid", name: "Knowz Dev" },
        },
      },
    } as never);
    const client = new KnowzClient({ apiBaseUrl: "https://api.example.test", apiKey: "ukz_test" });

    await expect(client.getConnectionInfo()).resolves.toEqual({
      tenantId: "tenant-guid",
      tenantName: "Knowz Dev",
    });
    expect(requestUrlMock).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://api.example.test/api/v1/auth/validate-key",
      method: "POST",
      body: JSON.stringify({ apiKey: "ukz_test" }),
    }));
  });

  it("retries a failed push once after two seconds", async () => {
    vi.useFakeTimers();
    requestUrlMock
      .mockResolvedValueOnce({
        status: 409,
        json: { success: false, errors: ["optimistic concurrency failure"] },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          success: true,
          data: {
            filesAdded: 0,
            filesModified: 0,
            filesDeleted: 1,
            filesErrored: 0,
            relationshipsImported: 0,
          },
        },
      } as never);
    const client = new KnowzClient({ apiBaseUrl: "https://api.example.test", apiKey: "ukz_test" });

    const resultPromise = client.push("repository", [{ path: "gone.md", action: 2 }], []);
    const resultExpectation = expect(resultPromise).resolves.toMatchObject({ filesDeleted: 1 });
    await vi.advanceTimersByTimeAsync(2_000);

    await resultExpectation;
    expect(requestUrlMock).toHaveBeenCalledTimes(2);
    expect(requestUrlMock.mock.calls[1]?.[0]).toEqual(requestUrlMock.mock.calls[0]?.[0]);
  });
});
