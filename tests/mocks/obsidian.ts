export type App = {
  workspace: { onLayoutReady(callback: () => void): void };
  vault: {
    configDir: string;
    on(name: string, handler: (...args: unknown[]) => void): unknown;
    getName(): string;
    getMarkdownFiles(): TFile[];
    cachedRead(file: TFile): Promise<string>;
    getAbstractFileByPath(path: string): unknown;
  };
  metadataCache: { resolvedLinks: Record<string, Record<string, number>> };
};

export class TFile {
  path = "";
  extension = "md";
  stat = { mtime: 0 };
}

export type TAbstractFile = { path: string };

export class Plugin {
  constructor(public app: App) {}
  addRibbonIcon(_icon: string, _title: string, _cb: () => void): unknown {
    return {};
  }
  addCommand(_command: unknown): unknown {
    return {};
  }
  addSettingTab(_tab: unknown): void {}
  registerEvent(_ref: unknown): void {}
  registerInterval(_id: number): number {
    return _id;
  }
  async loadData(): Promise<unknown> {
    return null;
  }
  async saveData(_data: unknown): Promise<void> {}
}

/**
 * Stands in for the declarative settings API added in app 1.13.0. `update()` records that a
 * re-render was asked for; `getControlValue`/`setControlValue` are the base-class fallbacks
 * the plugin delegates to for keys it does not own, and throw here so a test notices if the
 * plugin ever leans on them for a key it should be handling itself.
 */
export class PluginSettingTab {
  containerEl = { empty(): void {} };
  updateCount = 0;
  constructor(
    public app: App,
    _plugin: unknown,
  ) {}
  update(): void {
    this.updateCount += 1;
  }
  getControlValue(key: string): unknown {
    throw new Error(`unhandled getControlValue(${key})`);
  }
  async setControlValue(key: string, _value: unknown): Promise<void> {
    throw new Error(`unhandled setControlValue(${key})`);
  }
}

/**
 * Stands in for the input element behind a text component. Listeners are recorded rather
 * than dispatched by a DOM, so a test can fire a key the way the user would.
 */
export type FakeInputEl = {
  type: string;
  rows: number;
  listeners: Record<string, Array<(event: unknown) => void>>;
  addEventListener(name: string, handler: (event: unknown) => void): void;
  dispatch(name: string, event: unknown): void;
};

function fakeInputEl(): FakeInputEl {
  return {
    type: "text",
    rows: 0,
    listeners: {},
    addEventListener(name, handler) {
      (this.listeners[name] ??= []).push(handler);
    },
    dispatch(name, event) {
      for (const handler of this.listeners[name] ?? []) {
        handler(event);
      }
    },
  };
}

/** A text/textarea component, recording what the plugin configured on it. */
export class TextComponent {
  inputEl: FakeInputEl = fakeInputEl();
  placeholder = "";
  value = "";
  changeHandler: (value: string) => unknown = () => {};
  setPlaceholder(placeholder: string): this {
    this.placeholder = placeholder;
    return this;
  }
  setValue(value: string): this {
    this.value = value;
    return this;
  }
  onChange(handler: (value: string) => unknown): this {
    this.changeHandler = handler;
    return this;
  }
}

export class ButtonComponent {
  text = "";
  cta = false;
  clickHandler: () => unknown = () => {};
  setButtonText(text: string): this {
    this.text = text;
    return this;
  }
  setCta(): this {
    this.cta = true;
    return this;
  }
  onClick(handler: () => unknown): this {
    this.clickHandler = handler;
    return this;
  }
}

export class ToggleComponent {
  value = false;
  changeHandler: (value: boolean) => unknown = () => {};
  setValue(value: boolean): this {
    this.value = value;
    return this;
  }
  onChange(handler: (value: boolean) => unknown): this {
    this.changeHandler = handler;
    return this;
  }
}

export class Setting {
  readonly texts: TextComponent[] = [];
  readonly buttons: ButtonComponent[] = [];
  readonly toggles: ToggleComponent[] = [];
  name = "";
  desc = "";
  heading = false;

  constructor(_containerEl?: unknown) {
    settingInstances.push(this);
  }
  setName(name: string): this {
    this.name = name;
    return this;
  }
  setDesc(desc: string): this {
    this.desc = desc;
    return this;
  }
  setHeading(): this {
    this.heading = true;
    return this;
  }
  addText(callback: (text: TextComponent) => unknown): this {
    const text = new TextComponent();
    this.texts.push(text);
    callback(text);
    return this;
  }
  addTextArea(callback: (text: TextComponent) => unknown): this {
    return this.addText(callback);
  }
  addButton(callback: (button: ButtonComponent) => unknown): this {
    const button = new ButtonComponent();
    this.buttons.push(button);
    callback(button);
    return this;
  }
  addToggle(callback: (toggle: ToggleComponent) => unknown): this {
    const toggle = new ToggleComponent();
    this.toggles.push(toggle);
    callback(toggle);
    return this;
  }
}

export const settingInstances: Setting[] = [];

export class Modal {
  contentEl = {
    empty(): void {},
    createEl(): unknown {
      return { createEl: () => ({}), setText: () => {}, addEventListener: () => {} };
    },
    createDiv(): unknown {
      return { createEl: () => ({}), addClass: () => {} };
    },
  };
  constructor(public app: App) {}
  /** The real Modal runs these lifecycle hooks, and a dismissal is only observable through
   * onClose — so the mock runs them too rather than leaving a modal that never closes. */
  open(): void {
    this.onOpen();
  }
  close(): void {
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

export const noticeMessages: string[] = [];

export class Notice {
  constructor(public msg: string) {
    noticeMessages.push(msg);
  }
}

export const requestUrl = async (_request: unknown): Promise<never> => {
  throw new Error("mock requestUrl not stubbed");
};
