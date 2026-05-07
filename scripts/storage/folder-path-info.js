import { normalizeFolderPath, normalizePathLower } from './path-utils.js';

export function resolveFolderPathFromRecord(item) {
  if (!item) return '';
  const filePath = String(item.file_path || '');
  const inferredFilename = filePath ? filePath.split('/').pop() : '';
  const filename = String(item.filename || inferredFilename || '');
  const rawPath = String(item.path || '');
  if (rawPath) {
    if (filename && rawPath.endsWith(`/${filename}`)) {
      return rawPath.slice(0, rawPath.length - (filename.length + 1));
    }
    return rawPath;
  }
  if (!filePath) return '';
  const lastSlash = filePath.lastIndexOf('/');
  return lastSlash >= 0 ? filePath.slice(0, lastSlash) : '';
}

export function getFolderPathInfo(item, { hydrate = false } = {}) {
  if (!item || typeof item !== 'object') return { normalized: '', lower: '' };
  if (!hydrate && typeof item._faFolderLower === 'string') {
    return {
      normalized: item._faFolderNormalized || '',
      lower: item._faFolderLower
    };
  }
  const normalized = normalizeFolderPath(typeof item.path === 'string' ? item.path : resolveFolderPathFromRecord(item));
  const lower = normalizePathLower(normalized);
  item._faFolderNormalized = normalized;
  item._faFolderLower = lower;
  return { normalized, lower };
}
