import { computeAffineScatterInstanceBounds } from './asset-scatter-instance-transform.js';

export const SCATTER_SHADOW_MAX_DIMENSION = 8192;
export const SCATTER_SHADOW_CHUNK_BLEED = 2;

const SCATTER_SHADOW_MAX_SPRITES = 60000;
const SCATTER_SHADOW_MAX_INSTANCES = 8000;

export function normalizeWorldBounds(bounds) {
  try {
    if (!bounds) return null;
    const minX = Number.isFinite(Number(bounds.minX)) ? Number(bounds.minX) : Number(bounds.x);
    const minY = Number.isFinite(Number(bounds.minY)) ? Number(bounds.minY) : Number(bounds.y);
    const maxX = Number.isFinite(Number(bounds.maxX))
      ? Number(bounds.maxX)
      : (Number.isFinite(Number(bounds.width)) ? minX + Number(bounds.width) : NaN);
    const maxY = Number.isFinite(Number(bounds.maxY))
      ? Number(bounds.maxY)
      : (Number.isFinite(Number(bounds.height)) ? minY + Number(bounds.height) : NaN);
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
    return {
      minX: Math.min(minX, maxX),
      minY: Math.min(minY, maxY),
      maxX: Math.max(minX, maxX),
      maxY: Math.max(minY, maxY)
    };
  } catch (_) {
    return null;
  }
}

export function mergeWorldBounds(a, b) {
  const left = normalizeWorldBounds(a);
  const right = normalizeWorldBounds(b);
  if (!left) return right;
  if (!right) return left;
  return {
    minX: Math.min(left.minX, right.minX),
    minY: Math.min(left.minY, right.minY),
    maxX: Math.max(left.maxX, right.maxX),
    maxY: Math.max(left.maxY, right.maxY)
  };
}

export function inflateWorldBounds(bounds, options = {}) {
  const normalized = normalizeWorldBounds(bounds);
  if (!normalized) return null;
  const offsetX = Math.abs(Number(options.offsetX || 0)) || 0;
  const offsetY = Math.abs(Number(options.offsetY || 0)) || 0;
  const dilation = Math.max(0, Number(options.dilation || 0)) || 0;
  const blur = Math.max(0, Number(options.blur || 0)) || 0;
  const marginX = offsetX + dilation + (blur * 12) + 8;
  const marginY = offsetY + dilation + (blur * 12) + 8;
  return {
    minX: normalized.minX - marginX,
    minY: normalized.minY - marginY,
    maxX: normalized.maxX + marginX,
    maxY: normalized.maxY + marginY
  };
}

export function worldBoundsIntersect(a, b) {
  const left = normalizeWorldBounds(a);
  const right = normalizeWorldBounds(b);
  if (!left || !right) return false;
  return left.minX <= right.maxX
    && left.maxX >= right.minX
    && left.minY <= right.maxY
    && left.maxY >= right.minY;
}

export function rectFromWorldBounds(bounds, pad = 0) {
  const normalized = normalizeWorldBounds(bounds);
  if (!normalized) return null;
  const padding = Math.max(0, Number(pad || 0));
  const minX = normalized.minX - padding;
  const minY = normalized.minY - padding;
  const maxX = normalized.maxX + padding;
  const maxY = normalized.maxY + padding;
  return {
    x: Math.floor(minX),
    y: Math.floor(minY),
    width: Math.max(1, Math.ceil(maxX) - Math.floor(minX)),
    height: Math.max(1, Math.ceil(maxY) - Math.floor(minY))
  };
}

export function shadowRenderProfileKey(options = {}, defaults = {}) {
  const alpha = Math.min(1, Math.max(0, Number(options.alpha ?? defaults.alpha ?? 0.65)));
  const blur = Math.max(0, Number(options.blur ?? defaults.blur ?? 0));
  return `a${Object.is(alpha, -0) ? 0 : alpha}:b${Object.is(blur, -0) ? 0 : blur}`;
}

export function planLayerShadowRenderChunks(entryPlans, { fallbackRect = null, layerOptions = {}, defaultOptions = {} } = {}) {
  const entries = Array.isArray(entryPlans)
    ? entryPlans.filter((plan) => plan?.entry?.doc)
    : [];
  if (!entries.length) return [];

  const items = [];
  for (let index = 0; index < entries.length; index += 1) {
    const plan = entries[index];
    const entry = plan.entry;
    const rectBounds = plan.bounds || normalizeWorldBounds(fallbackRect);
    if (!rectBounds) continue;
    const config = entry.config || {};
    const alpha = Math.min(1, Math.max(0, Number(config.alpha ?? layerOptions.alpha ?? defaultOptions.alpha ?? 0.65)));
    const blur = Math.max(0, Number(config.blur ?? layerOptions.blur ?? defaultOptions.blur ?? 0));
    const profileKey = shadowRenderProfileKey({ alpha, blur }, defaultOptions);
    const expanded = inflateWorldBounds(rectBounds, {
      offsetX: Math.max(Math.abs(Number(config.offsetX || 0)), Math.abs(Number(layerOptions.maxOffsetX || 0))),
      offsetY: Math.max(Math.abs(Number(config.offsetY || 0)), Math.abs(Number(layerOptions.maxOffsetY || 0))),
      dilation: Math.max(Number(config.dilation || 0), Number(layerOptions.maxDilation || 0)),
      blur
    });
    items.push({
      index,
      entry,
      alpha,
      blur,
      profileKey,
      bounds: rectBounds,
      expanded
    });
  }

  if (!items.length && fallbackRect) {
    return [{
      key: 'fallback',
      entries: entries.map((plan) => plan.entry),
      bounds: fallbackRect,
      alpha: Math.min(1, Math.max(0, Number(layerOptions.alpha ?? defaultOptions.alpha ?? 0.65))),
      blur: Math.max(0, Number(layerOptions.blur ?? defaultOptions.blur ?? 0)),
      profileKey: shadowRenderProfileKey(layerOptions, defaultOptions),
      maxOffsetX: Math.abs(Number(layerOptions.maxOffsetX || 0)),
      maxOffsetY: Math.abs(Number(layerOptions.maxOffsetY || 0)),
      maxDilation: Math.max(0, Number(layerOptions.maxDilation || 0))
    }];
  }

  const parent = items.map((_, index) => index);
  const find = (index) => {
    let current = index;
    while (parent[current] !== current) current = parent[current];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = current;
      index = next;
    }
    return current;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (items[i].profileKey !== items[j].profileKey) continue;
      if (worldBoundsIntersect(items[i].expanded, items[j].expanded)) union(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const root = find(i);
    let group = groups.get(root);
    const item = items[i];
    if (!group) {
      group = {
        entries: [],
        bounds: null,
        alpha: item.alpha,
        blur: item.blur,
        profileKey: item.profileKey,
        maxOffsetX: 0,
        maxOffsetY: 0,
        maxDilation: 0
      };
      groups.set(root, group);
    }
    group.entries.push(item.entry);
    group.bounds = mergeWorldBounds(group.bounds, item.bounds);
    const config = item.entry?.config || {};
    group.maxOffsetX = Math.max(group.maxOffsetX, Math.abs(Number(config.offsetX || 0)), Math.abs(Number(layerOptions.maxOffsetX || 0)));
    group.maxOffsetY = Math.max(group.maxOffsetY, Math.abs(Number(config.offsetY || 0)), Math.abs(Number(layerOptions.maxOffsetY || 0)));
    group.maxDilation = Math.max(group.maxDilation, Number(config.dilation || 0), Number(layerOptions.maxDilation || 0));
    group.alpha = Math.max(group.alpha, item.alpha);
    group.blur = Math.max(group.blur, item.blur);
  }

  return Array.from(groups.values())
    .map((group, index) => {
      const ids = group.entries
        .map((entry) => String(entry?.doc?.id || entry?.doc?._id || 'tile').trim())
        .filter(Boolean)
        .sort();
      const padded = rectFromWorldBounds(group.bounds, 8) || fallbackRect;
      return {
        key: `${group.profileKey}:${ids.length ? ids.join('|') : `chunk:${index}`}`,
        entries: group.entries,
        bounds: padded,
        alpha: group.alpha,
        blur: group.blur,
        maxOffsetX: group.maxOffsetX,
        maxOffsetY: group.maxOffsetY,
        maxDilation: group.maxDilation
      };
    })
    .filter((chunk) => chunk.bounds && chunk.entries.length)
    .sort((a, b) => {
      const ay = Number(a.bounds?.y || 0);
      const by = Number(b.bounds?.y || 0);
      if (ay !== by) return ay - by;
      const ax = Number(a.bounds?.x || 0);
      const bx = Number(b.bounds?.x || 0);
      if (ax !== bx) return ax - bx;
      return String(a.key).localeCompare(String(b.key));
    });
}

export function rectsIntersect(a, b) {
  if (!a || !b) return false;
  return a.minX < b.maxX
    && a.maxX > b.minX
    && a.minY < b.maxY
    && a.maxY > b.minY;
}

export function expandBounds(bounds, amount = 0) {
  const pad = Math.max(0, Number(amount) || 0);
  return {
    minX: Number(bounds?.minX || 0) - pad,
    minY: Number(bounds?.minY || 0) - pad,
    maxX: Number(bounds?.maxX || 0) + pad,
    maxY: Number(bounds?.maxY || 0) + pad
  };
}

export function resolveScatterShadowChunks(bounds, renderScale, options = {}) {
  const scale = Math.max(0.01, Number(renderScale) || 1);
  const maxTextureSize = Number(options.maxTextureSize || 4096) || 4096;
  const maxDimension = Number(options.maxDimension || SCATTER_SHADOW_MAX_DIMENSION) || SCATTER_SHADOW_MAX_DIMENSION;
  const bleedPixels = Number(options.bleedPixels ?? SCATTER_SHADOW_CHUNK_BLEED) || 0;
  const textureCap = Math.max(1024, Math.min(maxDimension, maxTextureSize));
  const bleed = Math.max(0, bleedPixels / scale);
  const chunkLocalSize = Math.max(1, (textureCap / scale) - (bleed * 2));
  const width = Math.max(1, Number(bounds?.width || 0));
  const height = Math.max(1, Number(bounds?.height || 0));
  const minX = Number(bounds?.minX || 0);
  const minY = Number(bounds?.minY || 0);
  const chunks = [];
  for (let y = minY; y < minY + height; y += chunkLocalSize) {
    const chunkHeight = Math.min(chunkLocalSize, minY + height - y);
    for (let x = minX; x < minX + width; x += chunkLocalSize) {
      const chunkWidth = Math.min(chunkLocalSize, minX + width - x);
      chunks.push({
        x,
        y,
        width: chunkWidth,
        height: chunkHeight,
        renderX: x - bleed,
        renderY: y - bleed,
        renderWidth: chunkWidth + (bleed * 2),
        renderHeight: chunkHeight + (bleed * 2),
        bounds: {
          minX: x,
          minY: y,
          maxX: x + chunkWidth,
          maxY: y + chunkHeight
        },
        renderBounds: {
          minX: x - bleed,
          minY: y - bleed,
          maxX: x + chunkWidth + bleed,
          maxY: y + chunkHeight + bleed
        }
      });
    }
  }
  return chunks;
}

export function buildScatterShadowSignature(instances, cfg, scale, extra = null) {
  const dilation = Number(cfg?.dilation) || 0;
  const safeScale = Number(scale) || 1;
  const roundedDilation = Math.round(dilation * 1000) / 1000;
  const roundedScale = Math.round(safeScale * 10000) / 10000;
  try {
    const payload = { d: roundedDilation, s: roundedScale, i: instances };
    if (extra && typeof extra === 'object') {
      Object.assign(payload, extra);
    }
    return JSON.stringify(payload);
  } catch (_) {
    return '';
  }
}

export function computeScatterShadowScale(baseScale, bounds, options = {}) {
  const safeScale = Number(baseScale) || 1;
  const width = Math.max(1, Number(bounds?.width || 0));
  const height = Math.max(1, Number(bounds?.height || 0));
  if (!width || !height) return safeScale;
  const pixelWidth = width * safeScale;
  const pixelHeight = height * safeScale;
  const maxDim = Math.max(pixelWidth, pixelHeight);
  const maxTextureSize = Number(options.maxTextureSize || 4096) || 4096;
  const maxDimension = Number(options.maxDimension || SCATTER_SHADOW_MAX_DIMENSION) || SCATTER_SHADOW_MAX_DIMENSION;
  const scatterCap = Math.max(1024, Math.min(maxDimension, maxTextureSize));
  if (maxDim <= scatterCap) return safeScale;
  const factor = scatterCap / maxDim;
  return Math.max(0.01, safeScale * factor);
}

export function computeScatterShadowInstanceLimit(offsetCount) {
  const offsets = Math.max(1, Number(offsetCount) || 1);
  const maxBySprites = Math.floor(SCATTER_SHADOW_MAX_SPRITES / offsets);
  if (!Number.isFinite(maxBySprites) || maxBySprites <= 0) return 1;
  return Math.max(1, Math.min(SCATTER_SHADOW_MAX_INSTANCES, maxBySprites));
}

export function sampleScatterShadowInstances(instances, limit) {
  if (!Array.isArray(instances)) return { instances: [], stride: 1 };
  if (!Number.isFinite(limit) || limit <= 0 || instances.length <= limit) {
    return { instances, stride: 1 };
  }
  const stride = Math.ceil(instances.length / limit);
  const sampled = [];
  for (let i = 0; i < instances.length; i += stride) {
    sampled.push(instances[i]);
  }
  return { instances: sampled, stride };
}

export function buildScatterDilationOffsets(radius, instanceCount = 0) {
  const offsets = [{ x: 0, y: 0 }];
  const r = Math.max(0, Number(radius || 0));
  if (r < 0.5) return offsets;
  let steps = 16;
  if (instanceCount > 8000) steps = 6;
  else if (instanceCount > 4000) steps = 8;
  else if (instanceCount > 2000) steps = 12;
  const full = Math.PI * 2;
  for (let i = 0; i < steps; i += 1) {
    const angle = (full * i) / steps;
    offsets.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  }
  const inner = r * 0.55;
  if (inner >= 0.5 && steps >= 8) {
    const innerSteps = Math.max(4, Math.floor(steps * 0.75));
    for (let i = 0; i < innerSteps; i += 1) {
      const angle = (full * i) / innerSteps + (full / (innerSteps * 2));
      offsets.push({ x: Math.cos(angle) * inner, y: Math.sin(angle) * inner });
    }
  }
  return offsets;
}

export function computeScatterInstanceBounds(instance) {
  if (instance?.affine) return computeAffineScatterInstanceBounds(instance);
  const cx = Number(instance?.x) || 0;
  const cy = Number(instance?.y) || 0;
  const hw = Math.max(1, Number(instance?.w) || 0) / 2;
  const hh = Math.max(1, Number(instance?.h) || 0) / 2;
  const rot = ((Number(instance?.r) || 0) * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const corners = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh }
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of corners) {
    const x = cx + corner.x * cos - corner.y * sin;
    const y = cy + corner.x * sin + corner.y * cos;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function computeScatterBounds(instances) {
  if (!Array.isArray(instances) || !instances.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const instance of instances) {
    if (!instance) continue;
    const bounds = computeScatterInstanceBounds(instance);
    if (!bounds) continue;
    if (bounds.minX < minX) minX = bounds.minX;
    if (bounds.minY < minY) minY = bounds.minY;
    if (bounds.maxX > maxX) maxX = bounds.maxX;
    if (bounds.maxY > maxY) maxY = bounds.maxY;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}
