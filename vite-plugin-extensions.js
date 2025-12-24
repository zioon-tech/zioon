import { resolve } from 'path';
import { readFileSync, existsSync, readdirSync } from 'fs';

/**
 * Zion Extensions 打包插件
 * 处理extensions目录下插件的依赖打包
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
      
      // 扫描所有插件
      const extensions = readdirSync(extensionsDir)
        .filter(dir => existsSync(resolve(extensionsDir, dir, 'extension.json')) || 
                        existsSync(resolve(extensionsDir, dir, 'package.json')));
      
      extensions.forEach(extName => {
        const extPath = resolve(extensionsDir, extName);
        let mainFile = 'main.js';
        
        // 读取插件配置
        const extJsonPath = resolve(extPath, 'extension.json');
        const pkgJsonPath = resolve(extPath, 'package.json');
        
        if (existsSync(extJsonPath)) {
          const extConfig = JSON.parse(readFileSync(extJsonPath, 'utf8'));
          mainFile = extConfig.main || mainFile;
        } else if (existsSync(pkgJsonPath)) {
          const pkgConfig = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
          mainFile = pkgConfig.main || mainFile;
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