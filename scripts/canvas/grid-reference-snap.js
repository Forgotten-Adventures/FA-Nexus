/**
 * Foundry snaps a dragged Tile by its centre and turns it about its centre. A Nexus layer that was drawn on the
 * grid (a Building, a Path, a flattened section that holds Foundry Walls) is as large as everything it draws, so
 * that centre is rarely on a grid point: a snapped drag or a quarter turn left walls and fences that stood on the
 * grid lines beside them. Such a layer is snapped by one of its own points and turned about the grid point
 * nearest to its position instead.
 *
 * Each family registers how to find the points of one of its Tiles that were placed on the grid: a Building's
 * wall ends, a Path's control points, the Walls a flattened section holds. A Tile no family answers for is left
 * to Foundry.
 */

const sources = [];
// The grid point a Tile was last turned about, with the exact position that turn gave it. Successive turns of
// the same Tile (one notch of the wheel after another) keep that point, so six notches equal one quarter turn.
const lastTurns = new WeakMap();

/** @param {(document: object) => Iterable<{x: number, y: number}>|null} resolvePoints Scene coordinates. */
export function registerGridReferenceSource(resolvePoints) {
  if (typeof resolvePoints !== 'function') throw new Error('A grid reference source must be a function.');
  if (!sources.includes(resolvePoints)) sources.push(resolvePoints);
}

function collectGridReferencePoints(document) {
  if (!document) return [];
  for (const resolvePoints of sources) {
    const points = resolvePoints(document);
    if (!points) continue;
    const list = Array.from(points).filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y));
    if (list.length) return list;
  }
  return [];
}

/** The two ends of each Wall, for sources whose reference points are Walls. */
export function wallEndPoints(walls) {
  const points = [];
  for (const wall of walls || []) {
    const c = Array.from(wall?._source?.c ?? wall?.c ?? []).map(Number);
    if (c.length !== 4 || !c.every(Number.isFinite)) continue;
    points.push({ x: c[0], y: c[1] }, { x: c[2], y: c[3] });
  }
  return points;
}

// The points Foundry snaps a dragged Tile's centre to (client/data/shapes.mjs, _getSnappedPoint).
export function snapToTileDragPoint(point) {
  const modes = CONST.GRID_SNAPPING_MODES;
  return canvas.grid.getSnappedPoint(point, {
    mode: modes.CENTER | modes.VERTEX | modes.EDGE_MIDPOINT,
    resolution: 1
  });
}

/**
 * The point a layer is snapped by (with its distance to the nearest snap point), or null for a document no
 * family answers for.
 *
 * Points placed on the grid share one position relative to it, also after the whole layer has been moved off
 * the grid; a point between two grid lines does not. The point is taken from the largest such set, and among
 * equals the one nearest to a snap point.
 */
export function resolveGridReferencePoint(document) {
  const ends = collectGridReferencePoints(document).map((point) => {
    const snapped = snapToTileDragPoint(point);
    const offset = { x: point.x - snapped.x, y: point.y - snapped.y };
    return { x: point.x, y: point.y, offset, distance: Math.hypot(offset.x, offset.y) };
  });
  // On a square grid the snap points repeat every half square, so an offset of +24 and one of -26 are one pixel apart.
  const period = globalThis.canvas?.grid?.isSquare ? Number(canvas.grid.size) / 2 : 0;
  const apart = (a, b) => {
    const difference = Math.abs(a - b);
    return period > 0 ? Math.min(difference, Math.abs(period - difference)) : difference;
  };
  let best = null;
  for (const end of ends) {
    const shared = ends.filter((other) => apart(end.offset.x, other.offset.x) <= 1 && apart(end.offset.y, other.offset.y) <= 1).length;
    if (!best || shared > best.shared || (shared === best.shared && end.distance < best.distance)) best = { ...end, shared };
  }
  return best ? { x: best.x, y: best.y, distance: best.distance } : null;
}

// A Tile stands on whole pixels. A reference point can lie half a pixel off them (a Path Tile of an odd size):
// the Tile keeps its whole pixel and the point its half.
function wholePixels(position) {
  return { x: Math.round(position.x), y: Math.round(position.y) };
}

/** That point as an offset from the Tile's position. */
function resolveGridReferenceAnchor(document, start) {
  const point = resolveGridReferencePoint(document);
  return point ? { x: point.x - start.x, y: point.y - start.y } : null;
}

function nearestGridPivot(position) {
  const grid = globalThis.canvas?.grid;
  if (!grid?.isSquare) return null;
  const modes = CONST.GRID_SNAPPING_MODES;
  return grid.getSnappedPoint({ x: position.x, y: position.y }, { mode: modes.CENTER | modes.VERTEX, resolution: 1 });
}

function turnAbout(pivot, position, degrees) {
  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = position.x - pivot.x;
  const dy = position.y - pivot.y;
  return { x: pivot.x + (dx * cos) - (dy * sin), y: pivot.y + (dx * sin) + (dy * cos) };
}

/**
 * Where a Tile at `original` stands after it is turned to `rotation` about the grid corner or square centre
 * nearest to its position: a quarter turn about either maps whole squares onto whole squares. Returns null
 * where the grid has no such point.
 */
export function turnAboutGridPivot(original, rotation) {
  const pivot = nearestGridPivot(original);
  if (!pivot) return null;
  const turned = turnAbout(pivot, original, rotation - original.rotation);
  return { x: Math.round(turned.x), y: Math.round(turned.y) };
}

/**
 * A change that turns a Tile and leaves its position and size alone is Foundry's turn about the Tile centre (the
 * wheel, the Rotation box of the Tile sheet). For a layer with grid reference points the position of that turn
 * about the grid is written into the change. Returns true when it did. The rotate handle has already placed its
 * preview; Undo restores a recorded pose.
 */
export function turnRotationOnlyChangeAboutGridPivot(document, changes, options = {}, { requireReference = true } = {}) {
  if (options?.isUndo || !document || !changes || typeof changes !== 'object') return false;
  // Only a square grid has points a quarter turn maps onto each other.
  if (!globalThis.canvas?.grid?.isSquare) return false;
  if (!Object.prototype.hasOwnProperty.call(changes, 'rotation')) return false;
  const source = document._source || document;
  const original = { x: Number(source.x), y: Number(source.y), rotation: Number(source.rotation) || 0 };
  const rotation = Number(changes.rotation);
  if (!Number.isFinite(rotation) || rotation === original.rotation) return false;
  for (const key of ['x', 'y', 'width', 'height']) {
    if (Object.prototype.hasOwnProperty.call(changes, key) && Number(changes[key]) !== Number(source[key])) return false;
  }
  if (requireReference && !resolveGridReferencePoint(document)) return false;
  const last = lastTurns.get(document);
  const continued = last && last.x === original.x && last.y === original.y;
  const pivot = continued ? last.pivot : nearestGridPivot(original);
  if (!pivot) return false;
  const exact = turnAbout(pivot, continued ? last.exact : original, rotation - original.rotation);
  const turned = { x: Math.round(exact.x), y: Math.round(exact.y) };
  lastTurns.set(document, { pivot, exact, x: turned.x, y: turned.y });
  if (turned.x === original.x && turned.y === original.y) return false;
  changes.x = turned.x;
  changes.y = turned.y;
  return true;
}

/**
 * The handles of Foundry's Tiles tool on such a layer: the centre handle moves it by its reference point, as a
 * drag of its body does, and the rotate handle turns it about the grid point nearest to its position. The shape
 * is adjusted before Foundry copies it to the preview, so the preview and the saved pose agree.
 */
export function adjustHandleDragForGrid(controls, event) {
  const interaction = event?.interactionData;
  const shape = interaction?.shape;
  const handle = String(interaction?.handle?.name || '');
  const document = controls?.object?.document || controls?.document || null;
  if (!shape || !document || canvas?.grid?.isGridless) return;
  if (handle !== 'translate' && handle !== 'rotate') return;
  const start = interaction.faNexusGridHandleStart ??= {
    x: Number(document.x), y: Number(document.y), rotation: Number(document.rotation) || 0
  };
  if (interaction.faNexusGridSnapAnchor === undefined) {
    interaction.faNexusGridSnapAnchor = resolveGridReferenceAnchor(document, start);
  }
  const anchor = interaction.faNexusGridSnapAnchor;
  if (!anchor) return;
  if (handle === 'translate') {
    if (event.shiftKey || !interaction.destination) return;
    const snapped = snapToTileDragPoint({
      x: interaction.destination.x + anchor.x,
      y: interaction.destination.y + anchor.y
    });
    shape.move(wholePixels({ x: snapped.x - anchor.x, y: snapped.y - anchor.y }));
  } else {
    const turned = turnAboutGridPivot(start, Number(shape.rotation) || 0);
    if (turned) shape.move(turned);
  }
}

/**
 * A snapped drag of such a layer by its body: Foundry would snap the centre of the dragged Tile and move the
 * whole selection by that distance. The dragged layer is snapped by its reference point instead (taken when the
 * drag begins). A drag that starts on any other Tile is left to Foundry.
 */
export function snapBodyDragByGridReference(placeable, event) {
  const interaction = event?.interactionData;
  const shape = interaction?.shape;
  if (!shape || interaction.handle || event.shiftKey || canvas?.grid?.isGridless) return;
  if (!interaction.origin || !interaction.offset || !interaction.destination) return;
  if (!placeable?.document) return;
  if (interaction.faNexusGridSnapAnchor === undefined) {
    interaction.faNexusGridSnapAnchor = resolveGridReferenceAnchor(placeable.document, {
      x: interaction.origin.x - interaction.offset.x,
      y: interaction.origin.y - interaction.offset.y
    });
  }
  const anchor = interaction.faNexusGridSnapAnchor;
  if (!anchor) return;
  const snapped = snapToTileDragPoint({
    x: interaction.destination.x - interaction.offset.x + anchor.x,
    y: interaction.destination.y - interaction.offset.y + anchor.y
  });
  shape.move(wholePixels({ x: snapped.x - anchor.x, y: snapped.y - anchor.y }));
}
