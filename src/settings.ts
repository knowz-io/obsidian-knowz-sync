export interface KnowzPluginSettings {
  apiBaseUrl: string;
  apiKey: string;
  accountName?: string;
  tenantName?: string;
  vaultName?: string;
  vaultId: string;
  repositoryId: string;
  excludeGlobs: string[];
  syncOnStartup: boolean;
  knownFiles: Record<string, string>;
  /**
   * Set once the user has confirmed the first upload. Syncing sends the whole vault, so the
   * first push is an explicit decision rather than a side effect of entering a key.
   */
  hasConfirmedFirstSync: boolean;
}

export const DEFAULT_SETTINGS: KnowzPluginSettings = {
  apiBaseUrl: "https://api.knowz.io",
  apiKey: "",
  accountName: "",
  tenantName: "",
  vaultName: "",
  vaultId: "",
  repositoryId: "",
  // The config folder is excluded unconditionally by isExcluded() via Vault#configDir, so it
  // is deliberately not listed here — a static ".obsidian/" would be wrong for any user who
  // has relocated it.
  excludeGlobs: [".trash/", ".smart-env/"],
  syncOnStartup: false,
  knownFiles: {},
  hasConfirmedFirstSync: false,
};

const GLOB_CHARACTERS = /[*?]/;

/**
 * Converts one exclusion pattern to an anchored regular expression.
 *
 * `**` crosses path separators, `*` matches within a single segment, and `?` matches one
 * character. Everything else is literal, so a filename containing regex metacharacters such
 * as `a+b.md` or `notes(1).md` matches itself.
 */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        // `**/` should also match zero directories, so `Journal/**/a.md` matches `Journal/a.md`.
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "i");
}

function isUnderDirectory(path: string, directory: string): boolean {
  const normalized = directory.replace(/\/+$/, "").toLowerCase();
  if (normalized === "") {
    return false;
  }
  const lowerPath = path.toLowerCase();
  return lowerPath === normalized || lowerPath.startsWith(`${normalized}/`);
}

/**
 * Whether a vault-relative path is excluded from syncing.
 *
 * Three forms are supported:
 *  - a directory prefix (`Journal/`, or a bare `Journal`) excludes the folder and everything
 *    beneath it — this is the original behaviour and is preserved for existing installs;
 *  - a pattern containing `/` is anchored to the vault root (`Journal/secret.md`);
 *  - a pattern without `/` is matched against the file name in any folder (`*.private.md`).
 *
 * `configDir` should always be passed by callers that have a vault. Obsidian's configuration
 * folder is usually `.obsidian` but the user can relocate it, and it holds every plugin's
 * stored data — including, for plugins like this one, API credentials. It is therefore
 * excluded unconditionally rather than relying on a default pattern the user could delete.
 */
export function isConflictSidecar(path: string): boolean {
  return /\.knowz-conflict\.(md|markdown)$/i.test(path);
}

export function isExcluded(path: string, excludeGlobs: string[], configDir?: string): boolean {
  if (isConflictSidecar(path)) {
    return true;
  }
  if (configDir !== undefined && isUnderDirectory(path, configDir)) {
    return true;
  }

  return excludeGlobs.some((pattern) => {
    const trimmed = pattern.trim();
    if (trimmed === "") {
      return false;
    }

    if (!GLOB_CHARACTERS.test(trimmed)) {
      // Directory-prefix semantics, as before — but compared case-insensitively. Obsidian
      // vaults live on case-insensitive filesystems on macOS and Windows, and for an
      // exclusion list a case mismatch fails in the dangerous direction: `journal/` would
      // silently not match `Journal/` and the folder would be uploaded.
      const withoutTrailingSlash = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
      const lowerPath = path.toLowerCase();
      const lowerPrefix = withoutTrailingSlash.toLowerCase();
      return lowerPath === lowerPrefix || lowerPath.startsWith(`${lowerPrefix}/`);
    }

    const expression = globToRegExp(trimmed);
    if (trimmed.includes("/")) {
      return expression.test(path);
    }

    const fileName = path.slice(path.lastIndexOf("/") + 1);
    return expression.test(fileName);
  });
}

/**
 * Parses the exclusions textarea: one pattern per line, blank lines and `#` comments dropped.
 */
export function parseExcludePatterns(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}
