const TILE_DOCUMENT_CLASS = () => globalThis?.foundry?.documents?.TileDocument;

export function collectTilePlaceables({
  layer = canvas?.tiles,
  includeDestroyed = true
} = {}) {
  const placeables = Array.isArray(layer?.placeables) ? layer.placeables : [];
  return includeDestroyed ? placeables.filter(Boolean) : placeables.filter((tile) => !!tile && !tile.destroyed);
}

export function mapTilePlaceablesById(placeables = null) {
  const list = Array.isArray(placeables) ? placeables : collectTilePlaceables();
  const placeablesById = new Map();
  for (const tile of list) {
    const id = tile?.document?.id || tile?.id;
    if (id) placeablesById.set(id, tile);
  }
  return placeablesById;
}

export function collectTileDocuments({
  scene = canvas?.scene,
  placeables = null
} = {}) {
  try {
    const sceneDocs = scene?.tiles ? Array.from(scene.tiles).filter(Boolean) : [];
    if (sceneDocs.length) return sceneDocs;
  } catch (_) {}
  const list = Array.isArray(placeables) ? placeables : collectTilePlaceables();
  return list.map((tile) => tile?.document).filter(Boolean);
}

export function resolveTileDocument(target) {
  if (!target) return null;
  const TileDocument = TILE_DOCUMENT_CLASS();
  if (TileDocument && target instanceof TileDocument) return target;
  if (TileDocument && target?.document instanceof TileDocument) return target.document;
  if (target?.document) return target.document;
  if (typeof target === 'string' && canvas?.scene?.tiles?.get) {
    try { return canvas.scene.tiles.get(target) || null; } catch (_) { return null; }
  }
  return null;
}

export function resolveTileId(target) {
  try {
    return resolveTileDocument(target)?.id || target?.id || target?.document?._id || target?._id || null;
  } catch (_) {
    return null;
  }
}

function matchesDocumentScene(tile, doc) {
  const sceneId = doc?.parent?.id;
  return !sceneId || tile?.document?.parent?.id === sceneId;
}

// Embedded Tile IDs are only unique within their owning Scene. Document hooks
// also arrive for Scenes this client is not viewing (including duplicated Scenes).
export function resolveCanvasTilePlaceable(doc, tileId = null) {
  const id = tileId || doc?.id || doc?._id;
  if (!id) return null;
  return globalThis.canvas?.tiles?.placeables?.find((tile) =>
    !tile?.destroyed && tile?.document?.id === id && matchesDocumentScene(tile, doc)
  ) || null;
}

export function resolveTilePlaceable(target, tileId = null) {
  try {
    if (target?.document && target?.mesh) return target;
    const doc = resolveTileDocument(target) || target;
    if (doc?.object) return doc.object;
    const id = tileId || doc?.id || doc?._id;
    if (!id) return null;
    return resolveCanvasTilePlaceable(doc, id);
  } catch (_) {
    return null;
  }
}

export function resolveTileDocumentById(tileId, {
  viewState = null,
  scene = canvas?.scene,
  resolveTileDocumentById = null
} = {}) {
  const id = String(tileId || '').trim();
  if (!id) return null;
  try {
    const viewDoc = viewState?.fullTileDocsById?.get?.(id);
    if (viewDoc) return viewDoc;
  } catch (_) {}
  try {
    const sceneDoc = scene?.tiles?.get?.(id);
    if (sceneDoc) return sceneDoc;
  } catch (_) {}
  try {
    const resolvedDoc = resolveTileDocumentById?.(id);
    if (resolvedDoc) return resolvedDoc;
  } catch (_) {}
  return resolveTileDocument(id);
}

export function resolveTilePlaceableForDocument(doc, {
  resolveTilePlaceableById = null,
  includeDestroyed = false
} = {}) {
  const id = resolveTileId(doc);
  let tile = resolveTilePlaceable(doc, id);
  if (!tile && id && typeof resolveTilePlaceableById === 'function') {
    try { tile = resolveTilePlaceableById(id) || null; } catch (_) {}
  }
  if (tile && !matchesDocumentScene(tile, doc)) return null;
  if (!includeDestroyed && tile?.destroyed) return null;
  return tile || null;
}

export function resolveTilePlaceablesForDocuments(docs = [], {
  resolveTilePlaceableById = null,
  includeDestroyed = false,
  onMissing = null
} = {}) {
  const list = Array.isArray(docs) ? docs : [];
  const targets = [];
  for (const doc of list) {
    const tile = resolveTilePlaceableForDocument(doc, {
      resolveTilePlaceableById,
      includeDestroyed
    });
    if (!tile) {
      try { onMissing?.(doc); } catch (_) {}
      continue;
    }
    targets.push(tile);
  }
  return targets;
}
