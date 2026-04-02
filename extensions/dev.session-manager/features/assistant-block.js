export function findAssistantBlockEndInText(text, hintPos) {
  const src = String(text || "").replace(/\r/g, "");
  const lines = src.split("\n");
  const len = src.length;
  const idxToPos = (lineIdx, ch) => {
    let pos = 0;
    for (let i = 0; i < lineIdx; i++) pos += lines[i].length + 1;
    return pos + ch;
  };

  const isRoleHead = (s) => /^(system|user|assistant|tool)\s+/.test(s);
  const lastAssistantIdx = (() => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*assistant\s+/.test(lines[i])) return i;
    }
    return -1;
  })();

  let headIdx = lastAssistantIdx;
  if (typeof hintPos === "number") {
    let acc = 0;
    let hintLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const next = acc + lines[i].length + 1;
      if (hintPos < next) { hintLine = i; break; }
      acc = next;
    }
    for (let i = hintLine; i >= 0; i--) {
      if (/^\s*assistant\s+/.test(lines[i])) { headIdx = i; break; }
    }
    if (headIdx < 0) headIdx = lastAssistantIdx;
  }
  if (headIdx < 0) return len;

  let endIdx = headIdx;
  for (let i = headIdx + 1; i < lines.length; i++) {
    if (isRoleHead(lines[i])) break;
    endIdx = i;
  }
  const endLine = endIdx;
  const endCh = lines[endLine].length;
  return idxToPos(endLine, endCh);
}

