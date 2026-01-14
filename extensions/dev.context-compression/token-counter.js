/**
 * Token Counter
 * 
 * Provides accurate token counting for different models
 */

export class TokenCounter {
  constructor(options = {}) {
    this.options = {
      // Default to Claude Sonnet pricing
      inputCostPerMillion: options.inputCostPerMillion || 3.0,
      cachedInputCostPerMillion: options.cachedInputCostPerMillion || 0.30,
      outputCostPerMillion: options.outputCostPerMillion || 15.0,
      
      // Token estimation settings
      charsPerToken: options.charsPerToken || 4, // Rough estimate for English
      multiLanguage: options.multiLanguage !== false,
      
      ...options
    };
    
    // Model-specific tokenizers (simplified)
    this.modelTokenizers = {
      'claude-3.5-sonnet': {
        charsPerToken: 3.5,
        specialTokenRatio: 0.1
      },
      'claude-3.7-sonnet': {
        charsPerToken: 3.7,
        specialTokenRatio: 0.12
      },
      'gpt-4': {
        charsPerToken: 4.0,
        specialTokenRatio: 0.08
      },
      'default': {
        charsPerToken: 4.0,
        specialTokenRatio: 0.1
      }
    };
  }
  
  /**
   * Count tokens in text
   * @param {string} text - Text to count
   * @param {string} model - Model name
   * @returns {Promise<number>} Token count
   */
  async countTokens(text, model = 'default') {
    if (!text || text.length === 0) return 0;
    
    const tokenizer = this.modelTokenizers[model] || 
                        this.modelTokenizers['default'];
    
    // Calculate base tokens
    let tokens = Math.ceil(text.length / tokenizer.charsPerToken);
    
    // Add special tokens (estimated)
    const specialTokens = Math.ceil(tokens * tokenizer.specialTokenRatio);
    tokens += specialTokens;
    
    return tokens;
  }
  
  /**
   * Count tokens in message
   * @param {Object} message - Message object
   * @param {string} model - Model name
   * @returns {Promise<Object>} Token breakdown
   */
  async countMessageTokens(message, model = 'default') {
    const result = {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0
      },
      total: 0,
      reasoning: 0
    };
    
    // Count content
    if (message.content) {
      const contentTokens = await this.countTokens(message.content, model);
      
      if (message.role === 'user') {
        result.input += contentTokens;
      } else if (message.role === 'assistant') {
        result.output += contentTokens;
      } else if (message.role === 'system') {
        result.input += contentTokens;
      }
    }
    
    // Count tool calls
    if (message.toolCall) {
      const toolCallTokens = await this.countTokens(
        JSON.stringify(message.toolCall), 
        model
      );
      result.input += toolCallTokens;
    }
    
    // Count tool outputs
    if (message.toolOutput) {
      const outputTokens = await this.countTokens(
        message.toolOutput, 
        model
      );
      
      if (message._cached) {
        result.cache.read += outputTokens;
      } else {
        result.cache.write += outputTokens;
      }
    }
    
    // Count reasoning tokens (if present)
    if (message.reasoning) {
      const reasoningTokens = await this.countTokens(message.reasoning, model);
      result.reasoning = reasoningTokens;
      // Reasoning tokens are charged as output
      result.output += reasoningTokens;
    }
    
    // Calculate total
    result.total = result.input + result.cache.read + result.output;
    
    return result;
  }
  
  /**
   * Count tokens in conversation
   * @param {Array} messages - Conversation messages
   * @param {string} model - Model name
   * @returns {Promise<Object>} Token breakdown
   */
  async countConversationTokens(messages, model = 'default') {
    const result = {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0
      },
      total: 0,
      reasoning: 0,
      messageCount: messages.length,
      userMessageCount: 0,
      assistantMessageCount: 0,
      toolCallCount: 0,
      avgTokensPerMessage: 0
    };
    
    // Count each message
    for (const message of messages) {
      const msgTokens = await this.countMessageTokens(message, model);
      
      result.input += msgTokens.input;
      result.output += msgTokens.output;
      result.cache.read += msgTokens.cache.read;
      result.cache.write += msgTokens.cache.write;
      result.reasoning += msgTokens.reasoning;
      
      // Count message types
      if (message.role === 'user') {
        result.userMessageCount++;
      } else if (message.role === 'assistant') {
        result.assistantMessageCount++;
      }
      
      if (message.toolCall) {
        result.toolCallCount++;
      }
    }
    
    // Calculate total
    result.total = result.input + result.cache.read + result.output;
    
    // Calculate average
    if (result.messageCount > 0) {
      result.avgTokensPerMessage = Math.round(
        result.total / result.messageCount
      );
    }
    
    return result;
  }
  
  /**
   * Calculate costs
   * @param {Object} tokens - Token breakdown
   * @returns {Promise<Object>} Cost breakdown
   */
  async calculateCosts(tokens) {
    const result = {
      input: 0,
      cachedInput: 0,
      output: 0,
      total: 0,
      currency: 'USD'
    };
    
    // Calculate input cost
    result.input = (tokens.input / 1000000) * 
                  this.options.inputCostPerMillion;
    
    // Calculate cached input cost
    result.cachedInput = (tokens.cache.read / 1000000) * 
                         this.options.cachedInputCostPerMillion;
    
    // Calculate output cost
    result.output = (tokens.output / 1000000) * 
                  this.options.outputCostPerMillion;
    
    // Calculate total
    result.total = result.input + result.cachedInput + result.output;
    
    // Format to 2 decimal places
    Object.keys(result).forEach(key => {
      if (typeof result[key] === 'number' && key !== 'currency') {
        result[key] = Math.round(result[key] * 100) / 100;
      }
    });
    
    return result;
  }
  
  /**
   * Estimate compression savings
   * @param {Object} originalTokens - Original token breakdown
   * @param {Object} compressedTokens - Compressed token breakdown
   * @returns {Object} Savings breakdown
   */
  estimateSavings(originalTokens, compressedTokens) {
    const savings = {
      input: originalTokens.input - compressedTokens.input,
      output: originalTokens.output - compressedTokens.output,
      cache: {
        read: originalTokens.cache.read - compressedTokens.cache.read,
        write: originalTokens.cache.write - compressedTokens.cache.write
      },
      total: originalTokens.total - compressedTokens.total,
      percent: 0,
      percentCached: 0
    };
    
    // Calculate percentage
    if (originalTokens.total > 0) {
      savings.percent = Math.round(
        (savings.total / originalTokens.total) * 100
      );
    }
    
    // Calculate cached savings percentage
    if (savings.cache.write > 0) {
      savings.percentCached = Math.round(
        (savings.cache.write / originalTokens.total) * 100
      );
    }
    
    return savings;
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
   * Format costs for display
   * @param {Object} costs - Cost breakdown
   * @returns {string} Formatted string
   */
  formatCosts(costs) {
    return `
Total Cost: $${costs.total.toFixed(2)}
  - Input: $${costs.input.toFixed(2)}
  - Cached: $${costs.cachedInput.toFixed(2)}
  - Output: $${costs.output.toFixed(2)}
    `.trim();
  }
  
  /**
   * Get token usage statistics
   * @param {Array} messages - Conversation messages
   * @param {string} model - Model name
   * @returns {Promise<Object>} Usage statistics
   */
  async getUsageStatistics(messages, model = 'default') {
    const tokens = await this.countConversationTokens(messages, model);
    const costs = await this.calculateCosts(tokens);
    
    return {
      tokens,
      costs,
      model,
      timestamp: Date.now(),
      efficiency: this.calculateEfficiency(tokens)
    };
  }
  
  /**
   * Calculate efficiency metrics
   * @param {Object} tokens - Token breakdown
   * @returns {Object} Efficiency metrics
   */
  calculateEfficiency(tokens) {
    const efficiency = {
      cacheHitRate: 0,
      inputOutputRatio: 0,
      reasoningRatio: 0
    };
    
    // Cache hit rate
    if (tokens.input + tokens.cache.read > 0) {
      efficiency.cacheHitRate = (
        tokens.cache.read / (tokens.input + tokens.cache.read)
      ) * 100;
    }
    
    // Input/output ratio
    if (tokens.output > 0) {
      efficiency.inputOutputRatio = tokens.input / tokens.output;
    }
    
    // Reasoning ratio
    if (tokens.output > 0) {
      efficiency.reasoningRatio = (tokens.reasoning / tokens.output) * 100;
    }
    
    return efficiency;
  }
  
  /**
   * Get tokenizer info for model
   * @param {string} model - Model name
   * @returns {Object} Tokenizer info
   */
  getTokenizerInfo(model = 'default') {
    const tokenizer = this.modelTokenizers[model] || 
                       this.modelTokenizers['default'];
    
    return {
      model,
      charsPerToken: tokenizer.charsPerToken,
      specialTokenRatio: tokenizer.specialTokenRatio,
      accuracy: 'estimated' // Using heuristic, not actual tokenizer
    };
  }
  
  /**
   * Set model-specific tokenizers
   * @param {Object} tokenizers - Custom tokenizers
   */
  setModelTokenizers(tokenizers) {
    this.modelTokenizers = { ...this.modelTokenizers, ...tokenizers };
  }
  
  /**
   * Update options
   * @param {Object} newOptions - New options
   */
  updateOptions(newOptions) {
    this.options = { ...this.options, ...newOptions };
  }
  
  /**
   * Get current options
   * @returns {Object} Current options
   */
  getOptions() {
    return { ...this.options };
  }
}
