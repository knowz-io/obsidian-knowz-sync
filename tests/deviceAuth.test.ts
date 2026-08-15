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
    const presentApproval = vi.fn();
    const request = vi.fn(async (input: DeviceAuthRequest) => {
      if (input.url.endsWith("/code")) {
        return response(200, {
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://app.example.test/link",
          verification_uri_complete: "https://app.example.test/link?user_code=ABCD-EFGH",
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

    const result = await runObsidianDeviceCodeFlow("https://api.example.test", "Research", {
      request,
      sleep,
      now: () => now,
      presentApproval,
    });

    expect(result).toEqual({ apiKey: `ukz_${"A".repeat(32)}`, accountName: "Alex" });
    expect(presentApproval).toHaveBeenCalledWith({
      userCode: "ABCD-EFGH",
      verificationUrl: "https://app.example.test/link?user_code=ABCD-EFGH",
      verificationUri: "https://app.example.test/link",
    });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2_000, 2_000, 9_000]);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      url: "https://api.example.test/api/v1/auth/device/code",
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
        verification_uri: "https://app.example.test/link",
        interval: 1,
        expires_in: 30,
      }))
      .mockResolvedValueOnce(response(400, { error: serverError }));

    const run = runObsidianDeviceCodeFlow("https://api.example.test", "Research", {
      request,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      presentApproval: vi.fn(),
    });

    await expect(run).rejects.toMatchObject({ kind });
    await expect(run).rejects.toBeInstanceOf(DeviceAuthError);
  });

  it("expires against the injected clock without issuing an extra poll", async () => {
    let now = 0;
    const request = vi.fn().mockResolvedValueOnce(response(200, {
      device_code: "device-secret",
      user_code: "ABCD-EFGH",
      verification_uri: "https://app.example.test/link",
      interval: 5,
      expires_in: 5,
    }));

    await expect(runObsidianDeviceCodeFlow("https://api.example.test", "Research", {
      request,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      presentApproval: vi.fn(),
    })).rejects.toMatchObject({ kind: "expired" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("stops polling when the user dismisses the approval modal", async () => {
    let now = 10_000;
    const sleep = vi.fn(async (ms: number) => { now += ms; });
    let cancelled = false;
    const request = vi.fn(async (input: DeviceAuthRequest) => {
      if (input.url.endsWith("/code")) {
        return response(200, {
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://app.example.test/link",
          interval: 2,
          expires_in: 600,
        });
      }
      // The dismissal lands while the flow is waiting between polls.
      cancelled = true;
      return response(400, { error: "authorization_pending" });
    });

    await expect(
      runObsidianDeviceCodeFlow("https://api.example.test", "Research", {
        request,
        sleep,
        now: () => now,
        presentApproval: vi.fn(),
        shouldCancel: () => cancelled,
      }),
    ).rejects.toMatchObject({ kind: "cancelled" });

    // One poll happened, then the cancel was observed; it must not have kept polling to expiry.
    const polls = request.mock.calls.filter(([call]) => call.url.endsWith("/token")).length;
    expect(polls).toBe(1);
  });

  it("does not require shouldCancel", async () => {
    let now = 10_000;
    const request = vi.fn(async (input: DeviceAuthRequest) =>
      input.url.endsWith("/code")
        ? response(200, {
            device_code: "device-secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://app.example.test/link",
            interval: 1,
            expires_in: 60,
          })
        : response(200, { credential: `ukz_${"A".repeat(32)}` }),
    );

    const result = await runObsidianDeviceCodeFlow("https://api.example.test", "Research", {
      request,
      sleep: async (ms: number) => { now += ms; },
      now: () => now,
      presentApproval: vi.fn(),
    });

    expect(result.apiKey).toBe(`ukz_${"A".repeat(32)}`);
  });
});
