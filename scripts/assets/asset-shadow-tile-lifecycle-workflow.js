import { NexusLogger as Logger } from '../core/nexus-logger.js';

export class AssetShadowTileLifecycleWorkflow {
  constructor(manager) {
    this.manager = manager;
  }

  onCanvasReady({ awaitRebuild = false } = {}) {
    const manager = this.manager;
    if (!canvas || !canvas.ready) {
      return { ok: true, skipped: true };
    }
    manager._previewSuppressionController?.cancelAll?.('canvas-ready');
    manager._sceneGeneration += 1;
    manager._sceneId = manager._getActiveSceneId();
    manager._updateRenderer();
    manager._clearAllLayers();
    manager._sceneRect = manager._getSceneRect();

    const placeables = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const placeable of placeables) {
      const doc = placeable?.document;
      if (!doc || !manager._isShadowRenderableTile(doc, { phase: 'canvasReady' })) continue;
      manager._addTile(doc, { deferRebuild: true });
    }

    const layerKeys = Array.from(manager._layers.keys());
    if (awaitRebuild) {
      return this._rebuildLayerKeys(layerKeys, {
        generation: manager._sceneGeneration,
        sceneId: manager._sceneId
      });
    }

    for (const elevation of layerKeys) {
      manager._scheduleRebuild(elevation, true);
    }

    return {
      ok: true,
      skipped: false,
      failures: []
    };
  }

  prepareForSceneTransitionCapture() {
    const manager = this.manager;
    if (!canvas || !canvas.ready) {
      return { ok: true, skipped: true };
    }
    const sceneId = manager._getActiveSceneId();
    if (!sceneId) {
      return { ok: true, skipped: true };
    }
    if (manager._sceneId !== sceneId) {
      return this.onCanvasReady({ awaitRebuild: true });
    }
    return this._rebuildLayerKeys(Array.from(manager._layers.keys()), {
      generation: manager._sceneGeneration,
      sceneId
    });
  }

  async _rebuildLayerKeys(layerKeys, { generation, sceneId } = {}) {
    const manager = this.manager;
    const keys = Array.from(layerKeys || []);
    const settled = await Promise.allSettled(keys.map((layerKey) => manager._rebuildLayer(layerKey, {
      generation,
      sceneId,
      waitForRunning: true
    })));
    const failures = [];
    for (let i = 0; i < settled.length; i += 1) {
      const result = settled[i];
      if (result.status !== 'rejected') continue;
      failures.push({
        layerKey: keys[i],
        error: String(result.reason?.message || result.reason || 'unknown error')
      });
    }
    return {
      ok: failures.length === 0,
      skipped: false,
      failures
    };
  }

  onCanvasTearDown() {
    const manager = this.manager;
    manager._previewSuppressionController?.cancelAll?.('canvas-teardown');
    manager._sceneGeneration += 1;
    const previousSceneId = manager._sceneId || manager._getActiveSceneId();
    manager._sceneId = null;
    manager._clearAllLayers();
    Logger.debug?.('AssetShadow.canvasTearDown.cleared', { sceneId: previousSceneId });
  }

  onCreateTile(doc) {
    const manager = this.manager;
    if (!doc || !manager._isActiveSceneDocument(doc, { phase: 'createTile' }) || !manager._isShadowRenderableTile(doc, { phase: 'createTile' })) return;
    manager._addTile(doc);
  }

  onUpdateTile(doc, changes = {}) {
    const manager = this.manager;
    if (!doc) return;
    if (!manager._isActiveSceneDocument(doc, { phase: 'updateTile' })) return;
    const hasShadow = manager._isShadowRenderableTile(doc, { phase: 'updateTile', changes });
    const tileId = doc.id;
    const prevElevation = manager._tileIndex.get(tileId);
    const suspendedEntry = tileId ? manager._suspendedTiles.get(tileId) : null;
    manager._clearStandardMaskShadowCache(tileId);

    if (!hasShadow) {
      if (suspendedEntry) {
        manager._suspendedTiles.delete(tileId);
      } else if (prevElevation !== undefined) {
        manager._removeTile(doc);
      }
      return;
    }

    if (suspendedEntry) {
      suspendedEntry.doc = doc;
      suspendedEntry.layerKey = manager._getTileLayerState(doc).key;
      return;
    }

    const layerState = manager._getTileLayerState(doc);
    if (prevElevation !== undefined && prevElevation !== layerState.key) {
      manager._removeTile(doc);
    }
    manager._addTile(doc);
  }

  onDeleteTile(doc) {
    const manager = this.manager;
    if (!doc) return;
    if (!manager._isActiveSceneDocument(doc, { phase: 'deleteTile' })) return;
    if (manager._suspendedTiles.has(doc.id)) {
      manager._suspendedTiles.delete(doc.id);
    }
    if (!manager._tileIndex.has(doc.id)) return;
    manager._removeTile(doc);
  }

  addTile(doc, { deferRebuild = false } = {}) {
    const manager = this.manager;
    try {
      if (!doc) return;
      if (!manager._isActiveSceneDocument(doc, { phase: 'addTile' })) return;
      if (!manager._isShadowRenderableTile(doc, { phase: 'addTile' })) return;
      const layerState = manager._getTileLayerState(doc);
      const layer = manager._ensureLayer(layerState);
      if (!layer) return;
      layer.tiles.set(doc.id, doc);
      layer.renderOrder = layerState.renderOrder;
      layer.shadowOcclusionKey = layerState.shadowOcclusionKey;
      layer.shadowOcclusionProfile = layerState.shadowOcclusionProfile;
      manager._tileIndex.set(doc.id, layerState.key);
      if (!deferRebuild) manager._scheduleRebuild(layerState.key);
    } catch (e) {
      Logger.warn('AssetShadow.addTile.failed', String(e?.message || e));
    }
  }

  removeTile(doc) {
    const manager = this.manager;
    try {
      const tileId = doc?.id;
      if (!manager._isActiveSceneDocument(doc, { phase: 'removeTile' })) return;
      if (!tileId || !manager._tileIndex.has(tileId)) return;
      const layerKey = manager._tileIndex.get(tileId);
      manager._tileIndex.delete(tileId);
      manager._suspendedTiles.delete(tileId);
      manager._clearScatterShadowCache(tileId);
      manager._clearStandardMaskShadowCache(tileId);
      const layer = manager._layers.get(layerKey);
      if (!layer) return;
      layer.tiles.delete(tileId);
      if (!layer.tiles.size) {
        manager._destroyLayer(layerKey);
        return;
      }
      manager._scheduleRebuild(layerKey);
    } catch (e) {
      Logger.warn('AssetShadow.removeTile.failed', String(e?.message || e));
    }
  }

  suspendTile(tileDocument) {
    const manager = this.manager;
    try {
      const doc = tileDocument?.document ?? tileDocument;
      if (!doc) return false;
      if (!manager._isActiveSceneDocument(doc, { phase: 'suspendTile' })) return false;
      const tileId = doc.id;
      if (!tileId) return false;
      if (manager._suspendedTiles.has(tileId)) return true;
      const layerKey = manager._tileIndex.get(tileId);
      if (layerKey === undefined) return false;
      const layer = manager._layers.get(layerKey);
      if (!layer || !layer.tiles.has(tileId)) return false;
      layer.tiles.delete(tileId);
      manager._tileIndex.delete(tileId);
      manager._suspendedTiles.set(tileId, { doc, layerKey });
      if (!layer.tiles.size) {
        manager._destroyLayer(layerKey);
        return true;
      }
      manager._scheduleRebuild(layerKey, true);
      return true;
    } catch (e) {
      Logger.warn('AssetShadow.suspendTile.failed', String(e?.message || e));
      return false;
    }
  }

  resumeTile(tileDocument, { immediate = true } = {}) {
    const manager = this.manager;
    try {
      const doc = tileDocument?.document ?? tileDocument;
      if (!doc) return false;
      if (!manager._isActiveSceneDocument(doc, { phase: 'resumeTile' })) return false;
      const tileId = doc.id;
      if (!tileId) return false;
      const entry = manager._suspendedTiles.get(tileId);
      if (!entry) return false;
      const liveDoc = canvas?.scene?.tiles?.get?.(tileId) || entry.doc || doc;
      const previousLayerKey = entry.layerKey || null;
      const nextLayerKey = manager._isActiveSceneDocument(liveDoc, { phase: 'resumeTile:live', log: false })
        && manager._isShadowRenderableTile(liveDoc, { phase: 'resumeTile:live', log: false })
        ? manager._getTileLayerState(liveDoc).key
        : null;
      manager._suspendedTiles.delete(tileId);
      if (nextLayerKey) manager._addTile(liveDoc, { deferRebuild: true });
      const rebuildTargets = new Set([previousLayerKey, nextLayerKey].filter(Boolean));
      for (const target of rebuildTargets) manager._scheduleRebuild(target, immediate === true);
      return true;
    } catch (e) {
      Logger.warn('AssetShadow.resumeTile.failed', String(e?.message || e));
      return false;
    }
  }
}
