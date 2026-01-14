/**
 * Compression Settings Panel
 *
 * Provides UI for configuring compression settings
 */

export class CompressionSettingsPanel {
  constructor(compressionEngine) {
    this.engine = compressionEngine;
    this.settings = this.getDefaultSettings();
    this.panelElement = null;
    this.root = null;
    this.currentTab = 'general';
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
      const saved = window.zion?.state?.get?.('compression.settings');
      if (saved) {
        this.settings = { ...this.settings, ...saved };
      }
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
      await window.zion?.state?.set?.('compression.settings', this.settings);
      console.log('Compression settings saved:', this.settings);
    } catch (error) {
      console.error('Failed to save compression settings:', error);
    }
  }
  
  /**
   * Render settings panel
   * @returns {string} HTML content
   */
  render() {
    const strategies = ['auto', 'opencode', 'claude-code', 'cursor', 'manus', 'focus-agent'];

    return `
      <div class="compression-settings-panel">
        <div class="panel-header">
          <div class="header-title">
            <span class="title-icon">📦</span>
            <span>Context Compression</span>
          </div>
          <button class="header-close" title="Close panel">✕</button>
        </div>

        <div class="panel-tabs">
          <button class="tab-btn ${this.currentTab === 'general' ? 'active' : ''}" data-tab="general">
            General
          </button>
          <button class="tab-btn ${this.currentTab === 'strategies' ? 'active' : ''}" data-tab="strategies">
            Strategies
          </button>
          <button class="tab-btn ${this.currentTab === 'statistics' ? 'active' : ''}" data-tab="statistics">
            Statistics
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

          <div class="tab-content ${this.currentTab === 'statistics' ? 'active' : ''}" id="tab-statistics">
            ${this.renderStatisticsPreview()}
          </div>
        </div>

        <div class="panel-footer">
          <button id="reset-settings" class="btn-secondary">Reset</button>
          <button id="save-settings" class="btn-primary">Save</button>
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
        <div class="section-title">Auto Compression</div>

        <div class="setting-item">
          <label class="toggle-label">
            <input type="checkbox" id="auto-compression" ${this.settings.autoCompression ? 'checked' : ''}>
            <span class="toggle-slider"></span>
            <span>Enable Auto Compression</span>
          </label>
          <small>Compress conversations when threshold is reached</small>
        </div>

        <div class="setting-row">
          <div class="setting-col">
            <label for="default-strategy" class="field-label">Strategy</label>
            <select id="default-strategy" class="field-input">
              <option value="auto" ${this.settings.defaultStrategy === 'auto' ? 'selected' : ''}>Auto (智能选择)</option>
              <option value="opencode" ${this.settings.defaultStrategy === 'opencode' ? 'selected' : ''}>OpenCode</option>
              <option value="claude-code" ${this.settings.defaultStrategy === 'claude-code' ? 'selected' : ''}>Claude Code</option>
              <option value="cursor" ${this.settings.defaultStrategy === 'cursor' ? 'selected' : ''}>Cursor</option>
              <option value="manus" ${this.settings.defaultStrategy === 'manus' ? 'selected' : ''}>Manus</option>
              <option value="focus-agent" ${this.settings.defaultStrategy === 'focus-agent' ? 'selected' : ''}>Focus Agent</option>
            </select>
          </div>

          <div class="setting-col">
            <label for="threshold" class="field-label">Threshold</label>
            <div class="range-wrapper">
              <input type="range" id="threshold" min="0.5" max="1.0" step="0.05" value="${this.settings.threshold}">
              <span id="threshold-value" class="range-value">${Math.round(this.settings.threshold * 100)}%</span>
            </div>
          </div>
        </div>

        <div class="section-title">Limits</div>

        <div class="setting-row">
          <div class="setting-col">
            <label for="context-limit-tokens" class="field-label">Context Limit</label>
            <input type="number" id="context-limit-tokens" class="field-input"
                   value="${this.settings.contextLimitTokens}" min="0" step="1024">
          </div>

          <div class="setting-col">
            <label for="output-tokens" class="field-label">Output Budget</label>
            <input type="number" id="output-tokens" class="field-input"
                   value="${this.settings.outputTokens}" min="0" step="256">
          </div>
        </div>

        <div class="setting-item">
          <label for="chars-per-token" class="field-label">Chars Per Token</label>
          <input type="number" id="chars-per-token" class="field-input"
                 value="${this.settings.charsPerToken}" min="1" step="1">
          <small>Token estimation factor (default 4)</small>
        </div>

        <div class="setting-item">
          <label class="toggle-label">
            <input type="checkbox" id="debug-logging" ${this.settings.debugLogging ? 'checked' : ''}>
            <span class="toggle-slider"></span>
            <span>Debug Logging</span>
          </label>
          <small>Log compression decisions to console</small>
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
        <div class="section-title">Strategy Configuration</div>

        ${this.renderOpenCodeSettings()}
        ${this.renderCursorSettings()}
        ${this.renderManusSettings()}
        ${this.renderFocusAgentSettings()}
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
          <span class="strategy-badge">Compaction + Pruning</span>
        </div>

        <div class="setting-row">
          <div class="setting-col">
            <label for="prune-protect" class="field-label">Prune Protect</label>
            <input type="number" id="prune-protect" class="field-input"
                   value="${this.settings.pruneProtect}" min="0" step="1000">
            <small>Recent tokens to retain</small>
          </div>

          <div class="setting-col">
            <label for="prune-minimum" class="field-label">Prune Minimum</label>
            <input type="number" id="prune-minimum" class="field-input"
                   value="${this.settings.pruneMinimum}" min="0" step="1000">
            <small>Min tokens before pruning</small>
          </div>
        </div>

        <div class="setting-item">
          <label for="protected-tools" class="field-label">Protected Tools</label>
          <input type="text" id="protected-tools" class="field-input"
                 value="${this.settings.protectedTools.join(', ')}" placeholder="e.g., skill, search">
          <small>Comma-separated tools to never prune</small>
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
          <span class="strategy-badge">Dynamic Discovery</span>
        </div>

        <div class="setting-item">
          <label for="max-tool-output" class="field-label">Max Tool Output</label>
          <input type="number" id="max-tool-output" class="field-input"
                 value="${this.settings.maxToolOutputLength}" min="1000" step="500">
          <small>Characters before writing to file</small>
        </div>

        <div class="strategy-description">
          <p>Dynamic context discovery:</p>
          <ul>
            <li>Long outputs → written to file</li>
            <li>MCP tools loaded on demand</li>
            <li>Historical file references</li>
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
          <span class="strategy-badge">KV-Cache Optimization</span>
        </div>

        <div class="setting-item">
          <label class="toggle-label">
            <input type="checkbox" id="kv-cache-opt" ${this.settings.kvCacheOptimization ? 'checked' : ''}>
            <span class="toggle-slider"></span>
            <span>KV-Cache Optimization</span>
          </label>
          <small>Reduce costs by 10x</small>
        </div>

        <div class="setting-item">
          <label class="toggle-label">
            <input type="checkbox" id="stable-prefix" ${this.settings.stablePrefix ? 'checked' : ''}>
            <span class="toggle-slider"></span>
            <span>Stable System Prefix</span>
          </label>
          <small>Avoid timestamps for better cache hits</small>
        </div>

        <div class="setting-item">
          <label class="toggle-label">
            <input type="checkbox" id="deterministic-serialization" ${this.settings.deterministicSerialization ? 'checked' : ''}>
            <span class="toggle-slider"></span>
            <span>Deterministic Serialization</span>
          </label>
          <small>Stable JSON key ordering</small>
        </div>

        <div class="strategy-description">
          <p>KV-Cache optimization for consistent caching</p>
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
          <span class="strategy-badge">Active Compression</span>
        </div>

        <div class="setting-row">
          <div class="setting-col">
            <label for="compression-interval" class="field-label">Interval</label>
            <input type="number" id="compression-interval" class="field-input"
                   value="${this.settings.compressionInterval}" min="5" step="5">
            <small>Compress every N calls</small>
          </div>

          <div class="setting-col">
            <label for="min-tool-calls" class="field-label">Min Calls</label>
            <input type="number" id="min-tool-calls" class="field-input"
                   value="${this.settings.minToolCalls}" min="1" step="1">
            <small>Before first compression</small>
          </div>
        </div>

        <div class="strategy-description">
          <p>Active compression with sawtooth pattern</p>
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
        <div class="section-title">Advanced</div>

        <div class="setting-item">
          <label class="toggle-label">
            <input type="checkbox" id="dynamic-context-discovery" ${this.settings.dynamicContextDiscovery ? 'checked' : ''}>
            <span class="toggle-slider"></span>
            <span>Dynamic Context Discovery</span>
          </label>
          <small>Load context on demand (46.9% token reduction)</small>
        </div>

        <div class="setting-item">
          <label class="toggle-label">
            <input type="checkbox" id="show-statistics" ${this.settings.showStatistics ? 'checked' : ''}>
            <span class="toggle-slider"></span>
            <span>Show Statistics</span>
          </label>
          <small>Display token savings and metrics</small>
        </div>

        <div class="setting-item">
          <label class="toggle-label">
            <input type="checkbox" id="show-compression-history" ${this.settings.showCompressionHistory ? 'checked' : ''}>
            <span class="toggle-slider"></span>
            <span>Show History</span>
          </label>
          <small>Track compression events</small>
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
        <div class="section-title">Overview</div>

        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Total Saved</div>
            <div class="stat-value">${this.formatTokens(stats.totalTokensSaved || 0)}</div>
          </div>

          <div class="stat-card">
            <div class="stat-label">Compressions</div>
            <div class="stat-value">${stats.compressionCount || 0}</div>
          </div>

          <div class="stat-card">
            <div class="stat-label">Avg Savings</div>
            <div class="stat-value">${this.formatTokens(stats.averageSavings || 0)}</div>
          </div>

          <div class="stat-card">
            <div class="stat-label">Cost Saved</div>
            <div class="stat-value">$${(stats.costSavings || 0).toFixed(2)}</div>
          </div>
        </div>

        <div class="section-title" style="margin-top: 16px;">Strategy Usage</div>
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
      return '<div class="empty-state">No compression events yet</div>';
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
      'focus-agent': 'Focus Agent'
    };
    
    return names[strategy] || strategy;
  }
  
  /**
   * Attach event listeners to panel
   */
  attachEventListeners() {
    // Wait for DOM to be ready
    setTimeout(() => {
      const saveBtn = document.getElementById('save-settings');
      const resetBtn = document.getElementById('reset-settings');
      const closeBtn = document.querySelector('.header-close');

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
      'show-compression-history': 'showCompressionHistory'
    };
    
    for (const [elementId, settingKey] of Object.entries(inputs)) {
      const element = document.getElementById(elementId);
      if (element) {
        element.addEventListener('change', (e) => {
          this.updateSetting(settingKey, e.target);
        });
        
        // For range inputs, update display value
        if (element.type === 'range') {
          element.addEventListener('input', (e) => {
            const display = document.getElementById(`${elementId}-value`);
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
   * Show panel (using unified panel manager)
   */
  show() {
    this.openSettingsPanel();
  }

  /**
   * Hide panel
   */
  hide() {
    if (this.root) {
      this.root.remove();
      this.root = null;
    }
  }

  /**
   * Open settings panel
   * @param {string} initialTab - Initial tab to show (optional)
   */
  async openSettingsPanel(initialTab) {
    // Set initial tab if provided
    if (initialTab && ['general', 'strategies', 'statistics'].includes(initialTab)) {
      this.currentTab = initialTab;
    }

    if (this.root) {
      this.root.remove();
    }

    const root = document.createElement('div');
    root.className = 'zion-compression-settings-root';
    Object.assign(root.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '1000',
      display: 'block'
    });

    const panel = document.createElement('div');
    panel.className = 'zion-compression-settings-panel';
    Object.assign(panel.style, {
      position: 'fixed',
      top: '48px',
      right: '12px',
      width: '400px',
      maxHeight: '75vh',
      overflow: 'auto',
      background: 'var(--panel)',
      color: 'var(--fg)',
      border: '1px solid var(--border)',
      borderRadius: '8px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
      fontFamily: 'var(--font-sans)',
      pointerEvents: 'auto'
    });

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

    // Click outside to close
    root.addEventListener('click', (e) => {
      if (e.target === root) {
        this.hide();
      }
    });

    this.attachEventListeners();
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
