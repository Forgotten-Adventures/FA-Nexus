import { onFoundryBoot } from '../core/foundry-boot-hooks.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { gatherBuildingLoops } from '../buildings/building-shape-helpers.js';
import { applyHsbcToDisplayObject } from '../core/hsbc.js';
import { DoorVisualProxyManager } from './door-visual-proxy-manager.js';
import {
  getSmallAnimatedWindowTexturePadding,
  isSmallAnimatedWindowDocument
} from './small-animated-window-texture.js';
import {
  DoorSceneLifecycleOwner,
  getActiveDoorSceneId,
  getDoorDocumentSceneId
} from './door-scene-lifecycle-owner.js';

const SHADOW_BLUR_QUALITY_MIN = 3;
const SHADOW_BLUR_QUALITY_STEP = 4;
const SHADOW_BLUR_QUALITY_MAX = 9;
const FALLBACK_ALPHA = 0.65;
const FALLBACK_BLUR = 1.8;
const FALLBACK_DILATION = 1.6;
const FALLBACK_OFFSET = 0;
// Offset should allow the same range as wall/path shadows (up to ±5 grid @ 200px grid ≈ 1000px).
const MAX_OFFSET_DISTANCE = 1200;
const SORT_EPSILON = 0.0001;
const RENDER_TEXTURE_FALLBACK_WARN_MS = 5000;
const TRANSITION_PENDING_BUILD_WAIT_MS = 750;
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

let _singleton = null;
const _VISIBLE_CACHE = new Map();
const _OFFSET_CACHE = new Map();
const _TILE_HOLE_CACHE = new Map(); // tileId -> { holes, stamp }
const _MESH_ELEVATION_WARNED = new Set();

function sleep(ms = 50) {
  if (foundry?.utils?.sleep) return foundry.utils.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasNoVisibleDoorMeshes(doc) {
  if (doc?.viewed !== false) return false;
  const proxies = DoorVisualProxyManager.peek();
  // A hidden Level has no native mesh. The proxy owner decides whether any
  // other visible Level requires one; a pending required proxy is not ready.
  return proxies?.isDoorVisualReady(doc.id, doc) === true
    && proxies.getDoorMeshes(doc.id).length === 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

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

function createDoorShadowOcclusionFilter() {
  const FilterClass = globalThis.PIXI?.Filter;
  if (!FilterClass) return null;
  return new FilterClass(undefined, SHADOW_OCCLUSION_FRAGMENT_SHADER, {
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
}

function hasActiveOcclusionState(mesh) {
  const mode = Number(mesh?.occlusionMode ?? 0) || 0;
  if (!mode) return false;
  const state = mesh?._occlusionState || {};
  return !!(
    clampUnit(state.fade, 0)
    || clampUnit(state.radial, 0)
    || clampUnit(state.vision, 0)
    || clampUnit(state.surface, 0)
  );
}

function computeBlurQuality(blur) {
  const numeric = Number(blur);
  if (!Number.isFinite(numeric)) return SHADOW_BLUR_QUALITY_MIN;
  const dynamic = SHADOW_BLUR_QUALITY_MIN + Math.floor(Math.abs(numeric) / SHADOW_BLUR_QUALITY_STEP);
  return Math.min(SHADOW_BLUR_QUALITY_MAX, Math.max(SHADOW_BLUR_QUALITY_MIN, dynamic));
}

function buildDoorShadowRenderSignature({
  baseTexture,
  baseScaleX,
  baseScaleY,
  anchorX,
  anchorY,
  rotation,
  dilation,
  blur,
  blurQuality,
  blurPadding,
  rendererResolution
}) {
  const textureBase = baseTexture?.baseTexture || null;
  const frame = baseTexture?.frame || null;
  const orig = baseTexture?.orig || null;
  const trim = baseTexture?.trim || null;
  return JSON.stringify([
    baseTexture?.uid ?? null,
    baseTexture?._updateID ?? null,
    textureBase?.uid ?? null,
    textureBase?._updateID ?? null,
    textureBase?.dirtyId ?? null,
    textureBase?.dirtyStyleId ?? null,
    baseTexture?.width ?? null,
    baseTexture?.height ?? null,
    textureBase?.width ?? null,
    textureBase?.height ?? null,
    frame?.x ?? null,
    frame?.y ?? null,
    frame?.width ?? null,
    frame?.height ?? null,
    orig?.width ?? null,
    orig?.height ?? null,
    trim?.x ?? null,
    trim?.y ?? null,
    trim?.width ?? null,
    trim?.height ?? null,
    baseScaleX,
    baseScaleY,
    anchorX,
    anchorY,
    rotation,
    dilation,
    blur,
    blurQuality,
    blurPadding,
    rendererResolution
  ]);
}

function isDoorShadowRenderTextureMissingOrStale(sub, rendererResolution) {
  return !sub.renderTexture
    || sub.renderTexture.destroyed
    || !sub._renderTextureAnchor
    || !Number.isFinite(sub._renderTextureWidth)
    || !Number.isFinite(sub._renderTextureHeight)
    || sub._renderTextureResolution !== rendererResolution
    || sub.renderTexture.width !== sub._renderTextureWidth
    || sub.renderTexture.height !== sub._renderTextureHeight;
}

function _pointInPolygon(x, y, polygon = []) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = Number(polygon[i]?.x ?? polygon[i]?.[0]);
    const yi = Number(polygon[i]?.y ?? polygon[i]?.[1]);
    const xj = Number(polygon[j]?.x ?? polygon[j]?.[0]);
    const yj = Number(polygon[j]?.y ?? polygon[j]?.[1]);
    if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function _collectHolePolygonsForTile(tile) {
  try {
    const doc = tile?.document || tile;
    if (!doc) return [];
    const data = doc.getFlag?.('fa-nexus', 'building');
    if (!data) return [];
    const loops = gatherBuildingLoops(data) || [];
    return loops
      .filter((loop) => Array.isArray(loop) && loop.length >= 3 && Number.isInteger(loop?.faLoopRef?.holeIndex))
      .map((loop) => loop.map((pt) => ({ x: Number(pt?.x) || 0, y: Number(pt?.y) || 0 })));
  } catch (_) {
    return [];
  }
}

function getTileHolePolygons(tileId) {
  if (!tileId || !canvas?.tiles) return [];
  const tiles = canvas.tiles;
  const tile = tiles.get?.(tileId) || (Array.isArray(tiles.placeables) ? tiles.placeables.find((t) => t?.id === tileId) : null);
  if (!tile) return [];
  const stamp = (tile.document?.updateId ?? tile.document?._id ?? tile.document?.id ?? tile.id ?? '') + ':' +
    (tile.document?.delta?._lastChange ?? tile.document?.timestamp?.modified ?? tile.document?._stats?.modified ?? '');
  const cached = _TILE_HOLE_CACHE.get(tileId);
  if (cached && cached.stamp === stamp) return cached.holes;
  const holes = _collectHolePolygonsForTile(tile);
  _TILE_HOLE_CACHE.set(tileId, { holes, stamp });
  return holes;
}

function _getVisibleBounds(texture) {
  if (!texture || !texture.baseTexture || texture.baseTexture.resource?.source?.readyState === 2) return null;
  const key = texture.baseTexture.uid;
  if (key && _VISIBLE_CACHE.has(key)) return _VISIBLE_CACHE.get(key);
  try {
    const base = texture.baseTexture;
    const res = base.resource;
    const source = res?.source;
    const width = Math.max(1, Number(base.width) || 1);
    const height = Math.max(1, Number(base.height) || 1);
    if (!source || !width || !height) return null;
    const canvasEl = document.createElement('canvas');
    canvasEl.width = width;
    canvasEl.height = height;
    const ctx = canvasEl.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    const data = ctx.getImageData(0, 0, width, height).data;
    const alphaThreshold = 4;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > alphaThreshold) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return null;
    const bounds = {
      left: minX,
      right: maxX,
      top: minY,
      bottom: maxY,
      width: maxX - minX + 1,
      height: maxY - minY + 1
    };
    if (key) _VISIBLE_CACHE.set(key, bounds);
    return bounds;
  } catch (_) {
    return null;
  }
}

function _buildDilationOffsets(radius) {
  const r = Math.max(0, Number(radius) || 0);
  if (r < 0.5) return [{ x: 0, y: 0 }];
  const key = Math.round(r * 10);
  if (_OFFSET_CACHE.has(key)) return _OFFSET_CACHE.get(key);
  const steps = 16;
  const offsets = [{ x: 0, y: 0 }];
  for (let i = 0; i < steps; i++) {
    const angle = (Math.PI * 2 * i) / steps;
    offsets.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  }
  // Inner ring for smoother fill
  const inner = r * 0.55;
  if (inner >= 0.5) {
    for (let i = 0; i < steps; i++) {
      const angle = (Math.PI * 2 * i) / steps + (Math.PI / steps);
      offsets.push({ x: Math.cos(angle) * inner, y: Math.sin(angle) * inner });
    }
  }
  _OFFSET_CACHE.set(key, offsets);
  return offsets;
}

function normalizeShadowConfig(raw = {}) {
  if (!raw || raw.enabled === false) return null;
  const scale = clamp(Number(raw.scale ?? 1), 0.25, 4);
  const alpha = clamp(Number(raw.alpha ?? FALLBACK_ALPHA), 0, 1);
  const blur = Math.max(0, Number(raw.blur ?? FALLBACK_BLUR));
  const dilation = Math.max(0, Number(raw.dilation ?? FALLBACK_DILATION));
  const offset = clamp(Number(raw.offset ?? FALLBACK_OFFSET), -MAX_OFFSET_DISTANCE, MAX_OFFSET_DISTANCE);
  return { enabled: true, scale, alpha, blur, dilation, offset };
}

export function resolveDoorShadowRenderOrder(mesh) {
  const elevation = Number(mesh?.elevation);
  const sortLayer = Number(mesh?.sortLayer);
  const meshSort = Number(mesh?.sort);
  // Native Level foregrounds (and their DoorMeshes) use infinite elevation
  // when the corresponding Level boundary is unbounded.
  const validElevation = !Number.isNaN(elevation);
  // Native v14 Descend leaves use +Infinity while open. Preserve that sort
  // group and use PrimaryCanvasGroup's zIndex tie-break to stay below the leaf.
  if (meshSort === Infinity && validElevation && [sortLayer, Number(mesh?.zIndex)].every(Number.isFinite)) {
    return { elevation, sortLayer, sort: Infinity, zIndex: Number(mesh.zIndex) - SORT_EPSILON };
  }
  if (!validElevation || ![sortLayer, meshSort].every(Number.isFinite)) {
    throw new Error('Door shadow requires a valid owner mesh elevation and finite sort order.');
  }
  const sort = meshSort - SORT_EPSILON;
  return { elevation, sortLayer, sort, zIndex: sort };
}

function normalizeTrackedShadowConfig(raw = {}) {
  if (raw?.enabled === false) {
    return {
      enabled: false,
      scale: clamp(Number(raw.scale ?? 1), 0.25, 4),
      alpha: clamp(Number(raw.alpha ?? FALLBACK_ALPHA), 0, 1),
      blur: Math.max(0, Number(raw.blur ?? FALLBACK_BLUR)),
      dilation: Math.max(0, Number(raw.dilation ?? FALLBACK_DILATION)),
      offset: clamp(Number(raw.offset ?? FALLBACK_OFFSET), -MAX_OFFSET_DISTANCE, MAX_OFFSET_DISTANCE)
    };
  }
  return normalizeShadowConfig(raw || {});
}

function readPortalHsbc(doc) {
  const faFlags = doc?.flags?.['fa-nexus'] || null;
  const buildingDoor = doc?.getFlag?.('fa-nexus', 'buildingDoor') || faFlags?.buildingDoor || null;
  if (buildingDoor && typeof buildingDoor === 'object' && Object.prototype.hasOwnProperty.call(buildingDoor, 'hsbc')) {
    return buildingDoor.hsbc || null;
  }
  const buildingWindow = doc?.getFlag?.('fa-nexus', 'buildingWindow') || faFlags?.buildingWindow || null;
  if (buildingWindow && typeof buildingWindow === 'object' && Object.prototype.hasOwnProperty.call(buildingWindow, 'hsbc')) {
    return buildingWindow.hsbc || null;
  }
  return null;
}

function resolveDocumentElevation(doc) {
  try {
    const directElevation = doc?.elevation;
    if (Number.isFinite(directElevation)) return Number(directElevation);
  } catch (_) { /* ignore */ }
  try {
    const flagElevation = doc?.getFlag?.('fa-nexus', 'buildingWall')?.elevation;
    if (Number.isFinite(flagElevation)) return Number(flagElevation);
  } catch (_) { /* ignore */ }
  try {
    const coreElevation = doc?.getFlag?.('core', 'elevation');
    if (Number.isFinite(coreElevation)) return Number(coreElevation);
  } catch (_) { /* ignore */ }
  const fg = Number(canvas?.primary?.foreground?.elevation);
  return Number.isFinite(fg) ? fg - 1 : 0;
}

function resolveShadowRenderElevation(doc, mesh, fallback) {
  const meshElevation = Number(mesh?.elevation);
  if (!Number.isNaN(meshElevation)) return meshElevation;
  const fallbackElevation = Number(fallback);
  const wallId = doc?.id || null;
  const warningKey = wallId || mesh?.name || 'unknown';
  if (!_MESH_ELEVATION_WARNED.has(warningKey)) {
    _MESH_ELEVATION_WARNED.add(warningKey);
    Logger.warn?.('DoorShadow.meshElevation.invalid', {
      wallId,
      meshName: mesh?.name || null,
      meshElevation: mesh?.elevation ?? null,
      storedElevation: Number.isFinite(fallbackElevation) ? fallbackElevation : null
    });
  }
  if (Number.isFinite(fallbackElevation)) return fallbackElevation;
  return resolveDocumentElevation(doc);
}

function computeDoorOffsetDelta(doc, mesh, offset) {
  let dist = Number(offset) || 0;
  if (!dist) return { dx: 0, dy: 0 };

  try {
    const generatedNormal = doc?.flags?.['fa-nexus']?.buildingGenerated?.doorShadowNormal;
    if (generatedNormal && Number.isFinite(generatedNormal.x) && Number.isFinite(generatedNormal.y)) {
      const len = Math.hypot(generatedNormal.x, generatedNormal.y) || 1;
      return { dx: (generatedNormal.x / len) * dist, dy: (generatedNormal.y / len) * dist };
    }
    const isHole = !!doc?.flags?.['fa-nexus']?.buildingWall?.isHole;
    const hingeFlipped = !!doc?.flags?.['fa-nexus']?.buildingDoor?.directionFlip;
    if (isHole) dist *= -1;
    if (hingeFlipped) dist *= -1;
  } catch (_) { /* ignore */ }

  // Prefer stored surface normal from building wall flag
  try {
    const normal = doc?.flags?.['fa-nexus']?.buildingWall?.normal;
    if (normal && Number.isFinite(normal.x) && Number.isFinite(normal.y)) {
      const len = Math.hypot(normal.x, normal.y) || 1;
      const nx = normal.x / len;
      const ny = normal.y / len;
      return { dx: nx * dist, dy: ny * dist };
    }
  } catch (_) { /* ignore */ }

  try {
    const coords = doc?.c || doc?.coords || (Array.isArray(doc?.data?.c) ? doc.data.c : null);
    if (Array.isArray(coords) && coords.length >= 4) {
      const [x1, y1, x2, y2] = coords.map((n) => Number(n));
      if ([x1, y1, x2, y2].every(Number.isFinite)) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        let nx = -dy / len;
        let ny = dx / len;
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;

        // Nudge the normal so positive offset always points toward the building's tile center when available.
        const tileId = doc?.flags?.['fa-nexus']?.buildingWall?.tileId;
        const tiles = canvas?.tiles;
        const tile = tileId && (tiles?.get?.(tileId) || (Array.isArray(tiles?.placeables) ? tiles.placeables.find((t) => t?.id === tileId) : null));
        if (tile) {
          const tcx = Number(tile?.center?.x ?? (tile.document?.x ?? tile.x ?? 0) + (tile.document?.width ?? tile.width ?? 0) / 2);
          const tcy = Number(tile?.center?.y ?? (tile.document?.y ?? tile.y ?? 0) + (tile.document?.height ?? tile.height ?? 0) / 2);
          const cross = dx * (tcy - midY) - dy * (tcx - midX);
          if (Number.isFinite(cross) && cross < 0) {
            nx = -nx;
            ny = -ny;
          }

          // If this wall borders a hole, reverse so offset points into the void.
          const holes = getTileHolePolygons(tileId);
          if (holes?.length) {
            const probe = Math.max(4, Math.min(24, Math.abs(dist)));
            const sideInHole = holes.some((poly) => _pointInPolygon(midX + nx * probe, midY + ny * probe, poly));
            const oppInHole = holes.some((poly) => _pointInPolygon(midX - nx * probe, midY - ny * probe, poly));
            if (sideInHole !== oppInHole) {
              const aimIntoHole = sideInHole ? 1 : -1;
              nx *= aimIntoHole;
              ny *= aimIntoHole;
            }
          }
        }

        return { dx: nx * dist, dy: ny * dist };
      }
    }
  } catch (_) { /* ignore */ }

  // Fallback to mesh rotation if anything above fails.
  const rot = mesh?.rotation || 0;
  return {
    dx: -Math.sin(rot) * dist,
    dy: Math.cos(rot) * dist
  };
}

/**
 * Manages drop shadows for FA Nexus animated door textures.
 * Shadows are lightweight sprites that follow DoorMesh transforms in real-time
 * without forcing a full shadow layer rebuild during door animations.
 */
export class DoorShadowManager {
  constructor() {
    if (_singleton) return _singleton;
    this._root = null;
    this._entries = new Map(); // wallId -> entry
    this._lifecycle = new DoorSceneLifecycleOwner({
      logger: Logger,
      foreignLogKey: 'DoorShadow.foreignSceneDocument.ignored',
      missingLogKey: 'DoorShadow.sceneOwnership.missing'
    });
    this._hooksBound = false;
    this._tickerBound = false;
    this._enabled = true;
    this._shadowsEnabled = true;
    this._readyRan = false;
    this._canvasReadyRan = false;
    this._noMeshSkip = new Set(); // wallIds that permanently skipped due to missing meshes
    this._transformPreviewSuppressionCounts = new Map();
    this._transformPreviewDynamicStates = new Map();
    this._bindHooks();
    this._ensureLifecycleCatchup();
    _singleton = this;
  }

  static getInstance() {
    return _singleton ?? new DoorShadowManager();
  }

  static peek() {
    return _singleton;
  }

  getPortalShadowContainers(wallId) {
    const id = String(wallId || '').trim();
    if (!id) return [];
    const entry = this._entries.get(id);
    return Array.from(entry?.subs || [])
      .map((sub) => sub?.container)
      .filter((container) => container && !container.destroyed);
  }

  getDetachedPreviewShadowContainers(documentId) {
    const id = String(documentId || '').trim();
    const entry = id ? this._entries.get(id) : null;
    if (entry?.detachedPreview !== true) return [];
    return Array.from(entry.subs || []).map((sub) => sub?.container)
      .filter((container) => container && !container.destroyed);
  }

  syncDoorTransformPreview(document) {
    const id = String(document?.id || document?._id || '').trim();
    const entry = id ? this._entries.get(id) : null;
    if (!entry || entry.detachedPreview === true) return false;
    const config = this._getShadowConfig(document);
    if (!config) return false;
    entry.doc = document;
    entry.config = config;
    entry.elevation = resolveDocumentElevation(document);
    const generated = document?.getFlag?.('fa-nexus', 'buildingGenerated')
      || document?.flags?.['fa-nexus']?.buildingGenerated;
    const isDerivedBuildingV2Shadow = generated?.role === 'portal'
      && generated?.doorShadowNormal != null;
    this._onTick(isDerivedBuildingV2Shadow ? { strictEntryId: id } : undefined);
    return true;
  }

  async prepareDetachedPreview({ document, meshes } = {}) {
    const id = String(document?.id || document?._id || '').trim();
    if (!id || !Array.isArray(meshes) || !meshes.length || meshes.some((mesh) => !mesh || mesh.destroyed)) {
      throw new Error('Door shadow detached preview requires one private Wall document and live Door meshes.');
    }
    if (this._entries.has(id)) throw new Error(`Door shadow entry already exists for ${id}.`);
    const config = this._getShadowConfig(document);
    if (!config) throw new Error('Door shadow detached preview requires an admitted FA Nexus Door shadow configuration.');
    let handle = null;
    try {
      await this._buildEntry(document, config, { meshesOverride: meshes, mount: false, detachedPreview: true });
      const entry = this._entries.get(id);
      if (!entry?.subs?.length || entry.detachedPreview !== true) {
        throw new Error('Door shadow detached preview could not prepare a complete renderer entry.');
      }
      handle = { id, entry, active: false, released: false };
      this._onTick({ strictEntryId: id });
      return handle;
    } catch (error) {
      const entry = this._entries.get(id);
      if (!entry) throw error;
      handle ||= { id, entry, active: false, released: false };
      try { this._removeEntry(id, { strict: true }); }
      catch (cleanupError) {
        const failure = new AggregateError([error, cleanupError], 'Door shadow detached preparation and cleanup failed.');
        Object.defineProperty(failure, 'faNexusDoorShadowCleanupHandle', { value: handle, enumerable: false });
        throw failure;
      }
      throw error;
    }
  }

  async preparePlacementPreview(document) {
    if (!this._enabled || !this._getShadowConfig(document)) return null;
    const meshes=Array.from(document.object?.doorMeshes || []);
    if(!meshes.length)return null;
    const handle=await this.prepareDetachedPreview({document,meshes});
    try {this.activateDetachedPreview(handle);return handle;}
    catch(error){this.releaseDetachedPreview(handle);throw error;}
  }

  syncDetachedPreview(handle) {
    if(!handle||handle.released)return;
    if(handle.entry!==this._entries.get(handle.id))throw new Error('Door shadow placement lost its owned preview.');
    handle.entry.config=this._getShadowConfig(handle.entry.doc);
    handle.entry.elevation=resolveDocumentElevation(handle.entry.doc);
    this._onTick({strictEntryId:handle.id});
  }

  activateDetachedPreview(handle) {
    if (!handle || handle.released || handle.entry !== this._entries.get(handle.id)) {
      throw new Error('Door shadow cannot activate a released or foreign detached preview.');
    }
    if (handle.active) throw new Error('Door shadow detached preview is already active.');
    const root = this._ensureRoot();
    if (!root) throw new Error('Door shadow detached preview requires the active Canvas primary group.');
    const mounted = [];
    try {
      for (const sub of handle.entry.subs) {
        root.addChild(sub.container);
        mounted.push(sub.container);
      }
      handle.active = true;
      return handle;
    } catch (error) {
      for (const container of mounted.reverse()) container.parent?.removeChild?.(container);
      throw error;
    }
  }

  releaseDetachedPreview(handle) {
    if (!handle || handle.released) return false;
    const current = this._entries.get(handle.id);
    if (!current) {
      handle.active = false;
      handle.released = true;
      return false;
    }
    if (handle.entry !== current || handle.entry?.detachedPreview !== true) {
      throw new Error('Door shadow cannot release a foreign detached preview.');
    }
    this._removeEntry(handle.id, { strict: true });
    handle.active = false;
    handle.released = true;
    return true;
  }

  setPortalTransformPreviewSuppressed(wallId, suppressed) {
    const id = String(wallId || '').trim();
    if (!id) return;
    const current = this._transformPreviewSuppressionCounts.get(id) || 0;
    const next = suppressed ? current + 1 : Math.max(0, current - 1);
    if (next) this._transformPreviewSuppressionCounts.set(id, next);
    else this._transformPreviewSuppressionCounts.delete(id);
    if (next) {
      for (const container of this.getPortalShadowContainers(id)) {
        this._suppressDynamicPreviewContainer(id, container);
      }
      return;
    }
    for (const [container, state] of Array.from(this._transformPreviewDynamicStates)) {
      if (state.wallId !== id) continue;
      this._transformPreviewDynamicStates.delete(container);
      if (!container || container.destroyed) continue;
      container.visible = state.visible;
      container.renderable = state.renderable;
    }
  }

  _suppressDynamicPreviewContainer(wallId, container) {
    if (!container || container.destroyed) return;
    if (!this._transformPreviewDynamicStates.has(container)
      && (container.visible !== false || container.renderable !== false)) {
      this._transformPreviewDynamicStates.set(container, {
        wallId,
        visible: container.visible,
        renderable: container.renderable
      });
    }
    container.visible = false;
    container.renderable = false;
  }

  isPortalShadowReady(wallId, document = null) {
    const id = String(wallId || '').trim();
    if (!id) return false;
    const doc = document || canvas?.scene?.walls?.get?.(id) || null;
    if (!doc) return false;
    if (!this._getShadowConfig(doc)) return true;
    if (hasNoVisibleDoorMeshes(doc)) return true;
    if (this._lifecycle.hasPendingBuild(id)) return false;
    const entry = this._entries.get(id);
    if (!entry?.subs?.length) return false;
    const offset = entry.config?.offset || 0;
    return entry.subs.every((sub) => {
      const mesh = sub?.mesh;
      const container = sub?.container;
      if (!mesh || mesh.destroyed || !container || container.destroyed) return false;
      const { dx, dy } = computeDoorOffsetDelta(entry.doc, mesh, offset);
      return sub._syncMesh === mesh
        && Math.abs(Number(container.position?.x) - (Number(mesh.position?.x) + dx)) < 0.01
        && Math.abs(Number(container.position?.y) - (Number(mesh.position?.y) + dy)) < 0.01
        && Math.abs(Number(container.rotation) - Number(mesh.rotation || 0)) < 0.0001;
    });
  }

  async prepareForSceneTransitionCapture() {
    const sceneId = this._getActiveSceneId();
    if (!this._enabled || !canvas?.ready) {
      return { ok: true, skipped: true, reason: 'canvas-not-ready-or-disabled', sceneId };
    }
    if (!sceneId) {
      return { ok: true, skipped: true, reason: 'scene-missing', sceneId: null };
    }
    if (!this._canvasReadyRan || this._lifecycle.sceneId !== sceneId) {
      await this._onCanvasReady();
    }

    const pending = Array.from(this._lifecycle.pendingBuilds.entries())
      .map(([wallId, entry]) => ({ wallId, promise: entry?.promise }))
      .filter((entry) => entry.promise);
    const settled = await Promise.allSettled(pending.map((entry) => Promise.race([
      entry.promise.then(() => ({ wallId: entry.wallId, timedOut: false })),
      sleep(TRANSITION_PENDING_BUILD_WAIT_MS).then(() => ({ wallId: entry.wallId, timedOut: true }))
    ])));
    const failures = [];
    const timedOut = [];
    for (let i = 0; i < settled.length; i += 1) {
      const result = settled[i];
      if (result.status === 'rejected') {
        failures.push({
          wallId: pending[i]?.wallId || null,
          error: String(result.reason?.message || result.reason || 'unknown error')
        });
      } else if (result.value?.timedOut) {
        timedOut.push({ wallId: result.value.wallId || null });
      }
    }
    if (timedOut.length) {
      Logger.warn?.('DoorShadow.transitionPrepare.pendingBuildsTimedOut', {
        sceneId,
        timeoutMs: TRANSITION_PENDING_BUILD_WAIT_MS,
        pending: timedOut
      });
    }

    try {
      this._onTick();
    } catch (error) {
      failures.push({
        phase: 'tick',
        error: String(error?.message || error)
      });
    }

    return {
      ok: failures.length === 0,
      skipped: false,
      failures
    };
  }

  /* -------------------------------------------- */
  /*  Hook Wiring                                 */
  /* -------------------------------------------- */

  _bindHooks() {
    if (this._hooksBound) return;
    this._hooksBound = true;
    try { Hooks.on('canvasReady', () => this._onCanvasReady()); } catch (_) {}
    try { Hooks.on('canvasTearDown', () => this._onCanvasTearDown()); } catch (_) {}
    try { Hooks.on('createWall', (doc) => this._onCreateWall(doc)); } catch (_) {}
    try { Hooks.on('drawWall', (wall) => this._onDrawWall(wall)); } catch (_) {}
    try { Hooks.on('refreshWall', (wall) => this._onDrawWall(wall)); } catch (_) {}
    try { Hooks.on('updateWall', (doc, diff) => this._onUpdateWall(doc, diff)); } catch (_) {}
    try { Hooks.on('faNexusSeamlessSecretDoorMeshesReplaced', (wall) => this._onDrawWall(wall)); } catch (_) {}
    try { Hooks.on('deleteWall', (doc) => this._onDeleteWall(doc)); } catch (_) {}
    try { Hooks.on('updateSetting', (setting) => this._onSetting(setting)); } catch (_) {}
    try { Hooks.on('faNexusDoorVisualProxyRefresh', (doc) => this._onDoorVisualProxyRefresh(doc)); } catch (_) {}
    // Last, so that a manager created after ready (a late-loaded module) runs its ready step with every hook bound.
    try { onFoundryBoot('ready', () => this._onReady()); } catch (_) {}
  }

  _onReady() {
    this._readyRan = true;
    try {
      this._shadowsEnabled = !!game.settings.get('fa-nexus', 'assetDropShadow');
    } catch (_) {
      this._shadowsEnabled = true;
    }
    this._onCanvasReady();
  }

  _onSetting(setting) {
    if (!setting || setting.namespace !== 'fa-nexus' || setting.key !== 'assetDropShadow') return;
    this._shadowsEnabled = !!setting.value;
    const detachedEntries = Array.from(this._entries.values())
      .filter((entry) => entry?.detachedPreview === true);
    if (detachedEntries.length) {
      for (const entry of this._entries.values()) {
        const config = this._getShadowConfig(entry.doc);
        if (config) entry.config = config;
      }
      this._onTick();
      return;
    }
    this._onCanvasReady();
  }

  async _onCanvasReady() {
    this._canvasReadyRan = true;
    this._lifecycle.beginCanvasReady();
    this._clearAll();
    if (!canvas?.ready) return;
    this._ensureRoot();
    const docs = new Map();
    const wallPlaceables = Array.isArray(canvas?.walls?.placeables) ? canvas.walls.placeables : [];
    for (const wall of wallPlaceables) {
      const doc = wall?.document || wall;
      if (doc?.id) docs.set(doc.id, doc);
    }
    const sceneWalls = canvas?.scene?.walls || [];
    for (const doc of sceneWalls) {
      if (doc?.id) docs.set(doc.id, doc);
    }
    for (const doc of docs.values()) {
      this._trackWall(doc);
    }
  }

  _onCanvasTearDown() {
    const previousSceneId = this._lifecycle.beginCanvasTearDown();
    this._clearAll();
    Logger.debug?.('DoorShadow.canvasTearDown.cleared', { sceneId: previousSceneId });
  }

  _ensureLifecycleCatchup() {
    try {
      const alreadyReady = this._readyRan || game?.ready === true || game?.application?.ready === true;
      if (alreadyReady) {
        this._onReady();
        return;
      }
      // ready not fired but canvas may already be ready in some late-load contexts
      if (canvas?.ready) {
        this._onCanvasReady();
      }
    } catch (_) { /* ignore */ }
  }

  _getActiveSceneId() {
    return getActiveDoorSceneId();
  }

  _getDocumentSceneId(doc) {
    return getDoorDocumentSceneId(doc);
  }

  _isCurrentSceneScope(generation = this._lifecycle.sceneGeneration, sceneId = this._lifecycle.sceneId || this._getActiveSceneId()) {
    return this._lifecycle.isCurrentSceneScope(generation, sceneId);
  }

  _isActiveSceneDocument(doc, { phase = 'unknown', log = true } = {}) {
    return this._lifecycle.isActiveSceneDocument(doc, { phase, log });
  }

  _onCreateWall(doc) {
    if (!this._enabled || !canvas?.ready) return;
    if (!this._isActiveSceneDocument(doc, { phase: 'createWall' })) return;
    this._trackWall(doc);
  }

  _onDrawWall(wall) {
    if (!this._enabled || !canvas?.ready) return;
    const doc = wall?.document || wall;
    if (!doc?.id) return;
    if (!this._isActiveSceneDocument(doc, { phase: 'drawWall' })) return;
    this._noMeshSkip.delete(doc.id);
    const generated = doc?.getFlag?.('fa-nexus', 'buildingGenerated')
      || doc?.flags?.['fa-nexus']?.buildingGenerated;
    const entry = this._entries.get(doc.id);
    const meshes = Array.from(wall?.doorMeshes || doc?.object?.doorMeshes || [])
      .filter(mesh => mesh && !mesh.destroyed);
    // Geometry refreshes reuse the native leaves. Keep their rendered shadows
    // mounted throughout held transforms; rebuild only when the leaf set changes.
    if (generated?.role === 'portal' && generated?.doorShadowNormal != null
      && entry?.detachedPreview === false && meshes.length
      && entry.subs.length === meshes.length
      && entry.subs.every(sub => meshes.includes(sub.mesh) && sub.container && !sub.container.destroyed)
      && this.syncDoorTransformPreview(doc)) return;
    this._trackWall(doc, { force: true });
  }

  _onUpdateWall(doc, diff = {}) {
    if (!doc || !this._enabled) return;
    if (!this._isActiveSceneDocument(doc, { phase: 'updateWall' })) return;
    const flags = diff.flags || {};
    const faFlags = flags['fa-nexus'] || {};
    const coreFlags = flags.core || {};
    const hasFaFlags = !!(faFlags && Object.keys(faFlags).length);
    const hasCoreFlags = !!(coreFlags && Object.keys(coreFlags).length);

    const forceRebuild = ('door' in diff)
      || ('animation' in diff)
      || ('elevation' in diff)
      || ('elevation' in coreFlags)
      || Object.prototype.hasOwnProperty.call(coreFlags, 'textureGridSize')
      || Object.prototype.hasOwnProperty.call(faFlags, 'buildingSeamlessSecretDoor');

    const shadowOnly =
      !forceRebuild &&
      hasFaFlags &&
      Object.keys(faFlags).length === 1 &&
      (Object.prototype.hasOwnProperty.call(faFlags, 'doorShadow') ||
       Object.prototype.hasOwnProperty.call(faFlags, 'windowShadow'));

    if (!forceRebuild && !shadowOnly && !hasFaFlags && !hasCoreFlags) return;

    // Shadow-only changes just refresh config without rebuilding meshes.
    this._trackWall(doc, { force: forceRebuild });
  }

  _onDeleteWall(doc) {
    const id = doc?.id;
    if (!id) return;
    if (!this._isActiveSceneDocument(doc, { phase: 'deleteWall' })) return;
    this._removeEntry(id);
  }

  _onDoorVisualProxyRefresh(doc) {
    if (!doc?.id || !this._enabled || !canvas?.ready) return;
    if (!this._isActiveSceneDocument(doc, { phase: 'doorVisualProxyRefresh' })) return;
    this._noMeshSkip.delete(doc.id);
    this._trackWall(doc, { force: true });
  }

  /* -------------------------------------------- */
  /*  Entry Management                            */
  /* -------------------------------------------- */

  _ensureRoot() {
    if (this._root && !this._root.destroyed) return this._root;
    if (!canvas?.primary) return null;
    this._root = canvas.primary;
    return this._root;
  }

  _trackWall(doc, { force = false } = {}) {
    if(doc?.object?.faNexusLocalCompositionPreview)return;
    const id = doc?.id;
    if (!id || !canvas?.ready) return;
    if (!this._isActiveSceneDocument(doc, { phase: 'trackWall' })) return;
    if (this._noMeshSkip.has(id) && !force) return;
    if (force) this._removeEntry(id);
    const config = this._getShadowConfig(doc);
    if (!config) {
      this._removeEntry(id);
      return;
    }
    if (this._entries.has(id) && !force) {
      const entry = this._entries.get(id);
      entry.doc = doc;
      entry.config = config;
      entry.elevation = resolveDocumentElevation(doc);
      return;
    }
    if (this._lifecycle.hasPendingBuild(id)) return;
    const pending = this._lifecycle.createPendingBuild(id);
    const { generation, sceneId } = pending;
    const promise = this._buildEntry(doc, config, { generation, sceneId, pending });
    pending.promise = promise;
    promise.finally(() => {
      this._lifecycle.settlePendingBuild(id, pending);
    });
  }

  _getShadowConfig(doc) {
    try {
      const buildingDoor = doc?.getFlag?.('fa-nexus', 'buildingDoor');
      const buildingWindow = doc?.getFlag?.('fa-nexus', 'buildingWindow');
      const buildingSeamlessSecretDoor = doc?.getFlag?.('fa-nexus', 'buildingSeamlessSecretDoor');
      const generated = doc?.getFlag?.('fa-nexus', 'buildingGenerated')
        || doc?.flags?.['fa-nexus']?.buildingGenerated;
      const generatedDoor = generated?.role === 'portal' && doc?.door === 1;
      if (!buildingDoor && !buildingWindow && !buildingSeamlessSecretDoor && !generatedDoor) return null; // Only manage FA Nexus Portals
      // Check for window shadow first (animated windows), then door shadow
      const rawShadow = buildingWindow
        ? doc.getFlag?.('fa-nexus', 'windowShadow')
        : doc.getFlag?.('fa-nexus', 'doorShadow');
      if (generatedDoor && !rawShadow) return null;
      const trackedShadow = this._shadowsEnabled !== false
        ? (rawShadow || {})
        : { ...(rawShadow && typeof rawShadow === 'object' ? rawShadow : {}), enabled: false };
      // Keep tracking portal meshes even when shadows are disabled so HSBC stays applied.
      const cfg = normalizeTrackedShadowConfig(trackedShadow);
      return cfg;
    } catch (error) {
      Logger.warn('DoorShadow.config.failed', String(error?.message || error));
      return null;
    }
  }

  async _buildEntry(doc, config, { generation = this._lifecycle.sceneGeneration, sceneId = this._lifecycle.sceneId || this._getActiveSceneId(), pending = null,
    meshesOverride = null, mount = true, detachedPreview = false } = {}) {
    const id = doc?.id;
    if (!id || !canvas?.ready) return;
    if (!this._isCurrentSceneScope(generation, sceneId)) return;
    if (!this._isActiveSceneDocument(doc, { phase: 'buildEntry', log: false })) return;
    const elevation = resolveDocumentElevation(doc);
    const meshes = meshesOverride || await this._waitForDoorMeshes(doc, { generation, sceneId, pending });
    if (pending?.cancelled) return;
    if (meshes === null) {
      Logger.debug?.('DoorShadow.buildEntry.staleDiscarded', { wallId: id, sceneId, generation });
      return;
    }
    if (!meshes?.length) {
      this._noMeshSkip.add(id);
      return;
    }
    this._applyAnimatedWindowMeshScaling(doc, meshes);
    const root = this._ensureRoot();
    if (!root) return;
    if (pending?.cancelled || !this._isCurrentSceneScope(generation, sceneId)) return;
    const entry = {
      id,
      doc,
      elevation,
      config,
      detachedPreview,
      subs: []
    };
    this._entries.set(id, entry);
    try {
    meshes.forEach((mesh) => {
      const sub = { mesh, container: null, sprite: null, baseSprite: null, blurFilter: null,
        occlusionFilter: null, dilationSprites: [], offscreen: null, renderTexture: null,
        _renderSignature: null, _syncSignature: null, _syncMesh: null,
        _renderTextureWidth: null, _renderTextureHeight: null, _renderTextureResolution: null,
        _renderTextureAnchor: null };
      entry.subs.push(sub);
      const sprite = sub.sprite = new PIXI.Sprite(mesh.texture || PIXI.Texture.WHITE);
      sprite.anchor.set(mesh.anchor?.x ?? 0, mesh.anchor?.y ?? 0);
      sprite.tint = 0x000000;
      sprite.alpha = config.alpha;
      sprite.eventMode = 'none';
      sprite.name = `fa-nexus-door-shadow-sprite:${id}`;

      const offscreen = sub.offscreen = new PIXI.Container();
      offscreen.eventMode = 'none';
      offscreen.sortableChildren = false;

      const baseSprite = sub.baseSprite = new PIXI.Sprite(mesh.texture || PIXI.Texture.WHITE);
      baseSprite.anchor.set(mesh.anchor?.x ?? 0, mesh.anchor?.y ?? 0);
      baseSprite.tint = 0x000000;
      baseSprite.alpha = 1;
      baseSprite.eventMode = 'none';
      baseSprite.name = `fa-nexus-door-shadow-offscreen:${id}`;
      offscreen.addChild(baseSprite);

      const blurFilter = sub.blurFilter = new PIXI.BlurFilter();
      blurFilter.repeatEdgePixels = true;

      const container = sub.container = new PIXI.Container();
      container.eventMode = 'none';
      container.sortableChildren = false;
      container.visible = true;
      container.name = `fa-nexus-door-shadow:${id}`;
      const initialOrder = resolveDoorShadowRenderOrder(mesh);
      container.sortLayer = initialOrder.sortLayer;
      container.sort = initialOrder.sort;
      container.zIndex = initialOrder.zIndex;
      container.elevation = initialOrder.elevation;
      container.addChild(sprite);
      if (this._transformPreviewSuppressionCounts.has(id)) {
        this._suppressDynamicPreviewContainer(id, container);
      }

    });
    const generated = doc?.getFlag?.('fa-nexus', 'buildingGenerated')
      || doc?.flags?.['fa-nexus']?.buildingGenerated;
    const isDerivedBuildingV2Shadow = generated?.role === 'portal'
      && generated?.doorShadowNormal != null;
    this._onTick(isDerivedBuildingV2Shadow ? { strictEntryId: id } : undefined);
    if (mount) {
      for (const sub of entry.subs) root.addChild(sub.container);
    }
    } catch (error) {
      try { this._removeEntry(id, { strict: true }); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Door shadow entry construction and cleanup failed.'); }
      throw error;
    }
    this._startTicker();
  }

  async _waitForDoorMeshes(doc, { generation = this._lifecycle.sceneGeneration, sceneId = this._lifecycle.sceneId || this._getActiveSceneId(), pending = null, attempts = 60, delay = 100 } = {}) {
    for (let i = 0; i < attempts; i++) {
      if (pending?.cancelled) return null;
      if (!this._isCurrentSceneScope(generation, sceneId)) return null;
      if (!this._isActiveSceneDocument(doc, { phase: 'waitForDoorMeshes', log: false })) return null;
      if (hasNoVisibleDoorMeshes(doc)) return [];
      const wall = canvas?.walls?.get?.(doc?.id);
      const meshes = wall?.doorMeshes ? Array.from(wall.doorMeshes) : [];
      if (meshes.length) return meshes;
      const proxyMeshes = DoorVisualProxyManager.peek()?.getDoorMeshes?.(doc?.id) || [];
      if (proxyMeshes.length) return proxyMeshes;
      await sleep(delay);
    }
    return [];
  }

  _applyAnimatedWindowMeshScaling(doc, meshes = []) {
    const smallWindow = isSmallAnimatedWindowDocument(doc);
    const animation = doc?.animation || doc?._source?.animation || doc?.data?.animation || {};
    for (const mesh of Array.isArray(meshes) ? meshes : []) {
      if (!mesh || mesh.destroyed) continue;
      const padding = getSmallAnimatedWindowTexturePadding(mesh.texture, smallWindow);
      const current = Number(mesh.faNexusSmallWindowTexturePadding || 0);
      if (Math.abs(current - padding) < 0.001) continue;
      const previous = {
        elevation: Number(mesh.elevation),
        sort: Number(mesh.sort),
        sortLayer: Number(mesh.sortLayer)
      };
      try {
        mesh.texturePadding = padding;
        mesh.faNexusSmallWindowTexturePadding = padding;
        if (typeof mesh.initialize === 'function') mesh.initialize({ ...animation, sort: Number.isFinite(previous.sort) ? previous.sort : undefined });
        if (!Number.isNaN(previous.elevation)) {
          if (mesh._closedPosition) mesh._closedPosition.elevation = previous.elevation;
          if (mesh._animatedPosition) mesh._animatedPosition.elevation = previous.elevation;
          mesh.elevation = previous.elevation;
        }
        if (Number.isFinite(previous.sort)) {
          if (mesh._closedPosition) mesh._closedPosition.sort = previous.sort;
          if (mesh._animatedPosition) mesh._animatedPosition.sort = previous.sort;
          mesh.sort = previous.sort;
          mesh.zIndex = previous.sort;
        }
        if (Number.isFinite(previous.sortLayer)) mesh.sortLayer = previous.sortLayer;
        Logger.debug?.('DoorShadow.smallWindowPadding.applied', {
          wallId: doc?.id || null,
          padding
        });
      } catch (error) {
        Logger.warn?.('DoorShadow.smallWindowPadding.failed', {
          wallId: doc?.id || null,
          padding,
          error: String(error?.message || error)
        });
      }
    }
  }

  _removeEntry(id, { preserveState = false, strict = false } = {}) {
    this._lifecycle.cancelPendingBuild(id);
    const entry = this._entries.get(id);
    if (!entry) return;
    if (!preserveState) this._noMeshSkip.delete(id);
    const errors = [];
    for (const sub of entry.subs || []) {
      this._transformPreviewDynamicStates.delete(sub?.container);
      const attempt = (operation) => { try { operation(); } catch (error) { if (strict) errors.push(error); } };
      attempt(() => applyHsbcToDisplayObject(sub?.mesh, null, { slot: 'fa-nexus-wall-portal' }));
      attempt(() => sub?.container?.parent?.removeChild?.(sub.container));
      attempt(() => sub?.sprite?.parent?.removeChild?.(sub.sprite));
      if (sub?.sprite && !sub.sprite.destroyed) attempt(() => sub.sprite.destroy());
      if (!sub?.container?.destroyed) attempt(() => sub?.container?.destroy?.({ children: false }));
      for (const sprite of sub?.dilationSprites || []) {
        attempt(() => sprite?.parent?.removeChild?.(sprite));
        if (sprite && !sprite.destroyed) attempt(() => sprite.destroy());
      }
      attempt(() => sub?.baseSprite?.parent?.removeChild?.(sub.baseSprite));
      if (sub?.baseSprite && !sub.baseSprite.destroyed) attempt(() => sub.baseSprite.destroy());
      if (!sub?.offscreen?.destroyed) attempt(() => sub?.offscreen?.destroy?.({ children: false }));
      if (sub?.blurFilter && !sub.blurFilter.destroyed) {
        attempt(() => sub.blurFilter.destroy());
      }
      if (sub?.occlusionFilter && !sub.occlusionFilter.destroyed) {
        attempt(() => sub.occlusionFilter.destroy());
      }
      if (sub?.renderTexture && !sub.renderTexture.destroyed) {
        attempt(() => sub.renderTexture.destroy(true));
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Door shadow cleanup failed.');
    this._entries.delete(id);
    if (!this._entries.size) this._stopTicker();
  }

  _clearAll() {
    this._lifecycle.cancelAllPendingBuilds();
    for (const id of Array.from(this._entries.keys())) {
      this._removeEntry(id);
    }
    this._root = null;
    this._noMeshSkip.clear();
    this._transformPreviewSuppressionCounts.clear();
    this._transformPreviewDynamicStates.clear();
    _VISIBLE_CACHE.clear();
    _OFFSET_CACHE.clear();
    _TILE_HOLE_CACHE.clear();
    this._stopTicker();
  }

  /* -------------------------------------------- */
  /*  Ticker                                      */
  /* -------------------------------------------- */

  _startTicker() {
    if (this._tickerBound) return;
    try {
      PIXI.Ticker.shared.add(this._onTick, this);
      this._tickerBound = true;
    } catch (_) { /* ignore */ }
  }

  _stopTicker() {
    if (!this._tickerBound) return;
    try { PIXI.Ticker.shared.remove(this._onTick, this); } catch (_) { }
    this._tickerBound = false;
  }

  _computeSort(mesh) {
    try { return resolveDoorShadowRenderOrder(mesh).sort; }
    catch (_) { return -Infinity; }
  }

  _syncShadowOcclusion(sub, mesh, sprite) {
    if (!sub || !mesh || !sprite || sprite.destroyed) return false;
    if (!hasActiveOcclusionState(mesh)) {
      try { sprite.filters = null; } catch (_) { /* ignore */ }
      if (sub.occlusionFilter && !sub.occlusionFilter.destroyed) {
        try { sub.occlusionFilter.destroy(); } catch (_) { /* ignore */ }
      }
      sub.occlusionFilter = null;
      return true;
    }

    const filter = sub.occlusionFilter && !sub.occlusionFilter.destroyed
      ? sub.occlusionFilter
      : createDoorShadowOcclusionFilter();
    if (!filter) {
      Logger.error?.('DoorShadow.occlusionFilter.unavailable', {
        meshName: mesh?.name || null,
        wallId: mesh?.faNexusSourceWallId || null
      });
      return false;
    }

    const occlusionMask = canvas?.masks?.occlusion || null;
    const uniforms = filter.uniforms || {};
    const state = mesh?._occlusionState || {};
    uniforms.screenDimensions = canvas?.screenDimensions || [1, 1];
    uniforms.occlusionTexture = occlusionMask?.renderTexture || getTransparentTexture();
    uniforms.occlusionElevation = occlusionMask?.mapElevation?.(mesh?.elevation ?? 0) ?? 0;
    uniforms.unoccludedAlpha = 1;
    uniforms.occludedAlpha = clampUnit(mesh?.occludedAlpha, 0);
    uniforms.fadeOcclusion = clampUnit(state.fade, 0);
    uniforms.radialOcclusion = clampUnit(state.radial, 0);
    uniforms.visionOcclusion = clampUnit(state.vision, 0);
    uniforms.surfaceOcclusion = clampUnit(state.surface, 0);
    sub.occlusionFilter = filter;
    try { sprite.filters = [filter]; } catch (error) {
      Logger.warn?.('DoorShadow.occlusionFilter.applyFailed', {
        meshName: mesh?.name || null,
        wallId: mesh?.faNexusSourceWallId || null,
        error: String(error?.message || error)
      });
      return false;
    }
    return true;
  }

  _warnRenderTextureFallback(entry, sub, subIndex, mesh, baseTexture, texWidth, texHeight, error) {
    const now = Date.now();
    const lastWarnAt = Number(sub?._renderTextureFallbackWarnAt || 0);
    if (lastWarnAt && now - lastWarnAt < RENDER_TEXTURE_FALLBACK_WARN_MS) return;
    if (sub) sub._renderTextureFallbackWarnAt = now;

    const payload = {
      wallId: entry?.id || mesh?.faNexusSourceWallId || null,
      documentId: entry?.doc?.id || null,
      subIndex: Number.isFinite(subIndex) ? subIndex : null,
      meshId: mesh?.id || null,
      meshName: mesh?.name || null,
      spriteName: sub?.sprite?.name || null,
      containerName: sub?.container?.name || null,
      textureWidth: Number(baseTexture?.width || baseTexture?.baseTexture?.width || 0) || null,
      textureHeight: Number(baseTexture?.height || baseTexture?.baseTexture?.height || 0) || null,
      targetWidth: Number.isFinite(texWidth) ? texWidth : null,
      targetHeight: Number.isFinite(texHeight) ? texHeight : null,
      renderTextureWidth: Number(sub?.renderTexture?.width || 0) || null,
      renderTextureHeight: Number(sub?.renderTexture?.height || 0) || null,
      error: String(error?.message || error)
    };

    try {
      Logger.warn?.('DoorShadow.renderTexture.fallback', payload);
    } catch (logError) {
      console.warn?.('[fa-nexus]', 'DoorShadow.renderTexture.fallback', payload, String(logError?.message || logError));
    }
  }

  _onTick({ strictEntryId = null } = {}) {
    if (!this._entries.size || !canvas?.ready) return;
    for (const entry of Array.from(this._entries.values())) {
      if (entry?.detachedPreview !== true && !this._isActiveSceneDocument(entry?.doc, { phase: 'tick', log: false })) {
        Logger.debug?.('DoorShadow.tick.foreignEntryRemoved', {
          wallId: entry?.id || null,
          sceneId: this._getDocumentSceneId(entry?.doc),
          activeSceneId: this._lifecycle.sceneId || this._getActiveSceneId()
        });
        if (entry?.id) this._removeEntry(entry.id);
        continue;
      }
      if (!entry?.subs?.length) continue;
      const cfg = entry.config || {};
      const blurEnabled = cfg.blur > 0;
      const portalHsbc = readPortalHsbc(entry.doc);
      for (const [subIndex, sub] of entry.subs.entries()) {
        const mesh = sub.mesh;
        const sprite = sub.sprite;
        const container = sub.container;
        const baseSprite = sub.baseSprite;
        const offscreen = sub.offscreen;
        const renderer = canvas?.app?.renderer;
        if (!mesh || mesh.destroyed || !sprite || sprite.destroyed || !container || container.destroyed) continue;
        if (!renderer || renderer.destroyed || !baseSprite || baseSprite.destroyed || !offscreen || offscreen.destroyed) continue;
        if (this._transformPreviewSuppressionCounts.has(entry.id)) {
          this._suppressDynamicPreviewContainer(entry.id, container);
        }

        // Spread with dilation (outline-style, no texture scaling)
        const baseTexture = mesh.texture || PIXI.Texture.WHITE;
        const dilation = Math.max(0, Number(cfg.dilation) || 0);
        const baseScaleX = Number(mesh.scale?.x) || 1;
        const baseScaleY = (Number(mesh.scale?.y) || 1) * (Number(cfg.scale) || 1);
        const anchorX = Number.isFinite(mesh.anchor?.x) ? mesh.anchor.x : 0.5;
        const anchorY = Number.isFinite(mesh.anchor?.y) ? mesh.anchor.y : 0.5;
        const rot = mesh.rotation || 0;
        const rendererResolution = Number(renderer.resolution ?? 1) || 1;
        const targetBlur = blurEnabled ? Math.max(0.25, Number(cfg.blur)) : 0;
        const blurQuality = blurEnabled ? computeBlurQuality(targetBlur) : 0;
        const blurPadding = blurEnabled ? Math.max(2, targetBlur * 2) : 0;
        const renderSignature = buildDoorShadowRenderSignature({
          baseTexture,
          baseScaleX,
          baseScaleY,
          anchorX,
          anchorY,
          rotation: rot,
          dilation,
          blur: targetBlur,
          blurQuality,
          blurPadding,
          rendererResolution
        });
        const renderTextureMissingOrStale = isDoorShadowRenderTextureMissingOrStale(sub, rendererResolution);
        const needsRender = renderSignature !== sub._renderSignature || renderTextureMissingOrStale;
        const offset = cfg.offset || 0;
        const { dx, dy } = computeDoorOffsetDelta(entry.doc, mesh, offset);
        const containerX = mesh.position.x + dx;
        const containerY = mesh.position.y + dy;
        const visible = cfg.enabled !== false && mesh.visible !== false && mesh.renderable !== false;
        const shadowRenderOrder = resolveDoorShadowRenderOrder(mesh);
        const sort = shadowRenderOrder.sort;
        const renderElevation = resolveShadowRenderElevation(entry.doc, mesh, entry.elevation);
        const activeOcclusion = hasActiveOcclusionState(mesh);
        const occlusionMask = canvas?.masks?.occlusion || null;
        const occlusionTexture = occlusionMask?.renderTexture || null;
        const occlusionTextureBase = occlusionTexture?.baseTexture || null;
        const occlusionState = mesh?._occlusionState || null;
        const screenDimensions = canvas?.screenDimensions || [];
        const syncSignature = JSON.stringify([
          containerX,
          containerY,
          rot,
          cfg.alpha ?? FALLBACK_ALPHA,
          visible,
          sort,
          shadowRenderOrder.sortLayer,
          renderElevation,
          activeOcclusion,
          occlusionMask?.mapElevation?.(mesh?.elevation ?? 0) ?? 0,
          mesh?.occludedAlpha ?? null,
          occlusionState?.fade ?? null,
          occlusionState?.radial ?? null,
          occlusionState?.vision ?? null,
          occlusionState?.surface ?? null,
          portalHsbc?.hue ?? null,
          portalHsbc?.saturation ?? null,
          portalHsbc?.brightness ?? null,
          portalHsbc?.contrast ?? null,
          screenDimensions?.[0] ?? null,
          screenDimensions?.[1] ?? null,
          occlusionTexture?.uid ?? null,
          occlusionTexture?._updateID ?? null,
          occlusionTextureBase?.uid ?? null,
          occlusionTextureBase?._updateID ?? null
        ]);
        const activeOcclusionFilterMissing = activeOcclusion
          && (!sub.occlusionFilter || sub.occlusionFilter.destroyed || !Array.isArray(sprite.filters) || !sprite.filters.includes(sub.occlusionFilter));
        if (!needsRender && !activeOcclusionFilterMissing && sub._syncMesh === mesh && syncSignature === sub._syncSignature) continue;

        let hsbcSynced = true;
        try { applyHsbcToDisplayObject(mesh, portalHsbc, { slot: 'fa-nexus-wall-portal' }); } catch (_) { hsbcSynced = false; }

        // Position + rotation (offset is oriented toward the building center when possible)
        container.position.set(containerX, containerY);
        container.rotation = rot;

        // Render union to a temporary texture so alpha is applied once
        let texWidth = null;
        let texHeight = null;
        if (needsRender) {
          try {
            const sinR = Math.sin(rot);
            const cosR = Math.cos(rot);
            if (baseSprite.texture !== baseTexture) {
              try { baseSprite.texture = baseTexture; } catch (_) { /* ignore */ }
            }
            baseSprite.scale.set(baseScaleX, baseScaleY);
            baseSprite.anchor.set(anchorX, anchorY);
            baseSprite.position.set(0, 0);
            baseSprite.alpha = 1;
            baseSprite.tint = 0x000000;

            // Dilation sprites (drawn into offscreen container)
            const offsets = _buildDilationOffsets(dilation);
            while (sub.dilationSprites.length < offsets.length) {
              const extra = new PIXI.Sprite(baseTexture);
              extra.tint = 0x000000;
              extra.alpha = 1;
              extra.anchor.set(anchorX, anchorY);
              extra.eventMode = 'none';
              extra.name = `fa-nexus-door-shadow-spread`;
              offscreen.addChild(extra);
              sub.dilationSprites.push(extra);
            }
            while (sub.dilationSprites.length > offsets.length) {
              const extra = sub.dilationSprites.pop();
              try { offscreen.removeChild(extra); } catch (_) { }
              try { extra.destroy(); } catch (_) { }
            }
            sub.dilationSprites.forEach((spr, idx) => {
              const o = offsets[idx];
              if (spr.texture !== baseTexture) {
                try { spr.texture = baseTexture; } catch (_) { /* ignore */ }
              }
              spr.alpha = 1;
              spr.scale.set(baseScaleX, baseScaleY);
              spr.anchor.set(anchorX, anchorY);
              const wx = (o.x * cosR) - (o.y * sinR);
              const wy = (o.x * sinR) + (o.y * cosR);
              spr.position.set(wx, wy);
              spr.visible = true;
              spr.renderable = true;
              spr.filters = null;
            });

            // Blur (applied once to the offscreen union)
            if (blurEnabled) {
              sub.blurFilter.blur = targetBlur;
              sub.blurFilter.quality = blurQuality;
              sub.blurFilter.padding = blurPadding;
              offscreen.filters = [sub.blurFilter];
            } else {
              offscreen.filters = null;
            }

            offscreen.position.set(0, 0); // reset before measuring
            const bounds = offscreen.getLocalBounds(undefined, true);
            const pad = blurEnabled ? Math.ceil(targetBlur * 2) : 0;
            texWidth = Math.max(1, Math.ceil(bounds.width + pad * 2));
            texHeight = Math.max(1, Math.ceil(bounds.height + pad * 2));
            const shiftX = -bounds.x + pad;
            const shiftY = -bounds.y + pad;
            const previousRenderTexture = sub.renderTexture && !sub.renderTexture.destroyed ? sub.renderTexture : null;

            if (!previousRenderTexture || sub._renderTextureResolution !== rendererResolution) {
              const nextRenderTexture = PIXI.RenderTexture.create({
                width: texWidth,
                height: texHeight,
                resolution: rendererResolution
              });
              sub.renderTexture = nextRenderTexture;
              if (previousRenderTexture && previousRenderTexture !== nextRenderTexture) {
                try { previousRenderTexture.destroy(true); } catch (_) { /* ignore */ }
              }
            } else if (sub.renderTexture.width !== texWidth || sub.renderTexture.height !== texHeight) {
              sub.renderTexture.resize(texWidth, texHeight, true);
            }

            offscreen.position.set(shiftX, shiftY);
            renderer.render(offscreen, { renderTexture: sub.renderTexture, clear: true });

            sub._renderSignature = renderSignature;
            sub._renderTextureWidth = texWidth;
            sub._renderTextureHeight = texHeight;
            sub._renderTextureResolution = rendererResolution;
            sub._renderTextureAnchor = { x: shiftX / texWidth, y: shiftY / texHeight };
          } catch (error) {
            sub._renderSignature = null;
            if (strictEntryId === entry.id) throw error;
            // Fallback to direct texture if render-to-texture fails
            if (sprite.texture !== baseTexture) {
              try { sprite.texture = baseTexture; } catch (_) { /* ignore */ }
            }
            sprite.anchor.set(anchorX, anchorY);
            this._warnRenderTextureFallback(entry, sub, subIndex, mesh, baseTexture, texWidth, texHeight, error);
          }
        }

        if (sub.renderTexture && !sub.renderTexture.destroyed && sub._renderSignature === renderSignature && sub._renderTextureAnchor) {
          if (sprite.texture !== sub.renderTexture) {
            try { sprite.texture = sub.renderTexture; } catch (_) { /* ignore */ }
          }
          sprite.anchor.set(sub._renderTextureAnchor.x, sub._renderTextureAnchor.y);
          sprite.position.set(0, 0);
          sprite.scale.set(1, 1);
        }

        // Alpha + visibility (applied once on the composed texture)
        sprite.alpha = cfg.alpha ?? FALLBACK_ALPHA;
        sprite.visible = visible;
        sprite.renderable = visible;
        container.renderable = visible;
        const occlusionSynced = this._syncShadowOcclusion(sub, mesh, sprite);

        // Sorting
        entry.elevation = renderElevation;
        container.sortLayer = shadowRenderOrder.sortLayer;
        container.sort = sort;
        container.zIndex = shadowRenderOrder.zIndex;
        container.elevation = shadowRenderOrder.elevation;
        container.faNexusElevation = renderElevation;
        if (hsbcSynced && occlusionSynced !== false) {
          sub._syncMesh = mesh;
          sub._syncSignature = syncSignature;
        }
      }
    }
  }
}

// Auto-initialize when Foundry is ready so shadows appear without manual imports.
try {
  onFoundryBoot('ready', () => {
    try { DoorShadowManager.getInstance(); } catch (_) { /* ignore */ }
  });
} catch (_) { /* ignore */ }
