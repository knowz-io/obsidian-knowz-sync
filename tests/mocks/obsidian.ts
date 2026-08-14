export type App = {
  workspace: { onLayoutReady(callback: () => void): void };
  vault: {
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
  async loadData(): Promise<unknown> {
    return null;
  }
  async saveData(_data: unknown): Promise<void> {}
}

export class PluginSettingTab {
  containerEl = { empty(): void {} };
  constructor(_app: App, _plugin: unknown) {}
}

export class Setting {
  constructor(_containerEl: unknown) {}
  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
  setHeading(): this {
    return this;
  }
  addText(): this {
    return this;
  }
  addTextArea(): this {
    return this;
  }
  addButton(): this {
    return this;
  }
  addToggle(): this {
    return this;
  }
}

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
  open(): void {}
  close(): void {}
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
