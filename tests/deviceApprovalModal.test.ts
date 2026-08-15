import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceApprovalModal } from "../src/deviceApprovalModal";
import type { App } from "obsidian";
import { noticeMessages, settingInstances } from "./mocks/obsidian";

const APP = {} as App;
const USER_CODE = "ABCD-EFGH";
const COMPLETE_URL = "https://app.example.test/link?user_code=ABCD-EFGH";
const BARE_URI = "https://app.example.test/link";

function build(onCancel = vi.fn()) {
  const modal = new DeviceApprovalModal(APP, USER_CODE, COMPLETE_URL, BARE_URI, onCancel);
  modal.open();
  const setting = settingInstances[settingInstances.length - 1];
  if (!setting) throw new Error("the modal registered no Setting");
  const [open, cancel] = setting.buttons;
  if (!open || !cancel) throw new Error("expected an open button and a cancel button");
  return { modal, onCancel, open, cancel };
}

describe("DeviceApprovalModal", () => {
  beforeEach(() => {
    settingInstances.length = 0;
    noticeMessages.length = 0;
    vi.unstubAllGlobals();
  });

  it("opens the approval page from the button's own click, not on its own", () => {
    const browserPopup = vi.fn();
    vi.stubGlobal("open", browserPopup);
    const { open } = build();

    // Nothing opened merely by showing the modal: the gesture is the whole point.
    expect(browserPopup).not.toHaveBeenCalled();

    open.clickHandler();

    expect(browserPopup).toHaveBeenCalledWith(COMPLETE_URL, "_blank", "noopener,noreferrer");
  });

  it("reports a dismissal as a cancel exactly once", () => {
    const { modal, onCancel, cancel } = build();

    cancel.clickHandler();
    expect(onCancel).toHaveBeenCalledTimes(1);

    // Esc or the close button after an already-closed modal must not double-report.
    modal.close();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("treats an Esc dismissal as a cancel", () => {
    const { modal, onCancel } = build();

    modal.close();

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not report a cancel when the flow closes it", () => {
    const { modal, onCancel } = build();

    modal.complete();

    expect(onCancel).not.toHaveBeenCalled();
  });

  it("surfaces a refused approval URL instead of throwing out of the click handler", () => {
    const browserPopup = vi.fn();
    vi.stubGlobal("open", browserPopup);
    const modal = new DeviceApprovalModal(APP, USER_CODE, "javascript:alert(1)", BARE_URI, vi.fn());
    modal.open();
    const setting = settingInstances[settingInstances.length - 1];
    const open = setting?.buttons[0];
    if (!open) throw new Error("expected an open button");

    expect(() => open.clickHandler()).not.toThrow();
    expect(browserPopup).not.toHaveBeenCalled();
    expect(noticeMessages.join(" ")).toMatch(/unsupported approval URL/);
  });
});
