/**
 * Combine inherited Node heap/GC flags with catalog loopback network preload.
 * Outer CATALOG_BUILD_NODE_OPTIONS or NODE_OPTIONS heap flags are preserved.
 */
export function mergePreviewNodeOptions(preloadPath, extra = process.env.CATALOG_BUILD_NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? '') {
  const preload = `--require="${preloadPath.replace(/\\/g, '/')}"`;
  const parts = String(extra).trim().split(/\s+/).filter(Boolean);
  const withoutRequire = parts.filter((part) => !part.startsWith('--require='));
  return [...withoutRequire, preload].join(' ');
}
