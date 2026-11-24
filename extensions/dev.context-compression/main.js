import { workbenchStorage as localStorage } from "../../src/runtime/workbench-space.ts";
import { hydrateRemoteAnnotations } from "../dev.session-manager/storage/remote.js";
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
import { stripAssistantBlockIdComment } from '../../src/chat/restore.ts';
import { isContinuationBoundaryLine } from '../../src/chat/session-document-format.js';
import { readWorkbenchRuntimeConfig } from '../../src/runtime/workbench-runtime-config.ts';
import { currentAccountSession } from '../../packages/account-ui/src/client.ts';
import { runtimePluginCommand } from '../../src/runtime/runtime-plugin-commands.ts';
import {
  compressionSettingsSyncDirection,
  loadCompressionSettingsFromRuntime,
  syncCompressionSettingsToRuntime
} from './compression-runtime-state.js';

const I18N_NS = 'dev.context-compression';
const I18N_MESSAGES = {
  'zh-CN': {
    'category.compression': '压缩',
    'cmd.manual': '压缩对话（手动）',
    'cmd.strategy.opencode': '使用 OpenCode 策略压缩',
    'cmd.strategy.claudeCode': '使用 Claude Code 策略压缩',
    'cmd.strategy.cursor': '使用 Cursor 策略压缩',
    'cmd.strategy.manus': '使用 Manus 策略压缩',
    'cmd.strategy.focusAgent': '使用 Focus Agent 策略压缩',
    'cmd.settings': '打开压缩设置',
    'cmd.stats': '显示压缩统计',
    'settings.title': '压缩',
    'settings.description': '上下文压缩与摘要策略',
    'settings.basics': '基础设置',
    'settings.actions': '更多操作',
    'settings.autoCompression.label': '自动压缩',
    'settings.autoCompression.description': '在上下文过长时自动触发压缩',
    'settings.strategy.label': '默认策略',
    'settings.strategy.description': '决定自动压缩优先采用的方式',
    'settings.strategy.auto': '自动选择',
    'settings.threshold.label': '触发阈值',
    'settings.threshold.description': '达到上下文比例后触发压缩，通常建议 0.8',
    'settings.limit.label': '上下文上限',
    'settings.limit.description': '压缩计算时参考的 token 上限',
    'settings.advanced.label': '高级压缩配置',
    'settings.advanced.description': '打开完整压缩设置面板',
    'settings.advanced.action': '打开高级配置',
    'settings.stats.label': '压缩统计',
    'settings.stats.description': '查看压缩次数与节省情况',
    'settings.stats.action': '查看统计',
    'slash.compress.title': '压缩',
    'slash.compress.description': '压缩当前编辑器对话',
    'slash.settings.title': '压缩设置',
    'slash.settings.description': '打开压缩设置',
    'slash.stats.title': '压缩统计',
    'slash.stats.description': '显示压缩统计',
    'status.text': '上下文：{saved}',
    'status.title': '上下文压缩：{saved}',
    'status.tooltip': '已节省 tokens：{saved}'
  },
  'en-US': {
    'category.compression': 'Compression',
    'cmd.manual': 'Compress Conversation (Manual)',
    'cmd.strategy.opencode': 'Compress with OpenCode Strategy',
    'cmd.strategy.claudeCode': 'Compress with Claude Code Strategy',
    'cmd.strategy.cursor': 'Compress with Cursor Strategy',
    'cmd.strategy.manus': 'Compress with Manus Strategy',
    'cmd.strategy.focusAgent': 'Compress with Focus Agent Strategy',
    'cmd.settings': 'Open Compression Settings',
    'cmd.stats': 'Show Compression Statistics',
    'settings.title': 'Compression',
    'settings.description': 'Context compression and summary strategy',
    'settings.basics': 'Basics',
    'settings.actions': 'More Actions',
    'settings.autoCompression.label': 'Auto Compression',
    'settings.autoCompression.description': 'Automatically compress when context gets too long',
    'settings.strategy.label': 'Default Strategy',
    'settings.strategy.description': 'Choose the preferred strategy for automatic compression',
    'settings.strategy.auto': 'Auto',
    'settings.threshold.label': 'Trigger Threshold',
    'settings.threshold.description': 'Trigger compression when context ratio reaches this value',
    'settings.limit.label': 'Context Limit',
    'settings.limit.description': 'Token limit used for compression calculation',
    'settings.advanced.label': 'Advanced Compression',
    'settings.advanced.description': 'Open full compression settings',
    'settings.advanced.action': 'Open Advanced',
    'settings.stats.label': 'Compression Stats',
    'settings.stats.description': 'View compression count and savings',
    'settings.stats.action': 'View Stats',
    'slash.compress.title': 'Compress',
    'slash.compress.description': 'Compress current editor conversation',
    'slash.settings.title': 'Compression Settings',
    'slash.settings.description': 'Open compression settings',
    'slash.stats.title': 'Compression Stats',
    'slash.stats.description': 'Show compression statistics',
    'status.text': 'Ctx: {saved}',
    'status.title': 'Context Compression: {saved}',
    'status.tooltip': 'Tokens saved: {saved}'
  }
};

function t(key, fallback, values) {
  try {
    const translated = window.zion?.i18n?.t?.(`${I18N_NS}.${key}`, values);
    if (translated && translated !== `${I18N_NS}.${key}`) return translated;
  } catch {}
  return fallback;
}

let __settingsPanelSingleton = null;
let __runtimeSettingsSyncTimer = 0;

export function usesRuntimeCompression() {
  const config = readWorkbenchRuntimeConfig({ state: window.zion?.state, storage: globalThis.localStorage });
  return config.mode !== 'browser' && (config.mode === 'runtime'
    || !!currentAccountSession()
    || window.zion?.state?.get?.('runtime.connection')?.backend === 'runtime');
}

async function runtimeCompact() {
  await window.zion?.commands?.executeCommand?.('zion.sessions.flushPendingSave');
  const result = await runtimePluginCommand('dev.context-compression', { action: 'compact' });
  window.zion?.state?.set?.('compression.runtimeStatus', result);
  const status = await runtimePluginCommand('dev.context-compression', { action: 'status' });
  if (status) window.zion.state.set('compression.stats', {
    compressionCount: status.count, totalTokensSaved: status.tokensSaved,
    lastCompressionTime: status.status?.at, runtimeStatus: status.status
  });
  window.zion.notification?.show?.(`上下文已压缩，预计节省 ${result.savedTokens} tokens。`, { type: 'success' });
  window.zion?.events?.emit?.('compression/runtimeCompleted', result);
  return { ok: true, ...result };
}

const __compressionMem = { kv: {}, versions: {} };

function getActivePanelContext() {
  try {
    const panelId = window.zion?.panels?.getActivePanelId?.() || null;
    const panels = window.zion?.panels?.list?.() || [];
    const panel = panelId ? panels.find(p => p?.id === panelId) : null;
    const sessionId = panel?.activeTabId || window.zion?.state?.get?.('sessions.currentId') || null;
    const editor = panelId ? (window.zion?.panels?.getEditor?.(panelId) || window.zion?.window?.activeEditor) : window.zion?.window?.activeEditor;
    return { panelId, sessionId, editor };
  } catch {
    return {
      panelId: null,
      sessionId: null,
      editor: window.zion?.window?.activeEditor
    };
  }
}

function getSessionKey() {
  try {
    const sid = getActivePanelContext().sessionId || window.zion?.state?.get?.('sessions.currentId');
    if (sid) return `session:${String(sid)}`;
  } catch {}
  return 'global';
}

function makeVersionId(sessionKey) {
  const rand = Math.random().toString(16).slice(2);
  return `${sessionKey}:${Date.now()}:${rand}`;
}

function canUseIDB() {
  return typeof indexedDB !== 'undefined' && indexedDB;
}

const COMPRESSION_DB = 'zion.compression.db';
let __dbPromise = null;

function openCompressionDB() {
  if (__dbPromise) return __dbPromise;
  __dbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(COMPRESSION_DB, 1);
      req.onupgradeneeded = (e) => {
        try {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('versions')) db.createObjectStore('versions', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        } catch {}
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error || new Error('idb open error'));
    } catch (err) {
      reject(err);
    }
  });
  return __dbPromise;
}

async function idbGet(store, key) {
  const db = await openCompressionDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(store, 'readonly');
      const st = tx.objectStore(store);
      const req = st.get(key);
      req.onsuccess = () => {
        const v = req.result;
        if (!v) return resolve(undefined);
        if (store === 'kv') return resolve(v?.value);
        return resolve(v);
      };
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

async function idbSet(store, record) {
  const db = await openCompressionDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(store, 'readwrite');
      const st = tx.objectStore(store);
      const req = st.put(record);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

async function idbDel(store, key) {
  const db = await openCompressionDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(store, 'readwrite');
      const st = tx.objectStore(store);
      const req = st.delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

async function storageGetKV(key) {
  if (canUseIDB()) {
    try {
      return await idbGet('kv', key);
    } catch {}
  }
  return __compressionMem.kv[key];
}

async function storageSetKV(key, value) {
  if (canUseIDB()) {
    try {
      await idbSet('kv', { key, value });
      return;
    } catch {}
  }
  __compressionMem.kv[key] = value;
}

async function storageDelKV(key) {
  if (canUseIDB()) {
    try {
      await idbDel('kv', key);
      return;
    } catch {}
  }
  delete __compressionMem.kv[key];
}

async function storagePutVersion(record) {
  if (canUseIDB()) {
    try {
      await idbSet('versions', record);
      return;
    } catch {}
  }
  __compressionMem.versions[record.id] = record;
}

async function storageGetVersion(id) {
  if (canUseIDB()) {
    try {
      return await idbGet('versions', id);
    } catch {}
  }
  return __compressionMem.versions[id];
}

async function storageDelVersion(id) {
  if (canUseIDB()) {
    try {
      await idbDel('versions', id);
      return;
    } catch {}
  }
  delete __compressionMem.versions[id];
}

async function getVersionsIndex(sessionKey) {
  const v = await storageGetKV(`index:${sessionKey}`);
  return Array.isArray(v) ? v : [];
}

async function setVersionsIndex(sessionKey, idx) {
  await storageSetKV(`index:${sessionKey}`, Array.isArray(idx) ? idx : []);
}

async function getActiveVersionId(sessionKey) {
  const v = await storageGetKV(`active:${sessionKey}`);
  return v ? String(v) : null;
}

async function setActiveVersionId(sessionKey, id) {
  if (!id) {
    await storageDelKV(`active:${sessionKey}`);
    return;
  }
  await storageSetKV(`active:${sessionKey}`, String(id));
}

async function listVersionsForActiveSession() {
  const sessionKey = getSessionKey();
  const index = await getVersionsIndex(sessionKey);
  const activeId = await getActiveVersionId(sessionKey);
  return { sessionKey, activeId, versions: index };
}

async function restoreVersionForActiveSession(id) {
  const { panelId, sessionId: activePanelSessionId, editor } = getActivePanelContext();
  if (!editor) return { ok: false, error: 'no_editor' };
  const sessionKey = getSessionKey();
  const rec = await storageGetVersion(String(id));
  if (!rec || rec.sessionKey !== sessionKey) return { ok: false, error: 'not_found' };

  const sessionId = activePanelSessionId || (sessionKey.startsWith('session:') ? sessionKey.slice('session:'.length) : null);
  const annotations = rec.annotations && typeof rec.annotations === 'object' ? rec.annotations : null;

  editor.setValue(String(rec.text ?? ''));
  await setActiveVersionId(sessionKey, String(id));

  if (sessionId) {
    setTimeout(() => {
      try {
        window.zion?.commands?.executeCommand?.('zion.chatCards.restoreSession', {
          sessionId,
          panelId,
          annotations: annotations || {},
          clearFirst: true
        });
      } catch {}
    }, 0);
  }

  return { ok: true };
}

async function buildMessagesForCompression(docText, sessionId, suppliedAnnotations) {
  const messages = parseMessages(docText);
  if (!sessionId) return messages;

  const ann = await hydrateRemoteAnnotations(suppliedAnnotations || (() => {
    try {
      const v = window.zion?.commands?.executeCommand?.('zion.chatCards.getSessionAnnotations', sessionId);
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  })());

  const limitPos = String(docText || '').length;

  const itemsToolsRaw = Array.isArray(ann.tools) ? ann.tools : [];
  const deletedTool = new Set(Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds : []);
  const itemsTools = itemsToolsRaw
    .filter(it => it && it.id && !deletedTool.has(it.id))
    .filter(it => typeof it.from === 'number' && it.from >= 0 && it.from < limitPos)
    .filter(it => it.name && it.args && it.result != null)
    .sort((a, b) => (a.from || 0) - (b.from || 0));

  const itemsThinkingRaw = Array.isArray(ann.thinking) ? ann.thinking : [];
  const deletedThinking = new Set(Array.isArray(ann.deletedThinkingIds) ? ann.deletedThinkingIds : []);
  const itemsThinking = itemsThinkingRaw
    .filter(it => it && !deletedThinking.has(it.id))
    .filter(it => typeof it.from === 'number' && it.from >= 0 && it.from < limitPos)
    .filter(it => typeof it.text === 'string' && it.text.trim().length > 0)
    .sort((a, b) => (a.from || 0) - (b.from || 0));

  if (itemsTools.length === 0 && itemsThinking.length === 0) return messages;

  const buildRanges = (text) => {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const ranges = [];
    let pos = 0;
    let startPos = 0;
    let currentRole = 'user';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^(system|user|assistant)\s+(.*)$/);
      if (m) {
        if (pos > startPos) ranges.push({ role: currentRole, from: startPos, to: pos });
        currentRole = m[1];
        startPos = pos;
      }
      pos += line.length + 1;
    }
    if (pos > startPos) ranges.push({ role: currentRole, from: startPos, to: pos });
    return ranges;
  };

  const ranges = buildRanges(docText);
  const assistantRanges = ranges.filter(r => r.role === 'assistant');
  const assistantMsgIdxs = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'assistant') assistantMsgIdxs.push(i);
  }

  const groups = new Map();
  const findAssistantIndexForPos = (p) => {
    for (let i = 0; i < assistantRanges.length; i++) {
      const r = assistantRanges[i];
      if (p >= r.from && p < r.to) return assistantMsgIdxs[i] ?? -1;
    }
    let fallback = -1;
    for (let i = 0; i < assistantRanges.length; i++) {
      if (assistantRanges[i].to <= p) fallback = assistantMsgIdxs[i] ?? -1;
    }
    return fallback;
  };

  for (const it of itemsTools) {
    const idx = findAssistantIndexForPos(it.from);
    if (idx < 0) continue;
    const arr = groups.get(idx) || [];
    arr.push({
      pos: it.from,
      kind: 'tool',
      data: {
        id: it.id,
        name: it.name,
        args: it.args,
        result: String(it.result)
      }
    });
    groups.set(idx, arr);
  }

  for (const it of itemsThinking) {
    const idx = findAssistantIndexForPos(it.from);
    if (idx < 0) continue;
    const arr = groups.get(idx) || [];
    arr.push({ pos: it.from, kind: 'thinking', data: { content: String(it.text || '') } });
    groups.set(idx, arr);
  }

  if (groups.size === 0) return messages;

  const out = messages.slice();
  const sortedIdxs = Array.from(groups.keys()).sort((a, b) => a - b);
  let offset = 0;
  for (const baseIdx of sortedIdxs) {
    const idx = baseIdx + offset;
    const units = (groups.get(baseIdx) || []).slice().sort((a, b) => (a.pos || 0) - (b.pos || 0));
    const range = assistantRanges[sortedIdxs.indexOf(baseIdx)] || null;
    const origMsg = out[idx];
    const segments = [];
    const sliceClean = (from, to) => {
      const seg = String(docText || '').slice(from, to);
      const cleaned = stripWidgetStubs(seg);
      return cleaned.trim();
    };
    let prevPos = range ? range.from : null;
    const lineEndAt = (p) => {
      const text = String(docText || '');
      const end = text.indexOf('\n', p);
      return end === -1 ? text.length : end + 1;
    };
    for (const unit of units) {
      if (prevPos != null && unit.pos > prevPos) {
        const pre = sliceClean(prevPos, unit.pos);
        if (pre) segments.push({ role: 'assistant', content: [{ type: 'text', text: pre }] });
      }
      if (unit.kind === 'thinking') {
        const text = String(unit.data.content || '').trim();
        if (text && !/^思考$/.test(text)) {
          segments.push({ role: 'assistant', content: [{ type: 'thinking', text }] });
        }
        // advance prevPos past the widget line
        prevPos = lineEndAt(unit.pos);
      } else if (unit.kind === 'tool') {
        const tc = {
          id: unit.data.id,
          type: 'function',
          function: { name: unit.data.name, arguments: JSON.stringify(unit.data.args || {}) }
        };
        segments.push({ role: 'assistant', tool_calls: [tc] });
        segments.push({ role: 'tool', tool_call_id: unit.data.id, content: unit.data.result });
        prevPos = lineEndAt(unit.pos);
      }
    }
    if (prevPos != null && range && prevPos < range.to) {
      const tail = sliceClean(prevPos, range.to);
      if (tail) segments.push({ role: 'assistant', content: [{ type: 'text', text: tail }] });
    }
    // Replace original assistant message with segmented series placed at widget positions
    out.splice(idx, 1, ...segments);
    offset += Math.max(0, segments.length - 1);
  }

  return out;
}

async function deleteVersionForActiveSession(id) {
  const sessionKey = getSessionKey();
  const idx = await getVersionsIndex(sessionKey);
  const strId = String(id);
  const nextIdx = idx.filter((v) => v?.id !== strId);
  await setVersionsIndex(sessionKey, nextIdx);
  await storageDelVersion(strId);
  const activeId = await getActiveVersionId(sessionKey);
  if (activeId === strId) {
    const nextActive = nextIdx[0]?.id ? String(nextIdx[0].id) : null;
    await setActiveVersionId(sessionKey, nextActive);
  }
  return { ok: true };
}

async function clearVersionsForActiveSession() {
  const sessionKey = getSessionKey();
  const idx = await getVersionsIndex(sessionKey);
  for (const v of idx) {
    if (v?.id) await storageDelVersion(String(v.id));
  }
  await setVersionsIndex(sessionKey, []);
  await setActiveVersionId(sessionKey, null);
  return { ok: true };
}

function scheduleCompressionSettingsSync(settings) {
  try {
    if (__runtimeSettingsSyncTimer) window.clearTimeout(__runtimeSettingsSyncTimer);
    __runtimeSettingsSyncTimer = window.setTimeout(() => {
      __runtimeSettingsSyncTimer = 0;
      void syncCompressionSettingsToRuntime({ settings }).catch(() => {});
    }, 200);
  } catch {}
}

async function reconcileCompressionSettingsWithRuntime() {
  const local = await getCompressionSettings();
  const runtime = await loadCompressionSettingsFromRuntime();
  const direction = compressionSettingsSyncDirection(local, runtime);
  if (direction === 'restore') {
    const restored = {
      ...local,
      ...runtime
    };
    await storageSetKV('compression.settings', restored);
    try { window.zion?.state?.set?.('compression.settings', restored); } catch {}
    return restored;
  }
  if (direction === 'upload') {
    await syncCompressionSettingsToRuntime({ settings: local });
  }
  return runtime || local;
}

export async function activate(ctx) {
  try {
    const disp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

  console.log('dev.context-compression plugin activated');
  const log = (...args) => console.log('[context-compression]', ...args);
  const warn = (...args) => console.warn('[context-compression]', ...args);
  const SETTINGS_KV_KEY = 'compression.settings';
  
  // 初始化压缩引擎
  const compressionEngine = new CompressionEngine();
  
  // 注册所有压缩策略
  compressionEngine.registerStrategy('opencode', new OpenCodeStrategy());
  compressionEngine.registerStrategy('claude-code', new ClaudeCodeStrategy());
  compressionEngine.registerStrategy('cursor', new CursorStrategy());
  compressionEngine.registerStrategy('manus', new ManusStrategy());
  compressionEngine.registerStrategy('focus-agent', new FocusAgentStrategy());
  try {
    const { ProgressiveStrategy } = await import('./strategies/progressive.js');
    compressionEngine.registerStrategy('progressive', new ProgressiveStrategy());
  } catch {}
  
  // 初始化 Token 计数器
  const tokenCounter = new TokenCounter();
  
  // 初始化 KV-Cache 优化器
  const kvCacheOptimizer = new KVCacheOptimizer();
  
  // 注册命令
  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.manual', async () => {
      await applyCompressionToActiveEditor(compressionEngine, { strategy: 'auto', openPanel: false });
    })
  );
  
  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.strategy.opencode', async () => {
      await applyCompressionToActiveEditor(compressionEngine, { strategy: 'opencode', openPanel: false });
    })
  );
  
  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.strategy.claude-code', async () => {
      await applyCompressionToActiveEditor(compressionEngine, { strategy: 'claude-code', openPanel: false });
    })
  );
  
  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.strategy.cursor', async () => {
      await applyCompressionToActiveEditor(compressionEngine, { strategy: 'cursor', openPanel: false });
    })
  );
  
  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.strategy.manus', async () => {
      await applyCompressionToActiveEditor(compressionEngine, { strategy: 'manus', openPanel: false });
    })
  );
  
  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.strategy.focus-agent', async () => {
      await applyCompressionToActiveEditor(compressionEngine, { strategy: 'focus-agent', openPanel: false });
    })
  );
  
  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.strategy.progressive', async () => {
      await applyCompressionToActiveEditor(compressionEngine, { strategy: 'progressive', openPanel: false });
    })
  );
  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.tool.view', async (args) => {
      try {
        const toolId = String(args?.tool_call_id || args?.id || '');
        if (!toolId) return { ok: false, error: 'invalid_id' };
        const sessionKey = getSessionKey();
        const sessionId = sessionKey.startsWith('session:') ? sessionKey.slice('session:'.length) : null;
        if (!sessionId) return { ok: false, error: 'no_session' };
        const ann = await hydrateRemoteAnnotations(window.zion?.commands?.executeCommand?.('zion.chatCards.getSessionAnnotations', sessionId) || {});
        const items = Array.isArray(ann.tools) ? ann.tools : [];
        const it = items.find(x => String(x.id) === toolId);
        if (!it) return { ok: false, error: 'not_found' };
        return { ok: true, content: String(it.result ?? '') };
      } catch (e) {
        return { ok: false, error: 'exception' };
      }
    })
  );

  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.preview', async () => {
      openCompressionPanel({ tab: 'compress' });
    })
  );

  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.preview.compute', async (opts) => {
      const strategy = opts?.strategy || 'auto';
      return await computeCompressionPreview(compressionEngine, { strategy });
    })
  );

  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.apply', async (opts) => {
      const strategy = opts?.strategy || 'auto';
      const openPanel = opts?.openPanel !== false;
      return await applyCompressionToActiveEditor(compressionEngine, { strategy, openPanel });
    })
  );

  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.versions.list', async () => {
      return await listVersionsForActiveSession();
    })
  );

  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.versions.restore', async (id) => {
      return await restoreVersionForActiveSession(id);
    })
  );

  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.versions.delete', async (id) => {
      return await deleteVersionForActiveSession(id);
    })
  );

  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.versions.clear', async () => {
      return await clearVersionsForActiveSession();
    })
  );
  
  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.settings', () => {
      showSettingsPanel();
    })
  );

  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.stats', async () => {
      if (usesRuntimeCompression()) {
        const result = await runtimePluginCommand('dev.context-compression', { action: 'status' });
        window.zion.state.set('compression.runtimeStatus', result);
        if (result) window.zion.state.set('compression.stats', {
          compressionCount: result.count, totalTokensSaved: result.tokensSaved,
          lastCompressionTime: result.status?.at, runtimeStatus: result.status
        });
      }
      showCompressionStats();
    })
  );

  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.settings.save', async (settings) => {
      try {
        if (settings && typeof settings === 'object') {
          const next = {
            ...settings,
            updatedAt: Date.now()
          };
          try { window.zion?.state?.set?.('compression.settings', next); } catch {}
          await storageSetKV(SETTINGS_KV_KEY, next);
          scheduleCompressionSettingsSync(next);
          return { ok: true };
        }
        return { ok: false, error: 'invalid_settings' };
      } catch (e) {
        warn('settings.save failed', e);
        return { ok: false, error: 'exception' };
      }
    })
  );

  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.settings.load', async () => {
      try {
        const persisted = await storageGetKV(SETTINGS_KV_KEY);
        const inState = window.zion?.state?.get?.('compression.settings');
        const panel = new CompressionSettingsPanel();
        const defaults = panel.getDefaultSettings();
        const merged = { ...defaults, ...(persisted || inState || {}) };
        try { window.zion?.state?.set?.('compression.settings', merged); } catch {}
        return { ok: true, settings: merged };
      } catch (e) {
        return { ok: false, error: 'exception' };
      }
    })
  );

  ctx.subscriptions.push(
    window.zion.commands.registerCommand('compression.panel', (opts) => {
      const initialTab = opts?.tab || 'general';
      openCompressionPanel({ tab: initialTab });
    })
  );

  let slashRegistered = false;
  const registerSlashCommands = () => {
    if (slashRegistered || !window.zion.slash?.registerCommand) return;
    slashRegistered = true;
    ctx.subscriptions.push(
      window.zion.slash.registerCommand({
        id: 'compression.slash.compress',
        trigger: ['compress', 'compact'],
        title: t('slash.compress.title', 'Compress'),
        description: t('slash.compress.description', 'Compress current editor conversation'),
        category: t('category.compression', 'compression'),
        execute: () => window.zion.commands.executeCommand('compression.manual')
      }),
      window.zion.slash.registerCommand({
        id: 'compression.slash.settings',
        trigger: ['compressSettings', 'compressionSettings'],
        title: t('slash.settings.title', 'Compression Settings'),
        description: t('slash.settings.description', 'Open compression settings'),
        category: t('category.compression', 'compression'),
        execute: () => window.zion.commands.executeCommand('compression.settings')
      }),
      window.zion.slash.registerCommand({
        id: 'compression.slash.stats',
        trigger: ['compressStats', 'compressionStats'],
        title: t('slash.stats.title', 'Compression Stats'),
        description: t('slash.stats.description', 'Show compression statistics'),
        category: t('category.compression', 'compression'),
        execute: () => window.zion.commands.executeCommand('compression.stats')
      })
    );
  };
  registerSlashCommands();
  const slashReady = window.zion.state?.onDidChange?.('workbench.pluginsReady', registerSlashCommands);
  if (slashReady) ctx.subscriptions.push(slashReady);

  await ensureDefaultSettings(SETTINGS_KV_KEY);

  try {
    const initialSettings = await reconcileCompressionSettingsWithRuntime();
    syncEngineFromSettings(compressionEngine, initialSettings);
  } catch {}

  const updateCompressionSetting = async (key, value, parser) => {
    const current = await getCompressionSettings();
    const nextValue = typeof parser === 'function' ? parser(value) : value;
    const next = { ...current, [key]: nextValue };
    await window.zion.commands.executeCommand('compression.settings.save', next);
    syncEngineFromSettings(compressionEngine, next);
  };

  try {
    window.zion.settings.registerPage({
      id: 'compression.preferences',
      pluginId: 'dev.context-compression',
      category: 'workspace',
      title: 'Compression',
      titleKey: 'dev.context-compression.settings.title',
      description: '上下文压缩与摘要策略',
      descriptionKey: 'dev.context-compression.settings.description',
      order: 30,
      sections: [
        {
          id: 'compression.basics',
          title: '基础设置',
          titleKey: 'dev.context-compression.settings.basics',
          settings: [
            {
              id: 'compression.autoCompression',
              kind: 'boolean',
              label: '自动压缩',
              labelKey: 'dev.context-compression.settings.autoCompression.label',
              description: '在上下文过长时自动触发压缩',
              descriptionKey: 'dev.context-compression.settings.autoCompression.description',
              getValue: async () => !!(await getCompressionSettings()).autoCompression,
              setValue: async (value) => updateCompressionSetting('autoCompression', !!value)
            },
            {
              id: 'compression.defaultStrategy',
              kind: 'select',
              label: '默认策略',
              labelKey: 'dev.context-compression.settings.strategy.label',
              description: '决定自动压缩优先采用的方式',
              descriptionKey: 'dev.context-compression.settings.strategy.description',
              enumOptions: [
                { value: 'handoff', label: 'Runtime 交接摘要（推荐）' },
                { value: 'auto', label: '自动选择', labelKey: 'dev.context-compression.settings.strategy.auto' },
                { value: 'opencode', label: 'OpenCode' },
                { value: 'claude-code', label: 'Claude Code' },
                { value: 'cursor', label: 'Cursor' },
                { value: 'manus', label: 'Manus' },
                { value: 'focus-agent', label: 'Focus Agent' },
                { value: 'progressive', label: 'Progressive' }
              ],
              getValue: async () => String((await getCompressionSettings()).defaultStrategy || 'auto'),
              setValue: async (value) => updateCompressionSetting('defaultStrategy', String(value || 'auto'))
            },
            {
              id: 'compression.threshold',
              kind: 'number',
              label: '触发阈值',
              labelKey: 'dev.context-compression.settings.threshold.label',
              description: '达到上下文比例后触发压缩，通常建议 0.8',
              descriptionKey: 'dev.context-compression.settings.threshold.description',
              getValue: async () => String((await getCompressionSettings()).threshold ?? 0.8),
              setValue: async (value) => updateCompressionSetting('threshold', value, (raw) => {
                const parsed = Number(raw);
                return Number.isFinite(parsed) ? parsed : 0.8;
              })
            },
            {
              id: 'compression.contextLimitTokens',
              kind: 'number',
              label: '上下文上限',
              labelKey: 'dev.context-compression.settings.limit.label',
              description: '压缩计算时参考的 token 上限',
              descriptionKey: 'dev.context-compression.settings.limit.description',
              getValue: async () => String((await getCompressionSettings()).contextLimitTokens ?? 200000),
              setValue: async (value) => updateCompressionSetting('contextLimitTokens', value, (raw) => {
                const parsed = Number(raw);
                return Number.isFinite(parsed) ? parsed : 200000;
              })
            }
          ]
        },
        {
          id: 'compression.actions',
          title: '更多操作',
          titleKey: 'dev.context-compression.settings.actions',
          settings: [
            {
              id: 'compression.openAdvanced',
              kind: 'action',
              label: '高级压缩配置',
              labelKey: 'dev.context-compression.settings.advanced.label',
              description: '打开完整压缩设置面板',
              descriptionKey: 'dev.context-compression.settings.advanced.description',
              actionLabel: '打开高级配置',
              actionLabelKey: 'dev.context-compression.settings.advanced.action',
              action: async () => window.zion.commands.executeCommand('compression.settings')
            },
            {
              id: 'compression.openStats',
              kind: 'action',
              label: '压缩统计',
              labelKey: 'dev.context-compression.settings.stats.label',
              description: '查看压缩次数与节省情况',
              descriptionKey: 'dev.context-compression.settings.stats.description',
              actionLabel: '查看统计',
              actionLabelKey: 'dev.context-compression.settings.stats.action',
              action: async () => window.zion.commands.executeCommand('compression.stats')
            }
          ]
        }
      ]
    });
  } catch (e) {
    warn('register compression settings page failed', e);
  }

  log('settings', window.zion?.state?.get?.('compression.settings'));

  const dispContributor = window.zion.messages.registerContributor({
    id: 'dev.context-compression',
    order: 90,
    stage: 'post',
    contribute: async (messages) => {
      if (usesRuntimeCompression()) return messages;
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
        if (compressed === messages) return messages;
      } catch (e) {
        warn('post contribute: compression failed', { strategy, error: e?.message || String(e) });
        return messages;
      }

      try {
        compressed = sanitizeChatMessages(compressed, messages, { appendFinalUser: strategy !== 'progressive' });
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
  try {
    const runtimeConnectionDisposable = window.zion?.state?.onDidChange?.(
      'runtime.connection',
      () => {
        void reconcileCompressionSettingsWithRuntime()
          .then((settings) => syncEngineFromSettings(compressionEngine, settings))
          .catch(() => {});
      }
    );
    if (runtimeConnectionDisposable) ctx.subscriptions.push(runtimeConnectionDisposable);
  } catch {}
  ctx.subscriptions.push({
    dispose() {
      if (__runtimeSettingsSyncTimer) window.clearTimeout(__runtimeSettingsSyncTimer);
      __runtimeSettingsSyncTimer = 0;
    }
  });

  let statusDisp = null;
  const updateStatus = () => {
    const stats = window.zion.state.get('compression.stats') || {};
    const saved = stats.totalTokensSaved || 0;
    const savedText = formatTokens(saved);
    try { statusDisp?.dispose?.(); } catch {}
    statusDisp = window.zion.bottomStatusBar?.registerItem?.({
      id: 'compression.status',
      text: t('status.text', 'Ctx: {saved}', { saved: savedText }),
      tooltip: t('status.tooltip', 'Tokens saved: {saved}', { saved }),
      priority: 60,
      onClick: () => openCompressionPanel()
    }) || window.zion.editorHeaderMenu?.register?.({
      id: 'compression.status',
      title: t('status.title', 'Context Compression: {saved}', { saved: savedText }),
      section: 'Chat',
      order: 30,
      onClick: () => openCompressionPanel()
    }) || window.zion.statusBar.registerItem({
      id: 'compression.status',
      text: t('status.text', 'Ctx: {saved}', { saved: savedText }),
      tooltip: t('status.tooltip', 'Tokens saved: {saved}', { saved }),
      onClick: () => openCompressionPanel()
    });
  };
  updateStatus();
  ctx.subscriptions.push({ dispose: () => { try { statusDisp?.dispose?.(); } catch {} } });
  ctx.subscriptions.push(window.zion.state.onDidChange('compression.stats', updateStatus));
  ctx.subscriptions.push(window.zion.events.on('i18n/changed', updateStatus));
  const runtimeCompressionStatus = window.zion.events.on('runtime/sessionRunEvent', (event = {}) => {
    if (!usesRuntimeCompression() || !['run.completed', 'run.failed', 'run.aborted'].includes(event.type)) return;
    void runtimePluginCommand('dev.context-compression', { action: 'status' }).then(result => {
      if (result) window.zion.state.set('compression.stats', {
        compressionCount: result.count, totalTokensSaved: result.tokensSaved,
        lastCompressionTime: result.status?.at, runtimeStatus: result.status
      });
    }).catch(() => {});
  });
  if (runtimeCompressionStatus) ctx.subscriptions.push(runtimeCompressionStatus);
  
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
  try {
    const panel = new CompressionSettingsPanel();
    const defaults = panel.getDefaultSettings();
    const persisted = await storageGetKV('compression.settings');
    const inState = window.zion?.state?.get?.('compression.settings');
    const merged = { ...defaults, ...(persisted || inState || {}) };
    if (!inState) {
      try { window.zion?.state?.set?.('compression.settings', merged); } catch {}
    }
    return merged;
  } catch {
    const panel = new CompressionSettingsPanel();
    return panel.getDefaultSettings();
  }
}

async function writeToFile(content) {
  // Implementation for writing content to temporary file
  const fileName = `compression-output-${Date.now()}.txt`;
  // Use Zion's file system API if available
  return `/tmp/${fileName}`;
}

function showSettingsPanel() {
  openCompressionPanel();
}

function showCompressionStats() {
  openCompressionPanel();
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

async function ensureDefaultSettings(SETTINGS_KV_KEY) {
  try {
    const existing = window.zion?.state?.get?.('compression.settings');
    if (existing) return;
    const persisted = await storageGetKV(SETTINGS_KV_KEY || 'compression.settings');
    const panel = new CompressionSettingsPanel();
    const defaults = panel.getDefaultSettings();
    const base = persisted || defaults;
    try { window.zion?.state?.set?.('compression.settings', base); } catch {}
    if (!persisted) {
      try { await storageSetKV(SETTINGS_KV_KEY || 'compression.settings', base); } catch {}
    }
  } catch {}
}

async function computeCompressionPreview(compressionEngine, opts) {
  const editor = window.zion.window.activeEditor;
  if (!editor) return null;
  const docText = editor.getValue();
  const sessionKey = getSessionKey();
  const sessionId = sessionKey.startsWith('session:') ? sessionKey.slice('session:'.length) : null;
  const messages = await buildMessagesForCompression(docText, sessionId);
  if (!messages.length) return null;

  const settings = await getCompressionSettings();
  syncEngineFromSettings(compressionEngine, settings);

  const strategy = opts?.strategy || 'auto';
  const context = compressionEngine.createCompressionContext(messages);
  const originalTokens = Number(context?.tokens || 0);
  const originalMessages = messages.length;

  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  let compressed = await compressionEngine.compress(messages, strategy);
  if (compressed === messages) {
    window.zion.notification?.show?.("当前没有可用的压缩结果。摘要压缩需要配置真实的摘要模型。", { type: 'info' });
    return { ok: false, error: 'compression_unavailable' };
  }
  compressed = sanitizeChatMessages(compressed, messages, { appendFinalUser: strategy !== 'progressive' });
  const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  const cpt = Number(compressionEngine?.config?.charsPerToken || 4);
  const compressedTokens = Math.floor(JSON.stringify(compressed).length / (cpt > 0 ? cpt : 4));
  const compressedMessages = Array.isArray(compressed) ? compressed.length : 0;
  const savedTokens = Math.max(0, originalTokens - compressedTokens);
  const savedPercent = originalTokens > 0 ? (savedTokens / originalTokens) : 0;

  const fullText = serializeMessages(compressed);
  const maxPreviewChars = 20000;
  const truncated = fullText.length > maxPreviewChars;
  const previewText = truncated ? fullText.slice(0, maxPreviewChars) : fullText;

  return {
    strategy,
    originalTokens,
    compressedTokens,
    savedTokens,
    savedPercent,
    originalMessages,
    compressedMessages,
    previewText,
    truncated,
    ms: Math.round((t1 - t0) * 100) / 100
  };
}

async function applyCompressionToActiveEditor(compressionEngine, opts) {
  if (usesRuntimeCompression()) return await runtimeCompact();
  const editor = window.zion.window.activeEditor;
  if (!editor) return { ok: false, error: 'no_editor' };
  const docText = editor.getValue();
  const sessionKey = getSessionKey();
  const sessionId = sessionKey.startsWith('session:') ? sessionKey.slice('session:'.length) : null;
  const annotations = sessionId ? await hydrateRemoteAnnotations(window.zion?.commands?.executeCommand?.('zion.chatCards.getSessionAnnotations', sessionId) || null) : null;
  const messages = await buildMessagesForCompression(docText, sessionId, annotations);
  if (!messages.length) return { ok: false, error: 'no_messages' };

  const settings = await getCompressionSettings();
  syncEngineFromSettings(compressionEngine, settings);
  const debug = !!settings?.debugLogging;

  const strategy = opts?.strategy || 'auto';
  const openPanel = opts?.openPanel !== false;
  const context = compressionEngine.createCompressionContext(messages);
  const originalTokens = Number(context?.tokens || 0);
  const originalMessages = messages.length;

  if (debug) {
    console.log('[context-compression]', 'manual compress: start', {
      strategy,
      messages: originalMessages,
      estTokens: originalTokens,
      sessionKey
    });
  }

  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  let compressed = await compressionEngine.compress(messages, strategy);
  compressed = sanitizeChatMessages(compressed, messages, { appendFinalUser: strategy !== 'progressive' });
  const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  const cpt = Number(compressionEngine?.config?.charsPerToken || 4);
  const compressedTokens = Math.floor(JSON.stringify(compressed).length / (cpt > 0 ? cpt : 4));
  const compressedMessages = Array.isArray(compressed) ? compressed.length : 0;
  const outText = serializeMessages(compressed);

  const now = Date.now();
  const groupId = makeVersionId(sessionKey);
  const beforeId = makeVersionId(sessionKey);
  const afterId = makeVersionId(sessionKey);
  const savedTokens = Math.max(0, originalTokens - compressedTokens);

  await storagePutVersion({
    id: beforeId,
    sessionKey,
    text: docText,
    annotations,
    meta: {
      createdAt: now,
      kind: 'before',
      groupId,
      strategy,
      tokens: originalTokens,
      messages: originalMessages
    }
  });

  await storagePutVersion({
    id: afterId,
    sessionKey,
    text: outText,
    annotations: null,
    meta: {
      createdAt: now,
      kind: 'after',
      groupId,
      strategy,
      tokens: compressedTokens,
      messages: compressedMessages,
      savedTokens,
      originalTokens,
      originalMessages
    }
  });

  const idx = await getVersionsIndex(sessionKey);
  const entryAfter = {
    id: afterId,
    createdAt: now,
    kind: 'after',
    groupId,
    strategy,
    tokens: compressedTokens,
    messages: compressedMessages,
    savedTokens,
    originalTokens,
    originalMessages
  };
  const entryBefore = {
    id: beforeId,
    createdAt: now,
    kind: 'before',
    groupId,
    strategy,
    tokens: originalTokens,
    messages: originalMessages
  };
  await setVersionsIndex(sessionKey, [entryAfter, entryBefore, ...idx]);
  await setActiveVersionId(sessionKey, afterId);

  editor.setValue(outText);
  recordCompressionEvent({ strategy, originalTokens, compressedTokens, timestamp: now });

  if (debug) {
    console.log('[context-compression]', 'manual compress: done', {
      strategy,
      beforeMessages: originalMessages,
      afterMessages: compressedMessages,
      beforeTokens: originalTokens,
      afterTokens: compressedTokens,
      savedTokens,
      ms: Math.round((t1 - t0) * 100) / 100
    });
  }

  if (openPanel) {
    openCompressionPanel({ tab: 'compress' });
  }

  return { ok: true, sessionKey, activeId: afterId };
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

  try {
    const progressive = compressionEngine.strategies?.get?.('progressive');
    progressive?.updateOptions?.({
      threshold: settings.threshold,
      keepRecentTurns: Number(settings.progressiveKeepRecentTurns),
      maxRecordPromptChars: Number(settings.progressiveMaxRecordPromptChars),
      tokensProtect: Number(settings.progressiveTokensProtect),
      tokensCompact: Number(settings.progressiveTokensCompact),
      recentProtectTokens: Number(settings.progressiveRecentProtectTokens)
    });
  } catch {}
}

function sanitizeChatMessages(compressed, original, opts = {}) {
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
  const flattenContentToText = (content) => {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts = [];
      for (const part of content) {
        if (typeof part === 'string') { parts.push(part); continue; }
        const t = part?.type;
        if (t === 'text' || t === 'thinking') {
          parts.push(String(part?.text || ''));
        } else if (t === 'image_url') {
          const url = part?.image_url?.url || '';
          if (url) parts.push(`![image](${url})`);
        } else {
          try { parts.push(JSON.stringify(part)); } catch { parts.push(String(part)); }
        }
      }
      return parts.join('\n');
    }
    if (typeof content === 'object') {
      try { return JSON.stringify(content); } catch { return String(content); }
    }
    return String(content);
  };

  for (const m of inMsgs) {
    const role = String(m?.role || '');
    if (!allowedRoles.has(role)) continue;

    if (role === 'tool') {
      const id = m?.tool_call_id != null ? String(m.tool_call_id) : '';
      if (!id || !assistantToolCallIds.has(id)) {
        continue;
      }
      const content = flattenContentToText(m?.content);
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
      let content = flattenContentToText(m?.content);
      content = stripWidgetStubs(content);
      if (tool_calls.length > 0) {
        out.push(content ? { role: 'assistant', content, tool_calls } : { role: 'assistant', tool_calls });
      } else {
        if (content) out.push({ role: 'assistant', content });
      }
      continue;
    }

    let content = flattenContentToText(m?.content);
    if (role === 'assistant') {
      content = stripWidgetStubs(content);
      if (!content) continue;
    }
    out.push({ role, content });
  }

  const lastRole = out.length > 0 ? out[out.length - 1].role : null;
  const shouldAppendFinalUser = opts?.appendFinalUser !== false;
  const orig = Array.isArray(original) ? original : [];
  const originalLastRole = orig.length > 0 ? String(orig[orig.length - 1]?.role || '') : null;
  if (shouldAppendFinalUser && originalLastRole === 'user' && lastRole !== 'user') {
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

function stripWidgetStubs(text) {
  if (text == null) return '';
  const s = String(text);
  const lines = s.replace(/\r/g, '').split('\n');
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isContinuationBoundaryLine(line)) continue;
    if (/^(思考|Thinking)(?:\s*<!--\s*zion-thinking:id=[^>\s]+\s*-->)?$/i.test(trimmed)) continue;
    if (/^(?:调用|Call)\s+[^\n<]+(?:\s*<!--\s*zion-tool:id=[^>\s]+\s*-->)?$/i.test(trimmed)) continue;
    // Strip leading role headers like "system|user|assistant <content>"
    const roleMatch = trimmed.match(/^(system|user|assistant)\s+(.*)$/);
    if (roleMatch) {
      const body = (roleMatch[1] === 'assistant'
        ? stripAssistantBlockIdComment(roleMatch[2])
        : roleMatch[2]).trim();
      if (body) out.push(body);
      continue;
    }
    out.push(line);
  }
  return out.join('\n').trim();
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
    const continuation = isContinuationBoundaryLine(line);

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
      const contentPart = continuation
        ? ""
        : currentRole === 'assistant'
        ? stripAssistantBlockIdComment(roleMatch[2])
        : roleMatch[2];
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
      else if (part?.type === 'thinking') out.push(String(part.text || ''));
      else if (part?.type === 'image_url') out.push(`![image](${part?.image_url?.url || ''})`);
      else out.push(typeof part === 'string' ? part : JSON.stringify(part));
    }
    return out.join('\n');
  }
  return typeof content === 'object' ? JSON.stringify(content) : String(content);
}

function openCompressionPanel(opts) {
  if (!__settingsPanelSingleton) __settingsPanelSingleton = new CompressionSettingsPanel();
  __settingsPanelSingleton.show({ tab: opts?.tab });
}

function openStatsOverlay() {
  const id = 'zion-compression-stats-overlay';
  const existing = document.getElementById(id);
  if (existing) existing.remove();

  const root = document.createElement('div');
  root.id = id;
  Object.assign(root.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '1000',
    display: 'block'
  });

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    position: 'fixed',
    top: '48px',
    right: '12px',
    width: '360px',
    maxWidth: 'calc(100vw - 16px)',
    maxHeight: '65vh',
    overflow: 'auto',
    background: 'var(--panel)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    boxShadow: '0 12px 32px rgba(0,0,0,0.32)',
    padding: '8px',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
    pointerEvents: 'auto'
  });

  const stats = window.zion.state.get('compression.stats') || {};
  const strategies = stats.strategyUsage || {};
  const savingsByStrategy = stats.tokenSavingsByStrategy || {};
  const last = stats.lastCompressionTime ? new Date(stats.lastCompressionTime).toLocaleString() : '-';
  const totalSaved = Number(stats.totalTokensSaved || 0);
  const count = Number(stats.compressionCount || 0);

  const styles = document.createElement('style');
  styles.textContent = `
.compression-stats-view{font-size:13px}
.compression-stats-view .header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.compression-stats-view .header-title{font-weight:600;font-size:14px}
.compression-stats-view .btn-close{background:transparent;border:none;color:var(--fg);cursor:pointer;font-size:18px;padding:2px 6px;border-radius:4px;opacity:0.7}
.compression-stats-view .btn-close:hover{background:var(--border);opacity:1}
.compression-stats-view .stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px}
.compression-stats-view .stat-card{background:rgba(0,0,0,0.04);border:1px solid var(--border);border-radius:6px;padding:10px;text-align:center}
:root[data-theme="light"] .compression-stats-view .stat-card{background:rgba(0,0,0,0.02)}
.compression-stats-view .stat-label{font-size:11px;opacity:0.7;margin-bottom:4px}
.compression-stats-view .stat-value{font-size:16px;font-weight:600}
.compression-stats-view .section-title{font-size:11px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;opacity:0.8;margin:12px 0 8px 0}
.compression-stats-view .usage-list{display:flex;flex-direction:column;gap:6px}
.compression-stats-view .usage-item{display:grid;grid-template-columns:100px 1fr 60px;gap:8px;align-items:center}
.compression-stats-view .usage-name{font-size:12px;opacity:0.8}
.compression-stats-view .usage-bar{height:6px;background:var(--border);border-radius:3px;overflow:hidden}
.compression-stats-view .usage-fill{height:100%;background:var(--accent);transition:width 0.3s}
.compression-stats-view .usage-count{font-size:11px;opacity:0.75;text-align:right}
.compression-stats-view .footer{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;padding-top:12px;border-top:1px solid var(--border)}
.compression-stats-view .btn{padding:6px 12px;border-radius:6px;border:1px solid var(--border);font-size:12px;cursor:pointer}
.compression-stats-view .btn:hover{filter:brightness(1.08)}
.compression-stats-view .btn-primary{background:var(--accent);color:var(--panel)}
.compression-stats-view .btn-secondary{background:transparent;color:var(--fg)}
`;
  panel.appendChild(styles);

  const container = document.createElement('div');
  container.className = 'compression-stats-view';

  const total = Object.values(strategies).reduce((a, b) => a + b, 0);

  container.innerHTML = `
    <div class="header">
      <div class="header-title">📊 Compression Statistics</div>
      <button class="btn-close">✕</button>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Saved</div>
        <div class="stat-value">${formatTokens(totalSaved)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Compressions</div>
        <div class="stat-value">${count}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Last Compression</div>
        <div class="stat-value" style="font-size:12px">${last}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Avg Per Run</div>
        <div class="stat-value">${count > 0 ? formatTokens(totalSaved / count) : '0'}</div>
      </div>
    </div>

    <div class="section-title">Strategy Usage</div>
    <div class="usage-list">
      ${Object.entries(strategies).map(([k, c]) => {
        const s = savingsByStrategy[k] || 0;
        const pct = total > 0 ? (c / total * 100).toFixed(1) : 0;
        return `
          <div class="usage-item">
            <div class="usage-name">${k}</div>
            <div class="usage-bar">
              <div class="usage-fill" style="width: ${pct}%"></div>
            </div>
            <div class="usage-count">${c}x</div>
          </div>
        `;
      }).join('')}
    </div>

    <div class="footer">
      <button class="btn btn-secondary" id="btn-reset">Reset</button>
      <button class="btn btn-primary" id="btn-close">Close</button>
    </div>
  `;

  panel.appendChild(container);
  root.appendChild(panel);
  document.body.appendChild(root);
  positionStatsOverlayPanel(panel);

  // Event handlers
  root.addEventListener('click', (e) => {
    if (e.target === root) {
      root.remove();
    }
  });

  panel.querySelector('.btn-close').addEventListener('click', () => root.remove());
  panel.querySelector('#btn-close').addEventListener('click', () => root.remove());
  panel.querySelector('#btn-reset').addEventListener('click', () => {
    window.zion.state.set('compression.stats', {
      totalTokensSaved: 0,
      compressionCount: 0,
      strategyUsage: {},
      tokenSavingsByStrategy: {}
    });
    root.remove();
  });
}

function positionStatsOverlayPanel(panel) {
  const btn = document.querySelector('[data-zion-status-id="compression.status"]')
    || Array.from(document.querySelectorAll('#bottombar .status-item, #statusbar .status-item'))
      .find((b) => b.textContent?.includes('Ctx:'));
  const pad = 8;
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  panel.style.left = '';
  panel.style.right = '';
  panel.style.top = '';
  panel.style.bottom = '';
  panel.style.maxHeight = 'min(75vh, calc(100vh - 24px))';
  if (!btn) {
    panel.style.right = '12px';
    panel.style.bottom = '36px';
    return;
  }
  const rect = btn.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const mw = Math.min(panelRect.width || 380, Math.max(240, vw - pad * 2));
  const spaceAbove = Math.max(180, rect.top - pad * 2);
  panel.style.maxHeight = `${Math.min(Math.round(vh * 0.75), spaceAbove)}px`;
  const mh = Math.min(panelRect.height || 420, spaceAbove);
  const left = Math.max(pad, Math.min(Math.round(rect.right - mw), Math.max(pad, vw - mw - pad)));
  const top = Math.max(pad, Math.round(rect.top - pad - mh));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}
