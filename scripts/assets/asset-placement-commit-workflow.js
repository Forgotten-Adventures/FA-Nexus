import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { preserveTileDocumentCustomSettingsForUpdate } from '../canvas/tile-document-payloads.js';
import { getAssetShadowManager } from './asset-shadow-manager.js';
import { buildPlacementTileUpdate } from './asset-placement-tile-payload.js';
import { getTileVisualCenterWorld } from './asset-placement-edit-session.js';

// An edit writes what it sets. A setting the Tile never stored is not written as null or false
// merely because the edit leaves it off.
function dropClearsOfUnstoredSettings(doc, update) {
  const prefix = 'flags.fa-nexus.';
  for (const [key, value] of Object.entries(update)) {
    if (!key.startsWith(prefix) || (value !== null && value !== false)) continue;
    const stored = doc.getFlag('fa-nexus', key.slice(prefix.length));
    if (stored === undefined || stored === null) delete update[key];
  }
  return update;
}

export class AssetPlacementCommitWorkflow {
  constructor(manager) {
    if (!manager) throw new Error('AssetPlacementCommitWorkflow requires manager.');
    this.manager = manager;
  }

  async placeAtWorldCoordinates(world, { screenX = null, screenY = null } = {}) {
    const manager = this.manager;
    if (!world || !Number.isFinite(world.x) || !Number.isFinite(world.y)) return;
    const worldPoint = { x: Number(world.x), y: Number(world.y) };
    if (Number.isFinite(screenX) && Number.isFinite(screenY)) {
      manager._lastPointer = { x: Number(screenX), y: Number(screenY) };
    } else {
      const estimated = manager._canvasToScreen(worldPoint.x, worldPoint.y);
      if (estimated && Number.isFinite(estimated.x) && Number.isFinite(estimated.y)) {
        manager._lastPointer = { x: estimated.x, y: estimated.y };
      }
    }
    manager._lastPointerWorld = { x: worldPoint.x, y: worldPoint.y };
    const snappedWorld = manager._applyGridSnapping(worldPoint);
    manager._announcePreviewElevation(snappedWorld, { immediate: true });
    if (manager._previewFrozen) {
      manager._frozenPreviewWorld = { x: snappedWorld.x, y: snappedWorld.y };
      manager._refreshFrozenPointerScreen();
    }
    if (!manager.currentAsset) return;
    const editingDoc = ((manager._isEditingExistingTile || manager._replaceOriginalOnPlace) && manager._editingTile) ? manager._editingTile : null;
    const sortContext = manager._applyPlacementPreviewOrdering(manager._resolvePlacementSortContext(manager._previewElevation));
    manager._syncScatterPreviewOrdering();
    if (manager.isRandomMode && manager.currentAsset && String(manager.currentAsset.source || '').toLowerCase() === 'cloud' && !manager.currentAsset.cachedLocalPath) {
      await manager._ensureRandomCommitAssetLocal();
    }
    const assetPx = manager._getAssetBasePxPerSquare();
    const sceneGridSize = canvas?.scene?.grid?.size || 100;
    const gridScaleFactor = sceneGridSize / assetPx;
    const sm = manager._getPendingScale();
    const placedWidth = Math.round((manager._previewContainer?._tileWidth || assetPx) * gridScaleFactor * sm);
    const placedHeight = Math.round((manager._previewContainer?._tileHeight || assetPx) * gridScaleFactor * sm);
    const x = Math.round(snappedWorld.x);
    const y = Math.round(snappedWorld.y);
    const globalDropShadowEnabled = manager._isGlobalDropShadowEnabled();
    const dropShadowEnabled = globalDropShadowEnabled && manager.isDropShadowEnabled();
    const placementRotation = manager._getPendingRotation();
    const flipState = manager._getPendingFlipState();
    const { tileData, textureConfig } = manager._buildPlacementTileData({
      assetPath: manager.currentAsset.path,
      width: placedWidth,
      height: placedHeight,
      x,
      y,
      rotation: placementRotation,
      sort: manager._previewSort,
      elevation: manager._previewElevation,
      flipState,
      dropShadowEnabled
    });
    if (!canvas || !canvas.scene) throw new Error('Canvas unavailable');

    // Placing an edited asset again is an edit of its Tile, not a new Tile: the document keeps
    // its id, and with it its Scene Group, its relationships, and everything a placement does
    // not set (opacity, hidden state, mask, other modules' flags). One Undo entry takes it back.
    if (editingDoc) {
      await manager._applyPlacementSiblingSortUpdates(sortContext?.siblingUpdates, {
        reason: 'asset-edit'
      });
      // The pending rotation is the Tile's own after a round trip through radians.
      const storedRotation = Number(editingDoc.rotation);
      const rotation = Math.abs(placementRotation - storedRotation) < 1e-9 ? storedRotation : placementRotation;
      // An asset that was not carried anywhere stays where it stands, on the grid or off it.
      const centre = getTileVisualCenterWorld(editingDoc);
      const stays = Math.abs(worldPoint.x - centre.x) < 0.5 && Math.abs(worldPoint.y - centre.y) < 0.5;
      const update = buildPlacementTileUpdate({
        tileId: editingDoc.id,
        x: stays ? centre.x : x,
        y: stays ? centre.y : y,
        width: placedWidth,
        height: placedHeight,
        rotation,
        elevation: manager._previewElevation,
        sort: manager._previewSort,
        textureConfig,
        existingTextureSrc: editingDoc.texture?.src,
        placementLevelId: manager._resolveActivePlacementLevelId(editingDoc) || null,
        hsbc: manager._getPersistedHsbc(),
        dropShadow: dropShadowEnabled ? manager._buildPlacementDropShadowPayload() : null,
        clearDropShadow: !dropShadowEnabled
      });
      dropClearsOfUnstoredSettings(editingDoc, update);
      preserveTileDocumentCustomSettingsForUpdate(editingDoc, update);
      const updated = await canvas.scene.updateEmbeddedDocuments('Tile', [update], { diff: false });
      if (!Array.isArray(updated) || !updated[0]) {
        // Another handler refused the update. The asset stays picked up so the edit is not lost.
        Logger.warn('Placement.editTile.update.refused', { tileId: editingDoc.id || null });
        ui.notifications?.warn?.('The asset edit was not saved: the Tile update was refused.');
        return;
      }
      manager._editingTile = updated[0];
      manager._setPlacementFreeze(false, { announce: false });
      manager.cancelPlacement('completed');
      return;
    }

    await manager._applyPlacementSiblingSortUpdates(sortContext?.siblingUpdates, {
      reason: 'asset-placement'
    });
    const created = await canvas.scene.createEmbeddedDocuments('Tile', [tileData]);
    const createdDocs = Array.isArray(created) ? created : [created];
    const primaryCreated = createdDocs[0] || null;
    try { Logger.info('Placement.placed', { path: manager.currentAsset?.path, w: placedWidth, h: placedHeight, x, y, rot: placementRotation }); } catch (_) {}

    if (primaryCreated) manager._adoptPlacementSortAnchor(primaryCreated);

    if (dropShadowEnabled) {
      try {
        const shadowManager = getAssetShadowManager(manager.app);
        for (const doc of createdDocs) {
          shadowManager?.registerTile?.(doc);
        }
        manager._refreshShadowElevationContext({ adopt: false });
      } catch (e) {
        Logger.warn('Placement.shadow.register.failed', String(e?.message || e));
      }
    }

    if (manager.isPlacementActive) {
      manager._syncPreviewOrdering();
      manager._prepareNextPlacementRotation();
      manager._prepareNextPlacementScale();
      manager._prepareNextPlacementFlip();
    }
    manager._setPlacementFreeze(false, { announce: false });

    if (manager.isStickyMode && manager.isRandomMode) {
      await manager._switchToNextRandomAsset();
      return;
    }

    if (!manager.isStickyMode) { manager.cancelPlacement('completed'); }
  }
}
