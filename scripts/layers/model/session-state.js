import { NexusLogger as Logger } from '../../core/nexus-logger.js';
import { getCurrentSceneLevel } from '../../canvas/elevation-band-utils.js';
import { elevationGroupKey, parseElevationInput } from './elevation-group-metadata.js';

const MODULE_ID = 'fa-nexus';

export const COLLAPSED_STATE_SETTING = 'layerManagerCollapsedState';

const layerManagerSessionState = new Map();
let layerManagerCollapsedStateSyncPending = false;
let layerManagerCollapsedStateSyncQueued = false;

function readCollapsedStateSetting() {
  try {
    return game?.settings?.get?.(MODULE_ID, COLLAPSED_STATE_SETTING);
  } catch (_) {
    return '';
  }
}

function writeCollapsedStateSetting(value) {
  try {
    return game?.settings?.set?.(MODULE_ID, COLLAPSED_STATE_SETTING, value);
  } catch (_) {
    return undefined;
  }
}

export function normalizeLevelIds(levels) {
  const source = Array.isArray(levels)
    ? levels
    : (levels instanceof Set ? Array.from(levels) : []);
  return Array.from(new Set(source
    .map((levelId) => String(levelId || '').trim())
    .filter(Boolean)));
}

export function getDocumentLevelIds(doc) {
  const direct = doc?.levels;
  if (direct instanceof Set || Array.isArray(direct)) return normalizeLevelIds(direct);
  const source = doc?._source?.levels;
  return normalizeLevelIds(source);
}

export function getActiveLevelListId(scene = canvas?.scene) {
  return String(getCurrentSceneLevel(scene)?.id || '').trim();
}

export function isDocumentInActiveLevelListScope(doc, { scene = canvas?.scene } = {}) {
  if (!doc) return false;
  const currentLevelId = getActiveLevelListId(scene);
  if (!currentLevelId) return true;
  const levelIds = getDocumentLevelIds(doc);
  if (!levelIds.length) return true;
  return levelIds.includes(currentLevelId);
}

export function getCurrentSceneSessionKey() {
  const sceneId = canvas?.scene?.id || game?.scenes?.current?.id || 'default';
  return String(sceneId);
}

export function normalizeCollapsedElevationKey(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parsed = parseElevationInput(raw);
  return Number.isFinite(parsed) ? elevationGroupKey(parsed) : raw;
}

function compareCollapsedKeys(left, right) {
  const leftRaw = String(left ?? '').trim();
  const rightRaw = String(right ?? '').trim();
  const leftNumeric = parseElevationInput(leftRaw);
  const rightNumeric = parseElevationInput(rightRaw);
  const leftIsNumeric = Number.isFinite(leftNumeric);
  const rightIsNumeric = Number.isFinite(rightNumeric);
  if (leftIsNumeric && rightIsNumeric) return Number(leftNumeric) - Number(rightNumeric);
  if (leftIsNumeric) return -1;
  if (rightIsNumeric) return 1;
  return leftRaw.localeCompare(rightRaw);
}

function isSyntheticCollapsedElevationKey(value) {
  return String(value ?? '').trim().includes(':');
}

function setsMatchValues(set, values = []) {
  if (!(set instanceof Set)) return false;
  if (set.size !== values.length) return false;
  return values.every((value) => set.has(value));
}

export function readPersistedLayerManagerCollapsedState() {
  const raw = String(readCollapsedStateSetting() ?? '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected a scene-keyed object.');
    }
    const normalized = {};
    for (const [sceneKey, rawKeys] of Object.entries(parsed)) {
      if (!Array.isArray(rawKeys)) continue;
      const collapsedKeys = Array.from(new Set(rawKeys
        .map((key) => normalizeCollapsedElevationKey(key))
        .filter(Boolean)))
        .sort(compareCollapsedKeys);
      if (collapsedKeys.length) normalized[String(sceneKey)] = collapsedKeys;
    }
    return normalized;
  } catch (error) {
    Logger.warn('LayerManager.collapsedState.read.failed', {
      error: String(error?.message || error)
    });
    return {};
  }
}

export function syncLayerManagerCollapsedStateFromSettings() {
  const persisted = readPersistedLayerManagerCollapsedState();
  for (const [sceneKey, state] of layerManagerSessionState.entries()) {
    state.collapsedElevations = new Set(persisted[String(sceneKey)] || []);
  }
}

export function reconcileLayerManagerCollapsedState({
  sessionState = null,
  hierarchy = null
} = {}) {
  if (!sessionState) {
    return {
      changed: false,
      collapsedKeys: [],
      staleSyntheticKeys: []
    };
  }
  if (!(sessionState.collapsedElevations instanceof Set)) {
    sessionState.collapsedElevations = new Set();
  }
  const visibleKeys = hierarchy?.visibleKeys instanceof Set ? hierarchy.visibleKeys : new Set();
  const staleSyntheticKeys = [];
  const collapsedKeys = Array.from(new Set(Array.from(sessionState.collapsedElevations)
    .map((key) => normalizeCollapsedElevationKey(key))
    .filter((key) => {
      if (!key) return false;
      if (!isSyntheticCollapsedElevationKey(key)) return true;
      if (visibleKeys.has(key)) return true;
      staleSyntheticKeys.push(key);
      return false;
    })))
    .sort(compareCollapsedKeys);

  const changed = staleSyntheticKeys.length > 0 || !setsMatchValues(sessionState.collapsedElevations, collapsedKeys);
  if (changed) {
    sessionState.collapsedElevations = new Set(collapsedKeys);
  }

  return {
    changed,
    collapsedKeys,
    staleSyntheticKeys: Array.from(new Set(staleSyntheticKeys)).sort(compareCollapsedKeys)
  };
}

function serializeLayerManagerCollapsedState() {
  const serialized = {};
  for (const [sceneKey, state] of layerManagerSessionState.entries()) {
    const collapsedKeys = state?.collapsedElevations instanceof Set
      ? Array.from(new Set(Array.from(state.collapsedElevations)
        .map((key) => normalizeCollapsedElevationKey(key))
        .filter(Boolean)))
          .sort(compareCollapsedKeys)
      : [];
    if (collapsedKeys.length) serialized[String(sceneKey)] = collapsedKeys;
  }
  return serialized;
}

export function queuePersistLayerManagerCollapsedState() {
  if (layerManagerCollapsedStateSyncPending) {
    layerManagerCollapsedStateSyncQueued = true;
    return;
  }
  const serialized = serializeLayerManagerCollapsedState();
  layerManagerCollapsedStateSyncPending = true;
  Promise.resolve(writeCollapsedStateSetting(JSON.stringify(serialized)))
    .catch((error) => {
      Logger.error('LayerManager.collapsedState.persist.failed', {
        error: String(error?.message || error)
      });
    })
    .finally(() => {
      layerManagerCollapsedStateSyncPending = false;
      if (layerManagerCollapsedStateSyncQueued) {
        layerManagerCollapsedStateSyncQueued = false;
        queuePersistLayerManagerCollapsedState();
      }
    });
}

function createLayerManagerSessionState(sceneKey = getCurrentSceneSessionKey()) {
  const persisted = readPersistedLayerManagerCollapsedState();
  return {
    searchQuery: '',
    typeFilters: new Set(),
    flagFilters: {
      locked: false,
      hidden: false,
      hsbc: false,
      mask: false
    },
    collapsedElevations: new Set(persisted[String(sceneKey)] || []),
    selectionOptionsCollapsed: true
  };
}

export function getLayerManagerSessionState(sceneKey = getCurrentSceneSessionKey()) {
  const key = String(sceneKey || 'default');
  let state = layerManagerSessionState.get(key);
  if (!state) {
    state = createLayerManagerSessionState(key);
    layerManagerSessionState.set(key, state);
  }
  return state;
}
