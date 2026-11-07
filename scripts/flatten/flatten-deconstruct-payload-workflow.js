import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { restoreCompositionArchiveElevation } from '../composition/composition-elevation.js';
import {reprojectCompositionSnapshotGrid} from '../composition/scene-group-copy-runtime.js';
import {
  LEVEL_POLICY_PRESERVE,
  migrateLegacyTilePositionForV14,
  normalizeTileCreatePayloadForV14
} from '../canvas/tile-document-payloads.js';
import { encodeTexturePath } from '../textures/texture-runtime-core.js';
import {
  FLATTEN_WEBP_METADATA_SCHEMA,
  FLATTEN_WEBP_METADATA_VERSION,
  readFlattenMetadataFromWebPUrl
} from './flatten-webp-metadata.js';
import {
  buildFlattenLevelRangeMetadata,
  normalizeLevelIds
} from './flatten-level-scope.js';

const MODULE_ID = 'fa-nexus';
const TILE_TRANSFORM_EPSILON = 1e-4;

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getTileTextureAnchor(texture) {
  const anchorX = Number(texture?.anchorX);
  const anchorY = Number(texture?.anchorY);
  return {
    x: Number.isFinite(anchorX) ? anchorX : 0.5,
    y: Number.isFinite(anchorY) ? anchorY : 0.5
  };
}

function getTileRenderedTopLeft(data) {
  const anchor = getTileTextureAnchor(data?.texture);
  const x = Number(data?.x);
  const y = Number(data?.y);
  const width = Number(data?.width);
  const height = Number(data?.height);
  return {
    x: (Number.isFinite(x) ? x : 0) - ((Number.isFinite(width) ? width : 0) * anchor.x),
    y: (Number.isFinite(y) ? y : 0) - ((Number.isFinite(height) ? height : 0) * anchor.y)
  };
}

function getTileTextureScale(texture) {
  const scaleX = Number(texture?.scaleX);
  const scaleY = Number(texture?.scaleY);
  return {
    x: Number.isFinite(scaleX) ? scaleX : 1,
    y: Number.isFinite(scaleY) ? scaleY : 1
  };
}

function getTileTransformSnapshot(data) {
  const anchor = getTileTextureAnchor(data?.texture);
  const scale = getTileTextureScale(data?.texture);
  const renderedTopLeft = getTileRenderedTopLeft(data);
  const x = Number(data?.x);
  const y = Number(data?.y);
  const width = Number(data?.width);
  const height = Number(data?.height);
  const rotation = Number(data?.rotation);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
    rotation: Number.isFinite(rotation) ? rotation : 0,
    anchorX: anchor.x,
    anchorY: anchor.y,
    scaleX: scale.x,
    scaleY: scale.y,
    topLeftX: Number.isFinite(renderedTopLeft?.x) ? renderedTopLeft.x : 0,
    topLeftY: Number.isFinite(renderedTopLeft?.y) ? renderedTopLeft.y : 0
  };
}

export function buildFlattenedWrapperTransform(bounds) {
  const x = Number(bounds?.x);
  const y = Number(bounds?.y);
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  if (![x, y, width, height].every(Number.isFinite) || (width <= 0) || (height <= 0)) return null;
  const normalizedWidth = Math.max(1, Math.round(width));
  const normalizedHeight = Math.max(1, Math.round(height));
  const normalizedX = Math.round(x + (width / 2));
  const normalizedY = Math.round(y + (height / 2));
  return {
    x: normalizedX,
    y: normalizedY,
    width: normalizedWidth,
    height: normalizedHeight,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
    scaleX: 1,
    scaleY: 1,
    topLeftX: normalizedX - (normalizedWidth * 0.5),
    topLeftY: normalizedY - (normalizedHeight * 0.5)
  };
}

function tileTransformsMatchValue(left, right) {
  return Math.abs((Number(left) || 0) - (Number(right) || 0)) <= TILE_TRANSFORM_EPSILON;
}

export class FlattenDeconstructPayloadWorkflow {
  constructor(manager) {
    if (!manager) throw new Error('FlattenDeconstructPayloadWorkflow requires manager.');
    this.manager = manager;
  }

  buildRestorePlan(tileDoc, metadata) {
    const transformValidation = this.validateFlattenedTileRestoreTransform(tileDoc, metadata);
    if (!transformValidation.ok) {
      return { ok: false, transformValidation, offset: null, restoration: null };
    }

    const offset = this.resolveFlattenOffset(tileDoc, metadata);
    const restoration = this.prepareDeconstructionPayload(metadata, offset, {
      forceLegacyTilePositionMigration: this.shouldForceLegacyFlattenTilePositionMigration(tileDoc, metadata)
    });

    return { ok: true, transformValidation, offset, restoration };
  }

  requiresEmbeddedFlattenMetadata(metadata) {
    const embedded = metadata?.embeddedMetadata;
    return !!(embedded && typeof embedded === 'object' && (
      embedded.required === true
      || embedded.schema === FLATTEN_WEBP_METADATA_SCHEMA
      || Number(embedded.version) === FLATTEN_WEBP_METADATA_VERSION
    ));
  }

  resolveEmbeddedFlattenMetadataSources(tileDoc, metadata = null) {
    const manager = this.manager;
    const sources = [];
    const seen = new Set();
    const push = (source, kind) => {
      const normalized = String(source || '').trim();
      if (!normalized) return;
      const key = manager._normalizeUploadPathForComparison(normalized);
      if (seen.has(key)) return;
      seen.add(key);
      sources.push({ source: normalized, kind });
    };

    push(this.resolveTileTextureSourceForFlattenMetadata(tileDoc), 'tile-texture');

    if (metadata && this.requiresEmbeddedFlattenMetadata(metadata)) {
      push(metadata?.embeddedMetadata?.primaryFilePath, 'metadata-primary');
      push(metadata?.filePath, 'metadata-file');
      push(metadata?.chunks?.[0]?.src, 'metadata-first-chunk');
      if (!sources.length) {
        throw new Error('Flatten metadata requires embedded WebP metadata but does not identify the generated WebP file.');
      }
      return sources;
    }

    if (!sources.length) {
      throw new Error('Selected tile does not contain FA Nexus flatten data or a readable WebP texture source.');
    }
    return sources;
  }

  async readEmbeddedFlattenMetadata(tileDoc, metadata = null) {
    const sources = this.resolveEmbeddedFlattenMetadataSources(tileDoc, metadata);
    let lastError = null;

    for (const entry of sources) {
      const source = entry?.source || '';
      const url = encodeTexturePath(source);
      try {
        const envelope = await readFlattenMetadataFromWebPUrl(url);
        return this.manager._deepClone(envelope.flattened);
      } catch (error) {
        lastError = error;
        Logger.warn('TileFlatten.embeddedMetadata.sourceReadFailed', {
          tileId: tileDoc?.id || null,
          source,
          sourceKind: entry?.kind || null,
          error: String(error?.message || error)
        });
      }
    }

    Logger.error('TileFlatten.embeddedMetadata.readFailed', {
      tileId: tileDoc?.id || null,
      sources: sources.map((entry) => ({
        source: entry?.source || '',
        kind: entry?.kind || null
      })),
      error: String(lastError?.message || lastError || 'No readable embedded metadata source')
    });
    throw new Error(`Cannot read embedded FA Nexus flatten metadata from generated WebP source: ${lastError?.message || lastError}`);
  }

  resolveTileTextureSourceForFlattenMetadata(tileDoc) {
    return String(
      tileDoc?.texture?.src
      || tileDoc?._source?.texture?.src
      || tileDoc?.img
      || tileDoc?._source?.img
      || ''
    ).trim();
  }

  async assertEmbeddedFlattenMetadataReadable(tileDoc, metadata) {
    const embedded = await this.readEmbeddedFlattenMetadata(tileDoc, metadata);
    const cachedCount = Number(metadata?.originalTileCount ?? metadata?.tiles?.length ?? 0) || 0;
    const embeddedCount = Number(embedded?.originalTileCount ?? embedded?.tiles?.length ?? 0) || 0;
    if (cachedCount > 0 && embeddedCount !== cachedCount) {
      Logger.error('TileFlatten.embeddedMetadata.countMismatch', {
        tileId: tileDoc?.id || null,
        cachedCount,
        embeddedCount
      });
      throw new Error(`Embedded flatten metadata tile count mismatch; expected ${cachedCount}, found ${embeddedCount}.`);
    }
    if (Number(embedded?.version) !== Number(metadata?.version)) {
      Logger.error('TileFlatten.embeddedMetadata.versionMismatch', {
        tileId: tileDoc?.id || null,
        cachedVersion: metadata?.version ?? null,
        embeddedVersion: embedded?.version ?? null
      });
      throw new Error(`Embedded flatten metadata version mismatch; expected ${metadata?.version ?? 'missing'}, found ${embedded?.version ?? 'missing'}.`);
    }
    return embedded;
  }

  async resolveFlattenMetadataForDeconstruct(tileDoc) {
    const cached = this.manager._resolveFlattenMetadata(tileDoc);
    if (cached) {
      if (this.requiresEmbeddedFlattenMetadata(cached)) {
        const embedded = await this.assertEmbeddedFlattenMetadataReadable(tileDoc, cached);
        if (cached.composition?.version === 1) {
          if (!embedded.composition?.snapshot) throw new Error('Generated WebP is missing its source composition archive.');
          cached.composition.snapshot = restoreCompositionArchiveElevation(
            embedded.composition.snapshot, embedded.flattenedElevation, tileDoc.elevation);
        }
      }
      if (cached.composition?.snapshot) cached.composition.snapshot = reprojectCompositionSnapshotGrid(
        cached.composition.snapshot, tileDoc.parent.toObject().grid);
      return cached;
    }

    const embedded = await this.readEmbeddedFlattenMetadata(tileDoc, null);
    if (tileDoc && typeof tileDoc.setFlag === 'function') {
      try {
        await tileDoc.setFlag(MODULE_ID, 'flattened', embedded);
        Logger.info('TileFlatten.embeddedMetadata.cacheHydrated', {
          tileId: tileDoc?.id || null,
          originalTileCount: embedded?.originalTileCount ?? embedded?.tiles?.length ?? null
        });
      } catch (error) {
        Logger.error('TileFlatten.embeddedMetadata.cacheWriteFailed', {
          tileId: tileDoc?.id || null,
          error: String(error?.message || error)
        });
        throw new Error(`Embedded flatten metadata was readable, but the runtime cache could not be written: ${error?.message || error}`);
      }
    } else {
      Logger.warn('TileFlatten.embeddedMetadata.cacheUnavailable', {
        tileId: tileDoc?.id || null
      });
    }
    if (embedded.composition?.snapshot) embedded.composition.snapshot = reprojectCompositionSnapshotGrid(
      embedded.composition.snapshot, tileDoc.parent.toObject().grid);
    return embedded;
  }

  resolveFlattenMetadataChunkForTile(tileDoc, metadata) {
    const chunks = Array.isArray(metadata?.chunks) ? metadata.chunks : [];
    if (!chunks.length) return null;
    const source = this.resolveTileTextureSourceForFlattenMetadata(tileDoc);
    if (!source) return null;
    const sourceKey = this.manager._normalizeUploadPathForComparison(source);
    if (!sourceKey) return null;
    const sourceKeyLower = sourceKey.toLowerCase();

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const chunkSrc = String(chunk?.src || '').trim();
      if (!chunkSrc) continue;
      const chunkKey = this.manager._normalizeUploadPathForComparison(chunkSrc);
      if (!chunkKey) continue;
      if (
        chunkKey === sourceKey
        || chunkKey.toLowerCase() === sourceKeyLower
        || this.manager._storageObjectKeysMatch(chunkSrc, source)
      ) {
        return { chunk, index };
      }
    }
    return null;
  }

  dimensionsMatch(width, height, expectedWidth, expectedHeight, epsilon = 1) {
    const w = Number(width);
    const h = Number(height);
    const ew = Number(expectedWidth);
    const eh = Number(expectedHeight);
    if (![w, h, ew, eh].every(Number.isFinite)) return false;
    return Math.abs(w - ew) <= epsilon && Math.abs(h - eh) <= epsilon;
  }

  resolveImportedFlattenChunkAnchor(tileDoc, metadata, actual = null, fullExpected = null) {
    const match = this.resolveFlattenMetadataChunkForTile(tileDoc, metadata);
    if (!match) return null;

    const transform = actual || getTileTransformSnapshot(tileDoc);
    if (fullExpected && this.dimensionsMatch(transform.width, transform.height, fullExpected.width, fullExpected.height)) {
      return null;
    }

    const chunk = match.chunk;
    const worldMatch = this.dimensionsMatch(transform.width, transform.height, chunk?.width, chunk?.height);
    const pixelMatch = this.dimensionsMatch(transform.width, transform.height, chunk?.pixelWidth, chunk?.pixelHeight);
    if (!worldMatch && !pixelMatch) return null;

    return {
      ...match,
      dimensionMode: worldMatch ? 'world' : 'pixel'
    };
  }

  buildExpectedImportedFlattenChunkTransform(tileDoc, metadata, actual = null, fullExpected = null) {
    const anchor = this.resolveImportedFlattenChunkAnchor(tileDoc, metadata, actual, fullExpected);
    if (!anchor) return null;
    const transform = actual || getTileTransformSnapshot(tileDoc);
    if (anchor.dimensionMode === 'pixel') {
      Logger.warn('TileFlatten.deconstruct.importedChunkPixelAnchor', {
        tileId: tileDoc?.id || null,
        chunkIndex: anchor.index,
        actualWidth: transform.width,
        actualHeight: transform.height,
        chunkWidth: Number(anchor.chunk?.width) || 0,
        chunkHeight: Number(anchor.chunk?.height) || 0,
        chunkPixelWidth: Number(anchor.chunk?.pixelWidth) || 0,
        chunkPixelHeight: Number(anchor.chunk?.pixelHeight) || 0
      });
    }
    return {
      ...transform,
      rotation: 0
    };
  }

  resolveExpectedFlattenedWrapperTransform(tileDoc, metadata) {
    const actual = getTileTransformSnapshot(tileDoc);

    if (metadata?.wrapperTransform && (typeof metadata.wrapperTransform === 'object')) {
      const expected = getTileTransformSnapshot(metadata.wrapperTransform);
      const chunkExpected = this.buildExpectedImportedFlattenChunkTransform(tileDoc, metadata, actual, expected);
      return chunkExpected || expected;
    }

    if (this.isLegacyFlattenedTileMetadata(tileDoc, metadata)) {
      const fallbackBounds = metadata?.renderBounds || metadata?.logicalBounds || null;
      const width = Number(fallbackBounds?.width ?? tileDoc?.width);
      const height = Number(fallbackBounds?.height ?? tileDoc?.height);
      const expected = {
        x: Number(tileDoc?.x) || 0,
        y: Number(tileDoc?.y) || 0,
        width: Number.isFinite(width) ? width : 0,
        height: Number.isFinite(height) ? height : 0,
        rotation: 0,
        anchorX: 0,
        anchorY: 0,
        scaleX: 1,
        scaleY: 1,
        topLeftX: Number(tileDoc?.x) || 0,
        topLeftY: Number(tileDoc?.y) || 0
      };
      const chunkExpected = this.buildExpectedImportedFlattenChunkTransform(tileDoc, metadata, actual, expected);
      return chunkExpected || expected;
    }

    const fallbackBounds = metadata?.renderBounds || metadata?.logicalBounds || null;
    const fallbackTransform = buildFlattenedWrapperTransform(fallbackBounds);
    if (fallbackTransform) {
      const chunkExpected = this.buildExpectedImportedFlattenChunkTransform(tileDoc, metadata, actual, fallbackTransform);
      return chunkExpected || fallbackTransform;
    }

    return null;
  }

  validateFlattenedTileRestoreTransform(tileDoc, metadata) {
    const expected = this.resolveExpectedFlattenedWrapperTransform(tileDoc, metadata);
    if (!expected) return { ok: true };

    const actual = getTileTransformSnapshot(tileDoc);
    const mismatches = [];
    if (!tileTransformsMatchValue(actual.rotation, expected.rotation)) mismatches.push('rotation');
    if (!tileTransformsMatchValue(actual.width, expected.width)) mismatches.push('width');
    if (!tileTransformsMatchValue(actual.height, expected.height)) mismatches.push('height');
    if (!tileTransformsMatchValue(actual.anchorX, expected.anchorX)) mismatches.push('anchorX');
    if (!tileTransformsMatchValue(actual.anchorY, expected.anchorY)) mismatches.push('anchorY');
    if (!tileTransformsMatchValue(actual.scaleX, expected.scaleX)) mismatches.push('scaleX');
    if (!tileTransformsMatchValue(actual.scaleY, expected.scaleY)) mismatches.push('scaleY');
    if (!mismatches.length) return { ok: true };

    Logger.error('TileFlatten.deconstruct.unsafeWrapperTransform', {
      tileId: tileDoc?.id || null,
      mismatches,
      expected,
      actual
    });

    return {
      ok: false,
      message: `Cannot deconstruct this flattened tile after its wrapper transform changed (${mismatches.join(', ')}). Reset the wrapper size, rotation, anchor, and scale before trying again.`
    };
  }

  resolveFlattenOffset(tileDoc, metadata) {
    const originX = Number(metadata?.wrapperTransform?.topLeftX ?? metadata?.originalPosition?.x ?? metadata?.renderBounds?.x ?? metadata?.logicalBounds?.x);
    const originY = Number(metadata?.wrapperTransform?.topLeftY ?? metadata?.originalPosition?.y ?? metadata?.renderBounds?.y ?? metadata?.logicalBounds?.y);
    if (!Number.isFinite(originX) || !Number.isFinite(originY)) return { x: 0, y: 0 };
    const current = getTileRenderedTopLeft(tileDoc);
    const importedChunk = this.resolveImportedFlattenChunkAnchor(tileDoc, metadata, getTileTransformSnapshot(tileDoc), {
      width: Number(metadata?.wrapperTransform?.width ?? metadata?.renderBounds?.width ?? metadata?.logicalBounds?.width),
      height: Number(metadata?.wrapperTransform?.height ?? metadata?.renderBounds?.height ?? metadata?.logicalBounds?.height)
    });
    const chunkOffsetX = importedChunk ? (Number(importedChunk.chunk?.x) || 0) : 0;
    const chunkOffsetY = importedChunk ? (Number(importedChunk.chunk?.y) || 0) : 0;
    if (importedChunk) {
      Logger.warn('TileFlatten.deconstruct.importedChunkAnchor', {
        tileId: tileDoc?.id || null,
        chunkIndex: importedChunk.index,
        dimensionMode: importedChunk.dimensionMode,
        chunkOffsetX,
        chunkOffsetY
      });
    }
    const offset = {
      x: current.x - (originX + chunkOffsetX),
      y: current.y - (originY + chunkOffsetY)
    };
    if (this.isLegacyFlattenedTileMetadata(tileDoc, metadata)) {
      const gridSize = Number(metadata?.gridSize ?? canvas?.scene?.grid?.size);
      const driftThreshold = Number.isFinite(gridSize) && gridSize > 0 ? (gridSize / 2) : 50;
      const ignoreLegacyOffset = Math.abs(offset.x) <= driftThreshold && Math.abs(offset.y) <= driftThreshold;
      if (ignoreLegacyOffset && (offset.x || offset.y)) {
        Logger.warn('TileFlatten.deconstruct.legacyFlattenOffsetIgnored', {
          tileId: tileDoc?.id || null,
          offsetX: offset.x,
          offsetY: offset.y,
          driftThreshold
        });
        return { x: 0, y: 0 };
      }
    }
    return offset;
  }

  isLegacyFlattenedTileMetadata(tileDoc, metadata) {
    if (metadata?.tilePositionMode === 'anchor') return false;
    if (metadata?.tilePositionMode === 'v13-top-left') return true;
    const rotation = Number(tileDoc?.rotation);
    const anchor = getTileTextureAnchor(tileDoc?.texture);
    return (Number.isFinite(rotation) ? rotation : 0) === 0
      && anchor.x === 0
      && anchor.y === 0;
  }

  shouldForceLegacyFlattenTilePositionMigration(tileDoc, metadata) {
    const isLegacyFlattenedTile = this.isLegacyFlattenedTileMetadata(tileDoc, metadata);
    if (isLegacyFlattenedTile) {
      const anchor = getTileTextureAnchor(tileDoc?.texture);
      const rotation = Number(tileDoc?.rotation);
      Logger.warn('TileFlatten.deconstruct.legacyTilePositionMigrationDetected', {
        tileId: tileDoc?.id || null,
        tilePositionMode: metadata?.tilePositionMode || null,
        anchorX: anchor.x,
        anchorY: anchor.y,
        rotation: Number.isFinite(rotation) ? rotation : 0
      });
    }
    return isLegacyFlattenedTile;
  }

  hasRestorableFlattenMetadata(metadata) {
    return !!(metadata && typeof metadata === 'object' && Array.isArray(metadata.tiles) && metadata.tiles.length);
  }

  cloneFlattenMetadataEntry(entry) {
    const manager = this.manager;
    const data = manager._deepClone(entry?.data);
    if (!data || typeof data !== 'object') return null;
    if (!data.flags || typeof data.flags !== 'object') data.flags = {};

    const storedFaFlags = entry?.faFlags && typeof entry.faFlags === 'object'
      ? manager._deepClone(entry.faFlags)
      : null;
    const fallbackFaFlags = data.flags[MODULE_ID] && typeof data.flags[MODULE_ID] === 'object'
      ? manager._deepClone(data.flags[MODULE_ID])
      : null;
    const hasStoredFaFlags = storedFaFlags && Object.keys(storedFaFlags).length > 0;
    const faFlags = hasStoredFaFlags ? storedFaFlags : (fallbackFaFlags || storedFaFlags);
    if (faFlags && typeof faFlags === 'object') {
      data.flags[MODULE_ID] = faFlags;
    }

    return {
      id: entry?.id || data?._id || data?.id || null,
      data
    };
  }

  applyFlattenOffsetToTileData(data, offset = null) {
    if (!data || typeof data !== 'object') return;
    const offsetX = Number.isFinite(offset?.x) ? Number(offset.x) : 0;
    const offsetY = Number.isFinite(offset?.y) ? Number(offset.y) : 0;
    if (!offsetX && !offsetY) return;
    data.x = (Number(data.x) || 0) + offsetX;
    data.y = (Number(data.y) || 0) + offsetY;
  }

  prepareDeconstructionPayload(metadata, offset = null, { forceLegacyTilePositionMigration = false } = {}) {
    const entries = Array.isArray(metadata?.tiles) ? metadata.tiles : [];
    const payloads = [];
    const restoredEntries = [];
    let preservedNestedFlattened = 0;
    let migratedLegacyPositions = 0;
    const offsetX = Number.isFinite(offset?.x) ? Number(offset.x) : 0;
    const offsetY = Number.isFinite(offset?.y) ? Number(offset.y) : 0;
    for (const entry of entries) {
      try {
        const cloned = this.cloneFlattenMetadataEntry(entry);
        if (!cloned) {
          throw new Error(`Stored source Tile ${entry?.id || 'unknown'} has no restorable document data.`);
        }
        const data = cloned.data;
        this.applyFlattenOffsetToTileData(data, offset);
        delete data._id;
        delete data._stats;
        const faFlags = data.flags?.[MODULE_ID];
        if (faFlags && Object.prototype.hasOwnProperty.call(faFlags, 'flattened')) {
          const flattenedMeta = faFlags.flattened;
          if (this.hasRestorableFlattenMetadata(flattenedMeta)) {
            preservedNestedFlattened += 1;
          } else {
            if (flattenedMeta && typeof flattenedMeta === 'object') {
              Logger.warn('TileFlatten.deconstruct.invalidNestedFlattenedFlag', {
                tileId: cloned.id || data?.id || null,
                originalTileCount: flattenedMeta?.originalTileCount ?? null,
                hasTiles: Array.isArray(flattenedMeta?.tiles),
                tileCount: Array.isArray(flattenedMeta?.tiles) ? flattenedMeta.tiles.length : null
              });
            }
            delete faFlags.flattened;
          }
        }
        if (migrateLegacyTilePositionForV14(data, { force: forceLegacyTilePositionMigration })) {
          migratedLegacyPositions += 1;
        }
        const building = data.flags?.[MODULE_ID]?.building;
        payloads.push(normalizeTileCreatePayloadForV14(data, { levelPolicy: LEVEL_POLICY_PRESERVE }));
        restoredEntries.push({
          id: cloned.id || null,
          wallGroupId: building?.meta?.wallGroupId || building?.wall?.wallGroupId || null
        });
      } catch (error) {
        const sourceId = entry?.id || entry?.data?._id || entry?.data?.id || 'unknown';
        Logger.error('TileFlatten.deconstruct.prepare.failed', {
          sourceId,
          error: String(error?.message || error)
        });
        throw new Error(
          `Cannot prepare flattened source Tile ${sourceId} for deconstruction: ${error?.message || error}`,
          { cause: error }
        );
      }
    }
    Logger.debug?.('TileFlatten.deconstruct.prepare.complete', {
      entries: entries.length,
      payloads: payloads.length,
      preservedNestedFlattened,
      migratedLegacyPositions,
      forceLegacyTilePositionMigration,
      offsetX,
      offsetY
    });
    return { payloads, restoredEntries, preservedNestedFlattened };
  }

  countDeconstructRestoreTiles(metadata) {
    return Number(metadata?.originalTileCount ?? metadata?.tiles?.length ?? 0) || 0;
  }

  buildMetadata(input, options = {}) {
    const manager = this.manager;
    const {
      tiles,
      logicalBounds,
      renderBounds,
      paddingInsets,
      pixelWidth,
      pixelHeight,
      ppi,
      quality,
      paddingSnap,
      paddingExtra,
      resolution,
      filePath,
      chunks,
      chunking,
      chunkSize,
      levelIds,
      levelRange,
      layerRole,
      sceneFlattenScope,
      flattenedElevation
    } = input || {};
    const sceneId = canvas?.scene?.id || null;
    const tileData = [];

    const list = Array.isArray(tiles) ? tiles : [];
    let preservedNestedFlattened = 0;
    for (let i = 0; i < list.length; i += 1) {
      const doc = list[i];
      if (!doc) continue;
      try {
        const data = doc.toObject(false);
        const faFlags = data?.flags?.[MODULE_ID] ? manager._deepClone(data.flags[MODULE_ID]) : {};
        if (this.hasRestorableFlattenMetadata(faFlags?.flattened || data?.flags?.[MODULE_ID]?.flattened)) {
          preservedNestedFlattened += 1;
        }
        tileData.push({
          id: doc.id,
          data,
          faFlags
        });
      } catch (error) {
        Logger.debug?.('TileFlatten.metadata.toObject.failed', { error: String(error?.message || error) });
      }
    }
    if (preservedNestedFlattened) {
      Logger.debug?.('TileFlatten.metadata.preservedNestedFlattenedSources', {
        sourceTiles: tileData.length,
        metadataTiles: tileData.length,
        preservedNestedFlattened
      });
    }

    const normalizedInsets = manager._normalizePaddingInsets(paddingInsets)
      || manager._computeBoundsInsets(logicalBounds || renderBounds, renderBounds);
    const fallbackPadding = normalizedInsets?.max ?? 0;
    const normalizedChunks = Array.isArray(chunks)
      ? chunks.map((chunk) => ({
        src: String(chunk?.src || ''),
        x: Number(chunk?.x) || 0,
        y: Number(chunk?.y) || 0,
        width: Number(chunk?.width) || 0,
        height: Number(chunk?.height) || 0,
        pixelWidth: Number.isFinite(Number(chunk?.pixelWidth)) ? Number(chunk?.pixelWidth) : null,
        pixelHeight: Number.isFinite(Number(chunk?.pixelHeight)) ? Number(chunk?.pixelHeight) : null
      })).filter((chunk) => chunk.src && chunk.width > 0 && chunk.height > 0)
      : null;
    const normalizedChunking = chunking && typeof chunking === 'object'
      ? {
        widthSquares: Number.isFinite(Number(chunking.widthSquares)) ? Number(chunking.widthSquares) : null,
        heightSquares: Number.isFinite(Number(chunking.heightSquares)) ? Number(chunking.heightSquares) : null,
        padToChunks: !!chunking.padToChunks,
        pixelWidth: Number.isFinite(Number(chunking.pixelWidth)) ? Number(chunking.pixelWidth) : null,
        pixelHeight: Number.isFinite(Number(chunking.pixelHeight)) ? Number(chunking.pixelHeight) : null,
        worldWidth: Number.isFinite(Number(chunking.worldWidth)) ? Number(chunking.worldWidth) : null,
        worldHeight: Number.isFinite(Number(chunking.worldHeight)) ? Number(chunking.worldHeight) : null
      }
      : null;
    const hasChunkingData = normalizedChunking
      ? [
        normalizedChunking.widthSquares,
        normalizedChunking.heightSquares,
        normalizedChunking.pixelWidth,
        normalizedChunking.pixelHeight,
        normalizedChunking.worldWidth,
        normalizedChunking.worldHeight
      ].some((value) => Number.isFinite(value) && value > 0)
      : false;
    const normalizedChunkSize = Number(chunkSize);

    return {
      version: 1,
      flattenedAt: Date.now(),
      originalTileCount: tileData.length,
      tiles: tileData,
      tilePositionMode: 'anchor',
      logicalBounds: logicalBounds || renderBounds,
      renderBounds,
      originalPosition: renderBounds ? { x: renderBounds.x, y: renderBounds.y } : null,
      wrapperTransform: buildFlattenedWrapperTransform(renderBounds || logicalBounds),
      padding: fallbackPadding,
      paddingInsets: normalizedInsets,
      pixelWidth: Number(pixelWidth) || null,
      pixelHeight: Number(pixelHeight) || null,
      ppi,
      quality,
      paddingSnap: manager._normalizePaddingSnap(paddingSnap),
      paddingExtra: Number.isFinite(Number(paddingExtra)) ? Number(paddingExtra) : 0,
      resolution,
      filePath,
      embeddedMetadata: {
        schema: FLATTEN_WEBP_METADATA_SCHEMA,
        version: FLATTEN_WEBP_METADATA_VERSION,
        required: true,
        primaryFilePath: filePath || null,
        generatedFileCount: normalizedChunks?.length || 1
      },
      chunked: !!(normalizedChunks && normalizedChunks.length),
      chunks: normalizedChunks,
      chunking: hasChunkingData ? normalizedChunking : null,
      chunkSize: Number.isFinite(normalizedChunkSize) && normalizedChunkSize > 0 ? normalizedChunkSize : null,
      levelIds: Array.isArray(levelIds)
        ? normalizeLevelIds(levelIds)
        : null,
      levelRange: buildFlattenLevelRangeMetadata(levelRange),
      layerRole: String(layerRole || '').trim() || null,
      sceneFlattenScope: manager._normalizeExportScope(sceneFlattenScope),
      flattenedElevation: toFiniteNumberOrNull(flattenedElevation),
      sceneId,
      gridSize: Number(canvas?.scene?.grid?.size || 0) || null
    };
  }
}
