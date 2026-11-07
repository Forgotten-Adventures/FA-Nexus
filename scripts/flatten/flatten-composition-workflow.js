import { planFlattenComposition, commitFlattenComposition, runtimeFlattenMetadata, collectFlattenArchiveReferences, flattenArchiveIdentities } from './flatten-composition.js';
import { getCurrentLevelElevationRange } from '../canvas/elevation-band-utils.js';
import { readFlattenedTilePose } from './flatten-tile-transform.js';

function mergedOutputSettings(tiles) {
  const sources=tiles.map(tile=>tile.toObject());
  const common=(key,fallback)=>sources.every(source=>JSON.stringify(source[key])===JSON.stringify(sources[0][key]))
    ? structuredClone(sources[0][key]) : fallback;
  return {occlusion:common('occlusion',{modes:[],alpha:0}),
    restrictions:common('restrictions',{light:false,weather:false}),roof:common('roof',false),
    locked:sources.every(source=>source.locked)};
}

export async function flattenCompositionTiles(manager, tiles, options, resolveCapturePlan) {
  const scene = canvas.scene;
  const plan = await planFlattenComposition(scene, tiles);
  if (!plan.sections.length) throw new Error('Select at least one visible composition to flatten.');
  const ppi = Number(options.ppi) || 200, quality = options.quality ?? 0.85;
  const paddingSnap = manager._normalizePaddingSnap(options.paddingSnap);
  const paddingExtra = options.paddingExtra || 0;
  const chunkSquares = manager._normalizeChunkSquares(options.chunkWidth, options.chunkHeight);
  const chunkPad = chunkSquares.enabled && !!options.chunkPad;
  const chunkSize = chunkSquares.enabled ? 0 : manager._normalizeChunkSize(options.chunkSize);
  const range = getCurrentLevelElevationRange(scene);
  const overlay = manager._showOverlay('flatten');
  const jobs = [];
  const baseName = manager._sanitizeOutputBaseName(options.outputName, manager._buildFlattenFilenameBase());
  for (const section of plan.sections) {
    const scope = manager._filterFlattenTargets(section.tiles);
    if (scope.outOfScope.length) throw new Error('The complete composition crosses Levels. Flatten it from a Level containing all its artwork.');
    const taskOptions = { splitLayers: true,
      middlePlacement: manager._normalizeMiddlePlacement(options.exportMiddlePlacement), action: 'flatten' };
    const tasks = manager._buildLevelLayerTasks(range, section.tiles, taskOptions).filter(task => task.tiles.length);
    // A band's own Elevation is right for a picture of everything in the band.
    // A picture of part of it stays with its lowest source: at the bottom of
    // the band it would go under every layer that was not selected.
    const visible = manager._collectSceneTiles({ levelRange: range })
      .filter(tile => !tile.hidden && !tile.flags?.['fa-nexus']?.layerHidden);
    const whole = manager._buildLevelLayerTasks(range, visible, taskOptions);
    for (const task of tasks) {
      const band = whole.find(entry => entry.role === task.role);
      if (!band || band.tiles.length <= task.tiles.length) continue;
      const elevations = task.tiles.map(tile => Number(tile.elevation)).filter(Number.isFinite);
      if (elevations.length) task.flattenedElevation = Math.min(...elevations);
    }
    // The wall/foreground artwork remains the manipulation and Portal draw-order
    // owner. Capture order must not silently promote the floor to Building Root.
    const priority = { foreground: 0, middle: 1, background: 2 };
    tasks.sort((a, b) => priority[a.role] - priority[b.role]);
    if (tasks.reduce((n, task) => n + task.tiles.length, 0) !== section.tiles.length) throw new Error('Some composition artwork could not be assigned to a ground, middle or foreground band.');
    for (const task of tasks) {
      const shadowBounds = manager._computeShadowedBounds(task.tiles);
      if (!shadowBounds) throw new Error('Could not compute the complete artwork bounds.');
      const capturePlan = await resolveCapturePlan(manager, { shadowBounds, ppi, paddingSnap, paddingExtra,
        chunkSquares, chunkPad, chunkSize, outputFolder: options.outputFolder,
        outputName: `${baseName}-${task.role}` });
      jobs.push({ section, task, shadowBounds, capturePlan });
    }
  }
  // Verify the actual band/section filenames before any uploads or Scene writes.
  const approved = await manager._confirmOverwriteOutputs(jobs[0].capturePlan.uploadContext,
    jobs.flatMap(job => job.capturePlan.plannedFilenames), { title: 'Overwrite Existing Flatten Files?', actionLabel: 'Overwrite' });
  if (!approved) return null;
  const entries = [];
  for (const job of jobs) {
    const { section, task, shadowBounds, capturePlan } = job;
    overlay.setStatus(`Capturing ${task.role} artwork…`);
    const captureResult = await manager._flattenCaptureWorkflow.capture({ targets: task.tiles, shadowBounds,
      ppi, quality, paddingSnap, paddingExtra, chunkSquares, chunkPad, chunkSize, overlay, ...capturePlan });
    const rendered = captureResult.renderData;
    const metadata = manager._buildMetadata({ tiles: task.tiles, logicalBounds: manager._computeBounds(task.tiles),
      renderBounds: rendered.renderBounds, paddingInsets: rendered.paddingInsets, pixelWidth: rendered.pixelWidth,
      pixelHeight: rendered.pixelHeight, ppi, quality, paddingSnap, paddingExtra, resolution: rendered.resolution,
      filePath: captureResult.filePath, chunks: captureResult.chunkEntries,
      chunking: rendered.chunking, chunkSize: rendered.chunkSize, layerRole: task.role,
      flattenedElevation: task.flattenedElevation, levelIds: task.levelIds, levelRange: range });
    const primary = !entries.some(entry => entry.section === section);
    metadata.outputTileSettings = mergedOutputSettings(task.tiles);
    const source = manager._wrapperTilePersistence.buildTileData(rendered.renderBounds, captureResult.filePath, metadata);
    source._id = primary ? section.ownerId : foundry.utils.randomID();
    // The band first: a list that shows the start of a long name can then tell the pictures of one section apart.
    source.name = `${task.role.charAt(0).toUpperCase()}${task.role.slice(1)} · ${options.outputName || 'Flattened picture'}`;
    metadata.composition = { version: 1, ownerUuid: `Scene.${scene.id}.Tile.${section.ownerId}`,
      ...(primary ? { snapshot: section.snapshot, sourcePose: readFlattenedTilePose(source), sourceTileIds: section.tiles.map(t => t.id),
        archiveSceneId: scene.id, identities: flattenArchiveIdentities(section.snapshot),
        sourceAssets: collectFlattenArchiveReferences(section.snapshot) } : {}) };
    metadata.tiles = [];
    metadata.originalTileCount = primary ? section.tiles.length : 0;
    // The whole archive exists once, in the primary band's generated WebP.
    await manager._flattenCaptureWorkflow.save({ captureResult, uploadContext: capturePlan.uploadContext, metadata, overlay });
    source.flags['fa-nexus'].flattened = runtimeFlattenMetadata(metadata);
    entries.push({ section, source });
  }
  overlay.setStatus('Replacing source artwork and preserving gameplay objects…');
  const result = await commitFlattenComposition(scene, plan, entries);
  overlay.setProgress?.(1);
  return result;
}
