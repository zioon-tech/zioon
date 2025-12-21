import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5177,
    strictPort: false
  },
  preview: {
    port: 5175,
    strictPort: true
  }
});