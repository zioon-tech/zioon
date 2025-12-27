import { defineConfig } from "vite";
import { zionExtensionsPlugin } from "./vite-plugin-extensions-fixed.js";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';

// 自定义插件：复制src/plugins到dist/plugins
function builtinPluginsPlugin() {
  return {
    name: 'builtin-plugins',
    apply: 'build',
    writeBundle() {
      const pluginsSourceDir = resolve(process.cwd(), 'src/plugins');
      const pluginsDestDir = resolve(process.cwd(), 'dist/plugins');
      
      if (!existsSync(pluginsSourceDir)) {
        return;
      }
      
      console.log('[builtin-plugins] 处理内置插件目录...');
      
      // 递归复制插件文件
      function copyDirectory(source, dest) {
        if (!existsSync(dest)) {
          mkdirSync(dest, { recursive: true });
        }
        
        const entries = readdirSync(source, { withFileTypes: true });
        
        for (const entry of entries) {
          const srcPath = resolve(source, entry.name);
          const destPath = resolve(dest, entry.name);
          
          if (entry.isDirectory()) {
            copyDirectory(srcPath, destPath);
          } else {
            // 只复制TypeScript和JSON文件，其他类型不处理
            if (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.json')) {
              let content = readFileSync(srcPath, 'utf-8');
              
              // 对于TypeScript文件，复制为.js文件
              if (entry.name.endsWith('.ts')) {
                const jsPath = destPath.replace(/\.ts$/, '.js');
                writeFileSync(jsPath, content);
                console.log(`[builtin-plugins] 复制: ${entry.name} -> ${jsPath}`);
              } else if (entry.name === 'manifest.json') {
                // 对于 manifest.json，需要将 main 字段的 .ts 改为 .js
                try {
                  const manifest = JSON.parse(content);
                  if (manifest.zion && manifest.zion.main && manifest.zion.main.endsWith('.ts')) {
                    manifest.zion.main = manifest.zion.main.replace(/\.ts$/, '.js');
                    content = JSON.stringify(manifest, null, 2);
                    console.log(`[builtin-plugins] 修改manifest.json的main字段: ${manifest.zion.main}`);
                  }
                } catch (e) {
                  console.warn(`[builtin-plugins] 处理manifest.json失败:`, e);
                }
                writeFileSync(destPath, content);
                console.log(`[builtin-plugins] 复制: ${entry.name}`);
              } else {
                writeFileSync(destPath, content);
                console.log(`[builtin-plugins] 复制: ${entry.name}`);
              }
            }
          }
        }
      }
      
      copyDirectory(pluginsSourceDir, pluginsDestDir);
      console.log(`[builtin-plugins] 内置插件处理完成`);
    }
  };
}

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
    zionExtensionsPlugin(),
    builtinPluginsPlugin()
  ],
  optimizeDeps: {
    // 确保这些依赖被预构建
    include: [
      "langchain",
      "@langchain/openai",
      "@langchain/core",
      "openai",
      "zod",
      "eventemitter3",
      "jszip",
      "katex",
      "mermaid",
      "plantuml-encoder"
    ]
  }
});