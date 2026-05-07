import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { cloneDisplayObjectForProxy } from '../canvas/display-object-proxy.js';
import { invalidateCustomTileOverhead } from '../canvas/custom-tile-overhead.js';

const MODULE_ID = 'fa-nexus';
const SUPPRESSION_STATE_KEY = 'faNexusStandardMaskSuppressionState';

function isObjectLike(value) {
  return !!value && typeof value === 'object';
}

function readModuleFlag(doc, key) {
  if (!doc || !key) return undefined;
  try {
    const direct = doc.getFlag?.(MODULE_ID, key);
    if (direct !== undefined) return direct;
  } catch (_) {}
  try {
    const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID] || null;
    if (flags && Object.prototype.hasOwnProperty.call(flags, key)) return flags[key];
  } catch (_) {}
  return undefined;
}

function hasPathV2Payload(doc) {
  const pathV2 = readModuleFlag(doc, 'pathV2');
  if (isObjectLike(pathV2) && Array.isArray(pathV2.controlPoints) && pathV2.controlPoints.length > 0) return true;
  const pathsV2 = readModuleFlag(doc, 'pathsV2');
  return isObjectLike(pathsV2)
    && Array.isArray(pathsV2.paths)
    && pathsV2.paths.some((entry) => entry && Array.isArray(entry.controlPoints) && entry.controlPoints.length > 0);
}

function hasScatterPayload(doc) {
  const scatter = readModuleFlag(doc, 'assetScatter');
  return isObjectLike(scatter) && Array.isArray(scatter.instances) && scatter.instances.length > 0;
}

function hasObjectPayload(doc, key) {
  return isObjectLike(readModuleFlag(doc, key));
}

function readRootHsbcSignature(doc) {
  return readModuleFlag(doc, 'hsbc') || null;
}

const CUSTOM_BASE_SOURCES = Object.freeze([
  {
    kind: 'path',
    overheadKind: 'path',
    containerKey: 'faNexusPathContainer',
    hasPayload: hasPathV2Payload,
    signature: (doc) => ({
      pathV2: readModuleFlag(doc, 'pathV2') || null,
      pathsV2: readModuleFlag(doc, 'pathsV2') || null,
      hsbc: readRootHsbcSignature(doc)
    })
  },
  {
    kind: 'assetScatter',
    overheadKind: 'scatter',
    containerKey: 'faNexusAssetScatterContainer',
    hasPayload: hasScatterPayload,
    signature: (doc) => ({
      assetScatter: readModuleFlag(doc, 'assetScatter') || null,
      hsbc: readRootHsbcSignature(doc)
    })
  },
  {
    kind: 'building',
    overheadKind: 'building',
    containerKey: 'faNexusBuildingContainer',
    hasPayload: (doc) => hasObjectPayload(doc, 'building'),
    signature: (doc) => ({
      building: readModuleFlag(doc, 'building') || null,
      buildingComposite: readModuleFlag(doc, 'buildingComposite') || null,
      hsbc: readRootHsbcSignature(doc)
    })
  },
  {
    kind: 'buildingDoorFrame',
    overheadKind: 'building-door-frame',
    containerKey: 'faNexusDoorFrameContainer',
    hasPayload: (doc) => hasObjectPayload(doc, 'buildingDoorFrame'),
    signature: (doc) => ({
      buildingDoorFrame: readModuleFlag(doc, 'buildingDoorFrame') || null,
      hsbc: readRootHsbcSignature(doc)
    })
  },
  {
    kind: 'buildingComposite',
    overheadKind: 'building-composite',
    containerKey: 'faNexusBuildingCompositeContainer',
    hasPayload: (doc) => hasObjectPayload(doc, 'buildingComposite') && !hasObjectPayload(doc, 'building'),
    signature: (doc) => ({
      buildingComposite: readModuleFlag(doc, 'buildingComposite') || null,
      hsbc: readRootHsbcSignature(doc)
    })
  }
]);

function hashString(value) {
  const input = String(value ?? '');
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash &= 0xffffffff;
  }
  return (hash >>> 0).toString(16);
}

function resolveDocument(target) {
  return target?.document || target || null;
}

function getSourceContainer(tile, descriptor) {
  const key = descriptor?.containerKey;
  if (!tile || !key) return null;
  const mesh = tile?.mesh || null;
  return mesh?.[key] || tile?.[key] || null;
}

function resetCloneRootTransform(clone) {
  if (!clone || clone.destroyed) return;
  try { clone.position?.set?.(0, 0); } catch (_) {}
  try { clone.scale?.set?.(1, 1); } catch (_) {}
  try { clone.pivot?.set?.(0, 0); } catch (_) {}
  try { clone.skew?.set?.(0, 0); } catch (_) {}
  try { clone.rotation = 0; } catch (_) {}
  try { clone.angle = 0; } catch (_) {}
  try { clone.visible = true; } catch (_) {}
  try { clone.renderable = true; } catch (_) {}
  try { clone.eventMode = 'none'; } catch (_) {}
  try {
    if ('interactiveChildren' in clone) clone.interactiveChildren = false;
  } catch (_) {}
  try { clone.faNexusStandardMaskSuppressed = false; } catch (_) {}
  try { delete clone.faNexusStandardMaskSuppressionState; } catch (_) {}
}

function setContainerSuppressed(container, suppressed, { tileId = null, kind = null, reason = 'unknown' } = {}) {
  if (!container || container.destroyed) return false;
  try {
    if (suppressed) {
      if (!container[SUPPRESSION_STATE_KEY]) {
        container[SUPPRESSION_STATE_KEY] = {
          visible: container.visible,
          renderable: container.renderable,
          alpha: Number.isFinite(Number(container.alpha)) ? Number(container.alpha) : null
        };
      }
      container.faNexusStandardMaskSuppressed = true;
      container.visible = false;
      container.renderable = false;
      return true;
    }

    const state = container[SUPPRESSION_STATE_KEY] || null;
    if (state) {
      if (state.visible !== undefined) container.visible = state.visible;
      if (state.renderable !== undefined) container.renderable = state.renderable;
      if (state.alpha !== null && Number.isFinite(Number(state.alpha))) container.alpha = Number(state.alpha);
      delete container[SUPPRESSION_STATE_KEY];
    }
    container.faNexusStandardMaskSuppressed = false;
    return !!state;
  } catch (error) {
    Logger.warn?.('StandardMaskCustomBase.suppression.failed', {
      tileId,
      kind,
      reason,
      suppressed,
      error: String(error?.message || error)
    });
    return false;
  }
}

export function hasStandardMaskCustomBaseSource(target) {
  const doc = resolveDocument(target);
  return CUSTOM_BASE_SOURCES.some((descriptor) => {
    try { return !!descriptor.hasPayload(doc); }
    catch (_) { return false; }
  });
}

export function getStandardMaskCustomBaseKinds(target) {
  const doc = resolveDocument(target);
  const kinds = [];
  for (const descriptor of CUSTOM_BASE_SOURCES) {
    try {
      if (descriptor.hasPayload(doc)) kinds.push(descriptor.kind);
    } catch (_) {}
  }
  return kinds;
}

export function getStandardMaskCustomBaseKey(target) {
  const doc = resolveDocument(target);
  const signatures = [];
  for (const descriptor of CUSTOM_BASE_SOURCES) {
    try {
      if (!descriptor.hasPayload(doc)) continue;
      signatures.push({
        kind: descriptor.kind,
        payload: descriptor.signature(doc)
      });
    } catch (_) {}
  }
  if (!signatures.length) return null;
  return `custom-render:${hashString(JSON.stringify(signatures))}`;
}

export function resolveStandardMaskCustomBaseSources(tile) {
  const doc = tile?.document || null;
  const sources = [];
  const missing = [];
  for (const descriptor of CUSTOM_BASE_SOURCES) {
    let hasPayload = false;
    try { hasPayload = !!descriptor.hasPayload(doc); } catch (_) {}
    if (!hasPayload) continue;
    const container = getSourceContainer(tile, descriptor);
    if (container && !container.destroyed) {
      sources.push({
        kind: descriptor.kind,
        container,
        containerKey: descriptor.containerKey
      });
    } else {
      missing.push(descriptor.kind);
    }
  }
  return { sources, missing };
}

export function createStandardMaskCustomBaseDisplay(tile, options = {}) {
  const tileId = tile?.document?.id || tile?.id || null;
  const { sources, missing } = resolveStandardMaskCustomBaseSources(tile);
  if (!sources.length) {
    if (missing.length) {
      Logger.error?.('StandardMaskCustomBase.sourceContainersMissing', {
        tileId,
        missing
      });
    }
    return null;
  }

  const root = new PIXI.Container();
  root.eventMode = 'none';
  root.sortableChildren = false;
  root.interactiveChildren = false;
  root.faNexusStandardMaskCustomBase = true;
  root.faNexusStandardMaskCustomKinds = sources.map((entry) => entry.kind);

  for (const source of sources) {
    const clone = cloneDisplayObjectForProxy(source.container);
    if (!clone || clone.destroyed) {
      Logger.error?.('StandardMaskCustomBase.cloneFailed', {
        tileId,
        kind: source.kind
      });
      continue;
    }
    resetCloneRootTransform(clone);
    try { clone.faNexusStandardMaskSourceKind = source.kind; } catch (_) {}
    root.addChild(clone);
  }

  if (!root.children?.length) {
    try { root.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
    Logger.error?.('StandardMaskCustomBase.emptyClone', { tileId });
    return null;
  }

  if (missing.length && options?.logMissing !== false) {
    Logger.warn?.('StandardMaskCustomBase.partialSourceContainersMissing', {
      tileId,
      missing,
      rendered: root.faNexusStandardMaskCustomKinds
    });
  }
  return root;
}

export function syncStandardMaskCustomSourceSuppression(tile, suppressed, reason = 'unknown') {
  if (!tile) return false;
  const tileId = tile?.document?.id || tile?.id || null;
  let changed = false;
  for (const descriptor of CUSTOM_BASE_SOURCES) {
    const container = getSourceContainer(tile, descriptor);
    if (!container || container.destroyed) continue;
    changed = setContainerSuppressed(container, !!suppressed, {
      tileId,
      kind: descriptor.kind,
      reason
    }) || changed;
    try { invalidateCustomTileOverhead(tile, `${reason}:${descriptor.overheadKind}`); } catch (_) {}
  }
  return changed;
}
