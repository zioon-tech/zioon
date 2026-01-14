/**
 * Manus Compression Strategy
 * 
 * Implements Manus's KV-Cache optimization approach:
 * - Stable system prompt prefix
 * - Append-only context
 * - Maskable tool selection
 * - File system as context (restorable compression)
 */

export class ManusStrategy {
  constructor(options = {}) {
    this.name = 'manus';
    this.options = {
      // KV-Cache optimization settings
      enableKVCacheOptimization: options.enableKVCacheOptimization !== false,
      stablePrefix: options.stablePrefix || this.buildStablePrefix(),
      
      // Compression settings
      enableRestorableCompression: options.enableRestorableCompression !== false,
      maxContentSize: options.maxContentSize || 1000,
      
      // Tool management
      enableToolMasking: options.enableToolMasking !== false,
      toolGroupPrefixes: options.toolGroupPrefixes || {
        browser: 'browser_',
        shell: 'shell_',
        terminal: 'terminal_'
      },
      
      ...options
    };
    
    // File system for restorable compression
    this.fileSystem = new Map();
  }
  
  /**
   * Check if compression is needed
   * @param {Object} context - Compression context
   * @returns {Promise<boolean>} Whether to compress
   */
  async shouldCompress(context) {
    const { messages } = context;
    
    // Manus uses restorable compression, so check for large content
    for (const msg of messages) {
      if (msg.content && msg.content.length > this.options.maxContentSize * 10) {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Compress messages using Manus strategy
   * @param {Object} context - Compression context
   * @returns {Promise<Array>} Compressed messages
   */
  async compress(context) {
    const { messages } = context;
    const result = [];
    
    // Process each message
    for (const msg of messages) {
      const processedMsg = { ...msg };
      
      // 1. Apply restorable compression for web content
      if (this.isWebContent(msg)) {
        const url = this.extractUrl(msg.content);
        if (url) {
          processedMsg.content = `[Webpage content available at: ${url}]`;
          processedMsg._manusWebRef = url;
          processedMsg._manusOriginalContent = msg.content; // Store for restoration
        }
      }
      // 2. Apply restorable compression for documents
      else if (this.isDocumentContent(msg)) {
        const filePath = this.writeDocumentToFile(msg);
        processedMsg.content = `[Document content available at: ${filePath}]`;
        processedMsg._manusDocRef = filePath;
        processedMsg._manusOriginalContent = msg.content;
      }
      // 3. Optimize tool outputs
      else if (msg.toolOutput && msg.toolOutput.length > 1000) {
        const filePath = this.writeToolOutputToFile(msg.toolOutput);
        processedMsg.toolOutput = `[Tool output available at: ${filePath}]`;
        processedMsg._manusToolRef = filePath;
        processedMsg._manusOriginalOutput = msg.toolOutput;
      }
      
      result.push(processedMsg);
    }
    
    console.log(`Manus compression: restorable compression applied to ${this.fileSystem.size} items`);
    return result;
  }
  
  /**
   * Build stable system prompt prefix (for KV-Cache)
   * @returns {string} Stable prefix
   */
  buildStablePrefix() {
    // Important: Do NOT include dynamic content like timestamps
    return `You are an AI coding assistant.

Available commands:
- search_tool(name): Get tool details
- read_file(path): Read from virtual file system
- write_file(path, content): Write to virtual file system

Tool availability will be managed dynamically based on current state.
`;
  }
  
  /**
   * Optimize system prompt for KV-Cache
   * @param {string} systemPrompt - Original system prompt
   * @returns {string} Optimized system prompt
   */
  optimizeSystemPrompt(systemPrompt) {
    if (!this.options.enableKVCacheOptimization) {
      return systemPrompt;
    }
    
    // Remove dynamic elements that break cache
    let optimized = systemPrompt;
    
    // Remove exact timestamps
    optimized = optimized.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g, '[CURRENT_TIME]');
    
    // Remove session IDs
    optimized = optimized.replace(/session[_\-][a-zA-Z0-9]+/g, '[SESSION_ID]');
    
    // Use stable prefix instead
    if (optimized.includes('[CURRENT_TIME]') || optimized.includes('[SESSION_ID]')) {
      optimized = this.options.stablePrefix + '\n\n' + optimized;
    }
    
    return optimized;
  }
  
  /**
   * Make context append-only (for KV-Cache)
   * @param {Array} messages - Messages to process
   * @returns {Array} Append-only messages
   */
  makeAppendOnly(messages) {
    // Ensure deterministic serialization
    const result = [];
    
    for (const msg of messages) {
      const msgCopy = { ...msg };
      
      // Remove dynamic fields that would cause cache invalidation
      delete msgCopy.timestamp;
      delete msgCopy._id;
      delete msgCopy._uuid;
      
      // Ensure JSON key order is stable
      if (msgCopy.parts) {
        msgCopy.parts = this.stabilizeObject(msgCopy.parts);
      }
      
      result.push(msgCopy);
    }
    
    return result;
  }
  
  /**
   * Stabilize object keys (deterministic serialization)
   * @param {Object} obj - Object to stabilize
   * @returns {Object} Stabilized object
   */
  stabilizeObject(obj) {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.stabilizeObject(item));
    }
    
    // Sort keys alphabetically for deterministic serialization
    const sorted = {};
    const keys = Object.keys(obj).sort();
    
    for (const key of keys) {
      sorted[key] = this.stabilizeObject(obj[key]);
    }
    
    return sorted;
  }
  
  /**
   * Check if content is web content
   * @param {Object} msg - Message to check
   * @returns {boolean} Whether it's web content
   */
  isWebContent(msg) {
    if (!msg.content) return false;
    return msg.content.includes('http://') || 
           msg.content.includes('https://') ||
           msg.content.includes('www.');
  }
  
  /**
   * Extract URL from content
   * @param {string} content - Content containing URL
   * @returns {string|null} Extracted URL
   */
  extractUrl(content) {
    const urlRegex = /https?:\/\/[^\s]+|www\.[^\s]+/g;
    const matches = content.match(urlRegex);
    return matches ? matches[0] : null;
  }
  
  /**
   * Check if message is document content
   * @param {Object} msg - Message to check
   * @returns {boolean} Whether it's document content
   */
  isDocumentContent(msg) {
    return msg.type === 'document' || 
           (msg.content && msg.content.length > this.options.maxContentSize && 
            !this.isWebContent(msg));
  }
  
  /**
   * Write document to virtual file
   * @param {Object} msg - Message with document content
   * @returns {string} File path
   */
  writeDocumentToFile(msg) {
    const fileName = `doc-${this.generateId()}.txt`;
    const filePath = `/tmp/manus-docs/${fileName}`;
    
    this.fileSystem.set(filePath, {
      content: msg.content,
      type: 'document',
      createdAt: Date.now(),
      originalMsg: msg
    });
    
    return filePath;
  }
  
  /**
   * Write tool output to virtual file
   * @param {string} output - Tool output
   * @returns {string} File path
   */
  writeToolOutputToFile(output) {
    const fileName = `tool-output-${this.generateId()}.txt`;
    const filePath = `/tmp/manus-tools/${fileName}`;
    
    this.fileSystem.set(filePath, {
      content: output,
      type: 'tool-output',
      createdAt: Date.now()
    });
    
    return filePath;
  }
  
  /**
   * Mask tool selection (instead of removing tools)
   * @param {Array} availableTools - All available tools
   * @param {Array} allowedTools - Tools to allow
   * @returns {Object} Tool masking configuration
   */
  createToolMask(availableTools, allowedTools) {
    if (!this.options.enableToolMasking) {
      return { enabled: availableTools };
    }
    
    // Group tools by prefix
    const groups = this.groupToolsByPrefix(availableTools);
    
    // Create mask based on allowed groups
    const mask = {};
    
    for (const [groupName, prefix] of Object.entries(this.options.toolGroupPrefixes)) {
      const groupTools = groups[groupName] || [];
      
      // Check if any tool in this group is allowed
      const groupAllowed = groupTools.some(tool => 
        allowedTools.includes(tool.name));
      
      mask[groupName] = {
        enabled: groupAllowed,
        prefix,
        tools: groupTools
      };
    }
    
    return mask;
  }
  
  /**
   * Group tools by prefix
   * @param {Array} tools - Tools to group
   * @returns {Object} Tools grouped by prefix
   */
  groupToolsByPrefix(tools) {
    const groups = {};
    
    for (const tool of tools) {
      for (const [groupName, prefix] of Object.entries(this.options.toolGroupPrefixes)) {
        if (tool.name.startsWith(prefix)) {
          if (!groups[groupName]) {
            groups[groupName] = [];
          }
          groups[groupName].push(tool);
          break;
        }
      }
    }
    
    return groups;
  }
  
  /**
   * Get tool prefill for constrained decoding
   * @param {string} mode - Decoding mode ('auto' | 'required' | 'specified')
   * @param {string} groupName - Tool group name (for 'specified' mode)
   * @returns {string} Prefill content
   */
  getToolPrefill(mode, groupName = null) {
    switch (mode) {
      case 'auto':
        return '<|im_start|>assistant';
      case 'required':
        return '<|im_start|>assistant<｜tool_call｜>';
      case 'specified':
        if (groupName && this.options.toolGroupPrefixes[groupName]) {
          const prefix = this.options.toolGroupPrefixes[groupName];
          return `<|im_start|>assistant<｜tool_call｜>{"name": "${prefix}`;
        }
        return '<|im_start|>assistant<｜tool_call｜>';
      default:
        return '<|im_start|>assistant';
    }
  }
  
  /**
   * Estimate token savings
   * @param {Object} context - Compression context
   * @returns {Promise<number>} Estimated tokens saved
   */
  async estimateSavings(context) {
    const { messages } = context;
    let savings = 0;
    
    for (const msg of messages) {
      // Savings from web content compression
      if (this.isWebContent(msg)) {
        const originalTokens = await this.estimateTokens(msg.content);
        const replacementTokens = await this.estimateTokens('[Webpage content available at...]');
        savings += originalTokens - replacementTokens;
      }
      // Savings from document compression
      else if (this.isDocumentContent(msg)) {
        const originalTokens = await this.estimateTokens(msg.content);
        const replacementTokens = await this.estimateTokens('[Document content available at...]');
        savings += originalTokens - replacementTokens;
      }
      // Savings from tool output compression
      else if (msg.toolOutput && msg.toolOutput.length > 1000) {
        const originalTokens = await this.estimateTokens(msg.toolOutput);
        const replacementTokens = await this.estimateTokens('[Tool output available at...]');
        savings += originalTokens - replacementTokens;
      }
    }
    
    return savings;
  }
  
  /**
   * Estimate tokens in text
   * @param {string} text - Text to estimate
   * @returns {Promise<number>} Estimated token count
   */
  async estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }
  
  /**
   * Restore content from file
   * @param {string} filePath - File path
   * @returns {string|null} File content
   */
  restoreContent(filePath) {
    const file = this.fileSystem.get(filePath);
    return file ? file.content : null;
  }
  
  /**
   * Get file from file system
   * @param {string} filePath - File path
   * @returns {Object|null} File object
   */
  getFile(filePath) {
    return this.fileSystem.get(filePath) || null;
  }
  
  /**
   * List all files
   * @returns {Array} List of file paths
   */
  listFiles() {
    return Array.from(this.fileSystem.keys());
  }
  
  /**
   * Clear file system
   */
  clearFileSystem() {
    this.fileSystem.clear();
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
   * Get KV-Cache statistics
   * @returns {Object} Cache statistics
   */
  getKVCacheStats() {
    return {
      enabled: this.options.enableKVCacheOptimization,
      stablePrefixLength: this.options.stablePrefix.length,
      toolMaskingEnabled: this.options.enableToolMasking,
      appendOnlyMode: true,
      deterministicSerialization: true
    };
  }
}
