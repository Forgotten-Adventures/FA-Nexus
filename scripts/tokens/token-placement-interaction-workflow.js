import { getZoomAtCursorView } from '../canvas/canvas-pointer-utils.js';
import { isGridSnapShortcut, isHelpShortcut } from '../core/editor-shortcuts.js';
import {
  createManagedPlacementGestureSession,
  stopManagedPlacementGestureSession
} from '../core/placement/placement-session-utils.js';
import { toolOptionsController } from '../core/tool-options/tool-options-controller.js';

export class TokenPlacementInteractionWorkflow {
  constructor(manager) {
    this.manager = manager;
    this._gestureSession = null;
    this._hoveredActorEl = null;
    this._pendingActorClickBlocker = null;
    this._suppressNextActorClick = false;
    this._gridSnapShortcutHeld = false;
    this._gridSnapShortcutPendingToggle = false;
  }

  start() {
    this.stop();
    const handlers = this._createHandlers();
    this._gestureSession = createManagedPlacementGestureSession({
      pointermove: { handler: handlers.pointermove, respectZIndex: false },
      wheel: { handler: handlers.wheel, respectZIndex: true },
      pointerdown: handlers.pointerdown,
      keydown: handlers.keydown,
      keyup: handlers.keyup
    }, {
      cancelPlacement: (reason) => this.manager.cancelPlacement(reason),
      lockCanvasLayer: 'tokens',
      onStop: () => this.cleanup()
    });
  }

  stop() {
    stopManagedPlacementGestureSession(this._gestureSession, {
      cleanup: () => this.cleanup()
    });
  }

  cleanup() {
    this._gestureSession = null;
    this._gridSnapShortcutHeld = false;
    this._gridSnapShortcutPendingToggle = false;
    this.clearActorHoverHighlight();
    this.teardownActorClickBlocker();
  }

  updateActorHoverHighlight(clientX, clientY) {
    const manager = this.manager;
    try {
      const actorEl = manager._findActorElement(clientX, clientY);
      if (actorEl === this._hoveredActorEl) return;
      if (this._hoveredActorEl) {
        try { this._hoveredActorEl.classList.remove('actor-drop-target'); } catch (_) {}
      }
      if (actorEl) {
        try { actorEl.classList.add('actor-drop-target'); } catch (_) {}
      }
      this._hoveredActorEl = actorEl || null;
    } catch (_) {}
  }

  clearActorHoverHighlight() {
    if (this._hoveredActorEl) {
      try { this._hoveredActorEl.classList.remove('actor-drop-target'); } catch (_) {}
      this._hoveredActorEl = null;
    }
  }

  clearActorHoverIf(actorEl) {
    if (this._hoveredActorEl === actorEl) this._hoveredActorEl = null;
  }

  installActorClickBlocker() {
    this._suppressNextActorClick = true;
    if (this._pendingActorClickBlocker) return;
    const blocker = (ev) => {
      if (!this._suppressNextActorClick) {
        document.removeEventListener('click', blocker, true);
        this._pendingActorClickBlocker = null;
        return;
      }
      ev.stopImmediatePropagation();
      ev.preventDefault();
      this._suppressNextActorClick = false;
      document.removeEventListener('click', blocker, true);
      this._pendingActorClickBlocker = null;
    };
    this._pendingActorClickBlocker = blocker;
    document.addEventListener('click', blocker, true);
  }

  teardownActorClickBlocker() {
    this._suppressNextActorClick = false;
    if (this._pendingActorClickBlocker) {
      document.removeEventListener('click', this._pendingActorClickBlocker, true);
      this._pendingActorClickBlocker = null;
    }
  }

  clearActorClickSuppression() {
    this._suppressNextActorClick = false;
  }

  _createHandlers() {
    const manager = this.manager;

    const pointerMoveHandler = (event, { pointer }) => {
      if (!manager.isPlacementActive) return;
      if (pointer?.screen) {
        manager._lastPointer = { x: pointer.screen.x, y: pointer.screen.y };
      }
      if (pointer?.world) {
        manager._lastPointerWorld = { x: pointer.world.x, y: pointer.world.y };
      } else if (pointer?.screen) {
        const world = manager._screenToWorld(pointer.screen.x, pointer.screen.y, pointer.canvas);
        if (world) manager._lastPointerWorld = world;
      }
      if (manager._preview?.box) {
        if (manager._preview.box.style.display === 'none') manager._preview.box.style.display = 'block';
        manager._updatePreviewPosition({ pointer });
      }
      if (pointer?.screen) {
        this.updateActorHoverHighlight(pointer.screen.x, pointer.screen.y);
      }
    };

    const wheelHandler = (event, { pointer }) => {
      if (!manager.isPlacementActive) return;
      if (!pointer?.overCanvas || !pointer.zOk) return;

      if (this._gridSnapShortcutHeld && !event.altKey && !event.ctrlKey && !event.metaKey) {
        this._gridSnapShortcutPendingToggle = false;
      }

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const baseStep = 15;
        const step = event.shiftKey ? baseStep / 3 : baseStep;
        const dir = event.deltaY > 0 ? 1 : -1;
        manager._rotation = ((manager._rotation + dir * step) % 360 + 360) % 360;
        manager._updateRotationPreview({ clampOffset: true });
        manager._syncToolOptionsState();
        return;
      }

      try {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const stage = canvas?.stage; if (!stage) return;
        const rect = pointer.canvas?.getBoundingClientRect();
        if (!rect) return;
        const currentScale = Number(stage.scale?.x || 1);
        const step = 1.25;
        const dir = event.deltaY < 0 ? 1 : -1;
        const targetScale = currentScale * Math.pow(step, dir);
        const view = getZoomAtCursorView({
          canvasEl: pointer.canvas,
          screenX: pointer.screen.x,
          screenY: pointer.screen.y,
          targetScale
        });
        if (!view) return;
        const centerX = rect.width / 2; const centerY = rect.height / 2;
        if (typeof canvas?.animatePan === 'function') {
          canvas.animatePan({ ...view, duration: 50 });
        } else {
          stage.scale.set(view.scale, view.scale);
          stage.position.set(centerX - view.scale * view.x, centerY - view.scale * view.y);
        }
      } catch (_) {}
    };

    const pointerDownHandler = async (event, { pointer }) => {
      if (!manager.isPlacementActive) return;
      if (event.button !== 0) return;
      if (manager._placing) {
        event.preventDefault();
        return;
      }
      if (pointer?.screen) {
        this.updateActorHoverHighlight(pointer.screen.x, pointer.screen.y);
      }
      const actorEl = pointer?.screen ? manager._findActorElement(pointer.screen.x, pointer.screen.y) : null;
      const overCanvas = pointer?.overCanvas && pointer.zOk;
      if (!overCanvas && !actorEl) return;
      if (actorEl) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.installActorClickBlocker();
      } else {
        event.preventDefault();
        event.stopPropagation();
      }
      const result = await manager._placeAtPointer(event, actorEl);
      if (result === 'none') {
        manager.cancelPlacement('error');
        return;
      }
      const keepPlacing = event.shiftKey || manager._stickyMode;
      if (!keepPlacing && (result === 'canvas' || result === 'actor')) {
        manager.cancelPlacement('placed');
      } else if (keepPlacing && result === 'actor' && pointer?.screen) {
        this.updateActorHoverHighlight(pointer.screen.x, pointer.screen.y);
      }
      if (keepPlacing && (result === 'canvas' || result === 'actor') && manager._randomMode) {
        await manager._switchToNextRandomEntry({ pointerEvent: event });
      }
    };

    const keyDownHandler = (event) => {
      if (!manager.isPlacementActive) return;
      const keyName = typeof event?.key === 'string' ? event.key : '';
      if (keyName === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        manager.cancelPlacement('esc');
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
      if (isGridSnapShortcut(event)) {
        if (manager._shouldIgnorePlacementHotkey(event, keyName)) return;
        this._gridSnapShortcutHeld = true;
        if (!event.repeat) this._gridSnapShortcutPendingToggle = true;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
      }
    };

    const keyUpHandler = (event) => {
      if (String(event?.key || '').toLowerCase() === 's') {
        const shouldToggle = this._gridSnapShortcutHeld && this._gridSnapShortcutPendingToggle;
        this._gridSnapShortcutHeld = false;
        this._gridSnapShortcutPendingToggle = false;
        if (shouldToggle) {
          event.preventDefault?.();
          event.stopPropagation?.();
          event.stopImmediatePropagation?.();
          void Promise.resolve(toolOptionsController.toggleGridSnapShortcut())
            .finally(() => manager._refreshPlacementAfterGridSnapChange());
        }
      }
    };

    return {
      pointermove: pointerMoveHandler,
      wheel: wheelHandler,
      pointerdown: pointerDownHandler,
      keydown: keyDownHandler,
      keyup: keyUpHandler
    };
  }
}
