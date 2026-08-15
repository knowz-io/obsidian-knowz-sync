import { normalizeApiBaseUrl } from "./apiUrl";

export interface DeviceAuthRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  throw: false;
}

export interface DeviceAuthResponse {
  status: number;
  json: Record<string, unknown>;
}

export interface DeviceAuthDeps {
  request: (request: DeviceAuthRequest) => Promise<DeviceAuthResponse>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  openBrowser: (url: string) => void;
  showCode: (code: string, verificationUri: string) => void;
}

export type DeviceAuthErrorKind = "denied" | "expired" | "invalid-response" | "network" | "refused";

export class DeviceAuthError extends Error {
  constructor(message: string, readonly kind: DeviceAuthErrorKind) {
    super(message);
  }
}

export interface ObsidianDeviceAuthResult {
  apiKey: string;
  accountName?: string;
}

interface IssuedDeviceCode {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  interval?: unknown;
  expires_in?: unknown;
}

const PERSONAL_KEY = /^ukz_[A-Za-z0-9]{32}$/;

export async function runObsidianDeviceCodeFlow(
  apiBaseUrl: string,
  vaultName: string,
  deps: DeviceAuthDeps,
): Promise<ObsidianDeviceAuthResult> {
  const origin = normalizeApiBaseUrl(apiBaseUrl);
  let issueResponse: DeviceAuthResponse;
  try {
    issueResponse = await deps.request({
      url: `${origin}/api/v1/auth/device/code`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "obsidian",
        installationName: vaultName,
        edition: "community",
      }),
      throw: false,
    });
  } catch {
    throw new DeviceAuthError("Could not reach Knowz to start sign-in.", "network");
  }

  if (issueResponse.status >= 400) {
    throw new DeviceAuthError("Knowz refused the Obsidian connection request.", "refused");
  }
  const issued = issueResponse.json as IssuedDeviceCode;
  if (
    typeof issued.device_code !== "string" ||
    typeof issued.user_code !== "string" ||
    typeof issued.verification_uri !== "string" ||
    typeof issued.expires_in !== "number" ||
    issued.expires_in <= 0
  ) {
    throw new DeviceAuthError("Knowz returned an invalid device sign-in response.", "invalid-response");
  }

  const verificationUrl = typeof issued.verification_uri_complete === "string"
    ? issued.verification_uri_complete
    : issued.verification_uri;
  deps.showCode(issued.user_code, issued.verification_uri);
  deps.openBrowser(verificationUrl);

  let interval = Math.max(1, typeof issued.interval === "number" ? issued.interval : 5);
  const deadline = deps.now() + issued.expires_in * 1000;
  while (deps.now() < deadline) {
    await deps.sleep(interval * 1000);
    if (deps.now() >= deadline) break;

    let pollResponse: DeviceAuthResponse;
    try {
      pollResponse = await deps.request({
        url: `${origin}/api/v1/auth/device/token`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: issued.device_code, scope: "obsidian" }),
        throw: false,
      });
    } catch {
      throw new DeviceAuthError("Could not reach Knowz while waiting for approval.", "network");
    }

    const body = pollResponse.json ?? {};
    const status = String(body.error ?? body.status ?? (body.credential ? "approved" : ""));
    if (status === "authorization_pending" || status === "pending") continue;
    if (status === "slow_down") {
      interval = typeof body.interval === "number"
        ? Math.max(interval + 5, body.interval)
        : interval + 5;
      continue;
    }
    if (status === "expired_token" || status === "expired") {
      throw new DeviceAuthError("The Knowz sign-in code expired. Try connecting again.", "expired");
    }
    if (status === "access_denied" || status === "denied") {
      throw new DeviceAuthError("The Knowz connection request was denied.", "denied");
    }
    if (status === "approved") {
      const apiKey = String(body.credential ?? "");
      if (!PERSONAL_KEY.test(apiKey)) {
        throw new DeviceAuthError("Knowz returned a malformed personal API key.", "invalid-response");
      }
      const account = body.account as { displayName?: unknown } | undefined;
      return {
        apiKey,
        ...(typeof account?.displayName === "string" && account.displayName.trim()
          ? { accountName: account.displayName.trim() }
          : {}),
      };
    }
    throw new DeviceAuthError(
      pollResponse.status >= 400
        ? "Knowz refused the device sign-in poll."
        : "Knowz returned an unrecognized device sign-in status.",
      pollResponse.status >= 400 ? "refused" : "invalid-response",
    );
  }

  throw new DeviceAuthError("The Knowz sign-in code expired. Try connecting again.", "expired");
}
