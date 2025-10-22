/**
 * Normalize a folder path by converting backslashes to forward slashes,
 * collapsing duplicate separators, and trimming any leading or trailing slashes.
 * @param {string} value
 * @returns {string}
 */
export function normalizeFolderPath(value) {
  if (!value && value !== '') return '';
  const raw = String(value || '');
  return raw
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .trim();
}

/**
 * Build a reusable folder tree index from a collection of path counts.
 * Accepts Maps, arrays of tuples/objects, or plain objects keyed by path.
 * @param {Map<string, number>|Array|Object} pathCounts
 * @returns {{nodes:Array, pathSet:Set<string>, pathKeys:Array<string>, pathMap:Map<string,string>, totalCount:number}}
 */
export function createFolderTreeIndex(pathCounts, options = {}) {
  const version = Number.isFinite(options?.version) ? Number(options.version) : null;
  const rootMap = new Map();
  const pathSet = new Set();
  const pathMap = new Map();
  const pathKeys = [];
  let totalCount = 0;

  const addEntry = (path, count) => {
    const normalized = normalizeFolderPath(path);
    if (!normalized) return;
    const safeCount = Math.max(0, Number(count) || 0);
    if (!safeCount) return;

    const segments = normalized.split('/').filter(Boolean);
    if (!segments.length) return;
    totalCount += safeCount;

    let currentMap = rootMap;
    let fullPath = '';
    let fullLower = '';
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      fullPath = fullPath ? `${fullPath}/${seg}` : seg;
      fullLower = fullLower ? `${fullLower}/${seg.toLowerCase()}` : seg.toLowerCase();

      let node = currentMap.get(seg.toLowerCase());
      if (!node) {
        node = {
          name: seg,
          path: fullPath,
          pathLower: fullLower,
          count: 0,
          childMap: new Map()
        };
        currentMap.set(seg.toLowerCase(), node);
        pathMap.set(fullLower, fullPath);
      }

      node.count += safeCount;
      if (!pathSet.has(fullLower)) {
        pathSet.add(fullLower);
        pathKeys.push(fullLower);
      }

      if (i < segments.length - 1) currentMap = node.childMap;
    }
  };

  if (pathCounts instanceof Map) {
    for (const [path, count] of pathCounts.entries()) addEntry(path, count);
  } else if (Array.isArray(pathCounts)) {
    for (const record of pathCounts) {
      if (!record) continue;
      if (Array.isArray(record)) addEntry(record[0], record[1]);
      else if (typeof record === 'object') addEntry(record.path, record.count);
    }
  } else if (pathCounts && typeof pathCounts === 'object') {
    for (const [path, count] of Object.entries(pathCounts)) addEntry(path, count);
  }

  const convert = (map, level = 0) => {
    const entries = Array.from(map.values());
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return entries.map((node) => {
      const children = convert(node.childMap, level + 1);
      return {
        name: node.name,
        path: node.path,
        pathLower: node.pathLower,
        count: node.count,
        children,
        level
      };
    });
  };

  const nodes = convert(rootMap);
  return { nodes, pathSet, pathKeys, pathMap, totalCount, version };
}

/**
 * Produce a new empty tree index instance.
 * @returns {{nodes:Array, pathSet:Set<string>, pathKeys:Array<string>, pathMap:Map<string,string>, totalCount:number}}
 */
export function createEmptyFolderTreeIndex(version = 0) {
  return {
    nodes: [],
    pathSet: new Set(),
    pathKeys: [],
    pathMap: new Map(),
    totalCount: 0,
    version
  };
}

function deriveCollectionsFromNodes(nodes) {
  const pathSet = new Set();
  const pathMap = new Map();
  if (!Array.isArray(nodes)) return { pathSet, pathMap };
  const queue = nodes.slice();
  while (queue.length) {
    const node = queue.pop();
    if (!node) continue;
    const lower = typeof node.pathLower === 'string' ? node.pathLower.toLowerCase() : '';
    const path = typeof node.path === 'string' ? node.path : '';
    if (lower) {
      pathSet.add(lower);
      if (path) pathMap.set(lower, path);
    }
    if (Array.isArray(node.children) && node.children.length) {
      for (const child of node.children) queue.push(child);
    }
  }
  return { pathSet, pathMap };
}

function coercePathSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.map((entry) => String(entry || '').toLowerCase()).filter(Boolean));
  return new Set();
}

function coercePathMap(value) {
  if (value instanceof Map) return value;
  if (Array.isArray(value)) return new Map(value);
  if (value && typeof value === 'object') return new Map(Object.entries(value));
  return new Map();
}

function coerceTotalCount(value, fallback) {
  const num = Number(value);
  if (Number.isFinite(num) && num >= 0) return num;
  return Math.max(0, Number(fallback) || 0);
}

/**
 * Ensure the provided data resolves to a valid folder tree index.
 * @param {object} data
 * @returns {{nodes:Array, pathSet:Set<string>, pathKeys:Array<string>, pathMap:Map<string,string>, totalCount:number}}
 */
export function ensureFolderTreeIndex(data) {
  const candidate = data && typeof data === 'object' ? (data.tree || data) : null;
  if (candidate && typeof candidate === 'object' && Array.isArray(candidate.nodes)) {
    const nodes = candidate.nodes;
    const { pathSet: derivedSet, pathMap: derivedMap } = deriveCollectionsFromNodes(nodes);
    const pathSet = coercePathSet(candidate.pathSet ?? candidate.pathLookup ?? derivedSet);
    const pathMap = coercePathMap(candidate.pathMap ?? derivedMap);
    if (pathMap.size === 0 && derivedMap.size) {
      for (const [key, value] of derivedMap.entries()) pathMap.set(key, value);
    }
    const totalCount = coerceTotalCount(candidate.totalCount ?? candidate.total, 0);
    const pathKeys = Array.isArray(candidate.pathKeys)
      ? candidate.pathKeys.slice()
      : Array.from(pathSet.values());
    const version = Number.isFinite(candidate.version)
      ? Number(candidate.version)
      : Number.isFinite(data?.version)
        ? Number(data.version)
        : null;
    return {
      nodes,
      pathSet,
      pathKeys,
      pathMap,
      totalCount,
      version
    };
  }

  const source = data && typeof data === 'object' ? (data.pathCounts ?? data) : data;
  if (source == null) return createEmptyFolderTreeIndex(Number.isFinite(data?.version) ? Number(data.version) : 0);
  return createFolderTreeIndex(source, { version: Number.isFinite(data?.version) ? Number(data.version) : null });
}
