import { describe, expect, it, vi } from "vitest";
import {
  DeviceAuthError,
  runObsidianDeviceCodeFlow,
  type DeviceAuthRequest,
  type DeviceAuthResponse,
} from "../src/deviceAuth";

function response(status: number, json: Record<string, unknown>): DeviceAuthResponse {
  return { status, json };
}

describe("runObsidianDeviceCodeFlow", () => {
  it("opens the complete URL and honors pending plus server-directed slow-down without real sleeping", async () => {
    let now = 10_000;
    const sleep = vi.fn(async (ms: number) => { now += ms; });
    const openBrowser = vi.fn();
    const showCode = vi.fn();
    const request = vi.fn(async (input: DeviceAuthRequest) => {
      if (input.url.endsWith("/code")) {
        return response(200, {
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://dev.knowz.io/link",
          verification_uri_complete: "https://dev.knowz.io/link?user_code=ABCD-EFGH",
          interval: 2,
          expires_in: 60,
        });
      }
      const poll = request.mock.calls.filter(([call]) => call.url.endsWith("/token")).length;
      if (poll === 1) return response(400, { error: "authorization_pending", interval: 2 });
      if (poll === 2) return response(429, { error: "slow_down", interval: 9 });
      return response(200, {
        credential: `ukz_${"A".repeat(32)}`,
        account: { displayName: "Alex" },
      });
    });

    const result = await runObsidianDeviceCodeFlow("https://api.dev.knowz.io", "Research", {
      request,
      sleep,
      now: () => now,
      openBrowser,
      showCode,
    });

    expect(result).toEqual({ apiKey: `ukz_${"A".repeat(32)}`, accountName: "Alex" });
    expect(openBrowser).toHaveBeenCalledWith("https://dev.knowz.io/link?user_code=ABCD-EFGH");
    expect(showCode).toHaveBeenCalledWith("ABCD-EFGH", "https://dev.knowz.io/link");
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2_000, 2_000, 9_000]);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      url: "https://api.dev.knowz.io/api/v1/auth/device/code",
      method: "POST",
      throw: false,
    });
    expect(JSON.parse(String(request.mock.calls[0]?.[0].body))).toEqual({
      scope: "obsidian",
      installationName: "Research",
      edition: "community",
    });
  });

  it.each([
    ["expired_token", "expired"],
    ["access_denied", "denied"],
  ])("turns %s into a stable user-facing error kind", async (serverError, kind) => {
    let now = 0;
    const request = vi.fn()
      .mockResolvedValueOnce(response(200, {
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://dev.knowz.io/link",
        interval: 1,
        expires_in: 30,
      }))
      .mockResolvedValueOnce(response(400, { error: serverError }));

    const run = runObsidianDeviceCodeFlow("https://api.dev.knowz.io", "Research", {
      request,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      openBrowser: vi.fn(),
      showCode: vi.fn(),
    });

    await expect(run).rejects.toMatchObject({ kind });
    await expect(run).rejects.toBeInstanceOf(DeviceAuthError);
  });

  it("expires against the injected clock without issuing an extra poll", async () => {
    let now = 0;
    const request = vi.fn().mockResolvedValueOnce(response(200, {
      device_code: "device-secret",
      user_code: "ABCD-EFGH",
      verification_uri: "https://dev.knowz.io/link",
      interval: 5,
      expires_in: 5,
    }));

    await expect(runObsidianDeviceCodeFlow("https://api.dev.knowz.io", "Research", {
      request,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      openBrowser: vi.fn(),
      showCode: vi.fn(),
    })).rejects.toMatchObject({ kind: "expired" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
