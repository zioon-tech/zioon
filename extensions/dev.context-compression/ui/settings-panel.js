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
        <h2>Context Compression Settings</h2>
        
        ${this.renderGeneralSettings()}
        ${this.renderStrategySettings(strategies)}
        ${this.renderAdvancedSettings()}
        ${this.renderStatisticsPreview()}
        
        <div class="settings-actions">
          <button id="save-settings" class="btn btn-primary">Save Settings</button>
          <button id="reset-settings" class="btn btn-secondary">Reset to Defaults</button>
          <button id="cancel-settings" class="btn btn-secondary">Cancel</button>
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
        <h3>General Settings</h3>
        
        <div class="setting-item">
          <label>
            <input type="checkbox" id="auto-compression" 
                   ${this.settings.autoCompression ? 'checked' : ''}>
            Enable Auto Compression
          </label>
          <small>Automatically compress conversations when they reach threshold</small>
        </div>

        <div class="setting-item">
          <label>
            <input type="checkbox" id="debug-logging" 
                   ${this.settings.debugLogging ? 'checked' : ''}>
            Enable Debug Logging
          </label>
          <small>Log compression decisions and before/after metrics to console</small>
        </div>
        
        <div class="setting-item">
          <label for="default-strategy">Default Strategy:</label>
          <select id="default-strategy">
            <option value="auto" ${this.settings.defaultStrategy === 'auto' ? 'selected' : ''}>
              Auto (智能选择)
            </option>
            <option value="opencode" ${this.settings.defaultStrategy === 'opencode' ? 'selected' : ''}>
              OpenCode (压缩+修剪)
            </option>
            <option value="claude-code" ${this.settings.defaultStrategy === 'claude-code' ? 'selected' : ''}>
              Claude Code (简单总结)
            </option>
            <option value="cursor" ${this.settings.defaultStrategy === 'cursor' ? 'selected' : ''}>
              Cursor (动态发现)
            </option>
            <option value="manus" ${this.settings.defaultStrategy === 'manus' ? 'selected' : ''}>
              Manus (KV-Cache优化)
            </option>
            <option value="focus-agent" ${this.settings.defaultStrategy === 'focus-agent' ? 'selected' : ''}>
              Focus Agent (主动压缩)
            </option>
          </select>
          <small>Choose default compression strategy</small>
        </div>
        
        <div class="setting-item">
          <label for="threshold">Compression Threshold:</label>
          <input type="range" id="threshold" min="0.5" max="1.0" step="0.05" 
                 value="${this.settings.threshold}">
          <span id="threshold-value">${Math.round(this.settings.threshold * 100)}%</span>
          <small>Trigger compression when context reaches this percentage of limit</small>
        </div>

        <div class="setting-item">
          <label for="context-limit-tokens">Context Limit (tokens):</label>
          <input type="number" id="context-limit-tokens" 
                 value="${this.settings.contextLimitTokens}" min="0" step="1024">
          <small>Approximate model context window for auto-compression trigger</small>
        </div>

        <div class="setting-item">
          <label for="output-tokens">Output Budget (tokens):</label>
          <input type="number" id="output-tokens" 
                 value="${this.settings.outputTokens}" min="0" step="256">
          <small>Reserved output tokens for overflow calculations</small>
        </div>

        <div class="setting-item">
          <label for="chars-per-token">Chars Per Token:</label>
          <input type="number" id="chars-per-token" 
                 value="${this.settings.charsPerToken}" min="1" step="1">
          <small>Token estimation factor (default 4)</small>
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
        <h3>Strategy Details</h3>
        
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
      <div class="strategy-settings ${this.settings.defaultStrategy === 'opencode' || this.settings.defaultStrategy === 'auto' ? '' : 'hidden'}" id="opencode-settings">
        <h4>OpenCode Settings</h4>
        
        <div class="setting-item">
          <label for="prune-protect">Prune Protect (tokens):</label>
          <input type="number" id="prune-protect" 
                 value="${this.settings.pruneProtect}" min="0" step="1000">
          <small>Retain this many recent tokens (default: 40,000)</small>
        </div>
        
        <div class="setting-item">
          <label for="prune-minimum">Prune Minimum (tokens):</label>
          <input type="number" id="prune-minimum" 
                 value="${this.settings.pruneMinimum}" min="0" step="1000">
          <small>Minimum tokens to save before pruning (default: 20,000)</small>
        </div>
        
        <div class="setting-item">
          <label for="protected-tools">Protected Tools:</label>
          <input type="text" id="protected-tools" 
                 value="${this.settings.protectedTools.join(', ')}">
          <small>Tools to never prune (comma-separated, default: skill)</small>
        </div>
        
        <div class="strategy-description">
          <strong>OpenCode 策略说明:</strong>
          <p>采用双层压缩策略：</p>
          <ul>
            <li><strong>修剪（Pruning）</strong>: 智能删除旧工具输出，保护最近40K tokens</li>
            <li><strong>压缩（Compaction）</strong>: 生成总结，清空历史</li>
          </ul>
          <p><strong>触发条件:</strong> 当 tokens > context_limit - output_limit 时触发</p>
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
      <div class="strategy-settings ${this.settings.defaultStrategy === 'cursor' || this.settings.defaultStrategy === 'auto' ? '' : 'hidden'}" id="cursor-settings">
        <h4>Cursor Settings</h4>
        
        <div class="setting-item">
          <label for="max-tool-output">Max Tool Output Length:</label>
          <input type="number" id="max-tool-output" 
                 value="${this.settings.maxToolOutputLength}" min="1000" step="500">
          <small>Characters before writing to file (default: 5000)</small>
        </div>
        
        <div class="strategy-description">
          <strong>Cursor 策略说明:</strong>
          <p>采用动态上下文发现策略：</p>
          <ul>
            <li><strong>长工具输出 → 文件</strong>: 超过阈值的输出写入文件，减少上下文膨胀</li>
            <li><strong>MCP工具按需加载</strong>: 只加载需要的工具描述，减少46.9% tokens</li>
            <li><strong>历史文件引用</strong>: 压缩时引用历史文件，可按需恢复细节</li>
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
      <div class="strategy-settings ${this.settings.defaultStrategy === 'manus' || this.settings.defaultStrategy === 'auto' ? '' : 'hidden'}" id="manus-settings">
        <h4>Manus Settings</h4>
        
        <div class="setting-item">
          <label>
            <input type="checkbox" id="kv-cache-opt" 
                   ${this.settings.kvCacheOptimization ? 'checked' : ''}>
            Enable KV-Cache Optimization
          </label>
          <small>Reduce costs by 10x (Claude Sonnet: $0.30 vs $3/MTok)</small>
        </div>
        
        <div class="setting-item">
          <label>
            <input type="checkbox" id="stable-prefix" 
                   ${this.settings.stablePrefix ? 'checked' : ''}>
            Stable System Prefix
          </label>
          <small>Avoid timestamps and dynamic content for better cache hit rate</small>
        </div>
        
        <div class="setting-item">
          <label>
            <input type="checkbox" id="deterministic-serialization" 
                   ${this.settings.deterministicSerialization ? 'checked' : ''}>
            Deterministic Serialization
          </label>
          <small>Stable JSON key ordering for consistent caching</small>
        </div>
        
        <div class="strategy-description">
          <strong>Manus 策略说明:</strong>
          <p>采用KV-Cache优化策略：</p>
          <ul>
            <li><strong>稳定系统提示前缀</strong>: 不包含时间戳等动态内容</li>
            <li><strong>仅追加上下文</strong>: 不修改历史消息</li>
            <li><strong>确定性序列化</strong>: 稳定的JSON key顺序</li>
            <li><strong>可恢复压缩</strong>: 保留URL/路径引用，按需恢复内容</li>
          </ul>
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
      <div class="strategy-settings ${this.settings.defaultStrategy === 'focus-agent' || this.settings.defaultStrategy === 'auto' ? '' : 'hidden'}" id="focus-agent-settings">
        <h4>Focus Agent Settings</h4>
        
        <div class="setting-item">
          <label for="compression-interval">Compression Interval:</label>
          <input type="number" id="compression-interval" 
                 value="${this.settings.compressionInterval}" min="5" step="5">
          <small>Compress every N tool calls (default: 15)</small>
        </div>
        
        <div class="setting-item">
          <label for="min-tool-calls">Min Tool Calls:</label>
          <input type="number" id="min-tool-calls" 
                 value="${this.settings.minToolCalls}" min="1" step="1">
          <small>Minimum calls before first compression (default: 5)</small>
        </div>
        
        <div class="strategy-description">
          <strong>Focus Agent 策略说明:</strong>
          <p>采用主动压缩策略：</p>
          <ul>
            <li><strong>start_focus</strong>: 声明调查主题</li>
            <li><strong>explore</strong>: 使用标准工具探索</li>
            <li><strong>consolidate</strong>: 生成知识块总结</li>
            <li><strong>withdraw</strong>: 删除原始日志，保留知识</li>
          </ul>
          <p><strong>锯齿模式</strong>: 探索期间增长，压缩期间坍塌</p>
          <p><strong>效果</strong>: 在SWE-bench Lite上节省22.7% tokens，保持相同准确率</p>
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
        <h3>Advanced Settings</h3>
        
        <div class="setting-item">
          <label>
            <input type="checkbox" id="dynamic-context-discovery" 
                   ${this.settings.dynamicContextDiscovery ? 'checked' : ''}>
            Enable Dynamic Context Discovery
          </label>
          <small>Cursor-style: load context on demand (46.9% token reduction)</small>
        </div>
        
        <div class="setting-item">
          <label>
            <input type="checkbox" id="show-statistics" 
                   ${this.settings.showStatistics ? 'checked' : ''}>
            Show Compression Statistics
          </label>
          <small>Display token savings and compression metrics</small>
        </div>
        
        <div class="setting-item">
          <label>
            <input type="checkbox" id="show-compression-history" 
                   ${this.settings.showCompressionHistory ? 'checked' : ''}>
            Show Compression History
          </label>
          <small>Track compression events and their outcomes</small>
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
        <h3>Compression Statistics</h3>
        
        <div class="statistics-summary">
          <div class="stat-item">
            <span class="stat-label">Total Tokens Saved:</span>
            <span class="stat-value">${this.formatTokens(stats.totalTokensSaved || 0)}</span>
          </div>
          
          <div class="stat-item">
            <span class="stat-label">Compression Count:</span>
            <span class="stat-value">${stats.compressionCount || 0}</span>
          </div>
          
          <div class="stat-item">
            <span class="stat-label">Average Savings:</span>
            <span class="stat-value">${this.formatTokens(stats.averageSavings || 0)}</span>
          </div>
          
          <div class="stat-item">
            <span class="stat-label">Cost Savings:</span>
            <span class="stat-value">$${(stats.costSavings || 0).toFixed(2)}</span>
          </div>
        </div>
        
        <div class="strategy-breakdown">
          <h4>Strategy Usage</h4>
          ${this.renderStrategyUsage(stats.strategyUsage || {})}
        </div>
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
      return '<p>No compression events yet.</p>';
    }
    
    let html = '<ul class="strategy-usage-list">';
    
    for (const [strategy, count] of strategies) {
      const percent = count > 0 ? (count / Object.values(strategyUsage).reduce((a, b) => a + b, 0) * 100).toFixed(1) : 0;
      html += `
        <li>
          <span class="strategy-name">${this.formatStrategyName(strategy)}</span>
          <span class="strategy-count">${count}x</span>
          <span class="strategy-percent">${percent}%</span>
        </li>
      `;
    }
    
    html += '</ul>';
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
      const cancelBtn = document.getElementById('cancel-settings');
      
      if (saveBtn) {
        saveBtn.addEventListener('click', () => this.saveSettings());
      }
      
      if (resetBtn) {
        resetBtn.addEventListener('click', () => this.resetSettings());
      }
      
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => this.hide());
      }
      
      // Attach listeners for settings changes
      this.attachSettingListeners();
    }, 100);
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
   * Show panel
   */
  show() {
    if (this.panelElement) {
      this.panelElement.classList.remove('hidden');
    } else {
      this.panelElement = document.createElement('div');
      this.panelElement.className = 'compression-settings-panel-wrapper';
      this.panelElement.innerHTML = this.render();
      document.body.appendChild(this.panelElement);
    }
    
    this.attachEventListeners();
  }
  
  /**
   * Hide panel
   */
  hide() {
    if (this.panelElement) {
      this.panelElement.classList.add('hidden');
    }
  }
  
  /**
   * Get current settings
   * @returns {Object} Current settings
   */
  getSettings() {
    return { ...this.settings };
  }
}
