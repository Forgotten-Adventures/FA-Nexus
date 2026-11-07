export function routeLayerManagerRowHover({
  event = null,
  hoveredTileId = null,
  clearHover,
  getTilePlaceable,
  isTileBeingEdited,
  hoverEvent = null,
  setHoveredTileId
} = {}) {
  const target = event?.target?.closest?.('[data-tile-id]');
  const tileId = String(target?.dataset?.tileId || '').trim();
  if (!tileId) {
    if (hoveredTileId) clearHover?.();
    return false;
  }
  if (tileId === hoveredTileId) return false;
  clearHover?.();
  const tile = getTilePlaceable?.(tileId);
  if (!tile || isTileBeingEdited?.(tile)) return false;
  try { tile._onHoverIn?.(hoverEvent, { hoverOutOthers: true }); } catch (_) {}
  setHoveredTileId?.(tileId);
  return true;
}
