import { describe, expect, it } from "vitest";
import { ChangeQueue } from "../src/watcher";

describe("ChangeQueue", () => {
  it("coalesces create then modify into Added", () => {
    const queue = new ChangeQueue();

    queue.add("note.md", 0);
    queue.add("note.md", 1);

    expect(queue.drain()).toEqual([{ path: "note.md", action: 0 }]);
  });

  it("coalesces modify then delete into Deleted", () => {
    const queue = new ChangeQueue();

    queue.add("note.md", 1);
    queue.add("note.md", 2);

    expect(queue.drain()).toEqual([{ path: "note.md", action: 2 }]);
  });

  it("records the old path for a rename", () => {
    const queue = new ChangeQueue();

    queue.add("new.md", 3, "old.md");

    expect(queue.drain()).toEqual([{ path: "new.md", action: 3, oldPath: "old.md" }]);
  });

  it("preserves the original old path through a rename chain", () => {
    const queue = new ChangeQueue();

    queue.add("middle.md", 3, "original.md");
    queue.add("final.md", 3, "middle.md");

    expect(queue.drain()).toEqual([
      { path: "final.md", action: 3, oldPath: "original.md" },
    ]);
  });
});
