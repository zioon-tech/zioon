/**
 * Compression Core Engine
 * 
 * Manages multiple compression strategies and provides a unified interface
 */

export class CompressionEngine {
  constructor() {
    this.strategies = new Map();
    this.defaultStrategy = 'auto';
    this.config = {
      autoCompression: true,
      threshold: 0.95,
      maxTokens: 200000, // Default context window
      outputTokens: 4096,
      charsPerToken: 4,
      minTokensToCompress: 1000,
      savingsCalibration: 1.0,
      requireMeaningfulSavings: false
    };
  }
  
  /**
   * Register a compression strategy
   * @param {string} name - Strategy name
   * @param {Object} strategy - Strategy implementation
   */
  registerStrategy(name, strategy) {
    this.strategies.set(name, strategy);
    console.log(`Registered compression strategy: ${name}`);
  }
  
  /**
   * Get all available strategies
   * @returns {Array<string>} List of strategy names
   */
  getStrategies() {
    return Array.from(this.strategies.keys());
  }
  
  /**
   * Check if auto-compression should be triggered
   * @param {Object} context - Conversation context
   * @returns {Promise<boolean>} Whether to compress
   */
  async shouldAutoCompress(context) {
    if (!this.config.autoCompression) return false;
    
    const { messages = [], tokens = 0 } = context;
    if (messages.length < 5) return false; // Don't compress short conversations
    
    // Check token threshold
    if (tokens > this.config.maxTokens * this.config.threshold) {
      if (this.config.requireMeaningfulSavings) {
        const est = await this.estimateSavings(messages, 'auto');
        return est > this.config.minTokensToCompress;
      }
      return true;
    }
    
    // Check message count (heuristic)
    if (messages.length > 50) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Compress messages using specified strategy
   * @param {Array} messages - Conversation messages
   * @param {string} strategyName - Strategy to use ('auto' for automatic selection)
   * @returns {Promise<Array>} Compressed messages
   */
  async compress(messages, strategyName = 'auto') {
    if (!messages || messages.length === 0) {
      return messages;
    }
    
    const strategy = await this.selectStrategy(strategyName, messages);
    if (!strategy) {
      console.warn(`No compression strategy found: ${strategyName}`);
      return messages;
    }
    
    try {
      console.log(`Compressing with strategy: ${strategy.name}`);
      const context = this.createCompressionContext(messages);
      const compressed = await strategy.compress(context);
      
      // Ensure we don't lose all messages
      if (!compressed || compressed.length === 0) {
        console.warn('Compression resulted in empty messages, returning original');
        return messages;
      }
      
      return compressed;
    } catch (error) {
      console.error('Compression failed:', error);
      return messages; // Fallback to original messages
    }
  }
  
  /**
   * Estimate token savings for a compression strategy
   * @param {Array} messages - Conversation messages
   * @param {string} strategyName - Strategy to use
   * @returns {Promise<number>} Estimated tokens saved
   */
  async estimateSavings(messages, strategyName = 'auto') {
    if (!messages || messages.length === 0) return 0;
    
    const strategy = await this.selectStrategy(strategyName, messages);
    if (!strategy) return 0;
    
    try {
      const context = this.createCompressionContext(messages);
      const base = await strategy.estimateSavings(context);
      const factor = Number(this.config.savingsCalibration || 1);
      return Math.max(0, Math.floor(base * (factor > 0 ? factor : 1)));
    } catch (error) {
      console.error('Failed to estimate savings:', error);
      return 0;
    }
  }
  
  /**
   * Select the appropriate compression strategy
   * @param {string} strategyName - Requested strategy name
   * @param {Array} messages - Conversation messages
   * @returns {Promise<Object|null>} Selected strategy
   */
  async selectStrategy(strategyName, messages) {
    if (strategyName === 'auto') {
      return this.selectAutoStrategy(messages);
    }
    
    return this.strategies.get(strategyName) || null;
  }
  
  /**
   * Automatically select the best compression strategy
   * @param {Array} messages - Conversation messages
   * @returns {Promise<Object>} Selected strategy
   */
  async selectAutoStrategy(messages) {
    // Analyze conversation characteristics
    const analysis = this.analyzeConversation(messages);
    
    // Select strategy based on analysis
    if (analysis.hasManyToolCalls && analysis.hasLongToolOutputs) {
      // OpenCode is good for tool-heavy conversations
      return this.strategies.get('opencode') || this.strategies.values().next().value;
    } else if (analysis.isSimpleConversation) {
      // Claude Code for simple conversations
      return this.strategies.get('claude-code') || this.strategies.values().next().value;
    } else if (analysis.hasWebContent || analysis.hasLargeDocuments) {
      // Manus for web content and documents
      return this.strategies.get('manus') || this.strategies.values().next().value;
    } else if (analysis.isLongRunning && analysis.hasManyIterations) {
      // Focus Agent for long-running tasks
      return this.strategies.get('focus-agent') || this.strategies.values().next().value;
    }
    
    // Default to OpenCode
    return this.strategies.get('opencode') || this.strategies.values().next().value;
  }
  
  /**
   * Analyze conversation characteristics
   * @param {Array} messages - Conversation messages
   * @returns {Object} Analysis results
   */
  analyzeConversation(messages) {
    let toolCallCount = 0;
    let hasLongToolOutputs = false;
    let hasWebContent = false;
    let hasLargeDocuments = false;
    let totalLength = 0;
    
    for (const msg of messages) {
      try {
        totalLength += JSON.stringify(msg).length;
      } catch {}

      if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        toolCallCount += msg.tool_calls.length;
      }

      if (msg?.role === 'tool') {
        toolCallCount += 1;
        const toolText = typeof msg?.content === 'string' ? msg.content : (() => {
          try { return JSON.stringify(msg?.content ?? ''); } catch { return String(msg?.content ?? ''); }
        })();
        if (toolText.length > 1000) hasLongToolOutputs = true;
      }

      const text = typeof msg?.content === 'string'
        ? msg.content
        : (() => {
          try { return JSON.stringify(msg?.content ?? ''); } catch { return String(msg?.content ?? ''); }
        })();

      if (text.includes('http')) {
        hasWebContent = true;
      }

      if (msg?.type === 'document' || text.length > 5000) {
        hasLargeDocuments = true;
      }
    }
    
    return {
      hasManyToolCalls: toolCallCount > 10,
      hasLongToolOutputs,
      hasWebContent,
      hasLargeDocuments,
      isSimpleConversation: messages.length < 20 && toolCallCount < 5,
      isLongRunning: messages.length > 100,
      hasManyIterations: toolCallCount > 30,
      totalLength
    };
  }
  
  /**
   * Create compression context from messages
   * @param {Array} messages - Conversation messages
   * @returns {Object} Compression context
   */
  createCompressionContext(messages) {
    // Estimate tokens (simplified)
    const cpt = Number(this.config.charsPerToken || 4);
    const estimatedTokens = Math.floor(JSON.stringify(messages).length / (cpt > 0 ? cpt : 4));
    
    return {
      messages,
      tokens: estimatedTokens,
      model: {
        limit: {
          context: this.config.maxTokens,
          output: this.config.outputTokens
        }
      },
      config: this.config
    };
  }
  
  /**
   * Update engine configuration
   * @param {Object} newConfig - New configuration
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }
  
  /**
   * Get current configuration
   * @returns {Object} Current configuration
   */
  getConfig() {
    return { ...this.config };
  }
}
