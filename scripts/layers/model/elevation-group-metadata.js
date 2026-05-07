import { NexusLogger as Logger } from '../../core/nexus-logger.js';

const MODULE_ID = 'fa-nexus';
const ELEVATION_GROUPS_FLAG = 'layerManagerElevationGroups';

function readFaFlag(doc, key) {
  try {
    const direct = doc?.getFlag?.(MODULE_ID, key);
    if (direct !== undefined) return direct;
  } catch (_) {}
  const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
  return flags ? flags[key] : null;
}

export function parseElevationInput(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function quantizeElevation(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const quantized = Math.round(numeric * 10000) / 10000;
  return Object.is(quantized, -0) ? 0 : quantized;
}

export function elevationGroupKey(value) {
  const quantized = quantizeElevation(value);
  const key = quantized.toFixed(4);
  return key === '-0.0000' ? '0.0000' : key;
}

function normalizeElevationGroupMetadataKey(value, { synthetic = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parsed = parseElevationInput(raw);
  if (Number.isFinite(parsed)) return elevationGroupKey(parsed);
  if (synthetic === true || raw.includes(':')) return raw;
  return null;
}

function collectElevationGroupMetadataEntries(raw, prefix = '', output = []) {
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const name = String(entry?.name ?? '').trim();
      const synthetic = entry?.synthetic === true;
      const key = normalizeElevationGroupMetadataKey(
        entry?.key ?? entry?.elevationKey ?? entry?.elevation,
        { synthetic }
      );
      if (key && name) output.push({ key, name, synthetic });
    }
    return output;
  }
  if (!raw || typeof raw !== 'object') return output;
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const joinedKey = prefix ? `${prefix}.${rawKey}` : rawKey;
    const name = typeof rawValue === 'string'
      ? rawValue.trim()
      : String(rawValue?.name ?? '').trim();
    const synthetic = rawValue?.synthetic === true;
    const key = normalizeElevationGroupMetadataKey(
      rawValue?.key ?? rawValue?.elevationKey ?? rawValue?.elevation ?? joinedKey,
      { synthetic }
    );
    if (key) {
      if (name) {
        output.push({ key, name, synthetic });
        continue;
      }
      if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
        collectElevationGroupMetadataEntries(rawValue, key, output);
      }
      continue;
    }
    if (rawValue && typeof rawValue === 'object') {
      collectElevationGroupMetadataEntries(rawValue, '', output);
    }
  }
  return output;
}

export function normalizeElevationGroupMetadata(raw) {
  const normalized = {};
  const entries = collectElevationGroupMetadataEntries(raw);
  for (const entry of entries) {
    const key = String(entry?.key || '').trim();
    const name = String(entry.name ?? '').trim();
    if (!key || !name) continue;
    normalized[key] = {
      name,
      ...(entry?.synthetic === true ? { synthetic: true } : {})
    };
  }
  return normalized;
}

export function cloneElevationGroupMetadata(metadata = {}) {
  const normalized = normalizeElevationGroupMetadata(metadata);
  const clone = {};
  for (const [key, value] of Object.entries(normalized)) {
    clone[key] = { ...value };
  }
  return clone;
}

export function serializeElevationGroupMetadata(metadata = {}) {
  const normalized = normalizeElevationGroupMetadata(metadata);
  return Object.entries(normalized)
    .map(([key, value]) => {
      const numericElevation = parseElevationInput(key);
      return {
        ...(Number.isFinite(numericElevation) ? { elevation: numericElevation } : { key }),
        name: String(value?.name ?? '').trim(),
        ...(value?.synthetic === true ? { synthetic: true } : {})
      };
    })
    .filter((entry) => String(entry?.name ?? '').trim())
    .sort((a, b) => {
      const leftElevation = parseElevationInput(a?.elevation ?? a?.key);
      const rightElevation = parseElevationInput(b?.elevation ?? b?.key);
      const leftNumeric = Number.isFinite(leftElevation);
      const rightNumeric = Number.isFinite(rightElevation);
      if (leftNumeric && rightNumeric) return Number(leftElevation) - Number(rightElevation);
      if (leftNumeric) return -1;
      if (rightNumeric) return 1;
      return String(a?.key || '').localeCompare(String(b?.key || ''));
    });
}

export function getSceneElevationGroupMetadata(scene = canvas?.scene) {
  return cloneElevationGroupMetadata(readFaFlag(scene, ELEVATION_GROUPS_FLAG));
}

export function getElevationGroupName(metadata, elevationKey) {
  const key = String(elevationKey || '').trim();
  if (!key) return '';
  return String(metadata?.[key]?.name ?? '').trim();
}

export function applySceneElevationGroupMetadataLocally(scene, metadata) {
  const targetScene = scene || canvas?.scene;
  if (!targetScene) return;
  const normalized = cloneElevationGroupMetadata(metadata);
  const serialized = serializeElevationGroupMetadata(normalized);
  const hasGroups = serialized.length > 0;
  const assign = (target) => {
    if (!target || typeof target !== 'object') return;
    if (!target.flags || typeof target.flags !== 'object') target.flags = {};
    if (!target.flags[MODULE_ID] || typeof target.flags[MODULE_ID] !== 'object') target.flags[MODULE_ID] = {};
    if (hasGroups) target.flags[MODULE_ID][ELEVATION_GROUPS_FLAG] = serialized.map((entry) => ({ ...entry }));
    else delete target.flags[MODULE_ID][ELEVATION_GROUPS_FLAG];
  };
  try { assign(targetScene); } catch (_) {}
  try { assign(targetScene._source); } catch (_) {}
}

export async function setSceneElevationGroupMetadata(scene, metadata) {
  const targetScene = scene || canvas?.scene;
  if (!targetScene) throw new Error('No active scene available for elevation group update.');
  if (!targetScene?.canUserModify?.(game.user, 'update')) {
    throw new Error('You do not have permission to edit elevation groups.');
  }
  const normalized = normalizeElevationGroupMetadata(metadata);
  const groupKeys = Object.keys(normalized);
  const serialized = serializeElevationGroupMetadata(normalized);
  Logger.info('LayerManager.elevationGroups.persist', {
    sceneId: targetScene.id || null,
    groupKeys,
    storageEntries: serialized.length
  });
  if (!groupKeys.length) {
    if (typeof targetScene.unsetFlag === 'function') {
      await targetScene.unsetFlag(MODULE_ID, ELEVATION_GROUPS_FLAG);
    } else {
      await targetScene.update({ [`flags.${MODULE_ID}.-=${ELEVATION_GROUPS_FLAG}`]: null });
    }
    applySceneElevationGroupMetadataLocally(targetScene, {});
    return;
  }
  if (typeof targetScene.setFlag === 'function') {
    await targetScene.setFlag(MODULE_ID, ELEVATION_GROUPS_FLAG, serialized);
  } else {
    await targetScene.update({ [`flags.${MODULE_ID}.${ELEVATION_GROUPS_FLAG}`]: serialized });
  }
  applySceneElevationGroupMetadataLocally(targetScene, normalized);
}

export function mergeElevationGroupMetadataOnMove({ metadata = {}, sourceKey, targetKey } = {}) {
  const normalized = cloneElevationGroupMetadata(metadata);
  const fromKey = String(sourceKey || '').trim();
  const toKey = String(targetKey || '').trim();
  if (!fromKey || !toKey || fromKey === toKey) return normalized;
  const sourceEntry = normalized[fromKey] ? { ...normalized[fromKey] } : null;
  const sourceName = String(sourceEntry?.name ?? '').trim();
  const targetName = getElevationGroupName(normalized, toKey);
  if (!targetName && sourceName) {
    normalized[toKey] = { ...(sourceEntry || {}), name: sourceName };
  }
  delete normalized[fromKey];
  return normalizeElevationGroupMetadata(normalized);
}

export function mergeElevationGroupMetadataOnBulkMove({ metadata = {}, moves = [] } = {}) {
  const normalized = cloneElevationGroupMetadata(metadata);
  const moveList = Array.isArray(moves)
    ? moves
      .map((move) => ({
        sourceKey: String(move?.sourceKey || '').trim(),
        targetKey: String(move?.targetKey || '').trim()
      }))
      .filter((move) => move.sourceKey && move.targetKey && move.sourceKey !== move.targetKey)
    : [];
  if (!moveList.length) return normalizeElevationGroupMetadata(normalized);

  const sourceEntries = new Map(moveList.map((move) => [move.sourceKey, normalized[move.sourceKey] ? { ...normalized[move.sourceKey] } : null]));
  for (const move of moveList) {
    delete normalized[move.sourceKey];
  }
  for (const move of moveList) {
    const sourceEntry = sourceEntries.get(move.sourceKey) || null;
    const sourceName = String(sourceEntry?.name ?? '').trim();
    const targetName = getElevationGroupName(normalized, move.targetKey);
    if (!targetName && sourceName) {
      normalized[move.targetKey] = { ...(sourceEntry || {}), name: sourceName };
    }
  }
  return normalizeElevationGroupMetadata(normalized);
}
