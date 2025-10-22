/**
 * Shared inventory utilities (used by Tokens now, Assets later)
 * Provides filename parsing and local→inventory record mapping
 */

/**
 * Parse grid size and scale from a token filename.
 * Supports size keywords (Gargantuan/Huge/Large) and `scaleNN` suffix.
 * @param {string} [filename]
 * @returns {{gridWidth:number,gridHeight:number,scale:number}}
 */
export function parseTokenSize(filename = '') {
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

/**
 * Detect trailing `_NN` color variant token
 * @param {string} [filename]
 * @returns {{baseNameWithoutVariant:string,colorVariant:string|null,isMainColorVariant:boolean,hasColorVariant:boolean}}
 */
export function detectColorVariant(filename = '') {
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
export function deriveDisplayName(filename = '') {
  const noExt = String(filename || '').replace(/\.[^/.]+$/, '');
  const cleaned = noExt.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.replace(/\b\w/g, (l) => l.toUpperCase());
}

/**
 * Parse display name, alphanumeric variant token, size and creature type
 * @param {string} [filename]
 * @returns {{displayName:string,variant:string,size:string,creatureType:string}}
 */
export function parseTokenDisplayName(filename = '') {
  const nameWithoutExt = String(filename || '').replace(/\.[^/.]+$/, '');
  const parts = nameWithoutExt.split('_');

  if (parts.length < 2) {
    return {
      displayName: nameWithoutExt.replace(/_/g, ' '),
      variant: '',
      size: 'Medium',
      creatureType: 'Humanoid'
    };
  }

  // Find variant token (A1, AA2, X12, 002A)
  let variantIndex = -1;
  let variant = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (/^[A-Z]\d+$/.test(p) || /^[A-Z]{2}\d+$/.test(p) || /^[A-Z]\d{2,}$/.test(p) || /^\d{3}[A-Z]$/.test(p)) {
      variantIndex = i;
      variant = p;
      break;
    }
  }

  if (variantIndex === -1) {
    const dn = parts.join(' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    return {
      displayName: dn,
      variant: '',
      size: 'Medium',
      creatureType: 'Humanoid'
    };
  }

  const nameParts = parts.slice(0, variantIndex);
  const info = parts.slice(variantIndex + 1);

  const sizeOptions = ['Tiny','Small','Medium','Large','Huge','Gargantuan'];
  const creatureTypes = [
    'Aberration','Beast','Celestial','Construct','Dragon','Elemental','Fey','Fiend','Giant',
    'Humanoid','Monstrosity','Ooze','Plant','Undead','Human','Elf','Dwarf','Halfling',
    'Dragonborn','Tiefling','Orc','Goblin','Kobold','Gnoll','Hobgoblin'
  ];

  let size = '';
  let creatureType = '';
  for (const p of info) {
    const matchSize = sizeOptions.find(s => s.toLowerCase() === p.toLowerCase());
    if (matchSize) {
      size = matchSize;
      continue;
    }
    const matchCt = creatureTypes.find(c => c.toLowerCase() === p.toLowerCase());
    if (matchCt) {
      creatureType = matchCt;
    }
  }
  if (!creatureType) creatureType = 'Humanoid';
  if (!size) size = 'Medium';

  const displayName = nameParts.join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ').trim();

  return { displayName, variant, size, creatureType };
}

/**
 * Map a local token scan item to a cloud-parity inventory record
 * @param {{path?:string,filename:string,url?:string}} localItem
 * @param {string|null} [tier]
 * @returns {object}
 */
export function localToTokenInventoryRecord(localItem, tier = null) {
  const filename = localItem.filename || '';
  const path = localItem.path || localItem.url || '';
  const { gridWidth, gridHeight, scale } = parseTokenSize(filename);
  const { baseNameWithoutVariant, colorVariant, isMainColorVariant, hasColorVariant } = detectColorVariant(filename);
  const parsed = parseTokenDisplayName(filename);
  const displayName = parsed.displayName || deriveDisplayName(filename);

  // Rough pixel estimation (same idea as reference script)
  const isGarg = /gargantuan/i.test(filename) || (parsed.size && parsed.size.toLowerCase() === 'gargantuan');
  const basePx = isGarg ? 200 : 400;
  const width = Math.round(gridWidth * basePx * scale);
  const height = Math.round(gridHeight * basePx * scale);

  return {
    type: 'token',
    source: 'local',
    tier: tier,
    file_path: path,
    path: path.split('/').slice(0, -1).join('/'),
    filename,
    display_name: displayName,
    variant: parsed.variant || '',
    size: parsed.size || ((gridWidth >= 4 || gridHeight >= 4) ? 'Gargantuan' : (gridWidth === 3 ? 'Huge' : (gridWidth === 2 ? 'Large' : 'Medium'))),
    creature_type: parsed.creatureType || 'Humanoid',
    grid_width: gridWidth,
    grid_height: gridHeight,
    scale: scale+'x',
    width,
    height,
    color_variant: colorVariant,
    is_main_color_variant: isMainColorVariant,
    has_color_variant: hasColorVariant,
    base_name_no_variant: baseNameWithoutVariant,
    file_size: 0,
    content_type: filename.toLowerCase().endsWith('.webp') ? 'image/webp' : (filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'),
    last_modified: new Date().toISOString(),
    tags: [displayName.toLowerCase()]
  };
}

// UI consumes canonical inventory schema directly; no wrapper needed.

/**
 * Parse asset grid WxH from filename suffix (e.g., `name_3x5.png`)
 * @param {string} [filename]
 * @returns {{gridWidth:number,gridHeight:number}}
 */
export function parseAssetGrid(filename = '') {
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
 * @returns {object}
 */
export function localToAssetInventoryRecord(localItem) {
  const filename = localItem.filename || '';
  const path = localItem.path || localItem.url || '';
  const { gridWidth, gridHeight } = parseAssetGrid(filename);
  const displayName = deriveDisplayName(filename.replace(/\.[^/.]+$/, ''));
  const basePx = 200;
  const width = Math.round(gridWidth * basePx);
  const height = Math.round(gridHeight * basePx);
  const contentType = (() => {
    const f = filename.toLowerCase();
    if (f.endsWith('.webp')) return 'image/webp';
    if (f.endsWith('.png')) return 'image/png';
    if (f.endsWith('.jpg') || f.endsWith('.jpeg')) return 'image/jpeg';
    if (f.endsWith('.webm')) return 'video/webm';
    if (f.endsWith('.mp4')) return 'video/mp4';
    if (f.endsWith('.ogg')) return 'video/ogg';
    return 'application/octet-stream';
  })();
  return {
    type: 'asset',
    source: 'local',
    file_path: path,
    path: path.split('/').slice(0, -1).join('/'),
    filename,
    display_name: displayName,
    grid_width: gridWidth,
    grid_height: gridHeight,
    width,
    height,
    file_size: 0,
    content_type: contentType,
    last_modified: new Date().toISOString(),
    tags: [displayName.toLowerCase()]
  };
}
