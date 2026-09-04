/**
 * 插件系统工具函数
 */

import type { PluginManifest, PluginError, PluginErrorType } from './types';
import { validatePluginManifest } from '../../packages/plugin-sdk/src/manifest.mjs';

/**
 * 版本比较工具
 */
export class VersionUtils {
  /**
   * 解析版本号
   */
  static parse(version: string): {
    major: number;
    minor: number;
    patch: number;
    prerelease?: string;
  } {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-z0-9.-]+))?$/i);
    if (!match) {
      throw new Error(`无效版本号: ${version}`);
    }

    return {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: parseInt(match[3], 10),
      prerelease: match[4]
    };
  }

  /**
   * 比较版本号
   */
  static compare(version1: string, version2: string): number {
    const v1 = this.parse(version1);
    const v2 = this.parse(version2);

    // 比较主版本号
    if (v1.major !== v2.major) {
      return v1.major - v2.major;
    }

    // 比较次版本号
    if (v1.minor !== v2.minor) {
      return v1.minor - v2.minor;
    }

    // 比较修订号
    if (v1.patch !== v2.patch) {
      return v1.patch - v2.patch;
    }

    // 比较预发布版本
    if (v1.prerelease && !v2.prerelease) {
      return -1; // 预发布版本小于正式版本
    }
    if (!v1.prerelease && v2.prerelease) {
      return 1; // 正式版本大于预发布版本
    }
    if (v1.prerelease && v2.prerelease) {
      return v1.prerelease.localeCompare(v2.prerelease);
    }

    return 0; // 版本相同
  }

  /**
   * 检查版本是否满足范围要求
   */
  static satisfies(version: string, range: string): boolean {
    // 简单的版本范围检查
    // 支持 ^1.2.3, ~1.2.3, >=1.2.3, 1.2.3 等格式
    
    if (range.startsWith('^')) {
      // 兼容版本：主版本号相同，次版本号和修订号可以更高
      const baseVersion = range.slice(1);
      const base = this.parse(baseVersion);
      const current = this.parse(version);
      
      return current.major === base.major && 
             this.compare(version, baseVersion) >= 0;
    }
    
    if (range.startsWith('~')) {
      // 近似版本：主版本号和次版本号相同，修订号可以更高
      const baseVersion = range.slice(1);
      const base = this.parse(baseVersion);
      const current = this.parse(version);
      
      return current.major === base.major && 
             current.minor === base.minor && 
             this.compare(version, baseVersion) >= 0;
    }
    
    if (range.startsWith('>=')) {
      // 大于等于版本
      const baseVersion = range.slice(2);
      return this.compare(version, baseVersion) >= 0;
    }
    
    if (range.startsWith('>')) {
      // 大于版本
      const baseVersion = range.slice(1);
      return this.compare(version, baseVersion) > 0;
    }
    
    if (range.startsWith('<=')) {
      // 小于等于版本
      const baseVersion = range.slice(2);
      return this.compare(version, baseVersion) <= 0;
    }
    
    if (range.startsWith('<')) {
      // 小于版本
      const baseVersion = range.slice(1);
      return this.compare(version, baseVersion) < 0;
    }
    
    // 精确版本匹配
    return version === range;
  }

  /**
   * 获取最新版本
   */
  static getLatest(versions: string[]): string {
    if (versions.length === 0) {
      throw new Error('版本列表为空');
    }

    return versions.reduce((latest, current) => {
      return this.compare(current, latest) > 0 ? current : latest;
    });
  }
}

/**
 * 依赖解析工具
 */
export class DependencyResolver {
  /**
   * 解析依赖图
   */
  static resolveDependencyGraph(plugins: PluginManifest[]): {
    resolved: string[];
    circular: string[][];
    missing: string[];
  } {
    const pluginMap = new Map(plugins.map(p => [p.zion.id, p]));
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const resolved: string[] = [];
    const circular: string[][] = [];
    const missing: string[] = [];

    const visit = (pluginId: string, path: string[] = []): void => {
      if (visited.has(pluginId)) {
        return;
      }

      if (visiting.has(pluginId)) {
        // 发现循环依赖
        const cycleStart = path.indexOf(pluginId);
        circular.push(path.slice(cycleStart).concat(pluginId));
        return;
      }

      const plugin = pluginMap.get(pluginId);
      if (!plugin) {
        missing.push(pluginId);
        return;
      }

      visiting.add(pluginId);
      path.push(pluginId);

      // 处理依赖
      const dependencies = plugin.zion.dependencies || {};
      for (const depId of Object.keys(dependencies)) {
        visit(depId, [...path]);
      }

      visiting.delete(pluginId);
      visited.add(pluginId);
      resolved.push(pluginId);
    };

    // 遍历所有插件
    for (const plugin of plugins) {
      if (!visited.has(plugin.zion.id)) {
        visit(plugin.zion.id);
      }
    }

    return { resolved, circular, missing };
  }

  /**
   * 检查依赖冲突
   */
  static checkDependencyConflicts(plugins: PluginManifest[]): {
    conflicts: Array<{
      pluginId: string;
      dependencyId: string;
      requiredVersion: string;
      installedVersion?: string;
      conflict: boolean;
    }>;
    compatible: boolean;
  } {
    const conflicts: Array<{
      pluginId: string;
      dependencyId: string;
      requiredVersion: string;
      installedVersion?: string;
      conflict: boolean;
    }> = [];

    const pluginVersions = new Map(plugins.map(p => [p.zion.id, p.zion.version]));

    for (const plugin of plugins) {
      const dependencies = plugin.zion.dependencies || {};
      
      for (const [depId, requiredVersion] of Object.entries(dependencies)) {
        const installedVersion = pluginVersions.get(depId);
        
        if (installedVersion) {
          const satisfies = VersionUtils.satisfies(installedVersion, requiredVersion);
          
          conflicts.push({
            pluginId: plugin.zion.id,
            dependencyId: depId,
            requiredVersion,
            installedVersion,
            conflict: !satisfies
          });
        } else {
          conflicts.push({
            pluginId: plugin.zion.id,
            dependencyId: depId,
            requiredVersion,
            conflict: true
          });
        }
      }
    }

    const compatible = !conflicts.some(c => c.conflict);

    return { conflicts, compatible };
  }
}

/**
 * 插件验证工具
 */
export class PluginValidator {
  /**
   * 验证插件清单
   */
  static validateManifest(manifest: PluginManifest): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const shared = validatePluginManifest(manifest);
    const errors: string[] = [...shared.errors];
    const warnings: string[] = [...shared.warnings];

    if (shared.normalized.id.length > 50) {
      warnings.push('插件ID过长，建议不超过50个字符');
    }

    // 验证引擎要求
    if (manifest.zion?.engines?.zion) {
      try {
        const required = manifest.zion.engines.zion;
        if (!required.startsWith('>=') && !required.startsWith('^') && !required.startsWith('~')) {
          warnings.push('引擎版本要求格式无效，应使用 ^, ~ 或 >= 前缀');
        }
      } catch {
        errors.push('引擎版本要求解析失败');
      }
    }

    // 验证依赖
    if (manifest.zion?.dependencies) {
      for (const [depId, version] of Object.entries(manifest.zion.dependencies)) {
        if (!depId || typeof depId !== 'string') {
          errors.push(`依赖ID无效: ${depId}`);
        }
        if (!version || typeof version !== 'string') {
          errors.push(`依赖版本无效: ${version}`);
        }
      }
    }

    // 验证贡献点
    if (manifest.zion?.contributes) {
      const contributes = manifest.zion.contributes;
      
      // 验证命令
      if (contributes.commands) {
        for (const command of contributes.commands) {
          if (!command.id) {
            errors.push('命令缺少必需字段: id');
          }
          if (!command.title) {
            errors.push('命令缺少必需字段: title');
          }
        }
      }

      // 验证快捷键
      if (contributes.keybindings) {
        for (const keybinding of contributes.keybindings) {
          if (!keybinding.command) {
            errors.push('快捷键缺少必需字段: command');
          }
          if (!keybinding.key) {
            errors.push('快捷键缺少必需字段: key');
          }
        }
      }

      if (contributes.skills) {
        if (!Array.isArray(contributes.skills)) {
          errors.push('Skills contribution must be an array');
        } else {
          for (const skillPath of contributes.skills) {
            const value = typeof skillPath === 'string' ? skillPath.trim() : '';
            if (!value) {
              errors.push('Skill contribution must be a non-empty relative path');
            } else if (value.startsWith('/') || value.includes('..')) {
              errors.push(`Skill contribution path must stay inside the plugin: ${value}`);
            }
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * 验证插件包结构
   */
  static validatePackageStructure(files: string[]): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 检查必需文件
    const hasManifest = files.some(f => f === 'manifest.json' || f === 'extension.json');
    if (!hasManifest) {
      errors.push('缺少清单文件: manifest.json 或 extension.json');
    }

    // 检查入口文件
    const hasMain = files.some(f => f.includes('main.js') || f.includes('main.ts'));
    if (!hasMain) {
      warnings.push('未找到入口文件: main.js 或 main.ts');
    }

    // 检查文档
    const hasReadme = files.some(f => f.toLowerCase() === 'readme.md');
    if (!hasReadme) {
      warnings.push('缺少文档文件: README.md');
    }

    // 检查许可证
    const hasLicense = files.some(f => f.toLowerCase().startsWith('license'));
    if (!hasLicense) {
      warnings.push('缺少许可证文件: LICENSE');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
}

/**
 * 插件打包工具
 */
export class PluginPackager {
  /**
   * 创建插件包
   */
  static async createPackage(pluginPath: string, outputPath: string): Promise<void> {
    // 这里需要实现实际的打包逻辑
    // 由于是在浏览器环境中，我们需要使用不同的方法
    
    console.log(`创建插件包: ${pluginPath} -> ${outputPath}`);
    
    // TODO: 实现实际的打包逻辑
  }

  /**
   * 解压插件包
   */
  static async extractPackage(packagePath: string, outputPath: string): Promise<void> {
    // 这里需要实现实际的解压逻辑
    // 由于是在浏览器环境中，我们需要使用不同的方法
    
    console.log(`解压插件包: ${packagePath} -> ${outputPath}`);
    
    // TODO: 实现实际的解压逻辑
  }
}

/**
 * 插件工具函数
 */
export const PluginUtils = {
  /**
   * 生成插件ID
   */
  generatePluginId(name: string, author: string): string {
    const cleanName = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const cleanAuthor = author.toLowerCase().replace(/[^a-z0-9]/g, '-');
    return `${cleanAuthor}.${cleanName}`;
  },

  /**
   * 格式化插件大小
   */
  formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  },

  /**
   * 格式化日期
   */
  formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
      return `${days}天前`;
    } else if (hours > 0) {
      return `${hours}小时前`;
    } else if (minutes > 0) {
      return `${minutes}分钟前`;
    } else {
      return `${seconds}秒前`;
    }
  },

  /**
   * 验证插件ID格式
   */
  validatePluginId(id: string): boolean {
    return /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(id) && id.length <= 50;
  },

  /**
   * 验证版本号格式
   */
  validateVersion(version: string): boolean {
    return /^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/i.test(version);
  }
};
