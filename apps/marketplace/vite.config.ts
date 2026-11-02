import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5190, proxy: { "/api": "http://127.0.0.1:8777" } },
  build: {
    target: "es2022", sourcemap: false,
    rollupOptions: { output: { manualChunks: (id) => {
      if (id.includes("react-markdown") || id.includes("remark") || id.includes("micromark") || id.includes("mdast")) return "markdown";
      if (id.includes("/antd/") || id.includes("/@ant-design/") || id.includes("/rc-")) return "ui";
    } } }
  }
});
