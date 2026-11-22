import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { zionExtensionsPlugin } from "./vite-plugin-extensions-fixed.js";
import { VitePWA } from 'vite-plugin-pwa';
import { createRequire } from "node:module";
import { WORKBENCH_NAVIGATION_FALLBACK_DENYLIST } from "./src/pwa-navigation";
import workbenchManifest from "./public/manifest.json";

const require = createRequire(import.meta.url);
const reactPath = require.resolve("react");
const reactJsxRuntimePath = require.resolve("react/jsx-runtime");
const reactJsxDevRuntimePath = require.resolve("react/jsx-dev-runtime");
const reactDomPath = require.resolve("react-dom");
const reactDomClientPath = require.resolve("react-dom/client");

export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: /^react-dom\/client$/, replacement: reactDomClientPath },
      { find: /^react-dom$/, replacement: reactDomPath },
      { find: /^react\/jsx-runtime$/, replacement: reactJsxRuntimePath },
      { find: /^react\/jsx-dev-runtime$/, replacement: reactJsxDevRuntimePath },
      { find: /^react$/, replacement: reactPath }
    ]
  },
  server: {
    port: 5177,
    strictPort: false,
    host: true  // 允许局域网访问
  },
  preview: {
    port: 5175,
    strictPort: true
  },
  build: {
    target: "es2022",
    emptyOutDir: true,
    // 增加chunk大小限制警告
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      // 确保主应用入口被正确处理
      input: {
        main: './index.html',
        'share-reader': './share-reader.html',
        'src/main': './src/main.ts'
      },
      // 不排除任何依赖，全部打包
      external: [], 
      output: {
        onlyExplicitManualChunks: true,
        // 为插件创建独立的chunk
        manualChunks: (id) => {
          if (/\.css(?:\?|$)/.test(id)) return;
          if (/\/extensions\/dev\.tools\/(tool-calls|artifact-model|syntax-highlight)\.js$/.test(id)) return 'conversation-tools';
          if (/\/extensions\/dev\.thinking\/thinking-cards\.js$/.test(id)) return 'conversation-thinking';
          if (/\/extensions\/dev\.roles\/roles\.js$/.test(id)) return 'conversation-roles';
          // 插件代码单独打包
          if (id.includes('/extensions/')) {
            const match = id.match(/\/extensions\/([^/]+)/);
            if (match) {
              return `extensions/${match[1]}`;
            }
          }
          // 第三方依赖按包名分组
          if (id.includes('node_modules/')) {
            const match = id.match(/node_modules\/([^/]+)/);
            if (match) {
              return `vendor/${match[1]}`;
            }
          }
          return null;
        }
      }
    },
    // 复制extensions目录到dist
    copyPublicDir: true
  },
  plugins: [
    react(),
    zionExtensionsPlugin() as any,
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'zioon-icon-192.png', 'zioon-icon-512.png', 'zioon-apple-touch-icon.png'],
      workbox: {
        importScripts: ["/sw-client-refresh.js"],
        navigateFallbackDenylist: WORKBENCH_NAVIGATION_FALLBACK_DENYLIST,
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024
      },
      manifest: { ...workbenchManifest, display: "standalone",
        icons: workbenchManifest.icons.map(icon => ({ ...icon, purpose: "any" as const })) },
      devOptions: {
        enabled: true,
        type: 'module'
      }
    })
  ],
  optimizeDeps: {
    esbuildOptions: {
      target: "es2022"
    },
    // 确保这些依赖被预构建
    include: [
      "eventemitter3",
      "jszip",
      "katex",
      "mermaid",
      "mermaid/dist/c4Diagram-15b5d702.js",
      "mermaid/dist/flowDiagram-cbd28bf7.js",
      "mermaid/dist/flowDiagram-v2-ffc7f31a.js",
      "mermaid/dist/erDiagram-880f2ed8.js",
      "mermaid/dist/gitGraphDiagram-21fc4d3e.js",
      "mermaid/dist/ganttDiagram-04f9e578.js",
      "mermaid/dist/infoDiagram-4a4f5b27.js",
      "mermaid/dist/pieDiagram-421022e6.js",
      "mermaid/dist/quadrantDiagram-0957ecba.js",
      "mermaid/dist/xychartDiagram-b6496bcd.js",
      "mermaid/dist/requirementDiagram-23d650b8.js",
      "mermaid/dist/sequenceDiagram-17ac3bff.js",
      "mermaid/dist/classDiagram-d40c83e7.js",
      "mermaid/dist/classDiagram-v2-d5a6b087.js",
      "mermaid/dist/stateDiagram-9c5f0230.js",
      "mermaid/dist/stateDiagram-v2-51a3dcff.js",
      "mermaid/dist/journeyDiagram-29694f62.js",
      "mermaid/dist/flowchart-elk-definition-36e2d292.js",
      "mermaid/dist/timeline-definition-7e6b55e7.js",
      "mermaid/dist/mindmap-definition-ac74a2e8.js",
      "mermaid/dist/sankeyDiagram-23345273.js",
      "mermaid/dist/blockDiagram-68f4deed.js",
      "plantuml-encoder",
      "@codemirror/lang-json"
    ]
  }
});
