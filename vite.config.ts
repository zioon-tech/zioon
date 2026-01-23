import { defineConfig } from "vite";
import { zionExtensionsPlugin } from "./vite-plugin-extensions-fixed.js";
import { VitePWA } from 'vite-plugin-pwa';

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
    zionExtensionsPlugin() as any,
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Zion Next',
        short_name: 'Zion',
        description: 'Zion Next - A modern editor playground',
        theme_color: '#2563eb',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      devOptions: {
        enabled: true,
        type: 'module'
      }
    })
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
