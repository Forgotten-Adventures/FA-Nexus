import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { TileFlattenManager } from '../canvas/tile-flatten-manager.js';
import { getFaNexusTileEditMode, openFaNexusTileEditor } from '../canvas/tile-hud-edit.js';
import { createCanvasGestureSession } from '../canvas/canvas-gesture-session.js';
import { computeNextSortAtElevation } from '../canvas/canvas-interaction-controller.js';
import { isKeepTokensAboveTileElevationsEnabled } from '../canvas/elevation-band-utils.js';
import { readDocumentHsbc } from '../core/hsbc.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { AbstractSidebarTab, Sidebar } = foundry.applications.sidebar;

const MODULE_ID = 'fa-nexus';
const TAB_ID = 'layer-manager';
const RANGE_MIN_SETTING = 'layerManagerElevationMin';
const RANGE_MAX_SETTING = 'layerManagerElevationMax';
const SKIP_LOCKED_SETTING = 'layerManagerSkipLocked';
const SKIP_HIDDEN_SETTING = 'layerManagerSkipHidden';
const SKIP_FILTERED_SETTING = 'layerManagerSkipFiltered';
const IGNORE_FOREGROUND_SETTING = 'layerManagerIgnoreForeground';
const COLLAPSED_STATE_SETTING = 'layerManagerCollapsedState';
const NESTED_GROUPING_SETTING = 'layerManagerNestedGrouping';
const LAYER_HIDDEN_FLAG = 'layerHidden';
const ELEVATION_GROUPS_FLAG = 'layerManagerElevationGroups';
const CONTEXT_DOUBLE_CLICK_MS = 350;
const SEPARATOR_RENAME_CLICK_DELAY_MS = 180;
const BG_RENDER_OVERRIDE_KEY = 'faNexusBgBandRenderElevation';
const MAX_ELEVATION_DECIMALS = 4;
const ELEVATION_SCALE = 10 ** MAX_ELEVATION_DECIMALS;
const ELEVATION_STEP_DEFAULT = 0.01;
const ELEVATION_STEP_FINE = 0.001;
const ELEVATION_STEP_COARSE = 0.1;
const EDITING_TILE_SET_KEYS = [
  '__faNexusTextureEditingTileIds',
  '__faNexusBuildingEditingTileIds',
  '__faNexusPathEditingTiles'
];
const LIST_FILTER_FLAG_KEYS = Object.freeze(['locked', 'hidden', 'hsbc', 'mask']);
const LIST_FILTER_CHIPS = Object.freeze([
  { key: 'asset', kind: 'type', label: 'Asset', icon: 'fa-solid fa-image' },
  { key: 'scatter', kind: 'type', label: 'Scatter', icon: 'fa-solid fa-braille' },
  { key: 'building', kind: 'type', label: 'Wall/Building', icon: 'fa-solid fa-building' },
  { key: 'path', kind: 'type', label: 'Path', icon: 'fa-solid fa-route' },
  { key: 'texture', kind: 'type', label: 'Texture', icon: 'fa-solid fa-paint-roller' },
  { key: 'locked', kind: 'flag', label: 'Locked', icon: 'fa-solid fa-lock' },
  { key: 'hidden', kind: 'flag', label: 'Hidden', icon: 'fa-solid fa-eye-slash' },
  { key: 'hsbc', kind: 'flag', label: 'HSBC', icon: 'fa-solid fa-sliders' },
  /* { key: 'mask', kind: 'flag', label: 'Mask', icon: 'fa-solid fa-mask' } */
]);

const selectionFilterState = {
  active: false,
  min: null,
  max: null,
  skipLocked: false,
  skipHidden: false,
  skipFiltered: false,
  listFilterSignature: '',
  listFilterActive: false,
  matchingListTileIds: new Set(),
  ignoreForeground: false
};
const SELECTION_FILTER_BLOCK_KEY = '_faNexusSelectionFilterBlocked';
const layerHiddenState = {
  hooksBound: false
};
const selectionFilterHookState = {
  hooksBound: false
};

const hoverEventStub = { buttons: 0 };
const clickEventStub = { shiftKey: false, stopPropagation: () => {} };

let _tileFlattenManager = null;
let _altKeyHeld = false;
const _layerManagerSessionState = new Map();
let _layerManagerCollapsedStateSyncPending = false;
let _layerManagerCollapsedStateSyncQueued = false;

function getTileFlattenManager() {
  if (!_tileFlattenManager) _tileFlattenManager = new TileFlattenManager();
  return _tileFlattenManager;
}

function parseElevationInput(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatElevation(value) {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 10000) / 10000;
  const fixed = rounded.toFixed(4).replace(/\.?0+$/, '');
  return fixed || '0';
}

function quantizeElevation(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const quantized = Math.round(numeric * 10000) / 10000;
  return Object.is(quantized, -0) ? 0 : quantized;
}

function elevationGroupKey(value) {
  const quantized = quantizeElevation(value);
  const key = quantized.toFixed(4);
  return key === '-0.0000' ? '0.0000' : key;
}

function getCurrentSceneSessionKey() {
  const sceneId = canvas?.scene?.id || game?.scenes?.current?.id || 'default';
  return String(sceneId);
}

function normalizeCollapsedElevationKey(value) {
  const parsed = parseElevationInput(value);
  return Number.isFinite(parsed) ? elevationGroupKey(parsed) : null;
}

function readPersistedLayerManagerCollapsedState() {
  const raw = String(readSetting(COLLAPSED_STATE_SETTING) ?? '').trim();
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
        .sort((a, b) => Number(parseElevationInput(a) ?? 0) - Number(parseElevationInput(b) ?? 0));
      if (collapsedKeys.length) normalized[String(sceneKey)] = collapsedKeys;
    }
    return normalized;
  } catch (error) {
    Logger.error('LayerManager.collapsedState.read.failed', {
      error: String(error?.message || error)
    });
    return {};
  }
}

function syncLayerManagerCollapsedStateFromSettings() {
  const persisted = readPersistedLayerManagerCollapsedState();
  for (const [sceneKey, state] of _layerManagerSessionState.entries()) {
    state.collapsedElevations = new Set(persisted[String(sceneKey)] || []);
  }
}

function serializeLayerManagerCollapsedState() {
  const serialized = {};
  for (const [sceneKey, state] of _layerManagerSessionState.entries()) {
    const collapsedKeys = state?.collapsedElevations instanceof Set
      ? Array.from(new Set(Array.from(state.collapsedElevations)
        .map((key) => normalizeCollapsedElevationKey(key))
        .filter(Boolean)))
          .sort((a, b) => Number(parseElevationInput(a) ?? 0) - Number(parseElevationInput(b) ?? 0))
      : [];
    if (collapsedKeys.length) serialized[String(sceneKey)] = collapsedKeys;
  }
  return serialized;
}

function queuePersistLayerManagerCollapsedState() {
  if (_layerManagerCollapsedStateSyncPending) {
    _layerManagerCollapsedStateSyncQueued = true;
    return;
  }
  const serialized = serializeLayerManagerCollapsedState();
  _layerManagerCollapsedStateSyncPending = true;
  Promise.resolve(writeSetting(COLLAPSED_STATE_SETTING, JSON.stringify(serialized)))
    .catch((error) => {
      Logger.error('LayerManager.collapsedState.persist.failed', {
        error: String(error?.message || error)
      });
    })
    .finally(() => {
      _layerManagerCollapsedStateSyncPending = false;
      if (_layerManagerCollapsedStateSyncQueued) {
        _layerManagerCollapsedStateSyncQueued = false;
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

function getLayerManagerSessionState(sceneKey = getCurrentSceneSessionKey()) {
  const key = String(sceneKey || 'default');
  let state = _layerManagerSessionState.get(key);
  if (!state) {
    state = createLayerManagerSessionState(key);
    _layerManagerSessionState.set(key, state);
  }
  return state;
}

function normalizeTileTypeKey(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'asset' || normalized === 'image') return 'asset';
  if (normalized === 'scatter') return 'scatter';
  if (normalized === 'building' || normalized === 'wall' || normalized === 'wall/building') return 'building';
  if (normalized === 'path' || normalized === 'paths') return 'path';
  if (normalized === 'texture' || normalized === 'paint') return 'texture';
  return null;
}

function isFilterFlagKey(value) {
  return LIST_FILTER_FLAG_KEYS.includes(String(value ?? '').trim().toLowerCase());
}

function createParsedListSearchClause() {
  return {
    includeText: [],
    excludeText: [],
    includeTypes: new Set(),
    excludeTypes: new Set(),
    includeFlags: new Set(),
    excludeFlags: new Set()
  };
}

function isParsedListSearchClauseEmpty(parsed) {
  return !parsed
    || (
      !(parsed.includeText?.length)
      && !(parsed.excludeText?.length)
      && !(parsed.includeTypes?.size)
      && !(parsed.excludeTypes?.size)
      && !(parsed.includeFlags?.size)
      && !(parsed.excludeFlags?.size)
    );
}

function parseListSearchClause(tokens = []) {
  const parsed = createParsedListSearchClause();
  let negateNext = false;
  for (const rawToken of tokens) {
    if (!rawToken) continue;
    if (/^not$/i.test(rawToken)) {
      negateNext = true;
      continue;
    }
    let token = String(rawToken).trim();
    let negated = negateNext;
    negateNext = false;
    if (token.startsWith('-') && token.length > 1) {
      negated = true;
      token = token.slice(1);
    }
    if (
      (token.startsWith('"') && token.endsWith('"'))
      || (token.startsWith('\'') && token.endsWith('\''))
    ) {
      token = token.slice(1, -1);
    }
    const normalized = token.trim().toLowerCase();
    if (!normalized) continue;
    const typeMatch = normalized.match(/^(?:type|kind):(.+)$/);
    if (typeMatch) {
      const typeKey = normalizeTileTypeKey(typeMatch[1]);
      if (typeKey) {
        (negated ? parsed.excludeTypes : parsed.includeTypes).add(typeKey);
        continue;
      }
    }
    if (isFilterFlagKey(normalized)) {
      (negated ? parsed.excludeFlags : parsed.includeFlags).add(normalized);
      continue;
    }
    (negated ? parsed.excludeText : parsed.includeText).push(normalized);
  }
  return parsed;
}

function isListSearchOrToken(rawToken) {
  const token = String(rawToken ?? '').trim();
  return /^or$/i.test(token) || token === '|' || token === '||';
}

function parseListSearchQuery(query) {
  const rawTokens = String(query ?? '').match(/"[^"]+"|\S+/g) || [];
  const clauseTokens = [];
  let currentClause = [];
  for (const rawToken of rawTokens) {
    if (!rawToken) continue;
    if (isListSearchOrToken(rawToken)) {
      if (currentClause.length) clauseTokens.push(currentClause);
      currentClause = [];
      continue;
    }
    currentClause.push(rawToken);
  }
  if (currentClause.length) clauseTokens.push(currentClause);
  const clauses = clauseTokens
    .map((tokens) => parseListSearchClause(tokens))
    .filter((parsed) => !isParsedListSearchClauseEmpty(parsed));
  if (!clauses.length) {
    const empty = createParsedListSearchClause();
    return { ...empty, clauses: [empty] };
  }
  if (clauses.length === 1) {
    return { ...clauses[0], clauses };
  }
  const empty = createParsedListSearchClause();
  return { ...empty, clauses };
}

function hasTileHsbc(doc) {
  return !!readDocumentHsbc(doc, { nullIfMissing: true, nullIfNeutral: true });
}

function hasTileMask(doc) {
  return !!readFaFlag(doc, 'standardTileMask');
}

function cloneElevationGroupMetadata(metadata = {}) {
  const normalized = normalizeElevationGroupMetadata(metadata);
  const clone = {};
  for (const [key, value] of Object.entries(normalized)) {
    clone[key] = { ...value };
  }
  return clone;
}

function serializeElevationGroupMetadata(metadata = {}) {
  const normalized = normalizeElevationGroupMetadata(metadata);
  return Object.entries(normalized)
    .map(([key, value]) => ({
      elevation: parseElevationInput(key),
      name: String(value?.name ?? '').trim(),
      ...(value?.synthetic === true ? { synthetic: true } : {})
    }))
    .filter((entry) => Number.isFinite(entry.elevation) && entry.name)
    .sort((a, b) => Number(a.elevation) - Number(b.elevation));
}

function collectElevationGroupMetadataEntries(raw, prefix = '', output = []) {
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const elevation = parseElevationInput(entry?.elevation ?? entry?.key ?? entry?.elevationKey);
      const name = String(entry?.name ?? '').trim();
      const synthetic = entry?.synthetic === true;
      if (Number.isFinite(elevation) && name) output.push({ elevation, name, synthetic });
    }
    return output;
  }
  if (!raw || typeof raw !== 'object') return output;
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const joinedKey = prefix ? `${prefix}.${rawKey}` : rawKey;
    const parsedKey = parseElevationInput(joinedKey);
    const name = typeof rawValue === 'string'
      ? rawValue.trim()
      : String(rawValue?.name ?? '').trim();
    const synthetic = rawValue?.synthetic === true;
    if (Number.isFinite(parsedKey)) {
      if (name) {
        output.push({ elevation: parsedKey, name, synthetic });
        continue;
      }
      if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
        collectElevationGroupMetadataEntries(rawValue, joinedKey, output);
      }
      continue;
    }
    if (rawValue && typeof rawValue === 'object') {
      const embeddedElevation = parseElevationInput(rawValue?.elevation ?? rawValue?.key ?? rawValue?.elevationKey);
      if (Number.isFinite(embeddedElevation) && name) {
        output.push({ elevation: embeddedElevation, name, synthetic });
        continue;
      }
      collectElevationGroupMetadataEntries(rawValue, '', output);
    }
  }
  return output;
}

function normalizeElevationGroupMetadata(raw) {
  const normalized = {};
  const entries = collectElevationGroupMetadataEntries(raw);
  for (const entry of entries) {
    const key = elevationGroupKey(entry.elevation);
    const name = String(entry.name ?? '').trim();
    if (!name) continue;
    normalized[key] = {
      name,
      ...(entry?.synthetic === true ? { synthetic: true } : {})
    };
  }
  return normalized;
}

function getSceneElevationGroupMetadata(scene = canvas?.scene) {
  return cloneElevationGroupMetadata(readFaFlag(scene, ELEVATION_GROUPS_FLAG));
}

function getElevationGroupName(metadata, elevationKey) {
  const key = String(elevationKey || '').trim();
  if (!key) return '';
  return String(metadata?.[key]?.name ?? '').trim();
}

function isNestedLayerManagerGroupingEnabled() {
  return readSetting(NESTED_GROUPING_SETTING) === true;
}

function applySceneElevationGroupMetadataLocally(scene, metadata) {
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

async function setSceneElevationGroupMetadata(scene, metadata) {
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

function mergeElevationGroupMetadataOnMove({ metadata = {}, sourceKey, targetKey } = {}) {
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

function mergeElevationGroupMetadataOnBulkMove({ metadata = {}, moves = [] } = {}) {
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

function buildTileSearchText(entry) {
  const tokens = [
    entry?.name,
    entry?.typeLabel,
    entry?.typeKey,
    entry?.elevationLabel,
    entry?.locked ? 'locked' : 'unlocked',
    entry?.hidden ? 'hidden' : 'visible',
    entry?.hasHsbc ? 'hsbc hue saturation brightness contrast' : '',
    entry?.hasMask ? 'mask masked masking standard tile mask' : '',
    entry?.typeKey === 'building' ? 'wall building' : ''
  ];
  return tokens
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function collectEntryGroupSearchTokens(entry, {
  elevationGroupMetadata = {},
  nestedGrouping = false
} = {}) {
  const elevation = Number(entry?.elevation ?? 0);
  const exactKey = String(entry?.elevationKey || elevationGroupKey(elevation)).trim();
  if (!exactKey) return [];
  const keys = nestedGrouping
    ? buildNestedElevationPath(elevation)
    : [exactKey];
  const tokens = [];
  for (const key of keys) {
    const groupName = getElevationGroupName(elevationGroupMetadata, key);
    if (!groupName) continue;
    tokens.push(groupName);
  }
  return tokens;
}

function applyGroupSearchTextToEntries(entries = [], {
  elevationGroupMetadata = {},
  nestedGrouping = false
} = {}) {
  if (!Array.isArray(entries) || !entries.length) return entries;
  for (const entry of entries) {
    if (!entry || entry.preview || entry.marker || entry.separator) continue;
    const baseSearchText = buildTileSearchText(entry);
    const groupTokens = collectEntryGroupSearchTokens(entry, {
      elevationGroupMetadata,
      nestedGrouping
    });
    entry.searchText = [baseSearchText, ...groupTokens]
      .map((value) => String(value ?? '').trim().toLowerCase())
      .filter(Boolean)
      .join(' ');
  }
  return entries;
}

function buildLayerManagerTileEntry(doc, index, { selected = false } = {}) {
  const safeIndex = Number.isFinite(index) ? index : 0;
  const elevation = quantizeElevation(Number(doc?.elevation ?? 0));
  const elevationKey = elevationGroupKey(elevation);
  const id = doc?.id || doc?._id;
  const typeInfo = resolveTileType(doc);
  const entry = {
    id,
    name: computeTileName({ document: doc }, safeIndex),
    elevation,
    elevationKey,
    elevationLabel: formatElevation(elevation),
    sort: Number(doc?.sort ?? 0),
    selected: !!selected,
    hidden: isLayerHidden(doc),
    locked: !!doc?.locked,
    canToggleVisibility: !!doc?.canUserModify?.(game.user, 'update'),
    canToggleLock: !!doc?.canUserModify?.(game.user, 'update'),
    canReorder: !!doc?.canUserModify?.(game.user, 'update'),
    typeIcon: typeInfo.icon,
    typeLabel: typeInfo.label,
    typeKey: typeInfo.key || normalizeTileTypeKey(typeInfo.label) || 'asset',
    hasHsbc: hasTileHsbc(doc),
    hasMask: hasTileMask(doc),
    index: safeIndex
  };
  entry.searchText = buildTileSearchText(entry);
  return entry;
}

function entryMatchesFilterFlag(entry, flag) {
  switch (flag) {
    case 'locked': return !!entry?.locked;
    case 'hidden': return !!entry?.hidden;
    case 'hsbc': return !!entry?.hasHsbc;
    case 'mask': return !!entry?.hasMask;
    default: return false;
  }
}

function entryMatchesParsedSearchClause(entry, parsedQuery) {
  if (!entry || entry.preview || entry.marker || entry.separator) return true;
  if (parsedQuery?.includeTypes?.size && !parsedQuery.includeTypes.has(entry.typeKey)) return false;
  if (parsedQuery?.excludeTypes?.has(entry.typeKey)) return false;
  for (const key of parsedQuery?.includeFlags || []) {
    if (!entryMatchesFilterFlag(entry, key)) return false;
  }
  for (const key of parsedQuery?.excludeFlags || []) {
    if (entryMatchesFilterFlag(entry, key)) return false;
  }
  const haystack = String(entry?.searchText || '').toLowerCase();
  for (const term of parsedQuery?.includeText || []) {
    if (!haystack.includes(term)) return false;
  }
  for (const term of parsedQuery?.excludeText || []) {
    if (haystack.includes(term)) return false;
  }
  return true;
}

function entryMatchesListFilters(entry, sessionState, parsedQuery) {
  if (!entry || entry.preview || entry.marker || entry.separator) return true;
  if (sessionState?.typeFilters instanceof Set && sessionState.typeFilters.size) {
    if (!sessionState.typeFilters.has(entry.typeKey)) return false;
  }
  const chipFlags = sessionState?.flagFilters || {};
  for (const key of LIST_FILTER_FLAG_KEYS) {
    if (!chipFlags[key]) continue;
    if (!entryMatchesFilterFlag(entry, key)) return false;
  }
  const clauses = Array.isArray(parsedQuery?.clauses) && parsedQuery.clauses.length
    ? parsedQuery.clauses
    : [parsedQuery];
  return clauses.some((clause) => entryMatchesParsedSearchClause(entry, clause));
}

function listFiltersActive(sessionState) {
  if (!sessionState) return false;
  if (String(sessionState.searchQuery ?? '').trim()) return true;
  if (sessionState.typeFilters instanceof Set && sessionState.typeFilters.size) return true;
  return LIST_FILTER_FLAG_KEYS.some((key) => !!sessionState.flagFilters?.[key]);
}

function buildSelectionListFilterSignature(sessionState) {
  return JSON.stringify({
    sceneKey: getCurrentSceneSessionKey(),
    searchQuery: String(sessionState?.searchQuery ?? ''),
    typeFilters: sessionState?.typeFilters instanceof Set ? Array.from(sessionState.typeFilters).sort() : [],
    flagFilters: LIST_FILTER_FLAG_KEYS.filter((key) => !!sessionState?.flagFilters?.[key])
  });
}

function invalidateSelectionListFilterCache(reason = 'unknown') {
  selectionFilterState.listFilterSignature = '';
  selectionFilterState.listFilterActive = false;
  selectionFilterState.matchingListTileIds = new Set();
  Logger.debug('LayerManager.selectionFilter.listCache.invalidated', { reason });
}

function getLayerManagerSortedTileDocs() {
  if (!canvas?.ready || !canvas?.tiles) return [];
  const hiddenIds = collectEditedTileIds();
  const tiles = Array.isArray(canvas.tiles.placeables) ? canvas.tiles.placeables : [];
  const placeablesById = new Map();
  for (const tile of tiles) {
    const id = tile?.document?.id || tile?.id;
    if (id) placeablesById.set(id, tile);
  }
  const sceneDocs = canvas?.scene?.tiles ? Array.from(canvas.scene.tiles) : [];
  const sourceDocs = sceneDocs.length
    ? sceneDocs
    : tiles.map((tile) => tile?.document).filter(Boolean);
  return sourceDocs
    .filter((doc) => {
      if (!doc) return false;
      const id = doc?.id || doc?._id;
      if (id && hiddenIds instanceof Set && hiddenIds.has(id)) return false;
      const placeable = id ? placeablesById.get(id) : null;
      if (placeable && placeable.destroyed) return false;
      if (placeable && isTileBeingEdited(placeable, hiddenIds)) return false;
      return true;
    })
    .slice()
    .sort(sortLayerManagerTileDocs);
}

function syncSelectionListFilterCache({ reason = 'unknown', force = false } = {}) {
  const sessionState = getLayerManagerSessionState();
  const signature = buildSelectionListFilterSignature(sessionState);
  const active = listFiltersActive(sessionState);
  if (!force && signature === selectionFilterState.listFilterSignature && active === selectionFilterState.listFilterActive) {
    return {
      active,
      matchingIds: selectionFilterState.matchingListTileIds
    };
  }

  selectionFilterState.listFilterSignature = signature;
  selectionFilterState.listFilterActive = active;
  selectionFilterState.matchingListTileIds = new Set();

  if (!active) {
    Logger.debug('LayerManager.selectionFilter.listCache.synced', {
      reason,
      active: false,
      matchingCount: 0
    });
    return {
      active: false,
      matchingIds: selectionFilterState.matchingListTileIds
    };
  }

  const parsedQuery = parseListSearchQuery(sessionState.searchQuery || '');
  const sortedDocs = getLayerManagerSortedTileDocs();
  const elevationGroupMetadata = getSceneElevationGroupMetadata();
  const nestedGrouping = isNestedLayerManagerGroupingEnabled();
  for (let index = 0; index < sortedDocs.length; index += 1) {
    const doc = sortedDocs[index];
    const entry = buildLayerManagerTileEntry(doc, index);
    applyGroupSearchTextToEntries([entry], {
      elevationGroupMetadata,
      nestedGrouping
    });
    if (!entryMatchesListFilters(entry, sessionState, parsedQuery)) continue;
    if (entry.id) selectionFilterState.matchingListTileIds.add(entry.id);
  }

  Logger.debug('LayerManager.selectionFilter.listCache.synced', {
    reason,
    active: true,
    matchingCount: selectionFilterState.matchingListTileIds.size,
    totalTileCount: sortedDocs.length
  });
  return {
    active: true,
    matchingIds: selectionFilterState.matchingListTileIds
  };
}

function selectionFilterUsesListFilters() {
  if (!selectionFilterState.active || !selectionFilterState.skipFiltered) return false;
  return !!syncSelectionListFilterCache({ reason: 'selection-active-check' }).active;
}

function placeableMatchesSelectionListFilters(placeable) {
  if (!selectionFilterUsesListFilters()) return true;
  const matcher = syncSelectionListFilterCache({ reason: 'placeable-match-check' });
  if (!matcher.active) return true;
  const id = placeable?.document?.id || placeable?.id;
  if (!id) return false;
  return matcher.matchingIds.has(id);
}

function buildFilterChipContext(sessionState) {
  return LIST_FILTER_CHIPS.map((chip) => ({
    ...chip,
    active: chip.kind === 'type'
      ? !!sessionState?.typeFilters?.has?.(chip.key)
      : !!sessionState?.flagFilters?.[chip.key]
  }));
}

function sortLayerManagerRenderEntries(a, b) {
  const elevDiff = (Number(b?.elevation ?? 0) - Number(a?.elevation ?? 0));
  if (elevDiff) return elevDiff;
  const sortDiff = (Number(b?.sort ?? 0) - Number(a?.sort ?? 0));
  if (sortDiff) return sortDiff;
  const aRank = a?.marker ? 2 : (a?.preview ? 1 : 0);
  const bRank = b?.marker ? 2 : (b?.preview ? 1 : 0);
  if (aRank !== bRank) return aRank - bRank;
  const aIndex = Number.isFinite(a?.index) ? a.index : null;
  const bIndex = Number.isFinite(b?.index) ? b.index : null;
  if (aIndex !== null && bIndex !== null && aIndex !== bIndex) return aIndex - bIndex;
  const aKey = String(a?.previewId ?? a?.markerId ?? a?.id ?? '');
  const bKey = String(b?.previewId ?? b?.markerId ?? b?.id ?? '');
  if (aKey && bKey) return aKey.localeCompare(bKey);
  return 0;
}

function sortLayerManagerTileDocs(a, b) {
  const elevDiff = (Number(b?.elevation ?? 0) - Number(a?.elevation ?? 0));
  if (elevDiff) return elevDiff;
  const sortDiff = (Number(b?.sort ?? 0) - Number(a?.sort ?? 0));
  if (sortDiff) return sortDiff;
  const aId = String(a?.id ?? a?._id ?? '');
  const bId = String(b?.id ?? b?._id ?? '');
  if (aId && bId) return aId.localeCompare(bId);
  if (aId) return -1;
  if (bId) return 1;
  return 0;
}

function elevationKeyToUnits(value) {
  const numeric = parseElevationInput(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(quantizeElevation(numeric) * ELEVATION_SCALE);
}

function unitsToElevation(units) {
  const numeric = Number(units);
  if (!Number.isFinite(numeric)) return 0;
  return quantizeElevation(numeric / ELEVATION_SCALE);
}

function ceilingElevationKeyAtPrecision(value, precision) {
  const digits = Number(precision);
  if (!Number.isInteger(digits) || digits < 1 || digits > MAX_ELEVATION_DECIMALS) {
    throw new Error(`Invalid elevation precision: ${precision}`);
  }
  const units = elevationKeyToUnits(value);
  const step = 10 ** (MAX_ELEVATION_DECIMALS - digits);
  const bucketUnits = Math.ceil(units / step) * step;
  return elevationGroupKey(unitsToElevation(bucketUnits));
}

function buildNestedElevationPath(value) {
  const numeric = parseElevationInput(value);
  if (!Number.isFinite(numeric)) return [];
  const path = [];
  let lastKey = null;
  for (let digits = 1; digits <= MAX_ELEVATION_DECIMALS; digits += 1) {
    const key = ceilingElevationKeyAtPrecision(numeric, digits);
    if (!key || key === lastKey) continue;
    path.push(key);
    lastKey = key;
  }
  return path;
}

function createLayerManagerHierarchyNode(key) {
  return {
    key,
    elevation: parseElevationInput(key),
    children: new Map(),
    sortedChildren: [],
    exactEntries: [],
    exactDocs: [],
    matchingExactEntries: [],
    matchingExactDocs: [],
    fullSubtreeDocs: [],
    matchingSubtreeDocs: [],
    hasFullData: false,
    hasMatchingData: false
  };
}

function buildLayerManagerElevationHierarchy({ fullExactGroups = new Map(), matchingExactGroups = new Map() } = {}) {
  const root = createLayerManagerHierarchyNode('__root__');
  const nodeIndex = new Map();
  const ensureNode = (key) => {
    let node = nodeIndex.get(key);
    if (!node) {
      node = createLayerManagerHierarchyNode(key);
      nodeIndex.set(key, node);
    }
    return node;
  };

  for (const [exactKey, group] of fullExactGroups.entries()) {
    const path = buildNestedElevationPath(group?.elevation ?? exactKey);
    if (!path.length) continue;
    let parent = root;
    for (const key of path) {
      const node = ensureNode(key);
      if (!parent.children.has(key)) parent.children.set(key, node);
      else if (parent.children.get(key) !== node) {
        Logger.error('LayerManager.nestedHierarchy.parentCollision', {
          key,
          parentKey: parent.key || null
        });
        throw new Error(`Nested layer manager hierarchy collision at ${key}.`);
      }
      parent = node;
    }
    parent.exactEntries = Array.isArray(group?.entries) ? group.entries.slice() : [];
    parent.exactDocs = Array.isArray(group?.docs) ? group.docs.slice() : [];
  }

  for (const [exactKey, group] of matchingExactGroups.entries()) {
    const node = nodeIndex.get(exactKey);
    if (!node) {
      Logger.error('LayerManager.nestedHierarchy.matchingNodeMissing', {
        elevationKey: exactKey
      });
      continue;
    }
    node.matchingExactEntries = Array.isArray(group?.entries) ? group.entries.slice() : [];
    node.matchingExactDocs = Array.isArray(group?.docs) ? group.docs.slice() : [];
  }

  const annotate = (node) => {
    node.sortedChildren = Array.from(node.children.values())
      .filter(Boolean)
      .sort((a, b) => Number(b?.elevation ?? 0) - Number(a?.elevation ?? 0));
    const fullDocs = node.exactDocs.slice();
    const matchingDocs = node.matchingExactDocs.slice();
    for (const child of node.sortedChildren) {
      annotate(child);
      fullDocs.push(...child.fullSubtreeDocs);
      matchingDocs.push(...child.matchingSubtreeDocs);
    }
    node.fullSubtreeDocs = fullDocs;
    node.matchingSubtreeDocs = matchingDocs;
    node.hasFullData = fullDocs.length > 0;
    node.hasMatchingData = matchingDocs.length > 0;
  };

  for (const child of Array.from(root.children.values())) {
    annotate(child);
  }

  const buildVisibleHierarchy = ({ mode }) => {
    const nodesByKey = new Map();
    const rootKeys = [];
    const modeHasDataKey = mode === 'matching' ? 'hasMatchingData' : 'hasFullData';
    const modeExactEntriesKey = mode === 'matching' ? 'matchingExactEntries' : 'exactEntries';

    const visit = (node, parentKey = null, depth = 0) => {
      if (!node?.[modeHasDataKey]) return;
      const childNodes = node.sortedChildren.filter((child) => child?.[modeHasDataKey]);
      const hasExactEntries = Array.isArray(node?.[modeExactEntriesKey]) && node[modeExactEntriesKey].length > 0;
      if (!hasExactEntries && childNodes.length === 1) {
        visit(childNodes[0], parentKey, depth);
        return;
      }

      const info = {
        key: node.key,
        elevation: node.elevation,
        parentKey,
        depth,
        childKeys: [],
        visibleSubtreeKeys: [],
        isSynthetic: node.exactDocs.length === 0,
        exactEntries: node.exactEntries.slice(),
        exactDocs: node.exactDocs.slice(),
        matchingExactEntries: node.matchingExactEntries.slice(),
        matchingExactDocs: node.matchingExactDocs.slice(),
        fullSubtreeDocs: node.fullSubtreeDocs.slice(),
        matchingSubtreeDocs: node.matchingSubtreeDocs.slice()
      };
      nodesByKey.set(node.key, info);
      if (parentKey) nodesByKey.get(parentKey)?.childKeys?.push?.(node.key);
      else rootKeys.push(node.key);
      for (const child of childNodes) {
        visit(child, node.key, depth + 1);
      }
    };

    const rootChildren = Array.from(root.children.values())
      .filter((child) => child?.[modeHasDataKey])
      .sort((a, b) => Number(b?.elevation ?? 0) - Number(a?.elevation ?? 0));
    for (const child of rootChildren) {
      visit(child);
    }

    const collectSubtreeKeys = (key) => {
      const node = nodesByKey.get(key);
      if (!node) return [];
      const keys = [key];
      for (const childKey of node.childKeys) {
        keys.push(...collectSubtreeKeys(childKey));
      }
      node.visibleSubtreeKeys = keys;
      return keys;
    };
    for (const key of rootKeys) {
      collectSubtreeKeys(key);
    }

    return {
      mode,
      rootKeys,
      nodesByKey,
      visibleKeys: new Set(nodesByKey.keys())
    };
  };

  return {
    exactKeys: new Set(fullExactGroups.keys()),
    root,
    nodeIndex,
    fullVisible: buildVisibleHierarchy({ mode: 'full' }),
    matchingVisible: buildVisibleHierarchy({ mode: 'matching' })
  };
}

function synchronizeElevationGroupMetadataWithHierarchy(metadata = {}, hierarchy = null) {
  const normalized = cloneElevationGroupMetadata(metadata);
  const visibleNodes = hierarchy?.nodesByKey instanceof Map ? hierarchy.nodesByKey : new Map();
  const output = {};
  const staleSyntheticKeys = [];
  for (const [key, value] of Object.entries(normalized)) {
    const name = String(value?.name ?? '').trim();
    if (!name) continue;
    const visibleNode = visibleNodes.get(key) || null;
    if (!visibleNode) {
      if (value?.synthetic === true) staleSyntheticKeys.push(key);
      else output[key] = { name };
      continue;
    }
    output[key] = visibleNode.isSynthetic ? { name, synthetic: true } : { name };
  }
  const currentSerialized = JSON.stringify(serializeElevationGroupMetadata(normalized));
  const nextSerialized = JSON.stringify(serializeElevationGroupMetadata(output));
  return {
    metadata: output,
    staleSyntheticKeys,
    changed: currentSerialized !== nextSerialized
  };
}

function isAltModifierActive() {
  if (_altKeyHeld) return true;
  try {
    return !!game?.keyboard?.isModifierActive?.('ALT');
  } catch (_) {
    return false;
  }
}

function collectEditedTileIds() {
  const hiddenIds = new Set();
  try {
    for (const key of EDITING_TILE_SET_KEYS) {
      const set = globalThis?.[key];
      if (!(set instanceof Set)) continue;
      for (const id of set) {
        if (id) hiddenIds.add(id);
      }
    }

    const buildingSet = globalThis?.__faNexusBuildingEditingTileIds;
    if (!(buildingSet instanceof Set) || !buildingSet.size) return hiddenIds;

    const wallGroupIds = new Set();
    const primaryIds = new Set();
    const tiles = canvas?.scene?.tiles
      ? Array.from(canvas.scene.tiles)
      : (Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables.map(tile => tile?.document).filter(Boolean) : []);

    for (const doc of tiles) {
      const id = doc?.id;
      if (!id || !buildingSet.has(id)) continue;
      primaryIds.add(id);
      hiddenIds.add(id);
      const data = doc.getFlag?.('fa-nexus', 'building');
      const meta = data?.meta || {};
      if (meta?.wallGroupId) wallGroupIds.add(meta.wallGroupId);
      if (meta?.fillTileId) hiddenIds.add(meta.fillTileId);
    }

    if (!wallGroupIds.size && !primaryIds.size) return hiddenIds;

    for (const doc of tiles) {
      const id = doc?.id;
      if (!id || hiddenIds.has(id)) continue;
      const data = doc.getFlag?.('fa-nexus', 'building');
      if (data) {
        const meta = data?.meta || {};
        if (meta?.parentWallTileId && primaryIds.has(meta.parentWallTileId)) {
          hiddenIds.add(id);
          continue;
        }
        if (meta?.parentWallGroupId && wallGroupIds.has(meta.parentWallGroupId)) {
          hiddenIds.add(id);
          continue;
        }
        if (meta?.wallGroupId && wallGroupIds.has(meta.wallGroupId)) {
          hiddenIds.add(id);
          continue;
        }
      }
      const door = doc.getFlag?.('fa-nexus', 'buildingDoorFrame');
      if (door?.wallGroupId && wallGroupIds.has(door.wallGroupId)) {
        hiddenIds.add(id);
        continue;
      }
      const sill = doc.getFlag?.('fa-nexus', 'buildingWindowSill');
      const window = doc.getFlag?.('fa-nexus', 'buildingWindowWindow');
      const frame = doc.getFlag?.('fa-nexus', 'buildingWindowFrame');
      const windowFlag = sill || window || frame;
      if (windowFlag?.wallGroupId && wallGroupIds.has(windowFlag.wallGroupId)) {
        hiddenIds.add(id);
      }
    }

    return hiddenIds;
  } catch (_) {
    return hiddenIds;
  }
}

function isTileBeingEdited(tile, hiddenIds) {
  try {
    const id = tile?.document?.id || tile?.id;
    if (!id) return false;
    if (hiddenIds instanceof Set) return hiddenIds.has(id);
    for (const key of EDITING_TILE_SET_KEYS) {
      const set = globalThis?.[key];
      if (set instanceof Set && set.has(id)) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

function isTilesLayerActive() {
  try {
    return !!canvas?.tiles && canvas?.activeLayer === canvas.tiles;
  } catch (_) {
    return false;
  }
}

function forceHideEditedTile(tile) {
  try {
    if (!tile || tile.destroyed) return;
    if (!isTileBeingEdited(tile)) return;
    try { tile.visible = false; } catch (_) {}
    try { tile.alpha = 0; } catch (_) {}
    if (tile.mesh && tile.mesh.visible !== false) {
      try { tile.mesh.visible = false; } catch (_) {}
    }
    if (tile.bg && tile.bg.visible !== false) {
      try { tile.bg.visible = false; } catch (_) {}
    }
    if (tile.frame) {
      try { if (tile.frame.border) tile.frame.border.visible = false; } catch (_) {}
      try { if (tile.frame.handle) tile.frame.handle.visible = false; } catch (_) {}
    }
    if (typeof tile.eventMode !== 'undefined') {
      try { tile.eventMode = 'none'; } catch (_) {}
    }
  } catch (_) {}
}

function restoreEditedTileFrame(tile) {
  try {
    if (!tile || tile.destroyed) return;
    if (isTileBeingEdited(tile)) return;
    if (isLayerHidden(tile?.document)) return;
    if (tile.frame && tile.frame.visible === false) {
      try { tile.frame.visible = true; } catch (_) {}
    }
  } catch (_) {}
}

function shouldSuppressTileHover() {
  return !!selectionFilterState.active && isAltModifierActive() && isTilesLayerActive();
}

function clearTileHover() {
  const hover = canvas?.tiles?.hover;
  if (!hover) return;
  try { hover._onHoverOut?.(hoverEventStub); } catch (_) {}
}

function setAltKeyHeld(active) {
  const next = !!active;
  if (_altKeyHeld === next) return;
  _altKeyHeld = next;
  if (!selectionFilterState.active) return;
  if (shouldSuppressTileHover()) {
    clearTileHover();
    try { canvas?.highlightObjects?.(false); } catch (_) {}
  }
}

function getForegroundElevation() {
  try {
    const fg = canvas?.scene?.foregroundElevation ?? canvas?.scene?._source?.foregroundElevation;
    const numeric = Number(fg);
    if (Number.isFinite(numeric)) return numeric;
  } catch (_) {}
  try {
    const gridDistance = Number(canvas?.scene?.grid?.distance || 0);
    if (Number.isFinite(gridDistance)) return gridDistance * 4;
  } catch (_) {}
  return 0;
}

function sceneHasBackgroundImage() {
  try {
    const scene = canvas?.scene;
    const raw = scene?.background?.src
      ?? scene?.background?.texture?.src
      ?? scene?._source?.background?.src
      ?? scene?._source?.background?.texture?.src;
    return !!String(raw ?? '').trim();
  } catch (_) {
    return false;
  }
}

function sceneHasForegroundImage() {
  try {
    const scene = canvas?.scene;
    const raw = scene?.foreground
      ?? scene?.foreground?.src
      ?? scene?._source?.foreground
      ?? scene?._source?.foreground?.src;
    return !!String(raw ?? '').trim();
  } catch (_) {
    return false;
  }
}

function resolveBackgroundBaseElevation() {
  const extract = (target) => {
    if (!target) return null;
    const base = Number(target.faNexusBgBandBaseElevation);
    return Number.isFinite(base) ? base : null;
  };
  const roots = [];
  if (canvas?.primary?.background) roots.push(canvas.primary.background);
  if (canvas?.background) roots.push(canvas.background);
  for (const root of roots) {
    const direct = extract(root);
    if (direct !== null) return direct;
    const candidates = [root.mesh, root.sprite, root.background, root._background];
    for (const candidate of candidates) {
      const base = extract(candidate);
      if (base !== null) return base;
    }
  }
  return null;
}

function resolveBackgroundRenderElevation() {
  const allowOverride = isKeepTokensAboveTileElevationsEnabled();
  if (allowOverride) {
    const sceneOverride = Number(canvas?.scene?.[BG_RENDER_OVERRIDE_KEY]);
    if (Number.isFinite(sceneOverride)) return sceneOverride;
  }
  const extract = (target) => {
    if (!target) return null;
    if (allowOverride) {
      const override = Number(target[BG_RENDER_OVERRIDE_KEY]);
      if (Number.isFinite(override)) return override;
    }
    const elevation = Number(target.elevation);
    return Number.isFinite(elevation) ? elevation : null;
  };
  const roots = [];
  if (canvas?.primary?.background) roots.push(canvas.primary.background);
  if (canvas?.background) roots.push(canvas.background);
  for (const root of roots) {
    const direct = extract(root);
    if (direct !== null) return direct;
    const candidates = [root.mesh, root.sprite, root.background, root._background];
    for (const candidate of candidates) {
      const value = extract(candidate);
      if (value !== null) return value;
    }
  }
  return null;
}

function getBackgroundElevation() {
  try {
    const render = resolveBackgroundRenderElevation();
    if (render !== null) return render;
    const base = resolveBackgroundBaseElevation();
    if (base !== null) return base;
    const bg = canvas?.scene?.background?.elevation
      ?? canvas?.scene?.backgroundElevation
      ?? canvas?.scene?._source?.backgroundElevation;
    if (bg === null || bg === undefined || bg === '') return 0;
    const numeric = Number(bg);
    return Number.isFinite(numeric) ? numeric : 0;
  } catch (_) {
    return 0;
  }
}

function getBackgroundDisplayElevation() {
  const render = getBackgroundElevation();
  if (!Number.isFinite(render)) return render;
  if (!isKeepTokensAboveTileElevationsEnabled()) return render;
  return quantizeElevation(render + 1);
}

function setBackgroundRenderElevation(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return;
  try {
    if (canvas?.scene) canvas.scene[BG_RENDER_OVERRIDE_KEY] = numeric;
  } catch (_) {}
  const targets = [];
  if (canvas?.primary?.background) targets.push(canvas.primary.background);
  if (canvas?.background) targets.push(canvas.background);
  const apply = (target) => {
    if (!target) return;
    try { target[BG_RENDER_OVERRIDE_KEY] = numeric; } catch (_) {}
    try { if ('elevation' in target) target.elevation = numeric; } catch (_) {}
  };
  for (const target of targets) {
    apply(target);
    apply(target.mesh);
    apply(target.sprite);
    apply(target.background);
    apply(target._background);
  }
  try { if (canvas?.primary) canvas.primary.sortDirty = true; } catch (_) {}
}

function readSetting(key) {
  try { return game?.settings?.get?.(MODULE_ID, key) ?? ''; } catch (_) { return ''; }
}

function writeSetting(key, value) {
  try { return game?.settings?.set?.(MODULE_ID, key, value); } catch (_) { return null; }
}

function getElevationRangeFromSettings() {
  const minRaw = readSetting(RANGE_MIN_SETTING);
  const maxRaw = readSetting(RANGE_MAX_SETTING);
  const skipLocked = !!readSetting(SKIP_LOCKED_SETTING);
  const skipHidden = !!readSetting(SKIP_HIDDEN_SETTING);
  const skipFiltered = !!readSetting(SKIP_FILTERED_SETTING);
  const ignoreForeground = !!readSetting(IGNORE_FOREGROUND_SETTING);
  return {
    minRaw,
    maxRaw,
    min: parseElevationInput(minRaw),
    max: parseElevationInput(maxRaw),
    skipLocked,
    skipHidden,
    skipFiltered,
    ignoreForeground
  };
}

function readFaFlag(doc, key) {
  try {
    const direct = doc?.getFlag?.(MODULE_ID, key);
    if (direct !== undefined) return direct;
  } catch (_) {}
  const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
  return flags ? flags[key] : null;
}

function isLayerHidden(doc) {
  return !!readFaFlag(doc, LAYER_HIDDEN_FLAG);
}

function isTileHidden(doc) {
  if (!doc) return false;
  return isLayerHidden(doc);
}

function setLayerHidden(doc, hidden) {
  if (!doc) return;
  try {
    if (hidden) {
      if (typeof doc.setFlag === 'function') {
        doc.setFlag(MODULE_ID, LAYER_HIDDEN_FLAG, true);
      } else {
        doc.update({ [`flags.${MODULE_ID}.${LAYER_HIDDEN_FLAG}`]: true });
      }
      return;
    }
    if (typeof doc.unsetFlag === 'function') {
      doc.unsetFlag(MODULE_ID, LAYER_HIDDEN_FLAG);
    } else {
      doc.update({ [`flags.${MODULE_ID}.${LAYER_HIDDEN_FLAG}`]: false });
    }
  } catch (_) {}
}

function resolveTileType(doc) {
  if (!doc) return { icon: 'fa-solid fa-image', label: 'Asset', key: 'asset' };
  if (readFaFlag(doc, 'assetScatter')) return { icon: 'fa-solid fa-braille', label: 'Scatter', key: 'scatter' };
  if (readFaFlag(doc, 'building')) return { icon: 'fa-solid fa-building', label: 'Wall/Building', key: 'building' };
  if (readFaFlag(doc, 'pathsV2') || readFaFlag(doc, 'pathV2') || readFaFlag(doc, 'path')) {
    return { icon: 'fa-solid fa-route', label: 'Path', key: 'path' };
  }
  if (readFaFlag(doc, 'maskedTiling')) return { icon: 'fa-solid fa-paint-roller', label: 'Texture', key: 'texture' };
  return { icon: 'fa-solid fa-image', label: 'Asset', key: 'asset' };
}

function syncSelectionFilterFromSettings() {
  const { min, max, skipLocked, skipHidden, skipFiltered, ignoreForeground } = getElevationRangeFromSettings();
  const wasIgnoreForeground = selectionFilterState.ignoreForeground;
  const wasSkipLocked = selectionFilterState.skipLocked;
  const wasSkipHidden = selectionFilterState.skipHidden;
  const wasSkipFiltered = selectionFilterState.skipFiltered;
  selectionFilterState.min = min;
  selectionFilterState.max = max;
  selectionFilterState.skipLocked = !!skipLocked;
  selectionFilterState.skipHidden = !!skipHidden;
  selectionFilterState.skipFiltered = !!skipFiltered;
  const nextIgnoreForeground = true;
  if (!ignoreForeground) writeSetting(IGNORE_FOREGROUND_SETTING, true);
  selectionFilterState.ignoreForeground = nextIgnoreForeground;
  if (wasSkipFiltered !== selectionFilterState.skipFiltered) invalidateSelectionListFilterCache('settings-sync');
  if (
    wasIgnoreForeground !== nextIgnoreForeground
    || wasSkipLocked !== selectionFilterState.skipLocked
    || wasSkipHidden !== selectionFilterState.skipHidden
    || wasSkipFiltered !== selectionFilterState.skipFiltered
  ) {
    refreshTileInteractionState();
  }
}

function selectionFilterActive() {
  return !!selectionFilterState.active && (
    Number.isFinite(selectionFilterState.min)
    || Number.isFinite(selectionFilterState.max)
    || !!selectionFilterState.skipLocked
    || !!selectionFilterState.skipHidden
    || selectionFilterUsesListFilters()
  );
}

function selectionIgnoresForeground() {
  return !!selectionFilterState.active && !!selectionFilterState.ignoreForeground;
}

function canSelectPlaceable(placeable, { ignoreForeground = false, filterActive = false } = {}) {
  if (!placeable) return false;
  if (ignoreForeground) {
    if (!placeable.visible || !placeable.renderable) return false;
  }
  if (filterActive) {
    const elevation = Number(placeable?.document?.elevation ?? 0);
    if (!elevationInRange(elevation)) return false;
    if (selectionFilterState.skipLocked) {
      const doc = placeable?.document;
      const sourceLocked = typeof doc?._source?.locked === 'boolean' ? doc._source.locked : null;
      const locked = sourceLocked !== null ? sourceLocked : !!doc?.locked;
      if (locked) return false;
    }
    if (selectionFilterState.skipHidden && isTileHidden(placeable?.document)) return false;
    if (selectionFilterState.skipFiltered && !placeableMatchesSelectionListFilters(placeable)) return false;
  }
  return true;
}

function elevationInRange(value) {
  if (!selectionFilterActive()) return true;
  if (!Number.isFinite(value)) return false;
  if (Number.isFinite(selectionFilterState.min) && value < selectionFilterState.min) return false;
  if (Number.isFinite(selectionFilterState.max) && value > selectionFilterState.max) return false;
  return true;
}

function refreshTileInteractionState() {
  if (!canvas?.ready || !canvas?.tiles?.setAllRenderFlags) return;
  try { canvas.tiles.setAllRenderFlags({ refreshState: true }); } catch (_) {}
}

function getMouseInteractionManager() {
  return globalThis?.foundry?.canvas?.interaction?.MouseInteractionManager || globalThis?.MouseInteractionManager || null;
}

function scheduleSelectionFilterRefresh({
  reason = 'unknown',
  source = 'unknown',
  tileIds = null,
  resyncSettings = true
} = {}) {
  const normalizedTileIds = Array.isArray(tileIds)
    ? [...new Set(tileIds.filter((id) => typeof id === 'string' && id.trim()))]
    : [];
  const targetIds = normalizedTileIds.length ? new Set(normalizedTileIds) : null;

  const refresh = () => {
    try {
      if (!canvas?.ready || !canvas?.tiles) return;
      if (resyncSettings) syncSelectionFilterFromSettings();
      const filterActive = selectionFilterActive();
      const ignoreForeground = selectionIgnoresForeground();
      const tiles = Array.isArray(canvas.tiles.placeables) ? canvas.tiles.placeables : [];
      for (const tile of tiles) {
        const id = tile?.document?.id || tile?.id;
        if (targetIds && !targetIds.has(id)) continue;
        try { requestTileRefresh(tile); } catch (_) {}
        try { forceHideEditedTile(tile); } catch (_) {}
        try { restoreEditedTileFrame(tile); } catch (_) {}
        applySelectionFilterInteractivity(tile, { ignoreForeground, filterActive });
      }
      refreshTileInteractionState();
      pruneSelectionForFilter();
      try { getMouseInteractionManager()?.emulateMoveEvent?.(); } catch (_) {}
      Logger.info('LayerManager.selectionFilter.refresh', {
        reason,
        source,
        tileIds: normalizedTileIds,
        active: selectionFilterState.active,
        filterActive,
        ignoreForeground,
        skipFiltered: selectionFilterState.skipFiltered
      });
    } catch (error) {
      Logger.error('LayerManager.selectionFilter.refresh.failed', {
        reason,
        source,
        tileIds: normalizedTileIds,
        error: String(error?.message || error)
      });
    }
  };

  refresh();
  try { queueMicrotask(() => refresh()); } catch (_) {}
  try {
    const root = globalThis?.window ?? globalThis;
    root?.requestAnimationFrame?.(() => refresh());
  } catch (_) {}
  try { setTimeout(() => refresh(), 80); } catch (_) {}
  try { setTimeout(() => refresh(), 180); } catch (_) {}
}

function ensureSelectionFilterRefreshHook() {
  if (selectionFilterHookState.hooksBound) return;
  selectionFilterHookState.hooksBound = true;
  const hooks = globalThis?.Hooks;
  if (!hooks?.on) return;
  try {
    hooks.on('fa-nexus-selection-filter-refresh', (options = {}) => {
      scheduleSelectionFilterRefresh(options);
    });
  } catch (error) {
    Logger.error('LayerManager.selectionFilter.hook.failed', {
      error: String(error?.message || error)
    });
  }
}

function pruneSelectionForFilter() {
  if (!selectionFilterActive()) return;
  const selection = Array.isArray(canvas?.tiles?.controlled) ? canvas.tiles.controlled : [];
  if (!selection.length) return;
  const filterActive = selectionFilterActive();
  const ignoreForeground = selectionIgnoresForeground();
  for (const tile of selection) {
    if (canSelectPlaceable(tile, { ignoreForeground, filterActive })) continue;
    try { tile?.release?.(); } catch (_) {}
  }
}

function applySelectionFilterInteractivity(tile, { ignoreForeground = false, filterActive = false } = {}) {
  if (!tile) return;
  const blocked = !!filterActive && !canSelectPlaceable(tile, { ignoreForeground, filterActive });
  const wasBlocked = !!tile[SELECTION_FILTER_BLOCK_KEY];
  if (!blocked) {
    if (wasBlocked) {
      tile[SELECTION_FILTER_BLOCK_KEY] = false;
      if (typeof tile.interactiveChildren !== 'undefined') {
        try { tile.interactiveChildren = true; } catch (_) {}
      }
    }
    return;
  }
  tile[SELECTION_FILTER_BLOCK_KEY] = true;
  if (typeof tile.interactiveChildren !== 'undefined') {
    try { tile.interactiveChildren = false; } catch (_) {}
  }
  if (tile.eventMode !== 'none') {
    try { tile.eventMode = 'none'; } catch (_) {}
    const mouseManager = globalThis?.foundry?.canvas?.interaction?.MouseInteractionManager || globalThis?.MouseInteractionManager;
    try { mouseManager?.emulateMoveEvent?.(); } catch (_) {}
  }
}

function ensureTileSelectionPatch() {
  const TilesLayer = globalThis?.foundry?.canvas?.layers?.TilesLayer || canvas?.tiles?.constructor;
  if (!TilesLayer?.prototype?.selectObjects) return;
  if (TilesLayer.prototype._faNexusSelectObjectsPatched) return;
  TilesLayer.prototype._faNexusSelectObjectsPatched = true;
  const original = TilesLayer.prototype.selectObjects;
  TilesLayer.prototype._faNexusSelectObjectsOriginal = original;

  TilesLayer.prototype.selectObjects = function ({ x, y, width, height, releaseOptions = {}, controlOptions = {} } = {}, { releaseOthers = true } = {}) {
    const filterActive = selectionFilterActive();
    const ignoreForeground = selectionIgnoresForeground();
    if (!filterActive && !ignoreForeground) return original.call(this, { x, y, width, height, releaseOptions, controlOptions }, { releaseOthers });
    if (!this.options.controllableObjects) return false;

    const oldSet = new Set(this.controlled);
    const newSet = new Set();
    const rectangle = new PIXI.Rectangle(x, y, width, height);

    const placeables = ignoreForeground ? this.placeables : this.controllableObjects();
    for (const placeable of placeables) {
      if (!canSelectPlaceable(placeable, { ignoreForeground, filterActive })) continue;
      if (placeable._overlapsSelection(rectangle)) newSet.add(placeable);
    }

    const toRelease = oldSet.difference(newSet);
    if (releaseOthers) toRelease.forEach(placeable => placeable.release(releaseOptions));

    if (foundry.utils.isEmpty(controlOptions)) controlOptions.releaseOthers = false;
    const toControl = newSet.difference(oldSet);
    toControl.forEach(placeable => placeable.control(controlOptions));

    return (releaseOthers && (toRelease.size > 0)) || (toControl.size > 0);
  };
}

function ensureTileSelectAllPatch() {
  const TilesLayer = globalThis?.foundry?.canvas?.layers?.TilesLayer || canvas?.tiles?.constructor;
  if (!TilesLayer?.prototype?._onSelectAllKey) return;
  if (TilesLayer.prototype._faNexusSelectAllPatched) return;
  TilesLayer.prototype._faNexusSelectAllPatched = true;
  const original = TilesLayer.prototype._onSelectAllKey;
  TilesLayer.prototype._faNexusSelectAllOriginal = original;

  TilesLayer.prototype._onSelectAllKey = function (event) {
    const filterActive = selectionFilterActive();
    const ignoreForeground = selectionIgnoresForeground();
    if (!filterActive && !ignoreForeground) return original.call(this, event);
    if (!this.options.controllableObjects) return false;

    const oldSet = new Set(this.controlled);
    const newSet = new Set();
    const placeables = ignoreForeground ? this.placeables : this.controllableObjects();

    for (const placeable of placeables) {
      if (!canSelectPlaceable(placeable, { ignoreForeground, filterActive })) continue;
      newSet.add(placeable);
    }

    const toRelease = oldSet.difference(newSet);
    toRelease.forEach(placeable => placeable.release());

    const toControl = newSet.difference(oldSet);
    const controlOptions = { releaseOthers: false };
    toControl.forEach(placeable => placeable.control(controlOptions));

    return true;
  };
}

function ensureTileForegroundSelectionPatch() {
  const Tile = globalThis?.foundry?.canvas?.placeables?.Tile
    || canvas?.tiles?.constructor?.placeableClass
    || globalThis?.CONFIG?.Tile?.objectClass;
  if (!Tile?.prototype?._refreshState) return;
  if (Tile.prototype._faNexusIgnoreForegroundPatched) return;
  Tile.prototype._faNexusIgnoreForegroundPatched = true;
  const original = Tile.prototype._refreshState;
  Tile.prototype._faNexusIgnoreForegroundOriginal = original;

  Tile.prototype._refreshState = function (...args) {
    const filterActive = selectionFilterActive();
    const ignoreForeground = selectionIgnoresForeground();
    if (!ignoreForeground) {
      const result = original.apply(this, args);
      try { forceHideEditedTile(this); } catch (_) {}
      try { restoreEditedTileFrame(this); } catch (_) {}
      applySelectionFilterInteractivity(this, { ignoreForeground, filterActive });
      return result;
    }
    const fgTool = ui?.controls?.control?.tools?.foreground;
    if (!fgTool || typeof fgTool.active !== 'boolean') {
      const result = original.apply(this, args);
      if (this.layer?.active && this.eventMode !== 'static') this.eventMode = 'static';
      try { forceHideEditedTile(this); } catch (_) {}
      try { restoreEditedTileFrame(this); } catch (_) {}
      applySelectionFilterInteractivity(this, { ignoreForeground, filterActive });
      return result;
    }
    const prev = fgTool.active;
    const overhead = Number(this.document?.elevation ?? 0) >= Number(this.document?.parent?.foregroundElevation ?? 0);
    fgTool.active = overhead;
    try {
      const result = original.apply(this, args);
      try { forceHideEditedTile(this); } catch (_) {}
      try { restoreEditedTileFrame(this); } catch (_) {}
      applySelectionFilterInteractivity(this, { ignoreForeground, filterActive });
      return result;
    } finally {
      fgTool.active = prev;
    }
  };
}

function ensureTileHoverSuppressionPatch() {
  const Tile = globalThis?.foundry?.canvas?.placeables?.Tile
    || canvas?.tiles?.constructor?.placeableClass
    || globalThis?.CONFIG?.Tile?.objectClass;
  if (!Tile?.prototype?._onHoverIn) return;
  if (Tile.prototype._faNexusHoverSuppressionPatched) return;
  Tile.prototype._faNexusHoverSuppressionPatched = true;
  const original = Tile.prototype._onHoverIn;
  Tile.prototype._faNexusHoverSuppressionOriginal = original;

  Tile.prototype._onHoverIn = function (...args) {
    if (shouldSuppressTileHover()) return;
    return original.apply(this, args);
  };
}

function ensureCanvasHighlightSuppressionPatch() {
  const Canvas = globalThis?.foundry?.canvas?.Canvas || canvas?.constructor;
  if (!Canvas?.prototype?.highlightObjects) return;
  if (Canvas.prototype._faNexusHighlightSuppressionPatched) return;
  Canvas.prototype._faNexusHighlightSuppressionPatched = true;
  const original = Canvas.prototype.highlightObjects;
  Canvas.prototype._faNexusHighlightSuppressionOriginal = original;

  Canvas.prototype.highlightObjects = function (active) {
    if (active && shouldSuppressTileHover()) return;
    return original.call(this, active);
  };
}

function applyLayerHiddenState(tile) {
  if (!tile || tile.destroyed) return;
  const doc = tile.document;
  if (!isLayerHidden(doc)) return;
  if (tile.mesh && tile.mesh.visible !== false) {
    try { tile.mesh.visible = false; } catch (_) {}
  }
  if (tile.bg && tile.bg.visible !== false) {
    try { tile.bg.visible = false; } catch (_) {}
  }
  if (tile.frame && tile.frame.visible !== false) {
    try { tile.frame.visible = false; } catch (_) {}
  }
  if (typeof tile.eventMode !== 'undefined') {
    try { tile.eventMode = 'none'; } catch (_) {}
  }
}

function restoreLayerHiddenState(tile) {
  if (!tile || tile.destroyed) return;
  const doc = tile.document;
  if (isLayerHidden(doc)) return;
  if (tile.mesh && tile.mesh.visible === false) {
    try { tile.mesh.visible = tile.isVisible; } catch (_) {}
  }
  if (tile.bg && tile.bg.visible === false) {
    try { tile.bg.visible = !!tile.layer?.active; } catch (_) {}
  }
  if (tile.frame && tile.frame.visible === false) {
    try { tile.frame.visible = true; } catch (_) {}
  }
}

function hasLayerHiddenChange(changes) {
  if (!changes?.flags) return false;
  const scoped = changes.flags[MODULE_ID];
  if (scoped === null) return true;
  if (!scoped) return false;
  if (Object.prototype.hasOwnProperty.call(scoped, LAYER_HIDDEN_FLAG)) return true;
  const unsetKey = `-=${LAYER_HIDDEN_FLAG}`;
  return Object.prototype.hasOwnProperty.call(scoped, unsetKey);
}

function requestTileRefresh(tile) {
  try { tile?.renderFlags?.set?.({ refreshState: true }); } catch (_) {}
}

function handleLayerHiddenUpdate(doc, changes) {
  const tile = doc?.object;
  if (!tile) return;
  const hiddenNow = isLayerHidden(doc);
  if (hasLayerHiddenChange(changes)) requestTileRefresh(tile);
  if (hiddenNow) applyLayerHiddenState(tile);
  else restoreLayerHiddenState(tile);
}

function applyLayerHiddenToCanvas() {
  if (!canvas?.ready || !canvas?.tiles) return;
  const placeables = Array.isArray(canvas.tiles.placeables) ? canvas.tiles.placeables : [];
  for (const tile of placeables) {
    if (isLayerHidden(tile?.document)) applyLayerHiddenState(tile);
    else restoreLayerHiddenState(tile);
  }
}

function ensureLayerHiddenHooks() {
  if (layerHiddenState.hooksBound) return;
  layerHiddenState.hooksBound = true;
  const hooks = globalThis?.Hooks;
  if (hooks && typeof hooks.on === 'function') {
    try { hooks.on('drawTile', (tile) => applyLayerHiddenState(tile)); } catch (_) {}
    try { hooks.on('refreshTile', (tile) => applyLayerHiddenState(tile)); } catch (_) {}
    try { hooks.on('updateTile', (doc, changes) => handleLayerHiddenUpdate(doc, changes)); } catch (_) {}
    try { hooks.on('controlTile', (tile) => applyLayerHiddenState(tile)); } catch (_) {}
    try { hooks.on('canvasReady', () => applyLayerHiddenToCanvas()); } catch (_) {}
  }
  if (canvas?.ready) queueMicrotask(() => applyLayerHiddenToCanvas());
}

function computeTileName(tile, index) {
  const doc = tile?.document;
  const explicitName = readFaFlag(doc, 'name');
  if (explicitName !== null && explicitName !== undefined && String(explicitName).trim()) {
    return String(explicitName).trim();
  }
  const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
  const legacyLabel = flags?.label || doc?.name || doc?.label;
  if (legacyLabel) return String(legacyLabel);
  const masked = readFaFlag(doc, 'maskedTiling');
  if (masked?.baseColor) return 'Solid Color';
  const src = String(doc?.texture?.src || '').trim();
  if (src) {
    const filename = src.split('/').pop() || src;
    const base = filename.replace(/\.[^/.]+$/, '');
    return base || filename;
  }
  return `Tile ${index + 1}`;
}

function resolvePreviewElevation(container) {
  if (!container) return 0;
  const candidate = Number(
    container.faNexusPathPreviewElevation
    ?? container.faNexusElevationDoc
    ?? container.elevation
    ?? 0
  );
  return quantizeElevation(candidate);
}

function resolvePreviewSort(container) {
  if (!container) return 0;
  const candidate = Number(container.faNexusSort ?? container.sort ?? container.zIndex ?? 0);
  return Number.isFinite(candidate) ? candidate : 0;
}

function buildPreviewEntry(container, { label, icon, kind, previewActiveOverride }) {
  if (!container || container.destroyed) return null;
  const elevation = resolvePreviewElevation(container);
  const previewActive = previewActiveOverride !== undefined
    ? !!previewActiveOverride
    : !!container?.faNexusPreviewActive;
  return {
    preview: true,
    previewId: `${kind}-${container?.faNexusPathPreviewKey || container?.faNexusScatterPreviewKey || container?.name || String(elevation)}`,
    previewActive,
    name: label,
    elevation,
    elevationKey: elevationGroupKey(elevation),
    sort: resolvePreviewSort(container),
    typeIcon: icon,
    typeLabel: label
  };
}

function buildSceneMarkerEntry(kind, elevation) {
  const numeric = Number(elevation);
  if (!Number.isFinite(numeric)) return null;
  const label = kind === 'foreground' ? 'Scene Foreground' : 'Scene Background';
  const icon = kind === 'foreground' ? 'fa-solid fa-layer-group' : 'fa-solid fa-image';
  return {
    marker: true,
    markerKind: kind,
    markerId: `scene-${kind}`,
    name: label,
    elevation: quantizeElevation(numeric),
    elevationKey: elevationGroupKey(numeric),
    sort: Number.NEGATIVE_INFINITY,
    typeIcon: icon,
    typeLabel: label
  };
}

function collectPreviewEntries() {
  if (!canvas?.ready) return [];
  const roots = new Set();
  if (canvas?.primary) roots.add(canvas.primary);
  if (canvas?.stage) roots.add(canvas.stage);
  const entries = [];
  const seen = new Set();
  const scatterCandidates = [];
  const buildingPreviewRoots = [];
  const buildingFillRoots = [];
  let scatterEntries = 0;
  const shouldInclude = (container) => !!container?.faNexusPreviewActive || !!container?.faNexusPreviewHasContent;
  const push = (container, meta) => {
    if (!container || container.destroyed) return;
    if (seen.has(container)) return;
    const entry = buildPreviewEntry(container, meta);
    if (entry) {
      entries.push(entry);
      seen.add(container);
      if (meta?.kind === 'scatter-preview') scatterEntries += 1;
    }
  };
  const pushScatterCandidate = (container) => {
    if (!container || container.destroyed) return;
    scatterCandidates.push(container);
  };
  const pushBuildingRoot = (container, collection) => {
    if (!container || container.destroyed) return;
    collection.push(container);
  };
  const walk = (container, depth = 0) => {
    if (!container || container.destroyed) return;
    if (container.faNexusScatterPreview) {
      if (shouldInclude(container)) {
        push(container, { label: 'Scatter Preview', icon: 'fa-solid fa-braille', kind: 'scatter-preview' });
      } else {
        pushScatterCandidate(container);
      }
    } else if (container.faNexusPathPreview) {
      if (shouldInclude(container)) {
        push(container, { label: 'Path Preview', icon: 'fa-solid fa-route', kind: 'path-preview' });
      }
    } else if (container.faNexusTexturePreview) {
      if (shouldInclude(container)) {
        push(container, { label: 'Texture Preview', icon: 'fa-solid fa-paint-roller', kind: 'texture-preview' });
      }
    } else if (container.name === 'fa-nexus-building-preview-root') {
      pushBuildingRoot(container, buildingPreviewRoots);
    } else if (container.name === 'fa-nexus-building-fill-preview-root') {
      pushBuildingRoot(container, buildingFillRoots);
    }
    if (depth >= 3) return;
    const children = Array.isArray(container.children) ? container.children : [];
    for (const child of children) {
      walk(child, depth + 1);
    }
  };
  for (const root of roots) {
    walk(root, 0);
  }

  const buildingManagerActive = (() => {
    try {
      return !!globalThis?.faNexus?.premiumFeatures?.buildingEditor?.activeManager?.isActive;
    } catch (_) {
      return false;
    }
  })();
  const buildingActive = buildingManagerActive || [...buildingPreviewRoots, ...buildingFillRoots].some(
    (container) => !!container?.faNexusPreviewActive
  );
  for (const container of buildingPreviewRoots) {
    push(container, {
      label: 'Building Preview',
      icon: 'fa-solid fa-building',
      kind: 'building-preview',
      previewActiveOverride: buildingActive ? true : undefined
    });
  }
  for (const container of buildingFillRoots) {
    push(container, {
      label: 'Building Fill Preview',
      icon: 'fa-solid fa-fill-drip',
      kind: 'building-fill-preview',
      previewActiveOverride: buildingActive ? true : undefined
    });
  }

  if (!scatterEntries && scatterCandidates.length) {
    let fallback = scatterCandidates[0];
    for (const candidate of scatterCandidates) {
      if (!candidate || candidate.destroyed) continue;
      if (resolvePreviewSort(candidate) > resolvePreviewSort(fallback)) {
        fallback = candidate;
      }
    }
    push(fallback, {
      label: 'Scatter Preview',
      icon: 'fa-solid fa-braille',
      kind: 'scatter-preview',
      previewActiveOverride: true
    });
  }

  return entries;
}

function buildEntriesFromCanvas(options = {}) {
  const sessionState = options?.sessionState || getLayerManagerSessionState();
  const parsedQuery = options?.parsedQuery || parseListSearchQuery(sessionState?.searchQuery || '');
  const rawElevationGroupMetadata = options?.elevationGroupMetadata || getSceneElevationGroupMetadata();
  const nestedGrouping = isNestedLayerManagerGroupingEnabled();
  const filtersApplied = listFiltersActive(sessionState);
  const emptyHierarchy = {
    rootKeys: [],
    nodesByKey: new Map(),
    visibleKeys: new Set()
  };
  if (!canvas?.ready || !canvas?.tiles) {
    return {
      entries: [],
      matchingTileIdsByElevation: new Map(),
      fullTileDocsById: new Map(),
      fullTileIdsInOrder: [],
      fullElevationGroups: new Map(),
      fullGroupDocsByKey: new Map(),
      fullGroupHierarchy: emptyHierarchy,
      matchingGroupHierarchy: emptyHierarchy,
      elevationGroupMetadata: rawElevationGroupMetadata,
      elevationGroupMetadataDirty: false,
      staleSyntheticMetadataKeys: [],
      nestedGrouping,
      filtersApplied,
      totalTileCount: 0,
      matchingTileCount: 0
    };
  }
  const sortedDocs = getLayerManagerSortedTileDocs();
  const controlled = new Set((canvas.tiles.controlled || []).map(tile => tile.document?.id || tile.id));
  const fullTileDocsById = new Map();
  const fullTileIdsInOrder = [];
  const fullExactGroups = new Map();
  const tileEntries = [];
  for (let i = 0; i < sortedDocs.length; i += 1) {
    const doc = sortedDocs[i];
    const entry = buildLayerManagerTileEntry(doc, i, {
      selected: controlled.has(doc?.id || doc?._id)
    });
    const elevation = entry.elevation;
    const elevationKey = entry.elevationKey;
    const id = entry.id;
    if (id) {
      fullTileDocsById.set(id, doc);
      fullTileIdsInOrder.push(id);
    }
    let fullGroup = fullExactGroups.get(elevationKey);
    if (!fullGroup) {
      fullGroup = {
        key: elevationKey,
        elevation,
        entries: [],
        docs: []
      };
      fullExactGroups.set(elevationKey, fullGroup);
    }
    fullGroup.docs.push(doc);
    tileEntries.push(entry);
    fullGroup.entries.push(entry);
  }

  applyGroupSearchTextToEntries(tileEntries, {
    elevationGroupMetadata: rawElevationGroupMetadata,
    nestedGrouping
  });

  const matchingTileEntries = tileEntries.filter((entry) => entryMatchesListFilters(entry, sessionState, parsedQuery));
  const matchingExactGroups = new Map();
  for (const entry of matchingTileEntries) {
    const key = entry.elevationKey;
    let group = matchingExactGroups.get(key);
    if (!group) {
      group = {
        key,
        elevation: Number(entry.elevation ?? 0),
        entries: [],
        docs: []
      };
      matchingExactGroups.set(key, group);
    }
    group.entries.push(entry);
    const doc = fullTileDocsById.get(entry.id);
    if (doc) group.docs.push(doc);
  }

  const previewEntries = collectPreviewEntries();
  const hasBackground = sceneHasBackgroundImage();
  const hasForeground = sceneHasForegroundImage();
  const foregroundElevation = getForegroundElevation();
  const backgroundElevation = hasBackground ? getBackgroundDisplayElevation() : null;
  const markerEntries = [];
  if (hasBackground) {
    const entry = buildSceneMarkerEntry('background', backgroundElevation);
    if (entry) markerEntries.push(entry);
  }
  if (hasForeground) {
    const entry = buildSceneMarkerEntry('foreground', foregroundElevation);
    if (entry) markerEntries.push(entry);
  }
  const supplementalEntries = previewEntries.concat(markerEntries).sort(sortLayerManagerRenderEntries);
  const fullElevationGroups = new Map(
    Array.from(fullExactGroups.entries()).map(([key, group]) => [key, group.docs.slice()])
  );
  const entries = [];
  const matchingTileIdsByElevation = new Map();
  const fullGroupDocsByKey = new Map();
  let elevationGroupMetadata = rawElevationGroupMetadata;
  let elevationGroupMetadataDirty = false;
  let staleSyntheticMetadataKeys = [];
  let fullGroupHierarchy = emptyHierarchy;
  let matchingGroupHierarchy = emptyHierarchy;

  if (nestedGrouping) {
    const hierarchy = buildLayerManagerElevationHierarchy({
      fullExactGroups,
      matchingExactGroups
    });
    const metadataSync = synchronizeElevationGroupMetadataWithHierarchy(rawElevationGroupMetadata, hierarchy.fullVisible);
    elevationGroupMetadata = metadataSync.metadata;
    elevationGroupMetadataDirty = metadataSync.changed;
    staleSyntheticMetadataKeys = metadataSync.staleSyntheticKeys.slice();
    fullGroupHierarchy = hierarchy.fullVisible;
    matchingGroupHierarchy = hierarchy.matchingVisible;

    for (const [key, node] of hierarchy.fullVisible.nodesByKey.entries()) {
      fullGroupDocsByKey.set(key, node.fullSubtreeDocs.slice());
    }
    for (const [key, node] of hierarchy.matchingVisible.nodesByKey.entries()) {
      matchingTileIdsByElevation.set(key, node.matchingSubtreeDocs.map((doc) => doc?.id).filter(Boolean));
    }

    const exactSupplementalsByGroupKey = new Map();
    const orphanSupplementalsByGroupKey = new Map();
    const topLevelSupplementals = new Map();
    const visibleGroupKeys = hierarchy.matchingVisible.visibleKeys;
    const attachSupplemental = (targetMap, ownerKey, item) => {
      if (!ownerKey) return;
      let exactMap = targetMap.get(ownerKey);
      if (!exactMap) {
        exactMap = new Map();
        targetMap.set(ownerKey, exactMap);
      }
      const exactKey = String(item?.elevationKey || '').trim() || elevationGroupKey(item?.elevation ?? 0);
      let block = exactMap.get(exactKey);
      if (!block) {
        block = {
          elevation: Number(item?.elevation ?? 0),
          items: []
        };
        exactMap.set(exactKey, block);
      }
      block.items.push(item);
    };
    const findVisibleAncestorKey = (item) => {
      const path = buildNestedElevationPath(item?.elevation ?? 0);
      let nearest = null;
      for (const key of path) {
        if (!visibleGroupKeys.has(key)) continue;
        nearest = key;
      }
      return nearest;
    };

    for (const item of supplementalEntries) {
      const exactKey = String(item?.elevationKey || '').trim() || elevationGroupKey(item?.elevation ?? 0);
      if (visibleGroupKeys.has(exactKey)) {
        attachSupplemental(exactSupplementalsByGroupKey, exactKey, item);
        continue;
      }
      const ancestorKey = findVisibleAncestorKey(item);
      if (ancestorKey) {
        attachSupplemental(orphanSupplementalsByGroupKey, ancestorKey, item);
        continue;
      }
      attachSupplemental(topLevelSupplementals, '__root__', item);
    }

    const materializeSupplementalBlocks = (blockMap = null) => {
      if (!(blockMap instanceof Map)) return [];
      return Array.from(blockMap.values())
        .map((block) => ({
          elevation: Number(block?.elevation ?? 0),
          items: (Array.isArray(block?.items) ? block.items.slice() : []).sort(sortLayerManagerRenderEntries)
        }))
        .sort((a, b) => Number(b?.elevation ?? 0) - Number(a?.elevation ?? 0));
    };
    const applyTreeDepth = (items, depth) => items.map((item) => ({
      ...item,
      treeDepth: depth,
      indentPx: depth * 12
    }));

    const renderGroupBlock = (groupKey) => {
      const node = hierarchy.matchingVisible.nodesByKey.get(groupKey);
      if (!node) return null;
      const matchingDocs = node.matchingSubtreeDocs.filter(Boolean);
      const groupName = getElevationGroupName(elevationGroupMetadata, groupKey);
      const blockEntries = [{
        separator: true,
        elevation: formatElevation(node.elevation),
        elevationValue: node.elevation,
        elevationKey: groupKey,
        groupHasCustomName: !!groupName,
        groupName: groupName || '',
        groupDisplayName: groupName || `Elev ${formatElevation(node.elevation)}`,
        groupHidden: matchingDocs.length ? matchingDocs.every((doc) => isLayerHidden(doc)) : false,
        groupLocked: matchingDocs.length ? matchingDocs.every((doc) => !!doc?.locked) : false,
        canToggleVisibility: matchingDocs.some((doc) => doc?.canUserModify?.(game.user, 'update')),
        matchingCount: matchingDocs.length,
        collapsed: !!sessionState?.collapsedElevations?.has?.(groupKey),
        treeDepth: node.depth,
        indentPx: node.depth * 12,
        groupSynthetic: !!node.isSynthetic,
        hasChildGroups: node.childKeys.length > 0
      }];
      if (sessionState?.collapsedElevations?.has?.(groupKey)) {
        return {
          elevation: node.elevation,
          entries: blockEntries
        };
      }

      const childBlocks = [];
      const exactItems = node.matchingExactEntries
        .concat((materializeSupplementalBlocks(exactSupplementalsByGroupKey.get(groupKey))[0]?.items || []))
        .sort(sortLayerManagerRenderEntries);
      if (exactItems.length) {
        childBlocks.push({
          elevation: node.elevation,
          entries: applyTreeDepth(exactItems, node.depth + 1)
        });
      }

      for (const orphanBlock of materializeSupplementalBlocks(orphanSupplementalsByGroupKey.get(groupKey))) {
        childBlocks.push({
          elevation: orphanBlock.elevation,
          entries: applyTreeDepth(orphanBlock.items, node.depth + 1)
        });
      }

      for (const childKey of node.childKeys) {
        const childBlock = renderGroupBlock(childKey);
        if (childBlock) childBlocks.push(childBlock);
      }

      childBlocks.sort((a, b) => Number(b?.elevation ?? 0) - Number(a?.elevation ?? 0));
      for (const childBlock of childBlocks) {
        blockEntries.push(...childBlock.entries);
      }
      return {
        elevation: node.elevation,
        entries: blockEntries
      };
    };

    const topLevelBlocks = [];
    for (const rootKey of hierarchy.matchingVisible.rootKeys) {
      const block = renderGroupBlock(rootKey);
      if (block) topLevelBlocks.push(block);
    }
    for (const topLevelBlock of materializeSupplementalBlocks(topLevelSupplementals.get('__root__'))) {
      topLevelBlocks.push({
        elevation: topLevelBlock.elevation,
        entries: applyTreeDepth(topLevelBlock.items, 0)
      });
    }
    topLevelBlocks.sort((a, b) => Number(b?.elevation ?? 0) - Number(a?.elevation ?? 0));
    for (const block of topLevelBlocks) {
      entries.push(...block.entries);
    }
  } else {
    for (const [key, docs] of fullElevationGroups.entries()) {
      fullGroupDocsByKey.set(key, Array.isArray(docs) ? docs.slice() : []);
    }
    const matchingElevationGroups = new Map();
    for (const [key, group] of matchingExactGroups.entries()) {
      const matchingDocs = group.docs.filter(Boolean);
      matchingElevationGroups.set(key, {
        entries: group.entries.slice(),
        docs: matchingDocs,
        canToggleVisibility: matchingDocs.some((doc) => doc?.canUserModify?.(game.user, 'update')),
        collapsed: !!sessionState?.collapsedElevations?.has?.(key),
        groupHidden: matchingDocs.length ? matchingDocs.every((doc) => isLayerHidden(doc)) : false,
        groupLocked: matchingDocs.length ? matchingDocs.every((doc) => !!doc?.locked) : false,
        matchingCount: matchingDocs.length,
        groupName: getElevationGroupName(elevationGroupMetadata, key)
      });
      matchingTileIdsByElevation.set(key, matchingDocs.map((doc) => doc?.id).filter(Boolean));
      fullGroupDocsByKey.set(key, fullElevationGroups.get(key)?.slice?.() || []);
    }

    const items = matchingTileEntries.concat(supplementalEntries).sort(sortLayerManagerRenderEntries);
    let lastElevationKey = null;
    for (const item of items) {
      const elevation = Number(item.elevation ?? 0);
      const key = elevationGroupKey(elevation);
      if (lastElevationKey === null || key !== lastElevationKey) {
        const group = matchingElevationGroups.get(key);
        if (group) {
          entries.push({
            separator: true,
            elevation: formatElevation(elevation),
            elevationValue: elevation,
            elevationKey: key,
            groupHasCustomName: !!group.groupName,
            groupName: group.groupName || '',
            groupDisplayName: group.groupName || `Elev ${formatElevation(elevation)}`,
            groupHidden: group.groupHidden,
            groupLocked: group.groupLocked,
            canToggleVisibility: !!group.canToggleVisibility && group.matchingCount > 0,
            matchingCount: group.matchingCount,
            collapsed: !!group.collapsed,
            treeDepth: 0,
            indentPx: 0,
            groupSynthetic: false,
            hasChildGroups: false
          });
        }
        lastElevationKey = key;
      }
      if (matchingElevationGroups.get(key)?.collapsed) continue;
      entries.push({
        ...item,
        treeDepth: 0,
        indentPx: 0
      });
    }
  }

  if (Number.isFinite(foregroundElevation)) {
    const foregroundEntry = {
      separator: true,
      foregroundSeparator: true,
      foregroundElevation: formatElevation(foregroundElevation),
      foregroundElevationValue: foregroundElevation,
      elevationKey: elevationGroupKey(foregroundElevation)
    };
    const insertIndex = entries.findIndex((entry) => (
      Number(
        entry?.separator && !entry?.foregroundSeparator
          ? entry.elevationValue
          : entry?.elevation
      ) < foregroundElevation
    ));
    if (insertIndex === -1) entries.push(foregroundEntry);
    else entries.splice(insertIndex, 0, foregroundEntry);
  }
  return {
    entries,
    matchingTileIdsByElevation,
    fullTileDocsById,
    fullTileIdsInOrder,
    fullElevationGroups,
    elevationGroupMetadata,
    elevationGroupMetadataDirty,
    staleSyntheticMetadataKeys,
    fullGroupDocsByKey,
    fullGroupHierarchy,
    matchingGroupHierarchy,
    nestedGrouping,
    filtersApplied,
    totalTileCount: tileEntries.length,
    matchingTileCount: matchingTileEntries.length
  };
}

function insertTabAfterScenes() {
  const tabs = Sidebar.TABS;
  if (tabs[TAB_ID]) return;
  const descriptor = {
    tooltip: 'FA-NEXUS.LayerManager',
    icon: 'fa-solid fa-layer-group',
    gmOnly: true
  };
  const entries = Object.entries(tabs);
  const next = [];
  let inserted = false;
  for (const [key, value] of entries) {
    next.push([key, value]);
    if (key === 'scenes') {
      next.push([TAB_ID, descriptor]);
      inserted = true;
    }
  }
  if (!inserted) next.push([TAB_ID, descriptor]);
  Sidebar.TABS = Object.fromEntries(next);
}

function registerLayerManagerTab() {
  try {
    insertTabAfterScenes();
    if (!CONFIG.ui[TAB_ID]) CONFIG.ui[TAB_ID] = LayerManagerTab;
    syncSelectionFilterFromSettings();
    ensureSelectionFilterRefreshHook();
    ensureTileSelectionPatch();
    ensureTileSelectAllPatch();
    ensureTileForegroundSelectionPatch();
    ensureTileHoverSuppressionPatch();
    ensureCanvasHighlightSuppressionPatch();
    ensureLayerHiddenHooks();
  } catch (error) {
    Logger.warn('LayerManager.register.failed', { error: String(error?.message || error) });
  }
}

class LayerManagerHelpWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    foundry.utils.deepClone(super.DEFAULT_OPTIONS ?? {}),
    {
      id: 'fa-nexus-layer-manager-help',
      tag: 'section',
      position: { width: 460, height: 'auto' },
      window: {
        title: 'Layer Manager Help',
        icon: 'fas fa-circle-question',
        minimizable: true,
        resizable: true
      },
      classes: ['fa-nexus-tool-help-window']
    },
    { inplace: false }
  );

  static PARTS = foundry.utils.mergeObject(
    foundry.utils.deepClone(super.PARTS ?? {}),
    {
      body: { template: 'modules/fa-nexus/templates/tool-help-modal.hbs' }
    },
    { inplace: false }
  );

  constructor({ owner = null, helpContext = {} } = {}) {
    super();
    this._owner = owner;
    this._helpContext = helpContext && typeof helpContext === 'object' ? helpContext : {};
  }

  setHelpContext(helpContext = {}, { suppressRender = false } = {}) {
    this._helpContext = helpContext && typeof helpContext === 'object' ? helpContext : {};
    if (this.rendered && !suppressRender) this.render(false);
  }

  _resolveWindowTitle() {
    const label = typeof this._helpContext?.toolLabel === 'string' ? this._helpContext.toolLabel.trim() : '';
    return label ? `${label} Help` : 'Layer Manager Help';
  }

  _syncWindowTitle() {
    const title = this._resolveWindowTitle();
    try {
      if (!this.options.window || typeof this.options.window !== 'object') this.options.window = {};
      this.options.window.title = title;
    } catch (_) {}
    try {
      const appWindow = this.window;
      if (appWindow) {
        if (typeof appWindow.setTitle === 'function') appWindow.setTitle(title);
        else appWindow.title = title;
      }
    } catch (_) {}
    try {
      const headerTitle = this.element?.querySelector('.window-title');
      if (headerTitle) headerTitle.textContent = title;
    } catch (_) {}
  }

  async _prepareContext() {
    const help = this._helpContext && typeof this._helpContext === 'object' ? this._helpContext : {};
    return {
      toolLabel: typeof help.toolLabel === 'string' ? help.toolLabel : '',
      summary: typeof help.summary === 'string' ? help.summary : '',
      selectionSummary: help.selectionSummary ?? null,
      dirty: !!help.dirty,
      sections: Array.isArray(help.sections) ? help.sections : [],
      shortcuts: Array.isArray(help.shortcuts) ? help.shortcuts : [],
      notes: Array.isArray(help.notes) ? help.notes : []
    };
  }

  _onRender(initial, ctx) {
    super._onRender(initial, ctx);
    this._syncWindowTitle();
  }

  _onClose(options = {}) {
    try { this._owner?._handleHelpWindowClosed?.(this); } catch (_) {}
    return super._onClose(options);
  }
}

export class LayerManagerTab extends HandlebarsApplicationMixin(AbstractSidebarTab) {
  static tabName = TAB_ID;

  static DEFAULT_OPTIONS = {
    id: TAB_ID,
    classes: ['fa-nexus-layer-manager'],
    actions: {}
  };

  static PARTS = {
    content: {
      template: 'modules/fa-nexus/templates/layer-manager-tab.hbs',
      scrollable: ['.fa-nexus-layer-manager__list']
    }
  };

  constructor(options = {}) {
    super(options);
    this._hookIds = [];
    this._lastClickedIndex = -1;
    this._lastClickedTileId = null;
    this._hoveredTileId = null;
    this._scrollQueued = false;
    this._scrollTargetId = null;
    this._scrollPreviewQueued = false;
    this._scrollPreviewTargetId = null;
    this._lastActivePreviewId = null;
    this._lastContextClick = { id: null, time: 0 };
    this._wheelSession = null;
    this._selectedSceneMarkers = new Set();
    this._lastElevationAnnounce = 0;
    this._elevationAnnounceTimer = null;
    this._pendingElevationAnnouncePoint = null;
    this._pendingElevationAnnounceMessage = null;
    this._renamingTileId = null;
    this._renameDraft = '';
    this._renameFocusPending = false;
    this._renameSubmitting = false;
    this._editingElevationGroupNameKey = null;
    this._editingElevationGroupNameDraft = '';
    this._editingElevationGroupNameFocusPending = false;
    this._editingElevationGroupElevationKey = null;
    this._editingElevationGroupElevationDraft = '';
    this._editingElevationGroupElevationFocusPending = false;
    this._editingElevationGroupSubmitting = false;
    this._elevationGroupMetadataSyncPending = false;
    this._viewState = null;
    this._dragState = null;
    this._dropIndicator = null;
    this._contextMenuCleanup = null;
    this._pendingSeparatorSelectTimer = null;
    this._helpWindow = null;
    this._searchFocusPending = false;
    this._searchSelectionStart = null;
    this._searchSelectionEnd = null;
  }

  get title() {
    return game.i18n.localize('FA-NEXUS.LayerManager');
  }

  _onActivate() {
    this._setActiveClass(true);
    this._setFilterActive(true);
    this._ensureHooks();
    this._startWheelSession();
    this._clearHover();
    this._activateTilesLayer();
    this.render({ force: true });
  }

  _onDeactivate() {
    this._setActiveClass(false);
    this._setFilterActive(false);
    this._closeContextMenu();
    this._clearPendingSeparatorSelection();
    this._clearHover();
    this._clearRenameState();
    this._clearElevationGroupEditState();
    this._clearDropIndicator();
    this._dragState = null;
    this._stopWheelSession();
    this._clearElevationAnnounceTimer();
    this._selectedSceneMarkers?.clear?.();
    this._removeHooks();
  }

  async _prepareContext() {
    const { minRaw, maxRaw, skipLocked, skipHidden, skipFiltered, ignoreForeground } = getElevationRangeFromSettings();
    const sessionState = getLayerManagerSessionState();
    const parsedQuery = parseListSearchQuery(sessionState.searchQuery || '');
    const flattenState = this._getFlattenState();
    const elevationGroupMetadata = getSceneElevationGroupMetadata();
    const viewState = buildEntriesFromCanvas({ sessionState, parsedQuery, elevationGroupMetadata });
    if (selectionFilterState.skipFiltered) syncSelectionListFilterCache({ reason: 'prepare-context' });
    const entries = viewState.entries;
    this._viewState = viewState;
    if (viewState?.elevationGroupMetadataDirty) {
      this._queueElevationGroupMetadataSync(viewState.elevationGroupMetadata);
    }
    let renameFound = false;
    let groupNameEditFound = false;
    let groupElevationEditFound = false;
    for (const entry of entries) {
      if (entry?.separator && !entry?.foregroundSeparator) {
        if (entry.elevationKey === this._editingElevationGroupNameKey) {
          entry.editingGroupName = true;
          entry.groupNameValue = this._editingElevationGroupNameDraft;
          groupNameEditFound = true;
        }
        if (entry.elevationKey === this._editingElevationGroupElevationKey) {
          entry.editingGroupElevation = true;
          entry.groupElevationValue = this._editingElevationGroupElevationDraft || formatElevation(entry.elevationValue);
          groupElevationEditFound = true;
        }
      }
      if (!entry?.id || entry?.preview || entry?.marker || entry?.separator) continue;
      if (entry.id !== this._renamingTileId) continue;
      entry.editing = true;
      entry.renameValue = this._renameDraft;
      renameFound = true;
      break;
    }
    if (this._renamingTileId && !renameFound) {
      this._renamingTileId = null;
      this._renameDraft = '';
      this._renameFocusPending = false;
    }
    if (this._editingElevationGroupNameKey && !groupNameEditFound) {
      this._clearElevationGroupNameEditState();
    }
    if (this._editingElevationGroupElevationKey && !groupElevationEditFound) {
      this._clearElevationGroupElevationEditState();
    }
    if (this._selectedSceneMarkers?.size) {
      for (const entry of entries) {
        if (!entry?.marker) continue;
        entry.selected = this._selectedSceneMarkers.has(entry.markerKind);
      }
    }
    const selectionActionState = this._getSelectionActionState();
    const matchingGroupKeys = this._getMatchingElevationGroupKeys(viewState);
    const collapsedMatchingGroupCount = matchingGroupKeys.filter((key) => sessionState?.collapsedElevations?.has?.(key)).length;
    return {
      canvasReady: !!canvas?.ready,
      elevationMin: minRaw,
      elevationMax: maxRaw,
      skipLocked,
      skipHidden,
      skipFiltered,
      ignoreForeground,
      selectionOptionsCollapsed: !!sessionState.selectionOptionsCollapsed,
      searchQuery: sessionState.searchQuery,
      filterChips: buildFilterChipContext(sessionState),
      resetFiltersDisabled: !listFiltersActive(sessionState),
      collapseAllDisabled: !matchingGroupKeys.length || collapsedMatchingGroupCount === matchingGroupKeys.length,
      expandAllDisabled: !matchingGroupKeys.length || collapsedMatchingGroupCount === 0,
      selectionActionTitle: selectionActionState.lockTitle,
      selectionActionDisabled: selectionActionState.lockDisabled,
      deleteSelectionDisabled: selectionActionState.deleteDisabled,
      flattenVisible: flattenState.visible,
      flattenDisabled: flattenState.disabled,
      flattenLabel: flattenState.label,
      flattenAriaLabel: flattenState.ariaLabel,
      flattenAction: flattenState.action,
      flattenIconClass: flattenState.iconClass,
      entries
    };
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this._setActiveClass(this.active);
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this._closeContextMenu();
    const root = this.element;
    if (!root) return;
    const list = root.querySelector('.fa-nexus-layer-manager__list');
    const searchInput = root.querySelector('input[data-action="search-layers"]');
    const resetFiltersButton = root.querySelector('button[data-action="reset-filters"]');
    const collapseAllButton = root.querySelector('button[data-action="collapse-all-groups"]');
    const expandAllButton = root.querySelector('button[data-action="expand-all-groups"]');
    const selectionLockButton = root.querySelector('button[data-action="toggle-selection-lock"]');
    const selectionDeleteButton = root.querySelector('button[data-action="delete-selection"]');
    const minInput = root.querySelector('input[data-range="min"]');
    const maxInput = root.querySelector('input[data-range="max"]');
    const skipLockedInput = root.querySelector('input[data-action="skip-locked"]');
    const skipHiddenInput = root.querySelector('input[data-action="skip-hidden"]');
    const skipFilteredInput = root.querySelector('input[data-action="skip-filtered"]');
    const flattenButton = root.querySelector('button[data-action="flatten"]');
    const renameInput = root.querySelector('.fa-nexus-layer-manager__rename-input');
    const groupNameInput = root.querySelector('.fa-nexus-layer-manager__separator-group-name-input');
    const groupElevationInput = root.querySelector('.fa-nexus-layer-manager__separator-group-elevation-input');
    const selectionOptionsToggle = root.querySelector('button[data-action="toggle-selection-options"]');
    const helpButton = root.querySelector('button[data-action="open-help"]');

    if (selectionOptionsToggle) {
      selectionOptionsToggle.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._toggleSelectionOptions();
      });
    }

    if (helpButton) {
      helpButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._openLayerManagerHelp();
      });
    }

    if (list) {
      list.addEventListener('click', (event) => this._onListClick(event));
      list.addEventListener('dblclick', (event) => this._onListDoubleClick(event));
      list.addEventListener('contextmenu', (event) => this._onListContextMenu(event));
      list.addEventListener('mouseover', (event) => this._onListHover(event));
      list.addEventListener('mouseleave', () => this._clearHover());
      list.addEventListener('wheel', (event) => this._onListWheel(event), { passive: false });
      list.addEventListener('dragstart', (event) => this._onListDragStart(event));
      list.addEventListener('dragover', (event) => this._onListDragOver(event));
      list.addEventListener('dragleave', (event) => this._onListDragLeave(event));
      list.addEventListener('drop', (event) => this._onListDrop(event));
      list.addEventListener('dragend', (event) => this._onListDragEnd(event));
    }

    if (searchInput) {
      searchInput.addEventListener('input', (event) => this._onSearchInput(event));
    }

    if (resetFiltersButton) {
      resetFiltersButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._resetListFilters();
      });
    }

    if (collapseAllButton) {
      collapseAllButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._collapseAllElevationGroups();
      });
    }

    if (expandAllButton) {
      expandAllButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._expandAllElevationGroups();
      });
    }

    for (const chipButton of root.querySelectorAll('button[data-action="toggle-filter-chip"]')) {
      chipButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._toggleFilterChip(chipButton);
      });
    }

    if (selectionLockButton) {
      selectionLockButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._toggleSelectionLock();
      });
    }

    if (selectionDeleteButton) {
      selectionDeleteButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._deleteSelection();
      });
    }

    if (minInput) {
      minInput.addEventListener('change', () => this._onRangeChange());
      minInput.addEventListener('input', () => this._onRangeChange(true));
    }

    if (maxInput) {
      maxInput.addEventListener('change', () => this._onRangeChange());
      maxInput.addEventListener('input', () => this._onRangeChange(true));
    }

    if (skipLockedInput) {
      skipLockedInput.addEventListener('change', () => this._onSkipLockedChange());
    }

    if (skipHiddenInput) {
      skipHiddenInput.addEventListener('change', () => this._onSkipHiddenChange());
    }

    if (skipFilteredInput) {
      skipFilteredInput.addEventListener('change', () => this._onSkipFilteredChange());
    }

    if (flattenButton) {
      if (flattenButton._faNexusFlattenHandler) {
        flattenButton.removeEventListener('click', flattenButton._faNexusFlattenHandler);
      }
      const handler = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const manager = getTileFlattenManager();
        const state = this._getFlattenState();
        this._updateFlattenFooter();
        if (state.action === 'deconstruct') {
          const selection = TileFlattenManager.getSelectedTiles();
          const doc = Array.isArray(selection) ? selection[0] : null;
          if (!doc) return;
          manager.confirmAndDeconstructTile(doc).catch((error) => {
            Logger.warn('LayerManager.deconstruct.failed', { error: String(error?.message || error) });
            ui?.notifications?.error?.(`Failed to deconstruct tile: ${error?.message || error}`);
          }).finally(() => {
            this._updateFlattenFooter();
          });
          return;
        }
        if (state.action === 'export') {
          manager.showExportDialog().catch((error) => {
            Logger.warn('LayerManager.export.failed', { error: String(error?.message || error) });
            ui?.notifications?.error?.(`Failed to export scene: ${error?.message || error}`);
          }).finally(() => {
            this._updateFlattenFooter();
          });
          return;
        }
        manager.showFlattenDialog().catch((error) => {
          Logger.warn('LayerManager.flatten.failed', { error: String(error?.message || error) });
          ui?.notifications?.error?.(`Failed to flatten tiles: ${error?.message || error}`);
        }).finally(() => {
          this._updateFlattenFooter();
        });
      };
      flattenButton._faNexusFlattenHandler = handler;
      flattenButton.addEventListener('click', handler);
    }

    if (renameInput) {
      renameInput.addEventListener('click', (event) => event.stopPropagation());
      renameInput.addEventListener('dblclick', (event) => event.stopPropagation());
      renameInput.addEventListener('contextmenu', (event) => event.stopPropagation());
      renameInput.addEventListener('input', (event) => {
        this._renameDraft = event.currentTarget?.value ?? '';
      });
      renameInput.addEventListener('keydown', (event) => this._onRenameInputKeyDown(event));
      renameInput.addEventListener('blur', (event) => {
        this._commitRename(event.currentTarget).catch((error) => {
          Logger.warn('LayerManager.rename.failed', { error: String(error?.message || error) });
          ui?.notifications?.error?.(`Failed to rename tile: ${error?.message || error}`);
        });
      });
      if (this._renameFocusPending) {
        this._renameFocusPending = false;
        requestAnimationFrame(() => {
          try {
            renameInput.focus();
            renameInput.select();
          } catch (_) {}
        });
      }
    }

    if (groupNameInput) {
      groupNameInput.addEventListener('click', (event) => event.stopPropagation());
      groupNameInput.addEventListener('dblclick', (event) => event.stopPropagation());
      groupNameInput.addEventListener('contextmenu', (event) => event.stopPropagation());
      groupNameInput.addEventListener('input', (event) => {
        this._editingElevationGroupNameDraft = event.currentTarget?.value ?? '';
      });
      groupNameInput.addEventListener('keydown', (event) => this._onElevationGroupNameInputKeyDown(event));
      groupNameInput.addEventListener('blur', (event) => {
        this._commitElevationGroupNameEdit(event.currentTarget).catch((error) => {
          Logger.error('LayerManager.elevationGroup.rename.failed', {
            elevationKey: this._editingElevationGroupNameKey || null,
            error: String(error?.message || error)
          });
          ui?.notifications?.error?.(`Failed to rename elevation group: ${error?.message || error}`);
        });
      });
      if (this._editingElevationGroupNameFocusPending) {
        this._editingElevationGroupNameFocusPending = false;
        requestAnimationFrame(() => {
          try {
            groupNameInput.focus();
            groupNameInput.select();
          } catch (_) {}
        });
      }
    }

    if (groupElevationInput) {
      groupElevationInput.addEventListener('click', (event) => event.stopPropagation());
      groupElevationInput.addEventListener('dblclick', (event) => event.stopPropagation());
      groupElevationInput.addEventListener('contextmenu', (event) => event.stopPropagation());
      groupElevationInput.addEventListener('input', (event) => {
        this._editingElevationGroupElevationDraft = event.currentTarget?.value ?? '';
      });
      groupElevationInput.addEventListener('keydown', (event) => this._onElevationGroupElevationInputKeyDown(event));
      groupElevationInput.addEventListener('blur', (event) => {
        this._commitElevationGroupElevationEdit(event.currentTarget).catch((error) => {
          Logger.error('LayerManager.elevationGroup.move.failed', {
            elevationKey: this._editingElevationGroupElevationKey || null,
            error: String(error?.message || error)
          });
          ui?.notifications?.error?.(`Failed to move elevation group: ${error?.message || error}`);
        });
      });
      if (this._editingElevationGroupElevationFocusPending) {
        this._editingElevationGroupElevationFocusPending = false;
        requestAnimationFrame(() => {
          try {
            groupElevationInput.focus();
            groupElevationInput.select();
          } catch (_) {}
        });
      }
    }

    if (searchInput && this._searchFocusPending) {
      this._searchFocusPending = false;
      const start = Number.isInteger(this._searchSelectionStart) ? this._searchSelectionStart : searchInput.value.length;
      const end = Number.isInteger(this._searchSelectionEnd) ? this._searchSelectionEnd : searchInput.value.length;
      try {
        searchInput.focus({ preventScroll: true });
        searchInput.setSelectionRange(start, end);
      } catch (_) {}
      this._searchSelectionStart = null;
      this._searchSelectionEnd = null;
    }

    this._updateSelectionActions();
    this._updateFlattenFooter();
    this._syncPreviewScroll();
    this._syncHelpWindow({ suppressRender: false });
  }

  _getFlattenState() {
    const selection = TileFlattenManager.getSelectedTiles();
    const rawCount = Array.isArray(selection) ? selection.length : 0;
    const flattenableSelection = TileFlattenManager.getFlattenableTiles(selection);
    const count = Array.isArray(flattenableSelection) ? flattenableSelection.length : 0;
    const singleDoc = rawCount === 1 ? selection[0] : null;
    const singleFlattened = !!singleDoc && TileFlattenManager.isFlattenedTile(singleDoc);
    const singleMerged = count === 1 && TileFlattenManager.isMergedTile(flattenableSelection[0]);
    const allowExport = rawCount === 0;
    const allowFlatten = !singleFlattened && count >= 1;
    const visible = allowExport || allowFlatten || singleFlattened;
    const manager = getTileFlattenManager();
    const busy = manager?.isBusy ? manager.isBusy() : false;
    const action = singleFlattened ? 'deconstruct' : (allowExport ? 'export' : 'flatten');
    const label = singleFlattened
      ? 'Deconstruct flattened tile'
      : (action === 'export'
        ? 'Export / Flatten Scene'
        : (count > 1
          ? `Flatten ${count} selected tile${count === 1 ? '' : 's'}`
          : (singleMerged ? 'Flatten merged tile' : 'Flatten selected tile')));
    const ariaLabel = singleFlattened
      ? 'Deconstruct flattened tile in FA Nexus'
      : (action === 'export'
        ? 'Export or flatten scene in FA Nexus'
        : (count > 1
          ? `Flatten ${count} selected tile${count === 1 ? '' : 's'} in FA Nexus`
          : (singleMerged ? 'Flatten merged tile in FA Nexus' : 'Flatten selected tile in FA Nexus')));
    const iconClass = singleFlattened
      ? 'fa-object-ungroup'
      : (action === 'export' ? 'fa-file-export' : 'fa-compress-arrows-alt');
    const canvasReady = !!canvas?.ready;
    return {
      visible,
      disabled: !visible || busy || !canvasReady,
      label,
      ariaLabel,
      count,
      action,
      iconClass
    };
  }

  _updateFlattenFooter() {
    const root = this.element;
    if (!root) return;
    const footer = root.querySelector('.fa-nexus-layer-manager__footer');
    const button = root.querySelector('button[data-action="flatten"]');
    if (!footer || !button) return;
    const state = this._getFlattenState();
    if (state.visible) footer.removeAttribute('hidden');
    else footer.setAttribute('hidden', 'hidden');
    button.disabled = state.disabled;
    button.classList.toggle('disabled', state.disabled);
    const label = state.label || 'Flatten tiles';
    const labelEl = button.querySelector('.fa-nexus-layer-manager__flatten-label');
    if (labelEl) labelEl.textContent = label;
    const iconEl = button.querySelector('.fa-nexus-layer-manager__flatten-icon');
    if (iconEl && state.iconClass) {
      iconEl.className = `fas ${state.iconClass} fa-nexus-layer-manager__flatten-icon`;
    }
    button.dataset.mode = state.action || 'flatten';
    button.setAttribute('aria-label', state.ariaLabel || label);
    button.title = state.ariaLabel || label;
    if (state.disabled) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
  }

  _getSessionState() {
    return getLayerManagerSessionState();
  }

  _closeContextMenu() {
    const cleanup = this._contextMenuCleanup;
    this._contextMenuCleanup = null;
    if (!cleanup) return;
    try { cleanup(); } catch (_) {}
  }

  _clearPendingSeparatorSelection() {
    if (!this._pendingSeparatorSelectTimer) return;
    window.clearTimeout(this._pendingSeparatorSelectTimer);
    this._pendingSeparatorSelectTimer = null;
  }

  _queueSeparatorSelection(separatorEl, event = null) {
    this._clearPendingSeparatorSelection();
    this._pendingSeparatorSelectTimer = window.setTimeout(() => {
      this._pendingSeparatorSelectTimer = null;
      this._selectElevation(separatorEl, event);
    }, SEPARATOR_RENAME_CLICK_DELAY_MS);
  }

  _showLayerContextMenu(event, items = []) {
    const menuItems = Array.isArray(items) ? items.filter((item) => item && item.label) : [];
    if (!menuItems.length) return;
    this._closeContextMenu();

    const menu = document.createElement('div');
    menu.className = 'fa-nexus-layer-manager__context-menu';
    menu.setAttribute('role', 'menu');

    for (const item of menuItems) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fa-nexus-layer-manager__context-menu-item';
      button.setAttribute('role', 'menuitem');
      if (item.disabled) {
        button.disabled = true;
        button.setAttribute('aria-disabled', 'true');
      }
      if (item.title) button.title = item.title;

      const icon = document.createElement('i');
      icon.className = `${item.iconClass || 'fa-solid fa-circle'} fa-nexus-layer-manager__context-menu-item-icon`;
      icon.setAttribute('aria-hidden', 'true');

      const label = document.createElement('span');
      label.className = 'fa-nexus-layer-manager__context-menu-item-label';
      label.textContent = item.label;

      button.append(icon, label);
      button.addEventListener('click', async (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        if (button.disabled || typeof item.action !== 'function') return;
        this._closeContextMenu();
        try {
          await item.action();
        } catch (error) {
          Logger.error('LayerManager.contextMenu.action.failed', {
            label: item.label,
            error: String(error?.message || error)
          });
          ui?.notifications?.error?.(item.errorMessage || `Failed to ${String(item.label || 'run action').toLowerCase()}: ${error?.message || error}`);
        }
      });
      menu.appendChild(button);
    }

    const root = document.body || this.element;
    if (!root) return;
    root.appendChild(menu);

    const margin = 8;
    const clientX = Number(event?.clientX ?? 0) + 2;
    const clientY = Number(event?.clientY ?? 0) + 2;
    const maxLeft = Math.max(margin, (window.innerWidth || menu.offsetWidth || 0) - menu.offsetWidth - margin);
    const maxTop = Math.max(margin, (window.innerHeight || menu.offsetHeight || 0) - menu.offsetHeight - margin);
    menu.style.left = `${Math.min(Math.max(margin, clientX), maxLeft)}px`;
    menu.style.top = `${Math.min(Math.max(margin, clientY), maxTop)}px`;

    const onPointerDown = (pointerEvent) => {
      if (menu.contains(pointerEvent?.target)) return;
      this._closeContextMenu();
    };
    const onContextMenu = (contextEvent) => {
      if (menu.contains(contextEvent?.target)) return;
      this._closeContextMenu();
    };
    const onKeyDown = (keyEvent) => {
      if (keyEvent?.key === 'Escape') this._closeContextMenu();
    };
    const onWindowChange = () => this._closeContextMenu();

    let listenersBound = false;
    const bindTimer = window.setTimeout(() => {
      listenersBound = true;
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('contextmenu', onContextMenu, true);
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('resize', onWindowChange);
      window.addEventListener('blur', onWindowChange);
      window.addEventListener('scroll', onWindowChange, true);
    }, 0);

    const cleanup = () => {
      window.clearTimeout(bindTimer);
      try { menu.remove(); } catch (_) {}
      if (!listenersBound) return;
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onWindowChange);
      window.removeEventListener('blur', onWindowChange);
      window.removeEventListener('scroll', onWindowChange, true);
    };

    this._contextMenuCleanup = cleanup;
  }

  _positionApplicationNearCursor(app, anchor = null, { offsetX = 14, offsetY = 10 } = {}) {
    const clientX = Number(anchor?.clientX);
    const clientY = Number(anchor?.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || typeof app?.setPosition !== 'function') return;
    requestAnimationFrame(() => {
      const element = app?.element;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const margin = 12;
      const maxLeft = Math.max(margin, (window.innerWidth || rect.width || 0) - rect.width - margin);
      const maxTop = Math.max(margin, (window.innerHeight || rect.height || 0) - rect.height - margin);
      const left = Math.min(Math.max(margin, clientX + offsetX), maxLeft);
      const top = Math.min(Math.max(margin, clientY + offsetY), maxTop);
      try {
        app.setPosition({ left, top, width: rect.width, height: rect.height });
      } catch (error) {
        Logger.error('LayerManager.dialog.position.failed', {
          error: String(error?.message || error)
        });
      }
    });
  }

  _buildLayerManagerHelpContext() {
    const totalLayers = Number(this._viewState?.fullTileDocsById?.size ?? canvas?.scene?.tiles?.size ?? 0) || 0;
    const visibleLayers = Array.isArray(this._viewState?.entries)
      ? this._viewState.entries.filter((entry) => entry?.id && !entry?.separator && !entry?.preview && !entry?.marker).length
      : totalLayers;
    const selectedLayers = this._getSelectedTileDocs().length;
    return {
      toolLabel: 'Layer Manager',
      summary: 'Search, filter, rename, regroup, reorder, and batch-edit scene layers by elevation without leaving the sidebar.',
      selectionSummary: `${selectedLayers} selected | ${visibleLayers} visible | ${totalLayers} total`,
      dirty: false,
      sections: [
        { label: 'Search & Filters' },
        { label: 'Elevation Groups' },
        { label: 'Layer Rows' },
        { label: 'Context Menu' },
        { label: 'Flatten & Selection' }
      ],
      shortcuts: [
        { label: 'Help', binding: 'Click ?', description: 'Open layer manager help from the header.' },
        { label: 'Multi-select', binding: 'Ctrl/Cmd+Click', description: 'Add or remove a layer from the current selection.' },
        { label: 'Range Select', binding: 'Shift+Click', description: 'Select a contiguous range of visible layers.' },
        { label: 'Rename Layer', binding: 'F2', description: 'Rename the currently selected layer.' },
        { label: 'Rename Group', binding: 'Double Click', description: 'Rename an elevation group from its header.' },
        { label: 'Actions Menu', binding: 'Right Click', description: 'Open contextual actions for a layer or group.' },
        { label: 'Tile Sheet', binding: 'Double Right Click', description: 'Open the standard Foundry tile sheet for a layer row.' },
        { label: 'Reorder', binding: 'Drag', description: 'Drag layers onto rows or group headers to reorder or change elevation.' },
        { label: 'Elevation Wheel', binding: 'Alt+Wheel', description: 'Nudge selected layers or scene markers by 0.01; Shift uses 0.1 and Ctrl/Cmd uses 0.001.' },
        { label: 'Elevation Keys', binding: 'Alt+[ / ] or Alt+Up / Down', description: 'Adjust the current layer-manager selection without relying on the mouse wheel.' }
      ],
      notes: [
        'Right-click headers for rename, lock, move, and flatten actions on matching group layers.',
        'Nested groups remember collapsed state per scene and auto-expand to reveal canvas selections.',
        'With active filters, group lock and flatten act on matching layers only, and group elevation moves are blocked.',
        'Quick elevation nudging uses 0.01 by default, 0.001 with Ctrl/Cmd, and 0.1 with Shift.'
      ]
    };
  }

  _openLayerManagerHelp({ focus = true } = {}) {
    const helpContext = this._buildLayerManagerHelpContext();
    if (!this._helpWindow) {
      this._helpWindow = new LayerManagerHelpWindow({ owner: this, helpContext });
    } else {
      this._helpWindow.setHelpContext(helpContext, { suppressRender: true });
    }
    if (!this._helpWindow.rendered) this._helpWindow.render(true);
    else this._helpWindow.render(false);
    if (focus) {
      try { this._helpWindow.bringToFront?.(); } catch (_) {}
    }
    return true;
  }

  _syncHelpWindow({ suppressRender = false } = {}) {
    if (!this._helpWindow) return;
    if (this._helpWindow.state === ApplicationV2.RENDER_STATES.CLOSING) return;
    this._helpWindow.setHelpContext(this._buildLayerManagerHelpContext(), { suppressRender });
    if (!this._helpWindow.rendered) this._helpWindow.render(true);
  }

  _handleHelpWindowClosed(instance) {
    if (this._helpWindow === instance) this._helpWindow = null;
  }

  _getTilePlaceable(tileId) {
    const id = String(tileId || '').trim();
    if (!id) return null;
    return canvas?.tiles?.placeables?.find?.((tile) => (tile?.document?.id || tile?.id) === id) || null;
  }

  _getContextMenuTileDocs(tileId) {
    const id = String(tileId || '').trim();
    if (!id) return [];
    const clickedDoc = this._viewState?.fullTileDocsById?.get?.(id)
      || canvas?.scene?.tiles?.get?.(id)
      || this._getTilePlaceable(id)?.document
      || null;
    if (!clickedDoc) return [];
    const selectedDocs = this._getSelectedTileDocs();
    const selectedIds = new Set(selectedDocs.map((doc) => doc?.id).filter(Boolean));
    if (selectedIds.has(id) && selectedDocs.length > 1) return selectedDocs;
    return [clickedDoc];
  }

  _getGroupContextMenuDocs(elevationKey) {
    const key = String(elevationKey || '').trim();
    if (!key) return [];
    const ids = this._getMatchingElevationDocs(key).map((doc) => doc?.id).filter(Boolean);
    return this._getOrderedDocsByIds(ids);
  }

  _triggerTileContextHighlight(tile, event = null) {
    if (!tile) return;
    this._activateTilesLayer();
    const stub = Object.assign({}, clickEventStub, {
      shiftKey: !!event?.shiftKey,
      ctrlKey: !!event?.ctrlKey,
      metaKey: !!event?.metaKey,
      altKey: !!event?.altKey,
      button: 2,
      preventDefault: () => {},
      stopPropagation: () => {},
      stopImmediatePropagation: () => {}
    });
    try { tile._onClickRight?.(stub); } catch (error) {
      Logger.error('LayerManager.contextMenu.highlight.failed', {
        tileId: tile?.document?.id || tile?.id || null,
        error: String(error?.message || error)
      });
    }
    this._syncSelectionFromCanvas();
  }

  async _toggleDocsLock(docs = []) {
    const orderedDocs = this._getOrderedDocsByIds(docs.map((doc) => doc?.id).filter(Boolean));
    if (!orderedDocs.length || !canvas?.scene?.updateEmbeddedDocuments) return;
    const blockedDocs = orderedDocs.filter((doc) => !doc?.canUserModify?.(game.user, 'update'));
    if (blockedDocs.length) {
      throw new Error('You do not have permission to lock every targeted layer.');
    }
    const allLocked = orderedDocs.every((doc) => !!doc?.locked);
    const nextLocked = !allLocked;
    await canvas.scene.updateEmbeddedDocuments('Tile', orderedDocs.map((doc) => ({
      _id: doc.id,
      locked: nextLocked
    })));
    Logger.info('LayerManager.contextMenu.lock.commit', {
      sceneId: canvas?.scene?.id || null,
      tileCount: orderedDocs.length,
      locked: nextLocked
    });
    this._updateSelectionActions();
  }

  _selectTileDocs(docs = []) {
    const orderedDocs = this._getOrderedDocsByIds(docs.map((doc) => doc?.id).filter(Boolean));
    if (!orderedDocs.length) return [];
    this._activateTilesLayer();
    this._clearSceneMarkerSelection();
    try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
    const selectedDocs = [];
    for (const doc of orderedDocs) {
      const tile = doc?.object || this._getTilePlaceable(doc?.id);
      if (!tile || tile.destroyed) {
        Logger.error('LayerManager.contextMenu.selection.missingPlaceable', {
          tileId: doc?.id || null
        });
        continue;
      }
      try {
        tile.control({ releaseOthers: false });
        if (tile?.document) selectedDocs.push(tile.document);
      } catch (error) {
        Logger.error('LayerManager.contextMenu.selection.control.failed', {
          tileId: doc?.id || null,
          error: String(error?.message || error)
        });
      }
    }
    this._syncSelectionFromCanvas();
    return selectedDocs;
  }

  async _flattenDocs(docs = []) {
    const orderedDocs = this._getOrderedDocsByIds(docs.map((doc) => doc?.id).filter(Boolean));
    if (!orderedDocs.length) return;
    const manager = getTileFlattenManager();
    if (manager?.isBusy?.()) {
      throw new Error('Another flattening or deconstruction operation is already in progress.');
    }
    this._selectTileDocs(orderedDocs);
    Logger.info('LayerManager.contextMenu.flatten.begin', {
      sceneId: canvas?.scene?.id || null,
      tileCount: orderedDocs.length
    });
    await manager.showFlattenDialog();
    this._updateFlattenFooter();
  }

  async _deconstructDoc(doc) {
    if (!doc) return;
    const manager = getTileFlattenManager();
    if (manager?.isBusy?.()) {
      throw new Error('Another flattening or deconstruction operation is already in progress.');
    }
    Logger.info('LayerManager.contextMenu.deconstruct.begin', {
      sceneId: canvas?.scene?.id || null,
      tileId: doc?.id || null
    });
    try {
      await manager.confirmAndDeconstructTile(doc);
    } finally {
      this._updateFlattenFooter();
    }
  }

  _buildFlattenContextMenuItem(docs = []) {
    const orderedDocs = this._getOrderedDocsByIds(docs.map((doc) => doc?.id).filter(Boolean));
    const flattenManager = getTileFlattenManager();
    const busy = !!flattenManager?.isBusy?.();
    const singleDoc = orderedDocs.length === 1 ? orderedDocs[0] : null;
    const singleFlattened = !!singleDoc && TileFlattenManager.isFlattenedTile(singleDoc);

    if (singleFlattened) {
      return {
        label: 'Deconstruct',
        iconClass: 'fa-solid fa-object-ungroup',
        disabled: busy || !canvas?.ready,
        action: () => this._deconstructDoc(singleDoc),
        errorMessage: 'Failed to deconstruct the targeted layer.'
      };
    }

    return {
      label: 'Flatten',
      iconClass: 'fa-solid fa-compress-arrows-alt',
      disabled: !TileFlattenManager.canFlattenSelection(orderedDocs) || busy,
      action: () => this._flattenDocs(orderedDocs),
      errorMessage: 'Failed to flatten the targeted layers.'
    };
  }

  async _openNexusTileEditor(doc) {
    if (!doc) throw new Error('Tile document not available.');
    Logger.info('LayerManager.contextMenu.nexusEdit.begin', {
      sceneId: canvas?.scene?.id || null,
      tileId: doc?.id || null,
      mode: getFaNexusTileEditMode(doc)
    });
    await openFaNexusTileEditor(doc, { source: 'layer-manager-context-menu' });
  }

  async _promptDocsElevationChange(docs = [], anchor = null) {
    const orderedDocs = this._getOrderedDocsByIds(docs.map((doc) => doc?.id).filter(Boolean));
    if (!orderedDocs.length) return;
    const blockedDocs = orderedDocs.filter((doc) => !doc?.canUserModify?.(game.user, 'update'));
    if (blockedDocs.length) {
      throw new Error('You do not have permission to move every targeted layer.');
    }
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2?.wait) {
      throw new Error('DialogV2.wait is unavailable for layer elevation changes.');
    }
    const uniqueElevations = Array.from(new Set(orderedDocs.map((doc) => formatElevation(Number(doc?.elevation ?? 0)))));
    const initialValue = uniqueElevations.length === 1 ? uniqueElevations[0] : '';
    const inputId = `fa-nexus-layer-manager-elevation-${Date.now()}`;
    const tileCount = orderedDocs.length;
    const result = await DialogV2.wait({
      window: {
        title: tileCount === 1 ? 'Change Layer Elevation' : 'Change Layer Elevation'
      },
      position: {
        width: 320,
        height: 'auto'
      },
      modal: true,
      content: `
        <form class="standard-form">
          <p>Move ${tileCount} layer${tileCount === 1 ? '' : 's'} to an exact elevation.</p>
          <div class="form-group">
            <label for="${inputId}">Elevation</label>
            <div class="form-fields">
              <input id="${inputId}" name="elevation" type="number" step="0.001" value="${initialValue}">
            </div>
          </div>
        </form>
      `,
      buttons: [
        {
          action: 'apply',
          label: 'Apply',
          icon: 'fas fa-arrows-up-down',
          default: true,
          callback: (_event, _button, dialog) => {
            const input = dialog?.element?.querySelector?.(`#${CSS.escape(inputId)}`);
            return String(input?.value ?? '').trim();
          }
        },
        {
          action: 'cancel',
          label: 'Cancel'
        }
      ],
      close: () => null,
      render: (_event, dialog) => {
        const input = dialog?.element?.querySelector?.(`#${CSS.escape(inputId)}`);
        requestAnimationFrame(() => {
          this._positionApplicationNearCursor(dialog, anchor);
          try {
            input?.focus?.();
            input?.select?.();
          } catch (_) {}
        });
      }
    });
    if (result === null || result === undefined) return;
    const targetElevation = parseElevationInput(result);
    if (!Number.isFinite(targetElevation)) {
      throw new Error('Elevation value must be a valid number.');
    }
    await this._applyDocsElevationChange(orderedDocs, targetElevation);
  }

  async _applyDocsElevationChange(docs = [], targetElevation) {
    const orderedDocs = this._getOrderedDocsByIds(docs.map((doc) => doc?.id).filter(Boolean));
    if (!orderedDocs.length || !canvas?.scene?.updateEmbeddedDocuments) return;
    const blockedDocs = orderedDocs.filter((doc) => !doc?.canUserModify?.(game.user, 'update'));
    if (blockedDocs.length) {
      throw new Error('You do not have permission to move every targeted layer.');
    }
    const scene = canvas?.scene;
    if (!scene) throw new Error('No active scene available for layer elevation change.');
    const nextElevation = quantizeElevation(targetElevation);
    const targetKey = elevationGroupKey(nextElevation);
    const movedIds = new Set(orderedDocs.map((doc) => doc?.id).filter(Boolean));
    const updates = [];
    let nextSort = computeNextSortAtElevation(nextElevation);
    if (!Number.isFinite(nextSort)) nextSort = 0;
    nextSort += Math.max(0, orderedDocs.length - 1) * 2;
    for (const doc of orderedDocs) {
      const currentKey = elevationGroupKey(doc?.elevation ?? 0);
      const currentSort = Number(doc?.sort ?? 0) || 0;
      if (currentKey !== targetKey || currentSort !== nextSort) {
        updates.push({
          _id: doc.id,
          elevation: nextElevation,
          sort: nextSort
        });
      }
      nextSort -= 2;
    }
    if (!updates.length) {
      Logger.info('LayerManager.contextMenu.elevation.noop', {
        sceneId: scene.id || null,
        targetKey,
        tileCount: orderedDocs.length
      });
      return;
    }

    await scene.updateEmbeddedDocuments('Tile', updates);

    const metadata = getSceneElevationGroupMetadata(scene);
    const completeMoves = [];
    for (const [sourceKey, groupDocs] of this._viewState?.fullElevationGroups || []) {
      if (!Array.isArray(groupDocs) || !groupDocs.length || sourceKey === targetKey) continue;
      const groupIds = groupDocs.map((doc) => doc?.id).filter(Boolean);
      if (!groupIds.length || !groupIds.every((id) => movedIds.has(id))) continue;
      completeMoves.push({ sourceKey, targetKey });
    }
    if (completeMoves.length) {
      await setSceneElevationGroupMetadata(scene, mergeElevationGroupMetadataOnBulkMove({
        metadata,
        moves: completeMoves
      }));
    }

    Logger.info('LayerManager.contextMenu.elevation.commit', {
      sceneId: scene.id || null,
      targetKey,
      tileCount: updates.length,
      metadataMoves: completeMoves.length
    });
  }

  _getSelectedTileDocs({ visibleOnly = false } = {}) {
    const selected = Array.isArray(canvas?.tiles?.controlled) ? canvas.tiles.controlled : [];
    const docsById = new Map();
    for (const tile of selected) {
      const doc = tile?.document || null;
      const id = doc?.id || tile?.id;
      if (!doc || !id) continue;
      docsById.set(id, doc);
    }
    if (!docsById.size) return [];
    let allowedIds = null;
    if (visibleOnly) {
      const visibleIds = new Set();
      const root = this.element;
      for (const item of root?.querySelectorAll?.('[data-tile-id]') || []) {
        const id = item?.dataset?.tileId;
        if (id) visibleIds.add(id);
      }
      allowedIds = visibleIds;
    }
    const orderedIds = Array.isArray(this._viewState?.fullTileIdsInOrder) ? this._viewState.fullTileIdsInOrder : [...docsById.keys()];
    const docs = [];
    for (const id of orderedIds) {
      if (allowedIds && !allowedIds.has(id)) continue;
      const doc = docsById.get(id);
      if (doc) docs.push(doc);
    }
    return docs;
  }

  _getSelectionActionState() {
    const selectedDocs = this._getSelectedTileDocs();
    const lockTargets = selectedDocs.filter((doc) => doc?.canUserModify?.(game.user, 'update'));
    const deleteTargets = selectedDocs.filter((doc) => doc?.canUserModify?.(game.user, 'delete'));
    const allLocked = lockTargets.length ? lockTargets.every((doc) => !!doc?.locked) : false;
    const lockLabel = allLocked ? 'Unlock Selected' : 'Lock Selected';
    return {
      lockLabel,
      lockTitle: `${lockLabel} layer${lockTargets.length === 1 ? '' : 's'}`,
      lockDisabled: lockTargets.length === 0,
      deleteDisabled: deleteTargets.length === 0
    };
  }

  _updateSelectionActions() {
    const root = this.element;
    if (!root) return;
    const lockButton = root.querySelector('button[data-action="toggle-selection-lock"]');
    const deleteButton = root.querySelector('button[data-action="delete-selection"]');
    const state = this._getSelectionActionState();
    if (lockButton) {
      lockButton.disabled = state.lockDisabled;
      lockButton.classList.toggle('disabled', state.lockDisabled);
      lockButton.setAttribute('aria-disabled', state.lockDisabled ? 'true' : 'false');
      lockButton.title = state.lockTitle;
      lockButton.setAttribute('aria-label', state.lockTitle);
    }
    if (deleteButton) {
      deleteButton.disabled = state.deleteDisabled;
      deleteButton.classList.toggle('disabled', state.deleteDisabled);
      deleteButton.setAttribute('aria-disabled', state.deleteDisabled ? 'true' : 'false');
    }
  }

  async _toggleSelectionLock() {
    const targets = this._getSelectedTileDocs().filter((doc) => doc?.canUserModify?.(game.user, 'update'));
    if (!targets.length) return;
    const allLocked = targets.every((doc) => !!doc?.locked);
    const nextLocked = !allLocked;
    await Promise.allSettled(targets.map((doc) => Promise.resolve(doc.update({ locked: nextLocked }))));
    this._updateSelectionActions();
  }

  async _deleteSelection() {
    const targets = this._getSelectedTileDocs().filter((doc) => doc?.canUserModify?.(game.user, 'delete'));
    const ids = targets.map((doc) => doc?.id).filter(Boolean);
    if (!ids.length || !canvas?.scene?.deleteEmbeddedDocuments) return;
    try {
      await canvas.scene.deleteEmbeddedDocuments('Tile', ids);
    } catch (error) {
      Logger.warn('LayerManager.deleteSelection.failed', { error: String(error?.message || error) });
      ui?.notifications?.error?.(`Failed to delete selected layers: ${error?.message || error}`);
    } finally {
      this._updateSelectionActions();
    }
  }

  _onSearchInput(event) {
    const state = this._getSessionState();
    state.searchQuery = String(event?.currentTarget?.value ?? '');
    this._searchFocusPending = true;
    this._searchSelectionStart = event?.currentTarget?.selectionStart ?? null;
    this._searchSelectionEnd = event?.currentTarget?.selectionEnd ?? null;
    this._handleSelectionListFilterStateChange('search-input');
    this._scheduleRender();
  }

  _toggleFilterChip(buttonEl) {
    const state = this._getSessionState();
    const kind = String(buttonEl?.dataset?.filterKind || '').trim();
    const key = String(buttonEl?.dataset?.filterKey || '').trim();
    if (!kind || !key) return;
    if (kind === 'type') {
      if (state.typeFilters.has(key)) state.typeFilters.delete(key);
      else state.typeFilters.add(key);
    } else if (kind === 'flag' && Object.prototype.hasOwnProperty.call(state.flagFilters, key)) {
      state.flagFilters[key] = !state.flagFilters[key];
    }
    this._handleSelectionListFilterStateChange('chip-toggle');
    this._scheduleRender();
  }

  _resetListFilters() {
    const state = this._getSessionState();
    state.searchQuery = '';
    state.typeFilters.clear();
    for (const key of LIST_FILTER_FLAG_KEYS) {
      state.flagFilters[key] = false;
    }
    this._searchFocusPending = false;
    this._searchSelectionStart = null;
    this._searchSelectionEnd = null;
    this._handleSelectionListFilterStateChange('filters-reset');
    this._scheduleRender();
  }

  _toggleSelectionOptions() {
    const state = this._getSessionState();
    state.selectionOptionsCollapsed = !state.selectionOptionsCollapsed;
    this._scheduleRender();
  }

  _getMatchingElevationGroupKeys(viewState = this._viewState) {
    const state = viewState || this._viewState;
    if (!state) return [];
    if (state?.nestedGrouping) {
      const visibleKeys = state?.matchingGroupHierarchy?.visibleKeys;
      if (visibleKeys instanceof Set) {
        return Array.from(visibleKeys).filter((key) => String(key || '').trim().length);
      }
    }
    const map = state?.matchingTileIdsByElevation;
    if (map instanceof Map) {
      return Array.from(map.keys()).filter((key) => String(key || '').trim().length);
    }
    return [];
  }

  _setMatchingElevationGroupsCollapsed(collapsed) {
    const matchingGroupKeys = this._getMatchingElevationGroupKeys();
    if (!matchingGroupKeys.length) return;
    const state = this._getSessionState();
    if (!(state.collapsedElevations instanceof Set)) {
      state.collapsedElevations = new Set();
    }
    let changed = false;
    for (const key of matchingGroupKeys) {
      if (collapsed) {
        if (!state.collapsedElevations.has(key)) {
          state.collapsedElevations.add(key);
          changed = true;
        }
        continue;
      }
      if (state.collapsedElevations.delete(key)) changed = true;
    }
    if (!changed) return;
    queuePersistLayerManagerCollapsedState();
    Logger.info(collapsed ? 'LayerManager.elevationGroup.collapseAll' : 'LayerManager.elevationGroup.expandAll', {
      sceneId: canvas?.scene?.id || null,
      groupCount: matchingGroupKeys.length,
      filtersApplied: !!this._viewState?.filtersApplied
    });
    this._scheduleRender();
  }

  _collapseAllElevationGroups() {
    this._setMatchingElevationGroupsCollapsed(true);
  }

  _expandAllElevationGroups() {
    this._setMatchingElevationGroupsCollapsed(false);
  }

  _toggleElevationCollapse(buttonEl) {
    const separator = buttonEl?.closest?.('.fa-nexus-layer-manager__separator');
    const key = String(buttonEl?.dataset?.elevationKey || separator?.dataset?.elevationKey || '').trim();
    if (!key) return;
    const state = this._getSessionState();
    if (state.collapsedElevations.has(key)) state.collapsedElevations.delete(key);
    else state.collapsedElevations.add(key);
    queuePersistLayerManagerCollapsedState();
    this._scheduleRender();
  }

  _expandElevationGroupsForDocs(docs = []) {
    if (!Array.isArray(docs) || !docs.length) return false;
    const state = this._getSessionState();
    if (!(state?.collapsedElevations instanceof Set) || !state.collapsedElevations.size) return false;
    const keysToExpand = new Set();

    for (const doc of docs) {
      if (!doc) continue;
      const exactKey = elevationGroupKey(doc?.elevation ?? 0);
      if (!exactKey) continue;
      if (!this._usesNestedGrouping()) {
        keysToExpand.add(exactKey);
        continue;
      }
      let node = this._getFullGroupNode(exactKey);
      if (!node) {
        keysToExpand.add(exactKey);
        continue;
      }
      while (node) {
        keysToExpand.add(node.key);
        node = node.parentKey ? this._getFullGroupNode(node.parentKey) : null;
      }
    }

    let changed = false;
    for (const key of keysToExpand) {
      if (state.collapsedElevations.delete(key)) changed = true;
    }
    if (changed) {
      queuePersistLayerManagerCollapsedState();
      Logger.info('LayerManager.selection.autoExpand', {
        sceneId: canvas?.scene?.id || null,
        groupCount: keysToExpand.size,
        elevationKeys: Array.from(keysToExpand)
      });
    }
    return changed;
  }

  _getMatchingElevationDocs(elevationKey) {
    const key = String(elevationKey || '').trim();
    if (!key) return [];
    const ids = this._viewState?.matchingTileIdsByElevation?.get?.(key) || [];
    const docs = [];
    for (const id of ids) {
      const doc = this._viewState?.fullTileDocsById?.get?.(id) || canvas?.scene?.tiles?.get?.(id) || null;
      if (doc) docs.push(doc);
    }
    return docs;
  }

  _getFullElevationDocs(elevationKey) {
    const key = String(elevationKey || '').trim();
    if (!key) return [];
    const docs = this._viewState?.fullGroupDocsByKey?.get?.(key) || [];
    return Array.isArray(docs) ? docs.filter(Boolean) : [];
  }

  _getFullGroupNode(elevationKey) {
    const key = String(elevationKey || '').trim();
    if (!key) return null;
    return this._viewState?.fullGroupHierarchy?.nodesByKey?.get?.(key) || null;
  }

  _getMatchingGroupNode(elevationKey) {
    const key = String(elevationKey || '').trim();
    if (!key) return null;
    return this._viewState?.matchingGroupHierarchy?.nodesByKey?.get?.(key) || null;
  }

  _usesNestedGrouping() {
    return !!this._viewState?.nestedGrouping;
  }

  _queueElevationGroupMetadataSync(metadata) {
    if (this._elevationGroupMetadataSyncPending) return;
    const scene = canvas?.scene;
    if (!scene) return;
    this._elevationGroupMetadataSyncPending = true;
    Promise.resolve()
      .then(() => setSceneElevationGroupMetadata(scene, metadata))
      .catch((error) => {
        Logger.error('LayerManager.elevationGroups.sync.failed', {
          sceneId: scene.id || null,
          error: String(error?.message || error)
        });
      })
      .finally(() => {
        this._elevationGroupMetadataSyncPending = false;
      });
  }

  _collectCompleteVisibleGroupMovesForDelta(movedDocIds, delta) {
    if (!(movedDocIds instanceof Set) || !movedDocIds.size || !Number.isFinite(delta) || !this._usesNestedGrouping()) return [];
    const nodes = this._viewState?.fullGroupHierarchy?.nodesByKey;
    if (!(nodes instanceof Map) || !nodes.size) return [];
    const moves = [];
    for (const node of nodes.values()) {
      const fullIds = Array.isArray(node?.fullSubtreeDocs)
        ? node.fullSubtreeDocs.map((doc) => doc?.id).filter(Boolean)
        : [];
      if (!fullIds.length) continue;
      if (!fullIds.every((id) => movedDocIds.has(id))) continue;
      const targetKey = elevationGroupKey((Number(node?.elevation ?? 0) || 0) + delta);
      if (!targetKey || targetKey === node.key) continue;
      moves.push({ sourceKey: node.key, targetKey });
    }
    return moves;
  }

  _resolveDraggedTileIds(originId) {
    const visibleSelectedDocs = this._getSelectedTileDocs({ visibleOnly: true });
    const visibleSelectedIds = new Set(visibleSelectedDocs.map((doc) => doc?.id).filter(Boolean));
    if (originId && visibleSelectedIds.has(originId) && visibleSelectedIds.size > 1) {
      return visibleSelectedDocs.map((doc) => doc?.id).filter(Boolean);
    }
    return originId ? [originId] : [];
  }

  _getOrderedDocsByIds(tileIds = []) {
    const wanted = new Set(tileIds.filter(Boolean));
    if (!wanted.size) return [];
    const docs = [];
    const orderedIds = Array.isArray(this._viewState?.fullTileIdsInOrder) ? this._viewState.fullTileIdsInOrder : [];
    for (const id of orderedIds) {
      if (!wanted.has(id)) continue;
      const doc = this._viewState?.fullTileDocsById?.get?.(id) || canvas?.scene?.tiles?.get?.(id) || null;
      if (doc) docs.push(doc);
    }
    if (docs.length >= wanted.size) return docs;
    for (const id of wanted) {
      if (docs.some((doc) => doc?.id === id)) continue;
      const doc = this._viewState?.fullTileDocsById?.get?.(id) || canvas?.scene?.tiles?.get?.(id) || null;
      if (doc) docs.push(doc);
    }
    return docs;
  }

  _setDraggedRowState(tileIds = []) {
    const root = this.element;
    if (!root) return;
    const wanted = new Set(tileIds.filter(Boolean));
    for (const item of root.querySelectorAll('[data-tile-id]')) {
      const id = item?.dataset?.tileId;
      item.classList.toggle('is-dragging', !!id && wanted.has(id));
    }
  }

  _clearDraggedRowState() {
    const root = this.element;
    if (!root) return;
    for (const item of root.querySelectorAll('.is-dragging')) {
      item.classList.remove('is-dragging');
    }
  }

  _clearDropIndicator() {
    const root = this.element;
    if (!root) {
      this._dropIndicator = null;
      return;
    }
    for (const item of root.querySelectorAll('.is-drop-before, .is-drop-after, .is-drop-header')) {
      item.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-header');
    }
    this._dropIndicator = null;
  }

  _applyDropIndicator(target) {
    if (!target?.element) {
      this._clearDropIndicator();
      return;
    }
    const nextKey = JSON.stringify({
      kind: target.kind,
      rowId: target.rowId || null,
      elevationKey: target.elevationKey || null,
      placeBefore: target.placeBefore !== false
    });
    if (this._dropIndicator === nextKey) return;
    this._clearDropIndicator();
    if (target.kind === 'header') {
      target.element.classList.add('is-drop-header');
    } else if (target.placeBefore) {
      target.element.classList.add('is-drop-before');
    } else {
      target.element.classList.add('is-drop-after');
    }
    this._dropIndicator = nextKey;
  }

  _resolveDropTarget(event) {
    if (!this._dragState?.tileIds?.length) return null;
    const header = event?.target?.closest?.('.fa-nexus-layer-manager__separator[data-elevation-key]:not(.fa-nexus-layer-manager__separator--foreground)');
    if (header) {
      const elevationKey = String(header?.dataset?.elevationKey || '').trim();
      if (!elevationKey) return null;
      return {
        kind: 'header',
        elevationKey,
        element: header
      };
    }
    const row = event?.target?.closest?.('[data-tile-id]');
    if (!row) return null;
    const rowId = String(row?.dataset?.tileId || '').trim();
    if (!rowId) return null;
    const draggedIds = new Set(this._dragState.tileIds);
    if (draggedIds.has(rowId)) return null;
    const rect = row.getBoundingClientRect();
    const midpoint = rect.top + (rect.height / 2);
    return {
      kind: 'row',
      rowId,
      elevationKey: String(row?.dataset?.elevationKey || '').trim(),
      placeBefore: Number(event?.clientY ?? 0) <= midpoint,
      element: row
    };
  }

  _onListDragStart(event) {
    if (event?.target?.closest?.('.fa-nexus-layer-manager__rename-input')) {
      event.preventDefault();
      return;
    }
    const row = event?.target?.closest?.('[data-tile-id]');
    const originId = String(row?.dataset?.tileId || '').trim();
    if (!originId) {
      event.preventDefault();
      return;
    }
    const orderedDocs = this._getOrderedDocsByIds(this._resolveDraggedTileIds(originId))
      .filter((doc) => doc?.canUserModify?.(game.user, 'update'));
    const tileIds = orderedDocs.map((doc) => doc?.id).filter(Boolean);
    if (!tileIds.length) {
      event.preventDefault();
      return;
    }
    this._dragState = { tileIds, originId };
    try {
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tileIds.join(','));
      }
    } catch (_) {}
    this._setDraggedRowState(tileIds);
    this._clearDropIndicator();
  }

  _onListDragOver(event) {
    if (!this._dragState?.tileIds?.length) return;
    const target = this._resolveDropTarget(event);
    if (!target) {
      this._clearDropIndicator();
      return;
    }
    event.preventDefault();
    try {
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    } catch (_) {}
    this._applyDropIndicator(target);
  }

  _onListDragLeave(event) {
    const currentTarget = event?.currentTarget;
    const relatedTarget = event?.relatedTarget;
    if (currentTarget && relatedTarget && currentTarget.contains(relatedTarget)) return;
    this._clearDropIndicator();
  }

  async _onListDrop(event) {
    if (!this._dragState?.tileIds?.length) return;
    event.preventDefault();
    const target = this._resolveDropTarget(event);
    try {
      if (target) await this._applyDropReorder(target);
    } finally {
      this._clearDropIndicator();
      this._clearDraggedRowState();
      this._dragState = null;
    }
  }

  _onListDragEnd() {
    this._clearDropIndicator();
    this._clearDraggedRowState();
    this._dragState = null;
  }

  async _applyDropReorder(target) {
    const targetElevationKey = String(target?.elevationKey || '').trim();
    if (!targetElevationKey || !canvas?.scene?.updateEmbeddedDocuments) return;
    const movingDocs = this._getOrderedDocsByIds(this._dragState?.tileIds || [])
      .filter((doc) => doc?.canUserModify?.(game.user, 'update'));
    if (!movingDocs.length) return;
    const movingIds = new Set(movingDocs.map((doc) => doc?.id).filter(Boolean));
    const reorderedGroups = new Map();
    for (const [key, docs] of this._viewState?.fullElevationGroups || []) {
      reorderedGroups.set(key, (Array.isArray(docs) ? docs : []).filter((doc) => doc?.id && !movingIds.has(doc.id)));
    }
    if (!reorderedGroups.has(targetElevationKey)) reorderedGroups.set(targetElevationKey, []);
    const targetGroup = reorderedGroups.get(targetElevationKey);
    if (!Array.isArray(targetGroup)) return;
    let insertIndex = 0;
    if (target?.kind === 'row') {
      const targetId = String(target?.rowId || '').trim();
      const rowIndex = targetGroup.findIndex((doc) => String(doc?.id || '') === targetId);
      if (rowIndex < 0) return;
      insertIndex = rowIndex + (target.placeBefore ? 0 : 1);
    }
    targetGroup.splice(insertIndex, 0, ...movingDocs);
    const affectedKeys = new Set([targetElevationKey, ...movingDocs.map((doc) => elevationGroupKey(doc?.elevation ?? 0))]);
    const updates = [];
    for (const key of affectedKeys) {
      const docs = reorderedGroups.get(key) || [];
      const nextElevation = Number(key);
      const total = docs.length;
      for (let index = 0; index < docs.length; index += 1) {
        const doc = docs[index];
        const nextSort = (total - index) * 2;
        const currentElevationKey = elevationGroupKey(doc?.elevation ?? 0);
        const currentSort = Number(doc?.sort ?? 0) || 0;
        if (currentElevationKey === key && currentSort === nextSort) continue;
        updates.push({
          _id: doc.id,
          elevation: nextElevation,
          sort: nextSort
        });
      }
    }
    if (!updates.length) return;
    await canvas.scene.updateEmbeddedDocuments('Tile', updates);
  }

  _ensureHooks() {
    if (!globalThis.Hooks || this._hookIds.length) return;
    const hook = (name, fn) => {
      try { Hooks.on(name, fn); } catch (_) { return; }
      this._hookIds.push({ name, fn });
    };

    const refresh = (reason = 'hook-refresh', { invalidateListCache = true, refreshSelection = true } = {}) => {
      if (invalidateListCache) invalidateSelectionListFilterCache(reason);
      if (this.active || this.isPopout) this._startWheelSession();
      if (refreshSelection && selectionFilterState.active && selectionFilterState.skipFiltered) {
        scheduleSelectionFilterRefresh({
          reason,
          source: 'layer-manager-hooks',
          resyncSettings: false
        });
      }
      this._scheduleRender();
    };
    const syncSelection = (tile, controlled) => this._syncSelectionFromCanvas(tile, controlled);

    hook('createTile', () => refresh('create-tile'));
    hook('updateTile', () => refresh('update-tile'));
    hook('deleteTile', () => refresh('delete-tile'));
    hook('canvasReady', () => refresh('canvas-ready'));
    hook('canvasTearDown', () => refresh('canvas-teardown'));
    hook('updateScene', () => refresh('update-scene'));
    hook('fa-nexus-preview-layers-changed', () => refresh('preview-layers-changed'));
    hook('controlTile', syncSelection);
    hook('updateSetting', (payload) => {
      if (payload?.namespace !== MODULE_ID) return;
      if (payload?.key === COLLAPSED_STATE_SETTING) {
        syncLayerManagerCollapsedStateFromSettings();
        refresh('collapsed-state-updated', { invalidateListCache: false, refreshSelection: false });
        return;
      }
      if (payload?.key !== NESTED_GROUPING_SETTING) return;
      refresh('nested-grouping-updated', { invalidateListCache: false, refreshSelection: false });
    });
  }

  _removeHooks() {
    if (!globalThis.Hooks || !this._hookIds.length) return;
    for (const { name, fn } of this._hookIds) {
      try { Hooks.off(name, fn); } catch (_) {}
    }
    this._hookIds = [];
  }

  _scheduleRender() {
    if (!this.rendered || (!this.active && !this.isPopout)) return;
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this.render({ parts: ['content'] });
    });
  }

  _handleSelectionListFilterStateChange(reason) {
    invalidateSelectionListFilterCache(reason);
    if (!selectionFilterState.active || !selectionFilterState.skipFiltered) return;
    scheduleSelectionFilterRefresh({
      reason,
      source: 'layer-manager-list-filters',
      resyncSettings: false
    });
  }

  _activateTilesLayer() {
    try {
      if (canvas?.tiles && canvas.activeLayer !== canvas.tiles) canvas.tiles.activate();
    } catch (_) {}
  }

  _onRangeChange(isInput = false) {
    const root = this.element;
    if (!root) return;
    const minInput = root.querySelector('input[data-range="min"]');
    const maxInput = root.querySelector('input[data-range="max"]');
    const minRaw = minInput?.value ?? '';
    const maxRaw = maxInput?.value ?? '';
    const minValue = minRaw.trim();
    const maxValue = maxRaw.trim();
    selectionFilterState.min = parseElevationInput(minValue);
    selectionFilterState.max = parseElevationInput(maxValue);
    if ((minValue || maxValue) && !selectionFilterState.ignoreForeground) {
      selectionFilterState.ignoreForeground = true;
      if (!isInput) writeSetting(IGNORE_FOREGROUND_SETTING, true);
      refreshTileInteractionState();
    }
    if (!isInput) {
      writeSetting(RANGE_MIN_SETTING, minValue);
      writeSetting(RANGE_MAX_SETTING, maxValue);
      refreshTileInteractionState();
      pruneSelectionForFilter();
    }
  }

  _onSkipLockedChange() {
    const root = this.element;
    if (!root) return;
    const input = root.querySelector('input[data-action="skip-locked"]');
    const value = !!input?.checked;
    selectionFilterState.skipLocked = value;
    writeSetting(SKIP_LOCKED_SETTING, value);
    refreshTileInteractionState();
    pruneSelectionForFilter();
  }

  _onSkipHiddenChange() {
    const root = this.element;
    if (!root) return;
    const input = root.querySelector('input[data-action="skip-hidden"]');
    const value = !!input?.checked;
    selectionFilterState.skipHidden = value;
    writeSetting(SKIP_HIDDEN_SETTING, value);
    refreshTileInteractionState();
    pruneSelectionForFilter();
  }

  _onSkipFilteredChange() {
    const root = this.element;
    if (!root) return;
    const input = root.querySelector('input[data-action="skip-filtered"]');
    const value = !!input?.checked;
    selectionFilterState.skipFiltered = value;
    invalidateSelectionListFilterCache('skip-filtered-toggle');
    writeSetting(SKIP_FILTERED_SETTING, value);
    scheduleSelectionFilterRefresh({
      reason: 'skip-filtered-toggle',
      source: 'layer-manager-selection-options',
      resyncSettings: false
    });
  }

  _setFilterActive(active) {
    const next = !!active;
    if (selectionFilterState.active === next) return;
    selectionFilterState.active = next;
    if (next) setAltKeyHeld(isAltModifierActive());
    refreshTileInteractionState();
    pruneSelectionForFilter();
  }

  _setActiveClass(active) {
    const el = this.element;
    if (!el) return;
    el.classList.toggle('active', this.isPopout ? true : !!active);
    if (!el.dataset.tab) el.dataset.tab = TAB_ID;
    if (!el.dataset.group) el.dataset.group = 'primary';
  }

  _onListClick(event) {
    if (event.target?.closest?.('.fa-nexus-layer-manager__rename-input')) return;
    if (event.target?.closest?.('.fa-nexus-layer-manager__separator-group-name-input')) return;
    if (event.target?.closest?.('.fa-nexus-layer-manager__separator-group-elevation-input')) return;
    this._clearPendingSeparatorSelection();
    const sceneMarker = event.target?.closest?.('[data-scene-marker]');
    if (sceneMarker) {
      event.preventDefault();
      event.stopPropagation();
      this._selectSceneMarker(sceneMarker, event);
      return;
    }

    const elevationToggle = event.target?.closest?.('[data-action="toggle-elevation-visibility"]');
    if (elevationToggle) {
      event.preventDefault();
      event.stopPropagation();
      this._toggleElevationVisibility(elevationToggle);
      return;
    }

    const collapseToggle = event.target?.closest?.('[data-action="toggle-elevation-collapse"]');
    if (collapseToggle) {
      event.preventDefault();
      event.stopPropagation();
      this._toggleElevationCollapse(collapseToggle);
      return;
    }

    const visibilityToggle = event.target?.closest?.('[data-action="toggle-visibility"]');
    if (visibilityToggle) {
      event.preventDefault();
      event.stopPropagation();
      this._toggleVisibility(visibilityToggle);
      return;
    }

    const lockToggle = event.target?.closest?.('[data-action="toggle-lock"]');
    if (lockToggle) {
      event.preventDefault();
      event.stopPropagation();
      this._toggleLock(lockToggle);
      return;
    }

    const separator = event.target?.closest?.('.fa-nexus-layer-manager__separator:not(.fa-nexus-layer-manager__separator--foreground)');
    if (separator) {
      event.preventDefault();
      event.stopPropagation();
      const renameTarget = event.target?.closest?.('.fa-nexus-layer-manager__separator-name, .fa-nexus-layer-manager__separator-elevation');
      if (renameTarget) {
        if ((Number(event?.detail) || 0) > 1) return;
        this._queueSeparatorSelection(separator, {
          ctrlKey: !!event?.ctrlKey,
          metaKey: !!event?.metaKey,
          shiftKey: !!event?.shiftKey
        });
        return;
      }
      this._selectElevation(separator, event);
      return;
    }

    const target = event.target?.closest?.('[data-tile-id]');
    if (!target) return;
    const list = target.parentElement;
    const items = list ? Array.from(list.querySelectorAll('[data-tile-id]')) : [target];
    const currentIndex = items.indexOf(target);
    const tileId = target.dataset.tileId;
    if (!tileId) return;
    this._lastClickedTileId = tileId;

    this._activateTilesLayer();

    const tile = canvas?.tiles?.placeables?.find((t) => (t?.document?.id || t?.id) === tileId);
    if (!tile) return;

    const isMeta = !!(event.ctrlKey || event.metaKey);
    const isShift = !!event.shiftKey;

    if (!isMeta) this._clearSceneMarkerSelection();

    if (isShift && this._lastClickedIndex >= 0) {
      const start = Math.min(this._lastClickedIndex, currentIndex);
      const end = Math.max(this._lastClickedIndex, currentIndex);
      if (!isMeta) {
        try { canvas.tiles.releaseAll(); } catch (_) {}
      }
      for (let i = start; i <= end; i += 1) {
        const rangeId = items[i]?.dataset?.tileId;
        if (!rangeId) continue;
        const rangeTile = canvas?.tiles?.placeables?.find((t) => (t?.document?.id || t?.id) === rangeId);
        if (!rangeTile) continue;
        try { rangeTile.control({ releaseOthers: false }); } catch (_) {}
      }
    } else if (isMeta) {
      try {
        if (tile.controlled) tile.release();
        else tile.control({ releaseOthers: false });
      } catch (_) {}
    } else {
      try { tile.control({ releaseOthers: true }); } catch (_) {}
    }

    this._lastClickedIndex = currentIndex;
    this._syncSelectionFromCanvas();
  }

  _onListDoubleClick(event) {
    this._clearPendingSeparatorSelection();
    if (event.target?.closest?.('.fa-nexus-layer-manager__rename-input')) return;
    if (event.target?.closest?.('.fa-nexus-layer-manager__separator-group-name-input')) return;
    if (event.target?.closest?.('.fa-nexus-layer-manager__separator-group-elevation-input')) return;
    if (event.target?.closest?.('[data-action="toggle-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-elevation-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-lock"]')) return;
    if (event.target?.closest?.('[data-action="toggle-elevation-collapse"]')) return;
    const groupName = event.target?.closest?.('.fa-nexus-layer-manager__separator-name');
    if (groupName) {
      const separator = groupName.closest('.fa-nexus-layer-manager__separator:not(.fa-nexus-layer-manager__separator--foreground)');
      const elevationKey = String(separator?.dataset?.elevationKey || '').trim();
      if (!elevationKey) return;
      event.preventDefault();
      event.stopPropagation();
      this._beginElevationGroupNameEdit(elevationKey);
      return;
    }
    if (event.target?.closest?.('[data-scene-marker]')) {
      this._openSceneSettings();
      return;
    }
    const target = event.target?.closest?.('[data-tile-id]');
    if (!target) return;
    const tileId = target.dataset.tileId;
    if (!tileId) return;
    const tile = canvas?.tiles?.placeables?.find((t) => (t?.document?.id || t?.id) === tileId);
    if (!tile) return;
    this._activateTilesLayer();
    try {
      const center = tile.center || { x: tile.document?.x ?? 0, y: tile.document?.y ?? 0 };
      canvas.animatePan({ x: center.x, y: center.y, duration: 250 });
    } catch (_) {}
  }

  _onListContextMenu(event) {
    this._clearPendingSeparatorSelection();
    if (event.target?.closest?.('.fa-nexus-layer-manager__rename-input')) return;
    if (event.target?.closest?.('.fa-nexus-layer-manager__separator-group-name-input')) return;
    if (event.target?.closest?.('.fa-nexus-layer-manager__separator-group-elevation-input')) return;
    if (event.target?.closest?.('[data-action="toggle-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-elevation-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-lock"]')) return;
    if (event.target?.closest?.('[data-action="toggle-elevation-collapse"]')) return;
    const separator = event.target?.closest?.('.fa-nexus-layer-manager__separator:not(.fa-nexus-layer-manager__separator--foreground)');
    if (separator) {
      const elevationKey = String(separator?.dataset?.elevationKey || '').trim();
      if (!elevationKey) return;
      const docs = this._getGroupContextMenuDocs(elevationKey);
      const canUpdateAll = docs.length > 0 && docs.every((doc) => doc?.canUserModify?.(game.user, 'update'));
      const allLocked = docs.length > 0 && docs.every((doc) => !!doc?.locked);
      const filtersApplied = !!this._viewState?.filtersApplied;
      const canRenameGroup = !!canvas?.scene?.canUserModify?.(game.user, 'update');
      event.preventDefault();
      event.stopPropagation();
      this._showLayerContextMenu(event, [
        {
          label: 'Rename',
          iconClass: 'fa-solid fa-i-cursor',
          disabled: !canRenameGroup,
          action: () => this._beginElevationGroupNameEdit(elevationKey),
          errorMessage: 'Failed to begin elevation group rename.'
        },
        {
          label: 'Change Elevation',
          iconClass: 'fa-solid fa-arrows-up-down',
          disabled: !canUpdateAll || filtersApplied,
          title: filtersApplied ? 'Clear filters before changing a group elevation.' : '',
          action: () => {
            this._beginElevationGroupElevationEdit(elevationKey);
          },
          errorMessage: 'Failed to begin elevation group edit.'
        },
        {
          label: allLocked ? 'Unlock' : 'Lock',
          iconClass: allLocked ? 'fa-solid fa-lock-open' : 'fa-solid fa-lock',
          disabled: !canUpdateAll,
          action: () => this._toggleDocsLock(docs),
          errorMessage: 'Failed to update layer locks.'
        },
        this._buildFlattenContextMenuItem(docs)
      ]);
      return;
    }

    const target = event.target?.closest?.('[data-tile-id]');
    if (!target) return;
    const tileId = String(target.dataset.tileId || '').trim();
    if (!tileId) return;
    const clickedTile = this._getTilePlaceable(tileId);
    if (!clickedTile) {
      Logger.error('LayerManager.contextMenu.tile.missing', { tileId });
      return;
    }
    this._triggerTileContextHighlight(clickedTile, event);
    if (this._isDoubleContextClick(tileId)) {
      event.preventDefault();
      event.stopPropagation();
      this._closeContextMenu();
      this._openTileSettings(clickedTile);
      return;
    }
    const docs = this._getContextMenuTileDocs(tileId);
    if (!docs.length) return;
    const clickedDoc = clickedTile?.document || docs[0] || null;
    const canUpdateAll = docs.every((doc) => doc?.canUserModify?.(game.user, 'update'));
    const allLocked = docs.every((doc) => !!doc?.locked);
    const hasNexusEdit = docs.length === 1 && !!getFaNexusTileEditMode(clickedDoc);
    const menuAnchor = {
      clientX: Number(event?.clientX ?? 0),
      clientY: Number(event?.clientY ?? 0)
    };
    event.preventDefault();
    event.stopPropagation();
    this._showLayerContextMenu(event, [
      {
        label: 'Rename',
        iconClass: 'fa-solid fa-i-cursor',
        disabled: docs.length !== 1 || !clickedDoc?.canUserModify?.(game.user, 'update'),
        action: () => this._beginRename(tileId),
        errorMessage: 'Failed to begin layer rename.'
      },
      {
        label: 'Change Elevation',
        iconClass: 'fa-solid fa-arrows-up-down',
        disabled: !canUpdateAll,
        action: () => this._promptDocsElevationChange(docs, menuAnchor),
        errorMessage: 'Failed to change layer elevation.'
      },
      {
        label: allLocked ? 'Unlock' : 'Lock',
        iconClass: allLocked ? 'fa-solid fa-lock-open' : 'fa-solid fa-lock',
        disabled: !canUpdateAll,
        action: () => this._toggleDocsLock(docs),
        errorMessage: 'Failed to update layer locks.'
      },
      {
        label: 'Nexus Edit',
        iconClass: 'fa-solid fa-wand-magic-sparkles',
        disabled: !hasNexusEdit,
        action: () => this._openNexusTileEditor(clickedDoc),
        errorMessage: 'Failed to open FA Nexus editor.'
      },
      {
        label: 'Edit',
        iconClass: 'fa-solid fa-pen-to-square',
        disabled: docs.length !== 1 || !clickedTile,
        action: () => this._openTileSettings(clickedTile),
        errorMessage: 'Failed to open layer settings.'
      },
      this._buildFlattenContextMenuItem(docs)
    ]);
  }

  _onListHover(event) {
    const target = event.target?.closest?.('[data-tile-id]');
    if (!target) return;
    const tileId = target.dataset.tileId;
    if (!tileId || tileId === this._hoveredTileId) return;
    this._clearHover();
    const tile = canvas?.tiles?.placeables?.find((t) => (t?.document?.id || t?.id) === tileId);
    if (!tile) return;
    if (isTileBeingEdited(tile)) return;
    try { tile._onHoverIn(hoverEventStub, { hoverOutOthers: true }); } catch (_) {}
    this._hoveredTileId = tileId;
  }

  _startWheelSession() {
    if (this._wheelSession || !canvas?.ready) return;
    this._wheelSession = createCanvasGestureSession({
      wheel: { handler: (event, { pointer }) => this._onCanvasWheel(event, pointer), respectZIndex: true },
      keydown: (event, { pointer }) => this._onCanvasKeyDown(event, pointer),
      keyup: (event) => this._onCanvasKeyUp(event)
    }, {
      onCanvasTearDown: () => this._stopWheelSession()
    });
  }

  _stopWheelSession() {
    if (!this._wheelSession) return;
    try { this._wheelSession.stop('layer-manager'); } catch (_) {}
    this._wheelSession = null;
    this._clearElevationAnnounceTimer();
  }

  _resolveElevationStep({ shiftKey = false, ctrlKey = false, metaKey = false } = {}) {
    if (shiftKey) return ELEVATION_STEP_COARSE;
    if (ctrlKey || metaKey) return ELEVATION_STEP_FINE;
    return ELEVATION_STEP_DEFAULT;
  }

  _getElevationShortcutDirection(event = null) {
    const code = String(event?.code || '');
    if (code === 'BracketRight' || code === 'ArrowUp') return 1;
    if (code === 'BracketLeft' || code === 'ArrowDown') return -1;
    return 0;
  }

  _getElevationAnnouncePoint(pointer = null) {
    const coerce = (point) => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
      return { x: Number(point.x), y: Number(point.y) };
    };
    const direct = coerce(pointer?.world || pointer);
    if (direct) return direct;
    const selectedTile = Array.isArray(canvas?.tiles?.controlled)
      ? canvas.tiles.controlled.find((tile) => !!tile && !tile.destroyed) || null
      : null;
    const selectedCenter = coerce(selectedTile?.center);
    if (selectedCenter) return selectedCenter;
    const doc = selectedTile?.document || this._getSelectedTileDocs()[0] || null;
    const docX = Number(doc?.x);
    const docY = Number(doc?.y);
    const docW = Number(doc?.width);
    const docH = Number(doc?.height);
    if (Number.isFinite(docX) && Number.isFinite(docY) && Number.isFinite(docW) && Number.isFinite(docH)) {
      return { x: docX + (docW / 2), y: docY + (docH / 2) };
    }
    const dimensions = canvas?.dimensions;
    const sceneX = Number((dimensions?.sceneX ?? dimensions?.x ?? 0) || 0) || 0;
    const sceneY = Number((dimensions?.sceneY ?? dimensions?.y ?? 0) || 0) || 0;
    const sceneWidth = Number((dimensions?.sceneWidth ?? dimensions?.width ?? canvas?.scene?.width) || 0) || 0;
    const sceneHeight = Number((dimensions?.sceneHeight ?? dimensions?.height ?? canvas?.scene?.height) || 0) || 0;
    if (sceneWidth > 0 && sceneHeight > 0) {
      return { x: sceneX + (sceneWidth / 2), y: sceneY + (sceneHeight / 2) };
    }
    return null;
  }

  _onCanvasKeyDown(event, pointer = null) {
    if (!event) return;
    if (event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight') {
      setAltKeyHeld(true);
      return;
    }
    const elevationDirection = event.altKey ? this._getElevationShortcutDirection(event) : 0;
    if (elevationDirection !== 0) {
      if (this._isEditableElement(event.target) || this._isEditableElement(document?.activeElement)) return;
      if (this._adjustElevationSelection(elevationDirection, event, { pointer, source: 'key' })) return;
    }
    if (this._shouldHandleRenameHotkey(event)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      this._beginRenameFromHotkey();
    }
  }

  _onCanvasKeyUp(event) {
    if (!event) return;
    if (event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight') {
      setAltKeyHeld(false);
    }
  }

  _onCanvasWheel(event, pointer) {
    if (!this.active && !this.isPopout) return;
    if (!pointer?.overCanvas || !pointer?.zOk) return;
    this._handleElevationWheel(event, pointer);
  }

  _handleElevationWheel(event, pointer = null) {
    const altActive = !!event?.altKey;
    if (event) setAltKeyHeld(altActive);
    if (!altActive) return;
    const direction = event.deltaY < 0 ? 1 : -1;
    this._adjustElevationSelection(direction, event, { pointer, source: 'wheel' });
  }

  _adjustElevationSelection(direction, event = null, { pointer = null, source = 'unknown' } = {}) {
    if (!Number.isFinite(direction) || direction === 0) return false;
    const step = this._resolveElevationStep(event || {});
    if (!canvas?.ready || !canvas?.scene) return false;
    let markerAdjusted = false;
    if (this._selectedSceneMarkers?.size) {
      for (const markerKind of this._selectedSceneMarkers) {
        if (this._adjustSceneMarkerElevation(markerKind, direction, step, pointer)) {
          markerAdjusted = true;
        }
      }
    }

    if (!canvas?.tiles && !markerAdjusted) return false;
    if (!canvas?.tiles) {
      if (markerAdjusted && event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
      }
      return markerAdjusted;
    }
    const selection = Array.isArray(canvas.tiles.controlled) ? canvas.tiles.controlled : [];
    if (!selection.length && !markerAdjusted) return false;
    const orderedDocs = this._getOrderedDocsByIds(
      selection
        .map((tile) => tile?.document?.id || tile?.id)
        .filter(Boolean)
    );
    const minElevation = -1000;
    const maxElevation = 1000;
    const groups = new Map();
    const movedGroupsBySource = new Map();
    const movedDocIds = new Set();
    let announceElevation = null;
    const elevationDelta = direction * step;

    for (const doc of orderedDocs) {
      if (!doc?.canUserModify?.(game.user, 'update')) continue;
      if (doc?.locked) continue;
      const current = Number(doc.elevation ?? 0) || 0;
      const clamped = Math.min(maxElevation, Math.max(minElevation, current + elevationDelta));
      const next = quantizeElevation(clamped);
      if (next === current) continue;
      const id = doc.id || doc._id;
      if (!id) continue;
      const sourceKey = elevationGroupKey(current);
      const targetKey = elevationGroupKey(next);
      if (announceElevation === null) announceElevation = next;
      let group = groups.get(next);
      if (!group) {
        group = [];
        groups.set(next, group);
      }
      group.push({ id, elevation: next });
      let movedGroup = movedGroupsBySource.get(sourceKey);
      if (!movedGroup) {
        movedGroup = { ids: new Set(), targetKey };
        movedGroupsBySource.set(sourceKey, movedGroup);
      }
      movedGroup.ids.add(id);
      movedDocIds.add(id);
    }

    if (!groups.size && !markerAdjusted) return false;
    if (!groups.size && markerAdjusted && event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      return true;
    }
    const updates = [];
    for (const [elevation, items] of groups.entries()) {
      let nextSort = computeNextSortAtElevation(elevation);
      if (!Number.isFinite(nextSort)) nextSort = 0;
      // Preserve the current top-to-bottom order of the selected rows.
      nextSort += Math.max(0, items.length - 1) * 2;
      for (const item of items) {
        updates.push({ _id: item.id, elevation, sort: nextSort });
        nextSort -= 2;
      }
    }
    const completeElevationGroupMoves = this._usesNestedGrouping()
      ? this._collectCompleteVisibleGroupMovesForDelta(movedDocIds, elevationDelta)
      : (() => {
        const moves = [];
        for (const [sourceKey, moveState] of movedGroupsBySource.entries()) {
          const fullDocs = this._getFullElevationDocs(sourceKey);
          const fullIds = fullDocs.map((doc) => doc?.id).filter(Boolean);
          if (!fullIds.length || fullIds.length !== moveState.ids.size) continue;
          if (!fullIds.every((id) => moveState.ids.has(id))) continue;
          if (moveState.targetKey === sourceKey) continue;
          moves.push({ sourceKey, targetKey: moveState.targetKey });
        }
        return moves;
      })();

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    if (updates.length) {
      const scene = canvas?.scene;
      try {
        const updatePromise = Promise.resolve(scene?.updateEmbeddedDocuments?.('Tile', updates));
        updatePromise
          .then(() => {
            if (!completeElevationGroupMoves.length || !scene) return;
            const metadata = getSceneElevationGroupMetadata(scene);
            const nextMetadata = mergeElevationGroupMetadataOnBulkMove({ metadata, moves: completeElevationGroupMoves });
            return setSceneElevationGroupMetadata(scene, nextMetadata)
              .then(() => {
                Logger.info('LayerManager.elevationGroup.adjust.commit', {
                  sceneId: scene.id || null,
                  source,
                  moveCount: completeElevationGroupMoves.length,
                  moves: completeElevationGroupMoves
                });
              })
              .catch((error) => {
                Logger.error('LayerManager.elevationGroup.adjust.metadataFailed', {
                  sceneId: scene.id || null,
                  source,
                  moveCount: completeElevationGroupMoves.length,
                  moves: completeElevationGroupMoves,
                  error: String(error?.message || error)
                });
                ui?.notifications?.error?.(`Layers moved but failed to update elevation group names: ${error?.message || error}`);
              });
          })
          .catch((error) => {
            Logger.error('LayerManager.elevationAdjust.failed', {
              sceneId: scene?.id || null,
              source,
              updateCount: updates.length,
              markerAdjusted,
              error: String(error?.message || error)
            });
            ui?.notifications?.error?.(`Failed to change layer elevation: ${error?.message || error}`);
          });
      } catch (error) {
        Logger.error('LayerManager.elevationAdjust.failed', {
          sceneId: scene?.id || null,
          source,
          updateCount: updates.length,
          markerAdjusted,
          error: String(error?.message || error)
        });
        ui?.notifications?.error?.(`Failed to change layer elevation: ${error?.message || error}`);
      }
    }
    if (Number.isFinite(announceElevation)) {
      this._queueElevationAnnounce(this._getElevationAnnouncePoint(pointer), announceElevation);
    }
    return true;
  }

  _onListWheel(event) {
    this._handleElevationWheel(event);
  }

  _clearElevationAnnounceTimer() {
    if (this._elevationAnnounceTimer) {
      clearTimeout(this._elevationAnnounceTimer);
      this._elevationAnnounceTimer = null;
    }
    this._pendingElevationAnnouncePoint = null;
    this._pendingElevationAnnounceMessage = null;
  }

  _queueElevationAnnounce(worldPoint, elevation, options = {}) {
    if (!Number.isFinite(elevation)) return;
    const now = Date.now();
    const delta = now - this._lastElevationAnnounce;
    const throttleMs = 75;
    const immediate = options?.immediate === true;
    this._pendingElevationAnnouncePoint = worldPoint ?? this._pendingElevationAnnouncePoint ?? null;
    this._pendingElevationAnnounceMessage = `Elevation: ${formatElevation(elevation)}`;

    if (immediate || delta >= throttleMs) {
      this._flushElevationAnnounce();
      return;
    }

    const remaining = Math.max(0, throttleMs - delta);
    if (this._elevationAnnounceTimer) clearTimeout(this._elevationAnnounceTimer);
    this._elevationAnnounceTimer = setTimeout(() => {
      this._elevationAnnounceTimer = null;
      this._flushElevationAnnounce();
    }, remaining);
  }

  _flushElevationAnnounce() {
    try {
      this._lastElevationAnnounce = Date.now();
      const worldPoint = this._pendingElevationAnnouncePoint ?? null;
      const message = this._pendingElevationAnnounceMessage ?? '';
      this._pendingElevationAnnouncePoint = null;
      this._pendingElevationAnnounceMessage = null;
      if (!worldPoint || !message) return;
      if (canvas?.interface?.createScrollingText && globalThis.CONST?.TEXT_ANCHOR_POINTS) {
        canvas.interface.createScrollingText(worldPoint, message, {
          anchor: CONST.TEXT_ANCHOR_POINTS.CENTER,
          direction: CONST.TEXT_ANCHOR_POINTS.TOP,
          distance: 60,
          duration: 900,
          fade: 0.8,
          stroke: 0x111111,
          strokeThickness: 4,
          fill: 0xffffff,
          fontSize: 26
        });
      }
    } catch (_) {}
  }

  _clearHover() {
    if (!this._hoveredTileId) return;
    const tile = canvas?.tiles?.placeables?.find((t) => (t?.document?.id || t?.id) === this._hoveredTileId);
    if (tile) {
      try { tile._onHoverOut(hoverEventStub); } catch (_) {}
    }
    this._hoveredTileId = null;
  }

  _shouldHandleRenameHotkey(event) {
    if ((!this.active && !this.isPopout) || this._renameSubmitting) return false;
    const key = String(event?.key || '');
    const code = String(event?.code || '');
    if (key !== 'F2' && code !== 'F2') return false;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    if (this._isEditableElement(event.target) || this._isEditableElement(document?.activeElement)) return false;
    return true;
  }

  _isEditableElement(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element.closest('.fa-nexus-layer-manager__rename-input')) return true;
    return !!element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
  }

  _beginRenameFromHotkey() {
    const tileId = this._resolveRenameTargetId();
    if (!tileId) return;
    this._beginRename(tileId);
  }

  _resolveRenameTargetId() {
    const root = this.element;
    const list = root?.querySelector?.('.fa-nexus-layer-manager__list');
    if (!list) return null;
    const resolveRowId = (selector) => {
      const row = list.querySelector(selector);
      return row?.dataset?.tileId || null;
    };
    if (this._lastClickedTileId) {
      const match = resolveRowId(`[data-tile-id="${CSS.escape(this._lastClickedTileId)}"]`);
      if (match) return match;
    }
    return resolveRowId('[data-tile-id].is-selected');
  }

  _findRenameDocument(tileId) {
    if (!tileId) return null;
    return canvas?.scene?.tiles?.get?.(tileId)
      || canvas?.tiles?.placeables?.find?.((tile) => (tile?.document?.id || tile?.id) === tileId)?.document
      || null;
  }

  _beginRename(tileId) {
    const doc = this._findRenameDocument(tileId);
    if (!doc) return;
    if (!doc?.canUserModify?.(game.user, 'update')) {
      ui?.notifications?.warn?.('You do not have permission to rename this tile.');
      return;
    }
    this._clearElevationGroupEditState();
    const root = this.element;
    const item = root?.querySelector?.(`[data-tile-id="${CSS.escape(tileId)}"]`);
    const currentLabel = item?.querySelector?.('.fa-nexus-layer-manager__name')?.textContent?.trim()
      || computeTileName({ document: doc }, 0);
    this._renamingTileId = tileId;
    this._renameDraft = currentLabel || '';
    this._renameFocusPending = true;
    this._scheduleRender();
  }

  _clearRenameState() {
    this._renamingTileId = null;
    this._renameDraft = '';
    this._renameFocusPending = false;
  }

  _cancelRename() {
    if (!this._renamingTileId) return;
    this._clearRenameState();
    this._scheduleRender();
  }

  async _commitRename(inputEl = null) {
    const tileId = this._renamingTileId;
    if (!tileId || this._renameSubmitting) return;
    const doc = this._findRenameDocument(tileId);
    if (!doc) {
      this._clearRenameState();
      this._scheduleRender();
      return;
    }

    const nextValue = String(inputEl?.value ?? this._renameDraft ?? '').trim();
    const currentValue = String(readFaFlag(doc, 'name') || '').trim();
    this._renameDraft = nextValue;
    this._renameSubmitting = true;

    try {
      if (!doc?.canUserModify?.(game.user, 'update')) {
        ui?.notifications?.warn?.('You do not have permission to rename this tile.');
        this._clearRenameState();
        this._scheduleRender();
        return;
      }
      if (!nextValue) {
        if (currentValue) {
          if (typeof doc.unsetFlag === 'function') await doc.unsetFlag(MODULE_ID, 'name');
          else await doc.update({ [`flags.${MODULE_ID}.-=name`]: null });
        }
      } else if (nextValue !== currentValue) {
        if (typeof doc.setFlag === 'function') await doc.setFlag(MODULE_ID, 'name', nextValue);
        else await doc.update({ [`flags.${MODULE_ID}.name`]: nextValue });
      }
      this._clearRenameState();
      this._scheduleRender();
    } finally {
      this._renameSubmitting = false;
    }
  }

  _onRenameInputKeyDown(event) {
    if (!event) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      this._commitRename(event.currentTarget).catch((error) => {
        Logger.warn('LayerManager.rename.failed', { error: String(error?.message || error) });
        ui?.notifications?.error?.(`Failed to rename tile: ${error?.message || error}`);
      });
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this._cancelRename();
    }
  }

  _clearElevationGroupNameEditState() {
    this._editingElevationGroupNameKey = null;
    this._editingElevationGroupNameDraft = '';
    this._editingElevationGroupNameFocusPending = false;
  }

  _clearElevationGroupElevationEditState() {
    this._editingElevationGroupElevationKey = null;
    this._editingElevationGroupElevationDraft = '';
    this._editingElevationGroupElevationFocusPending = false;
  }

  _clearElevationGroupEditState() {
    this._clearElevationGroupNameEditState();
    this._clearElevationGroupElevationEditState();
  }

  _beginElevationGroupNameEdit(elevationKey) {
    const key = String(elevationKey || '').trim();
    if (!key) return;
    const scene = canvas?.scene;
    if (!scene?.canUserModify?.(game.user, 'update')) {
      ui?.notifications?.warn?.('You do not have permission to rename elevation groups.');
      return;
    }
    this._clearRenameState();
    const metadata = getSceneElevationGroupMetadata(scene);
    this._clearElevationGroupElevationEditState();
    this._editingElevationGroupNameKey = key;
    this._editingElevationGroupNameDraft = getElevationGroupName(metadata, key);
    this._editingElevationGroupNameFocusPending = true;
    Logger.info('LayerManager.elevationGroup.rename.begin', {
      sceneId: scene.id || null,
      elevationKey: key
    });
    this._scheduleRender();
  }

  _cancelElevationGroupNameEdit() {
    if (!this._editingElevationGroupNameKey) return;
    this._clearElevationGroupNameEditState();
    this._scheduleRender();
  }

  async _commitElevationGroupNameEdit(inputEl = null) {
    const elevationKey = String(this._editingElevationGroupNameKey || '').trim();
    if (!elevationKey || this._editingElevationGroupSubmitting) return;
    const scene = canvas?.scene;
    if (!scene) {
      this._clearElevationGroupNameEditState();
      this._scheduleRender();
      return;
    }
    const nextValue = String(inputEl?.value ?? this._editingElevationGroupNameDraft ?? '').trim();
    const metadata = getSceneElevationGroupMetadata(scene);
    const currentValue = getElevationGroupName(metadata, elevationKey);
    this._editingElevationGroupNameDraft = nextValue;
    this._editingElevationGroupSubmitting = true;

    try {
      if (!scene?.canUserModify?.(game.user, 'update')) {
        ui?.notifications?.warn?.('You do not have permission to rename elevation groups.');
        this._clearElevationGroupNameEditState();
        this._scheduleRender();
        return;
      }
      if (nextValue === currentValue) {
        this._clearElevationGroupNameEditState();
        this._scheduleRender();
        return;
      }
      const fullGroupNode = this._getFullGroupNode(elevationKey);
      const nextMetadata = cloneElevationGroupMetadata(metadata);
      if (!nextValue) delete nextMetadata[elevationKey];
      else {
        const nextEntry = {
          ...(nextMetadata[elevationKey] || {}),
          name: nextValue
        };
        if (fullGroupNode?.isSynthetic) nextEntry.synthetic = true;
        else delete nextEntry.synthetic;
        nextMetadata[elevationKey] = nextEntry;
      }
      await setSceneElevationGroupMetadata(scene, nextMetadata);
      Logger.info('LayerManager.elevationGroup.rename.commit', {
        sceneId: scene.id || null,
        elevationKey,
        name: nextValue || null
      });
      this._clearElevationGroupNameEditState();
      this._scheduleRender();
    } catch (error) {
      this._editingElevationGroupNameFocusPending = true;
      this._scheduleRender();
      throw error;
    } finally {
      this._editingElevationGroupSubmitting = false;
    }
  }

  _onElevationGroupNameInputKeyDown(event) {
    if (!event) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      this._commitElevationGroupNameEdit(event.currentTarget).catch((error) => {
        Logger.error('LayerManager.elevationGroup.rename.failed', {
          elevationKey: this._editingElevationGroupNameKey || null,
          error: String(error?.message || error)
        });
        ui?.notifications?.error?.(`Failed to rename elevation group: ${error?.message || error}`);
      });
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this._cancelElevationGroupNameEdit();
    }
  }

  _beginElevationGroupElevationEdit(elevationKey) {
    const key = String(elevationKey || '').trim();
    if (!key) return;
    const scene = canvas?.scene;
    if (!scene?.canUserModify?.(game.user, 'update')) {
      ui?.notifications?.warn?.('You do not have permission to move elevation groups.');
      return;
    }
    this._clearRenameState();
    this._clearElevationGroupNameEditState();
    this._editingElevationGroupElevationKey = key;
    this._editingElevationGroupElevationDraft = formatElevation(Number(key));
    this._editingElevationGroupElevationFocusPending = true;
    Logger.info('LayerManager.elevationGroup.move.begin', {
      sceneId: scene.id || null,
      elevationKey: key
    });
    this._scheduleRender();
  }

  _cancelElevationGroupElevationEdit() {
    if (!this._editingElevationGroupElevationKey) return;
    this._clearElevationGroupElevationEditState();
    this._scheduleRender();
  }

  async _commitElevationGroupElevationEdit(inputEl = null) {
    const sourceKey = String(this._editingElevationGroupElevationKey || '').trim();
    if (!sourceKey || this._editingElevationGroupSubmitting) return;
    const scene = canvas?.scene;
    if (!scene?.updateEmbeddedDocuments) {
      this._clearElevationGroupElevationEditState();
      this._scheduleRender();
      return;
    }
    const draft = String(inputEl?.value ?? this._editingElevationGroupElevationDraft ?? '').trim();
    const nextElevation = parseElevationInput(draft);
    this._editingElevationGroupElevationDraft = draft;
    this._editingElevationGroupSubmitting = true;

    try {
      if (!scene?.canUserModify?.(game.user, 'update')) {
        ui?.notifications?.warn?.('You do not have permission to move elevation groups.');
        this._clearElevationGroupElevationEditState();
        this._scheduleRender();
        return;
      }
      if (!Number.isFinite(nextElevation)) {
        throw new Error('Elevation group value must be a valid number.');
      }
      const targetElevation = quantizeElevation(nextElevation);
      const targetKey = elevationGroupKey(targetElevation);
      if (targetKey === sourceKey) {
        this._clearElevationGroupElevationEditState();
        this._scheduleRender();
        return;
      }
      if (this._usesNestedGrouping() && this._viewState?.filtersApplied) {
        throw new Error('Clear layer filters before moving nested elevation groups.');
      }

      const sourceGroupNode = this._getFullGroupNode(sourceKey);
      const movingDocs = this._getOrderedDocsByIds(
        this._getFullElevationDocs(sourceKey).map((doc) => doc?.id).filter(Boolean)
      );
      if (!movingDocs.length) {
        this._clearElevationGroupElevationEditState();
        this._scheduleRender();
        return;
      }
      const blockedDocs = movingDocs.filter((doc) => !doc?.canUserModify?.(game.user, 'update'));
      if (blockedDocs.length) {
        throw new Error('You do not have permission to move every layer in this elevation group.');
      }

      const movedDocIds = new Set(movingDocs.map((doc) => doc?.id).filter(Boolean));
      const updates = [];
      if (this._usesNestedGrouping()) {
        const sourceElevation = Number(sourceGroupNode?.elevation ?? parseElevationInput(sourceKey));
        if (!Number.isFinite(sourceElevation)) {
          throw new Error(`Unable to resolve source elevation group ${sourceKey}.`);
        }
        const delta = quantizeElevation(targetElevation - sourceElevation);
        const targetGroups = new Map();
        for (const doc of movingDocs) {
          const currentElevation = Number(doc?.elevation ?? 0) || 0;
          const nextDocElevation = quantizeElevation(currentElevation + delta);
          const nextDocKey = elevationGroupKey(nextDocElevation);
          let bucket = targetGroups.get(nextDocKey);
          if (!bucket) {
            bucket = {
              elevation: nextDocElevation,
              items: []
            };
            targetGroups.set(nextDocKey, bucket);
          }
          bucket.items.push(doc);
        }
        for (const bucket of targetGroups.values()) {
          let nextSort = computeNextSortAtElevation(bucket.elevation);
          if (!Number.isFinite(nextSort)) nextSort = 0;
          nextSort += Math.max(0, bucket.items.length - 1) * 2;
          for (const doc of bucket.items) {
            updates.push({
              _id: doc.id,
              elevation: bucket.elevation,
              sort: nextSort
            });
            nextSort -= 2;
          }
        }
      } else {
        let nextSort = computeNextSortAtElevation(targetElevation);
        if (!Number.isFinite(nextSort)) nextSort = 0;
        nextSort += Math.max(0, movingDocs.length - 1) * 2;
        for (const doc of movingDocs) {
          updates.push({
            _id: doc.id,
            elevation: targetElevation,
            sort: nextSort
          });
          nextSort -= 2;
        }
      }
      await scene.updateEmbeddedDocuments('Tile', updates);
      const metadata = getSceneElevationGroupMetadata(scene);
      const nextMetadata = this._usesNestedGrouping()
        ? mergeElevationGroupMetadataOnBulkMove({
          metadata,
          moves: this._collectCompleteVisibleGroupMovesForDelta(
            movedDocIds,
            targetElevation - Number(sourceGroupNode?.elevation ?? parseElevationInput(sourceKey) ?? 0)
          )
        })
        : mergeElevationGroupMetadataOnMove({
          metadata,
          sourceKey,
          targetKey
        });
      await setSceneElevationGroupMetadata(scene, nextMetadata);
      Logger.info('LayerManager.elevationGroup.move.commit', {
        sceneId: scene.id || null,
        sourceKey,
        targetKey,
        tileCount: updates.length,
        nestedGrouping: this._usesNestedGrouping()
      });
      this._clearElevationGroupElevationEditState();
      this._scheduleRender();
    } catch (error) {
      this._editingElevationGroupElevationFocusPending = true;
      this._scheduleRender();
      throw error;
    } finally {
      this._editingElevationGroupSubmitting = false;
    }
  }

  _onElevationGroupElevationInputKeyDown(event) {
    if (!event) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      this._commitElevationGroupElevationEdit(event.currentTarget).catch((error) => {
        Logger.error('LayerManager.elevationGroup.move.failed', {
          elevationKey: this._editingElevationGroupElevationKey || null,
          error: String(error?.message || error)
        });
        ui?.notifications?.error?.(`Failed to move elevation group: ${error?.message || error}`);
      });
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this._cancelElevationGroupElevationEdit();
    }
  }

  _toggleVisibility(buttonEl) {
    const item = buttonEl?.closest?.('[data-tile-id]');
    if (!item) return;
    const tileId = item.dataset.tileId;
    if (!tileId) return;
    const tile = canvas?.tiles?.placeables?.find((t) => (t?.document?.id || t?.id) === tileId) || null;
    const doc = tile?.document || canvas?.scene?.tiles?.get?.(tileId) || null;
    if (!doc?.canUserModify?.(game.user, 'update')) return;
    const selectedDocs = this._getSelectedTileDocs().filter((selectedDoc) => selectedDoc?.canUserModify?.(game.user, 'update'));
    const selectionHasDoc = selectedDocs.some((selectedDoc) => selectedDoc?.id === doc.id);
    const targets = selectionHasDoc && selectedDocs.length > 1 ? selectedDocs : [doc];
    const nextHidden = !isLayerHidden(doc);
    for (const target of targets) {
      setLayerHidden(target, nextHidden);
    }
  }

  _toggleElevationVisibility(buttonEl) {
    const separator = buttonEl?.closest?.('.fa-nexus-layer-manager__separator');
    const elevationKey = String(buttonEl?.dataset?.elevationKey || separator?.dataset?.elevationKey || '').trim();
    if (!elevationKey) return;
    const targets = this._getMatchingElevationDocs(elevationKey);
    const toggleTargets = targets.filter((target) => target?.canUserModify?.(game.user, 'update'));
    if (!toggleTargets.length) return;
    const allHidden = toggleTargets.every((target) => isLayerHidden(target));
    const nextHidden = !allHidden;
    for (const target of toggleTargets) {
      setLayerHidden(target, nextHidden);
    }
  }

  _toggleLock(buttonEl) {
    const item = buttonEl?.closest?.('[data-tile-id]');
    if (!item) return;
    const tileId = item.dataset.tileId;
    if (!tileId) return;
    const tile = canvas?.tiles?.placeables?.find((t) => (t?.document?.id || t?.id) === tileId) || null;
    const doc = tile?.document || canvas?.scene?.tiles?.get?.(tileId) || null;
    if (!doc?.canUserModify?.(game.user, 'update')) return;
    try { doc.update({ locked: !doc.locked }); } catch (_) {}
  }

  _toggleElevationLock(buttonEl) {
    const separator = buttonEl?.closest?.('.fa-nexus-layer-manager__separator');
    const rawElevation = buttonEl?.dataset?.elevation || separator?.dataset?.elevation;
    const elevation = Number(rawElevation);
    if (!Number.isFinite(elevation)) return;
    const docs = canvas?.scene?.tiles ? Array.from(canvas.scene.tiles) : [];
    const targets = docs.filter((doc) => {
      if (!doc) return false;
      const docElevation = Number(doc?.elevation ?? 0);
      return docElevation === elevation;
    });
    const toggleTargets = targets.filter((target) => target?.canUserModify?.(game.user, 'update'));
    if (!toggleTargets.length) return;
    const allLocked = toggleTargets.every((target) => !!target?.locked);
    const nextLocked = !allLocked;
    for (const target of toggleTargets) {
      try { target.update({ locked: nextLocked }); } catch (_) {}
    }
  }

  _clearSceneMarkerSelection() {
    if (!this._selectedSceneMarkers?.size) return;
    this._selectedSceneMarkers.clear();
    this._scheduleRender();
  }

  _selectSceneMarker(markerEl, event = null) {
    const kindRaw = markerEl?.dataset?.sceneMarker;
    const kind = kindRaw === 'foreground' ? 'foreground' : (kindRaw === 'background' ? 'background' : null);
    if (!kind) return;
    const isMeta = !!(event?.ctrlKey || event?.metaKey);
    const isShift = !!event?.shiftKey;
    const allowMulti = isMeta || isShift;
    if (!allowMulti) {
      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      this._selectedSceneMarkers.clear();
      this._selectedSceneMarkers.add(kind);
    } else if (this._selectedSceneMarkers.has(kind)) {
      this._selectedSceneMarkers.delete(kind);
    } else {
      this._selectedSceneMarkers.add(kind);
    }
    this._scheduleRender();
    this._updateFlattenFooter();
  }

  _adjustSceneMarkerElevation(kind, direction, step, pointer = null) {
    const current = kind === 'foreground' ? getForegroundElevation() : getBackgroundElevation();
    if (!Number.isFinite(current)) return false;
    const minElevation = -1000;
    const maxElevation = 1000;
    const raw = current + (direction * step);
    const clamped = Math.min(maxElevation, Math.max(minElevation, raw));
    const next = quantizeElevation(clamped);
    if (next === current) return false;

    if (kind === 'foreground') {
      try { canvas?.scene?.update?.({ foregroundElevation: next }); } catch (_) {}
    } else {
      try {
        if (canvas?.scene && ('backgroundElevation' in canvas.scene)) {
          canvas.scene.update?.({ backgroundElevation: next });
        }
      } catch (_) {}
      setBackgroundRenderElevation(next);
      try {
        const enabled = isKeepTokensAboveTileElevationsEnabled();
        Hooks?.callAll?.('fa-nexus-token-elevation-offset-changed', { enabled });
      } catch (_) {}
    }

    const announceElevation = (kind === 'background')
      ? getBackgroundDisplayElevation()
      : next;
    this._queueElevationAnnounce(pointer?.world || null, announceElevation, { immediate: true });
    this._scheduleRender();
    return true;
  }

  _selectElevation(separatorEl, event) {
    const elevationKey = String(separatorEl?.dataset?.elevationKey || '').trim();
    if (!elevationKey) return;
    const docs = this._getMatchingElevationDocs(elevationKey);
    const targets = docs
      .map((doc) => doc?.object || canvas?.tiles?.placeables?.find?.((tile) => (tile?.document?.id || tile?.id) === doc?.id) || null)
      .filter((tile) => !!tile && !tile.destroyed);
    if (!targets.length) return;
    this._activateTilesLayer();
    const retain = !!(event?.ctrlKey || event?.metaKey);
    if (!retain) this._clearSceneMarkerSelection();
    if (!retain) {
      try { canvas.tiles.releaseAll(); } catch (_) {}
    }
    for (const target of targets) {
      try { target.control({ releaseOthers: false }); } catch (_) {}
    }
    this._syncSelectionFromCanvas();
  }

  _isDoubleContextClick(tileId) {
    const now = Date.now();
    const last = this._lastContextClick || { id: null, time: 0 };
    const isDouble = last.id === tileId && (now - last.time) < CONTEXT_DOUBLE_CLICK_MS;
    this._lastContextClick = { id: tileId, time: now };
    return isDouble;
  }

  _openTileSettings(tile) {
    const canView = tile.document?.testUserPermission?.(game.user, 'LIMITED');
    if (!canView) return;
    const stub = Object.assign({}, clickEventStub);
    if (typeof tile._onClickRight2 === 'function') {
      try { tile._onClickRight2(stub); } catch (_) {}
      return;
    }
    try { tile.sheet?.render?.({ force: true }); } catch (_) {}
  }

  _openSceneSettings() {
    try { canvas?.scene?.sheet?.render?.({ force: true }); } catch (_) {}
  }

  _queueScrollToTile(tileId) {
    if (!tileId || (!this.active && !this.isPopout)) return;
    this._scrollTargetId = tileId;
    if (this._scrollQueued) return;
    this._scrollQueued = true;
    requestAnimationFrame(() => {
      this._scrollQueued = false;
      const targetId = this._scrollTargetId;
      this._scrollTargetId = null;
      this._scrollToTile(targetId);
    });
  }

  _queueScrollToPreview(previewId) {
    if (!previewId || (!this.active && !this.isPopout)) return;
    this._scrollPreviewTargetId = previewId;
    if (this._scrollPreviewQueued) return;
    this._scrollPreviewQueued = true;
    requestAnimationFrame(() => {
      this._scrollPreviewQueued = false;
      const targetId = this._scrollPreviewTargetId;
      this._scrollPreviewTargetId = null;
      this._scrollToPreview(targetId);
    });
  }

  _scrollToTile(tileId) {
    const root = this.element;
    if (!root || !tileId) return;
    const list = root.querySelector('.fa-nexus-layer-manager__list');
    if (!list) return;
    const item = list.querySelector(`[data-tile-id="${CSS.escape(tileId)}"]`);
    if (!item) return;
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.top < listRect.top || itemRect.bottom > listRect.bottom) {
      try { item.scrollIntoView({ block: 'nearest' }); } catch (_) {}
    }
  }

  _scrollToPreview(previewId) {
    const root = this.element;
    if (!root || !previewId) return;
    const list = root.querySelector('.fa-nexus-layer-manager__list');
    if (!list) return;
    const item = list.querySelector(`[data-preview-id="${CSS.escape(previewId)}"]`);
    if (!item) return;
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.top < listRect.top || itemRect.bottom > listRect.bottom) {
      try { item.scrollIntoView({ block: 'nearest' }); } catch (_) {}
    }
  }

  _syncPreviewScroll() {
    const root = this.element;
    if (!root) return;
    const list = root.querySelector('.fa-nexus-layer-manager__list');
    if (!list) return;
    const activePreview = list.querySelector('.fa-nexus-layer-manager__item.is-preview.is-selected');
    if (!activePreview) {
      this._lastActivePreviewId = null;
      return;
    }
    const previewId = activePreview.dataset?.previewId || null;
    if (!previewId) return;
    if (previewId !== this._lastActivePreviewId) {
      this._lastActivePreviewId = previewId;
      this._queueScrollToPreview(previewId);
      return;
    }
    const listRect = list.getBoundingClientRect();
    const itemRect = activePreview.getBoundingClientRect();
    if (itemRect.top < listRect.top || itemRect.bottom > listRect.bottom) {
      this._queueScrollToPreview(previewId);
    }
  }

  _syncSelectionFromCanvas(tile = null, controlled = null) {
    const root = this.element;
    if (!root) return;
    const list = root.querySelector('.fa-nexus-layer-manager__list');
    if (!list) return;
    const selectedDocs = tile
      ? (() => {
        const isSelected = controlled === null ? !!tile?.controlled : !!controlled;
        return isSelected && tile?.document ? [tile.document] : [];
      })()
      : this._getSelectedTileDocs();
    const expandedGroups = this._expandElevationGroupsForDocs(selectedDocs);
    if (expandedGroups) {
      const scrollTargetId = tile?.document?.id || selectedDocs[0]?.id || null;
      if (scrollTargetId) this._queueScrollToTile(scrollTargetId);
      this._scheduleRender();
      this._updateSelectionActions();
      this._updateFlattenFooter();
      return;
    }
    if (tile) {
      const id = tile?.document?.id || tile?.id;
      if (!id) return;
      const item = list.querySelector(`[data-tile-id="${CSS.escape(id)}"]`);
      if (item) {
        const isSelected = controlled === null ? !!tile.controlled : !!controlled;
        item.classList.toggle('is-selected', isSelected);
        item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        if (isSelected) this._queueScrollToTile(id);
      }
      this._updateSelectionActions();
      this._updateFlattenFooter();
      return;
    }

    const selectedIds = new Set((canvas?.tiles?.controlled || []).map((t) => t?.document?.id || t?.id));
    for (const item of list.querySelectorAll('[data-tile-id]')) {
      const id = item.dataset.tileId;
      const isSelected = selectedIds.has(id);
      item.classList.toggle('is-selected', isSelected);
      item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    }
    this._updateSelectionActions();
    this._updateFlattenFooter();
  }
}

try {
  Hooks.once('init', () => {
    registerLayerManagerTab();
  });
} catch (_) {}

try {
  Hooks.once('canvasReady', () => {
    ensureTileSelectionPatch();
    ensureTileSelectAllPatch();
    ensureTileForegroundSelectionPatch();
    ensureTileHoverSuppressionPatch();
    ensureCanvasHighlightSuppressionPatch();
    ensureLayerHiddenHooks();
  });
} catch (_) {}
