import { describe, expect, it } from "vitest";
import { contentHash } from "../src/hash";

describe("contentHash", () => {
  it("matches the server SHA-256 vector after line-ending normalization", async () => {
    const expected = "7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78";

    expect(await contentHash("a\nb")).toBe(expected);
    expect(await contentHash("a\r\nb")).toBe(expected);
    expect(await contentHash("a\rb")).toBe(expected);
    expect(await contentHash("a\nb")).toMatch(/^[0-9a-f]{64}$/);
  });
});
