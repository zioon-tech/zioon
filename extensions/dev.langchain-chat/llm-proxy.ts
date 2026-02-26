/**
 * LLM 代理工具
 * 智能降级：优先使用 zion-local-tools 后端代理，失败时自动降级为直接请求
 * 解决 CORS 问题，支持流式/非流式请求
 */

// 大模型提供商配置
const LLM_PROVIDERS: Record<string, { name: string; baseURL: string }> = {
  dashscope: {
    name: '阿里百炼',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  },
  volcengine: {
    name: '火山方舟',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3'
  },
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1'
  },
  deepseek: {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com'
  },
  siliconflow: {
    name: 'SiliconFlow',
    baseURL: 'https://api.siliconflow.cn/v1'
  },
  zhipu: {
    name: '智谱AI',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4'
  }
};

// 后端健康检查缓存
let backendHealthCache: {
  available: boolean;
  checkedAt: number;
  backendUrl: string;
} | null = null;

const HEALTH_CHECK_CACHE_TTL = 5000; // 缓存 5 秒
const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8765';

function getBackendUrl(): string {
  try {
    const v = (window as any)?.zion?.state?.get?.("localTools.baseUrl");
    if (typeof v === "string" && v.trim()) return v.trim();
  } catch {}
  return DEFAULT_BACKEND_URL;
}

/**
 * 检查后端是否可用
 */
async function checkBackendAvailable(): Promise<boolean> {
  const now = Date.now();
  const backendUrl = getBackendUrl();
  
  // 使用缓存（避免频繁检查）
  if (
    backendHealthCache &&
    backendHealthCache.backendUrl === backendUrl &&
    (now - backendHealthCache.checkedAt < HEALTH_CHECK_CACHE_TTL)
  ) {
    return backendHealthCache.available;
  }
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500); // 1.5 秒超时
    
    const response = await fetch(`${backendUrl}/health`, {
      method: 'GET',
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    const available = response.ok;
    backendHealthCache = { available, checkedAt: now, backendUrl };
    
    if (available) {
      console.log('[LLM-Proxy] ✅ 后端服务可用');
    } else {
      console.warn('[LLM-Proxy] ⚠️ 后端服务响应异常');
    }
    
    return available;
  } catch (error) {
    backendHealthCache = { available: false, checkedAt: now, backendUrl };
    console.warn('[LLM-Proxy] ❌ 后端服务不可用', error);
    return false;
  }
}

/**
 * 解析 URL 获取 provider
 */
export function detectProviderFromURL(url: string): string | null {
  for (const [providerId, config] of Object.entries(LLM_PROVIDERS)) {
    if (url.includes(config.baseURL) || url.includes(providerId)) {
      return providerId;
    }
  }
  return null;
}

/**
 * 构建代理 URL
 */
function buildProxyURL(provider: string, originalURL: string): string {
  const backendUrl = getBackendUrl();
  return `${backendUrl}/llm/proxy/any/${encodeURIComponent(String(originalURL || ""))}`;
}

/**
 * LLM 代理请求配置
 */
export interface LLMProxyRequestConfig {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  signal?: AbortSignal;
}

/**
 * 发送 LLM 请求（智能降级）
 */
export async function proxyLLMRequest(config: LLMProxyRequestConfig): Promise<Response> {
  const useProxy = await checkBackendAvailable();
  
  if (useProxy) {
    console.log(`[LLM-Proxy] 🚀 使用代理转发: any`);
    return proxyRequest(config);
  } else {
    const provider = detectProviderFromURL(config.url);
    console.log(`[LLM-Proxy] 🔗 直接请求: ${provider || "unknown"}`);
    return directRequest(config);
  }
}

/**
 * 通过代理发送请求
 */
async function proxyRequest(config: LLMProxyRequestConfig): Promise<Response> {
  const proxyURL = buildProxyURL("any", config.url);
  
  const body = typeof config.body === 'string' ? config.body : JSON.stringify(config.body);
  
  return fetch(proxyURL, {
    method: config.method,
    headers: config.headers,
    body,
    signal: config.signal
  });
}

/**
 * 直接发送请求（可能 CORS）
 */
async function directRequest(config: LLMProxyRequestConfig): Promise<Response> {
  const body = typeof config.body === 'string' ? config.body : JSON.stringify(config.body);
  
  return fetch(config.url, {
    method: config.method,
    headers: config.headers,
    body,
    signal: config.signal
  });
}

/**
 * 强制使用代理（用于测试）
 */
export async function forceProxyRequest(config: LLMProxyRequestConfig): Promise<Response> {
  return proxyRequest(config);
}

/**
 * 强制直接请求（用于测试）
 */
export async function forceDirectRequest(config: LLMProxyRequestConfig): Promise<Response> {
  return directRequest(config);
}

/**
 * 清除健康检查缓存（用于测试）
 */
export function clearHealthCache(): void {
  backendHealthCache = null;
}

// 导出类型
