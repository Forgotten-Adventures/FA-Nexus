import { NexusLogger as Logger } from '../../core/nexus-logger.js';

const windowsDrivePattern = /^[A-Za-z]:$/;

export function normalizeContentSourcePath(path) {
  if (!path) return '';
  let str = String(path).trim();
  let prefix = '';
  const schemeMatch = str.match(/^([^:]+:)/);
  if (schemeMatch) {
    prefix = schemeMatch[1];
    str = str.slice(prefix.length);
  }
  const isWindowsDrive = windowsDrivePattern.test(prefix);
  if (isWindowsDrive) prefix = prefix.toLowerCase();
  let normalized = str.replace(/\\/g, '/');
  if (isWindowsDrive) normalized = normalized.toLowerCase();
  if (normalized.length > 1) normalized = normalized.replace(/\/\/+$/, '');
  return `${prefix}${normalized}`;
}

export function contentSourceKey(path) {
  try {
    return encodeURIComponent(normalizeContentSourcePath(path));
  } catch (error) {
    try { Logger.warn?.('ContentSources.key:normalize-failed', { path, error }); }
    catch (_) {}
    return encodeURIComponent(String(path || ''));
  }
}

export function normalizeContentSourceEntry(entry, { normalizePath = normalizeContentSourcePath } = {}) {
  const rawPath = entry?.path ?? '';
  const path = normalizePath(rawPath) || String(rawPath || '').trim();
  const fallbackLabel = path?.split('/')?.pop?.() || path || rawPath || '';
  const customLabel = entry?.customLabel ? String(entry.customLabel).trim() : null;
  return {
    path,
    label: entry?.label ? String(entry.label).trim() : fallbackLabel,
    enabled: entry?.enabled === undefined ? true : !!entry.enabled,
    customLabel
  };
}

export function parseContentSourcesSetting(value, { normalizePath = normalizeContentSourcePath } = {}) {
  if (value == null || value === '') return [];
  let data = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      data = JSON.parse(trimmed);
    } catch (error) {
      const wrapped = new Error('Failed to parse content sources settings JSON');
      wrapped.cause = error;
      throw wrapped;
    }
  }
  if (!Array.isArray(data)) {
    throw new Error('Content sources settings are not an array');
  }
  return data.map((entry) => normalizeContentSourceEntry(entry, { normalizePath }));
}

export function serializeContentSourcesSetting(folders, { normalizePath = normalizeContentSourcePath } = {}) {
  if (!Array.isArray(folders) || !folders.length) return '[]';
  const payload = folders.map((folder) => {
    const entry = normalizeContentSourceEntry(folder, { normalizePath });
    return {
      path: entry.path,
      label: entry.label,
      enabled: entry.enabled,
      customLabel: entry.customLabel
    };
  });
  return JSON.stringify(payload);
}
