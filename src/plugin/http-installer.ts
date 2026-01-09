/**
 * HTTP插件安装器
 * 支持从HTTP服务安装插件
 */

import JSZip from 'jszip';
import type {
  PluginInfo,
  PluginInstallResult,
  PluginError,
  PluginInstallOptions,
  PluginManifest
} from './types';
import { VersionUtils } from './utils';

/**
 * HTTP插件安装器选项
 */
export interface HttpPluginInstallerOptions {
  /** 插件服务基础URL */
  baseUrl: string;
  /** 请求超时时间（毫秒） */
  timeout?: number;
  /** 是否启用缓存 */
  cache?: boolean;
}

/**
 * HTTP插件安装器
 */
export class HttpPluginInstaller {
  private options: Required<HttpPluginInstallerOptions>;
  private cache = new Map<string, PluginInfo>();

  constructor(options: HttpPluginInstallerOptions) {
    this.options = {
      baseUrl: options.baseUrl,
      timeout: options.timeout || 30000,
      cache: options.cache ?? true
    };
  }

  /**
   * 从HTTP服务安装插件
   */
  async installFromUrl(
    pluginUrl: string,
    options: Partial<PluginInstallOptions> = {}
  ): Promise<PluginInstallResult> {
    try {
      console.log(`[HttpPluginInstaller] 从URL安装插件: ${pluginUrl}`);

      // 下载插件包
      const pluginData = await this.downloadPlugin(pluginUrl);
      
      // 解压并处理插件数据
      const pluginInfo = await this.processPluginData(pluginData, pluginUrl);
      
      // 验证插件
      const validation = await this.validatePlugin(pluginInfo);
      if (!validation.valid) {
        return {
          success: false,
          error: {
            type: 'validation_failed',
            message: `插件验证失败: ${validation.errors.join(', ')}`,
            timestamp: Date.now()
          },
          warnings: validation.warnings
        };
      }

      // 检查缓存：如版本一致则复用缓存；如版本变化则更新缓存并返回新版本
      if (this.options.cache && this.cache.has(pluginInfo.id)) {
        const cached = this.cache.get(pluginInfo.id)!;
        if (cached.version === pluginInfo.version) {
          console.log(`[HttpPluginInstaller] 使用缓存插件: ${pluginInfo.id}@${cached.version}`);
          return {
            success: true,
            plugin: cached,
            warnings: validation.warnings
          };
        }
        // 版本不一致：更新缓存并返回新版本
        console.log(`[HttpPluginInstaller] 检测到新版本，更新缓存: ${pluginInfo.id} ${cached.version} -> ${pluginInfo.version}`);
        this.cache.set(pluginInfo.id, pluginInfo);
        return {
          success: true,
          plugin: pluginInfo,
          warnings: validation.warnings
        };
      }

      // 保存到缓存
      if (this.options.cache) {
        this.cache.set(pluginInfo.id, pluginInfo);
      }

      console.log(`[HttpPluginInstaller] 插件安装成功: ${pluginInfo.id}@${pluginInfo.version}`);
      return {
        success: true,
        plugin: pluginInfo,
        warnings: validation.warnings
      };

    } catch (error) {
      console.error(`[HttpPluginInstaller] 插件安装失败: ${pluginUrl}`, error);
      
      const pluginError: PluginError = {
        type: 'load_failed',
        message: error instanceof Error ? error.message : '未知错误',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: Date.now()
      };

      return {
        success: false,
        error: pluginError,
        warnings: []
      };
    }
  }

  /**
   * 从插件服务安装插件
   */
  async installFromService(
    pluginId: string,
    options: Partial<PluginInstallOptions> = {}
  ): Promise<PluginInstallResult> {
    try {
      console.log(`[HttpPluginInstaller] 从服务安装插件: ${pluginId}`);

      // 构建插件下载URL
      const downloadUrl = `${this.options.baseUrl}/plugins/${pluginId}/download`;
      
      // 使用URL安装
      return await this.installFromUrl(downloadUrl, options);

    } catch (error) {
      console.error(`[HttpPluginInstaller] 从服务安装插件失败: ${pluginId}`, error);
      
      const pluginError: PluginError = {
        type: 'load_failed',
        message: error instanceof Error ? error.message : '未知错误',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: Date.now()
      };

      return {
        success: false,
        error: pluginError,
        warnings: []
      };
    }
  }

  /**
   * 开发模式：直接从本地开发目录拉取 manifest.json 并构建 PluginInfo（无需ZIP）
   * baseUrl 形如 http://127.0.0.1:8765/plugins/dev/{devId}
   */
  async installFromDevBase(
    baseUrl: string,
    devId: string
  ): Promise<PluginInstallResult> {
    try {
      const manifestUrl = `${baseUrl}/manifest.json`;
      console.log(`[HttpPluginInstaller] 开发模式安装: ${manifestUrl}`);

      const res = await fetch(manifestUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'X-Zion-Dev-Id': devId,
          'X-Zion-Dev-Mode': 'true'
        },
        signal: AbortSignal.timeout(this.options.timeout)
      });
      if (!res.ok) {
        throw new Error(`读取开发清单失败: ${res.status} ${res.statusText}`);
      }
      const manifest = await res.json() as PluginManifest;

      // 解析主入口（绝对URL）
      let mainPath = manifest?.zion?.main || (manifest as any)?.main || 'dist/main.js';
      if (!/^(blob:|data:|https?:)/i.test(mainPath)) {
        mainPath = `${baseUrl}/${String(mainPath).replace(/^\.\//, '')}`;
      }

      // 构建 PluginInfo
      const pluginInfo: PluginInfo = {
        id: manifest?.zion?.id || (manifest as any)?.id || manifest?.name || 'unknown.plugin',
        name: manifest?.zion?.name || manifest?.name || 'Unnamed Plugin',
        version: manifest?.zion?.version || manifest?.version || '0.0.1',
        description: manifest?.description,
        author: manifest?.author,
        license: manifest?.license,
        path: baseUrl,
        manifest: {
          ...manifest,
          zion: {
            ...(manifest?.zion || {}),
            main: mainPath
          }
        },
        state: 'installed',
        dependencies: manifest?.zion?.dependencies ? Object.keys(manifest.zion.dependencies) : [],
        peerDependencies: manifest?.zion?.peerDependencies ? Object.keys(manifest.zion.peerDependencies) : [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isLegacy: !manifest?.zion
      };

      // 验证
      const validation = await this.validatePlugin(pluginInfo);
      if (!validation.valid) {
        return {
          success: false,
          error: {
            type: 'validation_failed',
            message: `开发清单验证失败: ${validation.errors.join(', ')}`,
            timestamp: Date.now()
          },
          warnings: validation.warnings
        };
      }

      // 缓存处理（按 id）
      if (this.options.cache) {
        const cached = this.cache.get(pluginInfo.id);
        if (cached && cached.version === pluginInfo.version) {
          this.cache.set(pluginInfo.id, { ...cached, manifest: pluginInfo.manifest, updatedAt: Date.now() });
          return { success: true, plugin: this.cache.get(pluginInfo.id)!, warnings: validation.warnings };
        }
        this.cache.set(pluginInfo.id, pluginInfo);
      }

      return { success: true, plugin: pluginInfo, warnings: validation.warnings };
    } catch (error) {
      console.error(`[HttpPluginInstaller] 开发模式安装失败: ${baseUrl}`, error);
      return {
        success: false,
        error: {
          type: 'load_failed',
          message: error instanceof Error ? error.message : '未知错误',
          stack: error instanceof Error ? error.stack : undefined,
          timestamp: Date.now()
        },
        warnings: []
      };
    }
  }

  /**
   * 搜索插件
   */
  async searchPlugins(query: string, limit: number = 50): Promise<{
    success: boolean;
    data: Array<{
      id: string;
      name: string;
      version: string;
      description?: string;
      author?: string;
      downloads: number;
      size: number;
    }>;
    error?: PluginError;
  }> {
    try {
      console.log(`[HttpPluginInstaller] 搜索插件: ${query}`);

      const searchUrl = `${this.options.baseUrl}/plugins/search?query=${encodeURIComponent(query)}&limit=${limit}`;
      
      const response = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(this.options.timeout)
      });

      if (!response.ok) {
        throw new Error(`搜索失败: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      
      if (!result.success) {
        throw new Error(result.message || '搜索失败');
      }

      // 转换数据格式
      const plugins = result.data.map((plugin: any) => ({
        id: plugin.id,
        name: plugin.metadata?.name || plugin.id,
        version: plugin.metadata?.version || '1.0.0',
        description: plugin.metadata?.description,
        author: plugin.metadata?.author,
        downloads: plugin.download_count || 0,
        size: plugin.file_size || 0
      }));

      return {
        success: true,
        data: plugins
      };

    } catch (error) {
      console.error(`[HttpPluginInstaller] 搜索插件失败: ${query}`, error);
      
      const pluginError: PluginError = {
        type: 'runtime_error',
        message: error instanceof Error ? error.message : '未知错误',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: Date.now()
      };

      return {
        success: false,
        data: [],
        error: pluginError
      };
    }
  }

  /**
   * 获取插件列表
   */
  async listPlugins(limit: number = 100, offset: number = 0): Promise<{
    success: boolean;
    data: Array<{
      id: string;
      name: string;
      version: string;
      description?: string;
      author?: string;
      downloads: number;
      size: number;
    }>;
    total: number;
    error?: PluginError;
  }> {
    try {
      console.log(`[HttpPluginInstaller] 获取插件列表`);

      const listUrl = `${this.options.baseUrl}/plugins?limit=${limit}&offset=${offset}`;
      
      const response = await fetch(listUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(this.options.timeout)
      });

      if (!response.ok) {
        throw new Error(`获取列表失败: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      
      if (!result.success) {
        throw new Error(result.message || '获取列表失败');
      }

      // 转换数据格式
      const plugins = result.data.map((plugin: any) => ({
        id: plugin.id,
        name: plugin.metadata?.name || plugin.id,
        version: plugin.metadata?.version || '1.0.0',
        description: plugin.metadata?.description,
        author: plugin.metadata?.author,
        downloads: plugin.download_count || 0,
        size: plugin.file_size || 0
      }));

      return {
        success: true,
        data: plugins,
        total: result.total || plugins.length
      };

    } catch (error) {
      console.error(`[HttpPluginInstaller] 获取插件列表失败`, error);
      
      const pluginError: PluginError = {
        type: 'runtime_error',
        message: error instanceof Error ? error.message : '未知错误',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: Date.now()
      };

      return {
        success: false,
        data: [],
        total: 0,
        error: pluginError
      };
    }
  }

  /**
   * 获取插件统计信息
   */
  async getStats(): Promise<{
    success: boolean;
    data?: {
      total_plugins: number;
      total_downloads: number;
      total_size_mb: number;
      type_stats: Record<string, number>;
    };
    error?: PluginError;
  }> {
    try {
      console.log(`[HttpPluginInstaller] 获取插件统计`);

      const statsUrl = `${this.options.baseUrl}/plugins/stats`;
      
      const response = await fetch(statsUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(this.options.timeout)
      });

      if (!response.ok) {
        throw new Error(`获取统计失败: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      
      if (!result.success) {
        throw new Error(result.message || '获取统计失败');
      }

      return {
        success: true,
        data: result.data
      };

    } catch (error) {
      console.error(`[HttpPluginInstaller] 获取插件统计失败`, error);
      
      const pluginError: PluginError = {
        type: 'runtime_error',
        message: error instanceof Error ? error.message : '未知错误',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: Date.now()
      };

      return {
        success: false,
        error: pluginError
      };
    }
  }

  /**
   * 下载插件
   */
  private async downloadPlugin(url: string): Promise<ArrayBuffer> {
    console.log(`[HttpPluginInstaller] 下载插件: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/octet-stream'
      },
      signal: AbortSignal.timeout(this.options.timeout)
    });

    if (!response.ok) {
      throw new Error(`下载失败: ${response.status} ${response.statusText}`);
    }

    const contentLength = response.headers.get('content-length');
    console.log(`[HttpPluginInstaller] 插件大小: ${contentLength || '未知'} bytes`);

    return await response.arrayBuffer();
  }

  /**
   * 处理插件数据（ZIP解压，读取 manifest，生成主入口 Blob URL）
   */
  private async processPluginData(data: ArrayBuffer, sourceUrl: string): Promise<PluginInfo> {
    console.log(`[HttpPluginInstaller] 处理插件数据: ${sourceUrl}`);

    const zip = await JSZip.loadAsync(data);

    // 尝试读取 manifest.json 或 package.json
    const manifestEntry = zip.file('manifest.json');
    const packageEntry = zip.file('package.json');

    let manifest: any | null = null;

    if (manifestEntry) {
      const txt = await manifestEntry.async('string');
      manifest = JSON.parse(txt);
    } else if (packageEntry) {
      const txt = await packageEntry.async('string');
      const pkg = JSON.parse(txt);
      if (!pkg.zion) {
        throw new Error('package.json 缺少 zion 字段');
      }
      manifest = {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        author: pkg.author,
        license: pkg.license,
        zion: pkg.zion
      };
    } else {
      throw new Error('插件包缺少 manifest.json 或 package.json');
    }

    // 解析主入口
    const mainRel: string = manifest?.zion?.main || manifest?.main || 'dist/main.js';
    const normMainRel = String(mainRel).replace(/^\.\//, '');

    const mainEntry =
      zip.file(normMainRel) ||
      // 兼容常见目录
      zip.file(`dist/main.js`) ||
      zip.file(`main.js`);

    if (!mainEntry) {
      throw new Error(`未找到主入口文件: ${normMainRel}`);
    }

    // 生成 Data URL（持久化，刷新仍可用）
    const mainCode = await mainEntry.async('string');
    const base64 = btoa(unescape(encodeURIComponent(mainCode)));
    const mainUrl = `data:text/javascript;base64,${base64}`;

    // 组装 PluginInfo（使用绝对 mainUrl，loader 将直接动态导入）
    const pluginInfo: PluginInfo = {
      id: manifest?.zion?.id || manifest?.name || 'unknown.plugin',
      name: manifest?.zion?.name || manifest?.name || 'Unnamed Plugin',
      version: manifest?.zion?.version || manifest?.version || '1.0.0',
      description: manifest?.description,
      author: manifest?.author,
      license: manifest?.license,
      path: sourceUrl, // 保留源，可用于追踪
      manifest: {
        ...manifest,
        zion: {
          ...manifest.zion,
          main: mainUrl
        }
      },
      state: 'installed',
      dependencies: manifest?.zion?.dependencies ? Object.keys(manifest.zion.dependencies) : [],
      peerDependencies: manifest?.zion?.peerDependencies ? Object.keys(manifest.zion.peerDependencies) : [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isLegacy: !manifest?.zion
    };

    return pluginInfo;
  }

  /**
   * 验证插件
   */
  private async validatePlugin(pluginInfo: PluginInfo): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 基本验证
    if (!pluginInfo.id) {
      errors.push('插件ID不能为空');
    }

    if (!pluginInfo.name) {
      errors.push('插件名称不能为空');
    }

    if (!pluginInfo.version) {
      errors.push('插件版本不能为空');
    }

    // 清单验证
    if (!pluginInfo.manifest) {
      errors.push('插件清单不能为空');
    }

    // 主入口（Blob URL）验证
    try {
      const main =
        (pluginInfo.manifest as any)?.zion?.main ||
        (pluginInfo.manifest as any)?.main;
      if (typeof main !== 'string') {
        errors.push('主入口无效');
      } else if (!/^(blob:|data:|https?:)/i.test(main)) {
        warnings.push('主入口不是绝对URL，可能无法在浏览器环境加载');
      }
    } catch {}

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cache.clear();
    console.log(`[HttpPluginInstaller] 缓存已清除`);
  }

  /**
   * 从缓存中移除插件
   */
  removeFromCache(pluginId: string): void {
    this.cache.delete(pluginId);
    console.log(`[HttpPluginInstaller] 插件已从缓存移除: ${pluginId}`);
  }



  /**
   * 直接从本地文件安装（拖拽 ZIP 到前端面板）
   */
  async installFromFile(file: File, options: Partial<PluginInstallOptions> = {}): Promise<PluginInstallResult> {
    try {
      if (!file || !file.name.toLowerCase().endsWith(".zip")) {
        return {
          success: false,
          error: {
            type: 'validation_failed',
            message: '仅支持 .zip 插件包文件',
            timestamp: Date.now()
          },
          warnings: []
        };
      }
      console.log(`[HttpPluginInstaller] 从本地文件安装插件: ${file.name}`);
      const buf = await file.arrayBuffer();
      const sourceUrl = `file://${encodeURIComponent(file.name)}`;

      const pluginInfo = await this.processPluginData(buf, sourceUrl);
      const validation = await this.validatePlugin(pluginInfo);
      if (!validation.valid) {
        return {
          success: false,
          error: {
            type: 'validation_failed',
            message: `插件验证失败: ${validation.errors.join(', ')}`,
            timestamp: Date.now()
          },
          warnings: validation.warnings
        };
      }

      if (this.options.cache) {
        this.cache.set(pluginInfo.id, pluginInfo);
      }

      return {
        success: true,
        plugin: pluginInfo,
        warnings: validation.warnings
      };
    } catch (error) {
      console.error(`[HttpPluginInstaller] 本地文件安装失败: ${file?.name}`, error);
      return {
        success: false,
        error: {
          type: 'load_failed',
          message: error instanceof Error ? error.message : '未知错误',
          stack: error instanceof Error ? error.stack : undefined,
          timestamp: Date.now()
        },
        warnings: []
      };
    }
  }

  /**
   * 更新基础服务地址
   */
  setBaseUrl(baseUrl: string): void {
    if (typeof baseUrl === 'string' && baseUrl.trim()) {
      this.options.baseUrl = baseUrl.trim();
      console.log(`[HttpPluginInstaller] 基础URL已更新为: ${this.options.baseUrl}`);
    }
  }
}