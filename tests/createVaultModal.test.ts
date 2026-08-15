import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { settingInstances } from "./mocks/obsidian";
import { CreateVaultModal, promptForVaultName } from "../src/createVaultModal";

/**
 * The vault-name question used to be `window.prompt`, a native browser modal that Obsidian's
 * guidelines discourage and that behaves badly on mobile. The replacement is awaited, so the
 * contract that matters is that it always answers exactly once — including when the user
 * dismisses it with Esc or the close button, where nothing calls back into the modal.
 */

const app = {} as App;

/** The controls of the modal that is currently open. */
function controls() {
  const nameRow = settingInstances.find((setting) => setting.texts.length > 0)!;
  const buttonRow = settingInstances.find((setting) => setting.buttons.length > 0)!;
  return {
    text: nameRow.texts[0]!,
    cancel: buttonRow.buttons.find((button) => button.text === "Cancel")!,
    create: buttonRow.buttons.find((button) => button.cta)!,
  };
}

/** Opens the modal the way the plugin does, through the awaited helper. */
function openPrompt(defaultName = "TestVault") {
  const answer = promptForVaultName(app, defaultName);
  return { answer, ...controls() };
}

/** Opens the modal directly, for the cases that assert on how it resolves rather than what. */
function openModal(defaultName = "TestVault") {
  const resolve = vi.fn();
  const modal = new CreateVaultModal(app, defaultName, resolve);
  modal.open();
  return { modal, resolve, ...controls() };
}

describe("CreateVaultModal", () => {
  beforeEach(() => {
    settingInstances.length = 0;
  });

  it("prefills the field with the Obsidian vault name", () => {
    const { text } = openPrompt("Research notes");

    expect(text.value).toBe("Research notes");
  });

  it("resolves the trimmed name when the user creates the vault", async () => {
    const { answer, text, create } = openPrompt();

    text.changeHandler("  Research  ");
    create.clickHandler();

    await expect(answer).resolves.toBe("Research");
  });

  it("resolves null when the user cancels", async () => {
    const { answer, text, cancel } = openPrompt();

    text.changeHandler("Research");
    cancel.clickHandler();

    await expect(answer).resolves.toBeNull();
  });

  it("treats an empty or whitespace-only name as a cancel", async () => {
    const { answer, text, create } = openPrompt();

    text.changeHandler("   ");
    create.clickHandler();

    await expect(answer).resolves.toBeNull();
  });

  it("submits on Enter in the name field", async () => {
    const { answer, text } = openPrompt();

    text.changeHandler("Research");
    const event = { key: "Enter", preventDefault: vi.fn() };
    text.inputEl.dispatch("keydown", event);

    await expect(answer).resolves.toBe("Research");
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("ignores other keys in the name field", () => {
    const { resolve, text } = openModal();

    text.changeHandler("Research");
    text.inputEl.dispatch("keydown", { key: "a", preventDefault: vi.fn() });

    expect(resolve).not.toHaveBeenCalled();
  });

  // Esc and the window close button close the modal without routing through a button, so
  // onClose is the only place that can answer the caller. Without it the await hangs.
  it("resolves null when dismissed without an answer", () => {
    const { modal, resolve } = openModal();

    modal.close();

    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith(null);
  });

  it("answers exactly once even if it is closed twice", () => {
    const { modal, resolve, text, create } = openModal();

    text.changeHandler("Research");
    create.clickHandler();
    modal.close();

    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith("Research");
  });
});
