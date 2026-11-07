import { NexusLogger as Logger } from '../core/nexus-logger.js';

const formatError = (error) => String(error?.message || error);

export class AssetScatterPlacementSession {
  constructor(manager) {
    if (!manager) throw new Error('AssetScatterPlacementSession requires manager.');
    this.manager = manager;
  }

  async collectStampInstances(worldX, worldY) {
    const manager = this.manager;
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return [];
    if (!manager.currentAsset && (!manager.isRandomMode || !Array.isArray(manager.randomAssets) || !manager.randomAssets.length)) {
      return [];
    }
    const center = manager._applyGridSnapping({ x: worldX, y: worldY });
    const brushRadius = manager._getScatterBrushRadius();
    const density = manager._getScatterDensity();
    const instances = [];
    for (let i = 0; i < density; i += 1) {
      const asset = manager._pickScatterAsset();
      if (!asset) continue;
      if (manager._assetRequiresDownload(asset)) {
        try {
          await manager._ensureAssetLocal(asset);
        } catch (error) {
          Logger.warn('Placement.scatter.previewStamp.downloadFailed', {
            asset: asset?.path || asset?.url || asset?.filename || null,
            error: formatError(error)
          });
          continue;
        }
      }
      const offset = manager._sampleScatterOffset(brushRadius, brushRadius);
      const pos = { x: center.x + offset.x, y: center.y + offset.y };
      const snapped = manager._applyGridSnapping(pos);
      const rotation = manager._getScatterRotation();
      const scale = manager._getScatterScale();
      const flip = manager._getScatterFlipState();
      const instance = manager._buildScatterInstanceData(asset, snapped, { rotation, scale, flip });
      if (instance) instances.push(instance);
    }
    return instances;
  }

  async previewStampAtWorld(worldX, worldY) {
    const manager = this.manager;
    try {
      if (manager._scatterMergeEnabled && !manager._scatterEditing && !manager._scatterSessionActive) {
        manager._startScatterMergeSession();
      }
      const instances = await this.collectStampInstances(worldX, worldY);
      if (!instances.length) return;
      if (manager._scatterMergeEnabled && manager._scatterSessionActive && !manager._scatterEditing) {
        manager._registerScatterSessionInstances(instances, manager._previewElevation);
      } else {
        const key = manager._getScatterPreviewGroupKey(manager._previewElevation);
        const elevation = manager._quantizeScatterElevation(Number(manager._previewElevation) || 0);
        for (const instance of instances) {
          if (!instance) continue;
          instance._scatterGroupKey = instance._scatterGroupKey || key;
          instance._scatterElevation = Number.isFinite(instance._scatterElevation) ? instance._scatterElevation : elevation;
        }
      }
      for (const instance of instances) {
        manager._scatterPreviewInstances.push(instance);
        manager._addScatterPreviewInstance(instance);
      }
      manager._scatterHistoryDirty = true;
    } catch (error) {
      Logger.warn('Placement.scatter.previewStamp.failed', {
        x: worldX,
        y: worldY,
        error: formatError(error)
      });
    }
  }

  resolveQueueAction({ erase = null } = {}) {
    const manager = this.manager;
    if (manager._scatterMergeEnabled) {
      const effectiveErase = erase == null ? manager._isScatterEraseActive() : !!erase;
      if (effectiveErase) return 'erase';
      return 'preview';
    }
    return 'tile';
  }

  queueStamp(worldX, worldY, { erase = null } = {}) {
    const manager = this.manager;
    const action = this.resolveQueueAction({ erase });
    return manager._scatterCommitSession.enqueueStamp(worldX, worldY, {
      action,
      processQueue: () => this.processQueue()
    });
  }

  async processQueue() {
    const manager = this.manager;
    return manager._scatterCommitSession.processQueue({
      isPlacementActive: () => manager.isPlacementActive,
      isBrushMode: () => manager._scatterMode === manager._scatterModeBrush,
      handlers: {
        preview: (point) => this.previewStampAtWorld(point.x, point.y),
        erase: (point) => manager._scatterEraseAtWorld(point.x, point.y, { force: true }),
        tile: (point) => this.tileStampAtWorld(point.x, point.y)
      }
    });
  }

  async tileStampAtWorld(worldX, worldY) {
    const manager = this.manager;
    try {
      if (!manager.currentAsset) return;
      if (!canvas || !canvas.scene) return;
      const center = manager._applyGridSnapping({ x: worldX, y: worldY });
      const brushRadius = manager._getScatterBrushRadius();
      const density = manager._getScatterDensity();
      const positions = [];
      for (let i = 0; i < density; i += 1) {
        const offset = manager._sampleScatterOffset(brushRadius, brushRadius);
        positions.push({ x: center.x + offset.x, y: center.y + offset.y });
      }
      if (!positions.length) return;

      const plannedPlacements = [];
      for (const pos of positions) {
        const asset = manager._pickScatterAsset();
        if (!asset) continue;
        if (manager._assetRequiresDownload(asset)) {
          try { await manager._ensureAssetLocal(asset); }
          catch (error) {
            Logger.warn('Placement.scatter.tileStamp.downloadFailed', {
              asset: asset?.path || asset?.url || asset?.filename || null,
              error: formatError(error)
            });
            continue;
          }
        }
        plannedPlacements.push({
          asset,
          snapped: manager._applyGridSnapping(pos),
          rotation: manager._getScatterRotation(),
          scale: manager._getScatterScale(),
          flip: manager._getScatterFlipState()
        });
      }

      if (!plannedPlacements.length) return;
      const sortContext = manager._resolvePlacementSortContext(manager._previewElevation, {
        count: plannedPlacements.length
      });
      await manager._applyPlacementSiblingSortUpdates(sortContext.siblingUpdates, {
        reason: 'scatter-stamp'
      });

      const tileDataList = [];
      for (let index = 0; index < plannedPlacements.length; index += 1) {
        const placement = plannedPlacements[index];
        const sort = Array.isArray(sortContext?.placementSorts) && Number.isFinite(Number(sortContext.placementSorts[index]))
          ? Number(sortContext.placementSorts[index])
          : ((Number(sortContext?.sort) || 0) + (index * 2));
        const tileData = manager._buildScatterTileData(placement.asset, placement.snapped, {
          rotation: placement.rotation,
          scale: placement.scale,
          flip: placement.flip,
          sort
        });
        if (tileData) tileDataList.push(tileData);
      }
      if (!tileDataList.length) return;
      const created = await canvas.scene.createEmbeddedDocuments('Tile', tileDataList);
      const createdDocs = Array.isArray(created) ? created : [created];
      const dropShadowEnabled = manager._isGlobalDropShadowEnabled() && manager.isDropShadowEnabled();
      if (dropShadowEnabled) {
        try {
          const shadowManager = manager._getAssetShadowManager();
          for (const doc of createdDocs) {
            shadowManager?.registerTile?.(doc);
          }
          if (!manager._scatterShadowBatchActive) {
            manager._refreshShadowElevationContext({ adopt: false });
          }
        } catch (_) {}
      }
      const lastCreated = createdDocs[createdDocs.length - 1] || null;
      if (lastCreated) manager._adoptPlacementSortAnchor(lastCreated);
      const lastSort = Number(lastCreated?.sort);
      if (Number.isFinite(lastSort)) {
        manager._previewSort = lastSort;
        manager._previewRenderSort = lastSort;
      }
      if (manager.isPlacementActive) {
        manager._syncPreviewOrdering();
      }
    } catch (error) {
      Logger.warn('Placement.scatter.tileStamp.failed', {
        x: worldX,
        y: worldY,
        error: formatError(error)
      });
    }
  }
}
