import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { preserveTileDocumentCustomSettingsForUpdate } from '../canvas/tile-document-payloads.js';
import { getAssetShadowManager } from './asset-shadow-manager.js';
import { buildPlacementEditingShadowUpdate } from './asset-placement-tile-payload.js';

export class AssetPlacementEditShadowCommitWorkflow {
  constructor(manager) {
    if (!manager) throw new Error('AssetPlacementEditShadowCommitWorkflow requires manager.');
    this.manager = manager;
  }

  clearTimer() {
    const manager = this.manager;
    if (manager._editingCommitTimer) {
      try { clearTimeout(manager._editingCommitTimer); }
      catch (_) {}
      manager._editingCommitTimer = null;
    }
  }

  schedule(immediate = false) {
    const manager = this.manager;
    if (!manager._isEditingExistingTile) return;
    this.clearTimer();
    if (immediate) {
      this.commit();
      return;
    }
    manager._editingCommitTimer = setTimeout(() => {
      manager._editingCommitTimer = null;
      this.commit();
    }, 150);
  }

  commit() {
    const manager = this.manager;
    if (!manager._isEditingExistingTile || !manager._editingTile || !canvas?.scene) return;
    this.clearTimer();
    const scene = canvas.scene;
    const doc = manager._editingTile;
    const asset = manager.currentAsset;
    const enabled = manager.isDropShadowEnabled();
    const offsetVec = manager._computeShadowOffsetVector();
    let placedWidth = null;
    let placedHeight = null;
    try {
      const dims = manager._computeWorldSizeForAsset(asset, manager._getPendingScale());
      if (dims && Number.isFinite(dims.worldWidth) && Number.isFinite(dims.worldHeight)) {
        placedWidth = Math.max(1, Math.round(dims.worldWidth));
        placedHeight = Math.max(1, Math.round(dims.worldHeight));
      }
    } catch (_) {}
    const rotation = manager._getPendingRotation();
    const flipState = manager._getPendingFlipState();

    const payload = buildPlacementEditingShadowUpdate({
      tileId: doc.id,
      dropShadow: {
        alpha: manager._dropShadowAlpha,
        dilation: manager._dropShadowDilation,
        blur: manager._dropShadowBlur,
        offsetDistance: manager._dropShadowOffsetDistance,
        offsetAngle: manager._dropShadowOffsetAngle,
        offsetVector: offsetVec,
        shadowOnly: manager._dropShadowOnly
      },
      shadowEnabled: enabled,
      hsbc: manager._getPersistedHsbc(),
      width: placedWidth,
      height: placedHeight,
      rotation,
      flipState
    });
    preserveTileDocumentCustomSettingsForUpdate(doc, payload);

    const previousCommit = manager._editingCommitPromise || Promise.resolve();
    const commit = previousCommit.then(async () => {
      const updated = await scene.updateEmbeddedDocuments('Tile', [payload], { diff: false });
      const nextDoc = (Array.isArray(updated) && updated[0]) ? updated[0] : doc;
      const stillEditingSameAsset = asset && manager.currentAsset === asset && manager._isEditingExistingTile && manager._editingTile?.id === doc.id;
      if (stillEditingSameAsset && nextDoc) manager._editingTile = nextDoc;
      if (stillEditingSameAsset && nextDoc) {
        try {
          asset.width = nextDoc.width;
          asset.height = nextDoc.height;
          const sceneGridSize = Number(canvas?.scene?.grid?.size || 100) || 100;
          const gw = Number(nextDoc.width || 0) / sceneGridSize;
          const gh = Number(nextDoc.height || 0) / sceneGridSize;
          if (Number.isFinite(gw) && gw > 0) asset.grid_width = gw;
          if (Number.isFinite(gh) && gh > 0) asset.grid_height = gh;
          asset.actual_width = nextDoc.width;
          asset.actual_height = nextDoc.height;
        } catch (_) {}
      }
      try {
        const shadowManager = getAssetShadowManager(manager.app);
        const elevation = Number((nextDoc && nextDoc.elevation) ?? doc.elevation ?? 0) || 0;
        shadowManager?._scheduleRebuild?.(elevation, true);
      } catch (_) {}
      manager._refreshShadowElevationContext({ adopt: false, sync: true });
    }).catch((error) => {
      try { Logger.warn('Placement.editTile.update.failed', String(error?.message || error)); }
      catch (_) {}
    });
    manager._editingCommitPromise = commit;
    return commit;
  }
}
