/**
 * Claude Code Compression Strategy
 * 
 * Implements Claude Code's simple summarization approach:
 * - Manual: /compact command
 * - Auto: Triggers at ~95% context capacity
 * - Simple LLM-based summarization
 */

export class ClaudeCodeStrategy {
  constructor(options = {}) {
    this.name = 'claude-code';
    this.options = {
      threshold: options.threshold || 0.95, // 95% capacity
      keepRecentMessages: options.keepRecentMessages || 10,
      summaryPrompt: options.summaryPrompt || this.getDefaultSummaryPrompt(),
      summaryPrefix: options.summaryPrefix || this.getDefaultSummaryPrefix(),
      ...options
    };
  }
  
  /**
   * Check if compression is needed
   * @param {Object} context - Compression context
   * @returns {Promise<boolean>} Whether to compress
   */
  async shouldCompress(context) {
    const { tokens, model } = context;
    const contextLimit = model.limit.context;
    
    if (contextLimit === 0) return false;
    
    // Claude Code triggers at ~95% capacity
    return tokens > contextLimit * this.options.threshold;
  }
  
  /**
   * Compress messages using Claude Code strategy
   * @param {Object} context - Compression context
   * @returns {Promise<Array>} Compressed messages
   */
  async compress(context) {
    const { messages } = context;
    
    // Generate summary
    const summary = await this.generateSummary(messages);
    
    // Build new context structure
    const result = [];
    
    // Add summary prefix
    result.push({
      role: 'system',
      content: this.options.summaryPrefix + summary
    });
    
    // Keep recent user messages (Claude Code preserves recent messages)
    const recentMessages = this.getRecentUserMessages(messages, this.options.keepRecentMessages);
    result.push(...recentMessages);
    
    console.log(`Claude Code compression: ${messages.length} → ${result.length} messages`);
    return result;
  }
  
  /**
   * Generate summary of conversation
   * @param {Array} messages - Conversation messages
   * @returns {Promise<string>} Generated summary
   */
  async generateSummary(messages) {
    // In a real implementation, this would call an LLM with the summary prompt
    // For now, simulate the process
    
    const prompt = this.options.summaryPrompt;
    
    // Extract structured information
    const extracted = this.extractConversationDetails(messages);
    
    return `Conversation Summary:

What was accomplished:
${extracted.accomplished.map(item => `• ${item}`).join('\n')}

Current work in progress:
${extracted.inProgress.map(item => `• ${item}`).join('\n')}

Files involved:
${extracted.files.map(file => `• ${file}`).join('\n')}

Next steps:
${extracted.nextSteps.map(step => `• ${step}`).join('\n')}

Key user requests or constraints:
${extracted.constraints.map(constraint => `• ${constraint}`).join('\n')}`;
  }
  
  /**
   * Extract conversation details for summarization
   * @param {Array} messages - Conversation messages
   * @returns {Object} Extracted details
   */
  extractConversationDetails(messages) {
    const details = {
      accomplished: [],
      inProgress: [],
      files: new Set(),
      nextSteps: [],
      constraints: []
    };
    
    let currentTask = '';
    let lastUserRequest = '';
    
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const content = msg.content || '';
      
      if (msg.role === 'user') {
        lastUserRequest = content;
        
        // Extract constraints
        if (content.includes('don\'t') || content.includes('avoid') || 
            content.includes('must') || content.includes('should')) {
          details.constraints.push(content.substring(0, 150) + '...');
        }
        
        // Extract next steps from user requests
        if (content.includes('next') || content.includes('then') || 
            content.includes('after') || content.includes('please')) {
          details.nextSteps.push(content.substring(0, 150) + '...');
        }
      }
      
      if (msg.role === 'assistant') {
        // Check if this is a completion of a task
        if (content.includes('done') || content.includes('completed') || 
            content.includes('finished') || content.includes('successfully')) {
          details.accomplished.push(`Completed: ${lastUserRequest.substring(0, 100)}...`);
        }
        
        // Check for work in progress
        if (content.includes('working on') || content.includes('currently') || 
            content.includes('now') || content.includes('next I will')) {
          details.inProgress.push(content.substring(0, 150) + '...');
        }
      }
      
      // Extract file references (simple pattern matching)
      const fileMatches = content.match(/\b[\w\-]+\.[\w]{1,10}\b/g) || [];
      fileMatches.forEach(file => {
        if (file.length > 3 && file.length < 50 && !file.includes('http')) {
          details.files.add(file);
        }
      });
      
      // Extract tool calls and their results
      if (msg.toolCall) {
        const toolName = msg.toolName || 'unknown';
        const toolOutput = msg.toolOutput || '';
        
        if (toolOutput.includes('success') || toolOutput.includes('created') || 
            toolOutput.includes('updated') || toolOutput.includes('modified')) {
          details.accomplished.push(`Tool ${toolName}: ${toolOutput.substring(0, 100)}...`);
        }
      }
    }
    
    // Convert Set to Array
    details.files = Array.from(details.files);
    
    // Limit arrays to reasonable sizes
    details.accomplished = details.accomplished.slice(0, 10);
    details.inProgress = details.inProgress.slice(0, 5);
    details.files = details.files.slice(0, 20);
    details.nextSteps = details.nextSteps.slice(0, 5);
    details.constraints = details.constraints.slice(0, 5);
    
    return details;
  }
  
  /**
   * Get recent user messages
   * @param {Array} messages - All messages
   * @param {number} count - Number of recent messages to keep
   * @returns {Array} Recent user messages
   */
  getRecentUserMessages(messages, count = 10) {
    const userMessages = messages.filter(msg => msg.role === 'user');
    return userMessages.slice(-count);
  }
  
  /**
   * Estimate token savings
   * @param {Object} context - Compression context
   * @returns {Promise<number>} Estimated tokens saved
   */
  async estimateSavings(context) {
    const { messages } = context;
    
    if (messages.length <= this.options.keepRecentMessages) {
      return 0; // Not enough messages to compress
    }
    
    // Estimate tokens in messages that would be summarized
    const messagesToSummarize = messages.slice(0, -this.options.keepRecentMessages);
    const originalTokens = await this.estimateTokens(messagesToSummarize);
    
    // Estimate tokens in summary (roughly 10% of original)
    const summaryTokens = Math.ceil(originalTokens * 0.1);
    
    return originalTokens - summaryTokens;
  }
  
  /**
   * Estimate tokens in messages
   * @param {Array} messages - Messages to estimate
   * @returns {Promise<number>} Estimated token count
   */
  async estimateTokens(messages) {
    if (!messages || messages.length === 0) return 0;
    
    let total = 0;
    for (const msg of messages) {
      const text = JSON.stringify(msg);
      // Rough estimate: 1 token ≈ 4 characters
      total += Math.ceil(text.length / 4);
    }
    
    return total;
  }
  
  /**
   * Get default summary prompt (from Claude Code community)
   * @returns {string} Default prompt
   */
  getDefaultSummaryPrompt() {
    return `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions. This summary will be used as context when continuing the conversation, so preserve critical information including:
- What was accomplished
- Current work in progress  
- Files involved
- Next steps
- Key user requests or constraints`;
  }
  
  /**
   * Get default summary prefix
   * @returns {string} Default prefix
   */
  getDefaultSummaryPrefix() {
    return `Previous conversation summary:\n\n`;
  }
  
  /**
   * Get compression statistics
   * @param {Array} originalMessages - Original messages
   * @param {Array} compressedMessages - Compressed messages
   * @returns {Object} Compression statistics
   */
  getCompressionStats(originalMessages, compressedMessages) {
    const originalCount = originalMessages.length;
    const compressedCount = compressedMessages.length;
    const reduction = originalCount - compressedCount;
    const reductionPercent = originalCount > 0 ? (reduction / originalCount * 100).toFixed(1) : 0;
    
    return {
      originalCount,
      compressedCount,
      reduction,
      reductionPercent: `${reductionPercent}%`,
      strategy: this.name
    };
  }
}