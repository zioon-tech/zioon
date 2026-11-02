export class ProgressiveStrategy {
  constructor(options = {}) {
    this.name = 'progressive';
    this.options = {
      threshold: Number(options.threshold || 0.85),
      keepRecentTurns: Number(options.keepRecentTurns || 2),
      maxRecordPromptChars: Number(options.maxRecordPromptChars || 100),
      tokensProtect: Number(options.tokensProtect || 0),
      tokensCompact: Number(options.tokensCompact || 0),
      recentProtectTokens: Number(options.recentProtectTokens || 20000)
    };
  }
  updateOptions(opts = {}) {
    if (opts.threshold != null) this.options.threshold = Number(opts.threshold);
    if (opts.keepRecentTurns != null) this.options.keepRecentTurns = Number(opts.keepRecentTurns);
    if (opts.maxRecordPromptChars != null) this.options.maxRecordPromptChars = Number(opts.maxRecordPromptChars);
    if (opts.tokensProtect != null) this.options.tokensProtect = Number(opts.tokensProtect);
    if (opts.tokensCompact != null) this.options.tokensCompact = Number(opts.tokensCompact);
    if (opts.recentProtectTokens != null) this.options.recentProtectTokens = Number(opts.recentProtectTokens);
  }
  async shouldCompress(context) {
    const limit = Number(context?.model?.limit?.context || 0);
    const tokens = Number(context?.tokens || 0);
    if (limit > 0 && tokens > limit * this.options.threshold) return true;
    const msgs = Array.isArray(context?.messages) ? context.messages : [];
    let toolCount = 0;
    let longTool = false;
    for (const m of msgs) {
      if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) toolCount += m.tool_calls.length;
      if (m?.role === 'tool') {
        const text = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '');
        if (text.length > 2000) longTool = true;
      }
    }
    if (toolCount > 5 || longTool) return true;
    return false;
  }
  async compress(context) {
    const messages = Array.isArray(context?.messages) ? context.messages : [];
    const totalTokens = await this.estimateTokens(messages);
    if (this.options.tokensProtect > 0 && totalTokens < this.options.tokensProtect) {
      return messages;
    }
    const savings = await this.estimateSavings({ messages });
    if (this.options.tokensCompact > 0 && savings < this.options.tokensCompact) {
      return messages;
    }
    let protectStart = messages.length;
    if (this.options.recentProtectTokens > 0) {
      let acc = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        acc += Math.ceil(JSON.stringify(messages[i]).length / 4);
        protectStart = i;
        if (acc >= this.options.recentProtectTokens) break;
      }
    }
    const toolNameById = new Map();
    const toolArgsById = new Map();
    for (const m of messages) {
      if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const id = tc?.id != null ? String(tc.id) : '';
          const name = tc?.function?.name != null ? String(tc.function.name) : '';
          let args = tc?.function?.arguments;
          if (args != null && typeof args !== 'string') {
            try { args = JSON.stringify(args); } catch { args = String(args); }
          }
          if (id) {
            toolNameById.set(id, name);
            toolArgsById.set(id, args || '');
          }
        }
      }
    }
    const keepTurns = Math.max(0, this.options.keepRecentTurns);
    let skipCount = 0;
    const out = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'assistant' && !Array.isArray(msg.tool_calls)) {
        if (i < protectStart) {
          const c = Array.isArray(msg.content) ? msg.content : null;
          if (c) {
            const filtered = c.filter((part) => part?.type !== 'thinking');
            if (filtered.length > 0) {
              out.push({ ...msg, content: filtered });
            }
            continue;
          }
        }
      }
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        out.push(msg);
        continue;
      }
      if (msg.role === 'tool') {
        if (i >= protectStart) {
          out.push(msg);
          continue;
        }
        if (skipCount < this.options.keepRecentTurns * 2) {
          out.push(this.minimalToolMessage(msg, toolNameById, toolArgsById));
          skipCount++;
          continue;
        }
        out.push(this.minimalToolMessage(msg, toolNameById, toolArgsById));
        continue;
      }
      out.push(msg);
    }
    return out;
  }
  async estimateSavings(context) {
    const msgs = Array.isArray(context?.messages) ? context.messages : [];
    let original = 0;
    let after = 0;
    for (const m of msgs) {
      const s = JSON.stringify(m);
      original += Math.ceil(s.length / 4);
      const mm = m.role === 'tool' ? this.minimalToolMessage(m, new Map(), new Map()) : m;
      const ss = JSON.stringify(mm);
      after += Math.ceil(ss.length / 4);
    }
    return Math.max(0, original - after);
  }
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
  minimalToolMessage(msg, toolNameById, toolArgsById) {
    const id = msg?.tool_call_id != null ? String(msg.tool_call_id) : '';
    const name = toolNameById.get(id) || String(msg.toolName || '');
    const args = toolArgsById.get(id) || '';
    const raw = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content || '');
    // Without a durable recovery reference, retain the complete output.
    if (!msg.recovery || msg.toolResultStatus?.ok !== true || msg.toolResultStatus?.failureCode) return msg;
    const prompt = raw.slice(0, this.options.maxRecordPromptChars);
    const urlMatch = raw.match(/https?:\/\/[^\s)]+/i);
    const fileMatch = raw.match(/(?:[A-Za-z0-9_.\/-]+)\.(?:js|ts|tsx|jsx|py|md|json|yaml|yml|html|css|scss|go|rs|java|kt|c|h|cpp|cc|cs|sh|bash|zsh|ps1)/i);
    const kind = String(name || '').toLowerCase();
    let argObj = {};
    try { argObj = args ? JSON.parse(args) : {}; } catch { argObj = {}; }
    const argPrompt = typeof argObj?.prompt === 'string' ? argObj.prompt : '';
    let record = { tool_call_id: id, tool: name || 'unknown', status: msg.toolResultStatus, note: '[Output pruned for context optimization]', recovery: msg.recovery };
    if (kind.includes('read')) {
      record.file_path = fileMatch ? fileMatch[0] : undefined;
    } else if (kind.includes('websearch')) {
      record.prompt = argPrompt || args || prompt;
    } else if (kind.includes('webfetch') || kind.includes('fetch')) {
      record.prompt = argPrompt || args || prompt;
      record.url = urlMatch ? urlMatch[0] : undefined;
    } else if (kind.includes('edit')) {
      record.file_path = fileMatch ? fileMatch[0] : undefined;
      record.prompt = argPrompt || prompt;
    } else if (kind.includes('write')) {
      record.file_path = fileMatch ? fileMatch[0] : undefined;
      record.prompt = argPrompt || prompt;
    } else {
      record.prompt = argPrompt || prompt;
    }
    Object.keys(record).forEach(k => { if (record[k] == null) delete record[k]; });
    return { role: 'tool', tool_call_id: id, content: record };
  }
}
