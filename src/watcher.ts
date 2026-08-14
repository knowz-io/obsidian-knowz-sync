export type ChangeAction = 0 | 1 | 2 | 3;

export interface PendingChange {
  path: string;
  action: ChangeAction;
  oldPath?: string;
}

export class ChangeQueue {
  private readonly changes = new Map<string, PendingChange>();

  add(path: string, action: ChangeAction, oldPath?: string): void {
    if (action === 3 && oldPath) {
      const prior = this.changes.get(oldPath);
      if (prior) {
        this.changes.delete(oldPath);
        if (prior.action === 0) {
          this.changes.set(path, { path, action: 0 });
          return;
        }

        this.changes.set(path, {
          path,
          action: 3,
          oldPath: prior.action === 3 ? prior.oldPath : oldPath,
        });
        return;
      }

      this.changes.set(path, { path, action, oldPath });
      return;
    }

    const existing = this.changes.get(path);
    if (!existing) {
      this.changes.set(path, { path, action });
      return;
    }

    if (existing.action === 0 && action === 1) {
      return;
    }

    if (existing.action === 3 && action === 1) {
      return;
    }

    if (existing.action === 3 && action === 2 && existing.oldPath) {
      this.changes.delete(path);
      this.changes.set(existing.oldPath, { path: existing.oldPath, action: 2 });
      return;
    }

    if (existing.action === 0 && action === 2) {
      this.changes.delete(path);
      return;
    }

    this.changes.set(path, { path, action });
  }

  drain(): PendingChange[] {
    const pending = [...this.changes.values()];
    this.changes.clear();
    return pending;
  }
}
