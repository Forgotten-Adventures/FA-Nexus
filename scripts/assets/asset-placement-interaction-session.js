import { getZoomAtCursorView } from '../canvas/canvas-pointer-utils.js';
import {
  isCommitShortcut,
  isGridSnapShortcut,
  isHelpShortcut,
  isPolarityShortcut
} from '../core/editor-shortcuts.js';
import {
  createManagedPlacementGestureSession,
  stopManagedPlacementGestureSession
} from '../core/placement/placement-session-utils.js';
import { toolOptionsController } from '../core/tool-options/tool-options-controller.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { routeLayerManagerPreviewWheelAdjustment } from '../layers/layer-manager-preview-placement-bridge.js';

function updatePlacementPointerSnapshot(manager, pointer) {
  const screen = pointer?.screen;
  if (screen) {
    manager._lastPointer = { x: screen.x, y: screen.y };
  }
  let worldCoords = pointer?.world || null;
  if ((!worldCoords || !Number.isFinite(worldCoords.x) || !Number.isFinite(worldCoords.y)) && screen) {
    worldCoords = manager._screenToCanvas(screen.x, screen.y);
  }
  if (worldCoords && Number.isFinite(worldCoords.x) && Number.isFinite(worldCoords.y)) {
    manager._lastPointerWorld = { x: worldCoords.x, y: worldCoords.y };
  }
  return worldCoords;
}

class AssetPlacementGestureHandlers {
  constructor(session) {
    this.session = session;
    this.manager = session.manager;
  }

  create() {
    const { manager, session } = this;

    const pointerMoveHandler = (event, { pointer }) => {
      if (!manager.isPlacementActive) return;
      if (manager._isEditingExistingTile) return;
      if (manager._scatterEditing && manager._scatterEditPointerLockScreen) {
        const incomingScreen = pointer?.screen && Number.isFinite(pointer.screen.x) && Number.isFinite(pointer.screen.y)
          ? { x: Number(pointer.screen.x), y: Number(pointer.screen.y) }
          : ((typeof event?.clientX === 'number' && typeof event?.clientY === 'number')
            ? { x: Number(event.clientX), y: Number(event.clientY) }
            : null);
        if (incomingScreen) {
          const dx = incomingScreen.x - manager._scatterEditPointerLockScreen.x;
          const dy = incomingScreen.y - manager._scatterEditPointerLockScreen.y;
          if (Math.hypot(dx, dy) <= 0.5) return;
        }
        manager._scatterEditPointerLockScreen = null;
      }
      manager._setScatterPolarityInvertHeld(!!event?.altKey && manager._scatterMode === session.scatterModeBrush && manager._scatterMergeEnabled, {
        sync: false
      });
      const worldCoords = updatePlacementPointerSnapshot(manager, pointer);
      let displayCoords = worldCoords;
      if (displayCoords && manager.currentAsset) {
        displayCoords = manager._applyGridSnapping(displayCoords);
      }
      manager._applyPreviewAnchor(manager._getPreviewAnchorWorld(displayCoords));

      if (session._suppressDragSelect && (event.buttons & 1) === 1 && pointer?.overCanvas && pointer?.zOk) {
        try {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
        } catch (_) { /* no-op */ }
      }

      if (manager._scatterMode === session.scatterModeBrush && manager._scatterPainting) {
        if ((event.buttons & 1) !== 1 || !pointer?.overCanvas || !pointer?.zOk) return;
        if (worldCoords && Number.isFinite(worldCoords.x) && Number.isFinite(worldCoords.y)) {
          manager._scatterPaintAtWorld(worldCoords.x, worldCoords.y);
        }
      }
    };

    const wheelHandler = (event, { pointer }) => {
      if (!manager.isPlacementActive) return;
      const screen = pointer?.screen;
      if (!pointer?.overCanvas || !pointer.zOk || !screen) return;

      if (session._gridSnapShortcutHeld && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        session._gridSnapShortcutPendingToggle = false;
        const delta = event.deltaY < 0 ? 1 : -1;
        void toolOptionsController.nudgeGridSnapSubdivision(delta);
        manager._refreshPlacementAfterGridSnapChange();
        return;
      }

      if (event.altKey) {
        try {
          routeLayerManagerPreviewWheelAdjustment(event, {
            nudgeSort: (direction) => manager._nudgePlacementSort(direction),
            nudgeElevation: (direction) => {
              const step = manager._resolveElevationStep(event);
              const current = Number.isFinite(manager._previewElevation) ? manager._previewElevation : 0;
              manager._setPreviewElevation(current + (direction * step), {
                announce: false,
                syncToolOptions: true,
                worldPoint: pointer?.world || null
              });
            }
          });
        } catch (error) {
          Logger.error('Placement.wheel.alt.failed', { error: String(error?.message || error) });
        }
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const baseStep = Number(manager._rotationStep || 15) || 15;
        const step = event.shiftKey ? 1 : baseStep;
        const dir = event.deltaY > 0 ? 1 : -1;
        if (manager._rotationRandomEnabled) {
          const range = manager._getRotationRandomRange();
          let nextMin = range.min + dir * step;
          let nextMax = range.max + dir * step;
          if (nextMin < 0) {
            nextMax = Math.min(359, nextMax - nextMin);
            nextMin = 0;
          }
          if (nextMax > 359) {
            nextMin = Math.max(0, nextMin - (nextMax - 359));
            nextMax = 359;
          }
          manager._rotationRandomMin = manager._clampRotationRandomValue(nextMin, range.min);
          manager._rotationRandomMax = manager._clampRotationRandomValue(Math.max(manager._rotationRandomMin, nextMax), range.max);
          manager._persistPlacementTransformSetting('assetPlacementRotationRandomMin', manager._rotationRandomMin);
          manager._persistPlacementTransformSetting('assetPlacementRotationRandomMax', manager._rotationRandomMax);
        } else {
          manager.currentRotation = ((manager.currentRotation + dir * step) % 360 + 360) % 360;
          manager._persistPlacementTransformSetting('assetPlacementRotation', manager.currentRotation);
        }
        manager._updateRotationPreview({ clampOffset: true });
        manager._syncToolOptionsState();
        return;
      }

      if (event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        try {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          const step = 1.05;
          const delta = Number(event.deltaY) || Number(event.deltaX) || 0;
          const dir = delta < 0 ? 1 : -1;
          if (manager._scatterMode === session.scatterModeBrush) {
            const current = manager._getScatterBrushSize();
            let next = current * Math.pow(step, dir);
            next = Math.round(next);
            manager.setScatterBrushSize(next, true);
            return;
          }
          if (manager._scaleRandomEnabled) {
            const range = manager._getScaleRandomRange();
            const factor = Math.pow(step, dir);
            const nextMin = manager._clampScaleRandomPercent(range.min * factor, range.min);
            const nextMax = manager._clampScaleRandomPercent(range.max * factor, range.max);
            manager._scaleRandomMin = Math.min(nextMin, nextMax);
            manager._scaleRandomMax = Math.max(nextMin, nextMax);
            manager._persistPlacementTransformSetting('assetPlacementScaleRandomMin', manager._scaleRandomMin);
            manager._persistPlacementTransformSetting('assetPlacementScaleRandomMax', manager._scaleRandomMax);
          } else {
            const current = Number(manager.currentScale || 1) || 1;
            let next = current * Math.pow(step, dir);
            next = manager._clampScale(next);
            manager.currentScale = next;
            manager._persistPlacementTransformSetting('assetPlacementScale', manager.currentScale);
          }
          manager._updateScalePreview({ clampOffset: true });
          manager._syncToolOptionsState();
        } catch (_) { /* no-op */ }
        return;
      }

      try {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const canvasEl = pointer?.canvas || manager._interactionController.getCanvasElement?.();
        if (!canvasEl) return;
        const stage = canvas?.stage; if (!stage) return;
        const currentScale = Number(stage.scale?.x || 1);
        const step = 1.25;
        const dir = event.deltaY < 0 ? 1 : -1;
        const targetScale = currentScale * Math.pow(step, dir);
        const view = getZoomAtCursorView({
          canvasEl,
          screenX: screen.x,
          screenY: screen.y,
          targetScale
        });
        if (!view) return;
        if (typeof canvas?.animatePan === 'function') {
          canvas.animatePan({ ...view, duration: 50 });
        } else {
          stage.scale.set(view.scale, view.scale);
          const rect = canvasEl.getBoundingClientRect();
          const centerX = rect.width / 2;
          const centerY = rect.height / 2;
          stage.position.set(centerX - view.scale * view.x, centerY - view.scale * view.y);
        }
      } catch (_) { /* no-op */ }
    };

    const pointerDownHandler = async (event, { pointer }) => {
      if (!manager.isPlacementActive) return;
      if (manager._scatterEditPointerLockScreen) manager._scatterEditPointerLockScreen = null;
      manager._setScatterPolarityInvertHeld(!!event?.altKey && manager._scatterMode === session.scatterModeBrush && manager._scatterMergeEnabled, {
        sync: false
      });
      if (event.button !== 0) return;
      if (manager._isEditingExistingTile) {
        try {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
        } catch (_) {}
        return false;
      }
      const screen = pointer?.screen;
      if (!pointer?.overCanvas || !pointer.zOk || !screen) return;
      updatePlacementPointerSnapshot(manager, pointer);
      session._suppressDragSelect = true;

      if (manager._scatterMode === session.scatterModeBrush) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        manager._scatterPainting = true;
        manager._scatterLastPointerWorld = null;
        manager._scatterStrokeDistance = 0;
        manager._beginScatterShadowBatch();
        manager._beginScatterPreviewShadowBatch();
        if (manager._scatterMergeEnabled) {
          if (manager._scatterEditing) {
            manager._ensureScatterPreviewOverlay();
          } else {
            manager._startScatterMergeSession();
          }
        }
        if (manager._lastPointerWorld) {
          manager._scatterPaintAtWorld(manager._lastPointerWorld.x, manager._lastPointerWorld.y);
        }
        return false;
      }

      if (manager.isDownloading) {
        const queued = (manager._previewFrozen && manager._frozenPointerScreen)
          ? { x: manager._frozenPointerScreen.x, y: manager._frozenPointerScreen.y }
          : { x: screen.x, y: screen.y };
        manager.queuedPlacement = queued;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        return false;
      }

      if (session._commitInFlight) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        return false;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      session._commitInFlight = true;
      try {
        await manager._handleCanvasPlacement(event, pointer);
      } finally {
        session._commitInFlight = false;
      }
      return false;
    };

    const pointerUpHandler = async () => {
      if (!manager.isPlacementActive) return;
      session._suppressDragSelect = false;
      if (manager._scatterMode === session.scatterModeBrush) {
        manager._scatterPainting = false;
        manager._scatterLastPointerWorld = null;
        manager._scatterStrokeDistance = 0;
        if (manager._scatterMergeEnabled) {
          await manager._scatterCommitSession.drainQueue({
            loggerTag: 'Placement.scatter.pointerUp.queueDrainFailed'
          });
          if (manager._scatterEditing) {
            try {
              await manager._commitScatterEditChanges();
            } catch (_) {
              // The authoritative workflow already logs and notifies. Keep the editable preview open.
            }
          }
          if (manager._scatterHistoryDirty) {
            manager._recordScatterHistorySnapshot();
            manager._syncToolOptionsState({ suppressRender: false });
          }
          await manager._endScatterPreviewShadowBatch({ awaitQueue: false });
        } else {
          await manager._endScatterShadowBatch({ awaitQueue: true });
        }
        manager._stopScatterStroke();
      }
    };

    const keyDownHandler = (event) => {
      if (!manager.isPlacementActive) return;
      manager._setScatterPolarityInvertHeld(!!event.altKey && manager._scatterMode === session.scatterModeBrush && manager._scatterMergeEnabled, {
        sync: !!event.altKey
      });
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        if (manager._scatterMode === session.scatterModeBrush && manager._scatterMergeEnabled) {
          void manager._requestScatterCancel({ source: 'escape' });
        } else {
          manager.cancelPlacement('esc');
        }
        return;
      }
      const keyName = typeof event?.key === 'string' ? event.key : '';
      const keyLower = keyName.toLowerCase();
      const hasModifier = !!(event.ctrlKey || event.metaKey);
      const isUndo = hasModifier && keyLower === 'z' && !event.shiftKey;
      const isRedo = hasModifier && (keyLower === 'y' || (keyLower === 'z' && event.shiftKey));
      if ((isUndo || isRedo) && manager._scatterMode === session.scatterModeBrush && manager._scatterMergeEnabled) {
        if (manager._shouldIgnorePlacementHotkey(event, keyName)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        void manager._handleEditorAction(isUndo ? 'scatter-undo' : 'scatter-redo');
        return;
      }
      if (typeof isHelpShortcut === 'function' && isHelpShortcut(event)) {
        if (manager._shouldIgnorePlacementHotkey(event, keyName)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        toolOptionsController.openActiveToolHelp?.({ focus: true });
        return;
      }
      if (isCommitShortcut(event) && manager._isExistingTileReplaceSession()) {
        if (manager._shouldIgnorePlacementHotkey(event, keyName)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        void manager._commitExistingTileReplaceFromShortcut();
        return;
      }
      if (isCommitShortcut(event) && manager._scatterMode === session.scatterModeBrush && manager._scatterMergeEnabled) {
        if (manager._shouldIgnorePlacementHotkey(event, keyName)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        void manager._handleEditorAction('scatter-commit');
        return;
      }
      if (isGridSnapShortcut(event)) {
        if (manager._shouldIgnorePlacementHotkey(event, keyName)) return;
        session._gridSnapShortcutHeld = true;
        if (!event.repeat) session._gridSnapShortcutPendingToggle = true;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        return;
      }
      if (manager._isEditingExistingTile) return;
      const elevationDirection = event.altKey ? manager._getElevationShortcutDirection(event) : 0;
      if (elevationDirection !== 0) {
        if (manager._shouldIgnorePlacementHotkey(event, keyName)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const step = manager._resolveElevationStep(event);
        const current = Number.isFinite(manager._previewElevation) ? manager._previewElevation : 0;
        manager._setPreviewElevation(current + (elevationDirection * step), {
          announce: true,
          syncToolOptions: true,
          worldPoint: manager._getElevationAnnouncePoint()
        });
        return;
      }
      if (isPolarityShortcut(event) && manager._scatterMode === session.scatterModeBrush && manager._scatterMergeEnabled) {
        if (manager._shouldIgnorePlacementHotkey(event, keyName)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        manager.setScatterEraserEnabled(!manager._scatterEraseEnabled);
        return;
      }
      const isSpace = event.code === 'Space' || event.key === ' ';
      if (!isSpace || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      if (manager._shouldIgnoreFreezeShortcut(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      manager._togglePlacementFreeze();
    };

    const keyUpHandler = (event) => {
      if (String(event?.key || '').toLowerCase() === 's') {
        const shouldToggle = session._gridSnapShortcutHeld && session._gridSnapShortcutPendingToggle;
        session._gridSnapShortcutHeld = false;
        session._gridSnapShortcutPendingToggle = false;
        if (shouldToggle) {
          event.preventDefault?.();
          event.stopPropagation?.();
          event.stopImmediatePropagation?.();
          void toolOptionsController.toggleGridSnapShortcut();
          manager._refreshPlacementAfterGridSnapChange();
        }
      }
      manager._setScatterPolarityInvertHeld(!!event.altKey && manager._scatterMode === session.scatterModeBrush && manager._scatterMergeEnabled, {
        sync: true
      });
    };

    return {
      pointermove: pointerMoveHandler,
      wheel: wheelHandler,
      pointerdown: pointerDownHandler,
      pointerup: pointerUpHandler,
      keydown: keyDownHandler,
      keyup: keyUpHandler
    };
  }
}

export class AssetPlacementInteractionSession {
  constructor(manager, { scatterModeBrush }) {
    this.manager = manager;
    this.scatterModeBrush = scatterModeBrush;
    this._gestureSession = null;
    this._suppressDragSelect = false;
    this._gridSnapShortcutHeld = false;
    this._gridSnapShortcutPendingToggle = false;
    this._commitInFlight = false;
  }

  start() {
    const manager = this.manager;
    this.stop();
    if (manager._scatterMode === this.scatterModeBrush) {
      manager._ensureScatterOverlay();
      manager._updateScatterCursor();
    }

    const handlers = new AssetPlacementGestureHandlers(this).create();

    this._gestureSession = createManagedPlacementGestureSession({
      pointermove: { handler: handlers.pointermove, respectZIndex: false },
      wheel: { handler: handlers.wheel, respectZIndex: true },
      pointerdown: handlers.pointerdown,
      pointerup: handlers.pointerup,
      pointercancel: handlers.pointerup,
      keydown: handlers.keydown,
      keyup: handlers.keyup
    }, {
      cancelPlacement: (reason) => manager.cancelPlacement(reason),
      lockTileInteractivity: true,
      onStop: () => this.cleanup()
    });

    manager._startZoomWatcher();
  }

  cleanup() {
    const manager = this.manager;
    this._gestureSession = null;
    manager._stopZoomWatcher();
    this._suppressDragSelect = false;
    this._gridSnapShortcutHeld = false;
    this._gridSnapShortcutPendingToggle = false;
    this._commitInFlight = false;
    manager._setScatterPolarityInvertHeld(false, { sync: false });
  }

  stop() {
    stopManagedPlacementGestureSession(this._gestureSession, {
      cleanup: () => this.cleanup()
    });
  }
}
