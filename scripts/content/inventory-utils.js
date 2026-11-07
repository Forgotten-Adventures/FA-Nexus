/**
 * Shared inventory utilities (used by Tokens now, Assets later)
 * Provides filename parsing and local→inventory record mapping
 */

/**
 * @typedef {import('../core/fa-nexus-types.js').FaNexusAssetInventoryRecord} FaNexusAssetInventoryRecord
 * @typedef {import('../core/fa-nexus-types.js').FaNexusInventoryRecord} FaNexusInventoryRecord
 * @typedef {import('../core/fa-nexus-types.js').FaNexusTokenInventoryRecord} FaNexusTokenInventoryRecord
 * @typedef {import('../core/fa-nexus-types.js').FaNexusTokenSize} FaNexusTokenSize
 */

const TOKEN_SIZE_OPTIONS = ['Tiny','Small','Medium','Large','Huge','Gargantuan'];
const TOKEN_CREATURE_TYPES = [
  'Aberration','Beast','Celestial','Construct','Dragon','Elemental','Fey','Fiend','Giant',
  'Humanoid','Monstrosity','Ooze','Plant','Undead','Human','Elf','Dwarf','Halfling',
  'Dragonborn','Tiefling','Orc','Goblin','Kobold','Gnoll','Hobgoblin'
];

function normalizeLocalPath(path = '') {
  return String(path || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
}

function dirnamePosix(value = '') {
  const normalized = normalizeLocalPath(value);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '';
}

function extname(value = '') {
  const match = String(value || '').match(/(\.[^/.]+)$/);
  return match ? match[1].toLowerCase() : '';
}

function sourceForFilename(filename = '') {
  const ext = extname(filename) || '.webp';
  return {
    format: ext.replace(/^\./, '') || 'webp',
    ext,
    size: 0,
    mtime: new Date().toISOString()
  };
}

/**
 * Parse grid size and scale from a token filename.
 * Supports size keywords (Gargantuan/Huge/Large) and `scaleNN` suffix.
 * @param {string} [filename]
 * @returns {FaNexusTokenSize}
 */
function parseTokenSize(filename = '') {
  const name = String(filename || '').toLowerCase();
  let gridWidth = 1, gridHeight = 1, scale = 1;
  const MAX_GRID_SIZE = 100;
  const MAX_SCALE = 3;

  if (name.includes('gargantuan')) {
    const m = name.match(/(\d+)x(\d+)/);
    if (m) {
      const w = parseInt(m[1], 10);
      const h = parseInt(m[2], 10);
      gridWidth = Math.max(1, Math.min(MAX_GRID_SIZE, w));
      gridHeight = Math.max(1, Math.min(MAX_GRID_SIZE, h));
    } else {
      gridWidth = gridHeight = 4;
    }
  } else if (name.includes('huge')) {
    gridWidth = gridHeight = 3;
  } else if (name.includes('large')) {
    gridWidth = gridHeight = 2;
  } else {
    gridWidth = gridHeight = 1;
  }

  const sm = name.match(/scale(\d+)/i);
  if (sm) {
    const raw = parseInt(sm[1], 10) / 100;
    scale = Math.max(0.1, Math.min(MAX_SCALE, raw));
  }

  return { gridWidth, gridHeight, scale };
}

function matchTokenSizePart(part = '') {
  return TOKEN_SIZE_OPTIONS.find((s) => s.toLowerCase() === String(part || '').toLowerCase()) || '';
}

function matchTokenCreatureTypePart(part = '') {
  return TOKEN_CREATURE_TYPES.find((c) => c.toLowerCase() === String(part || '').toLowerCase()) || '';
}

function isTokenVariantPart(part = '') {
  return /^[A-Z]\d+$/i.test(part)
    || /^[A-Z]{2}\d+$/i.test(part)
    || /^[A-Z]\d{2,}$/i.test(part)
    || /^\d{3}[A-Z]$/i.test(part);
}

function isGridDimensionPart(part = '') {
  return /^\d+x\d+$/i.test(String(part || ''));
}

function findImplicitTokenMetadataIndex(parts = []) {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!matchTokenSizePart(parts[i])) continue;
    const suffix = parts.slice(i + 1);
    const hasCreatureType = suffix.some((p) => !!matchTokenCreatureTypePart(p));
    const hasGridDimensions = suffix.some((p) => isGridDimensionPart(p));
    if (hasCreatureType || hasGridDimensions) return i;
  }
  return -1;
}

function parseTokenMetadataParts(parts = []) {
  let size = '';
  let creatureType = '';
  for (const p of parts) {
    const matchSize = matchTokenSizePart(p);
    if (matchSize) {
      size = matchSize;
      continue;
    }
    const matchCt = matchTokenCreatureTypePart(p);
    if (matchCt) creatureType = matchCt;
  }
  return { size, creatureType };
}

function getCreatureSizeFromGridDimensions(gridWidth, gridHeight) {
  const width = Number(gridWidth);
  const height = Number(gridHeight);
  const maxDimension = Math.max(
    Number.isFinite(width) ? width : 1,
    Number.isFinite(height) ? height : 1
  );
  if (maxDimension >= 4) return 'Gargantuan';
  if (maxDimension >= 3) return 'Huge';
  if (maxDimension >= 2) return 'Large';
  return 'Medium';
}

/**
 * Detect trailing `_NN` color variant token
 * @param {string} [filename]
 * @returns {{baseNameWithoutVariant:string,colorVariant:string|null,isMainColorVariant:boolean,hasColorVariant:boolean}}
 */
function detectColorVariant(filename = '') {
  const noExt = String(filename || '').replace(/\.[^/.]+$/, '');
  const m = noExt.match(/^(.+)_(\d+)$/);
  if (m) {
    const base = m[1];
    const color = m[2];
    return {
      baseNameWithoutVariant: base,
      colorVariant: color,
      isMainColorVariant: color === '01',
      hasColorVariant: true
    };
  }
  return {
    baseNameWithoutVariant: noExt,
    colorVariant: null,
    isMainColorVariant: false,
    hasColorVariant: false
  };
}

/**
 * Derive a human-friendly display name from a filename
 * @param {string} [filename]
 * @returns {string}
 */
function deriveDisplayName(filename = '') {
  const noExt = String(filename || '').replace(/\.[^/.]+$/, '');
  const cleaned = noExt.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.replace(/\b\w/g, (l) => l.toUpperCase());
}

/**
 * Parse display name, alphanumeric variant token, size and creature type
 * @param {string} [filename]
 * @returns {{displayName:string,variant:string,size:string,creatureType:string}}
 */
function parseTokenDisplayName(filename = '') {
  const nameWithoutExt = String(filename || '').replace(/\.[^/.]+$/, '');
  const parts = nameWithoutExt.split('_');

  if (parts.length < 2) {
    return {
      displayName: nameWithoutExt.replace(/_/g, ' '),
      variant: '',
      size: '',
      creatureType: ''
    };
  }

  // Find variant token (A1, AA2, X12, 002A)
  let variantIndex = -1;
  let variant = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (isTokenVariantPart(p)) {
      variantIndex = i;
      variant = p;
      break;
    }
  }

  let nameParts = parts;
  let info = [];
  if (variantIndex === -1) {
    const metadataIndex = findImplicitTokenMetadataIndex(parts);
    if (metadataIndex !== -1) {
      nameParts = parts.slice(0, metadataIndex);
      info = parts.slice(metadataIndex);
    }
  } else {
    nameParts = parts.slice(0, variantIndex);
    info = parts.slice(variantIndex + 1);
  }

  const { size, creatureType } = parseTokenMetadataParts(info);

  const displaySource = nameParts.length ? nameParts : parts;
  const displayName = displaySource.join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ').trim();

  return { displayName, variant, size, creatureType };
}

/**
 * Normalize token metadata from filename and dimensions without trusting stale cached labels.
 * @param {FaNexusTokenInventoryRecord} record
 * @returns {FaNexusTokenInventoryRecord}
 */
export function normalizeTokenInventoryRecord(record) {
  if (!record || typeof record !== 'object') return record;
  if (Number(record.schema_version) === 2 && record.id && Array.isArray(record.grid)) {
    return {
      ...record,
      kind: 'token',
      scale: Number.isFinite(Number(record.scale)) ? Number(record.scale) : 1,
      color: record.color && typeof record.color === 'object'
        ? record.color
        : { variant: null, main: false, group: record.name || record.id }
    };
  }

  const filePath = String(record.file_path || record.path || '');
  const filename = String(record.filename || filePath.split('/').pop() || '');
  const next = localToTokenInventoryRecord({ path: filePath, url: record.url || filePath, filename }, record.tier || null);
  next.source = String(record.source || 'local').toLowerCase() === 'cloud' ? 'cloud' : 'local';
  if (record.cachedLocalPath) next.cachedLocalPath = record.cachedLocalPath;
  if (record.thumbnail_url) next.thumbnail_url = record.thumbnail_url;
  if (record.enhanced_thumbnail) next.enhanced_thumbnail = !!record.enhanced_thumbnail;
  if (record.original_thumbnail) next.original_thumbnail = record.original_thumbnail;
  if (record.cloud_tier) next.cloud_tier = record.cloud_tier;
  return next;
}

export function normalizeAssetInventoryRecord(record) {
  if (!record || typeof record !== 'object') return record;
  if (Number(record.schema_version) === 2 && record.id && Array.isArray(record.grid)) {
    return { ...record, kind: 'asset' };
  }
  const filePath = String(record.file_path || record.path || record.url || '');
  const filename = String(record.filename || filePath.split('/').pop() || '');
  const next = localToAssetInventoryRecord({ path: filePath, url: record.url || filePath, filename });
  next.source = String(record.source || 'local').toLowerCase() === 'cloud' ? 'cloud' : 'local';
  if (record.tier) next.tier = record.tier;
  if (record.cachedLocalPath) next.cachedLocalPath = record.cachedLocalPath;
  if (record.thumbnail_url) next.thumbnail_url = record.thumbnail_url;
  if (record.enhanced_thumbnail) next.enhanced_thumbnail = !!record.enhanced_thumbnail;
  if (record.original_thumbnail) next.original_thumbnail = record.original_thumbnail;
  if (record.cloud_tier) next.cloud_tier = record.cloud_tier;
  return next;
}

/**
 * Map a local token scan item to a cloud-parity inventory record
 * @param {{path?:string,filename:string,url?:string}} localItem
 * @param {string|null} [tier]
 * @returns {FaNexusTokenInventoryRecord}
 */
export function localToTokenInventoryRecord(localItem, tier = null) {
  const filename = localItem.filename || '';
  const path = normalizeLocalPath(localItem.path || localItem.url || '');
  const id = path ? path.replace(/\.[^/.]+$/, '') : filename.replace(/\.[^/.]+$/, '');
  const { gridWidth, gridHeight, scale } = parseTokenSize(filename);
  const { baseNameWithoutVariant, colorVariant, isMainColorVariant, hasColorVariant } = detectColorVariant(filename);
  const parsed = parseTokenDisplayName(filename);
  const displayName = parsed.displayName || deriveDisplayName(filename);
  const size = parsed.size || getCreatureSizeFromGridDimensions(gridWidth, gridHeight);
  const creatureType = parsed.creatureType || 'Humanoid';

  return {
    schema_version: 2,
    id,
    kind: 'token',
    source: 'local',
    tier: tier || null,
    folder: dirnamePosix(id),
    name: displayName,
    grid: [gridWidth, gridHeight],
    variant: parsed.variant || '',
    size,
    creature_type: creatureType,
    scale,
    color: {
      variant: colorVariant,
      main: isMainColorVariant,
      group: baseNameWithoutVariant
    },
    selected_source: sourceForFilename(filename),
    tags: [displayName.toLowerCase()]
  };
}

// UI consumes canonical inventory schema directly; no wrapper needed.

/**
 * Parse asset grid WxH from filename suffix (e.g., `name_3x5.png`)
 * @param {string} [filename]
 * @returns {{gridWidth:number,gridHeight:number}}
 */
function parseAssetGrid(filename = '') {
  const name = String(filename || '');
  const noExt = name.replace(/\.[^/.]+$/, '');
  const m = noExt.match(/(?:^|[_\-\s])(\d+)x(\d+)$/i);
  let w = 1, h = 1;
  if (m) {
    w = Math.max(1, Math.min(100, parseInt(m[1], 10) || 1));
    h = Math.max(1, Math.min(100, parseInt(m[2], 10) || 1));
  }
  return { gridWidth: w, gridHeight: h };
}

/**
 * Map a local asset scan item to a simplified inventory record
 * - `grid_width`/`grid_height` parsed from trailing NxM
 * - `width`/`height` estimated at 200px per grid square
 * @param {{path?:string,filename:string,url?:string}} localItem
 * @returns {FaNexusAssetInventoryRecord}
 */
export function localToAssetInventoryRecord(localItem) {
  const filename = localItem.filename || '';
  const path = normalizeLocalPath(localItem.path || localItem.url || '');
  const id = path ? path.replace(/\.[^/.]+$/, '') : filename.replace(/\.[^/.]+$/, '');
  const { gridWidth, gridHeight } = parseAssetGrid(filename);
  const displayName = deriveDisplayName(filename.replace(/\.[^/.]+$/, ''));
  const lower = path.toLowerCase();
  const assetClass = lower.includes('/textures/') || lower.includes('/texture_overlays/') ? 'texture'
    : (filename.toLowerCase().includes('path') || /(^|[\/\-_])paths?(?=[\/\-_]|$)/.test(lower) ? 'path' : 'asset');
  return {
    schema_version: 2,
    id,
    kind: 'asset',
    asset_class: assetClass,
    source: 'local',
    tier: null,
    folder: dirnamePosix(id),
    name: displayName,
    grid: [gridWidth, gridHeight],
    selected_source: sourceForFilename(filename),
    tags: [displayName.toLowerCase()]
  };
}
