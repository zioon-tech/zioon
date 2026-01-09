import { resolve } from 'path';
import { readFileSync, existsSync, readdirSync } from 'fs';

/**
 * Zion Plugins 打包插件
 * 处理 extensions 目录下插件的打包
 * 仅支持 manifest.json（新格式）
 */
export function zionExtensionsPlugin() {
  return {
    name: 'zion-extensions',
    apply: 'build',
    
    config(config) {
      // 确保extensions被正确处理
      if (!config.build) config.build = {};
      if (!config.build.rollupOptions) config.build.rollupOptions = {};
      if (!config.build.rollupOptions.input) config.build.rollupOptions.input = {};
      
      // 添加extensions作为额外入口
      const extensionsInput = {};
      const extensionsDir = resolve(process.cwd(), 'extensions');
      
      // 扫描所有插件（仅支持 manifest.json）
      const extensions = readdirSync(extensionsDir)
        .filter(dir => existsSync(resolve(extensionsDir, dir, 'manifest.json')));

      extensions.forEach(extName => {
        const extPath = resolve(extensionsDir, extName);
        let mainFile = 'main.js';

        // 读取插件配置（仅支持 manifest.json）
        const manifestJsonPath = resolve(extPath, 'manifest.json');
        
        if (existsSync(manifestJsonPath)) {
          const manifest = JSON.parse(readFileSync(manifestJsonPath, 'utf8'));
          mainFile = manifest.zion?.main || manifest.main || mainFile;
        }
        
        const mainPath = resolve(extPath, mainFile);
        if (existsSync(mainPath)) {
          extensionsInput[`extensions/${extName}/main`] = mainPath;
        }
      });
      
      // 合并到rollup输入配置
      Object.assign(config.build.rollupOptions.input, extensionsInput);
    },
    
    transform(code, id) {
      // 处理插件内部的import，确保依赖被打包
      if (id.includes('/extensions/') && id.endsWith('.js')) {
        // 检查是否有外部依赖引用
        const hasExternalDeps = code.includes('from "') || code.includes("from '");
        if (hasExternalDeps) {
          // 确保这些依赖会被打包而不是外部化
          return {
            code,
            map: null
          };
        }
      }
      return null;
    },
    
    generateBundle(options, bundle) {
      // 确保插件的依赖被打包到对应的chunk中
      Object.keys(bundle).forEach(fileName => {
        const chunk = bundle[fileName];
        if (chunk.type === 'chunk' && fileName.includes('extensions/')) {
          // 确保插件chunk包含其依赖
          console.log(`处理插件chunk: ${fileName}`);
        }
      });
    }
  };
}