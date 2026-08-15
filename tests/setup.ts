/**
 * The suite runs under Node, which has no `window`, while the plugin uses `window.setTimeout`
 * for its retry delay. Obsidian also injects an `activeWindow` global pointing at the window
 * the user is currently in.
 *
 * `globalThis` is used as the value rather than a captured `{ setTimeout }` object so that
 * `window.setTimeout` resolves at call time — otherwise `vi.useFakeTimers()` would patch the
 * global while tests still held a reference to the real one.
 */
const shim = globalThis as unknown as { window: unknown; activeWindow: unknown };

if (shim.window === undefined) {
  shim.window = globalThis;
}
shim.activeWindow = globalThis;

export {};
