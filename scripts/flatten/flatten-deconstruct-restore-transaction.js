const MODULE_ID = 'fa-nexus';

const formatError = (error) => String(error?.message || error);

export class FlattenDeconstructRestoreTransaction {
  constructor({
    deepClone,
    deleteSceneTilesByIds,
    resolveFlattenMetadata,
    sceneHasEmbeddedDocument,
    logger = null
  } = {}) {
    if (typeof deepClone !== 'function') {
      throw new Error('FlattenDeconstructRestoreTransaction requires deepClone.');
    }
    if (typeof deleteSceneTilesByIds !== 'function') {
      throw new Error('FlattenDeconstructRestoreTransaction requires deleteSceneTilesByIds.');
    }
    if (typeof resolveFlattenMetadata !== 'function') {
      throw new Error('FlattenDeconstructRestoreTransaction requires resolveFlattenMetadata.');
    }
    if (typeof sceneHasEmbeddedDocument !== 'function') {
      throw new Error('FlattenDeconstructRestoreTransaction requires sceneHasEmbeddedDocument.');
    }

    this._deepClone = deepClone;
    this._deleteSceneTilesByIds = deleteSceneTilesByIds;
    this._resolveFlattenMetadata = resolveFlattenMetadata;
    this._sceneHasEmbeddedDocument = sceneHasEmbeddedDocument;
    this._logger = logger;
  }

  createRestoreTransaction(tileDoc, restoreCount = 0) {
    return {
      flattenedId: tileDoc?.id || null,
      restoreCount,
      stage: 'plan',
      createdDocs: [],
      relinkPlan: null,
      relinkApplied: false
    };
  }

  async commitRestoreTransaction({
    tileDoc,
    metadata,
    payloads = [],
    restoredEntries = [],
    preservedNestedFlattened = 0,
    transaction = null,
    chunkSize = 25,
    onProgress = null,
    beforeCommit = null
  } = {}) {
    if (!canvas?.scene) throw new Error('Scene not available.');
    const restorePayloads = Array.isArray(payloads) ? payloads : [];
    const state = transaction || this.createRestoreTransaction(tileDoc, restorePayloads.length);
    state.restoreCount = restorePayloads.length;

    state.stage = 'create';
    // The server returns created documents in no fixed order, and the relink below pairs each stored Tile with its
    // restored one by position. Each restored Tile gets a fresh id here, and the created documents are put back in the
    // order of the payloads.
    const idsInOrder = restorePayloads.map(() => foundry.utils.randomID());
    const safeChunkSize = Math.max(1, Math.floor(Number(chunkSize) || 25));
    for (let i = 0; i < restorePayloads.length; i += safeChunkSize) {
      const chunkIds = idsInOrder.slice(i, i + safeChunkSize);
      const chunk = restorePayloads.slice(i, i + safeChunkSize).map((payload, index) => ({ ...payload, _id: chunkIds[index] }));
      this._log('debug', 'TileFlatten.deconstruct.createChunk.start', {
        flattenedId: state.flattenedId,
        startIndex: i,
        chunkSize: chunk.length,
        totalPayloads: restorePayloads.length
      });
      const chunkCreated = await canvas.scene.createEmbeddedDocuments('Tile', chunk, { keepId: true });
      const createdById = new Map((Array.isArray(chunkCreated) ? chunkCreated : []).map((doc) => [doc?.id, doc]));
      // Keep what was created for the rollback, then refuse a chunk that did not come back whole.
      state.createdDocs.push(...chunkIds.map((id) => createdById.get(id)).filter(Boolean));
      const missing = chunkIds.filter((id) => !createdById.has(id));
      if (missing.length) throw new Error(`Foundry did not create ${missing.length} of the ${chunkIds.length} restored Tiles.`);
      this._log('debug', 'TileFlatten.deconstruct.createChunk.complete', {
        flattenedId: state.flattenedId,
        startIndex: i,
        createdChunkCount: Array.isArray(chunkCreated) ? chunkCreated.length : 0,
        createdTotal: state.createdDocs.length
      });
      if (typeof onProgress === 'function') {
        onProgress(Math.min(i + chunk.length, restorePayloads.length), restorePayloads.length);
      }
    }

    state.stage = 'hydrate-renderers';
    if (typeof beforeCommit === 'function') await beforeCommit(state.createdDocs, state);

    state.stage = 'plan-relink';
    state.relinkPlan = this.buildRestoredTileReferenceRelinkPlan(metadata, state.createdDocs, restoredEntries);

    state.stage = 'relink';
    state.relinkApplied = true;
    await this.applyRestoredTileReferenceRelinkPlan(state.relinkPlan);

    state.stage = 'commit';
    await canvas.scene.deleteEmbeddedDocuments('Tile', [tileDoc.id]);

    this._log('info', 'TileFlatten.deconstruct.success', {
      restoredCount: restorePayloads.length,
      createdCount: state.createdDocs.length,
      flattenedId: tileDoc.id,
      preservedNestedFlattened: preservedNestedFlattened || 0,
      relinkedTileDocuments: state.relinkPlan?.tileUpdates?.size || 0,
      relinkedWallDocuments: state.relinkPlan?.wallUpdates?.size || 0
    });

    return state;
  }

  buildRestoredTileReferenceRelinkPlan(metadata, createdDocs = [], restoredEntries = null) {
    const restoredIdMap = this._buildRestoredTileIdMap(metadata, createdDocs, restoredEntries);
    const plan = {
      restoredIdMap,
      createdDocs: Array.isArray(createdDocs) ? createdDocs.slice() : [],
      restoredEntries: Array.isArray(restoredEntries) ? restoredEntries.slice() : [],
      tileUpdates: new Map(),
      wallUpdates: new Map(),
      rollbackTileUpdates: new Map(),
      rollbackWallUpdates: new Map(),
      unresolvedBuildingWalls: [],
      tileFieldUpdates: 0,
      wallFieldUpdates: 0
    };
    if (!canvas?.scene || !Array.isArray(createdDocs) || !createdDocs.length || !restoredIdMap.size) return plan;

    const sceneTiles = Array.from(canvas.scene.tiles || []);
    const sceneWalls = Array.from(canvas.scene.walls || []);
    const buildingGroupToTileId = new Map();
    const restoredBuildingGroupIds = new Set();

    const restoredEntriesList = Array.isArray(restoredEntries) ? restoredEntries : [];
    const restoredCount = Math.min(restoredEntriesList.length, createdDocs.length);
    for (let i = 0; i < restoredCount; i += 1) {
      const wallGroupId = restoredEntriesList[i]?.wallGroupId || null;
      const tileId = createdDocs[i]?.id || null;
      if (!wallGroupId || !tileId) continue;
      restoredBuildingGroupIds.add(wallGroupId);
      buildingGroupToTileId.set(wallGroupId, tileId);
    }

    for (const tileDoc of sceneTiles) {
      if (!tileDoc?.id) continue;
      const building = tileDoc.getFlag?.(MODULE_ID, 'building');
      const wallGroupId = building?.meta?.wallGroupId || null;
      if (wallGroupId) buildingGroupToTileId.set(wallGroupId, tileDoc.id);
    }

    const linkedTileFlagKeys = [
      'buildingDoorFrame',
      'buildingWindowSill',
      'buildingWindowWindow',
      'buildingWindowFrame'
    ];

    for (const tileDoc of sceneTiles) {
      if (!tileDoc?.id) continue;

      const building = tileDoc.getFlag?.(MODULE_ID, 'building');
      if (building) {
        const meta = building?.meta || {};
        const nextFillTileId = meta?.fillTileId ? restoredIdMap.get(meta.fillTileId) : null;
        const nextSillTileId = meta?.sillTileId ? restoredIdMap.get(meta.sillTileId) : null;
        const nextParentWallTileId = (
          (meta?.parentWallTileId ? restoredIdMap.get(meta.parentWallTileId) : null)
          || (meta?.parentWallGroupId ? buildingGroupToTileId.get(meta.parentWallGroupId) : null)
        );
        plan.tileFieldUpdates += this._planEmbeddedUpdate(plan.tileUpdates, plan.rollbackTileUpdates, tileDoc, {
          'flags.fa-nexus.building.meta.fillTileId': nextFillTileId && nextFillTileId !== meta.fillTileId
            ? nextFillTileId
            : undefined,
          'flags.fa-nexus.building.meta.sillTileId': nextSillTileId && nextSillTileId !== meta.sillTileId
            ? nextSillTileId
            : undefined,
          'flags.fa-nexus.building.meta.composite.sillTileId': nextSillTileId && nextSillTileId !== meta?.composite?.sillTileId
            ? nextSillTileId
            : undefined,
          'flags.fa-nexus.building.meta.parentWallTileId': nextParentWallTileId && nextParentWallTileId !== meta.parentWallTileId
            ? nextParentWallTileId
            : undefined
        });
      }

      const composite = tileDoc.getFlag?.(MODULE_ID, 'buildingComposite');
      if (composite) {
        const nextWallTileId = composite?.wallTileId ? restoredIdMap.get(composite.wallTileId) : null;
        const nextBackgroundTileId = composite?.backgroundTileId ? restoredIdMap.get(composite.backgroundTileId) : null;
        const nextSillTileId = composite?.sillTileId ? restoredIdMap.get(composite.sillTileId) : null;
        plan.tileFieldUpdates += this._planEmbeddedUpdate(plan.tileUpdates, plan.rollbackTileUpdates, tileDoc, {
          'flags.fa-nexus.buildingComposite.wallTileId': nextWallTileId && nextWallTileId !== composite.wallTileId
            ? nextWallTileId
            : undefined,
          'flags.fa-nexus.buildingComposite.backgroundTileId': nextBackgroundTileId && nextBackgroundTileId !== composite.backgroundTileId
            ? nextBackgroundTileId
            : undefined,
          'flags.fa-nexus.buildingComposite.sillTileId': nextSillTileId && nextSillTileId !== composite.sillTileId
            ? nextSillTileId
            : undefined
        });
      }

      for (const flagKey of linkedTileFlagKeys) {
        const linked = tileDoc.getFlag?.(MODULE_ID, flagKey);
        if (!linked) continue;
        const nextWallTileId = (
          (linked?.wallTileId ? restoredIdMap.get(linked.wallTileId) : null)
          || (linked?.wallGroupId ? buildingGroupToTileId.get(linked.wallGroupId) : null)
        );
        if (!nextWallTileId || nextWallTileId === linked?.wallTileId) continue;
        plan.tileFieldUpdates += this._planEmbeddedUpdate(plan.tileUpdates, plan.rollbackTileUpdates, tileDoc, {
          [`flags.fa-nexus.${flagKey}.wallTileId`]: nextWallTileId
        });
      }
    }

    for (const wallDoc of sceneWalls) {
      if (!wallDoc?.id) continue;

      const buildingWall = wallDoc.getFlag?.(MODULE_ID, 'buildingWall');
      if (
        buildingWall
        && (restoredIdMap.has(buildingWall?.tileId) || restoredBuildingGroupIds.has(buildingWall?.groupId))
      ) {
        const nextTileId = (
          (buildingWall?.tileId ? restoredIdMap.get(buildingWall.tileId) : null)
          || (buildingWall?.groupId ? buildingGroupToTileId.get(buildingWall.groupId) : null)
        );
        if (nextTileId && nextTileId !== buildingWall?.tileId) {
          plan.wallFieldUpdates += this._planEmbeddedUpdate(plan.wallUpdates, plan.rollbackWallUpdates, wallDoc, {
            'flags.fa-nexus.buildingWall.tileId': nextTileId,
            'flags.fa-nexus.buildingWall.updatedAt': Date.now()
          });
        } else if (!nextTileId && (buildingWall?.tileId || buildingWall?.groupId)) {
          plan.unresolvedBuildingWalls.push({
            wallId: wallDoc.id,
            tileId: buildingWall?.tileId || null,
            groupId: buildingWall?.groupId || null
          });
        }
      }

      const pathWall = wallDoc.getFlag?.(MODULE_ID, 'pathWall');
      const nextPathTileId = pathWall?.tileId ? restoredIdMap.get(pathWall.tileId) : null;
      if (nextPathTileId && nextPathTileId !== pathWall?.tileId) {
        plan.wallFieldUpdates += this._planEmbeddedUpdate(plan.wallUpdates, plan.rollbackWallUpdates, wallDoc, {
          'flags.fa-nexus.pathWall.tileId': nextPathTileId,
          'flags.fa-nexus.pathWall.updatedAt': Date.now()
        });
      }
    }

    this._log('debug', 'TileFlatten.deconstruct.relink.plan', {
      restoredTiles: createdDocs.length,
      remappedTileIds: restoredIdMap.size,
      tileDocuments: plan.tileUpdates.size,
      wallDocuments: plan.wallUpdates.size,
      tileFieldUpdates: plan.tileFieldUpdates,
      wallFieldUpdates: plan.wallFieldUpdates
    });

    return plan;
  }

  async applyRestoredTileReferenceRelinkPlan(plan = null) {
    if (!plan?.restoredIdMap?.size) return { tileUpdateCount: 0, wallUpdateCount: 0 };

    const tileUpdateCount = await this._applyEmbeddedUpdates('Tile', plan.tileUpdates);
    const wallUpdateCount = await this._applyEmbeddedUpdates('Wall', plan.wallUpdates);

    if (plan.unresolvedBuildingWalls.length) {
      this._log('warn', 'TileFlatten.deconstruct.relinkMissingBuildingWalls', {
        restoredTiles: plan.createdDocs.length,
        remappedTileIds: plan.restoredIdMap.size,
        unresolvedBuildingWalls: plan.unresolvedBuildingWalls
      });
    }

    this._log('info', 'TileFlatten.deconstruct.relinked', {
      restoredTiles: plan.createdDocs.length,
      remappedTileIds: plan.restoredIdMap.size,
      tileUpdates: tileUpdateCount,
      wallUpdates: wallUpdateCount
    });

    return { tileUpdateCount, wallUpdateCount };
  }

  async rollbackRestoredTileReferenceRelinkPlan(plan = null, { flattenedId = null, stage = 'unknown' } = {}) {
    const rollbackSummary = {
      attempted: false,
      ok: true,
      tileUpdates: 0,
      wallUpdates: 0
    };
    if (!plan) return rollbackSummary;

    const hasTileRollback = plan.rollbackTileUpdates instanceof Map && plan.rollbackTileUpdates.size > 0;
    const hasWallRollback = plan.rollbackWallUpdates instanceof Map && plan.rollbackWallUpdates.size > 0;
    if (!hasTileRollback && !hasWallRollback) return rollbackSummary;

    rollbackSummary.attempted = true;
    this._log('info', 'TileFlatten.deconstruct.rollback.relink.start', {
      flattenedId,
      stage,
      tileDocuments: plan.rollbackTileUpdates?.size || 0,
      wallDocuments: plan.rollbackWallUpdates?.size || 0
    });

    try {
      rollbackSummary.wallUpdates = await this._applyEmbeddedUpdates('Wall', plan.rollbackWallUpdates);
    } catch (error) {
      rollbackSummary.ok = false;
      rollbackSummary.wallError = formatError(error);
      this._log('error', 'TileFlatten.deconstruct.rollback.relinkWalls.failed', {
        flattenedId,
        stage,
        error: rollbackSummary.wallError
      });
    }

    try {
      rollbackSummary.tileUpdates = await this._applyEmbeddedUpdates('Tile', plan.rollbackTileUpdates);
    } catch (error) {
      rollbackSummary.ok = false;
      rollbackSummary.tileError = formatError(error);
      this._log('error', 'TileFlatten.deconstruct.rollback.relinkTiles.failed', {
        flattenedId,
        stage,
        error: rollbackSummary.tileError
      });
    }

    if (rollbackSummary.ok) {
      this._log('info', 'TileFlatten.deconstruct.rollback.relink.complete', {
        flattenedId,
        stage,
        tileUpdates: rollbackSummary.tileUpdates,
        wallUpdates: rollbackSummary.wallUpdates
      });
    }

    return rollbackSummary;
  }

  async rollbackDeconstructRestoreTransaction(tileDoc, transaction = null, error = null) {
    const createdDocs = Array.isArray(transaction?.createdDocs) ? transaction.createdDocs.filter(Boolean) : [];
    const createdTileIds = createdDocs.map((doc) => doc?.id).filter(Boolean);
    const flattenedId = transaction?.flattenedId || tileDoc?.id || null;
    const stage = String(transaction?.stage || 'unknown');
    const rollback = {
      attempted: false,
      ok: true,
      stage,
      flattenedId,
      createdCount: createdTileIds.length,
      createdTileIds,
      commitLikelyApplied: false,
      markerWritten: false,
      relinkRollback: {
        attempted: false,
        ok: true,
        tileUpdates: 0,
        wallUpdates: 0
      },
      deleteRollback: {
        attempted: false,
        ok: true,
        deletedCount: 0
      }
    };

    const wrapperStillPresent = this._hasEmbeddedDocument('Tile', flattenedId);
    rollback.wrapperStillPresent = wrapperStillPresent;
    if (stage === 'commit' && !wrapperStillPresent) {
      rollback.commitLikelyApplied = true;
      this._log('warn', 'TileFlatten.deconstruct.rollback.skippedAfterWrapperDelete', {
        flattenedId,
        stage,
        createdCount: createdTileIds.length,
        error: formatError(error)
      });
      return rollback;
    }

    if (!createdTileIds.length && !transaction?.relinkApplied) return rollback;

    rollback.attempted = true;
    this._log('info', 'TileFlatten.deconstruct.rollback.start', {
      flattenedId,
      stage,
      createdCount: createdTileIds.length,
      relinkApplied: !!transaction?.relinkApplied
    });

    if (transaction?.relinkApplied && transaction?.relinkPlan) {
      rollback.relinkRollback = await this.rollbackRestoredTileReferenceRelinkPlan(transaction.relinkPlan, {
        flattenedId,
        stage
      });
      if (!rollback.relinkRollback.ok) rollback.ok = false;
    }

    if (rollback.ok && createdTileIds.length) {
      try {
        await this._deleteSceneTilesByIds(createdTileIds, {
          preserveLinkedCleanup: true
        });
        rollback.deleteRollback = {
          attempted: true,
          ok: true,
          deletedCount: createdTileIds.length
        };
      } catch (deleteError) {
        rollback.ok = false;
        rollback.deleteRollback = {
          attempted: true,
          ok: false,
          deletedCount: 0,
          error: formatError(deleteError)
        };
        this._log('error', 'TileFlatten.deconstruct.rollback.deleteCreatedTiles.failed', {
          flattenedId,
          stage,
          createdTileIds,
          error: rollback.deleteRollback.error
        });
      }
    } else if (createdTileIds.length) {
      this._log('warn', 'TileFlatten.deconstruct.rollback.deleteCreatedTiles.skipped', {
        flattenedId,
        stage,
        createdTileIds
      });
    }

    if (!rollback.ok && this._hasEmbeddedDocument('Tile', flattenedId)) {
      rollback.markerWritten = await this._recordDeconstructRollbackFailure(tileDoc, {
        stage,
        error,
        createdTileIds,
        relinkRollback: rollback.relinkRollback,
        deleteRollback: rollback.deleteRollback
      });
    }

    this._log(rollback.ok ? 'info' : 'error', rollback.ok
      ? 'TileFlatten.deconstruct.rollback.complete'
      : 'TileFlatten.deconstruct.rollback.failed', {
        flattenedId,
        stage,
        createdCount: createdTileIds.length,
        relinkRollbackOk: rollback.relinkRollback.ok,
        deleteRollbackOk: rollback.deleteRollback.ok,
        markerWritten: rollback.markerWritten
      });

    return rollback;
  }

  _buildRestoredTileIdMap(metadata, createdDocs = [], restoredEntries = null) {
    const entries = Array.isArray(restoredEntries) ? restoredEntries : (Array.isArray(metadata?.tiles) ? metadata.tiles : []);
    const restored = Array.isArray(createdDocs) ? createdDocs : [];
    const map = new Map();
    const count = Math.min(entries.length, restored.length);
    for (let i = 0; i < count; i += 1) {
      const oldId = entries[i]?.id || null;
      const newId = restored[i]?.id || null;
      if (!oldId || !newId || oldId === newId) continue;
      map.set(oldId, newId);
    }
    if (entries.length !== restored.length) {
      this._log('warn', 'TileFlatten.deconstruct.restoreCountMismatch', {
        metadataTiles: entries.length,
        restoredTiles: restored.length
      });
    }
    return map;
  }

  _getEmbeddedDocumentUpdateValue(doc, path) {
    if (!doc || !path) return undefined;
    const source = doc?._source && (typeof doc._source === 'object')
      ? doc._source
      : (typeof doc?.toObject === 'function' ? doc.toObject() : doc);
    try {
      if (foundry?.utils?.getProperty) return foundry.utils.getProperty(source, path);
    } catch (_) {}

    let current = source;
    for (const key of String(path).split('.')) {
      if (current == null) return undefined;
      current = current[key];
    }
    return current;
  }

  _queueEmbeddedUpdate(updateMap, docId, changes = null) {
    if (!(updateMap instanceof Map) || !docId || !changes || typeof changes !== 'object') return;
    const entries = Object.entries(changes).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const payload = updateMap.get(docId) || { _id: docId };
    for (const [key, value] of entries) payload[key] = value;
    updateMap.set(docId, payload);
  }

  _planEmbeddedUpdate(updateMap, rollbackMap, doc, changes = null) {
    const docId = doc?.id || doc?._id || null;
    if (!(updateMap instanceof Map) || !(rollbackMap instanceof Map) || !docId || !changes || typeof changes !== 'object') return 0;

    let changed = 0;
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      const previousValue = this._getEmbeddedDocumentUpdateValue(doc, key);
      if (Object.is(previousValue, value)) continue;

      this._queueEmbeddedUpdate(updateMap, docId, { [key]: value });
      const rollbackKey = previousValue === undefined ? key.replace(/([^.]+)$/, '-=$1') : key;
      this._queueEmbeddedUpdate(rollbackMap, docId, {
        [rollbackKey]: previousValue === undefined ? null : this._deepClone(previousValue)
      });
      changed += 1;
    }

    return changed;
  }

  async _applyEmbeddedUpdates(documentName, updateMap, chunkSize = 50) {
    if (!canvas?.scene || !(updateMap instanceof Map) || !updateMap.size) return 0;
    const updates = [...updateMap.values()];
    for (let i = 0; i < updates.length; i += chunkSize) {
      const chunk = updates.slice(i, i + chunkSize);
      await canvas.scene.updateEmbeddedDocuments(documentName, chunk);
    }
    return updates.length;
  }

  async _recordDeconstructRollbackFailure(tileDoc, details = {}) {
    const liveDoc = canvas?.scene?.tiles?.get?.(tileDoc?.id) || tileDoc || null;
    if (!liveDoc?.id || !this._hasEmbeddedDocument('Tile', liveDoc.id)) return false;

    try {
      const metadata = this._resolveFlattenMetadata(liveDoc);
      if (!metadata) return false;
      metadata.deconstructFailure = {
        failedAt: Date.now(),
        stage: String(details?.stage || 'unknown'),
        error: String(details?.error?.message || details?.error || ''),
        createdTileIds: Array.isArray(details?.createdTileIds) ? details.createdTileIds.filter(Boolean) : [],
        relinkRollbackOk: details?.relinkRollback?.ok !== false,
        deleteRollbackOk: details?.deleteRollback?.ok !== false
      };
      await liveDoc.setFlag?.(MODULE_ID, 'flattened', metadata);
      this._log('warn', 'TileFlatten.deconstruct.rollback.markerWritten', {
        tileId: liveDoc.id,
        stage: metadata.deconstructFailure.stage,
        createdTileIds: metadata.deconstructFailure.createdTileIds
      });
      return true;
    } catch (markerError) {
      this._log('error', 'TileFlatten.deconstruct.rollback.markerFailed', {
        tileId: liveDoc?.id || null,
        stage: String(details?.stage || 'unknown'),
        error: formatError(markerError)
      });
      return false;
    }
  }

  _hasEmbeddedDocument(documentName, docId) {
    return !!this._sceneHasEmbeddedDocument(documentName, docId);
  }

  _log(level, tag, payload = {}) {
    const method = this._logger?.[level];
    if (typeof method === 'function') method.call(this._logger, tag, payload);
  }
}
