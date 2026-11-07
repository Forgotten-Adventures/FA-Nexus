import { NexusLogger as Logger } from '../core/nexus-logger.js';

const MODULE_ID = 'fa-nexus';
const DEFAULT_MAX_OFFSET_DISTANCE = 1200;

function approxNumber(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) < 0.0005;
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function resolveMaxOffsetDistance(maxOffsetDistance) {
  const numeric = Number(maxOffsetDistance);
  return Number.isFinite(numeric) ? numeric : DEFAULT_MAX_OFFSET_DISTANCE;
}

export function getAssetShadowElevationSettings(manager, elevation, {
  maxOffsetDistance = DEFAULT_MAX_OFFSET_DISTANCE,
  ignorePreview = false
} = {}) {
  try {
    const target = Number(elevation ?? 0) || 0;
    const docs = manager._collectShadowTilesAtElevation(target);
    const tileCount = Array.isArray(docs) ? docs.length : 0;
    const baseOptions = { ...manager._options };
    const layerKeys = manager._resolveLayerKeys(target);
    const layers = layerKeys
      .map((layerKey) => manager._layers.get(layerKey) || null)
      .filter(Boolean);
    const firstLayer = layers[0] || null;
    const previewOverride = ignorePreview ? null : manager._getElevationPreviewShadowOverride(target);
    if (!tileCount) {
      const offset = manager._computeOffsetVector(baseOptions.offsetDistance, baseOptions.offsetAngle);
      return {
        alpha: Number(previewOverride?.alpha ?? baseOptions.alpha ?? 0.65),
        dilation: Number(baseOptions.dilation ?? 0),
        blur: Number(previewOverride?.blur ?? baseOptions.blur ?? 0),
        offsetDistance: Number(baseOptions.offsetDistance ?? 0),
        offsetAngle: Number(baseOptions.offsetAngle ?? 135),
        offsetX: Number(offset.x || 0),
        offsetY: Number(offset.y || 0),
        tileCount,
        hasTiles: false
      };
    }

    const doc = docs[0];
    const firstConfig = manager._extractTileShadowConfig(doc, baseOptions);
    let dilationMixed = false;
    let offsetMixed = false;
    let distanceMixed = false;
    let angleMixed = false;

    for (let i = 1; i < docs.length; i += 1) {
      const otherConfig = manager._extractTileShadowConfig(docs[i], baseOptions);
      if (!dilationMixed && !approxNumber(otherConfig.dilation, firstConfig.dilation)) dilationMixed = true;
      if (!offsetMixed && (!approxNumber(otherConfig.offsetX, firstConfig.offsetX) || !approxNumber(otherConfig.offsetY, firstConfig.offsetY))) offsetMixed = true;
      if (!distanceMixed && !approxNumber(otherConfig.offsetDistance, firstConfig.offsetDistance)) distanceMixed = true;
      if (!angleMixed && !approxNumber(otherConfig.offsetAngle, firstConfig.offsetAngle)) angleMixed = true;
    }

    const offsetLimit = resolveMaxOffsetDistance(maxOffsetDistance);
    return {
      alpha: Math.min(1, Math.max(0, Number(
        previewOverride?.alpha
          ?? (ignorePreview ? undefined : firstLayer?.options?.alpha)
          ?? manager._readTileShadowNumber(doc, 'shadowAlpha')
          ?? manager._options.alpha
          ?? 0.65
      ))),
      dilation: Math.max(0, firstConfig.dilation),
      blur: Math.max(0, Number(
        previewOverride?.blur
          ?? (ignorePreview ? undefined : firstLayer?.options?.blur)
          ?? manager._readTileShadowNumber(doc, 'shadowBlur')
          ?? manager._options.blur
          ?? 0
      )),
      offsetDistance: Math.min(offsetLimit, Math.max(0, firstConfig.offsetDistance)),
      offsetAngle: manager._normalizeAngle(firstConfig.offsetAngle),
      offsetX: firstConfig.offsetX,
      offsetY: firstConfig.offsetY,
      tileCount,
      hasTiles: tileCount > 0,
      mixedDilation: dilationMixed,
      mixedOffset: offsetMixed,
      mixedOffsetDistance: distanceMixed,
      mixedOffsetAngle: angleMixed
    };
  } catch (error) {
    Logger.warn('AssetShadow.getElevation.failed', String(error?.message || error));
    return null;
  }
}

export async function applyAssetShadowElevationSettings(manager, elevation, settings = {}, { maxOffsetDistance = DEFAULT_MAX_OFFSET_DISTANCE } = {}) {
  try {
    if (!canvas?.scene) return false;
    const docs = manager._collectShadowTilesAtElevation(elevation);
    if (!docs.length) return false;
    const hasAlpha = hasOwn(settings, 'alpha');
    const hasBlur = hasOwn(settings, 'blur');
    const hasDilation = hasOwn(settings, 'dilation');
    const hasOffsetDistance = hasOwn(settings, 'offsetDistance');
    const hasOffsetAngle = hasOwn(settings, 'offsetAngle');
    const hasOffsetX = hasOwn(settings, 'offsetX');
    const hasOffsetY = hasOwn(settings, 'offsetY');
    const wantsOffsets = hasOffsetDistance || hasOffsetAngle || hasOffsetX || hasOffsetY;
    const offsetLimit = resolveMaxOffsetDistance(maxOffsetDistance);

    const alpha = hasAlpha
      ? Math.min(1, Math.max(0, Number(settings.alpha)))
      : null;
    const blur = hasBlur
      ? Math.max(0, Number(settings.blur))
      : null;
    const dilation = hasDilation
      ? Math.max(0, Number(settings.dilation))
      : null;
    const offsetDistance = hasOffsetDistance
      ? Math.min(offsetLimit, Math.max(0, Number(settings.offsetDistance)))
      : null;
    const offsetAngle = hasOffsetAngle
      ? manager._normalizeAngle(settings.offsetAngle)
      : null;
    const explicitOffsetX = hasOffsetX ? Number(settings.offsetX) : null;
    const explicitOffsetY = hasOffsetY ? Number(settings.offsetY) : null;

    let vector = null;
    if (wantsOffsets) {
      if (Number.isFinite(explicitOffsetX) && Number.isFinite(explicitOffsetY)) {
        vector = {
          x: Math.max(-offsetLimit, Math.min(offsetLimit, explicitOffsetX)),
          y: Math.max(-offsetLimit, Math.min(offsetLimit, explicitOffsetY))
        };
      } else {
        const dist = offsetDistance !== null ? offsetDistance : Math.min(offsetLimit, Math.max(0, Number(manager._options.offsetDistance ?? 0)));
        const ang = offsetAngle !== null ? offsetAngle : manager._normalizeAngle(manager._options.offsetAngle ?? 135);
        vector = manager._computeOffsetVector(dist, ang);
      }
    }

    const updates = [];

    for (const doc of docs) {
      if (!doc) continue;
      const update = { _id: doc.id };
      let changed = false;

      const assign = (key, value) => {
        const next = Number(value);
        if (!Number.isFinite(next)) return;
        const current = doc.getFlag(MODULE_ID, key);
        if (current === undefined || current === null || !approxNumber(current, next)) {
          update[`flags.${MODULE_ID}.${key}`] = next;
          changed = true;
        }
      };

      if (!doc.getFlag(MODULE_ID, 'shadow')) {
        update[`flags.${MODULE_ID}.shadow`] = true;
        changed = true;
      }

      if (hasAlpha && alpha !== null) assign('shadowAlpha', alpha);
      if (hasDilation && dilation !== null) assign('shadowDilation', dilation);
      if (hasBlur && blur !== null) assign('shadowBlur', blur);
      if (wantsOffsets && vector) {
        if (hasOffsetDistance && offsetDistance !== null) assign('shadowOffsetDistance', offsetDistance);
        if (hasOffsetAngle && offsetAngle !== null) assign('shadowOffsetAngle', offsetAngle);
        assign('shadowOffsetX', vector.x);
        assign('shadowOffsetY', vector.y);
      }

      if (changed) updates.push(update);
    }

    const matchingLayerKeys = manager._resolveLayerKeys(Number(elevation ?? 0) || 0);
    for (const layerKey of matchingLayerKeys) {
      const layer = manager._layers.get(layerKey) || null;
      if (!layer) continue;
      if (hasAlpha && alpha !== null) layer.options.alpha = Math.min(1, Math.max(0, Number(alpha)));
      if (hasBlur && blur !== null) layer.options.blur = Math.max(0, Number(blur));
    }

    if (!updates.length) return false;
    await canvas.scene.updateEmbeddedDocuments('Tile', updates, { diff: false });
    manager._scheduleRebuild(Number(elevation ?? 0) || 0, true);
    return true;
  } catch (error) {
    Logger.warn('AssetShadow.applyElevation.failed', String(error?.message || error));
    return false;
  }
}
