/**
 * Obsidian injects `activeWindow` as a global pointing at the window the user is currently in,
 * so plugins keep working when the vault is open in a popout. It does not exist under Node, so
 * the suite provides it. Obsidian's own typings already declare it, hence the assignment via a
 * cast rather than a second `declare global`.
 *
 * `globalThis` is used as the value rather than a captured `{ setTimeout }` object so that
 * `activeWindow.setTimeout` resolves at call time — otherwise `vi.useFakeTimers()` would patch
 * the global while tests still held a reference to the real one.
 */
(globalThis as unknown as { activeWindow: unknown }).activeWindow = globalThis;

export {};
