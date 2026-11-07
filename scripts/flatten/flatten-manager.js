import { flattenedClause, hiddenLeftOutClause, restoredClause, GAMEPLAY_KEEPS_WORKING, joinMessage } from './flatten-messages.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { sceneGroupInteractionState } from '../composition/scene-group-interaction-state.js';
import { getSelectedSceneGroupMemberUuids } from '../composition/scene-group-interaction-resolver.js';
import { TileFlattenDialog } from './flatten-dialog.js';
import { TileFlattenOverlay } from './tile-flatten-overlay.js';
import { resolveAutoChunking } from './tile-flatten-chunking.js';
import { FlattenDeconstructRestoreTransaction } from './flatten-deconstruct-restore-transaction.js';
import { FlattenDeconstructPayloadWorkflow } from './flatten-deconstruct-payload-workflow.js';
import { FlattenExportWorkflow } from './flatten-export-workflow.js';
import { FlattenCaptureWorkflow } from './flatten-capture-workflow.js';
import { FlattenCaptureRenderContextTransaction } from './flatten-capture-render-context-transaction.js';
import { FlattenOutputPersistence } from './flatten-output-persistence.js';
import { FlattenWrapperTilePersistence } from './flatten-wrapper-tile-persistence.js';
import { captureCompositionPreview } from './flatten-composition-preview-capture.js';
import { flattenCompositionTiles } from './flatten-composition-workflow.js';
import { planFlattenComposition, getFlattenCompositionOwner, deconstructFlattenComposition, maskedFlattenPictures, flattenSectionPictures, flattenSectionPictureFiles } from './flatten-composition.js';
import {
  alignBoundsToScenePixels,
  applyExtraPadding,
  computeFlattenResolution,
  computeRenderBounds,
  computeShadowBlurMargin,
  computeShadowedBounds,
  computeTileShadowMargins,
  computeTileWorldBounds,
  expandBoundsWithMargins,
  normalizeFlattenPaddingExtra,
  normalizeFlattenPaddingSnap,
  padBoundsToChunkGrid,
  snapBounds,
  tileOverlapsBounds
} from './flatten-bounds.js';
import {
  applyMaskedTilingToTile,
  applyStandardTileMaskToTile
} from '../textures/texture-mask-runtime.js';
import {
  getConfiguredAssetsDir,
  sanitizeStoragePathSegments
} from '../storage/generated-paths.js';
import {
  ensureFilePickerDirectory,
  ensureNestedFilePickerDirectory
} from '../storage/file-picker-directory.js';
import {
  buildFlattenOutputBaseName,
  buildFlattenOutputFilename,
  buildFlattenLevelOutputSlugs,
  getFlattenOutputDefaultFolder,
  sanitizeFlattenOutputBaseName,
  sanitizeFlattenOutputPart
} from './flatten-output-paths.js';
import { ensureGeneratedFlattenRootRegistered } from '../storage/generated-output-roots.js';
import {
  getCurrentLevelElevationRange,
  getSceneLevelElevationRanges,
} from '../canvas/elevation-band-utils.js';
import {
  LEVEL_BAND_SIZE,
  buildFlattenDoorVisibility,
  describeCurrentLevelEditScope,
  getDocumentMembershipInLevel,
  getFlattenExportLevelRanges,
  getLevelRangeDisplayName,
  getTileElevationValue,
  isElevationWithinLevelExportRangeValue,
  isTileInCurrentLevelEditScope,
  normalizeLevelId,
  normalizeLevelIds,
  resolveTileLevelLayerRole
} from './flatten-level-scope.js';
import {
  getCanvasReadiness,
  isCanvasReadyFor
} from '../canvas/canvas-readiness.js';
import {
  collectTilePlaceables,
  resolveTileDocumentById,
  resolveTilePlaceableForDocument
} from '../canvas/tile-targets.js';
import {
  PRESERVE_LINKED_TILE_CLEANUP_OPTION,
  withLinkedTileCleanupSuppressed
} from '../canvas/linked-tile-cleanup-guard.js';

const MODULE_ID = 'fa-nexus';
const LAYER_HIDDEN_FLAG = 'layerHidden';
const RESTORED_RENDERER_PLACEABLE_ATTEMPTS = 15;
const RESTORED_RENDERER_PLACEABLE_DELAY_MS = 60;
const RESTORED_RENDERER_HYDRATION_ATTEMPTS = 2;
const RESTORED_RENDERER_HYDRATION_DELAY_MS = 120;
const EXPORT_SCOPE_LEVEL = 'level';
const EXPORT_SCOPE_SCENE = 'scene';
const MIDDLE_PLACEMENT_SEPARATE = 'separate';
const MIDDLE_PLACEMENT_BACKGROUND = 'background';
const MIDDLE_PLACEMENT_FOREGROUND = 'foreground';

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

function normalizeExportScope(value) {
  return value === EXPORT_SCOPE_SCENE ? EXPORT_SCOPE_SCENE : EXPORT_SCOPE_LEVEL;
}

function normalizeMiddlePlacement(value) {
  if (value === MIDDLE_PLACEMENT_BACKGROUND) return MIDDLE_PLACEMENT_BACKGROUND;
  if (value === MIDDLE_PLACEMENT_FOREGROUND) return MIDDLE_PLACEMENT_FOREGROUND;
  return MIDDLE_PLACEMENT_SEPARATE;
}

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

async function resolveSingleFlattenCapturePlan(manager, {
  shadowBounds,
  ppi,
  paddingSnap,
  paddingExtra,
  chunkSquares,
  chunkPad,
  chunkSize,
  outputFolder,
  outputName
} = {}) {
  const gridSize = Math.max(1, Number(canvas?.scene?.grid?.size || 100));
  const resolution = manager._computeResolution(ppi, gridSize);
  // Planned as it will be captured: on the Scene's pixel grid (see alignBoundsToScenePixels).
  const plannedRenderBounds = alignBoundsToScenePixels(
    manager._computeRenderBounds(shadowBounds, gridSize, paddingSnap, paddingExtra),
    resolution
  );
  const plannedPixelWidth = Math.max(1, Math.round(plannedRenderBounds.width * resolution));
  const plannedPixelHeight = Math.max(1, Math.round(plannedRenderBounds.height * resolution));
  const maxTextureSize = manager._getMaxTextureSize(canvas?.app?.renderer);
  const autoChunkPlan = resolveAutoChunking(plannedPixelWidth, plannedPixelHeight, {
    maxTextureSize
  });
  const hasManualChunking = chunkSquares.enabled || chunkSize > 0;
  const useAutoChunking = !hasManualChunking && autoChunkPlan.enabled;
  const useChunking = hasManualChunking ? true : useAutoChunking;
  const uploadContext = await manager._resolveFlattenUploadContext(outputFolder);
  const baseName = manager._sanitizeOutputBaseName(outputName, manager._buildFlattenFilenameBase());
  const plannedFilenames = useChunking
    ? (() => {
      let chunkPixelWidth = 0;
      let chunkPixelHeight = 0;
      if (useAutoChunking) {
        chunkPixelWidth = autoChunkPlan.chunkPixelWidth;
        chunkPixelHeight = autoChunkPlan.chunkPixelHeight;
      } else {
        const chunkLayout = manager._resolveChunkLayout({
          chunkWidth: chunkSquares.widthSquares,
          chunkHeight: chunkSquares.heightSquares,
          chunkPad,
          chunkSize
        }, gridSize, resolution, maxTextureSize);
        chunkPixelWidth = chunkLayout?.pixelWidth || 0;
        chunkPixelHeight = chunkLayout?.pixelHeight || 0;
      }
      return manager._buildChunkOutputFilenames(baseName, plannedPixelWidth, plannedPixelHeight, {
        chunkPixelWidth,
        chunkPixelHeight
      });
    })()
    : [manager._buildOutputFilename(baseName)];

  return {
    autoChunkPlan,
    useAutoChunking,
    useChunking,
    uploadContext,
    baseName,
    plannedFilenames
  };
}

/**
 * Manages flattening multiple tiles into a single image
 */
export class TileFlattenManager {
  async captureCompositionPreview(tiles, bounds, { size = 768, lightIds = [], wallIds = [] } = {}) {
    return captureCompositionPreview(this, tiles, bounds, {size,lightIds,wallIds});
  }

  constructor() {
    this._flattening = false;
    this._deconstructing = false;
    this._overlay = null;
    this._wrapperTilePersistence = new FlattenWrapperTilePersistence({
      deepClone: (value) => this._deepClone(value),
      logger: Logger
    });
    this._deconstructPayloadWorkflow = new FlattenDeconstructPayloadWorkflow(this);
    this._deconstructRestoreTransaction = new FlattenDeconstructRestoreTransaction({
      deepClone: (value) => this._deepClone(value),
      deleteSceneTilesByIds: (ids, options) => this._deleteSceneTilesByIds(ids, options),
      resolveFlattenMetadata: (doc) => this._resolveFlattenMetadata(doc),
      sceneHasEmbeddedDocument: (documentName, id) => this._sceneHasEmbeddedDocument(documentName, id),
      logger: Logger
    });
    this._exportWorkflow = new FlattenExportWorkflow(this);
    this._flattenCaptureWorkflow = new FlattenCaptureWorkflow(this);
    this._flattenCaptureRenderContext = new FlattenCaptureRenderContextTransaction(this);
    this._outputPersistence = new FlattenOutputPersistence(this);
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
    return sanitizeFlattenOutputPart(value, fallback);
  }

  _getLevelOutputSlug(range) {
    const ranges = this._getExportLevelRanges(EXPORT_SCOPE_SCENE);
    const index = ranges.findIndex(candidate => normalizeLevelId(candidate.levelId) === normalizeLevelId(range?.levelId));
    if (index < 0) throw new Error('The output Level is no longer available in this Scene.');
    return buildFlattenLevelOutputSlugs(ranges.map(candidate => getLevelRangeDisplayName(candidate)))[index];
  }

  _buildDefaultOutputBaseName({ action = 'flatten', scope = EXPORT_SCOPE_LEVEL, levelRange = null } = {}) {
    const range = levelRange || getCurrentLevelElevationRange(canvas?.scene);
    return buildFlattenOutputBaseName({
      action,
      scope,
      sceneName: this._getSceneNameForOutput(),
      levelName: getLevelRangeDisplayName(range)
    });
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

      // A Scene Group picked in Direct or Root Group mode is selected as a group, not as canvas controls: its Tiles,
      // nested groups included, count as selected too. Its other members (Walls, Lights) are not Tiles to flatten.
      const scene = canvas?.scene;
      if (scene) {
        for (const uuid of getSelectedSceneGroupMemberUuids(scene, sceneGroupInteractionState.snapshot(scene))) {
          const [kind, id] = String(uuid).split('.').slice(-2);
          if (kind === 'Tile' && id) ids.add(id);
        }
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

    const compositionPlan = await planFlattenComposition(canvas.scene, flattenableTiles);
    const completeTiles = compositionPlan.sections.flatMap(section => section.tiles);
    if (!completeTiles.length) {
      ui.notifications.warn('Select at least one visible composition to flatten.');
      return;
    }
    const dialog = new TileFlattenDialog({
      tiles: completeTiles,
      currentLevelRange: getCurrentLevelElevationRange(canvas?.scene),
      levelRanges: getSceneLevelElevationRanges(canvas?.scene)
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
      levelRanges,
      sceneLevelCoverage: this._describeSceneLevelCoverage(levelRanges)
    });
    const result = await dialog.render(true);

    if (!result || result.cancelled) return;

    await this.exportScene(result);
  }

  async exportScene(options = {}) {
    return this._exportWorkflow.exportScene(options);
  }

  _getExportLevelRanges(scope = EXPORT_SCOPE_LEVEL) {
    return getFlattenExportLevelRanges(scope);
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
    return buildFlattenDoorVisibility(minElevation, maxElevation, { levelIds });
  }

  _buildLevelLayerTasks(range, tiles = [], { splitLayers = false, middlePlacement = MIDDLE_PLACEMENT_SEPARATE, action = 'export' } = {}) {
    const levelName = getLevelRangeDisplayName(range);
    const levelSlug = this._getLevelOutputSlug(range);
    const levelIds = normalizeLevelIds([range?.levelId]);
    const bottom = Number(range?.bottom);
    const top = Number(range?.top);
    const base = Number(range?.base ?? bottom);
    const backgroundEnd = Number.isFinite(base) ? base + LEVEL_BAND_SIZE : null;
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

    if (Number.isFinite(top) || hasForegroundTexture || foregroundTiles.length) {
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
      const base = Number(range?.base ?? range?.bottom);
      if (Number.isFinite(base)) return base;
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
    if (this.isBusy()) return;
    this._flattening = true;
    try {
      const result = await this._flattenCompositionTiles(tiles, options);
      if (result) {
        ui.notifications.info(joinMessage(
          flattenedClause({ layers: result.replacedTileIds?.length ?? 0, pictures: result.createdTileIds?.length ?? 0 }),
          hiddenLeftOutClause(result.hiddenLeftOutTileIds?.length ?? 0),
          GAMEPLAY_KEEPS_WORKING));
      }
      return result;
    } catch (error) {
      Logger.error('TileFlatten.composition.failed', { error: String(error?.stack || error) });
      ui.notifications.error(`Flatten failed: ${error.message}`);
    } finally {
      this._hideOverlay();
      this._flattening = false;
    }
  }

  _flattenCompositionTiles(tiles, options) {
    return flattenCompositionTiles(this, tiles, options, resolveSingleFlattenCapturePlan);
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

  // What "All scene levels" takes: one set of pictures for each Level, of the layers that the Level shows and whose
  // Elevation lies in its range. A visible layer that no Level takes is in no picture; the dialog names it.
  _describeSceneLevelCoverage(levelRanges = []) {
    const ranges = Array.isArray(levelRanges) ? levelRanges : [];
    const tiles = canvas?.scene?.tiles?.contents;
    if (!ranges.length || !Array.isArray(tiles)) return null;
    let includedCount = 0;
    const leftOut = [];
    // Why no Level takes a layer: the Level that has its Elevation does not show it, or (in the bands next to a
    // Level's floor and ceiling, which are drawn with their Parent Level) is not its Parent Level.
    const describe = (doc) => {
      const name = String(doc.name || '').trim() || String(doc.texture?.src || '').split('/').pop() || doc.id;
      const elevation = getTileElevationValue(doc);
      const home = ranges.find((range) => isElevationWithinLevelExportRangeValue(elevation, range)) || null;
      if (!home) return { name, kind: 'no-level', reason: `its Elevation ${elevation} lies in no Level` };
      const homeName = getLevelRangeDisplayName(home);
      if (getDocumentMembershipInLevel(doc, normalizeLevelId(home.levelId)) === false) {
        return { name, kind: 'not-shown', reason: `its Elevation ${elevation} belongs to ${homeName}, which does not show it` };
      }
      const parentId = normalizeLevelId(doc.getFlag?.('fa-nexus', 'placementLevelId'));
      const parentName = String(canvas.scene.levels?.get?.(parentId)?.name || '').trim();
      return { name, kind: 'parent', reason: `its Elevation ${elevation} belongs to ${homeName}, but its Parent Level is ${parentName || 'another Level'}` };
    };
    for (const doc of tiles) {
      if (isTileHiddenForFlatten(doc)) continue;
      if (ranges.some((range) => !!resolveTileLevelLayerRole(doc, range))) includedCount += 1;
      else leftOut.push(describe(doc));
    }
    return { includedCount, leftOut };
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

  async _captureStageToCanvas(renderer, stage, pixelWidth, pixelHeight, { onRenderError, afterRender } = {}) {
    const renderTexture = PIXI.RenderTexture.create({
      width: pixelWidth,
      height: pixelHeight,
      resolution: 1,
      scaleMode: PIXI.SCALE_MODES.LINEAR
    });

    if (renderTexture?.baseTexture) {
      try { renderTexture.baseTexture.clearColor = [0, 0, 0, 0]; } catch (_) {}
    }

    try {
      try {
        renderer.render(stage, {
          renderTexture,
          clear: true,
          skipUpdateTransform: false
        });
      } catch (renderErr) {
        if (typeof onRenderError === 'function') {
          const replacement = onRenderError(renderErr);
          if (replacement instanceof Error) throw replacement;
        }
        throw renderErr;
      }
      if (typeof afterRender === 'function') {
        await afterRender();
      }
      return renderer.extract.canvas(renderTexture);
    } finally {
      renderTexture.destroy(true);
    }
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
    // The picture's pixel grid starts where the capture starts: on a whole Scene pixel where that is possible.
    if (renderBounds) renderBounds = alignBoundsToScenePixels(renderBounds, resolution);
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
    // A picture at the texture cap has no room to grow by the pixel or two that alignment takes: it keeps its bounds.
    const alignWithinTextureCap = (candidate) => {
      const aligned = alignBoundsToScenePixels(candidate, resolution);
      return Math.round(aligned.width * resolution) <= maxTextureSize && Math.round(aligned.height * resolution) <= maxTextureSize
        ? aligned
        : candidate;
    };
    let pixelWidth = Math.max(1, Math.round(renderBounds.width * resolution));
    let pixelHeight = Math.max(1, Math.round(renderBounds.height * resolution));
    if (pixelWidth > maxTextureSize || pixelHeight > maxTextureSize) {
      if (capturePadding && baseBounds) {
        renderBounds = alignWithinTextureCap({ ...baseBounds });
        pixelWidth = Math.max(1, Math.round(renderBounds.width * resolution));
        pixelHeight = Math.max(1, Math.round(renderBounds.height * resolution));
      }
      if (pixelWidth > maxTextureSize || pixelHeight > maxTextureSize) {
        throw new Error(`Flattened image would exceed renderer texture cap (${pixelWidth}×${pixelHeight}px > ${maxTextureSize}). Try lowering PPI or enabling chunking.`);
      }
    }

    let captureTransaction = null;
    try {
      captureTransaction = await this._flattenCaptureRenderContext.begin({
        tiles,
        renderBounds,
        activeCanvas,
        renderer,
        options
      });
      const renderContext = captureTransaction.renderContext;

      Logger.debug?.('TileFlatten.capture.stageRender', {
        originalStage: renderContext.originalStageState,
        renderBounds,
        resolution,
        pixelSize: { width: pixelWidth, height: pixelHeight }
      });

      let renderedCanvas = null;
      let renderContextRestored = false;
      try {
        const targetPosition = {
          x: -renderBounds.x * resolution,
          y: -renderBounds.y * resolution
        };
        await this._flattenCaptureRenderContext.prepare(captureTransaction, {
          resolution,
          screenSize: { width: pixelWidth, height: pixelHeight },
          position: targetPosition,
          logPosition: { renderBounds, targetPosition },
          logScale: true
        });
        await this._flattenCaptureRenderContext.prepareScatter(captureTransaction, renderBounds, 'flatten-capture', { resolution });

        const canvasEl = await this._captureStageToCanvas(renderer, renderContext.stage, pixelWidth, pixelHeight, {
          afterRender: async () => {
            renderContextRestored = true;
            await this._flattenCaptureRenderContext.restoreRenderContext(captureTransaction);
          },
          onRenderError: (renderErr) => {
            const errorMsg = String(renderErr?.message || renderErr);
            Logger.error('TileFlatten.capture.renderFailed', {
              error: errorMsg,
              stagePos: renderContext.stage.position ? { x: renderContext.stage.position.x, y: renderContext.stage.position.y } : null,
              stageScale: renderContext.stage.scale ? { x: renderContext.stage.scale.x, y: renderContext.stage.scale.y } : null
            });
            return new Error(`Failed to render tiles: ${errorMsg}`);
          }
        });
        renderedCanvas = canvasEl;
      } finally {
        if (!renderContextRestored) {
          await this._flattenCaptureRenderContext.restoreRenderContext(captureTransaction);
        }
      }

      let outputCanvas = renderedCanvas;
      let outputBounds = renderBounds;
      if (trimToContent && renderedCanvas) {
        const trim = this._trimCanvasToContent(renderedCanvas);
        if (trim && trim.width > 0 && trim.height > 0) {
          const trimmedCanvas = this._cropCanvas(renderedCanvas, trim);
          if (trimmedCanvas && trimmedCanvas !== renderedCanvas) {
            this._releaseCanvas(renderedCanvas);
          }
          outputCanvas = trimmedCanvas || renderedCanvas;
          outputBounds = {
            x: renderBounds.x + (trim.x / resolution),
            y: renderBounds.y + (trim.y / resolution),
            width: trim.width / resolution,
            height: trim.height / resolution
          };
        }
      }

      // The Tile that shows the picture is placed by its centre in whole Scene pixels: an even size on whole
      // pixels keeps the picture's pixels on the Scene's pixel grid (see alignBoundsToScenePixels).
      const targetBounds = alignWithinTextureCap(this._computeRenderBounds(outputBounds, gridSize, outputSnap, outputExtra));
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

      Logger.debug?.('TileFlatten.capture.canvas', {
        pixelWidth,
        pixelHeight,
        actualWidth: outputCanvas?.width,
        actualHeight: outputCanvas?.height
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
      await this._flattenCaptureRenderContext.restore(captureTransaction);
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
    // The chunks share one pixel grid, which starts where this area starts. As for a single picture, an area on
    // whole Scene pixels with an even size keeps every chunk's pixels on the Scene's pixel grid.
    let renderBounds = alignBoundsToScenePixels(
      this._computeRenderBounds(baseBounds, gridSize, outputSnap, outputExtra),
      resolution
    );
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

    let captureTransaction = null;
    try {
      captureTransaction = await this._flattenCaptureRenderContext.begin({
        tiles,
        renderBounds,
        activeCanvas,
        renderer,
        options
      });
      const renderContext = captureTransaction.renderContext;

      try {
        await this._flattenCaptureRenderContext.prepare(captureTransaction, { resolution });

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
              if (renderContext.stage.position && typeof renderContext.stage.position.set === 'function') {
                renderContext.stage.position.set(-(chunkWorldX - overlapWorldX) * resolution, -(chunkWorldY - overlapWorldY) * resolution);
              }
            } catch (_) {}

            this._flattenCaptureRenderContext.updateTransforms(captureTransaction, { includeLayers: false });

            if (renderer.screen) {
              renderer.screen.width = renderPixelWidth;
              renderer.screen.height = renderPixelHeight;
            }
            await this._flattenCaptureRenderContext.prepareScatter(captureTransaction, {
              x: chunkWorldX - overlapWorldX,
              y: chunkWorldY - overlapWorldY,
              width: chunkWorldWidth + (overlapWorldX * 2),
              height: chunkWorldHeight + (overlapWorldY * 2)
            }, 'flatten-chunk-capture', { resolution });

            const canvasEl = await this._captureStageToCanvas(renderer, renderContext.stage, renderPixelWidth, renderPixelHeight, {
              onRenderError: (renderErr) => {
                const errorMsg = String(renderErr?.message || renderErr);
                return new Error(`Failed to render tile chunk: ${errorMsg}`);
              }
            });
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
        await this._flattenCaptureRenderContext.restoreRenderContext(captureTransaction);
      }
    } finally {
      await this._flattenCaptureRenderContext.restore(captureTransaction);
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

  _computeResolution(ppi, gridSize) {
    return computeFlattenResolution(ppi, gridSize);
  }

  _computeShadowedBounds(tiles) {
    return computeShadowedBounds(tiles, {
      computeTileWorldBounds: (doc) => this._computeTileWorldBounds(doc),
      computeTileShadowMargins: (doc) => this._computeTileShadowMargins(doc)
    });
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
    const offset = this._resolveShadowOffset(doc);
    return computeTileShadowMargins({ dilation, blur, offset });
  }

  _computeShadowBlurMargin(blur) {
    return computeShadowBlurMargin(blur);
  }

  _computeRenderBounds(bounds, gridSize, paddingSnap, paddingExtra) {
    return computeRenderBounds(bounds, gridSize, paddingSnap, paddingExtra);
  }

  _padBoundsToChunkGrid(bounds, chunkWidth, chunkHeight) {
    return padBoundsToChunkGrid(bounds, chunkWidth, chunkHeight);
  }

  _snapBounds(bounds, gridSize, paddingSnap) {
    return snapBounds(bounds, gridSize, paddingSnap);
  }

  _expandBoundsWithMargins(bounds, margins) {
    return expandBoundsWithMargins(bounds, margins);
  }

  _applyExtraPadding(bounds, extraPadding) {
    return applyExtraPadding(bounds, extraPadding);
  }

  _tileOverlapsBounds(doc, bounds) {
    return tileOverlapsBounds(doc, bounds, {
      computeTileWorldBounds: (tileDoc) => this._computeTileWorldBounds(tileDoc)
    });
  }

  _computeTileWorldBounds(doc) {
    if (!doc) return null;
    return computeTileWorldBounds(doc);
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

  /**
   * Ensure nested directory structure exists
   */
  async _ensureNestedDir(targetDir, context = null) {
    await ensureNestedFilePickerDirectory(targetDir, {
      source: context?.source || 'data',
      options: context?.options || {},
      filePicker: foundry.applications.apps.FilePicker.implementation
    });
  }

  /**
   * Ensure a single directory exists
   */
  async _ensureDir(dir, context = null) {
    await ensureFilePickerDirectory(dir, {
      source: context?.source || 'data',
      options: context?.options || {},
      filePicker: foundry.applications.apps.FilePicker.implementation
    });
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
    return !!(this._flattening || this._deconstructing || this._capturingPlayerCache);
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
    tileDoc = getFlattenCompositionOwner(tileDoc);
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
    tileDoc = getFlattenCompositionOwner(tileDoc);
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

    if (flattenMeta.composition) {
      this._deconstructing = true;
      try {
        this._showOverlay('deconstruct', flattenMeta.originalTileCount);
        const restored = await deconstructFlattenComposition(tileDoc, flattenMeta);
        await this._hydrateRestoredCustomTileRenderers(restored, { stage: 'after-commit' });
        ui.notifications.info(restoredClause((restored || []).filter(doc => doc?.documentName === 'Tile').length));
        return restored;
      } catch (error) {
        Logger.error('TileFlatten.composition.restoreFailed', { error: String(error?.stack || error) });
        ui.notifications.error(`Deconstruct failed: ${error.message}`);
      } finally {
        this._hideOverlay();
        this._deconstructing = false;
      }
      return;
    }

    const restorePlan = this._deconstructPayloadWorkflow.buildRestorePlan(tileDoc, flattenMeta);
    const transformValidation = restorePlan.transformValidation;
    if (!transformValidation.ok) {
      ui?.notifications?.error?.(transformValidation.message);
      return;
    }

    const restoration = restorePlan.restoration;
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
    const transaction = this._deconstructRestoreTransaction.createRestoreTransaction(tileDoc, payloads.length);

    try {
      overlay = this._showOverlay('deconstruct', payloads.length);
      overlay.updateProgress(0, payloads.length);
      await this._nextFrame();

      await this._deconstructRestoreTransaction.commitRestoreTransaction({
        tileDoc,
        metadata: flattenMeta,
        payloads,
        restoredEntries: restoration.restoredEntries,
        preservedNestedFlattened: restoration.preservedNestedFlattened,
        transaction,
        onProgress: (current, total) => overlay.updateProgress(current, total),
        beforeCommit: async (createdDocs) => {
          await this._hydrateRestoredCustomTileRenderers(createdDocs, {
            stage: 'before-commit'
          });
        }
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
        ui?.notifications?.warn?.(`${restoredClause(transaction.createdDocs.length)} Some of them may not show their painted masks until the Scene is reloaded; the console (F12) has the details.`);
      } else {
        ui?.notifications?.info?.(restoredClause(transaction.createdDocs.length));
      }
    } catch (error) {
      const rollback = await this._deconstructRestoreTransaction.rollbackDeconstructRestoreTransaction(tileDoc, transaction, error);
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
    return this._deconstructPayloadWorkflow.requiresEmbeddedFlattenMetadata(metadata);
  }

  _resolveEmbeddedFlattenMetadataSources(tileDoc, metadata = null) {
    return this._deconstructPayloadWorkflow.resolveEmbeddedFlattenMetadataSources(tileDoc, metadata);
  }

  async _readEmbeddedFlattenMetadata(tileDoc, metadata = null) {
    return this._deconstructPayloadWorkflow.readEmbeddedFlattenMetadata(tileDoc, metadata);
  }

  _resolveTileTextureSourceForFlattenMetadata(tileDoc) {
    return this._deconstructPayloadWorkflow.resolveTileTextureSourceForFlattenMetadata(tileDoc);
  }

  async _assertEmbeddedFlattenMetadataReadable(tileDoc, metadata) {
    return this._deconstructPayloadWorkflow.assertEmbeddedFlattenMetadataReadable(tileDoc, metadata);
  }

  async _resolveFlattenMetadataForDeconstruct(tileDoc) {
    return this._deconstructPayloadWorkflow.resolveFlattenMetadataForDeconstruct(tileDoc);
  }

  _resolveFlattenMetadataChunkForTile(tileDoc, metadata) {
    return this._deconstructPayloadWorkflow.resolveFlattenMetadataChunkForTile(tileDoc, metadata);
  }

  _dimensionsMatch(width, height, expectedWidth, expectedHeight, epsilon = 1) {
    return this._deconstructPayloadWorkflow.dimensionsMatch(width, height, expectedWidth, expectedHeight, epsilon);
  }

  _resolveImportedFlattenChunkAnchor(tileDoc, metadata, actual = null, fullExpected = null) {
    return this._deconstructPayloadWorkflow.resolveImportedFlattenChunkAnchor(tileDoc, metadata, actual, fullExpected);
  }

  _buildExpectedImportedFlattenChunkTransform(tileDoc, metadata, actual = null, fullExpected = null) {
    return this._deconstructPayloadWorkflow.buildExpectedImportedFlattenChunkTransform(tileDoc, metadata, actual, fullExpected);
  }

  _resolveExpectedFlattenedWrapperTransform(tileDoc, metadata) {
    return this._deconstructPayloadWorkflow.resolveExpectedFlattenedWrapperTransform(tileDoc, metadata);
  }

  _validateFlattenedTileRestoreTransform(tileDoc, metadata) {
    return this._deconstructPayloadWorkflow.validateFlattenedTileRestoreTransform(tileDoc, metadata);
  }

  _resolveFlattenOffset(tileDoc, metadata) {
    return this._deconstructPayloadWorkflow.resolveFlattenOffset(tileDoc, metadata);
  }

  _isLegacyFlattenedTileMetadata(tileDoc, metadata) {
    return this._deconstructPayloadWorkflow.isLegacyFlattenedTileMetadata(tileDoc, metadata);
  }

  _shouldForceLegacyFlattenTilePositionMigration(tileDoc, metadata) {
    return this._deconstructPayloadWorkflow.shouldForceLegacyFlattenTilePositionMigration(tileDoc, metadata);
  }

  _hasRestorableFlattenMetadata(metadata) {
    return this._deconstructPayloadWorkflow.hasRestorableFlattenMetadata(metadata);
  }

  _cloneFlattenMetadataEntry(entry) {
    return this._deconstructPayloadWorkflow.cloneFlattenMetadataEntry(entry);
  }

  _applyFlattenOffsetToTileData(data, offset = null) {
    return this._deconstructPayloadWorkflow.applyFlattenOffsetToTileData(data, offset);
  }

  _prepareDeconstructionPayload(metadata, offset = null, { forceLegacyTilePositionMigration = false } = {}) {
    return this._deconstructPayloadWorkflow.prepareDeconstructionPayload(metadata, offset, { forceLegacyTilePositionMigration });
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

  _countDeconstructRestoreTiles(metadata) {
    return this._deconstructPayloadWorkflow.countDeconstructRestoreTiles(metadata);
  }

  async _confirmDeconstruct(tileDoc, metadata) {
    const tileCount = this._countDeconstructRestoreTiles(metadata);
    const masked = maskedFlattenPictures(tileDoc, metadata).length;
    const maskNote = masked === 1
      ? ' The mask painted on the flattened picture will be discarded.'
      : masked > 1 ? ` The masks painted on ${masked} flattened pictures will be discarded.` : '';
    // A section can be several pictures (the walls and the floor of a Building): all of them go.
    const pictureCount = flattenSectionPictures(tileDoc, metadata).length;
    const many = pictureCount > 1;
    const restored = tileCount ? `the ${tileCount === 1 ? 'layer' : `${tileCount} layers`}` : 'the layers';
    // Deconstruct does not delete what Flatten wrote to disk.
    const fileCount = flattenSectionPictureFiles(tileDoc, metadata).length;
    const fileNote = fileCount > 1
      ? `Its ${fileCount} picture files are not deleted and stay on disk.`
      : fileCount === 1 ? 'Its picture file is not deleted and stays on disk.' : '';
    const paragraphs = [
      `Deconstruct brings back ${restored} ${many ? `these ${pictureCount} pictures were` : 'this picture was'} made from and deletes ${many ? 'them' : 'the picture'}.${maskNote}`,
      fileNote && `${fileNote} Generated Cleanup (Configure Settings, FA Nexus) lists flattened files that no Scene uses any more.`,
      'Continue?'
    ].filter(Boolean);
    const message = paragraphs.join(' ');
    const content = paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join('');

    try {
      const DialogV2 = foundry?.applications?.api?.DialogV2;
      if (DialogV2?.confirm) {
        const result = await DialogV2.confirm({
          window: {
            title: 'Deconstruct'
          },
          modal: true,
          content,
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
          title: 'Deconstruct',
          content,
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
    return this._outputPersistence.findExistingOutputFiles(uploadContext, filenames);
  }

  _isMissingOutputFolderBrowseError(error, source, target) {
    return this._outputPersistence.isMissingOutputFolderBrowseError(error, source, target);
  }

  async _confirmOverwriteOutputs(uploadContext, filenames, options = {}) {
    return this._outputPersistence.confirmOverwriteOutputs(uploadContext, filenames, options);
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
    return getFlattenOutputDefaultFolder(kind, { assetsDir: this._getAssetsDir() });
  }

  _sanitizeOutputBaseName(value, fallbackBase) {
    return sanitizeFlattenOutputBaseName(value, fallbackBase);
  }

  _buildOutputFilename(baseName, suffix = '') {
    return buildFlattenOutputFilename(baseName, suffix, this._buildFlattenFilenameBase());
  }

  async _resolveFlattenUploadContext(folder = null) {
    return this._outputPersistence.resolveFlattenUploadContext(folder);
  }

  async _resolveExportUploadContext(folder = null) {
    return this._outputPersistence.resolveExportUploadContext(folder);
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
    return this._outputPersistence.normalizeWebPFilename(options);
  }

  _resolveSavedWebPPath(uploadResult, uploadContext, filename) {
    return this._outputPersistence.resolveSavedWebPPath(uploadResult, uploadContext, filename);
  }

  _predictWebPUploadPath(uploadContext, filename) {
    return this._outputPersistence.predictWebPUploadPath(uploadContext, filename);
  }

  _buildS3ObjectUrl(uploadContext, key) {
    return this._outputPersistence.buildS3ObjectUrl(uploadContext, key);
  }

  _ensureTrailingSlash(value) {
    return this._outputPersistence.ensureTrailingSlash(value);
  }

  _normalizeS3ObjectKey(value) {
    return this._outputPersistence.normalizeS3ObjectKey(value);
  }

  _resolveS3ObjectKey(value, uploadContext = null) {
    return this._outputPersistence.resolveS3ObjectKey(value, uploadContext);
  }

  _resolveS3UploadedObjectKey(path, uploadContext, filename) {
    return this._outputPersistence.resolveS3UploadedObjectKey(path, uploadContext, filename);
  }

  _s3UploadPathsMatch(expectedPath, actualPath, uploadContext = null) {
    return this._outputPersistence.s3UploadPathsMatch(expectedPath, actualPath, uploadContext);
  }

  _storageObjectKeysMatch(leftPath, rightPath, uploadContext = null) {
    return this._outputPersistence.storageObjectKeysMatch(leftPath, rightPath, uploadContext);
  }

  _normalizeUploadPathForComparison(value) {
    return this._outputPersistence.normalizeUploadPathForComparison(value);
  }

  _recordSavedWebPPathMismatch(expectedPath, actualPath, filename, uploadContext = null) {
    return this._outputPersistence.recordSavedWebPPathMismatch(expectedPath, actualPath, filename, uploadContext);
  }

  async _saveAsWebP(canvasEl, quality, options = {}) {
    return this._outputPersistence.saveAsWebP(canvasEl, quality, options);
  }

  async _saveWebPBlob(blob, options = {}) {
    return this._outputPersistence.saveWebPBlob(blob, options);
  }

  async _captureFlattenChunkWebP(entry, quality, options = {}) {
    return this._outputPersistence.captureFlattenChunkWebP(entry, quality, options);
  }

  _chunkBlobRecordToMetadataEntry(record) {
    return this._outputPersistence.chunkBlobRecordToMetadataEntry(record);
  }

  _replaceFlattenMetadataGeneratedPath(metadata, previousPath, nextPath) {
    return this._outputPersistence.replaceFlattenMetadataGeneratedPath(metadata, previousPath, nextPath);
  }

  async _saveCapturedFlattenWebP(record, uploadContext, metadata) {
    return this._outputPersistence.saveCapturedFlattenWebP(record, uploadContext, metadata);
  }

  /**
   * Build metadata for deconstruction
   */
  _buildMetadata(data, options = {}) {
    return this._deconstructPayloadWorkflow.buildMetadata(data, options);
  }

  /**
   * Create flattened tile
   */
  async _createFlattenedTile(bounds, filePath, metadata) {
    return this._wrapperTilePersistence.createFlattenedTile(bounds, filePath, metadata);
  }

  _resolveFlattenedTileElevation(metadata, fallback = 0) {
    return this._wrapperTilePersistence.resolveFlattenedTileElevation(metadata, fallback);
  }

  _resolveFlattenedTileParentLevelId(metadata, fallbackLevels = []) {
    return this._wrapperTilePersistence.resolveFlattenedTileParentLevelId(metadata, fallbackLevels);
  }

  _resolveUniformLevelMembership(documents = []) {
    return this._wrapperTilePersistence.resolveUniformLevelMembership(documents);
  }

  _resolveFlattenedTileLevels(metadata) {
    return this._wrapperTilePersistence.resolveFlattenedTileLevels(metadata);
  }

  /**
   * Delete original tiles
   */
  async _deleteOriginalTiles(tiles) {
    const ids = Array.isArray(tiles) ? tiles.map((tile) => tile?.id).filter(Boolean) : [];
    if (!ids.length) return;
    await this._deleteSceneTilesByIds(ids, {
      preserveLinkedCleanup: true,
      preserveGeneratedFiles: true
    });
  }

  async _deleteSceneTilesByIds(ids, { preserveLinkedCleanup = false, preserveGeneratedFiles = false } = {}) {
    if (!canvas?.scene) return;

    const tileIds = Array.from(new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean)));
    if (!tileIds.length) return;

    if (preserveLinkedCleanup) {
      await withLinkedTileCleanupSuppressed(tileIds, () => (
        canvas.scene.deleteEmbeddedDocuments('Tile', tileIds, {
          [PRESERVE_LINKED_TILE_CLEANUP_OPTION]: true,
          faNexusSkipGeneratedCleanup: preserveGeneratedFiles
        })
      ), { suppressBuildingCleanup: true });
      return;
    }

    await canvas.scene.deleteEmbeddedDocuments('Tile', tileIds, {});
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
    return normalizeFlattenPaddingExtra(value, gridSize);
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
    return normalizeFlattenPaddingSnap(value);
  }
}
