/**
 * KV-Cache Optimizer
 * 
 * Implements Manus-style KV-Cache optimization:
 * - Stable system prompt prefix
 * - Append-only context
 * - Deterministic serialization
 * - Cache breakpoint management
 */

export class KVCacheOptimizer {
  constructor(options = {}) {
    this.options = {
      enableStablePrefix: options.enableStablePrefix !== false,
      enableAppendOnly: options.enableAppendOnly !== false,
      enableDeterministicSerialization: options.enableDeterministicSerialization !== false,
      enableCacheBreakpoints: options.enableCacheBreakpoints !== false,
      
      // System prompt settings
      systemPrompt: options.systemPrompt || this.getDefaultSystemPrompt(),
      
      // Cache breakpoint settings
      cacheBreakpoints: options.cacheBreakpoints || [],
      maxCacheAge: options.maxCacheAge || 3600000, // 1 hour in ms
      
      ...options
    };
    
    // Cache state
    this.cacheEntries = new Map();
    this.cacheStats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      totalBytes: 0
    };
  }
  
  /**
   * Optimize prompt for KV-Cache
   * @param {string} prompt - Original prompt
   * @returns {Promise<string>} Optimized prompt
   */
  async optimizePrompt(prompt) {
    if (!prompt) return prompt;
    
    let optimized = prompt;
    
    // 1. Ensure stable system prompt
    if (this.options.enableStablePrefix) {
      optimized = this.applyStablePrefix(optimized);
    }
    
    // 2. Make context append-only
    if (this.options.enableAppendOnly) {
      optimized = this.makeAppendOnly(optimized);
    }
    
    // 3. Ensure deterministic serialization
    if (this.options.enableDeterministicSerialization) {
      optimized = this.ensureDeterministicSerialization(optimized);
    }
    
    // 4. Add cache breakpoints
    if (this.options.enableCacheBreakpoints) {
      optimized = this.addCacheBreakpoints(optimized);
    }
    
    return optimized;
  }
  
  /**
   * Apply stable system prefix
   * @param {string} prompt - Prompt to optimize
   * @returns {string} Prompt with stable prefix
   */
  applyStablePrefix(prompt) {
    // Check if prompt already has system section
    if (!prompt.includes('<|im_start|>system') && 
        !prompt.includes('[SYSTEM]')) {
      // Prepend stable system prompt
      return `${this.options.systemPrompt}\n\n${prompt}`;
    }
    
    // Replace dynamic elements in existing system prompt
    let optimized = prompt;
    
    // Remove timestamps (they break cache)
    optimized = optimized.replace(
      /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g,
      '[CURRENT_TIME]'
    );
    
    // Remove session IDs
    optimized = optimized.replace(
      /session[_\-][a-zA-Z0-9]+/g,
      '[SESSION_ID]'
    );
    
    // Remove request IDs
    optimized = optimized.replace(
      /request[_\-][a-zA-Z0-9]+/g,
      '[REQUEST_ID]'
    );
    
    return optimized;
  }
  
  /**
   * Make prompt append-only
   * @param {string} prompt - Prompt to optimize
   * @returns {string} Append-only prompt
   */
  makeAppendOnly(prompt) {
    // In append-only mode, we don't modify previous context
    // We just ensure the new addition is append-only
    
    return prompt;
  }
  
  /**
   * Ensure deterministic serialization
   * @param {string} prompt - Prompt to optimize
   * @returns {string} Deterministically serialized prompt
   */
  ensureDeterministicSerialization(prompt) {
    // Parse and re-serialize JSON structures with stable key order
    let optimized = prompt;
    
    // Find all JSON-like structures
    const jsonMatches = optimized.match(/\{[^{}]*\}/g);
    
    if (jsonMatches) {
      for (const match of jsonMatches) {
        try {
          const obj = JSON.parse(match);
          const stableJson = this.stabilizeObject(obj);
          optimized = optimized.replace(match, JSON.stringify(stableJson));
        } catch (error) {
          // Not valid JSON, skip
        }
      }
    }
    
    return optimized;
  }
  
  /**
   * Stabilize object (sort keys deterministically)
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
   * Add cache breakpoints
   * @param {string} prompt - Prompt to optimize
   * @returns {string} Prompt with cache breakpoints
   */
  addCacheBreakpoints(prompt) {
    // Add breakpoints at strategic locations
    // (after system prompt, after large context blocks, etc.)
    
    let optimized = prompt;
    
    // Add breakpoint after system prompt
    const systemPromptEnd = optimized.search(
      /<\/?system>|\/?im_start|>|\\n\\n/
    );
    
    if (systemPromptEnd !== -1) {
      optimized = optimized.slice(0, systemPromptEnd + 1) + 
                 '<|cache_breakpoint|>' + 
                 optimized.slice(systemPromptEnd + 1);
    }
    
    return optimized;
  }
  
  /**
   * Check cache entry
   * @param {string} key - Cache key
   * @returns {Object|null} Cache entry
   */
  checkCache(key) {
    const entry = this.cacheEntries.get(key);
    
    if (!entry) {
      this.cacheStats.misses++;
      return null;
    }
    
    // Check if cache is expired
    if (Date.now() - entry.timestamp > this.options.maxCacheAge) {
      this.cacheEntries.delete(key);
      this.cacheStats.evictions++;
      return null;
    }
    
    this.cacheStats.hits++;
    return entry.value;
  }
  
  /**
   * Add cache entry
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} ttl - Time to live in ms (optional)
   */
  addCacheEntry(key, value, ttl = null) {
    const timestamp = Date.now();
    
    this.cacheEntries.set(key, {
      value,
      timestamp,
      ttl
    });
    
    this.cacheStats.totalBytes += this.estimateSize(value);
  }
  
  /**
   * Clear cache
   */
  clearCache() {
    this.cacheEntries.clear();
    this.cacheStats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      totalBytes: 0
    };
  }
  
  /**
   * Get cache statistics
   * @returns {Object} Cache statistics
   */
  getCacheStats() {
    const total = this.cacheStats.hits + this.cacheStats.misses;
    const hitRate = total > 0 ? (this.cacheStats.hits / total * 100).toFixed(1) : 0;
    
    return {
      ...this.cacheStats,
      hitRate: `${hitRate}%`,
      entries: this.cacheEntries.size,
      avgEntrySize: this.cacheEntries.size > 0 ? 
        Math.round(this.cacheStats.totalBytes / this.cacheEntries.size) : 0
    };
  }
  
  /**
   * Estimate size of value in bytes
   * @param {any} value - Value to estimate
   * @returns {number} Estimated size in bytes
   */
  estimateSize(value) {
    const str = JSON.stringify(value);
    return str.length * 2; // UTF-16 encoding (2 bytes per char)
  }
  
  /**
   * Generate cache key for prompt
   * @param {string} prompt - Prompt to generate key for
   * @returns {string} Cache key
   */
  generateCacheKey(prompt) {
    // Create stable cache key by normalizing prompt
    let normalized = prompt.toLowerCase();
    
    // Remove dynamic elements
    normalized = normalized.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g, '');
    normalized = normalized.replace(/session[_\-][a-zA-Z0-9]+/g, '');
    normalized = normalized.replace(/\s+/g, ' ');
    
    // Hash for shorter key
    return this.simpleHash(normalized);
  }
  
  /**
   * Simple hash function
   * @param {string} str - String to hash
   * @returns {string} Hash
   */
  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }
  
  /**
   * Get default system prompt
   * @returns {string} Default system prompt
   */
  getDefaultSystemPrompt() {
    return `<|im_start|>system
You are an AI coding assistant.

Available tools will be provided dynamically based on the current state and context.

Guidelines:
- Be concise and direct in your responses
- Use tools when appropriate
- Explain your reasoning when helpful
- Ask for clarification when needed

Context management:
- Maintain awareness of the current task and goals
- Keep track of files and code you've worked on
- Summarize completed work periodically
- Ask for clarification if context becomes unclear
<|im_end|>`;
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
  
  /**
   * Reset cache statistics
   */
  resetStats() {
    this.cacheStats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      totalBytes: 0
    };
  }
}
