import { contentFilename, contentPath } from '../content/cloud-inventory-v2.js';
import { mergeLocalAndCloudRecords } from '../content/nexus-content-service.js';

function normalizeTokenMergePathKey(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '');
}

function tokenMatchKey(record) {
  const base = String(record?.color?.group || '').trim().toLowerCase();
  const color = String(record?.color?.variant ?? '').trim().toLowerCase();
  if (base) return `${base}::${color || 'default'}`;
  const fallback = String(contentFilename(record) || contentPath(record) || '').trim();
  if (!fallback) return '';
  return fallback.replace(/\.[^/.]+$/, '').toLowerCase();
}

function tokenPathKey(record) {
  const raw = normalizeTokenMergePathKey(record?.id || contentPath(record) || '');
  if (!raw) return '';
  return raw.replace(/\.[^/.]+$/, '').toLowerCase();
}

function countTokenMatchKeys(records) {
  const counts = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const match = tokenMatchKey(record);
    if (!match) continue;
    counts.set(match, (counts.get(match) || 0) + 1);
  }
  return counts;
}

function sourceRank(item) {
  if (!item) return 0;
  const source = String(item.source || '').toLowerCase();
  if (source === 'local') return 3;
  if (source === 'cloud' && item.cachedLocalPath) return 2;
  return 1;
}

function extensionRank(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.webp')) return 3;
  if (lower.endsWith('.png')) return 2;
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 1;
  return 0;
}

export function choosePreferredTokenMergeRecord(existing, incoming) {
  const existingRank = sourceRank(existing);
  const incomingRank = sourceRank(incoming);
  if (incomingRank > existingRank) return incoming;
  if (incomingRank < existingRank) return existing;

  const existingExtensionRank = extensionRank(contentFilename(existing) || contentPath(existing));
  const incomingExtensionRank = extensionRank(contentFilename(incoming) || contentPath(incoming));
  if (incomingExtensionRank > existingExtensionRank) return incoming;
  if (incomingExtensionRank < existingExtensionRank) return existing;

  const existingModified = Date.parse(existing?.selected_source?.mtime || existing?.updated || '') || 0;
  const incomingModified = Date.parse(incoming?.selected_source?.mtime || incoming?.updated || '') || 0;
  return incomingModified >= existingModified ? incoming : existing;
}

export function mergeTokenLocalAndCloudRecords({
  localItems = [],
  cloudItems = [],
  contentService = null,
  logger = null
} = {}) {
  const safeLocalItems = Array.isArray(localItems) ? localItems : [];
  const safeCloudItems = Array.isArray(cloudItems) ? cloudItems : [];
  const localMatchCounts = countTokenMatchKeys(safeLocalItems);
  const cloudMatchCounts = countTokenMatchKeys(safeCloudItems);
  const sharedLocalCloudKey = (record) => {
    const match = tokenMatchKey(record);
    if (!match) return '';
    if ((localMatchCounts.get(match) || 0) !== 1) return '';
    if ((cloudMatchCounts.get(match) || 0) !== 1) return '';
    return `match:${match}`;
  };

  return mergeLocalAndCloudRecords({
    kind: 'tokens',
    local: safeLocalItems,
    cloud: safeCloudItems,
    keySelector: (record) => {
      const source = String(record?.source || '').toLowerCase();
      const sharedKey = sharedLocalCloudKey(record);
      const pathKey = tokenPathKey(record);
      const match = tokenMatchKey(record);
      if (source === 'local') {
        if (sharedKey) return sharedKey;
        if (pathKey) return `local:${pathKey}`;
        return match ? `local:${match}` : '';
      }
      if (sharedKey) return sharedKey;
      if (pathKey) return `cloud:${pathKey}`;
      return match ? `cloud:${match}` : '';
    },
    choosePreferred: choosePreferredTokenMergeRecord,
    onEnhanceLocal: ({ localRecord, cloudRecord }) => {
      if (!contentService || !contentFilename(cloudRecord)) return null;
      try {
        const thumbnail = contentService.getThumbnailURL?.('tokens', cloudRecord);
        if (!thumbnail) return null;
        if (String(localRecord.thumbnail_url || contentPath(localRecord) || '').includes(thumbnail)) return null;
        return {
          ...localRecord,
          original_thumbnail: contentPath(localRecord) || localRecord.thumbnail_url,
          thumbnail_url: thumbnail,
          enhanced_thumbnail: true,
          cloud_tier: cloudRecord.tier
        };
      } catch (_) {
        return null;
      }
    },
    onStats: ({ collisions, preferLocal, preferCloud, enhanced, localCount, cloudCount, mergedCount }) => {
      try {
        logger?.info?.('TokensTab.merge', {
          collisions,
          preferLocal,
          preferCloud,
          enhanced,
          local: localCount,
          cloud: cloudCount,
          merged: mergedCount
        });
      } catch (_) {}
    }
  });
}
