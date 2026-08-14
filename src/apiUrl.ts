/**
 * Validation for the user-supplied API base URL.
 *
 * Every request carries the user's API key in a header and, on push, the content of their
 * notes in the body. The base URL is free text in a settings field, so it is the single
 * point where a typo, a typosquat, or bad advice can redirect an entire vault plus the
 * credential to a host the user did not intend. Validation lives here rather than in the
 * settings tab alone because `data.json` can be edited by hand or replaced by vault sync,
 * and such a value never passes through the settings UI.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const TRUSTED_SUFFIX = "knowz.io";

export class InvalidApiUrlError extends Error {}

function parse(raw: string): URL {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new InvalidApiUrlError("Enter the Knowz API URL, for example https://api.knowz.io");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new InvalidApiUrlError(
      `"${trimmed}" is not a valid URL. Include the scheme, for example https://api.knowz.io`,
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new InvalidApiUrlError(
      `"${url.protocol}" is not supported. The Knowz API URL must start with https://`,
    );
  }

  // Credentials in the URL would be sent to the host and written to data.json in clear text.
  if (url.username !== "" || url.password !== "") {
    throw new InvalidApiUrlError(
      "Remove the username and password from the URL. Authentication uses the API key field.",
    );
  }

  if (url.protocol === "http:" && !isLoopback(url)) {
    throw new InvalidApiUrlError(
      `${url.host} must use https. Over http your API key and every note you sync are sent ` +
        "in clear text.",
    );
  }

  return url;
}

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
}

/**
 * Returns the URL with surrounding whitespace and any trailing slash removed, so it can be
 * concatenated with a path beginning `/api/...`. Throws `InvalidApiUrlError` with a message
 * intended to be shown to the user.
 */
export function normalizeApiBaseUrl(raw: string): string {
  const url = parse(raw);
  return url.toString().replace(/\/+$/, "");
}

/**
 * Whether the URL points at Knowz or at loopback. Used to warn — not to block, since
 * self-hosted and enterprise deployments run on customer domains.
 *
 * Matches only the exact apex or a dot-delimited subdomain, so `knowz.io.evil.com` and
 * `notknowz.io` are both rejected.
 */
export function isTrustedKnowzHost(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }

  if (isLoopback(url)) {
    return true;
  }

  const hostname = url.hostname.toLowerCase();
  return hostname === TRUSTED_SUFFIX || hostname.endsWith(`.${TRUSTED_SUFFIX}`);
}
