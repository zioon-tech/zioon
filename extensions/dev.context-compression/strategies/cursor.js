/**
 * Cursor Compression Strategy
 * 
 * Implements Cursor's dynamic context discovery approach:
 * - Long tool responses → files
 * - Chat history as files for summarization
 * - MCP tools loaded on demand
 * - Terminal sessions as files
 */

export class CursorStrategy {
  constructor(options = {}) {
    this.name = 'cursor';
    this.options = {
      maxToolOutputLength: options.maxToolOutputLength || 5000,
      fileOutputPath: options.fileOutputPath || '/tmp/cursor-output',
      enableMCPOptimization: options.enableMCPOptimization !== false,
      enableTerminalSync: options.enableTerminalSync !== false,
      toolDescriptionFolder: options.toolDescriptionFolder || '/tmp/mcp-tools',
      ...options
    };
    
    // Virtual file system for storing outputs
    this.fileSystem = new Map();
    this.fileCounter = 0;
  }
  
  /**
   * Check if compression is needed
   * @param {Object} context - Compression context
   * @returns {Promise<boolean>} Whether to compress
   */
  async shouldCompress(context) {
    // Cursor uses dynamic discovery, doesn't need traditional compression
    // Instead, we check if we should optimize tool outputs
    const { messages } = context;
    
    for (const msg of messages) {
      if (msg.toolOutput && msg.toolOutput.length > this.options.maxToolOutputLength) {
        return true; // Should optimize long outputs
      }
    }
    
    return false;
  }
  
  /**
   * Compress messages using Cursor strategy
   * @param {Object} context - Compression context
   * @returns {Promise<Array>} Compressed messages
   */
  async compress(context) {
    const { messages } = context;
    const result = [];
    
    // Process each message
    for (const msg of messages) {
      const processedMsg = { ...msg };
      
      // 1. Handle long tool outputs (write to file)
      if (msg.toolOutput && msg.toolOutput.length > this.options.maxToolOutputLength) {
        const filePath = await this.writeToolOutputToFile(msg.toolOutput);
        processedMsg.toolOutput = `[Output written to ${filePath}. Use 'tail' to preview.]`;
        processedMsg._cursorFileRef = filePath;
      }
      
      // 2. Handle large content (web pages, documents)
      if (msg.content && msg.content.length > 10000) {
        if (this.isWebContent(msg.content)) {
          const url = this.extractUrl(msg.content);
          if (url) {
            processedMsg.content = `[Webpage content available at: ${url}]`;
            processedMsg._cursorWebRef = url;
          }
        } else if (this.isDocumentContent(msg)) {
          const filePath = await this.writeContentToFile(msg.content);
          processedMsg.content = `[Document content available at: ${filePath}]`;
          processedMsg._cursorDocRef = filePath;
        }
      }
      
      result.push(processedMsg);
    }
    
    // 3. Add MCP tool optimization if enabled
    if (this.options.enableMCPOptimization) {
      await this.optimizeMCPTools(result);
    }
    
    // 4. Add terminal session references if enabled
    if (this.options.enableTerminalSync) {
      await this.addTerminalReferences(result);
    }
    
    console.log(`Cursor optimization applied: ${this.fileSystem.size} files created`);
    return result;
  }
  
  /**
   * Write tool output to virtual file
   * @param {string} output - Tool output
   * @returns {Promise<string>} File path
   */
  async writeToolOutputToFile(output) {
    this.fileCounter++;
    const fileName = `tool-output-${this.fileCounter}.txt`;
    const filePath = `${this.options.fileOutputPath}/${fileName}`;
    
    this.fileSystem.set(filePath, {
      content: output,
      createdAt: Date.now(),
      type: 'tool-output'
    });
    
    return filePath;
  }
  
  /**
   * Write content to virtual file
   * @param {string} content - Content to write
   * @returns {Promise<string>} File path
   */
  async writeContentToFile(content) {
    this.fileCounter++;
    const fileName = `content-${this.fileCounter}.txt`;
    const filePath = `${this.options.fileOutputPath}/${fileName}`;
    
    this.fileSystem.set(filePath, {
      content,
      createdAt: Date.now(),
      type: 'document'
    });
    
    return filePath;
  }
  
  /**
   * Check if content is web content
   * @param {string} content - Content to check
   * @returns {boolean} Whether it's web content
   */
  isWebContent(content) {
    return content.includes('http://') || 
           content.includes('https://') ||
           content.includes('www.');
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
           (msg.content && msg.content.length > 5000 && 
            !this.isWebContent(msg.content));
  }
  
  /**
   * Optimize MCP tool descriptions (Cursor's approach)
   * @param {Array} messages - Messages to optimize
   * @returns {Promise<void>}
   */
  async optimizeMCPTools(messages) {
    // Extract MCP tool references
    const mcpTools = this.extractMCPTools(messages);
    
    if (mcpTools.length === 0) return;
    
    // Create tool description files (one per server)
    const servers = this.groupToolsByServer(mcpTools);
    
    for (const [serverName, tools] of Object.entries(servers)) {
      const serverFolder = `${this.options.toolDescriptionFolder}/${serverName}`;
      
      // Create tool index file
      const indexContent = this.createToolIndex(tools);
      const indexPath = `${serverFolder}/index.md`;
      
      this.fileSystem.set(indexPath, {
        content: indexContent,
        createdAt: Date.now(),
        type: 'mcp-index'
      });
      
      // Create individual tool files
      for (const tool of tools) {
        const toolPath = `${serverFolder}/${tool.name}.md`;
        const toolContent = this.createToolDescription(tool);
        
        this.fileSystem.set(toolPath, {
          content: toolContent,
          createdAt: Date.now(),
          type: 'mcp-tool'
        });
      }
    }
    
    // Add system message about MCP tools
    const toolNames = mcpTools.map(t => t.name).join(', ');
    messages.push({
      role: 'system',
      content: `Available MCP tools: ${toolNames}. Use search_tool() to get details from ${this.options.toolDescriptionFolder}/.`
    });
  }
  
  /**
   * Extract MCP tools from messages
   * @param {Array} messages - Messages to analyze
   * @returns {Array} MCP tool references
   */
  extractMCPTools(messages) {
    const tools = [];
    
    for (const msg of messages) {
      if (msg.toolCall && msg.toolName && msg.toolName.startsWith('mcp_')) {
        tools.push({
          name: msg.toolName,
          description: msg.toolDescription || 'No description',
          server: this.extractMCPServer(msg.toolName)
        });
      }
    }
    
    // Deduplicate
    const uniqueTools = [];
    const seen = new Set();
    
    for (const tool of tools) {
      const key = `${tool.server}:${tool.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueTools.push(tool);
      }
    }
    
    return uniqueTools;
  }
  
  /**
   * Extract MCP server name from tool name
   * @param {string} toolName - Tool name
   * @returns {string} Server name
   */
  extractMCPServer(toolName) {
    // Example: mcp_github_search -> github
    const match = toolName.match(/^mcp_([^_]+)/);
    return match ? match[1] : 'unknown';
  }
  
  /**
   * Group tools by server
   * @param {Array} tools - Tools to group
   * @returns {Object} Tools grouped by server
   */
  groupToolsByServer(tools) {
    const groups = {};
    
    for (const tool of tools) {
      if (!groups[tool.server]) {
        groups[tool.server] = [];
      }
      groups[tool.server].push(tool);
    }
    
    return groups;
  }
  
  /**
   * Create tool index content
   * @param {Array} tools - Tools to index
   * @returns {string} Index content
   */
  createToolIndex(tools) {
    let content = '# MCP Tools Index\n\n';
    
    for (const tool of tools) {
      content += `## ${tool.name}\n`;
      content += `${tool.description}\n\n`;
    }
    
    return content;
  }
  
  /**
   * Create tool description
   * @param {Object} tool - Tool to describe
   * @returns {string} Tool description
   */
  createToolDescription(tool) {
    return `# ${tool.name}\n\n${tool.description}\n\nUsage: Call ${tool.name}() with appropriate parameters.`;
  }
  
  /**
   * Add terminal session references
   * @param {Array} messages - Messages to update
   * @returns {Promise<void>}
   */
  async addTerminalReferences(messages) {
    // Extract terminal outputs
    const terminalOutputs = this.extractTerminalOutputs(messages);
    
    if (terminalOutputs.length === 0) return;
    
    // Create terminal session file
    const sessionContent = this.createTerminalSession(terminalOutputs);
    const sessionPath = `${this.options.fileOutputPath}/terminal-session.md`;
    
    this.fileSystem.set(sessionPath, {
      content: sessionContent,
      createdAt: Date.now(),
      type: 'terminal-session'
    });
    
    // Add reference message
    messages.push({
      role: 'system',
      content: `Terminal session history available at: ${sessionPath}. Use grep to search for specific outputs.`
    });
  }
  
  /**
   * Extract terminal outputs from messages
   * @param {Array} messages - Messages to analyze
   * @returns {Array} Terminal outputs
   */
  extractTerminalOutputs(messages) {
    const outputs = [];
    
    for (const msg of messages) {
      if (msg.toolCall && msg.toolName && 
          (msg.toolName.includes('shell') || msg.toolName.includes('terminal'))) {
        outputs.push({
          command: msg.toolName,
          output: msg.toolOutput || '',
          timestamp: msg.timestamp || Date.now()
        });
      }
    }
    
    return outputs;
  }
  
  /**
   * Create terminal session content
   * @param {Array} outputs - Terminal outputs
   * @returns {string} Session content
   */
  createTerminalSession(outputs) {
    let content = '# Terminal Session History\n\n';
    
    for (const output of outputs) {
      content += `## ${new Date(output.timestamp).toLocaleString()}\n`;
      content += `Command: ${output.command}\n\n`;
      content += '```\n';
      content += output.output.substring(0, 1000); // Limit output length
      if (output.output.length > 1000) {
        content += '\n... (output truncated)';
      }
      content += '\n```\n\n';
    }
    
    return content;
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
      // Savings from tool output optimization
      if (msg.toolOutput && msg.toolOutput.length > this.options.maxToolOutputLength) {
        const originalTokens = await this.estimateTokens(msg.toolOutput);
        const replacementTokens = await this.estimateTokens('[Output written to file...]');
        savings += originalTokens - replacementTokens;
      }
      
      // Savings from content optimization
      if (msg.content && msg.content.length > 10000) {
        const originalTokens = await this.estimateTokens(msg.content);
        const replacementTokens = await this.estimateTokens('[Content available at...]');
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
   * Get file content (for reading back optimized content)
   * @param {string} filePath - File path
   * @returns {string|null} File content
   */
  getFileContent(filePath) {
    const file = this.fileSystem.get(filePath);
    return file ? file.content : null;
  }
  
  /**
   * List all files in virtual file system
   * @returns {Array} List of file paths
   */
  listFiles() {
    return Array.from(this.fileSystem.keys());
  }
  
  /**
   * Clear virtual file system
   */
  clearFileSystem() {
    this.fileSystem.clear();
    this.fileCounter = 0;
  }
}