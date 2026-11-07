import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  getTileOcclusionMask,
  getSurfaceTileOcclusionModes,
  mapTileOcclusionElevation
} from '../canvas/tile-occlusion.js';

// 40 checks of 250 ms: how long a Tile may still be drawing before its missing occlusion mesh is reported.
const SHADOW_OCCLUSION_MESH_WAIT_ATTEMPTS = 40;

const SHADOW_OCCLUSION_FRAGMENT_SHADER = `
varying vec2 vTextureCoord;

uniform sampler2D uSampler;
uniform sampler2D occlusionTexture;
uniform vec2 screenDimensions;
uniform float occlusionElevation;
uniform float unoccludedAlpha;
uniform float occludedAlpha;
uniform float fadeOcclusion;
uniform float radialOcclusion;
uniform float visionOcclusion;
uniform float surfaceOcclusion;

void main() {
  vec4 color = texture2D(uSampler, vTextureCoord);
  vec2 maskCoord = gl_FragCoord.xy / max(screenDimensions, vec2(1.0));
  vec4 occluded = 1.0 - step(vec4(occlusionElevation), texture2D(occlusionTexture, maskCoord));
  float occlusion = max(
    max(occluded.r * fadeOcclusion, occluded.g * radialOcclusion),
    max(occluded.b * visionOcclusion, occluded.a * surfaceOcclusion)
  );
  gl_FragColor = color * mix(unoccludedAlpha, occludedAlpha, occlusion);
}
`;

function clampUnit(value, fallback = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.min(1, Math.max(0, numeric));
  return Math.min(1, Math.max(0, Number(fallback) || 0));
}

function getTransparentTexture() {
  try {
    return PIXI.Texture.EMPTY;
  } catch (_) {
    return null;
  }
}

function getPrimaryShadowOcclusionMeshClasses() {
  try {
    const PrimarySpriteMesh = globalThis?.foundry?.canvas?.primary?.PrimarySpriteMesh;
    const PrimaryBaseSamplerShader = globalThis?.foundry?.canvas?.rendering?.shaders?.PrimaryBaseSamplerShader;
    if (typeof PrimarySpriteMesh !== 'function' || typeof PrimaryBaseSamplerShader !== 'function') return null;
    return { PrimarySpriteMesh, PrimaryBaseSamplerShader };
  } catch (_) {
    return null;
  }
}

function createAssetShadowOcclusionFilter(runtime, layer) {
  const FilterClass = globalThis.PIXI?.Filter;
  if (!FilterClass) return null;
  return new (class extends FilterClass {
    constructor() {
      super(undefined, SHADOW_OCCLUSION_FRAGMENT_SHADER, {
        screenDimensions: [1, 1],
        occlusionTexture: getTransparentTexture(),
        occlusionElevation: 0,
        unoccludedAlpha: 1,
        occludedAlpha: 0,
        fadeOcclusion: 0,
        radialOcclusion: 0,
        visionOcclusion: 0,
        surfaceOcclusion: 0
      });
      this.runtime = runtime;
      this.layer = layer;
    }

    apply(filterManager, input, output, clear, currentState) {
      try {
        this.runtime?.prepareShadowOcclusionUniforms?.(this.layer, this.uniforms);
      } catch (error) {
        Logger.warn('AssetShadow.occlusionFilter.prepareFailed', {
          layerKey: this.layer?.key || null,
          error: String(error?.message || error)
        });
      }
      super.apply(filterManager, input, output, clear, currentState);
    }
  })();
}

// The frame the canvas is drawing: every part of a shadow layer asks the same questions within one frame.
function currentFrameStamp() {
  const stamp = globalThis.canvas?.app?.ticker?.lastTime;
  return Number.isFinite(stamp) ? stamp : null;
}

export class AssetShadowOcclusionRuntime {
  constructor(manager) {
    this.manager = manager;
    // Tile document -> its occlusion profile, valid while the document's occlusion data objects are the same ones.
    this._profilesByDocument = new WeakMap();
  }

  getTileShadowOcclusionMask(doc) {
    try {
      return getTileOcclusionMask(doc?.occlusion, { sourceOcclusion: doc?._source?.occlusion });
    } catch (error) {
      Logger.warn('AssetShadow.occlusionMask.readFailed', {
        tileId: doc?.id || doc?._id || null,
        error: String(error?.message || error)
      });
      return 0;
    }
  }

  getSurfaceShadowOcclusionMask() {
    return getSurfaceTileOcclusionModes()
      .map((mode) => Number(mode))
      .filter((mode) => Number.isInteger(mode) && mode > 0)
      .reduce((resolvedMask, mode) => resolvedMask | mode, 0);
  }

  isSurfaceOnlyShadowOcclusionMask(mask) {
    const numericMask = Number(mask) || 0;
    const surfaceMask = this.getSurfaceShadowOcclusionMask();
    return !!surfaceMask && numericMask === surfaceMask;
  }

  getTileShadowOccludedAlpha(doc) {
    const alpha = Number(doc?.occlusion?.alpha ?? doc?._source?.occlusion?.alpha);
    return clampUnit(alpha, 0);
  }

  getTileShadowOcclusionProfile(doc) {
    // A document replaces its prepared occlusion object (and its Set of modes) whenever it changes, so the profile
    // worked out for the same objects is still the right one. Plain objects passed by previews are not remembered.
    const remember = !!doc && typeof doc === 'object' && typeof doc.update === 'function';
    if (!remember) return this._computeTileShadowOcclusionProfile(doc);
    const occlusion = doc.occlusion, source = doc._source?.occlusion;
    const known = this._profilesByDocument.get(doc);
    if (known && known.occlusion === occlusion && known.modes === occlusion?.modes && known.alpha === occlusion?.alpha
      && known.source === source && known.sourceModes === source?.modes && known.sourceAlpha === source?.alpha) return known.profile;
    const profile = this._computeTileShadowOcclusionProfile(doc);
    this._profilesByDocument.set(doc, { occlusion, modes: occlusion?.modes, alpha: occlusion?.alpha, source, sourceModes: source?.modes, sourceAlpha: source?.alpha, profile });
    return profile;
  }

  _computeTileShadowOcclusionProfile(doc) {
    const mask = this.getTileShadowOcclusionMask(doc);
    if (!mask) return {
      key: 'none',
      mask: 0,
      shareable: false,
      type: 'none'
    };

    if (this.isSurfaceOnlyShadowOcclusionMask(mask)) {
      const alphaKey = this.getTileShadowOccludedAlpha(doc).toFixed(3);
      return {
        key: `occlusion:surface:${mask}:a${alphaKey}`,
        mask,
        shareable: true,
        type: 'surface',
        alphaKey
      };
    }

    const tileId = String(doc?.id || doc?._id || '').trim();
    if (!tileId) {
      Logger.error('AssetShadow.occlusionKey.missingTileId', { mask });
      return {
        key: `occlusion:missing:${mask}`,
        mask,
        shareable: false,
        type: 'tile'
      };
    }
    return {
      key: `occlusion:${tileId}:${mask}`,
      mask,
      shareable: false,
      type: 'tile'
    };
  }

  shouldLayerUseShadowOcclusion(layer) {
    return !!layer && String(layer.shadowOcclusionKey || 'none') !== 'none';
  }

  ensureShadowOcclusionFilter(layer, holder = layer) {
    if (!this.shouldLayerUseShadowOcclusion(layer)) {
      if (holder?.occlusionFilter && !holder.occlusionFilter.destroyed) {
        try { holder.occlusionFilter.destroy(); } catch (_) {}
      }
      if (holder) holder.occlusionFilter = null;
      return null;
    }
    if (!globalThis.PIXI?.Filter) {
      this.logShadowOcclusionIssue(layer, 'AssetShadow.occlusionFilter.pixMissing');
      return null;
    }
    if (!holder.occlusionFilter || holder.occlusionFilter.destroyed) {
      holder.occlusionFilter = createAssetShadowOcclusionFilter(this, layer);
    }
    return holder.occlusionFilter;
  }

  syncShadowLayerFilters(layer) {
    if (!layer) return;
    if (layer.blurFilter && !layer.blurFilter.destroyed) {
      try { layer.blurFilter.destroy(); } catch (_) {}
    }
    layer.blurFilter = null;

    const chunks = Array.from(layer.renderChunks?.values?.() || []);
    const targets = chunks.length ? chunks : [{ sprite: layer.sprite, occlusionFilter: layer.occlusionFilter }];
    for (const target of targets) {
      if (!target?.sprite || target.sprite.destroyed) continue;
      if (target.usesOcclusionMesh) {
        try { target.sprite.filters = null; } catch (_) {}
        this.syncShadowOcclusionMeshRuntime(layer, target.sprite);
        continue;
      }
      const filters = [];
      const occlusionFilter = this.ensureShadowOcclusionFilter(layer, target);
      if (occlusionFilter && !occlusionFilter.destroyed) filters.push(occlusionFilter);
      try { target.sprite.filters = filters.length ? filters : null; }
      catch (error) {
        Logger.warn('AssetShadow.filters.syncFailed', {
          layerKey: layer?.key || null,
          error: String(error?.message || error)
        });
      }
    }
    if (!chunks.length && targets[0]) layer.occlusionFilter = targets[0].occlusionFilter || null;
  }

  getLayerOcclusionDoc(layer) {
    if (!this.shouldLayerUseShadowOcclusion(layer)) return null;
    // Every part of the layer asks this on every frame: the answer is worked out once per frame and layer.
    const stamp = currentFrameStamp(), memo = layer.occlusionDocMemo;
    if (memo && stamp !== null && memo.stamp === stamp && memo.tiles === layer.tiles && memo.size === layer.tiles?.size && memo.key === layer.shadowOcclusionKey) return memo.doc;
    const doc = this._resolveLayerOcclusionDoc(layer);
    layer.occlusionDocMemo = stamp === null ? null : { stamp, tiles: layer.tiles, size: layer.tiles?.size, key: layer.shadowOcclusionKey, doc };
    return doc;
  }

  _resolveLayerOcclusionDoc(layer) {
    const docs = Array.from(layer?.tiles?.values?.() || []);
    const doc = docs[0] || null;
    if (!doc) {
      this.logShadowOcclusionIssue(layer, 'AssetShadow.occlusionFilter.missingDoc');
      return null;
    }
    if (docs.length > 1) {
      const profile = layer?.shadowOcclusionProfile || null;
      const incompatibleDocs = profile?.shareable
        ? docs.filter((entry) => this.getTileShadowOcclusionProfile(entry).key !== layer.shadowOcclusionKey)
        : docs;
      if (profile?.shareable && !incompatibleDocs.length) return doc;

      const tileIds = docs
        .map((entry) => entry?.id || entry?._id || null)
        .filter(Boolean);
      this.logShadowOcclusionIssue(layer, 'AssetShadow.occlusionFilter.sharedLayer', {
        tileIds,
        shareable: !!profile?.shareable,
        incompatibleTileIds: incompatibleDocs
          .map((entry) => entry?.id || entry?._id || null)
          .filter(Boolean)
      });
      return null;
    }
    return doc;
  }

  syncShadowOcclusionMeshRuntime(layer, displayObject) {
    if (!displayObject || displayObject.destroyed) return false;
    try {
      const doc = this.getLayerOcclusionDoc(layer);
      const tile = doc ? this.getTilePlaceableForDocument(doc) : null;
      const sourceMesh = tile?.mesh || null;
      const sourceState = sourceMesh?._occlusionState || null;
      const targetState = displayObject._occlusionState || null;
      if (!doc || !tile || !sourceMesh || !sourceState || !targetState) {
        if (targetState) {
          targetState.fade = 0;
          targetState.radial = 0;
          targetState.vision = 0;
          targetState.surface = 0;
        }
        displayObject.occlusionMode = 0;
        displayObject.occluded = false;
        displayObject.unoccludedAlpha = 1;
        displayObject.occludedAlpha = 0;
        this.scheduleShadowOcclusionMeshIssue(layer);
        return false;
      }

      displayObject.elevation = sourceMesh.elevation ?? doc.elevation ?? layer?.elevation ?? 0;
      displayObject._occludedBySameElevationSurfaces = sourceMesh._occludedBySameElevationSurfaces !== false;
      displayObject.occlusionMode = Number(sourceMesh.occlusionMode ?? this.getTileShadowOcclusionMask(doc) ?? 0) || 0;
      displayObject.occluded = !!sourceMesh.occluded;
      displayObject.unoccludedAlpha = 1;
      displayObject.occludedAlpha = clampUnit(sourceMesh.occludedAlpha ?? doc?.occlusion?.alpha, 0);
      targetState.fade = clampUnit(sourceState.fade, 0);
      targetState.radial = clampUnit(sourceState.radial, 0);
      targetState.vision = clampUnit(sourceState.vision, 0);
      targetState.surface = clampUnit(sourceState.surface, 0);
      if (typeof displayObject._updateBatchData === 'function') displayObject._updateBatchData();
      this.clearScheduledShadowOcclusionMeshIssue(layer);
      this.clearShadowOcclusionIssue(layer);
      return true;
    } catch (error) {
      Logger.warn('AssetShadow.occlusionMesh.syncFailed', {
        layerKey: layer?.key || null,
        error: String(error?.message || error)
      });
      return false;
    }
  }

  getTilePlaceableForDocument(doc) {
    try {
      const tileId = String(doc?.id || doc?._id || '').trim();
      if (!tileId) return null;
      const direct = canvas?.tiles?.get?.(tileId);
      if (direct) return direct;
      const placeables = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
      return placeables.find((tile) => tile?.document === doc || String(tile?.document?.id || tile?.document?._id || '') === tileId) || null;
    } catch (_) {
      return null;
    }
  }

  scheduleShadowOcclusionMeshIssue(layer, attempt = 0) {
    if (!layer || layer.shadowOcclusionMeshIssueTimer) return;
    layer.shadowOcclusionMeshIssueTimer = setTimeout(() => {
      layer.shadowOcclusionMeshIssueTimer = null;
      const doc = this.getLayerOcclusionDoc(layer);
      if (!doc) return;
      const tile = this.getTilePlaceableForDocument(doc);
      const sourceMesh = tile?.mesh || null;
      const sourceState = sourceMesh?._occlusionState || null;
      if (tile && sourceMesh && sourceState) {
        this.clearShadowOcclusionIssue(layer);
        return;
      }
      // A Tile still drawing has no mesh until its texture has loaded, which on a slow host (The Forge, files from its
      // CDN) takes longer than one check. Keep looking for up to ten seconds before calling it missing.
      if (tile && !tile.destroyed && attempt < SHADOW_OCCLUSION_MESH_WAIT_ATTEMPTS) {
        this.scheduleShadowOcclusionMeshIssue(layer, attempt + 1);
        return;
      }
      this.logShadowOcclusionIssue(layer, 'AssetShadow.occlusionMesh.missingMeshState', {
        tileId: doc?.id || doc?._id || null,
        hasTile: !!tile,
        hasMesh: !!sourceMesh,
        hasState: !!sourceState
      });
    }, 250);
  }

  clearScheduledShadowOcclusionMeshIssue(layer) {
    if (!layer?.shadowOcclusionMeshIssueTimer) return;
    clearTimeout(layer.shadowOcclusionMeshIssueTimer);
    layer.shadowOcclusionMeshIssueTimer = null;
  }

  prepareShadowOcclusionUniforms(layer, uniforms) {
    if (!uniforms) return;
    const doc = this.getLayerOcclusionDoc(layer);
    const tile = doc ? this.getTilePlaceableForDocument(doc) : null;
    const mesh = tile?.mesh || null;
    const state = mesh?._occlusionState || null;
    const occlusionMask = canvas?.masks?.occlusion || null;

    uniforms.screenDimensions = canvas?.screenDimensions || [1, 1];
    uniforms.occlusionTexture = occlusionMask?.renderTexture || getTransparentTexture();
    uniforms.occlusionElevation = mapTileOcclusionElevation(tile || doc, {
      mesh,
      document: doc,
      occlusionMask,
      fallback: layer?.elevation ?? 0
    }) ?? occlusionMask?.mapElevation?.(mesh?.elevation ?? doc?.elevation ?? layer?.elevation ?? 0) ?? 0;
    uniforms.unoccludedAlpha = 1;
    uniforms.occludedAlpha = clampUnit(mesh?.occludedAlpha ?? doc?.occlusion?.alpha, 0);

    if (!doc || !tile || !mesh || !state) {
      uniforms.fadeOcclusion = 0;
      uniforms.radialOcclusion = 0;
      uniforms.visionOcclusion = 0;
      uniforms.surfaceOcclusion = 0;
      this.logShadowOcclusionIssue(layer, 'AssetShadow.occlusionFilter.missingMeshState', {
        tileId: doc?.id || doc?._id || null,
        hasTile: !!tile,
        hasMesh: !!mesh,
        hasState: !!state
      });
      return;
    }

    uniforms.fadeOcclusion = clampUnit(state.fade, 0);
    uniforms.radialOcclusion = clampUnit(state.radial, 0);
    uniforms.visionOcclusion = clampUnit(state.vision, 0);
    uniforms.surfaceOcclusion = clampUnit(state.surface, 0);
    this.clearShadowOcclusionIssue(layer);
  }

  logShadowOcclusionIssue(layer, code, details = {}) {
    try {
      const key = `${code}:${JSON.stringify(details)}`;
      if (layer && layer.occlusionIssueKey === key) return;
      if (layer) layer.occlusionIssueKey = key;
      Logger.error(code, {
        layerKey: layer?.key || null,
        shadowOcclusionKey: layer?.shadowOcclusionKey || null,
        ...details
      });
    } catch (_) {}
  }

  clearShadowOcclusionIssue(layer) {
    try { if (layer) layer.occlusionIssueKey = null; } catch (_) {}
  }

  createShadowOcclusionChunkMesh(layer, key) {
    try {
      const classes = getPrimaryShadowOcclusionMeshClasses();
      if (!classes) {
        if (!this.manager._shadowOcclusionMeshUnavailableLogged) {
          this.manager._shadowOcclusionMeshUnavailableLogged = true;
          Logger.error('AssetShadow.occlusionMesh.unavailable', {
            layerKey: layer?.key || null
          });
        }
        return null;
      }
      const rendererPlugins = canvas?.app?.renderer?.plugins || null;
      if (!rendererPlugins?.batchOcclusion) {
        if (!this.manager._shadowOcclusionBatchUnavailableLogged) {
          this.manager._shadowOcclusionBatchUnavailableLogged = true;
          Logger.error('AssetShadow.occlusionMesh.batchPluginUnavailable', {
            layerKey: layer?.key || null
          });
        }
        return null;
      }

      const { PrimarySpriteMesh, PrimaryBaseSamplerShader } = classes;
      const mesh = new PrimarySpriteMesh(PIXI.Texture.EMPTY, PrimaryBaseSamplerShader);
      mesh.name = `fa-nexus-shadow-occlusion-chunk:${key}`;
      mesh.eventMode = 'none';
      mesh.pluginName = 'batchOcclusion';
      mesh.unoccludedAlpha = 1;
      mesh.occludedAlpha = 0;
      mesh.occlusionMode = 0;
      mesh.occluded = false;
      this.syncShadowOcclusionMeshRuntime(layer, mesh);

      const runtime = this;
      const originalUpdateTransform = mesh.updateTransform;
      mesh.updateTransform = function faNexusShadowOcclusionUpdateTransform(...args) {
        const result = originalUpdateTransform.apply(this, args);
        runtime.syncShadowOcclusionMeshRuntime(layer, this);
        return result;
      };
      return mesh;
    } catch (error) {
      Logger.error('AssetShadow.occlusionMesh.createFailed', {
        layerKey: layer?.key || null,
        error: String(error?.message || error)
      });
      return null;
    }
  }
}
