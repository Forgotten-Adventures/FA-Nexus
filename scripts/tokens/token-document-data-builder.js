/**
 * Focused token document data composition for ActorFactory canvas placement.
 * Keeps Foundry document I/O and system-specific post-create repairs outside this module.
 */

function getFoundryUtils() {
  return globalThis.foundry?.utils ?? null;
}

function warnHpOverrideInjectionFailure(error) {
  console.warn('fa-nexus | ActorFactory: Failed to inject HP override into token data', error);
}

function setByPath(target, path, value) {
  const parts = String(path).split('.').filter((part) => part.length);
  if (!parts.length) return;

  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (cursor[key] === undefined || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

export function resolveTokenDepthFromGridDimensions(gridWidth, gridHeight, fallbackDepth = null) {
  const fallback = Number(fallbackDepth);
  if (Number.isFinite(fallback) && fallback > 0) return fallback;

  const width = Number(gridWidth);
  const height = Number(gridHeight);
  const depth = Math.max(
    Number.isFinite(width) && width > 0 ? width : 1,
    Number.isFinite(height) && height > 0 ? height : 1
  );
  return Math.round(depth * 100) / 100;
}

export function applyHpOverrideToTokenData(target, override, { utils = getFoundryUtils(), warn = warnHpOverrideInjectionFailure } = {}) {
  if (!target || !override) return false;

  const hpPath = override.path || 'system.attributes.hp';
  const valuePath = `actorData.${hpPath}.value`;
  const maxPath = `actorData.${hpPath}.max`;

  try {
    if (utils?.setProperty) {
      utils.setProperty(target, valuePath, override.value);
      utils.setProperty(target, maxPath, override.max);
      return true;
    }
  } catch (error) {
    if (typeof warn === 'function') warn(error);
  }

  setByPath(target, valuePath, override.value);
  setByPath(target, maxPath, override.max);
  return true;
}

export function buildTokenDocumentData({
  actor,
  dragData,
  dropCoordinates,
  tokenOptions = {},
  placementContext = null,
  resolvePlacementContext = null,
  gridSize = null,
  utils = getFoundryUtils()
} = {}) {
  const { world } = dropCoordinates;

  // Use the optimized dimensions from the actor's prototype token data.
  const prototypeToken = actor.prototypeToken;
  const gridWidth = prototypeToken.width;
  const gridHeight = prototypeToken.height;
  const tokenDepth = resolveTokenDepthFromGridDimensions(
    gridWidth,
    gridHeight,
    prototypeToken.depth
  );
  const prototypeScaleX = Number(prototypeToken.texture.scaleX ?? 1) || 1;
  const prototypeScaleY = Number(prototypeToken.texture.scaleY ?? 1) || 1;
  const baseScaleX = Math.abs(prototypeScaleX);
  const baseScaleY = Math.abs(prototypeScaleY);
  const textureFit = prototypeToken.texture.fit;
  const textureMirrorX = prototypeScaleX < 0;
  const textureMirrorY = prototypeScaleY < 0;
  const tokenRotation = Number.isFinite(dragData?.rotation) ? Number(dragData.rotation) : 0;

  const resolvedPlacementContext = placementContext ?? resolvePlacementContext?.();
  const {
    levelId: tokenLevelId,
    elevation: tokenElevation
  } = resolvedPlacementContext;
  const resolvedGridSize = typeof gridSize === 'function' ? gridSize() : gridSize;

  const tokenWidth = gridWidth * resolvedGridSize;
  const tokenHeight = gridHeight * resolvedGridSize;
  const tokenX = world.x - (tokenWidth / 2);
  const tokenY = world.y - (tokenHeight / 2);

  const actorLink = tokenOptions?.actorLink ?? prototypeToken?.actorLink ?? false;
  const hpOverride = tokenOptions?.hpOverride ?? null;
  const requestMirrorX = dragData?.mirrorX !== undefined ? !!dragData.mirrorX : textureMirrorX;
  const requestMirrorY = dragData?.mirrorY !== undefined ? !!dragData.mirrorY : textureMirrorY;
  const appliedScaleX = baseScaleX * (requestMirrorX ? -1 : 1);
  const appliedScaleY = baseScaleY * (requestMirrorY ? -1 : 1);

  const tokenData = {
    name: actor.name,
    actorId: actor.id,
    actorLink,
    x: tokenX,
    y: tokenY,
    level: tokenLevelId,
    elevation: tokenElevation,
    width: gridWidth,
    height: gridHeight,
    depth: tokenDepth,
    texture: {
      src: dragData.url,
      scaleX: appliedScaleX,
      scaleY: appliedScaleY,
      fit: textureFit
    },
    rotation: tokenRotation,
    lockRotation: false,
    randomImg: false,
    flags: {
      'fa-nexus': {
        customScale: true,
        originalScale: baseScaleX
      }
    }
  };

  const hpOverrideApplied = hpOverride && actorLink === false
    ? applyHpOverrideToTokenData(tokenData, hpOverride, { utils })
    : false;

  if (actorLink === false) {
    if (tokenOptions?.appendNumber !== undefined && tokenOptions.appendNumber !== null) {
      tokenData.appendNumber = !!tokenOptions.appendNumber;
    }
    if (tokenOptions?.prependAdjective !== undefined && tokenOptions.prependAdjective !== null) {
      tokenData.prependAdjective = !!tokenOptions.prependAdjective;
    }
  }

  return {
    tokenData,
    actorLink,
    appliedScaleX,
    appliedScaleY,
    baseScaleX,
    baseScaleY,
    requestMirrorX,
    requestMirrorY,
    tokenDepth,
    tokenWidth,
    tokenHeight,
    tokenX,
    tokenY,
    hpOverrideApplied
  };
}
