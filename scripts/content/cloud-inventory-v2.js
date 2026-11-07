const PX_PER_ASSET_GRID = 200;
const PX_PER_TOKEN_GRID = 400;
const PX_PER_GARGANTUAN_TOKEN_GRID = 200;
const MAX_GRID_SIZE = 100;

function asString(value) {
  return String(value ?? '').trim();
}

function withoutExt(value = '') {
  return asString(value).replace(/\.[^/.]+$/, '');
}

function dirnamePosix(value = '') {
  const raw = asString(value).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  const index = raw.lastIndexOf('/');
  return index >= 0 ? raw.slice(0, index) : '';
}

function basenamePosix(value = '') {
  const raw = asString(value).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  const index = raw.lastIndexOf('/');
  return index >= 0 ? raw.slice(index + 1) : raw;
}

function normalizeExt(value, fallback = '.webp') {
  const raw = asString(value || fallback).toLowerCase();
  return raw.startsWith('.') ? raw : `.${raw}`;
}

function clampGrid(value) {
  return Math.max(1, Math.min(MAX_GRID_SIZE, Math.round(Number(value) || 1)));
}

function normalizeGrid(value, context) {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`Invalid v2 grid for ${context}.`);
  }
  return [clampGrid(value[0]), clampGrid(value[1])];
}

function normalizeKind(kind) {
  const value = asString(kind);
  if (value === 'tokens' || value === 'token') return 'token';
  if (value === 'assets' || value === 'asset') return 'asset';
  throw new Error(`Unknown v2 inventory kind: ${value || '<empty>'}.`);
}

function normalizeSource(source = 'cloud') {
  const value = asString(source).toLowerCase();
  return value === 'local' ? 'local' : 'cloud';
}

function mimeFromExt(ext = '') {
  const raw = asString(ext).toLowerCase();
  const lower = raw.startsWith('.') ? raw : (raw.match(/\.[^/.?#]+(?=$|[?#])/)?.[0] || `.${raw}`);
  if (lower === '.webp') return 'image/webp';
  if (lower === '.png') return 'image/png';
  if (lower === '.jpg' || lower === '.jpeg') return 'image/jpeg';
  if (lower === '.webm') return 'video/webm';
  if (lower === '.mp4') return 'video/mp4';
  return 'application/octet-stream';
}

function normalizeSelectedSource(record, context) {
  if (record?.selected_source && typeof record.selected_source === 'object') {
    const selected = record.selected_source;
    const ext = normalizeExt(selected.ext || selected.format || '.webp');
    return {
      format: asString(selected.format || ext.replace(/^\./, '') || 'webp').toLowerCase(),
      ext,
      size: Math.max(0, Number(selected.size) || 0),
      mtime: asString(selected.mtime || record.updated)
    };
  }

  const webp = record?.sources?.webp;
  if (!webp || typeof webp !== 'object') {
    throw new Error(`Missing sources.webp entry for ${context}.`);
  }
  const ext = normalizeExt(webp.ext || '.webp');
  return {
    format: ext.replace(/^\./, '') || 'webp',
    ext,
    size: Math.max(0, Number(webp.size) || 0),
    mtime: asString(webp.mtime || record.updated)
  };
}

function normalizeAssetClass(record) {
  const value = asString(record.asset_class || record.type || '').toLowerCase();
  if (value === 'path' || value === 'texture' || value === 'asset') return value;
  return 'asset';
}

function normalizeTags(tags) {
  return Array.isArray(tags) ? tags.map((tag) => asString(tag)).filter(Boolean) : [];
}

function normalizeCloudPath(record, context) {
  const id = withoutExt(record?.id || record?.path || record?.file_path || '');
  if (!id) throw new Error(`Missing v2 path for ${context}.`);
  return id.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
}

export function isCloudManifestV2Payload(payload, plan = null) {
  if (Number(plan?.schema_version) === 2 || Number(plan?.schemaVersion) === 2) return true;
  const url = asString(plan?.full?.url || plan?.full?.key || '');
  if (url.includes('/manifests_v2/') || url.includes('manifests_v2/')) return true;
  const first = Array.isArray(payload) ? payload[0] : null;
  return !!(first && typeof first === 'object' && first.kind && first.path && first.sources && !first.file_path);
}

export function toInventoryV2Item(kind, record, source = 'cloud') {
  if (!record || typeof record !== 'object') {
    throw new Error(`Invalid ${kind} v2 inventory record.`);
  }
  const expectedKind = normalizeKind(kind);
  const actualKind = normalizeKind(record.kind || expectedKind);
  if (actualKind !== expectedKind) {
    throw new Error(`Mismatched v2 inventory kind for ${record.path || record.id || '<unknown>'}: expected ${expectedKind}, got ${actualKind}.`);
  }

  const id = normalizeCloudPath(record, expectedKind);
  const context = `${expectedKind}:${id}`;
  const selected = normalizeSelectedSource(record, context);
  const grid = normalizeGrid(record.grid, context);
  const item = {
    schema_version: 2,
    id,
    source: normalizeSource(source),
    kind: expectedKind,
    folder: asString(record.folder || dirnamePosix(id)),
    name: asString(record.name || record.display_name || basenamePosix(id).replace(/_/g, ' ')),
    tier: record.tier === 'premium' ? 'premium' : 'free',
    grid,
    updated: asString(record.updated || selected.mtime),
    tags: normalizeTags(record.tags),
    selected_source: selected
  };

  if (expectedKind === 'asset') {
    item.asset_class = normalizeAssetClass(record);
  } else {
    item.size = asString(record.size || 'Medium');
    item.creature_type = asString(record.creature_type || 'Humanoid');
    item.variant = asString(record.variant);
    item.scale = Number.isFinite(Number(record.scale)) ? Number(record.scale) : 1;
    item.color = record.color && typeof record.color === 'object'
      ? {
          variant: record.color.variant ?? null,
          main: !!record.color.main,
          group: asString(record.color.group || basenamePosix(id))
        }
      : { variant: null, main: false, group: basenamePosix(id) };
  }

  return item;
}

export function toInventoryV2Items(kind, records, source = 'cloud') {
  if (!Array.isArray(records)) throw new Error(`Expected ${kind} v2 inventory array.`);
  return records.map((record) => toInventoryV2Item(kind, record, source));
}

export function contentPath(item) {
  if (!item) return '';
  const id = asString(item.id || item.file_path || item.path || item.filename);
  if (!id) return '';
  const ext = asString(item.selected_source?.ext || '').toLowerCase();
  if (ext && !id.toLowerCase().endsWith(ext)) return `${id}${ext}`;
  return id;
}

export function contentFilename(item) {
  return basenamePosix(contentPath(item));
}

export function contentFolder(item) {
  return asString(item?.folder || dirnamePosix(contentPath(item)));
}

export function contentType(item) {
  return mimeFromExt(item?.selected_source?.ext || contentPath(item));
}

export function contentGrid(item) {
  const grid = Array.isArray(item?.grid) ? item.grid : [item?.grid_width, item?.grid_height];
  return [Math.max(0.01, Number(grid[0]) || 1), Math.max(0.01, Number(grid[1]) || 1)];
}

export function contentDimensions(item) {
  const [gridWidth, gridHeight] = contentGrid(item);
  const kind = normalizeKind(item?.kind || item?.type || 'asset');
  if (kind === 'token') {
    const scale = Number.isFinite(Number(item?.scale)) ? Number(item.scale) : 1;
    const isGargantuan = asString(item?.size).toLowerCase() === 'gargantuan';
    const base = isGargantuan ? PX_PER_GARGANTUAN_TOKEN_GRID : PX_PER_TOKEN_GRID;
    return {
      width: Math.round(gridWidth * base * scale),
      height: Math.round(gridHeight * base * scale),
      gridWidth,
      gridHeight,
      scale
    };
  }
  return {
    width: Math.round(gridWidth * PX_PER_ASSET_GRID),
    height: Math.round(gridHeight * PX_PER_ASSET_GRID),
    gridWidth,
    gridHeight,
    scale: 1
  };
}

export function inventoryItemKey(item) {
  return asString(item?.id || withoutExt(contentPath(item)));
}
