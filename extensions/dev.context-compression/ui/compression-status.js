/**
 * Compression Status
 * 
 * Provides status bar component for displaying compression information
 */

export class CompressionStatus {
  constructor(compressionEngine) {
    this.engine = compressionEngine;
    this.statusElement = null;
    this.tooltipElement = null;
  }
  
  /**
   * Render compression status
   * @returns {HTMLElement} Status element
   */
  render() {
    const status = this.getCurrentStatus();

    const element = document.createElement('div');
    element.className = 'status-item compression-status';
    element.innerHTML = `
      <span class="status-icon" title="${status.title}">${status.icon}</span>
      <span class="status-text" title="${status.title}">${status.text}</span>
    `;

    // Add tooltip
    if (status.hasTooltip) {
      element.addEventListener('mouseenter', () => this.showTooltip(status));
      element.addEventListener('mouseleave', () => this.hideTooltip());
    }

    return element;
  }
  
  /**
   * Get current compression status
   * @returns {Object} Status information
   */
  getCurrentStatus() {
    const stats = window.zion?.state?.get?.('compression.stats') || {};
    const settings = window.zion?.state?.get?.('compression.settings') || {};
    
    const status = {
      icon: '📦',
      text: 'No compression',
      title: 'Compression Status',
      hasTooltip: false,
      tokensSaved: stats.totalTokensSaved || 0,
      compressionCount: stats.compressionCount || 0,
      lastCompression: stats.lastCompressionTime,
      autoCompression: settings.autoCompression,
      activeStrategy: settings.defaultStrategy
    };
    
    // Update status based on compression activity
    if (status.compressionCount > 0) {
      status.text = `${this.formatTokens(status.tokensSaved)} saved`;
      status.icon = '💾';
      status.title = `${status.compressionCount} compressions performed`;
      status.hasTooltip = true;
    }
    
    // Update based on auto-compression setting
    if (status.autoCompression) {
      status.text += ' (Auto)';
    }
    
    return status;
  }
  
  /**
   * Show tooltip with detailed information
   * @param {Object} status - Status information
   */
  showTooltip(status) {
    // Remove existing tooltip
    this.hideTooltip();

    const tooltip = document.createElement('div');
    tooltip.className = 'zion-compression-tooltip';

    const timeSinceCompression = status.lastCompression ?
      this.formatTimeAgo(Date.now() - status.lastCompression) : 'Never';

    tooltip.innerHTML = `
      <div class="tooltip-content">
        <h4>Compression Status</h4>
        <div class="tooltip-section">
          <span class="tooltip-label">Strategy:</span>
          <span class="tooltip-value">${this.formatStrategyName(status.activeStrategy)}</span>
        </div>
        <div class="tooltip-section">
          <span class="tooltip-label">Auto Compression:</span>
          <span class="tooltip-value">${status.autoCompression ? 'Enabled' : 'Disabled'}</span>
        </div>
        <div class="tooltip-section">
          <span class="tooltip-label">Total Saved:</span>
          <span class="tooltip-value">${this.formatTokens(status.tokensSaved)}</span>
        </div>
        <div class="tooltip-section">
          <span class="tooltip-label">Compressions:</span>
          <span class="tooltip-value">${status.compressionCount}x</span>
        </div>
        <div class="tooltip-section">
          <span class="tooltip-label">Last Compression:</span>
          <span class="tooltip-value">${timeSinceCompression}</span>
        </div>
        <hr>
        <div class="tooltip-actions">
          <button class="zion-context-menu-item tooltip-action" data-action="compress">
            <span>🔄 Compress Now</span>
          </button>
          <button class="zion-context-menu-item tooltip-action" data-action="settings">
            <span>⚙️ Settings</span>
          </button>
          <button class="zion-context-menu-item tooltip-action" data-action="stats">
            <span>📊 Statistics</span>
          </button>
        </div>
      </div>
    `;

    // Position tooltip
    tooltip.style.position = 'absolute';
    tooltip.style.zIndex = '10000';
    tooltip.style.minWidth = '300px';

    // Add styles for the tooltip
    const styles = document.createElement('style');
    styles.textContent = this.getTooltipStyles();
    tooltip.appendChild(styles);

    document.body.appendChild(tooltip);
    this.tooltipElement = tooltip;

    // Add action handlers
    tooltip.querySelectorAll('.tooltip-action').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleTooltipAction(btn.dataset.action);
        this.hideTooltip();
      });
    });
  }
  
  /**
   * Hide tooltip
   */
  hideTooltip() {
    if (this.tooltipElement) {
      this.tooltipElement.remove();
      this.tooltipElement = null;
    }
  }
  
  /**
   * Handle tooltip action click
   * @param {string} action - Action to handle
   */
  handleTooltipAction(action) {
    switch (action) {
      case 'compress':
        window.zion?.commands?.execute?.('compression.manual');
        break;
      case 'settings':
      case 'stats':
        // Open the unified compression panel with the appropriate tab
        window.zion?.commands?.execute?.('compression.panel', { tab: action === 'settings' ? 'general' : 'statistics' });
        break;
    }
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
   * Format strategy name
   * @param {string} strategy - Strategy identifier
   * @returns {string} Formatted name
   */
  formatStrategyName(strategy) {
    const names = {
      'auto': 'Auto (智能选择)',
      'opencode': 'OpenCode (压缩+修剪)',
      'claude-code': 'Claude Code (简单总结)',
      'cursor': 'Cursor (动态发现)',
      'manus': 'Manus (KV-Cache优化)',
      'focus-agent': 'Focus Agent (主动压缩)'
    };
    
    return names[strategy] || strategy;
  }
  
  /**
   * Format time ago
   * @param {number} milliseconds - Milliseconds since event
   * @returns {string} Formatted time string
   */
  formatTimeAgo(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
      return `${days} day${days > 1 ? 's' : ''} ago`;
    } else if (hours > 0) {
      return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    } else if (minutes > 0) {
      return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    } else {
      return `${seconds} second${seconds > 1 ? 's' : ''} ago`;
    }
  }
  
  /**
   * Update status (refresh display)
   */
  update() {
    if (this.statusElement) {
      const newStatus = this.getCurrentStatus();

      // Update icon
      const iconElement = this.statusElement.querySelector('.status-icon');
      if (iconElement) {
        iconElement.textContent = newStatus.icon;
        iconElement.title = newStatus.title;
      }

      // Update text
      const textElement = this.statusElement.querySelector('.status-text');
      if (textElement) {
        textElement.textContent = newStatus.text;
        textElement.title = newStatus.title;
      }
    }
  }

  /**
   * Get CSS styles for the tooltip
   * @returns {string} CSS content
   */
  getTooltipStyles() {
    return `
.zion-compression-tooltip {
  background: var(--panel);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.30);
  padding: 4px;
  min-width: 280px;
  max-width: 320px;
  font-size: 12px;
  font-family: var(--font-sans);
  display: flex;
  flex-direction: column;
  gap: 4px;
  animation: tooltip-fade-in 0.14s ease;
}
@keyframes tooltip-fade-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.zion-compression-tooltip .tooltip-content h4 {
  margin: 0;
  padding: 6px 8px;
  font-size: 12px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}
.zion-compression-tooltip .tooltip-section {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  font-size: 11px;
}
.zion-compression-tooltip .tooltip-label {
  opacity: 0.7;
  min-width: 80px;
}
.zion-compression-tooltip .tooltip-value {
  flex: 1;
  opacity: 0.9;
}
.zion-compression-tooltip hr {
  margin: 4px 0;
  border: none;
  border-top: 1px solid var(--border);
}
.zion-compression-tooltip .tooltip-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 2px;
}
`;
  }
  
  /**
   * Create detailed statistics view
   * @returns {HTMLElement} Statistics view
   */
  createStatisticsView() {
    const stats = window.zion?.state?.get?.('compression.stats') || {};
    
    const view = document.createElement('div');
    view.className = 'compression-statistics-view';
    
    view.innerHTML = `
      <h2>Compression Statistics</h2>
      
      <div class="stats-overview">
        <div class="stat-card">
          <h3>Total Tokens Saved</h3>
          <div class="stat-value-large">${this.formatTokens(stats.totalTokensSaved || 0)}</div>
        </div>
        
        <div class="stat-card">
          <h3>Total Compressions</h3>
          <div class="stat-value-large">${stats.compressionCount || 0}</div>
        </div>
        
        <div class="stat-card">
          <h3>Average Savings</h3>
          <div class="stat-value-large">${this.formatTokens(stats.averageSavings || 0)}</div>
        </div>
        
        <div class="stat-card">
          <h3>Cost Savings</h3>
          <div class="stat-value-large">$${(stats.costSavings || 0).toFixed(2)}</div>
        </div>
      </div>
      
      <div class="stats-breakdown">
        <h3>Strategy Breakdown</h3>
        ${this.renderStrategyBreakdown(stats.strategyUsage || {})}
      </div>
      
      <div class="stats-history">
        <h3>Recent Compressions</h3>
        ${this.renderCompressionHistory(stats.compressionHistory || [])}
      </div>
    `;
    
    return view;
  }
  
  /**
   * Render strategy breakdown
   * @param {Object} strategyUsage - Strategy usage data
   * @returns {string} HTML content
   */
  renderStrategyBreakdown(strategyUsage) {
    const strategies = Object.entries(strategyUsage);
    
    if (strategies.length === 0) {
      return '<p>No compression events yet.</p>';
    }
    
    const total = Object.values(strategyUsage).reduce((a, b) => a + b, 0);
    
    let html = '<div class="strategy-breakdown-grid">';
    
    for (const [strategy, count] of strategies) {
      const percent = total > 0 ? (count / total * 100).toFixed(1) : 0;
      
      html += `
        <div class="strategy-breakdown-item">
          <div class="strategy-name">${this.formatStrategyName(strategy)}</div>
          <div class="strategy-metrics">
            <div class="metric">
              <span class="metric-label">Count:</span>
              <span class="metric-value">${count}x</span>
            </div>
            <div class="metric">
              <span class="metric-label">Usage:</span>
              <span class="metric-value">${percent}%</span>
            </div>
          </div>
        </div>
      `;
    }
    
    html += '</div>';
    return html;
  }
  
  /**
   * Render compression history
   * @param {Array} history - Compression history
   * @returns {string} HTML content
   */
  renderCompressionHistory(history) {
    if (history.length === 0) {
      return '<p>No compression history yet.</p>';
    }
    
    const recent = history.slice(-10); // Last 10 compressions
    
    let html = '<div class="compression-history-list">';
    
    for (const event of recent) {
      const timestamp = new Date(event.timestamp).toLocaleString();
      const savings = this.formatTokens(event.savings);
      
      html += `
        <div class="history-item">
          <div class="history-timestamp">${timestamp}</div>
          <div class="history-details">
            <span class="history-strategy">${this.formatStrategyName(event.strategy)}</span>
            <span class="history-savings">Saved: ${savings} tokens</span>
            <span class="history-reduction">${event.reductionPercent}% reduction</span>
          </div>
        </div>
      `;
    }
    
    html += '</div>';
    return html;
  }
}
