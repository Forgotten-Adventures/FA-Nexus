import { NexusLogger as Logger } from '../core/nexus-logger.js';
import BuildingWallMesher from './building-wall-mesher.js';
import { gatherBuildingLoops } from './building-shape-helpers.js';
import {
  attachCustomTileOverhead,
  createCustomTileOverheadMaterial,
  detachCustomTileOverhead,
  invalidateCustomTileOverhead
} from '../canvas/custom-tile-overhead.js';
import { resolveCanvasTilePlaceable, resolveTileId } from '../canvas/tile-targets.js';
import { createDisplayProxyFactory } from '../canvas/display-object-proxy.js';
import {
  loadTexture,
  ensureMeshTransparent,
  restoreMeshTexture
} from '../textures/texture-runtime-core.js';
import { createOwnedSamplerTexture } from '../textures/owned-sampler-texture.js';
import { syncStandardMaskCustomSourceSuppression } from '../textures/standard-mask-custom-base.js';
import {
  applyHsbcToDisplayObject,
  clearHsbcFromDisplayObject,
  normalizeHsbc,
  readDocumentHsbc
} from '../core/hsbc.js';
import {
  waitForTileMesh,
  clearTileMeshWaiters as clearSharedTileMeshWaiters
} from '../canvas/tile-mesh-waiter.js';
import {
  cleanupLinkedBuildingTiles,
  shouldSkipLinkedBuildingDeletes
} from './building-linked-cleanup-workflow.js';
import { canDeleteTileDuringBuildingEdit } from './building-edit-delete-guard.js';
import {
  readBuildingV2Data,
  resolveBuildingV2ContainerTransform,
  resolveBuildingV2RootFrameOffset
} from './v2/building-v2-root-frame.js';

const DISPLAY_TRANSFORM_PREVIEW_SLOT = Symbol.for('fa-nexus.scene-group-display-transform-preview');
import { registerCustomTileRenderLifecycle } from '../canvas/custom-tile-render-scheduler.js';

const EDITING_TILE_SET_KEY = '__faNexusBuildingEditingTileIds';

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

const DEFAULT_GRID_SCALE = 200;
const OWNED_SAMPLER_TEXTURES = new WeakMap();
const OWNED_SAMPLER_DESTROY_HOOKS = new WeakSet();

function releaseOwnedSamplerTextures(container) {
  const owners = OWNED_SAMPLER_TEXTURES.get(container);
  if (!owners) return false;
  OWNED_SAMPLER_TEXTURES.delete(container);
  for (const owner of owners) {
    try { owner?.release?.(); } catch (_) {}
  }
  return true;
}

function retainOwnedSamplerTexture(container, owner) {
  if (!container || !owner?.texture || typeof owner.release !== 'function') {
    throw new Error('Building Wall sampler ownership requires a live container and owned texture.');
  }
  let owners = OWNED_SAMPLER_TEXTURES.get(container);
  if (!owners) {
    owners = new Set();
    OWNED_SAMPLER_TEXTURES.set(container, owners);
  }
  owners.add(owner);
  if (!OWNED_SAMPLER_DESTROY_HOOKS.has(container)) {
    OWNED_SAMPLER_DESTROY_HOOKS.add(container);
    container.once?.('destroyed', () => releaseOwnedSamplerTextures(container));
  }
  return owner.texture;
}

function cleanupContainerChildren(container) {
  if (!container) return;
  const children = container.children ? [...container.children] : [];
  container.removeChildren();
  for (const child of children) {
    try { clearHsbcFromDisplayObject(child, { slot: 'building-v2-portal-artwork' }); } catch (_) {}
    try { clearHsbcFromDisplayObject(child, { slot: 'building-v2-door-frame' }); } catch (_) {}
    try { child.faNexusOwnedTexture?.destroy?.(false); } catch (_) {}
    try { child.destroy?.({ children: true, texture: false, baseTexture: false }); }
    catch (_) {}
  }
  releaseOwnedSamplerTextures(container);
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

export function cleanupBuildingCompositeOverlay(tile) {
  try {
    if (!tile) return;
    const mesh = tile.mesh;
    const container = tile.faNexusBuildingCompositeContainer || mesh?.faNexusBuildingCompositeContainer;
    detachCustomTileOverhead(tile, { kind: 'building-composite' });
    if (container) {
      cleanupContainerChildren(container);
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy({ children: true }); } catch (_) {}
    }
    if (mesh) mesh.faNexusBuildingCompositeContainer = null;
    tile.faNexusBuildingCompositeContainer = null;
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
        texturePhaseDistance: Number.isFinite(Number(segment?.texturePhaseDistance))
          ? Number(segment.texturePhaseDistance)
          : 0,
        scalePercent: Number(segment?.scalePercent) || 100,
        textureOffset: normalizeTextureOffset(segment?.textureOffset),
        textureFlip: normalizeTextureFlip(segment?.textureFlip),
        startCapNormal: segment?.startCapNormal || null,
        endCapNormal: segment?.endCapNormal || null,
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

export function collectBuildingV2PortalArtwork(data) {
  return Array.isArray(data?.runtime?.portalArtwork)
    ? data.runtime.portalArtwork.filter((entry) => (
      ['door-frame', 'window-frame', 'window-surface'].includes(entry?.kind) && Array.isArray(entry.artwork)
    ))
    : [];
}

async function addBuildingV2PortalArtwork(container, entries) {
  let rendered = 0;
  for (const portal of entries) {
    for (const artwork of portal.artwork) {
      const textureSrc = String(artwork?.textureSrc || '').trim();
      if (!textureSrc) continue;
      let sourceTexture;
      try { sourceTexture = await loadTexture(textureSrc); }
      catch (error) {
        Logger.warn?.('BuildingTiles.v2PortalArtwork.texture.loadFailed', {
          portalId: portal.portalId,
          textureSrc,
          error: String(error?.message || error)
        });
        continue;
      }
      const base = sourceTexture?.baseTexture;
      if (!base?.valid) continue;
      base.mipmap = PIXI.MIPMAP_MODES.OFF;
      base.wrapMode = PIXI.WRAP_MODES.CLAMP;
      let texture = sourceTexture;
      if (artwork.sourceFrame) {
        const frame = artwork.sourceFrame;
        texture = new PIXI.Texture(base, new PIXI.Rectangle(
          Number(frame.x), Number(frame.y), Number(frame.width), Number(frame.height)
        ));
      }
      const sprite = new PIXI.Sprite(texture);
      sprite.name = `fa-nexus-building-v2-portal-artwork:${portal.kind}:${portal.portalId}:${artwork.side || artwork.role}`;
      sprite.faNexusBuildingV2PortalArtwork = {
        kind: portal.kind, portalId: portal.portalId, part: artwork.side || artwork.role
      };
      if (portal.kind === 'door-frame') {
        sprite.faNexusBuildingV2DoorFrame = { portalId: portal.portalId, side: artwork.side };
      }
      if (texture !== sourceTexture) sprite.faNexusOwnedTexture = texture;
      sprite.anchor.set(0.5, 0.5);
      sprite.position.set(Number(artwork.x), Number(artwork.y));
      sprite.width = Math.max(1, Number(artwork.width));
      sprite.height = Math.max(1, Number(artwork.height));
      if (Number(artwork.flipX) < 0) sprite.scale.x *= -1;
      if (Number(artwork.flipY) < 0) sprite.scale.y *= -1;
      sprite.rotation = Number(artwork.rotation) || 0;
      sprite.eventMode = 'none';
      applyHsbcToDisplayObject(sprite, artwork.hsbc || null, { slot: 'building-v2-portal-artwork' });
      container.addChild(sprite);
      rendered += 1;
    }
  }
  return rendered;
}

async function loadBuildingTextureEntry(textureSrc) {
  if (!textureSrc) return null;
  const sourceTexture = await loadTexture(textureSrc);
  const visibleData = await detectVisibleRows(sourceTexture);
  const owner = createOwnedSamplerTexture(sourceTexture, {
    wrapMode: PIXI.WRAP_MODES.REPEAT,
    mipmap: PIXI.MIPMAP_MODES.OFF
  });
  return { texture: owner.texture, visibleData, owner };
}

function resetBuildingOverlayToTransparent(tile, mesh, doc) {
  ensureMeshTransparent(mesh, 'faNexusBuildingOriginalTexture');
  const container = ensureBuildingContainer(tile, mesh);
  cleanupContainerChildren(container);
  container.faNexusBuildingRenderKey = null;
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
      if (!preserveTexture) restoreMeshTexture(mesh, 'faNexusBuildingOriginalTexture');
    }
    tile.faNexusBuildingContainer = null;
  } catch (_) {}
}

async function ensureTileMesh(tile, options = {}) {
  return waitForTileMesh(tile, {
    attempts: Math.max(2, Number(options?.attempts) || 8),
    delay: Math.max(30, Number(options?.delay) || 60),
    scope: 'BuildingTiles.ensureTileMesh'
  });
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

function ensureBuildingCompositeContainer(tile, mesh) {
  let container = tile.faNexusBuildingCompositeContainer;
  if (!container || container.destroyed) {
    container = new PIXI.Container();
    container.eventMode = 'none';
    container.sortableChildren = true;
    tile.faNexusBuildingCompositeContainer = container;
    mesh.addChild(container);
  } else if (!container.parent) {
    mesh.addChild(container);
  }
  mesh.faNexusBuildingCompositeContainer = container;
  return container;
}

function raiseBackgroundCompositeAboveFill(tile, mesh, container) {
  try {
    if (!tile || !mesh || !container || container.destroyed) return;
    const maskContainer = tile.faNexusMaskContainer || mesh.faNexusMaskContainer || null;
    const standardMaskContainer = tile.faNexusStandardMaskContainer || mesh.faNexusStandardMaskContainer || null;
    if (maskContainer && !maskContainer.destroyed) maskContainer.zIndex = Math.min(Number(maskContainer.zIndex) || 0, 0);
    if (standardMaskContainer && !standardMaskContainer.destroyed) standardMaskContainer.zIndex = Math.min(Number(standardMaskContainer.zIndex) || 0, 0);
    container.zIndex = Math.max(Number(container.zIndex) || 0, 10);
    mesh.sortableChildren = true;
    if (container.parent === mesh) mesh.addChild(container);
    mesh.sortChildren?.();
  } catch (error) {
    Logger.warn?.('BuildingTiles.buildingComposite.order.failed', {
      tileId: tile?.document?.id,
      error: String(error?.message || error)
    });
  }
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
  const anchorX = Number(doc?.texture?.anchorX);
  const anchorY = Number(doc?.texture?.anchorY);
  const building = readBuildingV2Data(doc);
  const frame = resolveBuildingV2RootFrameOffset(building);
  if (frame.version !== 1) {
    const rawSx = Number(mesh.scale?.x ?? 1) || 1;
    const rawSy = Number(mesh.scale?.y ?? 1) || 1;
    const sx = Math.abs(rawSx) > 1.001 ? rawSx : (Math.sign(rawSx || 1) || 1) * docWidth;
    const sy = Math.abs(rawSy) > 1.001 ? rawSy : (Math.sign(rawSy || 1) || 1) * docHeight;
    const ax = Number.isFinite(anchorX) ? anchorX : 0.5;
    const ay = Number.isFinite(anchorY) ? anchorY : 0.5;
    container.scale.set(1 / sx, 1 / sy);
    container.position.set(-(docWidth * ax) / sx, -(docHeight * ay) / sy);
    return;
  }
  const transform = resolveBuildingV2ContainerTransform({
    docWidth,
    docHeight,
    docX: doc?._source?.x ?? doc?.x,
    docY: doc?._source?.y ?? doc?.y,
    docRotation: doc?.rotation,
    flipX: Number(doc?.texture?.scaleX) < 0, flipY: Number(doc?.texture?.scaleY) < 0,
    anchorX,
    anchorY,
    toMeshLocal(point) {
      const PointClass = globalThis.PIXI?.Point;
      if (!PointClass || typeof mesh.toLocal !== 'function') {
        throw new Error('Building V2 committed artwork requires the live Pixi Tile-mesh transform.');
      }
      return mesh.toLocal(new PointClass(point.x, point.y), mesh.parent);
    },
    building
  });
  const MatrixClass = globalThis.PIXI?.Matrix;
  if (!MatrixClass || typeof container.transform?.setFromMatrix !== 'function') {
    throw new Error('Building V2 committed artwork requires Pixi Matrix transform support.');
  }
  container.transform.setFromMatrix(new MatrixClass(
    transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty
  ));
}

function syncBuildingOverheadTransform(container, mesh, doc) {
  // Mouse-up ends input before the asynchronous group commit owns rendering.
  // Its planner temporarily restores the source pose; keep this participant's
  // held matrix until handoff completes instead of projecting that old pose.
  if (container?.[DISPLAY_TRANSFORM_PREVIEW_SLOT]) return;
  setContainerTransform(container, mesh, doc);
}

function hasRenderableChildren(container) {
  try {
    return !!(container && !container.destroyed && Array.isArray(container.children)
      && container.children.some((child) => child && !child.destroyed));
  } catch (_) {
    return false;
  }
}

function buildRenderKey(label, parts, tileId = null) {
  try {
    return JSON.stringify(parts);
  } catch (error) {
    Logger.error?.(`BuildingTiles.${label}.renderKey.failed`, {
      tileId,
      error: String(error?.message || error)
    });
    return null;
  }
}

function getTileRenderSignature(doc) {
  return {
    width: Number(doc?.width) || 0,
    height: Number(doc?.height) || 0,
    anchorX: Number.isFinite(Number(doc?.texture?.anchorX)) ? Number(doc.texture.anchorX) : 0.5,
    anchorY: Number.isFinite(Number(doc?.texture?.anchorY)) ? Number(doc.texture.anchorY) : 0.5,
    alpha: Number.isFinite(Number(doc?.alpha)) ? Number(doc.alpha) : 1,
    hidden: !!doc?.hidden,
    textureSrc: doc?.texture?.src || null,
    hsbc: readDocumentHsbc(doc, { nullIfMissing: true, nullIfNeutral: true }) || null
  };
}

function syncReusableBuildingRuntime(tile, mesh, doc, container, reason) {
  if (!container || container.destroyed) return;
  tile.faNexusBuildingContainer = container;
  mesh.faNexusBuildingContainer = container;
  if (!container.parent) mesh.addChild(container);
  setContainerTransform(container, mesh, doc);
  attachCustomTileOverhead(tile, {
    kind: 'building',
    contentContainer: container,
    proxyFactory: createDisplayProxyFactory(container),
    syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
      syncBuildingOverheadTransform(entry?.contentContainer, currentMesh, currentTile?.document);
    }
  });
  try {
    syncStandardMaskCustomSourceSuppression(tile, !!doc?.getFlag?.('fa-nexus', 'standardTileMask'), reason);
  } catch (error) {
    Logger.warn?.('BuildingTiles.standardMaskSuppression.failed', {
      tileId: tile?.document?.id,
      error: String(error?.message || error)
    });
  }
}

export function applyBuildingTileHsbcToExistingRenderer(tile) {
  try {
    if (!tile || tile.destroyed) return false;
    const doc = tile.document;
    const mesh = tile.mesh;
    const container = tile.faNexusBuildingContainer || mesh?.faNexusBuildingContainer || null;
    if (!doc || !container || container.destroyed) return false;
    const data = doc?.getFlag?.('fa-nexus', 'building');
    if (!data) return false;
    const renderSections = collectBuildingRenderSections(data);
    const portalArtwork = collectBuildingV2PortalArtwork(data);
    const compositeData = doc?.getFlag?.('fa-nexus', 'buildingComposite');
    const foregroundParts = compositeData?.role === 'foreground' && Array.isArray(compositeData?.parts)
      ? compositeData.parts.filter((part) => part && typeof part === 'object')
      : [];
    const rootHsbc = normalizeHsbc(readDocumentHsbc(doc, { nullIfMissing: true, nullIfNeutral: true }), null);
    const meshes = Array.isArray(container.faNexusBuildingMeshes)
      ? container.faNexusBuildingMeshes.filter((entry) => entry && !entry.destroyed)
      : [];
    let useContainerHsbc = foregroundParts.length <= 0 && portalArtwork.length <= 0;
    const sectionMeshes = meshes.map((sectionMesh) => ({
      mesh: sectionMesh,
      hsbc: normalizeHsbc(
        renderSections[Number(sectionMesh.faNexusBuildingSectionRenderIndex)]?.hsbc
          ?? sectionMesh.faNexusBuildingSectionHsbc
          ?? rootHsbc,
        null
      )
    }));
    for (const { hsbc: sectionHsbc } of sectionMeshes) {
      if (!hsbcValuesEqual(sectionHsbc, rootHsbc)) useContainerHsbc = false;
    }
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
    return true;
  } catch (error) {
    Logger.warn?.('BuildingTiles.hsbcPreview.apply.failed', {
      tileId: tile?.document?.id,
      error: String(error?.message || error)
    });
    return false;
  }
}

function syncReusableDoorFrameRuntime(tile, mesh, doc, container, reason) {
  if (!container || container.destroyed) return;
  tile.faNexusDoorFrameContainer = container;
  mesh.faNexusDoorFrameContainer = container;
  if (!container.parent) mesh.addChild(container);
  setContainerTransform(container, mesh, doc);
  attachCustomTileOverhead(tile, {
    kind: 'building-door-frame',
    contentContainer: container,
    proxyFactory: createDisplayProxyFactory(container),
    syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
      syncBuildingOverheadTransform(entry?.contentContainer, currentMesh, currentTile?.document);
    }
  });
  try {
    syncStandardMaskCustomSourceSuppression(tile, !!doc?.getFlag?.('fa-nexus', 'standardTileMask'), reason);
  } catch (error) {
    Logger.warn?.('BuildingTiles.doorFrame.standardMaskSuppression.failed', {
      tileId: tile?.document?.id,
      error: String(error?.message || error)
    });
  }
}

function syncReusableBuildingCompositeRuntime(tile, mesh, doc, container, reason) {
  if (!container || container.destroyed) return;
  tile.faNexusBuildingCompositeContainer = container;
  mesh.faNexusBuildingCompositeContainer = container;
  if (!container.parent) mesh.addChild(container);
  setContainerTransform(container, mesh, doc);
  if (doc?.getFlag?.('fa-nexus', 'buildingComposite')?.role === 'background') {
    raiseBackgroundCompositeAboveFill(tile, mesh, container);
  }
  attachCustomTileOverhead(tile, {
    kind: 'building-composite',
    contentContainer: container,
    proxyFactory: createDisplayProxyFactory(container),
    syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
      syncBuildingOverheadTransform(entry?.contentContainer, currentMesh, currentTile?.document);
    }
  });
  try {
    syncStandardMaskCustomSourceSuppression(tile, !!doc?.getFlag?.('fa-nexus', 'standardTileMask'), reason);
  } catch (error) {
    Logger.warn?.('BuildingTiles.buildingComposite.standardMaskSuppression.failed', {
      tileId: tile?.document?.id,
      error: String(error?.message || error)
    });
  }
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

function getTileWorldOrigin(doc) {
  const width = Math.max(1, Number(doc?.width) || 1);
  const height = Math.max(1, Number(doc?.height) || 1);
  const anchorX = Number.isFinite(Number(doc?.texture?.anchorX)) ? Number(doc.texture.anchorX) : 0.5;
  const anchorY = Number.isFinite(Number(doc?.texture?.anchorY)) ? Number(doc.texture.anchorY) : 0.5;
  return {
    x: (Number(doc?.x) || 0) - (width * anchorX),
    y: (Number(doc?.y) || 0) - (height * anchorY),
    width,
    height
  };
}

function getCompositePartTexturePath(part = {}) {
  const texture = part?.texture && typeof part.texture === 'object' ? part.texture : {};
  const flags = part?.flags && typeof part.flags === 'object' ? part.flags : {};
  const flagKey = part?.flagKey || '';
  const typedFlag = flagKey ? (flags?.[flagKey] || {}) : {};
  return texture.src
    || part.textureSrc
    || typedFlag.sourceTextureLocal
    || typedFlag.sourceTextureKey
    || '';
}

function normalizeCompositePartHsbc(part = {}) {
  const flags = part?.flags && typeof part.flags === 'object' ? part.flags : {};
  const typedFlag = part?.flagKey ? (flags?.[part.flagKey] || {}) : {};
  return normalizeHsbc(part.hsbc ?? flags.hsbc ?? typedFlag.hsbc ?? null, null);
}

function getCompositePartFlag(part = {}) {
  const flags = part?.flags && typeof part.flags === 'object' ? part.flags : {};
  const flagKey = part?.flagKey || '';
  return flagKey ? (flags?.[flagKey] || {}) : {};
}

function createCompositePartRoot(part = {}, doc = null) {
  const origin = getTileWorldOrigin(doc);
  const width = Math.max(1, Number(part?.width) || 1);
  const height = Math.max(1, Number(part?.height) || 1);
  const anchorX = Number.isFinite(Number(doc?.texture?.anchorX)) ? Number(doc.texture.anchorX) : 0.5;
  const anchorY = Number.isFinite(Number(doc?.texture?.anchorY)) ? Number(doc.texture.anchorY) : 0.5;
  const documentRotation = (Number(doc?.rotation) || 0) * (Math.PI / 180);
  const worldDx = (Number(part?.x) || 0) - (Number(doc?.x) || 0);
  const worldDy = (Number(part?.y) || 0) - (Number(doc?.y) || 0);
  const cosine = Math.cos(-documentRotation);
  const sine = Math.sin(-documentRotation);
  const centerX = (worldDx * cosine) - (worldDy * sine) + (origin.width * anchorX);
  const centerY = (worldDx * sine) + (worldDy * cosine) + (origin.height * anchorY);
  const rotation = ((Number(part?.rotation) || 0) * (Math.PI / 180)) - documentRotation;
  const root = new PIXI.Container();
  root.eventMode = 'none';
  root.sortableChildren = false;
  root.interactiveChildren = false;
  root.position.set(centerX, centerY);
  root.pivot.set(width / 2, height / 2);
  root.rotation = rotation;
  root.alpha = Number.isFinite(Number(part?.alpha)) ? Math.max(0, Math.min(1, Number(part.alpha))) : 1;
  root.zIndex = Number.isFinite(Number(part?.sort)) ? Number(part.sort) : 0;
  return { root, width, height, rotation };
}

function resolveCompositeShadowOffset(part = {}, rotationRad = 0) {
  const flags = part?.flags && typeof part.flags === 'object' ? part.flags : {};
  let x = Number(flags.shadowOffsetX);
  let y = Number(flags.shadowOffsetY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    const distance = Number(flags.shadowOffsetDistance);
    const angleDeg = Number(flags.shadowOffsetAngle);
    if (Number.isFinite(distance) && Number.isFinite(angleDeg)) {
      const angle = angleDeg * (Math.PI / 180);
      x = Math.cos(angle) * distance;
      y = Math.sin(angle) * distance;
    } else {
      x = 0;
      y = 0;
    }
  }
  const cos = Math.cos(-rotationRad || 0);
  const sin = Math.sin(-rotationRad || 0);
  return {
    x: (x * cos) - (y * sin),
    y: (x * sin) + (y * cos)
  };
}

function addCompositeSpriteShadow(root, texture, part, width, height, rotationRad = 0) {
  const flags = part?.flags && typeof part.flags === 'object' ? part.flags : {};
  if (!flags.shadow) return;
  const base = texture?.baseTexture;
  if (!base?.valid) return;
  const alpha = Number.isFinite(Number(flags.shadowAlpha)) ? Math.max(0, Math.min(1, Number(flags.shadowAlpha))) : 0.35;
  if (alpha <= 0.001) return;
  const blur = Math.max(0, Number(flags.shadowBlur) || 0);
  const dilation = Math.max(0, Number(flags.shadowDilation) || 0);
  const offset = resolveCompositeShadowOffset(part, rotationRad);
  const shadow = new PIXI.Sprite(texture);
  shadow.anchor.set(0.5, 0.5);
  shadow.position.set((width / 2) + offset.x, (height / 2) + offset.y);
  const scaleYSign = Number(part?.texture?.scaleY) < 0 ? -1 : 1;
  shadow.scale.set(
    (width + (dilation * 2)) / Math.max(1, Number(base.width) || 1),
    ((height + (dilation * 2)) / Math.max(1, Number(base.height) || 1)) * scaleYSign
  );
  shadow.tint = 0x000000;
  shadow.alpha = alpha;
  if (blur > 0 && PIXI?.BlurFilter) {
    try {
      const filter = new PIXI.BlurFilter();
      filter.blur = blur;
      shadow.filters = [filter];
    } catch (_) {}
  }
  root.addChild(shadow);
}

function isAssetShadowManagedCompositePart(part = {}) {
  const flags = part?.flags && typeof part.flags === 'object' ? part.flags : {};
  if (!flags.shadow) return false;
  const kind = String(part?.kind || part?.elementType || '').toLowerCase();
  return part?.flagKey === 'buildingWindowSill'
    || String(part?.role || '').toLowerCase() === 'sill'
    || kind === 'sill';
}

function addSimpleCompositeSprite(root, texture, part, width, height, rotationRad = 0) {
  const base = texture?.baseTexture;
  if (!texture || !base?.valid) return false;
  if (!isAssetShadowManagedCompositePart(part)) {
    addCompositeSpriteShadow(root, texture, part, width, height, rotationRad);
  }
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5, 0.5);
  sprite.position.set(width / 2, height / 2);
  const scaleYSign = Number(part?.texture?.scaleY) < 0 ? -1 : 1;
  sprite.scale.set(
    width / Math.max(1, Number(base.width) || 1),
    (height / Math.max(1, Number(base.height) || 1)) * scaleYSign
  );
  applyHsbcToDisplayObject(sprite, normalizeCompositePartHsbc(part));
  root.addChild(sprite);
  return true;
}

function addDoorFrameCompositeSprites(root, texture, part, width, height) {
  const base = texture?.baseTexture;
  if (!texture || !base?.valid) return false;
  const data = getCompositePartFlag(part);
  const gridSize = Number.isFinite(Number(data?.assetGridSize))
    ? Number(data.assetGridSize)
    : Math.max(1, Number(canvas?.scene?.grid?.size) || DEFAULT_GRID_SCALE);
  const baseAssetScale = gridSize / DEFAULT_GRID_SCALE;
  const userScaleRaw = Number.isFinite(Number(data?.scale)) ? Number(data.scale) : 1;
  const userScale = Math.min(3, Math.max(0.1, userScaleRaw));
  const assetScale = baseAssetScale * userScale;
  const offsetX = Number.isFinite(Number(data?.offsetX)) ? Number(data.offsetX) : 0;
  const offsetY = Number.isFinite(Number(data?.offsetY)) ? Number(data.offsetY) : 0;
  const spriteRotation = Number.isFinite(Number(data?.rotation)) ? Number(data.rotation) * (Math.PI / 180) : 0;
  const gapLength = Number.isFinite(Number(data?.gapLength)) ? Number(data.gapLength) : width;
  const rawMode = String(data?.mode || '').toLowerCase();
  const mode = rawMode === 'scale' ? 'scale' : (rawMode === 'pillar' ? 'pillar' : 'split');
  const heightScene = Math.max(1, Number(base.height) || 1) * assetScale;

  if (mode === 'scale') {
    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5, 0.5);
    sprite.position.set(width / 2, heightScene / 2);
    sprite.scale.set(width / Math.max(1, Number(base.width) || 1), assetScale);
    root.addChild(sprite);
  } else if (mode === 'pillar') {
    const pillarWidthPx = Math.max(1, Number(base.width) || 1);
    const pillarWidthScene = pillarWidthPx * assetScale;
    const targetWidth = Math.max(width, pillarWidthScene * 2 + 1, gapLength + pillarWidthScene * 2);
    const offsetXPx = offsetX * targetWidth * 0.5;
    const offsetYPx = offsetY * heightScene * 0.5;
    const left = new PIXI.Sprite(texture);
    left.anchor.set(0.5, 0.5);
    left.position.set(pillarWidthScene * 0.5 + offsetXPx, heightScene * 0.5 + offsetYPx);
    left.scale.set(assetScale, assetScale);
    left.rotation = spriteRotation;
    const right = new PIXI.Sprite(texture);
    right.anchor.set(0.5, 0.5);
    right.position.set(targetWidth - pillarWidthScene * 0.5 - offsetXPx, heightScene * 0.5 + offsetYPx);
    right.scale.set(-assetScale, assetScale);
    right.rotation = -spriteRotation;
    root.addChild(left, right);
  } else {
    const pillarWidthPx = Math.max(1, Math.min(base.height, Math.floor(base.width / 2)));
    const pillarWidthScene = pillarWidthPx * assetScale;
    const targetWidth = Math.max(width, pillarWidthScene * 2 + 1, gapLength + pillarWidthScene * 2);
    const offsetXPx = offsetX * targetWidth * 0.5;
    const offsetYPx = offsetY * heightScene * 0.5;
    const leftRect = new PIXI.Rectangle(0, 0, pillarWidthPx, base.height);
    const rightRect = new PIXI.Rectangle(Math.max(0, base.width - pillarWidthPx), 0, pillarWidthPx, base.height);
    const left = new PIXI.Sprite(new PIXI.Texture(base, leftRect));
    left.anchor.set(0.5, 0.5);
    left.position.set(pillarWidthScene * 0.5 + offsetXPx, heightScene * 0.5 + offsetYPx);
    left.scale.set(assetScale, assetScale);
    const right = new PIXI.Sprite(new PIXI.Texture(base, rightRect));
    right.anchor.set(0.5, 0.5);
    right.position.set(targetWidth - pillarWidthScene * 0.5 - offsetXPx, heightScene * 0.5 + offsetYPx);
    right.scale.set(assetScale, assetScale);
    root.addChild(left, right);
  }

  applyHsbcToDisplayObject(root, normalizeCompositePartHsbc(part));
  return true;
}

async function addCompositePart(container, doc, part) {
  const texturePath = getCompositePartTexturePath(part);
  if (!texturePath) {
    Logger.warn?.('BuildingTiles.buildingComposite.partTextureMissing', {
      tileId: doc?.id || null,
      kind: part?.kind || null,
      partId: part?.id || null
    });
    return false;
  }
  let texture = null;
  try {
    texture = await loadTexture(texturePath);
    const base = texture?.baseTexture;
    if (base) {
      base.mipmap = PIXI.MIPMAP_MODES.OFF;
      base.wrapMode = PIXI.WRAP_MODES.CLAMP;
    }
  } catch (error) {
    Logger.warn?.('BuildingTiles.buildingComposite.texture.loadFailed', {
      tileId: doc?.id || null,
      partId: part?.id || null,
      texturePath,
      error: String(error?.message || error)
    });
    return false;
  }
  const base = texture?.baseTexture;
  if (!texture || !base?.valid) return false;
  const { root, width, height, rotation } = createCompositePartRoot(part, doc);
  const kind = String(part?.kind || part?.elementType || '').toLowerCase();
  const rendered = kind === 'doorframe' || kind === 'door-frame' || part?.flagKey === 'buildingDoorFrame'
    ? addDoorFrameCompositeSprites(root, texture, part, width, height)
    : addSimpleCompositeSprite(root, texture, part, width, height, rotation);
  if (!rendered || !root.children?.length) {
    try { root.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
    return false;
  }
  container.addChild(root);
  return true;
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

function createWallShader(texture, tile) {
  if (!texture) return null;
  const material = createCustomTileOverheadMaterial(texture, tile);
  material.alpha = 1;
  material.uvMatrix.isSimple = false;
  material.uvMatrix.clampOffset = false;
  material.uvMatrix.clampMargin = -0.5;
  material.uvMatrix.update();
  return material;
}

export async function applyBuildingTile(tile) {
  const pendingTextureOwners = new Set();
  try {
    if (!tile || tile.destroyed) return;
    const doc = tile.document;
    if (isEditingTile(tile)) {
      cleanupBuildingOverlay(tile, { preserveTexture: true });
      let mesh = tile.mesh;
      if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
      if (!mesh || mesh.destroyed) return;
      ensureMeshTransparent(mesh, 'faNexusBuildingOriginalTexture');
      return;
    }
    const data = doc?.getFlag?.('fa-nexus', 'building');
    if (!data) {
      cleanupBuildingOverlay(tile);
      return;
    }
    const renderSections = collectBuildingRenderSections(data);
    const portalArtwork = collectBuildingV2PortalArtwork(data);
    const compositeData = doc?.getFlag?.('fa-nexus', 'buildingComposite');
    const foregroundParts = compositeData?.role === 'foreground' && Array.isArray(compositeData?.parts)
      ? compositeData.parts.filter((part) => part && typeof part === 'object')
      : [];
    let mesh = tile.mesh;
    if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
    if (!mesh || mesh.destroyed) return;
    if (!renderSections.length && !foregroundParts.length && !portalArtwork.length) {
      resetBuildingOverlayToTransparent(tile, mesh, doc);
      return;
    }
    ensureMeshTransparent(mesh, 'faNexusBuildingOriginalTexture');

    const renderKey = buildRenderKey('building', {
      tile: getTileRenderSignature(doc),
      data,
      foregroundParts,
      portalArtwork,
      renderSections
    }, doc?.id);
    const reusableContainer = tile.faNexusBuildingContainer || mesh.faNexusBuildingContainer;
    if (
      renderKey
      && reusableContainer?.faNexusBuildingRenderKey === renderKey
      && hasRenderableChildren(reusableContainer)
    ) {
      syncReusableBuildingRuntime(tile, mesh, doc, reusableContainer, 'building-reuse');
      return;
    }

    const visibleSections = renderSections.filter((section) => normalizeLayerOpacity(section?.layerOpacity, 1) > 0.001);
    const textureSources = Array.from(new Set(visibleSections.map((section) => section.textureSrc).filter(Boolean)));
    const textureEntries = new Map();
    await Promise.all(textureSources.map(async (textureSrc) => {
      try {
        const entry = await loadBuildingTextureEntry(textureSrc);
        if (entry?.texture) {
          textureEntries.set(textureSrc, entry);
          if (entry.owner) pendingTextureOwners.add(entry.owner);
        }
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
	    let useContainerHsbc = foregroundParts.length <= 0 && portalArtwork.length <= 0;

    const isOverWallPart = (part) => {
      const kind = String(part?.kind || part?.elementType || '').toLowerCase();
      return kind === 'doorframe' || kind === 'door-frame' || part?.flagKey === 'buildingDoorFrame';
    };
    const underWallParts = foregroundParts.filter((part) => !isOverWallPart(part));
    const overWallParts = foregroundParts.filter((part) => isOverWallPart(part));
    for (const part of underWallParts) {
      await addCompositePart(container, doc, part);
    }

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
        texturePhaseDistance: section?.texturePhaseDistance,
        textureOffset: normalizeTextureOffset(section?.textureOffset),
        textureFlip: normalizeTextureFlip(section?.textureFlip),
        startJoinDir: section?.startJoinDir || null,
        startCapNormal: section?.startCapNormal || null,
        endCapNormal: section?.endCapNormal || null,
        endJoinDir: section?.endJoinDir || null
      });
      const geometry = geometryResult?.geometry;
      if (!geometry || !geometryResult?.data?.positions?.length) continue;
	      remapVisibleRows(geometry, textureEntry?.visibleData);
	      const shader = createWallShader(texture, tile);
	      if (!shader) continue;
	      const sectionMesh = new PIXI.Mesh(geometry, shader);
	      sectionMesh.name = `fa-nexus-building-wall-${doc?.id || 'tile'}-${meshIndex}`;
	      sectionMesh.eventMode = 'none';
	      sectionMesh.interactiveChildren = false;
	      container.addChild(sectionMesh);
	      if (textureEntry?.owner && pendingTextureOwners.has(textureEntry.owner)) {
	        retainOwnedSamplerTexture(container, textureEntry.owner);
	        pendingTextureOwners.delete(textureEntry.owner);
	      }
	      container.faNexusBuildingMeshes.push(sectionMesh);
	      applyMeshAlpha(sectionMesh, layerOpacity);
	      const sectionHsbc = normalizeHsbc(section?.hsbc ?? rootHsbc, null);
	      sectionMesh.faNexusBuildingSectionHsbc = sectionHsbc;
	      sectionMesh.faNexusBuildingSectionRenderIndex = section.renderIndex;
	      if (!hsbcValuesEqual(sectionHsbc, rootHsbc)) useContainerHsbc = false;
	      sectionMeshes.push({ mesh: sectionMesh, hsbc: sectionHsbc });
	      meshIndex += 1;
	    }

    for (const part of overWallParts) {
      await addCompositePart(container, doc, part);
    }
    await addBuildingV2PortalArtwork(container, portalArtwork);

	    if (!container.children?.length) {
	      resetBuildingOverlayToTransparent(tile, mesh, doc);
      return;
    }

    container.alpha = 1;
    container.faNexusBuildingRenderKey = renderKey;
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
        syncBuildingOverheadTransform(entry?.contentContainer, currentMesh, currentTile?.document);
      }
    });
    try {
      syncStandardMaskCustomSourceSuppression(tile, !!doc?.getFlag?.('fa-nexus', 'standardTileMask'), 'building-refresh');
    } catch (error) {
      Logger.warn?.('BuildingTiles.standardMaskSuppression.failed', {
        tileId: tile?.document?.id,
        error: String(error?.message || error)
      });
    }
    invalidateCustomTileOverhead(tile, 'building-refresh');
  } catch (error) {
    Logger.warn?.('BuildingTiles.apply.failed', { error: String(error?.message || error) });
  } finally {
    for (const owner of pendingTextureOwners) {
      try { owner.release(); } catch (_) {}
    }
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
      ensureMeshTransparent(mesh, 'faNexusBuildingOriginalTexture');
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
    ensureMeshTransparent(mesh, 'faNexusBuildingOriginalTexture');

    const renderKey = buildRenderKey('doorFrame', {
      tile: getTileRenderSignature(doc),
      data,
      texturePath
    }, doc?.id);
    const reusableContainer = tile.faNexusDoorFrameContainer || mesh.faNexusDoorFrameContainer;
    if (
      renderKey
      && reusableContainer?.faNexusDoorFrameRenderKey === renderKey
      && hasRenderableChildren(reusableContainer)
    ) {
      syncReusableDoorFrameRuntime(tile, mesh, doc, reusableContainer, 'building-door-frame-reuse');
      return;
    }

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
    container.faNexusDoorFrameRenderKey = renderKey;

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
        syncBuildingOverheadTransform(entry?.contentContainer, currentMesh, currentTile?.document);
      }
    });
    try {
      syncStandardMaskCustomSourceSuppression(tile, !!doc?.getFlag?.('fa-nexus', 'standardTileMask'), 'building-door-frame-refresh');
    } catch (error) {
      Logger.warn?.('BuildingTiles.doorFrame.standardMaskSuppression.failed', {
        tileId: tile?.document?.id,
        error: String(error?.message || error)
      });
    }
    invalidateCustomTileOverhead(tile, 'building-door-frame-refresh');
  } catch (error) {
    Logger.warn?.('BuildingTiles.doorFrame.apply.failed', { error: String(error?.message || error) });
  }
}

// The parts container the composite renderer draws. The retired legacy `buildingComposite` flag
// and the current-state `buildingSills` flag describe the SAME thing — an ordered list of parts
// on a transparent Tile — and the sill part path already keys on `flagKey buildingWindowSill`
// (see isAssetShadowManagedCompositePart), so managed sills are a flag-recognition change here
// rather than a second renderer.
export function readBuildingCompositePartsFlag(doc) {
  const composite = doc?.getFlag?.('fa-nexus', 'buildingComposite');
  if (composite) return composite;
  const sills = doc?.getFlag?.('fa-nexus', 'buildingSills');
  return sills ? { ...sills, role: 'sill' } : null;
}

export async function applyBuildingCompositeTile(tile) {
  try {
    if (!tile || tile.destroyed) return;
    const doc = tile.document;
    if (isEditingTile(tile)) {
      cleanupBuildingCompositeOverlay(tile);
      return;
    }
    const data = readBuildingCompositePartsFlag(doc);
    if (!data) {
      cleanupBuildingCompositeOverlay(tile);
      return;
    }
    if (data?.role === 'foreground' && doc?.getFlag?.('fa-nexus', 'building')) {
      cleanupBuildingCompositeOverlay(tile);
      return;
    }
    const parts = Array.isArray(data?.parts) ? data.parts.filter((part) => part && typeof part === 'object') : [];
    if (!parts.length) {
      cleanupBuildingCompositeOverlay(tile);
      return;
    }

    let mesh = tile.mesh;
    if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
    if (!mesh || mesh.destroyed) return;

    const renderKey = buildRenderKey('buildingComposite', {
      tile: getTileRenderSignature(doc),
      data
    }, doc?.id);
    const reusableContainer = tile.faNexusBuildingCompositeContainer || mesh.faNexusBuildingCompositeContainer;
    if (
      renderKey
      && reusableContainer?.faNexusBuildingCompositeRenderKey === renderKey
      && hasRenderableChildren(reusableContainer)
    ) {
      syncReusableBuildingCompositeRuntime(tile, mesh, doc, reusableContainer, 'building-composite-reuse');
      return;
    }

    const container = ensureBuildingCompositeContainer(tile, mesh);
    cleanupContainerChildren(container);
    container.name = 'fa-nexus-building-composite';
    container.alpha = 1;
    container.faNexusBuildingCompositeRenderKey = renderKey;

    const orderedParts = parts
      .map((part, index) => ({ ...part, __index: index }))
      .sort((left, right) => {
        const sortDelta = (Number(left?.sort) || 0) - (Number(right?.sort) || 0);
        if (Math.abs(sortDelta) > 1e-6) return sortDelta;
        return (Number(left?.__index) || 0) - (Number(right?.__index) || 0);
      });
    let renderedCount = 0;
    for (const part of orderedParts) {
      if (await addCompositePart(container, doc, part)) renderedCount += 1;
    }
    if (!renderedCount) {
      cleanupBuildingCompositeOverlay(tile);
      return;
    }

    setContainerTransform(container, mesh, doc);
    if (data?.role === 'background') raiseBackgroundCompositeAboveFill(tile, mesh, container);
    attachCustomTileOverhead(tile, {
      kind: 'building-composite',
      contentContainer: container,
      proxyFactory: createDisplayProxyFactory(container),
      syncContent: ({ tile: currentTile, mesh: currentMesh, entry }) => {
        syncBuildingOverheadTransform(entry?.contentContainer, currentMesh, currentTile?.document);
      }
    });
    try {
      syncStandardMaskCustomSourceSuppression(tile, !!doc?.getFlag?.('fa-nexus', 'standardTileMask'), 'building-composite-refresh');
    } catch (error) {
      Logger.warn?.('BuildingTiles.buildingComposite.standardMaskSuppression.failed', {
        tileId: tile?.document?.id,
        error: String(error?.message || error)
      });
    }
    invalidateCustomTileOverhead(tile, 'building-composite-refresh');
  } catch (error) {
    Logger.warn?.('BuildingTiles.buildingComposite.apply.failed', { error: String(error?.message || error) });
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

        const compositeData = readBuildingCompositePartsFlag(tile?.document);
        if (compositeData) applyBuildingCompositeTile(tile);
        else cleanupBuildingCompositeOverlay(tile);
      } catch (_) {}
    }
  } catch (_) {}
}

export function clearBuildingTileMeshWaiters() {
  clearSharedTileMeshWaiters('BuildingTiles.clearBuildingTileMeshWaiters');
}

try {
  registerCustomTileRenderLifecycle({
    id: 'building-tiles',
    callback: applyBuildingTile,
    logCode: 'BuildingTiles.lifecycle.failed'
  });
  registerCustomTileRenderLifecycle({
    id: 'building-door-frame-tiles',
    callback: applyDoorFrameTile,
    logCode: 'BuildingTiles.doorFrame.lifecycle.failed'
  });
  registerCustomTileRenderLifecycle({
    id: 'building-composite-tiles',
    callback: applyBuildingCompositeTile,
    logCode: 'BuildingTiles.composite.lifecycle.failed'
  });
  Hooks.on('canvasReady', () => {
    try { rehydrateBuildingTiles(); } catch (_) {}
  });
  Hooks.on('updateTile', (doc) => {
    try {
      const tile = resolveCanvasTilePlaceable(doc);
      if (tile) {
        applyBuildingTile(tile);
        applyDoorFrameTile(tile);
        applyBuildingCompositeTile(tile);
      }
    } catch (_) {}
  });
  // SINGLE-WRITER RULE for the linked Building cascade: it runs ONLY in the browsing session that
  // INITIATED the deletion. The discriminator is Foundry's own dispatch asymmetry: `preDeleteTile`
  // fires exclusively on the initiating client (ClientDatabaseBackend.#preDeleteDocumentArray runs
  // inside _deleteDocuments before the socket request), while broadcast receivers only ever run
  // `deleteTile`. A userId comparison is NOT a session discriminator — two tabs logged in as the
  // same GM share the userId, so under a userId rule a kicked-but-still-running zombie tab would
  // also consider itself the initiator and cascade concurrently. Entries expire so a vetoed
  // preDelete never leaks.
  const LOCAL_TILE_DELETE_INITIATIONS = new Map();
  const LOCAL_TILE_DELETE_INITIATION_TTL_MS = 60000;
  Hooks.on('preDeleteTile', (doc, options = {}) => {
    if (!canDeleteTileDuringBuildingEdit(doc, options)) {
      Logger.warn?.('BuildingTiles.deleteTile.blockedDuringEdit', {
        tileId: doc?.id || null,
        optionKeys: Object.keys(options || {})
      });
      globalThis.ui?.notifications?.warn?.(
        'This Building is currently being edited. Finish or cancel the edit before deleting it.'
      );
      return false;
    }
    try {
      const now = Date.now();
      for (const [tileId, at] of LOCAL_TILE_DELETE_INITIATIONS) {
        if (now - at > LOCAL_TILE_DELETE_INITIATION_TTL_MS) LOCAL_TILE_DELETE_INITIATIONS.delete(tileId);
      }
      if (doc?.id) LOCAL_TILE_DELETE_INITIATIONS.set(doc.id, now);
    } catch (_) {}
    return true;
  });
  Hooks.on('deleteTile', (doc, options) => {
    try {
      const tile = resolveCanvasTilePlaceable(doc);
      if (tile) {
        cleanupBuildingOverlay(tile);
        cleanupDoorFrameOverlay(tile);
        cleanupBuildingCompositeOverlay(tile);
      }
    } catch (_) {}
    const locallyInitiated = doc?.id ? LOCAL_TILE_DELETE_INITIATIONS.delete(doc.id) : false;
    if (!locallyInitiated) {
      Logger.debug?.('BuildingTiles.deleteTile.cascadeSkipped.foreignSession', {
        tileId: doc?.id || null,
        optionKeys: Object.keys(options || {})
      });
      return;
    }
    if (!shouldSkipLinkedBuildingDeletes(doc, options)) {
      Promise.resolve(cleanupLinkedBuildingTiles(doc, options)).catch((error) => {
        Logger.warn?.('BuildingTiles.deleteTile.cleanup.failed', {
          tileId: doc?.id || null,
          error: String(error?.message || error)
        });
        // The cascade owns removing a deleted Building's generated documents; a rejection here
        // leaves orphans on the Scene, so the user is told, not only the console.
        globalThis.ui?.notifications?.warn?.(
          `Building linked cleanup failed for Tile ${doc?.id || '(unknown)'}: ${String(error?.message || error)}.`
          + ' Generated documents may remain on the Scene.'
        );
      });
    }
  });
  Hooks.on('canvasTearDown', () => {
    try { clearBuildingTileMeshWaiters(); } catch (_) {}
  });
} catch (error) {
  // These registrations install the Building render lifecycle AND the single-writer cascade
  // guards. Failing to register them silently would disable both without a trace, so the failure
  // is loud: without the guards, Building deletions stop cascading at all.
  Logger.error?.('BuildingTiles.hookRegistration.failed', { error: String(error?.message || error) });
  globalThis.ui?.notifications?.error?.(
    `FA Nexus Building Tile hooks failed to register: ${String(error?.message || error)}.`
    + ' Building rendering and linked cleanup are disabled for this session.'
  );
}
