/**
 * dev.context-compression - Multi-strategy context compression plugin for Zion Next
 * 
 * Implements compression strategies from:
 * - OpenCode: Compaction + Pruning
 * - Claude Code: Simple summarization
 * - Cursor: Dynamic context discovery
 * - Manus: KV-Cache optimization
 * - Focus Agent: Active compression
 */

import { CompressionEngine } from './compression-core.js';
import { OpenCodeStrategy } from './strategies/opencode.js';
import { ClaudeCodeStrategy } from './strategies/claude-code.js';
import { CursorStrategy } from './strategies/cursor.js';
import { ManusStrategy } from './strategies/manus.js';
import { FocusAgentStrategy } from './strategies/focus-agent.js';
import { TokenCounter } from './token-counter.js';
import { KVCacheOptimizer } from './kv-cache-optimizer.js';
import { CompressionSettingsPanel } from './ui/settings-panel.js';
import { CompressionStatus } from './ui/compression-status.js';

export async function activate(ctx) {
  console.log('dev.context-compression plugin activated');
  const log = (...args) => console.log('[context-compression]', ...args);
  const warn = (...args) => console.warn('[context-compression]', ...args);
  
  // 初始化压缩引擎
  const compressionEngine = new CompressionEngine();
  
  // 注册所有压缩策略
  compressionEngine.registerStrategy('opencode', new OpenCodeStrategy());
  compressionEngine.registerStrategy('claude-code', new ClaudeCodeStrategy());
  compressionEngine.registerStrategy('cursor', new CursorStrategy());
  compressionEngine.registerStrategy('manus', new ManusStrategy());
  compressionEngine.registerStrategy('focus-agent', new FocusAgentStrategy());
  
  // 初始化 Token 计数器
  const tokenCounter = new TokenCounter();
  
  // 初始化 KV-Cache 优化器
  const kvCacheOptimizer = new KVCacheOptimizer();
  
  // 注册命令
  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.manual', async () => {
      await compressEditorConversation(compressionEngine, 'auto');
    })
  );
  
  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.strategy.opencode', async () => {
      await compressEditorConversation(compressionEngine, 'opencode');
    })
  );
  
  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.strategy.claude-code', async () => {
      await compressEditorConversation(compressionEngine, 'claude-code');
    })
  );
  
  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.strategy.cursor', async () => {
      await compressEditorConversation(compressionEngine, 'cursor');
    })
  );
  
  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.strategy.manus', async () => {
      await compressEditorConversation(compressionEngine, 'manus');
    })
  );
  
  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.strategy.focus-agent', async () => {
      await compressEditorConversation(compressionEngine, 'focus-agent');
    })
  );
  
  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.settings', () => {
      showSettingsPanel();
    })
  );
  
  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.stats', () => {
      showCompressionStats();
    })
  );

  if (window.zion.slash?.registerCommand) {
    ctx.subscriptions.push(
      window.zion.slash.registerCommand({
        id: 'compression.slash.compress',
        trigger: ['compress', 'compact'],
        title: 'Compress',
        description: 'Compress current editor conversation',
        category: 'compression',
        execute: () => window.zion.commands.executeCommand('compression.manual')
      }),
      window.zion.slash.registerCommand({
        id: 'compression.slash.settings',
        trigger: ['compressSettings', 'compressionSettings'],
        title: 'Compression Settings',
        description: 'Open compression settings',
        category: 'compression',
        execute: () => window.zion.commands.executeCommand('compression.settings')
      }),
      window.zion.slash.registerCommand({
        id: 'compression.slash.stats',
        trigger: ['compressStats', 'compressionStats'],
        title: 'Compression Stats',
        description: 'Show compression statistics',
        category: 'compression',
        execute: () => window.zion.commands.executeCommand('compression.stats')
      })
    );
  }
  
  ensureDefaultSettings();

  try {
    const initialSettings = await getCompressionSettings();
    syncEngineFromSettings(compressionEngine, initialSettings);
  } catch {}

  log('settings', window.zion?.state?.get?.('compression.settings'));

  const dispContributor = window.zion.messages.registerContributor({
    id: 'dev.context-compression',
    order: 90,
    stage: 'post',
    contribute: async (messages) => {
      const settings = await getCompressionSettings();
      const debug = !!settings?.debugLogging;
      const safeLen = Array.isArray(messages) ? messages.length : 0;
      const now = Date.now();

      let estTokens = 0;
      try { estTokens = Math.floor(JSON.stringify(messages).length / 4); } catch {}

      if (debug) {
        log('post contribute: start', {
          at: now,
          messages: safeLen,
          estTokens,
          autoCompression: !!settings?.autoCompression,
          threshold: settings?.threshold,
          defaultStrategy: settings?.defaultStrategy
        });
      }

      if (!settings.autoCompression) {
        if (debug) log('post contribute: skip (autoCompression=false)');
        return messages;
      }

      syncEngineFromSettings(compressionEngine, settings);
      const context = compressionEngine.createCompressionContext(messages);

      let skipReason = null;
      if ((context?.messages?.length || 0) < 5) skipReason = 'too_few_messages';
      else if ((context?.messages?.length || 0) > 50) skipReason = null;
      else {
        const limit = Number(compressionEngine?.config?.maxTokens || 0);
        const thr = Number(compressionEngine?.config?.threshold || 0);
        if (limit > 0 && thr > 0 && Number(context?.tokens || 0) <= limit * thr) {
          skipReason = 'below_threshold';
        }
      }

      const shouldCompress = await compressionEngine.shouldAutoCompress(context);
      if (!shouldCompress) {
        if (debug) {
          log('post contribute: skip', {
            reason: skipReason || 'engine_decision',
            messages: safeLen,
            estTokens: context?.tokens,
            maxTokens: compressionEngine?.config?.maxTokens,
            threshold: compressionEngine?.config?.threshold
          });
        }
        return messages;
      }

      const strategy = settings.defaultStrategy || 'auto';
      const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      let compressed = null;
      try {
        compressed = await compressionEngine.compress(messages, strategy);
      } catch (e) {
        warn('post contribute: compression failed', { strategy, error: e?.message || String(e) });
        return messages;
      }

      try {
        compressed = sanitizeChatMessages(compressed, messages);
      } catch (e) {
        warn('post contribute: sanitize failed', { error: e?.message || String(e) });
        return messages;
      }
      const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

      let compressedTokens = 0;
      try { compressedTokens = Math.floor(JSON.stringify(compressed).length / 4); } catch {}
      recordCompressionEvent({
        strategy,
        originalTokens: context.tokens,
        compressedTokens,
        timestamp: Date.now()
      });

      if (debug) {
        log('post contribute: compressed', {
          strategy,
          beforeMessages: safeLen,
          afterMessages: Array.isArray(compressed) ? compressed.length : 0,
          beforeTokens: context?.tokens,
          afterTokens: compressedTokens,
          savedTokens: Number(context?.tokens || 0) - Number(compressedTokens || 0),
          ms: Math.round((t1 - t0) * 100) / 100
        });
      }

      return compressed;
    }
  });
  ctx.subscriptions.push(dispContributor);
  log('registered message contributor', { id: 'dev.context-compression', stage: 'post', order: 90 });

  let statusDisp = null;
  const updateStatus = () => {
    const stats = window.zion.state.get('compression.stats') || {};
    const saved = stats.totalTokensSaved || 0;
    try { statusDisp?.dispose?.(); } catch {}
    statusDisp = window.zion.statusBar.registerItem({
      id: 'compression.status',
      text: `📦 ${formatTokens(saved)}`,
      tooltip: `Tokens saved: ${saved}`,
      onClick: () => window.zion.commands.executeCommand('compression.stats')
    });
  };
  updateStatus();
  ctx.subscriptions.push({ dispose: () => { try { statusDisp?.dispose?.(); } catch {} } });
  ctx.subscriptions.push(window.zion.state.onDidChange('compression.stats', updateStatus));
  
  return {
    deactivate: () => {
      console.log('dev.context-compression plugin deactivated');
    },
    
    // 导出 API 供其他插件使用
    api: {
      compressionEngine,
      getAvailableStrategies: () => compressionEngine.getStrategies(),
      compress: (messages, strategy = 'auto') => 
        compressionEngine.compress(messages, strategy),
      estimateSavings: (messages, strategy = 'auto') =>
        compressionEngine.estimateSavings(messages, strategy),
      tokenCounter,
      kvCacheOptimizer
    }
  };
}

async function getCompressionSettings() {
  const v = window.zion.state.get('compression.settings');
  if (v) return v;
  const panel = new CompressionSettingsPanel();
  return panel.getDefaultSettings();
}

async function writeToFile(content) {
  // Implementation for writing content to temporary file
  const fileName = `compression-output-${Date.now()}.txt`;
  // Use Zion's file system API if available
  return `/tmp/${fileName}`;
}

function showSettingsPanel() {
  openSettingsOverlay();
}

function showCompressionStats() {
  openStatsOverlay();
}

function formatTokens(tokens) {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  } else if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return tokens.toString();
}

function recordCompressionEvent(event) {
  const stats = window.zion.state.get('compression.stats') || {
    totalTokensSaved: 0,
    compressionCount: 0,
    strategyUsage: {},
    tokenSavingsByStrategy: {}
  };
  
  const savings = event.originalTokens - event.compressedTokens;
  
  stats.totalTokensSaved += savings;
  stats.compressionCount += 1;
  stats.strategyUsage[event.strategy] = (stats.strategyUsage[event.strategy] || 0) + 1;
  stats.tokenSavingsByStrategy[event.strategy] = (stats.tokenSavingsByStrategy[event.strategy] || 0) + savings;
  stats.lastCompressionTime = event.timestamp;
  
  window.zion.state.set('compression.stats', stats);
}

function ensureDefaultSettings() {
  const existing = window.zion.state.get('compression.settings');
  if (existing) return;
  const panel = new CompressionSettingsPanel();
  window.zion.state.set('compression.settings', panel.getDefaultSettings());
}

async function compressEditorConversation(compressionEngine, strategyName) {
  const editor = window.zion.window.activeEditor;
  if (!editor) return;
  const docText = editor.getValue();
  const messages = parseMessages(docText);
  if (!messages.length) return;
  const settings = await getCompressionSettings();
  syncEngineFromSettings(compressionEngine, settings);
  const debug = !!settings?.debugLogging;
  const originalTokens = Math.floor(JSON.stringify(messages).length / 4);
  if (debug) {
    console.log('[context-compression]', 'manual compress: start', {
      strategy: strategyName,
      messages: messages.length,
      estTokens: originalTokens
    });
  }
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const compressed = await compressionEngine.compress(messages, strategyName);
  const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const compressedTokens = Math.floor(JSON.stringify(compressed).length / 4);
  const outText = serializeMessages(compressed);
  editor.setValue(outText);
  recordCompressionEvent({ strategy: strategyName, originalTokens, compressedTokens, timestamp: Date.now() });
  if (debug) {
    console.log('[context-compression]', 'manual compress: done', {
      strategy: strategyName,
      beforeMessages: messages.length,
      afterMessages: Array.isArray(compressed) ? compressed.length : 0,
      beforeTokens: originalTokens,
      afterTokens: compressedTokens,
      savedTokens: originalTokens - compressedTokens,
      ms: Math.round((t1 - t0) * 100) / 100
    });
  }
}

function syncEngineFromSettings(compressionEngine, settings) {
  if (!compressionEngine || !settings) return;
  const maxTokens = Number(settings.contextLimitTokens);
  const outputTokens = Number(settings.outputTokens);
  const charsPerToken = Number(settings.charsPerToken);
  compressionEngine.updateConfig({
    autoCompression: settings.autoCompression !== false,
    threshold: typeof settings.threshold === 'number' ? settings.threshold : Number(settings.threshold),
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : compressionEngine.config.maxTokens,
    outputTokens: Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : compressionEngine.config.outputTokens,
    charsPerToken: Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : compressionEngine.config.charsPerToken
  });

  try {
    const open = compressionEngine.strategies?.get?.('opencode');
    open?.updateOptions?.({
      pruneProtect: settings.pruneProtect,
      pruneMinimum: settings.pruneMinimum,
      protectedTools: settings.protectedTools,
      threshold: settings.threshold,
      outputTokenMax: outputTokens
    });
  } catch {}

  try {
    const focus = compressionEngine.strategies?.get?.('focus-agent');
    if (focus?.options) {
      if (Number.isFinite(Number(settings.compressionInterval))) focus.options.compressionInterval = Number(settings.compressionInterval);
      if (Number.isFinite(Number(settings.minToolCalls))) focus.options.minToolCalls = Number(settings.minToolCalls);
    }
  } catch {}

  try {
    const cursor = compressionEngine.strategies?.get?.('cursor');
    if (cursor?.options && Number.isFinite(Number(settings.maxToolOutputLength))) {
      cursor.options.maxToolOutputLength = Number(settings.maxToolOutputLength);
    }
  } catch {}
}

function sanitizeChatMessages(compressed, original) {
  const inMsgs = Array.isArray(compressed) ? compressed : [];
  const allowedRoles = new Set(['system', 'user', 'assistant', 'tool']);

  const assistantToolCallIds = new Set();
  for (const m of inMsgs) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.id) assistantToolCallIds.add(String(tc.id));
      }
    }
  }

  const out = [];
  for (const m of inMsgs) {
    const role = String(m?.role || '');
    if (!allowedRoles.has(role)) continue;

    if (role === 'tool') {
      const id = m?.tool_call_id != null ? String(m.tool_call_id) : '';
      if (!id || !assistantToolCallIds.has(id)) {
        continue;
      }
      const content = normalizeContent(m?.content);
      out.push({ role: 'tool', tool_call_id: id, content });
      continue;
    }

    if (role === 'assistant' && Array.isArray(m.tool_calls)) {
      const tool_calls = m.tool_calls
        .map((tc) => {
          const id = tc?.id != null ? String(tc.id) : '';
          const name = tc?.function?.name != null ? String(tc.function.name) : '';
          let args = tc?.function?.arguments;
          if (args != null && typeof args !== 'string') {
            try { args = JSON.stringify(args); } catch { args = String(args); }
          }
          if (!id || !name) return null;
          return { id, type: 'function', function: { name, arguments: args || '{}' } };
        })
        .filter(Boolean);
      const content = normalizeContent(m?.content);
      if (tool_calls.length > 0) out.push({ role: 'assistant', content, tool_calls });
      else out.push({ role: 'assistant', content });
      continue;
    }

    const content = normalizeContent(m?.content);
    out.push({ role, content });
  }

  const lastRole = out.length > 0 ? out[out.length - 1].role : null;
  if (lastRole !== 'user') {
    const orig = Array.isArray(original) ? original : [];
    for (let i = orig.length - 1; i >= 0; i--) {
      if (orig[i]?.role === 'user') {
        out.push({ role: 'user', content: normalizeContent(orig[i]?.content) });
        break;
      }
    }
  }

  return out.length > 0 ? out : inMsgs;
}

function normalizeContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'object') {
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  return String(content);
}

function parseMessages(content) {
  const lines = String(content || '').split('\n');
  const messages = [];
  let currentRole = 'user';
  let currentContent = [];
  let currentImages = [];

  for (const line of lines) {
    const roleMatch = line.match(/^(system|user|assistant)\s+(.*)$/);
    const imageMatch = line.match(/^!\[.*\]\((.*)\)$/);

    if (roleMatch) {
      if (currentContent.length > 0 || currentImages.length > 0) {
        const message = { role: currentRole, content: [] };
        if (currentContent.length > 0) {
          message.content.push({ type: 'text', text: currentContent.join('\n').trim() });
        }
        for (const img of currentImages) {
          if (img.startsWith('http') || img.startsWith('app://')) {
            message.content.push({ type: 'image_url', image_url: { url: img } });
          }
        }
        messages.push(message);
        currentContent = [];
        currentImages = [];
      }
      currentRole = roleMatch[1];
      const contentPart = roleMatch[2];
      if (contentPart.trim()) currentContent.push(contentPart);
    } else if (imageMatch) {
      const imageUrl = imageMatch[1];
      currentImages.push(imageUrl);
    } else {
      currentContent.push(line);
    }
  }

  if (currentContent.length > 0 || currentImages.length > 0) {
    const message = { role: currentRole, content: [] };
    if (currentContent.length > 0) {
      message.content.push({ type: 'text', text: currentContent.join('\n').trim() });
    }
    for (const img of currentImages) {
      if (img.startsWith('http') || img.startsWith('app://')) {
        message.content.push({ type: 'image_url', image_url: { url: img } });
      }
    }
    messages.push(message);
  }

  const simplified = messages.map(msg => {
    if (Array.isArray(msg.content) && msg.content.length === 1 && msg.content[0]?.type === 'text') {
      return { role: msg.role, content: msg.content[0].text };
    }
    return msg;
  });

  return simplified;
}

function serializeMessages(messages) {
  const parts = [];
  for (const msg of messages || []) {
    const role = msg?.role || 'user';
    const content = msg?.content;
    const body = serializeContent(content);
    const lines = body.split('\n');
    const head = `${role} ${lines[0] ?? ''}`;
    const tail = lines.slice(1).join('\n');
    parts.push(tail ? `${head}\n${tail}` : head);
  }
  return parts.join('\n\n');
}

function serializeContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const out = [];
    for (const part of content) {
      if (part?.type === 'text') out.push(String(part.text || ''));
      else if (part?.type === 'image_url') out.push(`![image](${part?.image_url?.url || ''})`);
      else out.push(typeof part === 'string' ? part : JSON.stringify(part));
    }
    return out.join('\n');
  }
  return typeof content === 'object' ? JSON.stringify(content) : String(content);
}

function openSettingsOverlay() {
  const id = 'zion-compression-settings-overlay';
  const existing = document.getElementById(id);
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = id;
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.background = 'rgba(0,0,0,0.35)';
  overlay.style.zIndex = '99998';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const panel = document.createElement('div');
  panel.style.position = 'fixed';
  panel.style.right = '20px';
  panel.style.top = '60px';
  panel.style.width = '420px';
  panel.style.maxHeight = '70vh';
  panel.style.overflow = 'auto';
  panel.style.background = 'var(--panel)';
  panel.style.border = '1px solid var(--border)';
  panel.style.borderRadius = '8px';
  panel.style.boxShadow = '0 8px 24px rgba(0,0,0,0.35)';
  panel.style.padding = '12px';
  panel.style.zIndex = '99999';
  panel.style.color = 'var(--fg)';
  panel.onclick = (e) => e.stopPropagation();

  const settingsPanel = new CompressionSettingsPanel();
  settingsPanel.hide = () => overlay.remove();
  const originalSave = settingsPanel.saveSettings.bind(settingsPanel);
  settingsPanel.saveSettings = async () => {
    await originalSave();
    overlay.remove();
  };

  const styles = document.createElement('style');
  styles.textContent = `
.compression-settings-panel h2{margin:0 0 10px 0;font-size:14px}
.compression-settings-panel h3{margin:14px 0 8px 0;font-size:12px;opacity:.9}
.compression-settings-panel h4{margin:10px 0 6px 0;font-size:12px;opacity:.85}
.compression-settings-panel small{display:block;opacity:.7;margin-top:4px}
.compression-settings-panel .settings-section{padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:10px;background:rgba(0,0,0,0.06)}
:root[data-theme="light"] .compression-settings-panel .settings-section{background:rgba(0,0,0,0.03)}
.compression-settings-panel .setting-item{margin:10px 0}
.compression-settings-panel input[type="text"],.compression-settings-panel input[type="number"],.compression-settings-panel select{width:100%;box-sizing:border-box;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:12px}
.compression-settings-panel input[type="range"]{width:100%}
.compression-settings-panel .settings-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
.compression-settings-panel button{background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer}
.compression-settings-panel button:hover{filter:brightness(1.08)}
.compression-settings-panel .hidden{display:none}
`;
  panel.appendChild(styles);

  (async () => {
    await settingsPanel.loadSettings();
    panel.insertAdjacentHTML('beforeend', settingsPanel.render());
    settingsPanel.attachEventListeners();
  })();

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

function openStatsOverlay() {
  const id = 'zion-compression-stats-overlay';
  const existing = document.getElementById(id);
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = id;
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.background = 'rgba(0,0,0,0.35)';
  overlay.style.zIndex = '99998';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const panel = document.createElement('div');
  panel.style.position = 'fixed';
  panel.style.right = '20px';
  panel.style.top = '60px';
  panel.style.width = '360px';
  panel.style.maxHeight = '70vh';
  panel.style.overflow = 'auto';
  panel.style.background = 'var(--panel)';
  panel.style.border = '1px solid var(--border)';
  panel.style.borderRadius = '8px';
  panel.style.boxShadow = '0 8px 24px rgba(0,0,0,0.35)';
  panel.style.padding = '12px';
  panel.style.zIndex = '99999';
  panel.style.color = 'var(--fg)';
  panel.onclick = (e) => e.stopPropagation();

  const title = document.createElement('div');
  title.textContent = 'Compression Statistics';
  title.style.fontWeight = '600';
  title.style.marginBottom = '8px';

  const styles = document.createElement('style');
  styles.textContent = `
.compression-stats{font-size:12px}
.compression-stats .kv{display:grid;grid-template-columns:140px 1fr;gap:6px 10px;margin:10px 0}
.compression-stats .k{opacity:.75}
.compression-stats table{width:100%;border-collapse:collapse;margin-top:10px}
.compression-stats th,.compression-stats td{border:1px solid var(--border);padding:6px 8px;text-align:left}
.compression-stats th{opacity:.85}
`;
  panel.appendChild(styles);

  const stats = window.zion.state.get('compression.stats') || {};
  const strategies = stats.strategyUsage || {};
  const savingsByStrategy = stats.tokenSavingsByStrategy || {};

  const container = document.createElement('div');
  container.className = 'compression-stats';

  const kv = document.createElement('div');
  kv.className = 'kv';
  const last = stats.lastCompressionTime ? new Date(stats.lastCompressionTime).toLocaleString() : '-';
  const totalSaved = Number(stats.totalTokensSaved || 0);
  const count = Number(stats.compressionCount || 0);
  kv.innerHTML = `
    <div class="k">Total saved</div><div>${formatTokens(totalSaved)} (${totalSaved})</div>
    <div class="k">Compressions</div><div>${count}</div>
    <div class="k">Last</div><div>${last}</div>
  `;
  container.appendChild(kv);

  const table = document.createElement('table');
  table.innerHTML = `<thead><tr><th>Strategy</th><th>Count</th><th>Saved</th></tr></thead>`;
  const tbody = document.createElement('tbody');
  const keys = Array.from(new Set([...Object.keys(strategies), ...Object.keys(savingsByStrategy)])).sort();
  for (const k of keys) {
    const tr = document.createElement('tr');
    const c = Number(strategies[k] || 0);
    const s = Number(savingsByStrategy[k] || 0);
    tr.innerHTML = `<td>${k}</td><td>${c}</td><td>${formatTokens(s)} (${s})</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);

  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '8px';
  row.style.marginTop = '10px';
  row.style.justifyContent = 'flex-end';

  const btnReset = document.createElement('button');
  btnReset.textContent = 'Reset';
  btnReset.onclick = () => {
    window.zion.state.set('compression.stats', {
      totalTokensSaved: 0,
      compressionCount: 0,
      strategyUsage: {},
      tokenSavingsByStrategy: {}
    });
    overlay.remove();
  };

  const btnClose = document.createElement('button');
  btnClose.textContent = 'Close';
  btnClose.onclick = () => overlay.remove();

  row.appendChild(btnClose);
  row.appendChild(btnReset);
  panel.appendChild(title);
  panel.appendChild(container);
  panel.appendChild(row);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}
