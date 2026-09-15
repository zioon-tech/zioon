import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const require = createRequire(import.meta.url);
const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const runtimeTarget =
    environment.ZION_MOBILE_RUNTIME_URL || "http://127.0.0.1:8766";

  return {
    root: appRoot,
    base: "/mobile/",
    publicDir: "public",
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: [
        { find: /^react-dom\/client$/, replacement: require.resolve("react-dom/client") },
        { find: /^react-dom$/, replacement: require.resolve("react-dom") },
        { find: /^react\/jsx-runtime$/, replacement: require.resolve("react/jsx-runtime") },
        { find: /^react\/jsx-dev-runtime$/, replacement: require.resolve("react/jsx-dev-runtime") },
        { find: /^react$/, replacement: require.resolve("react") },
      ],
    },
    server: {
      host: true,
      port: 5182,
      strictPort: false,
      proxy: {
        "/health": runtimeTarget,
        "/v1": {
          target: runtimeTarget,
          ws: true,
        },
      },
    },
    preview: {
      host: true,
      port: 5181,
      strictPort: false,
    },
    build: {
      target: "es2022",
      outDir: fileURLToPath(new URL("../../dist/mobile", import.meta.url)),
      emptyOutDir: true,
      sourcemap: false,
    },
    plugins: [
      react(),
      VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["favicon.svg", "icon-192.png", "icon-512.png"],
        manifest: {
          id: "/mobile/",
          name: "Zion Mobile",
          short_name: "Zion",
          lang: "zh-CN",
          description: "Mobile client for Zion Runtime",
          start_url: "/mobile/",
          scope: "/mobile/",
          display: "standalone",
          theme_color: "#ffffff",
          background_color: "#f6f7f7",
          icons: [
            {
              src: "/mobile/icon-192.png",
              sizes: "192x192",
              type: "image/png",
            },
            {
              src: "/mobile/icon-512.png",
              sizes: "512x512",
              type: "image/png",
            },
          ],
        },
        workbox: {
          navigateFallback: "/mobile/index.html",
          navigateFallbackAllowlist: [/^\/mobile\//],
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        },
        devOptions: {
          enabled: true,
          type: "module",
        },
      }),
    ],
  };
});
