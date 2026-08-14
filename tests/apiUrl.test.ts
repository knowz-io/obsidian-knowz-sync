import { describe, expect, it } from "vitest";
import { InvalidApiUrlError, isTrustedKnowzHost, normalizeApiBaseUrl } from "../src/apiUrl";

describe("normalizeApiBaseUrl", () => {
  it("accepts an https URL and strips the trailing slash", () => {
    expect(normalizeApiBaseUrl("https://api.knowz.io/")).toBe("https://api.knowz.io");
    expect(normalizeApiBaseUrl("  https://api.knowz.io  ")).toBe("https://api.knowz.io");
  });

  it("preserves a path prefix for self-hosted deployments behind a gateway", () => {
    expect(normalizeApiBaseUrl("https://knowz.example.com/gateway/")).toBe(
      "https://knowz.example.com/gateway",
    );
  });

  // The whole vault and the API key travel on every request. Plaintext http means both are
  // readable by anyone on the network path.
  it("rejects http for a remote host", () => {
    expect(() => normalizeApiBaseUrl("http://api.knowz.io")).toThrow(InvalidApiUrlError);
    expect(() => normalizeApiBaseUrl("http://evil.example.com")).toThrow(/https/i);
  });

  it("allows http only for loopback, so local development still works", () => {
    expect(normalizeApiBaseUrl("http://localhost:5001")).toBe("http://localhost:5001");
    expect(normalizeApiBaseUrl("http://127.0.0.1:5001")).toBe("http://127.0.0.1:5001");
    expect(normalizeApiBaseUrl("http://[::1]:5001")).toBe("http://[::1]:5001");
  });

  it("rejects a URL carrying embedded credentials", () => {
    expect(() => normalizeApiBaseUrl("https://user:pass@knowz.example.test")).toThrow(
      InvalidApiUrlError,
    );
  });

  it("rejects non-http schemes", () => {
    for (const url of ["ftp://api.knowz.io", "file:///etc/passwd", "javascript:alert(1)"]) {
      expect(() => normalizeApiBaseUrl(url)).toThrow(InvalidApiUrlError);
    }
  });

  it("rejects empty and unparseable input", () => {
    for (const url of ["", "   ", "not a url", "://missing-scheme"]) {
      expect(() => normalizeApiBaseUrl(url)).toThrow(InvalidApiUrlError);
    }
  });

  it("rejects a bare host with no scheme rather than guessing one", () => {
    expect(() => normalizeApiBaseUrl("api.knowz.io")).toThrow(InvalidApiUrlError);
  });
});

describe("isTrustedKnowzHost", () => {
  it("recognizes knowz.io and its subdomains", () => {
    expect(isTrustedKnowzHost("https://api.knowz.io")).toBe(true);
    expect(isTrustedKnowzHost("https://sync.knowz.io")).toBe(true);
    expect(isTrustedKnowzHost("https://knowz.io")).toBe(true);
  });

  it("treats loopback as trusted for local development", () => {
    expect(isTrustedKnowzHost("http://localhost:5001")).toBe(true);
  });

  // The check exists to warn users, so a lookalike must not pass.
  it("rejects lookalike and suffix-attack hosts", () => {
    expect(isTrustedKnowzHost("https://knowz.io.evil.com")).toBe(false);
    expect(isTrustedKnowzHost("https://notknowz.io")).toBe(false);
    expect(isTrustedKnowzHost("https://evil.com/knowz.io")).toBe(false);
    expect(isTrustedKnowzHost("https://xn--knowz-hza.io")).toBe(false);
  });

  it("returns false rather than throwing for unparseable input", () => {
    expect(isTrustedKnowzHost("not a url")).toBe(false);
  });
});
