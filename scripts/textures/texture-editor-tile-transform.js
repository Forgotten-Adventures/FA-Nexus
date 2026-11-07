const DEG_TO_RAD = Math.PI / 180;

function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundTransformValue(value, places = 9) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function resolveAnchor(texture = {}) {
  const x = finite(texture?.anchorX) ?? 0.5;
  const y = finite(texture?.anchorY) ?? 0.5;
  return { x, y };
}

function resolveTextureScale(value, { includeSign = false } = {}) {
  const scale = finite(value) ?? 1;
  const magnitude = Math.abs(scale);
  if (magnitude === 0) {
    throw new Error('Texture editor re-entry requires non-zero Tile texture scale.');
  }
  return includeSign && scale < 0 ? -magnitude : magnitude;
}

function cloneTileTexture(tile) {
  const texture = tile?._source?.texture || tile?.texture || {};
  if (typeof structuredClone === 'function') return structuredClone(texture);
  return JSON.parse(JSON.stringify(texture));
}

export function resolveTextureEditorTileTransform(tile, { includeTextureFlip = true } = {}) {
  const x = finite(tile?.x);
  const y = finite(tile?.y);
  const width = finite(tile?.width);
  const height = finite(tile?.height);
  if ([x, y, width, height].some((value) => value == null)) {
    throw new Error('Texture editor re-entry requires finite live Tile geometry.');
  }
  if (!(width > 0) || !(height > 0)) {
    throw new Error('Texture editor re-entry requires positive Tile dimensions.');
  }

  const anchor = resolveAnchor(tile?.texture);
  const rotationDegrees = finite(tile?.rotation) ?? 0;
  return {
    position: { x: roundTransformValue(x), y: roundTransformValue(y) },
    pivot: {
      x: roundTransformValue(width * (includeTextureFlip && Number(tile.texture?.scaleX)<0 ? 1-anchor.x : anchor.x)),
      y: roundTransformValue(height * (includeTextureFlip && Number(tile.texture?.scaleY)<0 ? 1-anchor.y : anchor.y))
    },
    scale: {
      x: resolveTextureScale(tile?.texture?.scaleX, { includeSign: includeTextureFlip }),
      y: resolveTextureScale(tile?.texture?.scaleY, { includeSign: includeTextureFlip })
    },
    rotation: rotationDegrees * DEG_TO_RAD,
    rotationDegrees: roundTransformValue(rotationDegrees),
    anchor,
    bounds: {
      x: roundTransformValue(x - (width * anchor.x)),
      y: roundTransformValue(y - (height * anchor.y)),
      width: roundTransformValue(width),
      height: roundTransformValue(height)
    }
  };
}

export function tileLocalPointToWorld(tile, point) {
  const transform = resolveTextureEditorTileTransform(tile);
  const localX = finite(point?.x);
  const localY = finite(point?.y);
  if (localX == null || localY == null) {
    throw new Error('Texture editor Tile-local point must be finite.');
  }

  const x = (localX - transform.pivot.x) * transform.scale.x;
  const y = (localY - transform.pivot.y) * transform.scale.y;
  const cosine = Math.cos(transform.rotation);
  const sine = Math.sin(transform.rotation);
  return {
    x: roundTransformValue(transform.position.x + (x * cosine) - (y * sine)),
    y: roundTransformValue(transform.position.y + (x * sine) + (y * cosine))
  };
}

export function worldPointToTileLocal(tile, point) {
  const transform = resolveTextureEditorTileTransform(tile);
  const worldX = finite(point?.x);
  const worldY = finite(point?.y);
  if (worldX == null || worldY == null) {
    throw new Error('Texture editor world point must be finite.');
  }

  const x = worldX - transform.position.x;
  const y = worldY - transform.position.y;
  const cosine = Math.cos(-transform.rotation);
  const sine = Math.sin(-transform.rotation);
  return {
    x: roundTransformValue(((x * cosine) - (y * sine)) / transform.scale.x + transform.pivot.x),
    y: roundTransformValue(((x * sine) + (y * cosine)) / transform.scale.y + transform.pivot.y)
  };
}

export function refitTextureEditorTilePose(tile, localBounds) {
  const transform = resolveTextureEditorTileTransform(tile);
  const minX = finite(localBounds?.minX);
  const minY = finite(localBounds?.minY);
  const maxX = finite(localBounds?.maxX);
  const maxY = finite(localBounds?.maxY);
  if ([minX, minY, maxX, maxY].some((value) => value == null)) {
    throw new Error('Texture editor Tile refit requires finite local bounds.');
  }
  if (maxX < minX || maxY < minY) {
    throw new Error('Texture editor Tile refit requires ordered local bounds.');
  }
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const position = tileLocalPointToWorld(tile, {
    x: minX + (width * (transform.scale.x < 0 ? 1-transform.anchor.x : transform.anchor.x)),
    y: minY + (height * (transform.scale.y < 0 ? 1-transform.anchor.y : transform.anchor.y))
  });
  return {
    x: Math.round(position.x),
    y: Math.round(position.y),
    width: roundTransformValue(width),
    height: roundTransformValue(height),
    rotation: transform.rotationDegrees,
    texture: cloneTileTexture(tile)
  };
}

export function rebaseTextureEditorPhase(phase, localBounds) {
  const x = finite(phase?.x) ?? 0;
  const y = finite(phase?.y) ?? 0;
  const minX = finite(localBounds?.minX);
  const minY = finite(localBounds?.minY);
  if (minX == null || minY == null) {
    throw new Error('Texture editor phase rebase requires finite local bounds.');
  }
  return {
    x: roundTransformValue(x - minX),
    y: roundTransformValue(y - minY)
  };
}

export function resolveMaskedTilingEditorBaseShift(tile, maskedTiling = {}) {
  const transform = resolveTextureEditorTileTransform(tile);
  const originX = finite(maskedTiling?.maskWorld?.origin?.x);
  const originY = finite(maskedTiling?.maskWorld?.origin?.y);
  if (originX == null || originY == null) return { x: 0, y: 0 };

  // Match the v3 committed runtime exactly. A plain native move leaves
  // maskWorld.tile at its authored anchor, so the live Tile delta cancels the
  // world-origin shift. Native resize commits a new maskWorld.tile and scaled
  // phase; its live delta becomes zero, preserving the remaining origin shift.
  const version = Number(maskedTiling?.maskVersion || 1);
  const tileMetaX = finite(maskedTiling?.maskWorld?.tile?.x);
  const tileMetaY = finite(maskedTiling?.maskWorld?.tile?.y);
  const tileX = finite(tile?.x);
  const tileY = finite(tile?.y);
  const liveDeltaX = version >= 3 && tileMetaX != null && tileX != null ? tileX - tileMetaX : 0;
  const liveDeltaY = version >= 3 && tileMetaY != null && tileY != null ? tileY - tileMetaY : 0;
  return {
    x: roundTransformValue(-(transform.bounds.x - originX) + liveDeltaX),
    y: roundTransformValue(-(transform.bounds.y - originY) + liveDeltaY)
  };
}
