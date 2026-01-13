/**
 * dev.slash-commands - Slash commands plugin for Zion Next
 *
 * Features:
 * - Register slash commands from any plugin via window.zion.slash
 * - Trigger commands by typing '/' in editor
 * - Show command palette with fuzzy search
 * - Support command parameters (string, number, boolean, select)
 * - Support multi-level interactions (e.g., /model -> select provider -> select model)
 *
 * Usage example in other plugins:
 * ```javascript
 * window.zion.slash.registerCommand({
 *   id: "my.command",
 *   trigger: "mycmd",
 *   title: "My Command",
 *   description: "Description",
 *   category: "custom",
 *   icon: "🔧",
 *   execute: (params, editor) => {
 *     console.log("Command executed!", params);
 *   }
 * });
 * ```
 */

export async function activate(ctx) {
  // ===== Slash Command Registry =====
  const commands = new Map(); // id -> SlashCommand
  const commandsByTrigger = new Map(); // trigger -> SlashCommand[]
  const changeHandlers = new Set(); // Set<() => void>

  const injectSlashStyles = () => {
    try {
      const styleId = 'zion-slash-commands-style';
      if (document.getElementById(styleId)) return;
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
.zion-slash-panel{font-family:var(--font-sans,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif);font-size:12px;animation:zionSlashFadeIn .15s ease-out}
@keyframes zionSlashFadeIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
.zion-slash-header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border-bottom:1px solid var(--border,#3c3c3c)}
.zion-slash-query{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace);font-size:11px;opacity:.9}
.zion-slash-hint{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace);font-size:10px;opacity:.6;white-space:nowrap}
.zion-slash-empty{color:rgba(248,248,242,.7)}
:root[data-theme="light"] .zion-slash-empty{color:rgba(0,0,0,.55)}
.zion-slash-category{color:rgba(248,248,242,.55)}
:root[data-theme="light"] .zion-slash-category{color:rgba(0,0,0,.45)}
.zion-slash-item{transition:background-color .1s ease;color:var(--fg,#cccccc);box-sizing:border-box}
.zion-slash-item:hover{background-color:rgba(98,114,164,.10)}
:root[data-theme="light"] .zion-slash-item:hover{background-color:rgba(59,130,246,.10)}
.zion-slash-item:active{background-color:rgba(98,114,164,.14)}
:root[data-theme="light"] .zion-slash-item:active{background-color:rgba(59,130,246,.14)}
.zion-slash-item.is-active{background-color:var(--role-user-bg,rgba(98,114,164,.18));color:var(--fg,#cccccc)}
.zion-slash-item.is-active:hover{background-color:var(--role-user-bg,rgba(98,114,164,.18))}
.zion-slash-item.is-active:active{background-color:var(--role-user-bg,rgba(98,114,164,.18))}
.zion-slash-title{color:inherit}
.zion-slash-desc{color:rgba(248,248,242,.7)}
:root[data-theme="light"] .zion-slash-desc{color:rgba(0,0,0,.6)}
.zion-slash-item.is-active .zion-slash-desc{color:inherit;opacity:.85}
.zion-slash-trigger{color:var(--accent,#007acc)}
.zion-slash-item.is-active .zion-slash-trigger{color:var(--accent,#007acc);opacity:1}

.zion-slash-list{padding:6px;box-sizing:border-box;scrollbar-color:transparent transparent;scrollbar-width:thin}
.zion-slash-list:hover{scrollbar-color:var(--scrollbar-thumb,var(--border,#44475a)) transparent}
.zion-slash-list::-webkit-scrollbar{width:10px;height:10px}
.zion-slash-list::-webkit-scrollbar-track{background:transparent}
.zion-slash-list::-webkit-scrollbar-thumb{background:transparent;border-radius:6px;border:2px solid transparent;background-clip:content-box;transition:background .15s ease}
.zion-slash-list:hover::-webkit-scrollbar-thumb{background:var(--scrollbar-thumb,var(--border,#44475a));background-clip:content-box}
.zion-slash-list::-webkit-scrollbar-thumb:hover{background:var(--scrollbar-thumb-hover,var(--accent,#6272a4));background-clip:content-box}
      `;
      document.head.appendChild(style);
    } catch {}
  };

  injectSlashStyles();

  const registerSlashCommand = (cmd) => {
    // Validate command
    if (!cmd.id || typeof cmd.id !== 'string') {
      console.error('[dev.slash-commands] Command id is required');
      return { dispose: () => {} };
    }
    if (!cmd.trigger) {
      console.error('[dev.slash-commands] Command trigger is required');
      return { dispose: () => {} };
    }
    if (!cmd.title) {
      console.error('[dev.slash-commands] Command title is required');
      return { dispose: () => {} };
    }
    if (typeof cmd.execute !== 'function') {
      console.error('[dev.slash-commands] Command execute function is required');
      return { dispose: () => {} };
    }

    // Normalize triggers to array
    const triggers = Array.isArray(cmd.trigger) ? cmd.trigger : [cmd.trigger];
    cmd._triggers = triggers;
    cmd._aliases = cmd.aliases || [];

    // Register by id
    commands.set(cmd.id, cmd);

    // Register by trigger (for lookup)
    triggers.forEach(trigger => {
      if (!commandsByTrigger.has(trigger)) {
        commandsByTrigger.set(trigger, []);
      }
      commandsByTrigger.get(trigger).push(cmd);
    });

    // Also register by aliases
    (cmd.aliases || []).forEach(alias => {
      if (!commandsByTrigger.has(alias)) {
        commandsByTrigger.set(alias, []);
      }
      commandsByTrigger.get(alias).push(cmd);
    });

    console.log(`[dev.slash-commands] Registered command: ${cmd.id} (${triggers.join(', ')})`);

    // Notify listeners
    notifyChange();

    // Return disposable
    return {
      dispose: () => {
        // Unregister
        commands.delete(cmd.id);
        triggers.forEach(trigger => {
          const list = commandsByTrigger.get(trigger);
          if (list) {
            const idx = list.indexOf(cmd);
            if (idx !== -1) list.splice(idx, 1);
            if (list.length === 0) commandsByTrigger.delete(trigger);
          }
        });
        (cmd.aliases || []).forEach(alias => {
          const list = commandsByTrigger.get(alias);
          if (list) {
            const idx = list.indexOf(cmd);
            if (idx !== -1) list.splice(idx, 1);
            if (list.length === 0) commandsByTrigger.delete(alias);
          }
        });
        notifyChange();
        console.log(`[dev.slash-commands] Unregistered command: ${cmd.id}`);
      }
    };
  };

  const notifyChange = () => {
    changeHandlers.forEach(handler => {
      try {
        handler();
      } catch (e) {
        console.error('[dev.slash-commands] Error in change handler:', e);
      }
    });
  };

  const getAllCommands = () => {
    return Array.from(commands.values());
  };

  const getCommand = (id) => {
    return commands.get(id);
  };

  const executeCommand = async (id, params) => {
    const cmd = commands.get(id);
    if (!cmd) {
      console.error(`[dev.slash-commands] Command not found: ${id}`);
      return;
    }
    const editor = window.zion?.window?.activeEditor || null;
    try {
      await cmd.execute(params || {}, editor);
    } catch (e) {
      console.error(`[dev.slash-commands] Error executing command ${id}:`, e);
    }
  };

  const onCommandsChanged = (handler) => {
    changeHandlers.add(handler);
    return {
      dispose: () => {
        changeHandlers.delete(handler);
      }
    };
  };

  // ===== Built-in Markdown Commands =====
  const registerBuiltInCommands = () => {
    // Heading commands
    for (let i = 1; i <= 6; i++) {
      const hashes = '#'.repeat(i);
      registerSlashCommand({
        id: `markdown.h${i}`,
        trigger: [`h${i}`, `${hashes}`, `heading${i}`],
        title: `${i}级标题`,
        description: `插入 ${i} 级标题 (${hashes})`,
        category: 'markdown',
        icon: '📌',
        priority: 100 - i,
        execute: (params, editor) => {
          if (!editor) return;
          editor.replaceSelection(`${hashes} `);
        }
      });
    }

    // Generic heading command
    registerSlashCommand({
      id: 'markdown.heading',
      trigger: ['heading', 'head', 'h'],
      title: '标题',
      description: '插入标题（可选级别 1-6）',
      category: 'markdown',
      icon: '📌',
      params: [
        {
          name: 'level',
          type: 'number',
          label: '级别',
          placeholder: '1-6',
          default: 1,
          min: 1,
          max: 6
        }
      ],
      execute: (params, editor) => {
        if (!editor) return;
        const level = params.level || 1;
        const hashes = '#'.repeat(Math.min(6, Math.max(1, level)));
        editor.replaceSelection(`${hashes} `);
      }
    });

    // Text formatting
    registerSlashCommand({
      id: 'markdown.bold',
      trigger: ['bold', 'b'],
      title: '粗体',
      description: '插入粗体文本 (**text**)',
      category: 'markdown',
      icon: '🔤',
      execute: (params, editor) => {
        if (!editor) return;
        const selection = editor.getSelection();
        if (selection) {
          editor.replaceSelection(`**${selection}**`);
        } else {
          editor.replaceSelection('****');
          const cursor = editor.getCursor();
          editor.setCursor({ line: cursor.line, ch: cursor.ch - 2 });
        }
      }
    });

    registerSlashCommand({
      id: 'markdown.italic',
      trigger: ['italic', 'i', 'em'],
      title: '斜体',
      description: '插入斜体文本 (*text*)',
      category: 'markdown',
      icon: '🔤',
      execute: (params, editor) => {
        if (!editor) return;
        const selection = editor.getSelection();
        if (selection) {
          editor.replaceSelection(`*${selection}*`);
        } else {
          editor.replaceSelection('**');
          const cursor = editor.getCursor();
          editor.setCursor({ line: cursor.line, ch: cursor.ch - 1 });
        }
      }
    });

    registerSlashCommand({
      id: 'markdown.strikethrough',
      trigger: ['strikethrough', 's'],
      title: '删除线',
      description: '插入删除线文本 (~~text~~)',
      category: 'markdown',
      icon: '🔤',
      execute: (params, editor) => {
        if (!editor) return;
        const selection = editor.getSelection();
        if (selection) {
          editor.replaceSelection(`~~${selection}~~`);
        } else {
          editor.replaceSelection('~~~~');
          const cursor = editor.getCursor();
          editor.setCursor({ line: cursor.line, ch: cursor.ch - 2 });
        }
      }
    });

    registerSlashCommand({
      id: 'markdown.code',
      trigger: ['code', 'c'],
      title: '行内代码',
      description: '插入行内代码 (`code`)',
      category: 'markdown',
      icon: '💻',
      execute: (params, editor) => {
        if (!editor) return;
        const selection = editor.getSelection();
        if (selection) {
          editor.replaceSelection(`\`${selection}\``);
        } else {
          editor.replaceSelection('``');
          const cursor = editor.getCursor();
          editor.setCursor({ line: cursor.line, ch: cursor.ch - 1 });
        }
      }
    });

    // List commands
    registerSlashCommand({
      id: 'markdown.ul',
      trigger: ['ul', 'bullet', 'list'],
      title: '无序列表',
      description: '插入无序列表 (- item)',
      category: 'markdown',
      icon: '📋',
      execute: (params, editor) => {
        if (!editor) return;
        editor.replaceSelection('- ');
      }
    });

    registerSlashCommand({
      id: 'markdown.ol',
      trigger: ['ol', 'numbered', 'numlist'],
      title: '有序列表',
      description: '插入有序列表 (1. item)',
      category: 'markdown',
      icon: '📋',
      execute: (params, editor) => {
        if (!editor) return;
        editor.replaceSelection('1. ');
      }
    });

    registerSlashCommand({
      id: 'markdown.checklist',
      trigger: ['checklist', 'todo', 'task'],
      title: '任务列表',
      description: '插入任务列表 (- [ ] item)',
      category: 'markdown',
      icon: '✅',
      execute: (params, editor) => {
        if (!editor) return;
        editor.replaceSelection('- [ ] ');
      }
    });

    // Block elements
    registerSlashCommand({
      id: 'markdown.quote',
      trigger: ['quote', 'q', 'blockquote'],
      title: '引用',
      description: '插入引用块 (> quote)',
      category: 'markdown',
      icon: '💬',
      execute: (params, editor) => {
        if (!editor) return;
        editor.replaceSelection('> ');
      }
    });

    registerSlashCommand({
      id: 'markdown.codeblock',
      trigger: ['codeblock', 'code-block', 'cb', '```'],
      title: '代码块',
      description: '插入代码块',
      category: 'markdown',
      icon: '💻',
      execute: (params, editor) => {
        if (!editor) return;
        const codeblock = `\`\`\`\n\n\`\`\``;
        editor.replaceSelection(codeblock);
        const cursor = editor.getCursor();
        editor.setCursor({ line: cursor.line - 1, ch: 0 });
      }
    });

    registerSlashCommand({
      id: 'markdown.divider',
      trigger: ['divider', 'hr', '---'],
      title: '分隔线',
      description: '插入分隔线 (---)',
      category: 'markdown',
      icon: '➖',
      execute: (params, editor) => {
        if (!editor) return;
        editor.replaceSelection('\n---\n');
      }
    });

    // Link and media
    registerSlashCommand({
      id: 'markdown.link',
      trigger: ['link', 'url'],
      title: '链接',
      description: '插入链接 ([text](url))',
      category: 'markdown',
      icon: '🔗',
      execute: (params, editor) => {
        if (!editor) return;
        const selection = editor.getSelection();
        if (selection) {
          editor.replaceSelection(`[${selection}](url)`);
        } else {
          editor.replaceSelection('[](url)');
          const cursor = editor.getCursor();
          editor.setCursor({ line: cursor.line, ch: cursor.ch - 5 });
        }
      }
    });

    registerSlashCommand({
      id: 'markdown.image',
      trigger: ['image', 'img', 'pic'],
      title: '图片',
      description: '插入图片\n![alt](url)',
      category: 'markdown',
      icon: '🖼️',
      execute: (params, editor) => {
        if (!editor) return;
        editor.replaceSelection('\n![alt](url)\n');
        const cursor = editor.getCursor();
        editor.setCursor({ line: cursor.line - 2, ch: 2 });
      }
    });

    registerSlashCommand({
      id: 'markdown.table',
      trigger: ['table'],
      title: '表格',
      description: '插入表格模板',
      category: 'markdown',
      icon: '📊',
      execute: (params, editor) => {
        if (!editor) return;
        const table = `
| 列1 | 列2 | 列3 |
|-----|-----|-----|
|     |     |     |
`;
        editor.replaceSelection(table);
        const cursor = editor.getCursor();
        editor.setCursor({ line: cursor.line - 2, ch: 2 });
      }
    });

    // Utility commands
    registerSlashCommand({
      id: 'utility.timestamp',
      trigger: ['timestamp', 'time', 'now'],
      title: '时间戳',
      description: '插入当前时间戳',
      category: 'utility',
      icon: '⏰',
      execute: (params, editor) => {
        if (!editor) return;
        editor.replaceSelection(new Date().toISOString());
      }
    });

    registerSlashCommand({
      id: 'utility.date',
      trigger: ['date'],
      title: '日期',
      description: '插入当前日期',
      category: 'utility',
      icon: '📅',
      execute: (params, editor) => {
        if (!editor) return;
        editor.replaceSelection(new Date().toLocaleDateString('zh-CN'));
      }
    });
  };

  // ===== Slash UI Components =====
  let slashPanel = null;
  let slashHeaderQuery = null;
  let slashList = null;
  let slashActiveCommand = null;
  let slashStartPos = null;
  let slashTriggerText = '';

  let slashNavStack = [];
  let slashNavMode = 'root';
  let slashSubFilter = '';

  let slashSelectedIndex = 0;
  let slashCurrentCommands = [];
  let slashCurrentItemEls = [];

  let slashDocKeydownAttached = false;
  let slashDocMousedownAttached = false;
  let slashDocMousemoveAttached = false;
  let slashDocCompositionAttached = false;
  let slashCompositionActive = false;
  let slashLastMouseMoveAt = 0;
  let lastEditorView = null;

  const onSlashGlobalCompositionStart = () => {
    if (!isSlashPanelOpen()) return;
    slashCompositionActive = true;
  };

  const onSlashGlobalCompositionEnd = () => {
    if (!isSlashPanelOpen()) return;
    slashCompositionActive = false;
  };

  const onSlashGlobalMouseMove = (e) => {
    if (!isSlashPanelOpen()) return;
    if (!slashPanel || !e.target || !slashPanel.contains(e.target)) return;

    slashLastMouseMoveAt = Date.now();

    const el = e.target.closest ? e.target.closest('.zion-slash-item') : null;
    if (!el) return;

    const idx = Number(el.dataset && el.dataset.slashIndex);
    if (Number.isFinite(idx)) setSlashActiveIndex(idx);
  };

  const createSlashPanel = () => {
    if (slashPanel) return slashPanel;

    const panel = document.createElement('div');
    panel.id = 'zion-slash-panel';
    panel.className = 'zion-slash-panel';
    panel.style.display = 'none';
    panel.style.position = 'fixed';
    panel.style.zIndex = '1000';
    panel.style.background = 'var(--panel, var(--bg, #1e1e1e))';
    panel.style.border = '1px solid var(--border, #3c3c3c)';
    panel.style.borderRadius = '6px';
    panel.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.30)';
    panel.style.maxWidth = '400px';
    panel.style.maxHeight = '400px';
    panel.style.overflow = 'hidden';
    panel.style.fontFamily = 'var(--font-sans, system-ui, -apple-system, sans-serif)';
    panel.style.fontSize = '12px';

    const header = document.createElement('div');
    header.className = 'zion-slash-header';

    const query = document.createElement('div');
    query.className = 'zion-slash-query';
    query.textContent = '/';

    const hint = document.createElement('div');
    hint.className = 'zion-slash-hint';
    hint.textContent = '↑↓ 选择 · Enter 执行 · Esc 关闭';

    header.appendChild(query);
    header.appendChild(hint);
    panel.appendChild(header);

    // Command list
    const list = document.createElement('div');
    list.className = 'zion-slash-list';
    list.style.overflowY = 'auto';
    list.style.maxHeight = '340px';

    panel.appendChild(list);

    document.body.appendChild(panel);

    slashPanel = panel;
    slashHeaderQuery = query;
    slashList = list;

    return panel;
  };

  const isSlashPanelOpen = () => {
    return !!slashPanel && slashPanel.style.display !== 'none';
  };

  const hasSubmenu = (cmd) => {
    return !!cmd && (typeof cmd.submenu === 'function' || Array.isArray(cmd.submenu));
  };

  const getNavTitle = (cmd) => {
    if (!cmd) return '';
    if (typeof cmd.title === 'string' && cmd.title.trim()) return cmd.title.trim();
    if (Array.isArray(cmd._triggers) && cmd._triggers[0]) return String(cmd._triggers[0]);
    if (Array.isArray(cmd.trigger) && cmd.trigger[0]) return String(cmd.trigger[0]);
    if (typeof cmd.trigger === 'string') return cmd.trigger;
    return String(cmd.id || '');
  };

  const getBreadcrumbText = () => {
    if (!slashNavStack.length) return '';
    return slashNavStack.map(getNavTitle).filter(Boolean).join(' / ');
  };

  const resolveSubmenuItems = async (cmd) => {
    try {
      if (!cmd) return [];
      if (typeof cmd.submenu === 'function') {
        const out = await cmd.submenu();
        return Array.isArray(out) ? out : [];
      }
      if (Array.isArray(cmd.submenu)) return cmd.submenu;
      return [];
    } catch (e) {
      console.error('[dev.slash-commands] resolveSubmenuItems error:', e);
      return [];
    }
  };

  const setSlashActiveIndex = (nextIdx) => {
    if (!slashCurrentItemEls || slashCurrentItemEls.length === 0) return;
    const clamped = Math.max(0, Math.min(nextIdx, slashCurrentItemEls.length - 1));
    const prevEl = slashCurrentItemEls[slashSelectedIndex];
    const nextEl = slashCurrentItemEls[clamped];

    if (prevEl && prevEl !== nextEl) prevEl.classList.remove('is-active');
    if (nextEl) {
      nextEl.classList.add('is-active');
      try {
        nextEl.scrollIntoView({ block: 'nearest' });
      } catch {}
    }

    slashSelectedIndex = clamped;
    slashActiveCommand = slashCurrentCommands[slashSelectedIndex] || null;
  };

  const renderSlashCommands = (filter = '') => {
    if (!slashList) return;

    if (slashNavMode === 'submenu') {
      const items = slashNavStack.length ? (slashNavStack[slashNavStack.length - 1]._submenuItems || []) : [];
      const lowerFilter = (filter || '').toLowerCase();

      const filtered = (items || []).filter((cmd) => {
        if (!filter) return true;
        const title = String(cmd.title || '').toLowerCase();
        const desc = String(cmd.description || '').toLowerCase();
        return title.includes(lowerFilter) || desc.includes(lowerFilter);
      });

      slashList.innerHTML = '';
      slashCurrentCommands = [];
      slashCurrentItemEls = [];

      const renderItem = (cmd) => {
        const itemIndex = slashCurrentCommands.length;
        slashCurrentCommands.push(cmd);

        const item = document.createElement('div');
        item.className = 'zion-slash-item';
        item.dataset.slashIndex = String(itemIndex);
        item.style.padding = '8px 12px';
        item.style.cursor = 'pointer';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.gap = '12px';
        item.style.borderRadius = '6px';

        const icon = document.createElement('div');
        icon.className = 'zion-slash-icon';
        icon.textContent = cmd.icon || (cmd.__navBack ? '↩︎' : (hasSubmenu(cmd) ? '›' : '⚡'));
        icon.style.fontSize = '18px';
        icon.style.flexShrink = '0';

        const text = document.createElement('div');
        text.className = 'zion-slash-text';
        text.style.flex = '1';
        text.style.minWidth = '0';

        const title = document.createElement('div');
        title.className = 'zion-slash-title';
        title.style.fontWeight = '500';
        title.textContent = cmd.title || '';

        const desc = document.createElement('div');
        desc.className = 'zion-slash-desc';
        desc.style.fontSize = '12px';
        desc.style.whiteSpace = 'nowrap';
        desc.style.overflow = 'hidden';
        desc.style.textOverflow = 'ellipsis';
        desc.style.marginTop = '2px';
        desc.textContent = cmd.description || '';

        text.appendChild(title);
        if (cmd.description) text.appendChild(desc);
        item.appendChild(icon);
        item.appendChild(text);

        item.onclick = () => {
          selectCommand(cmd);
        };

        item.onmouseenter = () => {
          if (Date.now() - slashLastMouseMoveAt < 120) {
            setSlashActiveIndex(itemIndex);
          }
        };

        slashCurrentItemEls.push(item);
        slashList.appendChild(item);
      };

      if (slashNavStack.length > 0) {
        renderItem({
          __navBack: true,
          title: 'Back',
          description: getBreadcrumbText(),
          icon: '←'
        });
      }

      if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'zion-slash-empty';
        empty.style.padding = '16px';
        empty.style.textAlign = 'center';
        empty.textContent = '没有找到匹配的命令';
        slashList.appendChild(empty);
        return;
      }

      filtered.forEach(renderItem);

      if (slashSelectedIndex >= slashCurrentItemEls.length) slashSelectedIndex = 0;
      setSlashActiveIndex(slashSelectedIndex);
      return;
    }

    const allCommands = getAllCommands();
    const lowerFilter = filter.toLowerCase();

    // Filter and sort commands
    let filtered = allCommands.filter(cmd => {
      if (!filter) return true;
      const matchTrigger = cmd._triggers.some(t => t.toLowerCase().startsWith(lowerFilter));
      const matchAlias = cmd._aliases.some(a => a.toLowerCase().startsWith(lowerFilter));
      const matchTitle = cmd.title.toLowerCase().includes(lowerFilter);
      const matchDesc = cmd.description && cmd.description.toLowerCase().includes(lowerFilter);
      return matchTrigger || matchAlias || matchTitle || matchDesc;
    });

    // Sort by category and priority
    filtered.sort((a, b) => {
      if (a.category !== b.category) {
        return a.category.localeCompare(b.category);
      }
      const priorityA = a.priority || 50;
      const priorityB = b.priority || 50;
      return priorityB - priorityA;
    });

    // Group by category
    const grouped = new Map();
    filtered.forEach(cmd => {
      if (!grouped.has(cmd.category)) {
        grouped.set(cmd.category, []);
      }
      grouped.get(cmd.category).push(cmd);
    });

    // Render
    slashList.innerHTML = '';
    slashCurrentCommands = [];
    slashCurrentItemEls = [];

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'zion-slash-empty';
      empty.style.padding = '16px';
      empty.style.textAlign = 'center';
      empty.textContent = '没有找到匹配的命令';
      slashList.appendChild(empty);
      return;
    }

    grouped.forEach((cmds, category) => {
      // Category header
      const header = document.createElement('div');
      header.className = 'zion-slash-category';
      header.style.padding = '8px 12px 4px 12px';
      header.style.fontSize = '11px';
      header.style.fontWeight = '600';
      header.style.textTransform = 'uppercase';
      header.style.letterSpacing = '0.5px';
      header.textContent = category;
      slashList.appendChild(header);

      // Commands
      cmds.forEach((cmd) => {
        const itemIndex = slashCurrentCommands.length;
        slashCurrentCommands.push(cmd);
        const item = document.createElement('div');
        item.className = 'zion-slash-item';
        item.dataset.slashIndex = String(itemIndex);
        item.style.padding = '8px 12px';
        item.style.cursor = 'pointer';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.gap = '12px';
        item.style.borderRadius = '6px';

        // Icon
        const icon = document.createElement('div');
        icon.className = 'zion-slash-icon';
        icon.textContent = cmd.icon || '⚡';
        icon.style.fontSize = '18px';
        icon.style.flexShrink = '0';

        // Text
        const text = document.createElement('div');
        text.className = 'zion-slash-text';
        text.style.flex = '1';
        text.style.minWidth = '0';

        const title = document.createElement('div');
        title.className = 'zion-slash-title';
        title.style.fontWeight = '500';
        title.textContent = cmd.title;

        const desc = document.createElement('div');
        desc.className = 'zion-slash-desc';
        desc.style.fontSize = '12px';
        desc.style.whiteSpace = 'nowrap';
        desc.style.overflow = 'hidden';
        desc.style.textOverflow = 'ellipsis';
        desc.style.marginTop = '2px';
        desc.textContent = cmd.description || `${cmd._triggers.join(', ')}`;

        const triggers = document.createElement('div');
        triggers.className = 'zion-slash-trigger';
        triggers.style.fontSize = '11px';
        triggers.style.marginTop = '2px';
        triggers.textContent = `/${cmd._triggers[0]}`;

        text.appendChild(title);
        text.appendChild(desc);
        text.appendChild(triggers);

        item.appendChild(icon);
        item.appendChild(text);

        // Click handler
        item.onclick = () => {
          selectCommand(cmd);
        };

        item.onmouseenter = () => {
          if (Date.now() - slashLastMouseMoveAt < 120) {
            setSlashActiveIndex(itemIndex);
          }
        };

        slashCurrentItemEls.push(item);

        slashList.appendChild(item);
      });
    });

    if (slashSelectedIndex >= slashCurrentItemEls.length) slashSelectedIndex = 0;
    setSlashActiveIndex(slashSelectedIndex);
  };

  const showSlashPanel = (x, y, triggerText = '') => {
    const panel = createSlashPanel();

    const prevTriggerText = slashTriggerText;
    slashTriggerText = triggerText;
    panel.style.display = 'block';

    // Position panel near cursor
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const panelRect = panel.getBoundingClientRect();

    let posX = x;
    let posY = y + 20;

    // Keep panel in viewport
    if (posX + panelRect.width > viewportWidth - 20) {
      posX = viewportWidth - panelRect.width - 20;
    }
    if (posX < 20) posX = 20;
    if (posY + panelRect.height > viewportHeight - 20) {
      posY = y - panelRect.height - 10;
    }
    if (posY < 20) posY = 20;

    panel.style.left = `${posX}px`;
    panel.style.top = `${posY}px`;

    if (slashHeaderQuery) {
      if (slashNavMode === 'submenu') {
        const bc = getBreadcrumbText();
        const suffix = slashSubFilter ? ` ${slashSubFilter}` : '';
        slashHeaderQuery.textContent = `/${bc}${suffix}`;
      } else {
        slashHeaderQuery.textContent = `/${triggerText || ''}`;
      }
    }

    if (prevTriggerText !== triggerText) {
      slashSelectedIndex = 0;
      slashLastMouseMoveAt = 0;
    }

    renderSlashCommands(slashNavMode === 'submenu' ? slashSubFilter : triggerText);

    if (!slashDocKeydownAttached) {
      document.addEventListener('keydown', onSlashGlobalKeyDown, true);
      slashDocKeydownAttached = true;
    }

    if (!slashDocMousedownAttached) {
      document.addEventListener('mousedown', onSlashGlobalMouseDown, true);
      slashDocMousedownAttached = true;
    }

    if (!slashDocMousemoveAttached) {
      document.addEventListener('mousemove', onSlashGlobalMouseMove, true);
      slashDocMousemoveAttached = true;
    }

    if (!slashDocCompositionAttached) {
      document.addEventListener('compositionstart', onSlashGlobalCompositionStart, true);
      document.addEventListener('compositionend', onSlashGlobalCompositionEnd, true);
      slashDocCompositionAttached = true;
    }
  };

  const onSlashGlobalMouseDown = (e) => {
    if (!isSlashPanelOpen()) return;
    if (slashPanel && e.target && slashPanel.contains(e.target)) return;
    hideSlashPanel();
  };

  const onSlashGlobalKeyDown = (e) => {
    if (!isSlashPanelOpen()) return;

    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hideSlashPanel();
      return;
    }

    if (slashNavMode === 'submenu') {
      if (e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        if (slashSubFilter) {
          slashSubFilter = slashSubFilter.slice(0, -1);
          if (slashHeaderQuery) {
            const bc = getBreadcrumbText();
            const suffix = slashSubFilter ? ` ${slashSubFilter}` : '';
            slashHeaderQuery.textContent = `/${bc}${suffix}`;
          }
          renderSlashCommands(slashSubFilter);
        } else if (slashNavStack.length) {
          selectCommand({ __navBack: true });
        }
        return;
      }

      if (e.key && e.key.length === 1 && !/\s/.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        slashSubFilter += e.key;
        if (slashHeaderQuery) {
          const bc = getBreadcrumbText();
          const suffix = slashSubFilter ? ` ${slashSubFilter}` : '';
          slashHeaderQuery.textContent = `/${bc}${suffix}`;
        }
        renderSlashCommands(slashSubFilter);
        return;
      }
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setSlashActiveIndex(slashSelectedIndex + 1);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setSlashActiveIndex(slashSelectedIndex - 1);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      const cmd = slashCurrentCommands[slashSelectedIndex];
      if (!cmd) return;
      e.preventDefault();
      e.stopPropagation();
      const deferClean = slashCompositionActive || !!e.isComposing || (e.keyCode === 229);
      selectCommand(cmd, { deferClean });
    }
  };

  const hideSlashPanel = () => {
    if (slashPanel) {
      slashPanel.style.display = 'none';
      slashTriggerText = '';
    }

    slashNavStack = [];
    slashNavMode = 'root';
    slashSubFilter = '';

    if (slashDocKeydownAttached) {
      document.removeEventListener('keydown', onSlashGlobalKeyDown, true);
      slashDocKeydownAttached = false;
    }
    if (slashDocMousedownAttached) {
      document.removeEventListener('mousedown', onSlashGlobalMouseDown, true);
      slashDocMousedownAttached = false;
    }

    if (slashDocMousemoveAttached) {
      document.removeEventListener('mousemove', onSlashGlobalMouseMove, true);
      slashDocMousemoveAttached = false;
    }

    if (slashDocCompositionAttached) {
      document.removeEventListener('compositionstart', onSlashGlobalCompositionStart, true);
      document.removeEventListener('compositionend', onSlashGlobalCompositionEnd, true);
      slashDocCompositionAttached = false;
    }

    slashCompositionActive = false;
  };

  const waitForNextFrame = () => {
    return new Promise((resolve) => {
      const raf = globalThis.requestAnimationFrame;
      if (typeof raf === 'function') {
        raf(() => raf(resolve));
      } else {
        setTimeout(resolve, 0);
      }
    });
  };

  const selectCommand = async (cmd, opts) => {
    const deferClean = (opts && Object.prototype.hasOwnProperty.call(opts, 'deferClean'))
      ? !!opts.deferClean
      : slashCompositionActive;
    if (cmd && cmd.__navBack) {
      if (!slashNavStack.length) {
        slashNavMode = 'root';
        slashSubFilter = '';
        if (slashHeaderQuery) slashHeaderQuery.textContent = `/${slashTriggerText || ''}`;
        renderSlashCommands(slashTriggerText);
        return;
      }
      slashNavStack.pop();
      slashSubFilter = '';
      if (!slashNavStack.length) {
        slashNavMode = 'root';
        if (slashHeaderQuery) slashHeaderQuery.textContent = `/${slashTriggerText || ''}`;
        renderSlashCommands(slashTriggerText);
        return;
      }
      const parent = slashNavStack[slashNavStack.length - 1];
      parent._submenuItems = await resolveSubmenuItems(parent);
      if (slashHeaderQuery) {
        const bc = getBreadcrumbText();
        slashHeaderQuery.textContent = `/${bc}`;
      }
      slashSelectedIndex = (parent._submenuItems && parent._submenuItems.length) ? 1 : 0;
      renderSlashCommands('');
      return;
    }

    if (hasSubmenu(cmd)) {
      slashNavMode = 'submenu';
      slashSubFilter = '';
      const next = cmd;
      next._submenuItems = await resolveSubmenuItems(next);
      slashNavStack.push(next);
      if (slashHeaderQuery) {
        const bc = getBreadcrumbText();
        slashHeaderQuery.textContent = `/${bc}`;
      }
      slashSelectedIndex = (next._submenuItems && next._submenuItems.length) ? 1 : 0;
      renderSlashCommands('');
      return;
    }

    hideSlashPanel();

    const editor = window.zion?.window?.activeEditor || null;

    try {
      editor?.focus?.();
    } catch {}

    let params = {};

    if (cmd.params && cmd.params.length > 0) {
      const inputParams = await showParameterDialog(cmd);
      if (!inputParams) return;
      params = inputParams;
    }

    if (deferClean) {
      await waitForNextFrame();
    }

    cleanSlashTrigger();

    try {
      if (typeof cmd.execute === 'function') {
        await cmd.execute(params, editor);
      }
    } catch (e) {
      console.error(`[dev.slash-commands] Error executing command ${cmd.id}:`, e);
    }

    try {
      editor?.focus?.();
    } catch {}
  };

  const cleanSlashTrigger = () => {
    if (slashStartPos) {
      const editor = window.zion?.window?.activeEditor;
      if (editor) {
        try {
          const from = slashStartPos;
          const to = editor.getCursor();
          if (to && to.line === from.line) {
            const start = from.ch <= to.ch ? from : to;
            const end = from.ch <= to.ch ? to : from;
            editor.replaceRange('', start, end);
            editor.setCursor(start);
          }
        } catch (e) {
          console.error('[dev.slash-commands] Error cleaning slash trigger:', e);
        }
      }
      slashStartPos = null;
    }
  };

  const showParameterDialog = async (cmd) => {
    // Create dialog
    const dialog = document.createElement('div');
    dialog.className = 'zion-slash-dialog';
    dialog.style.position = 'fixed';
    dialog.style.top = '0';
    dialog.style.left = '0';
    dialog.style.width = '100%';
    dialog.style.height = '100%';
    dialog.style.background = 'rgba(0, 0, 0, 0.5)';
    dialog.style.display = 'flex';
    dialog.style.alignItems = 'center';
    dialog.style.justifyContent = 'center';
    dialog.style.zIndex = '2000';

    const content = document.createElement('div');
    content.style.background = 'var(--panel, var(--bg, #1e1e1e))';
    content.style.border = '1px solid var(--border, #3c3c3c)';
    content.style.borderRadius = '6px';
    content.style.padding = '24px';
    content.style.minWidth = '300px';
    content.style.maxWidth = '400px';

    const title = document.createElement('h3');
    title.textContent = cmd.title;
    title.style.margin = '0 0 16px 0';
    title.style.color = 'var(--fg, #cccccc)';
    title.style.fontSize = '18px';
    content.appendChild(title);

    const params = {};

    const fieldControls = [];

    const loadSelectOptions = async (param, selectEl) => {
      const prevValue = selectEl.value;

      let opts = [];
      if (typeof param.asyncOptions === 'function') {
        try {
          opts = await param.asyncOptions(params);
        } catch (e) {
          console.error('[dev.slash-commands] asyncOptions error:', e);
          opts = [];
        }
      } else if (Array.isArray(param.options)) {
        opts = param.options;
      }

      selectEl.innerHTML = '';
      (opts || []).forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        selectEl.appendChild(option);
      });

      const hasPrev = opts && opts.some(o => String(o.value) === String(prevValue));
      if (hasPrev) {
        selectEl.value = prevValue;
        return;
      }

      if (param.default !== undefined && opts && opts.some(o => String(o.value) === String(param.default))) {
        selectEl.value = String(param.default);
        params[param.name] = param.type === 'number' ? Number(selectEl.value) : selectEl.value;
        return;
      }

      const first = opts && opts[0];
      if (first) {
        selectEl.value = String(first.value);
        params[param.name] = param.type === 'number' ? Number(selectEl.value) : selectEl.value;
      } else {
        delete params[param.name];
      }
    };

    const refreshDependentSelects = async (fromIndex) => {
      for (let i = fromIndex; i < fieldControls.length; i++) {
        const c = fieldControls[i];
        if (!c || c.type !== 'select') continue;
        await loadSelectOptions(c.param, c.el);
      }
    };

    // Render parameter fields
    const renderParamField = async (param, idx) => {
      const container = document.createElement('div');
      container.style.marginBottom = '16px';

        const label = document.createElement('label');
        label.textContent = param.label || param.name;
        label.style.display = 'block';
        label.style.marginBottom = '6px';
        label.style.color = 'var(--fg, #cccccc)';
        label.style.fontSize = '14px';
        container.appendChild(label);

        if (param.type === 'select') {
          const select = document.createElement('select');
          select.style.width = '100%';
          select.style.padding = '8px 12px';
          select.style.border = '1px solid var(--border, #3c3c3c)';
          select.style.borderRadius = '4px';
          select.style.background = 'var(--input-bg, #2d2d2d)';
          select.style.color = 'var(--fg, #cccccc)';
          select.style.outline = 'none';

          fieldControls[idx] = { param, type: 'select', el: select };
          await loadSelectOptions(param, select);

          select.onchange = async () => {
            params[param.name] = param.type === 'number' ? Number(select.value) : select.value;
            await refreshDependentSelects(idx + 1);
          };

          container.appendChild(select);
        } else if (param.type === 'boolean') {
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.id = `slash-param-${param.name}`;
          if (param.default) checkbox.checked = true;

          checkbox.onchange = async () => {
            params[param.name] = checkbox.checked;
            await refreshDependentSelects(idx + 1);
          };

          params[param.name] = !!param.default;

          const wrapper = document.createElement('div');
          wrapper.style.display = 'flex';
          wrapper.style.alignItems = 'center';
          wrapper.style.gap = '8px';
          wrapper.appendChild(checkbox);
          wrapper.appendChild(document.createTextNode('启用'));

          container.appendChild(wrapper);
        } else {
          // Text or number input
          const input = document.createElement('input');
          input.type = param.type === 'number' ? 'number' : 'text';
          input.placeholder = param.placeholder || '';
          input.style.width = '100%';
          input.style.padding = '8px 12px';
          input.style.border = '1px solid var(--border, #3c3c3c)';
          input.style.borderRadius = '4px';
          input.style.background = 'var(--input-bg, #2d2d2d)';
          input.style.color = 'var(--fg, #cccccc)';
          input.style.outline = 'none';

          if (param.min !== undefined) input.min = param.min;
          if (param.max !== undefined) input.max = param.max;
          if (param.default !== undefined) input.value = param.default;

          input.oninput = async () => {
            const val = param.type === 'number' ? Number(input.value) : input.value;
            params[param.name] = val;
            await refreshDependentSelects(idx + 1);
          };

          // Set initial value
          if (param.default !== undefined) {
            params[param.name] = param.type === 'number' ? Number(param.default) : param.default;
          }

          container.appendChild(input);
        }

      return container;
    };

    // Render all params
    for (let i = 0; i < cmd.params.length; i++) {
      const param = cmd.params[i];
      const field = await renderParamField(param, i);
      content.appendChild(field);
    }

    // Buttons
    const buttons = document.createElement('div');
    buttons.style.display = 'flex';
    buttons.style.gap = '12px';
    buttons.style.marginTop = '24px';
    buttons.style.justifyContent = 'flex-end';

    return await new Promise((resolve) => {
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = '取消';
      cancelBtn.style.padding = '8px 16px';
      cancelBtn.style.border = '1px solid var(--border, #3c3c3c)';
      cancelBtn.style.borderRadius = '4px';
      cancelBtn.style.background = 'transparent';
      cancelBtn.style.color = 'var(--fg, #cccccc)';
      cancelBtn.style.cursor = 'pointer';
      cancelBtn.onclick = () => {
        document.body.removeChild(dialog);
        resolve(null);
      };

      const confirmBtn = document.createElement('button');
      confirmBtn.textContent = '确定';
      confirmBtn.style.padding = '8px 16px';
      confirmBtn.style.border = 'none';
      confirmBtn.style.borderRadius = '4px';
      confirmBtn.style.background = 'var(--accent, #007acc)';
      confirmBtn.style.color = '#ffffff';
      confirmBtn.style.cursor = 'pointer';
      confirmBtn.onclick = () => {
        document.body.removeChild(dialog);
        resolve(params);
      };

      buttons.appendChild(cancelBtn);
      buttons.appendChild(confirmBtn);
      content.appendChild(buttons);

      dialog.appendChild(content);
      document.body.appendChild(dialog);

      // Focus first input
      const firstInput = content.querySelector('input, select');
      if (firstInput) firstInput.focus();
    });
  };

  // ===== Editor Event Handling =====
  let editorUpdateListener = null;

  const attachEditorListener = () => {
    if (editorUpdateListener) return;

    editorUpdateListener = window.zion.events.on('editor.change', async ({ update, view }) => {
      try {
        if (slashNavMode === 'submenu' && isSlashPanelOpen()) return;
        if (!view) return;

        lastEditorView = view;

        const triggerChars = ['/', '／', '、', '。'];

        const selection = view.state.selection.main;
        const pos = selection.head;
        const line = view.state.doc.lineAt(pos);

        const lineText = view.state.doc.sliceString(line.from, pos);
        let triggerIdx = -1;
        for (const ch of triggerChars) {
          const idx = lineText.lastIndexOf(ch);
          if (idx > triggerIdx) triggerIdx = idx;
        }

        const validPrefix = triggerIdx === 0 || (triggerIdx > 0 && /\s/.test(lineText[triggerIdx - 1]));
        const query = triggerIdx >= 0 ? lineText.slice(triggerIdx + 1) : '';
        const validQuery = !/\s/.test(query);
        const validQueryChars = !query || /^[A-Za-z0-9_#`.-]+$/.test(query);

        if (triggerIdx >= 0 && validPrefix && validQuery && validQueryChars) {
          const triggerText = query;
          slashStartPos = { line: line.number - 1, ch: triggerIdx };

          const coords = view.coordsAtPos(pos);
          if (coords) {
            showSlashPanel(coords.left, coords.top, triggerText);
          }
        } else {
          // Hide panel if slash is not valid anymore
          if (slashPanel && slashPanel.style.display !== 'none') {
            hideSlashPanel();
          }
          if (!validQueryChars) slashStartPos = null;
        }
      } catch (e) {
        console.error('[dev.slash-commands] Error in editor change handler:', e);
      }
    });

    ctx.subscriptions.push(editorUpdateListener);
  };

  // ===== Register Core Command =====
  const dShow = window.zion.commands.registerCommand('slash.show', () => {
    const editor = window.zion?.window?.activeEditor;
    if (!editor) return;

    const cursor = editor.getCursor();
    slashStartPos = { ...cursor };

    // Show panel at cursor position
    const view = (editor.core && editor.core.view);
    if (view) {
      const pos = view.state.doc.line(cursor.line + 1).from;
      const coords = view.coordsAtPos(pos);
      if (coords) {
        showSlashPanel(coords.left, coords.top, '');
      }
    } else {
      // Fallback: estimate position
      showSlashPanel(100, 100, '');
    }
  });
  ctx.subscriptions.push(dShow);

  // ===== Initialize =====
  registerBuiltInCommands();
  attachEditorListener();

  // ===== Expose API =====
  window.zion.slash = {
    registerCommand: registerSlashCommand,
    getAllCommands: getAllCommands,
    getCommand: getCommand,
    executeCommand: executeCommand,
    onCommandsChanged: onCommandsChanged
  };

  console.log('[dev.slash-commands] Plugin activated. Type "/" in editor to see commands.');
}
