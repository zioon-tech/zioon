const { CompressionEngine } = await import('../compression-core.js');
const { OpenCodeStrategy } = await import('../strategies/opencode.js');
const { ClaudeCodeStrategy } = await import('../strategies/claude-code.js');
const { TokenCounter } = await import('../token-counter.js');

function makeMsg(role, content) {
  return { role, content };
}

function makeTool(roleId, name, output, cached) {
  return { role: 'tool', tool_call_id: String(roleId), content: output, toolName: name, toolOutput: output, _cached: cached };
}

function makeAssistantTools(calls) {
  return { role: 'assistant', content: 'tools', tool_calls: calls.map((c) => ({ id: String(c.id), type: 'function', function: { name: c.name, arguments: '{}' } })) };
}

function scenarioToolHeavy() {
  const msgs = [];
  for (let i = 0; i < 20; i++) {
    msgs.push(makeMsg('user', `Request ${i}`));
    msgs.push(makeMsg('assistant', `Response ${i}`));
  }
  msgs.push(makeAssistantTools([{ id: 1, name: 'build' }, { id: 2, name: 'lint' }, { id: 3, name: 'deploy' }]));
  const big = 'A'.repeat(40000);
  msgs.push(makeTool(1, 'build', big, false));
  msgs.push(makeTool(2, 'lint', big, false));
  msgs.push(makeTool(3, 'deploy', big, false));
  return msgs;
}

function scenarioAssistantLongThink() {
  const msgs = [];
  msgs.push(makeMsg('system', 'You are helpful'));
  for (let i = 0; i < 30; i++) {
    msgs.push(makeMsg('user', `Task ${i}`));
    msgs.push({ role: 'assistant', content: 'R'.repeat(10000), reasoning: 'R'.repeat(8000) });
  }
  return msgs;
}

function scenarioUserLongContext() {
  const msgs = [];
  for (let i = 0; i < 25; i++) {
    msgs.push(makeMsg('user', 'U'.repeat(15000)));
    msgs.push(makeMsg('assistant', `Ack ${i}`));
  }
  return msgs;
}

async function bench(name, msgs, engine, counter) {
  const before = await counter.countConversationTokens(msgs, 'default');
  const autoCompressed = await engine.compress(msgs, 'auto');
  const after = await counter.countConversationTokens(autoCompressed, 'default');
  const stats = {
    scenario: name,
    messagesBefore: msgs.length,
    messagesAfter: autoCompressed.length,
    tokensBefore: before.total,
    tokensAfter: after.total
  };
  return stats;
}

async function run() {
  const engine = new CompressionEngine();
  engine.updateConfig({ maxTokens: 8000, outputTokens: 2000, charsPerToken: 4, threshold: 0.85 });
  const oc = new OpenCodeStrategy();
  oc.updateOptions({ pruneProtect: 6000, pruneMinimum: 800, protectedTools: [], threshold: 0.7, outputTokenMax: 2000 });
  const cc = new ClaudeCodeStrategy({ keepRecentMessages: 10, threshold: 0.85 });
  engine.registerStrategy('opencode', oc);
  engine.registerStrategy('claude-code', cc);
  const counter = new TokenCounter({ charsPerToken: 4 });

  const results = [];
  results.push(await bench('tool-heavy', scenarioToolHeavy(), engine, counter));
  results.push(await bench('assistant-long-think', scenarioAssistantLongThink(), engine, counter));
  results.push(await bench('user-long-context', scenarioUserLongContext(), engine, counter));

  console.log(JSON.stringify(results, null, 2));
}

await run();
