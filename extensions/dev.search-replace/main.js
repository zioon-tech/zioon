import { search, searchKeymap } from '@codemirror/search';
import { Decoration, ViewPlugin, keymap } from '@codemirror/view';

// 移除默认的搜索快捷键，使用我们自定义的
const filteredSearchKeymap = searchKeymap.filter(binding => 
  !['Mod-f', 'Mod-F3', 'Shift-Mod-F3', 'Mod-g', 'Shift-Mod-g', 'Mod-Alt-g', 'Mod-d'].includes(binding.key)
);

let searchExtension = null;
let isSearchVisible = false;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchDecorations(view) {
  if (!window.zion?.state?.get?.('searchReplace.visible')) return Decoration.none;
  const query = window.zion?.state?.get?.('searchReplace.query') || '';
  if (!query) return Decoration.none;

  const caseSensitive = !!window.zion?.state?.get?.('searchReplace.caseSensitive');
  const wholeWord = !!window.zion?.state?.get?.('searchReplace.wholeWord');
  const regex = !!window.zion?.state?.get?.('searchReplace.regex');
  const source = regex ? query : escapeRegExp(query);
  const boundary = wholeWord ? '\\b' : '';
  let re;
  try {
    re = new RegExp(`${boundary}${source}${boundary}`, caseSensitive ? 'g' : 'gi');
  } catch {
    return Decoration.none;
  }

  const builder = [];
  const selected = view.state.selection.main;
  for (const range of view.visibleRanges) {
    const text = view.state.doc.sliceString(range.from, range.to);
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const from = range.from + match.index;
      const to = from + match[0].length;
      if (to > from) {
        const isSelected = !selected.empty && selected.from === from && selected.to === to;
        builder.push(Decoration.mark({ class: isSelected ? 'cm-searchMatch cm-searchMatch-selected' : 'cm-searchMatch' }).range(from, to));
      }
      if (match.index === re.lastIndex) re.lastIndex++;
    }
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
    window.zion?.window?.activeEditor?.getView?.()?.dispatch({});
  } catch {}
}

export async function activate(ctx) {
  // 初始化搜索扩展
  searchExtension = search();
  
  // 注册命令
  const commands = [
    window.zion.commands.registerCommand('searchReplace.show', () => showSearchPanel(false)),
    window.zion.commands.registerCommand('searchReplace.showWithReplace', () => showSearchPanel(true)),
    window.zion.commands.registerCommand('searchReplace.hide', hideSearchPanel),
    window.zion.commands.registerCommand('searchReplace.next', findNext),
    window.zion.commands.registerCommand('searchReplace.prev', findPrevious),
    window.zion.commands.registerCommand('searchReplace.selectAll', selectAllMatches),
    window.zion.commands.registerCommand('searchReplace.replace', replaceCurrent),
    window.zion.commands.registerCommand('searchReplace.replaceAll', replaceAll)
  ];
  
  commands.forEach(cmd => ctx.subscriptions.push(cmd));

  // 注册 keybindings 到全局注册表，这样 Registry 会把它们合并到编辑器 keymap
  const kbs = [
    window.zion.keybindings.register({ command: 'searchReplace.show', key: 'Mod-f', when: 'editorFocus' }),
    window.zion.keybindings.register({ command: 'searchReplace.showWithReplace', key: 'Mod-h', when: 'editorFocus' }),
    window.zion.keybindings.register({ command: 'searchReplace.hide', key: 'Escape', when: 'searchReplaceVisible' }),
    window.zion.keybindings.register({ command: 'searchReplace.next', key: 'Enter', when: 'searchReplaceVisible' }),
    window.zion.keybindings.register({ command: 'searchReplace.prev', key: 'Shift-Enter', when: 'searchReplaceVisible' }),
    window.zion.keybindings.register({ command: 'searchReplace.selectAll', key: 'Alt-Enter', when: 'searchReplaceVisible' })
  ];
  kbs.forEach(k => ctx.subscriptions.push(k));

  // 注册装饰器来注入搜索扩展
  const decorator = window.zion.editor.registerDecorator({
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
  const focusListener = window.zion.events.on('editor.focusChanged', () => {
    updateSearchPanelVisibility();
    if (isSearchVisible) {
      try { ensureSearchPanel(); } catch {}
    }
  });
  ctx.subscriptions.push(focusListener);
}

function showSearchPanel(withReplace = false) {
  const editor = window.zion.window.activeEditor;
  if (!editor) return;
  
  // 获取当前选区文本作为搜索词
  const selection = editor.getSelection();
  if (selection) {
    window.zion.state.set('searchReplace.query', selection);
  }
  
  window.zion.state.set('searchReplace.visible', true);
  window.zion.state.set('searchReplace.withReplace', withReplace);
  isSearchVisible = true;
  
  // 创建或显示搜索面板
  ensureSearchPanel();

  // 用选区填充输入框并同步到 CM6 SearchQuery
  const input = searchPanel.querySelector('#search-input');
  if (input && selection) {
    input.value = selection;
  }
  // 回填替换框的上次内容
  const replaceInput = searchPanel.querySelector('#replace-input');
  const prevReplace = window.zion.state.get('searchReplace.replace') || '';
  if (replaceInput && typeof prevReplace === 'string') {
    replaceInput.value = prevReplace;
  }
  updateSearch(); // 推送查询并刷新计数

  focusSearchInput();
}

function hideSearchPanel() {
  window.zion.state.set('searchReplace.visible', false);
  window.zion.state.set('selectionToolbar.suppressUntil', Date.now() + 900);
  isSearchVisible = false;
  hideCustomPanel();
  refreshSearchHighlights();
  
  // 焦点回到编辑器
  const editor = window.zion.window.activeEditor;
  editor?.focus();
}

function findNext() {
  // 通过执行 CM6 的搜索命令
  window.zion.commands.executeCommand('findNext');
}

function findPrevious() {
  window.zion.commands.executeCommand('findPrev');
}

function selectAllMatches() {
  window.zion.commands.executeCommand('selectMatches');
}

function replaceCurrent() {
  // 在替换前将 replace 同步到 CM6 的 SearchQuery
  const editor = window.zion.window.activeEditor;
  const before = editor?.getValue?.() ?? '';
  if (searchPanel) {
    const query = window.zion.state.get('searchReplace.query') || '';
    const replaceVal = (searchPanel.querySelector('#replace-input')?.value || '');
    const caseSensitive = !!(searchPanel.querySelector('#case-sensitive')?.checked);
    const wholeWord = !!(searchPanel.querySelector('#whole-word')?.checked);
    const regex = !!(searchPanel.querySelector('#regex')?.checked);
    window.zion.commands.executeCommand('setSearchQuery', {
      search: query,
      replace: replaceVal,
      caseSensitive,
      wholeWord,
      regexp: regex
    });
  }
  window.zion.commands.executeCommand('replaceNext');
  // 简单反馈：如果内容发生变化，提示“Replaced 1”
  const after = editor?.getValue?.() ?? '';
  if (after !== before) {
    __showSearchStatus('Replaced 1');
  }
}

function replaceAll() {
  let count = 0;
  if (searchPanel) {
    const query = window.zion.state.get('searchReplace.query') || '';
    const replaceVal = (searchPanel.querySelector('#replace-input')?.value || '');
    const caseSensitive = !!(searchPanel.querySelector('#case-sensitive')?.checked);
    const wholeWord = !!(searchPanel.querySelector('#whole-word')?.checked);
    const regex = !!(searchPanel.querySelector('#regex')?.checked);

    // 统计替换总数（基于当前内容与选项）
    const ed = window.zion.window.activeEditor;
    const text = ed?.getValue?.() || '';
    try {
      const ranges = __computeMatches(text, query, { caseSensitive, wholeWord, regex });
      count = ranges.length;
    } catch {}

    window.zion.commands.executeCommand('setSearchQuery', {
      search: query,
      replace: replaceVal,
      caseSensitive,
      wholeWord,
      regexp: regex
    });
  }
  window.zion.commands.executeCommand('replaceAll');
  if (count > 0) {
    __showSearchStatus(`Replaced ${count}`);
  } else {
    __showSearchStatus('Replaced 0');
  }
}

function updateSearchPanelVisibility() {
  // 当编辑器失去焦点时隐藏搜索面板
  if (isSearchVisible) {
    const editor = window.zion.window.activeEditor;
    if (!editor) {
      hideSearchPanel();
    }
  }
}

// 自定义搜索面板的 DOM 操作
let searchPanel = null;

function getSearchPanelHost() {
  try {
    const editor = window.zion.window.activeEditor;
    const view = editor?.getView?.();
    const editorDom = view?.dom || null;
    const host = editorDom?.closest?.('.zion-editor-host');
    if (host && host instanceof HTMLElement) return host;
  } catch {}
  try {
    const panelId = window.zion?.panels?.getActivePanelId?.();
    if (panelId) {
      const panelRoot = document.querySelector(`[data-panel-id="${CSS.escape(String(panelId))}"]`);
      const host = panelRoot?.querySelector?.('.zion-editor-host');
      if (host && host instanceof HTMLElement) return host;
    }
  } catch {}
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

function ensureSearchPanel() {
  if (!searchPanel) {
    searchPanel = document.createElement('div');
    searchPanel.className = 'search-replace-panel';
    searchPanel.style.cssText = `
      position: absolute;
      top: 8px;
      right: 12px;
      left: auto;
      transform: none;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      z-index: 10000;
      font-family: system-ui, sans-serif;
      font-size: 13px;
      min-width: 320px;
      max-width: 48%;
    `;
    
    searchPanel.innerHTML = `
      <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px;">
        <textarea id="search-input" placeholder="Search" rows="1"
               style="flex: 1; max-height: 80px; resize: none; padding: 6px 8px; border: 1px solid var(--border); 
                      background: var(--input-bg, var(--panel)); 
                      color: var(--fg); border-radius: 4px; font-family: inherit; font-size: inherit; overflow: hidden;"></textarea>
        <span id="match-count" style="color: var(--fg-secondary); font-size: 12px;"></span>
        <button id="toggle-replace-btn" title="Show replace" style="background: none; border: 1px solid var(--border); color: var(--fg); cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size:12px;">▾</button>
        <button id="prev-btn" title="Previous Match" style="background: none; border: 1px solid var(--border); color: var(--fg); cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size:12px;">↑</button>
        <button id="next-btn" title="Next Match" style="background: none; border: 1px solid var(--border); color: var(--fg); cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size:12px;">↓</button>
        <button id="select-all-btn" title="Select All Matches" style="background: none; border: 1px solid var(--border); color: var(--fg); cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size:12px;">All</button>
        <button id="close-btn" title="Close" style="background: none; border: none; color: var(--fg); cursor: pointer; padding: 2px 6px; font-size:12px;">×</button>
      </div>
      <div id="replace-section" style="display: none; margin-top: 8px;">
        <div style="display: flex; gap: 8px; align-items: center;">
          <textarea id="replace-input" placeholder="Replace" rows="1"
                 style="flex: 1; max-height: 80px; resize: none; padding: 6px 8px; border: 1px solid var(--border); 
                        background: var(--input-bg, var(--panel)); 
                        color: var(--fg); border-radius: 4px; font-family: inherit; font-size: inherit; overflow: hidden;"></textarea>
          <button id="replace-btn" style="padding: 4px 8px; background: var(--accent); color: white; border: none; border-radius: 4px; cursor: pointer; font-size:12px;">Replace</button>
          <button id="replace-all-btn" style="padding: 4px 8px; background: var(--border); color: var(--fg); border: none; border-radius: 4px; cursor: pointer; font-size:12px;">All</button>
        </div>
      </div>
      <div style="display: flex; gap: 8px; margin-top: 8px; align-items: center;">
        <label title="Match case" style="display: flex; align-items: center; gap: 6px; font-size: 12px;">
          <input type="checkbox" id="case-sensitive" />
          <span style="font-size:12px; opacity:0.9;">Aa</span>
        </label>
        <label title="Whole word" style="display: flex; align-items: center; gap: 6px; font-size: 12px;">
          <input type="checkbox" id="whole-word" />
          <span style="font-size:12px; opacity:0.9;">⎵</span>
        </label>
        <label title="Regex" style="display: flex; align-items: center; gap: 6px; font-size: 12px;">
          <input type="checkbox" id="regex" />
          <span style="font-size:12px; opacity:0.9;">.*</span>
        </label>
      </div>
    `;
    
    // Append the panel into the editor host so position:absolute is relative to the editor content (not tabs bar)
    attachSearchPanelToActiveHost();
    
    // 事件监听
    setupEventListeners();
  }
  attachSearchPanelToActiveHost();
  
  // 显示/隐藏替换区域
  const replaceSection = searchPanel.querySelector('#replace-section');
  const withReplace = window.zion.state.get('searchReplace.withReplace');
  replaceSection.style.display = withReplace ? 'block' : 'none';
  // 更新“Replace”切换按钮的文案（使用紧凑图标并保留 tooltip）
  const toggleBtn = searchPanel.querySelector('#toggle-replace-btn');
  if (toggleBtn) {
    toggleBtn.textContent = withReplace ? '▴' : '▾';
    toggleBtn.title = withReplace ? 'Hide replace' : 'Show replace';
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
    const input = searchPanel.querySelector('#search-input');
    input?.focus();
    input?.select();
  }
}

function setupEventListeners() {
  if (!searchPanel) return;
  
  const searchInput = searchPanel.querySelector('#search-input');
  const replaceInput = searchPanel.querySelector('#replace-input');
  const closeBtn = searchPanel.querySelector('#close-btn');
  const replaceBtn = searchPanel.querySelector('#replace-btn');
  const replaceAllBtn = searchPanel.querySelector('#replace-all-btn');
  const caseCheckbox = searchPanel.querySelector('#case-sensitive');
  const wholeWordCheckbox = searchPanel.querySelector('#whole-word');
  const regexCheckbox = searchPanel.querySelector('#regex');
  const prevBtn = searchPanel.querySelector('#prev-btn');
  const nextBtn = searchPanel.querySelector('#next-btn');
  const selectAllBtn = searchPanel.querySelector('#select-all-btn');
  const toggleReplaceBtn = searchPanel.querySelector('#toggle-replace-btn');
  
  // 关闭按钮
  closeBtn?.addEventListener('click', hideSearchPanel);

  // 上一/下一/选择所有 按钮
  prevBtn?.addEventListener('click', findPrevious);
  nextBtn?.addEventListener('click', findNext);
  selectAllBtn?.addEventListener('click', selectAllMatches);

  // 展开/收起替换框
  toggleReplaceBtn?.addEventListener('click', () => {
    const withReplace = !!window.zion.state.get('searchReplace.withReplace');
    const next = !withReplace;
    window.zion.state.set('searchReplace.withReplace', next);
    const replaceSection = searchPanel.querySelector('#replace-section');
    if (replaceSection) replaceSection.style.display = next ? 'block' : 'none';
    const btn = searchPanel.querySelector('#toggle-replace-btn');
    if (btn) {
      btn.textContent = next ? '▴' : '▾';
      btn.title = next ? 'Hide replace' : 'Show replace';
    }
    if (next) {
      const rInput = searchPanel.querySelector('#replace-input');
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
    window.zion.state.set('searchReplace.query', e.target.value);
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
    window.zion.state.set('searchReplace.replace', e.target.value);
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
  const ranges = [];
  if (!query) return ranges;
  try {
    const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\');
    const boundary = wholeWord ? '\\b' : '';
    const flags = caseSensitive ? 'g' : 'gi';
    const re = new RegExp(`${boundary}${source}${boundary}`, flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const from = m.index;
      const to = m.index + m[0].length;
      ranges.push({ from, to, text: m[0] });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  } catch (e) {
    // ignore invalid regex
  }
  return ranges;
}

// Helper: 在计数位置短暂显示反馈消息
let __srStatusTimer = null;
function __showSearchStatus(msg) {
  const el = searchPanel?.querySelector('#match-count');
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
  const query = window.zion.state.get('searchReplace.query') || '';
  const replaceVal = (searchPanel.querySelector('#replace-input')?.value || '');
  const caseSensitive = !!(searchPanel.querySelector('#case-sensitive')?.checked);
  const wholeWord = !!(searchPanel.querySelector('#whole-word')?.checked);
  const regex = !!(searchPanel.querySelector('#regex')?.checked);
  const ed = window.zion.window.activeEditor;

  window.zion.state.set('searchReplace.replace', replaceVal);

  window.zion.commands.executeCommand('setSearchQuery', {
    search: query,
    replace: replaceVal,
    caseSensitive,
    wholeWord,
    regexp: regex
  });
  refreshSearchHighlights();

  const text = ed?.getValue?.() || '';

  let ranges = [];
  let count = 0;
  if (query) {
    try {
      const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\');
      const boundary = wholeWord ? '\\b' : '';
      const flags = caseSensitive ? 'g' : 'gi';
      const re = new RegExp(`${boundary}${source}${boundary}`, flags);
      let m;
      while ((m = re.exec(text)) !== null) {
        const from = m.index;
        const to = m.index + m[0].length;
        ranges.push({ from, to, text: m[0] });
        count += 1;
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    } catch (e) {
      count = 0;
      ranges = [];
    }
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

  const matchCount = searchPanel.querySelector('#match-count');
  if (matchCount) {
    if (!query) {
      matchCount.textContent = '';
    } else if (count === 0) {
      matchCount.textContent = 'No results';
    } else {
      matchCount.textContent = `${current}/${count}`;
    }
  }
}

function updateSearchOptions() {
  if (!searchPanel) return;
  
  const caseSensitive = searchPanel.querySelector('#case-sensitive').checked;
  const wholeWord = searchPanel.querySelector('#whole-word').checked;
  const regex = searchPanel.querySelector('#regex').checked;
  
  window.zion.state.set('searchReplace.caseSensitive', caseSensitive);
  window.zion.state.set('searchReplace.wholeWord', wholeWord);
  window.zion.state.set('searchReplace.regex', regex);
  
  // 重新搜索
  updateSearch();
}
