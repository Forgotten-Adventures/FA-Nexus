import {
  contentFilename,
  contentFolder,
  contentGrid,
  contentPath
} from '../content/cloud-inventory-v2.js';

export function joinTokenPlacementPath(folder, name) {
  const filename = String(name || '').trim();
  if (!filename) return String(folder || '').trim();
  const base = String(folder || '').trim();
  if (!base) return filename;
  return `${base.replace(/\/+$/, '')}/${filename}`;
}

export function normalizeTokenPlacementFilePath(filePath, folderPath, filename) {
  const direct = String(filePath || '').trim();
  if (direct) return direct;
  const folder = String(folderPath || '').trim();
  const name = String(filename || '').trim();
  if (folder && name) return joinTokenPlacementPath(folder, name);
  return name;
}

export function normalizeTokenPlacementFolderPath(folderPath, filePath) {
  const direct = String(folderPath || '').trim();
  if (direct) return direct;
  const resolved = String(filePath || '').trim();
  if (!resolved) return '';
  const idx = resolved.lastIndexOf('/');
  if (idx <= 0) return '';
  return resolved.slice(0, idx);
}

function cardAttribute(card, name) {
  return card?.getAttribute?.(name) ?? null;
}

function readDownloadManagerPath(downloadManager, item) {
  if (!downloadManager) return '';
  try {
    return downloadManager.getLocalPath('tokens', item) || '';
  } catch (_) {
    return '';
  }
}

function readCardLocalPath(card) {
  if (!card) return '';
  try {
    if (card._resolvedLocalPath) return card._resolvedLocalPath;
  } catch (_) {}
  try {
    const attr = card.getAttribute('data-url') || '';
    const isCached = card.getAttribute('data-cached') === 'true';
    if (attr && (isCached || attr.startsWith('file:') || attr.match(/^[A-Za-z]:\\/))) {
      return attr;
    }
  } catch (_) {}
  return '';
}

function parseEntryScale(value) {
  const raw = value ?? 1;
  return (typeof raw === 'string' && raw.endsWith('x'))
    ? (Number(raw.replace('x', '')) || 1)
    : (Number(raw) || 1);
}

export function resolveTokenPlacementCachedLocalPath(item, {
  card = null,
  downloadManager = null,
  allowCardFallback = false
} = {}) {
  let cachedLocalPath = item?.cachedLocalPath || '';
  if (!cachedLocalPath) cachedLocalPath = readDownloadManagerPath(downloadManager, item);
  if (!cachedLocalPath && allowCardFallback) cachedLocalPath = readCardLocalPath(card);
  if (!cachedLocalPath && String(item?.source || '').toLowerCase() === 'local') {
    cachedLocalPath = contentPath(item);
  }
  return cachedLocalPath || '';
}

export function buildTokenPlacementEntryFromRecord(item, {
  card = null,
  key = '',
  downloadManager = null,
  useCardFallbacks = false,
  pathStrategy = 'folder',
  includeItemAlias = false
} = {}) {
  if (!item) return null;
  const fallbackCard = useCardFallbacks ? card : null;
  const filename = contentFilename(item) || cardAttribute(fallbackCard, 'data-filename') || '';
  const filePathAttr = contentPath(item)
    || cardAttribute(fallbackCard, 'data-content-path')
    || cardAttribute(fallbackCard, 'data-file-path')
    || '';
  const folderPathAttr = contentFolder(item)
    || cardAttribute(fallbackCard, 'data-folder')
    || cardAttribute(fallbackCard, 'data-path')
    || '';
  const normalizedFilePath = normalizeTokenPlacementFilePath(filePathAttr, folderPathAttr, filename);
  const normalizedFolder = normalizeTokenPlacementFolderPath(folderPathAttr, normalizedFilePath);
  const cachedLocalPath = resolveTokenPlacementCachedLocalPath(item, {
    card: fallbackCard,
    downloadManager,
    allowCardFallback: useCardFallbacks
  });
  const [gridWidth, gridHeight] = contentGrid(item);
  const colorVariant = item?.color?.variant
    ?? cardAttribute(fallbackCard, 'data-color-variant')
    ?? cardAttribute(fallbackCard, 'data-variant')
    ?? null;
  const colorGroup = item?.color?.group || cardAttribute(fallbackCard, 'data-color-group') || (useCardFallbacks ? item?.name : '') || '';
  const variantGroup = colorGroup || (!useCardFallbacks ? item?.name || '' : '');
  const entry = {
    source: item?.source || cardAttribute(fallbackCard, 'data-source') || 'local',
    tier: item?.tier || cardAttribute(fallbackCard, 'data-tier') || 'free',
    filename,
    file_path: normalizedFilePath,
    path: pathStrategy === 'cached-or-folder' ? (cachedLocalPath || normalizedFolder) : normalizedFolder,
    cachedLocalPath,
    display_name: item?.name || cardAttribute(fallbackCard, 'data-display-name') || '',
    grid_width: gridWidth,
    grid_height: gridHeight,
    scale: Number(item?.scale ?? cardAttribute(fallbackCard, 'data-scale') ?? 1) || 1,
    color_variant: colorVariant,
    base_name_no_variant: colorGroup,
    has_color_variant: colorVariant != null,
    variant_group: variantGroup,
    thumbnail_url: item?.thumbnail_url || '',
    source_item: item,
    card
  };
  if (key) entry.key = key;
  if (includeItemAlias) entry.item = item;
  return entry;
}

export function deriveTokenPlacementEntryKey(entry) {
  if (!entry) return '';
  if (entry.key) return String(entry.key).toLowerCase();
  if (entry.file_path) return String(entry.file_path).toLowerCase();
  if (entry.path) return String(entry.path).toLowerCase();
  if (entry.filename) return String(entry.filename).toLowerCase();
  if (entry.display_name) return String(entry.display_name).toLowerCase();
  return '';
}

export function normalizeTokenPlacementEntry(entry) {
  if (!entry) return null;
  if (entry._nexusNormalized) return entry;
  const card = entry.card || null;
  const item = entry.source_item || entry.item || null;
  const filename = entry.filename ?? item?.filename ?? cardAttribute(card, 'data-filename') ?? '';
  const folderPath = entry.path ?? item?.path ?? cardAttribute(card, 'data-path') ?? '';
  const filePathRaw = entry.file_path ?? item?.file_path ?? cardAttribute(card, 'data-file-path') ?? '';
  const resolvedFilePath = filePathRaw || (folderPath && filename ? joinTokenPlacementPath(folderPath, filename) : filename);
  let cachedLocalPath = entry.cachedLocalPath ?? item?.cachedLocalPath ?? card?._resolvedLocalPath ?? '';
  if (!cachedLocalPath) {
    const cardCached = cardAttribute(card, 'data-cached') === 'true';
    const cardUrl = cardAttribute(card, 'data-url') ?? '';
    if (cardCached && cardUrl) cachedLocalPath = cardUrl;
  }
  const source = entry.source ?? item?.source ?? cardAttribute(card, 'data-source') ?? 'local';
  if (!cachedLocalPath && String(source).toLowerCase() === 'local' && resolvedFilePath) {
    cachedLocalPath = resolvedFilePath;
  }
  let resolvedPath = folderPath;
  if (!resolvedPath && cachedLocalPath) resolvedPath = cachedLocalPath;
  const normalized = {
    card,
    source_item: item,
    source,
    tier: entry.tier ?? item?.tier ?? cardAttribute(card, 'data-tier') ?? 'free',
    filename,
    file_path: resolvedFilePath,
    path: resolvedPath,
    cachedLocalPath,
    display_name: entry.display_name ?? item?.display_name ?? cardAttribute(card, 'data-display-name') ?? '',
    grid_width: Number(entry.grid_width ?? item?.grid_width ?? cardAttribute(card, 'data-grid-w') ?? 1) || 1,
    grid_height: Number(entry.grid_height ?? item?.grid_height ?? cardAttribute(card, 'data-grid-h') ?? 1) || 1,
    scale: parseEntryScale(entry.scale ?? item?.scale ?? cardAttribute(card, 'data-scale') ?? 1),
    color_variant: entry.color_variant ?? item?.color_variant ?? cardAttribute(card, 'data-variant') ?? null,
    base_name_no_variant: entry.base_name_no_variant ?? item?.base_name_no_variant ?? '',
    has_color_variant: entry.has_color_variant ?? !!item?.has_color_variant,
    variant_group: entry.variant_group ?? item?.base_name_no_variant ?? item?.display_name ?? '',
    thumbnail_url: entry.thumbnail_url ?? item?.thumbnail_url ?? '',
    _ensureLocalPromise: entry._ensureLocalPromise || null
  };
  normalized.key = deriveTokenPlacementEntryKey(normalized);
  normalized._nexusNormalized = true;
  return normalized;
}
