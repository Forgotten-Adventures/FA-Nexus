export class FlattenCaptureWorkflow {
  constructor(manager) {
    if (!manager) throw new Error('FlattenCaptureWorkflow requires manager.');
    this.manager = manager;
  }

  async capture({
    targets,
    shadowBounds,
    ppi,
    quality,
    paddingSnap,
    paddingExtra,
    useChunking,
    useAutoChunking,
    autoChunkPlan,
    chunkSquares,
    chunkPad,
    chunkSize,
    uploadContext,
    baseName,
    overlay
  }) {
    return useChunking
      ? this._captureChunks({
        targets,
        shadowBounds,
        ppi,
        quality,
        paddingSnap,
        paddingExtra,
        useAutoChunking,
        autoChunkPlan,
        chunkSquares,
        chunkPad,
        chunkSize,
        uploadContext,
        baseName,
        overlay
      })
      : this._captureSingle({
        targets,
        shadowBounds,
        ppi,
        quality,
        paddingSnap,
        paddingExtra,
        uploadContext,
        baseName,
        overlay
      });
  }

  async _captureChunks({
    targets,
    shadowBounds,
    ppi,
    quality,
    paddingSnap,
    paddingExtra,
    useAutoChunking,
    autoChunkPlan,
    chunkSquares,
    chunkPad,
    chunkSize,
    uploadContext,
    baseName,
    overlay
  }) {
    const manager = this.manager;
    overlay.setStatus('Capturing chunks...');
    overlay.setProgress?.(0.35);
    await manager._nextFrame();

    const capturedChunks = [];
    const autoChunkWidth = useAutoChunking ? (autoChunkPlan.chunkPixelWidth / ppi) : 0;
    const autoChunkHeight = useAutoChunking ? (autoChunkPlan.chunkPixelHeight / ppi) : 0;
    const chunkData = await manager._renderTilesToCanvasChunked(targets, shadowBounds, ppi, {
      paddingSnap,
      paddingExtra,
      chunkWidth: chunkSquares.enabled ? chunkSquares.widthSquares : autoChunkWidth,
      chunkHeight: chunkSquares.enabled ? chunkSquares.heightSquares : autoChunkHeight,
      chunkPad: chunkSquares.enabled ? chunkPad : false,
      chunkSize: chunkSquares.enabled ? 0 : (useAutoChunking ? 0 : chunkSize),
      chunkAuto: useAutoChunking,
      suspendRender: true,
      visibility: { keepBackground: false, keepForeground: false, keepTiles: true, keepDoors: false },
      onChunk: async (entry, index, total) => {
        const label = Number.isFinite(total) && total > 0
          ? `Encoding chunk ${index + 1} of ${total}...`
          : 'Encoding chunk...';
        overlay.setStatus(label);
        if (Number.isFinite(total) && total > 0) {
          const progress = 0.35 + (0.25 * ((index + 1) / total));
          overlay.setProgress?.(Math.min(0.6, progress));
        }
        const rowLabel = Number.isFinite(entry?.row) ? entry.row + 1 : null;
        const colLabel = Number.isFinite(entry?.col) ? entry.col + 1 : null;
        const chunkSuffix = rowLabel && colLabel ? `-r${rowLabel}-c${colLabel}` : `-chunk-${index + 1}`;
        const filename = manager._buildOutputFilename(baseName, chunkSuffix);
        let captured = null;
        try {
          captured = await manager._captureFlattenChunkWebP(entry, quality, { uploadContext, filename });
        } finally {
          manager._releaseCanvas(entry?.canvas);
        }
        if (captured) capturedChunks.push(captured);
      }
    });

    if (!chunkData) {
      throw new Error('Failed to render tile chunks');
    }
    if (!capturedChunks.length) {
      throw new Error('Failed to encode flattened image chunks');
    }
    const expectedChunks = Number.isFinite(chunkData?.rows) && Number.isFinite(chunkData?.columns)
      ? (chunkData.rows * chunkData.columns)
      : null;
    if (Number.isFinite(expectedChunks) && expectedChunks > 0 && capturedChunks.length !== expectedChunks) {
      throw new Error('Failed to encode all flattened image chunks');
    }

    return {
      useChunking: true,
      renderData: chunkData,
      filePath: capturedChunks[0]?.src || null,
      chunkEntries: capturedChunks.map((record) => manager._chunkBlobRecordToMetadataEntry(record)),
      capturedChunks,
      singleOutput: null
    };
  }

  async _captureSingle({
    targets,
    shadowBounds,
    ppi,
    quality,
    paddingSnap,
    paddingExtra,
    uploadContext,
    baseName,
    overlay
  }) {
    const manager = this.manager;
    overlay.setStatus('Capturing canvas...');
    overlay.setProgress?.(0.35);
    await manager._nextFrame();

    const canvasData = await manager._renderTilesToCanvas(targets, shadowBounds, ppi, {
      paddingSnap,
      paddingExtra,
      suspendRender: true,
      visibility: { keepBackground: false, keepForeground: false, keepTiles: true, keepDoors: false }
    });
    if (!canvasData || !canvasData.canvas) {
      throw new Error('Failed to render tiles to canvas');
    }

    overlay.setStatus('Encoding image...');
    overlay.setProgress?.(0.6);
    await manager._nextFrame();

    const filename = manager._normalizeWebPFilename({ filename: manager._buildOutputFilename(baseName) });
    const blob = await manager._canvasToWebPBlob(canvasData.canvas, quality);
    if (!blob) throw new Error(`Failed to encode flattened WebP ${filename}.`);
    const filePath = manager._predictWebPUploadPath(uploadContext, filename);
    const singleOutput = { filename, src: filePath, blob };
    manager._releaseCanvas(canvasData?.canvas);

    return {
      useChunking: false,
      renderData: canvasData,
      filePath,
      chunkEntries: null,
      capturedChunks: null,
      singleOutput
    };
  }

  async save({ captureResult, uploadContext, metadata, overlay }) {
    const manager = this.manager;
    const useChunking = !!captureResult?.useChunking;
    overlay.setStatus(useChunking ? 'Saving image chunks...' : 'Saving image...');
    overlay.setProgress?.(0.84);
    await manager._nextFrame();

    let filePath = captureResult?.filePath || null;
    if (useChunking) {
      const capturedChunks = captureResult?.capturedChunks || [];
      for (let i = 0; i < capturedChunks.length; i += 1) {
        overlay.setStatus(`Saving chunk ${i + 1} of ${capturedChunks.length}...`);
        overlay.setProgress?.(0.84 + (0.05 * ((i + 1) / capturedChunks.length)));
        const chunkMetadata = i > 0 && metadata.composition?.snapshot
          ? { ...metadata, originalTileCount: 0, composition: { ...metadata.composition, snapshot: undefined } }
          : metadata;
        await manager._saveCapturedFlattenWebP(capturedChunks[i], uploadContext, chunkMetadata);
      }
      filePath = capturedChunks[0]?.src || filePath;
    } else {
      filePath = await manager._saveCapturedFlattenWebP(captureResult?.singleOutput, uploadContext, metadata);
    }

    metadata.filePath = filePath || metadata.filePath;
    if (metadata.embeddedMetadata) metadata.embeddedMetadata.primaryFilePath = metadata.filePath || null;
    return filePath;
  }
}
