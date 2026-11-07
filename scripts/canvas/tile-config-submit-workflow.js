const REQUIRED_DEPENDENCIES = Object.freeze([
  'Logger',
  'getFaNexusTileCapabilities',
  'getLiveTileForDocument',
  'createPreviewTileDocumentProxy',
  'applyAssetScatterTile',
  'applyPathTile',
  'applyBuildingTile',
  'applyMaskedTilingToTile',
  'applyStandardTileMaskToTile',
  'applyTileHsbc',
  'applyTileHsbcToMesh',
  'applyCustomRendererHsbcSubmit',
  'applyPathShadowOffsetSubmit',
  'applyBuildingPathShadowSubmit',
  'supportsTileShadowControls',
  'buildElevationShadowSubmit',
  'stripElevationShadowSubmit',
  'getShadowPreviewManager',
  'getDocumentElevation',
  'shouldApplyElevationShadowSettings'
]);

export class TileConfigSubmitWorkflow {
  constructor(deps = {}) {
    for (const key of REQUIRED_DEPENDENCIES) {
      if (deps[key] == null) {
        throw new Error(`TileConfigSubmitWorkflow requires dependency "${key}".`);
      }
    }
    this.deps = deps;
  }

  async refreshCustomRenderedTileDocument(doc, { reason = 'tile-config-close' } = {}) {
    const {
      Logger,
      getFaNexusTileCapabilities,
      getLiveTileForDocument,
      createPreviewTileDocumentProxy,
      applyAssetScatterTile,
      applyPathTile,
      applyBuildingTile,
      applyMaskedTilingToTile,
      applyStandardTileMaskToTile,
      applyTileHsbc,
      applyTileHsbcToMesh
    } = this.deps;
    const capabilities = getFaNexusTileCapabilities(doc);
    const needsCustomRefresh = !!(
      capabilities?.hasAssetScatter
      || capabilities?.hasPathV2
      || capabilities?.hasPathsV2
      || capabilities?.hasBuilding
      || capabilities?.hasMaskedTiling
      || capabilities?.hasStandardTileMask
    );
    if (!needsCustomRefresh) return;
    const tile = getLiveTileForDocument(doc);
    if (!tile) {
      Logger.warn('TileConfig.customRenderer.refresh.missingTile', {
        tileId: doc?.id || null,
        reason
      });
      return;
    }
    const renderTile = createPreviewTileDocumentProxy(tile, doc);
    const jobs = [];
    const queueRendererJob = (label, promiseFactory) => {
      jobs.push(Promise.resolve()
        .then(promiseFactory)
        .catch((error) => {
          Logger.warn(`TileConfig.customRenderer.refresh.${label}.failed`, {
            tileId: doc?.id || null,
            reason,
            error: String(error?.message || error)
          });
        }));
    };
    if (capabilities?.hasAssetScatter) {
      queueRendererJob('scatterApply', () => applyAssetScatterTile(renderTile));
    }
    if (capabilities?.hasPathV2 || capabilities?.hasPathsV2) {
      queueRendererJob('pathApply', () => applyPathTile(renderTile));
    }
    if (capabilities?.hasBuilding) {
      queueRendererJob('buildingApply', () => applyBuildingTile(renderTile));
    }
    if (capabilities?.hasMaskedTiling) {
      queueRendererJob('maskedApply', () => applyMaskedTilingToTile(renderTile));
    }
    await Promise.allSettled(jobs);
    if (capabilities?.hasStandardTileMask) {
      try {
        await applyStandardTileMaskToTile(renderTile);
      } catch (error) {
        Logger.warn('TileConfig.customRenderer.refresh.standardMaskApply.failed', {
          tileId: doc?.id || null,
          reason,
          error: String(error?.message || error)
        });
      }
    }
    try { applyTileHsbc(doc); } catch (error) {
      Logger.warn('TileConfig.customRenderer.refresh.hsbcApply.failed', {
        tileId: doc?.id || null,
        reason,
        error: String(error?.message || error)
      });
    }
    try { applyTileHsbcToMesh(renderTile, tile.mesh); } catch (error) {
      Logger.warn('TileConfig.customRenderer.refresh.maskedHsbcApply.failed', {
        tileId: doc?.id || null,
        reason,
        error: String(error?.message || error)
      });
    }
  }

  scheduleCustomRendererRefreshAfterClose(app, { reason = 'tile-config-close' } = {}) {
    const {
      Logger
    } = this.deps;
    const doc = app?.document || null;
    if (!doc) return;
    const run = () => {
      this.refreshCustomRenderedTileDocument(doc, { reason }).catch((error) => {
        Logger.warn('TileConfig.customRenderer.refresh.failed', {
          tileId: doc?.id || null,
          reason,
          error: String(error?.message || error)
        });
      });
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(run, 0));
      return;
    }
    setTimeout(run, 0);
  }

  async wrapElevationShadowSubmit(appInstance, submitData, runSubmit, { app } = {}) {
    const {
      Logger,
      applyCustomRendererHsbcSubmit,
      applyPathShadowOffsetSubmit,
      applyBuildingPathShadowSubmit,
      supportsTileShadowControls,
      buildElevationShadowSubmit,
      stripElevationShadowSubmit,
      getShadowPreviewManager,
      getDocumentElevation,
      shouldApplyElevationShadowSettings
    } = this.deps;
    const doc = appInstance?.document || app?.document || null;
    const shouldManageElevationShadow = !!doc && supportsTileShadowControls(doc);
    const deepClone = globalThis?.foundry?.utils?.deepClone;
    const nextSubmitData = typeof deepClone === 'function'
      ? deepClone(submitData)
      : { ...(submitData || {}) };
    try { applyCustomRendererHsbcSubmit(appInstance, nextSubmitData); } catch (error) {
      Logger.error('TileConfig.hsbc.submit.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      throw error;
    }
    try { applyPathShadowOffsetSubmit(appInstance, nextSubmitData); } catch (error) {
      Logger.error('TileConfig.pathShadow.submit.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      throw error;
    }
    try { applyBuildingPathShadowSubmit(appInstance, nextSubmitData); } catch (error) {
      Logger.error('TileConfig.buildingShadow.submit.failed', {
        tileId: doc?.id || null,
        error: String(error?.message || error)
      });
      throw error;
    }
    const elevationShadowSettings = shouldManageElevationShadow ? buildElevationShadowSubmit(appInstance, nextSubmitData) : null;
    if (shouldManageElevationShadow) stripElevationShadowSubmit(nextSubmitData);

    const result = await runSubmit(nextSubmitData);
    if (!shouldManageElevationShadow) return result;

    const manager = getShadowPreviewManager(appInstance);
    const targetDoc = appInstance?.document || doc || null;
    const elevation = getDocumentElevation(targetDoc, getDocumentElevation(doc));
    if (!manager?.applyElevationSettings) {
      Logger.error('TileConfig.shadowElevation.submit.missingManager', {
        tileId: targetDoc?.id || doc?.id || null,
        elevation
      });
      globalThis?.ui?.notifications?.error?.('Tile updated, but elevation shadow blur/opacity did not apply. Check FA Nexus shadow manager availability.');
      return result;
    }

    const elevationSnapshot = manager.getElevationSettings?.(elevation) || null;
    if (!elevationSnapshot?.hasTiles) return result;
    if (!shouldApplyElevationShadowSettings(manager, elevation, elevationShadowSettings)) return result;

    const applied = await manager.applyElevationSettings(elevation, elevationShadowSettings);
    if (!applied) {
      Logger.error('TileConfig.shadowElevation.submit.notApplied', {
        tileId: targetDoc?.id || doc?.id || null,
        elevation,
        settings: elevationShadowSettings
      });
      globalThis?.ui?.notifications?.error?.('Tile updated, but elevation shadow blur/opacity did not apply to this band.');
      return result;
    }
    return result;
  }
}
