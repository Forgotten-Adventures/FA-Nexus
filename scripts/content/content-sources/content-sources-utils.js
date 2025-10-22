import { NexusLogger as Logger } from '../../core/nexus-logger.js';

const identityPath = (value) => {
  if (value == null) return '';
  const str = String(value);
  return str;
};

const defaultLogger = {
  debug: (...args) => {
    try { Logger?.debug?.(...args); }
    catch (_) {}
  }
};

export function cloneFolderSelection(selection) {
  if (!selection) return null;
  try {
    if (typeof foundry !== 'undefined' && foundry?.utils?.duplicate) {
      return foundry.utils.duplicate(selection);
    }
  } catch (_) {}
  if (typeof structuredClone === 'function') {
    try { return structuredClone(selection); }
    catch (_) { /* ignore */ }
  }
  try { return JSON.parse(JSON.stringify(selection)); }
  catch (_) {}
  if (Array.isArray(selection)) return selection.slice();
  if (typeof selection === 'object') return { ...selection };
  return selection;
}

export function summarizeFolderSelection(selection) {
  if (!selection) return null;
  const snapshot = (arr) => (Array.isArray(arr) ? arr.slice() : undefined);
  return {
    type: selection.type || 'all',
    includePaths: snapshot(selection.includePaths),
    includePathLowers: snapshot(selection.includePathLowers),
    paths: snapshot(selection.paths),
    pathLowers: snapshot(selection.pathLowers),
    excludePaths: snapshot(selection.excludePaths),
    excludePathLowers: snapshot(selection.excludePathLowers)
  };
}

const normalizeExcludeFilters = (selection, { normalizePath = identityPath, availableLowers = null } = {}) => {
  const map = new Map();
  const addPath = (raw) => {
    const path = normalizePath(raw);
    if (!path) return;
    const lower = path.toLowerCase();
    if (!lower) return;
    if (availableLowers && availableLowers.size && !availableLowers.has(lower)) {
      let exists = false;
      for (const key of availableLowers) {
        if (key.startsWith(`${lower}/`)) { exists = true; break; }
      }
      if (!exists) return;
    }
    if (!map.has(lower)) map.set(lower, path);
  };
  const addLower = (raw) => {
    const lower = String(raw || '').toLowerCase();
    if (!lower) return;
    if (map.has(lower)) return;
    if (availableLowers && availableLowers.size && !availableLowers.has(lower)) {
      let exists = false;
      for (const key of availableLowers) {
        if (key.startsWith(`${lower}/`)) { exists = true; break; }
      }
      if (!exists) return;
    }
    const canonical = normalizePath(lower) || lower;
    const canonicalLower = canonical.toLowerCase();
    if (!map.has(canonicalLower)) map.set(canonicalLower, canonical);
  };

  if (Array.isArray(selection?.excludePaths)) {
    for (const value of selection.excludePaths) addPath(value);
  }
  if (Array.isArray(selection?.excludePathLowers)) {
    for (const value of selection.excludePathLowers) addLower(value);
  }

  if (!map.size) return { excludePaths: undefined, excludePathLowers: undefined };
  return {
    excludePaths: Array.from(map.values()),
    excludePathLowers: Array.from(map.keys())
  };
};

const uniqueNormalizedPaths = (values, normalizePath) => {
  const normalizedPaths = [];
  const normalizedLowers = [];
  const seen = new Set();
  for (const raw of values) {
    const path = normalizePath(raw);
    if (!path) continue;
    const lower = path.toLowerCase();
    if (!lower || seen.has(lower)) continue;
    seen.add(lower);
    normalizedPaths.push(path);
    normalizedLowers.push(lower);
  }
  return { paths: normalizedPaths, lowers: normalizedLowers };
};

export function normalizeFolderSelection(selection, { normalizePath = identityPath, supportsUnassigned = false } = {}) {
  const input = (selection && typeof selection === 'object') ? selection : {};
  const normalize = (value) => {
    const normalized = normalizePath(value);
    if (!normalized) return '';
    return normalized
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .trim();
  };

  const type = String(input.type || '').toLowerCase();
  let normalized;

  if (type === 'folder') {
    const path = normalize(input.path || input.includePaths?.[0] || input.paths?.[0]);
    if (path) {
      const lower = path.toLowerCase();
      normalized = {
        type: 'folder',
        path,
        pathLower: lower,
        includePaths: [path],
        includePathLowers: [lower]
      };
    }
  } else if (type === 'folders' || type === 'multi' || type === 'multifolder') {
    const incoming = Array.isArray(input.paths) ? input.paths
      : Array.isArray(input.includePaths) ? input.includePaths : [];
    const lowers = Array.isArray(input.pathLowers) ? input.pathLowers
      : Array.isArray(input.includePathLowers) ? input.includePathLowers : [];
    const { paths: nextPaths, lowers: nextLowers } = uniqueNormalizedPaths(incoming, normalize);
    if (!nextPaths.length && lowers.length) {
      const byLower = uniqueNormalizedPaths(lowers, (value) => {
        const lower = String(value || '').toLowerCase();
        return lower;
      });
      nextPaths.push(...byLower.paths);
      nextLowers.push(...byLower.lowers);
    }
    if (nextPaths.length === 1) {
      const path = nextPaths[0];
      const lower = path.toLowerCase();
      normalized = {
        type: 'folder',
        path,
        pathLower: lower,
        includePaths: [path],
        includePathLowers: [lower]
      };
    } else if (nextPaths.length > 1) {
      normalized = {
        type: 'folders',
        paths: nextPaths,
        pathLowers: nextLowers,
        includePaths: nextPaths.slice(),
        includePathLowers: nextLowers.slice()
      };
    }
  } else if (supportsUnassigned && type === 'unassigned') {
    normalized = { type: 'unassigned', includePaths: [], includePathLowers: [] };
  }

  if (!normalized) {
    normalized = { type: 'all', includePaths: [], includePathLowers: [] };
  }

  if (normalized.type === 'folder') {
    normalized.includePaths = [normalized.path];
    normalized.includePathLowers = [normalized.pathLower];
  } else if (normalized.type !== 'folders') {
    normalized.includePaths = [];
    normalized.includePathLowers = [];
  } else {
    normalized.includePaths = Array.isArray(normalized.includePaths) ? normalized.includePaths.slice() : [];
    normalized.includePathLowers = Array.isArray(normalized.includePathLowers) ? normalized.includePathLowers.slice() : [];
  }

  const excludes = normalizeExcludeFilters(input, { normalizePath: normalize });
  if (excludes.excludePaths) normalized.excludePaths = excludes.excludePaths;
  if (excludes.excludePathLowers) normalized.excludePathLowers = excludes.excludePathLowers;

  return normalized;
}

const hasAvailableLower = (lower, availableLowers) => {
  if (!lower) return false;
  if (!availableLowers || !availableLowers.size) return true;
  if (availableLowers.has(lower)) return true;
  for (const key of availableLowers) {
    if (key.startsWith(`${lower}/`)) return true;
  }
  return false;
};

const cloneSelectionArrays = (selection) => {
  const clone = { ...selection };
  if (Array.isArray(selection.includePaths)) clone.includePaths = selection.includePaths.slice();
  if (Array.isArray(selection.includePathLowers)) clone.includePathLowers = selection.includePathLowers.slice();
  if (Array.isArray(selection.paths)) clone.paths = selection.paths.slice();
  if (Array.isArray(selection.pathLowers)) clone.pathLowers = selection.pathLowers.slice();
  if (Array.isArray(selection.excludePaths)) clone.excludePaths = selection.excludePaths.slice();
  if (Array.isArray(selection.excludePathLowers)) clone.excludePathLowers = selection.excludePathLowers.slice();
  return clone;
};

export function enforceFolderSelectionAvailability(selection, {
  availableLowers = null,
  supportsUnassigned = false,
  normalizePath = identityPath
} = {}) {
  if (!selection) return normalizeFolderSelection(selection, { normalizePath, supportsUnassigned });
  const normalized = cloneSelectionArrays(selection);
  if (!availableLowers || !availableLowers.size) return normalized;

  if (normalized.type === 'folder') {
    const target = String(normalized.pathLower || normalized.path || '').toLowerCase();
    if (!hasAvailableLower(target, availableLowers)) {
      return { type: 'all', includePaths: [], includePathLowers: [] };
    }
  } else if (normalized.type === 'folders') {
    const paths = Array.isArray(normalized.paths) ? normalized.paths : [];
    const lowers = Array.isArray(normalized.pathLowers) ? normalized.pathLowers : [];
    const nextPaths = [];
    const nextLowers = [];
    const count = Math.max(paths.length, lowers.length);
    for (let i = 0; i < count; i += 1) {
      const path = normalizePath(paths[i]);
      const lower = String(lowers[i] || path || '').toLowerCase();
      if (!lower || !hasAvailableLower(lower, availableLowers)) continue;
      if (nextLowers.includes(lower)) continue;
      const canonicalPath = path || lower;
      nextPaths.push(canonicalPath);
      nextLowers.push(lower);
    }
    if (!nextPaths.length) {
      return { type: 'all', includePaths: [], includePathLowers: [] };
    }
    if (nextPaths.length === 1) {
      const folderPath = nextPaths[0];
      const lower = folderPath.toLowerCase();
      return {
        type: 'folder',
        path: folderPath,
        pathLower: lower,
        includePaths: [folderPath],
        includePathLowers: [lower]
      };
    }
    normalized.paths = nextPaths;
    normalized.pathLowers = nextLowers;
    normalized.includePaths = nextPaths.slice();
    normalized.includePathLowers = nextLowers.slice();
  } else if (normalized.type === 'unassigned' && !supportsUnassigned) {
    return { type: 'all', includePaths: [], includePathLowers: [] };
  }

  if (Array.isArray(normalized.excludePathLowers) || Array.isArray(normalized.excludePaths)) {
    const excludes = normalizeExcludeFilters(normalized, { normalizePath, availableLowers });
    if (excludes.excludePaths) normalized.excludePaths = excludes.excludePaths;
    else delete normalized.excludePaths;
    if (excludes.excludePathLowers) normalized.excludePathLowers = excludes.excludePathLowers;
    else delete normalized.excludePathLowers;
  }

  return normalized;
}

export function mergeFolderSelectionExcludes({
  selection,
  previousSelection,
  normalizePath = identityPath,
  availableLowers = null
} = {}) {
  if (!selection) return selection;
  const map = new Map();
  const addFromSelection = (source) => {
    if (!source) return;
    if (Array.isArray(source.excludePaths)) {
      for (const value of source.excludePaths) {
        const path = normalizePath(value);
        if (!path) continue;
        const lower = path.toLowerCase();
        if (!lower) continue;
        if (!map.has(lower)) map.set(lower, path);
      }
    }
    if (Array.isArray(source.excludePathLowers)) {
      for (const value of source.excludePathLowers) {
        const lower = String(value || '').toLowerCase();
        if (!lower || map.has(lower)) continue;
        const canonical = normalizePath(lower) || lower;
        map.set(lower, canonical);
      }
    }
  };

  addFromSelection(selection);
  addFromSelection(previousSelection);

  if (!map.size) {
    const cleaned = cloneSelectionArrays(selection);
    delete cleaned.excludePaths;
    delete cleaned.excludePathLowers;
    return cleaned;
  }

  if (availableLowers && availableLowers.size) {
    for (const [lower] of map) {
      if (hasAvailableLower(lower, availableLowers)) continue;
      map.delete(lower);
    }
  }

  const cleaned = cloneSelectionArrays(selection);
  cleaned.excludePathLowers = Array.from(map.keys());
  cleaned.excludePaths = Array.from(map.values());
  return cleaned;
}

export function folderSelectionKey(selection) {
  if (!selection || typeof selection !== 'object') return 'all';
  const type = String(selection.type || 'all').toLowerCase();
  let base;
  if (type === 'folder') {
    const lower = String(selection.pathLower || selection.path || '').toLowerCase();
    base = `folder:${lower}`;
  } else if (type === 'folders') {
    const lowers = Array.isArray(selection.pathLowers) ? selection.pathLowers
      : Array.isArray(selection.includePathLowers) ? selection.includePathLowers
      : Array.isArray(selection.paths) ? selection.paths.map((p) => String(p || '').toLowerCase()) : [];
    const unique = Array.from(new Set(lowers.map((p) => String(p || '').toLowerCase())));
    unique.sort();
    base = `folders:${unique.join('|')}`;
  } else if (type === 'unassigned') {
    base = 'unassigned';
  } else {
    base = 'all';
  }

  const excludes = Array.isArray(selection.excludePathLowers) && selection.excludePathLowers.length
    ? selection.excludePathLowers
    : Array.isArray(selection.excludePaths) ? selection.excludePaths.map((p) => String(p || '').toLowerCase()) : [];
  if (excludes && excludes.length) {
    const normalized = Array.from(new Set(excludes.map((p) => String(p || '').toLowerCase())));
    normalized.sort();
    if (normalized.length) base = `${base}|exclude:${normalized.join('|')}`;
  }

  return base;
}

export function logFolderSelection(label, selection, { logger = defaultLogger } = {}) {
  try {
    logger.debug(label, { selection: summarizeFolderSelection(selection) });
  } catch (_) {}
}
