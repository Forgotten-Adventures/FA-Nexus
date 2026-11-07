import { ActorFactory } from './actor-factory.js';
import * as SystemDetection from './system-detection.js';
import { applyHpOverrideToTokenData } from './token-document-data-builder.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';

function getFoundryUtils() {
  return globalThis.foundry?.utils ?? null;
}

function getCanvas() {
  return globalThis.canvas ?? null;
}

function hasTokenNamingOption(tokenOptions) {
  return tokenOptions?.appendNumber !== undefined
    || tokenOptions?.prependAdjective !== undefined;
}

function tokenScaleRepairWarningContext({
  actor,
  tokenDoc,
  systemId = null,
  scope,
  reason,
  appliedScaleX,
  appliedScaleY,
  error
}) {
  return {
    scope,
    reason,
    actorName: actor?.name || null,
    actorId: actor?.id || actor?._id || null,
    actorType: actor?.type || null,
    tokenId: tokenDoc?.id || tokenDoc?._id || null,
    systemId: systemId || null,
    appliedScaleX,
    appliedScaleY,
    error: String(error?.message || error)
  };
}

function applyTextureOverrides(merged, {
  actor,
  dragData,
  tokenProto,
  appliedScaleX,
  appliedScaleY,
  baseScaleX,
  utils,
  logger
}) {
  const overrides = {
    texture: {
      ...(merged?.texture || {}),
      src: dragData?.url || merged?.texture?.src || actor.prototypeToken?.texture?.src || '',
      scaleX: appliedScaleX,
      scaleY: appliedScaleY,
      fit: tokenProto?.texture?.fit || merged?.texture?.fit || actor.prototypeToken?.texture?.fit || 'contain'
    },
    flags: {
      ...(merged?.flags || {}),
      'fa-nexus': {
        ...(merged?.flags?.['fa-nexus'] || {}),
        customScale: true,
        originalScale: baseScaleX
      }
    }
  };

  if (utils?.mergeObject) {
    try {
      return utils.mergeObject(merged, overrides, { inplace: false, overwrite: true, recursive: true });
    } catch (error) {
      logger?.warn?.('TokenPlacement.textureOverride.mergeFailed', { error: String(error?.message || error) });
    }
  }

  merged.texture = overrides.texture;
  merged.flags = overrides.flags;
  return merged;
}

export async function createActorTokenPlacement({
  dragData,
  drop,
  options = {},
  actorFactory = ActorFactory,
  systemDetection = SystemDetection,
  createTokenPlacementDocumentFactory = createTokenPlacementDocument,
  uiRef = globalThis.ui,
  consoleRef = globalThis.console
} = {}) {
  try {
    if (!systemDetection?.isSystemReady?.()) {
      throw new Error('Game system not ready for actor creation');
    }
    if (typeof actorFactory?.generateActorName !== 'function') {
      throw new Error('Actor name generation unavailable');
    }
    if (typeof actorFactory?._createActorWithFallback !== 'function') {
      throw new Error('Actor creation unavailable');
    }

    const actorName = actorFactory.generateActorName(dragData.filename);
    const actor = await actorFactory._createActorWithFallback(actorName, dragData, options);
    if (!actor) {
      throw new Error('Failed to create actor with all fallback strategies');
    }

    /** @type {import('../core/fa-nexus-types.js').FaNexusActorTokenOptions} */
    let tokenOptions = {};
    if (options && typeof options.beforeTokenCreate === 'function') {
      try {
        const result = await options.beforeTokenCreate(actor);
        if (result && typeof result === 'object') tokenOptions = result;
      } catch (error) {
        consoleRef?.warn?.('fa-nexus | ActorFactory: beforeTokenCreate hook failed', error);
        tokenOptions = {};
      }
    }

    const linked = tokenOptions?.actorLink ?? actor?.prototypeToken?.actorLink ?? false;
    const token = await createTokenPlacementDocumentFactory({
      actor,
      dragData,
      drop,
      linked: !!linked,
      hpOverride: tokenOptions?.hpOverride ?? null,
      appendNumberOverride: tokenOptions?.appendNumber ?? null,
      prependAdjectiveOverride: tokenOptions?.prependAdjective ?? null,
      supportsTokenNamingOptions: hasTokenNamingOption(tokenOptions),
      actorFactory
    });

    return { actor, token };
  } catch (error) {
    consoleRef?.error?.('fa-nexus | ActorFactory: Error creating actor:', error);
    uiRef?.notifications?.error?.(`Failed to create actor: ${error?.message || error}`);
    throw error;
  }
}

async function applySystemScaleFixes(tokenDoc, {
  actor = null,
  appliedScaleX,
  appliedScaleY,
  baseScaleX,
  systemId = null,
  logger = Logger
} = {}) {
  if (!systemId || !tokenDoc) return;

  if (systemId === 'pf2e') {
    await tokenDoc.update({
      'texture.scaleX': appliedScaleX,
      'texture.scaleY': appliedScaleY,
      'flags.pf2e.linkToActorSize': false,
      'flags.fa-nexus.customScale': true,
      'flags.fa-nexus.originalScale': baseScaleX
    }, { animate: false });
  } else if (systemId === 'dsa5') {
    setTimeout(async () => {
      try {
        await tokenDoc.update({
          'texture.scaleX': appliedScaleX,
          'texture.scaleY': appliedScaleY
        }, { animate: false });
      } catch (error) {
        logger?.warn?.('TokenPlacement.systemScaleFix.deferredFailed', tokenScaleRepairWarningContext({
          actor,
          tokenDoc,
          systemId,
          scope: 'dsa5-delayed-repair',
          reason: 'delayed DSA5 scale repair update failed',
          appliedScaleX,
          appliedScaleY,
          error
        }));
      }
    }, 50);
  }
}

function resolveTokenPlacementPrototype({
  actor,
  dragData,
  tokenSize,
  actorFactory,
  logger
}) {
  let tokenProto = null;
  if (typeof actorFactory?._buildTokenData === 'function') {
    try {
      tokenProto = actorFactory._buildTokenData(dragData) || null;
    } catch (error) {
      logger?.warn?.('TokenPlacement.tokenProto.buildFailed', { error: String(error?.message || error) });
      tokenProto = null;
    }
  }
  if (tokenProto) return tokenProto;

  const width = Number(tokenSize.gridWidth || 1) || 1;
  const height = Number(tokenSize.gridHeight || 1) || 1;
  const scale = Number(tokenSize.scale || 1) || 1;
  return {
    width,
    height,
    depth: actorFactory.resolveTokenDepthFromGridDimensions(width, height),
    texture: {
      src: dragData?.url || actor.prototypeToken?.texture?.src || '',
      scaleX: scale * (dragData?.mirrorX ? -1 : 1),
      scaleY: scale * (dragData?.mirrorY ? -1 : 1),
      fit: 'contain'
    }
  };
}

export async function createTokenPlacementDocument({
  actor,
  dragData,
  drop,
  linked = false,
  hpOverride = null,
  appendNumberOverride = null,
  prependAdjectiveOverride = null,
  supportsTokenNamingOptions = false,
  actorFactory = ActorFactory,
  tokenDocumentClass = globalThis.TokenDocument,
  canvasRef = getCanvas(),
  foundryUtils = getFoundryUtils(),
  systemDetection = SystemDetection,
  logger = Logger
} = {}) {
  if (!actor || !drop?.world) throw new Error('Missing placement context');
  if (!tokenDocumentClass?.create) throw new Error('TokenDocument creation unavailable');

  const tokenSize = dragData?.tokenSize || { gridWidth: 1, gridHeight: 1, scale: 1 };
  const tokenProto = resolveTokenPlacementPrototype({
    actor,
    dragData,
    tokenSize,
    actorFactory,
    logger
  });

  const gridSize = canvasRef?.grid?.size || 100;
  const tokenWidthPx = Number(tokenProto.width || 1) * gridSize;
  const tokenHeightPx = Number(tokenProto.height || 1) * gridSize;
  const tokenDepth = actorFactory.resolveTokenDepthFromGridDimensions(
    tokenProto.width,
    tokenProto.height,
    tokenProto.depth
  );
  const rotation = Number.isFinite(dragData?.rotation) ? Number(dragData.rotation) : 0;
  const world = drop.world;
  const x = world.x - tokenWidthPx / 2;
  const y = world.y - tokenHeightPx / 2;
  const {
    levelId: tokenLevelId,
    elevation: tokenElevation
  } = actorFactory._resolveCurrentTokenPlacementContext(canvasRef?.scene);

  const protoScaleX = Number(tokenProto?.texture?.scaleX ?? tokenSize.scale ?? 1) || 1;
  const protoScaleY = Number(tokenProto?.texture?.scaleY ?? tokenSize.scale ?? 1) || 1;
  const protoMirrorX = tokenProto?.mirrorX ?? (protoScaleX < 0);
  const protoMirrorY = tokenProto?.mirrorY ?? (protoScaleY < 0);
  const baseScaleX = Math.abs(protoScaleX);
  const baseScaleY = Math.abs(protoScaleY);
  const actorProtoScaleX = Number(actor?.prototypeToken?.texture?.scaleX ?? 1) || 1;
  const actorProtoScaleY = Number(actor?.prototypeToken?.texture?.scaleY ?? 1) || 1;
  const actorProtoMirrorX = (actorProtoScaleX < 0) || !!actor?.prototypeToken?.mirrorX;
  const actorProtoMirrorY = (actorProtoScaleY < 0) || !!actor?.prototypeToken?.mirrorY;
  const requestMirrorX = dragData?.mirrorX !== undefined
    ? !!dragData.mirrorX
    : (protoMirrorX || actorProtoMirrorX);
  const requestMirrorY = dragData?.mirrorY !== undefined
    ? !!dragData.mirrorY
    : (protoMirrorY || actorProtoMirrorY);
  const appliedScaleX = baseScaleX * (requestMirrorX ? -1 : 1);
  const appliedScaleY = baseScaleY * (requestMirrorY ? -1 : 1);

  let merged = {};
  try {
    if (typeof actor.getTokenDocument === 'function') {
      const namingOverrides = (!linked && supportsTokenNamingOptions)
        ? {
          ...(appendNumberOverride !== null ? { appendNumber: !!appendNumberOverride } : {}),
          ...(prependAdjectiveOverride !== null ? { prependAdjective: !!prependAdjectiveOverride } : {})
        }
        : {};
      const tokenTemplate = actor.getTokenDocument({
        x,
        y,
        level: tokenLevelId,
        elevation: tokenElevation,
        width: Number(tokenProto.width || 1) || 1,
        height: Number(tokenProto.height || 1) || 1,
        depth: tokenDepth,
        rotation,
        lockRotation: false,
        randomImg: false,
        actorLink: !!linked,
        ...namingOverrides
      }, { parent: canvasRef?.scene });
      const resolvedTemplate = tokenTemplate && typeof tokenTemplate.then === 'function'
        ? await tokenTemplate
        : tokenTemplate;
      merged = resolvedTemplate?.toObject?.() ?? resolvedTemplate ?? {};
    } else {
      merged = actor.prototypeToken?.toObject?.() ?? foundryUtils?.deepClone?.(actor.prototypeToken ?? {}) ?? {};
      if (foundryUtils?.mergeObject) {
        merged = foundryUtils.mergeObject(merged, {
          x,
          y,
          level: tokenLevelId,
          elevation: tokenElevation,
          width: Number(tokenProto.width || 1) || 1,
          height: Number(tokenProto.height || 1) || 1,
          depth: tokenDepth,
          rotation,
          lockRotation: false,
          randomImg: false,
          actorLink: !!linked
        }, { inplace: false, overwrite: true, recursive: true });
      }
    }
  } catch (error) {
    logger?.error?.('TokenPlacement.actorTokenDocument.failed', {
      actorId: actor?.id || null,
      actorName: actor?.name || null,
      level: tokenLevelId,
      error: String(error?.message || error)
    });
    throw new Error(`Failed to prepare token document for ${actor?.name || 'actor'}: ${error?.message || error}`);
  }

  merged = applyTextureOverrides(merged, {
    actor,
    dragData,
    tokenProto,
    appliedScaleX,
    appliedScaleY,
    baseScaleX,
    utils: foundryUtils,
    logger
  });

  if (!linked && supportsTokenNamingOptions) {
    if (appendNumberOverride !== null) merged.appendNumber = !!appendNumberOverride;
    if (prependAdjectiveOverride !== null) merged.prependAdjective = !!prependAdjectiveOverride;
  }

  try { delete merged._id; } catch (_) {}
  merged.actorId = actor.id;
  merged.actorLink = !!linked;
  merged.randomImg = false;
  merged.level = tokenLevelId;
  merged.elevation = tokenElevation;
  merged.depth = tokenDepth;
  if (hpOverride && !linked) {
    applyHpOverrideToTokenData(merged, hpOverride, {
      utils: foundryUtils,
      warn: (error) => logger?.warn?.('TokenPlacement.hp.injectFailed', { error: String(error?.message || error) })
    });
  }

  const tokenDoc = await tokenDocumentClass.create(merged, { parent: canvasRef?.scene });
  if (dragData?.mirrorX !== undefined || dragData?.mirrorY !== undefined) {
    try {
      await tokenDoc.update({
        'texture.scaleX': appliedScaleX,
        'texture.scaleY': appliedScaleY
      }, { animate: false });
    } catch (error) {
      logger?.warn?.('TokenPlacement.textureScale.updateFailed', tokenScaleRepairWarningContext({
        actor,
        tokenDoc,
        scope: 'mirror-repair',
        reason: 'post-create mirror scale repair update failed',
        appliedScaleX,
        appliedScaleY,
        error
      }));
    }
  }

  let systemId = null;
  try {
    systemId = systemDetection?.getCurrentSystemId?.() || null;
    await applySystemScaleFixes(tokenDoc, {
      actor,
      appliedScaleX,
      appliedScaleY,
      baseScaleX,
      systemId,
      logger
    });
  } catch (error) {
    logger?.warn?.('TokenPlacement.systemScaleFix.failed', tokenScaleRepairWarningContext({
      actor,
      tokenDoc,
      systemId,
      scope: systemId ? 'system-scale-repair' : 'system-detection',
      reason: systemId
        ? 'system-specific scale repair failed'
        : 'system id lookup for scale repair failed',
      appliedScaleX,
      appliedScaleY,
      error
    }));
  }

  return tokenDoc;
}
