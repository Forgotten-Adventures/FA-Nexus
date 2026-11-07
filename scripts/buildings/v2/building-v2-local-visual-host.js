import { BuildingWallMesher } from '../building-wall-mesher.js';
import { resolvePreviewTileRenderOrdering } from '../../canvas/tile-band-utils.js';
import { loadTexture } from '../../textures/texture-runtime-core.js';
import { createOwnedSamplerTexture } from '../../textures/owned-sampler-texture.js';
import { resolveMaskedTilingBaseGridScale } from '../../textures/masked-tiling-resize-contract.js';
import { applyHsbcToDisplayObject, clearHsbcFromDisplayObject } from '../../core/hsbc.js';
import {
  createBuildingV2FillMaskRuntime,
  measureBuildingV2FillMaskRegions,
  normalizeBuildingV2FillAppearance
} from './building-v2-fill-mask-runtime.js';
import { createBuildingV2SpatialTransform } from './building-v2-spatial-transform.js';

const ROOT_NAME = 'fa-nexus-building-preview-root';
const FILL_ROOT_NAME = 'fa-nexus-building-fill-preview-root';
const SILLS_ROOT_NAME = 'fa-nexus-building-sills-preview-root';
const CENTERLINE_NAME = 'fa-nexus-building-v2-native-wall-centerline';
const VISIBLE_ROWS_CACHE = new WeakMap();
const PREPARED_CLEANUP_STATE = Symbol('faNexusBuildingV2PreparedCleanupState');

function requireProjection(projection) {
  if (!projection || Number(projection.version) !== 1) {
    throw new Error('Building V2 visual projection requires compiler contract version 1.');
  }
  if (!Array.isArray(projection.visualSections)) {
    throw new Error('Building V2 visual projection requires renderer-ready Wall sections, including an empty pre-geometry list.');
  }
  if (!projection.fillPlacement || !Number.isFinite(Number(projection.fillPlacement.elevation))) {
    throw new Error('Building V2 visual projection requires its planned Fill placement.');
  }
  return projection;
}

export function inspectBuildingV2WallTextureRows(texture) {
  if (texture && VISIBLE_ROWS_CACHE.has(texture)) return VISIBLE_ROWS_CACHE.get(texture);
  const base = texture?.baseTexture;
  const source = base?.resource?.source;
  if (!source || !base?.valid || typeof globalThis.document?.createElement !== 'function') return null;
  try {
    const width = Math.max(1, Number(base.width) || 1);
    const height = Math.max(1, Number(base.height) || 1);
    const sample = globalThis.document.createElement('canvas');
    sample.width = width;
    sample.height = height;
    const context = sample.getContext('2d');
    context.drawImage(source, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;
    const rowVisible = (y) => {
      for (let x = 0; x < width; x += 1) {
        if (pixels[((y * width) + x) * 4 + 3] > 10) return true;
      }
      return false;
    };
    let top = 0;
    let bottom = height - 1;
    while (top < height && !rowVisible(top)) top += 1;
    while (bottom > top && !rowVisible(bottom)) bottom -= 1;
    const visibleData = { topRow: top, bottomRow: bottom, totalHeight: height, visibleHeight: Math.max(1, bottom - top + 1) };
    VISIBLE_ROWS_CACHE.set(texture, visibleData);
    return visibleData;
  } catch (_) {
    return null;
  }
}

function remapVisibleRows(geometry, visibleData) {
  if (!geometry || !visibleData) return;
  try {
    const uvBuffer = geometry.getBuffer?.('aTextureCoord');
    if (!uvBuffer?.data) return;
    const vMin = visibleData.topRow / visibleData.totalHeight;
    const vMax = (visibleData.bottomRow + 1) / visibleData.totalHeight;
    const range = Math.max(0.001, vMax - vMin);
    for (let index = 1; index < uvBuffer.data.length; index += 2) {
      uvBuffer.data[index] = vMin + (uvBuffer.data[index] * range);
    }
    uvBuffer.update?.();
  } catch (_) {}
}

export function resolveBuildingV2WallTextureMetrics(section, texture, visibleData) {
  const sceneGridSize = Math.max(1, Number(section?.sceneGridSize) || 100);
  const assetScale = sceneGridSize / 200;
  const textureWidth = Math.max(1, Number(texture?.width || texture?.baseTexture?.width) || 200);
  const textureHeight = Math.max(1, Number(texture?.height || texture?.baseTexture?.height) || 200);
  const explicitWidth = Number(section?.width);
  const explicitRepeat = Number(section?.repeatDistance);
  const scale = Math.min(4, Math.max(0.25, Number(section?.scalePercent || 100) / 100));
  return {
    width: Number.isFinite(explicitWidth) && explicitWidth > 0
      ? explicitWidth
      : Math.max(10, (visibleData?.visibleHeight || textureHeight) * assetScale * scale),
    repeatDistance: Number.isFinite(explicitRepeat) && explicitRepeat > 0
      ? explicitRepeat
      : Math.max(1, textureWidth * assetScale * scale)
  };
}

function boundsFromPositions(positions) {
  if (!positions || positions.length < 2) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index + 1 < positions.length; index += 2) {
    const x = Number(positions[index]);
    const y = Number(positions[index + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  return { minX, minY, maxX, maxY };
}

function boundsFromCenteredRectangle({ x, y, width, height, rotationDegrees }) {
  const radians = Number(rotationDegrees) * (Math.PI / 180);
  const halfWidth = Number(width) / 2;
  const halfHeight = Number(height) / 2;
  const extentX = (Math.abs(Math.cos(radians)) * halfWidth) + (Math.abs(Math.sin(radians)) * halfHeight);
  const extentY = (Math.abs(Math.sin(radians)) * halfWidth) + (Math.abs(Math.cos(radians)) * halfHeight);
  return {
    minX: Number(x) - extentX,
    minY: Number(y) - extentY,
    maxX: Number(x) + extentX,
    maxY: Number(y) + extentY
  };
}

function normalizeSillPreviewParts(sills = []) {
  if (!Array.isArray(sills)) {
    throw new Error('Building V2 visual projection requires Window sills to be an array.');
  }
  let sharedElevation = null;
  let sharedSort = null;
  return sills.map((part, index) => {
    const id = String(part?.id || '').trim();
    const textureSrc = String(part?.texture?.src || '').trim();
    const values = {
      x: Number(part?.x),
      y: Number(part?.y),
      width: Number(part?.width),
      height: Number(part?.height),
      rotationDegrees: Number(part?.rotation),
      alpha: Number(part?.alpha),
      anchorX: Number(part?.texture?.anchorX),
      anchorY: Number(part?.texture?.anchorY),
      elevation: Number(part?.elevation),
      sort: Number(part?.sort)
    };
    if (!id || !textureSrc) {
      throw new Error(`Building V2 Window sill preview part ${index} is missing its identity or exact texture source.`);
    }
    if (!Object.values(values).every(Number.isFinite) || !(values.width > 0) || !(values.height > 0)) {
      throw new Error(`Building V2 Window sill preview part ${id} requires finite center, size, rotation, alpha, anchor, elevation, and sort.`);
    }
    if (sharedElevation === null) {
      sharedElevation = values.elevation;
      sharedSort = values.sort;
    } else if (values.elevation !== sharedElevation || values.sort !== sharedSort) {
      throw new Error('Building V2 Window sill preview requires every part to share one exact elevation and sort.');
    }
    return { source: part, id, textureSrc, ...values };
  });
}

export function mergeRenderEnvelopes(envelopes) {
  const finite = envelopes.filter((entry) => entry
    && [entry.minX, entry.minY, entry.maxX, entry.maxY].every((value) => Number.isFinite(Number(value))));
  if (!finite.length) return null;
  const minX = Math.min(...finite.map((entry) => Number(entry.minX)));
  const minY = Math.min(...finite.map((entry) => Number(entry.minY)));
  const maxX = Math.max(...finite.map((entry) => Number(entry.maxX)));
  const maxY = Math.max(...finite.map((entry) => Number(entry.maxY)));
  return Object.freeze({ minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY });
}

function pointOnPolygonEdge(point, polygon, epsilon = 1e-7) {
  const px = Number(point?.x);
  const py = Number(point?.y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
  return polygon.some((start, index) => {
    const end = polygon[(index + 1) % polygon.length];
    const ax = Number(start?.x);
    const ay = Number(start?.y);
    const bx = Number(end?.x);
    const by = Number(end?.y);
    const cross = ((bx - ax) * (py - ay)) - ((by - ay) * (px - ax));
    if (Math.abs(cross) > epsilon) return false;
    return px >= Math.min(ax, bx) - epsilon && px <= Math.max(ax, bx) + epsilon
      && py >= Math.min(ay, by) - epsilon && py <= Math.max(ay, by) + epsilon;
  });
}

function polygonContainsPoint(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3 || pointOnPolygonEdge(point, polygon)) return false;
  const px = Number(point.x);
  const py = Number(point.y);
  let inside = false;
  for (let index = 0, prior = polygon.length - 1; index < polygon.length; prior = index, index += 1) {
    const current = polygon[index];
    const previous = polygon[prior];
    const crosses = ((Number(current.y) > py) !== (Number(previous.y) > py))
      && (px < ((Number(previous.x) - Number(current.x)) * (py - Number(current.y))
        / (Number(previous.y) - Number(current.y))) + Number(current.x));
    if (crosses) inside = !inside;
  }
  return inside;
}

export function groupBuildingV2FillMaskShapesForPixi(shapes = []) {
  const exteriors = shapes.filter((shape) => shape?.operation !== 'subtract');
  const holes = shapes.filter((shape) => shape?.operation === 'subtract');
  const groups = exteriors.map((exterior) => ({ exterior, holes: [] }));
  for (const hole of holes) {
    const probe = hole?.vertices?.[0];
    const owners = groups.filter((group) => polygonContainsPoint(probe, group.exterior?.vertices));
    if (owners.length !== 1) {
      throw new Error('Building V2 Fill preview requires every hole to belong to exactly one exterior.');
    }
    owners[0].holes.push(hole);
  }
  return groups;
}

export function measureBuildingV2WallRenderEnvelope(sections, { mesher = BuildingWallMesher } = {}) {
  if (!Array.isArray(sections)) {
    throw new Error('Building V2 local Render Envelope measurement requires Wall sections.');
  }
  const envelopes = [];
  for (const section of sections) {
    const width = Number(section?.width);
    const repeatDistance = Number(section?.repeatDistance);
    if (!(width > 0) || !(repeatDistance > 0)) {
      throw new Error(`Building V2 local Render Envelope measurement is missing metrics for ${String(section?.sectionId || '')}.`);
    }
    const result = mesher.buildGeometry(section.points, {
      width,
      closed: section.closed !== false,
      joinStyle: 'mitre',
      mitreLimit: 4,
      textureRepeatDistance: repeatDistance,
      texturePhaseDistance: section.texturePhaseDistance,
      textureOffset: section.textureOffset,
      textureFlip: section.textureFlip,
      startJoinDir: section.startJoinDir,
      startCapNormal: section.startCapNormal,
      endCapNormal: section.endCapNormal,
      endJoinDir: section.endJoinDir
    });
    try {
      const envelope = boundsFromPositions(result?.data?.positions);
      if (!envelope) {
        throw new Error(`Building V2 local Render Envelope measurement produced empty geometry for ${String(section?.sectionId || '')}.`);
      }
      envelopes.push(envelope);
    } finally {
      try { result?.geometry?.destroy?.(); } catch (_) {}
    }
  }
  return mergeRenderEnvelopes(envelopes);
}

function hasRenderablePathShadow(section) {
  const shadow = section?.pathShadow;
  if (!shadow || typeof shadow !== 'object' || shadow.enabled === false) return false;
  const alpha = Math.min(1, Math.max(0, Number(shadow.alpha ?? 0.6)));
  const layerOpacity = Math.min(1, Math.max(0, Number(section?.layerOpacity ?? 1)));
  return alpha > 0.001 && layerOpacity > 0.001;
}

function remapVisibleRowsData(data, visibleData) {
  if (!data?.uvs || !visibleData) return data;
  const vMin = visibleData.topRow / visibleData.totalHeight;
  const vMax = (visibleData.bottomRow + 1) / visibleData.totalHeight;
  const range = Math.max(0.001, vMax - vMin);
  for (let index = 1; index < data.uvs.length; index += 2) {
    data.uvs[index] = vMin + (data.uvs[index] * range);
  }
  return data;
}

function updateGeometryFromCenterline(geometry, data) {
  if (!geometry || !data) throw new Error('Building V2 continuous Wall update requires geometry and centerline data.');
  const updateAttribute = (name, values, fallbackType = Float32Array) => {
    const buffer = geometry.getBuffer?.(name);
    if (!buffer?.update) throw new Error(`Building V2 continuous Wall geometry is missing ${name}.`);
    const Type = ArrayBuffer.isView(buffer.data) ? buffer.data.constructor : fallbackType;
    buffer.update(values instanceof Type ? values : new Type(values));
  };
  updateAttribute('aVertexPosition', data.positions);
  updateAttribute('aTextureCoord', data.uvs);
  if (Array.isArray(data.alphas) && data.alphas.length) updateAttribute('aAlpha', data.alphas);
  const indexBuffer = geometry.getIndex?.();
  if (!indexBuffer?.update) throw new Error('Building V2 continuous Wall geometry is missing its index buffer.');
  let maxIndex = 0;
  for (const index of data.indices || []) maxIndex = Math.max(maxIndex, Number(index) || 0);
  const IndexType = maxIndex > 65535 ? Uint32Array : Uint16Array;
  indexBuffer.update(data.indices instanceof IndexType ? data.indices : new IndexType(data.indices || []));
  return geometry;
}

function visualSectionResourceSignature(section) {
  return JSON.stringify({
    points: section?.points,
    width: section?.width,
    repeatDistance: section?.repeatDistance,
    closed: section?.closed !== false,
    textureSrc: section?.textureSrc,
    texturePhaseDistance: section?.texturePhaseDistance,
    textureOffset: section?.textureOffset,
    textureFlip: section?.textureFlip,
    startJoinDir: section?.startJoinDir,
    startCapNormal: section?.startCapNormal,
    endCapNormal: section?.endCapNormal,
    endJoinDir: section?.endJoinDir,
    layerOpacity: section?.layerOpacity,
    hsbc: section?.hsbc
  });
}

function shadowProjectionSignature(projection) {
  return JSON.stringify({
    // Preview-only candidate/component/semantic IDs change when Direct placement
    // promotes the same rendered boundary into accepted authoring. They are not
    // shadow inputs and must not force a visually identical GPU resample.
    visualSections: (projection?.visualSections || []).map((section) => {
      const { sectionId, componentId, semanticWallIds, ...presentation } = section || {};
      return presentation;
    }),
    portalArtwork: projection?.portalArtwork || [],
    placement: projection?.placement || null
  });
}

function sillShadowProjectionSignature(projection) {
  return JSON.stringify({
    sills: projection?.sills || [],
    fillPlacement: projection?.fillPlacement || null
  });
}

function runPreparedCleanupStep(state, key, operation, errors) {
  if (state.completed.has(key)) return;
  try {
    operation();
    state.completed.add(key);
  } catch (error) {
    errors.push(error);
  }
}

function destroyPrepared(prepared, pendingCleanup = null) {
  if (!prepared || prepared.released) return false;
  const state = prepared[PREPARED_CLEANUP_STATE] || { completed: new Set() };
  prepared[PREPARED_CLEANUP_STATE] = state;
  const errors = [];
  const step = (key, operation) => runPreparedCleanupStep(state, key, operation, errors);
  // Until adoption, a reused shadow is still owned by the active prior visual.
  // Failed/stale preparation must never release that shared render target.
  if (prepared.reusedShadow !== true) {
    step('shadow:release', () => prepared.shadowRenderer?.releaseLocalBuildingShadow?.(prepared.shadow));
  } else {
    state.completed.add('shadow:release');
  }
  if (prepared.reusedSillShadow !== true) {
    step('sill-shadow:release', () => prepared.sillShadowRenderer?.releaseLocalBuildingShadow?.(prepared.sillShadow));
  } else {
    state.completed.add('sill-shadow:release');
  }
  step('root:detach', () => prepared.root?.parent?.removeChild?.(prepared.root));
  step('fill-root:detach', () => prepared.fillRoot?.parent?.removeChild?.(prepared.fillRoot));
  step('sill-root:detach', () => prepared.sillRoot?.parent?.removeChild?.(prepared.sillRoot));
  step('centerline:detach', () => prepared.centerline?.parent?.removeChild?.(prepared.centerline));
  step('centerline:destroy', () => prepared.centerline?.destroy?.());
  for (const [index, fill] of (prepared.fills || (prepared.fill ? [prepared.fill] : [])).entries()) {
    step(`fill:${index}:unmask`, () => { fill.sprite.mask = null; });
    step(`fill:${index}:clear-hsbc`, () => clearHsbcFromDisplayObject(fill.sprite, { slot: 'building-v2-fill' }));
    step(`fill:${index}:sprite-detach`, () => fill.sprite?.parent?.removeChild?.(fill.sprite));
    step(`fill:${index}:mask-detach`, () => fill.mask?.parent?.removeChild?.(fill.mask));
    step(`fill:${index}:sprite-destroy`, () => fill.sprite?.destroy?.({ children: false, texture: false, baseTexture: false }));
    step(`fill:${index}:mask-destroy`, () => fill.mask?.destroy?.({ children: true }));
  }
  for (const [index, entry] of (prepared.owned || []).entries()) {
    // A stale preparation may reference a display object still owned and shown
    // by the active prior projection. Adoption clears reusedFrom only after the
    // new projection has activated and taken ownership.
    if (entry.reusedFrom) continue;
    if (entry.ownsDisplayObject !== false) {
      step(`wall:${index}:detach`, () => entry.mesh?.parent?.removeChild?.(entry.mesh));
      step(`wall:${index}:clear-hsbc`, () => clearHsbcFromDisplayObject(entry.mesh, { slot: 'building-v2-wall' }));
      step(`wall:${index}:mesh-destroy`, () => entry.mesh?.destroy?.({ children: false, texture: false, baseTexture: false }));
    }
    if (entry.ownsResources !== false) {
      step(`wall:${index}:geometry-destroy`, () => entry.geometry?.destroy?.());
      step(`wall:${index}:material-destroy`, () => entry.material?.destroy?.(false));
    }
  }
  for (const [index, entry] of (prepared.portalArtwork || []).entries()) {
    step(`portal:${index}:clear-hsbc`, () => clearHsbcFromDisplayObject(entry.sprite, { slot: 'building-v2-portal-artwork' }));
    step(`portal:${index}:detach`, () => entry.sprite?.parent?.removeChild?.(entry.sprite));
    step(`portal:${index}:sprite-destroy`, () => entry.sprite?.destroy?.({ children: false, texture: false, baseTexture: false }));
    if (entry.ownsTexture) {
      step(`portal:${index}:texture-destroy`, () => entry.texture?.destroy?.(false));
    }
  }
  for (const [index, entry] of (prepared.sills || []).entries()) {
    step(`sill:${index}:clear-hsbc`, () => clearHsbcFromDisplayObject(entry.sprite, { slot: 'building-v2-sill' }));
    step(`sill:${index}:detach`, () => entry.sprite?.parent?.removeChild?.(entry.sprite));
    step(`sill:${index}:sprite-destroy`, () => entry.sprite?.destroy?.({ children: false, texture: false, baseTexture: false }));
  }
  for (const [index, lease] of (prepared.repeatTextureLeases || []).entries()) {
    step(`repeat-texture:${index}:release`, () => lease.release?.());
  }
  step('root:destroy', () => prepared.root?.destroy?.({ children: false, texture: false, baseTexture: false }));
  step('fill-root:destroy', () => prepared.fillRoot?.destroy?.({ children: false, texture: false, baseTexture: false }));
  step('sill-root:destroy', () => prepared.sillRoot?.destroy?.({ children: false, texture: false, baseTexture: false }));
  if (errors.length) {
    pendingCleanup?.add(prepared);
    throw new AggregateError(errors, 'Building V2 local visual cleanup failed.');
  }
  pendingCleanup?.delete(prepared);
  prepared.released = true;
  return true;
}

export function createBuildingV2LocalVisualHost({
  getCanvas = () => globalThis.canvas,
  pixi = () => globalThis.PIXI,
  textureLoader = loadTexture,
  samplerTextureFactory = createOwnedSamplerTexture,
  mesher = BuildingWallMesher,
  resolveOrdering = resolvePreviewTileRenderOrdering,
  getShadowRenderer = async () => {
    const { getAssetShadowManager } = await import('../../assets/asset-shadow-manager.js');
    return getAssetShadowManager();
  }
} = {}) {
  const textureEntries = new Map();
  const repeatTextureEntries = new Map();
  const pendingCleanup = new Set();
  const fillMaskRuntime = createBuildingV2FillMaskRuntime();
  let shadowRendererPromise = null;
  let resolvedShadowRenderer = null;
  let shadowElevationPreviewRevision = 0;
  let shadowElevationPreview = null;
  const shadowElevationPreviewOwner = Object.freeze(Object.create(null));
  const resolveShadowRenderer = async () => {
    shadowRendererPromise ??= Promise.resolve(getShadowRenderer()).then((renderer) => {
      resolvedShadowRenderer = renderer;
      return renderer;
    }).catch((error) => {
      shadowRendererPromise = null;
      throw error;
    });
    return shadowRendererPromise;
  };
  const getTextureEntry = (src) => {
    if (!textureEntries.has(src)) {
      textureEntries.set(src, Promise.resolve(textureLoader(src)).then((texture) => {
        return { texture, visibleData: inspectBuildingV2WallTextureRows(texture) };
      }).catch((error) => {
        textureEntries.delete(src);
        throw error;
      }));
    }
    return textureEntries.get(src);
  };
  const acquireRepeatTextureEntry = async (src) => {
    let record = repeatTextureEntries.get(src);
    if (!record) {
      record = { references: 0, owner: null, promise: null };
      record.promise = getTextureEntry(src).then((sourceEntry) => {
        const PIXI = pixi();
        const owner = samplerTextureFactory(sourceEntry.texture, {
          pixi: PIXI,
          wrapMode: PIXI.WRAP_MODES.REPEAT,
          mipmap: PIXI.MIPMAP_MODES.OFF
        });
        record.owner = owner;
        return { texture: owner.texture, visibleData: sourceEntry.visibleData };
      }).catch((error) => {
        if (repeatTextureEntries.get(src) === record) repeatTextureEntries.delete(src);
        throw error;
      });
      repeatTextureEntries.set(src, record);
    }
    record.references += 1;
    let entry;
    try {
      entry = await record.promise;
    } catch (error) {
      record.references -= 1;
      throw error;
    }
    let released = false;
    return {
      ...entry,
      release() {
        if (released) return false;
        released = true;
        record.references -= 1;
        if (record.references === 0) {
          if (repeatTextureEntries.get(src) === record) repeatTextureEntries.delete(src);
          record.owner?.release?.();
        }
        return true;
      }
    };
  };
  return Object.freeze({
    async getShadowElevationSettings(elevation) {
      const renderer = await resolveShadowRenderer();
      if (typeof renderer?.getElevationSettings !== 'function') {
        throw new Error('Building V2 exact preview requires canonical elevation shadow settings.');
      }
      return renderer.getElevationSettings(Number(elevation), { ignorePreview: true });
    },

    async replaceShadowElevationPreview(elevation, settings = {}) {
      const targetElevation = Number(elevation);
      if (!Number.isFinite(targetElevation)) {
        throw new TypeError('Building V2 elevation shadow preview requires a finite elevation.');
      }
      const revision = ++shadowElevationPreviewRevision;
      const renderer = await resolveShadowRenderer();
      if (revision !== shadowElevationPreviewRevision) return false;
      if (typeof renderer?.setElevationPreviewShadowOverride !== 'function'
        || typeof renderer?.clearElevationPreviewShadowOverride !== 'function') {
        throw new Error('Building V2 exact preview requires canonical client-local elevation shadow overrides.');
      }
      if (shadowElevationPreview != null && shadowElevationPreview !== targetElevation) {
        renderer.clearElevationPreviewShadowOverride(shadowElevationPreview, {
          immediate: true,
          owner: shadowElevationPreviewOwner
        });
      }
      const applied = renderer.setElevationPreviewShadowOverride(targetElevation, {
        alpha: settings?.alpha,
        blur: settings?.blur
      }, { immediate: true, owner: shadowElevationPreviewOwner });
      if (applied) shadowElevationPreview = targetElevation;
      return applied;
    },

    clearShadowElevationPreview() {
      shadowElevationPreviewRevision += 1;
      const targetElevation = shadowElevationPreview;
      shadowElevationPreview = null;
      if (targetElevation == null || !resolvedShadowRenderer) return false;
      return resolvedShadowRenderer.clearElevationPreviewShadowOverride(targetElevation, {
        immediate: true,
        owner: shadowElevationPreviewOwner
      });
    },

    probe({ sceneId } = {}) {
      const canvas = getCanvas();
      const PIXI = pixi();
      if (String(canvas?.scene?.id || '') !== String(sceneId || '')) {
        throw new Error('Building V2 visual host requires the active Scene Canvas.');
      }
      if (canvas?.ready !== true) {
        throw new Error('Building V2 visual host requires a ready Foundry Canvas.');
      }
      if (!canvas?.primary?.addChild || !PIXI?.Container || !PIXI?.Graphics || !PIXI?.Mesh
        || !PIXI?.MeshMaterial || !PIXI?.TilingSprite) {
        throw new Error('Building V2 visual host requires Foundry v14 canvas.primary and PixiJS 7 Graphics, mesh, and TilingSprite APIs.');
      }
      return true;
    },

    async prepare(projection, { isCurrent = () => true, reusableVisual = null } = {}) {
      requireProjection(projection);
      this.probe({ sceneId: projection.sceneId });
      const PIXI = pixi();
      const textures = new Map();
      const repeatTextures = new Map();
      const repeatTextureLeases = [];
      const sillParts = normalizeSillPreviewParts(projection.sills || []);
      try {
        for (const section of projection.visualSections) {
          const src = String(section?.textureSrc || '').trim();
          if (!src) throw new Error('Building V2 visual section is missing its exact Wall texture source.');
          if (!repeatTextures.has(src)) {
            const lease = await acquireRepeatTextureEntry(src);
            repeatTextures.set(src, lease);
            repeatTextureLeases.push(lease);
          }
        }
        for (const portal of projection.portalArtwork || []) {
          for (const artwork of portal?.artwork || []) {
            const src = String(artwork?.textureSrc || '').trim();
            if (!src) throw new Error('Building V2 Portal artwork is missing its exact texture source.');
            if (!textures.has(src)) textures.set(src, await getTextureEntry(src));
          }
        }
        for (const part of sillParts) {
          if (!textures.has(part.textureSrc)) textures.set(part.textureSrc, await getTextureEntry(part.textureSrc));
        }
        const fillIntents = projection.fillProjection?.active === true
          ? projection.fillProjection.maskSource?.version === 2
            ? projection.fillProjection.maskSource.regions.filter((region) => region.active)
            : [projection.fillProjection]
          : [];
        for (const intent of fillIntents) {
          const src = String(intent.asset?.src || '').trim();
          if (!src) throw new Error('Building V2 active Fill projection is missing its exact texture source.');
          if (!repeatTextures.has(src)) {
            const lease = await acquireRepeatTextureEntry(src);
            repeatTextures.set(src, lease);
            repeatTextureLeases.push(lease);
          }
        }
      } catch (error) {
        for (const lease of repeatTextureLeases) lease.release();
        throw error;
      }
      if (!isCurrent()) {
        for (const lease of repeatTextureLeases) lease.release();
        return { root: null, fillRoot: null, sillRoot: null, owned: [], sills: [], projection, released: true, mounted: false, stale: true };
      }
      const root = new PIXI.Container();
      root.name = ROOT_NAME;
      root.eventMode = 'none';
      root.interactiveChildren = false;
      root.sortableChildren = true;
      root.faNexusBuildingV2ProjectionId = projection.projectionId;
      root.faNexusBuildingV2RequestGeneration = projection.requestGeneration;
      // Preview artwork is the prospective committed artwork. Do not dim it with
      // a preview-only parent alpha; authored texture transparency still applies.
      root.alpha = 1;
      const fillRoot = new PIXI.Container();
      fillRoot.name = FILL_ROOT_NAME;
      fillRoot.eventMode = 'none';
      fillRoot.interactiveChildren = false;
      fillRoot.sortableChildren = true;
      fillRoot.faNexusBuildingV2ProjectionId = projection.projectionId;
      fillRoot.faNexusBuildingV2RequestGeneration = projection.requestGeneration;
      fillRoot.alpha = 1;
      const sillRoot = new PIXI.Container();
      sillRoot.name = SILLS_ROOT_NAME;
      sillRoot.eventMode = 'none';
      sillRoot.interactiveChildren = false;
      sillRoot.sortableChildren = true;
      sillRoot.faNexusBuildingV2ProjectionId = projection.projectionId;
      sillRoot.faNexusBuildingV2RequestGeneration = projection.requestGeneration;
      sillRoot.alpha = 1;
      const owned = [];
      const prepared = {
        root,
        fillRoot,
        sillRoot,
        centerline: null,
        fill: null,
        shadow: null,
        shadowRenderer: null,
        sillShadow: null,
        sillShadowRenderer: null,
        owned,
        projection,
        released: false,
        mounted: false,
        materializationReceipt: null,
        reusedSectionCount: 0,
        reusedShadow: false,
        reusedSillShadow: false
      };
      prepared.repeatTextureLeases = repeatTextureLeases;
      prepared.portalArtwork = [];
      prepared.sills = [];
      try {
        if (projection.nativeFragments?.length) {
          const centerline = new PIXI.Graphics();
          centerline.name = CENTERLINE_NAME;
          centerline.eventMode = 'none';
          centerline.interactiveChildren = false;
          centerline.zIndex = -1;
          centerline.lineStyle({ width: 1.5, color: 0x00a8ff, alpha: 0.9, alignment: 0.5 });
          for (const fragment of projection.nativeFragments) {
            if (fragment.portalId) continue;
            const ax = Number(fragment?.a?.x);
            const ay = Number(fragment?.a?.y);
            const bx = Number(fragment?.b?.x);
            const by = Number(fragment?.b?.y);
            if (![ax, ay, bx, by].every(Number.isFinite)) continue;
            centerline.moveTo(ax, ay);
            centerline.lineTo(bx, by);
          }
          prepared.centerline = centerline;
          root.addChild(centerline);
        }
        const materializedSections = projection.visualSections.map((section) => {
          const textureEntry = repeatTextures.get(section.textureSrc);
          const texture = textureEntry.texture;
          const metrics = resolveBuildingV2WallTextureMetrics(section, texture, textureEntry.visibleData);
          return { ...section, width: metrics.width, repeatDistance: metrics.repeatDistance };
        });
        const hasPortalShadow = (projection.portalArtwork || []).some((portal) => (
          portal?.shadow?.enabled !== false && Number(portal?.shadow?.alpha) > 0.001 && portal?.artwork?.length
        ));
        const hasSillShadow = sillParts.some((part) => (
          part.source?.shadow?.enabled !== false && Number(part.source?.shadow?.alpha) > 0.001
        ));
        if (materializedSections.some(hasRenderablePathShadow) || hasPortalShadow) {
          const shadowRenderer = await resolveShadowRenderer();
          if (
            !shadowRenderer
            || typeof shadowRenderer.prepareLocalBuildingShadow !== 'function'
            || typeof shadowRenderer.syncLocalBuildingShadowOrdering !== 'function'
            || typeof shadowRenderer.releaseLocalBuildingShadow !== 'function'
          ) {
            throw new Error('Building V2 exact preview requires the canonical public Building shadow renderer.');
          }
          const renderOrder = resolveOrdering(
            projection.placement.previewSort ?? projection.placement.sort,
            projection.placement.elevation,
            {
              fallbackZIndex: projection.placement.previewSort ?? projection.placement.sort,
              placementLevelId: projection.placement.placementLevelId
            }
          );
          prepared.shadowRenderer = shadowRenderer;
          const reusableShadow = projection.reuseShadow === true
            && reusableVisual?.shadow
            && reusableVisual.shadow.released !== true
            && shadowProjectionSignature(projection) === shadowProjectionSignature(reusableVisual.projection);
          if (reusableShadow) {
            prepared.shadow = reusableVisual.shadow;
            prepared.reusedShadow = true;
          } else {
            prepared.shadow = await shadowRenderer.prepareLocalBuildingShadow({
              projectionId: projection.projectionId,
              requestGeneration: projection.requestGeneration,
              sections: materializedSections,
              portalArtwork: projection.portalArtwork || [],
              placement: projection.placement,
              renderOrder,
              // Continuous and exact projections intentionally use one quality
              // profile. A release that accepts unchanged preview geometry must
              // never change the shadow's sampling or blur appearance.
              maxPixelCount: null
            });
          }
        }
        if (hasSillShadow) {
          const shadowRenderer = await resolveShadowRenderer();
          if (
            !shadowRenderer
            || typeof shadowRenderer.prepareLocalBuildingShadow !== 'function'
            || typeof shadowRenderer.syncLocalBuildingShadowOrdering !== 'function'
            || typeof shadowRenderer.releaseLocalBuildingShadow !== 'function'
          ) {
            throw new Error('Building V2 exact sill preview requires the canonical public Building shadow renderer.');
          }
          const sillPlacement = {
            ...projection.fillPlacement,
            elevation: sillParts[0].elevation,
            sort: sillParts[0].sort,
            previewSort: sillParts[0].sort
          };
          const renderOrder = resolveOrdering(sillPlacement.sort, sillPlacement.elevation, {
            fallbackZIndex: sillPlacement.sort,
            placementLevelId: sillPlacement.placementLevelId
          });
          prepared.sillShadowRenderer = shadowRenderer;
          const reusableSillShadow = projection.reuseShadow === true
            && reusableVisual?.sillShadow
            && reusableVisual.sillShadow.released !== true
            && sillShadowProjectionSignature(projection) === sillShadowProjectionSignature(reusableVisual.projection);
          if (reusableSillShadow) {
            prepared.sillShadow = reusableVisual.sillShadow;
            prepared.reusedSillShadow = true;
          } else {
            prepared.sillShadow = await shadowRenderer.prepareLocalBuildingShadow({
              projectionId: projection.projectionId,
              requestGeneration: projection.requestGeneration,
              sections: [],
              portalArtwork: [],
              sills: projection.sills || [],
              placement: sillPlacement,
              renderOrder,
              maxPixelCount: null
            });
          }
        }
        const wallEnvelopes = [];
        const reusableEntries = reusableVisual?.owned || [];
        const reusableBySectionId = new Map(reusableEntries.map((entry) => [entry.sectionId, entry]));
        const claimedReusableEntries = new Set();
        const exactPromotion = projection.continuousGesture !== true
          && reusableVisual?.projection?.continuousGesture === true;
        for (const [sectionIndex, section] of materializedSections.entries()) {
          const textureEntry = repeatTextures.get(section.textureSrc);
          const texture = textureEntry.texture;
          const resourceSignature = visualSectionResourceSignature(section);
          let reusable = reusableBySectionId.get(section.sectionId);
          if (claimedReusableEntries.has(reusable)) reusable = null;
          if ((!reusable || reusable.resourceSignature !== resourceSignature) && exactPromotion) {
            reusable = reusableEntries.find((entry) => (
              !claimedReusableEntries.has(entry)
              && entry.resourceSignature === resourceSignature
            )) || reusable;
          }
          if (reusable) claimedReusableEntries.add(reusable);
          const canReuse = !!reusable
            && reusable.ownsResources !== false
            && reusable.resourceSignature === resourceSignature
            && reusable.geometry?.destroyed !== true
            && reusable.material?.destroyed !== true;
          const canUpdate = !canReuse
            && (projection.continuousGesture === true || reusableVisual?.projection?.continuousGesture === true)
            && !!reusable
            && reusable.ownsResources !== false
            && reusable.geometry?.destroyed !== true
            && reusable.material?.destroyed !== true
            && reusable.texture === texture
            && typeof reusable.geometry?.getBuffer === 'function'
            && typeof reusable.geometry?.getIndex === 'function'
            && typeof mesher.buildCenterline === 'function';
          let geometry;
          let material;
          let mesh;
          let wallEnvelope;
          let pendingGeometryData = null;
          if (canReuse) {
            geometry = reusable.geometry;
            material = reusable.material;
            wallEnvelope = reusable.renderEnvelope || null;
          } else if (canUpdate) {
            pendingGeometryData = mesher.buildCenterline(section.points, {
              width: section.width,
              closed: section.closed !== false,
              joinStyle: 'mitre',
              mitreLimit: 4,
              textureRepeatDistance: section.repeatDistance,
              texturePhaseDistance: section.texturePhaseDistance,
              textureOffset: section.textureOffset,
              textureFlip: section.textureFlip,
              startJoinDir: section.startJoinDir,
              startCapNormal: section.startCapNormal,
              endCapNormal: section.endCapNormal,
              endJoinDir: section.endJoinDir
            });
            if (!pendingGeometryData?.positions?.length) {
              throw new Error(`Building V2 visual compiler produced empty continuous Wall data: ${section.sectionId}.`);
            }
            remapVisibleRowsData(pendingGeometryData, textureEntry.visibleData);
            geometry = reusable.geometry;
            material = reusable.material;
            wallEnvelope = boundsFromPositions(pendingGeometryData.positions);
          } else {
            const result = mesher.buildGeometry(section.points, {
              width: section.width,
              closed: section.closed !== false,
              joinStyle: 'mitre',
              mitreLimit: 4,
              textureRepeatDistance: section.repeatDistance,
              texturePhaseDistance: section.texturePhaseDistance,
              textureOffset: section.textureOffset,
              textureFlip: section.textureFlip,
              startJoinDir: section.startJoinDir,
              startCapNormal: section.startCapNormal,
              endCapNormal: section.endCapNormal,
              endJoinDir: section.endJoinDir
            });
            if (!result?.geometry || !result?.data?.positions?.length) {
              throw new Error(`Building V2 visual compiler produced an empty Wall section: ${section.sectionId}.`);
            }
            geometry = result.geometry;
            wallEnvelope = boundsFromPositions(result.data.positions);
            remapVisibleRows(geometry, textureEntry.visibleData);
            material = new PIXI.MeshMaterial(texture);
            material.alpha = 1;
            if (material.uvMatrix) {
              material.uvMatrix.isSimple = false;
              material.uvMatrix.clampOffset = false;
              material.uvMatrix.clampMargin = -0.5;
              material.uvMatrix.update?.();
            }
          }
          if (wallEnvelope) {
            wallEnvelopes.push(wallEnvelope);
            section.renderEnvelope = wallEnvelope;
          }
          if (canReuse || canUpdate) {
            mesh = reusable.mesh;
            mesh.name = `fa-nexus-building-v2-wall-${section.sectionId}`;
          } else {
            mesh = new PIXI.Mesh(geometry, material);
            mesh.name = `fa-nexus-building-v2-wall-${section.sectionId}`;
            mesh.eventMode = 'none';
            mesh.interactiveChildren = false;
            mesh.zIndex = 0;
            mesh.alpha = Math.min(1, Math.max(0, Number(section?.layerOpacity ?? 1)));
            applyHsbcToDisplayObject(mesh, section?.hsbc || null, { slot: 'building-v2-wall' });
            try {
              mesh.state = mesh.state || {};
              if (PIXI.BLEND_MODES?.NORMAL !== undefined) mesh.state.blendMode = PIXI.BLEND_MODES.NORMAL;
            } catch (_) {}
            root.addChild(mesh);
          }
          // Section order is semantic render order: Inner sections precede
          // Outer sections, and later Inner stacking will use the same list.
          // A partial appearance generation may reuse an earlier mesh while
          // rebuilding another; assign the current ordinal explicitly so
          // reuse timing cannot become an accidental Pixi stacking authority.
          mesh.zIndex = sectionIndex;
          owned.push({
            sectionId: section.sectionId,
            mesh,
            geometry,
            material,
            texture,
            resourceSignature,
            renderEnvelope: wallEnvelope,
            ownsDisplayObject: !(canReuse || canUpdate),
            ownsResources: !(canReuse || canUpdate),
            reusedFrom: canReuse || canUpdate ? reusable : null,
            pendingGeometryData
          });
          if (canReuse || canUpdate) prepared.reusedSectionCount += 1;
        }
        const portalEnvelopes = [];
        for (const [portalIndex, portal] of (projection.portalArtwork || []).entries()) {
          for (const artwork of portal?.artwork || []) {
            const textureEntry = textures.get(artwork.textureSrc);
            const baseTexture = textureEntry?.texture?.baseTexture;
            if (!baseTexture?.valid) throw new Error(`Building V2 Portal artwork texture is unavailable: ${artwork.textureSrc}`);
            let texture = textureEntry.texture;
            let ownsTexture = false;
            if (artwork.sourceFrame) {
              const frame = artwork.sourceFrame;
              texture = new PIXI.Texture(baseTexture, new PIXI.Rectangle(
                Number(frame.x), Number(frame.y), Number(frame.width), Number(frame.height)
              ));
              ownsTexture = true;
            }
            const sprite = new PIXI.Sprite(texture);
            sprite.name = `fa-nexus-building-v2-portal-artwork:${portal.kind}:${portal.portalId}:${artwork.side || artwork.role}`;
            sprite.faNexusBuildingV2PortalArtwork = {
              kind: portal.kind, portalId: portal.portalId, part: artwork.side || artwork.role
            };
            if (portal.kind === 'door-frame') {
              sprite.faNexusBuildingV2DoorFrame = { portalId: portal.portalId, side: artwork.side };
            }
            sprite.anchor.set(0.5, 0.5);
            sprite.position.set(Number(artwork.x), Number(artwork.y));
            sprite.width = Number(artwork.width);
            sprite.height = Number(artwork.height);
            if (Number(artwork.flipX) < 0) sprite.scale.x *= -1;
            if (Number(artwork.flipY) < 0) sprite.scale.y *= -1;
            sprite.rotation = Number(artwork.rotation);
            sprite.eventMode = 'none';
            sprite.zIndex = materializedSections.length + portalIndex + 1;
            applyHsbcToDisplayObject(sprite, artwork.hsbc || null, { slot: 'building-v2-portal-artwork' });
            root.addChild(sprite);
            prepared.portalArtwork.push({
              sprite, texture, ownsTexture, kind: portal.kind,
              portalId: portal.portalId, part: artwork.side || artwork.role
            });
          }
          if (portal?.bounds) portalEnvelopes.push(portal.bounds);
        }
        const sillEnvelopes = [];
        if (sillParts.length && !PIXI?.Sprite) {
          throw new Error('Building V2 Window sill preview requires the PixiJS 7 Sprite API.');
        }
        for (const [sillIndex, part] of sillParts.entries()) {
          const texture = textures.get(part.textureSrc)?.texture;
          if (!texture?.baseTexture || texture.baseTexture.valid === false) {
            throw new Error(`Building V2 Window sill preview texture is unavailable: ${part.textureSrc}`);
          }
          const sprite = new PIXI.Sprite(texture);
          sprite.name = `fa-nexus-building-v2-window-sill:${part.id}`;
          sprite.faNexusBuildingV2WindowSill = { id: part.id, gapId: part.source?.gapId || null };
          sprite.anchor.set(part.anchorX, part.anchorY);
          sprite.position.set(part.x, part.y);
          sprite.width = part.width;
          sprite.height = part.height;
          sprite.rotation = part.rotationDegrees * (Math.PI / 180);
          sprite.alpha = part.alpha;
          sprite.eventMode = 'none';
          sprite.zIndex = sillIndex;
          applyHsbcToDisplayObject(sprite, part.source?.hsbc ?? part.source?.flags?.hsbc ?? null, {
            slot: 'building-v2-sill'
          });
          sillRoot.addChild(sprite);
          const renderEnvelope = boundsFromCenteredRectangle(part);
          sillEnvelopes.push(renderEnvelope);
          prepared.sills.push({
            id: part.id,
            sprite,
            texture,
            renderEnvelope,
            elevation: part.elevation,
            sort: part.sort
          });
        }
        // Managed Window Sills are a separately materialized Tile and preview
        // layer. Their bounds must not resize the Root/Fill render frame: doing
        // so would make a sill-only appearance edit change the Building pose.
        let renderEnvelope = mergeRenderEnvelopes([...wallEnvelopes, ...portalEnvelopes]);
        let fillRegionEnvelopes = [];
        if (projection.fillProjection?.active === true) {
          const materialization = fillMaskRuntime.materialize(projection.fillProjection.maskSource, {
            sceneGridSize: Number(
              projection.fillProjection.maskSceneGridSize
              ?? projection.fillProjection.sceneGridSize
            )
          });
          const maskSpatialTransform = projection.fillProjection.maskSpatialPose
            ? createBuildingV2SpatialTransform(projection.fillProjection.maskSpatialPose) : null;
          fillRegionEnvelopes = measureBuildingV2FillMaskRegions(materialization, { transform: maskSpatialTransform });
          // Openings remove Wall artwork, never Fill. Size the sprite and ready
          // Commit bounds from the actual materialized masks as well as Walls.
          renderEnvelope = mergeRenderEnvelopes([renderEnvelope, ...fillRegionEnvelopes.map((region) => region.renderEnvelope)]);
          if (!renderEnvelope) throw new Error('Building V2 active Fill preview requires a materialized Render Envelope.');
          prepared.fills = [];
          const regionMaterializations = materialization.version === 2
            ? materialization.regions.filter((region) => region.active)
            : [{ ...projection.fillProjection, materialization }];
          for (const region of regionMaterializations) {
            const fillTextureSrc = String(region.asset?.src || '').trim();
            const materializedShapes = region.materialization.shapes.map((shape) => ({
              ...shape,
              vertices: maskSpatialTransform
                ? shape.vertices.map((point) => maskSpatialTransform.localToWorld(point))
                : shape.vertices
            }));
            const padding = Math.max(0, Number(projection.fillProjection.presentationPadding) || 0);
            const frame = {
              minX: Number(renderEnvelope.minX) - padding,
              minY: Number(renderEnvelope.minY) - padding,
              maxX: Number(renderEnvelope.maxX) + padding,
              maxY: Number(renderEnvelope.maxY) + padding
            };
            const texture = repeatTextures.get(fillTextureSrc)?.texture;
            if (!texture?.baseTexture || texture.baseTexture.valid === false) {
              throw new Error(`Building V2 Fill texture is unavailable: ${fillTextureSrc}`);
            }
            const sprite = new PIXI.TilingSprite(
              texture,
              Math.max(1, frame.maxX - frame.minX),
              Math.max(1, frame.maxY - frame.minY)
            );
            const preparedRegion = { sprite, mask: null, materialization: region.materialization, renderEnvelope: frame };
            prepared.fills.push(preparedRegion);
            sprite.name = 'fa-nexus-building-v2-fill';
            sprite.eventMode = 'none';
            sprite.position.set(frame.minX, frame.minY);
            const fillAppearance = normalizeBuildingV2FillAppearance(region.appearance);
            const repeatScale = resolveMaskedTilingBaseGridScale(
              Number(projection.fillProjection.sceneGridSize)
            ) * (fillAppearance.scalePercent / 100);
            sprite.tileScale.set(repeatScale * (projection.fillProjection.maskSpatialPose?.flipX ? -1 : 1), repeatScale * (projection.fillProjection.maskSpatialPose?.flipY ? -1 : 1));
            const buildingRotation = Number(projection.fillProjection.maskSpatialPose?.rotation || 0);
            sprite.tileTransform.rotation = (buildingRotation + ((!!projection.fillProjection.maskSpatialPose?.flipX !== !!projection.fillProjection.maskSpatialPose?.flipY) ? -fillAppearance.rotationDegrees : fillAppearance.rotationDegrees)) * (Math.PI / 180);
            const textureOrigin = projection.fillProjection?.textureBasis?.origin || { x: 0, y: 0 };
            const localOffset = fillAppearance.offset;
            let worldOffset = { x: Number(localOffset.x), y: Number(localOffset.y) };
            if (maskSpatialTransform) {
              const originWorld = maskSpatialTransform.localToWorld({ x: 0, y: 0 });
              const offsetWorld = maskSpatialTransform.localToWorld(localOffset);
              worldOffset = { x: offsetWorld.x - originWorld.x, y: offsetWorld.y - originWorld.y };
            }
            sprite.tilePosition.set(
              Number(textureOrigin.x) + worldOffset.x - frame.minX,
              Number(textureOrigin.y) + worldOffset.y - frame.minY
            );
            sprite.alpha = fillAppearance.opacity;
            applyHsbcToDisplayObject(sprite, fillAppearance.hsbc, { slot: 'building-v2-fill' });
            const mask = new PIXI.Graphics();
            preparedRegion.mask = mask;
            mask.name = 'fa-nexus-building-v2-fill-mask';
            mask.eventMode = 'none';
            for (const group of groupBuildingV2FillMaskShapesForPixi(materializedShapes)) {
              mask.beginFill(0xffffff, 1);
              mask.drawPolygon(group.exterior.vertices.flatMap((point) => [Number(point.x), Number(point.y)]));
              if (group.holes.length) {
                mask.beginHole();
                for (const shape of group.holes) {
                  mask.drawPolygon(shape.vertices.flatMap((point) => [Number(point.x), Number(point.y)]));
                }
                mask.endHole();
              }
              mask.endFill();
            }
            sprite.mask = mask;
            fillRoot.addChild(sprite);
            fillRoot.addChild(mask);
          }
          prepared.fill = prepared.fills.length ? { ...prepared.fills[0], materialization } : null;
        }
        prepared.materializationReceipt = Object.freeze({
          projectionId: projection.projectionId,
          requestGeneration: projection.requestGeneration,
          visualSections: Object.freeze(materializedSections.map((section) => Object.freeze({
            sectionId: section.sectionId,
            width: section.width,
            repeatDistance: section.repeatDistance,
            renderEnvelope: section.renderEnvelope || null
          }))),
          // The Root Tile is the native selection surface for committed artwork.
          // Shadow blur/filter allocation may extend far beyond that artwork and
          // must not inflate the selectable Building bounds.
          renderEnvelope,
          ...(prepared.sills.length ? {
            sills: Object.freeze(prepared.sills.map((part) => Object.freeze({
              id: part.id,
              elevation: part.elevation,
              sort: part.sort,
              renderEnvelope: Object.freeze({ ...part.renderEnvelope })
            })))
          } : {}),
          fill: prepared.fill ? Object.freeze({
            sourceFingerprint: prepared.fill.materialization.sourceFingerprint,
            cacheKey: prepared.fill.materialization.cacheKey,
            regionRenderEnvelopes: Object.freeze(fillRegionEnvelopes.map((region) => Object.freeze({
              regionId: region.regionId, renderEnvelope: Object.freeze({ ...region.renderEnvelope })
            }))),
            renderEnvelope: Object.freeze({ ...prepared.fill.renderEnvelope })
          }) : null
        });
      } catch (error) {
        try {
          destroyPrepared(prepared, pendingCleanup);
        } catch (cleanupError) {
          const cleanupErrors = cleanupError instanceof AggregateError
            ? Array.from(cleanupError.errors || [])
            : [cleanupError];
          throw new AggregateError(
            [error, ...cleanupErrors],
            'Building V2 local visual preparation and cleanup both failed.'
          );
        }
        throw error;
      }
      return prepared;
    },

    activate(prepared) {
      if (!prepared || prepared.released) throw new Error('Building V2 visual host cannot activate a released projection.');
      const canvas = getCanvas();
      for (const entry of prepared.owned || []) {
        if (!entry.pendingGeometryData) continue;
        updateGeometryFromCenterline(entry.geometry, entry.pendingGeometryData);
        entry.pendingGeometryData = null;
      }
      for (const entry of prepared.owned || []) {
        if (entry.reusedFrom) prepared.root.addChild(entry.mesh);
      }
      prepared.root.sortChildren?.();
      const activeKind = String(prepared.projection.activePlacementPreviewKind || 'building-fill-preview');
      const applyPlacement = (root, placement, kind) => {
        const ordering = resolveOrdering(placement.previewSort ?? placement.sort, placement.elevation, {
          fallbackZIndex: placement.previewSort ?? placement.sort,
          placementLevelId: placement.placementLevelId
        });
        Object.assign(root, {
          faNexusPreviewActive: activeKind === kind,
          faNexusPreviewHasContent: root.children.length > 0,
          faNexusBuildingPreviewKey: prepared.projection.projectionId,
          faNexusElevationDoc: placement.elevation,
          faNexusElevation: ordering.renderElevation,
          faNexusBandKind: ordering.kind,
          elevation: ordering.renderElevation,
          faNexusSort: ordering.sort,
          faNexusPlacementSort: placement.sort,
          faNexusPreviewSort: placement.previewSort ?? placement.sort,
          sort: ordering.sort,
          zIndex: ordering.zIndex,
          sortLayer: ordering.sortLayer,
          faNexusRenderElevation: ordering.renderElevation,
          faNexusRenderOrderKind: ordering.kind,
          faNexusPlacementLevelId: ordering.placementLevelId,
          faNexusPlacementAnchorTileId: placement.anchorTileId,
          faNexusSortBeforeAnchor: placement.sortBefore === true
        });
      };
      applyPlacement(prepared.root, prepared.projection.placement, 'building-preview');
      applyPlacement(prepared.fillRoot, prepared.projection.fillPlacement, 'building-fill-preview');
      if (prepared.sills.length) {
        const sillPlacement = {
          ...prepared.projection.fillPlacement,
          elevation: prepared.sills[0].elevation,
          sort: prepared.sills[0].sort,
          previewSort: prepared.sills[0].sort,
          ...prepared.projection.sillsPlacement
        };
        applyPlacement(prepared.sillRoot, sillPlacement, 'building-sills-preview');
      }
      const shadowRoot = prepared.shadow?.root || null;
      if (shadowRoot) {
        shadowRoot.faNexusBuildingV2RequestGeneration = prepared.projection.requestGeneration;
        if (shadowRoot.children?.[0]) {
          shadowRoot.children[0].faNexusBuildingV2RequestGeneration = prepared.projection.requestGeneration;
        }
        const wallOrdering = resolveOrdering(
          prepared.projection.placement.previewSort ?? prepared.projection.placement.sort,
          prepared.projection.placement.elevation,
          {
            fallbackZIndex: prepared.projection.placement.previewSort ?? prepared.projection.placement.sort,
            placementLevelId: prepared.projection.placement.placementLevelId
          }
        );
        prepared.shadowRenderer.syncLocalBuildingShadowOrdering(prepared.shadow, {
          placement: prepared.projection.placement,
          renderOrder: wallOrdering
        });
        const parent = prepared.shadow?.parent || canvas.primary;
        parent.addChild(shadowRoot);
      }
      const sillShadowRoot = prepared.sillShadow?.root || null;
      if (sillShadowRoot) {
        sillShadowRoot.faNexusBuildingV2RequestGeneration = prepared.projection.requestGeneration;
        if (sillShadowRoot.children?.[0]) {
          sillShadowRoot.children[0].faNexusBuildingV2RequestGeneration = prepared.projection.requestGeneration;
        }
        const sillPlacement = {
          ...prepared.projection.fillPlacement,
          elevation: prepared.sills[0].elevation,
          sort: prepared.sills[0].sort,
          previewSort: prepared.sills[0].sort
        };
        const sillOrdering = resolveOrdering(sillPlacement.sort, sillPlacement.elevation, {
          fallbackZIndex: sillPlacement.sort,
          placementLevelId: sillPlacement.placementLevelId
        });
        prepared.sillShadowRenderer.syncLocalBuildingShadowOrdering(prepared.sillShadow, {
          placement: sillPlacement,
          renderOrder: sillOrdering
        });
        const parent = prepared.sillShadow?.parent || canvas.primary;
        parent.addChild(sillShadowRoot);
      }
      canvas.primary.addChild(prepared.root);
      canvas.primary.addChild(prepared.fillRoot);
      if (prepared.sills.length) canvas.primary.addChild(prepared.sillRoot);
      canvas.primary.sortChildren?.();
      prepared.mounted = true;
      return prepared;
    },

    adoptReusableSections(prepared, prior) {
      if (!prepared || prepared.released || !prior || prior.released) return false;
      let adoptedShadow = false;
      let adoptedSillShadow = false;
      for (const entry of prepared.owned || []) {
        const source = entry.reusedFrom;
        if (!source) continue;
        if (source.ownsResources === false || source.geometry !== entry.geometry || source.material !== entry.material) {
          throw new Error('Building V2 visual host cannot adopt an unchanged Wall section without its active prior owner.');
        }
        source.ownsResources = false;
        source.ownsDisplayObject = false;
        entry.ownsResources = true;
        entry.ownsDisplayObject = true;
        entry.reusedFrom = null;
      }
      if (prepared.reusedShadow) {
        if (!prior.shadow || prior.shadow !== prepared.shadow || prior.shadow.released === true) {
          throw new Error('Building V2 visual host cannot adopt an unchanged shadow without its active prior owner.');
        }
        prior.shadow = null;
        prior.shadowRenderer = null;
        prepared.reusedShadow = false;
        adoptedShadow = true;
      }
      if (prepared.reusedSillShadow) {
        if (!prior.sillShadow || prior.sillShadow !== prepared.sillShadow || prior.sillShadow.released === true) {
          throw new Error('Building V2 visual host cannot adopt an unchanged sill shadow without its active prior owner.');
        }
        prior.sillShadow = null;
        prior.sillShadowRenderer = null;
        prepared.reusedSillShadow = false;
        adoptedSillShadow = true;
      }
      return prepared.reusedSectionCount > 0 || adoptedShadow || adoptedSillShadow;
    },

    release(prepared) {
      return destroyPrepared(prepared, pendingCleanup);
    },

    releasePending() {
      const errors = [];
      let released = 0;
      for (const prepared of Array.from(pendingCleanup)) {
        try {
          if (destroyPrepared(prepared, pendingCleanup)) released += 1;
          else if (prepared?.released) pendingCleanup.delete(prepared);
        } catch (error) {
          if (error instanceof AggregateError) errors.push(...Array.from(error.errors || []));
          else errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, 'Building V2 local visual pending cleanup failed.');
      }
      return released;
    }
  });
}

export {
  ROOT_NAME as BUILDING_V2_VISUAL_ROOT_NAME,
  FILL_ROOT_NAME as BUILDING_V2_FILL_VISUAL_ROOT_NAME,
  SILLS_ROOT_NAME as BUILDING_V2_SILLS_VISUAL_ROOT_NAME
};
