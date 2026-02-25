import { CompletionContext, CompletionResult } from "@codemirror/autocomplete";

// Regular expression to match words including Chinese characters
// \w matches [a-zA-Z0-9_], \u4e00-\u9fa5 matches common Chinese characters
const wordPattern = /[\u4e00-\u9fa5\w]+/g;

/**
 * A completion source that scans the document for words, supporting both English and Chinese.
 * It serves as a replacement for CodeMirror's native completeAnyWord which has limited CJK support.
 */
export function completeChineseAndWords(context: CompletionContext): CompletionResult | null {
  // Conflict resolution: Do not trigger if Slash Command Panel is visible
  const slashPanel = document.getElementById('zion-slash-panel');
  if (slashPanel && slashPanel.style.display !== 'none') {
    return null;
  }

  const { state, pos } = context;
  
  // Conflict resolution: Do not trigger if line starts with '/' (likely typing a command)
  const line = state.doc.lineAt(pos);
  const lineTextStart = line.text.trimStart();
  if (lineTextStart.startsWith("/")) {
    return null;
  }
  
  // 1. Check the text before cursor
  // We want to match any sequence of word characters or Chinese characters immediately before the cursor
  const range = context.matchBefore(/[\u4e00-\u9fa5\w]+/);
  
  // If no match or cursor is at the start of the match
  if (!range || range.from === pos) return null;

  const prefix = range.text;
  
  // 2. Trigger rules
  // For purely ASCII text, require at least 2 characters to avoid noise
  // For text containing Chinese, 1 character is enough to start suggesting
  const isASCII = /^[ -~]*$/.test(prefix); // Use printable ASCII range instead of control chars to avoid lint error
  if (!context.explicit && isASCII && prefix.length < 2) return null;
  
  // 3. Scan document for candidates
  // To maintain performance, we can limit the scanning range if necessary.
  // For now, let's scan the whole doc but we could optimize to a window around the cursor.
  const doc = state.doc;
  const options = new Set<string>();
  
  // Optimization: Scan a window around the cursor instead of the full document for very large files
  // For typical source files (< 10k lines), full scan is usually acceptable in UI thread
  // Let's implement a window of +/- 2000 lines to be safe
  const currentLine = doc.lineAt(pos).number;
  const scanWindow = 2000;
  const startLine = Math.max(1, currentLine - scanWindow);
  const endLine = Math.min(doc.lines, currentLine + scanWindow);

  for (let l = startLine; l <= endLine; l++) {
    const lineText = doc.line(l).text;
    
    // Scan for words in the line
    let match;
    // We use a regex with 'g' flag, so we must reset lastIndex if reusing it globally,
    // but here we are matching against a string. Wait, exec() with 'g' relies on lastIndex
    // if the regex object is reused. Let's create a new regex or reset it carefully.
    // The const 'wordPattern' is defined outside. We must reset it.
    wordPattern.lastIndex = 0;
    
    while ((match = wordPattern.exec(lineText)) !== null) {
      const word = match[0];
      
      // Candidate must:
      // 1. Start with the prefix
      // 2. Be longer than the prefix (don't suggest what's already fully typed)
      if (word.length > prefix.length && word.startsWith(prefix)) {
        options.add(word);
      }
    }
  }

  if (options.size === 0) return null;

  return {
    from: range.from,
    options: Array.from(options).map(word => ({
      label: word,
      type: "text",
      boost: -1 // Give these lower priority than keyword/syntax completions if any
    })),
    // The completion remains valid as long as the user types characters that match our word pattern
    validFor: /^[\u4e00-\u9fa5\w]*$/
  };
}
