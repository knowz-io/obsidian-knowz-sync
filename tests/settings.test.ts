import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, isExcluded, parseExcludePatterns } from "../src/settings";

describe("isExcluded", () => {
  // Characterization: the pre-existing directory-prefix behaviour must not change, since
  // every existing install has these three patterns persisted in data.json.
  it("excludes the Obsidian workspace tree", () => {
    expect(isExcluded(".obsidian/app.json", [".obsidian/"])).toBe(true);
  });

  it("keeps ordinary notes", () => {
    expect(isExcluded("Notes/a.md", [".obsidian/"])).toBe(false);
  });

  it("still treats a plain folder name as a directory prefix", () => {
    expect(isExcluded("Archive/old.md", ["Archive"])).toBe(true);
    expect(isExcluded("Archive", ["Archive"])).toBe(true);
    // must not match a sibling that merely starts with the same letters
    expect(isExcluded("Archived/old.md", ["Archive"])).toBe(false);
  });

  it("applies every default exclusion", () => {
    for (const path of [".trash/x.md", ".smart-env/y.json"]) {
      expect(isExcluded(path, DEFAULT_SETTINGS.excludeGlobs)).toBe(true);
    }
  });

  // The config folder holds every plugin's stored data, including credentials. It is usually
  // .obsidian but the user can relocate it, so it must come from Vault#configDir rather than a
  // hardcoded default the user could also delete from their exclusion list.
  describe("Obsidian config folder", () => {
    it("is excluded via configDir even when no pattern mentions it", () => {
      expect(isExcluded(".obsidian/plugins/x/data.json", [], ".obsidian")).toBe(true);
    });

    it("is excluded when the user has relocated it", () => {
      expect(isExcluded(".my-config/plugins/x/data.json", [], ".my-config")).toBe(true);
      // and the old default no longer protects anything it should not
      expect(isExcluded(".obsidian/plugins/x/data.json", [], ".my-config")).toBe(false);
    });

    it("cannot be re-included by clearing the exclusion list", () => {
      expect(isExcluded(".obsidian/app.json", [], ".obsidian")).toBe(true);
    });

    it("tolerates a trailing slash and differing case", () => {
      expect(isExcluded(".Obsidian/app.json", [], ".obsidian/")).toBe(true);
    });

    it("does not over-match a sibling folder with the same prefix", () => {
      expect(isExcluded(".obsidian-backup/notes.md", [], ".obsidian")).toBe(false);
    });

    it("is inert when no configDir is supplied", () => {
      expect(isExcluded(".obsidian/app.json", [])).toBe(false);
    });
  });

  // The bug this fixes: the field was named excludeGlobs and did prefix matching, so a
  // user-authored glob silently matched nothing and the file was uploaded anyway.
  describe("glob patterns", () => {
    it("matches an extension glob anywhere in the vault", () => {
      expect(isExcluded("secret.private.md", ["*.private.md"])).toBe(true);
      expect(isExcluded("Journal/2026/secret.private.md", ["*.private.md"])).toBe(true);
      expect(isExcluded("Journal/notes.md", ["*.private.md"])).toBe(false);
    });

    it("matches a single path segment with *", () => {
      expect(isExcluded("Journal/private/a.md", ["Journal/*/a.md"])).toBe(true);
      // * must not cross a separator
      expect(isExcluded("Journal/deep/nested/a.md", ["Journal/*/a.md"])).toBe(false);
    });

    it("crosses separators with **", () => {
      expect(isExcluded("Journal/deep/nested/a.md", ["Journal/**/a.md"])).toBe(true);
      expect(isExcluded("Journal/a.md", ["Journal/**"])).toBe(true);
    });

    it("matches a single character with ?", () => {
      expect(isExcluded("note-a.md", ["note-?.md"])).toBe(true);
      expect(isExcluded("note-ab.md", ["note-?.md"])).toBe(false);
    });

    it("anchors a rooted pattern to the vault root", () => {
      expect(isExcluded("Journal/secret.md", ["Journal/secret.md"])).toBe(true);
      expect(isExcluded("Nested/Journal/secret.md", ["Journal/secret.md"])).toBe(false);
    });

    it("treats regex metacharacters as literals", () => {
      expect(isExcluded("a+b.md", ["a+b.md"])).toBe(true);
      expect(isExcluded("aab.md", ["a+b.md"])).toBe(false);
      expect(isExcluded("notes(1).md", ["notes(1).md"])).toBe(true);
    });

    it("is case-insensitive, matching how Obsidian treats vault paths", () => {
      expect(isExcluded("Journal/Secret.MD", ["journal/secret.md"])).toBe(true);
    });
  });

  it("ignores empty patterns rather than excluding everything", () => {
    expect(isExcluded("Notes/a.md", ["", "   "])).toBe(false);
  });
});

describe("parseExcludePatterns", () => {
  it("splits on newlines and trims", () => {
    expect(parseExcludePatterns(".obsidian/\n  *.private.md  \n\n.trash/")).toEqual([
      ".obsidian/",
      "*.private.md",
      ".trash/",
    ]);
  });

  it("drops comment lines so users can annotate their list", () => {
    expect(parseExcludePatterns("# personal\nJournal/\n")).toEqual(["Journal/"]);
  });

  it("returns an empty list for blank input", () => {
    expect(parseExcludePatterns("   \n\n")).toEqual([]);
  });
});
