import { onFoundryBoot } from '../core/foundry-boot-hooks.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { applyHsbcToDisplayObject } from '../core/hsbc-editor-helpers.js';
import { resolveTileRenderOrder } from '../canvas/tile-band-utils.js';
import {
  createSeamlessSecretDoorLeafTexturePlan,
  reconstructTransientPortalSurface
} from './seamless-surface-runtime.js';

const MODULE_ID = 'fa-nexus';
const SURFACE_FLAG = 'buildingSeamlessSecretDoor';
const PATCH_MARKER = Symbol.for('fa-nexus.seamless-secret-door-runtime');
const HOOK_MARKER = Symbol.for('fa-nexus.seamless-secret-door-runtime.hooks');
const OWNER_SHADOW_SORT_GAP = 0.0001;
const SEAMLESS_SURFACE_SORT_OFFSET = OWNER_SHADOW_SORT_GAP / 2;

function getSurfacePlan(document) {
  return document?.flags?.[MODULE_ID]?.[SURFACE_FLAG]?.surfacePlan
    || document?._source?.flags?.[MODULE_ID]?.[SURFACE_FLAG]?.surfacePlan
    || null;
}

function getSurfacePlanSignature(plan) {
  return plan ? JSON.stringify(plan) : '';
}

function requireRuntime() {
  const renderer = globalThis?.canvas?.app?.renderer;
  const PIXIRef = globalThis?.PIXI;
  const loadTexture = globalThis?.foundry?.canvas?.loadTexture;
  if (!renderer || !PIXIRef?.RenderTexture || !PIXIRef?.TilingSprite || !PIXIRef?.Sprite || !PIXIRef?.Container) {
    throw new Error('Foundry canvas renderer is unavailable for Seamless Secret Door reconstruction.');
  }
  if (typeof loadTexture !== 'function') {
    throw new Error('Foundry texture loader is unavailable for Seamless Secret Door reconstruction.');
  }
  return { renderer, PIXIRef, loadTexture };
}

export function renderSeamlessSecretDoorTextureFromDisplayObject(displayObject, {
  width,
  height,
  resolution = 1,
  renderer,
  PIXIRef
}) {
  let texture = null;
  let renderError = null;
  let displayCleanupError = null;
  try {
    texture = PIXIRef.RenderTexture.create({ width, height, resolution });
    renderer.render(displayObject, { renderTexture: texture, clear: true });
  } catch (error) {
    renderError = error;
  }
  try {
    displayObject.destroy({ children: true });
  } catch (error) {
    displayCleanupError = error;
  }
  if (renderError || displayCleanupError) {
    let textureCleanupError = null;
    try {
      texture?.destroy?.(true);
    } catch (error) {
      textureCleanupError = error;
    }
    const errors = [renderError, displayCleanupError, textureCleanupError].filter(Boolean);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, 'Seamless Secret Door texture render cleanup failed.');
  }
  return texture;
}

export function destroySeamlessSecretDoorOwnedTextures(textures, {
  cause = null,
  operation = 'texture cleanup'
} = {}) {
  const cleanupErrors = [];
  const visited = new Set();
  for (const texture of Array.isArray(textures) ? textures : [textures]) {
    if (!texture || visited.has(texture)) continue;
    visited.add(texture);
    try {
      if (!texture.destroyed) texture.destroy(true);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cause && cleanupErrors.length) {
    throw new AggregateError(
      [cause, ...cleanupErrors],
      `Seamless Secret Door ${operation} failed after an earlier error.`
    );
  }
  if (cause) throw cause;
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, `Seamless Secret Door ${operation} failed.`);
  }
  return true;
}

function rollbackStagedDoorMeshReplacement({ meshes, resource, currentResource, cause }) {
  const cleanupErrors = [];
  for (const mesh of meshes) {
    try { mesh?.parent?.removeChild?.(mesh); } catch (error) { cleanupErrors.push(error); }
    try { if (mesh && !mesh.destroyed) mesh.destroy(); } catch (error) { cleanupErrors.push(error); }
  }
  if (resource && resource !== currentResource) {
    try { resource.destroy(); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) {
    throw new AggregateError(
      [cause, ...cleanupErrors],
      'Seamless Secret Door replacement and staged-resource rollback both failed.'
    );
  }
  throw cause;
}

export function resolveSeamlessSecretDoorNativeScaleY(plan, {
  sceneGridSize,
  currentScaleY = 1,
  textureHeight = null
} = {}) {
  const sceneGrid = Number(sceneGridSize);
  if (!Number.isFinite(sceneGrid) || sceneGrid <= 0) {
    throw new Error('Seamless Secret Door requires a positive Foundry scene grid size.');
  }
  const persistedTextureGrid = Number(plan?.textureGridSize);
  const textureGrid = Number.isFinite(persistedTextureGrid) && persistedTextureGrid > 0
    ? persistedTextureGrid
    : sceneGrid;
  const plannedWallWidth = Number(plan?.wallWidth);
  const renderedTextureHeight = Number(textureHeight);
  const rasterHeightCorrection = Number.isFinite(plannedWallWidth) && plannedWallWidth > 0
    && Number.isFinite(renderedTextureHeight) && renderedTextureHeight > 0
    ? plannedWallWidth / renderedTextureHeight
    : 1;
  const sign = Math.sign(Number(currentScaleY)) || 1;
  // V2 recipes already carry transformed world-space Wall thickness. Their
  // captured texture grid must not resize that thickness after a Scene edit.
  const gridRatio = plan?.version === 2 ? 1 : sceneGrid / textureGrid;
  return sign * gridRatio * rasterHeightCorrection;
}

export function applySeamlessSecretDoorMeshPresentation(mesh, plan, offset) {
  const dx = Number(offset?.x) || 0;
  const dy = Number(offset?.y) || 0;
  const previousPresentation = mesh?.faNexusSeamlessSecretDoorPresentation || null;
  const previousDx = Number(previousPresentation?.offsetX) || 0;
  const previousDy = Number(previousPresentation?.offsetY) || 0;
  const closed = mesh?._closedPosition;
  const animated = mesh?._animatedPosition;
  if (!closed || !animated || typeof mesh?.position?.set !== 'function' || typeof mesh?.scale?.set !== 'function') {
    throw new Error('Foundry DoorMesh presentation state is unavailable for Seamless Secret Door alignment.');
  }
  const nativeScaleY = resolveSeamlessSecretDoorNativeScaleY(plan, {
    sceneGridSize: globalThis?.canvas?.scene?._source?.grid?.size,
    currentScaleY: closed.scaleY,
    textureHeight: mesh?.texture?.height
  });
  const currentClosedScaleY = Number(closed.scaleY);
  if (!Number.isFinite(currentClosedScaleY) || Math.abs(currentClosedScaleY) < 1e-6) {
    throw new Error('Foundry DoorMesh closed vertical scale is invalid for Seamless Secret Door alignment.');
  }
  const previousClosedX = Number(previousPresentation?.closedX);
  const previousClosedY = Number(previousPresentation?.closedY);
  const alreadyOffset = Number.isFinite(previousClosedX) && Number.isFinite(previousClosedY)
    && Math.abs(Number(closed.x) - previousClosedX) < 1e-6
    && Math.abs(Number(closed.y) - previousClosedY) < 1e-6;
  const verticalScaleRatio = nativeScaleY / currentClosedScaleY;
  closed.scaleY = nativeScaleY;
  animated.scaleY *= verticalScaleRatio;
  closed.x += dx - (alreadyOffset ? previousDx : 0);
  closed.y += dy - (alreadyOffset ? previousDy : 0);
  animated.x += dx - (alreadyOffset ? previousDx : 0);
  animated.y += dy - (alreadyOffset ? previousDy : 0);
  mesh.position.set(animated.x, animated.y);
  mesh.scale.set(animated.scaleX, animated.scaleY);
  mesh.faNexusSeamlessSecretDoorPresentation = Object.freeze({
    nativeScaleY,
    textureHeight: Number(mesh?.texture?.height) || null,
    wallWidth: Number(plan?.wallWidth) || null,
    offsetX: dx,
    offsetY: dy,
    closedX: Number(closed.x),
    closedY: Number(closed.y)
  });
}

export function applySeamlessSecretDoorMeshPresentationForDocument(document, mesh) {
  const plan = getSurfacePlan(document);
  if (!plan) return false;
  applySeamlessSecretDoorMeshPresentation(mesh, plan, plan.visualOffset);
  applySeamlessSecretDoorOwnerRenderOrder(document, mesh);
  return true;
}

export function resolveSeamlessSecretDoorMeshRenderOrder(ownerRenderOrder, { aboveOwner = false } = {}) {
  const elevation = Number(ownerRenderOrder?.elevation);
  const sortLayer = Number(ownerRenderOrder?.sortLayer);
  const ownerSort = Number(ownerRenderOrder?.sort);
  if (![elevation, sortLayer, ownerSort].every(Number.isFinite)) {
    throw new Error('Seamless Secret Door requires a finite owning Building Tile render order.');
  }
  const sort = ownerSort + (aboveOwner ? SEAMLESS_SURFACE_SORT_OFFSET : -SEAMLESS_SURFACE_SORT_OFFSET);
  return { elevation, sortLayer, sort, zIndex: sort };
}

export function applySeamlessSecretDoorOwnerRenderOrder(document, mesh, {
  canvasRef = globalThis?.canvas,
  resolveRenderOrder = resolveTileRenderOrder
} = {}) {
  const tileId = String(document?.flags?.[MODULE_ID]?.buildingWall?.tileId || '').trim();
  if (!tileId) return false;
  const ownerTile = document?.object?.faNexusPreviewOwnerTile
    || canvasRef?.scene?.tiles?.get?.(tileId)
    || canvasRef?.tiles?.get?.(tileId)?.document
    || canvasRef?.tiles?.placeables?.find?.((tile) => String(tile?.document?.id || tile?.id || '') === tileId)?.document
    || null;
  if (!ownerTile) {
    throw new Error(`Seamless Secret Door owning Building Tile ${tileId} is unavailable.`);
  }
  const flattened = ownerTile.flags?.[MODULE_ID]?.flattened?.composition;
  let renderOwner = ownerTile;
  if (flattened) {
    // A baked band can contain opaque floor pixels behind the Portal. Its live
    // leaf must draw above that image. Resolve existing ground-owned sections
    // through the same registry, without changing their archived identities.
    const scene = document.parent || canvasRef?.scene;
    const bands = [ownerTile, ...(scene?.flags?.[MODULE_ID]?.compositionRegistry?.relationships || [])
      .filter(relation => relation.ownerUuid === flattened.ownerUuid && relation.generator === 'flatten')
      .map(relation => scene.tiles.get(relation.dependentUuid.split('.').at(-1)))
      .filter(tile => tile?.flags?.[MODULE_ID]?.flattened?.composition?.ownerUuid === flattened.ownerUuid)];
    const priority = { foreground: 0, middle: 1, background: 2 };
    renderOwner = bands.sort((a, b) => priority[a.flags[MODULE_ID].flattened.layerRole] - priority[b.flags[MODULE_ID].flattened.layerRole])[0];
  }
  const order = resolveSeamlessSecretDoorMeshRenderOrder(resolveRenderOrder(renderOwner), { aboveOwner: !!flattened });
  mesh.elevation = order.elevation;
  mesh.sortLayer = order.sortLayer;
  mesh.sort = order.sort;
  mesh.zIndex = order.zIndex;
  for (const snapshot of [mesh?._closedPosition, mesh?._animatedPosition]) {
    if (!snapshot || typeof snapshot !== 'object') continue;
    snapshot.elevation = order.elevation;
    snapshot.sort = order.sort;
  }
  mesh.faNexusSeamlessSecretDoorOwnerRenderOrder = Object.freeze({ tileId, ...order });
  return true;
}

function renderTextureRegion(sourceTexture, region, runtime) {
  const { PIXIRef } = runtime;
  const container = new PIXIRef.Container();
  const sprite = new PIXIRef.Sprite(sourceTexture);
  sprite.position.set(-region.x, -region.y);
  container.addChild(sprite);
  return renderSeamlessSecretDoorTextureFromDisplayObject(container, {
    width: region.width,
    height: region.height,
    ...runtime
  });
}

function renderTextureCrop(sourceTexture, crop, height, runtime) {
  const { PIXIRef } = runtime;
  const container = new PIXIRef.Container();
  const sprite = new PIXIRef.Sprite(sourceTexture);
  if (crop.reverse) {
    sprite.position.x = crop.sourceEnd;
    sprite.scale.x = -1;
  } else {
    sprite.position.x = -crop.sourceStart;
  }
  container.addChild(sprite);
  return renderSeamlessSecretDoorTextureFromDisplayObject(container, {
    width: crop.sourceEnd - crop.sourceStart,
    height,
    ...runtime
  });
}

export function createSeamlessSecretDoorSurfaceRenderPlan(plan, sourceTexture) {
  const sourceWidth = Math.max(1, Number(sourceTexture?.width ?? sourceTexture?.baseTexture?.width) || 1);
  const sourceHeight = Math.max(1, Number(sourceTexture?.height ?? sourceTexture?.baseTexture?.height) || 1);
  const outputWidth = createSeamlessSecretDoorLeafTexturePlan(plan?.spanLength).fullWidth;
  const outputHeight = Math.max(1, Math.ceil(Number(plan?.wallWidth) || 0));
  const visibleRows = plan?.visibleRows;
  let sourceCrop = { top: 0, height: sourceHeight };
  if (visibleRows && typeof visibleRows === 'object') {
    const totalHeight = Math.max(1, Number(visibleRows.totalHeight) || sourceHeight);
    const topRatio = Math.min(1, Math.max(0, Number(visibleRows.topRow) || 0) / totalHeight);
    const bottomRatio = Math.min(1, Math.max(0,
      ((Number(visibleRows.bottomRow) || 0) + 1) / totalHeight));
    const top = Math.min(sourceHeight - 1, Math.max(0, Math.floor(topRatio * sourceHeight)));
    const bottom = Math.min(sourceHeight, Math.max(top + 1, Math.ceil(bottomRatio * sourceHeight)));
    sourceCrop = { top, height: bottom - top };
  }
  const repeatDistance = Math.max(0.001, Number(plan?.repeatDistance) || outputWidth);
  const horizontalSign = plan?.textureFlip?.horizontal ? -1 : 1;
  const verticalSign = plan?.textureFlip?.vertical ? -1 : 1;
  const visualOffsetX = Number(plan?.visualOffset?.x) || 0;
  const visualOffsetY = Number(plan?.visualOffset?.y) || 0;
  return {
    outputWidth,
    outputHeight,
    sourceCrop,
    tileScale: {
      x: horizontalSign * (repeatDistance / sourceWidth),
      y: verticalSign * (outputHeight / sourceCrop.height)
    },
    tilePosition: {
      x: -((Number(plan?.phaseDistance) || 0)
        + (horizontalSign * (Number(plan?.textureOffset?.x) || 0))),
      y: 0
    },
    meshOffset: { x: visualOffsetX, y: visualOffsetY }
  };
}

export function resolveSeamlessSecretDoorRenderResolution(plan, sourceTexture, {
  maxResolution = Number.POSITIVE_INFINITY,
  maxTextureSize = 8192
} = {}) {
  const renderPlan = createSeamlessSecretDoorSurfaceRenderPlan(plan, sourceTexture);
  const sourceWidth = Math.max(1, Number(sourceTexture?.width ?? sourceTexture?.baseTexture?.width) || 1);
  const sourceResolution = resolveSeamlessSecretDoorSourceResolution(sourceTexture);
  const repeatDistance = Math.max(0.001, Number(plan?.repeatDistance) || renderPlan.outputWidth);
  const horizontalDensity = (sourceWidth * sourceResolution) / repeatDistance;
  const verticalDensity = (renderPlan.sourceCrop.height * sourceResolution) / renderPlan.outputHeight;
  const numericResolutionCap = Number(maxResolution);
  const cap = Number.isFinite(numericResolutionCap) ? Math.max(1, numericResolutionCap) : Number.POSITIVE_INFINITY;
  const textureLimit = Math.max(1, Number(maxTextureSize) || 8192);
  if (renderPlan.outputWidth > textureLimit || renderPlan.outputHeight > textureLimit) {
    throw new Error(`Seamless Secret Door surface ${renderPlan.outputWidth}x${renderPlan.outputHeight} exceeds the renderer texture limit ${textureLimit}.`);
  }
  const dimensionCap = Math.min(
    textureLimit / renderPlan.outputWidth,
    textureLimit / renderPlan.outputHeight
  );
  return Math.min(cap, dimensionCap, Math.max(1, horizontalDensity, verticalDensity));
}

export function resolveSeamlessSecretDoorSourceResolution(sourceTexture) {
  return Math.max(1, Number(
    sourceTexture?.resolution
      ?? sourceTexture?.baseTexture?.resolution
      ?? sourceTexture?.source?.resolution
  ) || 1);
}

function resolveRendererMaxTextureSize(renderer) {
  const gl = renderer?.gl || renderer?.context?.gl || null;
  const glLimit = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE);
  const gpuLimit = renderer?.gpu?.device?.limits?.maxTextureDimension2D
    ?? renderer?.device?.limits?.maxTextureDimension2D
    ?? renderer?.limits?.maxTextureDimension2D;
  return Math.max(1, Number(glLimit ?? gpuLimit) || 8192);
}

export async function renderSeamlessSecretDoorSurface(plan, sourceTexture, { renderer, PIXIRef }) {
  const leafPlan = createSeamlessSecretDoorLeafTexturePlan(plan.spanLength);
  const renderPlan = createSeamlessSecretDoorSurfaceRenderPlan(plan, sourceTexture);
  const resolution = resolveSeamlessSecretDoorRenderResolution(plan, sourceTexture, {
    maxTextureSize: resolveRendererMaxTextureSize(renderer)
  });
  const width = renderPlan.outputWidth;
  const height = renderPlan.outputHeight;
  let visibleSourceTexture = null;
  const needsVisibleRowCrop = renderPlan.sourceCrop.top > 0
    || renderPlan.sourceCrop.height < Math.max(1, Number(sourceTexture?.height ?? sourceTexture?.baseTexture?.height) || 1);
  if (needsVisibleRowCrop) {
    visibleSourceTexture = renderTextureRegion(sourceTexture, {
      x: 0,
      y: renderPlan.sourceCrop.top,
      width: Math.max(1, Number(sourceTexture?.width ?? sourceTexture?.baseTexture?.width) || 1),
      height: renderPlan.sourceCrop.height
    }, {
      resolution: resolveSeamlessSecretDoorSourceResolution(sourceTexture),
      renderer,
      PIXIRef
    });
  }
  const container = new PIXIRef.Container();
  const sprite = new PIXIRef.TilingSprite(visibleSourceTexture || sourceTexture, width, height);
  sprite.tileScale.set(renderPlan.tileScale.x, renderPlan.tileScale.y);
  sprite.tilePosition.set(renderPlan.tilePosition.x, renderPlan.tilePosition.y);
  sprite.alpha = Math.min(1, Math.max(0, Number(plan.opacity ?? 1)));
  applyHsbcToDisplayObject(sprite, plan.hsbc || null, { slot: 'seamless-secret-door-surface' });
  container.addChild(sprite);
  let canonicalTexture = null;
  let texture = null;
  let doubleLeftTexture = null;
  let doubleRightTexture = null;
  try {
    canonicalTexture = renderSeamlessSecretDoorTextureFromDisplayObject(container, {
      width,
      height,
      resolution,
      renderer,
      PIXIRef
    });
    if (plan.directionReversed) {
      const orientationContainer = new PIXIRef.Container();
      const orientationSprite = new PIXIRef.Sprite(canonicalTexture);
      orientationSprite.position.x = width;
      orientationSprite.scale.x = -1;
      orientationContainer.addChild(orientationSprite);
      texture = renderSeamlessSecretDoorTextureFromDisplayObject(orientationContainer, {
        width,
        height,
        resolution,
        renderer,
        PIXIRef
      });
      canonicalTexture.destroy(true);
      canonicalTexture = null;
    } else {
      texture = canonicalTexture;
      canonicalTexture = null;
    }
    doubleLeftTexture = renderTextureCrop(texture, leafPlan.left, height, { resolution, renderer, PIXIRef });
    doubleRightTexture = renderTextureCrop(texture, leafPlan.right, height, { resolution, renderer, PIXIRef });
    visibleSourceTexture?.destroy?.(true);
    visibleSourceTexture = null;
  } catch (error) {
    destroySeamlessSecretDoorOwnedTextures(
      [visibleSourceTexture, canonicalTexture, texture, doubleLeftTexture, doubleRightTexture],
      { cause: error, operation: 'surface reconstruction rollback' }
    );
  }
  return {
    texture,
    meshOffset: renderPlan.meshOffset,
    presentationPlan: Object.freeze({
      textureGridSize: Number(plan?.textureGridSize) || null,
      wallWidth: Number(plan?.wallWidth) || null
    }),
    surfacePlanSignature: getSurfacePlanSignature(plan),
    textures: Object.freeze({
      single: texture,
      doubleLeft: doubleLeftTexture,
      doubleRight: doubleRightTexture
    }),
    textureForStyle(style, DoorMesh) {
      if (style === DoorMesh?.DOOR_STYLES?.DOUBLE_LEFT) return doubleLeftTexture;
      if (style === DoorMesh?.DOOR_STYLES?.DOUBLE_RIGHT) return doubleRightTexture;
      return texture;
    },
    destroy() {
      return destroySeamlessSecretDoorOwnedTextures(
        [texture, doubleLeftTexture, doubleRightTexture],
        { operation: 'surface resource cleanup' }
      );
    }
  };
}

export function resolveSeamlessSecretDoorCompositeResolution(plan, textures, maxTextureSize = 8192) {
  const width = createSeamlessSecretDoorLeafTexturePlan(plan.spanLength).fullWidth;
  const height = Math.max(1, Math.ceil(plan.wallWidth));
  const density = Math.max(1, ...plan.parts.map((part, index) => {
    const texture = textures[index], renderPlan = createSeamlessSecretDoorSurfaceRenderPlan(part, texture);
    const sourceResolution = resolveSeamlessSecretDoorSourceResolution(texture);
    return Math.max(texture.width * sourceResolution / part.repeatDistance * plan.spanLength / width,
      renderPlan.sourceCrop.height * sourceResolution / part.wallWidth * plan.wallWidth / height);
  }));
  // Budget the complete leaf, including tiny cuts at a closed carrier seam.
  return Math.min(density, maxTextureSize / width, maxTextureSize / height);
}

async function reconstructCompositeSeamlessSurface(plan, runtime) {
  const { PIXIRef, renderer } = runtime;
  if (!Array.isArray(plan.parts) || !plan.parts.length || !(plan.wallWidth > 0) || !(plan.spanLength > 0)) {
    throw new Error('Seamless Secret Door requires a complete composite Wall surface.');
  }
  const sourceViews = [], ownedTextures = [];
  let container = null;
  try {
    const sources = await Promise.all(plan.parts.map(part => runtime.loadTexture(part.sourceTexture)));
    const leafPlan = createSeamlessSecretDoorLeafTexturePlan(plan.spanLength);
    const width = leafPlan.fullWidth, height = Math.max(1, Math.ceil(plan.wallWidth));
    const resolution = resolveSeamlessSecretDoorCompositeResolution(plan, sources, resolveRendererMaxTextureSize(renderer));
    const dx = (plan.span.end.x - plan.span.start.x) / plan.spanLength;
    const dy = (plan.span.end.y - plan.span.start.y) / plan.spanLength;
    const centerOffset = -dy * plan.visualOffset.x + dx * plan.visualOffset.y;
    container = new PIXIRef.Container();
    for (const [index, part] of plan.parts.entries()) {
      const source = sources[index], renderPlan = createSeamlessSecretDoorSurfaceRenderPlan(part, source);
      const crop = renderPlan.sourceCrop;
      const view = new PIXIRef.Texture(source.baseTexture, new PIXIRef.Rectangle(
        source.frame.x, source.frame.y + crop.top, source.width, crop.height));
      sourceViews.push(view);
      const scaleX = width / plan.spanLength, scaleY = height / plan.wallWidth;
      const sprite = new PIXIRef.TilingSprite(view, part.spanLength * scaleX, part.wallWidth * scaleY);
      sprite.tileScale.set(renderPlan.tileScale.x * scaleX,
        (part.textureFlip?.vertical ? -1 : 1) * part.wallWidth * scaleY / crop.height);
      sprite.tilePosition.set(renderPlan.tilePosition.x * scaleX, 0);
      sprite.alpha = Math.min(1, Math.max(0, Number(part.opacity ?? 1)));
      applyHsbcToDisplayObject(sprite, part.hsbc || null, { slot: 'seamless-secret-door-surface' });
      const offset = -dy * part.visualOffset.x + dx * part.visualOffset.y;
      sprite.position.set((part.directionReversed ? part.endDistance : part.startDistance) * scaleX,
        height / 2 + (offset - centerOffset - part.wallWidth / 2) * scaleY);
      if (part.directionReversed) sprite.scale.x = -1;
      container.addChild(sprite);
    }
    if (plan.hingeFlip) { container.position.set(width, height); container.scale.set(-1, -1); }
    const texture = renderSeamlessSecretDoorTextureFromDisplayObject(container, { width, height, resolution, renderer, PIXIRef });
    container = null; ownedTextures.push(texture);
    const doubleLeft = renderTextureCrop(texture, leafPlan.left, height, { resolution, renderer, PIXIRef }); ownedTextures.push(doubleLeft);
    const doubleRight = renderTextureCrop(texture, leafPlan.right, height, { resolution, renderer, PIXIRef }); ownedTextures.push(doubleRight);
    for (const view of sourceViews) view.destroy(false);
    sourceViews.length = 0;
    return { texture, meshOffset: plan.visualOffset,
      presentationPlan: { version: plan.version, textureGridSize: plan.textureGridSize, wallWidth: plan.wallWidth },
      surfacePlanSignature: getSurfacePlanSignature(plan),
      textureForStyle: (style, DoorMesh) => style === DoorMesh?.DOOR_STYLES?.DOUBLE_LEFT ? doubleLeft
        : style === DoorMesh?.DOOR_STYLES?.DOUBLE_RIGHT ? doubleRight : texture,
      destroy: () => destroySeamlessSecretDoorOwnedTextures(ownedTextures, { operation: 'composite surface cleanup' }) };
  } catch (cause) {
    const errors = [cause];
    if (container && !container.destroyed) { try { container.destroy({ children: true }); } catch (error) { errors.push(error); } }
    for (const view of sourceViews) { try { view.destroy(false); } catch (error) { errors.push(error); } }
    try { destroySeamlessSecretDoorOwnedTextures(ownedTextures, { operation: 'composite surface rollback' }); } catch (error) { errors.push(error); }
    throw errors.length === 1 ? cause : new AggregateError(errors, 'Seamless Secret Door composition and rollback failed.');
  }
}

export async function reconstructSeamlessSecretDoorSurface(plan) {
  const runtime = requireRuntime();
  if (plan?.version === 2) return reconstructCompositeSeamlessSurface(plan, runtime);
  return reconstructTransientPortalSurface(plan, {
    loadSourceTexture: runtime.loadTexture,
    renderSurface: (surfacePlan, sourceTexture) => renderSeamlessSecretDoorSurface(surfacePlan, sourceTexture, runtime),
    validateSurface: (texture) => {
      const textureSource = texture?.source || texture?.baseTexture || null;
      const sourceInvalid = textureSource && textureSource.valid === false;
      const dimensionsInvalid = !(Number(texture?.width) > 0) || !(Number(texture?.height) > 0);
      if (!texture || texture.destroyed || sourceInvalid || dimensionsInvalid) {
        throw new Error('Seamless Secret Door reconstruction produced an invalid in-memory texture.');
      }
    }
  });
}

export async function preflightSeamlessSecretDoorSurface(plan) {
  const resource = await reconstructSeamlessSecretDoorSurface(plan);
  resource.destroy();
  return true;
}

export async function loadSeamlessSecretDoorTextureForDocument(document) {
  const plan = getSurfacePlan(document);
  return plan ? reconstructSeamlessSecretDoorSurface(plan) : null;
}

function installWallDoorMeshPatch() {
  const Wall = globalThis?.foundry?.canvas?.placeables?.Wall;
  const DoorMesh = globalThis?.foundry?.canvas?.containers?.DoorMesh;
  if (!Wall?.prototype || !DoorMesh || Wall.prototype[PATCH_MARKER]) return false;
  const originalCreate = Wall.prototype.createDoorMeshes;
  const originalDestroy = Wall.prototype.destroyDoorMeshes;
  if (typeof originalCreate !== 'function' || typeof originalDestroy !== 'function') {
    throw new Error('Foundry Wall DoorMesh lifecycle is unavailable for Seamless Secret Doors.');
  }
  Object.defineProperty(Wall.prototype, PATCH_MARKER, { value: true });
  Wall.prototype.destroyDoorMeshes = function destroySeamlessSecretDoorMeshes() {
    this.faNexusSeamlessSecretDoorGeneration = Number(this.faNexusSeamlessSecretDoorGeneration || 0) + 1;
    originalDestroy.call(this);
    const resource = this.faNexusSeamlessSecretDoorSurface;
    this.faNexusSeamlessSecretDoorSurface = null;
    this.faNexusSeamlessSecretDoorSurfacePlanSignature = '';
    resource?.destroy?.();
  };
  Wall.prototype.createDoorMeshes = async function createSeamlessSecretDoorMeshes() {
    const plan = getSurfacePlan(this.document);
    if (!plan) {
      if (this.faNexusSeamlessSecretDoorSurface) this.destroyDoorMeshes();
      return originalCreate.call(this);
    }
    if (this.isPreview || !this.hasDoorMesh) {
      this.destroyDoorMeshes();
      return;
    }
    const generation = Number(this.faNexusSeamlessSecretDoorGeneration || 0) + 1;
    this.faNexusSeamlessSecretDoorGeneration = generation;
    let resource = null;
    let previousResource = null;
    const stagedMeshes = [];
    try {
      resource = await reconstructSeamlessSecretDoorSurface(plan);
      const signature = getSurfacePlanSignature(plan);
      if (this.faNexusSeamlessSecretDoorGeneration !== generation
        || signature !== getSurfacePlanSignature(getSurfacePlan(this.document))) {
        resource.destroy();
        return;
      }
      const { texture: _ignored, ...animation } = this.document.animation;
      const styles = [animation.double ? DoorMesh.DOOR_STYLES.DOUBLE_LEFT : DoorMesh.DOOR_STYLES.SINGLE];
      if (animation.double) styles.push(DoorMesh.DOOR_STYLES.DOUBLE_RIGHT);
      for (const style of styles) {
        const mesh = new DoorMesh({ object: this, texture: resource.textureForStyle(style, DoorMesh), style, ...animation });
        stagedMeshes.push(mesh);
        applySeamlessSecretDoorMeshPresentation(mesh, plan, resource.meshOffset);
        applySeamlessSecretDoorOwnerRenderOrder(this.document, mesh);
        canvas.primary.addChild(mesh);
      }
      previousResource = this.faNexusSeamlessSecretDoorSurface;
      originalDestroy.call(this);
      this.faNexusSeamlessSecretDoorSurface = resource;
      this.faNexusSeamlessSecretDoorSurfacePlanSignature = signature;
      for (const mesh of stagedMeshes) this.doorMeshes.add(mesh);
      globalThis.Hooks?.callAll?.('faNexusSeamlessSecretDoorMeshesReplaced', this);
    } catch (error) {
      let visibleError = error;
      try {
        rollbackStagedDoorMeshReplacement({
          meshes: stagedMeshes,
          resource,
          currentResource: this.faNexusSeamlessSecretDoorSurface,
          cause: error
        });
      } catch (rollbackError) {
        visibleError = rollbackError;
      }
      Logger.error('SeamlessSecretDoorRuntime.createDoorMeshes.failed', {
        wallId: this.document?.id || null,
        portalId: plan.portalId || null,
        error: String(visibleError?.message || visibleError)
      });
      globalThis.ui?.notifications?.error?.(`Seamless Secret Door rendering failed: ${visibleError?.message || visibleError}`);
      throw visibleError;
    }
    if (previousResource && previousResource !== resource) {
      try {
        previousResource.destroy();
      } catch (error) {
        Logger.error('SeamlessSecretDoorRuntime.previousSurfaceCleanup.failed', {
          wallId: this.document?.id || null,
          portalId: plan.portalId || null,
          error: String(error?.message || error)
        });
        globalThis.ui?.notifications?.error?.(`Seamless Secret Door previous surface cleanup failed: ${error?.message || error}`);
        throw error;
      }
    }
  };
  return true;
}

function installSurfacePlanUpdateHook() {
  const hooks = globalThis.Hooks;
  if (!hooks?.on || hooks[HOOK_MARKER]) return false;
  Object.defineProperty(hooks, HOOK_MARKER, { value: true });
  hooks.on('updateWall', (document) => {
    const wall = document?.object || globalThis?.canvas?.walls?.get?.(document?.id) || null;
    if (!wall || wall.destroyed) return;
    const nextSignature = getSurfacePlanSignature(getSurfacePlan(document));
    const currentSignature = String(wall.faNexusSeamlessSecretDoorSurfacePlanSignature || '');
    if (nextSignature === currentSignature) {
      const plan = getSurfacePlan(document);
      if (!plan) return;
      Promise.resolve().then(() => {
        for (const mesh of Array.from(wall.doorMeshes || [])) {
          if (!mesh || mesh.destroyed) continue;
          applySeamlessSecretDoorMeshPresentation(mesh, plan, plan.visualOffset);
          applySeamlessSecretDoorOwnerRenderOrder(document, mesh);
        }
      }).catch((error) => {
        Logger.error('SeamlessSecretDoorRuntime.updateWallPresentation.failed', {
          wallId: document?.id || null,
          error: String(error?.message || error)
        });
        globalThis.ui?.notifications?.error?.(
          `Seamless Secret Door presentation refresh failed; rebuilding the rendered surface: ${error?.message || error}`
        );
        return Promise.resolve(wall.createDoorMeshes()).catch((rebuildError) => {
          Logger.error('SeamlessSecretDoorRuntime.updateWallPresentation.rebuildFailed', {
            wallId: document?.id || null,
            error: String(rebuildError?.message || rebuildError)
          });
        });
      });
      return;
    }
    Promise.resolve(wall.createDoorMeshes()).catch((error) => {
      Logger.error('SeamlessSecretDoorRuntime.updateWall.failed', {
        wallId: document?.id || null,
        error: String(error?.message || error)
      });
    });
  });
  return true;
}

if (globalThis.Hooks?.once) {
  onFoundryBoot('init', installWallDoorMeshPatch);
  onFoundryBoot('ready', () => {
    installWallDoorMeshPatch();
    installSurfacePlanUpdateHook();
  });
}
installWallDoorMeshPatch();
installSurfacePlanUpdateHook();
