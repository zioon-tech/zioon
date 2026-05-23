/**
 * Compression Settings Panel
 *
 * Provides UI for configuring compression settings
 */

const PANEL_I18N = {
  "zh-CN": {
    "title": "上下文压缩",
    "close": "关闭面板",
    "tab.general": "通用",
    "tab.strategies": "策略",
    "tab.compress": "压缩",
    "tab.statistics": "统计",
    "btn.reset": "重置",
    "btn.save": "保存",
    "section.auto": "自动压缩",
    "label.enableAuto": "启用自动压缩",
    "help.enableAuto": "达到阈值时压缩对话",
    "label.strategy": "策略",
    "label.auto": "自动（智能选择）",
    "label.threshold": "阈值",
    "section.limits": "限制",
    "label.contextLimit": "上下文上限",
    "label.outputBudget": "输出预算",
    "label.charsPerToken": "每 Token 字符数",
    "help.charsPerToken": "Token 估算系数（默认 4）",
    "label.debugLogging": "调试日志",
    "help.debugLogging": "在控制台记录压缩决策",
    "section.strategyConfig": "策略配置",
    "section.advanced": "高级",
    "section.compression": "压缩",
    "btn.preview": "预览",
    "stat.current": "当前",
    "stat.after": "压缩后",
    "stat.saved": "节省",
    "stat.messages": "消息数",
    "label.preview": "预览",
    "placeholder.preview": "点击预览生成压缩文本...",
    "btn.apply": "压缩（保留快照）",
    "section.versions": "版本",
    "btn.clearHistory": "清空历史",
    "section.overview": "概览",
    "stat.totalSaved": "总节省",
    "stat.compressions": "压缩次数",
    "stat.avgSavings": "平均节省",
    "stat.costSaved": "节省成本",
    "section.strategyUsage": "策略使用",
    "empty.events": "暂无压缩事件",
    "empty.versions": "暂无版本",
    "btn.restore": "恢复",
    "btn.delete": "删除",
    "badge.compactionPruning": "压缩 + 剪枝",
    "badge.dynamicDiscovery": "动态发现",
    "badge.kvCache": "KV-Cache 优化",
    "badge.activeCompression": "主动压缩",
    "badge.minimalToolRecords": "最小工具记录",
    "label.pruneProtect": "剪枝保护",
    "help.pruneProtect": "保留的最近 token 数",
    "label.pruneMinimum": "剪枝下限",
    "help.pruneMinimum": "开始剪枝前的最小 token 数",
    "label.protectedTools": "受保护工具",
    "placeholder.protectedTools": "例如：skill, search",
    "help.protectedTools": "逗号分隔，列出永不剪枝的工具",
    "label.maxToolOutput": "最大工具输出",
    "help.maxToolOutput": "超过该字符数后写入文件",
    "desc.dynamicDiscovery": "动态上下文发现：",
    "desc.longOutputs": "长输出写入文件",
    "desc.mcpDemand": "MCP 工具按需加载",
    "desc.historyRefs": "历史文件引用",
    "label.kvCache": "KV-Cache 优化",
    "help.kvCache": "通过缓存命中降低成本",
    "label.stablePrefix": "稳定系统前缀",
    "help.stablePrefix": "避免时间戳以提升缓存命中",
    "label.deterministicSerialization": "确定性序列化",
    "help.deterministicSerialization": "稳定 JSON key 顺序",
    "desc.kvCache": "为一致缓存优化 KV-Cache",
    "label.interval": "间隔",
    "help.interval": "每 N 次调用压缩一次",
    "label.minCalls": "最小调用数",
    "help.minCalls": "首次压缩前需要的调用数",
    "desc.activeCompression": "采用锯齿模式的主动压缩",
    "label.tokensProtect": "保护 Token",
    "help.tokensProtect": "总 token 低于该值时跳过压缩",
    "label.tokensCompact": "压缩 Token",
    "help.tokensCompact": "要求节省量超过阈值",
    "label.recentProtectTokens": "最近保护 Token",
    "help.recentProtectTokens": "保留最近 token 不压缩",
    "label.maxPromptChars": "最大 Prompt 字符",
    "help.maxPromptChars": "记录 prompt 长度限制",
    "label.keepRecentTurns": "保留最近轮次",
    "help.keepRecentTurns": "完整保留的 assistant-tool 对数",
    "label.dynamicContextDiscovery": "动态上下文发现",
    "help.dynamicContextDiscovery": "按需加载上下文（减少 46.9% token）",
    "label.showStatistics": "显示统计",
    "help.showStatistics": "显示 token 节省和指标",
    "label.showHistory": "显示历史",
    "help.showHistory": "跟踪压缩事件",
    "version.history": "历史",
    "version.current": "当前",
    "version.generic": "版本",
    "version.active": "活动",
    "version.messages": "{count} 条消息",
    "version.saved": "节省 {count}"
  },
  "en-US": {}
};

function panelT(key, fallback) {
  try {
    const fullKey = `dev.context-compression.panel.${key}`;
    const translated = window.zion?.i18n?.t?.(fullKey);
    if (translated && translated !== fullKey) return translated;
    const locale = window.zion?.i18n?.getLocale?.() || "en-US";
    return PANEL_I18N[locale]?.[key] || fallback;
  } catch {
    return fallback;
  }
}

export class CompressionSettingsPanel {
  constructor(compressionEngine) {
    this.engine = compressionEngine;
    this.settings = this.getDefaultSettings();
    this.panelElement = null;
    this.root = null;
    this.currentTab = 'general';
    this.i18nDispose = null;
  }

  t(key, fallback) {
    return panelT(key, fallback);
  }

  /**
   * Show panel (using unified panel manager)
   * @param {Object} options - Options
   * @param {string} options.tab - Initial tab to show ('general', 'strategies', 'statistics')
   */
  show(options) {
    this.openSettingsPanel(options?.tab);
  }

  /**
   * Hide panel
   */
  hide() {
    if (this.root) {
      this.root.remove();
      this.root = null;
    }
    try { this.i18nDispose?.dispose?.(); } catch {}
    this.i18nDispose = null;
    this.panelElement = null;
  }
  
  /**
   * Get default settings
   * @returns {Object} Default settings
   */
  getDefaultSettings() {
    return {
      // General settings
      autoCompression: true,
      debugLogging: true,
      defaultStrategy: 'auto',
      threshold: 0.95,
      contextLimitTokens: 128000,
      outputTokens: 4096,
      charsPerToken: 4,
      
      // OpenCode-specific
      pruneProtect: 40000,
      pruneMinimum: 20000,
      protectedTools: ['skill'],
      
      // KV-Cache optimization
      kvCacheOptimization: true,
      stablePrefix: true,
      deterministicSerialization: true,
      
      // Dynamic context discovery
      dynamicContextDiscovery: true,
      maxToolOutputLength: 5000,
      
      // Focus Agent
      compressionInterval: 15,
      minToolCalls: 5,
      
      // Progressive strategy
      progressiveTokensProtect: 0,
      progressiveTokensCompact: 0,
      progressiveRecentProtectTokens: 20000,
      progressiveMaxRecordPromptChars: 100,
      progressiveKeepRecentTurns: 2,
      
      // UI settings
      showStatistics: true,
      showCompressionHistory: true
    };
  }
  
  /**
   * Load settings from storage
   * @returns {Promise<Object>} Loaded settings
   */
  async loadSettings() {
    try {
      const res = await window.zion?.commands?.executeCommand?.('compression.settings.load');
      const saved = res?.settings || window.zion?.state?.get?.('compression.settings');
      if (saved) this.settings = { ...this.settings, ...saved };
    } catch (error) {
      console.error('Failed to load compression settings:', error);
    }
    
    return this.settings;
  }
  
  /**
   * Save settings to storage
   * @returns {Promise<void>}
   */
  async saveSettings() {
    try {
      const res = await window.zion?.commands?.executeCommand?.('compression.settings.save', this.settings);
      if (!res?.ok) throw new Error('save_failed');
    } catch (error) {
      console.error('Failed to save compression settings:', error);
    }
  }
  
  /**
   * Render settings panel
   * @returns {string} HTML content
   */
  render() {
    const strategies = ['auto', 'opencode', 'claude-code', 'cursor', 'manus', 'focus-agent', 'progressive'];

    return `
      <div class="compression-settings-panel">
        <div class="panel-header">
          <div class="header-title">
            <span class="title-icon">📦</span>
            <span>${this.t("title", "Context Compression")}</span>
          </div>
          <button class="header-close" title="${this.t("close", "Close panel")}">✕</button>
        </div>

        <div class="panel-tabs">
          <button class="tab-btn ${this.currentTab === 'general' ? 'active' : ''}" data-tab="general">
            ${this.t("tab.general", "General")}
          </button>
          <button class="tab-btn ${this.currentTab === 'strategies' ? 'active' : ''}" data-tab="strategies">
            ${this.t("tab.strategies", "Strategies")}
          </button>
          <button class="tab-btn ${this.currentTab === 'compress' ? 'active' : ''}" data-tab="compress">
            ${this.t("tab.compress", "Compress")}
          </button>
          <button class="tab-btn ${this.currentTab === 'statistics' ? 'active' : ''}" data-tab="statistics">
            ${this.t("tab.statistics", "Statistics")}
          </button>
        </div>

        <div class="panel-content">
          <div class="tab-content ${this.currentTab === 'general' ? 'active' : ''}" id="tab-general">
            ${this.renderGeneralSettings()}
            ${this.renderAdvancedSettings()}
          </div>

          <div class="tab-content ${this.currentTab === 'strategies' ? 'active' : ''}" id="tab-strategies">
            ${this.renderStrategySettings(strategies)}
          </div>

          <div class="tab-content ${this.currentTab === 'compress' ? 'active' : ''}" id="tab-compress">
            ${this.renderCompressionTab(strategies)}
          </div>

          <div class="tab-content ${this.currentTab === 'statistics' ? 'active' : ''}" id="tab-statistics">
            ${this.renderStatisticsPreview()}
          </div>
        </div>

        <div class="panel-footer">
          <button id="reset-settings" class="btn-secondary">${this.t("btn.reset", "Reset")}</button>
          <button id="save-settings" class="btn-primary">${this.t("btn.save", "Save")}</button>
        </div>
      </div>
    `;
  }
  
  /**
   * Render general settings section
   * @returns {string} HTML content
   */
  renderGeneralSettings() {
    return `
      <div class="settings-section">
        <div class="section-title">${this.t("section.auto", "Auto Compression")}</div>

        <div class="setting-item">
          <label class="toggle-label">
            <input type="checkbox" id="auto-compression" ${this.settings.autoCompression ? 'checked' : ''}>
            <span class="toggle-slider"></span>
            <span>${this.t("label.enableAuto", "Enable Auto Compression")}</span>
          </label>
          <small>${this.t("help.enableAuto", "Compress conversations when threshold is reached")}</small>
        </div>

        <div class="setting-row">
          <div class="setting-col">
            <label for="default-strategy" class="field-label">${this.t("label.strategy", "Strategy")}</label>
            <select id="default-strategy" class="field-input">
              <option value="auto" ${this.settings.defaultStrategy === 'auto' ? 'selected' : ''}>${this.t("label.auto", "Auto (智能选择)")}</option>
              <option value="opencode" ${this.settings.defaultStrategy === 'opencode' ? 'selected' : ''}>OpenCode</option>
              <option value="claude-code" ${this.settings.defaultStrategy === 'claude-code' ? 'selected' : ''}>Claude Code</option>
              <option value="cursor" ${this.settings.defaultStrategy === 'cursor' ? 'selected' : ''}>Cursor</option>
              <option value="manus" ${this.settings.defaultStrategy === 'manus' ? 'selected' : ''}>Manus</option>
              <option value="focus-agent" ${this.settings.defaultStrategy === 'focus-agent' ? 'selected' : ''}>Focus Agent</option>
              <option value="progressive" ${this.settings.defaultStrategy === 'progressive' ? 'selected' : ''}>Progressive</option>
            </select>
          </div>

          <div class="setting-col">
            <label for="threshold" class="field-label">${this.t("label.threshold", "Threshold")}</label>
            <div class="range-wrapper">
              <input type="range" id="threshold" min="0.5" max="1.0" step="0.05" value="${this.settings.threshold}">
              <span id="threshold-value" class="range-value">${Math.round(this.settings.threshold * 100)}%</span>
            </div>
          </div>
        </div>

        <div class="section-title">${this.t("section.limits", "Limits")}</div>

        <div class="setting-row">
          <div class="setting-col">
            <label for="context-limit-tokens" class="field-label">${this.t("label.contextLimit", "Context Limit")}</label>
            <input type="number" id="context-limit-tokens" class="field-input"
                   value="${this.settings.contextLimitTokens}" min="0" step="1024">
          </div>

          <div class="setting-col">
            <label for="output-tokens" class="field-label">${this.t("label.outputBudget", "Output Budget")}</label>
            <input type="number" id="output-tokens" class="field-input"
                   value="${this.settings.outputTokens}" min="0" step="256">
          </div>
        </div>

        <div class="setting-item">
          <label for="chars-per-token" class="field-label">${this.t("label.charsPerToken", "Chars Per Token")}</label>
          <input type="number" id="chars-per-token" class="field-input"
                 value="${this.settings.charsPerToken}" min="1" step="1">
          <small>${this.t("help.charsPerToken", "Token estimation factor (default 4)")}</small>
        </div>

        <div class="setting-item">
          <label class="toggle-label">
            <input type="checkbox" id="debug-logging" ${this.settings.debugLogging ? 'checked' : ''}>
            <span class="toggle-slider"></span>
            <span>${this.t("label.debugLogging", "Debug Logging")}</span>
          </label>
          <small>${this.t("help.debugLogging", "Log compression decisions to console")}</small>
        </div>
      </div>
    `;
  }
  
  /**
   * Render strategy-specific settings
   * @param {Array} strategies - Available strategies
   * @returns {string} HTML content
   */
  renderStrategySettings(strategies) {
    return `
      <div class="settings-section">
        <div class="section-title">${this.t("section.strategyConfig", "Strategy Configuration")}</div>

        ${this.renderOpenCodeSettings()}
        ${this.renderCursorSettings()}
        ${this.renderManusSettings()}
        ${this.renderFocusAgentSettings()}
        ${this.renderProgressiveSettings()}
      </div>
    `;
  }
  
  /**
   * Render OpenCode-specific settings
   * @returns {string} HTML content
   */
  renderOpenCodeSettings() {
    return `
      <div class="strategy-card">
        <div class="strategy-header">
          <span class="strategy-name">OpenCode</span>
          <span class="strategy-badge">${this.t("badge.compactionPruning", "Compaction + Pruning")}</span>
        </div>

        <div class="setting-row">
          <div class="setting-col">
            <label for="prune-protect" class="field-label">${this.t("label.pruneProtect", "Prune Protect")}</label>
            <input type="number" id="prune-protect" class="field-input"
                   value="${this.settings.pruneProtect}" min="0" step="1000">
            <small>${this.t("help.pruneProtect", "Recent tokens to retain")}</small>
          </div>

          <div class="setting-col">
            <label for="prune-minimum" class="field-label">${this.t("label.pruneMinimum", "Prune Minimum")}</label>
            <input type="number" id="prune-minimum" class="field-input"
                   value="${this.settings.pruneMinimum}" min="0" step="1000">
            <small>${this.t("help.pruneMinimum", "Min tokens before pruning")}</small>
          </div>
        </div>

        <div class="setting-item">
          <label for="protected-tools" class="field-label">${this.t("label.protectedTools", "Protected Tools")}</label>
          <input type="text" id="protected-tools" class="field-input"
                 value="${this.settings.protectedTools.join(', ')}" placeholder="${this.t("placeholder.protectedTools", "e.g., skill, search")}">
          <small>${this.t("help.protectedTools", "Comma-separated tools to never prune")}</small>
        </div>
      </div>
    `;
  }
  
  /**
   * Render Cursor-specific settings
   * @returns {string} HTML content
   */
  renderCursorSettings() {
    return `
      <div class="strategy-card">
        <div class="strategy-header">
          <span class="strategy-name">Cursor</span>
          <span class="strategy-badge">${this.t("badge.dynamicDiscovery", "Dynamic Discovery")}</span>
        </div>

        <div class="setting-item">
          <label for="max-tool-output" class="field-label">${this.t("label.maxToolOutput", "Max Tool Output")}</label>
          <input type="number" id="max-tool-output" class="field-input"
                 value="${this.settings.maxToolOutputLength}" min="1000" step="500">
          <small>${this.t("help.maxToolOutput", "Characters before writing to file")}</small>
        </div>

        <div class="strategy-description">
          <p>${this.t("desc.dynamicDiscovery", "Dynamic context discovery:")}</p>
          <ul>
            <li>${this.t("desc.longOutputs", "Long outputs -> written to file")}</li>
            <li>${this.t("desc.mcpDemand", "MCP tools loaded on demand")}</li>
            <li>${this.t("desc.historyRefs", "Historical file references")}</li>
          </ul>
        </div>
      </div>
    `;
  }
  
  /**
   * Render Manus-specific settings
   * @returns {string} HTML content
   */
  renderManusSettings() {
    return `
      <div class="strategy-card">
        <div class="strategy-header">
          <span class="strategy-name">Manus</span>
          <span class="strategy-badge">${this.t("badge.kvCache", "KV-Cache Optimization")}</span>
        </div>

        <div class="setting-item">
          <label class="toggle-label">
            <input type="checkbox" id="kv-cache-opt" ${this.settings.kvCacheOptimization ? 'checked' : ''}>
            <span class="toggle-slider"></span>
            <span>${this.t("label.kvCache", "KV-Cache Optimization")}</span>
          </label>
          <small>${this.t("help.kvCache", "Reduce costs by 10x")}</small>
        </div>

        <div class="setting-item">
          <label class="toggle-label">
            <input type="checkbox" id="stable-prefix" ${this.settings.stablePrefix ? 'checked' : ''}>
            <span class="toggle-slider"></span>
            <span>${this.t("label.stablePrefix", "Stable System Prefix")}</span>
          </label>
          <small>${this.t("help.stablePrefix", "Avoid timestamps for better cache hits")}</small>
        </div>

        <div class="setting-item">
          <label class="toggle-label">
            <input type="checkbox" id="deterministic-serialization" ${this.settings.deterministicSerialization ? 'checked' : ''}>
            <span class="toggle-slider"></span>
            <span>${this.t("label.deterministicSerialization", "Deterministic Serialization")}</span>
          </label>
          <small>${this.t("help.deterministicSerialization", "Stable JSON key ordering")}</small>
        </div>

        <div class="strategy-description">
          <p>${this.t("desc.kvCache", "KV-Cache optimization for consistent caching")}</p>
        </div>
      </div>
    `;
  }
  
  /**
   * Render Focus Agent-specific settings
   * @returns {string} HTML content
   */
  renderFocusAgentSettings() {
    return `
      <div class="strategy-card">
        <div class="strategy-header">
          <span class="strategy-name">Focus Agent</span>
          <span class="strategy-badge">${this.t("badge.activeCompression", "Active Compression")}</span>
        </div>

        <div class="setting-row">
          <div class="setting-col">
            <label for="compression-interval" class="field-label">${this.t("label.interval", "Interval")}</label>
            <input type="number" id="compression-interval" class="field-input"
                   value="${this.settings.compressionInterval}" min="5" step="5">
            <small>${this.t("help.interval", "Compress every N calls")}</small>
          </div>

          <div class="setting-col">
            <label for="min-tool-calls" class="field-label">${this.t("label.minCalls", "Min Calls")}</label>
            <input type="number" id="min-tool-calls" class="field-input"
                   value="${this.settings.minToolCalls}" min="1" step="1">
            <small>${this.t("help.minCalls", "Before first compression")}</small>
          </div>
        </div>

        <div class="strategy-description">
          <p>${this.t("desc.activeCompression", "Active compression with sawtooth pattern")}</p>
        </div>
      </div>
    `;
  }
  
  renderProgressiveSettings() {
    return `
      <div class="strategy-card">
        <div class="strategy-header">
          <span class="strategy-name">Progressive</span>
          <span class="strategy-badge">${this.t("badge.minimalToolRecords", "Minimal Tool Records")}</span>
        </div>
        <div class="setting-row">
          <div class="setting-col">
            <label for="progressive-tokens-protect" class="field-label">${this.t("label.tokensProtect", "Tokens Protect")}</label>
            <input type="number" id="progressive-tokens-protect" class="field-input"
                   value="${this.settings.progressiveTokensProtect}" min="0" step="1000">
            <small>${this.t("help.tokensProtect", "Skip compression if total tokens below")}</small>
          </div>
          <div class="setting-col">
            <label for="progressive-tokens-compact" class="field-label">${this.t("label.tokensCompact", "Tokens Compact")}</label>
            <input type="number" id="progressive-tokens-compact" class="field-input"
                   value="${this.settings.progressiveTokensCompact}" min="0" step="1000">
            <small>${this.t("help.tokensCompact", "Require savings above threshold")}</small>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-col">
            <label for="progressive-recent-protect" class="field-label">${this.t("label.recentProtectTokens", "Recent Protect Tokens")}</label>
            <input type="number" id="progressive-recent-protect" class="field-input"
                   value="${this.settings.progressiveRecentProtectTokens}" min="0" step="1000">
            <small>${this.t("help.recentProtectTokens", "Keep recent tokens uncompressed")}</small>
          </div>
          <div class="setting-col">
            <label for="progressive-max-prompt" class="field-label">${this.t("label.maxPromptChars", "Max Prompt Chars")}</label>
            <input type="number" id="progressive-max-prompt" class="field-input"
                   value="${this.settings.progressiveMaxRecordPromptChars}" min="10" step="10">
            <small>${this.t("help.maxPromptChars", "Record prompt length limit")}</small>
          </div>
        </div>
        <div class="setting-item">
          <label for="progressive-keep-turns" class="field-label">${this.t("label.keepRecentTurns", "Keep Recent Turns")}</label>
          <input type="number" id="progressive-keep-turns" class="field-input"
                 value="${this.settings.progressiveKeepRecentTurns}" min="0" step="1">
          <small>${this.t("help.keepRecentTurns", "Assistant-tool pairs to keep in full")}</small>
        </div>
      </div>
    `;
  }
  
  /**
   * Render advanced settings
   * @returns {string} HTML content
   */
  renderAdvancedSettings() {
    return `
      <div class="settings-section">
        <div class="section-title">${this.t("section.advanced", "Advanced")}</div>

        <div class="setting-item">
          <label class="toggle-label">
            <input type="checkbox" id="dynamic-context-discovery" ${this.settings.dynamicContextDiscovery ? 'checked' : ''}>
            <span class="toggle-slider"></span>
            <span>${this.t("label.dynamicContextDiscovery", "Dynamic Context Discovery")}</span>
          </label>
          <small>${this.t("help.dynamicContextDiscovery", "Load context on demand (46.9% token reduction)")}</small>
        </div>

        <div class="setting-item">
          <label class="toggle-label">
            <input type="checkbox" id="show-statistics" ${this.settings.showStatistics ? 'checked' : ''}>
            <span class="toggle-slider"></span>
            <span>${this.t("label.showStatistics", "Show Statistics")}</span>
          </label>
          <small>${this.t("help.showStatistics", "Display token savings and metrics")}</small>
        </div>

        <div class="setting-item">
          <label class="toggle-label">
            <input type="checkbox" id="show-compression-history" ${this.settings.showCompressionHistory ? 'checked' : ''}>
            <span class="toggle-slider"></span>
            <span>${this.t("label.showHistory", "Show History")}</span>
          </label>
          <small>${this.t("help.showHistory", "Track compression events")}</small>
        </div>
      </div>
    `;
  }

  renderCompressionTab(strategies) {
    return `
      <div class="settings-section">
        <div class="section-title">${this.t("section.compression", "Compression")}</div>

        <div class="setting-row">
          <div class="setting-col">
            <label for="compress-strategy" class="field-label">${this.t("label.strategy", "Strategy")}</label>
            <select id="compress-strategy" class="field-input">
              <option value="auto" ${this.settings.defaultStrategy === 'auto' ? 'selected' : ''}>${this.t("label.auto", "Auto (智能选择)")}</option>
              <option value="opencode" ${this.settings.defaultStrategy === 'opencode' ? 'selected' : ''}>OpenCode</option>
              <option value="claude-code" ${this.settings.defaultStrategy === 'claude-code' ? 'selected' : ''}>Claude Code</option>
              <option value="cursor" ${this.settings.defaultStrategy === 'cursor' ? 'selected' : ''}>Cursor</option>
              <option value="manus" ${this.settings.defaultStrategy === 'manus' ? 'selected' : ''}>Manus</option>
              <option value="focus-agent" ${this.settings.defaultStrategy === 'focus-agent' ? 'selected' : ''}>Focus Agent</option>
              <option value="progressive" ${this.settings.defaultStrategy === 'progressive' ? 'selected' : ''}>Progressive</option>
            </select>
          </div>

          <div class="setting-col">
            <label class="field-label">&nbsp;</label>
            <button id="compress-preview-btn" class="btn-secondary" style="width:100%">${this.t("btn.preview", "Preview")}</button>
          </div>
        </div>

        <div class="stats-grid" id="compress-stats-grid">
          <div class="stat-card">
            <div class="stat-label">${this.t("stat.current", "Current")}</div>
            <div class="stat-value" id="compress-stat-current">-</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">${this.t("stat.after", "After")}</div>
            <div class="stat-value" id="compress-stat-after">-</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">${this.t("stat.saved", "Saved")}</div>
            <div class="stat-value" id="compress-stat-saved">-</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">${this.t("stat.messages", "Messages")}</div>
            <div class="stat-value" id="compress-stat-messages">-</div>
          </div>
        </div>

        <div class="setting-item">
          <label class="field-label">${this.t("label.preview", "Preview")}</label>
          <textarea id="compress-preview-text" class="compression-preview" readonly placeholder="${this.t("placeholder.preview", "Click Preview to generate compressed text...")}"></textarea>
          <small id="compress-preview-meta"></small>
        </div>

        <div class="panel-footer-inline">
          <button id="compress-apply-btn" class="btn-primary" style="width:100%">${this.t("btn.apply", "Compress (Keep snapshot)")}</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="section-title">${this.t("section.versions", "Versions")}</div>
        <div id="compression-versions-list" class="compression-versions-list"></div>
        <div class="panel-footer-inline">
          <button id="compression-versions-clear" class="btn-secondary" style="width:100%">${this.t("btn.clearHistory", "Clear all history")}</button>
        </div>
      </div>
    `;
  }
  
  /**
   * Render statistics preview
   * @returns {string} HTML content
   */
  renderStatisticsPreview() {
    const stats = window.zion?.state?.get?.('compression.stats') || {};

    return `
      <div class="settings-section">
        <div class="section-title">${this.t("section.overview", "Overview")}</div>

        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">${this.t("stat.totalSaved", "Total Saved")}</div>
            <div class="stat-value">${this.formatTokens(stats.totalTokensSaved || 0)}</div>
          </div>

          <div class="stat-card">
            <div class="stat-label">${this.t("stat.compressions", "Compressions")}</div>
            <div class="stat-value">${stats.compressionCount || 0}</div>
          </div>

          <div class="stat-card">
            <div class="stat-label">${this.t("stat.avgSavings", "Avg Savings")}</div>
            <div class="stat-value">${this.formatTokens(stats.averageSavings || 0)}</div>
          </div>

          <div class="stat-card">
            <div class="stat-label">${this.t("stat.costSaved", "Cost Saved")}</div>
            <div class="stat-value">$${(stats.costSavings || 0).toFixed(2)}</div>
          </div>
        </div>

        <div class="section-title" style="margin-top: 16px;">${this.t("section.strategyUsage", "Strategy Usage")}</div>
        ${this.renderStrategyUsage(stats.strategyUsage || {})}
      </div>
    `;
  }
  
  /**
   * Render strategy usage breakdown
   * @param {Object} strategyUsage - Strategy usage data
   * @returns {string} HTML content
   */
  renderStrategyUsage(strategyUsage) {
    const strategies = Object.entries(strategyUsage);

    if (strategies.length === 0) {
      return `<div class="empty-state">${this.t("empty.events", "No compression events yet")}</div>`;
    }

    const total = Object.values(strategyUsage).reduce((a, b) => a + b, 0);
    let html = '<div class="strategy-usage-list">';

    for (const [strategy, count] of strategies) {
      const percent = count > 0 ? (count / total * 100).toFixed(1) : 0;
      html += `
        <div class="usage-item">
          <span class="usage-name">${this.formatStrategyName(strategy)}</span>
          <div class="usage-bar">
            <div class="usage-fill" style="width: ${percent}%"></div>
          </div>
          <span class="usage-count">${count}x</span>
        </div>
      `;
    }

    html += '</div>';
    return html;
  }
  
  /**
   * Format tokens for display
   * @param {number} tokens - Token count
   * @returns {string} Formatted string
   */
  formatTokens(tokens) {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(1)}M`;
    } else if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(1)}K`;
    }
    return tokens.toString();
  }
  
  /**
   * Format strategy name for display
   * @param {string} strategy - Strategy name
   * @returns {string} Formatted name
   */
  formatStrategyName(strategy) {
    const names = {
      'opencode': 'OpenCode',
      'claude-code': 'Claude Code',
      'cursor': 'Cursor',
      'manus': 'Manus',
      'focus-agent': 'Focus Agent',
      'progressive': 'Progressive'
    };
    
    return names[strategy] || strategy;
  }
  
  /**
   * Attach event listeners to panel
   */
  attachEventListeners() {
    // Wait for DOM to be ready
    setTimeout(() => {
      const saveBtn = this.panelElement?.querySelector?.('#save-settings');
      const resetBtn = this.panelElement?.querySelector?.('#reset-settings');
      const closeBtn = this.panelElement?.querySelector?.('.header-close');

      if (saveBtn) {
        saveBtn.addEventListener('click', () => this.saveSettings());
      }

      if (resetBtn) {
        resetBtn.addEventListener('click', () => this.resetSettings());
      }

      if (closeBtn) {
        closeBtn.addEventListener('click', () => this.hide());
      }

      // Tab switching
      const tabBtns = this.panelElement?.querySelectorAll('.tab-btn');
      tabBtns?.forEach(btn => {
        btn.addEventListener('click', () => {
          const tab = btn.dataset.tab;
          this.switchTab(tab);
        });
      });

      // Attach listeners for settings changes
      this.attachSettingListeners();

      this.attachCompressionTabListeners();
      if (this.currentTab === 'compress') {
        this.refreshCompressionTab();
      }
    }, 100);
  }

  /**
   * Switch to a tab
   * @param {string} tabName - Tab name
   */
  switchTab(tabName) {
    this.currentTab = tabName;

    // Update tab buttons
    const tabBtns = this.panelElement?.querySelectorAll('.tab-btn');
    tabBtns?.forEach(btn => {
      if (btn.dataset.tab === tabName) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Update tab contents
    const tabContents = this.panelElement?.querySelectorAll('.tab-content');
    tabContents?.forEach(content => {
      if (content.id === `tab-${tabName}`) {
        content.classList.add('active');
      } else {
        content.classList.remove('active');
      }
    });

    if (tabName === 'compress') {
      this.refreshCompressionTab();
    }
  }

  attachCompressionTabListeners() {
    const previewBtn = this.panelElement?.querySelector?.('#compress-preview-btn');
    const applyBtn = this.panelElement?.querySelector?.('#compress-apply-btn');
    const strategySel = this.panelElement?.querySelector?.('#compress-strategy');
    const clearBtn = this.panelElement?.querySelector?.('#compression-versions-clear');
    const list = this.panelElement?.querySelector?.('#compression-versions-list');

    previewBtn?.addEventListener('click', () => this.refreshCompressionTab());
    strategySel?.addEventListener('change', () => this.refreshCompressionTab());

    applyBtn?.addEventListener('click', async () => {
      try {
        const strategy = String(strategySel?.value || 'auto');
        await window.zion?.commands?.executeCommand?.('compression.apply', { strategy, openPanel: false });
        await this.refreshCompressionTab();
      } catch {}
    });

    clearBtn?.addEventListener('click', async () => {
      try {
        await window.zion?.commands?.executeCommand?.('compression.versions.clear');
        await this.refreshCompressionTab();
      } catch {}
    });

    list?.addEventListener('click', async (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const btn = target.closest('button[data-action][data-id]');
      if (!(btn instanceof HTMLElement)) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (!action || !id) return;
      try {
        if (action === 'restore') {
          await window.zion?.commands?.executeCommand?.('compression.versions.restore', id);
        } else if (action === 'delete') {
          await window.zion?.commands?.executeCommand?.('compression.versions.delete', id);
        }
      } catch {}
      await this.refreshCompressionTab();
    });
  }

  async refreshCompressionTab() {
    const strategySel = this.panelElement?.querySelector?.('#compress-strategy');
    const previewEl = this.panelElement?.querySelector?.('#compress-preview-text');
    const metaEl = this.panelElement?.querySelector?.('#compress-preview-meta');
    const statCurrent = this.panelElement?.querySelector?.('#compress-stat-current');
    const statAfter = this.panelElement?.querySelector?.('#compress-stat-after');
    const statSaved = this.panelElement?.querySelector?.('#compress-stat-saved');
    const statMessages = this.panelElement?.querySelector?.('#compress-stat-messages');
    const listEl = this.panelElement?.querySelector?.('#compression-versions-list');

    const strategy = String(strategySel?.value || this.settings.defaultStrategy || 'auto');

    try {
      const preview = await window.zion?.commands?.executeCommand?.('compression.preview.compute', { strategy });
      if (preview && previewEl) {
        previewEl.value = String(preview.previewText || '');
        if (metaEl) {
          const tail = preview.truncated ? ' (truncated)' : '';
          metaEl.textContent = `Strategy: ${preview.strategy} · ${preview.ms}ms${tail}`;
        }
        if (statCurrent) statCurrent.textContent = `${this.formatTokens(preview.originalTokens || 0)}`;
        if (statAfter) statAfter.textContent = `${this.formatTokens(preview.compressedTokens || 0)}`;
        if (statSaved) statSaved.textContent = `${this.formatTokens(preview.savedTokens || 0)} (${Math.round((preview.savedPercent || 0) * 100)}%)`;
        if (statMessages) statMessages.textContent = `${preview.originalMessages || 0} → ${preview.compressedMessages || 0}`;
      }
    } catch {
      if (previewEl) previewEl.value = '';
      if (metaEl) metaEl.textContent = '';
    }

    try {
      const data = await window.zion?.commands?.executeCommand?.('compression.versions.list');
      const versions = Array.isArray(data?.versions) ? data.versions : [];
      const activeId = data?.activeId ? String(data.activeId) : null;
      if (listEl) {
        listEl.innerHTML = this.renderVersionsList(versions, activeId);
      }
    } catch {
      if (listEl) listEl.innerHTML = `<div class="empty-state">${this.t("empty.versions", "No versions yet")}</div>`;
    }
  }

  renderVersionsList(versions, activeId) {
    if (!Array.isArray(versions) || versions.length === 0) {
      return `<div class="empty-state">${this.t("empty.versions", "No versions yet")}</div>`;
    }

    const rows = versions.map((v, i) => {
      const id = String(v?.id || '');
      const ts = v?.createdAt ? new Date(v.createdAt).toLocaleString() : '-';
      const kind = v?.kind === 'before' ? this.t("version.history", "History") : (v?.kind === 'after' ? this.t("version.current", "Current") : this.t("version.generic", "Version"));
      const isActive = activeId && id === activeId;
      const title = isActive ? `${kind} (${this.t("version.active", "active")})` : kind;
      const tokens = typeof v?.tokens === 'number' ? this.formatTokens(v.tokens) : '-';
      const msgs = typeof v?.messages === 'number' ? String(v.messages) : '-';
      const strat = v?.strategy ? String(v.strategy) : '-';
      const saved = typeof v?.savedTokens === 'number' ? this.formatTokens(v.savedTokens) : '';

      return `
        <div class="compression-version-item ${isActive ? 'active' : ''}">
          <div class="version-main">
            <div class="version-title">${title}</div>
            <div class="version-meta">${ts} · ${strat} · ${this.t("version.messages", "{count} msgs").replace("{count}", msgs)} · ${tokens}${saved ? ` · ${this.t("version.saved", "saved {count}").replace("{count}", saved)}` : ''}</div>
          </div>
          <div class="version-actions">
            <button class="btn-mini" data-action="restore" data-id="${id}">${this.t("btn.restore", "Restore")}</button>
            <button class="btn-mini btn-danger" data-action="delete" data-id="${id}">${this.t("btn.delete", "Delete")}</button>
          </div>
        </div>
      `;
    });

    return rows.join('');
  }
  
  /**
   * Attach listeners to setting inputs
   */
  attachSettingListeners() {
    const inputs = {
      'auto-compression': 'autoCompression',
      'debug-logging': 'debugLogging',
      'default-strategy': 'defaultStrategy',
      'threshold': 'threshold',
      'context-limit-tokens': 'contextLimitTokens',
      'output-tokens': 'outputTokens',
      'chars-per-token': 'charsPerToken',
      'prune-protect': 'pruneProtect',
      'prune-minimum': 'pruneMinimum',
      'protected-tools': 'protectedTools',
      'max-tool-output': 'maxToolOutputLength',
      'kv-cache-opt': 'kvCacheOptimization',
      'stable-prefix': 'stablePrefix',
      'deterministic-serialization': 'deterministicSerialization',
      'compression-interval': 'compressionInterval',
      'min-tool-calls': 'minToolCalls',
      'dynamic-context-discovery': 'dynamicContextDiscovery',
      'show-statistics': 'showStatistics',
      'show-compression-history': 'showCompressionHistory',
      'progressive-tokens-protect': 'progressiveTokensProtect',
      'progressive-tokens-compact': 'progressiveTokensCompact',
      'progressive-recent-protect': 'progressiveRecentProtectTokens',
      'progressive-max-prompt': 'progressiveMaxRecordPromptChars',
      'progressive-keep-turns': 'progressiveKeepRecentTurns'
    };
    
    for (const [elementId, settingKey] of Object.entries(inputs)) {
      const element = this.panelElement?.querySelector?.(`#${elementId}`);
      if (element) {
        element.addEventListener('change', (e) => {
          this.updateSetting(settingKey, e.target);
        });
        
        // For range inputs, update display value
        if (element.type === 'range') {
          element.addEventListener('input', (e) => {
            const display = this.panelElement?.querySelector?.(`#${elementId}-value`);
            if (display) {
              display.textContent = `${Math.round(e.target.value * 100)}%`;
            }
            this.updateSetting(settingKey, e.target);
          });
        }
      }
    }
  }
  
  /**
   * Update a setting value
   * @param {string} key - Setting key
   * @param {HTMLElement} element - Input element
   */
  updateSetting(key, element) {
    const value = element.type === 'checkbox' ? element.checked : 
                  element.type === 'number' ? parseFloat(element.value) :
                  element.type === 'range' ? parseFloat(element.value) :
                  element.value;
    
    // Special handling for comma-separated lists
    if (key === 'protectedTools') {
      this.settings[key] = value.split(',').map(s => s.trim()).filter(s => s.length > 0);
    } else {
      this.settings[key] = value;
    }
  }
  
  /**
   * Reset settings to defaults
   */
  async resetSettings() {
    this.settings = this.getDefaultSettings();
    await this.saveSettings();
    this.render(); // Re-render panel
  }
  
  /**
   * Open settings panel
   * @param {string} initialTab - Initial tab to show (optional)
   */
  async openSettingsPanel(initialTab) {
    // Set initial tab if provided
    if (initialTab && ['general', 'strategies', 'compress', 'statistics'].includes(initialTab)) {
      this.currentTab = initialTab;
    }

    if (this.root && this.panelElement && document.body.contains(this.root)) {
      try {
        this.switchTab(this.currentTab);
        this.positionPanelFromStatusBar();
      } catch {}
      return;
    }

    if (this.root) {
      this.root.remove();
    }

    const root = document.createElement('div');
    root.className = 'zion-compression-settings-root';
    Object.assign(root.style, {
      position: 'fixed',
      inset: '0',
      background: 'transparent',
      zIndex: '100001',
      display: 'block'
    });

    const panel = document.createElement('div');
    panel.className = 'zion-compression-settings-panel';
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
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
      outline: 'none'
    });
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', this.t("title", "Context Compression"));
    panel.tabIndex = -1;

    // Load settings before rendering
    await this.loadSettings();

    const styles = document.createElement('style');
    styles.textContent = this.getStyles();
    panel.appendChild(styles);

    this.panelElement = panel;
    panel.insertAdjacentHTML('beforeend', this.render());

    root.appendChild(panel);
    document.body.appendChild(root);
    this.root = root;
    this.positionPanelFromStatusBar();

    // Click outside to close
    root.addEventListener('click', (e) => {
      if (e.target === root) {
        this.hide();
      }
    });

    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
      }
    });

    this.attachEventListeners();
    this.i18nDispose = window.zion?.events?.on?.("i18n/changed", () => {
      const tab = this.currentTab;
      this.hide();
      this.openSettingsPanel(tab);
    }) || null;
    panel.focus({ preventScroll: true });
  }

  positionPanelFromStatusBar() {
    const panel = this.panelElement;
    if (!panel) return;
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
    panel.style.maxHeight = 'min(65vh, calc(100vh - 24px))';
    if (!btn) {
      panel.style.right = '12px';
      panel.style.bottom = '36px';
      return;
    }
    const rect = btn.getBoundingClientRect();
    const width = Math.min(360, Math.max(240, vw - pad * 2));
    const maxRight = Math.max(pad, vw - width - pad);
    const right = Math.min(Math.max(pad, Math.round(vw - rect.right)), maxRight);
    const spaceAbove = Math.max(180, Math.round(rect.top - pad * 2));
    panel.style.width = `${width}px`;
    panel.style.maxHeight = `${Math.min(Math.round(vh * 0.65), spaceAbove)}px`;
    panel.style.right = `${right}px`;
    panel.style.bottom = `${Math.max(pad, Math.round(vh - rect.top + pad))}px`;
  }

  /**
   * Get CSS styles for the panel
   * @returns {string} CSS content
   */
  getStyles() {
    return `
.zion-compression-settings-panel { font-size: 13px; }
.zion-compression-settings-panel .panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.zion-compression-settings-panel .header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.zion-compression-settings-panel .title-icon { font-size: 16px; }
.zion-compression-settings-panel .header-close {
  background: transparent;
  border: none;
  color: var(--fg);
  cursor: pointer;
  font-size: 18px;
  padding: 2px 6px;
  border-radius: 4px;
  opacity: 0.7;
}
.zion-compression-settings-panel .header-close:hover {
  background: var(--border);
  opacity: 1;
}

/* Tabs */
.zion-compression-settings-panel .panel-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  gap: 0;
}
.zion-compression-settings-panel .tab-btn {
  flex: 1;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--fg);
  cursor: pointer;
  padding: 10px 0;
  font-size: 12px;
  font-weight: 500;
  opacity: 0.7;
  transition: all 0.15s ease;
  border-radius: 0;
}
.zion-compression-settings-panel .tab-btn:hover {
  opacity: 1;
  background: rgba(248,248,242,0.03);
}
:root[data-theme="light"] .zion-compression-settings-panel .tab-btn:hover {
  background: rgba(0,0,0,0.03);
}
.zion-compression-settings-panel .tab-btn.active {
  border-bottom-color: var(--accent);
  opacity: 1;
  background: rgba(98,114,164,0.08);
}
:root[data-theme="light"] .zion-compression-settings-panel .tab-btn.active {
  background: rgba(59,130,246,0.08);
}

/* Tab Content */
.zion-compression-settings-panel .panel-content { padding: 12px; }
.zion-compression-settings-panel .tab-content { display: none; }
.zion-compression-settings-panel .tab-content.active { display: block; }

/* Sections */
.zion-compression-settings-panel .settings-section { margin-bottom: 16px; }
.zion-compression-settings-panel .section-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
  opacity: 0.8;
  margin: 0 0 8px 0;
}

/* Setting Items */
.zion-compression-settings-panel .setting-item { margin-bottom: 12px; }
.zion-compression-settings-panel .setting-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 12px;
}
.zion-compression-settings-panel .setting-col { }

/* Form Controls */
.zion-compression-settings-panel .field-label {
  display: block;
  font-size: 11px;
  opacity: 0.75;
  margin-bottom: 4px;
}
.zion-compression-settings-panel .field-input,
.zion-compression-settings-panel select {
  width: 100%;
  box-sizing: border-box;
  background: var(--panel);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.zion-compression-settings-panel .field-input:focus,
.zion-compression-settings-panel select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(98,114,164,0.11);
}
:root[data-theme="light"] .zion-compression-settings-panel .field-input:focus,
:root[data-theme="light"] .zion-compression-settings-panel select:focus {
  box-shadow: 0 0 0 3px rgba(59,130,246,0.11);
}
.zion-compression-settings-panel small {
  display: block;
  font-size: 11px;
  opacity: 0.6;
  margin-top: 3px;
}

/* Toggle */
.zion-compression-settings-panel .toggle-label {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
}
.zion-compression-settings-panel .toggle-label input[type="checkbox"] {
  display: none;
}
.zion-compression-settings-panel .toggle-slider {
  width: 36px;
  height: 20px;
  background: var(--border);
  border-radius: 10px;
  position: relative;
  transition: background 0.25s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.15);
}
:root[data-theme="light"] .zion-compression-settings-panel .toggle-slider {
  box-shadow: inset 0 1px 2px rgba(0,0,0,0.08);
}
.zion-compression-settings-panel .toggle-slider::before {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  background: #f8f8f2;
  border-radius: 50%;
  top: 2px;
  left: 2px;
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), background 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}
:root[data-theme="light"] .zion-compression-settings-panel .toggle-slider::before {
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(0,0,0,0.15);
}
.zion-compression-settings-panel .toggle-label input:checked + .toggle-slider {
  background: var(--ok);
  box-shadow: inset 0 1px 2px rgba(0,0,0,0.2);
}
:root[data-theme="light"] .zion-compression-settings-panel .toggle-label input:checked + .toggle-slider {
  box-shadow: inset 0 1px 1px rgba(0,0,0,0.1);
}
.zion-compression-settings-panel .toggle-label input:checked + .toggle-slider::before {
  transform: translateX(16px);
  background: #ffffff;
}
.zion-compression-settings-panel .toggle-slider:hover {
  filter: brightness(1.15);
}
:root[data-theme="light"] .zion-compression-settings-panel .toggle-slider:hover {
  filter: brightness(0.95);
}

/* Range */
.zion-compression-settings-panel .range-wrapper {
  display: flex;
  align-items: center;
  gap: 8px;
}
.zion-compression-settings-panel .range-wrapper input[type="range"] {
  flex: 1;
}
.zion-compression-settings-panel .range-value {
  font-size: 11px;
  opacity: 0.75;
  min-width: 40px;
  text-align: right;
}

/* Strategy Cards */
.zion-compression-settings-panel .strategy-card {
  background: rgba(0,0,0,0.04);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 10px;
}
:root[data-theme="light"] .zion-compression-settings-panel .strategy-card {
  background: rgba(0,0,0,0.02);
}
.zion-compression-settings-panel .strategy-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.zion-compression-settings-panel .strategy-name {
  font-weight: 600;
  font-size: 12px;
}
.zion-compression-settings-panel .strategy-badge {
  font-size: 10px;
  padding: 2px 6px;
  background: var(--accent);
  color: var(--panel);
  border-radius: 10px;
  opacity: 0.8;
}
.zion-compression-settings-panel .strategy-description {
  font-size: 11px;
  opacity: 0.7;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.zion-compression-settings-panel .strategy-description p { margin: 0 0 4px 0; }
.zion-compression-settings-panel .strategy-description ul {
  margin: 4px 0;
  padding-left: 16px;
}
.zion-compression-settings-panel .strategy-description li { margin: 2px 0; }

/* Statistics Grid */
.zion-compression-settings-panel .stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.zion-compression-settings-panel .stat-card {
  background: rgba(0,0,0,0.04);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  text-align: center;
}
:root[data-theme="light"] .zion-compression-settings-panel .stat-card {
  background: rgba(0,0,0,0.02);
}
.zion-compression-settings-panel .stat-label {
  font-size: 11px;
  opacity: 0.7;
  margin-bottom: 4px;
}
.zion-compression-settings-panel .stat-value {
  font-size: 16px;
  font-weight: 600;
}

/* Strategy Usage List */
.zion-compression-settings-panel .strategy-usage-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.zion-compression-settings-panel .usage-item {
  display: grid;
  grid-template-columns: 100px 1fr 40px;
  gap: 8px;
  align-items: center;
}
.zion-compression-settings-panel .usage-name {
  font-size: 11px;
  opacity: 0.8;
}
.zion-compression-settings-panel .usage-bar {
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  overflow: hidden;
}
.zion-compression-settings-panel .usage-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.3s;
}
.zion-compression-settings-panel .usage-count {
  font-size: 11px;
  opacity: 0.75;
  text-align: right;
}

/* Empty State */
.zion-compression-settings-panel .empty-state {
  font-size: 12px;
  opacity: 0.6;
  text-align: center;
  padding: 16px;
  border: 1px dashed var(--border);
  border-radius: 6px;
}

/* Footer */
.zion-compression-settings-panel .panel-footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 10px 12px;
  border-top: 1px solid var(--border);
}
.zion-compression-settings-panel .btn-primary,
.zion-compression-settings-panel .btn-secondary {
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
  font-family: var(--font-sans);
}
.zion-compression-settings-panel .btn-primary {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
:root[data-theme="light"] .zion-compression-settings-panel .btn-primary {
  color: #fff;
}
.zion-compression-settings-panel .btn-secondary {
  background: transparent;
  color: var(--fg);
}
.zion-compression-settings-panel .btn-primary:hover {
  filter: brightness(1.08);
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(98,114,164,0.25);
}
:root[data-theme="light"] .zion-compression-settings-panel .btn-primary:hover {
  box-shadow: 0 2px 6px rgba(59,130,246,0.25);
}
.zion-compression-settings-panel .btn-secondary:hover {
  background: var(--border);
  transform: translateY(-1px);
}
.zion-compression-settings-panel .btn-primary:active,
.zion-compression-settings-panel .btn-secondary:active {
  transform: translateY(0);
}
/* Compression tab */
.zion-compression-settings-panel .compression-preview {
  width: 100%;
  box-sizing: border-box;
  min-height: 140px;
  max-height: 260px;
  resize: vertical;
  background: rgba(0,0,0,0.06);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font-size: 12px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
}
:root[data-theme="light"] .zion-compression-settings-panel .compression-preview {
  background: rgba(0,0,0,0.03);
}
.zion-compression-settings-panel .panel-footer-inline { margin-top: 10px; }
.zion-compression-settings-panel .compression-versions-list { display: flex; flex-direction: column; gap: 8px; }
.zion-compression-settings-panel .compression-version-item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  background: rgba(0,0,0,0.03);
}
:root[data-theme="light"] .zion-compression-settings-panel .compression-version-item {
  background: rgba(0,0,0,0.02);
}
.zion-compression-settings-panel .compression-version-item.active { border-color: var(--accent); }
.zion-compression-settings-panel .version-title { font-size: 12px; font-weight: 600; }
.zion-compression-settings-panel .version-meta { font-size: 11px; opacity: 0.75; margin-top: 4px; }
.zion-compression-settings-panel .version-actions { display: flex; gap: 6px; }
.zion-compression-settings-panel .btn-mini {
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--fg);
  font-size: 12px;
  cursor: pointer;
}
.zion-compression-settings-panel .btn-mini:hover { filter: brightness(1.08); }
.zion-compression-settings-panel .btn-mini.btn-danger { color: var(--danger, #ff6b6b); }
`;
  }
  
  /**
   * Get current settings
   * @returns {Object} Current settings
   */
  getSettings() {
    return { ...this.settings };
  }
}
