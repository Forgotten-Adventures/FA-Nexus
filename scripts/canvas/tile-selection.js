import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  mapTileOcclusionElevation,
  tileUsesSurfaceTileOcclusion
} from './tile-occlusion.js';
import { getFaNexusTileCapabilities } from './tile-capabilities.js';
import { getCachedPixiTexture } from '../core/foundry-texture-loader-patch.js';
import { encodeTexturePath } from '../textures/texture-runtime-core.js';

const DEFAULT_ALPHA_THRESHOLD = 1 / 255;
const MASK_ALPHA_THRESHOLD = 1 / 255;
const SURFACE_OCCLUSION_ALPHA_THRESHOLD = 1 / 255;
const DEFAULT_ALPHA_RESOLUTION = 0.25;
const BUILDING_ALPHA_TARGET_PX = 1024;
const BUILDING_ALPHA_EXPAND_RADIUS = 1;
const MIN_ALPHA_RESOLUTION = 0.05;
const SCATTER_HIT_INDEX_CELL_SIZE = 256;
const INTERACTION_PRIORITY_EPSILON = 1e-9;
const INTERACTION_PRIORITY_KEYS = Object.freeze([
  'elevation',
  'sortLayer',
  'sort',
  'zIndex',
  'meshParentIndex',
  'tileParentIndex',
  'lastSortedIndex',
  'documentElevation',
  'documentSort'
]);
const MODULE_ID = 'fa-nexus';
const TILE_SELECTION_SETTING = 'tilePixelSelection';

const _tempPointA = new PIXI.Point();
const _tempPointB = new PIXI.Point();
const _tempPointHandle = new PIXI.Point();
const _tempScenePoint = new PIXI.Point();
const V14_TILE_CONTROL_HANDLE_NAMES = new Set(['translate', 'scale', 'scaleX', 'scaleY', 'rotate']);
const V14_TILE_RESIZE_HANDLE_NAMES = new Set(['scale', 'scaleX', 'scaleY', 'rotate']);
const CONTROLLED_TILE_REFRESH_DELAYS_MS = [0, 16, 80, 180];
const SURFACE_OCCLUSION_ISSUES = new Set();

class TileAlphaHitArea {
  constructor(tile) {
    this.tile = tile;
  }

  contains(localX, localY) {
    const tile = this.tile;
    if (!tile || tile.destroyed) return false;
    try {
      const world = tile.worldTransform.apply({ x: localX, y: localY }, _tempPointA);
      if (!world) return false;
      const handleOwner = TilePixelSelection._getInteractiveHandleOwnerAtPoint(world.x, world.y);
      if (handleOwner) return handleOwner === tile;
      if (!TilePixelSelection._pointWithinTileBounds(tile, world.x, world.y)) return false;
      if (!TilePixelSelection._pointHasVisibleAlpha(tile, world.x, world.y)) return false;
      return !TilePixelSelection._pointOccludedByHigherTile(tile, world.x, world.y);
    } catch (err) {
      Logger.debug('TileAlphaHitArea.contains failed', err);
      return true; // fall back to default behaviour on error
    }
  }
}

export class TilePixelSelection {
  static install() {
    if (this._installed) return;
    this._installed = true;

    this._canvasReady = !!globalThis.canvas?.ready;
    this._settingEnabled = this._getSettingEnabled();
    this._alphaCache = new WeakMap();
    this._controlledTileRefreshBatch = null;
    this._interactiveHandleOwnerCache = null;
    this._interactiveHandleCacheVersion = 0;
    this._active = false;

    Hooks.on('canvasReady', () => {
      this._canvasReady = true;
      this._alphaCache = new WeakMap();
      this._clearControlledInteractionRefreshBatch();
      this._invalidateInteractiveHandleOwnerCache();
      this._applyActivation({ rebindAll: true });
      this._updateAllResizeHandles();
    });

    Hooks.on('canvasTearDown', () => {
      this._canvasReady = false;
      this._applyActivation({ rebindAll: false });
      this._alphaCache = new WeakMap();
      this._clearControlledInteractionRefreshBatch();
      this._invalidateInteractiveHandleOwnerCache();
    });

    Hooks.on('drawTile', (tile) => { this._handleTileLifecycle(tile); });
    Hooks.on('refreshTile', (tile) => { this._handleTileLifecycle(tile); });
    Hooks.on('updateTile', (doc) => {
      try {
        const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
        if (tile) {
          this._handleTileLifecycle(tile);
          this._invalidateInteractiveHandleOwnerCache();
          this._scheduleControlledInteractionRefresh(tile, 'updateTile');
        }
      } catch (_) {}
    });
    Hooks.on('controlTile', (tile) => {
      this._handleTileLifecycle(tile);
      this._updateResizeHandleState(tile);
      this._invalidateInteractiveHandleOwnerCache();
      this._scheduleControlledInteractionRefresh(tile, 'controlTile');
    });
    Hooks.on('updateSetting', (data) => {
      if (!data || data.namespace !== MODULE_ID) return;
      if (data.key === TILE_SELECTION_SETTING) {
        this._settingEnabled = this._getSettingEnabled();
        this._applyActivation({ rebindAll: true });
        this._updateAllResizeHandles();
        this._invalidateInteractiveHandleOwnerCache();
      }
    });

    this._applyActivation({ rebindAll: true });
    this._updateAllResizeHandles();
  }

  static _bindAllTiles() {
    if (!this._active) return;
    try {
      const tiles = canvas.tiles?.placeables;
      if (!Array.isArray(tiles)) return;
      for (const tile of tiles) {
        this._updateResizeHandleState(tile);
        this._bindTile(tile);
      }
    } catch (err) {
      Logger.debug('TilePixelSelection._bindAllTiles failed', err);
    }
  }

  static _unbindAllTiles() {
    try {
      const tiles = canvas.tiles?.placeables;
      if (!Array.isArray(tiles)) return;
      for (const tile of tiles) this._unbindTile(tile);
    } catch (err) {
      Logger.debug('TilePixelSelection._unbindAllTiles failed', err);
    }
  }

  static _handleTileLifecycle(tile) {
    if (!tile || tile.destroyed) return;
    this._updateResizeHandleState(tile);
    if (this._active) this._bindTile(tile);
    else this._unbindTile(tile);
  }

  static _scheduleControlledInteractionRefresh(tile, reason = 'unknown') {
    try {
      if (!tile || tile.destroyed || !tile.controlled) return;
      if (!this._controlledTileRefreshBatch) {
        this._controlledTileRefreshBatch = {
          tiles: new Set(),
          timers: new Map(),
          reasons: new Set()
        };
      }
      const batch = this._controlledTileRefreshBatch;
      batch.tiles.add(tile);
      batch.reasons.add(String(reason || 'unknown'));
      for (const delayMs of CONTROLLED_TILE_REFRESH_DELAYS_MS) {
        if (batch.timers.has(delayMs)) continue;
        const timeoutId = setTimeout(() => {
          try {
            this._refreshControlledTileInteractionBatch(delayMs);
          } finally {
            const active = this._controlledTileRefreshBatch;
            if (!active?.timers) return;
            active.timers.delete(delayMs);
            if (!active.timers.size) this._controlledTileRefreshBatch = null;
          }
        }, delayMs);
        batch.timers.set(delayMs, timeoutId);
      }
    } catch (err) {
      Logger.debug('TilePixelSelection._scheduleControlledInteractionRefresh failed', err);
    }
  }

  static _clearControlledInteractionRefreshBatch() {
    try {
      const batch = this._controlledTileRefreshBatch;
      if (batch?.timers instanceof Map) {
        for (const timeoutId of batch.timers.values()) {
          try { clearTimeout(timeoutId); } catch (_) {}
        }
      }
    } catch (_) {}
    this._controlledTileRefreshBatch = null;
  }

  static _refreshControlledTileInteractionBatch(delayMs = 0) {
    try {
      const batch = this._controlledTileRefreshBatch;
      if (!batch?.tiles?.size) return;
      const tiles = Array.from(batch.tiles).filter((tile) => tile && !tile.destroyed && tile.controlled);
      if (!tiles.length) return;

      const reasons = Array.from(batch.reasons || []).slice(0, 8);
      for (const tile of tiles) this._handleTileLifecycle(tile);

      const manager = tiles.find((tile) => tile?.mouseInteractionManager)?.mouseInteractionManager || null;
      const state = Number(manager?.state ?? 0) || 0;
      const dragging = !!manager?.isDragging;
      if (dragging || state > 1) {
        Logger.trace('tileSelection', 'TilePixelSelection.controlledInteractionBatch.defer', {
          tileCount: tiles.length,
          delayMs,
          reasons,
          managerState: state,
          dragging
        });
        return;
      }

      const mouseManager = globalThis?.foundry?.canvas?.interaction?.MouseInteractionManager || globalThis?.MouseInteractionManager;
      try { mouseManager?.emulateMoveEvent?.(); } catch (_) {}
      Logger.trace('tileSelection', 'TilePixelSelection.controlledInteractionBatch.refresh', {
        tileCount: tiles.length,
        delayMs,
        reasons,
        managerStateBefore: state,
        dragging
      });

      const finalDelay = CONTROLLED_TILE_REFRESH_DELAYS_MS[CONTROLLED_TILE_REFRESH_DELAYS_MS.length - 1];
      if (delayMs !== finalDelay) return;
      const recovery = this._getControlledTileHoverRecoveryCandidate(tiles);
      if (!recovery?.tile || !recovery.expectation?.shouldHoverTile) return;

      const recovered = this._forceControlledTileHover(recovery.tile);
      const recoveredState = Number(recovery.tile?.mouseInteractionManager?.state ?? 0) || 0;
      const recoveredHovered = !!recovery.tile?.hover;
      if (recovered && (recoveredState > 0 || recoveredHovered)) {
        Logger.trace('tileSelection', 'TilePixelSelection.controlledInteractionBatch.hoverRearmed', {
          tileId: recovery.tile?.document?.id || recovery.tile?.id || null,
          tileCount: tiles.length,
          delayMs,
          managerStateAfterRecovery: recoveredState,
          hovered: recoveredHovered
        });
      } else {
        Logger.warn('TilePixelSelection.controlledInteractionBatch.hoverNotRearmed', {
          tileId: recovery.tile?.document?.id || recovery.tile?.id || null,
          tileCount: tiles.length,
          delayMs,
          managerStateAfterRecovery: recoveredState,
          hovered: recoveredHovered,
          pointerOnBoard: recovery.expectation.onBoard,
          pointerWithinBounds: recovery.expectation.withinBounds,
          pointerVisibleAlpha: recovery.expectation.visibleAlpha,
          pointerHitsResizeHandle: recovery.expectation.hitsResizeHandle,
          pointerOverTileTarget: recovery.expectation.overTileTarget,
          pointerOverHandleTarget: recovery.expectation.overHandleTarget
        });
      }
    } catch (err) {
      Logger.debug('TilePixelSelection._refreshControlledTileInteractionBatch failed', err);
    }
  }

  static _getControlledTileHoverRecoveryCandidate(tiles = []) {
    try {
      const candidates = Array.isArray(tiles)
        ? tiles.filter((tile) => tile && !tile.destroyed && tile.controlled)
        : [];
      if (!candidates.length) return null;

      const pointer = this._getRootPointerContext();
      if (!pointer.onBoard || !Number.isFinite(pointer.globalX) || !Number.isFinite(pointer.globalY)) return null;
      const prioritized = candidates.slice().sort((left, right) => this._compareTileInteractionPriority(right, left));
      for (const tile of prioritized) {
        const expectation = this._getControlledTileHoverExpectationForPointer(tile, pointer);
        if (expectation.shouldHoverTile) return { tile, expectation };
      }
      return null;
    } catch (err) {
      Logger.debug('TilePixelSelection._getControlledTileHoverRecoveryCandidate failed', err);
      return null;
    }
  }

  static _refreshControlledTileInteraction(tile, reason = 'unknown') {
    try {
      if (!tile || tile.destroyed || !tile.controlled) return;
      this._handleTileLifecycle(tile);

      const manager = tile.mouseInteractionManager;
      const state = Number(manager?.state ?? 0) || 0;
      const dragging = !!manager?.isDragging;
      if (dragging || state > 1) {
        Logger.trace('tileSelection', 'TilePixelSelection.controlledInteraction.defer', {
          tileId: tile?.document?.id || tile?.id || null,
          reason,
          managerState: state,
          dragging
        });
        return;
      }

      const mouseManager = globalThis?.foundry?.canvas?.interaction?.MouseInteractionManager || globalThis?.MouseInteractionManager;
      const beforeState = Number(manager?.state ?? 0) || 0;
      try { mouseManager?.emulateMoveEvent?.(); } catch (_) {}
      const afterState = Number(manager?.state ?? 0) || 0;
      Logger.trace('tileSelection', 'TilePixelSelection.controlledInteraction.refresh', {
        tileId: tile?.document?.id || tile?.id || null,
        reason,
        managerStateBefore: beforeState,
        managerStateAfter: afterState,
        hovered: !!tile?.hover,
        eventMode: tile?.eventMode ?? null,
        dragging
      });
      if ((afterState === 0) && /:180$/.test(String(reason || ''))) {
        const hoverExpectation = this._getControlledTileHoverExpectation(tile);
        if (hoverExpectation.shouldHoverTile) {
          const recovered = this._forceControlledTileHover(tile);
          const recoveredState = Number(manager?.state ?? 0) || 0;
          const recoveredHovered = !!tile?.hover;
          if (recovered && (recoveredState > 0 || recoveredHovered)) {
            Logger.trace('tileSelection', 'TilePixelSelection.controlledInteraction.hoverRearmed', {
              tileId: tile?.document?.id || tile?.id || null,
              reason,
              managerStateAfterRecovery: recoveredState,
              hovered: recoveredHovered,
              eventMode: tile?.eventMode ?? null,
              interactiveChildren: tile?.interactiveChildren ?? null,
              pointerOnBoard: hoverExpectation.onBoard,
              pointerWithinBounds: hoverExpectation.withinBounds,
              pointerVisibleAlpha: hoverExpectation.visibleAlpha,
              pointerHitsResizeHandle: hoverExpectation.hitsResizeHandle,
              pointerOverTileTarget: hoverExpectation.overTileTarget,
              pointerOverHandleTarget: hoverExpectation.overHandleTarget
            });
          } else {
            Logger.warn('TilePixelSelection.controlledInteraction.hoverNotRearmed', {
              tileId: tile?.document?.id || tile?.id || null,
              reason,
              hovered: recoveredHovered,
              eventMode: tile?.eventMode ?? null,
              interactiveChildren: tile?.interactiveChildren ?? null,
              managerStateAfterRecovery: recoveredState,
              pointerOnBoard: hoverExpectation.onBoard,
              pointerWithinBounds: hoverExpectation.withinBounds,
              pointerVisibleAlpha: hoverExpectation.visibleAlpha,
              pointerHitsResizeHandle: hoverExpectation.hitsResizeHandle,
              pointerOverTileTarget: hoverExpectation.overTileTarget,
              pointerOverHandleTarget: hoverExpectation.overHandleTarget
            });
          }
        } else {
          Logger.trace('tileSelection', 'TilePixelSelection.controlledInteraction.idleOffTile', {
            tileId: tile?.document?.id || tile?.id || null,
            reason,
            hovered: !!tile?.hover,
            eventMode: tile?.eventMode ?? null,
            interactiveChildren: tile?.interactiveChildren ?? null,
            pointerOnBoard: hoverExpectation.onBoard,
            pointerWithinBounds: hoverExpectation.withinBounds,
            pointerVisibleAlpha: hoverExpectation.visibleAlpha,
            pointerHitsResizeHandle: hoverExpectation.hitsResizeHandle,
            pointerOverTileTarget: hoverExpectation.overTileTarget,
            pointerOverHandleTarget: hoverExpectation.overHandleTarget
          });
        }
      }
    } catch (err) {
      Logger.debug('TilePixelSelection._refreshControlledTileInteraction failed', err);
    }
  }

  static _getRootPointerContext() {
    try {
      const eventSystem = canvas?.app?.renderer?.events;
      const rootPointerEvent = eventSystem?.rootPointerEvent;
      const clientX = Number(rootPointerEvent?.clientX);
      const clientY = Number(rootPointerEvent?.clientY);
      const context = {
        onBoard: false,
        clientX: Number.isFinite(clientX) ? clientX : null,
        clientY: Number.isFinite(clientY) ? clientY : null,
        globalX: null,
        globalY: null,
        overTargets: []
      };

      const pointerId = rootPointerEvent?.pointerId;
      const tracking = (pointerId == null) ? null : eventSystem?.rootBoundary?.trackingData?.(pointerId);
      if (Array.isArray(tracking?.overTargets)) context.overTargets = tracking.overTargets;

      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return context;
      const board = canvas?.app?.view || document.querySelector('canvas#board');
      const boardRect = board?.getBoundingClientRect?.();
      const hoverElement = document.elementFromPoint(clientX, clientY);
      context.onBoard = hoverElement?.id === 'board';
      if (!context.onBoard || !boardRect) return context;

      context.globalX = clientX - boardRect.left;
      context.globalY = clientY - boardRect.top;
      return context;
    } catch (err) {
      Logger.debug('TilePixelSelection._getRootPointerContext failed', err);
      return {
        onBoard: false,
        clientX: null,
        clientY: null,
        globalX: null,
        globalY: null,
        overTargets: []
      };
    }
  }

  static _forceControlledTileHover(tile) {
    try {
      const manager = tile?.mouseInteractionManager;
      const eventSystem = canvas?.app?.renderer?.events;
      const rootBoundary = eventSystem?.rootBoundary;
      if (!tile || !manager || !eventSystem || !rootBoundary) return false;

      const event = rootBoundary.createPointerEvent(eventSystem.pointer, 'pointerover', tile);
      try {
        event.defaultPrevented = false;
        if (!event.nativeEvent) event.nativeEvent = eventSystem.rootPointerEvent;
        if (!event.target) event.target = tile;
        manager.handleEvent(event);
      } finally {
        rootBoundary.freeEvent(event);
      }

      return !!tile?.hover || ((Number(manager?.state ?? 0) || 0) > 0);
    } catch (err) {
      Logger.debug('TilePixelSelection._forceControlledTileHover failed', err);
      return false;
    }
  }

  static _pointerTargetsTileHandle(tile, target) {
    try {
      if (!tile || !target) return false;
      const handles = tile?.controls?.handles;
      if (!handles) return false;
      if (target === handles) return true;
      const children = Array.isArray(handles.children) ? handles.children : [];
      return children.includes(target);
    } catch (err) {
      Logger.debug('TilePixelSelection._pointerTargetsTileHandle failed', err);
      return false;
    }
  }

  static _getControlledTileHoverExpectation(tile) {
    try {
      const pointer = this._getRootPointerContext();
      return this._getControlledTileHoverExpectationForPointer(tile, pointer);
    } catch (err) {
      Logger.debug('TilePixelSelection._getControlledTileHoverExpectation failed', err);
      return {
        onBoard: false,
        withinBounds: false,
        visibleAlpha: false,
        hitsResizeHandle: false,
        overTileTarget: false,
        overHandleTarget: false,
        shouldHoverTile: false
      };
    }
  }

  static _getControlledTileHoverExpectationForPointer(tile, pointer = null) {
    try {
      const context = pointer || this._getRootPointerContext();
      const overTargets = Array.isArray(context.overTargets) ? context.overTargets : [];
      const overHandleTarget = !!tile?._hoveredHandle || overTargets.some((target) => this._pointerTargetsTileHandle(tile, target));
      const overTileTarget = overTargets.some((target) => target === tile);

      let withinBounds = false;
      let visibleAlpha = false;
      let hitsResizeHandle = false;
      if (context.onBoard && Number.isFinite(context.globalX) && Number.isFinite(context.globalY)) {
        withinBounds = this._pointWithinTileBounds(tile, context.globalX, context.globalY);
        if (withinBounds) visibleAlpha = this._pointHasVisibleAlpha(tile, context.globalX, context.globalY);
        hitsResizeHandle = this._pointHitsResizeHandle(tile, context.globalX, context.globalY);
      }

      return {
        onBoard: context.onBoard,
        withinBounds,
        visibleAlpha,
        hitsResizeHandle,
        overTileTarget,
        overHandleTarget,
        shouldHoverTile: !!(context.onBoard && withinBounds && visibleAlpha && !hitsResizeHandle && !overHandleTarget)
      };
    } catch (err) {
      Logger.debug('TilePixelSelection._getControlledTileHoverExpectation failed', err);
      return {
        onBoard: false,
        withinBounds: false,
        visibleAlpha: false,
        hitsResizeHandle: false,
        overTileTarget: false,
        overHandleTarget: false,
        shouldHoverTile: false
      };
    }
  }

  static _bindTile(tile) {
    if (!this._active) return;
    if (!tile || tile.destroyed) return;
    try {
      const existingHitArea = tile._faNexusAlphaHitArea;
      const alreadyWrapped = existingHitArea?.tile === tile;
      if (!alreadyWrapped || tile.hitArea !== existingHitArea) {
        tile._faNexusOriginalHitArea = tile.hitArea ?? null;
      }
      if (!alreadyWrapped) {
        tile._faNexusAlphaHitArea = new TileAlphaHitArea(tile);
      }
      if (tile._faNexusAlphaHitArea) tile.hitArea = tile._faNexusAlphaHitArea;
    } catch (err) {
      Logger.debug('TilePixelSelection._bindTile failed', err);
    }
  }

  static _unbindTile(tile) {
    if (!tile || tile.destroyed) return;
    try {
      const wrapped = tile._faNexusAlphaHitArea?.tile === tile;
      if (!wrapped) return;
      if (tile.hitArea === tile._faNexusAlphaHitArea) {
        tile.hitArea = Object.prototype.hasOwnProperty.call(tile, '_faNexusOriginalHitArea') ? tile._faNexusOriginalHitArea : null;
      }
      delete tile._faNexusAlphaHitArea;
    } catch (err) {
      Logger.debug('TilePixelSelection._unbindTile failed', err);
    }
  }

  static _applyActivation({ rebindAll = false } = {}) {
    try {
      if (typeof this._settingEnabled !== 'boolean') this._settingEnabled = this._getSettingEnabled();
    } catch (_) {
      this._settingEnabled = true;
    }
    const shouldBeActive = !!this._canvasReady && !!this._settingEnabled;
    if (shouldBeActive) {
      if (!this._active) {
        this._active = true;
        this._alphaCache = new WeakMap();
        this._bindAllTiles();
      } else if (rebindAll) {
        this._bindAllTiles();
      }
    } else if (this._active || rebindAll) {
      this._unbindAllTiles();
      this._active = false;
      this._alphaCache = new WeakMap();
      this._clearControlledInteractionRefreshBatch();
    }
  }

  static _getSettingEnabled() {
    try {
      return game?.settings?.get?.(MODULE_ID, TILE_SELECTION_SETTING) !== false;
    } catch (err) {
      if (err) Logger.debug('TilePixelSelection._getSettingEnabled failed', err);
      return true;
    }
  }

  static _pointHasVisibleAlpha(tile, worldX, worldY) {
    try {
      if (!this._tileHasVisibleAlpha(tile)) return false;
      if (this._pointIsFullySurfaceOccluded(tile, worldX, worldY)) return false;
      if (this._isVideoTile(tile)) return true; // Video tiles fall back to bounding box
      const mesh = tile?.mesh;
      if (!mesh || mesh.destroyed) return true;

      const standardMaskContainer = mesh.faNexusStandardMaskContainer
        || tile.faNexusStandardMaskContainer
        || null;
      if (standardMaskContainer?.faNexusMaskSprite) {
        const maskAlpha = this._sampleSpriteAlpha(standardMaskContainer.faNexusMaskSprite, worldX, worldY, { useLumaWhenOpaque: true });
        if (maskAlpha === null) return true; // if we cannot sample, allow interaction
        if (maskAlpha < MASK_ALPHA_THRESHOLD) return false;

        const baseAlpha = this._sampleStandardMaskBaseAlpha(standardMaskContainer, worldX, worldY);
        if (baseAlpha !== null) return baseAlpha >= DEFAULT_ALPHA_THRESHOLD;
      }

      const maskContainer = mesh.faNexusMaskContainer
        || tile.faNexusMaskContainer;
      if (maskContainer?.faNexusMaskSprite) {
        const maskSprite = maskContainer.faNexusMaskSprite;
        const maskAlpha = this._sampleSpriteAlpha(maskSprite, worldX, worldY, { useLumaWhenOpaque: true });
        if (maskAlpha === null) return true; // if we cannot sample, allow interaction
        return maskAlpha >= MASK_ALPHA_THRESHOLD;
      }

      const pathContainer = mesh.faNexusPathContainer || tile.faNexusPathContainer;
      if (pathContainer) {
        let pathMeshes = Array.isArray(pathContainer.faNexusPathMeshes) && pathContainer.faNexusPathMeshes.length
          ? pathContainer.faNexusPathMeshes
          : (pathContainer.faNexusPathMesh ? [pathContainer.faNexusPathMesh] : []);
        if (!pathMeshes.length && Array.isArray(pathContainer.children)) {
          pathMeshes = pathContainer.children.filter((child) => child && !child.destroyed && child.geometry);
          if (pathMeshes.length) {
            if (!pathContainer.faNexusPathMesh) pathContainer.faNexusPathMesh = pathMeshes[0];
            if (pathMeshes.length > 1) pathContainer.faNexusPathMeshes = pathMeshes;
          }
        }
        let inspectedMesh = false;
        for (const pathMesh of pathMeshes) {
          if (!pathMesh || pathMesh.destroyed) continue;
          inspectedMesh = true;
          if (!this._meshContainsPoint(pathMesh, worldX, worldY)) continue;
          const pathAlpha = this._sampleMeshTextureAlpha(pathMesh, worldX, worldY);
          if (pathAlpha === null) return true;
          if (pathAlpha >= DEFAULT_ALPHA_THRESHOLD) return true;
        }
        if (inspectedMesh) return false;
      }

      const scatterContainer = mesh.faNexusAssetScatterContainer || tile.faNexusAssetScatterContainer;
      if (scatterContainer) {
        const scatterAlpha = this._sampleScatterContainerAlpha(scatterContainer, worldX, worldY);
        if (scatterAlpha === null) return true;
        return scatterAlpha >= DEFAULT_ALPHA_THRESHOLD;
      }

      const flattenContainer = mesh.faNexusFlattenChunkContainer || tile.faNexusFlattenChunkContainer;
      if (flattenContainer) {
        const sprites = flattenContainer.children || [];
        let inspected = false;
        let sampled = false;
        for (const sprite of sprites) {
          if (!sprite || sprite.destroyed) continue;
          inspected = true;
          if (!sprite.texture?.valid) continue;
          sampled = true;
          const alpha = this._sampleSpriteAlpha(sprite, worldX, worldY, { useLumaWhenOpaque: true });
          if (alpha === null) return true;
          if (alpha >= DEFAULT_ALPHA_THRESHOLD) return true;
        }
        if (sampled) return false;
        if (inspected) return true;
      }

      const buildingContainer = mesh.faNexusBuildingContainer || tile.faNexusBuildingContainer;
      if (buildingContainer) {
        const buildingMeshes = Array.isArray(buildingContainer.faNexusBuildingMeshes) && buildingContainer.faNexusBuildingMeshes.length
          ? buildingContainer.faNexusBuildingMeshes
          : (buildingContainer.children || []);
        let inspectedMesh = false;
        for (const buildingMesh of buildingMeshes) {
          if (!buildingMesh || buildingMesh.destroyed || typeof buildingMesh.render !== 'function') continue;
          inspectedMesh = true;
          if (!this._meshContainsPoint(buildingMesh, worldX, worldY)) continue;
          const buildingAlpha = this._sampleMeshTextureAlpha(buildingMesh, worldX, worldY, {
            target: BUILDING_ALPHA_TARGET_PX,
            expandRadius: BUILDING_ALPHA_EXPAND_RADIUS
          });
          if (buildingAlpha === null) return true;
          if (buildingAlpha >= DEFAULT_ALPHA_THRESHOLD) return true;
        }
        if (inspectedMesh) return false;
      }

      const frameContainer = mesh.faNexusDoorFrameContainer || tile.faNexusDoorFrameContainer;
      if (frameContainer) {
        const sprites = frameContainer.children || [];
        let inspected = false;
        for (const sprite of sprites) {
          if (!sprite || sprite.destroyed || !sprite.texture?.valid) continue;
          inspected = true;
          const alpha = this._sampleSpriteAlpha(sprite, worldX, worldY, { useLumaWhenOpaque: true });
          if (alpha === null) return true;
          if (alpha >= DEFAULT_ALPHA_THRESHOLD) return true;
        }
        if (inspected) return false;
      }

      const regularTileAlpha = this._sampleRegularTileAlpha(tile, worldX, worldY);
      if (regularTileAlpha !== null) return regularTileAlpha >= DEFAULT_ALPHA_THRESHOLD;

      if (typeof mesh.containsPoint === 'function') {
        return !!mesh.containsPoint({ x: worldX, y: worldY }, DEFAULT_ALPHA_THRESHOLD);
      }

      return true;
    } catch (err) {
      Logger.debug('TilePixelSelection._pointHasVisibleAlpha failed', err);
      return true;
    }
  }

  static _sampleScatterContainerAlpha(scatterContainer, worldX, worldY) {
    try {
      if (!scatterContainer || scatterContainer.destroyed) return null;

      const cacheAlpha = this._sampleScatterCacheAlpha(scatterContainer, worldX, worldY);
      if (cacheAlpha !== null && cacheAlpha >= DEFAULT_ALPHA_THRESHOLD) return cacheAlpha;

      const instanceAlpha = this._sampleScatterInstanceIndexAlpha(scatterContainer, worldX, worldY);
      if (instanceAlpha !== null) return instanceAlpha;

      const displayAlpha = this._sampleScatterDisplayAlpha(scatterContainer, worldX, worldY);
      if (displayAlpha !== null) return displayAlpha;

      return cacheAlpha;
    } catch (err) {
      Logger.debug('TilePixelSelection._sampleScatterContainerAlpha failed', err);
      return null;
    }
  }

  static _sampleScatterCacheAlpha(scatterContainer, worldX, worldY) {
    try {
      const cachedSprites = Array.isArray(scatterContainer.faNexusAssetScatterCacheSprites)
        ? scatterContainer.faNexusAssetScatterCacheSprites
        : (scatterContainer.faNexusAssetScatterCacheSprite ? [scatterContainer.faNexusAssetScatterCacheSprite] : []);
      let sampled = false;
      let indeterminate = false;
      for (const cachedSprite of cachedSprites) {
        if (!cachedSprite || cachedSprite.destroyed) continue;
        if (!cachedSprite.texture?.valid) continue;
        sampled = true;
        const alpha = this._sampleSpriteAlpha(cachedSprite, worldX, worldY, { useLumaWhenOpaque: true });
        if (alpha === null) {
          indeterminate = true;
          continue;
        }
        if (alpha >= DEFAULT_ALPHA_THRESHOLD) return alpha;
      }
      if (sampled) return indeterminate ? null : 0;
      return null;
    } catch (err) {
      Logger.debug('TilePixelSelection._sampleScatterCacheAlpha failed', err);
      return null;
    }
  }

  static _sampleScatterInstanceIndexAlpha(scatterContainer, worldX, worldY) {
    try {
      const transform = scatterContainer?.worldTransform;
      if (!transform?.applyInverse) return null;
      const local = transform.applyInverse({ x: worldX, y: worldY }, _tempPointB);
      const localX = Number(local?.x);
      const localY = Number(local?.y);
      if (!Number.isFinite(localX) || !Number.isFinite(localY)) return null;

      const index = this._getScatterHitIndex(scatterContainer);
      if (!index?.cells) return null;
      const cellX = Math.floor(localX / index.cellSize);
      const cellY = Math.floor(localY / index.cellSize);
      const entries = index.cells.get(`${cellX}:${cellY}`);
      if (!Array.isArray(entries) || !entries.length) return 0;

      let sampled = false;
      let indeterminate = false;
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        const bounds = entry?.bounds;
        if (!this._scatterBoundsContainPoint(bounds, localX, localY)) continue;

        const instance = entry?.instance;
        const texture = this._getCachedScatterTexture(instance?.src);
        if (!texture || (!texture.valid && !texture.baseTexture?.valid)) {
          indeterminate = true;
          continue;
        }

        const alpha = this._sampleScatterInstanceAlpha(instance, texture, localX, localY);
        if (alpha === null) {
          indeterminate = true;
          continue;
        }
        sampled = true;
        if (alpha >= DEFAULT_ALPHA_THRESHOLD) return alpha;
      }

      if (sampled) return 0;
      return indeterminate ? null : 0;
    } catch (err) {
      Logger.debug('TilePixelSelection._sampleScatterInstanceIndexAlpha failed', err);
      return null;
    }
  }

  static _getScatterHitIndex(scatterContainer) {
    try {
      const entries = Array.isArray(scatterContainer?.faNexusAssetScatterInstancesWithBounds)
        ? scatterContainer.faNexusAssetScatterInstancesWithBounds
        : [];
      if (!entries.length) return null;

      const contentVersion = Number(scatterContainer.faNexusAssetScatterContentVersion) || 0;
      const existing = scatterContainer.faNexusAssetScatterHitIndex;
      if (existing
        && existing.entries === entries
        && existing.contentVersion === contentVersion
        && existing.cellSize === SCATTER_HIT_INDEX_CELL_SIZE) {
        return existing;
      }

      const cells = new Map();
      const cellSize = SCATTER_HIT_INDEX_CELL_SIZE;
      for (const entry of entries) {
        const bounds = entry?.bounds;
        const instance = entry?.instance;
        if (!instance || !bounds) continue;
        const minX = Number(bounds.minX);
        const minY = Number(bounds.minY);
        const maxX = Number(bounds.maxX);
        const maxY = Number(bounds.maxY);
        if (!Number.isFinite(minX) || !Number.isFinite(minY)
          || !Number.isFinite(maxX) || !Number.isFinite(maxY)) continue;

        const startX = Math.floor(minX / cellSize);
        const endX = Math.floor(maxX / cellSize);
        const startY = Math.floor(minY / cellSize);
        const endY = Math.floor(maxY / cellSize);
        for (let y = startY; y <= endY; y += 1) {
          for (let x = startX; x <= endX; x += 1) {
            const key = `${x}:${y}`;
            let cell = cells.get(key);
            if (!cell) {
              cell = [];
              cells.set(key, cell);
            }
            cell.push(entry);
          }
        }
      }

      const index = {
        entries,
        contentVersion,
        cellSize,
        cells
      };
      scatterContainer.faNexusAssetScatterHitIndex = index;
      return index;
    } catch (err) {
      Logger.debug('TilePixelSelection._getScatterHitIndex failed', err);
      return null;
    }
  }

  static _getCachedScatterTexture(src) {
    try {
      if (!src) return null;
      const direct = getCachedPixiTexture(src);
      if (direct) return direct;
      const encoded = encodeTexturePath(src);
      if (encoded && encoded !== src) return getCachedPixiTexture(encoded);
    } catch (err) {
      Logger.debug('TilePixelSelection._getCachedScatterTexture failed', err);
    }
    return null;
  }

  static _scatterBoundsContainPoint(bounds, x, y) {
    if (!bounds) return false;
    const minX = Number(bounds.minX);
    const minY = Number(bounds.minY);
    const maxX = Number(bounds.maxX);
    const maxY = Number(bounds.maxY);
    if (!Number.isFinite(minX) || !Number.isFinite(minY)
      || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return false;
    const epsilon = 1e-4;
    return x >= (minX - epsilon)
      && x <= (maxX + epsilon)
      && y >= (minY - epsilon)
      && y <= (maxY + epsilon);
  }

  static _sampleScatterInstanceAlpha(instance, texture, localX, localY) {
    try {
      if (!instance || !texture || (!texture.valid && !texture.baseTexture?.valid)) return null;
      const width = Math.max(1, Number(instance.w) || 0);
      const height = Math.max(1, Number(instance.h) || 0);
      const centerX = Number(instance.x) || 0;
      const centerY = Number(instance.y) || 0;
      const rotation = -((Number(instance.r) || 0) * Math.PI) / 180;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const dx = localX - centerX;
      const dy = localY - centerY;
      let unrotatedX = (dx * cos) - (dy * sin);
      let unrotatedY = (dx * sin) + (dy * cos);
      if (instance.flipH) unrotatedX = -unrotatedX;
      if (instance.flipV) unrotatedY = -unrotatedY;

      const displayX = unrotatedX + (width / 2);
      const displayY = unrotatedY + (height / 2);
      if (displayX < 0 || displayY < 0 || displayX >= width || displayY >= height) return 0;

      const textureWidth = Math.max(1, Number(texture.width) || Number(texture.orig?.width) || Number(texture.baseTexture?.realWidth) || 1);
      const textureHeight = Math.max(1, Number(texture.height) || Number(texture.orig?.height) || Number(texture.baseTexture?.realHeight) || 1);
      const textureX = displayX * (textureWidth / width);
      const textureY = displayY * (textureHeight / height);

      const alphaData = this._getAlphaData(texture, { resolution: 1 });
      if (!alphaData?.alpha) return null;
      const px = Math.floor(textureX * (alphaData.width / textureWidth));
      const py = Math.floor(textureY * (alphaData.height / textureHeight));
      const alphaWidth = Math.max(1, alphaData.width || 1);
      const alphaHeight = Math.max(1, alphaData.height || 1);
      if (px < 0 || px >= alphaWidth || py < 0 || py >= alphaHeight) return 0;
      const minX = alphaData.minX ?? 0;
      const minY = alphaData.minY ?? 0;
      const maxX = alphaData.maxX ?? alphaWidth;
      const maxY = alphaData.maxY ?? alphaHeight;
      if (px < minX || px >= maxX || py < minY || py >= maxY) return 0;
      const index = (py * alphaWidth) + px;
      const alphaByte = alphaData.alpha[index];
      return Number.isFinite(alphaByte) ? alphaByte / 255 : 0;
    } catch (err) {
      Logger.debug('TilePixelSelection._sampleScatterInstanceAlpha failed', err);
      return null;
    }
  }

  static _sampleScatterDisplayAlpha(scatterContainer, worldX, worldY) {
    try {
      const liveLayer = scatterContainer?.faNexusAssetScatterViewportLayer;
      if (liveLayer
        && !liveLayer.destroyed
        && liveLayer.visible !== false
        && liveLayer.renderable !== false
        && Array.isArray(liveLayer.children)
        && liveLayer.children.length) {
        const alpha = this._sampleDisplayObjectAlpha(liveLayer, worldX, worldY, { resolution: 1 });
        if (alpha !== null) return alpha;
      }

      const children = Array.isArray(scatterContainer?.children) ? scatterContainer.children : [];
      let sampled = false;
      let indeterminate = false;
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i];
        if (!child || child.destroyed) continue;
        if (child.faNexusAssetScatterCacheSprite === true || child.faNexusAssetScatterViewportLayer === true) continue;
        if (child.visible === false || child.renderable === false || Number(child.worldAlpha) <= 0) continue;

        const alpha = this._sampleDisplayObjectAlpha(child, worldX, worldY, { resolution: 1 });
        if (alpha === null) {
          indeterminate = true;
          continue;
        }
        sampled = true;
        if (alpha >= DEFAULT_ALPHA_THRESHOLD) return alpha;
      }
      if (sampled) return indeterminate ? null : 0;
      return null;
    } catch (err) {
      Logger.debug('TilePixelSelection._sampleScatterDisplayAlpha failed', err);
      return null;
    }
  }

  static _pointIsFullySurfaceOccluded(tile, worldX, worldY) {
    try {
      if (!this._tileUsesSurfaceOcclusion(tile)) return false;
      const occludedAlpha = this._getTileSurfaceOccludedAlpha(tile);
      if (occludedAlpha >= SURFACE_OCCLUSION_ALPHA_THRESHOLD) return false;

      const scenePoint = this._worldToScenePoint(worldX, worldY);
      if (!scenePoint) {
        this._logSurfaceOcclusionIssue('TilePixelSelection.surfaceOcclusion.scenePointMissing', tile);
        return false;
      }

      const occlusionMask = canvas?.masks?.occlusion || null;
      const surfaces = occlusionMask?.occludedSurfaces;
      if (!(surfaces instanceof Set)) {
        this._logSurfaceOcclusionIssue('TilePixelSelection.surfaceOcclusion.surfacesMissing', tile);
        return false;
      }

      const tileMaskElevation = mapTileOcclusionElevation(tile, {
        mesh: tile?.mesh,
        occlusionMask
      });
      if (!Number.isFinite(tileMaskElevation)) {
        this._logSurfaceOcclusionIssue('TilePixelSelection.surfaceOcclusion.mapElevationMissing', tile);
        return false;
      }

      for (const surface of surfaces) {
        if (!surface?.region?.polygonTree?.testPoint) continue;
        if (!this._surfaceCanOccludeTile(surface, tileMaskElevation)) continue;
        if (surface.region.polygonTree.testPoint(scenePoint)) return true;
      }
      return false;
    } catch (err) {
      Logger.warn('TilePixelSelection.surfaceOcclusion.testFailed', {
        tileId: tile?.document?.id || tile?.id || null,
        error: String(err?.message || err)
      });
      return false;
    }
  }

  static _tileUsesSurfaceOcclusion(tile) {
    try {
      const meshMode = Number(tile?.mesh?.occlusionMode);
      const surfaceMode = Number(globalThis?.CONST?.OCCLUSION_MODES?.SURFACE ?? 2);
      if (Number.isFinite(meshMode) && Number.isFinite(surfaceMode) && ((meshMode & surfaceMode) !== 0)) return true;
      const doc = tile?.document;
      return tileUsesSurfaceTileOcclusion(doc?.occlusion, { sourceOcclusion: doc?._source?.occlusion });
    } catch (err) {
      Logger.debug('TilePixelSelection._tileUsesSurfaceOcclusion failed', err);
      return false;
    }
  }

  static _getTileSurfaceOccludedAlpha(tile) {
    const candidates = [
      Number(tile?.mesh?.occludedAlpha),
      Number(tile?.document?.occlusion?.alpha),
      Number(tile?.document?._source?.occlusion?.alpha)
    ];
    const alpha = candidates.find((value) => Number.isFinite(value));
    if (!Number.isFinite(alpha)) return 0;
    return Math.min(1, Math.max(0, alpha));
  }

  static _worldToScenePoint(worldX, worldY) {
    try {
      const x = Number(worldX);
      const y = Number(worldY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const stageTransform = canvas?.stage?.worldTransform ?? canvas?.app?.stage?.worldTransform ?? null;
      return stageTransform?.applyInverse
        ? stageTransform.applyInverse({ x, y }, _tempScenePoint)
        : _tempScenePoint.set(x, y);
    } catch (err) {
      Logger.debug('TilePixelSelection._worldToScenePoint failed', err);
      return null;
    }
  }

  static _surfaceCanOccludeTile(surface, tileMaskElevation) {
    const surfaceMaskElevation = this._mapSurfaceOcclusionElevation(this._getSurfaceMaskElevation(surface));
    if (!Number.isFinite(surfaceMaskElevation)) return false;
    return surfaceMaskElevation < tileMaskElevation;
  }

  static _getSurfaceMaskElevation(surface) {
    const elevation = Number(surface?.elevation);
    if (!Number.isFinite(elevation)) return 0;
    const offset = Math.pow(2, Math.log2(Math.abs(elevation) || 1) - 52);
    return elevation - offset;
  }

  static _mapSurfaceOcclusionElevation(elevation) {
    try {
      const mapped = canvas?.masks?.occlusion?.mapElevation?.(elevation);
      return Number.isFinite(mapped) ? mapped : null;
    } catch (err) {
      Logger.debug('TilePixelSelection._mapSurfaceOcclusionElevation failed', err);
      return null;
    }
  }

  static _logSurfaceOcclusionIssue(code, tile) {
    try {
      const tileId = tile?.document?.id || tile?.id || 'unknown';
      const key = `${code}:${tileId}`;
      if (SURFACE_OCCLUSION_ISSUES.has(key)) return;
      SURFACE_OCCLUSION_ISSUES.add(key);
      Logger.warn(code, { tileId });
    } catch (_) {}
  }

  static _pointWithinTileBounds(tile, worldX, worldY) {
    try {
      const doc = tile?.document;
      if (!doc) return false;
      const texture = doc?.texture || {};
      const width = Math.max(0, Number(doc?.width) || 0);
      const height = Math.max(0, Number(doc?.height) || 0);
      if (!width || !height) return false;
      const scaleX = Number(texture?.scaleX ?? 1);
      const scaleY = Number(texture?.scaleY ?? 1);
      const resolvedScaleX = Number.isFinite(scaleX) && Math.abs(scaleX) > 1e-6 ? scaleX : 1;
      const resolvedScaleY = Number.isFinite(scaleY) && Math.abs(scaleY) > 1e-6 ? scaleY : 1;
      const anchorX = Number(texture?.anchorX);
      const anchorY = Number(texture?.anchorY);
      const resolvedAnchorX = Number.isFinite(anchorX) ? anchorX : 0.5;
      const resolvedAnchorY = Number.isFinite(anchorY) ? anchorY : 0.5;
      const stage = canvas?.stage ?? canvas?.app?.stage;
      const scenePoint = stage?.worldTransform?.applyInverse?.({ x: worldX, y: worldY }, _tempPointB) ?? { x: worldX, y: worldY };
      const anchorWorldX = Number(doc?.x) || 0;
      const anchorWorldY = Number(doc?.y) || 0;
      const rotation = Math.toRadians(Number(doc?.rotation || 0) || 0);
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const deltaX = scenePoint.x - anchorWorldX;
      const deltaY = scenePoint.y - anchorWorldY;
      const unrotatedX = (deltaX * cos) + (deltaY * sin);
      const unrotatedY = (-deltaX * sin) + (deltaY * cos);
      const localX = (unrotatedX / resolvedScaleX) + (width * resolvedAnchorX);
      const localY = (unrotatedY / resolvedScaleY) + (height * resolvedAnchorY);
      const epsilon = 1e-4;
      return localX >= -epsilon
        && localY >= -epsilon
        && localX <= (width + epsilon)
        && localY <= (height + epsilon);
    } catch (err) {
      Logger.debug('TilePixelSelection._pointWithinTileBounds failed', err);
      return true;
    }
  }

  static _pointHitsResizeHandle(tile, worldX, worldY) {
    try {
      const handles = this._getTileControlHandles(tile);
      if (!handles.length) return false;
      for (const handle of handles) {
        if (!this._isInteractiveTileControlHandle(tile, handle)) continue;
        if (typeof handle.containsPoint === 'function') {
          if (handle.containsPoint({ x: worldX, y: worldY })) return true;
          continue;
        }
        const hitArea = handle.hitArea;
        if (!hitArea || typeof hitArea.contains !== 'function') continue;
        const local = handle.worldTransform?.applyInverse?.({ x: worldX, y: worldY }, _tempPointHandle);
        if (!local) continue;
        if (hitArea.contains(local.x, local.y)) return true;
      }
      return false;
    } catch (err) {
      Logger.debug('TilePixelSelection._pointHitsResizeHandle failed', err);
      return false;
    }
  }

  static _compareTileInteractionPriority(left, right) {
    const leftOrder = this._getTileInteractionRenderOrder(left);
    const rightOrder = this._getTileInteractionRenderOrder(right);
    return this._compareTileInteractionOrder(leftOrder, rightOrder);
  }

  static _compareTileInteractionOrder(leftOrder, rightOrder) {
    for (const key of INTERACTION_PRIORITY_KEYS) {
      const delta = leftOrder[key] - rightOrder[key];
      if (Math.abs(delta) > INTERACTION_PRIORITY_EPSILON) return delta;
    }
    return 0;
  }

  static _getTileInteractionRenderOrder(tile) {
    const mesh = tile?.mesh;
    const doc = tile?.document;
    const sortLayers = this._getPrimarySortLayers();
    const documentElevation = this._firstFiniteNumber(doc?.elevation, tile?.elevation, 0);
    const documentSort = this._firstFiniteNumber(doc?.sort, tile?.sort, 0);
    const elevation = this._firstFiniteNumber(
      mesh?.faNexusBgBandValue,
      mesh?.elevation,
      documentElevation
    );
    const sortLayer = this._firstFiniteNumber(
      mesh?.faNexusBgBandRenderSortLayer,
      mesh?.sortLayer,
      tile?.sortLayer,
      sortLayers.TILES
    );
    const sort = this._firstFiniteNumber(
      mesh?.faNexusBgBandRenderSort,
      mesh?.sort,
      documentSort
    );

    return {
      elevation,
      sortLayer,
      sort,
      zIndex: this._firstFiniteNumber(mesh?.faNexusBgBandRenderZIndex, mesh?.zIndex, tile?.zIndex, 0),
      meshParentIndex: this._getParentChildIndex(mesh),
      tileParentIndex: this._getParentChildIndex(tile),
      lastSortedIndex: this._firstFiniteNumber(mesh?._lastSortedIndex, tile?._lastSortedIndex, 0),
      documentElevation,
      documentSort
    };
  }

  static _pointOccludedByHigherTile(tile, worldX, worldY) {
    try {
      const tiles = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
      if (tiles.length <= 1) return false;
      const tileOrder = this._getTileInteractionRenderOrder(tile);
      for (const candidate of tiles) {
        if (!candidate || candidate === tile || candidate.destroyed) continue;
        if (!this._isTileInteractionCandidate(candidate)) continue;
        const candidateOrder = this._getTileInteractionRenderOrder(candidate);
        if (this._compareTileInteractionOrder(candidateOrder, tileOrder) <= INTERACTION_PRIORITY_EPSILON) continue;
        if (!this._pointWithinTileBounds(candidate, worldX, worldY)) continue;
        if (this._pointHasVisibleAlpha(candidate, worldX, worldY)) return true;
      }
      return false;
    } catch (err) {
      Logger.debug('TilePixelSelection._pointOccludedByHigherTile failed', err);
      return false;
    }
  }

  static _isTileInteractionCandidate(tile) {
    try {
      if (!tile || tile.destroyed) return false;
      if (tile.visible === false || tile.renderable === false) return false;
      if (tile.eventMode === 'none') return false;
      const doc = tile.document;
      if (doc?.hidden) return false;
      const mesh = tile.mesh;
      if (mesh && (mesh.visible === false || mesh.renderable === false || mesh.destroyed)) return false;
      return true;
    } catch (err) {
      Logger.debug('TilePixelSelection._isTileInteractionCandidate failed', err);
      return false;
    }
  }

  static _firstFiniteNumber(...values) {
    for (const value of values) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
    return 0;
  }

  static _getParentChildIndex(displayObject) {
    try {
      const parent = displayObject?.parent;
      const children = parent?.children;
      if (!Array.isArray(children)) return 0;
      const index = children.indexOf(displayObject);
      return index >= 0 ? index : 0;
    } catch (err) {
      Logger.debug('TilePixelSelection._getParentChildIndex failed', err);
      return 0;
    }
  }

  static _getPrimarySortLayers() {
    try {
      const source = canvas?.primary?.constructor?.SORT_LAYERS
        || globalThis?.foundry?.canvas?.groups?.PrimaryCanvasGroup?.SORT_LAYERS
        || {};
      const scene = Number(source.SCENE);
      const tiles = Number(source.TILES);
      return {
        SCENE: Number.isFinite(scene) ? scene : 0,
        TILES: Number.isFinite(tiles) ? tiles : 500
      };
    } catch (err) {
      Logger.debug('TilePixelSelection._getPrimarySortLayers failed', err);
      return { SCENE: 0, TILES: 500 };
    }
  }

  static _getInteractiveHandleOwnerAtPoint(worldX, worldY) {
    try {
      const cacheVersion = Number(this._interactiveHandleCacheVersion || 0) || 0;
      const transform = canvas?.stage?.worldTransform || null;
      const transformKey = transform
        ? `${Math.round((Number(transform.a) || 0) * 1000)}:${Math.round((Number(transform.d) || 0) * 1000)}:${Math.round((Number(transform.tx) || 0) * 10)}:${Math.round((Number(transform.ty) || 0) * 10)}`
        : 'no-stage-transform';
      const pointKey = `${Math.round((Number(worldX) || 0) * 100)}:${Math.round((Number(worldY) || 0) * 100)}:${transformKey}:${cacheVersion}`;
      if (this._interactiveHandleOwnerCache?.key === pointKey) {
        return this._interactiveHandleOwnerCache.owner || null;
      }
      const controlled = Array.isArray(canvas?.tiles?.controlled)
        ? canvas.tiles.controlled.filter((tile) => tile && !tile.destroyed)
        : [];
      if (!controlled.length) {
        this._interactiveHandleOwnerCache = { key: pointKey, owner: null };
        return null;
      }
      const prioritized = controlled.slice().sort((left, right) => this._compareTileInteractionPriority(right, left));
      for (const tile of prioritized) {
        if (this._pointHitsResizeHandle(tile, worldX, worldY)) {
          this._interactiveHandleOwnerCache = { key: pointKey, owner: tile };
          return tile;
        }
      }
      this._interactiveHandleOwnerCache = { key: pointKey, owner: null };
      return null;
    } catch (err) {
      Logger.debug('TilePixelSelection._getInteractiveHandleOwnerAtPoint failed', err);
      return null;
    }
  }

  static _invalidateInteractiveHandleOwnerCache() {
    this._interactiveHandleOwnerCache = null;
    this._interactiveHandleCacheVersion = (Number(this._interactiveHandleCacheVersion || 0) || 0) + 1;
  }

  static _getTileControlHandles(tile) {
    try {
      const v14Handles = Array.isArray(tile?.controls?.handles?.children)
        ? tile.controls.handles.children.filter((handle) => handle && !handle.destroyed && V14_TILE_CONTROL_HANDLE_NAMES.has(String(handle.name || '').trim()))
        : [];
      return v14Handles;
    } catch (err) {
      Logger.debug('TilePixelSelection._getTileControlHandles failed', err);
      return [];
    }
  }

  static _isInteractiveTileControlHandle(tile, handle) {
    try {
      if (!handle || handle.destroyed) return false;
      if (!handle.visible || handle.worldAlpha <= 0 || handle.eventMode === 'none') return false;
      if (!this._tileSupportsResizeHandle(tile) && this._isResizeLikeControlHandle(handle)) return false;
      return true;
    } catch (err) {
      Logger.debug('TilePixelSelection._isInteractiveTileControlHandle failed', err);
      return false;
    }
  }

  static _isResizeLikeControlHandle(handle) {
    const name = String(handle?.name || '').trim();
    if (V14_TILE_RESIZE_HANDLE_NAMES.has(name)) return true;
    return !name;
  }

  static _isFaNexusCustomRenderTile(tile) {
    try {
      return !!getFaNexusTileCapabilities(tile)?.isCustomRendered;
    } catch (err) {
      Logger.debug('TilePixelSelection._isFaNexusCustomRenderTile failed', err);
      return false;
    }
  }

  static _tileSupportsResizeHandle(tile) {
    try {
      return getFaNexusTileCapabilities(tile)?.supportsTransformHandles !== false;
    } catch (err) {
      Logger.debug('TilePixelSelection._tileSupportsResizeHandle failed', err);
    }
    return true;
  }

  static _updateAllResizeHandles() {
    try {
      const tiles = canvas.tiles?.placeables;
      if (!Array.isArray(tiles)) return;
      for (const tile of tiles) this._updateResizeHandleState(tile);
    } catch (err) {
      Logger.debug('TilePixelSelection._updateAllResizeHandles failed', err);
    }
  }

  static _updateResizeHandleState(tile) {
    try {
      const supported = this._tileSupportsResizeHandle(tile);
      const handles = this._getTileControlHandles(tile);
      if (!handles.length) {
        if (tile?.controlled) {
          Logger.debug('TilePixelSelection.controlHandles.missing', {
            tileId: tile?.document?.id || tile?.id || null,
            controlled: !!tile?.controlled
          });
        }
        return;
      }

      const handlesVisible = tile?.controls?.handles?.visible !== false;
      const locked = !!tile?.document?.locked;
      for (const handle of handles) {
        if (!handle || handle.destroyed) continue;
        if (!handle._faNexusHandleDefaults) {
          handle._faNexusHandleDefaults = {
            alpha: typeof handle.alpha === 'number' ? handle.alpha : 1,
            eventMode: handle.eventMode ?? 'static',
            cursor: handle.cursor ?? 'pointer'
          };
        }

        const defaults = handle._faNexusHandleDefaults;
        const isResizeLike = this._isResizeLikeControlHandle(handle);
        const controlVisible = tile?.controls?.shape?.controlHandles?.[handle.name]?.visible;
        const shouldDisable = isResizeLike && handlesVisible && !locked && !supported;
        const shouldEnable = !shouldDisable && handlesVisible && (controlVisible !== false);

        handle._faNexusHandleUnsupported = shouldDisable;
        handle.alpha = shouldEnable ? (defaults.alpha ?? 1) : 0;
        handle.cursor = shouldEnable ? (defaults.cursor ?? 'pointer') : 'default';
        handle.eventMode = shouldEnable ? (defaults.eventMode ?? 'static') : 'none';
        handle.visible = shouldEnable;
        if (!shouldEnable) handle.scale?.set?.(1, 1);
      }
    } catch (err) {
      Logger.debug('TilePixelSelection._updateResizeHandleState failed', err);
    }
  }

  static _tileHasVisibleAlpha(tile) {
    if (!tile) return true;
    const documentAlpha = Number(tile.document?.alpha);
    if (Number.isFinite(documentAlpha) && documentAlpha <= 0) return false;
    const tileAlpha = Number(tile.alpha);
    if (Number.isFinite(tileAlpha) && tileAlpha <= 0) return false;
    const meshAlpha = Number(tile.mesh?.worldAlpha ?? tile.mesh?.alpha);
    if (Number.isFinite(meshAlpha) && meshAlpha <= 0) return false;
    return true;
  }

  static _isVideoTile(tile) {
    try {
      // Check texture source path for video extensions
      const src = tile?.document?.texture?.src;
      if (src && /\.(webm|mp4|ogg|m4v)$/i.test(src)) return true;
      // Check if baseTexture resource is a video element
      const baseTexture = tile?.texture?.baseTexture ?? tile?.mesh?.texture?.baseTexture;
      const resource = baseTexture?.resource;
      if (resource?.source instanceof HTMLVideoElement) return true;
      if (resource?.constructor?.name === 'VideoResource') return true;
    } catch (_) {}
    return false;
  }

  static _resolveMeshTexture(mesh) {
    if (!mesh) return null;
    const candidates = [];
    try {
      if (mesh.texture) candidates.push(mesh.texture);
    } catch (_) {}
    const shader = mesh.shader ?? null;
    if (shader) {
      const uniforms = shader.uniforms ?? shader.uniformGroup?.uniforms ?? null;
      if (uniforms && typeof uniforms === 'object') {
        candidates.push(uniforms.uSampler);
        candidates.push(uniforms.texture);
        candidates.push(uniforms.map);
        candidates.push(uniforms.diffuse);
        candidates.push(uniforms.uTexture);
      }
    }
    const material = mesh.material ?? null;
    if (material) {
      candidates.push(material.texture);
      candidates.push(material.map);
    }
    for (const candidate of candidates) {
      const texture = this._unwrapTextureCandidate(candidate);
      if (texture?.valid || texture?.baseTexture?.valid) return texture;
    }
    return null;
  }

  static _unwrapTextureCandidate(candidate) {
    if (!candidate) return null;
    if (candidate instanceof PIXI.Texture) return candidate;
    if (candidate.texture instanceof PIXI.Texture) return candidate.texture;
    if (candidate.frame && candidate.baseTexture) return candidate;
    return null;
  }

  static _meshContainsPoint(mesh, worldX, worldY) {
    try {
      const local = mesh.worldTransform.applyInverse({ x: worldX, y: worldY }, _tempPointB);
      if (!local) return false;
      const geometry = mesh.geometry;
      if (!geometry) return true;
      const buffer = geometry.getBuffer?.('aVertexPosition') ?? geometry.attributes?.aVertexPosition;
      const indexBuffer = geometry.getIndex?.() ?? geometry.indexBuffer ?? geometry.indexArray;
      const vertices = buffer?.data;
      const indices = indexBuffer?.data ?? indexBuffer;
      if (!vertices || !indices) return true;
      for (let i = 0; i < indices.length; i += 3) {
        const ia = indices[i] * 2;
        const ib = indices[i + 1] * 2;
        const ic = indices[i + 2] * 2;
        const ax = vertices[ia];
        const ay = vertices[ia + 1];
        const bx = vertices[ib];
        const by = vertices[ib + 1];
        const cx = vertices[ic];
        const cy = vertices[ic + 1];
        if (this._pointInTriangle(local.x, local.y, ax, ay, bx, by, cx, cy)) return true;
      }
      return false;
    } catch (err) {
      Logger.debug('TilePixelSelection._meshContainsPoint failed', err);
      return true;
    }
  }

  static _sampleMeshTextureAlpha(mesh, worldX, worldY, options = {}) {
    try {
      const texture = this._resolveMeshTexture(mesh);
      if (!texture || (!texture.valid && !texture.baseTexture?.valid)) return null;
      const local = mesh.worldTransform.applyInverse({ x: worldX, y: worldY }, _tempPointB);
      if (!local) return null;

      const geometry = mesh.geometry;
      if (!geometry) return null;
      const vertexBuffer = geometry.getBuffer?.('aVertexPosition') ?? geometry.attributes?.aVertexPosition;
      const uvBuffer = geometry.getBuffer?.('aTextureCoord') ?? geometry.attributes?.aTextureCoord;
      const indexBuffer = geometry.getIndex?.() ?? geometry.indexBuffer ?? geometry.indexArray;
      const vertices = vertexBuffer?.data;
      const uvs = uvBuffer?.data;
      const indices = indexBuffer?.data ?? indexBuffer;
      if (!vertices || !uvs || !indices) return null;

      for (let i = 0; i < indices.length; i += 3) {
        const ia = indices[i] * 2;
        const ib = indices[i + 1] * 2;
        const ic = indices[i + 2] * 2;
        const ax = vertices[ia];
        const ay = vertices[ia + 1];
        const bx = vertices[ib];
        const by = vertices[ib + 1];
        const cx = vertices[ic];
        const cy = vertices[ic + 1];

        if (this._pointInTriangle(local.x, local.y, ax, ay, bx, by, cx, cy)) {
          const uva = uvs[ia];
          const vva = uvs[ia + 1];
          const uvb = uvs[ib];
          const vvb = uvs[ib + 1];
          const uvc = uvs[ic];
          const vvc = uvs[ic + 1];

          const bary = this._barycentricCoords(local.x, local.y, ax, ay, bx, by, cx, cy);
          if (!bary) return null;
          let u = bary.u * uva + bary.v * uvb + bary.w * uvc;
          let v = bary.u * vva + bary.v * vvb + bary.w * vvc;

          // Handle repeating textures by wrapping UV coordinates to 0-1 range
          u = ((u % 1) + 1) % 1;
          v = ((v % 1) + 1) % 1;

          const width = Math.max(1, Number(texture.width) || Number(texture.orig?.width) || Number(texture.baseTexture?.realWidth) || 1);
          const height = Math.max(1, Number(texture.height) || Number(texture.orig?.height) || Number(texture.baseTexture?.realHeight) || 1);
          const x = u * width;
          const y = v * height;

          const alphaData = this._getAlphaData(texture, options);
          if (!alphaData) return null;

          const scaleX = alphaData.width / width;
          const scaleY = alphaData.height / height;
          const sx = x * scaleX;
          const sy = y * scaleY;

          // Check bounds against full texture
          if (sx < 0 || sx >= alphaData.width || sy < 0 || sy >= alphaData.height) return 0;

          const px = Math.floor(sx);
          const py = Math.floor(sy);

          const alphaArray = alphaData.alpha;
          if (!alphaArray) return null;
          const alphaWidth = Math.max(1, alphaData.width || 1);
          const alphaHeight = Math.max(1, alphaData.height || 1);
          const lumaArray = alphaData.luma;
          const useLuma = !!(options.useLumaWhenOpaque && lumaArray);

          const sampleAt = (ix, iy) => {
            if (ix < 0 || ix >= alphaWidth || iy < 0 || iy >= alphaHeight) return 0;
            const index = (iy * alphaWidth) + ix;
            if (index < 0 || index >= alphaArray.length) return 0;
            const alphaByte = alphaArray[index];
            let value = Number.isFinite(alphaByte) ? alphaByte / 255 : 0;
            if (useLuma) {
              const lumaByte = lumaArray[index];
              const luma = Number.isFinite(lumaByte) ? lumaByte / 255 : 0;
              value *= luma;
            }
            return value;
          };

          let value = sampleAt(px, py);
          const radius = Math.max(0, Math.floor(Number(options.expandRadius) || 0));
          if (radius > 0 && value <= 0) {
            for (let dy = -radius; dy <= radius; dy += 1) {
              for (let dx = -radius; dx <= radius; dx += 1) {
                if (!dx && !dy) continue;
                const sampled = sampleAt(px + dx, py + dy);
                if (sampled > value) value = sampled;
                if (value >= 1) break;
              }
              if (value >= 1) break;
            }
          }
          return value;
        }
      }
      return 0;
    } catch (err) {
      Logger.debug('TilePixelSelection._sampleMeshTextureAlpha failed', err);
      return null;
    }
  }

  static _barycentricCoords(px, py, ax, ay, bx, by, cx, cy) {
    const v0x = bx - ax;
    const v0y = by - ay;
    const v1x = cx - ax;
    const v1y = cy - ay;
    const v2x = px - ax;
    const v2y = py - ay;

    const d00 = v0x * v0x + v0y * v0y;
    const d01 = v0x * v1x + v0y * v1y;
    const d11 = v1x * v1x + v1y * v1y;
    const d20 = v2x * v0x + v2y * v0y;
    const d21 = v2x * v1x + v2y * v1y;
    const denom = d00 * d11 - d01 * d01;

    if (Math.abs(denom) < 1e-8) return null;
    const v = (d11 * d20 - d01 * d21) / denom;
    const w = (d00 * d21 - d01 * d20) / denom;
    const u = 1 - v - w;
    return { u, v, w };
  }

  static _pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
    const v0x = cx - ax;
    const v0y = cy - ay;
    const v1x = bx - ax;
    const v1y = by - ay;
    const v2x = px - ax;
    const v2y = py - ay;

    const dot00 = v0x * v0x + v0y * v0y;
    const dot01 = v0x * v1x + v0y * v1y;
    const dot02 = v0x * v2x + v0y * v2y;
    const dot11 = v1x * v1x + v1y * v1y;
    const dot12 = v1x * v2x + v1y * v2y;

    const denom = (dot00 * dot11) - (dot01 * dot01);
    if (Math.abs(denom) < 1e-8) return false;
    const invDenom = 1 / denom;
    const u = ((dot11 * dot02) - (dot01 * dot12)) * invDenom;
    const v = ((dot00 * dot12) - (dot01 * dot02)) * invDenom;
    return (u >= -1e-4) && (v >= -1e-4) && (u + v <= 1 + 1e-4);
  }

  static _sampleSpriteAlpha(sprite, worldX, worldY, options = {}) {
    try {
      const texture = sprite?.texture;
      if (!texture?.valid) return null;
      const local = sprite.worldTransform.applyInverse({ x: worldX, y: worldY }, _tempPointB);
      if (!local) return null;

      const width = texture.width;
      const height = texture.height;
      const anchor = sprite.anchor || { x: 0, y: 0 };
      const x = local.x + (anchor.x * width);
      const y = local.y + (anchor.y * height);
      if (x < 0 || y < 0 || x >= width || y >= height) return 0;

      const alphaData = this._getAlphaData(texture, options);
      if (!alphaData) return null;

      const scaleX = alphaData.width / width;
      const scaleY = alphaData.height / height;
      const sx = x * scaleX;
      const sy = y * scaleY;
      const px = Math.floor(sx);
      const py = Math.floor(sy);
      const minX = alphaData.minX ?? 0;
      const minY = alphaData.minY ?? 0;
      const maxX = alphaData.maxX ?? alphaData.width;
      const maxY = alphaData.maxY ?? alphaData.height;
      if (px < minX || px >= maxX || py < minY || py >= maxY) return 0;
      const alphaWidth = Math.max(1, alphaData.width || 1);
      const alphaHeight = Math.max(1, alphaData.height || 1);
      if (px < 0 || px >= alphaWidth || py < 0 || py >= alphaHeight) return 0;
      // Alpha buffers keep the full texture stride; index with actual width to avoid skewed samples.
      const index = (py * alphaWidth) + px;
      const alphaArray = alphaData.alpha;
      if (!alphaArray) return null;
      const lumaArray = alphaData.luma;
      const alphaByte = alphaArray ? alphaArray[index] : 0;
      let value = Number.isFinite(alphaByte) ? alphaByte / 255 : 0;
      if (options.useLumaWhenOpaque && lumaArray) {
        const lumaByte = lumaArray[index];
        const luma = Number.isFinite(lumaByte) ? lumaByte / 255 : 0;
        value *= luma;
      }
      if (value <= 0) return 0;
      if (value >= 1) return 1;
      return value;
    } catch (err) {
      Logger.debug('TilePixelSelection._sampleSpriteAlpha failed', err);
      return null;
    }
  }

  static _sampleStandardMaskBaseAlpha(maskContainer, worldX, worldY) {
    try {
      const baseDisplay = maskContainer?.faNexusBaseDisplayObject
        || maskContainer?.faNexusBaseSprite
        || null;
      if (!baseDisplay || baseDisplay.destroyed) return null;
      return this._sampleDisplayObjectAlpha(baseDisplay, worldX, worldY, { useLumaWhenOpaque: true });
    } catch (err) {
      Logger.debug('TilePixelSelection._sampleStandardMaskBaseAlpha failed', err);
      return null;
    }
  }

  static _sampleDisplayObjectAlpha(displayObject, worldX, worldY, options = {}) {
    try {
      if (!displayObject || displayObject.destroyed) return null;
      if (displayObject.geometry) {
        if (!this._meshContainsPoint(displayObject, worldX, worldY)) return 0;
        return this._sampleMeshTextureAlpha(displayObject, worldX, worldY, options);
      }
      if (displayObject.texture) {
        return this._sampleSpriteAlpha(displayObject, worldX, worldY, options);
      }
      const children = Array.isArray(displayObject.children) ? displayObject.children : [];
      if (!children.length) return null;
      let sampled = false;
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i];
        if (!child || child.destroyed) continue;
        const alpha = this._sampleDisplayObjectAlpha(child, worldX, worldY, options);
        if (alpha === null) continue;
        sampled = true;
        if (alpha >= DEFAULT_ALPHA_THRESHOLD) return alpha;
      }
      return sampled ? 0 : null;
    } catch (err) {
      Logger.debug('TilePixelSelection._sampleDisplayObjectAlpha failed', err);
      return null;
    }
  }

  static _sampleRegularTileAlpha(tile, worldX, worldY, options = {}) {
    try {
      const doc = tile?.document;
      if (!doc) return null;
      const texture = tile?.mesh?.texture || tile?.texture || tile?.mesh?.material?.texture || null;
      if (!texture || (!texture.valid && !texture.baseTexture?.valid)) return null;

      const width = Math.max(0, Number(doc?.width) || 0);
      const height = Math.max(0, Number(doc?.height) || 0);
      if (!width || !height) return null;

      const scaleX = Number(doc?.texture?.scaleX ?? 1);
      const scaleY = Number(doc?.texture?.scaleY ?? 1);
      const resolvedScaleX = Number.isFinite(scaleX) && Math.abs(scaleX) > 1e-6 ? scaleX : 1;
      const resolvedScaleY = Number.isFinite(scaleY) && Math.abs(scaleY) > 1e-6 ? scaleY : 1;
      const anchorX = Number(doc?.texture?.anchorX);
      const anchorY = Number(doc?.texture?.anchorY);
      const resolvedAnchorX = Number.isFinite(anchorX) ? anchorX : 0.5;
      const resolvedAnchorY = Number.isFinite(anchorY) ? anchorY : 0.5;

      const stage = canvas?.stage ?? canvas?.app?.stage;
      const scenePoint = stage?.worldTransform?.applyInverse?.({ x: worldX, y: worldY }, _tempPointB) ?? { x: worldX, y: worldY };
      const anchorWorldX = Number(doc?.x) || 0;
      const anchorWorldY = Number(doc?.y) || 0;
      const rotation = Math.toRadians(Number(doc?.rotation || 0) || 0);
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const deltaX = scenePoint.x - anchorWorldX;
      const deltaY = scenePoint.y - anchorWorldY;
      const unrotatedX = (deltaX * cos) + (deltaY * sin);
      const unrotatedY = (-deltaX * sin) + (deltaY * cos);
      const localX = (unrotatedX / resolvedScaleX) + (width * resolvedAnchorX);
      const localY = (unrotatedY / resolvedScaleY) + (height * resolvedAnchorY);
      if (localX < 0 || localY < 0 || localX >= width || localY >= height) return 0;

      const alphaData = this._getAlphaData(texture, options);
      if (!alphaData?.alpha) return null;
      const sx = localX * (alphaData.width / width);
      const sy = localY * (alphaData.height / height);
      const px = Math.floor(sx);
      const py = Math.floor(sy);
      const alphaWidth = Math.max(1, alphaData.width || 1);
      const alphaHeight = Math.max(1, alphaData.height || 1);
      if (px < 0 || py < 0 || px >= alphaWidth || py >= alphaHeight) return 0;
      const index = (py * alphaWidth) + px;
      const alphaByte = alphaData.alpha[index];
      return Number.isFinite(alphaByte) ? alphaByte / 255 : 0;
    } catch (err) {
      Logger.debug('TilePixelSelection._sampleRegularTileAlpha failed', err);
      return null;
    }
  }

  static _resolveAlphaResolution(texture, options = {}) {
    const explicit = Number(options?.resolution);
    if (Number.isFinite(explicit) && explicit > 0) {
      return Math.min(1, Math.max(MIN_ALPHA_RESOLUTION, explicit));
    }
    const target = Number(options?.target);
    if (!(Number.isFinite(target) && target > 0)) return DEFAULT_ALPHA_RESOLUTION;
    const width = Math.max(1, Math.round(texture?.orig?.width ?? texture?.width ?? texture?.baseTexture?.realWidth ?? 1));
    const height = Math.max(1, Math.round(texture?.orig?.height ?? texture?.height ?? texture?.baseTexture?.realHeight ?? 1));
    const maxDim = Math.max(width, height);
    if (!Number.isFinite(maxDim) || maxDim <= 0) return DEFAULT_ALPHA_RESOLUTION;
    const desired = target / maxDim;
    return Math.min(1, Math.max(DEFAULT_ALPHA_RESOLUTION, desired));
  }

  static _getAlphaData(texture, options = {}) {
    try {
      const base = texture?.baseTexture;
      if (!base) return null;
      const frame = texture.frame;
      let resolution = this._resolveAlphaResolution(texture, options);
      if (!Number.isFinite(resolution) || resolution <= 0) resolution = DEFAULT_ALPHA_RESOLUTION;
      resolution = Math.round(resolution * 1000) / 1000;
      const key = frame
        ? `${frame.x},${frame.y},${frame.width},${frame.height}|r:${resolution}`
        : `frame:default|r:${resolution}`;
      let frameMap = this._alphaCache?.get(base);
      if (!frameMap) {
        frameMap = new Map();
        this._alphaCache?.set(base, frameMap);
      }
      const currentDirty = Number(base.dirtyId ?? 0);
      let entry = frameMap.get(key);
      if (entry && entry.dirty !== currentDirty) entry = null;
      if (!entry) {
        entry = this._buildAlphaData(texture, resolution);
        if (!entry) return null;
        entry.dirty = currentDirty;
        frameMap.set(key, entry);
      }
      return entry;
    } catch (err) {
      Logger.debug('TilePixelSelection._getAlphaData failed', err);
      return null;
    }
  }

  static _buildAlphaData(texture, resolution = DEFAULT_ALPHA_RESOLUTION) {
    try {
      const renderer = canvas?.app?.renderer;
      if (!renderer) return null;
      const width = Math.max(1, Math.round(texture?.orig?.width ?? texture?.width ?? texture?.baseTexture?.realWidth ?? 1));
      const height = Math.max(1, Math.round(texture?.orig?.height ?? texture?.height ?? texture?.baseTexture?.realHeight ?? 1));
      const resolved = Number.isFinite(resolution) && resolution > 0 ? Math.min(1, Math.max(MIN_ALPHA_RESOLUTION, resolution)) : DEFAULT_ALPHA_RESOLUTION;
      const targetWidth = Math.max(1, Math.round(width * resolved));
      const targetHeight = Math.max(1, Math.round(height * resolved));
      const sprite = new PIXI.Sprite(texture);
      sprite.anchor.set(0, 0);
      sprite.width = targetWidth;
      sprite.height = targetHeight;
      const renderTexture = PIXI.RenderTexture.create({ width: targetWidth, height: targetHeight });
      renderer.render(sprite, { renderTexture, clear: true });
      sprite.destroy();
      const pixels = renderer.extract.pixels(renderTexture);
      renderTexture.destroy(true);

      const alpha = new Uint8Array(targetWidth * targetHeight);
      const luma = new Uint8Array(targetWidth * targetHeight);
      let minX = targetWidth;
      let minY = targetHeight;
      let maxX = 0;
      let maxY = 0;
      for (let i = 0, j = 0, y = 0; y < targetHeight; y++) {
        for (let x = 0; x < targetWidth; x++, j++, i += 4) {
          const r = pixels[i];
          const g = pixels[i + 1];
          const b = pixels[i + 2];
          const a = pixels[i + 3];
          const maxRGB = Math.max(r, g, b);
          alpha[j] = a;
          luma[j] = maxRGB;
          if (a === 0 && maxRGB === 0) continue;
          const effective = Math.max(a, maxRGB);
          if (effective === 0) continue;
          if (x < minX) minX = x;
          if (x >= maxX) maxX = x + 1;
          if (y < minY) minY = y;
          if (y >= maxY) maxY = y + 1;
        }
      }
      if (maxX === 0 && maxY === 0) {
        minX = 0;
        minY = 0;
      }
      return { width: targetWidth, height: targetHeight, minX, minY, maxX, maxY, alpha, luma };
    } catch (err) {
      Logger.debug('TilePixelSelection._buildAlphaData failed', err);
      return null;
    }
  }
}

TilePixelSelection.install();
