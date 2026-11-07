import { NexusLogger as Logger } from '../core/nexus-logger.js';

// A pass that keeps meeting dead textures is a real failure, not a race.
const MAX_STALE_TEXTURE_PASSES = 3;

function drawsDestroyedTexture(container) {
  return (container?.children ?? []).some((child) => {
    const texture = child?.texture;
    if (texture && (texture.destroyed || texture.baseTexture?.destroyed)) return true;
    return drawsDestroyedTexture(child);
  });
}

export function buildLayerShadowRenderInputs(manager, docs, layer) {
  // Resolve per-tile configuration. Alpha/blur are render-profile settings, so keep
  // them with each entry; mixed building/window shadows at one elevation must not let
  // the first tile in the layer decide the whole layer's blur.
  const tileConfigs = [];
  let maxOffsetX = 0;
  let maxOffsetY = 0;
  let maxDilation = 0;
  let maxAlpha = 0;
  let maxBlur = 0;

  const addEntry = (doc, config, paths, partitionKey) => {
    const docId = String(doc?.id || doc?._id || 'tile');
    tileConfigs.push({ doc, config, paths, shadowEntryKey: `${docId}:${partitionKey}` });
    if (Math.abs(config.offsetX) > maxOffsetX) maxOffsetX = Math.abs(config.offsetX);
    if (Math.abs(config.offsetY) > maxOffsetY) maxOffsetY = Math.abs(config.offsetY);
    if (config.dilation > maxDilation) maxDilation = config.dilation;
    if (config.alpha > maxAlpha) maxAlpha = config.alpha;
    if (config.blur > maxBlur) maxBlur = config.blur;
  };

  for (const doc of docs) {
    const docBaseOptions = manager._extractShadowBaseOptions(doc, { elevation: layer?.elevation });
    const cfg = {
      ...manager._extractTileShadowConfig(doc, docBaseOptions),
      alpha: docBaseOptions.alpha,
      blur: docBaseOptions.blur
    };
    const pathDescriptors = manager._resolveShadowPathDescriptors(doc) || [];
    const inheritedDescriptors = [];
    const configuredGroups = new Map();
    for (const descriptor of pathDescriptors) {
      const override = descriptor?.shadowConfig;
      if (!override || typeof override !== 'object') {
        inheritedDescriptors.push(descriptor);
        continue;
      }
      const config = {
        ...cfg,
        alpha: Number.isFinite(Number(override.alpha))
          ? Math.min(1, Math.max(0, Number(override.alpha)))
          : cfg.alpha,
        blur: Number.isFinite(Number(override.blur))
          ? Math.max(0, Number(override.blur))
          : cfg.blur,
        dilation: Number.isFinite(Number(override.dilation))
          ? Math.max(0, Number(override.dilation))
          : cfg.dilation,
        offsetX: Number.isFinite(Number(override.offsetX)) ? Number(override.offsetX) : cfg.offsetX,
        offsetY: Number.isFinite(Number(override.offsetY)) ? Number(override.offsetY) : cfg.offsetY
      };
      const key = JSON.stringify([
        config.alpha,
        config.blur,
        config.dilation,
        config.offsetX,
        config.offsetY
      ]);
      let group = configuredGroups.get(key);
      if (!group) {
        group = { config, paths: [] };
        configuredGroups.set(key, group);
      }
      group.paths.push(descriptor);
    }

    if (inheritedDescriptors.length || !pathDescriptors.length) {
      addEntry(doc, cfg, inheritedDescriptors, 'inherited');
    }
    for (const [key, group] of configuredGroups) {
      addEntry(doc, group.config, group.paths, `configured:${key}`);
    }
  }

  const layerOptions = {
    alpha: maxAlpha,
    blur: maxBlur,
    maxOffsetX,
    maxOffsetY,
    maxDilation
  };

  return { tileConfigs, layerOptions };
}

export class AssetShadowRebuildWorkflow {
  constructor(manager) {
    this.manager = manager;
    this._timers = new Map();
    this._suspendCount = 0;
    this._pending = new Set();
    this._pendingImmediate = false;
    this._running = new Map();
  }

  suspend() {
    this._suspendCount += 1;
  }

  resume({ immediate = false } = {}) {
    if (this._suspendCount <= 0) return false;
    this._suspendCount -= 1;
    if (this._suspendCount > 0) return true;
    if (!this._pending.size) {
      this._pendingImmediate = false;
      return true;
    }
    const pending = Array.from(this._pending);
    this._pending.clear();
    const runImmediate = !!immediate || this._pendingImmediate;
    this._pendingImmediate = false;
    for (const elevation of pending) {
      this.manager._scheduleRebuild(elevation, runImmediate);
    }
    return true;
  }

  async waitFor(targets, { timeoutMs = 30000 } = {}) {
    const keys = Array.from(new Set(Array.isArray(targets) ? targets.filter(Boolean) : []));
    if (!keys.length) return;
    const started = Date.now();
    while (true) {
      const pending = keys.some((key) => {
        const layer = this.manager._layers.get(key);
        return !!(
          layer?.rebuilding
          || layer?.dirty
          || this._running.has(key)
          || this._timers.has(key)
          || this._pending.has(key)
        );
      });
      if (!pending) {
        const failures = keys
          .map((key) => this.manager._layers.get(key)?.lastRebuildError || null)
          .filter(Boolean);
        if (failures.length) {
          const error = new AggregateError(
            failures.map((failure) => failure.error || failure),
            `Failed to rebuild ${failures.length} authoritative asset shadow layer(s).`
          );
          error.details = failures.map((failure) => failure.details || null);
          throw error;
        }
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for ${keys.length} asset shadow rebuild(s).`);
      }
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  }

  schedule(target, immediate = false) {
    const manager = this.manager;
    const layerKeys = manager._resolveLayerKeys(target);
    if (!layerKeys.length) return;
    for (const layerKey of layerKeys) {
      const layer = manager._layers.get(layerKey);
      if (!layer || !canvas?.ready) continue;
      layer.lastRebuildError = null;
      layer.dirty = true;
      const handle = this._timers.get(layerKey);
      if (handle) {
        try { clearTimeout(handle); } catch (_) {}
        this._timers.delete(layerKey);
      }
      if (this._suspendCount > 0) {
        this._pending.add(layerKey);
        if (immediate) this._pendingImmediate = true;
        continue;
      }
      const generation = manager._sceneGeneration;
      const sceneId = manager._sceneId || manager._getActiveSceneId();
      const run = () => {
        this._timers.delete(layerKey);
        if (!manager._isCurrentSceneScope(generation, sceneId)) {
          Logger.debug?.('AssetShadow.rebuild.staleTimerDiscarded', { layerKey, sceneId, generation });
          return;
        }
        manager._rebuildLayer(layerKey, { generation, sceneId });
      };
      if (immediate) {
        run();
        continue;
      }
      const delay = Math.max(16, Number(manager._options.debounce || 0));
      const timer = setTimeout(run, delay);
      this._timers.set(layerKey, timer);
    }
  }

  async rebuildLayer(elevation, options = {}) {
    const manager = this.manager;
    const generation = options.generation === undefined ? manager._sceneGeneration : options.generation;
    const sceneId = options.sceneId === undefined ? (manager._sceneId || manager._getActiveSceneId()) : options.sceneId;
    const layer = manager._layers.get(elevation);
    if (!layer || !canvas?.ready) return;
    if (!manager._isCurrentSceneScope(generation, sceneId)) return;
    if (layer.sceneId && sceneId && layer.sceneId !== sceneId) {
      Logger.debug?.('AssetShadow.rebuild.sceneMismatchDiscarded', {
        elevation,
        layerSceneId: layer.sceneId,
        sceneId
      });
      return;
    }
    if (!layer.dirty && !layer.rebuilding) return;
    if (layer.rebuilding) {
      if (!options.waitForRunning) layer.dirty = true;
      const running = this._running.get(elevation);
      if (!running) return;
      await running;
      // The running owner schedules the dirty follow-up in its finally block.
      // Scheduled callers must not recursively invalidate that follow-up: two
      // overlapping requests would otherwise keep each other rebuilding forever.
      if (!options.waitForRunning) return;
      // Capture/readiness callers also wait for a follow-up already in flight.
      return this.rebuildLayer(elevation, options);
    }
    let finishRunning = null;
    const running = new Promise((resolve) => { finishRunning = resolve; });
    this._running.set(elevation, running);
    layer.rebuilding = true;
    layer.dirty = false;

    let rebuildDrawContainer = null;
    const rebuildTempDisplayObjects = [];
    const rebuildTempTextures = [];
    const staleRebuildAbort = new Error('stale shadow rebuild scope');
    let rebuildTileIds = [];
    let rebuildChunkKeys = [];
    staleRebuildAbort.faNexusStaleRebuild = true;
    const assertCurrentRebuild = () => {
      if (!manager._isCurrentSceneScope(generation, sceneId)) throw staleRebuildAbort;
    };

    try {
      manager._updateRenderer();
      const renderer = manager._renderer;
      if (!renderer) throw new Error('Asset shadow renderer is unavailable.');

      const docs = [];
      const staleTileIds = [];
      for (const [tileId, doc] of layer.tiles.entries()) {
        if (
          !doc
          || !manager._isActiveSceneDocument(doc, { phase: 'rebuildLayer', log: false })
          || !manager._isShadowRenderableTile(doc, { phase: 'rebuildLayer', log: false })
        ) {
          staleTileIds.push(tileId);
          continue;
        }
        docs.push(doc);
      }
      rebuildTileIds = docs.map((doc) => String(doc?.id || '')).filter(Boolean);
      if (staleTileIds.length) {
        for (const tileId of staleTileIds) {
          layer.tiles.delete(tileId);
          if (manager._tileIndex.get(tileId) === elevation) manager._tileIndex.delete(tileId);
          manager._suspendedTiles.delete(tileId);
          manager._clearScatterShadowCache(tileId);
          manager._clearStandardMaskShadowCache(tileId);
        }
        Logger.debug?.('AssetShadow.rebuild.removedStaleTiles', {
          elevation,
          sceneId,
          tileIds: staleTileIds
        });
      }
      if (!docs.length) {
        manager._destroyLayer(elevation);
        return;
      }
      manager._sortLayerShadowDocs(docs);

      const { tileConfigs, layerOptions } = buildLayerShadowRenderInputs(manager, docs, layer);
      layer.options = layerOptions;

      const baseRect = manager._getSceneRect();
      const renderChunks = manager._buildLayerShadowRenderChunks(tileConfigs, {
        fallbackRect: baseRect,
        layerOptions
      });
      rebuildChunkKeys = renderChunks.map((chunk) => String(chunk?.key || '')).filter(Boolean);
      const chunkStates = manager._syncLayerRenderChunks(layer, renderChunks);

      for (const renderChunk of renderChunks) {
        const chunkState = chunkStates.get(renderChunk.key);
        if (!chunkState) continue;

        let sr = renderChunk.bounds || baseRect;
        sr = manager._applyShadowMargins(sr, {
          offsetX: renderChunk.maxOffsetX,
          offsetY: renderChunk.maxOffsetY,
          dilation: renderChunk.maxDilation,
          blur: Number(renderChunk.blur ?? layerOptions.blur ?? 0)
        });
        manager._sceneRect = sr;
        const scale = manager._computeTextureScale(sr);
        const texWidth = Math.max(4, Math.round(sr.width * scale));
        const texHeight = Math.max(4, Math.round(sr.height * scale));
        if (!Number.isFinite(texWidth) || !Number.isFinite(texHeight)) continue;

        const chunkTempDisplayObjects = [];
        const chunkTempTextures = [];
        const chunkTempTextureViews = [];
        let chunkDrawContainer = null;
        try {
          chunkDrawContainer = await manager._buildLayerShadowDrawContainer(renderChunk.entries, {
            renderer,
            scale,
            sceneRect: sr,
            assertCurrentRebuild,
            tempDisplayObjects: chunkTempDisplayObjects,
            tempTextures: chunkTempTextures,
            tempTextureViews: chunkTempTextureViews
          });
          assertCurrentRebuild();

          const childCount = Number(chunkDrawContainer?.children?.length || 0);
          if (childCount <= 0) {
            manager._hideLayerRenderChunk(layer, chunkState);
            continue;
          }

          // Scatter stamps borrow the Scatter renderer's live cache textures. A Scatter
          // re-render during the awaits above (a native resize, for one) destroys them, and
          // rendering a destroyed texture throws. This pass is then out of date, not failed:
          // queue the follow-up, which reads the renderer's current textures.
          if (drawsDestroyedTexture(chunkDrawContainer)) {
            layer.staleTexturePasses = (layer.staleTexturePasses || 0) + 1;
            if (layer.staleTexturePasses <= MAX_STALE_TEXTURE_PASSES) {
              layer.dirty = true;
              throw staleRebuildAbort;
            }
          }

          const renderTexture = manager._renderLayerToTexture(layer, chunkDrawContainer, renderer, texWidth, texHeight, {
            renderTarget: chunkState,
            scale,
            layerOptions: {
              ...layerOptions,
              alpha: Number(renderChunk.alpha ?? layerOptions.alpha ?? 0.35),
              blur: Number(renderChunk.blur ?? layerOptions.blur ?? 0),
              maxDilation: Number(renderChunk.maxDilation ?? layerOptions.maxDilation ?? 0)
            }
          });
          if (!renderTexture) {
            throw new Error(`Asset shadow chunk ${renderChunk.key} produced no render texture.`);
          }
          if (manager._isLayerRenderTextureBlank(renderTexture, renderer, { elevation, sceneId, generation, childCount })) {
            manager._handleBlankLayerRender(elevation, {
              sceneId,
              generation,
              childCount,
              width: Number(renderTexture.width || 0),
              height: Number(renderTexture.height || 0),
              tileIds: renderChunk.entries.map((entry) => entry?.doc?.id).filter(Boolean)
            });
          }
          chunkState.options = {
            alpha: Number(renderChunk.alpha ?? layerOptions.alpha ?? 0.35),
            blur: Number(renderChunk.blur ?? layerOptions.blur ?? 0),
            maxDilation: Number(renderChunk.maxDilation ?? layerOptions.maxDilation ?? 0)
          };
          manager._applyLayerChunkTexture(layer, chunkState, sr, renderTexture, scale);
        } finally {
          for (const displayObject of chunkTempDisplayObjects) {
            try { displayObject.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
          }
          for (const texture of chunkTempTextures) {
            try { texture?.destroy?.(true); } catch (_) {}
          }
          for (const texture of chunkTempTextureViews) {
            try { texture?.destroy?.(false); } catch (_) {}
          }
          try { chunkDrawContainer?.destroy?.({ children: false }); } catch (_) {}
        }
      }

      manager._syncLayerOrdering(layer);
      layer.lastRebuildError = null;
      layer.staleTexturePasses = 0;
    } catch (e) {
      if (e?.faNexusStaleRebuild) {
        Logger.debug?.('AssetShadow.rebuild.staleAbort', { elevation, sceneId, generation });
      } else {
        const failure = {
          error: e,
          details: {
            layerKey: String(elevation),
            sceneId,
            tileIds: rebuildTileIds,
            chunkKeys: rebuildChunkKeys
          }
        };
        layer.lastRebuildError = failure;
        Logger.error('AssetShadow.rebuild.failed', {
          ...failure.details,
          error: String(e?.message || e)
        });
      }
    } finally {
      for (const displayObject of rebuildTempDisplayObjects) {
        try { displayObject.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      }
      for (const texture of rebuildTempTextures) {
        try { texture?.destroy?.(true); } catch (_) {}
      }
      try { rebuildDrawContainer?.destroy?.({ children: false }); } catch (_) {}
      if (manager._layers.get(elevation) !== layer || !manager._isCurrentSceneScope(generation, sceneId)) {
        Logger.debug?.('AssetShadow.rebuild.staleDiscarded', { elevation, sceneId, generation });
      } else {
        layer.rebuilding = false;
        if (layer.dirty) manager._scheduleRebuild(elevation, true);
      }
      if (this._running.get(elevation) === running) this._running.delete(elevation);
      finishRunning?.();
    }
  }

  clearAll() {
    for (const timer of this._timers.values()) {
      try { clearTimeout(timer); } catch (_) {}
    }
    this._timers.clear();
    this._pending.clear();
    this._pendingImmediate = false;
    this._suspendCount = 0;
  }

  clearTimer(elevation) {
    const timer = this._timers.get(elevation);
    if (timer) {
      try { clearTimeout(timer); } catch (_) {}
      this._timers.delete(elevation);
    }
  }
}
