/**
 * Focus Agent Compression Strategy
 * 
 * Implements Focus Agent's active compression approach:
 * - start_focus: Declare investigation
 * - explore: Use standard tools
 * - consolidate: Generate summary
 * - withdraw: Delete logs, keep knowledge
 * - Sawtooth pattern: Periodic context collapse
 */

export class FocusAgentStrategy {
  constructor(options = {}) {
    this.name = 'focus-agent';
    this.options = { ...options };

    if (this.options.compressionInterval == null) this.options.compressionInterval = 15;
    if (this.options.minToolCalls == null) this.options.minToolCalls = 5;
    if (this.options.maxKnowledgeBlocks == null) this.options.maxKnowledgeBlocks = 10;

    if (this.options.enableStartFocus == null) this.options.enableStartFocus = true;
    if (this.options.enableCompleteFocus == null) this.options.enableCompleteFocus = true;
    if (this.options.phasesPerTask == null) this.options.phasesPerTask = 4;

    if (this.options.consolidationPrompt == null) this.options.consolidationPrompt = this.getDefaultConsolidationPrompt();
    if (this.options.systemReminder == null) this.options.systemReminder = this.getDefaultSystemReminder();
    
    // Focus state tracking
    this.activeFocusBlocks = [];
    this.knowledgeBlocks = [];
    this.toolCallCounter = 0;
    this.currentPhase = 'explore';
  }
  
  /**
   * Check if compression is needed (Focus Agent's active approach)
   * @param {Object} context - Compression context
   * @returns {Promise<boolean>} Whether to compress
   */
  async shouldCompress(context) {
    const { messages } = context;
    
    // Count tool calls in conversation
    const toolCallCount = this.countToolCalls(messages);
    
    // Only compress if minimum threshold reached
    if (toolCallCount < this.options.minToolCalls) {
      return false;
    }
    
    // Check if compression interval reached
    if (toolCallCount % this.options.compressionInterval === 0) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Compress messages using Focus Agent strategy
   * @param {Object} context - Compression context
   * @returns {Promise<Array>} Compressed messages
   */
  async compress(context) {
    const { messages } = context;
    
    // Extract focus blocks
    const focusBlocks = this.extractFocusBlocks(messages);
    
    // Check if we're in the middle of a focus (exploration)
    if (focusBlocks.some(block => block.phase === 'explore' && !block.completed)) {
      // Don't interrupt active exploration
      return messages;
    }
    
    // Complete all open focus blocks
    const completedBlocks = await this.completeOpenFocusBlocks(focusBlocks);
    
    // Generate knowledge blocks from completed focus blocks
    const newKnowledgeBlocks = await this.generateKnowledgeBlocks(completedBlocks);
    this.knowledgeBlocks.push(...newKnowledgeBlocks);
    
    // Prune knowledge blocks if too many
    if (this.knowledgeBlocks.length > this.options.maxKnowledgeBlocks) {
      this.knowledgeBlocks = this.knowledgeBlocks.slice(-this.options.maxKnowledgeBlocks);
    }
    
    // Build new conversation with knowledge blocks
    const result = this.buildKnowledgeBasedConversation(newKnowledgeBlocks);
    
    // Add recent messages (keep recent context)
    const recentMessages = this.getRecentMessages(messages, 5);
    result.push(...recentMessages);
    
    console.log(`Focus Agent compression: ${messages.length} → ${result.length} messages, ${newKnowledgeBlocks.length} knowledge blocks`);
    return result;
  }
  
  /**
   * Extract focus blocks from messages
   * @param {Array} messages - Conversation messages
   * @returns {Array} Focus blocks
   */
  extractFocusBlocks(messages) {
    const blocks = [];
    let currentBlock = null;
    
    for (const msg of messages) {
      // Check for start_focus marker
      if (this.isStartFocus(msg)) {
        if (currentBlock) {
          currentBlock.completed = false;
          blocks.push(currentBlock);
        }
        
        currentBlock = {
          phase: 'explore',
          topic: this.extractTopic(msg),
          messages: [msg],
          startTime: msg.timestamp || Date.now(),
          toolCalls: this.countToolCalls([msg]),
          completed: false
        };
      } 
      // Check for complete_focus marker
      else if (this.isCompleteFocus(msg)) {
        if (currentBlock) {
          currentBlock.phase = 'consolidate';
          currentBlock.completed = true;
          currentBlock.endTime = msg.timestamp || Date.now();
          currentBlock.messages.push(msg);
          blocks.push(currentBlock);
          currentBlock = null;
        }
      }
      // Add message to current block
      else if (currentBlock) {
        currentBlock.messages.push(msg);
        currentBlock.toolCalls += this.countToolCalls([msg]);
      }
    }
    
    // Close any remaining block
    if (currentBlock) {
      currentBlock.completed = false;
      blocks.push(currentBlock);
    }
    
    return blocks;
  }
  
  /**
   * Check if message is start_focus
   * @param {Object} msg - Message to check
   * @returns {boolean} Whether it's start_focus
   */
  isStartFocus(msg) {
    return (msg.toolCall && msg.toolName === 'start_focus') ||
           (msg.content && msg.content.toLowerCase().includes('start_focus')) ||
           (msg._focusStart === true);
  }
  
  /**
   * Check if message is complete_focus
   * @param {Object} msg - Message to check
   * @returns {boolean} Whether it's complete_focus
   */
  isCompleteFocus(msg) {
    return (msg.toolCall && msg.toolName === 'complete_focus') ||
           (msg.content && msg.content.toLowerCase().includes('complete_focus')) ||
           (msg._focusComplete === true);
  }
  
  /**
   * Extract topic from start_focus message
   * @param {Object} msg - start_focus message
   * @returns {string} Extracted topic
   */
  extractTopic(msg) {
    if (msg.content) {
      const topicMatch = msg.content.match(/start_focus\s+(.+)/i);
      if (topicMatch) {
        return topicMatch[1].trim();
      }
    }
    
    if (msg.toolArgs && msg.toolArgs.topic) {
      return msg.toolArgs.topic;
    }
    
    return 'Unknown topic';
  }
  
  /**
   * Complete open focus blocks
   * @param {Array} focusBlocks - Focus blocks to complete
   * @returns {Promise<Array>} Completed blocks
   */
  async completeOpenFocusBlocks(focusBlocks) {
    const completed = [];
    
    for (const block of focusBlocks) {
      if (!block.completed) {
        // Generate summary for incomplete block
        const summary = await this.generateBlockSummary(block);
        
        completed.push({
          ...block,
          completed: true,
          summary,
          endTime: Date.now()
        });
      } else {
        completed.push(block);
      }
    }
    
    return completed;
  }
  
  /**
   * Generate knowledge blocks from completed focus blocks
   * @param {Array} completedBlocks - Completed focus blocks
   * @returns {Promise<Array>} Knowledge blocks
   */
  async generateKnowledgeBlocks(completedBlocks) {
    const knowledgeBlocks = [];
    
    for (const block of completedBlocks) {
      const knowledge = {
        id: this.generateId(),
        phase: block.phase,
        topic: block.topic,
        summary: block.summary || '',
        whatAttempted: '',
        whatLearned: [],
        whatOutcome: '',
        filesInvolved: [],
        nextSteps: []
      };
      
      // Extract information from block
      for (const msg of block.messages) {
        // Extract what was attempted
        if (msg.role === 'assistant' && msg.toolCall) {
          knowledge.whatAttempted += `${msg.toolName}: ${msg.toolOutput?.substring(0, 100) || ''}\n`;
        }
        
        // Extract what was learned
        if (msg.content && msg.content.includes('found') || 
            msg.content.includes('discovered') || msg.content.includes('learned')) {
          knowledge.whatLearned.push(msg.content.substring(0, 150));
        }
        
        // Extract file references
        if (msg.content) {
          const files = msg.content.match(/\b[\w\-]+\.[\w]{1,10}\b/g) || [];
          knowledge.filesInvolved.push(...files);
        }
      }
      
      // Deduplicate files
      knowledge.filesInvolved = [...new Set(knowledge.filesInvolved)];
      
      knowledgeBlocks.push(knowledge);
    }
    
    return knowledgeBlocks;
  }
  
  /**
   * Generate summary for a focus block
   * @param {Object} block - Focus block
   * @returns {Promise<string>} Generated summary
   */
  async generateBlockSummary(block) {
    // In a real implementation, this would call an LLM
    // For now, simulate the process
    
    const prompt = this.options.consolidationPrompt;
    
    // Extract key information
    const keyInfo = this.extractBlockInfo(block);
    
    return `Focus Phase: ${block.phase}
Topic: ${block.topic}

What was attempted:
${keyInfo.attempted}

What was learned:
${keyInfo.learned.map(item => `• ${item}`).join('\n')}

Outcome:
${keyInfo.outcome}

Files involved:
${keyInfo.files.map(f => `• ${f}`).join('\n')}

Next steps:
${keyInfo.nextSteps.map(step => `• ${step}`).join('\n')}`;
  }
  
  /**
   * Extract block information
   * @param {Object} block - Focus block
   * @returns {Object} Extracted information
   */
  extractBlockInfo(block) {
    const info = {
      attempted: '',
      learned: [],
      outcome: 'In progress',
      files: new Set(),
      nextSteps: []
    };
    
    for (const msg of block.messages) {
      if (msg.role === 'assistant' && msg.toolCall) {
        info.attempted += `• ${msg.toolName}\n`;
      }
      
      if (msg.content) {
        if (msg.content.includes('success') || msg.content.includes('completed')) {
          info.outcome = 'Success';
        } else if (msg.content.includes('failed') || msg.content.includes('error')) {
          info.outcome = 'Failed';
        }
        
        // Extract learnings
        if (msg.content.includes('found') || msg.content.includes('discovered')) {
          info.learned.push(msg.content.substring(0, 100));
        }
        
        // Extract file references
        const files = msg.content.match(/\b[\w\-]+\.[\w]{1,10}\b/g) || [];
        files.forEach(f => info.files.add(f));
      }
    }
    
    info.files = Array.from(info.files);
    return info;
  }
  
  /**
   * Build knowledge-based conversation
   * @param {Array} knowledgeBlocks - Knowledge blocks
   * @returns {Array} Knowledge-based messages
   */
  buildKnowledgeBasedConversation(knowledgeBlocks) {
    const messages = [];
    
    // Add system message with all knowledge blocks
    let knowledgeContent = '## Conversation Knowledge\n\n';
    
    for (const block of knowledgeBlocks) {
      knowledgeContent += `### ${block.phase}: ${block.topic}\n\n`;
      knowledgeContent += `${block.summary}\n\n`;
      
      if (block.whatLearned && block.whatLearned.length > 0) {
        knowledgeContent += '**Learnings:**\n';
        knowledgeContent += block.whatLearned.map(l => `- ${l}`).join('\n');
        knowledgeContent += '\n';
      }
      
      if (block.filesInvolved && block.filesInvolved.length > 0) {
        knowledgeContent += '**Files:**\n';
        knowledgeContent += block.filesInvolved.map(f => `- ${f}`).join('\n');
        knowledgeContent += '\n';
      }
    }
    
    messages.push({
      role: 'system',
      content: knowledgeContent,
      _knowledgeBlock: true
    });
    
    return messages;
  }
  
  /**
   * Get recent messages
   * @param {Array} messages - All messages
   * @param {number} count - Number of recent messages to keep
   * @returns {Array} Recent messages
   */
  getRecentMessages(messages, count = 5) {
    return messages.slice(-count);
  }
  
  /**
   * Count tool calls in messages
   * @param {Array} messages - Messages to analyze
   * @returns {number} Tool call count
   */
  countToolCalls(messages) {
    let count = 0;
    for (const msg of messages) {
      if (msg?.toolCall || (msg?.parts && msg.parts.some(p => p.type === 'tool'))) count++;
      else if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) count += msg.tool_calls.length;
      else if (msg?.role === 'tool') count++;
    }
    return count;
  }
  
  /**
   * Estimate token savings
   * @param {Object} context - Compression context
   * @returns {Promise<number>} Estimated tokens saved
   */
  async estimateSavings(context) {
    const { messages } = context;
    
    const focusBlocks = this.extractFocusBlocks(messages);
    if (focusBlocks.length === 0) return 0;
    
    // Estimate tokens in messages to be withdrawn
    let tokensToWithdraw = 0;
    
    for (const block of focusBlocks) {
      for (const msg of block.messages) {
        tokensToWithdraw += await this.estimateTokens(msg);
      }
    }
    
    // Estimate tokens in knowledge blocks (much smaller)
    const knowledgeTokens = await this.estimateTokens(this.knowledgeBlocks);
    
    return Math.max(0, tokensToWithdraw - knowledgeTokens);
  }
  
  /**
   * Estimate tokens in object
   * @param {Object|Array} obj - Object to estimate
   * @returns {Promise<number>} Estimated token count
   */
  async estimateTokens(obj) {
    if (!obj) return 0;
    
    const text = JSON.stringify(obj);
    if (text.length === 0) return 0;
    
    // Rough estimate: 1 token ≈ 4 characters for English
    return Math.ceil(text.length / 4);
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
    const focusBlocks = this.extractFocusBlocks(originalMessages);
    const reduction = originalCount - compressedCount;
    const reductionPercent = originalCount > 0 ? (reduction / originalCount * 100).toFixed(1) : 0;
    
    return {
      originalCount,
      compressedCount,
      reduction,
      reductionPercent: `${reductionPercent}%`,
      strategy: this.name,
      focusBlocksCount: focusBlocks.length,
      knowledgeBlocksCount: this.knowledgeBlocks.length,
      sawtoothPattern: true
    };
  }
  
  /**
   * Get system reminder (periodic reminder to compress)
   * @returns {string} System reminder
   */
  getDefaultSystemReminder() {
    const interval = this.options?.compressionInterval ?? 15;
    return `REMINDER: You should call complete_focus to compress your context every ${interval} tool calls.

Recommended workflow: explore → consolidate → explore → consolidate
Use 4-6 focus phases per task: explore → understand → implement → verify`;
  }
  
  /**
   * Get default consolidation prompt
   * @returns {string} Default prompt
   */
  getDefaultConsolidationPrompt() {
    return `Generate a concise summary of what you attempted, what you learned, and the outcome.

Focus on:
1. What was attempted (specific tool calls and actions)
2. What was learned (facts, file paths, bugs found)
3. What is the outcome (success, failure, next steps)

This summary will be added to a persistent knowledge block, and the raw logs of this phase will be withdrawn from context.`;
  }
  
  /**
   * Generate unique ID
   * @returns {string} Unique ID
   */
  generateId() {
    return Date.now().toString(36) + 
           Math.random().toString(36).substr(2, 9);
  }
  
  /**
   * Reset focus state
   */
  resetFocusState() {
    this.activeFocusBlocks = [];
    this.knowledgeBlocks = [];
    this.toolCallCounter = 0;
    this.currentPhase = 'explore';
  }
  
  /**
   * Get focus statistics
   * @returns {Object} Focus statistics
   */
  getFocusStats() {
    return {
      activeBlocks: this.activeFocusBlocks.length,
      knowledgeBlocks: this.knowledgeBlocks.length,
      toolCalls: this.toolCallCounter,
      currentPhase: this.currentPhase,
      compressionInterval: this.options.compressionInterval
    };
  }
}
