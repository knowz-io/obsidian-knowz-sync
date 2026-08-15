import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      obsidian: new URL("./tests/mocks/obsidian.ts", import.meta.url).pathname,
    },
  },
});
