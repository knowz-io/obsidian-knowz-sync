import { afterEach, describe, expect, it, vi } from "vitest";
import { openApprovalUrl } from "../src/browserLauncher";

describe("openApprovalUrl", () => {
  afterEach(() => {
    delete (window as Window & { require?: unknown }).require;
    vi.unstubAllGlobals();
  });

  it("uses Electron's external shell on desktop without making the plugin desktop-only", () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const browserPopup = vi.fn();
    (window as Window & { require?: (name: string) => unknown }).require = vi.fn((name) => {
      expect(name).toBe("electron");
      return { shell: { openExternal } };
    });
    vi.stubGlobal("open", browserPopup);

    openApprovalUrl("https://dev.knowz.io/link?user_code=ABCD-EFGH");

    expect(openExternal).toHaveBeenCalledWith(
      "https://dev.knowz.io/link?user_code=ABCD-EFGH",
    );
    expect(browserPopup).not.toHaveBeenCalled();
  });

  it("falls back to the Web API when Electron is absent on mobile", () => {
    const browserPopup = vi.fn();
    vi.stubGlobal("open", browserPopup);

    openApprovalUrl("https://dev.knowz.io/link?user_code=ABCD-EFGH");

    expect(browserPopup).toHaveBeenCalledWith(
      "https://dev.knowz.io/link?user_code=ABCD-EFGH",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
