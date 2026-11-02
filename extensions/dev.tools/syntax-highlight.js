const KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "from", "function",
  "if", "implements", "import", "in", "interface", "let", "new", "null", "of", "package", "private",
  "protected", "public", "return", "static", "super", "switch", "this", "throw", "true", "try", "type",
  "typeof", "undefined", "var", "void", "while", "with", "yield"
]);

const PYTHON_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else",
  "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "None",
  "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while", "with", "yield"
]);

const EXTENSION_LANGUAGES = new Map([
  ["cjs", "javascript"], ["css", "css"], ["go", "go"], ["html", "html"], ["htm", "html"],
  ["java", "java"], ["js", "javascript"], ["jsx", "javascript"], ["json", "json"], ["md", "markdown"],
  ["mjs", "javascript"], ["py", "python"], ["rs", "rust"], ["scss", "css"], ["sh", "shell"],
  ["tsx", "javascript"], ["ts", "javascript"], ["xml", "html"], ["yaml", "yaml"], ["yml", "yaml"]
]);

export function inferLanguageFromPath(path) {
  const ext = String(path || "").split(/[./\\]/).pop()?.toLowerCase() || "";
  return EXTENSION_LANGUAGES.get(ext) || "";
}

export function highlightLine(line, language) {
  const text = String(line ?? "");
  if (!text) return [{ text: " ", className: "" }];
  const lang = String(language || "").toLowerCase();
  if (lang === "json") return highlightJsonLine(text);
  if (lang === "html" || lang === "xml") return highlightHtmlLine(text);
  if (lang === "css") return highlightCssLine(text);
  return highlightGenericLine(text, lang);
}

function highlightGenericLine(text, lang) {
  const tokens = [];
  const keywordSet = lang === "python" ? PYTHON_KEYWORDS : KEYWORDS;
  let i = 0;

  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if ((lang !== "python" && two === "//") || (lang === "python" && text[i] === "#")) {
      push(tokens, text.slice(i), "tok-comment");
      break;
    }
    if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      const next = end >= 0 ? end + 2 : text.length;
      push(tokens, text.slice(i, next), "tok-comment");
      i = next;
      continue;
    }
    if (isQuote(text[i])) {
      const next = readString(text, i);
      push(tokens, text.slice(i, next), "tok-string");
      i = next;
      continue;
    }
    if (isNumberStart(text, i)) {
      const next = readNumber(text, i);
      push(tokens, text.slice(i, next), "tok-number");
      i = next;
      continue;
    }
    if (isIdentifierStart(text[i])) {
      const start = i;
      i += 1;
      while (i < text.length && isIdentifierPart(text[i])) i += 1;
      const word = text.slice(start, i);
      const after = skipSpaces(text, i);
      if (keywordSet.has(word)) {
        push(tokens, word, "tok-keyword");
      } else if (after < text.length && text[after] === "(") {
        push(tokens, word, "tok-function");
      } else if (/^[A-Z]/.test(word)) {
        push(tokens, word, "tok-type");
      } else {
        push(tokens, word, "");
      }
      continue;
    }
    push(tokens, text[i], "");
    i += 1;
  }

  return mergePlain(tokens);
}

function highlightJsonLine(text) {
  return tokenizeByRegex(text, /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, (match) => {
    if (match[1]) return match[2] ? "tok-property" : "tok-string";
    if (/^(true|false|null)$/i.test(match[0])) return "tok-keyword";
    return "tok-number";
  });
}

function highlightHtmlLine(text) {
  return tokenizeByRegex(text, /(<!--.*?-->)|(<\/?)([A-Za-z][\w:-]*)([^>]*)(\/?>)/g, (match, emit) => {
    if (match[1]) {
      emit(match[1], "tok-comment");
      return null;
    }
    emit(match[2], "tok-punctuation");
    emit(match[3], "tok-tag");
    emitAttributes(match[4], emit);
    emit(match[5], "tok-punctuation");
    return null;
  });
}

function highlightCssLine(text) {
  return tokenizeByRegex(text, /(\/\*.*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|#[0-9a-f]{3,8}\b|(@[\w-]+)|([\w-]+)(\s*:)|(-?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms)?)/gi, (match) => {
    if (match[1]) return "tok-comment";
    if (match[2]) return "tok-string";
    if (match[0].startsWith("#")) return "tok-number";
    if (match[3]) return "tok-keyword";
    if (match[4]) return "tok-property";
    if (match[6]) return "tok-number";
    return "";
  });
}

function tokenizeByRegex(text, regex, classify) {
  const tokens = [];
  let last = 0;
  for (const match of text.matchAll(regex)) {
    const index = match.index ?? 0;
    if (index > last) push(tokens, text.slice(last, index), "");
    const emitted = [];
    const cls = classify(match, (value, className) => {
      emitted.push({ text: value, className });
    });
    if (emitted.length) {
      for (const token of emitted) push(tokens, token.text, token.className);
    } else if (cls !== null) {
      push(tokens, match[0], cls || "");
    }
    last = index + match[0].length;
  }
  if (last < text.length) push(tokens, text.slice(last), "");
  return mergePlain(tokens);
}

function emitAttributes(text, emit) {
  let last = 0;
  const attrRegex = /([\w:-]+)(\s*=\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"'=<>`]+)?/g;
  for (const match of text.matchAll(attrRegex)) {
    const index = match.index ?? 0;
    if (index > last) emit(text.slice(last, index), "");
    emit(match[1], "tok-property");
    if (match[2]) emit(match[2], "");
    if (match[3]) emit(match[3], "tok-string");
    last = index + match[0].length;
  }
  if (last < text.length) emit(text.slice(last), "");
}

function readString(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  return text.length;
}

function readNumber(text, start) {
  let i = start;
  while (i < text.length && /[\w.+-]/.test(text[i])) i += 1;
  return i;
}

function isQuote(ch) {
  return ch === "\"" || ch === "'" || ch === "`";
}

function isNumberStart(text, index) {
  return /\d/.test(text[index]) && (index === 0 || !isIdentifierPart(text[index - 1]));
}

function isIdentifierStart(ch) {
  return /[A-Za-z_$]/.test(ch || "");
}

function isIdentifierPart(ch) {
  return /[A-Za-z0-9_$-]/.test(ch || "");
}

function skipSpaces(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

function push(tokens, text, className) {
  if (!text) return;
  tokens.push({ text, className });
}

function mergePlain(tokens) {
  const merged = [];
  for (const token of tokens) {
    const prev = merged[merged.length - 1];
    if (prev && prev.className === token.className) {
      prev.text += token.text;
    } else {
      merged.push({ ...token });
    }
  }
  return merged.length ? merged : [{ text: " ", className: "" }];
}
