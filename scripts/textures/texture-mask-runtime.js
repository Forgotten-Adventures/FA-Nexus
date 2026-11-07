import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  applyHsbcToDisplayObject,
  clearHsbcFromDisplayObject,
  readDocumentHsbc
} from '../core/hsbc.js';
import { cloneDisplayObjectForProxy } from '../canvas/display-object-proxy.js';
import {
  attachCustomTileOverhead,
  detachCustomTileOverhead
} from '../canvas/custom-tile-overhead.js';
import { resolveTileId } from '../canvas/tile-targets.js';
import {
  tileUsesLightOrWeatherRestrictions,
  tileUsesSurfaceTileOcclusion,
  tileUsesVisibleTileOcclusion
} from '../canvas/tile-occlusion.js';
import {
  encodeTexturePath,
  ensureMeshTransparent,
  getFlattenedChunkEntries,
  getMaxTextureSize,
  loadTexture,
  prepareCustomTileRendererMesh,
  restoreMeshTexture
} from './texture-runtime-core.js';
import { applyMaskedTextureBlendMode } from './texture-blend-runtime.js';
import {
  createStandardMaskCustomBaseDisplay,
  getStandardMaskCustomBaseKey,
  resolveStandardMaskCustomBaseSources,
  syncStandardMaskCustomSourceSuppression
} from './standard-mask-custom-base.js';
import { buildArcSamplePoints } from './texture-arc-geometry.js';
import {
  applyMaskedTilingRepeatTransform,
  deriveMaskedTilingTransformPreview,
  resolveMaskedTilingBaseGridScale
} from './masked-tiling-resize-contract.js';
import {
  destroyOwnedTextureResources,
  isTextureCleanupFailure
} from './texture-owned-resource-cleanup.js';

const TILE_RETRY_TIMERS = new WeakMap();
const TILE_APPLY_GENERATIONS = new WeakMap();
const PREVIEW_VISIBILITY_STATES = new WeakMap();
let REHYDRATE_STATE = null;

const MASK_TYPE_ARRAY = 'array';
const EDITING_TILE_SET_KEY = '__faNexusTextureEditingTileIds';
const SOLID_COLOR_FULL_RE = /^#([0-9a-f]{6})$/i;
const SOLID_COLOR_SHORT_RE = /^#([0-9a-f]{3})$/i;
const MASKED_TILING_FLAG = 'maskedTiling';
const STANDARD_TILE_MASK_FLAG = 'standardTileMask';
const MASKED_OVERHEAD_KIND = 'masked';
const STANDARD_MASK_OVERHEAD_KIND = 'standard-mask';
const LEGACY_ORIGINAL_TEXTURE_KEY = 'faNexusOriginalTexture';
const MASKED_TILING_ORIGINAL_TEXTURE_KEY = 'faNexusMaskedTilingOriginalTexture';
const STANDARD_TILE_MASK_ORIGINAL_TEXTURE_KEY = 'faNexusStandardMaskOriginalTexture';

function beginTileApply(tile, kind) {
  const generations = TILE_APPLY_GENERATIONS.get(tile) || {};
  const generation = Number(generations[kind] || 0) + 1;
  generations[kind] = generation;
  TILE_APPLY_GENERATIONS.set(tile, generations);
  return Object.freeze({ kind, generation });
}

function isCurrentTileApply(tile, token) {
  return Number(TILE_APPLY_GENERATIONS.get(tile)?.[token?.kind] || 0) === Number(token?.generation || 0);
}

function invalidateTileApply(tile, kind) {
  if (!tile) return;
  const generations = TILE_APPLY_GENERATIONS.get(tile) || {};
  generations[kind] = Number(generations[kind] || 0) + 1;
  TILE_APPLY_GENERATIONS.set(tile, generations);
}

export function cancelTileApplies(tile) {
  if (!tile) return;
  invalidateTileApply(tile, 'masked-tiling');
  invalidateTileApply(tile, 'standard-tile-mask');
}

function suppressPreviewVisibility(tile, token) {
  if (!tile?.isPreview) return null;
  const state = PREVIEW_VISIBILITY_STATES.get(tile) || {
    originalVisible: tile.visible !== false,
    tokens: new Set()
  };
  state.tokens.add(token);
  PREVIEW_VISIBILITY_STATES.set(tile, state);
  try { tile.visible = false; } catch (_) {}
  return token;
}

function releasePreviewVisibility(tile, token) {
  if (!tile || !token) return;
  const state = PREVIEW_VISIBILITY_STATES.get(tile);
  if (!state) return;
  state.tokens.delete(token);
  if (state.tokens.size) return;
  PREVIEW_VISIBILITY_STATES.delete(tile);
  try { tile.visible = state.originalVisible; } catch (_) {}
}

function getEditingTileSet() {
  try {
    const root = globalThis;
    if (!root) return null;
    const existing = root[EDITING_TILE_SET_KEY];
    return existing instanceof Set ? existing : null;
  } catch (_) {
    return null;
  }
}

function isEditingTile(tile) {
  try {
    const set = getEditingTileSet();
    if (!set) return false;
    const id = resolveTileId(tile);
    return !!id && set.has(id);
  } catch (_) {
    return false;
  }
}

function normalizeSolidColor(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const full = SOLID_COLOR_FULL_RE.exec(trimmed);
  if (full) return `#${full[1].toLowerCase()}`;
  const short = SOLID_COLOR_SHORT_RE.exec(trimmed);
  if (short) {
    const [r, g, b] = short[1].split('');
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

function parseSolidColorTint(value) {
  const normalized = normalizeSolidColor(value);
  if (!normalized) return null;
  return Number.parseInt(normalized.slice(1), 16);
}

function getSolidColorTexture() {
  try {
    if (PIXI?.Texture?.WHITE) return PIXI.Texture.WHITE;
  } catch (_) {}
  return PIXI.Texture.EMPTY;
}

export function normalizeOffset(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const round = (n) => Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
  return {
    x: Number.isFinite(x) ? round(x) : 0,
    y: Number.isFinite(y) ? round(y) : 0
  };
}

export function roundValue(value, places = 3) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** Math.max(0, places);
  return Math.round(value * factor) / factor;
}

function getBaseGridScale() {
  try {
    const sceneGridSize = Number(canvas?.scene?.grid?.size || 100) || 100;
    return resolveMaskedTilingBaseGridScale(sceneGridSize);
  } catch (_) {
    return 1;
  }
}

function applyTilingSamplingFix(tiling) {
  try {
    const base = tiling?.texture?.baseTexture;
    if (base) {
      base.wrapMode = PIXI.WRAP_MODES.REPEAT;
      base.mipmap = PIXI.MIPMAP_MODES.OFF;
    }
    const uv = tiling?.uvMatrix;
    if (uv) {
      uv.clampMargin = -0.5;
      uv.update();
    }
  } catch (_) {}
}

function copyProxyTransform(source, target) {
  if (!source || !target) return;
  try { target.position?.copyFrom?.(source.position); } catch (_) {
    try { target.position?.set?.(source.position?.x ?? 0, source.position?.y ?? 0); } catch (_) {}
  }
  try { target.scale?.copyFrom?.(source.scale); } catch (_) {
    try { target.scale?.set?.(source.scale?.x ?? 1, source.scale?.y ?? 1); } catch (_) {}
  }
  try { target.pivot?.copyFrom?.(source.pivot); } catch (_) {}
  try { target.skew?.copyFrom?.(source.skew); } catch (_) {}
  try { target.rotation = source.rotation ?? 0; } catch (_) {}
  try { target.angle = source.angle ?? 0; } catch (_) {}
  try { target.visible = source.visible !== false; } catch (_) {}
  try { target.renderable = source.renderable !== false; } catch (_) {}
  try { target.alpha = Number.isFinite(Number(source.alpha)) ? Number(source.alpha) : 1; } catch (_) {}
  try { target.eventMode = 'none'; } catch (_) {}
}

function createMaskedProxyFactory(container) {
  return () => {
    try {
      const liveContainer = container;
      if (liveContainer?.faNexusCompositeRegions) {
        const proxy = new PIXI.Container();
        copyProxyTransform(liveContainer, proxy);
        for (const region of liveContainer.faNexusCompositeRegions) {
          proxy.addChild(createMaskedProxyFactory(region.container)());
        }
        return proxy;
      }
      const liveMask = liveContainer?.faNexusMaskSprite || null;
      if (!liveContainer || liveContainer.destroyed || !liveMask || liveMask.destroyed) {
        return cloneDisplayObjectForProxy(liveContainer);
      }
      const proxyContainer = new PIXI.Container();
      proxyContainer.eventMode = 'none';
      proxyContainer.sortableChildren = false;
      proxyContainer.interactiveChildren = false;
      copyProxyTransform(liveContainer, proxyContainer);
      const proxyMask = cloneDisplayObjectForProxy(liveMask);
      if (!proxyMask || proxyMask.destroyed) return proxyContainer;
      try { proxyMask.visible = true; } catch (_) {}
      try { proxyMask.renderable = true; } catch (_) {}
      if (liveMask.texture?.baseTexture?.faNexusSingleChannelMask) {
        // One channel has no alpha of its own. Draw white through it, the way
        // the layer draws its texture through it.
        const fill = new PIXI.Sprite(PIXI.Texture.WHITE);
        fill.eventMode = 'none';
        fill.position.copyFrom(proxyMask.position);
        fill.width = proxyMask.width;
        fill.height = proxyMask.height;
        proxyContainer.addChild(fill, proxyMask);
        fill.mask = proxyMask;
        return proxyContainer;
      }
      proxyContainer.addChild(proxyMask);
      return proxyContainer;
    } catch (_) {
      return cloneDisplayObjectForProxy(container);
    }
  };
}

// Names what a masked Tile draws, for the silhouette kept by the overhead
// runtime: this renderer attaches again on every Tile refresh.
function overheadContentKey(doc, maskKey, maskTex, width, height, extra = []) {
  const base = maskTex?.baseTexture;
  const texture = doc?.texture || {};
  return [maskKey, base?.uid, base?.dirtyId, width, height, doc?.rotation, texture.scaleX, texture.scaleY,
    texture.anchorX, texture.anchorY, ...extra].join('|');
}

function shouldUseMaskedTileOverhead(tile) {
  const doc = tile?.document;
  if (!doc) return false;
  return tileUsesLightOrWeatherRestrictions(doc) || tileUsesSurfaceTileOcclusion(doc.occlusion, {
    sourceOcclusion: doc._source?.occlusion
  }) || tileUsesVisibleTileOcclusion(doc.occlusion, {
    sourceOcclusion: doc._source?.occlusion
  });
}

function syncMeshBoundContainerDisplayState(container, mesh, doc) {
  if (!container || container.destroyed) return;
  try { container.visible = mesh?.visible !== false; } catch (_) {}
  try { container.renderable = mesh?.renderable !== false; } catch (_) {}
  const documentAlpha = Number.isFinite(Number(doc?.alpha))
    ? clampValue(Number(doc.alpha), 0, 1)
    : 1;
  // Keep opacity off every parent shared by the artwork and its mask. Parent
  // alpha attenuates the mask as well as the texture and squares the result.
  try { if (mesh && !mesh.destroyed) mesh.alpha = 1; } catch (_) {}
  try { container.alpha = 1; } catch (_) {}
  try {
    const tiling = container.faNexusTilingSprite;
    if (tiling && !tiling.destroyed) tiling.alpha = documentAlpha;
  } catch (_) {}
  try {
    const baseDisplay = container.faNexusBaseDisplayObject;
    if (baseDisplay && !baseDisplay.destroyed) baseDisplay.alpha = documentAlpha;
  } catch (_) {}
  try {
    const mask = container.faNexusMaskSprite;
    if (mask && !mask.destroyed) mask.alpha = 1;
  } catch (_) {}
}

function resolveClonedDisplayReference(sourceRoot, clonedRoot, sourceTarget) {
  if (!sourceRoot || !clonedRoot || !sourceTarget) return null;
  if (sourceTarget === sourceRoot) return clonedRoot;
  const path = [];
  let current = sourceTarget;
  while (current && current !== sourceRoot) {
    const parent = current.parent;
    const index = Array.isArray(parent?.children) ? parent.children.indexOf(current) : -1;
    if (index < 0) return null;
    path.unshift(index);
    current = parent;
  }
  if (current !== sourceRoot) return null;
  return path.reduce((entry, index) => entry?.children?.[index] || null, clonedRoot);
}

function mirrorMaskedPreviewContainer(tile, {
  sourceContainer,
  containerKey,
  readyKey,
  slotKey,
  overheadKind,
  syncTransform,
  logTag
} = {}) {
  try {
    if (!tile?.isPreview || !tile?._original || !sourceContainer || sourceContainer.destroyed) return false;
    const mesh = tile?.mesh;
    if (!mesh || mesh.destroyed) return false;

    ensureMeshTransparent(mesh, slotKey);

    let container = mesh?.[containerKey] || tile?.[containerKey] || null;
    const canReuse = container
      && !container.destroyed
      && container.faNexusPreviewMirror === true
      && container.faNexusPreviewMirrorSource === sourceContainer;

    if (!canReuse) {
      if (tile) detachCustomTileOverhead(tile, { kind: overheadKind });
      if (container && !container.destroyed) {
        try { container.parent?.removeChild?.(container); } catch (_) {}
        try { container.destroy({ children: true }); } catch (_) {}
      }

      container = cloneDisplayObjectForProxy(sourceContainer);
      if (!container || container.destroyed) return false;
      try { container.eventMode = 'none'; } catch (_) {}
      try { container.sortableChildren = false; } catch (_) {}
      try { container.interactiveChildren = false; } catch (_) {}
      try { container.faNexusPreviewMirror = true; } catch (_) {}
      try { container.faNexusPreviewMirrorSource = sourceContainer; } catch (_) {}
      try { container.faNexusBaseTexture = sourceContainer.faNexusBaseTexture || null; } catch (_) {}
      try { container.faNexusMaskTexture = sourceContainer.faNexusMaskTexture || null; } catch (_) {}
      try { container.faNexusBaseSrc = sourceContainer.faNexusBaseSrc || null; } catch (_) {}
      try { container.faNexusMaskSrc = sourceContainer.faNexusMaskSrc || null; } catch (_) {}
      try { container.faNexusBaseKind = sourceContainer.faNexusBaseKind || null; } catch (_) {}
      try { container.faNexusMaskFlagKey = sourceContainer.faNexusMaskFlagKey || null; } catch (_) {}
      try { container.faNexusWidth = sourceContainer.faNexusWidth || null; } catch (_) {}
      try { container.faNexusHeight = sourceContainer.faNexusHeight || null; } catch (_) {}
      for (const referenceKey of [
        'faNexusContentContainer',
        'faNexusBaseDisplayObject',
        'faNexusBaseSprite',
        'faNexusMaskSprite',
        'faNexusTilingSprite'
      ]) {
        const sourceReference = sourceContainer?.[referenceKey] || null;
        const clonedReference = resolveClonedDisplayReference(sourceContainer, container, sourceReference);
        if (clonedReference) container[referenceKey] = clonedReference;
      }
      mesh[containerKey] = container;
      tile[containerKey] = container;
      mesh.addChild(container);
    } else {
      mesh[containerKey] = container;
      tile[containerKey] = container;
      if (!container.parent) mesh.addChild(container);
    }

    try {
      syncTransform?.(container, mesh, tile?.document);
    } catch (_) {}
    syncMeshBoundContainerDisplayState(container, mesh, tile?.document);

    try { mesh[readyKey] = true; } catch (_) {}
    if (shouldUseMaskedTileOverhead(tile)) {
      attachCustomTileOverhead(tile, {
        kind: overheadKind,
        contentContainer: container,
        proxyFactory: () => cloneDisplayObjectForProxy(container),
        filterMode: 'container',
        refreshReason: `${logTag}.previewMirror`,
        syncContent: ({ mesh: currentMesh, entry }) => {
          syncTransform?.(entry?.contentContainer, currentMesh, tile?.document);
          syncMeshBoundContainerDisplayState(entry?.contentContainer, currentMesh, tile?.document);
        }
      });
    } else {
      detachCustomTileOverhead(tile, { kind: overheadKind });
    }
    return true;
  } catch (error) {
    Logger.warn(logTag, {
      tileId: tile?.document?.id || tile?.id || null,
      error: String(error?.message || error)
    });
    return false;
  }
}

function isTextureUsable(texture) {
  if (!texture || texture.destroyed) return false;
  const base = texture.baseTexture;
  if (!base || base.destroyed) return false;
  if (base.valid === false) return false;
  return true;
}

function clampValue(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function expandPolygonVertices(vertices = []) {
  if (!Array.isArray(vertices) || !vertices.length) return [];
  const points = [];
  for (let i = 0; i < vertices.length; i += 1) {
    const current = vertices[i];
    const point = { x: Number(current?.x ?? 0), y: Number(current?.y ?? 0) };
    if (i === 0) {
      points.push(point);
      continue;
    }
    const arc = current?.arc;
    const controlX = Number.isFinite(arc?.controlX) ? Number(arc.controlX)
      : (Number.isFinite(arc?.control?.x) ? Number(arc.control.x) : null);
    const controlY = Number.isFinite(arc?.controlY) ? Number(arc.controlY)
      : (Number.isFinite(arc?.control?.y) ? Number(arc.control.y) : null);
    if (Number.isFinite(controlX) && Number.isFinite(controlY)) {
      const prevPoint = vertices[i - 2] ? { x: Number(vertices[i - 2].x ?? 0), y: Number(vertices[i - 2].y ?? 0) } : null;
      const arcResult = buildArcSamplePoints(
        { x: Number(vertices[i - 1].x ?? 0), y: Number(vertices[i - 1].y ?? 0) },
        point,
        { controlPoint: { x: controlX, y: controlY }, gridSize: canvas?.scene?.grid?.size, prevPoint }
      );
      const samples = Array.isArray(arcResult?.points) ? arcResult.points : [];
      if (samples.length) {
        for (let j = 1; j < samples.length; j += 1) {
          points.push({ x: samples[j].x, y: samples[j].y });
        }
        continue;
      }
    }
    points.push(point);
  }
  return points;
}

function hashString(value) {
  const input = String(value ?? '');
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash &= 0xffffffff;
  }
  return (hash >>> 0).toString(16);
}

function isArrayMask(flags) {
  return flags?.maskType === MASK_TYPE_ARRAY
    && (Array.isArray(flags?.maskShapes) || Array.isArray(flags?.maskShapes?.shapes));
}

function getMaskShapeData(flags) {
  const raw = flags?.maskShapes ?? null;
  const shapes = Array.isArray(raw) ? raw : (Array.isArray(raw?.shapes) ? raw.shapes : []);
  if (!shapes.length) return null;
  const key = flags?.maskShapeKey || hashString(JSON.stringify(raw));
  return { shapes, key };
}

function resolveMaskKey(flags) {
  if (isArrayMask(flags)) {
    const data = getMaskShapeData(flags);
    return data?.key || null;
  }
  return flags?.maskSrc || null;
}

// A mask texture built from shapes belongs to the container that shows it. Whenever that container is destroyed, by a
// cleanup here or together with the Tile's mesh when the canvas is redrawn, the texture goes with it; without this it
// stayed in GPU memory after every Level or Scene switch.
function bindOwnedMaskTexture(container, texture) {
  if (!container || container.destroyed) return;
  container.faNexusOwnedMaskTexture = texture || null;
  if (container.faNexusOwnedMaskTextureBound) return;
  container.faNexusOwnedMaskTextureBound = true;
  container.once('destroyed', () => {
    const owned = container.faNexusOwnedMaskTexture;
    container.faNexusOwnedMaskTexture = null;
    if (!owned || owned.destroyed || !owned.baseTexture) return;
    try { owned.destroy(true); }
    catch (error) { Logger.warn('TextureRender.ownedMask.destroyFailed', { error: String(error?.message || error) }); }
  });
}

// After an apply: a mask built now is owned by its container; a reused mask stays with whoever owns it (this container,
// when it built it in an earlier apply; the source Tile, when a preview borrows it).
function syncOwnedMaskTexture(container, maskTex, builtNow) {
  if (builtNow) bindOwnedMaskTexture(container, maskTex);
  else if (container?.faNexusOwnedMaskTexture && container.faNexusOwnedMaskTexture !== maskTex) container.faNexusOwnedMaskTexture = null;
}

function buildMaskTextureFromShapes(shapes, width, height) {
  try {
    if (!Array.isArray(shapes) || !shapes.length) return null;
    const renderer = canvas?.app?.renderer;
    if (!renderer) return null;
    const targetWidth = Math.max(2, Math.ceil(Number(width) || 2));
    const targetHeight = Math.max(2, Math.ceil(Number(height) || 2));
    const maxTex = getMaxTextureSize();
    const rtWidth = Math.max(2, Math.min(targetWidth, maxTex));
    const rtHeight = Math.max(2, Math.min(targetHeight, maxTex));
    const scaleX = rtWidth / targetWidth;
    const scaleY = rtHeight / targetHeight;
    const useScale = scaleX !== 1 || scaleY !== 1;
    const rt = PIXI.RenderTexture.create({
      width: rtWidth,
      height: rtHeight,
      resolution: 1
    });
    const g = new PIXI.Graphics();
    const container = useScale ? new PIXI.Container() : null;
    if (container) {
      container.scale.set(scaleX, scaleY);
      container.addChild(g);
    }
    let first = true;
    for (const shape of shapes) {
      if (!shape || !shape.type) continue;
      const blend = shape.operation === 'subtract' ? PIXI.BLEND_MODES.ERASE : PIXI.BLEND_MODES.NORMAL;
      g.clear();
      g.beginFill(0xFFFFFF, 1);
      if (shape.type === 'rectangle') {
        const x = Number(shape.x ?? shape?.topLeft?.x ?? 0);
        const y = Number(shape.y ?? shape?.topLeft?.y ?? 0);
        const w = Math.max(1, Number(shape.width ?? shape?.size?.width ?? 0));
        const h = Math.max(1, Number(shape.height ?? shape?.size?.height ?? 0));
        g.drawRect(x, y, w, h);
      } else if (shape.type === 'ellipse') {
        const cx = Number(shape.x ?? shape?.center?.x ?? 0);
        const cy = Number(shape.y ?? shape?.center?.y ?? 0);
        const rx = Math.max(0.5, Number(shape.radiusX ?? shape?.radius?.x ?? 0));
        const ry = Math.max(0.5, Number(shape.radiusY ?? shape?.radius?.y ?? 0));
        g.drawEllipse(cx, cy, rx, ry);
      } else if (shape.type === 'polygon') {
        const verts = Array.isArray(shape.vertices) ? shape.vertices : (Array.isArray(shape.points) ? shape.points : []);
        const expanded = expandPolygonVertices(verts);
        if (expanded.length >= 3) {
          const coords = [];
          for (const point of expanded) coords.push(point.x, point.y);
          g.drawPolygon(coords);
        }
      }
      g.endFill();
      g.blendMode = blend;
      renderer.render(container || g, { renderTexture: rt, clear: first });
      first = false;
    }
    if (container) {
      try { container.removeChild(g); } catch (_) {}
      try { container.destroy({ children: false }); } catch (_) {}
    }
    g.destroy({ children: true });
    if (!isTextureUsable(rt)) {
      try { rt.destroy(true); } catch (_) {}
      return null;
    }
    return rt;
  } catch (_) {
    return null;
  }
}

// Derived from the same array mask as the rendered texture. Keep it on the
// mounted mask so selection follows its live preview transform and lifetime.
function buildMaskHitGeometry(shapes, width, height) {
  return {
    width: Math.max(2, Math.ceil(Number(width) || 2)),
    height: Math.max(2, Math.ceil(Number(height) || 2)),
    shapes: (shapes || []).filter((source) => source?.type).map((source) => {
      let shape;
      if (source.type === 'rectangle') {
        shape = new PIXI.Rectangle(Number(source.x ?? source.topLeft?.x ?? 0), Number(source.y ?? source.topLeft?.y ?? 0),
          Math.max(1, Number(source.width ?? source.size?.width ?? 0)), Math.max(1, Number(source.height ?? source.size?.height ?? 0)));
      } else if (source.type === 'ellipse') {
        shape = new PIXI.Ellipse(Number(source.x ?? source.center?.x ?? 0), Number(source.y ?? source.center?.y ?? 0),
          Math.max(0.5, Number(source.radiusX ?? source.radius?.x ?? 0)), Math.max(0.5, Number(source.radiusY ?? source.radius?.y ?? 0)));
      } else if (source.type === 'polygon') {
        const vertices = Array.isArray(source.vertices) ? source.vertices : (Array.isArray(source.points) ? source.points : []);
        shape = new PIXI.Polygon(expandPolygonVertices(vertices).flatMap((point) => [point.x, point.y]));
      }
      return { operation: source.operation, shape };
    })
  };
}

const SINGLE_CHANNEL_MASKS = new WeakMap();
const FULL_COLOUR_MASKS = new Set();

/**
 * A painted mask holds one value per pixel (white with the value in alpha, or
 * the older grey on opaque). Uploaded premultiplied, its red channel is that
 * value, and red is all a sprite mask reads, so the copy drawn here keeps red
 * alone: a quarter of the GPU memory. The full-colour texture stays in the
 * loader's cache, off the GPU, for the Texture editor to paint on.
 */
function toSingleChannelMaskTexture(texture) {
  const base = texture?.baseTexture;
  const source = base?.resource?.source;
  const renderer = canvas?.app?.renderer;
  if (!base || !source || renderer?.context?.webGLVersion !== 2) return texture;
  if (base.alphaMode === PIXI.ALPHA_MODES.NPM) return texture;
  const image = [globalThis.ImageBitmap, globalThis.HTMLImageElement, globalThis.HTMLCanvasElement]
    .some((type) => type && source instanceof type);
  if (!image) return texture;
  let single = SINGLE_CHANNEL_MASKS.get(base);
  if (!isTextureUsable(single)) {
    const singleBase = new PIXI.BaseTexture(source, {
      format: PIXI.FORMATS.RED,
      type: PIXI.TYPES.UNSIGNED_BYTE,
      alphaMode: base.alphaMode,
      mipmap: base.mipmap,
      scaleMode: base.scaleMode,
      wrapMode: base.wrapMode,
      resolution: base.resolution,
      anisotropicLevel: base.anisotropicLevel
    });
    // The image belongs to the loader's texture; this copy must not close it.
    if (singleBase.resource && ('ownsImageBitmap' in singleBase.resource)) singleBase.resource.ownsImageBitmap = false;
    singleBase.faNexusSingleChannelMask = true;
    singleBase.faNexusFullColourMask = base;
    single = new PIXI.Texture(singleBase);
    SINGLE_CHANNEL_MASKS.set(base, single);
    FULL_COLOUR_MASKS.add(base);
    base.once('destroyed', () => {
      FULL_COLOUR_MASKS.delete(base);
      if (!single.destroyed) single.destroy(true);
    });
  }
  releaseFullColourMaskCopies();
  return single;
}

/** The editor uploads a full-colour mask to paint on it. Nothing draws it afterwards. */
function releaseFullColourMaskCopies() {
  const contextId = canvas?.app?.renderer?.CONTEXT_UID;
  for (const full of FULL_COLOUR_MASKS) {
    if (!full.destroyed && full._glTextures?.[contextId]) full.dispose();
  }
}

async function resolveMaskedTilingTextures({ reuse, flags, solidTint, arrayMask, maskData, width, height }) {
  let baseTex = reuse?.baseTex || null;
  let maskTex = reuse?.maskTex || null;
  let ownsMaskTex = false;
  if (solidTint !== null) baseTex = getSolidColorTexture();
  if (!baseTex) baseTex = solidTint !== null ? getSolidColorTexture() : await loadTexture(flags.baseSrc);
  if (!maskTex) {
    if (arrayMask) {
      maskTex = buildMaskTextureFromShapes(maskData?.shapes, width, height);
      ownsMaskTex = !!maskTex;
      if (!maskTex) throw new Error('Mask shape render failed');
    } else {
      maskTex = toSingleChannelMaskTexture(await loadTexture(flags.maskSrc));
    }
  }
  return { baseTex, maskTex, ownsMaskTex };
}

function buildFlattenedChunkKey(chunks) {
  if (!Array.isArray(chunks) || !chunks.length) return '';
  return chunks.map((chunk) => (
    `${chunk.src}|${chunk.x}|${chunk.y}|${chunk.width}|${chunk.height}|${chunk.pixelWidth ?? ''}|${chunk.pixelHeight ?? ''}`
  )).join(';');
}

function getTileAnchor(doc) {
  return {
    x: clampValue(Number(doc?.texture?.anchorX), 0, 1, 0.5),
    y: clampValue(Number(doc?.texture?.anchorY), 0, 1, 0.5)
  };
}

function getTileTopLeftWorld(doc, tileMeta = null) {
  const anchor = getTileAnchor({ texture: {
    anchorX: doc?.texture?.anchorX ?? tileMeta?.anchorX,
    anchorY: doc?.texture?.anchorY ?? tileMeta?.anchorY
  }});
  const width = Number(doc?.width ?? tileMeta?.width) || 0;
  const height = Number(doc?.height ?? tileMeta?.height) || 0;
  const anchorPosX = Number(doc?.x ?? tileMeta?.x) || 0;
  const anchorPosY = Number(doc?.y ?? tileMeta?.y) || 0;
  return {
    x: anchorPosX - (width * anchor.x),
    y: anchorPosY - (height * anchor.y)
  };
}

function syncTileLocalContainerTransform(
  container,
  mesh,
  width,
  height,
  anchor = { x: 0.5, y: 0.5 },
  { preserveFlipSign = false } = {}
) {
  if (!container || container.destroyed || !mesh || mesh.destroyed) return;
  try {
    const rawSx = Number(mesh.scale?.x ?? 1) || 1;
    const rawSy = Number(mesh.scale?.y ?? 1) || 1;
    const sx = Math.max(1, Number(width) || 1);
    const sy = Math.max(1, Number(height) || 1);
    const scaleX = preserveFlipSign ? (1 / sx) : ((Math.sign(rawSx || 1) || 1) / sx);
    const scaleY = preserveFlipSign ? (1 / sy) : ((Math.sign(rawSy || 1) || 1) / sy);
    container.scale.set(scaleX, scaleY);
    const offsetX = -((Number(width) || 0) * (preserveFlipSign && rawSx < 0 ? 1-clampValue(Number(anchor?.x), 0, 1, 0.5) : clampValue(Number(anchor?.x), 0, 1, 0.5))) / (sx || 1);
    const offsetY = -((Number(height) || 0) * (preserveFlipSign && rawSy < 0 ? 1-clampValue(Number(anchor?.y), 0, 1, 0.5) : clampValue(Number(anchor?.y), 0, 1, 0.5))) / (sy || 1);
    container.position.set(offsetX, offsetY);
  } catch (_) {
    try { container.scale.set(1, 1); } catch (_) {}
    container.position.set(
      -((Number(width) || 0) * clampValue(Number(anchor?.x), 0, 1, 0.5)),
      -((Number(height) || 0) * clampValue(Number(anchor?.y), 0, 1, 0.5))
    );
  }
}

function syncMaskedContainerTransform(container, mesh, width, height, doc) {
  syncTileLocalContainerTransform(container, mesh, width, height, getTileAnchor(doc), { preserveFlipSign: true });
  // A prepared Tile may be clamped while its semantic mask and native Walls
  // remain at the stored pose. Convert that displacement through the live mesh
  // rather than treating it as an authoring move or changing document state.
  const rawX = doc?._source?.x ?? doc?.x, rawY = doc?._source?.y ?? doc?.y;
  if (rawX === doc?.x && rawY === doc?.y) return;
  const stored = mesh.toLocal(new PIXI.Point(rawX, rawY), mesh.parent);
  const prepared = mesh.toLocal(new PIXI.Point(doc.x, doc.y), mesh.parent);
  container.position.x += stored.x - prepared.x;
  container.position.y += stored.y - prepared.y;
}

function syncStandardMaskContainerTransform(container, mesh, width, height, doc) {
  syncTileLocalContainerTransform(container, mesh, width, height, getTileAnchor(doc), { preserveFlipSign: true });
}

function syncStandardMaskNativeContainerTransform(container, mesh, document) {
  if (!container || container.destroyed || !mesh || mesh.destroyed || !document) return false;
  const width = Math.max(2, Number(document.width) || Number(mesh.width) || 2);
  const height = Math.max(2, Number(document.height) || Number(mesh.height) || 2);
  if (container.faNexusBaseKind === 'sprite') {
    const baseSprite = container.faNexusBaseDisplayObject || container.faNexusBaseSprite || null;
    if (baseSprite && !baseSprite.destroyed) {
      baseSprite.position?.set?.(0, 0);
      baseSprite.width = width;
      baseSprite.height = height;
    }
    const maskSprite = container.faNexusMaskSprite || null;
    const maskFlags = document.getFlag?.('fa-nexus', STANDARD_TILE_MASK_FLAG)
      ?? document.flags?.['fa-nexus']?.[STANDARD_TILE_MASK_FLAG]
      ?? null;
    if (maskSprite && !maskSprite.destroyed && maskFlags) {
      const placement = computeMaskPlacement(maskFlags, width, height, maskSprite.texture);
      maskSprite.position?.set?.(placement.offsetX || 0, placement.offsetY || 0);
      maskSprite.scale?.set?.(placement.scaleX || 1, placement.scaleY || 1);
    }
    container.faNexusWidth = width;
    container.faNexusHeight = height;
  }
  syncStandardMaskContainerTransform(container, mesh, width, height, document);
  syncMeshBoundContainerDisplayState(container, mesh, document);
  return true;
}

export function syncStandardMaskNativeTransformPreview(preview) {
  const mesh = preview?.mesh || null;
  const document = preview?.document || null;
  const container = preview?.faNexusStandardMaskContainer
    || mesh?.faNexusStandardMaskContainer
    || null;
  return syncStandardMaskNativeContainerTransform(container, mesh, document);
}

export function computeMaskPlacement(flags, tileWidth, tileHeight, maskTex) {
  try {
    const mw = Math.max(1, maskTex?.baseTexture?.realWidth || maskTex?.width || 1);
    const mh = Math.max(1, maskTex?.baseTexture?.realHeight || maskTex?.height || 1);
    const meta = flags || {};
    const version = Number(meta.maskVersion || 1);
    if (version >= 2) {
      const scaleX = Number.isFinite(tileWidth / mw) && tileWidth > 0 ? tileWidth / mw : 1;
      const scaleY = Number.isFinite(tileHeight / mh) && tileHeight > 0 ? tileHeight / mh : 1;
      return {
        scaleX: Math.max(1e-6, scaleX),
        scaleY: Math.max(1e-6, scaleY),
        offsetX: 0,
        offsetY: 0,
        version
      };
    }
    const original = meta.maskOriginalSize || {};
    const crop = meta.maskCrop || {};
    const originalWidth = Math.max(1, Number(original.width) || mw);
    const originalHeight = Math.max(1, Number(original.height) || mh);
    const cropX = Math.max(0, Number(crop.x) || 0);
    const cropY = Math.max(0, Number(crop.y) || 0);
    const cropWidth = Math.max(1, Number(crop.width) || originalWidth);
    const cropHeight = Math.max(1, Number(crop.height) || originalHeight);

    const scaleFromOriginalX = tileWidth / originalWidth;
    const scaleFromOriginalY = tileHeight / originalHeight;
    const displayWidth = cropWidth * scaleFromOriginalX;
    const displayHeight = cropHeight * scaleFromOriginalY;

    const rawScaleX = displayWidth / mw;
    const rawScaleY = displayHeight / mh;
    const offsetX = cropX * scaleFromOriginalX;
    const offsetY = cropY * scaleFromOriginalY;

    const safeScaleX = Number.isFinite(rawScaleX) && rawScaleX > 0 ? rawScaleX : (tileWidth / mw);
    const safeScaleY = Number.isFinite(rawScaleY) && rawScaleY > 0 ? rawScaleY : (tileHeight / mh);
    const clampWidth = Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : tileWidth;
    const clampHeight = Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : tileHeight;
    const maxOffsetX = Math.max(0, tileWidth - clampWidth);
    const maxOffsetY = Math.max(0, tileHeight - clampHeight);
    const safeOffsetX = Number.isFinite(offsetX) ? Math.min(Math.max(0, offsetX), maxOffsetX) : 0;
    const safeOffsetY = Number.isFinite(offsetY) ? Math.min(Math.max(0, offsetY), maxOffsetY) : 0;

    return {
      scaleX: safeScaleX,
      scaleY: safeScaleY,
      offsetX: safeOffsetX,
      offsetY: safeOffsetY
    };
  } catch (_) {
    const mw = Math.max(1, maskTex?.baseTexture?.realWidth || maskTex?.width || 1);
    const mh = Math.max(1, maskTex?.baseTexture?.realHeight || maskTex?.height || 1);
    return {
      scaleX: tileWidth / mw,
      scaleY: tileHeight / mh,
      offsetX: 0,
      offsetY: 0
    };
  }
}

export function applyBaseTilingOffset(tiling, tile, flags) {
  try {
    if (!tiling || tiling.destroyed) return;
    const tilePos = tiling.tilePosition;
    const version = Number(flags?.maskVersion || 1);
    if (!tilePos || typeof tilePos.set !== 'function') return;
    if (!tile || !tile.document) {
      tilePos.set(0, 0);
      return;
    }
    const doc = tile.document;
    const origin = flags?.maskWorld?.origin || {};
    const originX = Number(origin.x) || 0;
    const originY = Number(origin.y) || 0;
    const docTopLeft = getTileTopLeftWorld(doc, flags?.maskWorld?.tile || null);
    const deltaX = docTopLeft.x - originX;
    const deltaY = docTopLeft.y - originY;
    if (version >= 3) {
      const phase = normalizeOffset(flags?.texturePhase) || { x: 0, y: 0 };
      const userOffset = normalizeOffset(flags?.textureOffset) || { x: 0, y: 0 };
      const liveDelta = getLiveTileDelta(tile, flags);
      tilePos.x = roundValue((phase.x + userOffset.x) - deltaX + liveDelta.x);
      tilePos.y = roundValue((phase.y + userOffset.y) - deltaY + liveDelta.y);
      return;
    }
    if (version < 2) {
      tilePos.set(0, 0);
      return;
    }
    tilePos.x = roundValue(-deltaX);
    tilePos.y = roundValue(-deltaY);
  } catch (_) {}
}

export function syncMaskedTilingTransformPreview(
  tile,
  maskedTiling,
  { geometryCompensationX = 1, geometryCompensationY = 1 } = {}
) {
  if (!maskedTiling || typeof maskedTiling !== 'object') return false;
  const container = tile?.mesh?.faNexusMaskContainer || tile?.faNexusMaskContainer || null;
  if (maskedTiling.maskType === 'composite' && container?.faNexusCompositeRegions) {
    for (const region of maskedTiling.regions.filter((entry) => entry.active)) {
      const child = container.faNexusCompositeRegions.find((entry) => entry.regionId === region.regionId)?.container;
      if (!child) throw new Error(`Composite Fill Region ${region.regionId} is not ready.`);
      syncMaskedTilingTransformPreview({ document: tile.document, mesh: { faNexusMaskContainer: child } }, region.maskedTiling,
        { geometryCompensationX, geometryCompensationY });
    }
    return true;
  }
  const tiling = container?.faNexusTilingSprite || null;
  if (!tile?.document || !container || container.destroyed || !tiling || tiling.destroyed) {
    throw new Error(
      `Masked Texture Tile ${tile?.document?.uuid || tile?.document?.id || tile?.id || 'unknown'} `
        + 'cannot preview its semantic transform because the masked renderer is not ready.'
    );
  }
  applyMaskedTilingRepeatTransform(tiling, maskedTiling, getBaseGridScale());
  applyBaseTilingOffset(tiling, tile, maskedTiling);
  const compensationX = Number(geometryCompensationX);
  const compensationY = Number(geometryCompensationY);
  if (!(compensationX > 0) || !(compensationY > 0)) {
    throw new Error('Masked Texture preview geometry compensation requires positive per-axis factors.');
  }
  if (compensationX !== 1 || compensationY !== 1) {
    const Matrix = globalThis.PIXI?.Matrix;
    const transform = tiling.tileTransform;
    if (typeof Matrix !== 'function' || typeof transform?.setFromMatrix !== 'function') {
      throw new Error('Foundry v14 Pixi tileTransform matrix API is unavailable for preview compensation.');
    }
    transform.updateLocalTransform?.();
    const matrix = transform.localTransform;
    transform.setFromMatrix(new Matrix(
      matrix.a * compensationX,
      matrix.b * compensationY,
      matrix.c * compensationX,
      matrix.d * compensationY,
      matrix.tx * compensationX,
      matrix.ty * compensationY
    ));
  }
  if (typeof tiling._refresh === 'function') tiling._refresh();
  else tiling.uvMatrix?.update?.();
  return true;
}

export function getLiveTileDelta(tile, flags) {
  try {
    if (!tile || !tile.document) return { x: 0, y: 0 };
    const doc = tile.document;
    const anchor = flags?.maskWorld?.tile || {};
    const anchorX = Number(anchor.x);
    const anchorY = Number(anchor.y);
    const docX = Number(doc.x);
    const docY = Number(doc.y);
    const deltaX = (Number.isFinite(anchorX) && Number.isFinite(docX)) ? roundValue(docX - anchorX) : 0;
    const deltaY = (Number.isFinite(anchorY) && Number.isFinite(docY)) ? roundValue(docY - anchorY) : 0;
    if (!deltaX && !deltaY) return { x: 0, y: 0 };
    return { x: deltaX, y: deltaY };
  } catch (_) {
    return { x: 0, y: 0 };
  }
}

export function scheduleMaskedTileRetry(tile, applyFn) {
  try {
    if (!tile || tile.destroyed) return;
    const retries = TILE_RETRY_TIMERS;
    const existing = retries.get(tile) || { attempts: 0, timeout: null };
    if (existing.timeout) {
      try { clearTimeout(existing.timeout); } catch (_) {}
    }
    const next = (existing.attempts || 0) + 1;
    if (next > 8) {
      retries.delete(tile);
      Logger.error('TextureRender.scheduleMaskedTileRetry.exhausted', {
        tileId: tile?.document?.id || tile?.id || null,
        attempts: existing.attempts || 0
      });
      return;
    }
    const timeout = setTimeout(() => {
      try {
        const current = retries.get(tile);
        if (current?.timeout === timeout) current.timeout = null;
      } catch (_) {}
      let result = null;
      try {
        if (typeof applyFn === 'function') result = applyFn(tile);
      } catch (error) {
        Logger.warn?.('TextureRender.scheduleMaskedTileRetry.applyFailed', {
          tileId: tile?.document?.id || tile?.id || null,
          error: String(error?.message || error)
        });
      }
      Promise.resolve(result)
        .catch((error) => {
          Logger.warn?.('TextureRender.scheduleMaskedTileRetry.applyRejected', {
            tileId: tile?.document?.id || tile?.id || null,
            error: String(error?.message || error)
          });
        })
        .finally(() => {
          try {
            const current = retries.get(tile);
            if (current && !current.timeout) retries.delete(tile);
          } catch (_) {}
        });
    }, Math.min(150 * next, 600));
    retries.set(tile, { attempts: next, timeout });
  } catch (_) {}
}

export function clearMaskedTileRetry(tile) {
  try {
    if (!tile) return;
    const retries = TILE_RETRY_TIMERS;
    const existing = retries.get(tile);
    if (!existing) return;
    if (existing.timeout) {
      try { clearTimeout(existing.timeout); } catch (_) {}
    }
    retries.delete(tile);
  } catch (_) {}
}

function tileDocumentSnapshot(doc) {
  return {
    x: Number(doc?.x),
    y: Number(doc?.y),
    width: Number(doc?.width),
    height: Number(doc?.height),
    rotation: Number(doc?.rotation || 0),
    texture: {
      anchorX: Number(doc?.texture?.anchorX ?? 0.5),
      anchorY: Number(doc?.texture?.anchorY ?? 0.5)
    }
  };
}

export function deriveMaskedTilingPreviewState(tile, maskedTiling) {
  const sourceDocument = tile?._original?.document || null;
  const previewDocument = tile?.document || null;
  if (!maskedTiling || typeof maskedTiling !== 'object') return maskedTiling;
  if (!tile?.isPreview || !sourceDocument || !previewDocument) return maskedTiling;
  return deriveMaskedTilingTransformPreview({
    maskedTiling,
    originalTile: tileDocumentSnapshot(sourceDocument),
    finalTile: tileDocumentSnapshot(previewDocument)
  });
}

function clearMaskedTilingOverlay(tile, { preserveTexture = false } = {}) {
  try {
    const meshRef = tile?.mesh;
    const cont = meshRef?.faNexusMaskContainer || tile?.faNexusMaskContainer;
    if (tile) detachCustomTileOverhead(tile, { kind: MASKED_OVERHEAD_KIND });
    if (cont) {
      if (cont.faNexusCompositeRegions) destroyCompositeFillResources(cont);
      try { cont.parent?.removeChild?.(cont); } catch (_) {}
      try { cont.destroy({ children: true }); } catch (_) {}
      cont.faNexusTilingSprite = null;
      cont.faNexusMaskSprite = null;
      cont.faNexusBaseTexture = null;
      cont.faNexusMaskTexture = null;
      cont.faNexusBaseSrc = null;
      cont.faNexusMaskSrc = null;
    }
    if (meshRef) {
      meshRef.faNexusMaskContainer = null;
      meshRef.faNexusMaskReady = false;
      if (!preserveTexture && meshRef[MASKED_TILING_ORIGINAL_TEXTURE_KEY]) {
        if (meshRef.faNexusStandardMaskContainer || tile?.faNexusStandardMaskContainer) {
          Logger.debug('TextureRender.maskedTiling.cleanup.restoreBlockedByStandardMask', {
            tileId: tile?.document?.id || tile?.id || null
          });
        } else {
          restoreMeshTexture(meshRef, MASKED_TILING_ORIGINAL_TEXTURE_KEY);
        }
      }
    }
    if (tile) tile.faNexusMaskContainer = null;
  } catch (error) { if (isTextureCleanupFailure(error)) throw error; }
}

function destroyCompositeFillResources(container) {
  const textures = [];
  for (const region of container.faNexusCompositeRegions || []) {
    const child = region.container;
    if (child.faNexusTilingSprite) {
      child.faNexusTilingSprite.mask = null;
      clearHsbcFromDisplayObject(child.faNexusTilingSprite, { slot: 'masked-tiling' });
    }
    if (child.faNexusMaskTexture) textures.push(child.faNexusMaskTexture);
    child.faNexusMaskTexture = null;
    child.faNexusOwnedMaskTexture = null;
  }
  destroyOwnedTextureResources({ textures, context: 'Composite Fill mask cleanup' });
}

async function prepareCompositeFillContainer(tile, flags, width, height) {
  const container = new PIXI.Container();
  container.eventMode = 'none';
  container.faNexusCompositeRegions = [];
  try {
    for (const region of flags.regions || []) {
      if (!region.active) continue;
      const baseSrc = String(region.asset?.src || '').trim();
      if (!baseSrc) throw new Error(`Composite Fill Region ${region.regionId} has no asset source.`);
      const projected = { ...region.maskedTiling, baseSrc };
      const child = new PIXI.Container();
      child.eventMode = 'none';
      container.addChild(child);
      container.faNexusCompositeRegions.push({ regionId: region.regionId, container: child });
      const resources = await resolveMaskedTilingTextures({ flags: projected, solidTint: null, arrayMask: true,
        maskData: getMaskShapeData(projected), width, height });
      child.faNexusMaskTexture = resources.maskTex;
      if (resources.ownsMaskTex) bindOwnedMaskTexture(child, resources.maskTex);
      child.faNexusBaseTexture = resources.baseTex;
      if (!isTextureUsable(resources.baseTex) || !isTextureUsable(resources.maskTex)) throw new Error(`Composite Fill Region ${region.regionId} texture unavailable: ${baseSrc}`);
      const sprite = new PIXI.TilingSprite(resources.baseTex, width, height);
      child.addChild(sprite);
      child.faNexusTilingSprite = sprite;
      const mask = new PIXI.Sprite(resources.maskTex);
      child.addChild(mask);
      child.faNexusMaskSprite = mask;
      mask.faNexusMaskGeometry = buildMaskHitGeometry(getMaskShapeData(projected)?.shapes, width, height);
      applyMaskedTilingRepeatTransform(sprite, projected, getBaseGridScale());
      applyTilingSamplingFix(sprite);
      applyBaseTilingOffset(sprite, tile, projected);
      sprite.alpha = Number(region.appearance?.opacity ?? 1);
      applyHsbcToDisplayObject(sprite, region.appearance?.hsbc, { slot: 'masked-tiling' });
      const placement = computeMaskPlacement(projected, width, height, resources.maskTex);
      mask.scale.set(placement.scaleX || 1, placement.scaleY || 1);
      mask.position.set(placement.offsetX || 0, placement.offsetY || 0);
      mask.width = width;
      mask.height = height;
      sprite.mask = mask;
      mask.renderable = false;
    }
    if (!container.faNexusCompositeRegions.length) throw new Error('Composite Fill requires an active Region.');
    container.faNexusSourceFingerprint = flags.sourceFingerprint;
    return container;
  } catch (error) {
    try { destroyCompositeFillResources(container); }
    finally { container.destroy({ children: true }); }
    throw error;
  }
}

export async function applyMaskedTilingToTile(tile) {
  let compositeRequested = false;
  let hidePreview = false;
  let previewVisibilityToken = null;
  let applyToken = null;
  try {
    if (!tile || !tile.document) return;
    applyToken = beginTileApply(tile, 'masked-tiling');
    const editing = isEditingTile(tile);
    const sourceFlags = tile?._original?.document?.getFlag?.('fa-nexus', MASKED_TILING_FLAG)
      || tile.document.getFlag('fa-nexus', MASKED_TILING_FLAG);
    const flags = deriveMaskedTilingPreviewState(tile, sourceFlags);
    const arrayMask = isArrayMask(flags);
    const compositeMask = flags?.maskType === 'composite';
    compositeRequested = compositeMask;
    const solidColor = normalizeSolidColor(flags?.baseColor);
    const solidTint = parseSolidColorTint(solidColor);

    if (editing) {
      clearMaskedTilingOverlay(tile, { preserveTexture: true });
      clearMaskedTileRetry(tile);
      const mesh = await prepareCustomTileRendererMesh(tile, {
        originalTextureSlotKey: MASKED_TILING_ORIGINAL_TEXTURE_KEY
      });
      if (!isCurrentTileApply(tile, applyToken)) return;
      if (mesh && !mesh.destroyed) {
        try { mesh.alpha = 0; } catch (_) {}
      }
      return;
    }

    if (!flags || (!flags.baseSrc && !solidColor && !compositeMask) || (!flags.maskSrc && !arrayMask && !compositeMask)) {
      clearMaskedTilingOverlay(tile);
      clearMaskedTileRetry(tile);
      return;
    }

    const mesh = await prepareCustomTileRendererMesh(tile, {
      originalTextureSlotKey: MASKED_TILING_ORIGINAL_TEXTURE_KEY
    });
    if (!isCurrentTileApply(tile, applyToken)) return;

    if (!mesh || mesh.destroyed) {
      scheduleMaskedTileRetry(tile, applyMaskedTilingToTile);
      return;
    }

    clearMaskedTileRetry(tile);

    if (tile?.isPreview && (
      mesh.faNexusMaskContainer?.faNexusPreviewMirror
      || tile.faNexusMaskContainer?.faNexusPreviewMirror
    )) {
      clearMaskedTilingOverlay(tile, { preserveTexture: true });
    }

    let reuse = getReusableTextures(tile, flags);
    if (!reuse && tile?.isPreview) reuse = getPreviewSourceTextures(tile, flags);
    hidePreview = (!reuse || !reuse.ready) && tile?.isPreview;
    if (hidePreview) previewVisibilityToken = suppressPreviewVisibility(tile, applyToken);

    const meshWidth = Number(mesh?.width);
    const meshHeight = Number(mesh?.height);
    const docWidth = Number(tile?.document?.width);
    const docHeight = Number(tile?.document?.height);
    const w = Math.max(2, Number.isFinite(docWidth) && docWidth > 0 ? docWidth : (Number.isFinite(meshWidth) && meshWidth > 0 ? meshWidth : 2));
    const h = Math.max(2, Number.isFinite(docHeight) && docHeight > 0 ? docHeight : (Number.isFinite(meshHeight) && meshHeight > 0 ? meshHeight : 2));
    if (compositeMask) {
      const container = await prepareCompositeFillContainer(tile, flags, w, h);
      if (!isCurrentTileApply(tile, applyToken)) {
        try { destroyCompositeFillResources(container); }
        finally { container.destroy({ children: true }); }
        return;
      }
      clearMaskedTilingOverlay(tile, { preserveTexture: true });
      mesh.faNexusMaskContainer = container;
      tile.faNexusMaskContainer = container;
      mesh.addChild(container);
      syncMaskedContainerTransform(container, mesh, w, h, tile.document);
      syncMeshBoundContainerDisplayState(container, mesh, tile.document);
      mesh.faNexusMaskReady = true;
      if (shouldUseMaskedTileOverhead(tile)) attachCustomTileOverhead(tile, {
        kind: MASKED_OVERHEAD_KIND, contentContainer: container,
        proxyFactory: createMaskedProxyFactory(container), filterMode: 'leaf', refreshReason: 'masked-refresh',
        syncContent: ({ mesh: currentMesh, entry }) => {
          syncMaskedContainerTransform(entry?.contentContainer, currentMesh, w, h, tile.document);
          syncMeshBoundContainerDisplayState(entry?.contentContainer, currentMesh, tile.document);
        }
      });
      else detachCustomTileOverhead(tile, { kind: MASKED_OVERHEAD_KIND });
      return;
    }
    if (mesh.faNexusMaskContainer?.faNexusCompositeRegions) clearMaskedTilingOverlay(tile, { preserveTexture: true });
    const maskData = arrayMask ? getMaskShapeData(flags) : null;

    let baseTex = null;
    let maskTex = null;
    let ownsMaskTex = false;
    try {
      ({ baseTex, maskTex, ownsMaskTex } = await resolveMaskedTilingTextures({
        reuse,
        flags,
        solidTint,
        arrayMask,
        maskData,
        width: w,
        height: h
      }));
      if (!isCurrentTileApply(tile, applyToken)) {
        destroyOwnedTextureResources({
          textures: ownsMaskTex ? [maskTex] : [],
          context: 'Stale masked-tiling apply cleanup'
        });
        return;
      }
    } catch (texErr) {
      if (isTextureCleanupFailure(texErr)) throw texErr;
      if (!isCurrentTileApply(tile, applyToken)) return;
      try { Logger.warn('TextureRender.apply.loadFailed', { error: String(texErr?.message || texErr), tileId: tile?.document?.id }); } catch (_) {}
      scheduleMaskedTileRetry(tile, applyMaskedTilingToTile);
      return;
    }
    if (!isTextureUsable(baseTex)) throw new Error('Base texture invalid');
    if (!isTextureUsable(maskTex)) throw new Error('Mask texture invalid');
    const maskKey = resolveMaskKey(flags);

    let container = mesh.faNexusMaskContainer;
    if (!container || container.destroyed) {
      container = new PIXI.Container();
      container.eventMode = 'none';
      container.sortableChildren = false;
      mesh.faNexusMaskContainer = container;
      tile.faNexusMaskContainer = container;
      mesh.addChild(container);
    } else {
      mesh.faNexusMaskContainer = container;
      tile.faNexusMaskContainer = container;
      if (!container.parent) mesh.addChild(container);
    }
    const previousMaskTex = container.faNexusMaskTexture || null;

    let maskSprite = container.faNexusMaskSprite || null;
    let tiling = container.faNexusTilingSprite || null;
    if (!tiling || tiling.destroyed) {
      tiling = new PIXI.TilingSprite(baseTex, w, h);
      tiling.position.set(0, 0);
      tiling.tilePosition.set(0, 0);
      tiling.alpha = 1;
      container.addChild(tiling);
      container.faNexusTilingSprite = tiling;
    }

    if (!tiling || tiling.destroyed) return;
    if (tiling.texture !== baseTex) {
      try { tiling.texture = baseTex; } catch (_) {}
    }
    try {
      tiling.width = w;
      tiling.height = h;
    } catch (_) {}

    applyMaskedTilingRepeatTransform(tiling, flags, getBaseGridScale());
    applyTilingSamplingFix(tiling);

    if (!maskSprite || maskSprite.destroyed) {
      maskSprite = new PIXI.Sprite(maskTex);
      container.addChild(maskSprite);
      container.faNexusMaskSprite = maskSprite;
    } else if (maskSprite.texture !== maskTex) {
      try { maskSprite.texture = maskTex; } catch (_) {}
    }

    if (!maskSprite || !tiling) return;

    const placement = computeMaskPlacement(flags, w, h, maskTex);
    const refreshMaskPlacement = () => {
      try {
        maskSprite.scale.set(placement.scaleX || 1, placement.scaleY || 1);
        maskSprite.position.set(placement.offsetX || 0, placement.offsetY || 0);
        maskSprite.width = w;
        maskSprite.height = h;
      } catch (_) {}
      try { tiling.tint = solidTint !== null ? solidTint : 0xFFFFFF; } catch (_) {}
    };

    refreshMaskPlacement();
    applyBaseTilingOffset(tiling, tile, flags);
    try {
      if (typeof tiling._refresh === 'function') tiling._refresh();
      else if (tiling.uvMatrix) tiling.uvMatrix.update();
    } catch (_) {}

    container.faNexusMaskSprite = maskSprite;
    container.faNexusTilingSprite = tiling;
    maskSprite.faNexusMaskGeometry = arrayMask && tile.document.getFlag('fa-nexus', 'buildingFill')?.wallTileId
      ? buildMaskHitGeometry(maskData?.shapes, w, h) : null;
    container.faNexusMaskTexture = maskTex;
    syncOwnedMaskTexture(container, maskTex, ownsMaskTex);
    container.faNexusBaseTexture = baseTex;
    container.faNexusMaskSrc = maskKey;
    container.faNexusBaseSrc = flags.baseSrc;
    applyHsbcToDisplayObject(
      tiling,
      tile?.document
        ? readDocumentHsbc(tile.document, { nullIfMissing: true, nullIfNeutral: true })
        : null,
      { slot: 'masked-tiling' }
    );
    applyMaskedTextureBlendMode(tiling, flags?.blendMode, {
      logger: Logger,
      logTag: 'TextureRender.maskedTiling.blendMode.invalid'
    });

    if (arrayMask && previousMaskTex && previousMaskTex !== maskTex) {
      try { previousMaskTex.destroy(true); } catch (_) {}
    }

    tiling.mask = maskSprite;
    try { maskSprite.renderable = false; } catch (_) {}

    syncMaskedContainerTransform(container, mesh, w, h, tile.document);
    syncMeshBoundContainerDisplayState(container, mesh, tile.document);

    try { mesh.faNexusMaskReady = true; } catch (_) {}
    if (shouldUseMaskedTileOverhead(tile)) {
      attachCustomTileOverhead(tile, {
        kind: MASKED_OVERHEAD_KIND,
        contentContainer: container,
        proxyFactory: createMaskedProxyFactory(container),
        filterMode: 'leaf',
        refreshReason: 'masked-refresh',
        contentKey: overheadContentKey(tile.document, maskKey, maskTex, w, h, [placement.scaleX, placement.scaleY, placement.offsetX, placement.offsetY]),
        syncContent: ({ mesh: currentMesh, entry }) => {
          syncMaskedContainerTransform(entry?.contentContainer, currentMesh, w, h, tile.document);
          syncMeshBoundContainerDisplayState(entry?.contentContainer, currentMesh, tile.document);
        }
      });
    } else {
      detachCustomTileOverhead(tile, { kind: MASKED_OVERHEAD_KIND });
    }
  } catch (error) {
    if (isTextureCleanupFailure(error)) {
      Logger.error('TextureRender.apply.staleCleanupFailed', {
        tileId: tile?.document?.id,
        error: String(error?.message || error),
        failures: error?.errors?.length || 0
      });
      throw error;
    }
    if (applyToken && !isCurrentTileApply(tile, applyToken)) return;
    Logger.warn('TextureRender.apply.failed', String(error?.message || error));
    if (compositeRequested) {
      clearMaskedTilingOverlay(tile, { preserveTexture: true });
      if (tile?.mesh) tile.mesh.faNexusMaskReady = false;
      scheduleMaskedTileRetry(tile, applyMaskedTilingToTile);
      return;
    }
    try {
      const cont = tile?.mesh?.faNexusMaskContainer || tile?.faNexusMaskContainer;
      const invalid = cont && (!isTextureUsable(cont.faNexusBaseTexture) || !isTextureUsable(cont.faNexusMaskTexture));
      if (invalid) {
        if (tile) clearMaskedOverlaysOnDelete(tile);
      }
    } catch (_) {}
  } finally {
    if (hidePreview) releasePreviewVisibility(tile, previewVisibilityToken);
  }
}

function getReusableStandardMaskTextures(tile, flags, baseSrc) {
  try {
    const mesh = tile?.mesh;
    if (!mesh) return null;
    const container = mesh.faNexusStandardMaskContainer;
    if (!container) return null;
    if (container.faNexusPreviewMirror) return null;
    const maskTex = container.faNexusMaskTexture;
    const expectedMask = resolveMaskKey(flags);
    if (container.faNexusBaseSrc !== baseSrc) return null;
    if (container.faNexusMaskSrc !== expectedMask) return null;
    const baseKind = container.faNexusBaseKind || 'sprite';
    if (baseKind === 'custom-render') {
      const display = container.faNexusBaseDisplayObject || null;
      if (!display || display.destroyed) return null;
    } else if (baseKind !== 'flattened-chunks' && !isTextureUsable(container.faNexusBaseTexture)) return null;
    if (!isTextureUsable(maskTex)) return null;
    if (isArrayMask(flags) && maskTex) {
      const maxTex = getMaxTextureSize();
      const texW = Number(maskTex?.baseTexture?.realWidth || maskTex?.width || 0);
      const texH = Number(maskTex?.baseTexture?.realHeight || maskTex?.height || 0);
      if ((Number.isFinite(texW) && texW > maxTex) || (Number.isFinite(texH) && texH > maxTex)) return null;
    }
    return {
      baseTex: container.faNexusBaseTexture,
      maskTex,
      ready: !!mesh.faNexusStandardMaskReady
    };
  } catch (_) {
    return null;
  }
}

function destroyStandardBaseDisplay(container, content = null) {
  try {
    const display = container?.faNexusBaseDisplayObject || container?.faNexusBaseSprite || null;
    if (!display || display.destroyed) return;
    try {
      const parent = display.parent || content || null;
      parent?.removeChild?.(display);
    } catch (_) {}
    try { display.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
  } catch (_) {}
  try { if (container) container.faNexusBaseDisplayObject = null; } catch (_) {}
  try { if (container) container.faNexusBaseSprite = null; } catch (_) {}
  try { if (container) container.faNexusBaseKind = null; } catch (_) {}
  try { if (container) container.faNexusBaseChunkKey = null; } catch (_) {}
  try { if (container) container.faNexusBaseCustomKey = null; } catch (_) {}
  try { if (container) container.faNexusBaseTexture = null; } catch (_) {}
}

function ensureSpriteStandardBaseDisplay(content, container, baseTex, width, height) {
  let baseSprite = container?.faNexusBaseSprite || null;
  const baseDisplay = container?.faNexusBaseDisplayObject || null;
  const needsReset = !baseSprite
    || baseSprite.destroyed
    || container?.faNexusBaseKind !== 'sprite'
    || (baseDisplay && baseDisplay !== baseSprite);
  if (needsReset) {
    destroyStandardBaseDisplay(container, content);
    baseSprite = new PIXI.Sprite(baseTex);
    baseSprite.eventMode = 'none';
    content.addChildAt(baseSprite, 0);
    container.faNexusBaseDisplayObject = baseSprite;
    container.faNexusBaseSprite = baseSprite;
    container.faNexusBaseKind = 'sprite';
  } else if (baseSprite.parent !== content) {
    content.addChildAt(baseSprite, 0);
  }
  if (baseSprite.texture !== baseTex) {
    try { baseSprite.texture = baseTex; } catch (_) {}
  }
  try {
    baseSprite.position.set(0, 0);
    baseSprite.width = width;
    baseSprite.height = height;
    baseSprite.alpha = 1;
    baseSprite.tint = 0xFFFFFF;
  } catch (_) {}
  try { container.faNexusBaseChunkKey = null; } catch (_) {}
  try { container.faNexusBaseCustomKey = null; } catch (_) {}
  return baseSprite;
}

function canReuseChunkedStandardBaseDisplay(container, chunkKey) {
  const baseDisplay = container?.faNexusBaseDisplayObject || null;
  return !!(
    baseDisplay
    && !baseDisplay.destroyed
    && container?.faNexusBaseKind === 'flattened-chunks'
    && !(baseDisplay instanceof PIXI.Sprite)
    && container?.faNexusBaseChunkKey === chunkKey
  );
}

async function prepareChunkedStandardBaseSprites(chunkEntries, tileId = null) {
  const results = await Promise.all(chunkEntries.map(async (chunk) => {
    try {
      const texture = await loadTexture(chunk.src, { attempts: 3, timeout: 6000 });
      return { chunk, texture };
    } catch (error) {
      Logger.error('TextureRender.standardTileMask.chunkTextureLoadFailed', {
        tileId,
        src: chunk?.src || null,
        error: String(error?.message || error)
      });
      return null;
    }
  }));

  const nextSprites = [];
  for (const result of results) {
    if (!result?.texture) continue;
    const { chunk, texture } = result;
    const sprite = new PIXI.Sprite(texture);
    sprite.eventMode = 'none';
    sprite.position.set(Number(chunk?.x) || 0, Number(chunk?.y) || 0);
    sprite.width = Number(chunk?.width) || 1;
    sprite.height = Number(chunk?.height) || 1;
    nextSprites.push(sprite);
  }

  if (!nextSprites.length) {
    Logger.error('TextureRender.standardTileMask.chunkBaseMissing', {
      tileId,
      chunks: Array.isArray(chunkEntries) ? chunkEntries.length : 0
    });
    throw new Error('Chunked flattened tile did not produce any standard mask base sprites');
  }
  return nextSprites;
}

function destroyPreparedStandardBaseSprites(sprites) {
  return destroyOwnedTextureResources({
    displayObjects: sprites || [],
    context: 'Prepared Standard Mask base sprite cleanup'
  });
}

function ensureChunkedStandardBaseDisplay(content, container, nextSprites, chunkKey, tileId = null) {
  let baseDisplay = container?.faNexusBaseDisplayObject || null;
  const needsReset = !baseDisplay
    || baseDisplay.destroyed
    || container?.faNexusBaseKind !== 'flattened-chunks'
    || (baseDisplay instanceof PIXI.Sprite);
  if (needsReset) {
    destroyStandardBaseDisplay(container, content);
    baseDisplay = new PIXI.Container();
    baseDisplay.eventMode = 'none';
    baseDisplay.sortableChildren = false;
    content.addChildAt(baseDisplay, 0);
    container.faNexusBaseDisplayObject = baseDisplay;
    container.faNexusBaseSprite = null;
    container.faNexusBaseKind = 'flattened-chunks';
  } else if (baseDisplay.parent !== content) {
    content.addChildAt(baseDisplay, 0);
  }

  if (container?.faNexusBaseChunkKey === chunkKey) return baseDisplay;
  if (!Array.isArray(nextSprites) || !nextSprites.length) {
    throw new Error('Prepared chunk sprites are required before committing a standard mask base');
  }

  const prevChildren = baseDisplay.children?.slice() || [];
  try { baseDisplay.removeChildren(); } catch (_) {}
  for (const child of prevChildren) {
    try { child.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
  }
  for (const sprite of nextSprites) {
    baseDisplay.addChild(sprite);
  }

  try { container.faNexusBaseChunkKey = chunkKey; } catch (_) {}
  Logger.info('TextureRender.standardTileMask.chunkBaseReady', {
    tileId,
    chunks: nextSprites.length
  });
  return baseDisplay;
}

function ensureCustomStandardBaseDisplay(content, container, tile, customBaseKey) {
  let baseDisplay = container?.faNexusBaseDisplayObject || null;
  const needsReset = !!tile?.isPreview
    || !baseDisplay
    || baseDisplay.destroyed
    || container?.faNexusBaseKind !== 'custom-render'
    || container?.faNexusBaseCustomKey !== customBaseKey;
  if (needsReset) {
    destroyStandardBaseDisplay(container, content);
    baseDisplay = createStandardMaskCustomBaseDisplay(tile);
    if (!baseDisplay || baseDisplay.destroyed) {
      Logger.error('TextureRender.standardTileMask.customBaseMissing', {
        tileId: tile?.document?.id || tile?.id || null,
        customBaseKey
      });
      try { syncStandardMaskCustomSourceSuppression(tile, false, 'standard-mask-custom-base-missing'); } catch (_) {}
      scheduleMaskedTileRetry(tile, applyStandardTileMaskToTile);
      throw new Error('Custom-rendered tile did not provide a standard mask base display');
    }
    content.addChildAt(baseDisplay, 0);
    container.faNexusBaseDisplayObject = baseDisplay;
    container.faNexusBaseSprite = null;
    container.faNexusBaseKind = 'custom-render';
  } else if (baseDisplay.parent !== content) {
    content.addChildAt(baseDisplay, 0);
  }

  try { container.faNexusBaseCustomKey = customBaseKey; } catch (_) {}
  try { container.faNexusBaseChunkKey = null; } catch (_) {}
  try { container.faNexusBaseTexture = null; } catch (_) {}
  return baseDisplay;
}

function ensureStandardMaskBaseDisplay({
  content,
  container,
  tile,
  baseTex,
  width,
  height,
  isCustomBase,
  customBaseKey,
  isChunkedBase,
  preparedChunkSprites,
  chunkBaseKey
}) {
  if (isCustomBase) {
    const baseDisplay = ensureCustomStandardBaseDisplay(content, container, tile, customBaseKey);
    container.faNexusBaseTexture = null;
    return baseDisplay;
  }
  if (isChunkedBase) {
    const baseDisplay = ensureChunkedStandardBaseDisplay(content, container, preparedChunkSprites, chunkBaseKey, tile?.document?.id || null);
    container.faNexusBaseTexture = null;
    return baseDisplay;
  }
  const baseSprite = ensureSpriteStandardBaseDisplay(content, container, baseTex, width, height);
  container.faNexusBaseTexture = baseTex;
  return baseSprite;
}

function customStandardBaseNeedsRetry(tile, customBaseKey) {
  const tileId = tile?.document?.id || tile?.id || null;
  const { sources, missing } = resolveStandardMaskCustomBaseSources(tile);
  if (sources.length && !missing.length) return false;
  Logger.debug?.('TextureRender.standardTileMask.customBaseNotReady', {
    tileId,
    customBaseKey,
    sources: sources.map((entry) => entry.kind),
    missing
  });
  try { syncStandardMaskCustomSourceSuppression(tile, false, 'standard-mask-custom-base-not-ready'); } catch (_) {}
  scheduleMaskedTileRetry(tile, applyStandardTileMaskToTile);
  return true;
}

export function clearStandardTileMaskOverlay(tile, options = {}) {
  const preserveTexture = !!options?.preserveTexture;
  try {
    if (!tile) return;
    syncStandardMaskCustomSourceSuppression(tile, false, 'standard-mask-clear');
    const mesh = tile.mesh;
    const container = mesh?.faNexusStandardMaskContainer || tile.faNexusStandardMaskContainer;
    detachCustomTileOverhead(tile, { kind: STANDARD_MASK_OVERHEAD_KIND });
    if (container) {
      const previousMaskTex = container.faNexusMaskTexture || null;
      const destroyMaskTexture = isArrayMask(tile?.document?.getFlag?.('fa-nexus', STANDARD_TILE_MASK_FLAG))
        && previousMaskTex
        && !previousMaskTex.destroyed;
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy({ children: true }); } catch (_) {}
      if (destroyMaskTexture) {
        try { previousMaskTex.destroy(true); } catch (_) {}
      }
    }
    if (mesh) {
      mesh.faNexusStandardMaskContainer = null;
      mesh.faNexusStandardMaskReady = false;
      if (!preserveTexture && mesh[STANDARD_TILE_MASK_ORIGINAL_TEXTURE_KEY]) {
        if (mesh.faNexusMaskContainer || tile?.faNexusMaskContainer) {
          Logger.debug('TextureRender.standardTileMask.cleanup.restoreBlockedByMaskedTiling', {
            tileId: tile?.document?.id || tile?.id || null
          });
        } else {
          restoreMeshTexture(mesh, STANDARD_TILE_MASK_ORIGINAL_TEXTURE_KEY);
        }
      }
    }
    tile.faNexusStandardMaskContainer = null;
  } catch (_) {}
}

function resolveStandardMaskTarget(target) {
  const doc = target?.document || target || null;
  const tile = target?.document
    ? target
    : (doc?.object || canvas?.tiles?.placeables?.find?.((entry) => entry?.document?.id === doc?.id) || null);
  return { doc, tile };
}

export async function clearStandardTileMask(target, options = {}) {
  const { doc, tile } = resolveStandardMaskTarget(target);
  if (!doc) throw new Error('Unable to resolve tile document for mask clearing.');
  invalidateTileApply(tile, 'standard-tile-mask');
  const tileId = doc?.id || tile?.id || null;
  const hadFlag = !!doc?.getFlag?.('fa-nexus', STANDARD_TILE_MASK_FLAG);
  const hadOverlay = !!(tile?.mesh?.faNexusStandardMaskContainer || tile?.faNexusStandardMaskContainer);
  Logger.info('TextureRender.standardTileMask.clear.begin', {
    tileId,
    reason: String(options?.reason || 'manual'),
    hadFlag,
    hadOverlay
  });

  if (hadFlag && typeof doc.unsetFlag === 'function') {
    await doc.unsetFlag('fa-nexus', STANDARD_TILE_MASK_FLAG);
  } else if (hadFlag && typeof doc.update === 'function') {
    await doc.update({ [`flags.fa-nexus.-=${STANDARD_TILE_MASK_FLAG}`]: null });
  }
  if (tile) {
    clearStandardTileMaskOverlay(tile);
    try { tile.mesh?.clear?.(); } catch (_) {}
    try { tile.refresh?.(); } catch (_) {}
    try { tile.renderFlags?.set?.({ refresh: true }); } catch (_) {}
  }
  clearMaskedTileRetry(tile);
  Logger.info('TextureRender.standardTileMask.clear.done', {
    tileId,
    cleared: hadFlag || hadOverlay
  });
  return hadFlag || hadOverlay;
}

export async function applyStandardTileMaskToTile(tile) {
  let hidePreview = false;
  let previewVisibilityToken = null;
  let applyToken = null;
  try {
    if (!tile || !tile.document) return;
    applyToken = beginTileApply(tile, 'standard-tile-mask');
    const editing = isEditingTile(tile);
    const flags = tile.document.getFlag('fa-nexus', STANDARD_TILE_MASK_FLAG);
    const arrayMask = isArrayMask(flags);
    const chunkEntries = getFlattenedChunkEntries(tile.document);
    const chunkBaseKey = buildFlattenedChunkKey(chunkEntries);
    const isChunkedBase = !!chunkBaseKey;
    const customBaseKey = getStandardMaskCustomBaseKey(tile);
    const isCustomBase = !!customBaseKey;
    const src = String(tile.document?.texture?.src || '').trim();

    if (editing) {
      clearStandardTileMaskOverlay(tile, { preserveTexture: true });
      clearMaskedTileRetry(tile);
      const mesh = await prepareCustomTileRendererMesh(tile, {
        originalTextureSlotKey: STANDARD_TILE_MASK_ORIGINAL_TEXTURE_KEY
      });
      if (!isCurrentTileApply(tile, applyToken)) return;
      if (mesh && !mesh.destroyed) {
        try { mesh.alpha = 0; } catch (_) {}
      }
      return;
    }

    if (!flags || (!flags.maskSrc && !arrayMask) || (!src && !isChunkedBase && !isCustomBase)) {
      clearStandardTileMaskOverlay(tile);
      clearMaskedTileRetry(tile);
      return;
    }
    if (!isCustomBase && /\.(webm|mp4)$/i.test(src)) {
      Logger.error('TextureRender.applyStandardTileMaskToTile.unsupportedVideo', {
        tileId: tile?.document?.id,
        src
      });
      clearStandardTileMaskOverlay(tile);
      clearMaskedTileRetry(tile);
      return;
    }

    const mesh = await prepareCustomTileRendererMesh(tile, {
      originalTextureSlotKey: STANDARD_TILE_MASK_ORIGINAL_TEXTURE_KEY
    });
    if (!isCurrentTileApply(tile, applyToken)) return;
    if (!mesh || mesh.destroyed) {
      scheduleMaskedTileRetry(tile, applyStandardTileMaskToTile);
      return;
    }

    if (isCustomBase && customStandardBaseNeedsRetry(tile, customBaseKey)) return;
    clearMaskedTileRetry(tile);

    if (tile?.isPreview && !isCustomBase) {
      const originalContainer = tile?._original?.mesh?.faNexusStandardMaskContainer
        || tile?._original?.faNexusStandardMaskContainer
        || null;
      const mirrored = mirrorMaskedPreviewContainer(tile, {
        sourceContainer: originalContainer,
        containerKey: 'faNexusStandardMaskContainer',
        readyKey: 'faNexusStandardMaskReady',
        slotKey: STANDARD_TILE_MASK_ORIGINAL_TEXTURE_KEY,
        overheadKind: STANDARD_MASK_OVERHEAD_KIND,
        syncTransform: (containerRef, meshRef, docRef) => {
          syncStandardMaskNativeContainerTransform(containerRef, meshRef, docRef);
        },
        logTag: 'TextureRender.applyStandardTileMaskToTile.previewMirrorFailed'
      });
      if (mirrored) return;
    }

    const meshWidth = Number(mesh?.width);
    const meshHeight = Number(mesh?.height);
    const docWidth = Number(tile?.document?.width);
    const docHeight = Number(tile?.document?.height);
    const w = Math.max(2, Number.isFinite(docWidth) && docWidth > 0 ? docWidth : (Number.isFinite(meshWidth) && meshWidth > 0 ? meshWidth : 2));
    const h = Math.max(2, Number.isFinite(docHeight) && docHeight > 0 ? docHeight : (Number.isFinite(meshHeight) && meshHeight > 0 ? meshHeight : 2));
    const baseSrc = isCustomBase ? customBaseKey : (isChunkedBase ? `flattened-chunks:${chunkBaseKey}` : encodeTexturePath(src));
    const maskData = arrayMask ? getMaskShapeData(flags) : null;
    const reuse = getReusableStandardMaskTextures(tile, flags, baseSrc);

    hidePreview = (!reuse || !reuse.ready) && tile?.isPreview;
    if (hidePreview) previewVisibilityToken = suppressPreviewVisibility(tile, applyToken);

    let baseTex = reuse?.baseTex || null;
    let maskTex = reuse?.maskTex || null;
    let ownsMaskTex = false;
    try {
      if (!isChunkedBase && !isCustomBase && !baseTex) baseTex = await loadTexture(baseSrc);
      if (!maskTex) {
        if (arrayMask) {
          maskTex = buildMaskTextureFromShapes(maskData?.shapes, w, h);
          ownsMaskTex = !!maskTex;
          if (!maskTex) throw new Error('Tile mask shape render failed');
        } else {
          maskTex = await loadTexture(flags.maskSrc);
        }
      }
      if (!isCurrentTileApply(tile, applyToken)) {
        destroyOwnedTextureResources({
          textures: ownsMaskTex ? [maskTex] : [],
          context: 'Stale Standard Mask texture cleanup'
        });
        return;
      }
    } catch (texErr) {
      if (isTextureCleanupFailure(texErr)) throw texErr;
      if (!isCurrentTileApply(tile, applyToken)) return;
      Logger.error('TextureRender.applyStandardTileMaskToTile.textureLoadFailed', {
        tileId: tile?.document?.id,
        error: String(texErr?.message || texErr),
        src: baseSrc,
        maskSrc: flags?.maskSrc || null
      });
      syncStandardMaskCustomSourceSuppression(tile, false, 'standard-mask-texture-load-failed');
      scheduleMaskedTileRetry(tile, applyStandardTileMaskToTile);
      return;
    }
    if (!isChunkedBase && !isCustomBase && !isTextureUsable(baseTex)) throw new Error('Standard tile base texture invalid');
    if (!isTextureUsable(maskTex)) throw new Error('Tile mask texture invalid');

    let preparedChunkSprites = null;
    const existingContainer = mesh.faNexusStandardMaskContainer || tile.faNexusStandardMaskContainer || null;
    if (isChunkedBase && !canReuseChunkedStandardBaseDisplay(existingContainer, chunkBaseKey)) {
      preparedChunkSprites = await prepareChunkedStandardBaseSprites(chunkEntries, tile?.document?.id || null);
      if (!isCurrentTileApply(tile, applyToken)) {
        destroyOwnedTextureResources({
          displayObjects: preparedChunkSprites || [],
          textures: ownsMaskTex ? [maskTex] : [],
          context: 'Stale Standard Mask prepared resource cleanup'
        });
        return;
      }
    }

    let container = mesh.faNexusStandardMaskContainer;
    if (!container || container.destroyed) {
      container = new PIXI.Container();
      container.eventMode = 'none';
      container.sortableChildren = false;
      mesh.faNexusStandardMaskContainer = container;
      tile.faNexusStandardMaskContainer = container;
      mesh.addChild(container);
    } else {
      mesh.faNexusStandardMaskContainer = container;
      tile.faNexusStandardMaskContainer = container;
      if (!container.parent) mesh.addChild(container);
    }
    const previousMaskTex = container.faNexusMaskTexture || null;

    let content = container.faNexusContentContainer || null;
    if (!content || content.destroyed) {
      content = new PIXI.Container();
      content.eventMode = 'none';
      content.sortableChildren = false;
      container.addChild(content);
      container.faNexusContentContainer = content;
    }

    let maskSprite = container.faNexusMaskSprite || null;
    const baseDisplay = ensureStandardMaskBaseDisplay({
      content,
      container,
      tile,
      baseTex,
      width: w,
      height: h,
      isCustomBase,
      customBaseKey,
      isChunkedBase,
      preparedChunkSprites,
      chunkBaseKey
    });

    if (!maskSprite || maskSprite.destroyed) {
      maskSprite = new PIXI.Sprite(maskTex);
      maskSprite.eventMode = 'none';
      content.addChild(maskSprite);
    } else if (maskSprite.texture !== maskTex) {
      try { maskSprite.texture = maskTex; } catch (_) {}
    }
    container.faNexusMaskSprite = maskSprite;
    for (const child of Array.from(content.children || [])) {
      if (!child || child === baseDisplay || child === maskSprite) continue;
      try { content.removeChild(child); } catch (_) {}
      try { child.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
    }
    const placement = computeMaskPlacement(flags, w, h, maskTex);
    try {
      maskSprite.position.set(placement.offsetX || 0, placement.offsetY || 0);
      maskSprite.scale.set(placement.scaleX || 1, placement.scaleY || 1);
      maskSprite.alpha = 1;
      maskSprite.visible = true;
      maskSprite.renderable = false;
    } catch (_) {}

    try { if (baseDisplay) baseDisplay.mask = maskSprite; } catch (_) {}

    container.faNexusMaskTexture = maskTex;
    syncOwnedMaskTexture(container, maskTex, ownsMaskTex);
    container.faNexusBaseDisplayObject = baseDisplay;
    container.faNexusMaskSrc = resolveMaskKey(flags);
    container.faNexusBaseSrc = baseSrc;
    container.faNexusMaskFlagKey = STANDARD_TILE_MASK_FLAG;
    container.faNexusWidth = w;
    container.faNexusHeight = h;

    if (!isCustomBase) {
      applyHsbcToDisplayObject(
        baseDisplay,
        tile?.document
          ? readDocumentHsbc(tile.document, { nullIfMissing: true, nullIfNeutral: true })
          : null,
        { slot: 'standard-tile-mask' }
      );
    }

    if (arrayMask && previousMaskTex && previousMaskTex !== maskTex) {
      try { previousMaskTex.destroy(true); } catch (_) {}
    }

    syncStandardMaskContainerTransform(container, mesh, w, h, tile.document);
    syncMeshBoundContainerDisplayState(container, mesh, tile.document);
    syncStandardMaskCustomSourceSuppression(tile, isCustomBase, 'standard-mask-ready');

    try { mesh.faNexusStandardMaskReady = true; } catch (_) {}
    if (shouldUseMaskedTileOverhead(tile)) {
      attachCustomTileOverhead(tile, {
        kind: STANDARD_MASK_OVERHEAD_KIND,
        contentContainer: container,
        proxyFactory: () => cloneDisplayObjectForProxy(container),
        filterMode: 'container',
        refreshReason: 'standard-mask-refresh',
        contentKey: overheadContentKey(tile.document, container.faNexusMaskSrc, maskTex, w, h, [baseSrc, isCustomBase]),
        syncContent: ({ mesh: currentMesh, entry }) => {
          syncStandardMaskNativeContainerTransform(entry?.contentContainer, currentMesh, tile.document);
        }
      });
    } else {
      detachCustomTileOverhead(tile, { kind: STANDARD_MASK_OVERHEAD_KIND });
    }
  } catch (error) {
    if (isTextureCleanupFailure(error)) {
      Logger.error('TextureRender.applyStandardTileMaskToTile.staleCleanupFailed', {
        tileId: tile?.document?.id,
        error: String(error?.message || error),
        failures: error?.errors?.length || 0
      });
      throw error;
    }
    if (applyToken && !isCurrentTileApply(tile, applyToken)) return;
    Logger.error('TextureRender.applyStandardTileMaskToTile.failed', {
      tileId: tile?.document?.id,
      error: String(error?.message || error)
    });
    try { syncStandardMaskCustomSourceSuppression(tile, false, 'standard-mask-failed'); } catch (_) {}
    try {
      const cont = tile?.mesh?.faNexusStandardMaskContainer || tile?.faNexusStandardMaskContainer;
      const baseKind = cont?.faNexusBaseKind || 'sprite';
      const invalidBase = baseKind === 'flattened-chunks'
        ? !(cont?.faNexusBaseDisplayObject && !cont.faNexusBaseDisplayObject.destroyed)
        : baseKind === 'custom-render'
          ? !(cont?.faNexusBaseDisplayObject && !cont.faNexusBaseDisplayObject.destroyed)
        : !isTextureUsable(cont?.faNexusBaseTexture);
      const invalid = cont && (invalidBase || !isTextureUsable(cont?.faNexusMaskTexture));
      if (invalid) clearStandardTileMaskOverlay(tile);
    } catch (_) {}
  } finally {
    if (hidePreview) releasePreviewVisibility(tile, previewVisibilityToken);
  }
}

function getReusableTextures(tile, flags) {
  try {
    const mesh = tile?.mesh;
    if (!mesh) return null;
    const container = mesh.faNexusMaskContainer;
    if (!container) return null;
    if (container.faNexusPreviewMirror) return null;
    const baseSrc = container.faNexusBaseSrc;
    const maskSrc = container.faNexusMaskSrc;
    const maskTex = container.faNexusMaskTexture;
    const expectedMask = resolveMaskKey(flags);
    if (baseSrc === flags.baseSrc && maskSrc === expectedMask) {
      if (!isTextureUsable(container.faNexusBaseTexture) || !isTextureUsable(maskTex)) return null;
      if (isArrayMask(flags) && maskTex) {
        const maxTex = getMaxTextureSize();
        const texW = Number(maskTex?.baseTexture?.realWidth || maskTex?.width || 0);
        const texH = Number(maskTex?.baseTexture?.realHeight || maskTex?.height || 0);
        if ((Number.isFinite(texW) && texW > maxTex) || (Number.isFinite(texH) && texH > maxTex)) {
          return null;
        }
      }
      return {
        baseTex: container.faNexusBaseTexture,
        maskTex,
        ready: !!mesh.faNexusMaskReady
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

function getPreviewSourceTextures(tile, flags) {
  try {
    const sourceMesh = tile?._original?.mesh || null;
    const container = sourceMesh?.faNexusMaskContainer || tile?._original?.faNexusMaskContainer || null;
    if (!container || container.destroyed) return null;
    const baseTex = container.faNexusBaseTexture || null;
    if (container.faNexusBaseSrc !== flags?.baseSrc || !isTextureUsable(baseTex)) return null;
    if (isArrayMask(flags)) {
      return {
        baseTex,
        maskTex: null,
        ready: sourceMesh?.faNexusMaskReady === true
      };
    }
    const maskTex = container.faNexusMaskTexture || null;
    if (container.faNexusMaskSrc !== resolveMaskKey(flags) || !isTextureUsable(maskTex)) return null;
    return {
      baseTex,
      maskTex,
      ready: sourceMesh?.faNexusMaskReady === true
    };
  } catch (_) {
    return null;
  }
}

export function rehydrateAllMaskedTiles(options = {}) {
  try {
    if (!canvas?.ready) return;
    const state = REHYDRATE_STATE || (REHYDRATE_STATE = {
      remaining: Math.max(1, Number(options?.attempts) || 1),
      interval: Math.max(50, Number(options?.interval) || 200),
      timer: null,
      cancelled: false,
      tiles: new Set()
    });

    const addAttempts = Math.max(0, Number(options?.attempts ?? 0));
    state.remaining = Math.max(state.remaining, addAttempts);
    if (Number.isFinite(options?.interval) && options.interval > 0) state.interval = Math.max(50, options.interval);
    if (state.timer) return;

    const run = async () => {
      state.timer = null;
      try {
        if (state.cancelled || !canvas || !canvas.ready) {
          if (REHYDRATE_STATE === state) REHYDRATE_STATE = null;
          return;
        }
        const tiles = Array.isArray(canvas.tiles?.placeables) ? canvas.tiles.placeables : [];
        const jobs = [];
        for (const tile of tiles) {
          try {
            const hasMaskedTiling = !!tile?.document?.getFlag?.('fa-nexus', MASKED_TILING_FLAG);
            const hasStandardTileMask = !!tile?.document?.getFlag?.('fa-nexus', STANDARD_TILE_MASK_FLAG);
            if (!hasMaskedTiling && !hasStandardTileMask) continue;
            state.tiles.add(tile);
            if (hasMaskedTiling) jobs.push(applyMaskedTilingToTile(tile));
            if (hasStandardTileMask) jobs.push(applyStandardTileMaskToTile(tile));
          } catch (_) {}
        }
        if (jobs.length) await Promise.allSettled(jobs);
      } catch (_) {}
      if (!state.cancelled && REHYDRATE_STATE === state) {
        state.remaining = Math.max(0, (state.remaining || 0) - 1);
        if (state.remaining > 0) {
          state.timer = setTimeout(run, state.interval);
        } else {
          REHYDRATE_STATE = null;
        }
      }
    };

    state.remaining = Math.max(1, state.remaining || 1);
    state.timer = setTimeout(run, 0);
  } catch (_) {}
}

export function rehydrateAllStandardTileMasks(options = {}) {
  return rehydrateAllMaskedTiles(options);
}

export function cancelGlobalRehydrate() {
  const state = REHYDRATE_STATE;
  if (!state) return;
  state.cancelled = true;
  if (state.timer) clearTimeout(state.timer);
  for (const tile of state.tiles || []) cancelTileApplies(tile);
  REHYDRATE_STATE = null;
}

export function clearMaskedOverlaysOnDelete(tile) {
  try {
    if (!tile) return;
    cancelTileApplies(tile);
    const mesh = tile.mesh;
    const container = mesh?.faNexusMaskContainer || tile.faNexusMaskContainer;
    detachCustomTileOverhead(tile, { kind: MASKED_OVERHEAD_KIND });
    if (container) {
      if (container.faNexusCompositeRegions) destroyCompositeFillResources(container);
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy({ children: true }); } catch (_) {}
    }
    if (mesh) {
      mesh.faNexusMaskContainer = null;
      mesh.faNexusMaskReady = false;
      if (mesh[MASKED_TILING_ORIGINAL_TEXTURE_KEY]) restoreMeshTexture(mesh, MASKED_TILING_ORIGINAL_TEXTURE_KEY);
      if (mesh[STANDARD_TILE_MASK_ORIGINAL_TEXTURE_KEY]) restoreMeshTexture(mesh, STANDARD_TILE_MASK_ORIGINAL_TEXTURE_KEY);
      if (mesh[LEGACY_ORIGINAL_TEXTURE_KEY]) restoreMeshTexture(mesh, LEGACY_ORIGINAL_TEXTURE_KEY);
    }
    if (tile) tile.faNexusMaskContainer = null;
    clearMaskedTileRetry(tile);
  } catch (error) { if (isTextureCleanupFailure(error)) throw error; }
  try {
    clearStandardTileMaskOverlay(tile);
  } catch (_) {}
}
