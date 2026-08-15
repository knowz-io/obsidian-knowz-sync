import { beforeEach, describe, expect, it, vi } from "vitest";
import { settingInstances } from "./mocks/obsidian";
import { PullReviewModal } from "../src/pullReviewModal";
import type { PullChange } from "../src/syncEngine";

function change(path: string, classification: "server-only" | "both-changed"): PullChange {
  return {
    knowledgeId: `${path}-id`,
    path,
    serverHash: "server",
    localHash: classification === "server-only" ? "base" : "local",
    knownHash: "base",
    updatedAt: "2026-08-15T08:00:00Z",
    classification,
  };
}

describe("PullReviewModal", () => {
  beforeEach(() => {
    settingInstances.length = 0;
  });

  it("offers per-note and apply-all actions only for server-only changes", async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const modal = new PullReviewModal({} as never, [
      change("safe.md", "server-only"),
      change("conflict.md", "both-changed"),
    ], apply);

    modal.onOpen();

    const safe = settingInstances.find((setting) => setting.name === "safe.md")!;
    const conflict = settingInstances.find((setting) => setting.name === "conflict.md")!;
    const footer = settingInstances[settingInstances.length - 1]!;
    expect(safe.buttons.map((button) => button.text)).toEqual(["Apply"]);
    expect(conflict.buttons).toHaveLength(0);
    expect(conflict.desc).toContain("Conflict");
    expect(footer.buttons.map((button) => button.text)).toEqual(["Apply all (1)"]);

    await footer.buttons[0]?.clickHandler();
    expect(apply).toHaveBeenCalledWith(["safe.md"]);
  });
});
