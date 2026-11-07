import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { doorTransformPreviewRuntime } from './door-transform-preview-runtime.js';

const PATCH_MARKER = Symbol.for('fa-nexus.door-transform-native-tile-preview');
const SESSION_KEY = Symbol.for('fa-nexus.door-transform-native-tile-preview-session');
const COMMIT_TIMEOUT_MS = 10_000;

function tileDocumentsForGesture(tile, event) {
  const handleName = String(event?.interactionData?.handle?.name || '').trim();
  if (handleName && handleName !== 'translate') return tile?.document ? [tile.document] : [];
  const controlled = Array.from(tile?.layer?.controlled || [])
    .map((placeable) => placeable?.document)
    .filter((document) => document?.documentName === 'Tile');
  if (controlled.length) return controlled;
  return tile?.document ? [tile.document] : [];
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
    'Animated portal preview could not finish. See the console for details.'
  );
}

export class DoorTransformNativeTilePreviewRuntime {
  constructor({
    previewRuntime = doorTransformPreviewRuntime,
    commitTimeoutMs = COMMIT_TIMEOUT_MS
  } = {}) {
    this._previewRuntime = previewRuntime;
    this._statesByTileId = new Map();
    this._states = new Set();
    this._commitTimeoutMs = commitTimeoutMs;
  }

  initialize() {
    const Tile = globalThis.foundry?.canvas?.placeables?.Tile;
    const prototype = Tile?.prototype;
    if (!prototype) throw new Error('Foundry v14 Tile is unavailable for animated portal preview integration.');
    if (prototype[PATCH_MARKER]) return;

    const originalStart = prototype._onDragLeftStart;
    const originalDrop = prototype._onDragLeftDrop;
    const originalCancel = prototype._onDragLeftCancel;
    if (![originalStart, originalDrop, originalCancel].every((method) => typeof method === 'function')) {
      throw new Error('Foundry v14 Tile drag lifecycle is incomplete for animated portal preview integration.');
    }

    const runtime = this;
    Object.defineProperty(prototype, PATCH_MARKER, { value: true, configurable: false });

    prototype._onDragLeftStart = function faNexusDoorTransformTileDragStart(event) {
      const result = originalStart.call(this, event);
      try {
        runtime._start(this, event);
      } catch (error) {
        reportFailure('DoorTransform.nativePreview.startFailed', null, error);
        throw error;
      }
      return result;
    };

    prototype._onDragLeftDrop = function faNexusDoorTransformTileDragDrop(event) {
      const state = event?.interactionData?.[SESSION_KEY] || null;
      try {
        runtime._prepareCommit(state);
        const result = originalDrop.call(this, event);
        if (result === false) runtime._cancel(state, 'native-drop-rejected');
        else runtime._handoff(state);
        return result;
      } catch (error) {
        runtime._cancel(state, 'native-drop-failed');
        reportFailure('DoorTransform.nativePreview.dropFailed', state, error);
        throw error;
      }
    };

    prototype._onDragLeftCancel = function faNexusDoorTransformTileDragCancel(event) {
      const state = event?.interactionData?.[SESSION_KEY] || null;
      try {
        return originalCancel.call(this, event);
      } finally {
        runtime._cancel(state, 'native-cancel');
      }
    };

    Hooks.on('updateTile', (document) => runtime._onUpdateTile(document));
    Hooks.on('canvasTearDown', () => runtime.clear('canvas-teardown'));
    Hooks.on('canvasReady', () => runtime.clear('canvas-ready'));
    Logger.info('DoorTransform.nativeTilePreview.initialized');
  }

  _start(tile, event) {
    const documents = tileDocumentsForGesture(tile, event);
    const tileIds = new Set(documents.map((document) => String(document?.id || '')).filter(Boolean));
    if (!tileIds.size) return null;
    const handleName = String(event?.interactionData?.handle?.name || 'move').trim() || 'move';
    const source = `native-tile-${handleName}`;
    const suppression = this._previewRuntime.begin({ documents, source });
    if (!suppression) return null;
    const state = {
      source,
      tileIds,
      documents,
      layers: new Set(documents.map((document) => document?.object?.layer).filter(Boolean)),
      updatedTileIds: new Set(),
      suppression,
      phase: 'preview',
      timer: null
    };
    this._states.add(state);
    for (const id of tileIds) this._statesByTileId.set(id, state);
    event.interactionData[SESSION_KEY] = state;
    return state;
  }

  _prepareCommit(state) {
    if (!state || state.phase !== 'preview') return;
    state.suppression?.prepareCommit?.();
  }

  _handoff(state) {
    if (!state || state.phase !== 'preview') return;
    state.phase = 'commit';
    state.timer = globalThis.setTimeout?.(() => {
      if (state.phase !== 'commit') return;
      void this._handleCommitTimeout(state);
    }, this._commitTimeoutMs);
  }

  async _handleCommitTimeout(state) {
    if (!state || state.phase !== 'commit') return;
    this._clearTimer(state);
    state.phase = 'rollback';
    this._clearNativePreview(state);
    const error = new Error(
      `Timed out waiting for authoritative Tile updates: ${Array.from(state.tileIds).sort().join(', ')}.`
    );
    error.details = state.suppression?.describe?.('native-commit-timeout') || null;
    try {
      await state.suppression?.fail?.();
      state.phase = 'done';
      this._remove(state);
    } catch (rollbackError) {
      state.phase = 'failed';
      reportFailure('DoorTransform.nativePreview.rollbackHandoffFailed', state, rollbackError);
      this._remove(state);
    }
    reportFailure('DoorTransform.nativePreview.commitTimeout', state, error);
  }

  _onUpdateTile(document) {
    const id = String(document?.id || '').trim();
    const state = id ? this._statesByTileId.get(id) : null;
    if (!state || state.phase !== 'commit') return;
    state.updatedTileIds.add(id);
    if (state.updatedTileIds.size !== state.tileIds.size) return;
    this._clearTimer(state);
    state.phase = 'rebuild';
    queueMicrotask(async () => {
      try {
        await this._completeSuppressionHandoff(state);
        state.phase = 'done';
        this._remove(state);
      } catch (error) {
        state.phase = 'waiting-authoritative';
        this._clearNativePreview(state);
        reportFailure('DoorTransform.nativePreview.rebuildHandoffFailed', state, error);
        this._continueSuppressionHandoff(state);
      }
    });
  }

  async _completeSuppressionHandoff(state) {
    try {
      return await state.suppression.commit();
    } catch (firstError) {
      Logger.warn('DoorTransform.nativePreview.rebuildHandoffRetry', {
        source: state.source,
        tileIds: Array.from(state.tileIds).sort(),
        error: String(firstError?.message || firstError)
      });
      return await state.suppression.commit();
    }
  }

  _continueSuppressionHandoff(state) {
    const continuation = state?.suppression?.continueCommit?.();
    if (!continuation || typeof continuation.then !== 'function') {
      state.phase = 'failed';
      reportFailure(
        'DoorTransform.nativePreview.backgroundHandoffUnavailable',
        state,
        new Error('Animated portal suppression cannot continue waiting for authoritative renderers.')
      );
      return;
    }
    state.continuation = continuation;
    void continuation.then((completed) => {
      if (!completed || state.phase === 'done') return;
      state.phase = 'done';
      this._remove(state);
      Logger.info('DoorTransform.nativePreview.backgroundHandoffCompleted', {
        source: state.source,
        tileIds: Array.from(state.tileIds).sort()
      });
    }).catch((error) => {
      state.phase = 'failed';
      reportFailure('DoorTransform.nativePreview.backgroundHandoffFailed', state, error);
    }).finally(() => {
      if (state.continuation === continuation) state.continuation = null;
    });
  }

  _cancel(state, reason, { clearNativePreview = false } = {}) {
    if (!state || state.phase === 'done') return;
    this._clearTimer(state);
    state.suppression?.cancel?.();
    if (clearNativePreview) this._clearNativePreview(state);
    state.phase = 'done';
    this._remove(state);
    Logger.debug?.('DoorTransform.nativePreview.cancelled', {
      reason,
      source: state.source,
      tileIds: Array.from(state.tileIds).sort()
    });
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
        reportFailure('DoorTransform.nativePreview.previewCleanupFailed', state, error);
      }
    }
    for (const document of state?.documents || []) {
      document?.object?.renderFlags?.set?.({
        refreshPosition: true,
        refreshTransform: true,
        refreshShape: true,
        refreshState: true
      });
    }
  }

  _remove(state) {
    this._clearTimer(state);
    this._states.delete(state);
    for (const id of state?.tileIds || []) {
      if (this._statesByTileId.get(id) === state) this._statesByTileId.delete(id);
    }
    state.suppression = null;
  }

  clear(reason = 'manual') {
    for (const state of Array.from(this._states)) this._cancel(state, reason);
  }

  diagnostics() {
    return {
      sessionCount: this._states.size,
      tileIds: Array.from(this._statesByTileId.keys()).sort()
    };
  }
}

export const doorTransformNativeTilePreviewRuntime = new DoorTransformNativeTilePreviewRuntime();
if (globalThis.foundry?.canvas?.placeables?.Tile) {
  doorTransformNativeTilePreviewRuntime.initialize();
}
