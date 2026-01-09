import { defineConfig } from "vite";
import { zionExtensionsPlugin } from "./vite-plugin-extensions-fixed.js";

export default defineConfig({
  server: {
    port: 5177,
    strictPort: false
  },
  preview: {
    port: 5175,
    strictPort: true
  },
  build: {
    emptyOutDir: false,
    // 增加chunk大小限制警告
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      // 确保主应用入口被正确处理
      input: {
        main: './index.html',
        'src/main': './src/main.ts'
      },
      // 不排除任何依赖，全部打包
      external: [], 
      output: {
        // 为插件创建独立的chunk
        manualChunks: (id) => {
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
    zionExtensionsPlugin() as any
  ],
  optimizeDeps: {
    // 确保这些依赖被预构建
    include: [
      "eventemitter3",
      "jszip",
      "katex",
      "mermaid",
      "plantuml-encoder",
      "@codemirror/lang-json"
    ]
  }
});
