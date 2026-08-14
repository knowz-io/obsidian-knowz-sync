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
              path: "Projects/Knowz Integration.md",
              contentHash: "sha256:aaa",
              updatedAt: "2026-08-14T05:00:00Z",
            },
            {
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
          path: "Projects/Knowz Integration.md",
          contentHash: "sha256:aaa",
          updatedAt: "2026-08-14T05:00:00Z",
        },
        {
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
