import { NexusLogger as Logger } from '../core/nexus-logger.js';
import BuildingWallMesher from './building-wall-mesher.js';
import { gatherBuildingLoops } from './building-shape-helpers.js';
import {
  attachCustomTileOverhead,
  createDisplayProxyFactory,
  detachCustomTileOverhead,
  invalidateCustomTileOverhead
} from '../canvas/custom-tile-overhead.js';
import {
  loadTexture,
  getTransparentTexture
} from '../textures/texture-render.js';
import {
  applyHsbcToDisplayObject,
  normalizeHsbc,
  readDocumentHsbc
} from '../core/hsbc.js';

const EDITING_TILE_SET_KEY = '__faNexusBuildingEditingTileIds';
const BUILDING_WALL_DELETE_QUEUE = new Map();
const PRESERVE_LINKED_TILE_CLEANUP_OPTION = 'faNexusPreserveLinkedTileCleanup';
const SUPPRESS_FILL_TRIGGERED_BUILDING_CLEANUP_OPTION = 'faNexusSuppressFillTriggeredBuildingCleanup';
const SKIP_LINKED_BUILDING_FILL_DELETE_OPTION = 'faNexusSkipLinkedBuildingFillDelete';

function isBuildingTileDocument(doc = null) {
  try {
    return !!doc?.getFlag?.('fa-nexus', 'building');
  } catch (_) {
    return false;
  }
}

function isBuildingFillDocument(doc = null) {
  try {
    return !!doc?.getFlag?.('fa-nexus', 'buildingFill');
  } catch (_) {
    return false;
  }
}

function shouldSkipLinkedBuildingDeletes(doc = null, options = {}) {
  try {
    if (isBuildingFillDocument(doc) && options?.[SUPPRESS_FILL_TRIGGERED_BUILDING_CLEANUP_OPTION]) return true;
    if (options?.[PRESERVE_LINKED_TILE_CLEANUP_OPTION]) return true;
    if (globalThis?.FA_NEXUS_SUPPRESS_LINKED_TILE_DELETE) return true;
    if (globalThis?.FA_NEXUS_SUPPRESS_BUILDING_TILE_DELETE) return true;
    const suppressedIds = globalThis?.FA_NEXUS_SUPPRESS_LINKED_TILE_DELETE_IDS;
    const docId = doc?.id || doc?._id || null;
    return !!(docId && suppressedIds instanceof Set && suppressedIds.has(docId));
  } catch (_) {
    return false;
  }
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

function resolveTileId(tile) {
  try {
    return tile?.document?.id || tile?.document?._id || tile?.id || null;
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

function ensureBuildingMeshTransparent(mesh) {
  try {
    if (!mesh || mesh.destroyed) return;
    if (!mesh.faNexusBuildingOriginalTexture) {
      mesh.faNexusBuildingOriginalTexture = mesh.texture;
    }
    const placeholder = getTransparentTexture();
    if (mesh.texture !== placeholder) mesh.texture = placeholder;
    if (!Number.isFinite(mesh.alpha)) mesh.alpha = 1;
    mesh.renderable = true;
  } catch (_) {}
}

const DEFAULT_GRID_SCALE = 200;
const TILE_MESH_WAITERS = new WeakMap();

function sleep(ms = 60) {
  if (foundry?.utils?.sleep) return foundry.utils.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSceneQueueKey(scene) {
  if (!scene) return null;
  return scene.uuid || scene.id || null;
}

async function deleteWallsRobustly(scene, wallIds = [], logCode = 'BuildingTiles.delete.walls') {
  if (!scene || !Array.isArray(wallIds) || !wallIds.length) return;
  const collection = scene.walls;
  const errors = [];
  // Tile delete hooks can fire while Foundry is still reconciling document collections.
  // Yield once so linked wall cleanup runs against settled scene state.
  await sleep(75);
  for (const wallId of wallIds) {
    if (!wallId) continue;
    try {
      const doc = collection?.get?.(wallId);
      if (!doc || doc._destroyed) continue;
      await scene.deleteEmbeddedDocuments('Wall', [wallId]);
      await sleep(25);
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes('does not exist')) continue;
      errors.push({ wallId, error: message });
    }
  }
  if (errors.length) {
    Logger.warn?.(`${logCode}.failed`, { errors, wallIds: wallIds.filter(Boolean) });
  }
}

function queueWallDeletes(scene, wallIds = [], logCode = 'BuildingTiles.delete.walls') {
  const uniqueIds = Array.from(new Set(
    (Array.isArray(wallIds) ? wallIds : []).filter(Boolean)
  ));
  if (!scene || !uniqueIds.length) return Promise.resolve();
  const queueKey = getSceneQueueKey(scene);
  if (!queueKey) return deleteWallsRobustly(scene, uniqueIds, logCode);
  let entry = BUILDING_WALL_DELETE_QUEUE.get(queueKey);
  if (!entry) {
    entry = {
      scene,
      wallIds: new Set(),
      logCode,
      task: null
    };
    BUILDING_WALL_DELETE_QUEUE.set(queueKey, entry);
  }
  entry.scene = scene;
  entry.logCode = logCode || entry.logCode;
  for (const wallId of uniqueIds) entry.wallIds.add(wallId);
  if (entry.task) return entry.task;
  entry.task = (async () => {
    await sleep(150);
    while (entry.wallIds.size) {
      const pendingIds = Array.from(entry.wallIds);
      entry.wallIds.clear();
      await deleteWallsRobustly(entry.scene, pendingIds, entry.logCode);
      if (entry.wallIds.size) await sleep(75);
    }
  })().finally(() => {
    BUILDING_WALL_DELETE_QUEUE.delete(queueKey);
  });
  return entry.task;
}

function resolveBuildingCleanupTargets(doc, scene = null) {
  try {
    if (!doc?.getFlag) return [];
    const buildingData = doc.getFlag('fa-nexus', 'building');
    if (buildingData) return [{ doc, data: buildingData }];
    if (!doc.getFlag('fa-nexus', 'buildingFill')) return [];
    const resolvedScene = scene || doc.parent || canvas?.scene;
    if (!resolvedScene?.tiles?.size) return [];
    const targets = [];
    for (const tileDoc of resolvedScene.tiles) {
      if (!tileDoc || tileDoc.id === doc.id) continue;
      const data = tileDoc.getFlag?.('fa-nexus', 'building');
      if (!data) continue;
      const fillTileId = data?.meta?.fillTileId || null;
      if (fillTileId !== doc.id) continue;
      targets.push({ doc: tileDoc, data });
    }
    return targets;
  } catch (_) {
    return [];
  }
}

function resolveBuildingWallTileGroupId(tileDoc) {
  try {
    const building = tileDoc?.getFlag?.('fa-nexus', 'building');
    if (!building) return null;
    return building?.meta?.wallGroupId || building?.wall?.wallGroupId || null;
  } catch (_) {
    return null;
  }
}

function cleanupContainerChildren(container) {
  if (!container) return;
  const children = container.children ? [...container.children] : [];
  container.removeChildren();
  for (const child of children) {
    try { child.destroy?.({ children: true, texture: false, baseTexture: false }); }
    catch (_) {}
  }
  container.faNexusBuildingMeshes = null;
}

function cleanupDoorFrameOverlay(tile) {
  try {
    if (!tile) return;
    const mesh = tile.mesh;
    const container = tile.faNexusDoorFrameContainer || mesh?.faNexusDoorFrameContainer;
    detachCustomTileOverhead(tile, { kind: 'building-door-frame' });
    if (container) {
      cleanupContainerChildren(container);
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy({ children: true }); } catch (_) {}
    }
    if (mesh) mesh.faNexusDoorFrameContainer = null;
    tile.faNexusDoorFrameContainer = null;
  } catch (_) {}
}

function restoreMeshTexture(mesh) {
  try {
    if (!mesh || mesh.destroyed) return;
    if (mesh.faNexusBuildingOriginalTexture) {
      mesh.texture = mesh.faNexusBuildingOriginalTexture;
      mesh.faNexusBuildingOriginalTexture = null;
    }
  } catch (_) {}
}

function normalizeTextureOffset(offset) {
  const data = offset && typeof offset === 'object' ? offset : {};
  const x = Number(data.x);
  const y = Number(data.y);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0
  };
}

function normalizeTextureFlip(flip) {
  if (!flip || typeof flip !== 'object') {
    return { horizontal: false, vertical: false };
  }
  return {
    horizontal: !!flip.horizontal,
    vertical: !!flip.vertical
  };
}

function normalizeLayerOpacity(value, fallback = 1) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.min(1, Math.max(0, numeric));
  const fallbackNumeric = Number(fallback);
  if (Number.isFinite(fallbackNumeric)) return Math.min(1, Math.max(0, fallbackNumeric));
  return 1;
}

function hsbcValuesEqual(a = null, b = null) {
  const left = normalizeHsbc(a, null);
  const right = normalizeHsbc(b, null);
  if (!left && !right) return true;
  if (!left || !right) return false;
  return Math.abs(left.hue - right.hue) < 0.001
    && Math.abs(left.saturation - right.saturation) < 0.001
    && Math.abs(left.brightness - right.brightness) < 0.001
    && Math.abs(left.contrast - right.contrast) < 0.001;
}

function getBuildingWallTextureSrc(data) {
  return data?.wall?.texture || data?.meta?.wallTexture?.src || null;
}

function collectBuildingRenderSections(data) {
  const fallbackTextureSrc = getBuildingWallTextureSrc(data);
  const rootHsbc = normalizeHsbc(data?.wall?.hsbc || null, null);
  const innerFallbackHsbc = normalizeHsbc(data?.meta?.innerDefaults?.hsbc || rootHsbc, null);
  const renderSegments = Array.isArray(data?.wall?.renderSegments) ? data.wall.renderSegments : [];
  const normalizedSegments = renderSegments
    .filter((segment) => segment && Array.isArray(segment.points))
    .map((segment, index) => {
      const closed = segment?.closed !== false;
      const points = segment.points
        .map((point) => ({
          x: Number(point?.x) || 0,
          y: Number(point?.y) || 0
        }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      return {
        order: Number.isFinite(Number(segment?.order)) ? Number(segment.order) : index,
        closed,
        points,
        textureSrc: segment?.texture || segment?.pathLocal || fallbackTextureSrc,
        textureKey: segment?.pathKey || data?.wall?.pathKey || null,
        width: Number(segment?.width),
        repeatDistance: Number(segment?.repeatDistance),
        scalePercent: Number(segment?.scalePercent) || 100,
        textureOffset: normalizeTextureOffset(segment?.textureOffset),
        textureFlip: normalizeTextureFlip(segment?.textureFlip),
        startJoinDir: segment?.startJoinDir ? {
          x: Number(segment.startJoinDir.x) || 0,
          y: Number(segment.startJoinDir.y) || 0
        } : null,
        endJoinDir: segment?.endJoinDir ? {
          x: Number(segment.endJoinDir.x) || 0,
          y: Number(segment.endJoinDir.y) || 0
        } : null,
        layerOpacity: normalizeLayerOpacity(segment?.layerOpacity, data?.wall?.layerOpacity),
        hsbc: normalizeHsbc(
          segment?.appearance?.hsbc
          || segment?.hsbc
          || (segment?.wallType === 'inner' ? innerFallbackHsbc : rootHsbc),
          null
        ),
        wallType: segment?.wallType || segment?.loopRef?.wallType || data?.meta?.wallType || data?.wall?.mode || 'outer',
        pathShadow: segment?.pathShadow || null
      };
    })
    .filter((segment) => segment.points.length >= (segment.closed ? 3 : 2));
  if (normalizedSegments.length) return normalizedSegments;

  const loops = gatherBuildingLoops(data);
  if (!loops.length) return [];

  const wallWidth = Math.max(10, Number(data?.wall?.width) || DEFAULT_GRID_SCALE / 2);
  const wallOpacity = normalizeLayerOpacity(data?.wall?.layerOpacity, 1);
  const textureOffset = normalizeTextureOffset(data?.wall?.textureOffset);
  const textureFlip = normalizeTextureFlip(data?.wall?.textureFlip);
  return loops
    .filter((loop) => Array.isArray(loop) && loop.length >= (loop?.closed === false ? 2 : 3))
    .map((loop, index) => {
      const wallType = loop?.wallType || data?.meta?.wallType || data?.wall?.mode || 'outer';
      return {
        order: index,
        closed: loop?.closed !== false,
        points: loop.map((point) => ({
          x: Number(point?.x) || 0,
          y: Number(point?.y) || 0
        })),
        textureSrc: fallbackTextureSrc,
        textureKey: data?.wall?.pathKey || null,
        width: wallWidth,
        repeatDistance: Number(data?.wall?.repeatDistance),
        scalePercent: Number(data?.wall?.scalePercent) || 100,
        textureOffset: { ...textureOffset },
        textureFlip: { ...textureFlip },
        layerOpacity: wallOpacity,
        hsbc: wallType === 'inner' ? innerFallbackHsbc : rootHsbc,
        wallType,
        pathShadow: data?.wall?.pathShadow || null
      };
    });
}

async function loadBuildingTextureEntry(textureSrc) {
  if (!textureSrc) return null;
  const texture = await loadTexture(textureSrc);
  const base = texture?.baseTexture;
  if (base) {
    base.wrapMode = PIXI.WRAP_MODES.REPEAT;
    base.mipmap = PIXI.MIPMAP_MODES.OFF;
  }
  const visibleData = await detectVisibleRows(texture);
  return { texture, visibleData };
}

function applyTransparentPlaceholder(mesh) {
  try {
    const placeholder = getTransparentTexture();
    mesh.texture = placeholder;
    if (mesh.material) mesh.material.texture = placeholder;
    if (mesh.shader?.uniforms) {
      if ('uSampler' in mesh.shader.uniforms) mesh.shader.uniforms.uSampler = placeholder;
      if ('texture' in mesh.shader.uniforms) mesh.shader.uniforms.texture = placeholder;
    }
  } catch (_) { }
}

function resetBuildingOverlayToTransparent(tile, mesh, doc) {
  ensureBuildingMeshTransparent(mesh);
  applyTransparentPlaceholder(mesh);
  const container = ensureBuildingContainer(tile, mesh);
  cleanupContainerChildren(container);
  container.faNexusBuildingMeshes = [];
  container.alpha = 1;
  setContainerTransform(container, mesh, doc);
  detachCustomTileOverhead(tile, { kind: 'building' });
  return container;
}

export function cleanupBuildingOverlay(tile, options = {}) {
  try {
    const preserveTexture = !!options.preserveTexture;
    if (!tile) return;
    const mesh = tile.mesh;
    const container = tile.faNexusBuildingContainer || mesh?.faNexusBuildingContainer;
    detachCustomTileOverhead(tile, { kind: 'building' });
    if (container) {
      cleanupContainerChildren(container);
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy({ children: true }); } catch (_) {}
    }
    if (mesh) {
      mesh.faNexusBuildingContainer = null;
      if (!preserveTexture) restoreMeshTexture(mesh);
    }
    tile.faNexusBuildingContainer = null;
  } catch (_) {}
}

async function ensureTileMesh(tile, options = {}) {
  try {
    if (!tile || tile.destroyed) return null;
    if (tile.mesh && !tile.mesh.destroyed) return tile.mesh;
    const attempts = Math.max(2, Number(options.attempts) || 8);
    const delay = Math.max(30, Number(options.delay) || 60);
    if (TILE_MESH_WAITERS.has(tile)) return TILE_MESH_WAITERS.get(tile);
    const waiter = (async () => {
      if (typeof tile.draw === 'function') {
        try { await Promise.resolve(tile.draw()); } catch (_) {}
        if (tile.mesh && !tile.mesh.destroyed) return tile.mesh;
      }
      for (let i = 0; i < attempts; i++) {
        await sleep(delay);
        if (!tile || tile.destroyed || !tile.document?.scene) break;
        if (tile.mesh && !tile.mesh.destroyed) return tile.mesh;
      }
      return tile?.mesh && !tile.mesh.destroyed ? tile.mesh : null;
    })();
    TILE_MESH_WAITERS.set(tile, waiter);
    try {
      return await waiter;
    } finally {
      TILE_MESH_WAITERS.delete(tile);
    }
  } catch (_) {
    return null;
  }
}

function ensureBuildingContainer(tile, mesh) {
  let container = tile.faNexusBuildingContainer;
  if (!container || container.destroyed) {
    container = new PIXI.Container();
    container.eventMode = 'none';
    container.sortableChildren = false;
    tile.faNexusBuildingContainer = container;
    mesh.addChild(container);
  } else if (!container.parent) {
    mesh.addChild(container);
  }
  mesh.faNexusBuildingContainer = container;
  return container;
}

function ensureDoorFrameContainer(tile, mesh) {
  let container = tile.faNexusDoorFrameContainer;
  if (!container || container.destroyed) {
    container = new PIXI.Container();
    container.eventMode = 'none';
    container.sortableChildren = false;
    tile.faNexusDoorFrameContainer = container;
    mesh.addChild(container);
  } else if (!container.parent) {
    mesh.addChild(container);
  }
  mesh.faNexusDoorFrameContainer = container;
  return container;
}

function applyMeshAlpha(mesh, alpha) {
  try {
    if (!mesh || mesh.destroyed) return;
    mesh.alpha = alpha;
    const shader = mesh.shader || mesh.material?.shader || null;
    const uniforms = shader?.uniforms || null;
    if (!uniforms) return;
    const target = uniforms.uColor;
    if (target instanceof Float32Array && target.length >= 4) {
      target[0] = target[1] = target[2] = target[3] = alpha;
    } else if (Array.isArray(target) && target.length >= 4) {
      target[0] = target[1] = target[2] = target[3] = alpha;
    } else if (target && typeof target.length === 'number' && target.length >= 4) {
      target[0] = target[1] = target[2] = target[3] = alpha;
    } else {
      uniforms.uColor = new Float32Array([alpha, alpha, alpha, alpha]);
    }
  } catch (_) {}
}

function setContainerTransform(container, mesh, doc) {
  if (!container || !mesh || mesh.destroyed) return;
  const docWidth = Math.max(1, Number(doc?.width) || Number(mesh?.width) || 1);
  const docHeight = Math.max(1, Number(doc?.height) || Number(mesh?.height) || 1);
  const rawSx = Number(mesh.scale?.x ?? 1) || 1;
  const rawSy = Number(mesh.scale?.y ?? 1) || 1;
  const sx = Math.abs(rawSx) > 1.001 ? rawSx : (Math.sign(rawSx || 1) || 1) * docWidth;
  const sy = Math.abs(rawSy) > 1.001 ? rawSy : (Math.sign(rawSy || 1) || 1) * docHeight;
  container.scale.set(1 / sx, 1 / sy);
  container.position.set(-(docWidth / 2) / (sx || 1), -(docHeight / 2) / (sy || 1));
}

function computeTextureRepeatDistance(texture, data) {
  const assetPxOverride = Number(
    data?.wall?.assetGridSize ??
    data?.meta?.assetGridSize ??
    data?.meta?.wallTexture?.gridSize
  );
  const assetPx = Math.max(1, assetPxOverride || DEFAULT_GRID_SCALE);
  const sceneGridSize = Math.max(1, Number(canvas?.scene?.grid?.size) || DEFAULT_GRID_SCALE);
  const gridScaleFactor = sceneGridSize / assetPx;
  const texWidth = Math.max(1, Number(texture?.width) || assetPx);
  return texWidth * gridScaleFactor;
}

async function detectVisibleRows(texture) {
  if (!texture || !texture.baseTexture) return null;
  if (texture.faNexusBuildingVisibleData) return texture.faNexusBuildingVisibleData;
  const base = texture.baseTexture;
  if (!base.valid) {
    await new Promise((resolve) => {
      const done = () => { base.off?.('loaded', done); base.off?.('error', done); resolve(); };
      base.once?.('loaded', done);
      base.once?.('error', done);
      if (base.valid) done();
    });
  }
  try {
    const resource = base.resource;
    const source = resource?.source;
    if (!source) return null;
    const width = base.width;
    const height = base.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const alphaThreshold = 10;
    let top = 0;
    let bottom = height - 1;
    const rowVisible = (y) => {
      for (let x = 0; x < width; x++) {
        if (pixels[(y * width + x) * 4 + 3] > alphaThreshold) return true;
      }
      return false;
    };
    while (top < height && !rowVisible(top)) top += 1;
    while (bottom > top && !rowVisible(bottom)) bottom -= 1;
    const data = {
      topRow: top,
      bottomRow: bottom,
      totalHeight: height
    };
    texture.faNexusBuildingVisibleData = data;
    return data;
  } catch (_) {
    return null;
  }
}

function remapVisibleRows(geometry, visibleData) {
  if (!geometry || !visibleData) return;
  const texHeight = Math.max(1, visibleData.totalHeight || 0);
  if (!texHeight) return;
  const uvBuffer = geometry.getBuffer('aTextureCoord');
  if (!uvBuffer?.data) return;
  const vMin = visibleData.topRow / texHeight;
  const vMax = (visibleData.bottomRow + 1) / texHeight;
  const range = Math.max(0.001, vMax - vMin);
  const data = uvBuffer.data;
  for (let i = 1; i < data.length; i += 2) {
    data[i] = vMin + (data[i] * range);
  }
  uvBuffer.update();
}

function createWallShader(texture) {
  if (!texture) return null;
  try {
    if (PIXI?.MeshMaterial) {
      const material = new PIXI.MeshMaterial(texture);
      material.alpha = 1;
      if (material.uvMatrix) {
        material.uvMatrix.isSimple = false;
        material.uvMatrix.clampOffset = false;
        material.uvMatrix.clampMargin = -0.5;
        material.uvMatrix.update();
      }
      return material;
    }
    if (PIXI?.Mesh?.Material) {
      const material = new PIXI.Mesh.Material(texture);
      material.alpha = 1;
      if (material.uvMatrix) {
        material.uvMatrix.isSimple = false;
        material.uvMatrix.clampOffset = false;
        material.uvMatrix.clampMargin = -0.5;
        material.uvMatrix.update();
      }
      return material;
    }
  } catch (error) {
    Logger.warn?.('BuildingTiles.shader.create.failed', { error: String(error?.message || error) });
  }
  try {
    const material = new PIXI.MeshMaterial(texture);
    if (material.uvMatrix) {
      material.uvMatrix.isSimple = false;
      material.uvMatrix.clampOffset = false;
      material.uvMatrix.clampMargin = -0.5;
      material.uvMatrix.update();
    }
    return material;
  } catch (_) {
    return null;
  }
}

export async function applyBuildingTile(tile) {
  try {
    if (!tile || tile.destroyed) return;
    const doc = tile.document;
    if (isEditingTile(tile)) {
      cleanupBuildingOverlay(tile, { preserveTexture: true });
      let mesh = tile.mesh;
      if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
      if (!mesh || mesh.destroyed) return;
      ensureBuildingMeshTransparent(mesh);
      return;
    }
    const data = doc?.getFlag?.('fa-nexus', 'building');
    if (!data) {
      cleanupBuildingOverlay(tile);
      return;
    }
    const renderSections = collectBuildingRenderSections(data);
    let mesh = tile.mesh;
    if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
    if (!mesh || mesh.destroyed) return;
    if (!renderSections.length) {
      resetBuildingOverlayToTransparent(tile, mesh, doc);
      return;
    }
    ensureBuildingMeshTransparent(mesh);
    applyTransparentPlaceholder(mesh);

    const visibleSections = renderSections.filter((section) => normalizeLayerOpacity(section?.layerOpacity, 1) > 0.001);
    const textureSources = Array.from(new Set(visibleSections.map((section) => section.textureSrc).filter(Boolean)));
    const textureEntries = new Map();
    await Promise.all(textureSources.map(async (textureSrc) => {
      try {
        const entry = await loadBuildingTextureEntry(textureSrc);
        if (entry?.texture) textureEntries.set(textureSrc, entry);
      } catch (error) {
        Logger.warn?.('BuildingTiles.texture.loadFailed', {
          error: String(error?.message || error),
          tileId: doc?.id,
          textureSrc
        });
      }
    }));

	    const container = ensureBuildingContainer(tile, mesh);
	    const rootHsbc = normalizeHsbc(readDocumentHsbc(doc, { nullIfMissing: true, nullIfNeutral: true }), null);
	    cleanupContainerChildren(container);
	    container.faNexusBuildingMeshes = [];
	    const sectionMeshes = [];
	    let useContainerHsbc = true;

	    const orderedSections = renderSections
	      .map((section, renderIndex) => ({ ...section, renderIndex }))
	      .sort((a, b) => {
	        const orderDelta = (Number(a?.order) || 0) - (Number(b?.order) || 0);
	        if (Math.abs(orderDelta) > 1e-6) return orderDelta;
	        return (Number(a?.renderIndex) || 0) - (Number(b?.renderIndex) || 0);
	      });
	    let meshIndex = 0;
	    for (const section of orderedSections) {
	      const layerOpacity = normalizeLayerOpacity(section?.layerOpacity, 1);
	      if (layerOpacity <= 0.001) continue;
      const textureSrc = section?.textureSrc || getBuildingWallTextureSrc(data);
      const textureEntry = textureSources.length ? textureEntries.get(textureSrc) : null;
      const texture = textureEntry?.texture || null;
      if (!texture) continue;
      const closed = section?.closed !== false;
      const points = Array.isArray(section?.points) ? section.points : [];
      const minPoints = closed ? 3 : 2;
      if (points.length < minPoints) continue;
      const wallWidth = Math.max(10, Number(section?.width) || Number(data?.wall?.width) || DEFAULT_GRID_SCALE / 2);
      const repeatDistance = (() => {
        const stored = Number(section?.repeatDistance);
        if (Number.isFinite(stored) && stored > 0) return stored;
        return computeTextureRepeatDistance(texture, data);
      })();
	      const geometryResult = BuildingWallMesher.buildGeometry(points, {
	        width: wallWidth,
	        closed,
        joinStyle: 'mitre',
        mitreLimit: 4,
        textureRepeatDistance: repeatDistance,
        textureOffset: normalizeTextureOffset(section?.textureOffset),
        textureFlip: normalizeTextureFlip(section?.textureFlip),
        startJoinDir: section?.startJoinDir || null,
        endJoinDir: section?.endJoinDir || null
      });
	      const geometry = geometryResult?.geometry;
	      if (!geometry || !geometryResult?.data?.positions?.length) continue;
	      remapVisibleRows(geometry, textureEntry?.visibleData);
	      const shader = createWallShader(texture);
	      if (!shader) continue;
	      const sectionMesh = new PIXI.Mesh(geometry, shader);
	      sectionMesh.name = `fa-nexus-building-wall-${doc?.id || 'tile'}-${meshIndex}`;
	      sectionMesh.eventMode = 'none';
	      sectionMesh.interactiveChildren = false;
	      container.addChild(sectionMesh);
	      container.faNexusBuildingMeshes.push(sectionMesh);
	      applyMeshAlpha(sectionMesh, layerOpacity);
	      const sectionHsbc = normalizeHsbc(section?.hsbc ?? rootHsbc, null);
	      if (!hsbcValuesEqual(sectionHsbc, rootHsbc)) useContainerHsbc = false;
	      sectionMeshes.push({ mesh: sectionMesh, hsbc: sectionHsbc });
	      meshIndex += 1;
	    }

	    if (!container.children?.length) {
	      resetBuildingOverlayToTransparent(tile, mesh, doc);
      return;
    }

    container.alpha = 1;
    applyHsbcToDisplayObject(container, useContainerHsbc ? rootHsbc : null);
    if (useContainerHsbc) {
      for (const { mesh: sectionMesh } of sectionMeshes) {
        applyHsbcToDisplayObject(sectionMesh, null);
      }
    } else {
      for (const { mesh: sectionMesh, hsbc } of sectionMeshes) {
        applyHsbcToDisplayObject(sectionMesh, hsbc);
      }
    }
    setContainerTransform(container, mesh, doc);
    attachCustomTileOverhead(tile, {
      kind: 'building',
      contentContainer: container,
      proxyFactory: createDisplayProxyFactory(container),
      syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
        setContainerTransform(entry?.contentContainer, currentMesh, currentTile?.document);
      }
    });
    invalidateCustomTileOverhead(tile, 'building-refresh');
  } catch (error) {
    Logger.warn?.('BuildingTiles.apply.failed', { error: String(error?.message || error) });
  }
}

export async function applyDoorFrameTile(tile) {
  try {
    if (!tile || tile.destroyed) return;
    const doc = tile.document;
    if (isEditingTile(tile)) {
      cleanupDoorFrameOverlay(tile);
      let mesh = tile.mesh;
      if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
      if (!mesh || mesh.destroyed) return;
      ensureBuildingMeshTransparent(mesh);
      return;
    }
    const data = doc?.getFlag?.('fa-nexus', 'buildingDoorFrame');
    if (!data) {
      cleanupDoorFrameOverlay(tile);
      return;
    }

    const texturePath = data?.sourceTextureLocal || data?.sourceTextureKey || '';
    if (!texturePath) {
      cleanupDoorFrameOverlay(tile);
      return;
    }

    let mesh = tile.mesh;
    if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
    if (!mesh || mesh.destroyed) return;
    ensureBuildingMeshTransparent(mesh);

    let texture = null;
    try {
      texture = await loadTexture(texturePath);
      const base = texture?.baseTexture;
      if (base) {
        base.mipmap = PIXI.MIPMAP_MODES.OFF;
        base.wrapMode = PIXI.WRAP_MODES.CLAMP;
      }
    } catch (error) {
      Logger.warn?.('BuildingTiles.doorFrame.texture.loadFailed', { error: String(error?.message || error), tileId: doc?.id, texturePath });
      cleanupDoorFrameOverlay(tile);
      return;
    }

    const base = texture?.baseTexture;
    if (!texture || !base?.valid) {
      cleanupDoorFrameOverlay(tile);
      return;
    }

    const container = ensureDoorFrameContainer(tile, mesh);
    cleanupContainerChildren(container);
    container.name = 'fa-nexus-building-door-frame';

    const docWidth = Math.max(2, Number(doc?.width) || Number(tile?.width) || 0);
    const docHeight = Math.max(2, Number(doc?.height) || Number(tile?.height) || 0);
    const gridSize = Number.isFinite(Number(data?.assetGridSize))
      ? Number(data.assetGridSize)
      : Math.max(1, Number(canvas?.scene?.grid?.size) || DEFAULT_GRID_SCALE);
    const baseAssetScale = gridSize / DEFAULT_GRID_SCALE; // FRAME_ASSET_GRID_PX === 200
    const userScaleRaw = Number.isFinite(Number(data?.scale)) ? Number(data.scale) : 1;
    const userScale = Math.min(3, Math.max(0.1, userScaleRaw));
    const assetScale = baseAssetScale * userScale;
    const offsetX = Number.isFinite(Number(data?.offsetX)) ? Number(data.offsetX) : 0;
    const offsetY = Number.isFinite(Number(data?.offsetY)) ? Number(data.offsetY) : 0;
    const rotation = Number.isFinite(Number(data?.rotation)) ? Number(data.rotation) : 0;
    const rotationRad = rotation * (Math.PI / 180);
    const gapLength = Number.isFinite(Number(data?.gapLength)) ? Number(data.gapLength) : docWidth;
    const rawMode = String(data?.mode || '').toLowerCase();
    const mode = rawMode === 'scale' ? 'scale' : (rawMode === 'pillar' ? 'pillar' : 'split');

    const heightScene = Math.max(1, Number(base.height) || 1) * assetScale;

    if (mode === 'scale') {
      const sprite = new PIXI.Sprite(texture);
      sprite.anchor.set(0.5, 0.5);
      sprite.position.set(docWidth / 2, heightScene / 2);
      sprite.scale.set(docWidth / Math.max(1, Number(base.width) || 1), assetScale);
      container.addChild(sprite);
    } else if (mode === 'pillar') {
      // Pillar mode: duplicate the full texture and flip for right side
      const pillarWidthPx = base.width;
      const pillarWidthScene = pillarWidthPx * assetScale;
      const targetWidth = Math.max(docWidth, pillarWidthScene * 2 + 1, gapLength + pillarWidthScene * 2);
      const offsetXPx = offsetX * targetWidth * 0.5;
      const offsetYPx = offsetY * heightScene * 0.5;

      const left = new PIXI.Sprite(texture);
      left.anchor.set(0.5, 0.5);
      left.position.set(pillarWidthScene * 0.5 + offsetXPx, heightScene * 0.5 + offsetYPx);
      left.scale.set(assetScale, assetScale);
      left.rotation = rotationRad;

      const right = new PIXI.Sprite(texture);
      right.anchor.set(0.5, 0.5);
      right.position.set(targetWidth - pillarWidthScene * 0.5 - offsetXPx, heightScene * 0.5 + offsetYPx);
      right.scale.set(-assetScale, assetScale); // Flip horizontally
      right.rotation = -rotationRad; // Counter-rotate for flipped sprite

      container.addChild(left, right);
    } else {
      // Split mode: split door frame texture in half
      const pillarWidthPx = Math.max(1, Math.min(base.height, Math.floor(base.width / 2)));
      const pillarWidthScene = pillarWidthPx * assetScale;
      const targetWidth = Math.max(docWidth, pillarWidthScene * 2 + 1, gapLength + pillarWidthScene * 2);
      const offsetXPx = offsetX * targetWidth * 0.5;
      const offsetYPx = offsetY * heightScene * 0.5;
      const leftRect = new PIXI.Rectangle(0, 0, pillarWidthPx, base.height);
      const rightRect = new PIXI.Rectangle(Math.max(0, base.width - pillarWidthPx), 0, pillarWidthPx, base.height);
      const leftTex = new PIXI.Texture(base, leftRect);
      const rightTex = new PIXI.Texture(base, rightRect);
      const left = new PIXI.Sprite(leftTex);
      left.anchor.set(0.5, 0.5);
      left.position.set(pillarWidthScene * 0.5 + offsetXPx, heightScene * 0.5 + offsetYPx);
      left.scale.set(assetScale, assetScale);
      const right = new PIXI.Sprite(rightTex);
      right.anchor.set(0.5, 0.5);
      right.position.set(targetWidth - pillarWidthScene * 0.5 - offsetXPx, heightScene * 0.5 + offsetYPx);
      right.scale.set(assetScale, assetScale);
      container.addChild(left, right);
    }

    container.alpha = 1;
    applyHsbcToDisplayObject(container, readDocumentHsbc(doc));
    setContainerTransform(container, mesh, doc);
    attachCustomTileOverhead(tile, {
      kind: 'building-door-frame',
      contentContainer: container,
      proxyFactory: createDisplayProxyFactory(container),
      syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
        setContainerTransform(entry?.contentContainer, currentMesh, currentTile?.document);
      }
    });
    invalidateCustomTileOverhead(tile, 'building-door-frame-refresh');
  } catch (error) {
    Logger.warn?.('BuildingTiles.doorFrame.apply.failed', { error: String(error?.message || error) });
  }
}

function shouldHandleLinkedBuildingDelete(userId) {
  try {
    const currentUserId = game?.user?.id || null;
    if (!currentUserId) return false;
    if (userId) return userId === currentUserId;
    const activeGmIds = Array.from(game?.users || [])
      .filter((user) => user?.active && user?.isGM && user?.id)
      .map((user) => user.id)
      .sort();
    if (!activeGmIds.length) return true;
    return activeGmIds[0] === currentUserId;
  } catch (_) {
    return false;
  }
}

export function rehydrateBuildingTiles() {
  try {
    if (!canvas?.ready) return;
    const tiles = Array.isArray(canvas.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const tile of tiles) {
      try {
        const data = tile?.document?.getFlag?.('fa-nexus', 'building');
        if (data) applyBuildingTile(tile);
        else cleanupBuildingOverlay(tile);

        const frameData = tile?.document?.getFlag?.('fa-nexus', 'buildingDoorFrame');
        if (frameData) applyDoorFrameTile(tile);
        else cleanupDoorFrameOverlay(tile);
      } catch (_) {}
    }
  } catch (_) {}
}

export function clearBuildingTileMeshWaiters() {
  try { TILE_MESH_WAITERS.clear(); }
  catch (_) {}
}

async function deleteLinkedFillAndWalls(doc, { scene = null, data = null, options = null } = {}) {
  try {
    if (!doc || !game?.user?.isGM) return;
    const buildingData = data ?? (typeof doc.getFlag === 'function' ? doc.getFlag('fa-nexus', 'building') : null);
    if (!buildingData) return;
    const resolvedScene = scene || doc.parent || canvas?.scene;
    if (!resolvedScene) return;
    const meta = buildingData?.meta || {};
    const fillTileId = meta?.fillTileId;
    if (fillTileId && fillTileId !== doc.id && !options?.[SKIP_LINKED_BUILDING_FILL_DELETE_OPTION]) {
      try {
        await resolvedScene.deleteEmbeddedDocuments('Tile', [fillTileId], {
          [SUPPRESS_FILL_TRIGGERED_BUILDING_CLEANUP_OPTION]: true
        });
      } catch (error) {
        Logger.warn?.('BuildingTiles.delete.fill.failed', { error: String(error?.message || error), fillTileId });
      }
    }
    // NOTE: We intentionally do NOT use meta.wallIds here, as those can be stale.
    // When multiple islands are committed, wall IDs may get reassigned to different
    // tiles during _assignWallsToCommittedIslands. The meta.wallIds stored at commit
    // time may contain walls that were later claimed by other islands.
    // Instead, we rely exclusively on the wall's actual flag.tileId and flag.groupId
    // which are the authoritative sources after commit.
    const wallIds = new Set();
    const staleWallLinks = [];
    const groupId = meta?.wallGroupId || null;
    const collection = resolvedScene.walls;
    if (collection?.size) {
      for (const wall of collection) {
        if (!wall) continue;
        const flag = wall.getFlag?.('fa-nexus', 'buildingWall');
        if (!flag) continue;
        // Only delete walls where the flag actually points to this tile
        if (flag.tileId === doc.id) {
          wallIds.add(wall.id);
          continue;
        }
        if (!groupId || flag.groupId !== groupId) continue;
        if (!flag.tileId) {
          // Also catch walls that have our groupId but no specific tileId
          // (e.g., from interrupted commits or legacy data)
          wallIds.add(wall.id);
          continue;
        }

        const linkedTile = resolvedScene.tiles?.get?.(flag.tileId) || null;
        const linkedGroupId = resolveBuildingWallTileGroupId(linkedTile);
        if (!linkedTile || linkedTile?._destroyed || linkedGroupId !== groupId) {
          wallIds.add(wall.id);
          staleWallLinks.push({
            wallId: wall.id,
            staleTileId: flag.tileId,
            flagGroupId: flag.groupId || null,
            linkedGroupId: linkedGroupId || null,
            deletingTileId: doc.id
          });
        }
      }
    }
    if (staleWallLinks.length) {
      Logger.warn?.('BuildingTiles.delete.walls.staleTileLinks', {
        tileId: doc.id,
        wallGroupId: groupId,
        staleWallLinks
      });
    }
    if (!wallIds.size) return;
    await queueWallDeletes(resolvedScene, [...wallIds], 'BuildingTiles.delete.walls');
  } catch (error) {
    Logger.warn?.('BuildingTiles.delete.cleanup.failed', { error: String(error?.message || error) });
  }
}

async function deleteLinkedDoorFrameTiles(doc, { scene = null, data = null } = {}) {
  try {
    if (!doc || !game?.user?.isGM) return;
    const buildingData = data ?? (typeof doc.getFlag === 'function' ? doc.getFlag('fa-nexus', 'building') : null);
    if (!buildingData) return;
    const resolvedScene = scene || doc.parent || canvas?.scene;
    if (!resolvedScene?.tiles?.size) return;
    const meta = buildingData?.meta || {};
    const wallGroupId = meta?.wallGroupId || null;
    if (!wallGroupId) return;
    const frameTileIds = [];
    for (const tileDoc of resolvedScene.tiles) {
      if (!tileDoc || tileDoc.id === doc.id) continue;
      const flag = tileDoc.getFlag?.('fa-nexus', 'buildingDoorFrame');
      if (flag?.wallGroupId === wallGroupId) {
        frameTileIds.push(tileDoc.id);
      }
    }
    if (!frameTileIds.length) return;
    try {
      await resolvedScene.deleteEmbeddedDocuments('Tile', frameTileIds);
    } catch (error) {
      Logger.warn?.('BuildingTiles.delete.doorFrames.failed', { error: String(error?.message || error), frameTileIds });
    }
  } catch (error) {
    Logger.warn?.('BuildingTiles.delete.doorFrames.cleanup.failed', { error: String(error?.message || error) });
  }
}

async function deleteLinkedWindowTiles(doc, { scene = null, data = null } = {}) {
  try {
    if (!doc || !game?.user?.isGM) return;
    const buildingData = data ?? (typeof doc.getFlag === 'function' ? doc.getFlag('fa-nexus', 'building') : null);
    if (!buildingData) return;
    const resolvedScene = scene || doc.parent || canvas?.scene;
    if (!resolvedScene?.tiles?.size) return;
    const meta = buildingData?.meta || {};
    const wallGroupId = meta?.wallGroupId || null;
    if (!wallGroupId) return;
    const windowTileIds = [];
    for (const tileDoc of resolvedScene.tiles) {
      if (!tileDoc || tileDoc.id === doc.id) continue;
      // Check for window sill, window texture, or window frame tiles
      const sillFlag = tileDoc.getFlag?.('fa-nexus', 'buildingWindowSill');
      const windowFlag = tileDoc.getFlag?.('fa-nexus', 'buildingWindowWindow');
      const frameFlag = tileDoc.getFlag?.('fa-nexus', 'buildingWindowFrame');
      const flag = sillFlag || windowFlag || frameFlag;
      if (flag?.wallGroupId === wallGroupId) {
        windowTileIds.push(tileDoc.id);
      }
    }
    if (!windowTileIds.length) return;
    try {
      await resolvedScene.deleteEmbeddedDocuments('Tile', windowTileIds);
    } catch (error) {
      Logger.warn?.('BuildingTiles.delete.windowTiles.failed', { error: String(error?.message || error), windowTileIds });
    }
  } catch (error) {
    Logger.warn?.('BuildingTiles.delete.windowTiles.cleanup.failed', { error: String(error?.message || error) });
  }
}

async function deleteLinkedInnerWallTiles(doc, { scene = null, data = null } = {}) {
  try {
    if (!doc || !game?.user?.isGM) return;
    const buildingData = data ?? (typeof doc.getFlag === 'function' ? doc.getFlag('fa-nexus', 'building') : null);
    if (!buildingData) return;
    const resolvedScene = scene || doc.parent || canvas?.scene;
    if (!resolvedScene?.tiles?.size) return;
    const meta = buildingData?.meta || {};
    // Only outer wall tiles should cascade delete their inner walls
    const wallType = meta?.wallType || buildingData?.wall?.mode;
    if (wallType === 'inner') return;
    const wallGroupId = meta?.wallGroupId || null;
    const innerWallTileIds = [];
    for (const tileDoc of resolvedScene.tiles) {
      if (!tileDoc || tileDoc.id === doc.id) continue;
      const innerData = tileDoc.getFlag?.('fa-nexus', 'building');
      if (!innerData) continue;
      const innerMeta = innerData.meta || {};
      const innerWallType = innerMeta?.wallType || innerData?.wall?.mode;
      // Only consider inner wall tiles
      if (innerWallType !== 'inner') continue;
      // Check if this inner tile is linked to the deleted outer tile
      const matchesTileId = innerMeta.parentWallTileId === doc.id;
      const matchesGroupId = wallGroupId && innerMeta.parentWallGroupId === wallGroupId;
      if (matchesTileId || matchesGroupId) {
        innerWallTileIds.push(tileDoc.id);
      }
    }
    if (!innerWallTileIds.length) return;
    try {
      await resolvedScene.deleteEmbeddedDocuments('Tile', innerWallTileIds);
    } catch (error) {
      Logger.warn?.('BuildingTiles.delete.innerWallTiles.failed', { error: String(error?.message || error), innerWallTileIds });
    }
  } catch (error) {
    Logger.warn?.('BuildingTiles.delete.innerWallTiles.cleanup.failed', { error: String(error?.message || error) });
  }
}

async function cleanupLinkedBuildingTiles(doc, options = {}) {
  try {
    if (!doc || !game?.user?.isGM) return;
    const scene = doc.parent || canvas?.scene;
    if (!scene) return;
    const targets = resolveBuildingCleanupTargets(doc, scene);
    if (!targets.length) return;
    const isFillTrigger = !isBuildingTileDocument(doc) && isBuildingFillDocument(doc);
    if (isFillTrigger) {
      const ownerTileIds = Array.from(new Set(
        targets.map((target) => target?.doc?.id).filter(Boolean)
      ));
      if (!ownerTileIds.length) return;
      try {
        await scene.deleteEmbeddedDocuments('Tile', ownerTileIds, {
          [SKIP_LINKED_BUILDING_FILL_DELETE_OPTION]: true
        });
      } catch (error) {
        Logger.warn?.('BuildingTiles.delete.fillOwners.failed', {
          error: String(error?.message || error),
          fillTileId: doc.id,
          ownerTileIds
        });
      }
      return;
    }
    for (const target of targets) {
      if (!target?.doc || !target?.data) continue;
      await deleteLinkedFillAndWalls(target.doc, { scene, data: target.data, options });
      await deleteLinkedDoorFrameTiles(target.doc, { scene, data: target.data });
      await deleteLinkedWindowTiles(target.doc, { scene, data: target.data });
      await deleteLinkedInnerWallTiles(target.doc, { scene, data: target.data });
    }
  } catch (error) {
    Logger.warn?.('BuildingTiles.delete.linked.cleanup.failed', { error: String(error?.message || error) });
  }
}

try {
  Hooks.on('canvasReady', () => {
    try { rehydrateBuildingTiles(); } catch (_) {}
  });
  Hooks.on('drawTile', (tile) => {
    try { applyBuildingTile(tile); } catch (_) {}
    try { applyDoorFrameTile(tile); } catch (_) {}
  });
  Hooks.on('updateTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) {
        applyBuildingTile(tile);
        applyDoorFrameTile(tile);
      }
    } catch (_) {}
  });
  Hooks.on('deleteTile', (doc, options, userId) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) {
        cleanupBuildingOverlay(tile);
        cleanupDoorFrameOverlay(tile);
      }
    } catch (_) {}
    if (shouldHandleLinkedBuildingDelete(userId) && !shouldSkipLinkedBuildingDeletes(doc, options) && doc?.getFlag) {
      Promise.resolve(cleanupLinkedBuildingTiles(doc, options)).catch(() => {});
    }
  });
  Hooks.on('canvasTearDown', () => {
    try { clearBuildingTileMeshWaiters(); } catch (_) {}
  });
} catch (_) {}
