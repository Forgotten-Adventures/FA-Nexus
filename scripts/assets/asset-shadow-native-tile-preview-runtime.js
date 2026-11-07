import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { AssetShadowManager, getAssetShadowManager } from './asset-shadow-manager.js';
import { readNativeTileGestureRoute } from '../canvas/native-tile-gesture-route.js';
import { collectBuildingV2SceneTransformDependents } from '../buildings/v2/building-v2-transform-aggregate.js';

const PATCH_MARKER = Symbol.for('fa-nexus.asset-shadow-native-tile-preview');
const SESSION_KEY = Symbol.for('fa-nexus.asset-shadow-native-tile-preview-session');
const COMMIT_TIMEOUT_MS = 30_000;
const POSE_FIELDS = ['x', 'y', 'width', 'height', 'rotation'];

function tilePose(document) {
  return Object.fromEntries(POSE_FIELDS.map((key) => [key, Number(document?.[key]) || 0]));
}

function tileDocumentsForGesture(tile, event) {
  const sourceTile = readNativeTileGestureRoute(event)?.placeable || tile;
  const handleName = String(event?.interactionData?.handle?.name || '').trim();
  if (handleName && handleName !== 'translate') return sourceTile?.document ? [sourceTile.document] : [];
  const controlled = Array.from(sourceTile?.layer?.controlled || [])
    .map((placeable) => placeable?.document)
    .filter((document) => document?.documentName === 'Tile');
  if (controlled.length) return controlled;
  return sourceTile?.document ? [sourceTile.document] : [];
}

export function resolveAssetShadowNativePreviewDocuments(documents, {
  collectBuildingDependents = collectBuildingV2SceneTransformDependents
} = {}) {
  const resolved = new Map();
  const add = (document) => {
    const id = String(document?.id || '').trim();
    if (document?.documentName === 'Tile' && id && !resolved.has(id)) resolved.set(id, document);
  };
  for (const document of Array.from(documents || []).filter(Boolean)) {
    add(document);
    for (const dependent of collectBuildingDependents(document) || []) add(dependent);
  }
  return Array.from(resolved.values());
}

function reportFailure(scope, state, error) {
  const details = {
    source: state?.source || 'native-tile',
    tileIds: Array.from(state?.tileIds || []).sort(),
    suppression: error?.details || null,
    error: String(error?.message || error)
  };
  Logger.error(scope, details);
  globalThis.ui?.notifications?.error?.(
    'Tile shadow preview could not finish. See the console for details.'
  );
}

function signedAngleDelta(next, previous) {
  const delta = Number(next) - Number(previous);
  if (!Number.isFinite(delta)) return null;
  return ((delta + 540) % 360) - 180;
}

export class AssetShadowNativeTilePreviewRuntime {
  constructor({ commitTimeoutMs = COMMIT_TIMEOUT_MS } = {}) {
    this._statesByTileId = new Map();
    this._states = new Set();
    this._commitTimeoutMs = commitTimeoutMs;
  }

  initialize() {
    const Tile = foundry?.canvas?.placeables?.Tile;
    const prototype = Tile?.prototype;
    if (!prototype) throw new Error('Foundry v14 Tile is unavailable for shadow preview integration.');
    if (prototype[PATCH_MARKER]) return;

    const originalStart = prototype._onDragLeftStart;
    const originalMove = prototype._onDragLeftMove;
    const originalDrop = prototype._onDragLeftDrop;
    const originalCancel = prototype._onDragLeftCancel;
    if (![originalStart, originalMove, originalDrop, originalCancel].every((method) => typeof method === 'function')) {
      throw new Error('Foundry v14 Tile drag lifecycle is incomplete for shadow preview integration.');
    }

    const runtime = this;
    Object.defineProperty(prototype, PATCH_MARKER, { value: true, configurable: false });

    prototype._onDragLeftStart = function faNexusAssetShadowTileDragStart(event) {
      const result = originalStart.call(this, event);
      try {
        runtime._start(this, event);
      } catch (error) {
        reportFailure('AssetShadow.nativePreview.startFailed', null, error);
        throw error;
      }
      return result;
    };

    prototype._onDragLeftMove = function faNexusAssetShadowTileDragMove(event) {
      const result = originalMove.call(this, event);
      const state = event?.interactionData?.[SESSION_KEY] || null;
      try {
        runtime._updatePreview(state, event);
      } catch (error) {
        runtime._cancel(state, 'native-move-preview-failed');
        reportFailure('AssetShadow.nativePreview.moveFailed', state, error);
        throw error;
      }
      return result;
    };

    prototype._onDragLeftDrop = function faNexusAssetShadowTileDragDrop(event) {
      const state = event?.interactionData?.[SESSION_KEY] || null;
      try {
        runtime._prepareCommit(state, event);
        const result = originalDrop.call(this, event);
        runtime._finishDrop(state, event, result);
        return result;
      } catch (error) {
        runtime._cancel(state, 'native-drop-failed');
        reportFailure('AssetShadow.nativePreview.dropFailed', state, error);
        throw error;
      }
    };

    prototype._onDragLeftCancel = function faNexusAssetShadowTileDragCancel(event) {
      const state = event?.interactionData?.[SESSION_KEY] || null;
      try {
        return originalCancel.call(this, event);
      } finally {
        runtime._handleNativeCancel(state);
      }
    };

    Hooks.on('preUpdateTile', (document) => runtime._onPreUpdateTile(document));
    Hooks.on('updateTile', (document) => runtime._onUpdateTile(document));
    Hooks.on('canvasTearDown', () => runtime.clear('canvas-teardown'));
    Hooks.on('canvasReady', () => runtime.clear('canvas-ready'));
    Logger.info('AssetShadow.nativeTilePreview.initialized');
  }

  _start(tile, event) {
    const existing = event?.interactionData?.[SESSION_KEY];
    if (existing && existing.phase !== 'done') return existing;
    const shadowEnabled = game?.settings?.get?.('fa-nexus', 'assetDropShadow') === true;
    const manager = AssetShadowManager.peek?.() || (shadowEnabled ? getAssetShadowManager() : null);
    if (!manager) return;
    const gestureDocuments = tileDocumentsForGesture(tile, event);
    const documentsById = new Map();
    const tileIdsByGestureTileId = new Map();
    for (const document of gestureDocuments) {
      const participants = resolveAssetShadowNativePreviewDocuments([document]);
      tileIdsByGestureTileId.set(String(document.id), participants.map((entry) => String(entry.id)));
      for (const entry of participants) documentsById.set(String(entry.id), entry);
    }
    const documents = Array.from(documentsById.values());
    const tileIds = new Set(documents.map((document) => String(document?.id || '')).filter(Boolean));
    if (!tileIds.size) return;
    const handleName = String(event?.interactionData?.handle?.name || 'move').trim() || 'move';
    const source = `native-tile-${handleName}`;
    const operation = ['move', 'translate'].includes(handleName)
      ? 'translate'
      : handleName === 'rotate'
        ? 'rotate'
        : 'suppress';
    const pivot = operation === 'rotate' && gestureDocuments.length === 1
      ? { x: Number(gestureDocuments[0]?.x), y: Number(gestureDocuments[0]?.y) }
      : null;
    const suppression = manager.beginTransformPreviewSuppression({ documents, source, operation, pivot });
    const state = {
      source,
      operation,
      tileIds,
      tileIdsByGestureTileId,
      documents,
      originByTileId: new Map(documents.map((document) => [
        String(document?.id || ''),
        tilePose(document)
      ])),
      originRotationByTileId: new Map(documents.map((document) => [
        String(document?.id || ''),
        Number(document?.rotation) || 0
      ])),
      pivotByTileId: new Map(documents.map((document) => [
        String(document?.id || ''),
        { x: Number(document?.x) || 0, y: Number(document?.y) || 0 }
      ])),
      layers: new Set(documents.map((document) => document?.object?.layer).filter(Boolean)),
      updateStartedTileIds: new Set(),
      updatedTileIds: new Set(),
      suppression,
      phase: 'preview',
      timer: null
    };
    this._states.add(state);
    for (const id of tileIds) this._statesByTileId.set(id, state);
    event.interactionData[SESSION_KEY] = state;
  }

  _updatePreview(state, event) {
    if (state?.operation === 'translate') return this._updateTranslation(state, event);
    if (state?.operation === 'rotate') return this._updateRotation(state, event);
    return false;
  }

  _updateTranslation(state, event) {
    if (!state || state.phase !== 'preview' || state.operation !== 'translate') return false;
    // ShapeControls uses one preview for the move handle; body drags use clones.
    // Both documents already contain Foundry's resolved/snapped world pose.
    const interaction = event?.interactionData;
    const clones = [interaction?.preview, ...Array.from(interaction?.clones || [])].filter(Boolean);
    for (const clone of clones) {
      const id = String(clone?._original?.document?.id || clone?._original?.id || '').trim();
      const origin = state.originByTileId?.get?.(id);
      if (!origin || !state.tileIds.has(id)) continue;
      const x = Number(clone?.document?.x);
      const y = Number(clone?.document?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      return state.suppression?.updateTranslation?.({ x: x - origin.x, y: y - origin.y }) === true;
    }

    const shapeOrigin = interaction?.shape?.origin;
    const pointerOrigin = interaction?.origin;
    const offset = interaction?.offset;
    if (
      Number.isFinite(Number(shapeOrigin?.x))
      && Number.isFinite(Number(shapeOrigin?.y))
      && Number.isFinite(Number(pointerOrigin?.x))
      && Number.isFinite(Number(pointerOrigin?.y))
      && Number.isFinite(Number(offset?.x))
      && Number.isFinite(Number(offset?.y))
    ) {
      return state.suppression?.updateTranslation?.({
        x: Number(shapeOrigin.x) - (Number(pointerOrigin.x) - Number(offset.x)),
        y: Number(shapeOrigin.y) - (Number(pointerOrigin.y) - Number(offset.y))
      }) === true;
    }
    return false;
  }

  _updateRotation(state, event) {
    if (!state || state.phase !== 'preview' || state.operation !== 'rotate') return false;
    const preview = event?.interactionData?.preview || null;
    const id = String(preview?._original?.document?.id || preview?._original?.id || '').trim();
    const originalRotation = state.originRotationByTileId?.get?.(id);
    const pivot = state.pivotByTileId?.get?.(id);
    const angle = signedAngleDelta(preview?.document?.rotation, originalRotation);
    if (!id || !state.tileIds.has(id) || angle == null || !pivot) return false;
    return state.suppression?.updateRotation?.({ angle, pivot: { ...pivot } }) === true;
  }

  _handoff(state) {
    if (!state || state.phase !== 'preview') return;
    state.phase = 'commit';
    state.timer = globalThis.setTimeout?.(() => {
      if (state.phase !== 'commit') return;
      const pendingIds = Array.from(state.commitTileIds || state.tileIds)
        .filter((id) => !state.updatedTileIds.has(id));
      const error = new Error(`Timed out waiting for authoritative Tile updates: ${pendingIds.sort().join(', ')}.`);
      this._cancel(state, 'native-commit-timeout', { clearNativePreview: true });
      reportFailure('AssetShadow.nativePreview.commitTimeout', state, error);
    }, this._commitTimeoutMs);
  }

  _finishDrop(state, event, result) {
    if (!state || state.phase !== 'preview') return false;
    if (result === false || event?.interactionData?.clearPreviewContainer !== false) {
      const reason = result === false
        ? 'native-drop-rejected'
        : 'native-drop-not-committed';
      this._cancel(state, reason);
      return false;
    }
    if (state.commitTileIds?.size === 0) {
      this._cancel(state, 'native-drop-pose-unchanged');
      return false;
    }
    this._handoff(state);
    return true;
  }

  _prepareCommit(state, event) {
    if (!state || state.phase !== 'preview') return;
    const interaction = event?.interactionData;
    const previews = [interaction?.preview, ...Array.from(interaction?.others || []),
      ...Array.from(interaction?.clones || [])].filter(Boolean);
    if (previews.length) {
      // Foundry calls preUpdateTile before removing empty diffs. A quick drag
      // that snaps back can therefore start an update but never emit updateTile.
      // Capture the final participants before native drop destroys its previews
      // or Building handoff adopts their pose into the original documents.
      const changed = previews.filter((preview) => {
        const original = preview._original?.document;
        const origin = state.originByTileId.get(String(original?.id || ''));
        const final = tilePose(preview.document);
        return origin && POSE_FIELDS.some((key) => final[key] !== origin[key]);
      }).map((preview) => String(preview._original.document.id));
      // Use the validated gesture-start aggregate. Linked artwork may already
      // hold its preview pose here, before the original Root adopts that pose.
      state.commitTileIds = new Set(changed.flatMap((id) => state.tileIdsByGestureTileId.get(id) || []));
      if (!state.commitTileIds.size) return;
    }
    state.suppression?.prepareCommit?.();
  }

  _onPreUpdateTile(document) {
    const id = String(document?.id || '').trim();
    const state = id ? this._statesByTileId.get(id) : null;
    if (!state || !['preview', 'commit'].includes(state.phase)) return;
    state.updateStartedTileIds.add(id);
  }

  _onUpdateTile(document) {
    const id = String(document?.id || '').trim();
    const state = id ? this._statesByTileId.get(id) : null;
    if (!state || state.phase !== 'commit') return;
    state.updatedTileIds.add(id);
    if (!Array.from(state.commitTileIds || state.tileIds).every((id) => state.updatedTileIds.has(id))) return;
    this._clearTimer(state);
    state.phase = 'rebuild';
    queueMicrotask(async () => {
      try {
        await this._completeSuppressionHandoff(state);
        state.phase = 'done';
        this._remove(state);
      } catch (error) {
        state.phase = 'failed';
        state.suppression?.abandon?.('native-rebuild-handoff-failed');
        this._clearNativePreview(state);
        this._remove(state);
        reportFailure('AssetShadow.nativePreview.rebuildHandoffFailed', state, error);
      }
    });
  }

  async _completeSuppressionHandoff(state) {
    try {
      return await state.suppression.commit();
    } catch (firstError) {
      Logger.warn('AssetShadow.nativePreview.rebuildHandoffRetry', {
        source: state.source,
        tileIds: Array.from(state.tileIds).sort(),
        error: String(firstError?.message || firstError)
      });
      return await state.suppression.commit();
    }
  }

  _cancel(state, reason, { clearNativePreview = false } = {}) {
    if (!state || state.phase === 'done') return;
    this._clearTimer(state);
    state.suppression?.cancel?.();
    if (clearNativePreview) this._clearNativePreview(state);
    state.phase = 'done';
    this._remove(state);
    Logger.debug?.('AssetShadow.nativePreview.cancelled', {
      reason,
      source: state.source,
      tileIds: Array.from(state.tileIds).sort()
    });
  }

  _handleNativeCancel(state) {
    if (!state || state.phase === 'done') return false;
    if (state.phase === 'preview') {
      this._cancel(state, 'native-cancel');
      return true;
    }
    if (state.phase !== 'commit' || state.finalizeCheckQueued) return false;
    state.finalizeCheckQueued = true;
    globalThis.setTimeout?.(() => {
      state.finalizeCheckQueued = false;
      if (state.phase !== 'commit' || state.updateStartedTileIds.size) return;
      this._cancel(state, 'native-finalize-without-update');
    }, 0);
    return false;
  }

  _clearTimer(state) {
    if (state?.timer != null) globalThis.clearTimeout?.(state.timer);
    if (state) state.timer = null;
  }

  _clearNativePreview(state) {
    for (const layer of state?.layers || []) {
      try {
        layer?.clearPreviewContainer?.();
      } catch (error) {
        reportFailure('AssetShadow.nativePreview.previewCleanupFailed', state, error);
      }
    }
    for (const document of state?.documents || []) {
      document?.object?.renderFlags?.set?.({
        refreshPosition: true,
        refreshTransform: true,
        refreshState: true
      });
    }
  }

  _remove(state, { preserveSuppression = false } = {}) {
    this._clearTimer(state);
    this._states.delete(state);
    for (const id of state?.tileIds || []) {
      if (this._statesByTileId.get(id) === state) this._statesByTileId.delete(id);
    }
    if (!preserveSuppression) state.suppression = null;
  }

  clear(reason = 'manual') {
    for (const state of Array.from(this._states)) this._cancel(state, reason);
  }
}

export const assetShadowNativeTilePreviewRuntime = new AssetShadowNativeTilePreviewRuntime();
if (globalThis.foundry?.canvas?.placeables?.Tile) {
  assetShadowNativeTilePreviewRuntime.initialize();
}
