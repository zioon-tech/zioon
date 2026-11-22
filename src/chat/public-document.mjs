/** Recorded content only: never carry session configuration into a shared reader. */
export function publicDocumentAnchors(markdown) {
  const anchors = [];
  let from = 0, fence = null, assistantBlockId = null;
  for (const text of String(markdown || "").split("\n")) {
    const opening = /^(?:assistant\s+(?:<!--\s*zion-assistant:id=[^>]+-->\s*)?)?\s*(`{3,}|~{3,})/.exec(text);
    if (fence) {
      if (new RegExp(`^\\s*${fence.char}{${fence.length},}\\s*$`).test(text)) fence = null;
    } else if (opening) {
      fence = { char: opening[1][0], length: opening[1].length };
    } else {
      if (/^(user|system|tool)\s/.test(text)) assistantBlockId = null;
      if (/^assistant\s/.test(text)) assistantBlockId = /^assistant\s+<!--\s*zion-assistant:id=([^>\s]+)\s*-->/.exec(text)?.[1] || null;
      const thinking = /^\s*思考(?:\s*<!--\s*zion-thinking:id=([^>\s]+)\s*-->)?\s*$/.exec(text);
      const tool = /^\s*调用\s+([^\n<]{1,300}?)(?:\s*<!--\s*zion-tool:id=([^>\s]+)\s*-->)?\s*$/.exec(text);
      if (thinking || tool) anchors.push({ kind: thinking ? "thinking" : "tools",
        id: (thinking ? thinking[1] : tool[2]) || null, name: tool?.[1]?.trim() || "",
        from, to: from + text.length, assistantBlockId });
    }
    from += text.length + 1;
  }
  return anchors;
}

export function projectPublicCards(markdown, annotations) {
  const projected = { tools: [], thinking: [] };
  const seen = new Set();
  const byId = {}, byRange = {};
  for (const kind of ["tools", "thinking"]) {
    const list = Array.isArray(annotations?.[kind]) ? annotations[kind] : [];
    byId[kind] = new Map(list.filter(item => item && typeof item.id === "string").map(item => [item.id, item]));
    byRange[kind] = new Map(list.filter(item => item && typeof item.id === "string")
      .map(item => [`${item.from}:${item.to}`, item]));
  }
  for (const anchor of publicDocumentAnchors(markdown)) {
    const item = anchor.id ? byId[anchor.kind].get(anchor.id) : byRange[anchor.kind].get(`${anchor.from}:${anchor.to}`);
    if (!item || seen.has(`${anchor.kind}:${item.id}`)) continue;
    if (item.assistantBlockId && item.assistantBlockId !== anchor.assistantBlockId) continue;
    seen.add(`${anchor.kind}:${item.id}`);
    if (anchor.kind === "thinking") {
      projected.thinking.push({ id: item.id, from: anchor.from, to: anchor.to,
        text: typeof item.text === "string" ? item.text : "" });
    } else {
      projected.tools.push({ id: item.id, from: anchor.from, to: anchor.to, name: anchor.name,
        args: item.args ?? null, result: item.result ?? null,
        ok: typeof item.ok === "boolean" ? item.ok : null,
        action: ["accept", "revert"].includes(item.action) ? item.action : null });
    }
  }
  return projected;
}
