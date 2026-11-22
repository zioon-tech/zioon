import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Suites create isolated PostgreSQL schemas and real child Runtime servers.
    // Bound concurrent migrations/servers on developer machines and CI runners.
    maxWorkers: 2,
    minWorkers: 1,
    include: ["tests/**/*.test.js"]
  }
});
