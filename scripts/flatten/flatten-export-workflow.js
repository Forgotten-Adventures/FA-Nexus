import { exportedClause, flattenedClause, hiddenLeftOutClause, joinMessage } from './flatten-messages.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { isCanvasReadyFor } from '../canvas/canvas-readiness.js';
import { getCurrentLevelElevationRange } from '../canvas/elevation-band-utils.js';
import { isLayerHidden } from '../canvas/layer-hidden-state.js';
import { resolveAutoChunking } from './tile-flatten-chunking.js';
import { alignBoundsToScenePixels } from './flatten-bounds.js';
import { planFlattenComposition } from './flatten-composition.js';
import { isPrefabPlacementActive } from '../composition/prefab-placement.js';
import {
  describeLevelRange,
  getLevelRangeDisplayName,
  normalizeLevelId,
  resolveTileLevelLayerRole
} from './flatten-level-scope.js';

const EXPORT_SCOPE_SCENE = 'scene';
const EXPORT_SCOPE_LEVEL = 'level';
const MIDDLE_PLACEMENT_SEPARATE = 'separate';

export class FlattenExportWorkflow {
  constructor(manager) {
    if (!manager) throw new Error('FlattenExportWorkflow requires manager.');
    this.manager = manager;
  }

  async exportScene(options = {}) {
    const manager = this.manager;
    if (manager.isBusy()) {
      Logger.warn('TileFlatten.exportScene.busy');
      return;
    }

    if (!isCanvasReadyFor({ requireScene: true })) {
      ui?.notifications?.error?.('Scene not available.');
      return;
    }

    manager._flattening = true;
    let overlay = null;
    let resolvedAction = 'export';
    let shouldExport = true;
    let shouldFlatten = false;
    const scene = canvas?.scene;
    const originalLevelId = normalizeLevelId(canvas?.level?.id || scene?._view);
    let switchedLevelDuringRun = false;
    try {
      const {
        ppi = 200,
        quality = 0.85,
        paddingSnap = 'none',
        paddingExtra = 0,
        exportSplitLayers = false,
        exportChunked = false,
        exportScope = EXPORT_SCOPE_LEVEL,
        exportMiddlePlacement = MIDDLE_PLACEMENT_SEPARATE,
        exportAction,
        outputName = '',
        outputFolder = '',
        overwriteConfirmed = false
      } = options || {};
      resolvedAction = exportAction === 'export' || exportAction === 'flatten'
        ? exportAction
        : (options?.exportFlattenScene ? 'flatten' : 'export');
      shouldExport = resolvedAction === 'export';
      shouldFlatten = resolvedAction === 'flatten';
      const scope = manager._normalizeExportScope(exportScope);
      if (isPrefabPlacementActive() && manager._getExportLevelRanges(scope)
        .some(range => normalizeLevelId(range.levelId) !== originalLevelId)) {
        throw new Error('Finish or cancel the active Prefab placement before exporting or flattening multiple Levels.');
      }
      // Validate the full requested scope before any Level writes an image or
      // replaces source Tiles. Collection deliberately omits unresolved bands.
      for (const range of manager._getExportLevelRanges(scope)) {
        for (const tile of scene.tiles) {
          if (tile.hidden || isLayerHidden(tile)) continue;
          resolveTileLevelLayerRole(tile, range, { scene, rejectAmbiguous: true });
        }
      }
      const middlePlacement = manager._normalizeMiddlePlacement(exportMiddlePlacement);
      const normalizedPaddingSnap = manager._normalizePaddingSnap(paddingSnap);
      const sceneBounds = manager._getSceneBounds();
      if (!sceneBounds) {
        throw new Error('Could not resolve scene bounds for export');
      }

      const gridSize = Math.max(1, Number(canvas?.scene?.grid?.size || 100));
      const resolution = manager._computeResolution(ppi, gridSize);
      // Planned as it will be captured: on the Scene's pixel grid (see alignBoundsToScenePixels).
      const plannedRenderBounds = alignBoundsToScenePixels(
        manager._computeRenderBounds(sceneBounds, gridSize, normalizedPaddingSnap, paddingExtra),
        resolution
      );
      const plannedPixelWidth = Math.max(1, Math.round(plannedRenderBounds.width * resolution));
      const plannedPixelHeight = Math.max(1, Math.round(plannedRenderBounds.height * resolution));
      const maxTextureSize = manager._getMaxTextureSize(canvas?.app?.renderer);
      const autoChunkPlan = resolveAutoChunking(plannedPixelWidth, plannedPixelHeight, { maxTextureSize });
      const exceedsMaxTexture = plannedPixelWidth > maxTextureSize || plannedPixelHeight > maxTextureSize;
      const useAutoChunking = !!exportChunked && autoChunkPlan.enabled;
      const useChunking = exceedsMaxTexture || useAutoChunking;
      const chunkAuto = useChunking;
      const autoChunkWidth = useChunking ? (autoChunkPlan.chunkPixelWidth / ppi) : 0;
      const autoChunkHeight = useChunking ? (autoChunkPlan.chunkPixelHeight / ppi) : 0;

      overlay = manager._showOverlay(shouldExport ? 'export' : 'flatten');
      overlay.setStatus(shouldExport ? 'Preparing level export...' : 'Preparing level flatten...');
      overlay.setProgress?.(0.1);
      await manager._nextFrame();

      const levelPlans = manager._buildSceneExportLevelPlans({
        scope,
        splitLayers: !!exportSplitLayers,
        middlePlacement
      });
      if (!levelPlans.length) throw new Error('No Levels elevation ranges were available for flatten/export.');

      if (shouldFlatten) {
        // Expand ownership on every requested Level before the first capture or
        // replacement. A later Level's refusal must not leave earlier floors
        // flattened after the user receives a failure notification.
        for (const level of levelPlans) {
          const tiles = manager._collectSceneTiles({ levelRange: level.range });
          if (!tiles.length) continue;
          const plan = await planFlattenComposition(scene, tiles);
          for (const section of plan.sections) {
            if (section.tiles.some(tile => !resolveTileLevelLayerRole(tile, level.range, { scene, rejectAmbiguous: true }))) {
              throw new Error('The complete composition crosses Levels. Flatten it from a Level containing all its artwork.');
            }
          }
        }
      }

      const hasFlattenTargets = levelPlans.some((plan) => Array.isArray(plan?.flattenTasks)
        && plan.flattenTasks.some((task) => Array.isArray(task?.tiles) && task.tiles.length));
      if (shouldFlatten && !hasFlattenTargets) {
        const targetLabel = scope === EXPORT_SCOPE_SCENE ? 'scene levels' : describeLevelRange(levelPlans[0]?.range);
        ui?.notifications?.warn?.(`No tiles found in ${targetLabel} to flatten.`);
        return;
      }
      const hasExportTargets = levelPlans.some((plan) => Array.isArray(plan?.exportTasks)
        && plan.exportTasks.some((task) => manager._shouldRunTask(task, 'export')));
      if (shouldExport && !hasExportTargets) {
        const targetLabel = scope === EXPORT_SCOPE_SCENE ? 'scene levels' : describeLevelRange(levelPlans[0]?.range);
        ui?.notifications?.warn?.(`No tiles or level images found in ${targetLabel} to export.`);
        return;
      }
      if (exceedsMaxTexture && !exportChunked) {
        ui?.notifications?.info?.('Scene exceeds GPU texture size; generating multiple images.');
      }
      const primaryRange = levelPlans[0]?.range || getCurrentLevelElevationRange(canvas?.scene);
      const exportBaseName = manager._sanitizeOutputBaseName(
        outputName,
        manager._buildExportFilenameBase({ scope, levelRange: primaryRange })
      );
      const flattenBaseName = manager._sanitizeOutputBaseName(
        outputName,
        manager._buildFlattenFilenameBase({ scope, levelRange: primaryRange })
      );
      const savedFiles = [];
      let exportFolder = null;
      if (shouldExport) {
        const exportResult = await this._runExportModeTasks({
          levelPlans,
          scope,
          outputFolder,
          overwriteConfirmed,
          exportBaseName,
          useChunking,
          plannedPixelWidth,
          plannedPixelHeight,
          autoChunkPlan,
          sceneBounds,
          ppi,
          normalizedPaddingSnap,
          paddingExtra,
          autoChunkWidth,
          autoChunkHeight,
          chunkAuto,
          quality,
          overlay,
          markLevelSwitched: () => { switchedLevelDuringRun = true; }
        });
        if (exportResult.canceled) return;
        savedFiles.push(...exportResult.savedFiles);
        exportFolder = exportResult.folder || exportFolder;
      }

      let flattenedCount = 0;
      let flattenTotals = null;
      if (shouldFlatten) {
        const flattenResult = await this._runFlattenModeTasks({
          levelPlans,
          middlePlacement,
          scope,
          outputFolder,
          overwriteConfirmed,
          flattenBaseName,
          useChunking,
          plannedPixelWidth,
          plannedPixelHeight,
          autoChunkPlan,
          sceneBounds,
          ppi,
          normalizedPaddingSnap,
          paddingExtra,
          autoChunkWidth,
          autoChunkHeight,
          chunkAuto,
          quality,
          overlay,
          markLevelSwitched: () => { switchedLevelDuringRun = true; }
        });
        if (flattenResult.canceled) return;
        flattenedCount += flattenResult.flattenedCount;
        flattenTotals = flattenResult.totals;
      }

      overlay.setStatus(shouldExport ? 'Export complete.' : 'Flatten complete.');
      overlay.setProgress?.(1);
      // The lead sentence stays as it was (retained workflows wait for it); the counts follow (design D1).
      const lead = scope === EXPORT_SCOPE_SCENE ? 'Scene' : 'Level';
      const doneMessage = shouldExport
        ? joinMessage(`${lead} export complete.`, exportedClause(savedFiles.length, exportFolder))
        : joinMessage(`${lead} flatten complete.`,
          flattenTotals?.pictures ? flattenedClause(flattenTotals) : '',
          hiddenLeftOutClause(flattenTotals?.hidden ?? 0));
      ui?.notifications?.info?.(doneMessage);
      Logger.info('TileFlatten.exportScene.success', {
        action: resolvedAction,
        scope,
        files: savedFiles,
        split: !!exportSplitLayers,
        middlePlacement,
        chunked: !!useChunking,
        flattenedCount
      });
    } catch (error) {
      Logger.error('TileFlatten.exportScene.failed', { error: String(error?.message || error) });
      const actionLabel = shouldExport ? 'export' : 'flatten';
      ui?.notifications?.error?.(`Failed to ${actionLabel} level: ${error?.message || error}`);
    } finally {
      if (switchedLevelDuringRun && originalLevelId && normalizeLevelId(canvas?.scene?._view || canvas?.level?.id) !== originalLevelId) {
        try {
          await manager._viewLevelForExport({ levelId: originalLevelId, levelName: 'original level' });
        } catch (error) {
          Logger.error('TileFlatten.exportScene.restoreLevelFailed', {
            originalLevelId,
            error: String(error?.message || error)
          });
          ui?.notifications?.error?.(`Flatten/export completed but FA Nexus could not restore the original viewed level: ${error?.message || error}`);
        }
      }
      manager._hideOverlay();
      manager._flattening = false;
    }
  }

  async _runFlattenModeTasks({ levelPlans, scope, outputFolder, flattenBaseName, ppi,
    normalizedPaddingSnap, paddingExtra, quality, markLevelSwitched, middlePlacement }) {
    let flattenedCount = 0;
    const totals = { layers: 0, pictures: 0, levels: 0, hidden: 0 };
    for (const level of levelPlans) {
      await this.manager._viewLevelForExport(level.range);
      markLevelSwitched();
      const tiles = this.manager._collectSceneTiles({ levelRange: level.range });
      // Hidden layers are not flattened and stay as they are: the closing message counts them.
      totals.hidden += Math.max(0, this.manager._collectSceneTiles({ levelRange: level.range, includeHidden: true }).length - tiles.length);
      if (!tiles.length) continue;
      const result = await this.manager._flattenCompositionTiles(tiles, {
        ppi, quality, paddingSnap: normalizedPaddingSnap, paddingExtra, outputFolder,
        outputName: scope === 'scene' ? `${flattenBaseName}-${this.manager._getLevelOutputSlug(level.range)}` : flattenBaseName,
        exportMiddlePlacement: middlePlacement
      });
      if (!result) return { canceled: true, flattenedCount, totals };
      flattenedCount += result.createdTileIds.length;
      totals.layers += result.replacedTileIds?.length ?? 0;
      totals.pictures += result.createdTileIds.length;
      totals.hidden += result.hiddenLeftOutTileIds?.length ?? 0;
      if (result.createdTileIds.length) totals.levels += 1;
    }
    return { canceled: false, flattenedCount, totals };
  }
  async _runExportModeTasks({
    levelPlans,
    scope,
    outputFolder,
    overwriteConfirmed,
    exportBaseName,
    useChunking,
    plannedPixelWidth,
    plannedPixelHeight,
    autoChunkPlan,
    sceneBounds,
    ppi,
    normalizedPaddingSnap,
    paddingExtra,
    autoChunkWidth,
    autoChunkHeight,
    chunkAuto,
    quality,
    overlay,
    markLevelSwitched
  }) {
    const manager = this.manager;
    const exportContext = await manager._resolveExportUploadContext(outputFolder);
    const plannedExportFilenames = manager._buildPlannedTaskFilenames(levelPlans, {
      action: 'export',
      baseName: exportBaseName,
      scope,
      useChunking,
      plannedPixelWidth,
      plannedPixelHeight,
      autoChunkPlan
    });
    if (!overwriteConfirmed) {
      const approved = await manager._confirmOverwriteOutputs(exportContext, plannedExportFilenames, {
        title: 'Overwrite Existing Export Files?',
        actionLabel: 'Overwrite'
      });
      if (!approved) {
        ui?.notifications?.info?.('Scene export canceled.');
        return { canceled: true, savedFiles: [] };
      }
    }

    const savedFiles = [];
    const exportTasks = manager._getRunnablePlanTasks(levelPlans, 'export');
    const taskCount = exportTasks.length;
    const taskSpan = taskCount > 0 ? 0.8 / taskCount : 0.8;
    let taskIndex = 0;
    for (const plan of levelPlans) {
      if (scope === EXPORT_SCOPE_SCENE) {
        const didSwitch = await manager._viewLevelForExport(plan.range, { overlay });
        if (didSwitch) markLevelSwitched();
      }
      for (const task of plan.exportTasks) {
        if (!manager._shouldRunTask(task, 'export')) continue;
        const layerLabel = task.label || 'Scene';
        const taskSuffix = manager._buildTaskOutputSuffix(task, { scope });
        const layerProgressBase = 0.1 + (taskSpan * taskIndex);
        taskIndex += 1;

        overlay.setStatus(`Capturing ${layerLabel.toLowerCase()}...`);
        overlay.setProgress?.(layerProgressBase);
        await manager._nextFrame();

        if (useChunking) {
          const savedChunks = await this._runChunkedExportTask({
            task,
            sceneBounds,
            ppi,
            normalizedPaddingSnap,
            paddingExtra,
            autoChunkWidth,
            autoChunkHeight,
            chunkAuto,
            layerLabel,
            taskSuffix,
            exportBaseName,
            quality,
            exportContext,
            overlay,
            layerProgressBase,
            taskSpan
          });
          savedFiles.push(...savedChunks);
        } else {
          const filePath = await this._runSingleExportTask({
            task,
            sceneBounds,
            ppi,
            normalizedPaddingSnap,
            paddingExtra,
            layerLabel,
            taskSuffix,
            exportBaseName,
            quality,
            exportContext,
            overlay,
            layerProgressBase,
            taskSpan
          });
          savedFiles.push(filePath);
        }
      }
    }
    return { canceled: false, savedFiles, folder: exportContext?.effectiveFolder || null };
  }

  async _runChunkedExportTask({
    task,
    sceneBounds,
    ppi,
    normalizedPaddingSnap,
    paddingExtra,
    autoChunkWidth,
    autoChunkHeight,
    chunkAuto,
    layerLabel,
    taskSuffix,
    exportBaseName,
    quality,
    exportContext,
    overlay,
    layerProgressBase,
    taskSpan
  }) {
    const manager = this.manager;
    const savedChunks = [];
    const chunkData = await manager._renderTilesToCanvasChunked(task.tiles, sceneBounds, ppi, {
      paddingSnap: normalizedPaddingSnap,
      paddingExtra,
      chunkWidth: autoChunkWidth,
      chunkHeight: autoChunkHeight,
      chunkPad: false,
      chunkAuto,
      suspendRender: true,
      visibility: task.visibility,
      onChunk: async (entry, index, total) => {
        const label = Number.isFinite(total) && total > 0
          ? `Saving ${layerLabel.toLowerCase()} chunk ${index + 1} of ${total}...`
          : `Saving ${layerLabel.toLowerCase()} chunk...`;
        overlay.setStatus(label);
        if (Number.isFinite(total) && total > 0) {
          const progress = layerProgressBase + (taskSpan * ((index + 1) / total));
          overlay.setProgress?.(Math.min(0.9, progress));
        }
        const rowLabel = Number.isFinite(entry?.row) ? entry.row + 1 : null;
        const colLabel = Number.isFinite(entry?.col) ? entry.col + 1 : null;
        const chunkSuffix = (rowLabel && colLabel)
          ? `-r${rowLabel}-c${colLabel}`
          : `-chunk-${index + 1}`;
        const filename = manager._buildOutputFilename(exportBaseName, `${taskSuffix}${chunkSuffix}`);
        let src = null;
        try {
          // One closing message names the count and the folder: no note per file (design D1).
          src = await manager._saveAsWebP(entry?.canvas, quality, { uploadContext: exportContext, filename, quiet: true });
        } finally {
          manager._releaseCanvas(entry?.canvas);
        }
        if (src) savedChunks.push(src);
      }
    });

    if (!chunkData) {
      throw new Error(`Failed to export ${layerLabel.toLowerCase()} chunks`);
    }
    if (!savedChunks.length) {
      throw new Error(`Failed to save ${layerLabel.toLowerCase()} chunks`);
    }
    const expectedChunks = Number.isFinite(chunkData?.rows) && Number.isFinite(chunkData?.columns)
      ? (chunkData.rows * chunkData.columns)
      : null;
    if (Number.isFinite(expectedChunks) && expectedChunks > 0 && savedChunks.length !== expectedChunks) {
      throw new Error(`Failed to save all ${layerLabel.toLowerCase()} chunks`);
    }
    return savedChunks;
  }

  async _runSingleExportTask({
    task,
    sceneBounds,
    ppi,
    normalizedPaddingSnap,
    paddingExtra,
    layerLabel,
    taskSuffix,
    exportBaseName,
    quality,
    exportContext,
    overlay,
    layerProgressBase,
    taskSpan
  }) {
    const manager = this.manager;
    overlay.setStatus(`Capturing ${layerLabel.toLowerCase()}...`);
    const canvasData = await manager._renderTilesToCanvas(task.tiles, sceneBounds, ppi, {
      paddingSnap: normalizedPaddingSnap,
      paddingExtra,
      trimToContent: false,
      suspendRender: true,
      visibility: task.visibility
    });
    if (!canvasData?.canvas) {
      throw new Error(`Failed to export ${layerLabel.toLowerCase()}`);
    }

    overlay.setStatus(`Saving ${layerLabel.toLowerCase()}...`);
    const filename = manager._buildOutputFilename(exportBaseName, taskSuffix);
    const filePath = await manager._saveAsWebP(canvasData.canvas, quality, { uploadContext: exportContext, filename, quiet: true });
    if (!filePath) {
      throw new Error(`Failed to save ${layerLabel.toLowerCase()} export`);
    }
    manager._releaseCanvas(canvasData.canvas);
    overlay.setProgress?.(Math.min(0.9, layerProgressBase + taskSpan));
    return filePath;
  }
}
