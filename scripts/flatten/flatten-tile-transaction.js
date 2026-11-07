const formatError = (error) => String(error?.message || error);

export class FlattenTileTransaction {
  constructor({
    createFlattenedTile,
    deleteOriginalTiles,
    deleteSceneTilesByIds,
    hasSceneTile,
    logger = null
  } = {}) {
    if (typeof createFlattenedTile !== 'function') {
      throw new Error('FlattenTileTransaction requires createFlattenedTile.');
    }
    if (typeof deleteOriginalTiles !== 'function') {
      throw new Error('FlattenTileTransaction requires deleteOriginalTiles.');
    }
    if (typeof deleteSceneTilesByIds !== 'function') {
      throw new Error('FlattenTileTransaction requires deleteSceneTilesByIds.');
    }
    if (typeof hasSceneTile !== 'function') {
      throw new Error('FlattenTileTransaction requires hasSceneTile.');
    }

    this._createFlattenedTile = createFlattenedTile;
    this._deleteOriginalTiles = deleteOriginalTiles;
    this._deleteSceneTilesByIds = deleteSceneTilesByIds;
    this._hasSceneTile = hasSceneTile;
    this._logger = logger;
  }

  async commit({ bounds, filePath, metadata, originals = [] } = {}) {
    return this.commitMany({
      entries: [{ bounds, filePath, metadata }],
      originals
    });
  }

  async commitMany({ entries = [], originals = [] } = {}) {
    const jobs = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
    if (!jobs.length) {
      throw new Error('FlattenTileTransaction requires at least one wrapper entry.');
    }
    const transaction = {
      stage: 'plan',
      filePaths: jobs.map((entry) => String(entry?.filePath || '')).filter(Boolean),
      originalIds: this._resolveOriginalIds(originals),
      originalIdsAlreadyMissing: [],
      createdDocs: [],
      createdTileIds: []
    };

    try {
      transaction.stage = 'create-wrappers';
      for (const [index, entry] of jobs.entries()) {
        const created = await this._createFlattenedTile(entry.bounds, entry.filePath, entry.metadata);
        const docs = this._normalizeCreatedDocs(created);
        const ids = this._resolveCreatedIds(docs);
        if (!ids.length) {
          throw new Error(`Flatten tile transaction created no wrapper tiles for entry ${index + 1}.`);
        }
        transaction.createdDocs.push(...docs);
        transaction.createdTileIds.push(...ids);
      }
      transaction.createdTileIds = Array.from(new Set(transaction.createdTileIds));
      this._log('debug', 'TileFlatten.flatten.commit.wrappersCreated', {
        createdTileIds: transaction.createdTileIds,
        originalIds: transaction.originalIds,
        filePaths: transaction.filePaths
      });

      transaction.stage = 'delete-originals';
      const originalList = Array.isArray(originals) ? originals : [originals];
      const liveOriginals = originalList.filter((doc) => {
        const id = doc?.id || doc?._id || null;
        return !!(id && this._hasSceneTile(id));
      });
      const liveOriginalIds = new Set(this._resolveOriginalIds(liveOriginals));
      transaction.originalIdsAlreadyMissing = transaction.originalIds.filter(
        (id) => !liveOriginalIds.has(id)
      );
      if (transaction.originalIdsAlreadyMissing.length) {
        this._log('warn', 'TileFlatten.flatten.commit.originalsAlreadyMissing', {
          originalIds: transaction.originalIds,
          missingOriginalIds: transaction.originalIdsAlreadyMissing
        });
      }
      await this._deleteOriginalTiles(liveOriginals);

      transaction.stage = 'committed';
      return {
        transaction,
        createdDocs: transaction.createdDocs,
        createdTileIds: transaction.createdTileIds,
        originalIds: transaction.originalIds,
        originalIdsAlreadyMissing: transaction.originalIdsAlreadyMissing,
        createdCount: transaction.createdTileIds.length
      };
    } catch (error) {
      const rollback = await this.rollback(transaction, error);
      if (error && typeof error === 'object') {
        error.flattenTransaction = transaction;
        error.flattenRollback = rollback;
      }
      throw error;
    }
  }

  async rollback(transaction = null, error = null) {
    const stage = String(transaction?.stage || 'unknown');
    const createdTileIds = Array.isArray(transaction?.createdTileIds) && transaction.createdTileIds.length
      ? Array.from(new Set(transaction.createdTileIds.filter(Boolean)))
      : this._resolveCreatedIds(transaction?.createdDocs);
    const rollback = {
      attempted: false,
      ok: true,
      stage,
      createdTileIds,
      commitLikelyApplied: false,
      originalIdsMissing: [],
      remainingTileIds: [],
      deletedCount: 0
    };

    if (!createdTileIds.length || stage === 'committed') return rollback;
    if (stage === 'delete-originals') {
      await this._settleDeleteBoundary();
      const originalIds = Array.isArray(transaction?.originalIds) ? transaction.originalIds : [];
      const originalIdsAlreadyMissing = new Set(
        Array.isArray(transaction?.originalIdsAlreadyMissing)
          ? transaction.originalIdsAlreadyMissing
          : []
      );
      const missingOriginalIds = originalIds.filter(
        (id) => !originalIdsAlreadyMissing.has(id) && !this._hasSceneTile(id)
      );
      if (missingOriginalIds.length) {
        rollback.commitLikelyApplied = true;
        rollback.originalIdsMissing = missingOriginalIds;
        this._log('warn', 'TileFlatten.flatten.rollback.skippedAfterOriginalDelete', {
          stage,
          createdTileIds,
          missingOriginalIds,
          error: formatError(error)
        });
        return rollback;
      }
    }

    rollback.attempted = true;
    this._log('info', 'TileFlatten.flatten.rollback.start', {
      stage,
      createdTileIds,
      error: formatError(error)
    });

    try {
      await this._deleteSceneTilesByIds(createdTileIds, { preserveLinkedCleanup: true });
      await this._settleDeleteBoundary();
      rollback.remainingTileIds = createdTileIds.filter((id) => this._hasSceneTile(id));
      rollback.deletedCount = createdTileIds.length - rollback.remainingTileIds.length;
      if (rollback.remainingTileIds.length) {
        rollback.ok = false;
        this._log('error', 'TileFlatten.flatten.rollback.deleteCreatedTile.incomplete', {
          stage,
          createdTileIds,
          remainingTileIds: rollback.remainingTileIds
        });
        return rollback;
      }
      this._log('info', 'TileFlatten.flatten.rollback.complete', {
        stage,
        deletedCount: rollback.deletedCount
      });
    } catch (deleteError) {
      rollback.ok = false;
      rollback.error = formatError(deleteError);
      this._log('error', 'TileFlatten.flatten.rollback.deleteCreatedTile.failed', {
        stage,
        createdTileIds,
        error: rollback.error
      });
    }

    return rollback;
  }

  _normalizeCreatedDocs(created) {
    if (Array.isArray(created)) return created.filter(Boolean);
    return created ? [created] : [];
  }

  _resolveOriginalIds(originals = []) {
    return Array.from(new Set((Array.isArray(originals) ? originals : [originals])
      .map((doc) => doc?.id || doc?._id || null)
      .filter(Boolean)));
  }

  _resolveCreatedIds(createdDocs = []) {
    return Array.from(new Set((Array.isArray(createdDocs) ? createdDocs : [createdDocs])
      .map((doc) => doc?.id || doc?._id || null)
      .filter(Boolean)));
  }

  async _settleDeleteBoundary() {
    await Promise.resolve();
    if (typeof requestAnimationFrame === 'function') {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    } else if (typeof setTimeout === 'function') {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  _log(level, tag, payload = {}) {
    this._logger?.[level]?.(tag, payload);
  }
}
