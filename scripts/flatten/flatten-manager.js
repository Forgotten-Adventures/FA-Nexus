import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { forgeIntegration } from '../core/forge-integration.js';
import { TileFlattenDialog } from './flatten-dialog.js';
import { TileFlattenOverlay } from './tile-flatten-overlay.js';
import { resolveAutoChunking } from './tile-flatten-chunking.js';
import {
  FLATTEN_WEBP_METADATA_SCHEMA,
  FLATTEN_WEBP_METADATA_VERSION,
  embedFlattenMetadataInWebPBlob,
  readFlattenMetadataFromWebPUrl
} from './flatten-webp-metadata.js';
import { AssetShadowManager } from '../assets/asset-shadow-manager.js';
import {
  encodeTexturePath,
  getTransparentTextureSrc
} from '../textures/texture-runtime-core.js';
import {
  applyMaskedTilingToTile,
  applyStandardTileMaskToTile
} from '../textures/texture-mask-runtime.js';
import { applyPathTile } from '../paths/path-geometry.js';
import {
  applyAssetScatterTile,
  refreshAllAssetScatterViewportLayers,
  restoreAssetScatterCaptureLayer,
  syncAssetScatterCaptureLayer
} from '../assets/asset-scatter-geometry.js';
import {
  appendStoragePath,
  buildGeneratedRoot,
  getConfiguredAssetsDir,
  resolveGeneratedSceneFolder,
  sanitizeStoragePathSegments
} from '../storage/generated-paths.js';
import { ensureGeneratedFlattenRootRegistered } from '../storage/generated-output-roots.js';
import {
  getCurrentSceneLevel,
  getCurrentLevelElevationRange,
  getCurrentViewedLevelIds,
  getSceneLevelElevationRanges,
  isElevationWithinCurrentLevelEditScope,
  normalizeGroundBandDocumentSort
} from '../canvas/elevation-band-utils.js';
import {
  FA_NEXUS_TILE_PLACEMENT_LEVEL_FLAG,
  analyzeTileBandState
} from '../canvas/tile-band-utils.js';
import {
  getActiveCanvasLevelIds,
  getRawLevelIds,
  hasOwnLevelField,
  LEVEL_POLICY_INHERIT_CURRENT,
  LEVEL_POLICY_PRESERVE,
  migrateLegacyTilePositionForV14,
  normalizeTileCreatePayloadForV14
} from '../canvas/tile-document-payloads.js';
import {
  getCanvasReadiness,
  isCanvasReadyFor
} from '../canvas/canvas-readiness.js';
import {
  collectTilePlaceables,
  resolveTileDocumentById,
  resolveTilePlaceableForDocument
} from '../canvas/tile-targets.js';

const MODULE_ID = 'fa-nexus';
const LAYER_HIDDEN_FLAG = 'layerHidden';
const PRESERVE_LINKED_TILE_CLEANUP_OPTION = 'faNexusPreserveLinkedTileCleanup';
const TILE_TRANSFORM_EPSILON = 1e-4;
const RESTORED_RENDERER_PLACEABLE_ATTEMPTS = 15;
const RESTORED_RENDERER_PLACEABLE_DELAY_MS = 60;
const RESTORED_RENDERER_HYDRATION_ATTEMPTS = 2;
const RESTORED_RENDERER_HYDRATION_DELAY_MS = 120;
const LEVEL_BAND_SIZE = 1;
const LEVEL_ELEVATION_EPSILON = 1e-6;
const EXPORT_SCOPE_LEVEL = 'level';
const EXPORT_SCOPE_SCENE = 'scene';
const MIDDLE_PLACEMENT_SEPARATE = 'separate';
const MIDDLE_PLACEMENT_BACKGROUND = 'background';
const MIDDLE_PLACEMENT_FOREGROUND = 'foreground';
const ambiguousLevelBandWarnings = new Set();

function isTileHiddenForFlatten(doc) {
  if (!doc) return false;

  try {
    if (doc.hidden === true || doc?._source?.hidden === true) return true;
  } catch (_) {}

  try {
    if (doc.getFlag?.(MODULE_ID, LAYER_HIDDEN_FLAG)) return true;
  } catch (_) {}

  try {
    return !!(doc?.flags?.[MODULE_ID]?.[LAYER_HIDDEN_FLAG] || doc?._source?.flags?.[MODULE_ID]?.[LAYER_HIDDEN_FLAG]);
  } catch (_) {
    return false;
  }
}

function getCurrentViewedLevelId(scene = canvas?.scene) {
  const levelIds = getCurrentViewedLevelIds(scene);
  const levelId = Array.isArray(levelIds) ? levelIds[0] : null;
  const normalized = String(levelId || '').trim();
  return normalized || null;
}

function getTileElevationValue(doc) {
  const raw = Number(doc?.elevation ?? doc?._source?.elevation ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}

function getDocumentMembershipInLevel(doc, levelId) {
  const normalizedLevelId = normalizeLevelId(levelId);
  if (!normalizedLevelId) return null;

  const hasExplicitLevels = hasOwnLevelField(doc) || hasOwnLevelField(doc?._source) || !!doc?.schema?.has?.('levels');
  if (hasExplicitLevels) {
    const levelIds = getRawLevelIds(doc);
    const included = !levelIds.length || levelIds.includes(normalizedLevelId);
    if (typeof doc?.includedInLevel === 'function') {
      try {
        const helperIncluded = !!doc.includedInLevel(normalizedLevelId);
        if (helperIncluded !== included) {
          Logger.warn('TileFlatten.levelMembershipCheck.mismatch', {
            tileId: doc?.id || null,
            levelId: normalizedLevelId,
            helperIncluded,
            explicitIncluded: included,
            explicitLevels: levelIds
          });
        }
      } catch (error) {
        Logger.warn('TileFlatten.levelMembershipCheck.failed', {
          tileId: doc?.id || null,
          levelId: normalizedLevelId,
          error: String(error?.message || error)
        });
      }
    }
    return included;
  }

  if (typeof doc?.includedInLevel === 'function') {
    try {
      return !!doc.includedInLevel(normalizedLevelId);
    } catch (error) {
      Logger.warn('TileFlatten.levelMembershipCheck.failed', {
        tileId: doc?.id || null,
        levelId: normalizedLevelId,
        error: String(error?.message || error)
      });
    }
  }

  return null;
}

function getTileMembershipInCurrentViewedLevel(doc, { scene = canvas?.scene } = {}) {
  const currentLevelId = getCurrentViewedLevelId(scene);
  if (!currentLevelId) return null;
  return getDocumentMembershipInLevel(doc, currentLevelId);
}

function isElevationWithinLevelExportRangeValue(elevation, range) {
  const numeric = Number(elevation);
  if (!Number.isFinite(numeric) || !range) return false;
  const bottom = Number(range.bottom);
  const top = Number(range.top);
  if (Number.isFinite(bottom) && numeric < (bottom - LEVEL_ELEVATION_EPSILON)) return false;
  if (Number.isFinite(top) && numeric >= (top + LEVEL_BAND_SIZE - LEVEL_ELEVATION_EPSILON)) return false;
  return true;
}

function getTileBandAnalysisForFlatten(doc, { scene = canvas?.scene } = {}) {
  try {
    return analyzeTileBandState(doc, {
      scene,
      visibleLevelIds: getRawLevelIds(doc),
      requireVisibleMembership: false,
      allowSingleLevelInference: true,
      allowCurrentLevelFallback: false
    });
  } catch (error) {
    Logger.warn('TileFlatten.levelBand.analysisFailed', {
      tileId: doc?.id || null,
      error: String(error?.message || error)
    });
    return null;
  }
}

function warnAmbiguousLevelBand(doc, range, analysis) {
  const levelId = normalizeLevelId(range?.levelId);
  const tileId = doc?.id || doc?._id || null;
  const key = `${canvas?.scene?.id || 'scene'}:${tileId || 'unknown'}:${levelId || 'level'}`;
  if (ambiguousLevelBandWarnings.has(key)) return;
  ambiguousLevelBandWarnings.add(key);
  Logger.warn('TileFlatten.levelBand.ambiguousPlacementLevel', {
    tileId,
    tileName: doc?.name || doc?.texture?.src || null,
    levelId,
    levelName: getLevelRangeDisplayName(range, ''),
    elevation: getTileElevationValue(doc),
    candidates: Array.isArray(analysis?.candidates)
      ? analysis.candidates.map((candidate) => ({
        kind: candidate?.kind || null,
        levelId: normalizeLevelId(candidate?.placementLevelId)
      }))
      : []
  });
}

function mapBandAnalysisKindToLayerRole(kind) {
  if (kind === 'ground') return 'background';
  if (kind === 'foreground') return 'foreground';
  return null;
}

function resolveTileLevelLayerRole(doc, range, { scene = canvas?.scene } = {}) {
  if (!doc || !range) return null;
  const levelId = normalizeLevelId(range?.levelId);
  if (levelId) {
    const membership = getDocumentMembershipInLevel(doc, levelId);
    if (membership === false) return null;
  }

  const elevation = getTileElevationValue(doc);
  if (!isElevationWithinLevelExportRangeValue(elevation, range)) return null;

  const analysis = getTileBandAnalysisForFlatten(doc, { scene });
  if (analysis?.inSpecialBand) {
    const placementLevelId = normalizeLevelId(analysis?.placementLevelId);
    if (placementLevelId) {
      if (levelId && placementLevelId !== levelId) return null;
      const role = mapBandAnalysisKindToLayerRole(analysis?.kind);
      if (role) return role;
    } else {
      const candidates = Array.isArray(analysis?.candidates) ? analysis.candidates : [];
      const matching = levelId
        ? candidates.filter((candidate) => normalizeLevelId(candidate?.placementLevelId) === levelId)
        : candidates;
      if (matching.length === 1 && candidates.length === 1) {
        const role = mapBandAnalysisKindToLayerRole(matching[0]?.kind);
        if (role) return role;
      }
      if (matching.length) warnAmbiguousLevelBand(doc, range, analysis);
      return null;
    }
  }

  const bottom = Number(range?.bottom);
  const top = Number(range?.top);
  if (Number.isFinite(top) && elevation >= (top - LEVEL_ELEVATION_EPSILON)) return 'foreground';
  if (Number.isFinite(bottom) && elevation < (bottom + LEVEL_BAND_SIZE - LEVEL_ELEVATION_EPSILON)) return 'background';
  return 'middle';
}

function isTileInCurrentLevelEditScope(doc, { scene = canvas?.scene } = {}) {
  const range = getCurrentLevelElevationRange(scene);
  if (range) {
    if (resolveTileLevelLayerRole(doc, range, { scene })) return true;
    const analysis = getTileBandAnalysisForFlatten(doc, { scene });
    if (analysis?.inSpecialBand) return false;
  }
  const membership = getTileMembershipInCurrentViewedLevel(doc, { scene });
  if (membership === false) return false;
  return isElevationWithinCurrentLevelEditScope(getTileElevationValue(doc), { scene });
}

function describeCurrentLevelEditScope(scene = canvas?.scene) {
  const range = getCurrentLevelElevationRange(scene);
  if (!range) return 'current viewed level';
  if (range.levelName) return `level "${range.levelName}"`;
  const bottom = Number(range.bottom);
  const top = Number(range.top);
  if (Number.isFinite(bottom) && Number.isFinite(top)) {
    return `current viewed level (${bottom} to ${top})`;
  }
  return 'current viewed level';
}

function normalizeExportScope(value) {
  return value === EXPORT_SCOPE_SCENE ? EXPORT_SCOPE_SCENE : EXPORT_SCOPE_LEVEL;
}

function normalizeMiddlePlacement(value) {
  if (value === MIDDLE_PLACEMENT_BACKGROUND) return MIDDLE_PLACEMENT_BACKGROUND;
  if (value === MIDDLE_PLACEMENT_FOREGROUND) return MIDDLE_PLACEMENT_FOREGROUND;
  return MIDDLE_PLACEMENT_SEPARATE;
}

function normalizeLevelId(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getLevelRangeDisplayName(range, fallback = 'Level') {
  const name = String(range?.levelName || '').trim();
  if (name) return name;
  const levelName = String(range?.level?.name || '').trim();
  if (levelName) return levelName;
  const levelId = normalizeLevelId(range?.levelId);
  return levelId || fallback;
}

function describeLevelRange(range) {
  const label = getLevelRangeDisplayName(range, 'level');
  const bottom = Number(range?.bottom);
  const top = Number(range?.top);
  if (Number.isFinite(bottom) && Number.isFinite(top)) return `${label} (${bottom} to ${top})`;
  return label;
}

function getTileTextureAnchor(texture) {
  const anchorX = Number(texture?.anchorX);
  const anchorY = Number(texture?.anchorY);
  return {
    x: Number.isFinite(anchorX) ? anchorX : 0.5,
    y: Number.isFinite(anchorY) ? anchorY : 0.5
  };
}

function getTileRenderedTopLeft(data) {
  const anchor = getTileTextureAnchor(data?.texture);
  const x = Number(data?.x);
  const y = Number(data?.y);
  const width = Number(data?.width);
  const height = Number(data?.height);
  return {
    x: (Number.isFinite(x) ? x : 0) - ((Number.isFinite(width) ? width : 0) * anchor.x),
    y: (Number.isFinite(y) ? y : 0) - ((Number.isFinite(height) ? height : 0) * anchor.y)
  };
}

function getTileTextureScale(texture) {
  const scaleX = Number(texture?.scaleX);
  const scaleY = Number(texture?.scaleY);
  return {
    x: Number.isFinite(scaleX) ? scaleX : 1,
    y: Number.isFinite(scaleY) ? scaleY : 1
  };
}

function getTileTransformSnapshot(data) {
  const anchor = getTileTextureAnchor(data?.texture);
  const scale = getTileTextureScale(data?.texture);
  const renderedTopLeft = getTileRenderedTopLeft(data);
  const x = Number(data?.x);
  const y = Number(data?.y);
  const width = Number(data?.width);
  const height = Number(data?.height);
  const rotation = Number(data?.rotation);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
    rotation: Number.isFinite(rotation) ? rotation : 0,
    anchorX: anchor.x,
    anchorY: anchor.y,
    scaleX: scale.x,
    scaleY: scale.y,
    topLeftX: Number.isFinite(renderedTopLeft?.x) ? renderedTopLeft.x : 0,
    topLeftY: Number.isFinite(renderedTopLeft?.y) ? renderedTopLeft.y : 0
  };
}

function buildFlattenedWrapperTransform(bounds) {
  const x = Number(bounds?.x);
  const y = Number(bounds?.y);
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  if (![x, y, width, height].every(Number.isFinite) || (width <= 0) || (height <= 0)) return null;
  const normalizedWidth = Math.max(1, Math.round(width));
  const normalizedHeight = Math.max(1, Math.round(height));
  const normalizedX = Math.round(x + (width / 2));
  const normalizedY = Math.round(y + (height / 2));
  return {
    x: normalizedX,
    y: normalizedY,
    width: normalizedWidth,
    height: normalizedHeight,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
    scaleX: 1,
    scaleY: 1,
    topLeftX: normalizedX - (normalizedWidth * 0.5),
    topLeftY: normalizedY - (normalizedHeight * 0.5)
  };
}

function tileTransformsMatchValue(left, right) {
  return Math.abs((Number(left) || 0) - (Number(right) || 0)) <= TILE_TRANSFORM_EPSILON;
}

/**
 * Manages flattening multiple tiles into a single image
 */
export class TileFlattenManager {
  constructor() {
    this._flattening = false;
    this._deconstructing = false;
    this._overlay = null;
  }

  _normalizeExportScope(value) {
    return normalizeExportScope(value);
  }

  _normalizeMiddlePlacement(value) {
    return normalizeMiddlePlacement(value);
  }

  _getSceneNameForOutput(scene = canvas?.scene) {
    return String(scene?.name || scene?.id || 'scene').trim() || 'scene';
  }

  _slugOutputPart(value, fallback = 'item') {
    const fallbackText = String(fallback || 'item').trim() || 'item';
    let text = String(value ?? '').trim() || fallbackText;
    text = text.replace(/\.[^./\\]+$/, '');
    text = text.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-');
    text = text.replace(/\s+/g, '-').replace(/-+/g, '-').trim();
    text = text.replace(/^\.+/, '').replace(/[. ]+$/, '');
    return text || fallbackText;
  }

  _getLevelOutputSlug(range) {
    return this._slugOutputPart(getLevelRangeDisplayName(range), 'level');
  }

  _buildDefaultOutputBaseName({ action = 'flatten', scope = EXPORT_SCOPE_LEVEL, levelRange = null } = {}) {
    const scenePart = this._slugOutputPart(this._getSceneNameForOutput(), 'scene');
    const actionPart = action === 'export' ? 'export' : 'flattened';
    const scopePart = scope === EXPORT_SCOPE_SCENE
      ? 'all-levels'
      : this._getLevelOutputSlug(levelRange || getCurrentLevelElevationRange(canvas?.scene));
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
    return this._sanitizeOutputBaseName(`${scenePart}-${scopePart}-${actionPart}-${timestamp}-${rand}`, `${actionPart}-${timestamp}-${rand}`);
  }

  /**
   * Get currently selected tiles
   * @returns {Array<import('foundry/applications/api').TileDocument>}
   */
  static getSelectedTiles() {
    try {
      const layer = canvas?.tiles;
      if (!layer) return [];
      const ids = new Set();
      const controlled = Array.isArray(layer.controlled) ? layer.controlled : [];
      for (const placeable of controlled) {
        const id = placeable?.document?.id || placeable?.id;
        if (id) ids.add(id);
      }

      const listSelection = typeof document?.querySelectorAll === 'function'
        ? document.querySelectorAll('.fa-nexus-layer-manager__item.is-selected[data-tile-id]')
        : [];
      for (const item of listSelection) {
        const id = item?.dataset?.tileId;
        if (id) ids.add(id);
      }

      if (!ids.size) return [];

      const tiles = [];
      const seen = new Set();
      const placeables = collectTilePlaceables({ layer });
      for (const placeable of placeables) {
        const doc = placeable?.document;
        const id = doc?.id || placeable?.id;
        if (!id || !ids.has(id) || seen.has(id)) continue;
        if (doc && doc instanceof foundry.documents.TileDocument) {
          tiles.push(doc);
          seen.add(id);
        }
      }

      for (const id of ids) {
        if (seen.has(id)) continue;
        const doc = resolveTileDocumentById(id);
        if (doc && doc instanceof foundry.documents.TileDocument) {
          tiles.push(doc);
          seen.add(id);
        }
      }

      return tiles;
    } catch (error) {
      Logger.warn('TileFlatten.getSelectedTiles.failed', { error: String(error?.message || error) });
      return [];
    }
  }

  /**
   * Check if multiple tiles are selected
   * @returns {boolean}
   */
  static hasMultipleTilesSelected() {
    return this.getFlattenableTiles().length > 1;
  }

  static getSelectionAnalysis(tiles = null, { scene = canvas?.scene } = {}) {
    const list = Array.isArray(tiles) ? tiles : this.getSelectedTiles();
    const targets = [];
    const skippedHidden = [];
    const outOfScope = [];
    for (const doc of list) {
      if (!doc) continue;
      if (isTileHiddenForFlatten(doc)) {
        skippedHidden.push(doc);
        continue;
      }
      if (!isTileInCurrentLevelEditScope(doc, { scene })) {
        outOfScope.push(doc);
        continue;
      }
      targets.push(doc);
    }
    return {
      selected: list,
      targets,
      skippedHidden,
      outOfScope,
      canFlatten: targets.length >= 1 && outOfScope.length === 0
    };
  }

  static getFlattenableTiles(tiles = null) {
    return this.getSelectionAnalysis(tiles).targets;
  }

  static canFlattenSelection(tiles = null) {
    return this.getSelectionAnalysis(tiles).canFlatten;
  }

  /**
   * Show flatten dialog and process flattening
   */
  async showFlattenDialog() {
    const selectedTiles = TileFlattenManager.getSelectedTiles();
    const selection = TileFlattenManager.getSelectionAnalysis(selectedTiles);
    const flattenableTiles = selection.targets;
    if (!selection.canFlatten) {
      if (selection.outOfScope.length) {
        ui?.notifications?.warn?.(`Flatten only supports tiles in the ${describeCurrentLevelEditScope()}. Clear mixed-level selections and try again.`);
        return;
      }
      const skippedHidden = selection.skippedHidden.length > 0;
      if (!flattenableTiles.length) {
        ui?.notifications?.warn?.(
          skippedHidden
            ? 'Hidden tiles are ignored when flattening. Select at least 1 visible tile.'
            : 'Please select at least 1 tile to flatten.'
        );
        return;
      }
    }

    if (!flattenableTiles.length) {
      const skippedHidden = selection.skippedHidden.length > 0;
      ui?.notifications?.warn?.(
        skippedHidden
          ? 'Hidden tiles are ignored when flattening. Select at least 1 visible tile.'
          : 'Please select at least 1 tile to flatten.'
      );
      return;
    }

    if (this.isBusy()) {
      ui?.notifications?.warn?.('Another flattening or deconstruction operation is already in progress.');
      return;
    }

    const dialog = new TileFlattenDialog({
      tiles: flattenableTiles,
      currentLevelRange: getCurrentLevelElevationRange(canvas?.scene),
      levelRanges: getSceneLevelElevationRanges(canvas?.scene),
      previewBoundsResolver: this._capturePreviewBounds.bind(this)
    });
    const result = await dialog.render(true);
    
    if (!result || result.cancelled) return;

    await this.flattenTiles(flattenableTiles, result);
  }

  async showExportDialog() {
    if (!isCanvasReadyFor({ requireScene: true })) {
      ui?.notifications?.warn?.('Scene is not ready for export yet.');
      return;
    }

    if (this.isBusy()) {
      ui?.notifications?.warn?.('Another flattening or deconstruction operation is already in progress.');
      return;
    }

    const sceneBounds = this._getSceneBounds();
    if (!sceneBounds) {
      ui?.notifications?.error?.('Could not resolve scene bounds for export.');
      return;
    }
    const gridSize = Math.max(1, Number(canvas?.scene?.grid?.size || 100));
    const currentRange = getCurrentLevelElevationRange(canvas?.scene);
    const levelRanges = getSceneLevelElevationRanges(canvas?.scene);
    const tiles = currentRange
      ? this._collectSceneTiles({ levelRange: currentRange })
      : this._collectSceneTiles();

    const dialog = new TileFlattenDialog({
      tiles,
      mode: 'export',
      baseBounds: { ...sceneBounds, gridSize },
      currentLevelRange: currentRange,
      levelRanges
    });
    const result = await dialog.render(true);

    if (!result || result.cancelled) return;

    await this.exportScene(result);
  }

  async exportScene(options = {}) {
    if (this.isBusy()) {
      Logger.warn('TileFlatten.exportScene.busy');
      return;
    }

    if (!isCanvasReadyFor({ requireScene: true })) {
      ui?.notifications?.error?.('Scene not available.');
      return;
    }

    this._flattening = true;
    let overlay = null;
    let resolvedAction = 'export';
    let shouldExport = true;
    let shouldFlatten = false;
    const scene = canvas?.scene;
    const originalLevelId = normalizeLevelId(canvas?.level?.id || scene?._view);
    let switchedLevelDuringRun = false;
    try {
      const {
        ppi = 200,
        quality = 0.85,
        paddingSnap = 'none',
        paddingExtra = 0,
        exportSplitLayers = false,
        exportChunked = false,
        exportScope = EXPORT_SCOPE_LEVEL,
        exportMiddlePlacement = MIDDLE_PLACEMENT_SEPARATE,
        exportAction,
        outputName = '',
        outputFolder = '',
        overwriteConfirmed = false
      } = options || {};
      resolvedAction = exportAction === 'export' || exportAction === 'flatten'
        ? exportAction
        : (options?.exportFlattenScene ? 'flatten' : 'export');
      shouldExport = resolvedAction === 'export';
      shouldFlatten = resolvedAction === 'flatten';
      const scope = this._normalizeExportScope(exportScope);
      const middlePlacement = this._normalizeMiddlePlacement(exportMiddlePlacement);
      const normalizedPaddingSnap = this._normalizePaddingSnap(paddingSnap);
      const sceneBounds = this._getSceneBounds();
      if (!sceneBounds) {
        throw new Error('Could not resolve scene bounds for export');
      }

      const gridSize = Math.max(1, Number(canvas?.scene?.grid?.size || 100));
      const resolution = this._computeResolution(ppi, gridSize);
      const plannedRenderBounds = this._computeRenderBounds(sceneBounds, gridSize, normalizedPaddingSnap, paddingExtra);
      const plannedPixelWidth = Math.max(1, Math.round(plannedRenderBounds.width * resolution));
      const plannedPixelHeight = Math.max(1, Math.round(plannedRenderBounds.height * resolution));
      const maxTextureSize = this._getMaxTextureSize(canvas?.app?.renderer);
      const autoChunkPlan = resolveAutoChunking(plannedPixelWidth, plannedPixelHeight, { maxTextureSize });
      const exceedsMaxTexture = plannedPixelWidth > maxTextureSize || plannedPixelHeight > maxTextureSize;
      const useAutoChunking = !!exportChunked && autoChunkPlan.enabled;
      const useChunking = exceedsMaxTexture || useAutoChunking;
      const chunkAuto = useChunking;
      const autoChunkWidth = useChunking ? (autoChunkPlan.chunkPixelWidth / ppi) : 0;
      const autoChunkHeight = useChunking ? (autoChunkPlan.chunkPixelHeight / ppi) : 0;

      overlay = this._showOverlay(shouldExport ? 'export' : 'flatten');
      overlay.setStatus(shouldExport ? 'Preparing level export...' : 'Preparing level flatten...');
      overlay.setProgress?.(0.1);
      await this._nextFrame();

      const levelPlans = this._buildSceneExportLevelPlans({
        scope,
        splitLayers: !!exportSplitLayers,
        middlePlacement
      });
      if (!levelPlans.length) throw new Error('No Levels elevation ranges were available for flatten/export.');

      const hasFlattenTargets = levelPlans.some((plan) => Array.isArray(plan?.flattenTasks)
        && plan.flattenTasks.some((task) => Array.isArray(task?.tiles) && task.tiles.length));
      if (shouldFlatten && !hasFlattenTargets) {
        const targetLabel = scope === EXPORT_SCOPE_SCENE ? 'scene levels' : describeLevelRange(levelPlans[0]?.range);
        ui?.notifications?.warn?.(`No tiles found in ${targetLabel} to flatten.`);
        return;
      }
      const hasExportTargets = levelPlans.some((plan) => Array.isArray(plan?.exportTasks)
        && plan.exportTasks.some((task) => this._shouldRunTask(task, 'export')));
      if (shouldExport && !hasExportTargets) {
        const targetLabel = scope === EXPORT_SCOPE_SCENE ? 'scene levels' : describeLevelRange(levelPlans[0]?.range);
        ui?.notifications?.warn?.(`No tiles or level images found in ${targetLabel} to export.`);
        return;
      }
      if (exceedsMaxTexture && !exportChunked) {
        ui?.notifications?.info?.('Scene exceeds GPU texture size; generating multiple images.');
      }
      const primaryRange = levelPlans[0]?.range || getCurrentLevelElevationRange(canvas?.scene);
      const exportBaseName = this._sanitizeOutputBaseName(
        outputName,
        this._buildExportFilenameBase({ scope, levelRange: primaryRange })
      );
      const flattenBaseName = this._sanitizeOutputBaseName(
        outputName,
        this._buildFlattenFilenameBase({ scope, levelRange: primaryRange })
      );
      const savedFiles = [];
      if (shouldExport) {
        const exportContext = await this._resolveExportUploadContext(outputFolder);
        const plannedExportFilenames = this._buildPlannedTaskFilenames(levelPlans, {
          action: 'export',
          baseName: exportBaseName,
          scope,
          useChunking,
          plannedPixelWidth,
          plannedPixelHeight,
          autoChunkPlan
        });
        if (!overwriteConfirmed) {
          const approved = await this._confirmOverwriteOutputs(exportContext, plannedExportFilenames, {
            title: 'Overwrite Existing Export Files?',
            actionLabel: 'Overwrite'
          });
          if (!approved) {
            ui?.notifications?.info?.('Scene export canceled.');
            return;
          }
        }

        const exportTasks = this._getRunnablePlanTasks(levelPlans, 'export');
        const taskCount = exportTasks.length;
        const taskSpan = taskCount > 0 ? 0.8 / taskCount : 0.8;
        let taskIndex = 0;
        for (const plan of levelPlans) {
          if (scope === EXPORT_SCOPE_SCENE) {
            const didSwitch = await this._viewLevelForExport(plan.range, { overlay });
            switchedLevelDuringRun = switchedLevelDuringRun || didSwitch;
          }
          for (const task of plan.exportTasks) {
            if (!this._shouldRunTask(task, 'export')) continue;
            const layerLabel = task.label || 'Scene';
            const taskSuffix = this._buildTaskOutputSuffix(task, { scope });
            const layerProgressBase = 0.1 + (taskSpan * taskIndex);
            taskIndex += 1;

            overlay.setStatus(`Capturing ${layerLabel.toLowerCase()}...`);
            overlay.setProgress?.(layerProgressBase);
            await this._nextFrame();

            if (useChunking) {
              const savedChunks = [];
              const chunkData = await this._renderTilesToCanvasChunked(task.tiles, sceneBounds, ppi, {
                paddingSnap: normalizedPaddingSnap,
                paddingExtra,
                chunkWidth: autoChunkWidth,
                chunkHeight: autoChunkHeight,
                chunkPad: false,
                chunkAuto,
                suspendRender: true,
                visibility: task.visibility,
                onChunk: async (entry, index, total) => {
                  const label = Number.isFinite(total) && total > 0
                    ? `Saving ${layerLabel.toLowerCase()} chunk ${index + 1} of ${total}...`
                    : `Saving ${layerLabel.toLowerCase()} chunk...`;
                  overlay.setStatus(label);
                  if (Number.isFinite(total) && total > 0) {
                    const progress = layerProgressBase + (taskSpan * ((index + 1) / total));
                    overlay.setProgress?.(Math.min(0.9, progress));
                  }
                  const rowLabel = Number.isFinite(entry?.row) ? entry.row + 1 : null;
                  const colLabel = Number.isFinite(entry?.col) ? entry.col + 1 : null;
                  const chunkSuffix = (rowLabel && colLabel)
                    ? `-r${rowLabel}-c${colLabel}`
                    : `-chunk-${index + 1}`;
                  const filename = this._buildOutputFilename(exportBaseName, `${taskSuffix}${chunkSuffix}`);
                  let src = null;
                  try {
                    src = await this._saveAsWebP(entry?.canvas, quality, { uploadContext: exportContext, filename });
                  } finally {
                    try {
                      if (entry?.canvas) {
                        entry.canvas.width = 0;
                        entry.canvas.height = 0;
                      }
                    } catch (_) {}
                  }
                  if (src) savedChunks.push(src);
                }
              });

              if (!chunkData) {
                throw new Error(`Failed to export ${layerLabel.toLowerCase()} chunks`);
              }
              if (!savedChunks.length) {
                throw new Error(`Failed to save ${layerLabel.toLowerCase()} chunks`);
              }
              const expectedChunks = Number.isFinite(chunkData?.rows) && Number.isFinite(chunkData?.columns)
                ? (chunkData.rows * chunkData.columns)
                : null;
              if (Number.isFinite(expectedChunks) && expectedChunks > 0 && savedChunks.length !== expectedChunks) {
                throw new Error(`Failed to save all ${layerLabel.toLowerCase()} chunks`);
              }
              savedFiles.push(...savedChunks);
            } else {
              overlay.setStatus(`Capturing ${layerLabel.toLowerCase()}...`);
              const canvasData = await this._renderTilesToCanvas(task.tiles, sceneBounds, ppi, {
                paddingSnap: normalizedPaddingSnap,
                paddingExtra,
                trimToContent: false,
                suspendRender: true,
                visibility: task.visibility
              });
              if (!canvasData?.canvas) {
                throw new Error(`Failed to export ${layerLabel.toLowerCase()}`);
              }

              overlay.setStatus(`Saving ${layerLabel.toLowerCase()}...`);
              const filename = this._buildOutputFilename(exportBaseName, taskSuffix);
              const filePath = await this._saveAsWebP(canvasData.canvas, quality, { uploadContext: exportContext, filename });
              if (!filePath) {
                throw new Error(`Failed to save ${layerLabel.toLowerCase()} export`);
              }
              try {
                canvasData.canvas.width = 0;
                canvasData.canvas.height = 0;
              } catch (_) {}
              savedFiles.push(filePath);
              overlay.setProgress?.(Math.min(0.9, layerProgressBase + taskSpan));
            }
          }
        }
      }

      let flattenedCount = 0;
      if (shouldFlatten) {
        try {
          const flattenContext = await this._resolveFlattenUploadContext(outputFolder);
          const logicalBounds = { ...sceneBounds };
          const pendingFlattenCreates = [];
          const originalTilesById = new Map();
          const plannedFlattenFilenames = this._buildPlannedTaskFilenames(levelPlans, {
            action: 'flatten',
            baseName: flattenBaseName,
            scope,
            useChunking,
            plannedPixelWidth,
            plannedPixelHeight,
            autoChunkPlan
          });
          if (!overwriteConfirmed) {
            const approved = await this._confirmOverwriteOutputs(flattenContext, plannedFlattenFilenames, {
              title: 'Overwrite Existing Flatten Files?',
              actionLabel: 'Overwrite'
            });
            if (!approved) {
              ui?.notifications?.info?.('Scene flatten canceled.');
              return;
            }
          }

          const runnableFlattenTasks = this._getRunnablePlanTasks(levelPlans, 'flatten');
          const taskCount = runnableFlattenTasks.length;
          const flattenSpan = taskCount > 0 ? 0.8 / taskCount : 0.8;
          let taskIndex = 0;
          for (const plan of levelPlans) {
            if (scope === EXPORT_SCOPE_SCENE) {
              const didSwitch = await this._viewLevelForExport(plan.range, { overlay });
              switchedLevelDuringRun = switchedLevelDuringRun || didSwitch;
            }
            for (const task of plan.flattenTasks) {
              if (!this._shouldRunTask(task, 'flatten')) {
                Logger.debug?.('TileFlatten.exportScene.skipEmptyFlattenBand', {
                  levelId: normalizeLevelId(task?.levelRange?.levelId),
                  levelName: getLevelRangeDisplayName(task?.levelRange, ''),
                  role: task?.role || null
                });
                continue;
              }
              const layerLabel = task.label || 'Scene';
              const taskSuffix = this._buildTaskOutputSuffix(task, { scope });
              const flattenProgressBase = 0.1 + (flattenSpan * taskIndex);
              taskIndex += 1;

              overlay.setStatus(`Flattening ${layerLabel.toLowerCase()} tiles...`);
              overlay.setProgress?.(flattenProgressBase);
              await this._nextFrame();

              let renderBounds = null;
              let paddingInsets = null;
              let pixelWidth = null;
              let pixelHeight = null;
              let resolutionOut = null;
              let filePath = null;
              let chunkEntries = null;
              let chunkingMeta = null;
              let chunkSize = 0;
              let capturedChunks = null;
              let singleOutput = null;

              if (useChunking) {
                capturedChunks = [];
                const chunkData = await this._renderTilesToCanvasChunked(task.tiles, sceneBounds, ppi, {
                  paddingSnap: normalizedPaddingSnap,
                  paddingExtra,
                  chunkWidth: autoChunkWidth,
                  chunkHeight: autoChunkHeight,
                  chunkPad: false,
                  chunkAuto,
                  suspendRender: true,
                  visibility: {
                    keepBackground: false,
                    keepTiles: true,
                    keepForeground: false,
                    keepDoors: false
                  },
                  onChunk: async (entry, index, total) => {
                    const label = Number.isFinite(total) && total > 0
                      ? `Encoding ${layerLabel.toLowerCase()} tile chunk ${index + 1} of ${total}...`
                      : `Encoding ${layerLabel.toLowerCase()} tile chunk...`;
                    overlay.setStatus(label);
                    if (Number.isFinite(total) && total > 0) {
                      const progress = flattenProgressBase + (flattenSpan * ((index + 1) / total));
                      overlay.setProgress?.(Math.min(0.98, progress));
                    }
                    const rowLabel = Number.isFinite(entry?.row) ? entry.row + 1 : null;
                    const colLabel = Number.isFinite(entry?.col) ? entry.col + 1 : null;
                    const chunkSuffix = rowLabel && colLabel ? `-r${rowLabel}-c${colLabel}` : `-chunk-${index + 1}`;
                    const filename = this._buildOutputFilename(flattenBaseName, `${taskSuffix}${chunkSuffix}`);
                    let captured = null;
                    try {
                      captured = await this._captureFlattenChunkWebP(entry, quality, { uploadContext: flattenContext, filename });
                    } finally {
                      try {
                        if (entry?.canvas) {
                          entry.canvas.width = 0;
                          entry.canvas.height = 0;
                        }
                      } catch (_) {}
                    }
                    if (captured) capturedChunks.push(captured);
                  }
                });

                if (!chunkData) {
                  throw new Error(`Failed to flatten ${layerLabel.toLowerCase()} tiles`);
                }
                if (!capturedChunks.length) {
                  throw new Error(`Failed to encode ${layerLabel.toLowerCase()} tile chunks`);
                }
                renderBounds = chunkData?.renderBounds || sceneBounds;
                paddingInsets = chunkData?.paddingInsets || null;
                pixelWidth = chunkData?.pixelWidth || null;
                pixelHeight = chunkData?.pixelHeight || null;
                resolutionOut = chunkData?.resolution || null;
                chunkEntries = capturedChunks.map((record) => this._chunkBlobRecordToMetadataEntry(record));
                chunkingMeta = chunkData?.chunking || null;
                chunkSize = chunkData?.chunkSize ?? 0;
                filePath = capturedChunks[0]?.src || null;
              } else {
                const canvasData = await this._renderTilesToCanvas(task.tiles, sceneBounds, ppi, {
                  paddingSnap: normalizedPaddingSnap,
                  paddingExtra,
                  trimToContent: false,
                  suspendRender: true,
                  visibility: {
                    keepBackground: false,
                    keepTiles: true,
                    keepForeground: false,
                    keepDoors: false
                  }
                });
                if (!canvasData?.canvas) {
                  throw new Error(`Failed to flatten ${layerLabel.toLowerCase()} tiles`);
                }
                renderBounds = canvasData.renderBounds;
                paddingInsets = canvasData.paddingInsets;
                pixelWidth = canvasData.pixelWidth;
                pixelHeight = canvasData.pixelHeight;
                resolutionOut = canvasData.resolution;

                const filename = this._normalizeWebPFilename({ filename: this._buildOutputFilename(flattenBaseName, taskSuffix) });
                const blob = await this._canvasToWebPBlob(canvasData.canvas, quality);
                if (!blob) throw new Error(`Failed to encode ${layerLabel.toLowerCase()} tile WebP ${filename}.`);
                filePath = this._predictWebPUploadPath(flattenContext, filename);
                singleOutput = { filename, src: filePath, blob };
                try {
                  canvasData.canvas.width = 0;
                  canvasData.canvas.height = 0;
                } catch (_) {}
              }

              const flattenedElevation = this._resolveLayerFlattenedElevation(task.role, task.tiles, task.levelRange);
              const metadata = this._buildMetadata({
                tiles: task.tiles,
                logicalBounds,
                renderBounds,
                paddingInsets,
                pixelWidth,
                pixelHeight,
                ppi,
                quality,
                paddingSnap: normalizedPaddingSnap,
                paddingExtra,
                resolution: resolutionOut,
                filePath,
                chunks: chunkEntries,
                chunking: chunkingMeta,
                chunkSize,
                levelIds: task.levelIds,
                levelRange: task.levelRange,
                layerRole: task.role,
                sceneFlattenScope: scope,
                flattenedElevation
              });
              if (useChunking) {
                for (let i = 0; i < capturedChunks.length; i += 1) {
                  overlay.setStatus(`Saving ${layerLabel.toLowerCase()} tile chunk ${i + 1} of ${capturedChunks.length}...`);
                  await this._saveCapturedFlattenWebP(capturedChunks[i], flattenContext, metadata);
                }
                filePath = capturedChunks[0]?.src || filePath;
              } else {
                overlay.setStatus(`Saving ${layerLabel.toLowerCase()} tile image...`);
                filePath = await this._saveCapturedFlattenWebP(singleOutput, flattenContext, metadata);
              }
              metadata.filePath = filePath || metadata.filePath;
              if (metadata.embeddedMetadata) metadata.embeddedMetadata.primaryFilePath = metadata.filePath || null;
              pendingFlattenCreates.push({
                bounds: renderBounds,
                filePath,
                metadata
              });
              for (const doc of task.tiles) {
                if (doc?.id && !originalTilesById.has(doc.id)) originalTilesById.set(doc.id, doc);
              }
            }
          }

          if (pendingFlattenCreates.length) {
            overlay.setStatus('Creating flattened tiles...');
            overlay.setProgress?.(0.98);
            await this._nextFrame();

            for (const entry of pendingFlattenCreates) {
              const created = await this._createFlattenedTile(entry.bounds, entry.filePath, entry.metadata);
              if (Array.isArray(created)) flattenedCount += created.length;
            }
          }

          if (flattenedCount > 0) {
            overlay.setStatus('Removing original tiles...');
            overlay.setProgress?.(0.99);
            await this._nextFrame();
            await this._deleteOriginalTiles(Array.from(originalTilesById.values()));
          }
        } catch (error) {
          Logger.error('TileFlatten.exportScene.flattenFailed', { error: String(error?.message || error) });
          throw error;
        }
      }

      overlay.setStatus(shouldExport ? 'Export complete.' : 'Flatten complete.');
      overlay.setProgress?.(1);
      const doneMessage = shouldExport
        ? (scope === EXPORT_SCOPE_SCENE ? 'Scene export complete.' : 'Level export complete.')
        : (flattenedCount > 0
          ? `${scope === EXPORT_SCOPE_SCENE ? 'Scene' : 'Level'} flatten complete. Flattened ${flattenedCount} tile${flattenedCount === 1 ? '' : 's'}.`
          : `${scope === EXPORT_SCOPE_SCENE ? 'Scene' : 'Level'} flatten complete.`);
      ui?.notifications?.info?.(doneMessage);
      Logger.info('TileFlatten.exportScene.success', {
        action: resolvedAction,
        scope,
        files: savedFiles,
        split: !!exportSplitLayers,
        middlePlacement,
        chunked: !!useChunking,
        flattenedCount
      });
    } catch (error) {
      Logger.error('TileFlatten.exportScene.failed', { error: String(error?.message || error) });
      const actionLabel = shouldExport ? 'export' : 'flatten';
      ui?.notifications?.error?.(`Failed to ${actionLabel} level: ${error?.message || error}`);
    } finally {
      if (switchedLevelDuringRun && originalLevelId && normalizeLevelId(canvas?.scene?._view || canvas?.level?.id) !== originalLevelId) {
        try {
          await this._viewLevelForExport({ levelId: originalLevelId, levelName: 'original level' });
        } catch (error) {
          Logger.error('TileFlatten.exportScene.restoreLevelFailed', {
            originalLevelId,
            error: String(error?.message || error)
          });
          ui?.notifications?.error?.(`Flatten/export completed but FA Nexus could not restore the original viewed level: ${error?.message || error}`);
        }
      }
      this._hideOverlay();
      this._flattening = false;
    }
  }

  _getExportLevelRanges(scope = EXPORT_SCOPE_LEVEL) {
    const scene = canvas?.scene;
    const ranges = getSceneLevelElevationRanges(scene);
    if (scope === EXPORT_SCOPE_SCENE) return ranges;

    const currentRange = getCurrentLevelElevationRange(scene);
    if (currentRange) return [currentRange];

    const currentLevel = getCurrentSceneLevel(scene);
    const currentLevelId = normalizeLevelId(currentLevel?.id);
    const byCurrentLevel = currentLevelId
      ? ranges.find((range) => normalizeLevelId(range?.levelId) === currentLevelId)
      : null;
    if (byCurrentLevel) return [byCurrentLevel];
    if (ranges.length === 1) return [ranges[0]];
    return [];
  }

  _buildSceneExportLevelPlans({ scope = EXPORT_SCOPE_LEVEL, splitLayers = false, middlePlacement = MIDDLE_PLACEMENT_SEPARATE } = {}) {
    const ranges = this._getExportLevelRanges(scope);
    return ranges.map((range) => {
      const tiles = this._collectSceneTiles({ levelRange: range });
      return {
        range,
        levelId: normalizeLevelId(range?.levelId),
        levelName: getLevelRangeDisplayName(range),
        levelSlug: this._getLevelOutputSlug(range),
        tiles,
        exportTasks: this._buildLevelLayerTasks(range, tiles, {
          splitLayers,
          middlePlacement,
          action: 'export'
        }),
        flattenTasks: this._buildLevelLayerTasks(range, tiles, {
          splitLayers,
          middlePlacement,
          action: 'flatten'
        })
      };
    });
  }

  _isElevationWithinLevelExportRange(elevation, range) {
    return isElevationWithinLevelExportRangeValue(elevation, range);
  }

  _classifyLevelLayer(doc, range) {
    return resolveTileLevelLayerRole(doc, range);
  }

  _buildDoorVisibility(minElevation = null, maxElevation = null, { levelIds = [] } = {}) {
    const visibility = {};
    const min = Number(minElevation);
    const max = Number(maxElevation);
    if (Number.isFinite(min)) visibility.minElevation = min;
    if (Number.isFinite(max)) visibility.maxElevation = max;
    const normalizedLevelIds = Array.isArray(levelIds)
      ? levelIds.map((levelId) => normalizeLevelId(levelId)).filter(Boolean)
      : [];
    if (normalizedLevelIds.length) visibility.levelIds = Array.from(new Set(normalizedLevelIds));
    return Object.keys(visibility).length ? visibility : null;
  }

  _buildLevelLayerTasks(range, tiles = [], { splitLayers = false, middlePlacement = MIDDLE_PLACEMENT_SEPARATE, action = 'export' } = {}) {
    const levelName = getLevelRangeDisplayName(range);
    const levelSlug = this._getLevelOutputSlug(range);
    const levelIds = normalizeLevelId(range?.levelId) ? [normalizeLevelId(range.levelId)] : [];
    const bottom = Number(range?.bottom);
    const top = Number(range?.top);
    const backgroundEnd = Number.isFinite(bottom) ? bottom + LEVEL_BAND_SIZE : null;
    const foregroundEnd = Number.isFinite(top) ? top + LEVEL_BAND_SIZE : null;
    const hasBackgroundTexture = this._levelTextureHasSource(range, 'background');
    const hasForegroundTexture = this._levelTextureHasSource(range, 'foreground');
    const exportVisibility = (keepBackground, keepForeground, doorVisibility = null) => ({
      keepBackground,
      keepTiles: true,
      keepForeground,
      keepDoors: true,
      doorVisibility
    });
    const flattenVisibility = {
      keepBackground: false,
      keepTiles: true,
      keepForeground: false,
      keepDoors: false
    };
    const makeTask = ({
      role,
      suffix = '',
      label,
      taskTiles,
      keepBackground = false,
      keepForeground = false,
      keepWhenEmpty = false,
      doorVisibility = null,
      flattenedElevation = null
    }) => {
      const normalizedTiles = Array.isArray(taskTiles) ? taskTiles : [];
      return {
        role,
        suffix,
        label,
        tiles: normalizedTiles,
        keepWhenEmpty,
        visibility: action === 'export'
          ? exportVisibility(keepBackground, keepForeground, doorVisibility)
          : flattenVisibility,
        levelRange: range,
        levelIds,
        levelSlug,
        flattenedElevation: toFiniteNumberOrNull(flattenedElevation)
          ?? this._resolveLayerFlattenedElevation(role, normalizedTiles, range)
      };
    };

    if (!splitLayers) {
      return [
        makeTask({
          role: 'level',
          label: `${levelName} Level`,
          taskTiles: tiles,
          keepBackground: hasBackgroundTexture,
          keepForeground: hasForegroundTexture,
          keepWhenEmpty: action === 'export' && (hasBackgroundTexture || hasForegroundTexture),
          doorVisibility: this._buildDoorVisibility(bottom, foregroundEnd, { levelIds })
        })
      ];
    }

    const buckets = { background: [], middle: [], foreground: [] };
    for (const doc of Array.isArray(tiles) ? tiles : []) {
      const role = this._classifyLevelLayer(doc, range);
      if (role && buckets[role]) buckets[role].push(doc);
    }

    let backgroundTiles = buckets.background;
    let middleTiles = buckets.middle;
    let foregroundTiles = buckets.foreground;
    if (middlePlacement === MIDDLE_PLACEMENT_BACKGROUND) {
      backgroundTiles = [...buckets.background, ...buckets.middle];
      middleTiles = [];
    } else if (middlePlacement === MIDDLE_PLACEMENT_FOREGROUND) {
      foregroundTiles = [...buckets.middle, ...buckets.foreground];
      middleTiles = [];
    }

    const tasks = [
      makeTask({
        role: 'background',
        suffix: 'background',
        label: `${levelName} Background`,
        taskTiles: backgroundTiles,
        keepBackground: hasBackgroundTexture,
        keepWhenEmpty: action === 'export' && hasBackgroundTexture,
        doorVisibility: this._buildDoorVisibility(
          bottom,
          middlePlacement === MIDDLE_PLACEMENT_BACKGROUND ? top : backgroundEnd,
          { levelIds }
        ),
        flattenedElevation: Number.isFinite(bottom) ? bottom : null
      })
    ];

    if (middlePlacement === MIDDLE_PLACEMENT_SEPARATE) {
      tasks.push(makeTask({
        role: 'middle',
        suffix: 'middle',
        label: `${levelName} Middle`,
        taskTiles: middleTiles,
        keepWhenEmpty: false,
        doorVisibility: this._buildDoorVisibility(backgroundEnd, top, { levelIds })
      }));
    }

    if (Number.isFinite(top)) {
      tasks.push(makeTask({
        role: 'foreground',
        suffix: 'foreground',
        label: `${levelName} Foreground`,
        taskTiles: foregroundTiles,
        keepForeground: hasForegroundTexture,
        keepWhenEmpty: action === 'export' && hasForegroundTexture,
        doorVisibility: this._buildDoorVisibility(
          middlePlacement === MIDDLE_PLACEMENT_FOREGROUND ? backgroundEnd : top,
          foregroundEnd,
          { levelIds }
        ),
        flattenedElevation: top
      }));
    }

    return tasks;
  }

  _levelTextureHasSource(range, kind = 'background') {
    const key = String(kind || '').trim().toLowerCase() === 'foreground' ? 'foreground' : 'background';
    const src = String(range?.level?.[key]?.src || '').trim();
    return !!src;
  }

  _resolveLayerFlattenedElevation(role, tiles = [], range = null) {
    if (role === 'background') {
      const bottom = Number(range?.bottom);
      if (Number.isFinite(bottom)) return bottom;
    }
    if (role === 'foreground') {
      const top = Number(range?.top);
      if (Number.isFinite(top)) return top;
    }
    const elevations = Array.isArray(tiles)
      ? tiles.map((doc) => this._getTileElevation(doc)).filter((value) => Number.isFinite(value))
      : [];
    if (elevations.length) return Math.min(...elevations);
    return null;
  }

  _shouldRunTask(task, action = 'export') {
    const tileCount = Array.isArray(task?.tiles) ? task.tiles.length : 0;
    if (tileCount > 0) return true;
    return action === 'export' && !!task?.keepWhenEmpty;
  }

  _getRunnablePlanTasks(levelPlans = [], action = 'export') {
    const key = action === 'flatten' ? 'flattenTasks' : 'exportTasks';
    return (Array.isArray(levelPlans) ? levelPlans : [])
      .flatMap((plan) => Array.isArray(plan?.[key]) ? plan[key] : [])
      .filter((task) => this._shouldRunTask(task, action));
  }

  _buildTaskOutputSuffix(task, { scope = EXPORT_SCOPE_LEVEL } = {}) {
    const parts = [];
    if (scope === EXPORT_SCOPE_SCENE && task?.levelSlug) parts.push(task.levelSlug);
    const rawSuffix = String(task?.suffix || '').trim();
    if (rawSuffix) parts.push(this._slugOutputPart(rawSuffix, 'layer'));
    return parts.length ? `-${parts.join('-')}` : '';
  }

  _buildPlannedTaskFilenames(levelPlans = [], {
    action = 'export',
    baseName = '',
    scope = EXPORT_SCOPE_LEVEL,
    useChunking = false,
    plannedPixelWidth = 0,
    plannedPixelHeight = 0,
    autoChunkPlan = null
  } = {}) {
    const tasks = this._getRunnablePlanTasks(levelPlans, action);
    const filenames = [];
    for (const task of tasks) {
      const suffix = this._buildTaskOutputSuffix(task, { scope });
      if (useChunking) {
        filenames.push(...this._buildChunkOutputFilenames(baseName, plannedPixelWidth, plannedPixelHeight, {
          suffix,
          chunkPixelWidth: autoChunkPlan?.chunkPixelWidth,
          chunkPixelHeight: autoChunkPlan?.chunkPixelHeight
        }));
      } else {
        filenames.push(this._buildOutputFilename(baseName, suffix));
      }
    }
    return filenames.length ? filenames : [this._buildOutputFilename(baseName)];
  }

  async _viewLevelForExport(range, { overlay = null } = {}) {
    const levelId = normalizeLevelId(range?.levelId);
    if (!levelId) return false;
    const scene = canvas?.scene;
    const currentLevelId = normalizeLevelId(canvas?.level?.id || scene?._view);
    if (currentLevelId === levelId) return false;
    if (!scene || typeof scene.view !== 'function') {
      throw new Error('Foundry Scene.view is unavailable; cannot switch levels for scene flatten/export.');
    }
    const label = getLevelRangeDisplayName(range, levelId);
    overlay?.setStatus?.(`Switching to ${label}...`);
    await scene.view({ level: levelId });
    await this._waitForViewedLevel(levelId);
    await this._nextFrame();
    return true;
  }

  async _waitForViewedLevel(levelId, timeoutMs = 15000) {
    const expected = normalizeLevelId(levelId);
    if (!expected) return;
    const deadline = Date.now() + timeoutMs;
    while (normalizeLevelId(canvas?.scene?._view || canvas?.level?.id) !== expected || canvas?.ready !== true) {
      if (Date.now() > deadline) {
        Logger.error('TileFlatten.exportScene.levelSwitchTimeout', {
          expectedLevelId: expected,
          actualViewId: canvas?.scene?._view || null,
          canvasLevelId: canvas?.level?.id || null,
          canvasReady: canvas?.ready === true
        });
        throw new Error(`Timed out waiting for Foundry to switch to level ${expected}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Flatten multiple tiles into a single image
   * @param {Array<import('foundry/applications/api').TileDocument>} tiles
   * @param {object} options
   * @param {number} options.ppi - Pixels per inch
   * @param {number} options.quality - WebP quality (0-1)
   * @param {string} options.paddingSnap - 'none' | 'half' | 'full'
   * @param {number} options.paddingExtra - Padding adjustment in grid squares (can be negative)
   * @param {number} options.chunkWidth - Chunk width in grid squares (0 disables chunking)
   * @param {number} options.chunkHeight - Chunk height in grid squares (0 disables chunking)
   * @param {boolean} options.chunkPad - Pad output bounds to full chunks
   * @param {number} options.chunkSize - Legacy chunk size in pixels (0 disables chunking)
   * @param {object} options.previewBounds - Trimmed bounds from the dialog preview (optional)
   * @param {number} options.previewPpi - PPI used to capture preview bounds
   * @param {string} options.outputName - Requested output file base name
   * @param {string} options.outputFolder - Requested output upload folder
   */
  async flattenTiles(tiles, options = {}) {
    if (this.isBusy()) {
      Logger.warn('TileFlatten.flattenTiles.busy');
      return;
    }

    this._flattening = true;
    const {
      ppi = 200,
      quality = 0.85,
      paddingSnap = 'none',
      paddingExtra = 0,
      chunkWidth = 0,
      chunkHeight = 0,
      chunkPad = false,
      chunkSize = 0,
      outputName = '',
      outputFolder = '',
      overwriteConfirmed = false
    } = options || {};
    const normalizedPaddingSnap = this._normalizePaddingSnap(paddingSnap);
    const normalizedChunkSquares = this._normalizeChunkSquares(chunkWidth, chunkHeight);
    const normalizedChunkPad = normalizedChunkSquares.enabled ? !!chunkPad : false;
    const normalizedChunkSize = normalizedChunkSquares.enabled ? 0 : this._normalizeChunkSize(chunkSize);
    let overlay = null;

    try {
      ui?.notifications?.info?.('Flattening tiles... This may take a moment.');

      const selection = this._filterFlattenTargets(tiles);
      const { targets, skipped, outOfScope } = selection;

      if (outOfScope.length) {
        ui?.notifications?.warn?.(`Flatten only supports tiles in the ${describeCurrentLevelEditScope()}. Clear mixed-level selections and try again.`);
        return;
      }

      if (!targets.length) {
        ui?.notifications?.warn?.(
          skipped.length
            ? 'Hidden tiles are ignored when flattening. Select at least 1 visible tile.'
            : 'Please select at least 1 tile to flatten.'
        );
        return;
      }

      this._resolveUniformLevelMembership(targets);

      overlay = this._showOverlay('flatten');
      overlay.setStatus('Preparing tiles...');
      overlay.setProgress?.(0.1);
      await this._nextFrame();

      // Compute bounding box of all tiles (logical + shadow-aware)
      const logicalBounds = this._computeBounds(targets);
      if (!logicalBounds) {
        throw new Error('Could not compute bounds for selected tiles');
      }
      const previewPpi = Number(options?.previewPpi);
      const previewBounds = Number.isFinite(previewPpi) && previewPpi !== ppi
        ? null
        : this._normalizeFlattenBounds(options?.previewBounds);
      const shadowBounds = previewBounds || this._computeShadowedBounds(targets);
      if (!shadowBounds) {
        throw new Error('Could not compute shadow bounds for selected tiles');
      }

      const gridSize = Math.max(1, Number(canvas?.scene?.grid?.size || 100));
      const resolution = this._computeResolution(ppi, gridSize);
      const plannedRenderBounds = this._computeRenderBounds(shadowBounds, gridSize, normalizedPaddingSnap, paddingExtra);
      const plannedPixelWidth = Math.max(1, Math.round(plannedRenderBounds.width * resolution));
      const plannedPixelHeight = Math.max(1, Math.round(plannedRenderBounds.height * resolution));
      const maxTextureSize = this._getMaxTextureSize(canvas?.app?.renderer);
      const autoChunkPlan = resolveAutoChunking(plannedPixelWidth, plannedPixelHeight, {
        maxTextureSize
      });
      const hasManualChunking = normalizedChunkSquares.enabled || normalizedChunkSize > 0;
      const useAutoChunking = !hasManualChunking && autoChunkPlan.enabled;
      const useChunking = hasManualChunking ? true : useAutoChunking;
      const uploadContext = await this._resolveFlattenUploadContext(outputFolder);
      const baseName = this._sanitizeOutputBaseName(outputName, this._buildFlattenFilenameBase());
      const plannedFilenames = useChunking
        ? (() => {
          let chunkPixelWidth = 0;
          let chunkPixelHeight = 0;
          if (useAutoChunking) {
            chunkPixelWidth = autoChunkPlan.chunkPixelWidth;
            chunkPixelHeight = autoChunkPlan.chunkPixelHeight;
          } else {
            const chunkLayout = this._resolveChunkLayout({
              chunkWidth: normalizedChunkSquares.widthSquares,
              chunkHeight: normalizedChunkSquares.heightSquares,
              chunkPad: normalizedChunkPad,
              chunkSize: normalizedChunkSize
            }, gridSize, resolution, maxTextureSize);
            chunkPixelWidth = chunkLayout?.pixelWidth || 0;
            chunkPixelHeight = chunkLayout?.pixelHeight || 0;
          }
          return this._buildChunkOutputFilenames(baseName, plannedPixelWidth, plannedPixelHeight, {
            chunkPixelWidth,
            chunkPixelHeight
          });
        })()
        : [this._buildOutputFilename(baseName)];
      if (!overwriteConfirmed) {
        const approved = await this._confirmOverwriteOutputs(uploadContext, plannedFilenames, {
          title: 'Overwrite Existing Flatten Files?',
          actionLabel: 'Overwrite'
        });
        if (!approved) {
          ui?.notifications?.info?.('Tile flatten canceled.');
          return;
        }
      }
      let canvasData = null;
      let chunkData = null;
      let filePath = null;
      let chunkEntries = null;
      let singleOutput = null;
      let capturedChunks = null;

      if (useChunking) {
        overlay.setStatus('Capturing chunks...');
        overlay.setProgress?.(0.35);
        await this._nextFrame();

        capturedChunks = [];

        const autoChunkWidth = useAutoChunking ? (autoChunkPlan.chunkPixelWidth / ppi) : 0;
        const autoChunkHeight = useAutoChunking ? (autoChunkPlan.chunkPixelHeight / ppi) : 0;
        chunkData = await this._renderTilesToCanvasChunked(targets, shadowBounds, ppi, {
          paddingSnap: normalizedPaddingSnap,
          paddingExtra,
          chunkWidth: normalizedChunkSquares.enabled ? normalizedChunkSquares.widthSquares : autoChunkWidth,
          chunkHeight: normalizedChunkSquares.enabled ? normalizedChunkSquares.heightSquares : autoChunkHeight,
          chunkPad: normalizedChunkSquares.enabled ? normalizedChunkPad : false,
          chunkSize: normalizedChunkSquares.enabled ? 0 : (useAutoChunking ? 0 : normalizedChunkSize),
          chunkAuto: useAutoChunking,
          suspendRender: true,
          onChunk: async (entry, index, total) => {
            const label = Number.isFinite(total) && total > 0
              ? `Encoding chunk ${index + 1} of ${total}...`
              : 'Encoding chunk...';
            overlay.setStatus(label);
            if (Number.isFinite(total) && total > 0) {
              const progress = 0.35 + (0.25 * ((index + 1) / total));
              overlay.setProgress?.(Math.min(0.6, progress));
            }
            const rowLabel = Number.isFinite(entry?.row) ? entry.row + 1 : null;
            const colLabel = Number.isFinite(entry?.col) ? entry.col + 1 : null;
            const chunkSuffix = rowLabel && colLabel ? `-r${rowLabel}-c${colLabel}` : `-chunk-${index + 1}`;
            const filename = this._buildOutputFilename(baseName, chunkSuffix);
            let captured = null;
            try {
              captured = await this._captureFlattenChunkWebP(entry, quality, { uploadContext, filename });
            } finally {
              try {
                if (entry?.canvas) {
                  entry.canvas.width = 0;
                  entry.canvas.height = 0;
                }
              } catch (_) {}
            }
            if (captured) capturedChunks.push(captured);
          }
        });

        if (!chunkData) {
          throw new Error('Failed to render tile chunks');
        }
        if (!capturedChunks.length) {
          throw new Error('Failed to encode flattened image chunks');
        }
        const expectedChunks = Number.isFinite(chunkData?.rows) && Number.isFinite(chunkData?.columns)
          ? (chunkData.rows * chunkData.columns)
          : null;
        if (Number.isFinite(expectedChunks) && expectedChunks > 0 && capturedChunks.length !== expectedChunks) {
          throw new Error('Failed to encode all flattened image chunks');
        }
        chunkEntries = capturedChunks.map((record) => this._chunkBlobRecordToMetadataEntry(record));
        filePath = capturedChunks[0]?.src || null;
      } else {
        overlay.setStatus('Capturing canvas...');
        overlay.setProgress?.(0.35);
        await this._nextFrame();

        // Render tiles to canvas
        canvasData = await this._renderTilesToCanvas(targets, shadowBounds, ppi, {
          paddingSnap: normalizedPaddingSnap,
          paddingExtra,
          suspendRender: true
        });
        if (!canvasData || !canvasData.canvas) {
          throw new Error('Failed to render tiles to canvas');
        }

        overlay.setStatus('Encoding image...');
        overlay.setProgress?.(0.6);
        await this._nextFrame();

        const filename = this._normalizeWebPFilename({ filename: this._buildOutputFilename(baseName) });
        const blob = await this._canvasToWebPBlob(canvasData.canvas, quality);
        if (!blob) throw new Error(`Failed to encode flattened WebP ${filename}.`);
        filePath = this._predictWebPUploadPath(uploadContext, filename);
        singleOutput = { filename, src: filePath, blob };
        try {
          if (canvasData?.canvas) {
            canvasData.canvas.width = 0;
            canvasData.canvas.height = 0;
          }
        } catch (_) {}
      }

      overlay.setStatus('Building metadata...');
      overlay.setProgress?.(0.75);
      await this._nextFrame();

      const renderBounds = useChunking ? chunkData?.renderBounds : canvasData?.renderBounds;

      // Store metadata for deconstruction
      const metadata = this._buildMetadata({
        tiles: targets,
        logicalBounds,
        renderBounds,
        paddingInsets: useChunking ? chunkData?.paddingInsets : canvasData?.paddingInsets,
        pixelWidth: useChunking ? chunkData?.pixelWidth : canvasData?.pixelWidth,
        pixelHeight: useChunking ? chunkData?.pixelHeight : canvasData?.pixelHeight,
        ppi,
        quality,
        paddingSnap: normalizedPaddingSnap,
        paddingExtra,
        resolution: useChunking ? chunkData?.resolution : canvasData?.resolution,
        filePath,
        chunks: useChunking ? chunkEntries : null,
        chunking: useChunking ? chunkData?.chunking : null,
        chunkSize: useChunking ? (chunkData?.chunkSize ?? normalizedChunkSize) : 0
      });

      overlay.setStatus(useChunking ? 'Saving image chunks...' : 'Saving image...');
      overlay.setProgress?.(0.84);
      await this._nextFrame();
      if (useChunking) {
        for (let i = 0; i < capturedChunks.length; i += 1) {
          overlay.setStatus(`Saving chunk ${i + 1} of ${capturedChunks.length}...`);
          overlay.setProgress?.(0.84 + (0.05 * ((i + 1) / capturedChunks.length)));
          await this._saveCapturedFlattenWebP(capturedChunks[i], uploadContext, metadata);
        }
        filePath = capturedChunks[0]?.src || filePath;
      } else {
        filePath = await this._saveCapturedFlattenWebP(singleOutput, uploadContext, metadata);
      }
      metadata.filePath = filePath || metadata.filePath;
      if (metadata.embeddedMetadata) metadata.embeddedMetadata.primaryFilePath = metadata.filePath || null;

      overlay.setStatus('Creating flattened tile...');
      overlay.setProgress?.(0.9);
      await this._nextFrame();

      // Create flattened tile
      await this._createFlattenedTile(renderBounds, filePath, metadata);

      overlay.setStatus('Cleaning up...');
      overlay.setProgress?.(0.97);
      await this._nextFrame();

      // Delete original tiles
      await this._deleteOriginalTiles(targets);
      overlay.setProgress?.(1);

      ui?.notifications?.info?.('Tiles flattened successfully!');
      Logger.info('TileFlatten.flattenTiles.success', { tileCount: tiles.length, filePath });

    } catch (error) {
      Logger.error('TileFlatten.flattenTiles.failed', { error: String(error?.message || error) });
      ui?.notifications?.error?.(`Failed to flatten tiles: ${error?.message || error}`);
    } finally {
      this._hideOverlay();
      this._flattening = false;
    }
  }

  /**
   * Compute bounding box of all tiles
   */
  _computeBounds(tiles) {
    if (!Array.isArray(tiles) || tiles.length === 0) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const doc of tiles) {
      const x = Number(doc.x) || 0;
      const y = Number(doc.y) || 0;
      const width = Number(doc.width) || 0;
      const height = Number(doc.height) || 0;
      const rotation = Number(doc.rotation) || 0;

      // For rotated tiles, compute bounding box of rotated rectangle
      if (rotation !== 0) {
        const rad = rotation * (Math.PI / 180);
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const corners = [
          { x: x, y: y },
          { x: x + width, y: y },
          { x: x + width, y: y + height },
          { x: x, y: y + height }
        ];
        for (const corner of corners) {
          const dx = corner.x - (x + width / 2);
          const dy = corner.y - (y + height / 2);
          const rotatedX = (x + width / 2) + dx * cos - dy * sin;
          const rotatedY = (y + height / 2) + dx * sin + dy * cos;
          minX = Math.min(minX, rotatedX);
          minY = Math.min(minY, rotatedY);
          maxX = Math.max(maxX, rotatedX);
          maxY = Math.max(maxY, rotatedY);
        }
      } else {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + width);
        maxY = Math.max(maxY, y + height);
      }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null;
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  _collectSceneTiles({ includeHidden = false, levelRange = null } = {}) {
    const docs = [];
    const seen = new Set();
    const TileDoc = foundry?.documents?.TileDocument;
    const addDoc = (doc) => {
      if (!doc) return;
      if (!includeHidden && isTileHiddenForFlatten(doc)) return;
      if (levelRange) {
        if (!resolveTileLevelLayerRole(doc, levelRange)) return;
      } else if (!isTileInCurrentLevelEditScope(doc)) return;
      const id = doc.id || null;
      if (id && seen.has(id)) return;
      if (TileDoc && !(doc instanceof TileDoc)) return;
      docs.push(doc);
      if (id) seen.add(id);
    };

    try {
      const sceneTiles = canvas?.scene?.tiles || null;
      if (sceneTiles) {
        const contents = Array.isArray(sceneTiles.contents)
          ? sceneTiles.contents
          : (Array.isArray(sceneTiles)
            ? sceneTiles
            : (typeof sceneTiles.values === 'function' ? Array.from(sceneTiles.values()) : []));
        for (const doc of contents) addDoc(doc);
      }
    } catch (_) {}

    const layers = [canvas?.tiles, canvas?.background];
    for (const layer of layers) {
      const placeables = Array.isArray(layer?.placeables) ? layer.placeables : [];
      for (const placeable of placeables) {
        addDoc(placeable?.document || placeable);
      }
    }

    return docs;
  }

  _getSceneBounds() {
    try {
      const d = canvas?.dimensions;
      if (d) {
        const sr = d.sceneRect || d.sceneRectangle || null;
        if (sr && Number.isFinite(sr.width) && Number.isFinite(sr.height)) {
          const x = Number(sr.x || 0) || 0;
          const y = Number(sr.y || 0) || 0;
          const w = Math.max(1, Math.round(Number(sr.width || 0)));
          const h = Math.max(1, Math.round(Number(sr.height || 0)));
          return { x, y, width: w, height: h };
        }
        const x = Number((d.sceneX ?? 0) || 0) || 0;
        const y = Number((d.sceneY ?? 0) || 0) || 0;
        const w = Number((d.sceneWidth ?? d.width ?? canvas?.scene?.width) || 0) || 0;
        const h = Number((d.sceneHeight ?? d.height ?? canvas?.scene?.height) || 0) || 0;
        if (w > 0 && h > 0) return { x, y, width: w, height: h };
      }
      const grid = Number(canvas?.scene?.grid?.size || 100) || 100;
      const sw = Math.max(1, Number(canvas?.scene?.width || 50));
      const sh = Math.max(1, Number(canvas?.scene?.height || 50));
      const pad = Number(canvas?.scene?.padding || 0) || 0;
      const padPxX = Math.round(pad * sw * grid);
      const padPxY = Math.round(pad * sh * grid);
      return { x: -padPxX, y: -padPxY, width: sw * grid + 2 * padPxX, height: sh * grid + 2 * padPxY };
    } catch (_) {
      return null;
    }
  }

  _getForegroundElevation() {
    try {
      const range = getCurrentLevelElevationRange(canvas?.scene);
      if (range) return range.top;
    } catch (_) {}
    try {
      const foregroundElevation = Number(canvas?.primary?.foreground?.elevation);
      if (Number.isFinite(foregroundElevation)) return foregroundElevation;
    } catch (_) {}
    try {
      const gridDistance = Number(canvas?.scene?.grid?.distance || 0);
      if (Number.isFinite(gridDistance)) return gridDistance * 4;
    } catch (_) {}
    return 0;
  }

  _getTileElevation(doc) {
    return getTileElevationValue(doc);
  }

  _normalizeFlattenBounds(bounds) {
    if (!bounds || typeof bounds !== 'object') return null;
    const x = Number(bounds.x);
    const y = Number(bounds.y);
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    if (![x, y, width, height].every(Number.isFinite)) return null;
    if (width <= 0 || height <= 0) return null;
    return { x, y, width, height };
  }

  /**
   * Normalize tile list for flattening.
   */
  _filterFlattenTargets(tiles = []) {
    const list = Array.isArray(tiles) ? tiles : [];
    const targets = [];
    const skipped = [];
    const outOfScope = [];
    for (const doc of list) {
      if (!doc) continue;
      if (isTileHiddenForFlatten(doc)) {
        skipped.push(doc);
        continue;
      }
      if (!isTileInCurrentLevelEditScope(doc)) {
        outOfScope.push(doc);
        continue;
      }
      targets.push(doc);
    }
    return { targets, skipped, outOfScope };
  }

  /**
   * Render tiles to canvas including shadows, masks, paths
   * Render the stage directly with adjusted transforms - cannot move PrimaryCanvasObjects
   */
  async _renderTilesToCanvas(tiles, bounds, ppi, options = {}) {
    const canvasState = getCanvasReadiness({ requireStage: true, requireRenderer: true });
    if (!canvasState.isReady) {
      throw new Error('Canvas not available');
    }

    const activeCanvas = canvasState.canvas;
    const renderer = activeCanvas.app.renderer;
    const gridSize = Math.max(1, Number(activeCanvas.scene?.grid?.size || 100));
    const resolution = this._computeResolution(ppi, gridSize);
    const outputSnap = options?.paddingSnap;
    const outputExtra = options?.paddingExtra;
    const trimToContent = options?.trimToContent !== false;
    const capturePadding = trimToContent ? this._computeCapturePadding(gridSize) : 0;
    const baseBounds = bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null;
    let renderBounds = baseBounds ? { ...baseBounds } : null;
    if (renderBounds && capturePadding) {
      renderBounds = this._applyExtraPadding(renderBounds, capturePadding);
    }
    let paddingInsets = renderBounds ? this._computeBoundsInsets(bounds, renderBounds) : null;

    Logger.debug?.('TileFlatten.capture.init', {
      tileIds: tiles.map?.((t) => t?.id).filter(Boolean),
      bounds,
      renderBounds,
      gridSize,
      resolution,
      paddingInsets,
      capturePadding,
      trimToContent,
      ppi
    });

    if (!renderBounds) {
      throw new Error('Invalid bounds for flattened image');
    }

    if (renderBounds.width <= 0 || renderBounds.height <= 0) {
      throw new Error('Invalid dimensions for flattened image');
    }

    const maxTextureSize = this._getMaxTextureSize(renderer);
    let pixelWidth = Math.max(1, Math.round(renderBounds.width * resolution));
    let pixelHeight = Math.max(1, Math.round(renderBounds.height * resolution));
    if (pixelWidth > maxTextureSize || pixelHeight > maxTextureSize) {
      if (capturePadding && baseBounds) {
        renderBounds = { ...baseBounds };
        pixelWidth = Math.max(1, Math.round(renderBounds.width * resolution));
        pixelHeight = Math.max(1, Math.round(renderBounds.height * resolution));
      }
      if (pixelWidth > maxTextureSize || pixelHeight > maxTextureSize) {
        throw new Error(`Flattened image would exceed renderer texture cap (${pixelWidth}×${pixelHeight}px > ${maxTextureSize}). Try lowering PPI or enabling chunking.`);
      }
    }

    const renderGuard = this._suspendCanvasRender(options?.suspendRender);
    let visibilityState = null;
    try {
      visibilityState = await this._applyFlattenVisibility(tiles, renderBounds, options?.visibility);
      await this._waitForShadowLayers(visibilityState.shadowManager, visibilityState.shadowElevations);
      await this._prepareTilesForCapture(tiles);
      
      // Ensure selected tiles are visible
      for (const doc of tiles) {
        try {
          const placeable = doc?.object;
          this._forceTileCaptureVisibility(placeable);
        } catch (_) {}
      }
      
      await this._nextFrame();

      const stage = activeCanvas.stage;
      const primary = activeCanvas.primary;
      
      if (!stage || !primary) throw new Error('Canvas stage/primary unavailable');

      const keepBackground = !!options?.visibility?.keepBackground;
      const restorePrimaryRender = keepBackground ? null : this._forcePrimaryTransparentClear(primary);
      const restorePrimaryDisplay = this._usePrimaryChildRendering(primary);

      // Store original stage state
      const originalStageState = {
        scaleX: stage.scale?.x ?? 1,
        scaleY: stage.scale?.y ?? 1,
        positionX: stage.position?.x ?? 0,
        positionY: stage.position?.y ?? 0,
        pivotX: stage.pivot?.x ?? 0,
        pivotY: stage.pivot?.y ?? 0
      };
      
      const originalScreen = renderer.screen ? { 
        width: renderer.screen.width, 
        height: renderer.screen.height 
      } : null;

      const rendererBackground = renderer.background || null;
      const previousBackground = rendererBackground
        ? { alpha: rendererBackground.alpha, color: rendererBackground.color }
        : null;
      const hasBackgroundAlpha = typeof renderer.backgroundAlpha === 'number';
      const previousBackgroundAlpha = hasBackgroundAlpha ? renderer.backgroundAlpha : null;

      Logger.debug?.('TileFlatten.capture.stageRender', {
        originalStage: originalStageState,
        renderBounds,
        resolution,
        pixelSize: { width: pixelWidth, height: pixelHeight }
      });

      // Create render texture
      const renderTexture = PIXI.RenderTexture.create({
        width: pixelWidth,
        height: pixelHeight,
        resolution: 1,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });
      
      if (renderTexture?.baseTexture) {
        try { renderTexture.baseTexture.clearColor = [0, 0, 0, 0]; } catch (_) {}
      }

      let stageAdjusted = false;
      let restoreShadowBlur = null;
      try {
        // Adjust renderer screen to match our render texture size
        if (renderer.screen) {
          renderer.screen.width = pixelWidth;
          renderer.screen.height = pixelHeight;
        }
        
        // Adjust stage to render the target region at the desired resolution
        // Transform world coordinates to render texture coordinates
        try {
          if (stage.pivot && typeof stage.pivot.set === 'function') {
            stage.pivot.set(0, 0);
          }
        } catch (_) {}
        
        try {
          if (stage.position && typeof stage.position.set === 'function') {
            // Position stage so renderBounds.x,y maps to 0,0 in render texture
            // Current stage position + offset = target position
            const targetX = -renderBounds.x * resolution;
            const targetY = -renderBounds.y * resolution;
            stage.position.set(targetX, targetY);
            
            Logger.debug?.('TileFlatten.capture.stagePositionSet', {
              renderBounds,
              resolution,
              targetPosition: { x: targetX, y: targetY },
              stagePosition: { x: stage.position.x, y: stage.position.y }
            });
          }
        } catch (_) {}
        
        try {
          if (stage.scale && typeof stage.scale.set === 'function') {
            stage.scale.set(resolution, resolution);
            
            Logger.debug?.('TileFlatten.capture.stageScaleSet', {
              resolution,
              stageScale: { x: stage.scale.x, y: stage.scale.y }
            });
          }
        } catch (_) {}

        // Recompute shadow blur to match capture scale, restore afterwards
        restoreShadowBlur = this._syncShadowBlurForCapture(visibilityState.shadowManager);
        
        // Make background transparent
        if (rendererBackground) {
          try {
            rendererBackground.alpha = 0;
          } catch (_) {}
        }
        if (hasBackgroundAlpha) {
          try {
            renderer.backgroundAlpha = 0;
          } catch (_) {}
        }
        
        stageAdjusted = true;
        
        // Update transforms - critical for correct rendering
        await this._nextFrame();
        
        try {
          if (typeof stage.updateTransform === 'function') {
            stage.updateTransform();
          }
        } catch (_) {}
        
        try {
          if (typeof primary.updateTransform === 'function') {
            primary.updateTransform();
          }
        } catch (_) {}
        
        // Also update transforms for tiles and background layers
        const tilesLayer = activeCanvas.tiles;
        const backgroundLayer = activeCanvas.background;
        try {
          if (tilesLayer && typeof tilesLayer.updateTransform === 'function') {
            tilesLayer.updateTransform();
          }
        } catch (_) {}
        try {
          if (backgroundLayer && typeof backgroundLayer.updateTransform === 'function') {
            backgroundLayer.updateTransform();
          }
        } catch (_) {}
        
        await this._nextFrame(); // Extra frame for transforms to settle
        await this._prepareScatterForCapture(tiles, renderBounds, 'flatten-capture', { resolution });

        // Render the stage (which shows only visible tiles due to visibility state)
        try {
          renderer.render(stage, {
            renderTexture,
            clear: true,
            skipUpdateTransform: false
          });
        } catch (renderErr) {
          const errorMsg = String(renderErr?.message || renderErr);
          Logger.error('TileFlatten.capture.renderFailed', { 
            error: errorMsg,
            stagePos: stage.position ? { x: stage.position.x, y: stage.position.y } : null,
            stageScale: stage.scale ? { x: stage.scale.x, y: stage.scale.y } : null
          });
          throw new Error(`Failed to render tiles: ${errorMsg}`);
        }
      } catch (err) {
        renderTexture.destroy(true);
        throw err;
      } finally {
        // Restore stage state
        if (stageAdjusted) {
          try {
            if (stage.scale && typeof stage.scale.set === 'function') {
              stage.scale.set(originalStageState.scaleX, originalStageState.scaleY);
            }
          } catch (_) {}
          
          try {
            if (stage.position && typeof stage.position.set === 'function') {
              stage.position.set(originalStageState.positionX, originalStageState.positionY);
            }
          } catch (_) {}
          
          try {
            if (stage.pivot && typeof stage.pivot.set === 'function') {
              stage.pivot.set(originalStageState.pivotX, originalStageState.pivotY);
            }
          } catch (_) {}
          
          // Restore renderer screen
          if (originalScreen && renderer.screen) {
            renderer.screen.width = originalScreen.width;
            renderer.screen.height = originalScreen.height;
          }
          
          // Update transforms after restoration
          try {
            if (typeof stage.updateTransform === 'function') {
              stage.updateTransform();
            }
          } catch (_) {}
        }
        
        // Restore background
        if (rendererBackground && previousBackground) {
          try {
            rendererBackground.alpha = previousBackground.alpha;
            rendererBackground.color = previousBackground.color;
          } catch (_) {}
        }
        if (hasBackgroundAlpha && previousBackgroundAlpha !== null) {
          try {
            renderer.backgroundAlpha = previousBackgroundAlpha;
          } catch (_) {}
        }

        if (typeof restorePrimaryDisplay === 'function') {
          try { restorePrimaryDisplay(); } catch (_) {}
        }
        if (typeof restorePrimaryRender === 'function') {
          try { restorePrimaryRender(); } catch (_) {}
        }
        if (typeof restoreShadowBlur === 'function') {
          try { restoreShadowBlur(); } catch (_) {}
        }
        await this._restoreScatterAfterCapture(tiles);
      }

      const canvasEl = renderer.extract.canvas(renderTexture);
      renderTexture.destroy(true);

      let outputCanvas = canvasEl;
      let outputBounds = renderBounds;
      if (trimToContent && canvasEl) {
        const trim = this._trimCanvasToContent(canvasEl);
        if (trim && trim.width > 0 && trim.height > 0) {
          const trimmedCanvas = this._cropCanvas(canvasEl, trim);
          if (trimmedCanvas && trimmedCanvas !== canvasEl) {
            this._releaseCanvas(canvasEl);
          }
          outputCanvas = trimmedCanvas || canvasEl;
          outputBounds = {
            x: renderBounds.x + (trim.x / resolution),
            y: renderBounds.y + (trim.y / resolution),
            width: trim.width / resolution,
            height: trim.height / resolution
          };
        }
      }

      const targetBounds = this._computeRenderBounds(outputBounds, gridSize, outputSnap, outputExtra);
      const targetPixelWidth = Math.max(1, Math.round(targetBounds.width * resolution));
      const targetPixelHeight = Math.max(1, Math.round(targetBounds.height * resolution));
      if (targetPixelWidth > maxTextureSize || targetPixelHeight > maxTextureSize) {
        throw new Error(`Flattened image would exceed renderer texture cap (${targetPixelWidth}×${targetPixelHeight}px > ${maxTextureSize}). Try lowering PPI or enabling chunking.`);
      }

      const previousOutputCanvas = outputCanvas;
      const adjusted = this._adjustCanvasToBounds(outputCanvas, outputBounds, targetBounds, resolution);
      outputCanvas = adjusted?.canvas || outputCanvas;
      if (outputCanvas && previousOutputCanvas && outputCanvas !== previousOutputCanvas) {
        this._releaseCanvas(previousOutputCanvas);
      }
      outputBounds = targetBounds;
      paddingInsets = this._computeBoundsInsets(bounds, outputBounds);

      const diagnostics = this._diagnoseCanvas(outputCanvas);
      Logger.debug?.('TileFlatten.capture.canvas', {
        pixelWidth,
        pixelHeight,
        actualWidth: outputCanvas?.width,
        actualHeight: outputCanvas?.height,
        blank: diagnostics?.isBlank ?? true,
        diagnostics
      });

      return {
        canvas: outputCanvas,
        renderBounds: outputBounds,
        logicalBounds: bounds,
        pixelWidth: outputCanvas?.width ?? targetPixelWidth,
        pixelHeight: outputCanvas?.height ?? targetPixelHeight,
        paddingInsets,
        resolution,
        gridSize,
        ppi
      };
    } finally {
      if (visibilityState) {
        await this._restoreFlattenVisibility(visibilityState);
      }
      if (typeof renderGuard === 'function') {
        try { renderGuard(); } catch (_) {}
      }
    }
  }

  async _renderTilesToCanvasChunked(tiles, bounds, ppi, options = {}) {
    const canvasState = getCanvasReadiness({ requireStage: true, requireRenderer: true });
    if (!canvasState.isReady) {
      throw new Error('Canvas not available');
    }

    const activeCanvas = canvasState.canvas;
    const renderer = activeCanvas.app.renderer;
    const gridSize = Math.max(1, Number(activeCanvas.scene?.grid?.size || 100));
    const resolution = this._computeResolution(ppi, gridSize);
    const outputSnap = options?.paddingSnap;
    const outputExtra = options?.paddingExtra;
    const baseBounds = bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null;
    if (!baseBounds) {
      throw new Error('Invalid bounds for flattened image');
    }

    const maxTextureSize = this._getMaxTextureSize(renderer);
    let renderBounds = this._computeRenderBounds(baseBounds, gridSize, outputSnap, outputExtra);
    const chunkLayout = this._resolveChunkLayout(options, gridSize, resolution, maxTextureSize);
    if (!chunkLayout.enabled) {
      throw new Error('Chunk size is required for chunked flatten');
    }
    if (chunkLayout.padToChunks) {
      renderBounds = this._padBoundsToChunkGrid(renderBounds, chunkLayout.worldWidth, chunkLayout.worldHeight);
    }
    let paddingInsets = renderBounds ? this._computeBoundsInsets(bounds, renderBounds) : null;

    if (!renderBounds || renderBounds.width <= 0 || renderBounds.height <= 0) {
      throw new Error('Invalid dimensions for flattened image');
    }

    const pixelWidth = Math.max(1, Math.round(renderBounds.width * resolution));
    const pixelHeight = Math.max(1, Math.round(renderBounds.height * resolution));
    const logicalWidth = pixelWidth / resolution;
    const logicalHeight = pixelHeight / resolution;
    const scaleFixX = logicalWidth > 0 ? (renderBounds.width / logicalWidth) : 1;
    const scaleFixY = logicalHeight > 0 ? (renderBounds.height / logicalHeight) : 1;
    const shadowOverlapWorld = this._computeMaxShadowMargin(tiles);
    const scaleFixXSafe = Number.isFinite(scaleFixX) && scaleFixX > 0 ? scaleFixX : 1;
    const scaleFixYSafe = Number.isFinite(scaleFixY) && scaleFixY > 0 ? scaleFixY : 1;
    const baseOverlapPxX = shadowOverlapWorld > 0
      ? Math.max(0, Math.ceil((shadowOverlapWorld * resolution) / scaleFixXSafe))
      : 0;
    const baseOverlapPxY = shadowOverlapWorld > 0
      ? Math.max(0, Math.ceil((shadowOverlapWorld * resolution) / scaleFixYSafe))
      : 0;
    const chunkPixelBaseWidth = Number(chunkLayout.pixelWidth) || 0;
    const chunkPixelBaseHeight = Number(chunkLayout.pixelHeight) || 0;
    if (!chunkPixelBaseWidth || !chunkPixelBaseHeight) {
      throw new Error('Chunk size is required for chunked flatten');
    }

    const columns = Math.max(1, Math.ceil(pixelWidth / chunkPixelBaseWidth));
    const rows = Math.max(1, Math.ceil(pixelHeight / chunkPixelBaseHeight));
    const totalChunks = columns * rows;
    const chunkingMeta = {
      widthSquares: Number.isFinite(chunkLayout.widthSquares) ? chunkLayout.widthSquares : null,
      heightSquares: Number.isFinite(chunkLayout.heightSquares) ? chunkLayout.heightSquares : null,
      padToChunks: !!chunkLayout.padToChunks,
      pixelWidth: Number.isFinite(chunkLayout.pixelWidth) ? chunkLayout.pixelWidth : null,
      pixelHeight: Number.isFinite(chunkLayout.pixelHeight) ? chunkLayout.pixelHeight : null,
      worldWidth: Number.isFinite(chunkLayout.worldWidth) ? chunkLayout.worldWidth : null,
      worldHeight: Number.isFinite(chunkLayout.worldHeight) ? chunkLayout.worldHeight : null
    };

    const renderGuard = this._suspendCanvasRender(options?.suspendRender);
    let visibilityState = null;
    try {
      visibilityState = await this._applyFlattenVisibility(tiles, renderBounds, options?.visibility);
      await this._waitForShadowLayers(visibilityState.shadowManager, visibilityState.shadowElevations);
      await this._prepareTilesForCapture(tiles);

      for (const doc of tiles) {
        try {
          const placeable = doc?.object;
          this._forceTileCaptureVisibility(placeable);
        } catch (_) {}
      }

      await this._nextFrame();

      const stage = activeCanvas.stage;
      const primary = activeCanvas.primary;
      if (!stage || !primary) throw new Error('Canvas stage/primary unavailable');

      const keepBackground = !!options?.visibility?.keepBackground;
      const restorePrimaryRender = keepBackground ? null : this._forcePrimaryTransparentClear(primary);
      const restorePrimaryDisplay = this._usePrimaryChildRendering(primary);

      const originalStageState = {
        scaleX: stage.scale?.x ?? 1,
        scaleY: stage.scale?.y ?? 1,
        positionX: stage.position?.x ?? 0,
        positionY: stage.position?.y ?? 0,
        pivotX: stage.pivot?.x ?? 0,
        pivotY: stage.pivot?.y ?? 0
      };

      const originalScreen = renderer.screen
        ? { width: renderer.screen.width, height: renderer.screen.height }
        : null;

      const rendererBackground = renderer.background || null;
      const previousBackground = rendererBackground
        ? { alpha: rendererBackground.alpha, color: rendererBackground.color }
        : null;
      const hasBackgroundAlpha = typeof renderer.backgroundAlpha === 'number';
      const previousBackgroundAlpha = hasBackgroundAlpha ? renderer.backgroundAlpha : null;

      let stageAdjusted = false;
      let restoreShadowBlur = null;
      try {
        try {
          if (stage.pivot && typeof stage.pivot.set === 'function') {
            stage.pivot.set(0, 0);
          }
        } catch (_) {}

        try {
          if (stage.scale && typeof stage.scale.set === 'function') {
            stage.scale.set(resolution, resolution);
          }
        } catch (_) {}

        restoreShadowBlur = this._syncShadowBlurForCapture(visibilityState.shadowManager);

        if (rendererBackground) {
          try {
            rendererBackground.alpha = 0;
          } catch (_) {}
        }
        if (hasBackgroundAlpha) {
          try {
            renderer.backgroundAlpha = 0;
          } catch (_) {}
        }

        stageAdjusted = true;

        await this._nextFrame();

        try {
          if (typeof stage.updateTransform === 'function') {
            stage.updateTransform();
          }
        } catch (_) {}

        try {
          if (typeof primary.updateTransform === 'function') {
            primary.updateTransform();
          }
        } catch (_) {}

        const tilesLayer = activeCanvas.tiles;
        const backgroundLayer = activeCanvas.background;
        try {
          if (tilesLayer && typeof tilesLayer.updateTransform === 'function') {
            tilesLayer.updateTransform();
          }
        } catch (_) {}
        try {
          if (backgroundLayer && typeof backgroundLayer.updateTransform === 'function') {
            backgroundLayer.updateTransform();
          }
        } catch (_) {}

        await this._nextFrame();

        const chunks = [];
        let index = 0;
        for (let row = 0; row < rows; row += 1) {
          const pixelY = row * chunkPixelBaseHeight;
          const chunkPixelHeight = Math.max(1, Math.min(chunkPixelBaseHeight, pixelHeight - pixelY));
          const chunkWorldY = renderBounds.y + ((pixelY / resolution) * scaleFixY);
          const chunkWorldHeight = (chunkPixelHeight / resolution) * scaleFixY;
          const maxOverlapPxY = Math.floor((maxTextureSize - chunkPixelHeight) / 2);
          const overlapPxY = Math.max(0, Math.min(baseOverlapPxY, Number.isFinite(maxOverlapPxY) ? maxOverlapPxY : 0));
          const overlapWorldY = (overlapPxY / resolution) * scaleFixYSafe;

          for (let col = 0; col < columns; col += 1) {
            const pixelX = col * chunkPixelBaseWidth;
            const chunkPixelWidth = Math.max(1, Math.min(chunkPixelBaseWidth, pixelWidth - pixelX));
            const chunkWorldX = renderBounds.x + ((pixelX / resolution) * scaleFixX);
            const chunkWorldWidth = (chunkPixelWidth / resolution) * scaleFixX;
            const maxOverlapPxX = Math.floor((maxTextureSize - chunkPixelWidth) / 2);
            const overlapPxX = Math.max(0, Math.min(baseOverlapPxX, Number.isFinite(maxOverlapPxX) ? maxOverlapPxX : 0));
            const overlapWorldX = (overlapPxX / resolution) * scaleFixXSafe;
            const renderPixelWidth = chunkPixelWidth + (overlapPxX * 2);
            const renderPixelHeight = chunkPixelHeight + (overlapPxY * 2);

            try {
              if (stage.position && typeof stage.position.set === 'function') {
                stage.position.set(-(chunkWorldX - overlapWorldX) * resolution, -(chunkWorldY - overlapWorldY) * resolution);
              }
            } catch (_) {}

            try {
              if (typeof stage.updateTransform === 'function') {
                stage.updateTransform();
              }
            } catch (_) {}

            try {
              if (typeof primary.updateTransform === 'function') {
                primary.updateTransform();
              }
            } catch (_) {}

            if (renderer.screen) {
              renderer.screen.width = renderPixelWidth;
              renderer.screen.height = renderPixelHeight;
            }
            await this._prepareScatterForCapture(tiles, {
              x: chunkWorldX - overlapWorldX,
              y: chunkWorldY - overlapWorldY,
              width: chunkWorldWidth + (overlapWorldX * 2),
              height: chunkWorldHeight + (overlapWorldY * 2)
            }, 'flatten-chunk-capture', { resolution });

            const renderTexture = PIXI.RenderTexture.create({
              width: renderPixelWidth,
              height: renderPixelHeight,
              resolution: 1,
              scaleMode: PIXI.SCALE_MODES.LINEAR
            });

            if (renderTexture?.baseTexture) {
              try { renderTexture.baseTexture.clearColor = [0, 0, 0, 0]; } catch (_) {}
            }

            try {
              renderer.render(stage, {
                renderTexture,
                clear: true,
                skipUpdateTransform: false
              });
            } catch (renderErr) {
              const errorMsg = String(renderErr?.message || renderErr);
              renderTexture.destroy(true);
              throw new Error(`Failed to render tile chunk: ${errorMsg}`);
            }

            const canvasEl = renderer.extract.canvas(renderTexture);
            renderTexture.destroy(true);
            let outputCanvas = canvasEl;
            if (overlapPxX || overlapPxY) {
              outputCanvas = this._cropCanvas(canvasEl, {
                x: overlapPxX,
                y: overlapPxY,
                width: chunkPixelWidth,
                height: chunkPixelHeight
              });
              try {
                canvasEl.width = 0;
                canvasEl.height = 0;
              } catch (_) {}
            }

            const entry = {
              canvas: outputCanvas,
              x: chunkWorldX - renderBounds.x,
              y: chunkWorldY - renderBounds.y,
              width: chunkWorldWidth,
              height: chunkWorldHeight,
              pixelWidth: chunkPixelWidth,
              pixelHeight: chunkPixelHeight,
              row,
              col
            };

            if (typeof options?.onChunk === 'function') {
              await options.onChunk(entry, index, totalChunks);
            } else {
              chunks.push(entry);
            }

            index += 1;
          }
        }

        return {
          chunks,
          renderBounds,
          logicalBounds: bounds,
          pixelWidth,
          pixelHeight,
          paddingInsets,
          resolution,
          gridSize,
          ppi,
          chunking: chunkingMeta,
          chunkSize: Number.isFinite(chunkLayout.pixelSize) ? chunkLayout.pixelSize : null,
          rows,
          columns
        };
      } finally {
        if (stageAdjusted) {
          try {
            if (stage.scale && typeof stage.scale.set === 'function') {
              stage.scale.set(originalStageState.scaleX, originalStageState.scaleY);
            }
          } catch (_) {}

          try {
            if (stage.position && typeof stage.position.set === 'function') {
              stage.position.set(originalStageState.positionX, originalStageState.positionY);
            }
          } catch (_) {}

          try {
            if (stage.pivot && typeof stage.pivot.set === 'function') {
              stage.pivot.set(originalStageState.pivotX, originalStageState.pivotY);
            }
          } catch (_) {}

          if (originalScreen && renderer.screen) {
            renderer.screen.width = originalScreen.width;
            renderer.screen.height = originalScreen.height;
          }

          try {
            if (typeof stage.updateTransform === 'function') {
              stage.updateTransform();
            }
          } catch (_) {}
        }

        if (rendererBackground && previousBackground) {
          try {
            rendererBackground.alpha = previousBackground.alpha;
            rendererBackground.color = previousBackground.color;
          } catch (_) {}
        }
        if (hasBackgroundAlpha && previousBackgroundAlpha !== null) {
          try {
            renderer.backgroundAlpha = previousBackgroundAlpha;
          } catch (_) {}
        }

        if (typeof restorePrimaryDisplay === 'function') {
          try { restorePrimaryDisplay(); } catch (_) {}
        }
        if (typeof restorePrimaryRender === 'function') {
          try { restorePrimaryRender(); } catch (_) {}
        }
        if (typeof restoreShadowBlur === 'function') {
          try { restoreShadowBlur(); } catch (_) {}
        }
        await this._restoreScatterAfterCapture(tiles);
      }
    } finally {
      if (visibilityState) {
        await this._restoreFlattenVisibility(visibilityState);
      }
      if (typeof renderGuard === 'function') {
        try { renderGuard(); } catch (_) {}
      }
    }
  }

  async _capturePreviewBounds({ tiles, ppi } = {}) {
    let fallback = null;
    try {
      if (this.isBusy()) return null;
      const list = Array.isArray(tiles) ? tiles : [];
      if (!list.length) return null;
      const { targets } = this._filterFlattenTargets(list);
      if (!targets.length) return null;
      const shadowBounds = this._computeShadowedBounds(targets);
      if (!shadowBounds) return null;
      const gridSize = Math.max(1, Number(canvas?.scene?.grid?.size || 100));
      const resolution = this._computeResolution(ppi, gridSize);
      fallback = {
        bounds: shadowBounds,
        gridSize,
        resolution
      };
      const maxTextureSize = this._getMaxTextureSize(canvas?.app?.renderer);
      const capturePadding = this._computeCapturePadding(gridSize);
      const previewRenderBounds = capturePadding
        ? this._applyExtraPadding(shadowBounds, capturePadding)
        : shadowBounds;
      const previewPixelWidth = Math.max(1, Math.round(previewRenderBounds.width * resolution));
      const previewPixelHeight = Math.max(1, Math.round(previewRenderBounds.height * resolution));
      const autoChunkPlan = resolveAutoChunking(previewPixelWidth, previewPixelHeight, {
        maxTextureSize
      });
      if (autoChunkPlan?.enabled || previewPixelWidth > maxTextureSize || previewPixelHeight > maxTextureSize) {
        Logger.debug?.('TileFlatten.preview.captureSkipped', {
          reason: autoChunkPlan?.enabled ? 'autoChunking' : 'texture-cap',
          previewPixelWidth,
          previewPixelHeight,
          maxTextureSize,
          columns: autoChunkPlan?.columns || 1,
          rows: autoChunkPlan?.rows || 1
        });
        return fallback;
      }
      const capture = await this._renderTilesToCanvas(targets, shadowBounds, ppi, {
        paddingSnap: 'none',
        paddingExtra: 0,
        trimToContent: true,
        suspendRender: true
      });
      const bounds = capture?.renderBounds;
      this._releaseCanvas(capture?.canvas);
      if (!bounds) return fallback;
      return {
        bounds,
        gridSize: capture?.gridSize ?? gridSize,
        resolution: capture?.resolution ?? resolution
      };
    } catch (error) {
      Logger.debug?.('TileFlatten.preview.captureFailed', { error: String(error?.message || error) });
      return fallback;
    }
  }

  async _prepareTilesForCapture(tiles) {
    const jobs = [];
    const failures = [];
    for (const doc of Array.isArray(tiles) ? tiles : []) {
      try {
        const placeable = doc?.object;
        if (!placeable) continue;
        if (doc.getFlag?.('fa-nexus', 'maskedTiling')) {
          jobs.push({
            tileId: doc?.id || null,
            task: Promise.resolve(applyMaskedTilingToTile(placeable))
          });
        }
        if (doc.getFlag?.('fa-nexus', 'standardTileMask')) {
          jobs.push({
            tileId: doc?.id || null,
            task: Promise.resolve(applyStandardTileMaskToTile(placeable))
          });
        }
        if (
          doc.getFlag?.('fa-nexus', 'pathV2')
          || doc.getFlag?.('fa-nexus', 'pathsV2')
        ) {
          jobs.push({
            tileId: doc?.id || null,
            task: Promise.resolve(applyPathTile(placeable))
          });
        }
        if (doc.getFlag?.('fa-nexus', 'assetScatter')) {
          jobs.push({
            tileId: doc?.id || null,
            task: Promise.resolve(applyAssetScatterTile(placeable))
          });
        }
      } catch (error) {
        failures.push(error);
        Logger.warn?.('TileFlatten.capture.prepareTile.failed', {
          tileId: doc?.id || null,
          error: String(error?.message || error)
        });
      }
    }
    if (jobs.length) {
      const results = await Promise.allSettled(jobs.map((job) => job.task));
      results.forEach((result, index) => {
        if (result.status !== 'rejected') return;
        failures.push(result.reason);
        Logger.warn?.('TileFlatten.capture.prepareJob.failed', {
          tileId: jobs[index]?.tileId || null,
          error: String(result.reason?.message || result.reason)
        });
      });
    }
    if (failures.length) {
      throw new Error(`Tile flatten capture prep failed for ${failures.length} job(s).`);
    }
  }

  async _prepareScatterForCapture(tiles, renderBounds, reason = 'flatten-capture', options = {}) {
    const scatterTiles = [];
    for (const doc of Array.isArray(tiles) ? tiles : []) {
      try {
        if (!doc?.getFlag?.('fa-nexus', 'assetScatter')) continue;
        if (renderBounds && !this._tileOverlapsBounds(doc, renderBounds)) continue;
        const placeable = doc.object;
        if (!placeable || placeable.destroyed) {
          throw new Error(`Scatter tile ${doc.id || '(unknown)'} has no active placeable for capture.`);
        }
        const container = placeable?.mesh?.faNexusAssetScatterContainer || placeable?.faNexusAssetScatterContainer || null;
        if (!container || container.destroyed) await applyAssetScatterTile(placeable);
        const localBounds = this._computeScatterCaptureLocalBounds(doc, renderBounds);
        if (!localBounds) {
          throw new Error(`Scatter tile ${doc.id || '(unknown)'} could not resolve capture bounds.`);
        }
        syncAssetScatterCaptureLayer(placeable, localBounds, {
          reason,
          resolution: options?.resolution
        });
        scatterTiles.push(placeable);
      } catch (error) {
        Logger.warn?.('TileFlatten.capture.scatterPrepare.failed', {
          tileId: doc?.id || null,
          error: String(error?.message || error)
        });
        throw error;
      }
    }

    if (!scatterTiles.length) return;

    const failures = [];
    for (const tile of scatterTiles) {
      const container = tile?.mesh?.faNexusAssetScatterContainer || tile?.faNexusAssetScatterContainer || null;
      if (!container || container.destroyed) {
        failures.push({
          tileId: tile?.document?.id || null,
          reason: 'container-missing'
        });
        continue;
      }
      if (!container.faNexusAssetScatterCached || container.faNexusAssetScatterCacheMode === 'live') continue;
      const cacheStillEnabled = container.faNexusAssetScatterCacheVisualEnabled !== false;
      if (!cacheStillEnabled) continue;
      failures.push({
        tileId: tile?.document?.id || null,
        reason: 'capture-live-layer-unavailable',
        cacheMode: container.faNexusAssetScatterCacheMode || null,
        instances: Array.isArray(container.faNexusAssetScatterInstancesWithBounds)
          ? container.faNexusAssetScatterInstancesWithBounds.length
          : null,
        liveInstances: Number(container.faNexusAssetScatterViewportLiveCount) || 0
      });
    }

    if (failures.length) {
      Logger.error('TileFlatten.capture.scatterFullResolution.failed', { reason, failures });
      throw new Error('Scatter flatten/export could not switch to full-resolution capture. Try a smaller chunk size or reduce visible scatter density.');
    }
  }

  _computeScatterCaptureLocalBounds(doc, bounds) {
    try {
      if (!doc || !bounds) return null;
      const width = Math.max(1, Number(doc.width) || 0);
      const height = Math.max(1, Number(doc.height) || 0);
      const anchorX = Number(doc?.texture?.anchorX);
      const anchorY = Number(doc?.texture?.anchorY);
      const resolvedAnchorX = Number.isFinite(anchorX) ? anchorX : 0.5;
      const resolvedAnchorY = Number.isFinite(anchorY) ? anchorY : 0.5;
      const scaleX = Number(doc?.texture?.scaleX ?? 1);
      const scaleY = Number(doc?.texture?.scaleY ?? 1);
      const resolvedScaleX = Number.isFinite(scaleX) && Math.abs(scaleX) > 1e-6 ? scaleX : 1;
      const resolvedScaleY = Number.isFinite(scaleY) && Math.abs(scaleY) > 1e-6 ? scaleY : 1;
      const originX = Number(doc.x) || 0;
      const originY = Number(doc.y) || 0;
      const rotation = ((Number(doc.rotation) || 0) * Math.PI) / 180;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const points = [
        { x: bounds.x, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
        { x: bounds.x, y: bounds.y + bounds.height }
      ];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const point of points) {
        const dx = (Number(point.x) || 0) - originX;
        const dy = (Number(point.y) || 0) - originY;
        const unrotatedX = (dx * cos) + (dy * sin);
        const unrotatedY = (-dx * sin) + (dy * cos);
        const localX = (unrotatedX / resolvedScaleX) + (width * resolvedAnchorX);
        const localY = (unrotatedY / resolvedScaleY) + (height * resolvedAnchorY);
        minX = Math.min(minX, localX);
        minY = Math.min(minY, localY);
        maxX = Math.max(maxX, localX);
        maxY = Math.max(maxY, localY);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
      const padding = 2;
      return {
        x: minX - padding,
        y: minY - padding,
        width: Math.max(1, (maxX - minX) + (padding * 2)),
        height: Math.max(1, (maxY - minY) + (padding * 2))
      };
    } catch (error) {
      Logger.warn?.('TileFlatten.capture.scatterBounds.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      return null;
    }
  }

  async _restoreScatterAfterCapture(tiles) {
    try {
      const hasScatter = Array.isArray(tiles)
        && tiles.some((doc) => {
          try { return !!doc?.getFlag?.('fa-nexus', 'assetScatter'); }
          catch (_) { return false; }
        });
      if (!hasScatter) return;
      for (const doc of tiles) {
        try {
          if (!doc?.getFlag?.('fa-nexus', 'assetScatter')) continue;
          const placeable = doc.object;
          if (placeable && !placeable.destroyed) restoreAssetScatterCaptureLayer(placeable);
        } catch (error) {
          Logger.warn?.('TileFlatten.capture.scatterTileRestore.failed', {
            tileId: doc?.id || null,
            error: String(error?.message || error)
          });
        }
      }
      refreshAllAssetScatterViewportLayers('flatten-capture-restore', { force: true });
    } catch (error) {
      Logger.warn?.('TileFlatten.capture.scatterRestore.failed', {
        error: String(error?.message || error)
      });
    }
  }

  _forceTileCaptureVisibility(placeable) {
    const targets = [placeable, placeable?.root, placeable?.mesh, placeable?.sprite];
    const seen = new Set();
    for (const target of targets) {
      if (!target || target.destroyed || seen.has(target)) continue;
      seen.add(target);
      try { target.visible = true; } catch (_) {}
      try {
        if (typeof target.renderable === 'boolean') target.renderable = true;
      } catch (_) {}
    }

    const containers = [
      placeable?.mesh?.faNexusMaskContainer || placeable?.faNexusMaskContainer || null,
      placeable?.mesh?.faNexusStandardMaskContainer || placeable?.faNexusStandardMaskContainer || null,
      placeable?.mesh?.faNexusPathContainer || placeable?.faNexusPathContainer || null,
      placeable?.mesh?.faNexusAssetScatterContainer || placeable?.faNexusAssetScatterContainer || null
    ];
    for (const container of containers) {
      if (!container || container.destroyed || seen.has(container)) continue;
      seen.add(container);
      try { container.visible = true; } catch (_) {}
      try {
        if (typeof container.renderable === 'boolean') container.renderable = true;
      } catch (_) {}

      const tiling = container.faNexusTilingSprite || null;
      if (tiling && !tiling.destroyed && !seen.has(tiling)) {
        seen.add(tiling);
        try { tiling.visible = true; } catch (_) {}
        try {
          if (typeof tiling.renderable === 'boolean') tiling.renderable = true;
        } catch (_) {}
      }

      const maskSprite = container.faNexusMaskSprite || null;
      if (maskSprite && !maskSprite.destroyed && !seen.has(maskSprite)) {
        seen.add(maskSprite);
        try { maskSprite.visible = true; } catch (_) {}
      }
    }
  }

  _computeResolution(ppi, gridSize) {
    const numericPPI = Math.max(10, Number(ppi) || 200);
    const numericGrid = Math.max(1, Number(gridSize) || 100);
    const resolution = numericPPI / numericGrid;
    return Math.max(0.1, Math.min(8, resolution));
  }

  _computeShadowedBounds(tiles) {
    if (!Array.isArray(tiles) || !tiles.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const doc of tiles) {
      const base = this._computeTileWorldBounds(doc);
      if (!base) continue;
      const margins = this._computeTileShadowMargins(doc);
      const expanded = this._expandBoundsWithMargins(base, margins);
      minX = Math.min(minX, expanded.x);
      minY = Math.min(minY, expanded.y);
      maxX = Math.max(maxX, expanded.x + expanded.width);
      maxY = Math.max(maxY, expanded.y + expanded.height);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null;
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  _computeMaxShadowMargin(tiles) {
    if (!Array.isArray(tiles) || !tiles.length) return 0;
    let maxMargin = 0;
    for (const doc of tiles) {
      const margins = this._computeTileShadowMargins(doc);
      if (!margins) continue;
      maxMargin = Math.max(
        maxMargin,
        Number(margins.left) || 0,
        Number(margins.right) || 0,
        Number(margins.top) || 0,
        Number(margins.bottom) || 0
      );
    }
    return Number.isFinite(maxMargin) ? Math.max(0, maxMargin) : 0;
  }

  _computeTileShadowMargins(doc) {
    const margins = { left: 0, right: 0, top: 0, bottom: 0 };
    if (!doc || !this._hasShadowEnabled(doc)) return margins;
    if (!this._isDropShadowEnabled()) return margins;
    const alphaValue = this._readShadowValue(doc, 'shadowAlpha');
    const alpha = Number(alphaValue);
    if (alphaValue !== undefined && Number.isFinite(alpha) && alpha <= 0) return margins;
    const dilation = Math.max(0, this._readShadowNumeric(doc, 'shadowDilation'));
    const blur = Math.max(0, this._readShadowNumeric(doc, 'shadowBlur'));
    const blurMargin = this._computeShadowBlurMargin(blur);
    const extra = dilation + blurMargin;
    const offset = this._resolveShadowOffset(doc);
    margins.left = Math.max(0, extra - offset.x);
    margins.right = Math.max(0, extra + offset.x);
    margins.top = Math.max(0, extra - offset.y);
    margins.bottom = Math.max(0, extra + offset.y);
    return margins;
  }

  _computeShadowBlurMargin(blur) {
    const numeric = Math.max(0, Number(blur) || 0);
    if (!numeric) return 0;
    return Math.ceil((numeric * 2) + 1);
  }

  _computeRenderBounds(bounds, gridSize, paddingSnap, paddingExtra) {
    const extraPadding = this._normalizePaddingExtra(paddingExtra, gridSize);
    const expanded = this._applyExtraPadding(bounds, extraPadding);
    return this._snapBounds(expanded, gridSize, paddingSnap);
  }

  _padBoundsToChunkGrid(bounds, chunkWidth, chunkHeight) {
    if (!bounds) return bounds;
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    const chunkW = Number(chunkWidth);
    const chunkH = Number(chunkHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return bounds;
    if (!Number.isFinite(chunkW) || !Number.isFinite(chunkH) || chunkW <= 0 || chunkH <= 0) return bounds;
    const paddedWidth = Math.ceil(width / chunkW) * chunkW;
    const paddedHeight = Math.ceil(height / chunkH) * chunkH;
    return {
      x: bounds.x,
      y: bounds.y,
      width: paddedWidth,
      height: paddedHeight
    };
  }

  _snapBounds(bounds, gridSize, paddingSnap) {
    const snap = this._normalizePaddingSnap(paddingSnap);
    if (snap === 'none') return bounds;
    const increment = snap === 'half' ? (Number(gridSize) / 2) : Number(gridSize);
    if (!Number.isFinite(increment) || increment <= 0) return bounds;
    const minX = Math.floor(bounds.x / increment) * increment;
    const minY = Math.floor(bounds.y / increment) * increment;
    const maxX = Math.ceil((bounds.x + bounds.width) / increment) * increment;
    const maxY = Math.ceil((bounds.y + bounds.height) / increment) * increment;
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  _expandBoundsWithMargins(bounds, margins) {
    const left = Math.max(0, Number(margins?.left) || 0);
    const right = Math.max(0, Number(margins?.right) || 0);
    const top = Math.max(0, Number(margins?.top) || 0);
    const bottom = Math.max(0, Number(margins?.bottom) || 0);
    return {
      x: bounds.x - left,
      y: bounds.y - top,
      width: bounds.width + left + right,
      height: bounds.height + top + bottom
    };
  }

  _applyExtraPadding(bounds, extraPadding) {
    const pad = Number(extraPadding) || 0;
    if (!pad) return bounds;
    const width = bounds.width + pad * 2;
    const height = bounds.height + pad * 2;
    if (width <= 1 || height <= 1) return bounds;
    return {
      x: bounds.x - pad,
      y: bounds.y - pad,
      width,
      height
    };
  }

  _tileOverlapsBounds(doc, bounds) {
    try {
      if (!doc || !bounds) return false;
      const tb = this._computeTileWorldBounds(doc);
      if (!tb) return false;
      const rightA = tb.x + tb.width;
      const bottomA = tb.y + tb.height;
      const rightB = bounds.x + bounds.width;
      const bottomB = bounds.y + bounds.height;
      return !(rightA <= bounds.x || rightB <= tb.x || bottomA <= bounds.y || bottomB <= tb.y);
    } catch (_) {
      return true;
    }
  }

  _computeTileWorldBounds(doc) {
    try {
      const placeable = doc?.object;
      const mesh = placeable?.mesh || placeable?.sprite;
      if (mesh) {
        const width = Math.abs(Number(mesh.width || 0));
        const height = Math.abs(Number(mesh.height || 0));
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
          const anchorX = Number(mesh.anchor?.x ?? 0);
          const anchorY = Number(mesh.anchor?.y ?? 0);
          const posX = Number(mesh.position?.x ?? mesh.x ?? 0);
          const posY = Number(mesh.position?.y ?? mesh.y ?? 0);
          const rotation = Number.isFinite(Number(mesh.rotation))
            ? Number(mesh.rotation)
            : (Number(mesh.angle || 0) * (Math.PI / 180));
          const left = -width * anchorX;
          const top = -height * anchorY;
          const right = left + width;
          const bottom = top + height;
          if (!rotation) {
            return {
              x: posX + left,
              y: posY + top,
              width,
              height
            };
          }
          const cos = Math.cos(rotation);
          const sin = Math.sin(rotation);
          const corners = [
            { x: left, y: top },
            { x: right, y: top },
            { x: right, y: bottom },
            { x: left, y: bottom }
          ];
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          for (const corner of corners) {
            const rx = (corner.x * cos) - (corner.y * sin) + posX;
            const ry = (corner.x * sin) + (corner.y * cos) + posY;
            minX = Math.min(minX, rx);
            minY = Math.min(minY, ry);
            maxX = Math.max(maxX, rx);
            maxY = Math.max(maxY, ry);
          }
          if (Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)) {
            return {
              x: minX,
              y: minY,
              width: maxX - minX,
              height: maxY - minY
            };
          }
        }
      }
      const bounds = placeable?.bounds;
      if (bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height) && bounds.width > 0 && bounds.height > 0) {
        return {
          x: Number(bounds.x) || 0,
          y: Number(bounds.y) || 0,
          width: Number(bounds.width) || 0,
          height: Number(bounds.height) || 0
        };
      }
      const x = Number(doc.x) || 0;
      const y = Number(doc.y) || 0;
      const width = Number(doc.width) || 0;
      const height = Number(doc.height) || 0;
      const rotation = Number(doc.rotation) || 0;
      if (!rotation) {
        return { x, y, width, height };
      }
      const rad = rotation * (Math.PI / 180);
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const cx = x + width / 2;
      const cy = y + height / 2;
      const corners = [
        { x, y },
        { x: x + width, y },
        { x: x + width, y: y + height },
        { x, y: y + height }
      ];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const corner of corners) {
        const dx = corner.x - cx;
        const dy = corner.y - cy;
        const rx = cx + (dx * cos) - (dy * sin);
        const ry = cy + (dx * sin) + (dy * cos);
        if (rx < minX) minX = rx;
        if (ry < minY) minY = ry;
        if (rx > maxX) maxX = rx;
        if (ry > maxY) maxY = ry;
      }
      return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
      };
    } catch (_) {
      return null;
    }
  }

  _getMaxTextureSize(renderer) {
    try {
      const gl = renderer?.gl;
      if (gl) {
        const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        if (Number.isFinite(max)) return max;
      }
    } catch (_) {}
    try {
      const optionMax = renderer?.options?.maxTextureSize;
      if (Number.isFinite(optionMax)) return optionMax;
    } catch (_) {}
    try {
      const system = renderer?.textures ?? renderer?.texture;
      const max = system?.GC?.maxSize ?? system?.maxSize;
      if (Number.isFinite(max)) return max;
    } catch (_) {}
    return 8192;
  }

  _resolveDoorElevation(doc) {
    try {
      const directElevation = doc?.elevation;
      if (Number.isFinite(directElevation)) return Number(directElevation);
    } catch (_) {}
    try {
      const flagElevation = doc?.getFlag?.('fa-nexus', 'buildingWall')?.elevation;
      if (Number.isFinite(flagElevation)) return Number(flagElevation);
    } catch (_) {}
    try {
      const coreElevation = doc?.getFlag?.('core', 'elevation');
      if (Number.isFinite(coreElevation)) return Number(coreElevation);
    } catch (_) {}
    try {
      const flags = doc?.flags || doc?._source?.flags || {};
      const faElevation = flags?.['fa-nexus']?.buildingWall?.elevation;
      if (Number.isFinite(Number(faElevation))) return Number(faElevation);
      const coreElevation = flags?.core?.elevation;
      if (Number.isFinite(Number(coreElevation))) return Number(coreElevation);
    } catch (_) {}
    const foregroundElevation = Number(canvas?.primary?.foreground?.elevation);
    return Number.isFinite(foregroundElevation) ? foregroundElevation - 1 : 0;
  }

  _isDoorElevationIncluded(elevation, visibility = null, doc = null) {
    if (!visibility || typeof visibility !== 'object') return true;
    const levelIds = Array.isArray(visibility.levelIds)
      ? visibility.levelIds.map((levelId) => normalizeLevelId(levelId)).filter(Boolean)
      : [];
    if (levelIds.length && doc) {
      const included = levelIds.some((levelId) => getDocumentMembershipInLevel(doc, levelId) !== false);
      if (!included) return false;
    }
    const minElevation = Number(visibility.minElevation);
    const maxElevation = Number(visibility.maxElevation);
    if (Number.isFinite(minElevation) && elevation < minElevation) return false;
    if (Number.isFinite(maxElevation) && elevation >= maxElevation) return false;
    return true;
  }

  _isDoorVisualProxyIncluded(child, visibility = null) {
    if (!visibility || typeof visibility !== 'object') return true;
    const levelIds = Array.isArray(visibility.levelIds)
      ? visibility.levelIds.map((levelId) => normalizeLevelId(levelId)).filter(Boolean)
      : [];
    const sourceLevelId = normalizeLevelId(child?.faNexusSourceLevelId);
    if (levelIds.length && sourceLevelId && !levelIds.includes(sourceLevelId)) return false;
    const elevation = Number(
      child?.elevation
      ?? child?._closedPosition?.elevation
      ?? child?._animatedPosition?.elevation
    );
    return this._isDoorElevationIncluded(Number.isFinite(elevation) ? elevation : 0, visibility);
  }

  async _extractDoorMeshesForExport(doorVisibility = null) {
    try {
      const wallsLayer = canvas?.walls;
      const placeables = Array.isArray(wallsLayer?.placeables) ? wallsLayer.placeables : [];
      if (!placeables.length) return null;

      const entries = [];
      const candidateWalls = [];
      for (const wall of placeables) {
        const doc = wall?.document || wall;
        const hasDoorFlag = !!(doc?.getFlag?.('fa-nexus', 'buildingDoor') || doc?.getFlag?.('fa-nexus', 'buildingWindow'));
        const doorType = Number(doc?.door ?? doc?._source?.door ?? doc?.data?.door ?? 0);
        if (hasDoorFlag || doorType) candidateWalls.push(wall);
      }

      if (!candidateWalls.length) return null;

      let waitCount = 0;
      while (waitCount < 6) {
        let missing = false;
        for (const wall of candidateWalls) {
          const meshes = wall?.doorMeshes ? Array.from(wall.doorMeshes) : [];
          if (!meshes.length) {
            missing = true;
            break;
          }
        }
        if (!missing) break;
        waitCount += 1;
        await this._nextFrame();
      }

      for (const wall of candidateWalls) {
        const doorMeshes = wall?.doorMeshes ? Array.from(wall.doorMeshes) : [];
        if (!doorMeshes.length) continue;
        const doc = wall?.document || wall;
        const elevation = this._resolveDoorElevation(doc);
        const include = this._isDoorElevationIncluded(elevation, doorVisibility, doc);
        for (const mesh of doorMeshes) {
          if (!mesh || mesh.destroyed) continue;
          entries.push({
            mesh,
            visible: typeof mesh.visible === 'boolean' ? mesh.visible : null,
            renderable: typeof mesh.renderable === 'boolean' ? mesh.renderable : null
          });
          try {
            mesh.visible = !!include;
            if (typeof mesh.renderable === 'boolean') mesh.renderable = !!include;
          } catch (_) {}
        }
      }

      if (!entries.length) return null;

      return { entries };
    } catch (error) {
      Logger.debug?.('TileFlatten.doorMeshes.captureFailed', { error: String(error?.message || error) });
      return null;
    }
  }

  _restoreDoorMeshesForExport(state) {
    if (!state || typeof state !== 'object') return;
    const entries = Array.isArray(state.entries) ? state.entries : [];
    for (const entry of entries) {
      const mesh = entry?.mesh;
      if (!mesh || mesh.destroyed) continue;
      try {
        if (entry?.visible !== null && typeof entry?.visible === 'boolean') mesh.visible = entry.visible;
        if (entry?.renderable !== null && typeof entry?.renderable === 'boolean') mesh.renderable = entry.renderable;
      } catch (_) {}
    }
  }

  async _applyFlattenVisibility(tiles, renderBounds, options = {}) {
    const selectedIds = new Set();
    for (const doc of Array.isArray(tiles) ? tiles : []) {
      if (doc?.id) selectedIds.add(doc.id);
    }

    const doorMeshState = options?.keepDoors
      ? await this._extractDoorMeshesForExport(options?.doorVisibility)
      : null;

    const tilesLayer = canvas?.tiles;
    const placeables = Array.isArray(tilesLayer?.placeables) ? tilesLayer.placeables : [];
    const hiddenTiles = [];

    for (const placeable of placeables) {
      const doc = placeable?.document;
      if (!doc) continue;
      if (selectedIds.has(doc.id)) continue;
      if (renderBounds && !this._tileOverlapsBounds(doc, renderBounds)) continue;
      if (placeable.visible) {
        placeable.visible = false;
        hiddenTiles.push(placeable);
      }
    }

    const backgroundLayer = canvas?.background;
    const backgroundPlaceables = Array.isArray(backgroundLayer?.placeables) ? backgroundLayer.placeables : [];
    const hiddenBackgroundTiles = [];

    for (const placeable of backgroundPlaceables) {
      const doc = placeable?.document;
      if (!doc) continue;
      if (selectedIds.has(doc.id)) {
        try {
          if (!placeable.visible) placeable.visible = true;
        } catch (_) {}
        continue;
      }
      if (renderBounds && !this._tileOverlapsBounds(doc, renderBounds)) continue;
      if (placeable.visible) {
        placeable.visible = false;
        hiddenBackgroundTiles.push(placeable);
      }
    }

    const primary = canvas?.primary;
    const hiddenPrimary = [];
    const retainWallsLayer = !!options?.keepDoors && !doorMeshState;
    if (primary?.children) {
      for (const child of primary.children) {
        if (!child) continue;
        const name = typeof child?.name === 'string' ? child.name : '';
        const keep = this._shouldRetainPrimaryChild(child, options)
          || (retainWallsLayer && (child === canvas?.walls || name === 'walls'));
        if (!keep && child.visible) {
          hiddenPrimary.push({ child, visible: true });
          child.visible = false;
        }
      }
    }

    const hiddenSceneImages = [];
    const hiddenSceneTargets = new Set();
    const hideSceneTarget = (target) => {
      if (!target || hiddenSceneTargets.has(target)) return;
      if (typeof target.visible !== 'boolean') return;
      if (!target.visible) return;
      hiddenSceneTargets.add(target);
      hiddenSceneImages.push({ target, visible: true });
      target.visible = false;
    };
    const keepBackground = !!options?.keepBackground;
    const keepForeground = !!options?.keepForeground;
    if (!keepBackground) {
      hideSceneTarget(canvas?.primary?.background);
      hideSceneTarget(canvas?.primary?.background?.mesh);
      hideSceneTarget(canvas?.primary?.background?.sprite);
      const backgroundLayerIsPlaceable = Array.isArray(backgroundLayer?.placeables);
      if (backgroundLayer && !backgroundLayerIsPlaceable) {
        hideSceneTarget(backgroundLayer);
      }
    }
    if (!keepForeground) {
      hideSceneTarget(canvas?.primary?.foreground);
      hideSceneTarget(canvas?.primary?.foreground?.mesh);
      hideSceneTarget(canvas?.primary?.foreground?.sprite);
      const foregroundLayer = canvas?.foreground;
      const foregroundLayerIsPlaceable = Array.isArray(foregroundLayer?.placeables);
      if (foregroundLayer && !foregroundLayerIsPlaceable) {
        hideSceneTarget(foregroundLayer);
      }
    }

    const hiddenFrames = [];
    const hiddenControlIcons = [];
    for (const doc of Array.isArray(tiles) ? tiles : []) {
      try {
        const placeable = doc?.object;
        if (placeable?.frame) {
          hiddenFrames.push({ frame: placeable.frame, visible: placeable.frame.visible });
          placeable.frame.visible = false;
        }
        if (placeable?.controlIcon) {
          hiddenControlIcons.push({ icon: placeable.controlIcon, visible: placeable.controlIcon.visible });
          placeable.controlIcon.visible = false;
        }
      } catch (_) {}
    }

    const grid = canvas?.grid;
    const gridState = typeof grid?.visible === 'boolean' ? grid.visible : null;
    const interfaceGrid = canvas?.interface?.grid || null;
    const interfaceGridState = typeof interfaceGrid?.visible === 'boolean' ? interfaceGrid.visible : null;
    const interfaceHighlightStates = [];

    const effects = canvas?.effects;
    const effectsState = typeof effects?.visible === 'boolean' ? effects.visible : null;
    if (effects) effects.visible = false;

    // Use interface.grid.highlightLayers (non-deprecated API)
    if (interfaceGrid?.highlightLayers && typeof interfaceGrid.highlightLayers.values === 'function') {
      for (const layer of interfaceGrid.highlightLayers.values()) {
        if (!layer) continue;
        interfaceHighlightStates.push({ layer, visible: !!layer.visible });
        layer.visible = false;
      }
    }

    if (grid) grid.visible = false;
    if (interfaceGrid) interfaceGrid.visible = false;
    const interfaceGroup = canvas?.interface || null;
    const interfaceState = typeof interfaceGroup?.visible === 'boolean' ? interfaceGroup.visible : null;
    if (interfaceGroup) interfaceGroup.visible = false;

    const shadowState = this._suspendShadowsForFlatten(selectedIds, placeables);

    return {
      selectedIds,
      placeables,
      hiddenTiles,
      hiddenBackgroundTiles,
      hiddenSceneImages,
      hiddenPrimary,
      hiddenFrames,
      hiddenControlIcons,
      gridState,
      interfaceGridState,
      interfaceHighlightStates,
      interfaceState,
      effectsState,
      doorMeshState,
      ...shadowState
    };
  }

  _shouldRetainPrimaryChild(child, options = {}) {
    try {
      const keepTiles = options?.keepTiles !== false;
      const keepBackground = !!options?.keepBackground;
      const keepForeground = !!options?.keepForeground;
      if (child === canvas.tiles) return keepTiles;
      if (child === canvas.background) return keepBackground;
      if (child === canvas.foreground) return keepForeground;
      if (child === canvas?.primary?.background) return keepBackground;
      if (child === canvas?.primary?.foreground) return keepForeground;
      const keepDoors = !!options?.keepDoors;
      const ctorName = typeof child?.constructor?.name === 'string' ? child.constructor.name : '';
      const name = typeof child?.name === 'string' ? child.name : '';
      if (child?.faNexusDoorVisualProxy || name.startsWith('fa-nexus-door-visual-proxy:')) {
        return keepDoors && this._isDoorVisualProxyIncluded(child, options?.doorVisibility);
      }
      if (name.startsWith('fa-nexus-door-shadow')) return keepDoors;
      if (keepDoors && ctorName === 'DoorMesh') return true;
      if (keepDoors && name.startsWith('Door.')) return true;
      if (name === 'background') return keepBackground;
      if (name === 'foreground') return keepForeground;
      if (!name) return false;
      if (!name.startsWith('fa-nexus-')) return false;
      if (name.endsWith('-preview') || name.endsWith('-ghost')) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  _suspendShadowsForFlatten(selectedIds, placeables) {
    const manager = AssetShadowManager?.peek?.();
    if (!manager) {
      return { shadowManager: null, suspendedShadows: [], shadowElevations: [] };
    }

    const suspendedShadows = [];
    const elevations = new Set();

    for (const placeable of placeables) {
      const doc = placeable?.document;
      if (!doc) continue;
      if (selectedIds.has(doc.id)) continue;
      if (!this._hasShadowEnabled(doc)) continue;
      try {
        if (manager.suspendTile(doc)) {
          suspendedShadows.push(doc);
          elevations.add(Number(doc.elevation ?? 0) || 0);
        }
      } catch (error) {
        Logger.debug?.('TileFlatten.suspendShadow.failed', { error: String(error?.message || error) });
      }
    }

    return {
      shadowManager: manager,
      suspendedShadows,
      shadowElevations: Array.from(elevations)
    };
  }

  async _waitForShadowLayers(manager, elevations) {
    if (!manager || !Array.isArray(elevations) || elevations.length === 0) return;
    const start = Date.now();
    const timeout = 500;
    while (Date.now() - start < timeout) {
      let pending = false;
      for (const elevation of elevations) {
        try {
          const layer = manager?._layers?.get?.(elevation);
          if (layer && (layer.rebuilding || layer.dirty)) {
            pending = true;
            break;
          }
        } catch (_) {
          continue;
        }
      }
      if (!pending) return;
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  }

  _suspendCanvasRender(shouldSuspend) {
    if (!shouldSuspend) return null;
    try {
      const app = canvas?.app;
      const ticker = app?.ticker;
      const wasRunning = !!ticker?.started;
      if (!wasRunning) return null;
      if (typeof app?.stop === 'function') {
        app.stop();
      } else if (typeof ticker?.stop === 'function') {
        ticker.stop();
      }
      return () => {
        try {
          if (typeof app?.start === 'function') {
            app.start();
          } else if (typeof ticker?.start === 'function') {
            ticker.start();
          }
        } catch (_) {}
      };
    } catch (_) {
      return null;
    }
  }

  _usePrimaryChildRendering(primary) {
    try {
      if (!primary) return null;
      const sprite = primary.sprite ?? null;
      const previousState = {
        displayed: !!primary.displayed,
        spriteVisible: sprite ? !!sprite.visible : null,
        spriteRenderable: sprite && typeof sprite.renderable === 'boolean' ? sprite.renderable : null,
        clearColor: Array.isArray(primary.clearColor) ? primary.clearColor.slice() : null
      };

      primary.displayed = true;
      if (sprite) {
        sprite.visible = false;
        if (typeof sprite.renderable === 'boolean') sprite.renderable = false;
      }
      if (primary.clearColor) {
        try { primary.clearColor = [0, 0, 0, 0]; } catch (_) {}
      }
      try {
        primary.renderDirty = true;
      } catch (_) {}

      return () => {
        try { primary.displayed = previousState.displayed; } catch (_) {}
        if (sprite) {
          try { sprite.visible = previousState.spriteVisible; } catch (_) {}
          if (previousState.spriteRenderable !== null) {
            try { sprite.renderable = previousState.spriteRenderable; } catch (_) {}
          }
        }
        if (previousState.clearColor) {
          try { primary.clearColor = previousState.clearColor; } catch (_) {}
        }
        try { primary.renderDirty = true; } catch (_) {}
      };
    } catch (error) {
      Logger.debug?.('TileFlatten.capture.primaryDisplayPatchFailed', { error: String(error?.message || error) });
      return null;
    }
  }

  _forcePrimaryTransparentClear(primary) {
    try {
      if (!primary || typeof primary._render !== 'function') return null;
      const originalRender = primary._render;
      primary._render = function patchedPrimaryRender(localRenderer) {
        const activeRenderer = localRenderer || canvas?.app?.renderer;
        const framebuffer = activeRenderer?.framebuffer;
        let restoreClear = null;
        if (framebuffer && typeof framebuffer.clear === 'function') {
          const originalClear = framebuffer.clear;
          framebuffer.clear = function patchedClear(r, g, b, a, mask) {
            return originalClear.call(this, 0, 0, 0, 0, mask);
          };
          restoreClear = () => {
            framebuffer.clear = originalClear;
          };
        }
        try {
          return originalRender.call(this, activeRenderer);
        } finally {
          if (restoreClear) {
            try { restoreClear(); } catch (_) {}
          }
        }
      };
      try { primary.renderDirty = true; } catch (_) {}
      return () => {
        primary._render = originalRender;
        try { primary.renderDirty = true; } catch (_) {}
      };
    } catch (error) {
      Logger.debug?.('TileFlatten.capture.primaryClearPatchFailed', { error: String(error?.message || error) });
      return null;
    }
  }

  async _restoreFlattenVisibility(state) {
    if (!state) return;
    try {
      for (const placeable of state.hiddenTiles || []) {
        if (placeable) placeable.visible = true;
      }
    } catch (_) {}

    try {
      if (state.shadowManager && state.suspendedShadows?.length) {
        for (const doc of state.suspendedShadows) {
          try {
            state.shadowManager.resumeTile(doc);
          } catch (error) {
            Logger.debug?.('TileFlatten.resumeShadow.failed', { error: String(error?.message || error) });
          }
        }
        await this._waitForShadowLayers(state.shadowManager, state.shadowElevations);
      }
    } catch (_) {}

    try {
      for (const entry of state.hiddenPrimary || []) {
        if (entry?.child) entry.child.visible = !!entry.visible;
      }
    } catch (_) {}

    try {
      this._restoreDoorMeshesForExport(state.doorMeshState);
    } catch (_) {}

    try {
      for (const entry of state.hiddenSceneImages || []) {
        if (entry?.target && typeof entry.target.visible === 'boolean') {
          entry.target.visible = !!entry.visible;
        }
      }
    } catch (_) {}

    try {
      for (const placeable of state.hiddenBackgroundTiles || []) {
        if (placeable) placeable.visible = true;
      }
    } catch (_) {}

    try {
      for (const entry of state.hiddenFrames || []) {
        if (entry?.frame) entry.frame.visible = !!entry.visible;
      }
    } catch (_) {}

    try {
      for (const entry of state.hiddenControlIcons || []) {
        if (entry?.icon) entry.icon.visible = !!entry.visible;
      }
    } catch (_) {}

    try {
      const grid = canvas?.grid;
      if (typeof state.gridState === 'boolean' && grid) {
        grid.visible = state.gridState;
      }
      const interfaceGrid = canvas?.interface?.grid;
      if (typeof state.interfaceGridState === 'boolean' && interfaceGrid) {
        interfaceGrid.visible = state.interfaceGridState;
      }
      if (Array.isArray(state.interfaceHighlightStates) && interfaceGrid?.highlightLayers) {
        for (const entry of state.interfaceHighlightStates) {
          const layer = entry?.layer;
          if (!layer) continue;
          try { layer.visible = !!entry.visible; } catch (_) {}
        }
      }
      const effects = canvas?.effects;
      if (typeof state.effectsState === 'boolean' && effects) {
        effects.visible = state.effectsState;
      }
      const interfaceGroup = canvas?.interface;
      if (typeof state.interfaceState === 'boolean' && interfaceGroup) {
        interfaceGroup.visible = state.interfaceState;
      }
    } catch (_) {}
  }

  /**
   * Align shadow blur radius with the current canvas scale for capture, and
   * provide a restore function to re-sync after reverting the stage transform.
   */
  _syncShadowBlurForCapture(manager) {
    try {
      const mgr = manager || AssetShadowManager?.peek?.();
      if (!mgr || typeof mgr._onCanvasPan !== 'function') return null;
      mgr._onCanvasPan(); // apply blur for current stage scale
      return () => {
        try { mgr._onCanvasPan(); } catch (_) {}
      };
    } catch (_) {
      return null;
    }
  }

  async _nextFrame() {
    await new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 16);
    });
  }

  _hasShadowEnabled(doc) {
    try {
      return !!doc?.getFlag?.('fa-nexus', 'shadow');
    } catch (_) {
      const flags = doc?.flags?.['fa-nexus'];
      return !!(flags && flags.shadow);
    }
  }

  _readShadowNumeric(doc, key) {
    try {
      const value = doc?.getFlag?.('fa-nexus', key);
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : 0;
    } catch (_) {
      return 0;
    }
  }

  _readShadowValue(doc, key) {
    try {
      const value = doc?.getFlag?.('fa-nexus', key);
      if (value !== undefined && value !== null) return value;
    } catch (_) {}
    try {
      const flags = doc?.flags?.['fa-nexus'] || doc?._source?.flags?.['fa-nexus'];
      if (flags && Object.prototype.hasOwnProperty.call(flags, key)) return flags[key];
    } catch (_) {}
    return undefined;
  }

  _resolveShadowOffset(doc) {
    const rawX = this._readShadowValue(doc, 'shadowOffsetX');
    const rawY = this._readShadowValue(doc, 'shadowOffsetY');
    const offsetX = Number(rawX);
    const offsetY = Number(rawY);
    if (Number.isFinite(offsetX) && Number.isFinite(offsetY)) return { x: offsetX, y: offsetY };
    const distRaw = this._readShadowValue(doc, 'shadowOffsetDistance');
    const angleRaw = this._readShadowValue(doc, 'shadowOffsetAngle');
    const distance = Number.isFinite(Number(distRaw)) ? Number(distRaw) : 0;
    const angle = Number.isFinite(Number(angleRaw)) ? Number(angleRaw) : 135;
    const radians = this._normalizeAngle(angle) * (Math.PI / 180);
    return {
      x: Math.cos(radians) * distance,
      y: Math.sin(radians) * distance
    };
  }

  _normalizeAngle(angle) {
    const numeric = Number(angle);
    if (!Number.isFinite(numeric)) return 0;
    let normalized = numeric % 360;
    if (normalized < 0) normalized += 360;
    return normalized;
  }

  _isCanvasBlank(canvas) {
    try {
      if (!canvas) return true;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return true;
      const { width, height } = canvas;
      if (!width || !height) return true;
      const sampleWidth = Math.min(width, 4);
      const sampleHeight = Math.min(height, 4);
      const data = ctx.getImageData(0, 0, sampleWidth, sampleHeight)?.data;
      if (!data) return true;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a !== 0 && (r !== 0 || g !== 0 || b !== 0)) return false;
      }
      return true;
    } catch (error) {
      Logger.debug?.('TileFlatten.capture.blankCheckFailed', { error: String(error?.message || error) });
      return false;
    }
  }

  _deepClone(value) {
    if (value == null || typeof value !== 'object') return value;
    try {
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
    } catch (_) {}
    try {
      return structuredClone(value);
    } catch (_) {}
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  _serializeMatrix(matrix) {
    try {
      if (!matrix) return null;
      const round = (v) => (Number.isFinite(v) ? Number(v.toFixed(6)) : v);
      return {
        a: round(matrix.a),
        b: round(matrix.b),
        c: round(matrix.c),
        d: round(matrix.d),
        tx: round(matrix.tx),
        ty: round(matrix.ty)
      };
    } catch (_) {
      return null;
    }
  }

  _serializePoint(point) {
    try {
      if (!point) return null;
      const round = (v) => (Number.isFinite(v) ? Number(v.toFixed(3)) : v);
      return { x: round(point.x), y: round(point.y) };
    } catch (_) {
      return null;
    }
  }

  _diagnoseCanvas(canvasEl) {
    try {
      if (!canvasEl) return { reason: 'no-canvas', isBlank: true };
      const width = canvasEl.width ?? 0;
      const height = canvasEl.height ?? 0;
      if (!width || !height) {
        return { reason: 'zero-dimensions', width, height, isBlank: true };
      }
      const ctx = canvasEl.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        return { reason: 'no-context', width, height, isBlank: true };
      }
      const samplePoints = [
        { label: 'center', x: Math.floor(width / 2), y: Math.floor(height / 2) },
        { label: 'topLeft', x: 0, y: 0 },
        { label: 'bottomRight', x: width - 1, y: height - 1 }
      ];
      const samples = [];
      let nonZero = false;
      for (const sample of samplePoints) {
        const data = ctx.getImageData(sample.x, sample.y, 1, 1)?.data;
        if (!data) continue;
        const rgba = Array.from(data).slice(0, 4);
        if (rgba.some((value) => value !== 0)) nonZero = true;
        samples.push({ label: sample.label, rgba });
      }
      return {
        width,
        height,
        samples,
        isBlank: !nonZero
      };
    } catch (error) {
      return { reason: 'diagnostic-error', error: String(error?.message || error), isBlank: true };
    }
  }

  /**
   * Ensure nested directory structure exists
   */
  async _ensureNestedDir(targetDir, context = null) {
    const segments = String(targetDir || '').split('/').filter(Boolean);
    if (!segments.length) return;
    let acc = segments[0];
    await this._ensureDir(acc, context);
    for (let i = 1; i < segments.length; i++) {
      acc = `${acc}/${segments[i]}`;
      await this._ensureDir(acc, context);
    }
  }

  /**
   * Ensure a single directory exists
   */
  async _ensureDir(dir, context = null) {
    const FP = foundry.applications.apps.FilePicker.implementation;
    const source = context?.source || 'data';
    const options = context?.options || {};
    try {
      await FP.browse(source, dir, options);
    } catch (_) {
      await FP.createDirectory(source, dir, options);
    }
  }

  /**
   * Get the assets directory from settings
   * @returns {string}
   */
  _getAssetsDir() {
    return getConfiguredAssetsDir({ moduleId: MODULE_ID });
  }

  async _registerGeneratedFlattenRoot(root) {
    const normalizedRoot = sanitizeStoragePathSegments(root).replace(/\/+$/, '');
    try {
      const result = await ensureGeneratedFlattenRootRegistered(root, {
        moduleId: MODULE_ID,
        assetsDir: this._getAssetsDir()
      });
      Logger.info(
        result?.existed ? 'TileFlatten.generatedRoots.exists' : 'TileFlatten.generatedRoots.registered',
        { root: result?.root || normalizedRoot || root, count: result?.roots?.length || 0 }
      );
      return result?.roots || [];
    } catch (error) {
      Logger.error('TileFlatten.generatedRoots.writeFailed', {
        root: normalizedRoot,
        error: String(error?.message || error)
      });
      throw new Error(`Failed to persist generated flatten root ${normalizedRoot}: ${error?.message || error}`);
    }
  }

  isBusy() {
    return !!(this._flattening || this._deconstructing);
  }

  _getOverlay() {
    if (!this._overlay) this._overlay = new TileFlattenOverlay();
    return this._overlay;
  }

  _showOverlay(kind, total = null) {
    const overlay = this._getOverlay();
    overlay.show(kind, { total });
    return overlay;
  }

  _hideOverlay() {
    try { this._overlay?.hide(); } catch (_) {}
  }

  static isFlattenedTile(doc) {
    try {
      const data = doc?.getFlag?.('fa-nexus', 'flattened');
      return !!data && typeof data === 'object';
    } catch (_) {
      return false;
    }
  }

  static isMergedTile(doc) {
    if (!doc) return false;
    try {
      const merged = doc?.getFlag?.('fa-nexus', 'pathsV2');
      if (merged && typeof merged === 'object' && Array.isArray(merged.paths)) return true;
    } catch (_) {}
    try {
      const scatter = doc?.getFlag?.('fa-nexus', 'assetScatter');
      if (scatter && typeof scatter === 'object' && Array.isArray(scatter.instances)) return true;
    } catch (_) {}
    try {
      const flags = doc?.flags?.['fa-nexus'] || doc?._source?.flags?.['fa-nexus'];
      if (flags?.pathsV2 && typeof flags.pathsV2 === 'object' && Array.isArray(flags.pathsV2.paths)) return true;
      if (flags?.assetScatter && typeof flags.assetScatter === 'object' && Array.isArray(flags.assetScatter.instances)) return true;
    } catch (_) {}
    return false;
  }

  static isCompositeTile(doc) {
    return this.isMergedTile(doc);
  }

  async confirmAndDeconstructTile(tileDoc) {
    let metadata = null;
    try {
      metadata = await this._resolveFlattenMetadataForDeconstruct(tileDoc);
    } catch (error) {
      Logger.error('TileFlatten.deconstruct.metadataResolveFailed', {
        tileId: tileDoc?.id || null,
        error: String(error?.message || error)
      });
      ui?.notifications?.error?.(`Cannot deconstruct tile: ${error?.message || error}`);
      return;
    }

    if (this.isBusy()) {
      ui?.notifications?.warn?.('Another flattening or deconstruction operation is already in progress.');
      return;
    }

    const confirmed = await this._confirmDeconstruct(tileDoc, metadata);
    if (!confirmed) return;

    await this.deconstructFlattenedTile(tileDoc, metadata, { embeddedVerified: true });
  }

  async deconstructFlattenedTile(tileDoc, metadata = null, options = {}) {
    if (!tileDoc) {
      ui?.notifications?.error?.('No tile selected for deconstruction.');
      return;
    }

    if (this.isBusy()) {
      ui?.notifications?.warn?.('Another flattening or deconstruction operation is already in progress.');
      return;
    }

    let flattenMeta = null;
    try {
      flattenMeta = metadata
        ? this._deepClone(metadata)
        : await this._resolveFlattenMetadataForDeconstruct(tileDoc);
      if (flattenMeta && !options?.embeddedVerified && this._requiresEmbeddedFlattenMetadata(flattenMeta)) {
        await this._assertEmbeddedFlattenMetadataReadable(tileDoc, flattenMeta);
      }
    } catch (error) {
      Logger.error('TileFlatten.deconstruct.metadataResolveFailed', {
        tileId: tileDoc?.id || null,
        error: String(error?.message || error)
      });
      ui?.notifications?.error?.(`Cannot deconstruct tile: ${error?.message || error}`);
      return;
    }
    if (!flattenMeta) {
      ui?.notifications?.warn?.('Selected tile does not contain FA Nexus flatten data.');
      return;
    }

    const transformValidation = this._validateFlattenedTileRestoreTransform(tileDoc, flattenMeta);
    if (!transformValidation.ok) {
      ui?.notifications?.error?.(transformValidation.message);
      return;
    }

    const offset = this._resolveFlattenOffset(tileDoc, flattenMeta);
    const restoration = this._prepareDeconstructionPayload(flattenMeta, offset, {
      forceLegacyTilePositionMigration: this._shouldForceLegacyFlattenTilePositionMigration(tileDoc, flattenMeta)
    });
    const payloads = restoration.payloads;
    if (!payloads.length) {
      ui?.notifications?.error?.('Flattened tile has no stored tiles to restore.');
      return;
    }

    if (!canvas?.scene) {
      ui?.notifications?.error?.('Scene not available.');
      return;
    }

    this._deconstructing = true;
    let overlay = null;
    const transaction = {
      flattenedId: tileDoc?.id || null,
      restoreCount: payloads.length,
      stage: 'plan',
      createdDocs: [],
      relinkPlan: null,
      relinkApplied: false
    };

    try {
      ui?.notifications?.info?.('Restoring flattened tiles...');
      overlay = this._showOverlay('deconstruct', payloads.length);
      overlay.updateProgress(0, payloads.length);
      await this._nextFrame();

      const chunkSize = 25;
      transaction.stage = 'create';
      for (let i = 0; i < payloads.length; i += chunkSize) {
        const chunk = payloads.slice(i, i + chunkSize);
        Logger.debug?.('TileFlatten.deconstruct.createChunk.start', {
          flattenedId: transaction.flattenedId,
          startIndex: i,
          chunkSize: chunk.length,
          totalPayloads: payloads.length
        });
        const chunkCreated = await canvas.scene.createEmbeddedDocuments('Tile', chunk);
        if (Array.isArray(chunkCreated)) transaction.createdDocs.push(...chunkCreated);
        Logger.debug?.('TileFlatten.deconstruct.createChunk.complete', {
          flattenedId: transaction.flattenedId,
          startIndex: i,
          createdChunkCount: Array.isArray(chunkCreated) ? chunkCreated.length : 0,
          createdTotal: transaction.createdDocs.length
        });
        overlay.updateProgress(Math.min(i + chunk.length, payloads.length), payloads.length);
      }

      transaction.stage = 'hydrate-renderers';
      await this._hydrateRestoredCustomTileRenderers(transaction.createdDocs, {
        stage: 'before-commit'
      });

      transaction.stage = 'plan-relink';
      transaction.relinkPlan = this._buildRestoredTileReferenceRelinkPlan(flattenMeta, transaction.createdDocs, restoration.restoredEntries);

      transaction.stage = 'relink';
      transaction.relinkApplied = true;
      await this._applyRestoredTileReferenceRelinkPlan(transaction.relinkPlan);

      transaction.stage = 'commit';
      await canvas.scene.deleteEmbeddedDocuments('Tile', [tileDoc.id]);

      Logger.info('TileFlatten.deconstruct.success', {
        restoredCount: payloads.length,
        createdCount: transaction.createdDocs.length,
        flattenedId: tileDoc.id,
        preservedNestedFlattened: restoration.preservedNestedFlattened || 0,
        relinkedTileDocuments: transaction.relinkPlan?.tileUpdates?.size || 0,
        relinkedWallDocuments: transaction.relinkPlan?.wallUpdates?.size || 0
      });

      await this._nextFrame();
      const postCommitRender = await this._hydrateRestoredCustomTileRenderers(transaction.createdDocs, {
        stage: 'after-commit',
        failOnError: false
      });

      const layer = canvas?.tiles;
      if (layer?.releaseAll && transaction.createdDocs.length) {
        try { layer.releaseAll(); } catch (_) {}
        await this._nextFrame();
        for (const doc of transaction.createdDocs) {
          if (!doc?.id) continue;
          const placeable = layer?.placeables?.find?.((p) => p?.document?.id === doc.id);
          if (placeable?.control) {
            try { placeable.control({ releaseOthers: false }); } catch (_) {}
          }
        }
      }

      if (postCommitRender?.failures?.length) {
        ui?.notifications?.warn?.('Flattened tile restored, but some masked tile renderers did not refresh. Check the console logs for FA Nexus details.');
      } else {
        ui?.notifications?.info?.('Flattened tile deconstructed successfully.');
      }
    } catch (error) {
      const rollback = await this._rollbackDeconstructRestoreTransaction(tileDoc, transaction, error);
      if (rollback?.commitLikelyApplied) {
        Logger.error('TileFlatten.deconstruct.commitReportedFailureAfterDelete', {
          flattenedId: transaction.flattenedId,
          stage: transaction.stage,
          restoreCount: transaction.restoreCount,
          createdCount: transaction.createdDocs.length,
          error: String(error?.message || error)
        });
        ui?.notifications?.warn?.(`Flattened tiles were restored, but wrapper cleanup reported an error after commit: ${error?.message || error}`);
      } else {
        Logger.error('TileFlatten.deconstruct.failed', {
          flattenedId: transaction.flattenedId,
          stage: transaction.stage,
          restoreCount: transaction.restoreCount,
          createdCount: transaction.createdDocs.length,
          relinkApplied: transaction.relinkApplied,
          error: String(error?.message || error),
          rollbackAttempted: !!rollback?.attempted,
          rollbackOk: rollback?.ok !== false,
          rollbackMarkerWritten: !!rollback?.markerWritten
        });
        const rollbackSuffix = rollback?.ok === false
          ? ' Automatic rollback also failed; check logs and the flattened tile metadata for recovery details.'
          : '';
        ui?.notifications?.error?.(`Failed to deconstruct tile: ${error?.message || error}${rollbackSuffix}`);
      }
    } finally {
      this._hideOverlay();
      this._deconstructing = false;
    }
  }

  _resolveFlattenMetadata(tileDoc) {
    try {
      if (!tileDoc || typeof tileDoc.getFlag !== 'function') return null;
      const data = tileDoc.getFlag('fa-nexus', 'flattened');
      if (!data || typeof data !== 'object') return null;
      return this._deepClone(data);
    } catch (error) {
      Logger.debug?.('TileFlatten.resolveMetadata.failed', { error: String(error?.message || error) });
      return null;
    }
  }

  _requiresEmbeddedFlattenMetadata(metadata) {
    const embedded = metadata?.embeddedMetadata;
    return !!(embedded && typeof embedded === 'object' && (
      embedded.required === true
      || embedded.schema === FLATTEN_WEBP_METADATA_SCHEMA
      || Number(embedded.version) === FLATTEN_WEBP_METADATA_VERSION
    ));
  }

  _resolveEmbeddedFlattenMetadataSources(tileDoc, metadata = null) {
    const sources = [];
    const seen = new Set();
    const push = (source, kind) => {
      const normalized = String(source || '').trim();
      if (!normalized) return;
      const key = this._normalizeUploadPathForComparison(normalized);
      if (seen.has(key)) return;
      seen.add(key);
      sources.push({ source: normalized, kind });
    };

    push(this._resolveTileTextureSourceForFlattenMetadata(tileDoc), 'tile-texture');

    if (metadata && this._requiresEmbeddedFlattenMetadata(metadata)) {
      push(metadata?.embeddedMetadata?.primaryFilePath, 'metadata-primary');
      push(metadata?.filePath, 'metadata-file');
      push(metadata?.chunks?.[0]?.src, 'metadata-first-chunk');
      if (!sources.length) {
        throw new Error('Flatten metadata requires embedded WebP metadata but does not identify the generated WebP file.');
      }
      return sources;
    }

    if (!sources.length) {
      throw new Error('Selected tile does not contain FA Nexus flatten data or a readable WebP texture source.');
    }
    return sources;
  }

  async _readEmbeddedFlattenMetadata(tileDoc, metadata = null) {
    const sources = this._resolveEmbeddedFlattenMetadataSources(tileDoc, metadata);
    let lastError = null;

    for (const entry of sources) {
      const source = entry?.source || '';
      const url = encodeTexturePath(source);
      try {
        const envelope = await readFlattenMetadataFromWebPUrl(url);
        return this._deepClone(envelope.flattened);
      } catch (error) {
        lastError = error;
        Logger.warn('TileFlatten.embeddedMetadata.sourceReadFailed', {
          tileId: tileDoc?.id || null,
          source,
          sourceKind: entry?.kind || null,
          error: String(error?.message || error)
        });
      }
    }

    Logger.error('TileFlatten.embeddedMetadata.readFailed', {
      tileId: tileDoc?.id || null,
      sources: sources.map((entry) => ({
        source: entry?.source || '',
        kind: entry?.kind || null
      })),
      error: String(lastError?.message || lastError || 'No readable embedded metadata source')
    });
    throw new Error(`Cannot read embedded FA Nexus flatten metadata from generated WebP source: ${lastError?.message || lastError}`);
  }

  _resolveTileTextureSourceForFlattenMetadata(tileDoc) {
    return String(
      tileDoc?.texture?.src
      || tileDoc?._source?.texture?.src
      || tileDoc?.img
      || tileDoc?._source?.img
      || ''
    ).trim();
  }

  async _assertEmbeddedFlattenMetadataReadable(tileDoc, metadata) {
    const embedded = await this._readEmbeddedFlattenMetadata(tileDoc, metadata);
    const cachedCount = Number(metadata?.originalTileCount ?? metadata?.tiles?.length ?? 0) || 0;
    const embeddedCount = Number(embedded?.originalTileCount ?? embedded?.tiles?.length ?? 0) || 0;
    if (cachedCount > 0 && embeddedCount !== cachedCount) {
      Logger.error('TileFlatten.embeddedMetadata.countMismatch', {
        tileId: tileDoc?.id || null,
        cachedCount,
        embeddedCount
      });
      throw new Error(`Embedded flatten metadata tile count mismatch; expected ${cachedCount}, found ${embeddedCount}.`);
    }
    if (Number(embedded?.version) !== Number(metadata?.version)) {
      Logger.error('TileFlatten.embeddedMetadata.versionMismatch', {
        tileId: tileDoc?.id || null,
        cachedVersion: metadata?.version ?? null,
        embeddedVersion: embedded?.version ?? null
      });
      throw new Error(`Embedded flatten metadata version mismatch; expected ${metadata?.version ?? 'missing'}, found ${embedded?.version ?? 'missing'}.`);
    }
    return embedded;
  }

  async _resolveFlattenMetadataForDeconstruct(tileDoc) {
    const cached = this._resolveFlattenMetadata(tileDoc);
    if (cached) {
      if (this._requiresEmbeddedFlattenMetadata(cached)) {
        await this._assertEmbeddedFlattenMetadataReadable(tileDoc, cached);
      }
      return cached;
    }

    const embedded = await this._readEmbeddedFlattenMetadata(tileDoc, null);
    if (tileDoc && typeof tileDoc.setFlag === 'function') {
      try {
        await tileDoc.setFlag(MODULE_ID, 'flattened', embedded);
        Logger.info('TileFlatten.embeddedMetadata.cacheHydrated', {
          tileId: tileDoc?.id || null,
          originalTileCount: embedded?.originalTileCount ?? embedded?.tiles?.length ?? null
        });
      } catch (error) {
        Logger.error('TileFlatten.embeddedMetadata.cacheWriteFailed', {
          tileId: tileDoc?.id || null,
          error: String(error?.message || error)
        });
        throw new Error(`Embedded flatten metadata was readable, but the runtime cache could not be written: ${error?.message || error}`);
      }
    } else {
      Logger.warn('TileFlatten.embeddedMetadata.cacheUnavailable', {
        tileId: tileDoc?.id || null
      });
    }
    return embedded;
  }

  _resolveFlattenMetadataChunkForTile(tileDoc, metadata) {
    const chunks = Array.isArray(metadata?.chunks) ? metadata.chunks : [];
    if (!chunks.length) return null;
    const source = this._resolveTileTextureSourceForFlattenMetadata(tileDoc);
    if (!source) return null;
    const sourceKey = this._normalizeUploadPathForComparison(source);
    if (!sourceKey) return null;
    const sourceKeyLower = sourceKey.toLowerCase();

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const chunkSrc = String(chunk?.src || '').trim();
      if (!chunkSrc) continue;
      const chunkKey = this._normalizeUploadPathForComparison(chunkSrc);
      if (!chunkKey) continue;
      if (
        chunkKey === sourceKey
        || chunkKey.toLowerCase() === sourceKeyLower
        || this._storageObjectKeysMatch(chunkSrc, source)
      ) {
        return { chunk, index };
      }
    }
    return null;
  }

  _dimensionsMatch(width, height, expectedWidth, expectedHeight, epsilon = 1) {
    const w = Number(width);
    const h = Number(height);
    const ew = Number(expectedWidth);
    const eh = Number(expectedHeight);
    if (![w, h, ew, eh].every(Number.isFinite)) return false;
    return Math.abs(w - ew) <= epsilon && Math.abs(h - eh) <= epsilon;
  }

  _resolveImportedFlattenChunkAnchor(tileDoc, metadata, actual = null, fullExpected = null) {
    const match = this._resolveFlattenMetadataChunkForTile(tileDoc, metadata);
    if (!match) return null;

    const transform = actual || getTileTransformSnapshot(tileDoc);
    if (fullExpected && this._dimensionsMatch(transform.width, transform.height, fullExpected.width, fullExpected.height)) {
      return null;
    }

    const chunk = match.chunk;
    const worldMatch = this._dimensionsMatch(transform.width, transform.height, chunk?.width, chunk?.height);
    const pixelMatch = this._dimensionsMatch(transform.width, transform.height, chunk?.pixelWidth, chunk?.pixelHeight);
    if (!worldMatch && !pixelMatch) return null;

    return {
      ...match,
      dimensionMode: worldMatch ? 'world' : 'pixel'
    };
  }

  _buildExpectedImportedFlattenChunkTransform(tileDoc, metadata, actual = null, fullExpected = null) {
    const anchor = this._resolveImportedFlattenChunkAnchor(tileDoc, metadata, actual, fullExpected);
    if (!anchor) return null;
    const transform = actual || getTileTransformSnapshot(tileDoc);
    if (anchor.dimensionMode === 'pixel') {
      Logger.warn('TileFlatten.deconstruct.importedChunkPixelAnchor', {
        tileId: tileDoc?.id || null,
        chunkIndex: anchor.index,
        actualWidth: transform.width,
        actualHeight: transform.height,
        chunkWidth: Number(anchor.chunk?.width) || 0,
        chunkHeight: Number(anchor.chunk?.height) || 0,
        chunkPixelWidth: Number(anchor.chunk?.pixelWidth) || 0,
        chunkPixelHeight: Number(anchor.chunk?.pixelHeight) || 0
      });
    }
    return {
      ...transform,
      rotation: 0
    };
  }

  _resolveExpectedFlattenedWrapperTransform(tileDoc, metadata) {
    const actual = getTileTransformSnapshot(tileDoc);

    if (metadata?.wrapperTransform && (typeof metadata.wrapperTransform === 'object')) {
      const expected = getTileTransformSnapshot(metadata.wrapperTransform);
      const chunkExpected = this._buildExpectedImportedFlattenChunkTransform(tileDoc, metadata, actual, expected);
      return chunkExpected || expected;
    }

    if (this._isLegacyFlattenedTileMetadata(tileDoc, metadata)) {
      const fallbackBounds = metadata?.renderBounds || metadata?.logicalBounds || null;
      const width = Number(fallbackBounds?.width ?? tileDoc?.width);
      const height = Number(fallbackBounds?.height ?? tileDoc?.height);
      const expected = {
        x: Number(tileDoc?.x) || 0,
        y: Number(tileDoc?.y) || 0,
        width: Number.isFinite(width) ? width : 0,
        height: Number.isFinite(height) ? height : 0,
        rotation: 0,
        anchorX: 0,
        anchorY: 0,
        scaleX: 1,
        scaleY: 1,
        topLeftX: Number(tileDoc?.x) || 0,
        topLeftY: Number(tileDoc?.y) || 0
      };
      const chunkExpected = this._buildExpectedImportedFlattenChunkTransform(tileDoc, metadata, actual, expected);
      return chunkExpected || expected;
    }

    const fallbackBounds = metadata?.renderBounds || metadata?.logicalBounds || null;
    const fallbackTransform = buildFlattenedWrapperTransform(fallbackBounds);
    if (fallbackTransform) {
      const chunkExpected = this._buildExpectedImportedFlattenChunkTransform(tileDoc, metadata, actual, fallbackTransform);
      return chunkExpected || fallbackTransform;
    }

    return null;
  }

  _validateFlattenedTileRestoreTransform(tileDoc, metadata) {
    const expected = this._resolveExpectedFlattenedWrapperTransform(tileDoc, metadata);
    if (!expected) return { ok: true };

    const actual = getTileTransformSnapshot(tileDoc);
    const mismatches = [];
    if (!tileTransformsMatchValue(actual.rotation, expected.rotation)) mismatches.push('rotation');
    if (!tileTransformsMatchValue(actual.width, expected.width)) mismatches.push('width');
    if (!tileTransformsMatchValue(actual.height, expected.height)) mismatches.push('height');
    if (!tileTransformsMatchValue(actual.anchorX, expected.anchorX)) mismatches.push('anchorX');
    if (!tileTransformsMatchValue(actual.anchorY, expected.anchorY)) mismatches.push('anchorY');
    if (!tileTransformsMatchValue(actual.scaleX, expected.scaleX)) mismatches.push('scaleX');
    if (!tileTransformsMatchValue(actual.scaleY, expected.scaleY)) mismatches.push('scaleY');
    if (!mismatches.length) return { ok: true };

    Logger.error('TileFlatten.deconstruct.unsafeWrapperTransform', {
      tileId: tileDoc?.id || null,
      mismatches,
      expected,
      actual
    });

    return {
      ok: false,
      message: `Cannot deconstruct this flattened tile after its wrapper transform changed (${mismatches.join(', ')}). Reset the wrapper size, rotation, anchor, and scale before trying again.`
    };
  }

  _resolveFlattenOffset(tileDoc, metadata) {
    const originX = Number(metadata?.wrapperTransform?.topLeftX ?? metadata?.originalPosition?.x ?? metadata?.renderBounds?.x ?? metadata?.logicalBounds?.x);
    const originY = Number(metadata?.wrapperTransform?.topLeftY ?? metadata?.originalPosition?.y ?? metadata?.renderBounds?.y ?? metadata?.logicalBounds?.y);
    if (!Number.isFinite(originX) || !Number.isFinite(originY)) return { x: 0, y: 0 };
    const current = getTileRenderedTopLeft(tileDoc);
    if (Number(tileDoc?.rotation) || 0) {
      Logger.warn('TileFlatten.deconstruct.rotatedFlattenedTileOffset', {
        tileId: tileDoc?.id || null,
        rotation: Number(tileDoc?.rotation) || 0,
        anchorX: Number(tileDoc?.texture?.anchorX),
        anchorY: Number(tileDoc?.texture?.anchorY),
        width: Number(tileDoc?.width) || 0,
        height: Number(tileDoc?.height) || 0
      });
    }
    const importedChunk = this._resolveImportedFlattenChunkAnchor(tileDoc, metadata, getTileTransformSnapshot(tileDoc), {
      width: Number(metadata?.wrapperTransform?.width ?? metadata?.renderBounds?.width ?? metadata?.logicalBounds?.width),
      height: Number(metadata?.wrapperTransform?.height ?? metadata?.renderBounds?.height ?? metadata?.logicalBounds?.height)
    });
    const chunkOffsetX = importedChunk ? (Number(importedChunk.chunk?.x) || 0) : 0;
    const chunkOffsetY = importedChunk ? (Number(importedChunk.chunk?.y) || 0) : 0;
    if (importedChunk) {
      Logger.warn('TileFlatten.deconstruct.importedChunkAnchor', {
        tileId: tileDoc?.id || null,
        chunkIndex: importedChunk.index,
        dimensionMode: importedChunk.dimensionMode,
        chunkOffsetX,
        chunkOffsetY
      });
    }
    const offset = {
      x: current.x - (originX + chunkOffsetX),
      y: current.y - (originY + chunkOffsetY)
    };
    if (this._isLegacyFlattenedTileMetadata(tileDoc, metadata)) {
      const gridSize = Number(metadata?.gridSize ?? canvas?.scene?.grid?.size);
      const driftThreshold = Number.isFinite(gridSize) && gridSize > 0 ? (gridSize / 2) : 50;
      const ignoreLegacyOffset = Math.abs(offset.x) <= driftThreshold && Math.abs(offset.y) <= driftThreshold;
      if (ignoreLegacyOffset && (offset.x || offset.y)) {
        Logger.warn('TileFlatten.deconstruct.legacyFlattenOffsetIgnored', {
          tileId: tileDoc?.id || null,
          offsetX: offset.x,
          offsetY: offset.y,
          driftThreshold
        });
        return { x: 0, y: 0 };
      }
    }
    return offset;
  }

  _isLegacyFlattenedTileMetadata(tileDoc, metadata) {
    if (metadata?.tilePositionMode === 'anchor') return false;
    if (metadata?.tilePositionMode === 'v13-top-left') return true;
    const rotation = Number(tileDoc?.rotation);
    const anchor = getTileTextureAnchor(tileDoc?.texture);
    return (Number.isFinite(rotation) ? rotation : 0) === 0
      && anchor.x === 0
      && anchor.y === 0;
  }

  _shouldForceLegacyFlattenTilePositionMigration(tileDoc, metadata) {
    const isLegacyFlattenedTile = this._isLegacyFlattenedTileMetadata(tileDoc, metadata);
    if (isLegacyFlattenedTile) {
      const anchor = getTileTextureAnchor(tileDoc?.texture);
      const rotation = Number(tileDoc?.rotation);
      Logger.warn('TileFlatten.deconstruct.legacyTilePositionMigrationDetected', {
        tileId: tileDoc?.id || null,
        tilePositionMode: metadata?.tilePositionMode || null,
        anchorX: anchor.x,
        anchorY: anchor.y,
        rotation: Number.isFinite(rotation) ? rotation : 0
      });
    }
    return isLegacyFlattenedTile;
  }

  _hasRestorableFlattenMetadata(metadata) {
    return !!(metadata && typeof metadata === 'object' && Array.isArray(metadata.tiles) && metadata.tiles.length);
  }

  _cloneFlattenMetadataEntry(entry) {
    const data = this._deepClone(entry?.data);
    if (!data || typeof data !== 'object') return null;
    if (!data.flags || typeof data.flags !== 'object') data.flags = {};

    const storedFaFlags = entry?.faFlags && typeof entry.faFlags === 'object'
      ? this._deepClone(entry.faFlags)
      : null;
    const fallbackFaFlags = data.flags[MODULE_ID] && typeof data.flags[MODULE_ID] === 'object'
      ? this._deepClone(data.flags[MODULE_ID])
      : null;
    const hasStoredFaFlags = storedFaFlags && Object.keys(storedFaFlags).length > 0;
    const faFlags = hasStoredFaFlags ? storedFaFlags : (fallbackFaFlags || storedFaFlags);
    if (faFlags && typeof faFlags === 'object') {
      data.flags[MODULE_ID] = faFlags;
    }

    return {
      id: entry?.id || data?._id || data?.id || null,
      data
    };
  }

  _applyFlattenOffsetToTileData(data, offset = null) {
    if (!data || typeof data !== 'object') return;
    const offsetX = Number.isFinite(offset?.x) ? Number(offset.x) : 0;
    const offsetY = Number.isFinite(offset?.y) ? Number(offset.y) : 0;
    if (!offsetX && !offsetY) return;
    data.x = (Number(data.x) || 0) + offsetX;
    data.y = (Number(data.y) || 0) + offsetY;
  }

  _prepareDeconstructionPayload(metadata, offset = null, { forceLegacyTilePositionMigration = false } = {}) {
    const entries = Array.isArray(metadata?.tiles) ? metadata.tiles : [];
    const payloads = [];
    const restoredEntries = [];
    let preservedNestedFlattened = 0;
    let migratedLegacyPositions = 0;
    const offsetX = Number.isFinite(offset?.x) ? Number(offset.x) : 0;
    const offsetY = Number.isFinite(offset?.y) ? Number(offset.y) : 0;
    for (const entry of entries) {
      try {
        const cloned = this._cloneFlattenMetadataEntry(entry);
        if (!cloned) continue;
        const data = cloned.data;
        this._applyFlattenOffsetToTileData(data, offset);
        delete data._id;
        delete data._stats;
        const faFlags = data.flags?.[MODULE_ID];
        if (faFlags && Object.prototype.hasOwnProperty.call(faFlags, 'flattened')) {
          const flattenedMeta = faFlags.flattened;
          if (this._hasRestorableFlattenMetadata(flattenedMeta)) {
            preservedNestedFlattened += 1;
          } else {
            if (flattenedMeta && typeof flattenedMeta === 'object') {
              Logger.warn('TileFlatten.deconstruct.invalidNestedFlattenedFlag', {
                tileId: cloned.id || data?.id || null,
                originalTileCount: flattenedMeta?.originalTileCount ?? null,
                hasTiles: Array.isArray(flattenedMeta?.tiles),
                tileCount: Array.isArray(flattenedMeta?.tiles) ? flattenedMeta.tiles.length : null
              });
            }
            delete faFlags.flattened;
          }
        }
        if (migrateLegacyTilePositionForV14(data, { force: forceLegacyTilePositionMigration })) {
          migratedLegacyPositions += 1;
        }
        const building = data.flags?.[MODULE_ID]?.building;
        payloads.push(normalizeTileCreatePayloadForV14(data, { levelPolicy: LEVEL_POLICY_PRESERVE }));
        restoredEntries.push({
          id: cloned.id || null,
          wallGroupId: building?.meta?.wallGroupId || building?.wall?.wallGroupId || null
        });
      } catch (error) {
        Logger.debug?.('TileFlatten.deconstruct.prepare.failed', { error: String(error?.message || error) });
      }
    }
    Logger.debug?.('TileFlatten.deconstruct.prepare.complete', {
      entries: entries.length,
      payloads: payloads.length,
      preservedNestedFlattened,
      migratedLegacyPositions,
      forceLegacyTilePositionMigration,
      offsetX,
      offsetY
    });
    return { payloads, restoredEntries, preservedNestedFlattened };
  }

  _readRestoredTileFaFlag(doc, key) {
    try {
      const direct = doc?.getFlag?.(MODULE_ID, key);
      if (direct !== undefined) return direct;
    } catch (_) {}
    try {
      const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
      if (flags && Object.prototype.hasOwnProperty.call(flags, key)) return flags[key];
    } catch (_) {}
    return undefined;
  }

  async _hydrateRestoredCustomTileRenderers(createdDocs = [], { stage = 'unknown', failOnError = true } = {}) {
    const docs = Array.isArray(createdDocs) ? createdDocs.filter(Boolean) : [];
    const targets = [];
    for (const doc of docs) {
      const hasMaskedTiling = !!this._readRestoredTileFaFlag(doc, 'maskedTiling');
      const hasStandardTileMask = !!this._readRestoredTileFaFlag(doc, 'standardTileMask');
      if (!hasMaskedTiling && !hasStandardTileMask) continue;
      if (hasMaskedTiling && hasStandardTileMask) {
        Logger.error('TileFlatten.deconstruct.rendererHydrate.conflictingMaskFlags', {
          stage,
          tileId: doc?.id || doc?._id || null
        });
      }
      targets.push({
        doc,
        hasMaskedTiling,
        hasStandardTileMask
      });
    }

    if (!targets.length) {
      return { targetCount: 0, failures: [] };
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
    const refresh = (reason) => {
      try {
        const layer = canvas?.tiles;
        if (!canvas?.ready || !layer) {
          Logger.error('TileFlatten.deconstruct.rendererHydrate.refreshUnavailable', {
            reason,
            canvasReady: !!canvas?.ready,
            hasTileLayer: !!layer
          });
          return;
        }
        if (typeof layer.setAllRenderFlags === 'function') layer.setAllRenderFlags({ refreshState: true });
        else {
          for (const tile of collectTilePlaceables({ layer, includeDestroyed: false })) {
            try { tile?.renderFlags?.set?.({ refreshState: true }); } catch (_) {}
          }
        }
      } catch (error) {
        Logger.error('TileFlatten.deconstruct.rendererHydrate.refreshFailed', {
          reason,
          error: String(error?.message || error)
        });
      }
    };
    const isReady = (tile, target) => {
      const mesh = tile?.mesh;
      if (!tile || tile.destroyed || !mesh || mesh.destroyed) return false;
      const masked = mesh.faNexusMaskContainer || tile.faNexusMaskContainer;
      const standard = mesh.faNexusStandardMaskContainer || tile.faNexusStandardMaskContainer;
      return (!target.hasMaskedTiling || (!!masked && !masked.destroyed && !!mesh.faNexusMaskReady))
        && (!target.hasStandardTileMask || (!!standard && !standard.destroyed && !!mesh.faNexusStandardMaskReady));
    };
    const waitForPlaceable = async (doc) => {
      const tileId = doc?.id || doc?._id || null;
      for (let attempt = 1; attempt <= RESTORED_RENDERER_PLACEABLE_ATTEMPTS; attempt += 1) {
        const tile = resolveTilePlaceableForDocument(doc, { includeDestroyed: false });
        if (tile && !tile.destroyed) return tile;
        if (attempt === 1 || attempt === RESTORED_RENDERER_PLACEABLE_ATTEMPTS || attempt % 5 === 0) {
          Logger.debug?.('TileFlatten.deconstruct.rendererHydrate.waitPlaceable', {
            stage,
            tileId,
            attempt,
            attempts: RESTORED_RENDERER_PLACEABLE_ATTEMPTS,
            placeables: Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables.length : 0
          });
        }
        refresh(`wait-placeable:${stage}:${attempt}`);
        await this._nextFrame();
        await sleep(RESTORED_RENDERER_PLACEABLE_DELAY_MS);
      }
      return null;
    };

    Logger.debug?.('TileFlatten.deconstruct.rendererHydrate.start', {
      stage,
      targetCount: targets.length,
      tileIds: targets.map((target) => target.doc?.id || target.doc?._id).filter(Boolean)
    });
    await this._nextFrame();
    refresh(`start:${stage}`);

    const failures = [];
    for (const target of targets) {
      const tileId = target.doc?.id || target.doc?._id || null;
      const tile = await waitForPlaceable(target.doc);
      if (!tile) {
        failures.push({ tileId, error: 'Restored tile placeable was unavailable.' });
        continue;
      }

      const attemptErrors = [];
      for (let attempt = 1; attempt <= RESTORED_RENDERER_HYDRATION_ATTEMPTS; attempt += 1) {
        refresh(`hydrate:${stage}:${attempt}`);
        try {
          if (target.hasMaskedTiling) await Promise.resolve(applyMaskedTilingToTile(tile));
          if (target.hasStandardTileMask) await Promise.resolve(applyStandardTileMaskToTile(tile));
        } catch (error) {
          attemptErrors.push({
            attempt,
            error: String(error?.message || error)
          });
        }
        await this._nextFrame();
        if (isReady(tile, target)) break;
        if (attempt < RESTORED_RENDERER_HYDRATION_ATTEMPTS) await sleep(RESTORED_RENDERER_HYDRATION_DELAY_MS);
      }

      if (isReady(tile, target)) {
        Logger.debug?.('TileFlatten.deconstruct.rendererHydrate.tileReady', {
          stage,
          tileId,
          maskedTiling: !!target.hasMaskedTiling,
          standardTileMask: !!target.hasStandardTileMask
        });
        continue;
      }

      const mesh = tile?.mesh;
      failures.push({
        tileId,
        maskedTiling: !!target.hasMaskedTiling,
        standardTileMask: !!target.hasStandardTileMask,
        attemptErrors,
        hasMesh: !!mesh,
        maskedReady: !!mesh?.faNexusMaskReady,
        standardMaskReady: !!mesh?.faNexusStandardMaskReady,
        hasMaskedContainer: !!(mesh?.faNexusMaskContainer || tile?.faNexusMaskContainer),
        hasStandardMaskContainer: !!(mesh?.faNexusStandardMaskContainer || tile?.faNexusStandardMaskContainer)
      });
    }

    if (failures.length) {
      Logger.error('TileFlatten.deconstruct.rendererHydrate.failed', {
        stage,
        targetCount: targets.length,
        failures
      });
      if (failOnError) {
        throw new Error(`Restored masked tile renderer hydration failed for ${failures.length} tile(s).`);
      }
    } else {
      Logger.debug?.('TileFlatten.deconstruct.rendererHydrate.complete', {
        stage,
        targetCount: targets.length
      });
    }

    return {
      targetCount: targets.length,
      failures
    };
  }

  _buildRestoredTileIdMap(metadata, createdDocs = [], restoredEntries = null) {
    const entries = Array.isArray(restoredEntries) ? restoredEntries : (Array.isArray(metadata?.tiles) ? metadata.tiles : []);
    const restored = Array.isArray(createdDocs) ? createdDocs : [];
    const map = new Map();
    const count = Math.min(entries.length, restored.length);
    for (let i = 0; i < count; i += 1) {
      const oldId = entries[i]?.id || null;
      const newId = restored[i]?.id || null;
      if (!oldId || !newId || oldId === newId) continue;
      map.set(oldId, newId);
    }
    if (entries.length !== restored.length) {
      Logger.warn('TileFlatten.deconstruct.restoreCountMismatch', {
        metadataTiles: entries.length,
        restoredTiles: restored.length
      });
    }
    return map;
  }

  _getEmbeddedDocumentUpdateValue(doc, path) {
    if (!doc || !path) return undefined;
    const source = doc?._source && (typeof doc._source === 'object')
      ? doc._source
      : (typeof doc?.toObject === 'function' ? doc.toObject() : doc);
    try {
      if (foundry?.utils?.getProperty) return foundry.utils.getProperty(source, path);
    } catch (_) {}

    let current = source;
    for (const key of String(path).split('.')) {
      if (current == null) return undefined;
      current = current[key];
    }
    return current;
  }

  _queueEmbeddedUpdate(updateMap, docId, changes = null) {
    if (!(updateMap instanceof Map) || !docId || !changes || typeof changes !== 'object') return;
    const entries = Object.entries(changes).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const payload = updateMap.get(docId) || { _id: docId };
    for (const [key, value] of entries) payload[key] = value;
    updateMap.set(docId, payload);
  }

  _planEmbeddedUpdate(updateMap, rollbackMap, doc, changes = null) {
    const docId = doc?.id || doc?._id || null;
    if (!(updateMap instanceof Map) || !(rollbackMap instanceof Map) || !docId || !changes || typeof changes !== 'object') return 0;

    let changed = 0;
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      const previousValue = this._getEmbeddedDocumentUpdateValue(doc, key);
      if (Object.is(previousValue, value)) continue;

      this._queueEmbeddedUpdate(updateMap, docId, { [key]: value });
      if (previousValue !== undefined) {
        this._queueEmbeddedUpdate(rollbackMap, docId, { [key]: this._deepClone(previousValue) });
      }
      changed += 1;
    }

    return changed;
  }

  async _applyEmbeddedUpdates(documentName, updateMap, chunkSize = 50) {
    if (!canvas?.scene || !(updateMap instanceof Map) || !updateMap.size) return 0;
    const updates = [...updateMap.values()];
    for (let i = 0; i < updates.length; i += chunkSize) {
      const chunk = updates.slice(i, i + chunkSize);
      await canvas.scene.updateEmbeddedDocuments(documentName, chunk);
    }
    return updates.length;
  }

  _buildRestoredTileReferenceRelinkPlan(metadata, createdDocs = [], restoredEntries = null) {
    const restoredIdMap = this._buildRestoredTileIdMap(metadata, createdDocs, restoredEntries);
    const plan = {
      restoredIdMap,
      createdDocs: Array.isArray(createdDocs) ? createdDocs.slice() : [],
      restoredEntries: Array.isArray(restoredEntries) ? restoredEntries.slice() : [],
      tileUpdates: new Map(),
      wallUpdates: new Map(),
      rollbackTileUpdates: new Map(),
      rollbackWallUpdates: new Map(),
      unresolvedBuildingWalls: [],
      tileFieldUpdates: 0,
      wallFieldUpdates: 0
    };
    if (!canvas?.scene || !Array.isArray(createdDocs) || !createdDocs.length || !restoredIdMap.size) return plan;

    const sceneTiles = Array.from(canvas.scene.tiles || []);
    const sceneWalls = Array.from(canvas.scene.walls || []);
    const buildingGroupToTileId = new Map();

    const restoredEntriesList = Array.isArray(restoredEntries) ? restoredEntries : [];
    const restoredCount = Math.min(restoredEntriesList.length, createdDocs.length);
    for (let i = 0; i < restoredCount; i += 1) {
      const wallGroupId = restoredEntriesList[i]?.wallGroupId || null;
      const tileId = createdDocs[i]?.id || null;
      if (!wallGroupId || !tileId) continue;
      buildingGroupToTileId.set(wallGroupId, tileId);
    }

    for (const tileDoc of sceneTiles) {
      if (!tileDoc?.id) continue;
      const building = tileDoc.getFlag?.('fa-nexus', 'building');
      const wallGroupId = building?.meta?.wallGroupId || null;
      if (wallGroupId) buildingGroupToTileId.set(wallGroupId, tileDoc.id);
    }

    const linkedTileFlagKeys = [
      'buildingDoorFrame',
      'buildingWindowSill',
      'buildingWindowWindow',
      'buildingWindowFrame'
    ];

    for (const tileDoc of sceneTiles) {
      if (!tileDoc?.id) continue;

      const building = tileDoc.getFlag?.('fa-nexus', 'building');
      if (building) {
        const meta = building?.meta || {};
        const nextFillTileId = meta?.fillTileId ? restoredIdMap.get(meta.fillTileId) : null;
        const nextSillTileId = meta?.sillTileId ? restoredIdMap.get(meta.sillTileId) : null;
        const nextParentWallTileId = (
          (meta?.parentWallTileId ? restoredIdMap.get(meta.parentWallTileId) : null)
          || (meta?.parentWallGroupId ? buildingGroupToTileId.get(meta.parentWallGroupId) : null)
        );
        plan.tileFieldUpdates += this._planEmbeddedUpdate(plan.tileUpdates, plan.rollbackTileUpdates, tileDoc, {
          'flags.fa-nexus.building.meta.fillTileId': nextFillTileId && nextFillTileId !== meta.fillTileId
            ? nextFillTileId
            : undefined,
          'flags.fa-nexus.building.meta.sillTileId': nextSillTileId && nextSillTileId !== meta.sillTileId
            ? nextSillTileId
            : undefined,
          'flags.fa-nexus.building.meta.composite.sillTileId': nextSillTileId && nextSillTileId !== meta?.composite?.sillTileId
            ? nextSillTileId
            : undefined,
          'flags.fa-nexus.building.meta.parentWallTileId': nextParentWallTileId && nextParentWallTileId !== meta.parentWallTileId
            ? nextParentWallTileId
            : undefined
        });
      }

      const composite = tileDoc.getFlag?.('fa-nexus', 'buildingComposite');
      if (composite) {
        const nextWallTileId = composite?.wallTileId ? restoredIdMap.get(composite.wallTileId) : null;
        const nextBackgroundTileId = composite?.backgroundTileId ? restoredIdMap.get(composite.backgroundTileId) : null;
        const nextSillTileId = composite?.sillTileId ? restoredIdMap.get(composite.sillTileId) : null;
        plan.tileFieldUpdates += this._planEmbeddedUpdate(plan.tileUpdates, plan.rollbackTileUpdates, tileDoc, {
          'flags.fa-nexus.buildingComposite.wallTileId': nextWallTileId && nextWallTileId !== composite.wallTileId
            ? nextWallTileId
            : undefined,
          'flags.fa-nexus.buildingComposite.backgroundTileId': nextBackgroundTileId && nextBackgroundTileId !== composite.backgroundTileId
            ? nextBackgroundTileId
            : undefined,
          'flags.fa-nexus.buildingComposite.sillTileId': nextSillTileId && nextSillTileId !== composite.sillTileId
            ? nextSillTileId
            : undefined
        });
      }

      for (const flagKey of linkedTileFlagKeys) {
        const linked = tileDoc.getFlag?.('fa-nexus', flagKey);
        if (!linked) continue;
        const nextWallTileId = (
          (linked?.wallTileId ? restoredIdMap.get(linked.wallTileId) : null)
          || (linked?.wallGroupId ? buildingGroupToTileId.get(linked.wallGroupId) : null)
        );
        if (!nextWallTileId || nextWallTileId === linked?.wallTileId) continue;
        plan.tileFieldUpdates += this._planEmbeddedUpdate(plan.tileUpdates, plan.rollbackTileUpdates, tileDoc, {
          [`flags.fa-nexus.${flagKey}.wallTileId`]: nextWallTileId
        });
      }
    }

    for (const wallDoc of sceneWalls) {
      if (!wallDoc?.id) continue;

      const buildingWall = wallDoc.getFlag?.('fa-nexus', 'buildingWall');
      if (buildingWall) {
        const nextTileId = (
          (buildingWall?.tileId ? restoredIdMap.get(buildingWall.tileId) : null)
          || (buildingWall?.groupId ? buildingGroupToTileId.get(buildingWall.groupId) : null)
        );
        if (nextTileId && nextTileId !== buildingWall?.tileId) {
          plan.wallFieldUpdates += this._planEmbeddedUpdate(plan.wallUpdates, plan.rollbackWallUpdates, wallDoc, {
            'flags.fa-nexus.buildingWall.tileId': nextTileId,
            'flags.fa-nexus.buildingWall.updatedAt': Date.now()
          });
        } else if (!nextTileId && (buildingWall?.tileId || buildingWall?.groupId)) {
          plan.unresolvedBuildingWalls.push({
            wallId: wallDoc.id,
            tileId: buildingWall?.tileId || null,
            groupId: buildingWall?.groupId || null
          });
        }
      }

      const pathWall = wallDoc.getFlag?.('fa-nexus', 'pathWall');
      const nextPathTileId = pathWall?.tileId ? restoredIdMap.get(pathWall.tileId) : null;
      if (nextPathTileId && nextPathTileId !== pathWall?.tileId) {
        plan.wallFieldUpdates += this._planEmbeddedUpdate(plan.wallUpdates, plan.rollbackWallUpdates, wallDoc, {
          'flags.fa-nexus.pathWall.tileId': nextPathTileId,
          'flags.fa-nexus.pathWall.updatedAt': Date.now()
        });
      }
    }

    Logger.debug?.('TileFlatten.deconstruct.relink.plan', {
      restoredTiles: createdDocs.length,
      remappedTileIds: restoredIdMap.size,
      tileDocuments: plan.tileUpdates.size,
      wallDocuments: plan.wallUpdates.size,
      tileFieldUpdates: plan.tileFieldUpdates,
      wallFieldUpdates: plan.wallFieldUpdates
    });

    return plan;
  }

  async _applyRestoredTileReferenceRelinkPlan(plan = null) {
    if (!plan?.restoredIdMap?.size) return { tileUpdateCount: 0, wallUpdateCount: 0 };

    const tileUpdateCount = await this._applyEmbeddedUpdates('Tile', plan.tileUpdates);
    const wallUpdateCount = await this._applyEmbeddedUpdates('Wall', plan.wallUpdates);

    if (plan.unresolvedBuildingWalls.length) {
      Logger.warn('TileFlatten.deconstruct.relinkMissingBuildingWalls', {
        restoredTiles: plan.createdDocs.length,
        remappedTileIds: plan.restoredIdMap.size,
        unresolvedBuildingWalls: plan.unresolvedBuildingWalls
      });
    }

    Logger.info('TileFlatten.deconstruct.relinked', {
      restoredTiles: plan.createdDocs.length,
      remappedTileIds: plan.restoredIdMap.size,
      tileUpdates: tileUpdateCount,
      wallUpdates: wallUpdateCount
    });

    return { tileUpdateCount, wallUpdateCount };
  }

  async _rollbackRestoredTileReferenceRelinkPlan(plan = null, { flattenedId = null, stage = 'unknown' } = {}) {
    const rollbackSummary = {
      attempted: false,
      ok: true,
      tileUpdates: 0,
      wallUpdates: 0
    };
    if (!plan) return rollbackSummary;

    const hasTileRollback = plan.rollbackTileUpdates instanceof Map && plan.rollbackTileUpdates.size > 0;
    const hasWallRollback = plan.rollbackWallUpdates instanceof Map && plan.rollbackWallUpdates.size > 0;
    if (!hasTileRollback && !hasWallRollback) return rollbackSummary;

    rollbackSummary.attempted = true;
    Logger.info('TileFlatten.deconstruct.rollback.relink.start', {
      flattenedId,
      stage,
      tileDocuments: plan.rollbackTileUpdates?.size || 0,
      wallDocuments: plan.rollbackWallUpdates?.size || 0
    });

    try {
      rollbackSummary.wallUpdates = await this._applyEmbeddedUpdates('Wall', plan.rollbackWallUpdates);
    } catch (error) {
      rollbackSummary.ok = false;
      rollbackSummary.wallError = String(error?.message || error);
      Logger.error('TileFlatten.deconstruct.rollback.relinkWalls.failed', {
        flattenedId,
        stage,
        error: rollbackSummary.wallError
      });
    }

    try {
      rollbackSummary.tileUpdates = await this._applyEmbeddedUpdates('Tile', plan.rollbackTileUpdates);
    } catch (error) {
      rollbackSummary.ok = false;
      rollbackSummary.tileError = String(error?.message || error);
      Logger.error('TileFlatten.deconstruct.rollback.relinkTiles.failed', {
        flattenedId,
        stage,
        error: rollbackSummary.tileError
      });
    }

    if (rollbackSummary.ok) {
      Logger.info('TileFlatten.deconstruct.rollback.relink.complete', {
        flattenedId,
        stage,
        tileUpdates: rollbackSummary.tileUpdates,
        wallUpdates: rollbackSummary.wallUpdates
      });
    }

    return rollbackSummary;
  }

  _sceneHasEmbeddedDocument(documentName, docId) {
    if (!canvas?.scene || !docId) return false;
    const collection = documentName === 'Wall'
      ? canvas.scene.walls
      : canvas.scene.tiles;
    try {
      return !!collection?.get?.(docId);
    } catch (_) {
      return false;
    }
  }

  async _recordDeconstructRollbackFailure(tileDoc, details = {}) {
    const liveDoc = canvas?.scene?.tiles?.get?.(tileDoc?.id) || tileDoc || null;
    if (!liveDoc?.id || !this._sceneHasEmbeddedDocument('Tile', liveDoc.id)) return false;

    try {
      const metadata = this._resolveFlattenMetadata(liveDoc);
      if (!metadata) return false;
      metadata.deconstructFailure = {
        failedAt: Date.now(),
        stage: String(details?.stage || 'unknown'),
        error: String(details?.error?.message || details?.error || ''),
        createdTileIds: Array.isArray(details?.createdTileIds) ? details.createdTileIds.filter(Boolean) : [],
        relinkRollbackOk: details?.relinkRollback?.ok !== false,
        deleteRollbackOk: details?.deleteRollback?.ok !== false
      };
      await liveDoc.setFlag?.(MODULE_ID, 'flattened', metadata);
      Logger.warn('TileFlatten.deconstruct.rollback.markerWritten', {
        tileId: liveDoc.id,
        stage: metadata.deconstructFailure.stage,
        createdTileIds: metadata.deconstructFailure.createdTileIds
      });
      return true;
    } catch (markerError) {
      Logger.error('TileFlatten.deconstruct.rollback.markerFailed', {
        tileId: liveDoc?.id || null,
        stage: String(details?.stage || 'unknown'),
        error: String(markerError?.message || markerError)
      });
      return false;
    }
  }

  async _rollbackDeconstructRestoreTransaction(tileDoc, transaction = null, error = null) {
    const createdDocs = Array.isArray(transaction?.createdDocs) ? transaction.createdDocs.filter(Boolean) : [];
    const createdTileIds = createdDocs.map((doc) => doc?.id).filter(Boolean);
    const flattenedId = transaction?.flattenedId || tileDoc?.id || null;
    const stage = String(transaction?.stage || 'unknown');
    const rollback = {
      attempted: false,
      ok: true,
      stage,
      flattenedId,
      createdCount: createdTileIds.length,
      createdTileIds,
      commitLikelyApplied: false,
      markerWritten: false,
      relinkRollback: {
        attempted: false,
        ok: true,
        tileUpdates: 0,
        wallUpdates: 0
      },
      deleteRollback: {
        attempted: false,
        ok: true,
        deletedCount: 0
      }
    };

    const wrapperStillPresent = this._sceneHasEmbeddedDocument('Tile', flattenedId);
    rollback.wrapperStillPresent = wrapperStillPresent;
    if (stage === 'commit' && !wrapperStillPresent) {
      rollback.commitLikelyApplied = true;
      Logger.warn('TileFlatten.deconstruct.rollback.skippedAfterWrapperDelete', {
        flattenedId,
        stage,
        createdCount: createdTileIds.length,
        error: String(error?.message || error)
      });
      return rollback;
    }

    if (!createdTileIds.length && !transaction?.relinkApplied) return rollback;

    rollback.attempted = true;
    Logger.info('TileFlatten.deconstruct.rollback.start', {
      flattenedId,
      stage,
      createdCount: createdTileIds.length,
      relinkApplied: !!transaction?.relinkApplied
    });

    if (transaction?.relinkApplied && transaction?.relinkPlan) {
      rollback.relinkRollback = await this._rollbackRestoredTileReferenceRelinkPlan(transaction.relinkPlan, {
        flattenedId,
        stage
      });
      if (!rollback.relinkRollback.ok) rollback.ok = false;
    }

    if (rollback.ok && createdTileIds.length) {
      try {
        await this._deleteSceneTilesByIds(createdTileIds, {
          preserveLinkedCleanup: true
        });
        rollback.deleteRollback = {
          attempted: true,
          ok: true,
          deletedCount: createdTileIds.length
        };
      } catch (deleteError) {
        rollback.ok = false;
        rollback.deleteRollback = {
          attempted: true,
          ok: false,
          deletedCount: 0,
          error: String(deleteError?.message || deleteError)
        };
        Logger.error('TileFlatten.deconstruct.rollback.deleteCreatedTiles.failed', {
          flattenedId,
          stage,
          createdTileIds,
          error: rollback.deleteRollback.error
        });
      }
    } else if (createdTileIds.length) {
      Logger.warn('TileFlatten.deconstruct.rollback.deleteCreatedTiles.skipped', {
        flattenedId,
        stage,
        createdTileIds
      });
    }

    if (!rollback.ok && this._sceneHasEmbeddedDocument('Tile', flattenedId)) {
      rollback.markerWritten = await this._recordDeconstructRollbackFailure(tileDoc, {
        stage,
        error,
        createdTileIds,
        relinkRollback: rollback.relinkRollback,
        deleteRollback: rollback.deleteRollback
      });
    }

    const rollbackLog = rollback.ok ? Logger.info.bind(Logger) : Logger.error.bind(Logger);
    rollbackLog(rollback.ok
      ? 'TileFlatten.deconstruct.rollback.complete'
      : 'TileFlatten.deconstruct.rollback.failed', {
        flattenedId,
        stage,
        createdCount: createdTileIds.length,
        relinkRollbackOk: rollback.relinkRollback.ok,
        deleteRollbackOk: rollback.deleteRollback.ok,
        markerWritten: rollback.markerWritten
      });

    return rollback;
  }

  _countDeconstructRestoreTiles(metadata) {
    return Number(metadata?.originalTileCount ?? metadata?.tiles?.length ?? 0) || 0;
  }

  async _confirmDeconstruct(tileDoc, metadata) {
    const tileCount = this._countDeconstructRestoreTiles(metadata);
    const message = tileCount
      ? `This will delete the flattened tile and restore ${tileCount} original tile${tileCount === 1 ? '' : 's'}. Continue?`
      : 'This will delete the flattened tile and restore the saved tiles. Continue?';

    try {
      const DialogV2 = foundry?.applications?.api?.DialogV2;
      if (DialogV2?.confirm) {
        const result = await DialogV2.confirm({
          window: {
            title: 'Deconstruct Flattened Tile'
          },
          modal: true,
          content: `<p>${message}</p>`,
          yes: {
            label: 'Deconstruct',
            icon: 'fas fa-object-ungroup'
          },
          no: {
            label: 'Cancel'
          },
          defaultYes: true
        });
        return !!result;
      }
      if (typeof Dialog?.confirm === 'function') {
        return Dialog.confirm({
          title: 'Deconstruct Flattened Tile',
          content: `<p>${message}</p>`,
          yes: () => true,
          no: () => false,
          defaultYes: true
        });
      }
    } catch (_) {}

    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      return window.confirm(message);
    }

    return true;
  }

  _extractFilenameFromPath(path) {
    const raw = String(path || '').trim();
    if (!raw) return '';
    let filenamePath = raw;
    try {
      const url = new URL(raw);
      filenamePath = url.pathname || raw;
    } catch (_) {}
    filenamePath = filenamePath.split(/[?#]/, 1)[0] || filenamePath;
    filenamePath = filenamePath.split('/').pop() || '';
    try {
      filenamePath = decodeURIComponent(filenamePath);
    } catch (_) {}
    return filenamePath;
  }

  _escapeHTML(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  _buildChunkOutputFilenames(baseName, pixelWidth, pixelHeight, options = {}) {
    const width = Number(pixelWidth);
    const height = Number(pixelHeight);
    const chunkPixelWidth = Number(options?.chunkPixelWidth);
    const chunkPixelHeight = Number(options?.chunkPixelHeight);
    const suffix = String(options?.suffix || '');
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return [];
    if (!Number.isFinite(chunkPixelWidth) || chunkPixelWidth <= 0) return [];
    if (!Number.isFinite(chunkPixelHeight) || chunkPixelHeight <= 0) return [];

    const columns = Math.max(1, Math.ceil(width / chunkPixelWidth));
    const rows = Math.max(1, Math.ceil(height / chunkPixelHeight));
    const filenames = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        filenames.push(this._buildOutputFilename(baseName, `${suffix}-r${row + 1}-c${col + 1}`));
      }
    }
    return filenames;
  }

  async _findExistingOutputFiles(uploadContext, filenames) {
    const wanted = new Map();
    for (const filename of Array.isArray(filenames) ? filenames : []) {
      const normalized = String(filename || '').trim();
      if (!normalized) continue;
      wanted.set(normalized.toLowerCase(), normalized);
    }
    if (!wanted.size) return [];

    const FP = uploadContext?.FP || foundry?.applications?.apps?.FilePicker?.implementation;
    if (!FP || typeof FP.browse !== 'function') {
      throw new Error('Foundry FilePicker browse runtime is unavailable; cannot check output collisions.');
    }

    const source = uploadContext?.source || 'data';
    const baseDir = uploadContext?.baseDir || '';
    const bucketOptions = uploadContext?.bucketOptions || {};
    let result = null;
    try {
      result = await FP.browse(source, baseDir, { ...bucketOptions });
    } catch (error) {
      if (this._isMissingOutputFolderBrowseError(error, source, baseDir)) {
        Logger.debug?.('TileFlatten.overwriteCheck.missingFolderClearFromError', {
          source,
          baseDir,
          error: String(error?.message || error)
        });
        return [];
      }
      throw error;
    }
    const existing = [];
    const seen = new Set();

    for (const filePath of result?.files || []) {
      const filename = this._extractFilenameFromPath(filePath);
      const key = filename.toLowerCase();
      if (!filename || !wanted.has(key) || seen.has(key)) continue;
      seen.add(key);
      existing.push({
        filename: wanted.get(key) || filename,
        path: String(filePath || '')
      });
    }

    existing.sort((a, b) => String(a.filename || '').localeCompare(String(b.filename || '')));
    return existing;
  }

  _isMissingOutputFolderBrowseError(error, source, target) {
    if (String(source || 'data').toLowerCase() !== 'data') return false;
    if (!String(target || '').trim()) return false;

    const message = String(error?.message || error || '');
    if (!message) return false;
    if (/permission|not permitted|not allowed|FILES_BROWSE/i.test(message)) return false;
    return /does not exist|not found|ENOENT|no such file or directory/i.test(message);
  }

  async _confirmOverwriteOutputs(uploadContext, filenames, options = {}) {
    const planned = Array.from(new Set(
      (Array.isArray(filenames) ? filenames : [])
        .map((filename) => String(filename || '').trim())
        .filter(Boolean)
    ));
    if (!planned.length) return true;

    let existing = [];
    try {
      existing = await this._findExistingOutputFiles(uploadContext, planned);
    } catch (error) {
      Logger.error('TileFlatten.overwriteCheck.failed', {
        error: String(error?.message || error),
        source: uploadContext?.source || 'data',
        baseDir: uploadContext?.baseDir || '',
        filenames: planned
      });
      ui?.notifications?.error?.('FA Nexus could not check the output folder for existing files. The operation was stopped to avoid overwriting files without confirmation.');
      return false;
    }
    if (!existing.length) return true;

    const previewCount = Math.min(existing.length, 8);
    const previewItems = existing
      .slice(0, previewCount)
      .map((entry) => `<li><code>${this._escapeHTML(entry.filename)}</code></li>`)
      .join('');
    const remainder = existing.length - previewCount;
    const subject = existing.length === 1 ? 'file already exists' : `${existing.length} files already exist`;
    const followup = remainder > 0
      ? `<p>And ${remainder} more file${remainder === 1 ? '' : 's'}.</p>`
      : '';
    const content = [
      `<p>The following ${subject} and will be overwritten:</p>`,
      `<ul>${previewItems}</ul>`,
      followup,
      '<p>Continue?</p>'
    ].join('');
    const title = String(options?.title || 'Overwrite Existing Files?').trim() || 'Overwrite Existing Files?';
    const actionLabel = String(options?.actionLabel || 'Overwrite').trim() || 'Overwrite';

    try {
      const DialogV2 = foundry?.applications?.api?.DialogV2;
      if (DialogV2?.confirm) {
        const result = await DialogV2.confirm({
          window: { title },
          modal: true,
          content,
          yes: {
            label: actionLabel,
            icon: 'fas fa-file-import'
          },
          no: {
            label: 'Cancel'
          },
          defaultYes: false
        });
        return !!result;
      }
      if (typeof Dialog?.confirm === 'function') {
        return Dialog.confirm({
          title,
          content,
          yes: () => true,
          no: () => false,
          defaultYes: false
        });
      }
    } catch (error) {
      Logger.warn('TileFlatten.overwriteConfirm.dialogFailed', { error: String(error?.message || error) });
    }

    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      const lines = existing.slice(0, previewCount).map((entry) => `- ${entry.filename}`);
      if (remainder > 0) lines.push(`- and ${remainder} more`);
      return window.confirm(`${title}\n\nThese files already exist and will be overwritten:\n${lines.join('\n')}\n\nContinue?`);
    }

    Logger.error('TileFlatten.overwriteConfirm.unavailable', { filenames: existing.map((entry) => entry.filename) });
    ui?.notifications?.error?.('FA Nexus could not open an overwrite confirmation dialog.');
    return false;
  }

  /**
   * Save canvas as WebP
   */
  _buildExportFilenameBase(options = {}) {
    return this._buildDefaultOutputBaseName({
      action: 'export',
      scope: this._normalizeExportScope(options?.scope),
      levelRange: options?.levelRange || null
    });
  }

  _buildFlattenFilenameBase(options = {}) {
    return this._buildDefaultOutputBaseName({
      action: 'flatten',
      scope: this._normalizeExportScope(options?.scope),
      levelRange: options?.levelRange || null
    });
  }

  _getDefaultOutputFolder(kind = 'flatten') {
    if (kind === 'export') return appendStoragePath(this._getAssetsDir(), 'exports');
    return buildGeneratedRoot('flattened', { assetsDir: this._getAssetsDir() });
  }

  _sanitizeOutputBaseName(value, fallbackBase) {
    const fallback = String(fallbackBase || '').trim() || 'flattened';
    let name = String(value ?? '').trim();
    if (!name) name = fallback;
    name = name.replace(/\.[^./\\]+$/, '');
    name = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-');
    name = name.replace(/\s+/g, '-').replace(/-+/g, '-').trim();
    name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');
    return name || fallback;
  }

  _buildOutputFilename(baseName, suffix = '') {
    const safeBase = this._sanitizeOutputBaseName(baseName, this._buildFlattenFilenameBase());
    const cleanSuffix = String(suffix || '').trim();
    return `${safeBase}${cleanSuffix}.webp`;
  }

  async _resolveFlattenUploadContext(folder = null) {
    await forgeIntegration.initialize();
    const requestedRoot = sanitizeStoragePathSegments(String(folder || '').trim()) || this._getDefaultOutputFolder('flatten');
    const generatedPath = resolveGeneratedSceneFolder('flattened', { root: requestedRoot });
    await this._registerGeneratedFlattenRoot(generatedPath.root);
    const dirContext = forgeIntegration.resolveFilePickerContext(generatedPath.folder);
    const source = dirContext?.source || 'data';
    const bucketOptions = dirContext?.options || {};
    const baseTarget = dirContext?.target || '';
    const baseDir = baseTarget;
    const FP = foundry.applications.apps.FilePicker.implementation;

    // Ensure nested directory structure exists
    await this._ensureNestedDir(baseDir, { source, options: bucketOptions });

    Logger.info('TileFlatten.uploadContext.flatten', {
      root: generatedPath.root,
      effectiveFolder: generatedPath.folder,
      source,
      target: baseDir,
      worldId: generatedPath.worldId,
      sceneId: generatedPath.sceneId
    });

    return {
      FP,
      source,
      bucketOptions,
      baseTarget,
      baseDir,
      assetsSetting: generatedPath.folder,
      requestedRoot: generatedPath.root,
      effectiveFolder: generatedPath.folder,
      worldId: generatedPath.worldId,
      sceneId: generatedPath.sceneId
    };
  }

  async _resolveExportUploadContext(folder = null) {
    const requested = sanitizeStoragePathSegments(String(folder || '').trim()) || this._getDefaultOutputFolder('export');
    await forgeIntegration.initialize();
    const dirContext = forgeIntegration.resolveFilePickerContext(requested);
    const source = dirContext?.source || 'data';
    const bucketOptions = dirContext?.options || {};
    const baseTarget = dirContext?.target || '';
    const baseDir = baseTarget;
    const FP = foundry.applications.apps.FilePicker.implementation;

    await this._ensureNestedDir(baseDir, { source, options: bucketOptions });
    Logger.info('TileFlatten.uploadContext.export', {
      root: requested,
      effectiveFolder: requested,
      source,
      target: baseDir
    });

    return {
      FP,
      source,
      bucketOptions,
      baseTarget,
      baseDir,
      assetsSetting: requested,
      requestedRoot: requested,
      effectiveFolder: requested,
      worldId: null,
      sceneId: null
    };
  }

  async _canvasToWebPBlob(canvasEl, quality) {
    if (!canvasEl) return null;
    return await new Promise((resolve) => {
      if (canvasEl.toBlob) {
        canvasEl.toBlob(resolve, 'image/webp', quality);
      } else {
        try {
          const dataUrl = canvasEl.toDataURL('image/webp', quality);
          const bin = atob(dataUrl.split(',')[1] || '');
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < arr.length; i++) arr[i] = bin.charCodeAt(i);
          resolve(new Blob([arr], { type: 'image/webp' }));
        } catch (err) {
          resolve(null);
        }
      }
    });
  }

  _normalizeWebPFilename(options = {}) {
    const baseName = this._sanitizeOutputBaseName(options.baseName, this._buildFlattenFilenameBase());
    let filename = String(options.filename || `${baseName}.webp`).trim();
    filename = filename.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-');
    if (!String(filename).toLowerCase().endsWith('.webp')) filename = `${filename}.webp`;
    return filename;
  }

  _resolveSavedWebPPath(uploadResult, uploadContext, filename) {
    const source = uploadContext?.source || 'data';
    const baseTarget = uploadContext?.baseTarget || '';
    const baseDir = uploadContext?.baseDir || '';
    const assetsSetting = uploadContext?.assetsSetting || this._getAssetsDir();
    let path = '';

    try {
      if (typeof uploadResult?.url === 'string') path = uploadResult.url;
      else if (typeof uploadResult?.path === 'string') path = uploadResult.path;
      else if (typeof uploadResult === 'string') path = uploadResult;
    } catch (_) {}
    if (!path) path = `${baseDir}/${filename}`;

    if (source === 's3' && !/^https?:\/\//i.test(path)) {
      const objectKey = this._resolveS3UploadedObjectKey(path, uploadContext, filename);
      const s3Url = this._buildS3ObjectUrl(uploadContext, objectKey);
      if (s3Url) {
        path = s3Url;
      } else if (/^https?:\/\//i.test(String(assetsSetting || ''))) {
        const baseUrl = String(assetsSetting || '').trim().endsWith('/') ? String(assetsSetting || '').trim() : `${String(assetsSetting || '').trim()}/`;
        const rel = baseTarget && baseDir.startsWith(`${baseTarget}/`) ? baseDir.slice(baseTarget.length + 1) : (baseDir === baseTarget ? '' : baseDir);
        const relPath = [rel, filename].filter(Boolean).join('/');
        path = `${baseUrl}${relPath.replace(/^\/+/, '')}`;
      }
    }
    if (source === 'forgevtt') {
      path = forgeIntegration.optimizeCacheURL(path);
    }

    return path;
  }

  _predictWebPUploadPath(uploadContext, filename) {
    return this._resolveSavedWebPPath(null, uploadContext || {}, filename);
  }

  _buildS3ObjectUrl(uploadContext, key) {
    const cleanBucket = String(uploadContext?.bucketOptions?.bucket || '').trim();
    const cleanKey = this._normalizeS3ObjectKey(key);
    if (!cleanBucket || !cleanKey) return '';

    const s3 = game?.data?.files?.s3 ?? {};
    const forcePathStyle = Boolean(s3.forcePathStyle || s3.pathStyle || s3.usePathStyle);
    const endpointCandidate = s3.endpoint || s3.url || s3.publicUrl || s3.publicURL || '';

    let endpointUrl = null;
    try {
      if (endpointCandidate instanceof URL) endpointUrl = endpointCandidate;
      else if (typeof endpointCandidate === 'string' && endpointCandidate.trim()) {
        const raw = endpointCandidate.trim();
        endpointUrl = new URL(raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`);
      } else if (endpointCandidate && typeof endpointCandidate === 'object') {
        const protocol = String(endpointCandidate.protocol || 'https:');
        const host = String(endpointCandidate.host || endpointCandidate.hostname || '').trim();
        if (host) endpointUrl = new URL(`${protocol.endsWith(':') ? protocol : `${protocol}:`}//${host}`);
      }
    } catch (_) {
      endpointUrl = null;
    }

    if (endpointUrl) {
      if (forcePathStyle) {
        return new URL(cleanKey, this._ensureTrailingSlash(`${endpointUrl.origin.replace(/\/+$/, '')}/${cleanBucket}`)).href;
      }
      const host = endpointUrl.hostname;
      const withBucketHost = host.startsWith(`${cleanBucket}.`) ? host : `${cleanBucket}.${host}`;
      const origin = `${endpointUrl.protocol}//${withBucketHost}${endpointUrl.port ? `:${endpointUrl.port}` : ''}`;
      return new URL(cleanKey, this._ensureTrailingSlash(origin)).href;
    }

    const region = s3.region || s3.awsRegion || s3.awsDefaultRegion || '';
    const host = region ? `${cleanBucket}.s3.${region}.amazonaws.com` : `${cleanBucket}.s3.amazonaws.com`;
    return new URL(cleanKey, `https://${host}/`).href;
  }

  _ensureTrailingSlash(value) {
    const normalized = String(value ?? '').trim();
    if (!normalized) return '';
    return normalized.endsWith('/') ? normalized : `${normalized}/`;
  }

  _normalizeS3ObjectKey(value) {
    let raw = String(value ?? '').trim();
    if (!raw) return '';
    raw = raw.split(/[?#]/, 1)[0] || '';
    try { raw = decodeURI(raw); } catch (_) {}
    return raw.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  }

  _resolveS3ObjectKey(value, uploadContext = null) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';

    try {
      const resolved = forgeIntegration.resolveFilePickerContext(raw);
      if (resolved?.source === 's3') {
        const target = this._normalizeS3ObjectKey(resolved.target);
        if (target) return target;
      }
    } catch (_) {}

    if (/^https?:\/\//i.test(raw)) {
      try {
        const url = new URL(raw);
        let key = this._normalizeS3ObjectKey(url.pathname);
        const bucket = String(uploadContext?.bucketOptions?.bucket || '').trim().toLowerCase();
        if (bucket) {
          const parts = key.split('/').filter(Boolean);
          if (parts[0]?.toLowerCase() === bucket) key = parts.slice(1).join('/');
        }
        return key;
      } catch (_) {}
    }

    if (/^s3:/i.test(raw)) {
      let key = raw.replace(/^s3:\/?/i, '');
      const bucket = String(uploadContext?.bucketOptions?.bucket || '').trim().toLowerCase();
      if (bucket) {
        const parts = key.split('/').filter(Boolean);
        if (parts[0]?.toLowerCase() === bucket) key = parts.slice(1).join('/');
      }
      return this._normalizeS3ObjectKey(key);
    }

    return this._normalizeS3ObjectKey(raw);
  }

  _resolveS3UploadedObjectKey(path, uploadContext, filename) {
    const key = this._resolveS3ObjectKey(path, uploadContext);
    const baseKey = this._resolveS3ObjectKey(uploadContext?.baseDir || '', uploadContext);
    if (!key) return [baseKey, filename].filter(Boolean).join('/');
    if (baseKey && !key.includes('/')) return `${baseKey}/${key}`;
    return key;
  }

  _s3UploadPathsMatch(expectedPath, actualPath, uploadContext = null) {
    if ((uploadContext?.source || '') !== 's3') return false;
    return this._storageObjectKeysMatch(expectedPath, actualPath, uploadContext);
  }

  _storageObjectKeysMatch(leftPath, rightPath, uploadContext = null) {
    const leftKey = this._resolveS3ObjectKey(leftPath, uploadContext);
    const rightKey = this._resolveS3ObjectKey(rightPath, uploadContext);
    return !!(leftKey && rightKey && leftKey === rightKey);
  }

  _normalizeUploadPathForComparison(value) {
    let raw = String(value || '').trim().replace(/\\/g, '/');
    try {
      const base = globalThis.location?.href || 'http://localhost/';
      const url = new URL(raw, base);
      const baseUrl = new URL(base);
      if (url.origin === baseUrl.origin) raw = `${url.pathname}${url.search || ''}${url.hash || ''}`;
    } catch (_) {}
    try { raw = decodeURI(raw); } catch (_) {}
    return raw.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  }

  _recordSavedWebPPathMismatch(expectedPath, actualPath, filename, uploadContext = null) {
    if (!expectedPath) return;
    const expected = this._normalizeUploadPathForComparison(expectedPath);
    const actual = this._normalizeUploadPathForComparison(actualPath);
    if (expected === actual) return;
    if (this._s3UploadPathsMatch(expectedPath, actualPath, uploadContext)) return;

    Logger.warn('TileFlatten.saveWebP.pathMismatch', {
      filename,
      expectedPath,
      actualPath,
      source: uploadContext?.source || 'data',
      usingActualPath: true
    });
  }

  async _saveAsWebP(canvasEl, quality, options = {}) {
    const blob = await this._canvasToWebPBlob(canvasEl, quality);
    return this._saveWebPBlob(blob, options);
  }

  async _saveWebPBlob(blob, options = {}) {
    if (!blob) return null;

    const filename = this._normalizeWebPFilename(options);
    const uploadContext = options.uploadContext || await this._resolveFlattenUploadContext();
    const source = uploadContext?.source || 'data';
    const bucketOptions = uploadContext?.bucketOptions || {};
    const baseDir = uploadContext?.baseDir || '';
    const FP = uploadContext?.FP || foundry.applications.apps.FilePicker.implementation;
    const embeddedMetadata = options.flattenMetadata || null;
    const uploadBlob = embeddedMetadata
      ? await embedFlattenMetadataInWebPBlob(blob, embeddedMetadata)
      : blob;
    const file = new File([uploadBlob], filename, { type: 'image/webp' });

    const uploadResult = await FP.upload(source, baseDir, file, { ...bucketOptions }, { notify: true, filename });

    const path = this._resolveSavedWebPPath(uploadResult, uploadContext, filename);
    this._recordSavedWebPPathMismatch(options.expectedPath || '', path, filename, uploadContext);

    // Wait for Foundry to process the uploaded file before using it
    // This prevents "Invalid Asset" errors when immediately creating tiles
    await new Promise(resolve => setTimeout(resolve, 200));

    return path;
  }

  async _captureFlattenChunkWebP(entry, quality, options = {}) {
    const filename = this._normalizeWebPFilename({ filename: options.filename });
    const blob = await this._canvasToWebPBlob(entry?.canvas, quality);
    if (!blob) {
      throw new Error(`Failed to encode flattened WebP chunk ${filename}.`);
    }
    const src = this._predictWebPUploadPath(options.uploadContext, filename);
    return {
      src,
      filename,
      blob,
      x: Number(entry?.x) || 0,
      y: Number(entry?.y) || 0,
      width: Number(entry?.width) || 0,
      height: Number(entry?.height) || 0,
      pixelWidth: Number(entry?.pixelWidth) || null,
      pixelHeight: Number(entry?.pixelHeight) || null
    };
  }

  _chunkBlobRecordToMetadataEntry(record) {
    return {
      src: String(record?.src || ''),
      x: Number(record?.x) || 0,
      y: Number(record?.y) || 0,
      width: Number(record?.width) || 0,
      height: Number(record?.height) || 0,
      pixelWidth: Number(record?.pixelWidth) || null,
      pixelHeight: Number(record?.pixelHeight) || null
    };
  }

  _replaceFlattenMetadataGeneratedPath(metadata, previousPath, nextPath) {
    const previous = String(previousPath || '').trim();
    const next = String(nextPath || '').trim();
    if (!metadata || !previous || !next || previous === next) return;

    const matches = (candidate) => this._normalizeUploadPathForComparison(candidate) === this._normalizeUploadPathForComparison(previous);
    if (matches(metadata.filePath)) metadata.filePath = next;
    if (metadata.embeddedMetadata && matches(metadata.embeddedMetadata.primaryFilePath)) {
      metadata.embeddedMetadata.primaryFilePath = next;
    }
    if (Array.isArray(metadata.chunks)) {
      for (const chunk of metadata.chunks) {
        if (matches(chunk?.src)) chunk.src = next;
      }
    }
  }

  async _saveCapturedFlattenWebP(record, uploadContext, metadata) {
    const expectedPath = String(record?.src || '').trim();
    const path = await this._saveWebPBlob(record?.blob, {
      uploadContext,
      filename: record?.filename,
      expectedPath,
      flattenMetadata: metadata
    });
    if (!path) throw new Error(`Failed to save flattened WebP ${record?.filename || ''}`.trim());
    if (record && path !== expectedPath) {
      record.src = path;
      this._replaceFlattenMetadataGeneratedPath(metadata, expectedPath, path);
    }
    return path;
  }

  /**
   * Build metadata for deconstruction
   */
  _buildMetadata(data, options = {}) {
    const {
      tiles,
      logicalBounds,
      renderBounds,
      paddingInsets,
      pixelWidth,
      pixelHeight,
      ppi,
      quality,
      paddingSnap,
      paddingExtra,
      resolution,
      filePath,
      chunks,
      chunking,
      chunkSize,
      levelIds,
      levelRange,
      layerRole,
      sceneFlattenScope,
      flattenedElevation
    } = data || {};
    const sceneId = canvas?.scene?.id || null;
    const tileData = [];

    const list = Array.isArray(tiles) ? tiles : [];
    let preservedNestedFlattened = 0;
    for (let i = 0; i < list.length; i += 1) {
      const doc = list[i];
      if (!doc) continue;
      try {
        const data = doc.toObject(false);
        const faFlags = data?.flags?.[MODULE_ID] ? this._deepClone(data.flags[MODULE_ID]) : {};
        if (this._hasRestorableFlattenMetadata(faFlags?.flattened || data?.flags?.[MODULE_ID]?.flattened)) {
          preservedNestedFlattened += 1;
        }
        tileData.push({
          id: doc.id,
          data,
          faFlags
        });
      } catch (error) {
        Logger.debug?.('TileFlatten.metadata.toObject.failed', { error: String(error?.message || error) });
      }
    }
    if (preservedNestedFlattened) {
      Logger.debug?.('TileFlatten.metadata.preservedNestedFlattenedSources', {
        sourceTiles: tileData.length,
        metadataTiles: tileData.length,
        preservedNestedFlattened
      });
    }

    const normalizedInsets = this._normalizePaddingInsets(paddingInsets)
      || this._computeBoundsInsets(logicalBounds || renderBounds, renderBounds);
    const fallbackPadding = normalizedInsets?.max ?? 0;
    const normalizedChunks = Array.isArray(chunks)
      ? chunks.map((chunk) => ({
        src: String(chunk?.src || ''),
        x: Number(chunk?.x) || 0,
        y: Number(chunk?.y) || 0,
        width: Number(chunk?.width) || 0,
        height: Number(chunk?.height) || 0,
        pixelWidth: Number.isFinite(Number(chunk?.pixelWidth)) ? Number(chunk?.pixelWidth) : null,
        pixelHeight: Number.isFinite(Number(chunk?.pixelHeight)) ? Number(chunk?.pixelHeight) : null
      })).filter((chunk) => chunk.src && chunk.width > 0 && chunk.height > 0)
      : null;
    const normalizedChunking = chunking && typeof chunking === 'object'
      ? {
        widthSquares: Number.isFinite(Number(chunking.widthSquares)) ? Number(chunking.widthSquares) : null,
        heightSquares: Number.isFinite(Number(chunking.heightSquares)) ? Number(chunking.heightSquares) : null,
        padToChunks: !!chunking.padToChunks,
        pixelWidth: Number.isFinite(Number(chunking.pixelWidth)) ? Number(chunking.pixelWidth) : null,
        pixelHeight: Number.isFinite(Number(chunking.pixelHeight)) ? Number(chunking.pixelHeight) : null,
        worldWidth: Number.isFinite(Number(chunking.worldWidth)) ? Number(chunking.worldWidth) : null,
        worldHeight: Number.isFinite(Number(chunking.worldHeight)) ? Number(chunking.worldHeight) : null
      }
      : null;
    const hasChunkingData = normalizedChunking
      ? [
        normalizedChunking.widthSquares,
        normalizedChunking.heightSquares,
        normalizedChunking.pixelWidth,
        normalizedChunking.pixelHeight,
        normalizedChunking.worldWidth,
        normalizedChunking.worldHeight
      ].some((value) => Number.isFinite(value) && value > 0)
      : false;
    const normalizedChunkSize = Number(chunkSize);

    return {
      version: 1,
      flattenedAt: Date.now(),
      originalTileCount: tileData.length,
      tiles: tileData,
      tilePositionMode: 'anchor',
      logicalBounds: logicalBounds || renderBounds,
      renderBounds,
      originalPosition: renderBounds ? { x: renderBounds.x, y: renderBounds.y } : null,
      wrapperTransform: buildFlattenedWrapperTransform(renderBounds || logicalBounds),
      padding: fallbackPadding,
      paddingInsets: normalizedInsets,
      pixelWidth: Number(pixelWidth) || null,
      pixelHeight: Number(pixelHeight) || null,
      ppi,
      quality,
      paddingSnap: this._normalizePaddingSnap(paddingSnap),
      paddingExtra: Number.isFinite(Number(paddingExtra)) ? Number(paddingExtra) : 0,
      resolution,
      filePath,
      embeddedMetadata: {
        schema: FLATTEN_WEBP_METADATA_SCHEMA,
        version: FLATTEN_WEBP_METADATA_VERSION,
        required: true,
        primaryFilePath: filePath || null,
        generatedFileCount: normalizedChunks?.length || 1
      },
      chunked: !!(normalizedChunks && normalizedChunks.length),
      chunks: normalizedChunks,
      chunking: hasChunkingData ? normalizedChunking : null,
      chunkSize: Number.isFinite(normalizedChunkSize) && normalizedChunkSize > 0 ? normalizedChunkSize : null,
      levelIds: Array.isArray(levelIds)
        ? levelIds.map((levelId) => String(levelId || '').trim()).filter(Boolean)
        : null,
      levelRange: levelRange ? {
        levelId: normalizeLevelId(levelRange.levelId),
        levelName: String(levelRange.levelName || levelRange.level?.name || '').trim(),
        bottom: Number.isFinite(Number(levelRange.bottom)) ? Number(levelRange.bottom) : null,
        top: Number.isFinite(Number(levelRange.top)) ? Number(levelRange.top) : null
      } : null,
      layerRole: String(layerRole || '').trim() || null,
      sceneFlattenScope: this._normalizeExportScope(sceneFlattenScope),
      flattenedElevation: toFiniteNumberOrNull(flattenedElevation),
      sceneId,
      gridSize: Number(canvas?.scene?.grid?.size || 0) || null
    };
  }

  /**
   * Create flattened tile
   */
  async _createFlattenedTile(bounds, filePath, metadata) {
    if (!canvas?.scene) throw new Error('Scene not available');

    const isChunked = Array.isArray(metadata?.chunks) && metadata.chunks.length > 0;
    const rawPath = typeof filePath === 'string' ? filePath : '';
    // Ensure path doesn't have leading slash for Foundry compatibility
    const cleanPath = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
    const textureSrc = cleanPath || (isChunked ? getTransparentTextureSrc() : '');

    const baseMeta = metadata?.tiles?.[0]?.data || {};
    const sortValues = Array.isArray(metadata?.tiles)
      ? metadata.tiles.map((t) => {
        const data = t?.data || {};
        const normalized = normalizeGroundBandDocumentSort(data.elevation ?? baseMeta.elevation, data.sort, {
          scene: canvas?.scene
        });
        if (normalized.normalized) {
          Logger.warn('TileFlatten.sort.groundBandDocumentSort.normalized', {
            tileId: data._id || data.id || null,
            elevation: Number(data.elevation ?? baseMeta.elevation ?? 0) || 0,
            originalSort: normalized.originalSort,
            normalizedSort: normalized.sort,
            groundBandLocalSort: normalized.localSort,
            encoding: normalized.encoding
          });
        }
        return Number(normalized.sort);
      }).filter((v) => Number.isFinite(v))
      : [];
    const maxSort = sortValues.length ? Math.max(...sortValues) : 0;
    const minElevation = this._resolveFlattenedTileElevation(metadata, baseMeta.elevation);
    const flattenedLevels = this._resolveFlattenedTileLevels(metadata);
    const flattenedParentLevelId = this._resolveFlattenedTileParentLevelId(metadata, flattenedLevels);
    const wrapperTransform = buildFlattenedWrapperTransform(bounds);
    if (wrapperTransform) metadata.wrapperTransform = wrapperTransform;

    const tileData = normalizeTileCreatePayloadForV14({
      texture: { src: encodeTexturePath(textureSrc), anchorX: 0.5, anchorY: 0.5 },
      x: wrapperTransform?.x ?? (bounds.x + (bounds.width / 2)),
      y: wrapperTransform?.y ?? (bounds.y + (bounds.height / 2)),
      width: wrapperTransform?.width ?? bounds.width,
      height: wrapperTransform?.height ?? bounds.height,
      rotation: 0,
      alpha: 1,
      elevation: minElevation,
      sort: Number.isFinite(maxSort) ? maxSort : 0,
      hidden: !!baseMeta.hidden,
      locked: !!baseMeta.locked,
      levels: [],
      roof: !!baseMeta.roof,
      occlusion: baseMeta.occlusion ? this._deepClone(baseMeta.occlusion) : undefined,
      restrictions: baseMeta.restrictions ? this._deepClone(baseMeta.restrictions) : undefined,
      flags: {
        'fa-nexus': {
          flattened: metadata,
          ...(flattenedParentLevelId ? { [FA_NEXUS_TILE_PLACEMENT_LEVEL_FLAG]: flattenedParentLevelId } : {})
        }
      }
    }, { levelPolicy: LEVEL_POLICY_PRESERVE });

    const created = await canvas.scene.createEmbeddedDocuments('Tile', [tileData]);
    
    // Wait for Foundry to finish processing the tile creation
    // This gives the texture loader time to initialize
    await new Promise(resolve => setTimeout(resolve, 100));
    
    return created;
  }

  _resolveFlattenedTileElevation(metadata, fallback = 0) {
    const explicitElevation = toFiniteNumberOrNull(metadata?.flattenedElevation);
    if (Number.isFinite(explicitElevation)) return explicitElevation;
    const elevations = Array.isArray(metadata?.tiles)
      ? metadata.tiles
        .map((entry) => Number(entry?.data?.elevation))
        .filter((value) => Number.isFinite(value))
      : [];
    if (elevations.length) return Math.min(...elevations);
    const numericFallback = Number(fallback);
    return Number.isFinite(numericFallback) ? numericFallback : 0;
  }

  _resolveFlattenedTileParentLevelId(metadata, fallbackLevels = []) {
    const explicit = normalizeLevelId(metadata?.levelRange?.levelId);
    if (explicit) return explicit;
    const levelIds = Array.isArray(metadata?.levelIds)
      ? metadata.levelIds.map((levelId) => normalizeLevelId(levelId)).filter(Boolean)
      : [];
    if (levelIds.length === 1) return levelIds[0];
    const fallback = Array.isArray(fallbackLevels)
      ? fallbackLevels.map((levelId) => normalizeLevelId(levelId)).filter(Boolean)
      : [];
    return fallback.length === 1 ? fallback[0] : null;
  }

  _resolveUniformLevelMembership(documents = []) {
    const list = Array.isArray(documents) ? documents : [];
    const memberships = new Map();

    for (const doc of list) {
      const levelIds = getRawLevelIds(doc);
      const key = JSON.stringify(levelIds);
      if (!memberships.has(key)) memberships.set(key, levelIds);
    }

    if (memberships.size <= 1) return Array.from(memberships.values())[0] || [];

    const variants = Array.from(memberships.values());
    Logger.error('TileFlatten.flattenTiles.mixedLevelMembership', {
      memberships: variants,
      tileIds: list.map((doc) => doc?.id).filter(Boolean)
    });
    throw new Error('Cannot flatten tiles with mixed level membership. Flatten one visibility group at a time.');
  }

  _resolveFlattenedTileLevels(metadata) {
    if (Array.isArray(metadata?.levelIds)) {
      return metadata.levelIds.map((levelId) => String(levelId || '').trim()).filter(Boolean);
    }
    const entries = Array.isArray(metadata?.tiles) ? metadata.tiles : [];
    return this._resolveUniformLevelMembership(entries.map((entry) => entry?.data).filter(Boolean));
  }

  /**
   * Delete original tiles
   */
  async _deleteOriginalTiles(tiles) {
    const ids = Array.isArray(tiles) ? tiles.map((tile) => tile?.id).filter(Boolean) : [];
    if (!ids.length) return;
    await this._deleteSceneTilesByIds(ids, { preserveLinkedCleanup: true });
  }

  async _deleteSceneTilesByIds(ids, { preserveLinkedCleanup = false } = {}) {
    if (!canvas?.scene) return;

    const tileIds = Array.from(new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean)));
    if (!tileIds.length) return;

    const prev = globalThis?.FA_NEXUS_SUPPRESS_BUILDING_TILE_DELETE;
    const prevGeneric = globalThis?.FA_NEXUS_SUPPRESS_LINKED_TILE_DELETE;
    const prevIds = globalThis?.FA_NEXUS_SUPPRESS_LINKED_TILE_DELETE_IDS;
    const nextIds = prevIds instanceof Set ? new Set(prevIds) : new Set();
    for (const id of tileIds) nextIds.add(id);

    try {
      if (preserveLinkedCleanup) {
        globalThis.FA_NEXUS_SUPPRESS_BUILDING_TILE_DELETE = true;
        globalThis.FA_NEXUS_SUPPRESS_LINKED_TILE_DELETE = true;
        globalThis.FA_NEXUS_SUPPRESS_LINKED_TILE_DELETE_IDS = nextIds;
      }

      const deleteOptions = preserveLinkedCleanup
        ? { [PRESERVE_LINKED_TILE_CLEANUP_OPTION]: true }
        : {};
      await canvas.scene.deleteEmbeddedDocuments('Tile', tileIds, deleteOptions);
    } finally {
      if (preserveLinkedCleanup) {
        if (prev === undefined) delete globalThis.FA_NEXUS_SUPPRESS_BUILDING_TILE_DELETE;
        else globalThis.FA_NEXUS_SUPPRESS_BUILDING_TILE_DELETE = prev;
        if (prevGeneric === undefined) delete globalThis.FA_NEXUS_SUPPRESS_LINKED_TILE_DELETE;
        else globalThis.FA_NEXUS_SUPPRESS_LINKED_TILE_DELETE = prevGeneric;
        if (prevIds === undefined) delete globalThis.FA_NEXUS_SUPPRESS_LINKED_TILE_DELETE_IDS;
        else globalThis.FA_NEXUS_SUPPRESS_LINKED_TILE_DELETE_IDS = prevIds;
      }
    }
  }

  _normalizePaddingInsets(padding) {
    if (!padding || typeof padding !== 'object') return null;
    const left = Math.max(0, Number(padding.left) || 0);
    const right = Math.max(0, Number(padding.right) || 0);
    const top = Math.max(0, Number(padding.top) || 0);
    const bottom = Math.max(0, Number(padding.bottom) || 0);
    const max = Math.max(left, right, top, bottom);
    return { left, right, top, bottom, max };
  }

  _computeBoundsInsets(baseBounds, expandedBounds) {
    if (!baseBounds || !expandedBounds) return null;
    const left = Math.max(0, Number(baseBounds.x) - Number(expandedBounds.x));
    const top = Math.max(0, Number(baseBounds.y) - Number(expandedBounds.y));
    const right = Math.max(
      0,
      (Number(expandedBounds.x) + Number(expandedBounds.width)) -
        (Number(baseBounds.x) + Number(baseBounds.width))
    );
    const bottom = Math.max(
      0,
      (Number(expandedBounds.y) + Number(expandedBounds.height)) -
        (Number(baseBounds.y) + Number(baseBounds.height))
    );
    if (![left, right, top, bottom].every(Number.isFinite)) return null;
    return this._normalizePaddingInsets({ left, right, top, bottom });
  }

  _computeCapturePadding(gridSize) {
    const size = Math.max(1, Number(gridSize) || 100);
    return Math.max(16, Math.round(size));
  }

  _releaseCanvas(canvasEl) {
    try {
      if (!canvasEl) return;
      if ('width' in canvasEl) canvasEl.width = 0;
      if ('height' in canvasEl) canvasEl.height = 0;
    } catch (_) {}
  }

  _trimCanvasToContent(canvasEl, alphaThreshold = 0) {
    try {
      if (!canvasEl) return null;
      const width = Number(canvasEl.width || 0);
      const height = Number(canvasEl.height || 0);
      if (!width || !height) return null;
      const ctx = canvasEl.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      const data = ctx.getImageData(0, 0, width, height)?.data;
      if (!data) return null;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      const threshold = Math.max(0, Number(alphaThreshold) || 0);
      for (let y = 0; y < height; y += 1) {
        const row = y * width * 4;
        for (let x = 0; x < width; x += 1) {
          const alpha = data[row + (x * 4) + 3];
          if (alpha > threshold) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < minX || maxY < minY) return null;
      return {
        x: minX,
        y: minY,
        width: (maxX - minX) + 1,
        height: (maxY - minY) + 1,
        touchesEdge: minX <= 0 || minY <= 0 || maxX >= (width - 1) || maxY >= (height - 1)
      };
    } catch (_) {
      return null;
    }
  }

  _cropCanvas(canvasEl, trim) {
    try {
      if (!canvasEl || !trim) return canvasEl;
      const width = Math.max(1, Math.round(Number(trim.width || 0)));
      const height = Math.max(1, Math.round(Number(trim.height || 0)));
      const output = document.createElement('canvas');
      output.width = width;
      output.height = height;
      const ctx = output.getContext('2d');
      if (ctx) {
        ctx.drawImage(canvasEl, -Number(trim.x || 0), -Number(trim.y || 0));
      }
      return output;
    } catch (_) {
      return canvasEl;
    }
  }

  _adjustCanvasToBounds(canvasEl, currentBounds, targetBounds, resolution) {
    try {
      if (!canvasEl || !currentBounds || !targetBounds) return { canvas: canvasEl };
      const targetWidth = Math.max(1, Math.round(Number(targetBounds.width || 0) * resolution));
      const targetHeight = Math.max(1, Math.round(Number(targetBounds.height || 0) * resolution));
      const offsetX = Math.round((Number(currentBounds.x || 0) - Number(targetBounds.x || 0)) * resolution);
      const offsetY = Math.round((Number(currentBounds.y || 0) - Number(targetBounds.y || 0)) * resolution);
      if (canvasEl.width === targetWidth && canvasEl.height === targetHeight && offsetX === 0 && offsetY === 0) {
        return { canvas: canvasEl };
      }
      const output = document.createElement('canvas');
      output.width = targetWidth;
      output.height = targetHeight;
      const ctx = output.getContext('2d');
      if (ctx) {
        ctx.drawImage(canvasEl, offsetX, offsetY);
      }
      return { canvas: output };
    } catch (_) {
      return { canvas: canvasEl };
    }
  }

  _normalizePaddingExtra(value, gridSize) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric === 0) return 0;
    const size = Math.max(1, Number(gridSize) || 100);
    return numeric * size;
  }

  _normalizeChunkSquares(width, height) {
    const rawWidth = Number(width);
    const rawHeight = Number(height);
    let widthSquares = Number.isFinite(rawWidth) && rawWidth >= 1 ? rawWidth : 0;
    let heightSquares = Number.isFinite(rawHeight) && rawHeight >= 1 ? rawHeight : 0;
    if (widthSquares && !heightSquares) heightSquares = widthSquares;
    if (heightSquares && !widthSquares) widthSquares = heightSquares;
    return {
      widthSquares,
      heightSquares,
      enabled: widthSquares > 0 && heightSquares > 0
    };
  }

  _normalizeChunkSize(value, maxTextureSize = null) {
    const numeric = Math.round(Number(value));
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    let size = Math.max(256, numeric);
    const max = Number(maxTextureSize);
    if (Number.isFinite(max) && max > 0) {
      size = Math.min(size, Math.floor(max));
    }
    return size;
  }

  _resolveChunkLayout(options, gridSize, resolution, maxTextureSize) {
    const chunkSquares = this._normalizeChunkSquares(options?.chunkWidth, options?.chunkHeight);
    const safeResolution = Number.isFinite(resolution) && resolution > 0 ? resolution : 1;
    if (chunkSquares.enabled) {
      const chunkWorldWidth = chunkSquares.widthSquares * gridSize;
      const chunkWorldHeight = chunkSquares.heightSquares * gridSize;
      const roundPixel = options?.chunkAuto ? Math.ceil : Math.round;
      const chunkPixelWidth = Math.max(1, roundPixel(chunkWorldWidth * safeResolution));
      const chunkPixelHeight = Math.max(1, roundPixel(chunkWorldHeight * safeResolution));
      const maxSize = Number(maxTextureSize);
      if (Number.isFinite(maxSize) && maxSize > 0) {
        if (chunkPixelWidth > maxSize || chunkPixelHeight > maxSize) {
          throw new Error(`Chunk size exceeds renderer texture cap (${chunkPixelWidth}x${chunkPixelHeight}px > ${maxSize}). Try lowering PPI or chunk size.`);
        }
      }
      return {
        enabled: true,
        widthSquares: chunkSquares.widthSquares,
        heightSquares: chunkSquares.heightSquares,
        worldWidth: chunkWorldWidth,
        worldHeight: chunkWorldHeight,
        pixelWidth: chunkPixelWidth,
        pixelHeight: chunkPixelHeight,
        padToChunks: !!options?.chunkPad
      };
    }

    const chunkPixelSize = this._normalizeChunkSize(options?.chunkSize, maxTextureSize);
    if (!chunkPixelSize) {
      return { enabled: false };
    }
    const worldSize = chunkPixelSize / safeResolution;
    return {
      enabled: true,
      widthSquares: null,
      heightSquares: null,
      worldWidth: worldSize,
      worldHeight: worldSize,
      pixelWidth: chunkPixelSize,
      pixelHeight: chunkPixelSize,
      pixelSize: chunkPixelSize,
      padToChunks: false
    };
  }

  _isDropShadowEnabled() {
    try { return !!game?.settings?.get?.('fa-nexus', 'assetDropShadow'); }
    catch (error) {
      Logger.warn('TileFlatten.dropShadowSetting.readFailed', { error: String(error?.message || error) });
      return true;
    }
  }

  _normalizePaddingSnap(value) {
    const snap = String(value || 'none').toLowerCase();
    if (snap === 'half' || snap === 'full') return snap;
    return 'none';
  }
}
