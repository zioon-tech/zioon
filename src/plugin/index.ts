/**
 * 插件系统入口
 * 导出插件系统的核心功能
 */

export { PluginManager } from './manager';
export { PluginLoader } from './loader';
export * from './types';

// 插件系统版本
export const PLUGIN_SYSTEM_VERSION = '1.0.0';

// 插件系统兼容性版本
export const PLUGIN_SYSTEM_COMPAT_VERSION = '0.1.0';