const { CompressionEngine } = await import('../compression-core.js');
const { OpenCodeStrategy } = await import('../strategies/opencode.js');
const { ClaudeCodeStrategy } = await import('../strategies/claude-code.js');
const { TokenCounter } = await import('../token-counter.js');
const { ProgressiveStrategy } = await import('../strategies/progressive.js');

function makeToolMessage(id, name, content) {
  return { role: 'tool', tool_call_id: String(id), content, toolName: name, toolOutput: content };
}

function makeAssistantWithToolCalls(calls) {
  return { role: 'assistant', content: 'calling tools', tool_calls: calls.map((c) => ({ id: String(c.id), type: 'function', function: { name: c.name, arguments: c.args } })) };
}

function makeUser(text) {
  return { role: 'user', content: text };
}

function buildConversation() {
  const msgs = [];
  for (let i = 0; i < 12; i++) {
    msgs.push(makeUser(`User request ${i}`));
    msgs.push({ role: 'assistant', content: `Assistant response ${i}` });
  }
  msgs.push(makeAssistantWithToolCalls([{ id: 1, name: 'build', args: '{}' }, { id: 2, name: 'lint', args: '{}' }, { id: 3, name: 'deploy', args: '{}' }]));
  const longOutput = 'X'.repeat(20000);
  msgs.push(makeToolMessage(1, 'build', longOutput));
  msgs.push(makeToolMessage(2, 'lint', longOutput));
  msgs.push(makeToolMessage(3, 'deploy', longOutput));
  for (let i = 0; i < 10; i++) {
    msgs.push(makeUser(`Follow-up ${i}`));
    msgs.push({ role: 'assistant', content: `Working on follow-up ${i}` });
  }
  return msgs;
}

async function run() {
  const engine = new CompressionEngine();
  engine.updateConfig({ maxTokens: 4000, outputTokens: 1024, charsPerToken: 4, threshold: 0.8 });

  const oc = new OpenCodeStrategy();
  oc.updateOptions({ pruneProtect: 3000, pruneMinimum: 500, protectedTools: [], threshold: 0.6, outputTokenMax: 1024 });
  const cc = new ClaudeCodeStrategy({ keepRecentMessages: 8, threshold: 0.8 });
  const pg = new ProgressiveStrategy({ threshold: 0.6, keepRecentTurns: 2 });

  engine.registerStrategy('opencode', oc);
  engine.registerStrategy('claude-code', cc);
  engine.registerStrategy('progressive', pg);

  const counter = new TokenCounter({ charsPerToken: 4 });
  const messages = buildConversation();

  const originalTokens = await counter.countConversationTokens(messages, 'default');
  const compressedAuto = await engine.compress(messages, 'auto');
  const compressedTokensAuto = await counter.countConversationTokens(compressedAuto, 'default');

  const compressedOC = await engine.compress(messages, 'opencode');
  const compressedTokensOC = await counter.countConversationTokens(compressedOC, 'default');

  const compressedCC = await engine.compress(messages, 'claude-code');
  const compressedTokensCC = await counter.countConversationTokens(compressedCC, 'default');
  const compressedPG = await engine.compress(messages, 'progressive');
  const compressedTokensPG = await counter.countConversationTokens(compressedPG, 'default');

  const report = {
    original: { messages: messages.length, tokens: originalTokens.total },
    auto: { messages: compressedAuto.length, tokens: compressedTokensAuto.total },
    opencode: { messages: compressedOC.length, tokens: compressedTokensOC.total },
    claudeCode: { messages: compressedCC.length, tokens: compressedTokensCC.total },
    progressive: { messages: compressedPG.length, tokens: compressedTokensPG.total }
  };

  console.log(JSON.stringify(report, null, 2));
}

await run();
