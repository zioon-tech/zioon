import { search, searchKeymap } from '@codemirror/search';
import { Decoration, ViewPlugin, keymap } from '@codemirror/view';
import { createConversationSearchPanel, computeConversationSearchMatches } from '../../src/editor/search-panel';

// 移除默认的搜索快捷键，使用我们自定义的
const filteredSearchKeymap = searchKeymap.filter(binding => 
  !['Mod-f', 'Mod-F3', 'Shift-Mod-F3', 'Mod-g', 'Shift-Mod-g', 'Mod-Alt-g', 'Mod-d'].includes(binding.key)
);

const I18N_NS = 'dev.search-replace';
const I18N_MESSAGES = {
  'zh-CN': {
    'category.search': '搜索',
    'cmd.show': '显示搜索',
    'cmd.showWithReplace': '显示搜索和替换',
    'cmd.hide': '隐藏搜索',
    'cmd.next': '下一个匹配',
    'cmd.prev': '上一个匹配',
    'cmd.selectAll': '选择所有匹配',
    'cmd.replace': '替换当前匹配',
    'cmd.replaceAll': '替换所有匹配',
    'ui.search': '搜索',
    'ui.replace': '替换',
    'ui.showReplace': '显示替换',
    'ui.hideReplace': '隐藏替换',
    'ui.prev': '上一个匹配',
    'ui.next': '下一个匹配',
    'ui.selectAll': '选择所有匹配',
    'ui.close': '关闭',
    'ui.replaceCurrent': '替换',
    'ui.all': '全部',
    'ui.matchCase': '区分大小写',
    'ui.wholeWord': '全字匹配',
    'ui.regex': '正则表达式',
    'ui.replaced': '已替换 {count} 个',
    'ui.noResults': '无结果'
    , 'ui.invalidRegex': '无效正则'
  },
  'en-US': {
    'category.search': 'Search',
    'cmd.show': 'Show Search',
    'cmd.showWithReplace': 'Show Search and Replace',
    'cmd.hide': 'Hide Search',
    'cmd.next': 'Next Match',
    'cmd.prev': 'Previous Match',
    'cmd.selectAll': 'Select All Matches',
    'cmd.replace': 'Replace Current Match',
    'cmd.replaceAll': 'Replace All Matches',
    'ui.search': 'Search',
    'ui.replace': 'Replace',
    'ui.showReplace': 'Show replace',
    'ui.hideReplace': 'Hide replace',
    'ui.prev': 'Previous Match',
    'ui.next': 'Next Match',
    'ui.selectAll': 'Select All Matches',
    'ui.close': 'Close',
    'ui.replaceCurrent': 'Replace',
    'ui.all': 'All',
    'ui.matchCase': 'Match case',
    'ui.wholeWord': 'Whole word',
    'ui.regex': 'Regex',
    'ui.replaced': 'Replaced {count}',
    'ui.noResults': 'No results'
    , 'ui.invalidRegex': 'Invalid regex'
  }
};

export function createConversationSearchController(ctx, host, options = {}) {
let searchExtension = null;
let isSearchVisible = false;
function t(key, fallback, values) {
  if (options.translate) return options.translate(key, fallback, values);
  const fullKey = `${I18N_NS}.${key}`;
  try {
    const translated = host?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

function buildSearchDecorations(view) {
  if (!host?.state?.get?.('searchReplace.visible')) return Decoration.none;
  const query = host?.state?.get?.('searchReplace.query') || '';
  if (!query) return Decoration.none;

  const caseSensitive = !!host?.state?.get?.('searchReplace.caseSensitive');
  const wholeWord = !!host?.state?.get?.('searchReplace.wholeWord');
  const regex = !!host?.state?.get?.('searchReplace.regex');
  const builder = [];
  const selected = view.state.selection.main;
  const { ranges } = options.matches ? options.matches(query, { caseSensitive, wholeWord, regex })
    : computeConversationSearchMatches(view.state.doc.toString(), query, { caseSensitive, wholeWord, regex });
  for (const { from, to } of ranges) {
    if (!view.visibleRanges.some(range => from < range.to && to > range.from)) continue;
    const isSelected = !selected.empty && selected.from === from && selected.to === to;
    builder.push(Decoration.mark({ class: isSelected ? 'cm-searchMatch cm-searchMatch-selected' : 'cm-searchMatch' }).range(from, to));
  }
  return Decoration.set(builder, true);
}

const searchHighlightExtension = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = buildSearchDecorations(view);
  }

  update(update) {
    this.decorations = buildSearchDecorations(update.view);
  }
}, {
  decorations: value => value.decorations
});

function refreshSearchHighlights() {
  try {
    host?.window?.activeEditor?.getView?.()?.dispatch({});
  } catch {}
}

function install() {
  try {
    const disp = host.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

  // 初始化搜索扩展
  searchExtension = search();
  
  // 注册命令
  const commands = [
    host.commands.registerCommand('searchReplace.show', () => showSearchPanel(false)),
    host.commands.registerCommand('searchReplace.hide', hideSearchPanel),
    host.commands.registerCommand('searchReplace.next', findNext),
    host.commands.registerCommand('searchReplace.prev', findPrevious),
    host.commands.registerCommand('searchReplace.selectAll', selectAllMatches),
    ...(options.readOnly ? [] : [
      host.commands.registerCommand('searchReplace.showWithReplace', () => showSearchPanel(true)),
      host.commands.registerCommand('searchReplace.replace', replaceCurrent),
      host.commands.registerCommand('searchReplace.replaceAll', replaceAll)
    ])
  ];
  
  commands.forEach(cmd => ctx.subscriptions.push(cmd));

  // 注册 keybindings 到全局注册表，这样 Registry 会把它们合并到编辑器 keymap
  const kbs = [
    host.keybindings.register({ command: 'searchReplace.show', key: 'Mod-f', when: 'editorFocus' }),
    host.keybindings.register({ command: 'searchReplace.hide', key: 'Escape', when: 'searchReplaceVisible' }),
    host.keybindings.register({ command: 'searchReplace.next', key: 'Enter', when: 'searchReplaceVisible' }),
    host.keybindings.register({ command: 'searchReplace.prev', key: 'Shift-Enter', when: 'searchReplaceVisible' }),
    host.keybindings.register({ command: 'searchReplace.selectAll', key: 'Alt-Enter', when: 'searchReplaceVisible' }),
    ...(options.readOnly ? [] : [host.keybindings.register({ command: 'searchReplace.showWithReplace', key: 'Mod-h', when: 'editorFocus' })])
  ];
  kbs.forEach(k => ctx.subscriptions.push(k));

  // 注册装饰器来注入搜索扩展
  const decorator = host.editor.registerDecorator({
    id: 'dev.search-replace',
    apply(editor) {
      // 注入搜索扩展和过滤后的快捷键
      editor.addVisualExtension([
        searchExtension,
        searchHighlightExtension,
        keymap.of(filteredSearchKeymap)
      ]);
      return { dispose() {} };
    }
  });
  ctx.subscriptions.push(decorator);
  
  // 监听编辑器焦点变化，更新搜索面板状态
  const focusListener = host.events.on('editor.focusChanged', () => {
    updateSearchPanelVisibility();
    if (isSearchVisible) {
      try { ensureSearchPanel(); } catch {}
    }
  });
  ctx.subscriptions.push(focusListener);
  ctx.subscriptions.push(host.events.on('i18n/changed', () => {
    if (!searchPanel || !isSearchVisible) return;
    try {
      searchPanel.remove();
      searchPanel = null;
      ensureSearchPanel();
      updateSearch();
    } catch {}
  }));
}

function showSearchPanel(withReplace = false) {
  const editor = host.window.activeEditor;
  if (!editor) return;
  
  // 获取当前选区文本作为搜索词
  const selection = editor.getSelection();
  if (selection) {
    host.state.set('searchReplace.query', selection);
  }
  
  host.state.set('searchReplace.visible', true);
  host.state.set('searchReplace.withReplace', withReplace && !options.readOnly);
  isSearchVisible = true;
  
  // 创建或显示搜索面板
  ensureSearchPanel();

  // 用选区填充输入框并同步到 CM6 SearchQuery
  const input = queryControl('#search-input');
  if (input && selection) {
    input.value = selection;
  }
  // 回填替换框的上次内容
  const replaceInput = queryControl('#replace-input');
  const prevReplace = host.state.get('searchReplace.replace') || '';
  if (replaceInput && typeof prevReplace === 'string') {
    replaceInput.value = prevReplace;
  }
  updateSearch(); // 推送查询并刷新计数

  focusSearchInput();
}

function hideSearchPanel() {
  host.state.set('searchReplace.visible', false);
  if (!options.readOnly) host.state.set('selectionToolbar.suppressUntil', Date.now() + 900);
  isSearchVisible = false;
  hideCustomPanel();
  refreshSearchHighlights();
  
  // 焦点回到编辑器
  const editor = host.window.activeEditor;
  editor?.focus();
}

function findNext() {
  // 通过执行 CM6 的搜索命令
  host.commands.executeCommand('findNext');
  updateSearch();
}

function findPrevious() {
  host.commands.executeCommand('findPrev');
  updateSearch();
}

function selectAllMatches() {
  host.commands.executeCommand('selectMatches');
  updateSearch();
}

function replaceCurrent() {
  if (options.readOnly) return;
  // 在替换前将 replace 同步到 CM6 的 SearchQuery
  const editor = host.window.activeEditor;
  const before = editor?.getValue?.() ?? '';
  if (searchPanel) {
    const query = host.state.get('searchReplace.query') || '';
    const replaceVal = (queryControl('#replace-input')?.value || '');
    const caseSensitive = !!(queryControl('#case-sensitive')?.checked);
    const wholeWord = !!(queryControl('#whole-word')?.checked);
    const regex = !!(queryControl('#regex')?.checked);
    host.commands.executeCommand('setSearchQuery', {
      search: query,
      replace: replaceVal,
      caseSensitive,
      wholeWord,
      regexp: regex
    });
  }
  host.commands.executeCommand('replaceNext');
  // 简单反馈：如果内容发生变化，提示“Replaced 1”
  const after = editor?.getValue?.() ?? '';
  if (after !== before) {
    __showSearchStatus(t('ui.replaced', 'Replaced {count}', { count: 1 }));
  }
}

function replaceAll() {
  if (options.readOnly) return;
  let count = 0;
  if (searchPanel) {
    const query = host.state.get('searchReplace.query') || '';
    const replaceVal = (queryControl('#replace-input')?.value || '');
    const caseSensitive = !!(queryControl('#case-sensitive')?.checked);
    const wholeWord = !!(queryControl('#whole-word')?.checked);
    const regex = !!(queryControl('#regex')?.checked);

    // 统计替换总数（基于当前内容与选项）
    const ed = host.window.activeEditor;
    const text = ed?.getValue?.() || '';
    try {
      const ranges = __computeMatches(text, query, { caseSensitive, wholeWord, regex });
      count = ranges.length;
    } catch {}

    host.commands.executeCommand('setSearchQuery', {
      search: query,
      replace: replaceVal,
      caseSensitive,
      wholeWord,
      regexp: regex
    });
  }
  host.commands.executeCommand('replaceAll');
  __showSearchStatus(t('ui.replaced', 'Replaced {count}', { count }));
}

function updateSearchPanelVisibility() {
  // 当编辑器失去焦点时隐藏搜索面板
  if (isSearchVisible) {
    const editor = host.window.activeEditor;
    if (!editor) {
      hideSearchPanel();
    }
  }
}

// 自定义搜索面板的 DOM 操作
let searchPanel = null;

function getSearchPanelHost() {
  try {
    const editor = host.window.activeEditor;
    const view = editor?.getView?.();
    const editorDom = view?.dom || null;
    const editorHost = editorDom?.closest?.('.zion-editor-host');
    if (editorHost && editorHost instanceof HTMLElement) return editorHost;
  } catch {}
  try {
    const panelId = host?.panels?.getActivePanelId?.();
    if (panelId) {
      const escapedPanelId = globalThis.CSS?.escape
        ? globalThis.CSS.escape(String(panelId))
        : String(panelId).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      const panelRoot = document.querySelector(`[data-panel-id="${escapedPanelId}"]`);
      const editorHost = panelRoot?.querySelector?.('.zion-editor-host');
      if (editorHost && editorHost instanceof HTMLElement) return editorHost;
    }
  } catch {}
  if (options.readOnly) return null;
  return document.querySelector('.zion-editor-host') || document.querySelector('#app > div') || document.getElementById('app');
}

function attachSearchPanelToActiveHost() {
  if (!searchPanel) return;
  const editorHost = getSearchPanelHost();
  if (editorHost && editorHost instanceof HTMLElement) {
    const pos = getComputedStyle(editorHost).position;
    if (!pos || pos === 'static') editorHost.style.position = 'relative';
    if (searchPanel.parentElement !== editorHost) {
      editorHost.appendChild(searchPanel);
    }
  } else if (searchPanel.parentElement !== document.body) {
    document.body.appendChild(searchPanel);
  }
}

function queryControl(selector) {
  const scoped = /^#[\w-]+$/.test(selector) ? `[data-search-control="${selector.slice(1)}"]` : selector;
  return searchPanel?.querySelector(scoped) || null;
}

function ensureSearchPanel() {
  if (!searchPanel) {
    searchPanel = createConversationSearchPanel({ translate: t, readOnly: options.readOnly, idPrefix: options.idPrefix });
    // Append the panel into the editor host so position:absolute is relative to the editor content (not tabs bar)
    attachSearchPanelToActiveHost();
    
    // 事件监听
    setupEventListeners();
  }
  attachSearchPanelToActiveHost();
  
  // 显示/隐藏替换区域
  const replaceSection = queryControl('#replace-section');
  const withReplace = host.state.get('searchReplace.withReplace');
  if (replaceSection) replaceSection.style.display = withReplace ? 'block' : 'none';
  // 更新“Replace”切换按钮的文案（使用紧凑图标并保留 tooltip）
  const toggleBtn = queryControl('#toggle-replace-btn');
  if (toggleBtn) {
    toggleBtn.textContent = withReplace ? '▴' : '▾';
    toggleBtn.title = withReplace ? t('ui.hideReplace', 'Hide replace') : t('ui.showReplace', 'Show replace');
  }
  
  searchPanel.style.display = 'block';
}

function hideCustomPanel() {
  if (searchPanel) {
    searchPanel.style.display = 'none';
  }
}

function focusSearchInput() {
  if (searchPanel) {
    const input = queryControl('#search-input');
    input?.focus();
    input?.select();
  }
}

function setupEventListeners() {
  if (!searchPanel) return;
  
  const searchInput = queryControl('#search-input');
  const replaceInput = queryControl('#replace-input');
  const closeBtn = queryControl('#close-btn');
  const replaceBtn = queryControl('#replace-btn');
  const replaceAllBtn = queryControl('#replace-all-btn');
  const caseCheckbox = queryControl('#case-sensitive');
  const wholeWordCheckbox = queryControl('#whole-word');
  const regexCheckbox = queryControl('#regex');
  const prevBtn = queryControl('#prev-btn');
  const nextBtn = queryControl('#next-btn');
  const selectAllBtn = queryControl('#select-all-btn');
  const toggleReplaceBtn = queryControl('#toggle-replace-btn');
  
  // 关闭按钮
  closeBtn?.addEventListener('click', hideSearchPanel);

  // 上一/下一/选择所有 按钮
  prevBtn?.addEventListener('click', findPrevious);
  nextBtn?.addEventListener('click', findNext);
  selectAllBtn?.addEventListener('click', selectAllMatches);

  // 展开/收起替换框
  toggleReplaceBtn?.addEventListener('click', () => {
    const withReplace = !!host.state.get('searchReplace.withReplace');
    const next = !withReplace;
    host.state.set('searchReplace.withReplace', next);
    const replaceSection = queryControl('#replace-section');
    if (replaceSection) replaceSection.style.display = next ? 'block' : 'none';
    const btn = queryControl('#toggle-replace-btn');
    if (btn) {
      btn.textContent = next ? '▴' : '▾';
      btn.title = next ? t('ui.hideReplace', 'Hide replace') : t('ui.showReplace', 'Show replace');
    }
    if (next) {
      const rInput = queryControl('#replace-input');
      rInput?.focus();
      rInput?.select?.();
    }
  });
  
  // 搜索输入
  searchInput?.addEventListener('input', (e) => {
    // 自动高度调整
    if (searchInput) {
      searchInput.style.height = 'auto';
      searchInput.style.height = Math.min(searchInput.scrollHeight, 80) + 'px';
    }
    host.state.set('searchReplace.query', e.target.value);
    updateSearch();
  });

  searchInput?.addEventListener('keydown', (e) => {
    // 键盘行为：
    // - Enter: 下一个
    // - Shift+Enter: 上一个
    // - Cmd/Ctrl+Enter: 全选
    // - Option/Alt+Enter: 换行
    if (e.key === 'Enter') {
      if (e.altKey) {
        e.preventDefault();
        // 真正插入换行符
        const { selectionStart, selectionEnd } = e.target;
        const before = e.target.value.slice(0, selectionStart);
        const after = e.target.value.slice(selectionEnd);
        e.target.value = before + '\n' + after;
        e.target.selectionStart = e.target.selectionEnd = selectionStart + 1;
        // 触发 input 事件以更新状态并自适应高度
        e.target.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        selectAllMatches();
      } else if (e.shiftKey) {
        findPrevious();
      } else {
        findNext();
      }
      // 下一帧刷新 current/total（等待 CM6 装饰更新后再读取 DOM）
      requestAnimationFrame(() => updateSearch());
    } else if (e.key === 'Escape') {
      hideSearchPanel();
    }
  });
  
  // 替换输入
  replaceInput?.addEventListener('keydown', (e) => {
    // 键盘行为：
    // - Enter: 替换当前（不换行）
    // - Cmd/Ctrl+Enter: 替换全部
    // - Option/Alt+Enter: 换行
    if (e.key === 'Enter') {
      if (e.altKey) {
        e.preventDefault();
        // 真正插入换行符
        const { selectionStart, selectionEnd } = e.target;
        const before = e.target.value.slice(0, selectionStart);
        const after = e.target.value.slice(selectionEnd);
        e.target.value = before + '\n' + after;
        e.target.selectionStart = e.target.selectionEnd = selectionStart + 1;
        e.target.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        replaceAll();
      } else {
        replaceCurrent();
      }
    } else if (e.key === 'Escape') {
      hideSearchPanel();
    }
  });
  // 替换输入内容变化（自适应高度 + 同步状态）
  replaceInput?.addEventListener('input', (e) => {
    if (replaceInput) {
      replaceInput.style.height = 'auto';
      replaceInput.style.height = Math.min(replaceInput.scrollHeight, 80) + 'px';
    }
    host.state.set('searchReplace.replace', e.target.value);
    updateSearch();
  });
  
  // 替换按钮
  replaceBtn?.addEventListener('click', replaceCurrent);
  replaceAllBtn?.addEventListener('click', replaceAll);
  
  // 选项变化
  [caseCheckbox, wholeWordCheckbox, regexCheckbox].forEach(checkbox => {
    checkbox?.addEventListener('change', updateSearchOptions);
  });
}

// Helper: 计算匹配范围（用于统计/反馈）
function __computeMatches(text, query, { caseSensitive, wholeWord, regex }) {
  return options.matches ? options.matches(query, { caseSensitive, wholeWord, regex }).ranges
    : computeConversationSearchMatches(text, query, { caseSensitive, wholeWord, regex }).ranges;
}

// Helper: 在计数位置短暂显示反馈消息
let __srStatusTimer = null;
function __showSearchStatus(msg) {
  const el = queryControl('#match-count');
  if (!el) return;
  el.textContent = msg;
  if (__srStatusTimer) {
    clearTimeout(__srStatusTimer);
    __srStatusTimer = null;
  }
  __srStatusTimer = setTimeout(() => {
    __srStatusTimer = null;
    try { updateSearch(); } catch {}
  }, 1000);
}

function updateSearch() {
  if (!searchPanel) return;
  const query = host.state.get('searchReplace.query') || '';
  const replaceVal = (queryControl('#replace-input')?.value || '');
  const caseSensitive = !!(queryControl('#case-sensitive')?.checked);
  const wholeWord = !!(queryControl('#whole-word')?.checked);
  const regex = !!(queryControl('#regex')?.checked);
  const ed = host.window.activeEditor;

  host.state.set('searchReplace.replace', replaceVal);

  host.commands.executeCommand('setSearchQuery', {
    search: query,
    replace: replaceVal,
    caseSensitive,
    wholeWord,
    regexp: regex
  });
  refreshSearchHighlights();

  const text = ed?.getValue?.() || '';

  const result = options.matches ? options.matches(query, { caseSensitive, wholeWord, regex })
    : computeConversationSearchMatches(text, query, { caseSensitive, wholeWord, regex });
  const ranges = result.ranges;
  const count = ranges.length;
  queryControl('#search-input')?.setAttribute('aria-invalid', String(result.invalid));
  for (const id of ['prev-btn', 'next-btn', 'select-all-btn']) {
    const control = queryControl(`#${id}`);
    if (control) control.disabled = result.invalid || !count;
  }

  let current = 0;
  if (query && count > 0 && ed?.getCursor) {
    const pos = ed.getCursor();
    const offsetAt = (t, p) => {
      const lines = t.split('\n');
      let off = 0;
      const upto = Math.min(p.line, lines.length - 1);
      for (let i = 0; i < upto; i++) off += lines[i].length + 1;
      off += p.ch;
      return off;
    };
    const off = offsetAt(text, pos);

    let idx = ranges.findIndex(r => r.to === off);
    if (idx < 0) idx = ranges.findIndex(r => off >= r.from && off <= r.to);

    if (idx < 0 && ed.getSelection) {
      const selText = ed.getSelection() || '';
      if (selText) {
        const eq = (a, b) => (caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase());
        idx = ranges.findIndex(r => eq(text.slice(r.from, r.to), selText));
      }
    }
    if (idx >= 0) current = idx + 1;
  }

  const matchCount = queryControl('#match-count');
  if (matchCount) {
    if (result.invalid) {
      matchCount.textContent = t('ui.invalidRegex', 'Invalid regex');
    } else if (!query) {
      matchCount.textContent = '';
    } else if (count === 0) {
      matchCount.textContent = t('ui.noResults', 'No results');
    } else {
      matchCount.textContent = `${current}/${count}`;
    }
  }
}

function updateSearchOptions() {
  if (!searchPanel) return;
  
  const caseSensitive = queryControl('#case-sensitive').checked;
  const wholeWord = queryControl('#whole-word').checked;
  const regex = queryControl('#regex').checked;
  
  host.state.set('searchReplace.caseSensitive', caseSensitive);
  host.state.set('searchReplace.wholeWord', wholeWord);
  host.state.set('searchReplace.regex', regex);
  
  // 重新搜索
  updateSearch();
}

install();
return {
  show: () => showSearchPanel(), hide: hideSearchPanel, refresh: updateSearch,
  get panel() { return searchPanel; },
  dispose() {
    if (__srStatusTimer) clearTimeout(__srStatusTimer);
    searchPanel?.remove();
    searchPanel = null;
    for (const item of ctx.subscriptions.splice(0).reverse()) item?.dispose?.();
  }
};
}

export function activate(ctx) { return createConversationSearchController(ctx, window.zion); }
