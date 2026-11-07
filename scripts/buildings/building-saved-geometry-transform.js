// Shared committed-runtime helpers. Authoring state belongs to the premium editor.

function clone(value) {
  if (value == null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function resolvePoint(point, label) {
  const x = finite(Array.isArray(point) ? point[0] : point?.x);
  const y = finite(Array.isArray(point) ? point[1] : point?.y);
  if (x == null || y == null) {
    throw new Error(`Building editor ${label} requires finite x and y.`);
  }
  return { x, y };
}

function operationPointDistance(a, b) {
  return Math.hypot(
    (finite(a?.x) ?? Number.POSITIVE_INFINITY) - (finite(b?.x) ?? Number.NEGATIVE_INFINITY),
    (finite(a?.y) ?? Number.POSITIVE_INFINITY) - (finite(b?.y) ?? Number.NEGATIVE_INFINITY)
  );
}

function operationBoundsFromPoints(points) {
  const xs = points.map((point) => finite(point?.x));
  const ys = points.map((point) => finite(point?.y));
  if (xs.some((value) => value == null) || ys.some((value) => value == null)) {
    throw new Error('Building editor operation geometry requires finite payload points.');
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function rectangleMetadataMatchesPoints(metadata, points, tolerance = 0.01) {
  const bounds = metadata?.bounds;
  if (!bounds || points.length !== 4) return false;
  const expected = [
    { x: finite(bounds.minX), y: finite(bounds.minY) },
    { x: finite(bounds.maxX), y: finite(bounds.minY) },
    { x: finite(bounds.maxX), y: finite(bounds.maxY) },
    { x: finite(bounds.minX), y: finite(bounds.maxY) }
  ];
  if (expected.some((point) => point.x == null || point.y == null)) return false;
  return expected.every((expectedPoint) => (
    points.some((point) => operationPointDistance(point, expectedPoint) <= tolerance)
  ));
}

function polygonMetadataFromOperationPoints(operation, points) {
  const closed = operation?.type !== 'append-line';
  const segmentCount = closed ? points.length : Math.max(0, points.length - 1);
  return {
    version: operation?.payload?.metadata?.version ?? 1,
    kind: 'polygon',
    closed,
    anchors: points.map((point) => ({ x: finite(point.x), y: finite(point.y) })),
    segments: Array.from({ length: segmentCount }, (_, index) => ({
      id: `${operation?.id || 'shape'}:reconciled:${index}`,
      type: 'line',
      startIndex: index,
      endIndex: closed ? ((index + 1) % points.length) : (index + 1),
      closing: closed && index === points.length - 1,
      control: null,
      mode: 'line',
      orientation: 0
    }))
  };
}

export function reconcileBuildingEditOperationGeometry(operation) {
  const next = clone(operation);
  const points = Array.isArray(next?.payload?.points) ? next.payload.points : [];
  const metadata = next?.payload?.metadata;
  if (!metadata?.kind || points.length < 2) return next;
  operationBoundsFromPoints(points);

  if (metadata.kind === 'rectangle' && !rectangleMetadataMatchesPoints(metadata, points)) {
    next.tool = 'polygon';
    next.payload.metadata = polygonMetadataFromOperationPoints(next, points);
    return next;
  }

  if (metadata.kind === 'ellipse' && metadata.center && metadata.radius && points.length >= 8) {
    const center = resolvePoint(metadata.center, 'ellipse center');
    const radiusX = Math.abs(finite(metadata.radius.x) ?? 0);
    const currentRotation = finite(metadata.rotation) ?? 0;
    if (!(radiusX > 0)) {
      throw new Error('Building editor ellipse operation requires a positive x radius.');
    }
    const expectedFirst = {
      x: center.x + (Math.cos(currentRotation) * radiusX),
      y: center.y + (Math.sin(currentRotation) * radiusX)
    };
    if (operationPointDistance(expectedFirst, points[0]) > 0.01) {
      next.payload.metadata.rotation = Math.atan2(
        finite(points[0].y) - center.y,
        finite(points[0].x) - center.x
      );
    }
    next.payload.metadata.bounds = operationBoundsFromPoints(points);
  }

  return next;
}
