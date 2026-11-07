import { NexusLogger as Logger } from '../core/nexus-logger.js';

export const CONTROLLED_TILE_REFRESH_DELAYS_MS = [0, 16, 80, 180];

const EMPTY_HOVER_EXPECTATION = Object.freeze({
  onBoard: false,
  withinBounds: false,
  visibleAlpha: false,
  hitsResizeHandle: false,
  overTileTarget: false,
  overHandleTarget: false,
  shouldHoverTile: false
});

export class TileControlledInteractionRefresh {
  constructor(adapter = {}) {
    this.adapter = adapter;
    this._batch = null;
  }

  schedule(tile, reason = 'unknown') {
    try {
      if (!tile || tile.destroyed || !tile.controlled) return;
      if (!this._batch) {
        this._batch = {
          tiles: new Set(),
          timers: new Map(),
          reasons: new Set()
        };
      }
      const batch = this._batch;
      batch.tiles.add(tile);
      batch.reasons.add(String(reason || 'unknown'));
      for (const delayMs of CONTROLLED_TILE_REFRESH_DELAYS_MS) {
        if (batch.timers.has(delayMs)) continue;
        const timeoutId = setTimeout(() => {
          try {
            this.refreshBatch(delayMs);
          } finally {
            const active = this._batch;
            if (!active?.timers) return;
            active.timers.delete(delayMs);
            if (!active.timers.size) this._batch = null;
          }
        }, delayMs);
        batch.timers.set(delayMs, timeoutId);
      }
    } catch (err) {
      Logger.debug('TilePixelSelection._scheduleControlledInteractionRefresh failed', err);
    }
  }

  clear() {
    try {
      const batch = this._batch;
      if (batch?.timers instanceof Map) {
        for (const timeoutId of batch.timers.values()) {
          try { clearTimeout(timeoutId); } catch (_) {}
        }
      }
    } catch (_) {}
    this._batch = null;
  }

  refreshBatch(delayMs = 0) {
    try {
      const batch = this._batch;
      if (!batch?.tiles?.size) return;
      const tiles = Array.from(batch.tiles).filter((tile) => tile && !tile.destroyed && tile.controlled);
      if (!tiles.length) return;

      const reasons = Array.from(batch.reasons || []).slice(0, 8);
      for (const tile of tiles) this.adapter.handleTileLifecycle(tile);

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
      const recovery = this.getHoverRecoveryCandidate(tiles);
      if (!recovery?.tile || !recovery.expectation?.shouldHoverTile) return;

      const recovered = this.forceControlledTileHover(recovery.tile);
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

  getHoverRecoveryCandidate(tiles = []) {
    try {
      const candidates = Array.isArray(tiles)
        ? tiles.filter((tile) => tile && !tile.destroyed && tile.controlled)
        : [];
      if (!candidates.length) return null;

      const pointer = this.getRootPointerContext();
      if (!pointer.onBoard || !Number.isFinite(pointer.globalX) || !Number.isFinite(pointer.globalY)) return null;
      const prioritized = candidates.slice().sort((left, right) => this.adapter.compareTileInteractionPriority(right, left));
      for (const tile of prioritized) {
        const expectation = this.getHoverExpectationForPointer(tile, pointer);
        if (expectation.shouldHoverTile) return { tile, expectation };
      }
      return null;
    } catch (err) {
      Logger.debug('TilePixelSelection._getControlledTileHoverRecoveryCandidate failed', err);
      return null;
    }
  }

  refreshTile(tile, reason = 'unknown') {
    try {
      if (!tile || tile.destroyed || !tile.controlled) return;
      this.adapter.handleTileLifecycle(tile);

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
        const hoverExpectation = this.getHoverExpectation(tile);
        if (hoverExpectation.shouldHoverTile) {
          const recovered = this.forceControlledTileHover(tile);
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

  getRootPointerContext() {
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

  forceControlledTileHover(tile) {
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

  pointerTargetsTileHandle(tile, target) {
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

  getHoverExpectation(tile) {
    try {
      const pointer = this.getRootPointerContext();
      return this.getHoverExpectationForPointer(tile, pointer);
    } catch (err) {
      Logger.debug('TilePixelSelection._getControlledTileHoverExpectation failed', err);
      return { ...EMPTY_HOVER_EXPECTATION };
    }
  }

  getHoverExpectationForPointer(tile, pointer = null) {
    try {
      const context = pointer || this.getRootPointerContext();
      const overTargets = Array.isArray(context.overTargets) ? context.overTargets : [];
      const overHandleTarget = !!tile?._hoveredHandle || overTargets.some((target) => this.pointerTargetsTileHandle(tile, target));
      const overTileTarget = overTargets.some((target) => target === tile);

      let withinBounds = false;
      let visibleAlpha = false;
      let hitsResizeHandle = false;
      if (context.onBoard && Number.isFinite(context.globalX) && Number.isFinite(context.globalY)) {
        withinBounds = this.adapter.pointWithinTileBounds(tile, context.globalX, context.globalY);
        if (withinBounds) visibleAlpha = this.adapter.pointHasVisibleAlpha(tile, context.globalX, context.globalY);
        hitsResizeHandle = this.adapter.pointHitsResizeHandle(tile, context.globalX, context.globalY);
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
      return { ...EMPTY_HOVER_EXPECTATION };
    }
  }
}
