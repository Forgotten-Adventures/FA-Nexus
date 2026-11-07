import { resolveInitialFaNexusPlacementElevation } from '../canvas/elevation-band-utils.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { loadTexture } from '../textures/texture-runtime-core.js';
import { MAX_SHADOW_DILATION } from './asset-placement-drop-shadow-state.js';
import { createNeutralHsbc, readDocumentHsbc } from '../core/hsbc.js';
import { createScatterEditState } from './asset-scatter-tile-transform.js';

export const getTileVisualCenterWorld = (doc) => {
  const x = Number(doc?.x || 0);
  const y = Number(doc?.y || 0);
  const width = Number(doc?.width || 0);
  const height = Number(doc?.height || 0);
  const anchorX = Number(doc?.texture?.anchorX);
  const anchorY = Number(doc?.texture?.anchorY);
  const resolvedAnchorX = Number.isFinite(anchorX) ? anchorX : 0.5;
  const resolvedAnchorY = Number.isFinite(anchorY) ? anchorY : 0.5;
  return {
    x: x + (width * (0.5 - resolvedAnchorX)),
    y: y + (height * (0.5 - resolvedAnchorY))
  };
};

export class AssetPlacementEditSession {
  constructor(manager, { scatterModeBrush, scatterModeSingle }) {
    if (!manager) throw new Error('AssetPlacementEditSession requires manager.');
    this.manager = manager;
    this.scatterModeBrush = scatterModeBrush;
    this.scatterModeSingle = scatterModeSingle;
  }

  async editTile(tileDocument, options = {}) {
    const manager = this.manager;
    try {
      if (!tileDocument) throw new Error('Tile document required');
      const doc = tileDocument.document ?? tileDocument;
      if (!doc) throw new Error('Tile document unavailable');
      const scatterPayload = manager._readScatterTileData(doc);
      if (scatterPayload) {
        await this.editScatterTile(doc, scatterPayload, options);
        return;
      }
      if (!doc.texture || !doc.texture.src) throw new Error('Tile is missing a texture source');

      const assetData = this.buildAssetDataFromTile(doc);
      if (!assetData) throw new Error('Unable to derive asset data from tile');

      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      manager.cancelPlacement('replace');

      manager.currentAsset = assetData;
      manager.isPlacementActive = true;
      manager.isStickyMode = false;
      manager.isRandomMode = false;
      manager.randomAssets = [];
      manager._editingTile = doc;
      manager._replaceOriginalOnPlace = true;
      manager._isEditingExistingTile = true;
      manager._scatterMode = this.scatterModeSingle;
      manager._stopScatterStroke();
      manager._clearScatterOverlay();
      manager._pendingEditState = null;

      this.hideSourceTile(doc, { suspendShadow: true });

      const centerWorld = this.resolveEditCenterWorld(doc, options);
      const pointerOption = this.resolveEditPointerScreen(centerWorld, options);

      this.ensurePointerSnapshot({
        pointer: pointerOption || options.pointer || null,
        pointerWorld: options.pointerWorld || centerWorld
      });

      const initialElevation = Number.isFinite(doc.elevation)
        ? Number(doc.elevation)
        : resolveInitialFaNexusPlacementElevation({ fallback: manager._lastElevationUsed });
      manager._previewElevation = initialElevation;
      manager._lastElevationUsed = manager._previewElevation;
      manager._previewSort = Number(doc.sort ?? 0) || 0;
      manager._previewRenderSort = manager._previewSort;
      manager._previewPlacementLevelId = manager._resolveDocumentPlacementLevelId(doc);
      manager._placementSortAnchorTileId = doc?.id || null;
      manager._placementSortAnchorPlacementLevelId = manager._previewPlacementLevelId;
      manager._placementSortBeforeAnchor = false;
      manager._lastElevationAnnounce = 0;
      manager._clearElevationAnnounceTimer();

      manager._activateToolOptions();
      manager._activateTilesLayer();
      manager._removePreviewElement();
      manager._createPreviewElement();

      if (manager._previewContainer) {
        manager._previewContainer.x = centerWorld.x;
        manager._previewContainer.y = centerWorld.y;
      }
      manager._lastPointer = null;
      manager._lastPointerWorld = { ...centerWorld };

      this.applyTileStateToPlacement(doc, { force: true });
      manager._isEditingExistingTile = false;
      manager._refreshShadowElevationContext({ adopt: false, sync: true });
      manager._syncToolOptionsState({ suppressRender: false });
      manager._setPlacementFreeze(true, { announce: false });
      // The freeze snaps to the grid. The asset is shown where its Tile stands, on the grid or
      // off it, until it is carried somewhere; saving it untouched then leaves it there.
      if (manager._previewFrozen) {
        manager._frozenPreviewExact = true;
        manager._lastPointerWorld = { ...centerWorld };
        manager._applyPreviewAnchor({ ...centerWorld });
      }

      manager._startInteractionSession();
      return true;
    } catch (error) {
      Logger.warn('Placement.editTile.failed', String(error?.message || error));
      ui.notifications?.error?.(`Unable to edit asset: ${error?.message || error}`);
      manager._restoreEditingTileVisibility();
      manager._resumeEditingTileShadow();
      manager._editingTileObject = null;
      manager._editingTileVisibilitySnapshot = null;
      manager._editingTile = null;
      manager._isEditingExistingTile = false;
      manager._pendingEditState = null;
      manager._replaceOriginalOnPlace = false;
      manager._editingTileShadowSuspended = false;
      return false;
    }
  }

  async editScatterTile(doc, payload, options = {}) {
    const manager = this.manager;
    try {
      manager.cancelPlacement('replace');
      manager.isPlacementActive = true;
      manager.isStickyMode = false;
      manager._scatterMode = this.scatterModeBrush;
      manager._restorePlacementTransformState({ mode: manager._scatterMode, regenerateOffsets: true });
      manager._scatterPainting = false;
      manager._scatterLastPointerWorld = null;
      manager._scatterStrokeDistance = 0;
      manager._scatterMergeBeforeEdit = manager._scatterMergeEnabled;
      manager._scatterMergeEnabled = true;
      manager._scatterEditing = true;
      manager._scatterEraseEnabled = false;
      manager._scatterEditTile = doc;
      manager._previewFrozen = false;
      manager._hsbc = readDocumentHsbc(doc, { nullIfMissing: false }) || createNeutralHsbc();
      this.applyScatterAppearanceFromTile(doc);

      const instances = manager._normalizeScatterInstances(payload.instances || []);
      const textureSources = [...new Set(instances.map((instance) => instance.src).filter(Boolean))];
      const loadedTextures = new Map(await Promise.all(textureSources.map(async (src) => [src, await loadTexture(src)])));
      if (!manager.isPlacementActive || !manager._scatterEditing || manager._scatterEditTile !== doc) return;

      manager._scatterCommitWorkflow.captureEditSessionStart(doc);
      this.hideSourceTile(doc, { suspendShadow: true });
      const editState = createScatterEditState({ instances, tile: doc });
      editState.appearanceSignature = manager._buildScatterEditAppearanceSignature();
      manager._scatterEditState = editState;
      const worldInstances = editState.worldInstances;
      const referenceInstance = worldInstances.find((instance) => instance?.src);
      // The asset of the session has the size of its picture, as a freshly chosen asset has. A saved instance is
      // already scaled: taken for the asset's size, the scale settings were applied to it a second time.
      const referenceSize = referenceInstance
        ? this.resolveAssetSceneSize(loadedTextures.get(referenceInstance.src))
        : null;
      if (referenceInstance && !referenceSize) {
        throw new Error('Scatter Edit could not read the size of its asset picture.');
      }
      manager.currentAsset = referenceInstance
        ? this.buildAssetDataFromTile({
          texture: { src: referenceInstance.src },
          width: referenceSize.width,
          height: referenceSize.height
        })
        : null;
      manager.isRandomMode = false;
      manager.randomAssets = [];
      if (!manager.currentAsset) {
        throw new Error('Scatter Edit could not derive an active asset from its persisted instances.');
      }

      const initialElevation = Number.isFinite(doc.elevation)
        ? Number(doc.elevation)
        : resolveInitialFaNexusPlacementElevation({ fallback: manager._lastElevationUsed });
      manager._previewElevation = initialElevation;
      manager._lastElevationUsed = manager._previewElevation;
      manager._previewSort = Number(doc.sort ?? 0) || 0;
      manager._previewRenderSort = manager._previewSort;
      manager._previewPlacementLevelId = manager._resolveDocumentPlacementLevelId(doc);
      manager._beginScatterPreviewSession(worldInstances, { elevation: manager._previewElevation });
      manager._applyScatterPreviewHsbc();
      manager._resetScatterHistory();
      manager._recordScatterHistorySnapshot({ force: true });

      const centerWorld = this.resolveEditCenterWorld(doc, options);
      const pointerOption = this.resolveEditPointerScreen(centerWorld, options);

      manager._scatterEditPointerLockScreen = this.captureInteractionPointerLockScreen();

      this.ensurePointerSnapshot({
        pointer: pointerOption || options.pointer || null,
        pointerWorld: options.pointerWorld || centerWorld
      });
      manager._syncScatterPreviewOrdering();
      manager._activateToolOptions();
      manager._activateTilesLayer();
      manager._ensureScatterOverlay();
      manager._startInteractionSession();
      manager._addPlacementFeedback();
    } catch (error) {
      Logger.warn('Placement.editScatter.failed', String(error?.message || error));
      globalThis.ui?.notifications?.error?.(`Unable to edit Scatter Tile: ${error?.message || error}`);
      manager._scatterEditState = null;
      manager.cancelPlacement('error');
      return false;
    }
    return true;
  }

  applyScatterAppearanceFromTile(doc) {
    const manager = this.manager;
    const readFlag = (key, fallback) => {
      const value = doc?.getFlag?.('fa-nexus', key);
      if (value === undefined || value === null) return fallback;
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : fallback;
    };
    manager._dropShadowPreference = !!doc?.getFlag?.('fa-nexus', 'shadow');
    manager._dropShadowOnly = !!doc?.getFlag?.('fa-nexus', 'shadowOnly');
    manager._dropShadowAlpha = Math.min(1, Math.max(0, readFlag('shadowAlpha', manager._dropShadowAlpha)));
    manager._dropShadowBlur = Math.max(0, readFlag('shadowBlur', manager._dropShadowBlur));
    manager._dropShadowDilation = Math.min(
      MAX_SHADOW_DILATION,
      Math.max(0, readFlag('shadowDilation', manager._dropShadowDilation))
    );
    let offsetDistance = readFlag('shadowOffsetDistance', manager._dropShadowOffsetDistance);
    let offsetAngle = readFlag('shadowOffsetAngle', manager._dropShadowOffsetAngle);
    const offsetX = readFlag('shadowOffsetX', null);
    const offsetY = readFlag('shadowOffsetY', null);
    if (Number.isFinite(offsetX) && Number.isFinite(offsetY)) {
      offsetDistance = Math.hypot(offsetX, offsetY);
      // A zero-length offset has no direction of its own: the stored angle stays.
      if (offsetDistance > 0) offsetAngle = Math.atan2(offsetY, offsetX) * (180 / Math.PI);
    }
    manager._dropShadowOffsetDistance = Math.min(manager._getShadowOffsetMax(), Math.max(0, offsetDistance));
    manager._dropShadowOffsetAngle = manager._normalizeShadowAngle(offsetAngle);
    manager._refreshShadowElevationContext({ adopt: false, sync: true });
    manager._notifyDropShadowChanged();
  }

  applyTileStateToPlacement(tileDocument, { force = false } = {}) {
    const manager = this.manager;
    try {
      if (!tileDocument) return;
      const doc = tileDocument.document ?? tileDocument;
      if (!doc) return;
      manager._editingTile = doc;
      const shadowEnabled = !!doc.getFlag('fa-nexus', 'shadow');
      manager._dropShadowPreference = shadowEnabled ? true : false;
      manager._dropShadowOnly = !!doc.getFlag('fa-nexus', 'shadowOnly');

      const readFlag = (key, fallback) => {
        try {
          const value = doc.getFlag('fa-nexus', key);
          if (value === undefined || value === null) return fallback;
          const numeric = Number(value);
          return Number.isFinite(numeric) ? numeric : fallback;
        } catch (_) {
          return fallback;
        }
      };

      const alpha = readFlag('shadowAlpha', manager._dropShadowAlpha);
      manager._dropShadowAlpha = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : manager._dropShadowAlpha));

      const blur = readFlag('shadowBlur', manager._dropShadowBlur);
      manager._dropShadowBlur = Math.max(0, Number.isFinite(blur) ? blur : manager._dropShadowBlur);

      const dilation = readFlag('shadowDilation', manager._dropShadowDilation);
      manager._dropShadowDilation = Math.min(MAX_SHADOW_DILATION, Math.max(0, Number.isFinite(dilation) ? dilation : manager._dropShadowDilation));

      let offsetDistance = readFlag('shadowOffsetDistance', manager._dropShadowOffsetDistance);
      offsetDistance = Math.min(manager._getShadowOffsetMax(), Math.max(0, Number.isFinite(offsetDistance) ? offsetDistance : manager._dropShadowOffsetDistance));
      let offsetAngle = readFlag('shadowOffsetAngle', manager._dropShadowOffsetAngle);
      offsetAngle = manager._normalizeShadowAngle(Number.isFinite(offsetAngle) ? offsetAngle : manager._dropShadowOffsetAngle);
      let offsetX = readFlag('shadowOffsetX', null);
      let offsetY = readFlag('shadowOffsetY', null);
      if (Number.isFinite(offsetX) && Number.isFinite(offsetY)) {
        const length = Math.hypot(offsetX, offsetY);
        offsetDistance = Math.min(manager._getShadowOffsetMax(), length);
        // A zero-length offset has no direction of its own: the stored angle stays.
        if (length > 0) offsetAngle = manager._normalizeShadowAngle(Math.atan2(offsetY, offsetX) * (180 / Math.PI));
      } else {
        const vecFallback = manager._computeShadowOffsetVector(offsetDistance, offsetAngle);
        offsetX = vecFallback.x;
        offsetY = vecFallback.y;
      }
      manager._dropShadowOffsetDistance = offsetDistance;
      manager._dropShadowOffsetAngle = offsetAngle;
      manager._hsbc = readDocumentHsbc(doc, { nullIfMissing: false }) || createNeutralHsbc();

      const canApply = manager._isEditingExistingTile || force;
      if (!canApply) {
        manager._pendingEditState = { doc };
        manager._refreshShadowElevationContext({ adopt: false, sync: true });
        manager._notifyDropShadowChanged();
        return;
      }
      if (!manager._previewContainer) {
        manager._pendingEditState = { doc };
        manager._refreshShadowElevationContext({ adopt: false, sync: true });
        manager._notifyDropShadowChanged();
        return;
      }

      manager._pendingEditState = null;

      const center = getTileVisualCenterWorld(doc);
      manager._lastPointerWorld = { ...center };
      manager._previewContainer.x = center.x;
      manager._previewContainer.y = center.y;

      manager._previewElevation = Number(doc.elevation ?? 0) || 0;
      manager._lastElevationUsed = manager._previewElevation;
      manager._previewSort = Number(doc.sort ?? 0) || 0;
      manager._previewRenderSort = manager._previewSort;
      manager._previewPlacementLevelId = manager._resolveDocumentPlacementLevelId(doc);
      manager._applyPreviewHsbc();
      manager._syncPreviewOrdering();

      manager.currentRotation = manager._normalizeRotation(doc.rotation || 0);
      manager._pendingRotation = manager.currentRotation;
      manager._updateRotationPreview({ clampOffset: true });

      manager.currentScale = 1;
      manager._pendingScale = manager.currentScale;
      manager._updateScalePreview({ clampOffset: true });

      const texScaleX = Number(doc?.texture?.scaleX ?? 1);
      const texScaleY = Number(doc?.texture?.scaleY ?? 1);
      manager._flipHorizontal = texScaleX < 0;
      manager._flipVertical = texScaleY < 0;
      manager._pendingFlipHorizontal = manager._flipHorizontal;
      manager._pendingFlipVertical = manager._flipVertical;
      manager._applyPendingFlipToPreview({ forceShadow: true });
      manager._syncDropShadowOnlyPreview();

      manager._updatePreviewShadow({ force: true });

      manager._refreshShadowElevationContext({ adopt: false, sync: true });
      manager._notifyDropShadowChanged();
    } catch (error) {
      Logger.warn('Placement.applyTileState.failed', String(error?.message || error));
    }
  }

  ensurePointerSnapshot(options = {}) {
    const manager = this.manager;
    const snapshot = this.capturePointerSnapshot(options);
    if (snapshot?.screen) {
      manager._lastPointer = { x: snapshot.screen.x, y: snapshot.screen.y };
    } else if (!snapshot) {
      manager._lastPointer = null;
    }
    if (snapshot?.world) {
      manager._lastPointerWorld = { x: snapshot.world.x, y: snapshot.world.y };
    } else if (snapshot?.screen) {
      const world = manager._screenToCanvas(snapshot.screen.x, snapshot.screen.y);
      manager._lastPointerWorld = world ? { x: world.x, y: world.y } : null;
    } else if (!snapshot) {
      manager._lastPointerWorld = null;
    }
    return snapshot;
  }

  capturePointerSnapshot(options = {}) {
    const manager = this.manager;
    const explicitPointerWorld = (options?.pointerWorld && Number.isFinite(options.pointerWorld.x) && Number.isFinite(options.pointerWorld.y))
      ? { x: Number(options.pointerWorld.x), y: Number(options.pointerWorld.y) }
      : null;
    if (explicitPointerWorld) {
      const explicitPointer = (options?.pointer && Number.isFinite(options.pointer.x) && Number.isFinite(options.pointer.y))
        ? { x: Number(options.pointer.x), y: Number(options.pointer.y) }
        : (manager._canvasToScreen(explicitPointerWorld.x, explicitPointerWorld.y) || null);
      return {
        screen: explicitPointer,
        world: explicitPointerWorld
      };
    }

    const candidates = [];
    const push = (screen, world, weight) => {
      if (!screen) return;
      const x = Number(screen.x);
      const y = Number(screen.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const entry = {
        screen: { x, y },
        world: null,
        weight: Number(weight) || 0
      };
      if (world && Number.isFinite(world.x) && Number.isFinite(world.y)) {
        entry.world = { x: Number(world.x), y: Number(world.y) };
      }
      candidates.push(entry);
    };

    try {
      const pointerEvent = options?.pointerEvent;
      if (pointerEvent && typeof pointerEvent.clientX === 'number' && typeof pointerEvent.clientY === 'number') {
        const screen = { x: Number(pointerEvent.clientX), y: Number(pointerEvent.clientY) };
        const world = manager._screenToCanvas(screen.x, screen.y);
        const weight = this.isScreenPointOnCanvas(screen) ? 6 : 2.5;
        push(screen, world, weight);
      }
    } catch (_) { /* no-op */ }

    if (options?.pointer && Number.isFinite(options.pointer.x) && Number.isFinite(options.pointer.y)) {
      const screen = { x: Number(options.pointer.x), y: Number(options.pointer.y) };
      const pointerWorld = options.pointerWorld;
      const world = (pointerWorld && Number.isFinite(pointerWorld.x) && Number.isFinite(pointerWorld.y))
        ? { x: Number(pointerWorld.x), y: Number(pointerWorld.y) }
        : manager._screenToCanvas(screen.x, screen.y);
      const weight = this.isScreenPointOnCanvas(screen) ? 5 : 2;
      push(screen, world, weight);
    }

    try {
      const controllerState = manager._interactionController?.getPointerState?.();
      if (controllerState?.screen && Number.isFinite(controllerState.screen.x) && Number.isFinite(controllerState.screen.y)) {
        const screen = { x: Number(controllerState.screen.x), y: Number(controllerState.screen.y) };
        const world = (controllerState.world && Number.isFinite(controllerState.world.x) && Number.isFinite(controllerState.world.y))
          ? { x: Number(controllerState.world.x), y: Number(controllerState.world.y) }
          : manager._screenToCanvas(screen.x, screen.y);
        const weight = this.isScreenPointOnCanvas(screen) ? 4 : 1.5;
        push(screen, world, weight);
      }
    } catch (_) { /* no-op */ }

    const rendererPointer = this.resolveRendererPointer();
    if (rendererPointer) {
      const world = manager._screenToCanvas(rendererPointer.x, rendererPointer.y);
      const weight = this.isScreenPointOnCanvas(rendererPointer) ? 4.5 : 1.8;
      push(rendererPointer, world, weight);
    }

    if (!candidates.length) {
      const width = (typeof window !== 'undefined' && typeof window.innerWidth === 'number') ? window.innerWidth : 1920;
      const height = (typeof window !== 'undefined' && typeof window.innerHeight === 'number') ? window.innerHeight : 1080;
      const screen = { x: width / 2, y: height / 2 };
      const world = manager._screenToCanvas(screen.x, screen.y);
      push(screen, world, 0);
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.weight - a.weight);
    const best = candidates[0];
    return {
      screen: best.screen,
      world: best.world
    };
  }

  isScreenPointOnCanvas(point) {
    const manager = this.manager;
    if (!point) return false;
    try {
      const canvasEl = manager._interactionController?.getCanvasElement?.();
      const rect = canvasEl?.getBoundingClientRect?.();
      if (!rect) return false;
      const x = Number(point.x);
      const y = Number(point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    } catch (_) {
      return false;
    }
  }

  resolveRendererPointer() {
    const manager = this.manager;
    try {
      const canvasEl = manager._interactionController?.getCanvasElement?.();
      const rect = canvasEl?.getBoundingClientRect?.();
      if (!rect) return null;
      const candidates = [];
      const add = (pt, weight = 1) => {
        if (!pt) return;
        const x = Number(pt.x);
        const y = Number(pt.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        candidates.push({ x: rect.left + x, y: rect.top + y, weight: Number(weight) || 1 });
      };

      const eventPointer = canvas?.app?.renderer?.events?.pointer?.global;
      if (eventPointer) add(eventPointer, 2.2);

      const interactionPointer = canvas?.app?.renderer?.plugins?.interaction?.mouse?.global;
      if (interactionPointer) add(interactionPointer, 1.6);

      const eventSystemPointer = canvas?.app?.renderer?.eventSystem?.pointer?.global;
      if (eventSystemPointer) add(eventSystemPointer, 1.9);

      if (!candidates.length) return null;
      candidates.sort((a, b) => b.weight - a.weight);
      const top = candidates[0];
      return { x: top.x, y: top.y };
    } catch (_) {
      return null;
    }
  }

  /** The size of an asset picture in Scene pixels at scale 1: its pixels at the asset resolution, on this grid. */
  resolveAssetSceneSize(texture) {
    const pixelWidth = Number(texture?.orig?.width ?? texture?.width);
    const pixelHeight = Number(texture?.orig?.height ?? texture?.height);
    if (!(pixelWidth > 0) || !(pixelHeight > 0)) return null;
    const gridSize = Number(canvas?.scene?.grid?.size || 100) || 100;
    const perSquare = this.manager._getAssetBasePxPerSquare();
    return { width: pixelWidth * gridSize / perSquare, height: pixelHeight * gridSize / perSquare };
  }

  buildAssetDataFromTile(tileDocument) {
    try {
      const doc = tileDocument?.document ?? tileDocument;
      if (!doc) return null;
      const texture = doc.texture || {};
      const src = String(texture.src || '').trim();
      if (!src) return null;
      const gridSize = Number(canvas?.scene?.grid?.size || 100) || 100;
      const width = Math.max(1, Number(doc.width || 0) || gridSize);
      const height = Math.max(1, Number(doc.height || 0) || gridSize);
      const gridWidth = Math.max(0.01, width / gridSize);
      const gridHeight = Math.max(0.01, height / gridSize);
      const isRemote = /^https?:/i.test(src);
      const filename = src.split('/').pop() || '';
      return {
        source: isRemote ? 'cloud' : 'local',
        tier: isRemote ? 'premium' : 'local',
        file_path: src,
        folder_path: '',
        cachedLocalPath: src,
        path: src,
        url: src,
        filename,
        grid_width: gridWidth,
        grid_height: gridHeight,
        width,
        height,
        actual_width: width,
        actual_height: height
      };
    } catch (error) {
      Logger.warn('Placement.assetDataFromTile.failed', String(error?.message || error));
      return null;
    }
  }

  hideSourceTile(doc, { suspendShadow = false } = {}) {
    const manager = this.manager;
    const tileObj = doc?.object || null;
    manager._editingTileObject = tileObj || null;
    manager._editingTileVisibilitySnapshot = tileObj ? manager._captureTileVisibility(tileObj) : null;
    if (tileObj) {
      manager._releaseTileSelection(tileObj);
      manager._hideTileForEditing(tileObj);
    }
    if (suspendShadow) manager._editingTileShadowSuspended = manager._suspendEditingTileShadow(doc);
  }

  resolveEditCenterWorld(doc, options = {}) {
    if (options.pointerWorld && Number.isFinite(options.pointerWorld.x) && Number.isFinite(options.pointerWorld.y)) {
      return { x: Number(options.pointerWorld.x), y: Number(options.pointerWorld.y) };
    }
    return getTileVisualCenterWorld(doc);
  }

  resolveEditPointerScreen(centerWorld, options = {}) {
    if (options.pointer && Number.isFinite(options.pointer.x) && Number.isFinite(options.pointer.y)) {
      return { x: Number(options.pointer.x), y: Number(options.pointer.y) };
    }
    if (canvas?.stage && centerWorld) {
      try {
        const stagePoint = canvas.stage.worldTransform.apply(new PIXI.Point(centerWorld.x, centerWorld.y));
        const canvasEl = canvas.app?.view || document.querySelector('canvas#board');
        if (canvasEl) {
          const rect = canvasEl.getBoundingClientRect();
          return { x: rect.left + stagePoint.x, y: rect.top + stagePoint.y };
        }
      } catch (_) {}
    }
    return null;
  }

  captureInteractionPointerLockScreen() {
    const manager = this.manager;
    try {
      const controllerScreen = manager._interactionController?.getPointerState?.()?.screen;
      if (controllerScreen && Number.isFinite(controllerScreen.x) && Number.isFinite(controllerScreen.y)) {
        return { x: Number(controllerScreen.x), y: Number(controllerScreen.y) };
      }
    } catch (_) {}
    const rendererPointer = this.resolveRendererPointer();
    if (rendererPointer && Number.isFinite(rendererPointer.x) && Number.isFinite(rendererPointer.y)) {
      return { x: Number(rendererPointer.x), y: Number(rendererPointer.y) };
    }
    if (manager._lastPointer && Number.isFinite(manager._lastPointer.x) && Number.isFinite(manager._lastPointer.y)) {
      return { x: Number(manager._lastPointer.x), y: Number(manager._lastPointer.y) };
    }
    return null;
  }
}
