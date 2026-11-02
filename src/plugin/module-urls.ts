import { parse } from 'acorn';

export function pluginModuleSpecifiers(source: string): Array<{ specifier: string; start: number; end: number }> {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const found: Array<{ specifier: string; start: number; end: number }> = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression'].includes(node.type)
      && typeof node.source?.value === 'string' && /^\.\.?\//.test(node.source.value)) {
      found.push({ specifier: node.source.value, start: node.source.start, end: node.source.end });
    }
    for (const [key, child] of Object.entries(node)) {
      if (['type', 'start', 'end'].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === 'object') walk(child);
    }
  };
  walk(tree);
  return found;
}

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
  for (const item of pluginModuleSpecifiers(source).sort((a, b) => b.start - a.start)) {
    code = code.slice(0, item.start) + JSON.stringify(resolveUrl(item.specifier)) + code.slice(item.end);
  }

  const url = URL.createObjectURL(
    new Blob([code], { type: 'text/javascript' })
  );
  cache.set(normalizedEntry, url);
  return url;
}
