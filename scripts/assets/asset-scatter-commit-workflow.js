import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { preserveTileDocumentCustomSettingsForUpdate } from '../canvas/tile-document-payloads.js';
import { applyAssetScatterTile } from './asset-scatter-geometry.js';
import {
  readScatterTilePose,
  scatterInstanceGeometrySignature
} from './asset-scatter-tile-transform.js';

const SCATTER_FLAG_KEY = 'assetScatter';

function cloneDocumentSource(document) {
  const source = document?.toObject?.() ?? document?._source;
  if (!source || typeof source !== 'object') {
    throw new Error('Scatter Edit could not capture the source Tile for rollback.');
  }
  return structuredClone(source);
}

// What separates the Tile now from an earlier source of it, as an update: changed fields carry
// the earlier value and fields added since are forced deletions.
function differenceFrom(current, earlier) {
  const diffObject = globalThis.foundry?.utils?.diffObject;
  if (typeof diffObject !== 'function') {
    throw new Error('Foundry bidirectional diff is unavailable for Scatter Edit.');
  }
  const difference = diffObject(current, earlier, { bidirectional: true });
  delete difference._stats;
  return difference;
}

export class AssetScatterCommitWorkflow {
  constructor(manager) {
    if (!manager) throw new Error('AssetScatterCommitWorkflow requires manager.');
    this.manager = manager;
  }

  /**
   * Scatter Edit writes every stroke to the Tile when the pointer is released, so that the Tile
   * and its shadow follow the brush. Cancel therefore has something to take back: the Tile as it
   * was when the editor opened is kept here, together with the newest native Undo entry of that
   * moment.
   */
  captureEditSessionStart(doc) {
    this.manager._scatterEditSessionStart = {
      source: cloneDocumentSource(doc),
      historyTop: globalThis.canvas?.tiles?.history?.at?.(-1) ?? null
    };
  }

  /** Whether Cancel would lose anything: strokes already written, or changes not yet applied. */
  hasEditSessionChanges() {
    const manager = this.manager;
    const start = manager._scatterEditSessionStart;
    const tile = manager._scatterEditTile;
    if (!start || !tile) return true;
    const instances = Array.isArray(manager._scatterPreviewInstances) ? manager._scatterPreviewInstances : [];
    if (manager._hasScatterEditGeometryChanges(instances) || manager._hasScatterEditAppearanceChanges()) return true;
    return Object.keys(differenceFrom(cloneDocumentSource(tile), start.source)).length > 0;
  }

  /**
   * Cancel: the Tile returns to its state when the editor opened, and the native Undo entries
   * of the cancelled strokes go with them, so that Ctrl+Z cannot bring one back.
   */
  async discardEditChanges() {
    const manager = this.manager;
    const start = manager._scatterEditSessionStart;
    const tile = manager._scatterEditTile;
    if (!manager._scatterEditing || !tile || !start || !canvas?.scene) return { status: 'noop' };
    try {
      await manager._scatterCommitSession.drainQueue({
        loggerTag: 'Placement.scatter.discard.queueDrainFailed'
      });
      return { status: await this._restoreEditSessionStart(start, tile, 'scatter-edit-discard') };
    } catch (error) {
      Logger.error('Placement.scatter.discard.failed', { error: String(error?.message || error) });
      globalThis.ui?.notifications?.error?.(`Unable to cancel Scatter edits: ${error?.message || error}`);
      throw error;
    }
  }

  /**
   * Put the Tile back to what it was when the editor opened, without a step in native Undo, and forget the
   * steps of the session's strokes. Returns 'restored', or 'noop' when the Tile was already in that state.
   */
  async _restoreEditSessionStart(start, tile, reason) {
    const manager = this.manager;
    const restore = differenceFrom(cloneDocumentSource(tile), start.source);
    let status = 'noop';
    if (Object.keys(restore).length) {
      const restored = await canvas.scene.updateEmbeddedDocuments('Tile', [{ _id: tile.id, ...restore }], {
        diff: false,
        isUndo: true,
        faNexusAssetScatterNativeRollback: true
      });
      if (!Array.isArray(restored) || !restored[0]) {
        throw new Error('Scatter Edit returned no restored Tile.');
      }
      manager._scatterEditTile = restored[0];
      if (restored[0].object) {
        await applyAssetScatterTile(restored[0].object, { reason, throwOnError: true });
      }
      status = 'restored';
    }
    this._forgetEditSessionHistory(start, tile.id);
    return status;
  }

  _forgetEditSessionHistory(start, tileId) {
    const history = globalThis.canvas?.tiles?.history;
    if (!Array.isArray(history)) return;
    const first = start.historyTop ? history.lastIndexOf(start.historyTop) + 1 : 0;
    for (let index = history.length - 1; index >= first; index -= 1) {
      const entry = history[index];
      if (entry?.type !== 'update' || !Array.isArray(entry.data) || !entry.data.length) continue;
      if (entry.data.every((data) => data?._id === tileId)) history.splice(index, 1);
    }
  }

  async commitGroups(groups) {
    const manager = this.manager;
    if (!Array.isArray(groups) || !groups.length || !canvas?.scene) return;
    const tileDataList = [];
    for (const group of groups) {
      const elevation = Number.isFinite(group.elevation) ? group.elevation : manager._previewElevation;
      const tileData = manager._buildScatterGroupTileData(group.instances, elevation, group.shadowSettings || null, group.sort);
      if (tileData) tileDataList.push(tileData);
    }
    if (!tileDataList.length) return;
    try {
      await canvas.scene.createEmbeddedDocuments('Tile', tileDataList);
      if (manager.isPlacementActive) manager._syncPreviewOrdering();
    } catch (error) {
      Logger.warn('Placement.scatter.merge.failed', String(error?.message || error));
    }
  }

  async commitMergeSession() {
    const manager = this.manager;
    if (manager._scatterEditing) {
      manager._resetScatterMergeSession();
      return;
    }
    if (!manager._scatterSessionActive) {
      manager._resetScatterMergeSession();
      return;
    }
    await manager._scatterCommitSession.drainQueue({
      loggerTag: 'Placement.scatter.merge.queueDrainFailed'
    });

    const groups = manager._collectScatterCommitGroups();
    manager._resetScatterMergeSession();
    await this.commitGroups(groups);
  }

  /**
   * Apply: everything the session wrote becomes one native Undo step back to the Tile as the editor found it,
   * and no step at all when the Tile ended up unchanged.
   */
  collapseEditSessionHistory() {
    const manager = this.manager;
    const start = manager._scatterEditSessionStart;
    const tile = manager._scatterEditTile;
    const layer = globalThis.canvas?.tiles;
    if (!start || !tile || !Array.isArray(layer?.history) || !canvas?.scene?.tiles?.get?.(tile.id)) return;
    this._forgetEditSessionHistory(start, tile.id);
    const current = cloneDocumentSource(tile);
    const restore = differenceFrom(current, start.source);
    const changed = Object.keys(globalThis.foundry.utils.flattenObject(restore));
    if (!changed.length) return;
    // Instances that were erased and brought back are stored again with the same angle written another way
    // (-68 for 292): the same scatter, as the editor's own comparison sees it, is not a step worth undoing.
    const instancesKey = `flags.fa-nexus.${SCATTER_FLAG_KEY}.instances`;
    const signature = (source) => scatterInstanceGeometrySignature(
      Array.from(source?.flags?.['fa-nexus']?.[SCATTER_FLAG_KEY]?.instances || [])
        .map((instance) => ({ ...instance, r: (((Number(instance?.r) || 0) % 360) + 360) % 360 }))
    );
    if (changed.every((key) => key === instancesKey) && signature(current) === signature(start.source)) return;
    layer.storeHistory('update', [{ _id: tile.id, ...restore }]);
  }

  /**
   * Write the editor's current state to the Tile. Requests run one after the other: a stroke, the editor's Undo or
   * Redo and Apply can follow each other faster than a write completes, and each must compare with what the one
   * before it wrote. `final` is the user's Apply (or a way out that saves): only then is an emptied Scatter deleted.
   */
  commitEditChanges({ final = false } = {}) {
    const run = () => this._commitEditChangesNow({ final });
    const result = (this._editCommitQueue || Promise.resolve()).then(run, run);
    this._editCommitQueue = result.catch(() => {});
    return result;
  }

  async _commitEditChangesNow({ final = false } = {}) {
    const manager = this.manager;
    if (!manager._scatterEditing || !manager._scatterEditTile || !canvas?.scene) return;
    if (!canvas.scene.tiles?.get?.(manager._scatterEditTile.id)) return { status: 'missing' };
    const instances = Array.isArray(manager._scatterPreviewInstances) ? manager._scatterPreviewInstances : [];
    if (!instances.length) {
      // Every instance is erased. While the editor is open the Tile stays (hidden behind the empty preview, with
      // what the stroke before wrote): the editor's Undo and Cancel need it. Apply deletes it, as one native Undo
      // step back to the Tile the editor found.
      if (!final) return { status: 'empty' };
      try {
        const start = manager._scatterEditSessionStart;
        if (start) await this._restoreEditSessionStart(start, manager._scatterEditTile, 'scatter-edit-delete');
        await canvas.scene.deleteEmbeddedDocuments('Tile', [manager._scatterEditTile.id]);
        return { status: 'deleted' };
      } catch (error) {
        Logger.error('Placement.scatter.edit.failed', { error: String(error?.message || error) });
        globalThis.ui?.notifications?.error?.(`Unable to delete Scatter Tile: ${error?.message || error}`);
        throw error;
      }
    }
    const geometryChanged = manager._hasScatterEditGeometryChanges(instances);
    const appearanceChanged = manager._hasScatterEditAppearanceChanges();
    // The preview row moved in the Layer Manager: the Tile's Elevation and its place in the order.
    const placement = {};
    if (manager._scatterEditPlacementMoved) {
      const elevation = Number(manager._previewElevation);
      const sort = Number(manager._previewSort);
      if (Number.isFinite(elevation) && elevation !== Number(manager._scatterEditTile.elevation)) placement.elevation = elevation;
      if (Number.isFinite(sort) && sort !== Number(manager._scatterEditTile.sort)) placement.sort = sort;
    }
    const placementChanged = Object.keys(placement).length > 0;
    if (!geometryChanged && !appearanceChanged && !placementChanged) return { status: 'noop' };
    let rollbackSource = null;
    let documentUpdated = false;
    try {
      const update = manager._buildScatterGroupTileUpdate(instances, manager._scatterEditTile, {
        includeGeometry: geometryChanged,
        includeAppearance: appearanceChanged
      });
      if (!update) throw new Error('Scatter Edit could not build an authoritative Tile update.');
      Object.assign(update, placement);
      // What this write carries. The preview may move on (a stroke, Undo, Redo) before the write returns.
      const writtenGeometry = scatterInstanceGeometrySignature(instances);
      const writtenAppearance = manager._buildScatterEditAppearanceSignature();
      rollbackSource = cloneDocumentSource(manager._scatterEditTile);
      preserveTileDocumentCustomSettingsForUpdate(manager._scatterEditTile, update);
      const updated = await canvas.scene.updateEmbeddedDocuments('Tile', [update], {
        diff: false,
        faNexusAssetScatterEditCommit: true
      });
      if (!Array.isArray(updated) || !updated[0]) {
        throw new Error('Scatter Edit update returned no authoritative Tile.');
      }
      documentUpdated = true;
      manager._scatterEditTile = updated[0];
      if (!updated[0].object) throw new Error('Scatter Edit updated Tile has no active renderer object.');
      await applyAssetScatterTile(updated[0].object, {
        reason: 'scatter-edit-commit',
        throwOnError: true
      });
      manager._scatterEditState = {
        tilePose: readScatterTilePose(updated[0]),
        baselineSignature: writtenGeometry,
        appearanceSignature: writtenAppearance
      };
      return { status: 'committed', document: manager._scatterEditTile };
    } catch (error) {
      if (documentUpdated) {
        try {
          const currentSource = cloneDocumentSource(manager._scatterEditTile);
          const diffObject = globalThis.foundry?.utils?.diffObject;
          if (typeof diffObject !== 'function') {
            throw new Error('Foundry bidirectional diff is unavailable for Scatter Edit rollback.');
          }
          const rollbackUpdate = {
            _id: manager._scatterEditTile.id,
            ...diffObject(currentSource, rollbackSource, { bidirectional: true })
          };
          const restored = await canvas.scene.updateEmbeddedDocuments('Tile', [rollbackUpdate], {
            diff: false,
            faNexusAssetScatterNativeRollback: true
          });
          if (!Array.isArray(restored) || !restored[0]) {
            throw new Error('Scatter Edit rollback returned no restored Tile.');
          }
          manager._scatterEditTile = restored[0];
          if (restored[0].object) {
            await applyAssetScatterTile(restored[0].object, {
              reason: 'scatter-edit-rollback',
              throwOnError: true
            });
          }
        } catch (rollbackError) {
          Logger.error('Placement.scatter.edit.rollback.failed', {
            error: String(rollbackError?.message || rollbackError),
            cause: String(error?.message || error)
          });
          const failure = new Error(
            `Scatter Edit failed and rollback could not restore the Tile: ${rollbackError?.message || rollbackError}`,
            { cause: error }
          );
          globalThis.ui?.notifications?.error?.(failure.message);
          throw failure;
        }
      }
      Logger.error('Placement.scatter.edit.failed', { error: String(error?.message || error) });
      globalThis.ui?.notifications?.error?.(`Unable to apply Scatter edits: ${error?.message || error}`);
      throw error;
    }
  }
}
