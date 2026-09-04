import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: {
    external: ["node:sqlite"]
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.js"]
  }
});
