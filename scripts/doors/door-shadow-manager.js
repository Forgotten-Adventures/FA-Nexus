import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { gatherBuildingLoops } from '../buildings/building-shape-helpers.js';
import { applyHsbcToDisplayObject } from '../core/hsbc.js';
import { DoorVisualProxyManager } from './door-visual-proxy-manager.js';

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
  const alpha = clamp(Number(raw.alpha ?? FALLBACK_ALPHA), 0, 1);
  const blur = Math.max(0, Number(raw.blur ?? FALLBACK_BLUR));
  const dilation = Math.max(0, Number(raw.dilation ?? FALLBACK_DILATION));
  const offset = clamp(Number(raw.offset ?? FALLBACK_OFFSET), -MAX_OFFSET_DISTANCE, MAX_OFFSET_DISTANCE);
  return { enabled: true, alpha, blur, dilation, offset };
}

function normalizeTrackedShadowConfig(raw = {}) {
  if (raw?.enabled === false) {
    return {
      enabled: false,
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

function readBuildingWindowFlag(doc) {
  const faFlags = doc?.flags?.['fa-nexus'] || null;
  return doc?.getFlag?.('fa-nexus', 'buildingWindow') || faFlags?.buildingWindow || null;
}

function hasSmallPortalTextureToken(path) {
  return /(?:^|[\\/_\-\s.])small(?:$|[\\/_\-\s.])/.test(String(path || '').toLowerCase());
}

function parseExplicitPortalTextureGridWidth(path) {
  const match = String(path || '').toLowerCase().match(/(?:^|[^0-9])(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)(?=[^0-9]|$)/);
  if (!match) return null;
  const width = Number.parseFloat(String(match[1] || ''));
  return Number.isFinite(width) && width > 0 ? width : null;
}

function isSmallAnimatedWindowDocument(doc) {
  const buildingWindow = readBuildingWindowFlag(doc);
  if (!buildingWindow) return false;
  const animation = doc?.animation || doc?._source?.animation || doc?.data?.animation || null;
  const texture = String(animation?.texture || buildingWindow.textureLocal || buildingWindow.textureKey || '');
  const explicitWidth = parseExplicitPortalTextureGridWidth(texture);
  if (Number.isFinite(explicitWidth) && explicitWidth > 1) return false;
  const flagWidth = Number(buildingWindow.textureGridWidth);
  if (Number.isFinite(flagWidth) && flagWidth > 1) return false;
  if (buildingWindow.smallTexture === true) return true;
  if (Number.isFinite(flagWidth) && flagWidth <= 0.5) return true;
  return hasSmallPortalTextureToken(texture);
}

function getTextureWidth(texture) {
  return Number(texture?.width || texture?.baseTexture?.width || 0) || 0;
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
  if (Number.isFinite(meshElevation)) return meshElevation;
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
    this._pendingBuilds = new Map(); // wallId -> promise
    this._hooksBound = false;
    this._tickerBound = false;
    this._enabled = true;
    this._shadowsEnabled = true;
    this._readyRan = false;
    this._canvasReadyRan = false;
    this._noMeshSkip = new Set(); // wallIds that permanently skipped due to missing meshes
    this._sceneId = null;
    this._sceneGeneration = 0;
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

  /* -------------------------------------------- */
  /*  Hook Wiring                                 */
  /* -------------------------------------------- */

  _bindHooks() {
    if (this._hooksBound) return;
    this._hooksBound = true;
    try { Hooks.once('ready', () => this._onReady()); } catch (_) {}
    try { Hooks.on('canvasReady', () => this._onCanvasReady()); } catch (_) {}
    try { Hooks.on('canvasTearDown', () => this._onCanvasTearDown()); } catch (_) {}
    try { Hooks.on('createWall', (doc) => this._onCreateWall(doc)); } catch (_) {}
    try { Hooks.on('drawWall', (wall) => this._onDrawWall(wall)); } catch (_) {}
    try { Hooks.on('refreshWall', (wall) => this._onDrawWall(wall)); } catch (_) {}
    try { Hooks.on('updateWall', (doc, diff) => this._onUpdateWall(doc, diff)); } catch (_) {}
    try { Hooks.on('deleteWall', (doc) => this._onDeleteWall(doc)); } catch (_) {}
    try { Hooks.on('updateSetting', (setting) => this._onSetting(setting)); } catch (_) {}
    try { Hooks.on('faNexusDoorVisualProxyRefresh', (doc) => this._onDoorVisualProxyRefresh(doc)); } catch (_) {}
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
    this._onCanvasReady();
  }

  async _onCanvasReady() {
    this._canvasReadyRan = true;
    this._sceneGeneration += 1;
    this._sceneId = this._getActiveSceneId();
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
    this._sceneGeneration += 1;
    const previousSceneId = this._sceneId || this._getActiveSceneId();
    this._sceneId = null;
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
    try {
      const id = canvas?.scene?.id ?? game?.scenes?.current?.id ?? null;
      return id ? String(id) : null;
    } catch (_) {
      return null;
    }
  }

  _getDocumentSceneId(doc) {
    try {
      const id = doc?.parent?.id ?? doc?.scene?.id ?? null;
      return id ? String(id) : null;
    } catch (_) {
      return null;
    }
  }

  _isCurrentSceneScope(generation = this._sceneGeneration, sceneId = this._sceneId || this._getActiveSceneId()) {
    const activeSceneId = this._sceneId || this._getActiveSceneId();
    return generation === this._sceneGeneration
      && !!sceneId
      && !!activeSceneId
      && String(sceneId) === String(activeSceneId)
      && !!canvas?.ready;
  }

  _isActiveSceneDocument(doc, { phase = 'unknown', log = true } = {}) {
    if (!doc) return false;
    const activeSceneId = this._sceneId || this._getActiveSceneId();
    const docSceneId = this._getDocumentSceneId(doc);
    if (!activeSceneId || !docSceneId) {
      if (log) {
        Logger.debug?.('DoorShadow.sceneOwnership.missing', {
          phase,
          wallId: doc?.id || null,
          activeSceneId,
          docSceneId
        });
      }
      return false;
    }
    if (docSceneId === activeSceneId) return true;
    if (log) {
      Logger.debug?.('DoorShadow.foreignSceneDocument.ignored', {
        phase,
        wallId: doc?.id || null,
        activeSceneId,
        docSceneId
      });
    }
    return false;
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
      || ('elevation' in coreFlags);

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
    if (this._pendingBuilds.has(id)) return;
    const sceneId = this._sceneId || this._getActiveSceneId();
    const generation = this._sceneGeneration;
    const promise = this._buildEntry(doc, config, { generation, sceneId });
    const pending = { promise, generation, sceneId };
    this._pendingBuilds.set(id, pending);
    promise.finally(() => {
      if (this._pendingBuilds.get(id) === pending) this._pendingBuilds.delete(id);
    });
  }

  _getShadowConfig(doc) {
    try {
      const buildingDoor = doc?.getFlag?.('fa-nexus', 'buildingDoor');
      const buildingWindow = doc?.getFlag?.('fa-nexus', 'buildingWindow');
      if (!buildingDoor && !buildingWindow) return null; // Only manage FA Nexus doors/windows
      // Check for window shadow first (animated windows), then door shadow
      const rawShadow = buildingWindow
        ? doc.getFlag?.('fa-nexus', 'windowShadow')
        : doc.getFlag?.('fa-nexus', 'doorShadow');
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

  async _buildEntry(doc, config, { generation = this._sceneGeneration, sceneId = this._sceneId || this._getActiveSceneId() } = {}) {
    const id = doc?.id;
    if (!id || !canvas?.ready) return;
    if (!this._isCurrentSceneScope(generation, sceneId)) return;
    if (!this._isActiveSceneDocument(doc, { phase: 'buildEntry', log: false })) return;
    const elevation = resolveDocumentElevation(doc);
    const meshes = await this._waitForDoorMeshes(doc, { generation, sceneId });
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
    if (!this._isCurrentSceneScope(generation, sceneId)) return;
    const entry = {
      id,
      doc,
      elevation,
      config,
      subs: []
    };
    meshes.forEach((mesh) => {
      const sprite = new PIXI.Sprite(mesh.texture || PIXI.Texture.WHITE);
      sprite.anchor.set(mesh.anchor?.x ?? 0, mesh.anchor?.y ?? 0);
      sprite.tint = 0x000000;
      sprite.alpha = config.alpha;
      sprite.eventMode = 'none';
      sprite.name = `fa-nexus-door-shadow-sprite:${id}`;

      const offscreen = new PIXI.Container();
      offscreen.eventMode = 'none';
      offscreen.sortableChildren = false;

      const baseSprite = new PIXI.Sprite(mesh.texture || PIXI.Texture.WHITE);
      baseSprite.anchor.set(mesh.anchor?.x ?? 0, mesh.anchor?.y ?? 0);
      baseSprite.tint = 0x000000;
      baseSprite.alpha = 1;
      baseSprite.eventMode = 'none';
      baseSprite.name = `fa-nexus-door-shadow-offscreen:${id}`;
      offscreen.addChild(baseSprite);

      const blurFilter = new PIXI.BlurFilter();
      blurFilter.repeatEdgePixels = true;

      const container = new PIXI.Container();
      container.eventMode = 'none';
      container.sortableChildren = false;
      container.visible = true;
      container.name = `fa-nexus-door-shadow:${id}`;
      const wallsLayer = canvas?.walls;
      const wallSortLayer = wallsLayer?.constructor?.SORT_LAYERS?.WALLS ?? wallsLayer?.sortLayer ?? 0;
      try { container.sortLayer = wallSortLayer; } catch (_) { /* ignore */ }
      container.addChild(sprite);
      root.addChild(container);

      entry.subs.push({
        mesh,
        container,
        sprite,
        baseSprite,
        blurFilter,
        occlusionFilter: null,
        dilationSprites: [],
        offscreen,
        renderTexture: null
      });
    });
    this._entries.set(id, entry);
    this._startTicker();
  }

  async _waitForDoorMeshes(doc, { generation = this._sceneGeneration, sceneId = this._sceneId || this._getActiveSceneId(), attempts = 60, delay = 100 } = {}) {
    for (let i = 0; i < attempts; i++) {
      if (!this._isCurrentSceneScope(generation, sceneId)) return null;
      if (!this._isActiveSceneDocument(doc, { phase: 'waitForDoorMeshes', log: false })) return null;
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
      const padding = smallWindow ? getTextureWidth(mesh.texture) * 0.25 : 0;
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
        if (Number.isFinite(previous.elevation)) {
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

  _removeEntry(id, { preserveState = false } = {}) {
    const entry = this._entries.get(id);
    if (!entry) return;
    if (!preserveState) this._noMeshSkip.delete(id);
    for (const sub of entry.subs || []) {
      try { applyHsbcToDisplayObject(sub?.mesh, null, { slot: 'fa-nexus-wall-portal' }); } catch (_) { }
      try { sub?.container?.removeChildren?.(); } catch (_) { }
      try { sub?.container?.parent?.removeChild?.(sub.container); } catch (_) { }
      try { sub?.container?.destroy?.({ children: true }); } catch (_) { }
      try { sub?.offscreen?.destroy?.({ children: true }); } catch (_) { }
      if (sub?.blurFilter && !sub.blurFilter.destroyed) {
        try { sub.blurFilter.destroy(); } catch (_) { }
      }
      if (sub?.occlusionFilter && !sub.occlusionFilter.destroyed) {
        try { sub.occlusionFilter.destroy(); } catch (_) { }
      }
      if (sub?.renderTexture && !sub.renderTexture.destroyed) {
        try { sub.renderTexture.destroy(true); } catch (_) { }
      }
    }
    this._entries.delete(id);
    if (!this._entries.size) this._stopTicker();
  }

  _clearAll() {
    this._pendingBuilds.clear();
    for (const id of Array.from(this._entries.keys())) {
      this._removeEntry(id);
    }
    this._root = null;
    this._noMeshSkip.clear();
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
    const base = Number(mesh?.sort);
    if (Number.isFinite(base)) return base - SORT_EPSILON;
    return -Infinity;
  }

  _syncShadowOcclusion(sub, mesh, sprite) {
    if (!sub || !mesh || !sprite || sprite.destroyed) return;
    if (!hasActiveOcclusionState(mesh)) {
      try { sprite.filters = null; } catch (_) { /* ignore */ }
      if (sub.occlusionFilter && !sub.occlusionFilter.destroyed) {
        try { sub.occlusionFilter.destroy(); } catch (_) { /* ignore */ }
      }
      sub.occlusionFilter = null;
      return;
    }

    const filter = sub.occlusionFilter && !sub.occlusionFilter.destroyed
      ? sub.occlusionFilter
      : createDoorShadowOcclusionFilter();
    if (!filter) {
      Logger.error?.('DoorShadow.occlusionFilter.unavailable', {
        meshName: mesh?.name || null,
        wallId: mesh?.faNexusSourceWallId || null
      });
      return;
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
    }
  }

  _onTick() {
    if (!this._entries.size || !canvas?.ready) return;
    for (const entry of Array.from(this._entries.values())) {
      if (!this._isActiveSceneDocument(entry?.doc, { phase: 'tick', log: false })) {
        Logger.debug?.('DoorShadow.tick.foreignEntryRemoved', {
          wallId: entry?.id || null,
          sceneId: this._getDocumentSceneId(entry?.doc),
          activeSceneId: this._sceneId || this._getActiveSceneId()
        });
        if (entry?.id) this._removeEntry(entry.id);
        continue;
      }
      if (!entry?.subs?.length) continue;
      const cfg = entry.config || {};
      const blurEnabled = cfg.blur > 0;
      const portalHsbc = readPortalHsbc(entry.doc);
      for (const sub of entry.subs) {
        const mesh = sub.mesh;
        const sprite = sub.sprite;
        const container = sub.container;
        const baseSprite = sub.baseSprite;
        const offscreen = sub.offscreen;
        const renderer = canvas?.app?.renderer;
        if (!mesh || mesh.destroyed || !sprite || sprite.destroyed || !container || container.destroyed) continue;
        if (!renderer || renderer.destroyed || !baseSprite || baseSprite.destroyed || !offscreen || offscreen.destroyed) continue;
        try { applyHsbcToDisplayObject(mesh, portalHsbc, { slot: 'fa-nexus-wall-portal' }); } catch (_) { }

        const baseTexture = mesh.texture || PIXI.Texture.WHITE;
        if (baseSprite.texture !== baseTexture) {
          try { baseSprite.texture = baseTexture; } catch (_) { /* ignore */ }
        }

        // Spread with dilation (outline-style, no texture scaling)
        const dilation = Math.max(0, Number(cfg.dilation) || 0);
        const baseScaleX = Number(mesh.scale?.x) || 1;
        const baseScaleY = Number(mesh.scale?.y) || 1;
        const anchorX = Number.isFinite(mesh.anchor?.x) ? mesh.anchor.x : 0.5;
        const anchorY = Number.isFinite(mesh.anchor?.y) ? mesh.anchor.y : 0.5;
        const rot = mesh.rotation || 0;
        const sinR = Math.sin(rot);
        const cosR = Math.cos(rot);

        baseSprite.scale.set(baseScaleX, baseScaleY);
        baseSprite.anchor.set(anchorX, anchorY);
        baseSprite.position.set(0, 0);
        baseSprite.alpha = 1;
        baseSprite.tint = 0x000000;

        // Position + rotation (offset is oriented toward the building center when possible)
        const offset = cfg.offset || 0;
        const { dx, dy } = computeDoorOffsetDelta(entry.doc, mesh, offset);
        container.position.set(mesh.position.x + dx, mesh.position.y + dy);
        container.rotation = rot;

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
          const targetBlur = Math.max(0.25, Number(cfg.blur));
          sub.blurFilter.blur = targetBlur;
          sub.blurFilter.quality = computeBlurQuality(targetBlur);
          sub.blurFilter.padding = Math.max(2, targetBlur * 2);
          offscreen.filters = [sub.blurFilter];
        } else {
          offscreen.filters = null;
        }

        // Render union to a temporary texture so alpha is applied once
        try {
          offscreen.position.set(0, 0); // reset before measuring
          const bounds = offscreen.getLocalBounds(undefined, true);
          const pad = blurEnabled ? Math.ceil((sub.blurFilter.blur || 0) * 2) : 0;
          const texWidth = Math.max(1, Math.ceil(bounds.width + pad * 2));
          const texHeight = Math.max(1, Math.ceil(bounds.height + pad * 2));
          const shiftX = -bounds.x + pad;
          const shiftY = -bounds.y + pad;

          if (!sub.renderTexture) {
            sub.renderTexture = PIXI.RenderTexture.create({
              width: texWidth,
              height: texHeight,
              resolution: renderer.resolution ?? 1
            });
          } else if (sub.renderTexture.width !== texWidth || sub.renderTexture.height !== texHeight) {
            sub.renderTexture.resize(texWidth, texHeight, true);
          }

          offscreen.position.set(shiftX, shiftY);
          renderer.render(offscreen, { renderTexture: sub.renderTexture, clear: true });

          sprite.texture = sub.renderTexture;
          sprite.anchor.set(shiftX / texWidth, shiftY / texHeight);
          sprite.position.set(0, 0);
          sprite.scale.set(1, 1);
        } catch (e) {
          // Fallback to direct texture if render-to-texture fails
          if (sprite.texture !== baseTexture) {
            try { sprite.texture = baseTexture; } catch (_) { /* ignore */ }
          }
          sprite.anchor.set(anchorX, anchorY);
        }

        // Alpha + visibility (applied once on the composed texture)
        sprite.alpha = cfg.alpha ?? FALLBACK_ALPHA;
        const visible = cfg.enabled !== false && mesh.visible !== false;
        sprite.visible = visible;
        sprite.renderable = visible;
        this._syncShadowOcclusion(sub, mesh, sprite);

        // Sorting
        const sort = this._computeSort(mesh);
        const renderElevation = resolveShadowRenderElevation(entry.doc, mesh, entry.elevation);
        entry.elevation = renderElevation;
        container.sort = sort;
        container.zIndex = sort;
        container.elevation = renderElevation;
        container.faNexusElevation = renderElevation;
      }
    }
  }
}

// Auto-initialize when Foundry is ready so shadows appear without manual imports.
try {
  Hooks.once('ready', () => {
    try { DoorShadowManager.getInstance(); } catch (_) { /* ignore */ }
  });
} catch (_) { /* ignore */ }
