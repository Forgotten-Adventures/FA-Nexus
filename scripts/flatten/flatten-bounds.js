export function normalizeFlattenPaddingSnap(value) {
  const snap = String(value || 'none').toLowerCase();
  if (snap === 'half' || snap === 'full') return snap;
  return 'none';
}

export function normalizeFlattenPaddingExtra(value, gridSize) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) return 0;
  const size = Math.max(1, Number(gridSize) || 100);
  return numeric * size;
}

export function computeFlattenResolution(ppi, gridSize) {
  const numericPPI = Math.max(10, Number(ppi) || 200);
  const numericGrid = Math.max(1, Number(gridSize) || 100);
  const resolution = numericPPI / numericGrid;
  return Math.max(0.1, Math.min(8, resolution));
}

export function computeShadowedBounds(tiles, options = {}) {
  if (!Array.isArray(tiles) || !tiles.length) return null;
  const computeTileBounds = typeof options.computeTileWorldBounds === 'function'
    ? options.computeTileWorldBounds
    : computeTileWorldBounds;
  const computeShadowMargins = typeof options.computeTileShadowMargins === 'function'
    ? options.computeTileShadowMargins
    : () => null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const doc of tiles) {
    const base = computeTileBounds(doc);
    if (!base) continue;
    const margins = computeShadowMargins(doc);
    const expanded = expandBoundsWithMargins(base, margins);
    minX = Math.min(minX, expanded.x);
    minY = Math.min(minY, expanded.y);
    maxX = Math.max(maxX, expanded.x + expanded.width);
    maxY = Math.max(maxY, expanded.y + expanded.height);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

export function computeShadowBlurMargin(blur) {
  const numeric = Math.max(0, Number(blur) || 0);
  if (!numeric) return 0;
  return Math.ceil((numeric * 2) + 1);
}

export function computeTileShadowMargins({ dilation = 0, blur = 0, offset = null } = {}) {
  const blurMargin = computeShadowBlurMargin(blur);
  const extra = Math.max(0, Number(dilation) || 0) + blurMargin;
  const offsetX = Number(offset?.x) || 0;
  const offsetY = Number(offset?.y) || 0;
  return {
    left: Math.max(0, extra - offsetX),
    right: Math.max(0, extra + offsetX),
    top: Math.max(0, extra - offsetY),
    bottom: Math.max(0, extra + offsetY)
  };
}

export function computeRenderBounds(bounds, gridSize, paddingSnap, paddingExtra) {
  const extraPadding = normalizeFlattenPaddingExtra(paddingExtra, gridSize);
  const expanded = applyExtraPadding(bounds, extraPadding);
  return snapBounds(expanded, gridSize, paddingSnap);
}

export function padBoundsToChunkGrid(bounds, chunkWidth, chunkHeight) {
  if (!bounds) return bounds;
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  const chunkW = Number(chunkWidth);
  const chunkH = Number(chunkHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return bounds;
  if (!Number.isFinite(chunkW) || !Number.isFinite(chunkH) || chunkW <= 0 || chunkH <= 0) return bounds;
  const paddedWidth = Math.ceil(width / chunkW) * chunkW;
  const paddedHeight = Math.ceil(height / chunkH) * chunkH;
  return {
    x: bounds.x,
    y: bounds.y,
    width: paddedWidth,
    height: paddedHeight
  };
}

export function snapBounds(bounds, gridSize, paddingSnap) {
  const snap = normalizeFlattenPaddingSnap(paddingSnap);
  if (snap === 'none') return bounds;
  const increment = snap === 'half' ? (Number(gridSize) / 2) : Number(gridSize);
  if (!Number.isFinite(increment) || increment <= 0) return bounds;
  const minX = Math.floor(bounds.x / increment) * increment;
  const minY = Math.floor(bounds.y / increment) * increment;
  const maxX = Math.ceil((bounds.x + bounds.width) / increment) * increment;
  const maxY = Math.ceil((bounds.y + bounds.height) / increment) * increment;
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

/**
 * A flattened picture is shown as a Tile, placed by its centre in whole Scene
 * pixels and filtered when drawn. Where one Scene pixel is a whole number of
 * picture pixels, growing the bounds to whole Scene pixels with an even width
 * and height puts every picture pixel on the Scene's pixel grid. Half a pixel
 * off, the picture is blended between neighbours and drawn soft. Other
 * densities cannot lie on that grid and keep their bounds.
 */
export function alignBoundsToScenePixels(bounds, resolution) {
  if (!bounds || !Number.isInteger(resolution) || resolution < 1) return bounds;
  const values = [bounds.x, bounds.y, bounds.width, bounds.height].map(Number);
  if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) return bounds;
  // The tolerance keeps a bound that is whole but for floating point error where it is.
  const tolerance = 1e-6;
  const left = Math.floor(values[0] + tolerance);
  const top = Math.floor(values[1] + tolerance);
  let right = Math.ceil(values[0] + values[2] - tolerance);
  let bottom = Math.ceil(values[1] + values[3] - tolerance);
  if ((right - left) % 2) right += 1;
  if ((bottom - top) % 2) bottom += 1;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function expandBoundsWithMargins(bounds, margins) {
  const left = Math.max(0, Number(margins?.left) || 0);
  const right = Math.max(0, Number(margins?.right) || 0);
  const top = Math.max(0, Number(margins?.top) || 0);
  const bottom = Math.max(0, Number(margins?.bottom) || 0);
  return {
    x: bounds.x - left,
    y: bounds.y - top,
    width: bounds.width + left + right,
    height: bounds.height + top + bottom
  };
}

export function applyExtraPadding(bounds, extraPadding) {
  const pad = Number(extraPadding) || 0;
  if (!pad) return bounds;
  const width = bounds.width + pad * 2;
  const height = bounds.height + pad * 2;
  if (width <= 1 || height <= 1) return bounds;
  return {
    x: bounds.x - pad,
    y: bounds.y - pad,
    width,
    height
  };
}

export function tileOverlapsBounds(doc, bounds, options = {}) {
  try {
    if (!doc || !bounds) return false;
    const computeTileBounds = typeof options.computeTileWorldBounds === 'function'
      ? options.computeTileWorldBounds
      : computeTileWorldBounds;
    const tb = computeTileBounds(doc);
    if (!tb) return false;
    const rightA = tb.x + tb.width;
    const bottomA = tb.y + tb.height;
    const rightB = bounds.x + bounds.width;
    const bottomB = bounds.y + bounds.height;
    return !(rightA <= bounds.x || rightB <= tb.x || bottomA <= bounds.y || bottomB <= tb.y);
  } catch (_) {
    return true;
  }
}

export function computeTileWorldBounds(doc) {
  try {
    const placeable = doc?.object;
    const mesh = placeable?.mesh || placeable?.sprite;
    if (mesh) {
      const width = Math.abs(Number(mesh.width || 0));
      const height = Math.abs(Number(mesh.height || 0));
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        const anchorX = Number(mesh.anchor?.x ?? 0);
        const anchorY = Number(mesh.anchor?.y ?? 0);
        const posX = Number(mesh.position?.x ?? mesh.x ?? 0);
        const posY = Number(mesh.position?.y ?? mesh.y ?? 0);
        const rotation = Number.isFinite(Number(mesh.rotation))
          ? Number(mesh.rotation)
          : (Number(mesh.angle || 0) * (Math.PI / 180));
        const left = -width * anchorX;
        const top = -height * anchorY;
        const right = left + width;
        const bottom = top + height;
        if (!rotation) {
          return {
            x: posX + left,
            y: posY + top,
            width,
            height
          };
        }
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        const corners = [
          { x: left, y: top },
          { x: right, y: top },
          { x: right, y: bottom },
          { x: left, y: bottom }
        ];
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const corner of corners) {
          const rx = (corner.x * cos) - (corner.y * sin) + posX;
          const ry = (corner.x * sin) + (corner.y * cos) + posY;
          minX = Math.min(minX, rx);
          minY = Math.min(minY, ry);
          maxX = Math.max(maxX, rx);
          maxY = Math.max(maxY, ry);
        }
        if (Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)) {
          return {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY
          };
        }
      }
    }

    const bounds = placeable?.bounds;
    if (bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height) && bounds.width > 0 && bounds.height > 0) {
      return {
        x: Number(bounds.x) || 0,
        y: Number(bounds.y) || 0,
        width: Number(bounds.width) || 0,
        height: Number(bounds.height) || 0
      };
    }

    const x = Number(doc?.x) || 0;
    const y = Number(doc?.y) || 0;
    const width = Number(doc?.width) || 0;
    const height = Number(doc?.height) || 0;
    const rotation = Number(doc?.rotation) || 0;
    if (!rotation) {
      return { x, y, width, height };
    }
    const rad = rotation * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = x + width / 2;
    const cy = y + height / 2;
    const corners = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height }
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const corner of corners) {
      const dx = corner.x - cx;
      const dy = corner.y - cy;
      const rx = cx + (dx * cos) - (dy * sin);
      const ry = cy + (dx * sin) + (dy * cos);
      if (rx < minX) minX = rx;
      if (ry < minY) minY = ry;
      if (rx > maxX) maxX = rx;
      if (ry > maxY) maxY = ry;
    }
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  } catch (_) {
    return null;
  }
}
