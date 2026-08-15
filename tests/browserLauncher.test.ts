import { afterEach, describe, expect, it, vi } from "vitest";
import { openApprovalUrl } from "../src/browserLauncher";

const APPROVAL_URL = "https://app.example.test/link?user_code=ABCD-EFGH";

describe("openApprovalUrl", () => {
  afterEach(() => {
    delete (window as Window & { require?: unknown }).require;
    vi.unstubAllGlobals();
  });

  it("opens through the Web API", () => {
    const browserPopup = vi.fn();
    vi.stubGlobal("open", browserPopup);

    openApprovalUrl(APPROVAL_URL);

    expect(browserPopup).toHaveBeenCalledWith(APPROVAL_URL, "_blank", "noopener,noreferrer");
  });

  it("never reaches for Electron, even where a host require exists", () => {
    // Guideline compliance is the point: `shell.openExternal` is a Node/Electron API, and the
    // manifest declares `isDesktopOnly: false`. The caller supplies the user gesture instead,
    // which is what let this drop. Asserting `require` is untouched keeps it dropped.
    const hostRequire = vi.fn();
    (window as Window & { require?: (name: string) => unknown }).require = hostRequire;
    const browserPopup = vi.fn();
    vi.stubGlobal("open", browserPopup);

    openApprovalUrl(APPROVAL_URL);

    expect(hostRequire).not.toHaveBeenCalled();
    expect(browserPopup).toHaveBeenCalledWith(APPROVAL_URL, "_blank", "noopener,noreferrer");
  });

  it.each(["javascript:alert(1)", "data:text/html,<script></script>", "file:///etc/passwd"])(
    "refuses to open %s, which the server could otherwise smuggle in",
    (hostile) => {
      const browserPopup = vi.fn();
      vi.stubGlobal("open", browserPopup);

      expect(() => openApprovalUrl(hostile)).toThrow(/unsupported approval URL/);
      expect(browserPopup).not.toHaveBeenCalled();
    },
  );
});
