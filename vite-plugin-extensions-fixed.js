import { resolve, dirname, relative } from 'path';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { createRequire } from 'module';

/**
 * 改进的 Zion Extensions 打包插件
 * 处理extensions目录下插件的依赖打包，确保插件内部的import被正确打包
 */
export function zionExtensionsPlugin() {
  const require = createRequire(import.meta.url);
  
  return {
    name: 'zion-extensions-fixed',
    apply: 'build',
    
    config(config) {
      // 确保extensions被正确处理
      if (!config.build) config.build = {};
      if (!config.build.rollupOptions) config.build.rollupOptions = {};
      if (!config.build.rollupOptions.input) config.build.rollupOptions.input = {};
      if (!config.build.rollupOptions.external) config.build.rollupOptions.external = [];
      
      // 添加extensions作为额外入口
      const extensionsInput = {};
      const extensionsDir = resolve(process.cwd(), 'extensions');

      if (!existsSync(extensionsDir)) {
        return config;
      }
      
      // 扫描所有插件
      const extensions = readdirSync(extensionsDir)
        .filter(dir => {
          const dirPath = resolve(extensionsDir, dir);
          try {
            return statSync(dirPath).isDirectory() && 
                   (existsSync(resolve(dirPath, 'extension.json')) || 
                    existsSync(resolve(dirPath, 'package.json')) ||
                    existsSync(resolve(dirPath, 'main.js')) ||
                    existsSync(resolve(dirPath, 'main.ts')));
          } catch {
            return false;
          }
        });
      
      console.log(`找到 ${extensions.length} 个插件:`, extensions);
      
      extensions.forEach(extName => {
        const extPath = resolve(extensionsDir, extName);
        let mainFile = 'main.js';
        
        // 读取插件配置
        const extJsonPath = resolve(extPath, 'extension.json');
        const pkgJsonPath = resolve(extPath, 'package.json');
        
        if (existsSync(extJsonPath)) {
          try {
            const extConfig = JSON.parse(readFileSync(extJsonPath, 'utf8'));
            mainFile = extConfig.main || mainFile;
          } catch (e) {
            console.warn(`解析 ${extJsonPath} 失败:`, e.message);
          }
        } else if (existsSync(pkgJsonPath)) {
          try {
            const pkgConfig = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
            mainFile = pkgConfig.main || mainFile;
          } catch (e) {
            console.warn(`解析 ${pkgJsonPath} 失败:`, e.message);
          }
        }
        
        // 尝试不同的扩展名
        const possibleMainFiles = [
          mainFile,
          mainFile.replace(/\.js$/, '.ts'),
          'main.js',
          'main.ts',
          'index.js',
          'index.ts'
        ];
        
        let mainPath = null;
        for (const file of possibleMainFiles) {
          const testPath = resolve(extPath, file);
          if (existsSync(testPath)) {
            mainPath = testPath;
            break;
          }
        }
        
        if (mainPath) {
          const relativePath = relative(process.cwd(), mainPath);
          const entryName = `extensions/${extName}/main`;
          extensionsInput[entryName] = mainPath;
          console.log(`添加插件入口: ${entryName} -> ${relativePath}`);
        } else {
          console.warn(`插件 ${extName} 未找到主文件，尝试的路径:`, possibleMainFiles);
        }
      });
      
      // 合并到rollup输入配置
      Object.assign(config.build.rollupOptions.input, extensionsInput);
      
      // 确保不外部化任何依赖，全部打包
      config.build.rollupOptions.external = [];
      
      // 配置输出chunk命名
      if (!config.build.rollupOptions.output) config.build.rollupOptions.output = {};
      if (!config.build.rollupOptions.output.manualChunks) {
        config.build.rollupOptions.output.manualChunks = (id) => {
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
        };
      }
      
      return config;
    },
    
    // 解析插件中的导入，确保依赖被正确打包
    async resolveId(source, importer) {
      // 如果是插件内部的相对导入，确保正确解析
      if (importer && importer.includes('/extensions/') && source.startsWith('.')) {
        const importerDir = dirname(importer);
        const resolved = resolve(importerDir, source);
        
        // 检查是否存在
        if (existsSync(resolved) || existsSync(resolved + '.js') || existsSync(resolved + '.ts')) {
          return resolved;
        }
      }
      
      // 处理插件内部的node_modules导入
      if (importer && importer.includes('/extensions/') && !source.startsWith('.')) {
        // 尝试在插件的node_modules中查找
        const importerDir = dirname(importer);
        const pluginNodeModules = resolve(importerDir, 'node_modules');
        
        if (existsSync(pluginNodeModules)) {
          try {
            const resolved = require.resolve(source, { paths: [importerDir] });
            return resolved;
          } catch (e) {
            // 如果插件node_modules中没有，回退到项目根目录的node_modules
            try {
              const resolved = require.resolve(source, { paths: [process.cwd()] });
              return resolved;
            } catch (e2) {
              // 继续使用默认解析
            }
          }
        }
      }
      
      return null;
    },
    
    // 加载插件文件时，确保正确处理
    async load(id) {
      // 如果是插件文件，确保其依赖被正确标记
      if (id.includes('/extensions/') && (id.endsWith('.js') || id.endsWith('.ts'))) {
        const code = readFileSync(id, 'utf8');
        
        // 检查是否有外部依赖
        const hasExternalImports = code.includes('from "') || code.includes("from '") || 
                                   code.includes('import ') || code.includes('require(');
        
        if (hasExternalImports) {
          console.log(`处理插件文件: ${relative(process.cwd(), id)}`);
        }
        
        return {
          code,
          map: null
        };
      }
      return null;
    },
    
    // 构建选项配置
    configResolved(config) {
      // 确保optimizeDeps包含插件可能用到的依赖
      if (!config.optimizeDeps) config.optimizeDeps = {};
      if (!config.optimizeDeps.include) config.optimizeDeps.include = [];
      
      const depsToInclude = [
        "langchain",
        "@langchain/openai",
        "@langchain/core",
        "openai",
        "zod",
        "eventemitter3"
      ];
      
      depsToInclude.forEach(dep => {
        try {
          require.resolve(dep, { paths: [process.cwd()] });
        } catch {
          return;
        }
        if (!config.optimizeDeps.include.includes(dep)) {
          config.optimizeDeps.include.push(dep);
        }
      });
      
      console.log('优化依赖包含:', config.optimizeDeps.include);
    },
    
    generateBundle(options, bundle) {
      // 验证所有插件chunk都已生成
      const extensionChunks = Object.keys(bundle).filter(fileName => 
        fileName.includes('extensions/') && bundle[fileName].type === 'chunk'
      );
      
      console.log(`生成 ${extensionChunks.length} 个插件chunk:`);
      extensionChunks.forEach(chunkName => {
        const chunk = bundle[chunkName];
        console.log(`  - ${chunkName}: ${chunk.modules ? Object.keys(chunk.modules).length : '未知'} 个模块`);
      });
      
      // 检查是否有大文件警告
      const largeChunks = Object.keys(bundle).filter(fileName => {
        const chunk = bundle[fileName];
        return chunk.type === 'chunk' && chunk.code.length > 500 * 1024; // 大于500KB
      });
      
      if (largeChunks.length > 0) {
        console.warn('发现大chunk:', largeChunks.map(name => `${name} (${Math.round(bundle[name].code.length / 1024)}KB)`));
      }
    }
  };
}
