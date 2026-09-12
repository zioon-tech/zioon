const MODULE_SPECIFIER_PATTERNS = [
  /\b(import\s+(?:[^'"]*?\s+from\s*)?["'])(\.{1,2}\/[^"']+)(["'])/gs,
  /\b(export\s+(?:[^'"]*?\s+from\s*)["'])(\.{1,2}\/[^"']+)(["'])/gs,
  /\b(import\s*\(\s*["'])(\.{1,2}\/[^"']+)(["']\s*\))/gs
];

export function normalizePluginModulePath(input: string): string {
  const parts: string[] = [];
  for (const part of String(input || '').replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error(`插件路径越界: ${input}`);
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function resolveModuleSpecifier(
  sources: Record<string, string>,
  importerPath: string,
  specifier: string
): string {
  const importerParts = normalizePluginModulePath(importerPath).split('/');
  importerParts.pop();
  const base = importerParts.length ? `${importerParts.join('/')}/` : '';
  const target = normalizePluginModulePath(`${base}${specifier}`);
  const candidates = [
    target,
    `${target}.js`,
    `${target}.mjs`,
    `${target}/index.js`,
    `${target}/index.mjs`
  ];
  const match = candidates.find((candidate) =>
    Object.prototype.hasOwnProperty.call(sources, candidate)
  );
  if (!match) {
    throw new Error(`未找到模块依赖: ${specifier} (from ${importerPath})`);
  }
  return match;
}

function replaceModuleSpecifiers(
  source: string,
  pattern: RegExp,
  resolveUrl: (specifier: string) => string
): string {
  return source.replace(pattern, (
    _full,
    before: string,
    specifier: string,
    after: string
  ) => `${before}${resolveUrl(specifier)}${after}`);
}

export function createPluginModuleBlobUrl({
  entryPath,
  sources,
  cache = new Map<string, string>(),
  stack = []
}: {
  entryPath: string;
  sources: Record<string, string>;
  cache?: Map<string, string>;
  stack?: string[];
}): string {
  const normalizedEntry = normalizePluginModulePath(entryPath);
  const cached = cache.get(normalizedEntry);
  if (cached) return cached;
  if (stack.includes(normalizedEntry)) {
    throw new Error(`插件模块存在循环依赖: ${[...stack, normalizedEntry].join(' -> ')}`);
  }

  const source = sources[normalizedEntry];
  if (typeof source !== 'string') {
    throw new Error(`未找到入口文件: ${normalizedEntry}`);
  }

  const nextStack = [...stack, normalizedEntry];
  const resolveUrl = (specifier: string) => {
    const dependencyPath = resolveModuleSpecifier(sources, normalizedEntry, specifier);
    return createPluginModuleBlobUrl({
      entryPath: dependencyPath,
      sources,
      cache,
      stack: nextStack
    });
  };
  let code = source;
  for (const pattern of MODULE_SPECIFIER_PATTERNS) {
    code = replaceModuleSpecifiers(code, pattern, resolveUrl);
  }

  const url = URL.createObjectURL(
    new Blob([code], { type: 'text/javascript' })
  );
  cache.set(normalizedEntry, url);
  return url;
}
