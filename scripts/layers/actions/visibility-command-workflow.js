import { NexusLogger as Logger } from '../../core/nexus-logger.js';

const MODULE_ID = 'fa-nexus';

export const bulkLayerDocumentUpdateState = {
  depth: 0,
  renderPending: false
};

export class LayerVisibilityCommandWorkflow {
  constructor(adapters = {}) {
    this.adapters = adapters;
  }

  _adapter(name) {
    const adapter = this.adapters?.[name];
    if (typeof adapter !== 'function') throw new Error(`Layer visibility workflow missing ${name} adapter.`);
    return adapter;
  }

  _buildTileVisibilityCommand(targets = [], {
    nextHidden = null,
    referenceDoc = null
  } = {}) {
    const getTileDocumentId = this._adapter('getTileDocumentId');
    const isLayerHidden = this._adapter('isLayerHidden');
    const buildLayerHiddenUpdate = this._adapter('buildLayerHiddenUpdate');
    const referenceId = getTileDocumentId(referenceDoc);
    const targetReference = referenceId
      ? targets.find((target) => getTileDocumentId(target) === referenceId) || null
      : null;
    const hidden = typeof nextHidden === 'boolean'
      ? nextHidden
      : (targetReference ? !isLayerHidden(targetReference) : !targets.every((target) => isLayerHidden(target)));
    const updates = targets
      .filter((doc) => isLayerHidden(doc) !== hidden)
      .map((doc) => buildLayerHiddenUpdate(doc, hidden))
      .filter(Boolean);
    return { hidden, updates };
  }

  async toggleTileDocsVisibility(docs = [], {
    source = 'unknown',
    nextHidden = null,
    referenceDoc = null
  } = {}) {
    const orderedDocs = this._adapter('orderTileDocuments')(docs);
    if (!orderedDocs.length) return [];
    const scene = this._adapter('getScene')();
    if (!scene?.updateEmbeddedDocuments) throw new Error('No active scene available for layer visibility updates.');
    const requireMutableTileDocuments = this._adapter('requireMutableTileDocuments');
    const targets = requireMutableTileDocuments(orderedDocs, {
      user: game?.user,
      action: 'change visibility for'
    });
    if (!targets.length) return [];
    const selectedIds = this._adapter('getSelectedTileDocIds')();
    if (selectedIds.length) {
      this._adapter('preserveSelectionContext')(
        this._adapter('orderDocsByIds')(selectedIds),
        `visibility:${source}:selected`
      );
    }
    const { hidden, updates } = this._buildTileVisibilityCommand(targets, { nextHidden, referenceDoc });

    if (updates.length) {
      // Foundry's Undo entry holds only the paths that existed before an update. Hiding adds
      // the flag, so on a Tile that already carried other Nexus flags the entry Foundry
      // recorded was empty: Ctrl+Z consumed it and the Tile stayed hidden. The exact inverse
      // is recorded as the Undo step instead, one step for the whole command.
      const getTileDocumentId = this._adapter('getTileDocumentId');
      const isLayerHidden = this._adapter('isLayerHidden');
      const buildLayerHiddenUpdate = this._adapter('buildLayerHiddenUpdate');
      const changedIds = new Set(updates.map((update) => update._id));
      const inverse = targets
        .filter((doc) => changedIds.has(getTileDocumentId(doc)))
        .map((doc) => buildLayerHiddenUpdate(doc, isLayerHidden(doc)))
        .filter(Boolean);
      this._adapter('preserveListScrollTop')(this._adapter('captureListScrollTop')());
      bulkLayerDocumentUpdateState.depth += 1;
      try {
        await this._adapter('updateTileDocuments')(updates, { isUndo: true });
        this._adapter('storeTileHistory')(inverse);
      } finally {
        bulkLayerDocumentUpdateState.depth = Math.max(0, bulkLayerDocumentUpdateState.depth - 1);
        if (bulkLayerDocumentUpdateState.renderPending) {
          bulkLayerDocumentUpdateState.renderPending = false;
          this._adapter('scheduleRender')();
        }
      }
    }
    Logger.info('LayerManager.bulk.visibility.commit', {
      sceneId: this._adapter('getScene')()?.id || null,
      source,
      tileCount: targets.length,
      updateCount: updates.length,
      hidden
    });
    await this._adapter('restoreSelectionAfterBulkTileUpdate')(selectedIds, {
      source: `visibility:${source}`,
      allowAutoExpand: false,
      allowScrollToTile: false
    });
    this._adapter('updateSelectionActions')();
    this._adapter('updateFlattenFooter')();
    return targets;
  }

  _collectSceneMarkerVisibilityEntries(markerId = '') {
    const targetMarkerIds = new Set([String(markerId || '').trim()].filter(Boolean));
    const markerEntries = [];
    const seenTargets = new Set();
    for (const entry of Array.from(this._adapter('getViewEntries')() || [])) {
      if (!entry?.marker) continue;
      if (!targetMarkerIds.has(String(entry.markerId || '').trim())) continue;
      const markerLevelId = String(entry?.markerLevelId || '').trim();
      const markerKind = String(entry?.markerKind || '').trim().toLowerCase();
      const targetKey = `${markerLevelId}:${markerKind}`;
      if (!markerLevelId || !markerKind || seenTargets.has(targetKey)) continue;
      markerEntries.push(entry);
      seenTargets.add(targetKey);
    }
    return markerEntries;
  }

  _buildSceneMarkerVisibilityCommand(scene, markerEntries = [], nextHidden = false) {
    const getLevelTextureHiddenFlagKey = this._adapter('getLevelTextureHiddenFlagKey');
    const updates = [];
    for (const entry of markerEntries) {
      const levelId = String(entry?.markerLevelId || '').trim();
      const markerKind = String(entry?.markerKind || '').trim().toLowerCase();
      const level = scene.levels.get(levelId) || null;
      if (!level?.canUserModify?.(game.user, 'update')) continue;
      const update = { _id: levelId };
      foundry.utils.setProperty(update, `flags.${MODULE_ID}.${getLevelTextureHiddenFlagKey(markerKind)}`, nextHidden);
      updates.push(update);
    }
    const requiresCanvasRedraw = scene === this._adapter('getScene')()
      && !!this._adapter('isCanvasReady')()
      && markerEntries.some((entry) => {
        const levelId = String(entry?.markerLevelId || '').trim();
        const level = levelId ? scene.levels.get(levelId) || null : null;
        return !!level?.isView || !!level?.isVisible;
      });
    return { updates, requiresCanvasRedraw };
  }

  toggleSceneMarkerVisibility(markerId = '') {
    const markerEntries = this._collectSceneMarkerVisibilityEntries(markerId);
    const referenceEntry = markerEntries.find((entry) => String(entry?.markerId || '').trim() === String(markerId || '').trim())
      || markerEntries[0]
      || null;
    if (!referenceEntry) return undefined;
    const nextHidden = !referenceEntry.hidden;
    const scene = this._adapter('getScene')();
    if (!scene?.updateEmbeddedDocuments) {
      throw new Error('No active scene available for level image visibility updates.');
    }
    const { updates, requiresCanvasRedraw } = this._buildSceneMarkerVisibilityCommand(scene, markerEntries, nextHidden);
    if (!updates.length) return undefined;
    this._adapter('preserveListScrollTop')(this._adapter('captureListScrollTop')());
    return this._adapter('updateLevelDocuments')(scene, updates)
      .then(async () => {
        if (requiresCanvasRedraw) {
          await this._adapter('drawCanvas')(scene);
        }
        Logger.info('LayerManager.sceneMarker.visibility.commit', {
          sceneId: scene?.id || null,
          markerCount: updates.length,
          hidden: nextHidden,
          redraw: requiresCanvasRedraw
        });
        this._adapter('scheduleRender')();
        this._adapter('updateFlattenFooter')();
      })
      .catch((error) => this._adapter('notifyActionError')('toggle level image visibility', error));
  }
}
