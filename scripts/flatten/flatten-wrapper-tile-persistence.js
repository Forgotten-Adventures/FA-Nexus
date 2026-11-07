import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { normalizeGroundBandDocumentSort } from '../canvas/elevation-band-utils.js';
import { FA_NEXUS_TILE_PLACEMENT_LEVEL_FLAG } from '../canvas/tile-band-utils.js';
import {
  LEVEL_POLICY_PRESERVE,
  normalizeTileCreatePayloadForV14
} from '../canvas/tile-document-payloads.js';
import {
  encodeTexturePath,
  getTransparentTextureSrc
} from '../textures/texture-runtime-core.js';
import { buildFlattenedWrapperTransform } from './flatten-deconstruct-payload-workflow.js';
import {
  resolveFlattenedTileLevels as resolveFlattenedTileLevelsForScope,
  resolveFlattenedTileParentLevelId as resolveFlattenedTileParentLevelIdForScope,
  resolveUniformLevelMembership as resolveUniformLevelMembershipForScope
} from './flatten-level-scope.js';

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function defaultDeepClone(value) {
  const foundryUtils = globalThis.foundry?.utils;
  if (foundryUtils?.deepClone) return foundryUtils.deepClone(value);
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}

export class FlattenWrapperTilePersistence {
  constructor({
    deepClone = defaultDeepClone,
    logger = Logger
  } = {}) {
    this._deepClone = typeof deepClone === 'function' ? deepClone : defaultDeepClone;
    this._logger = logger || Logger;
  }

  buildTileData(bounds, filePath, metadata) {
    if (!canvas?.scene) throw new Error('Scene not available');

    const isChunked = Array.isArray(metadata?.chunks) && metadata.chunks.length > 0;
    const rawPath = typeof filePath === 'string' ? filePath : '';
    const cleanPath = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
    const textureSrc = cleanPath || (isChunked ? getTransparentTextureSrc() : '');

    const baseMeta = metadata?.tiles?.[0]?.data || {};
    const outputSettings = metadata.outputTileSettings || baseMeta;
    const sortValues = Array.isArray(metadata?.tiles)
      ? metadata.tiles.map((t) => {
        const data = t?.data || {};
        const normalized = normalizeGroundBandDocumentSort(data.elevation ?? baseMeta.elevation, data.sort, {
          scene: canvas?.scene
        });
        if (normalized.normalized) {
          this._logger.warn('TileFlatten.sort.groundBandDocumentSort.normalized', {
            tileId: data._id || data.id || null,
            elevation: Number(data.elevation ?? baseMeta.elevation ?? 0) || 0,
            originalSort: normalized.originalSort,
            normalizedSort: normalized.sort,
            groundBandLocalSort: normalized.localSort,
            encoding: normalized.encoding
          });
        }
        return Number(normalized.sort);
      }).filter((v) => Number.isFinite(v))
      : [];
    const maxSort = sortValues.length ? Math.max(...sortValues) : 0;
    const minElevation = this.resolveFlattenedTileElevation(metadata, baseMeta.elevation);
    const flattenedLevels = this.resolveFlattenedTileLevels(metadata);
    const flattenedParentLevelId = this.resolveFlattenedTileParentLevelId(metadata, flattenedLevels);
    const wrapperTransform = buildFlattenedWrapperTransform(bounds);
    if (wrapperTransform) metadata.wrapperTransform = wrapperTransform;

    const tileData = normalizeTileCreatePayloadForV14({
      texture: { src: encodeTexturePath(textureSrc), anchorX: 0.5, anchorY: 0.5 },
      x: wrapperTransform?.x ?? (bounds.x + (bounds.width / 2)),
      y: wrapperTransform?.y ?? (bounds.y + (bounds.height / 2)),
      width: wrapperTransform?.width ?? bounds.width,
      height: wrapperTransform?.height ?? bounds.height,
      rotation: 0,
      alpha: 1,
      elevation: minElevation,
      sort: Number.isFinite(maxSort) ? maxSort : 0,
      hidden: !!baseMeta.hidden,
      locked: !!outputSettings.locked,
      levels: flattenedLevels,
      roof: !!outputSettings.roof,
      occlusion: outputSettings.occlusion ? this._deepClone(outputSettings.occlusion) : undefined,
      restrictions: outputSettings.restrictions ? this._deepClone(outputSettings.restrictions) : undefined,
      flags: {
        'fa-nexus': {
          flattened: metadata,
          ...(flattenedParentLevelId ? { [FA_NEXUS_TILE_PLACEMENT_LEVEL_FLAG]: flattenedParentLevelId } : {})
        }
      }
    }, { levelPolicy: LEVEL_POLICY_PRESERVE });

    return tileData;
  }

  async createFlattenedTile(bounds, filePath, metadata) {
    const created = await canvas.scene.createEmbeddedDocuments('Tile', [this.buildTileData(bounds, filePath, metadata)]);

    await new Promise(resolve => setTimeout(resolve, 100));

    return created;
  }

  resolveFlattenedTileElevation(metadata, fallback = 0) {
    const explicitElevation = toFiniteNumberOrNull(metadata?.flattenedElevation);
    if (Number.isFinite(explicitElevation)) return explicitElevation;
    const elevations = Array.isArray(metadata?.tiles)
      ? metadata.tiles
        .map((entry) => Number(entry?.data?.elevation))
        .filter((value) => Number.isFinite(value))
      : [];
    if (elevations.length) return Math.min(...elevations);
    const numericFallback = Number(fallback);
    return Number.isFinite(numericFallback) ? numericFallback : 0;
  }

  resolveFlattenedTileParentLevelId(metadata, fallbackLevels = []) {
    return resolveFlattenedTileParentLevelIdForScope(metadata, fallbackLevels);
  }

  resolveUniformLevelMembership(documents = []) {
    return resolveUniformLevelMembershipForScope(documents, { logger: this._logger });
  }

  resolveFlattenedTileLevels(metadata) {
    return resolveFlattenedTileLevelsForScope(metadata, { logger: this._logger });
  }
}
