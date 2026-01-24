/**
 * OpenCode Compression Strategy
 * 
 * Implements OpenCode's two-phase compression:
 * 1. Pruning: Remove old tool outputs while protecting recent context
 * 2. Compaction: Generate summary when context limit is reached
 */

export class OpenCodeStrategy {
  constructor(options = {}) {
    this.name = 'opencode';
    this.options = {
      // Pruning thresholds (from OpenCode source)
      PRUNE_PROTECT: options.pruneProtect || 40000, // Retain 40K recent tokens
      PRUNE_MINIMUM: options.pruneMinimum || 20000, // Minimum tokens to save
      PROTECTED_TOOLS: options.protectedTools || ['skill'], // Never prune these
      
      // Compression thresholds
      threshold: options.threshold || 0.95, // 95% of context window
      outputTokenMax: 32000, // Maximum output tokens
      
      // Prompt templates
      compactionPrompt: options.compactionPrompt || this.getDefaultCompactionPrompt(),
      
      ...options
    };
  }

  updateOptions(options = {}) {
    if (!options || typeof options !== 'object') return;
    if (options.pruneProtect != null) this.options.PRUNE_PROTECT = Number(options.pruneProtect) || this.options.PRUNE_PROTECT;
    if (options.pruneMinimum != null) this.options.PRUNE_MINIMUM = Number(options.pruneMinimum) || this.options.PRUNE_MINIMUM;
    if (options.protectedTools != null) this.options.PROTECTED_TOOLS = Array.isArray(options.protectedTools) ? options.protectedTools : this.options.PROTECTED_TOOLS;
    if (options.threshold != null) this.options.threshold = Number(options.threshold) || this.options.threshold;
    if (options.outputTokenMax != null) this.options.outputTokenMax = Number(options.outputTokenMax) || this.options.outputTokenMax;
  }
  
  /**
   * Check if compression is needed (OpenCode's isOverflow logic)
   * @param {Object} context - Compression context
   * @returns {Promise<boolean>} Whether to compress
   */
  async shouldCompress(context) {
    const { tokens, model, config } = context;
    
    if (config?.compaction?.auto === false) return false;
    
    const contextLimit = model.limit.context;
    if (contextLimit === 0) return false;
    
    // OpenCode's overflow detection logic
    const count = typeof tokens === 'number'
      ? tokens
      : (Number(tokens?.input || 0) + Number(tokens?.cache?.read || 0) + Number(tokens?.output || 0));
    const output = Math.min(model.limit.output, this.options.outputTokenMax);
    const usable = contextLimit - output;
    
    return count > usable;
  }
  
  /**
   * Compress messages using OpenCode strategy
   * @param {Object} context - Compression context
   * @returns {Promise<Array>} Compressed messages
   */
  async compress(context) {
    const { messages } = context;
    
    // Phase 1: Prune tool outputs
    const pruned = await this.pruneToolOutputs(messages);
    
    // Phase 2: Check if compaction is still needed
    const prunedTokens = await this.estimateTokens(pruned);
    const contextLimit = context.model.limit.context;
    
    if (prunedTokens > contextLimit * this.options.threshold) {
      // Phase 3: Perform compaction
      return await this.performCompaction(pruned, context);
    }
    
    return pruned;
  }
  
  /**
   * Prune old tool outputs (OpenCode's pruning algorithm)
   * @param {Array} messages - Conversation messages
   * @returns {Promise<Array>} Pruned messages
   */
  async pruneToolOutputs(messages) {
    const result = [...messages];
    let totalTokens = 0;
    let prunedTokens = 0;
    const toPrune = [];

    const toolNameById = new Map();
    for (const m of result) {
      if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const id = tc?.id;
          const name = tc?.function?.name;
          if (id && name) toolNameById.set(String(id), String(name));
        }
      }
    }
    
    // Walk backward through messages (from oldest to newest)
    // Skip recent 2 turns (about 4 messages)
    let skipCount = 0;

    let keptTokens = 0;
    
    for (let i = result.length - 1; i >= 0; i--) {
      const msg = result[i];
      
      // Stop at first summary message (compaction boundary)
      if (msg.role === 'assistant' && msg.summary === true) {
        break;
      }
      
      // Skip first 2 turns (recent context)
      if (skipCount < 4) {
        skipCount++;
        try { keptTokens += await this.estimateTokens(JSON.stringify(msg)); } catch {}
        continue;
      }

      if (keptTokens < this.options.PRUNE_PROTECT) {
        try { keptTokens += await this.estimateTokens(JSON.stringify(msg)); } catch {}
        continue;
      }

      if (msg?.role === 'tool') {
        const toolName = toolNameById.get(String(msg.tool_call_id || '')) || String(msg.tool_call_id || 'tool');
        if (this.options.PROTECTED_TOOLS.includes(toolName)) {
          continue;
        }
        if (typeof msg.content !== 'string' || !msg.content) {
          continue;
        }

        const outputTokens = await this.estimateTokens(msg.content);
        totalTokens += outputTokens;

        const replacement = `[Output pruned for context optimization: ${toolName}]`;
        const replacementTokens = await this.estimateTokens(replacement);

        toPrune.push({ msgIndex: i, replacement });
        prunedTokens += Math.max(0, outputTokens - replacementTokens);
        continue;
      }
      
      // Check for tool calls to prune
      if (msg.parts) {
        for (const part of msg.parts) {
          if (part.type === 'tool' && part.state === 'completed') {
            // Skip protected tools
            if (this.options.PROTECTED_TOOLS.includes(part.tool)) {
              continue;
            }
            
            // Skip already compacted
            if (part.time?.compacted) {
              continue;
            }
            
            // Estimate tokens in output
            const outputTokens = await this.estimateTokens(part.output);
            totalTokens += outputTokens;
            
            // Mark for pruning if we've accumulated enough
            if (totalTokens > this.options.PRUNE_PROTECT) {
              toPrune.push({ msgIndex: i, part });
              prunedTokens += outputTokens;
            }
          }
        }
      }
    }
    
    // Only apply pruning if we save enough tokens
    if (prunedTokens < this.options.PRUNE_MINIMUM) {
      return messages; // Revert changes
    }
    
    // Apply pruning marks
    for (const mark of toPrune) {
      if (mark.part && result[mark.msgIndex]?.parts) {
        const partIndex = result[mark.msgIndex].parts.indexOf(mark.part);
        if (partIndex !== -1) {
          result[mark.msgIndex].parts[partIndex].time = { compacted: Date.now() };
          result[mark.msgIndex].parts[partIndex].output = '[Output pruned for context optimization]';
        }
      } else if (typeof mark.replacement === 'string' && result[mark.msgIndex]?.role === 'tool') {
        result[mark.msgIndex] = { ...result[mark.msgIndex], content: mark.replacement };
      }
    }
    
    console.log(`Pruned ${prunedTokens} tokens from tool outputs`);
    return result;
  }
  
  /**
   * Perform compaction (generate summary)
   * @param {Array} messages - Messages to compact
   * @param {Object} context - Compression context
   * @returns {Promise<Array>} Compacted messages
   */
  async performCompaction(messages, context) {
    // Generate summary using LLM
    const summary = await this.generateSummary(messages);
    
    // Create summary message (OpenCode format)
    const summaryMessage = {
      role: 'assistant',
      content: summary,
      summary: true,
      agent: 'compaction',
      mode: 'compaction',
      tokens: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 }
      }
    };
    
    // If auto-compaction, add continuation message
    const result = [summaryMessage];
    
    if (context.config?.auto === true && 
        summary.toLowerCase().includes('continue')) {
      result.push({
        role: 'user',
        content: 'Continue if you have next steps'
      });
    }
    
    // Keep recent messages (OpenCode keeps messages after compaction point)
    const recentMessages = this.getRecentMessages(messages, 10);
    return [...result, ...recentMessages];
  }
  
  /**
   * Generate summary of conversation
   * @param {Array} messages - Conversation messages
   * @returns {Promise<string>} Generated summary
   */
  async generateSummary(messages) {
    // In a real implementation, this would call an LLM
    // For now, return a simulated summary
    
    const prompt = this.options.compactionPrompt;
    
    // Extract key information from messages
    const keyInfo = this.extractKeyInformation(messages);
    
    return `Summary of conversation:
    
What was accomplished:
${keyInfo.accomplished.join('\n')}

Current work in progress:
${keyInfo.inProgress.join('\n')}

Files involved:
${keyInfo.files.join('\n')}

Next steps:
${keyInfo.nextSteps.join('\n')}

Key constraints:
${keyInfo.constraints.join('\n')}`;
  }
  
  /**
   * Extract key information from messages
   * @param {Array} messages - Conversation messages
   * @returns {Object} Extracted information
   */
  extractKeyInformation(messages) {
    const info = {
      accomplished: [],
      inProgress: [],
      files: [],
      nextSteps: [],
      constraints: []
    };
    
    // Simple extraction logic
    for (const msg of messages) {
      if (msg.role === 'user') {
        // Extract user requests
        const content = msg.content || '';
        if (content.includes('need') || content.includes('want')) {
          info.inProgress.push(content.substring(0, 100) + '...');
        }
      } else if (msg.role === 'assistant') {
        // Extract assistant actions
        const content = msg.content || '';
        if (content.includes('created') || content.includes('modified')) {
          info.accomplished.push(content.substring(0, 100) + '...');
        }
      }
      
      // Extract file references
      if (msg.content && msg.content.match(/[\w\-]+\.[\w]+/g)) {
        const files = msg.content.match(/[\w\-]+\.[\w]+/g);
        info.files.push(...files);
      }
    }
    
    // Deduplicate
    info.files = [...new Set(info.files)];
    
    return info;
  }
  
  /**
   * Get recent messages (after last compaction)
   * @param {Array} messages - All messages
   * @param {number} count - Number of recent messages to keep
   * @returns {Array} Recent messages
   */
  getRecentMessages(messages, count = 10) {
    // Find last compaction point
    let lastCompactionIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].summary === true) {
        lastCompactionIndex = i;
        break;
      }
    }
    
    // Return messages after last compaction
    return messages.slice(Math.max(lastCompactionIndex + 1, messages.length - count));
  }
  
  /**
   * Estimate token savings
   * @param {Object} context - Compression context
   * @returns {Promise<number>} Estimated tokens saved
   */
  async estimateSavings(context) {
    const { messages } = context;
    
    // Estimate pruning savings
    let pruningSavings = 0;
    for (const msg of messages) {
      if (msg.toolCall && !this.options.PROTECTED_TOOLS.includes(msg.toolName)) {
        pruningSavings += await this.estimateTokens(msg.toolOutput || '');
      }
    }
    
    // Cap at PRUNE_PROTECT
    pruningSavings = Math.min(pruningSavings, this.options.PRUNE_PROTECT);
    
    // Only count if above minimum
    if (pruningSavings < this.options.PRUNE_MINIMUM) {
      pruningSavings = 0;
    }
    
    return pruningSavings;
  }
  
  /**
   * Estimate tokens in text (simplified)
   * @param {any} text - Text or messages to estimate
   * @returns {Promise<number>} Estimated token count
   */
  async estimateTokens(text) {
    if (!text) return 0;
    if (Array.isArray(text)) {
      let total = 0;
      for (const msg of text) {
        const s = JSON.stringify(msg);
        total += Math.ceil(s.length / 4);
      }
      return total;
    }
    if (typeof text === 'object') {
      try {
        const s = JSON.stringify(text);
        return Math.ceil(s.length / 4);
      } catch {
        const s = String(text);
        return Math.ceil(s.length / 4);
      }
    }
    return Math.ceil(String(text).length / 4);
  }
  
  /**
   * Get default compaction prompt (from OpenCode)
   * @returns {string} Default prompt
   */
  getDefaultCompactionPrompt() {
    return `Provide a detailed prompt for continuing our conversation above. 
Focus on information that would be helpful for continuing the conversation, 
including what we did, what we're doing, which files we're working on, 
and what we're going to do next considering new session will not have 
access to our conversation.`;
  }
}
