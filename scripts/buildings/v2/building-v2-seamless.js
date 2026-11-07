/** Public, derived Seamless Secret Door artwork. Authored Walls remain the source. */
const EPSILON = 1e-6;
const copy = value => structuredClone(value);
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const point = value => {
  if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y)) throw new Error('Seamless Secret Door requires finite points.');
  return { x: value.x, y: value.y };
};

function positionOnSection(value, points, tolerance) {
  let travelled = 0, best = null;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index], length = distance(a, b);
    if (length <= EPSILON) continue;
    const t = Math.max(0, Math.min(1, ((value.x - a.x) * (b.x - a.x) + (value.y - a.y) * (b.y - a.y)) / length ** 2));
    const offset = distance(value, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    if (!best || offset < best.offset) best = { offset, distance: travelled + length * t,
      normal: { x: -(b.y - a.y) / length, y: (b.x - a.x) / length } };
    travelled += length;
  }
  if (!best || best.offset > tolerance + EPSILON * 10) throw new Error(`Seamless Secret Door jamb must lie on its exact rendered Wall section: ${JSON.stringify({ point: value, offset: best?.offset, tolerance, start: points[0], end: points.at(-1), count: points.length })}`);
  return best;
}

export function compileBuildingV2SeamlessSurface(source, metricsByTexture) {
  const [a, b] = (source?.endpoints || []).map(point), width = a && b ? distance(a, b) : 0;
  if (!(width > EPSILON) || !source?.parts?.length || !(source.sceneGridSize > 0)) throw new Error('Seamless Secret Door requires an exact jamb-to-jamb surface source.');
  const tangent = { x: (b.x - a.x) / width, y: (b.y - a.y) / width };
  const normal = { x: -tangent.y, y: tangent.x };
  // Flatten each occupied carrier cut onto the chord, retaining its source
  // samples for public admission. Straight runs preserve their existing phase.
  const paths = source.parts.map(part => (part.sourcePath || part.endpoints).map(point));
  const lengths = paths.map(path => path.slice(1).reduce((sum, p, i) => sum + distance(path[i], p), 0));
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  if (!(totalLength > EPSILON)) throw new Error('Seamless Secret Door has an empty carrier interval.');
  let travelled = 0;
  const parts = source.parts.map((part, index) => {
    const section = part.section, metrics = metricsByTexture.get(section.sectionId);
    if (!metrics || !(metrics.width > 0) || !(metrics.repeatDistance > 0)) throw new Error('Seamless Secret Door requires ready Wall texture metrics.');
    const sourcePath = paths[index];
    const tolerance = Math.max(.25, source.sceneGridSize * .006);
    const points = section.closed ? [...section.points, section.points[0]] : section.points;
    const p = positionOnSection(sourcePath[0], points, tolerance);
    const q = positionOnSection(sourcePath.at(-1), points, tolerance);
    if (section.closed) {
      const perimeter = points.slice(1).reduce((sum, value, i) => sum + distance(points[i], value), 0);
      q.distance = [q.distance, q.distance - perimeter, q.distance + perimeter].sort((x, y) =>
        Math.abs(Math.abs(x - p.distance) - lengths[index]) - Math.abs(Math.abs(y - p.distance) - lengths[index]))[0];
      if (Math.min(p.distance, q.distance) < -EPSILON) { p.distance += perimeter; q.distance += perimeter; }
    }
    const startDistance = travelled * width / totalLength;
    travelled += lengths[index];
    const endDistance = travelled * width / totalLength;
    const spanLength = endDistance - startDistance;
    const sourceLength = Math.abs(q.distance - p.distance);
    if (!(spanLength > EPSILON) || !(sourceLength > EPSILON)) throw new Error('Seamless Secret Door requires a nonempty Wall artwork interval.');
    const compression = spanLength / sourceLength;
    const at = length => ({ x: a.x + tangent.x * length, y: a.y + tangent.y * length });
    const start = at(startDistance), end = at(endDistance);
    const reversed = p.distance > q.distance;
    const offsetY = Number(section.textureOffset?.y || 0) * (reversed ? -1 : 1);
    const visualOffset = { x: normal.x * offsetY, y: normal.y * offsetY };
    return { semanticWallId: part.semanticWallId, startDistance, endDistance,
      sourceTexture: section.textureSrc, textureKey: section.textureKey, span: { start, end }, sourcePath: copy(sourcePath), spanLength,
      directionReversed: reversed, phaseDistance: (Number(section.texturePhaseDistance || 0) + Math.min(p.distance, q.distance)) * compression,
      textureGridSize: source.sceneGridSize, wallWidth: metrics.width, repeatDistance: metrics.repeatDistance * compression,
      textureOffset: { x: Number(section.textureOffset?.x || 0) * compression, y: Number(section.textureOffset?.y || 0) },
      // Wall UV v=0 lies on its positive normal; a leaf texture's v=0 is its negative normal.
      textureFlip: { horizontal: section.textureFlip?.horizontal === true, vertical: (section.textureFlip?.vertical !== true) !== reversed },
      visibleRows: copy(metrics.visibleRows), hsbc: copy(section.hsbc), opacity: Number(section.layerOpacity ?? 1), visualOffset };
  });
  let cursor = 0, minY = Infinity, maxY = -Infinity;
  for (const part of parts) {
    if (Math.abs(part.startDistance - cursor) > EPSILON * 10) throw new Error('Seamless Secret Door requires one complete contiguous surface.');
    cursor = part.endDistance;
    const offset = part.visualOffset.x * normal.x + part.visualOffset.y * normal.y;
    minY = Math.min(minY, offset - part.wallWidth / 2); maxY = Math.max(maxY, offset + part.wallWidth / 2);
  }
  if (Math.abs(cursor - width) > EPSILON * 10) throw new Error('Seamless Secret Door surface differs from its jamb width.');
  const centerY = (minY + maxY) / 2;
  return { version: 2, portalId: source.portalId, sourceTexture: parts[0].sourceTexture,
    span: { start: a, end: b }, spanLength: width, wallWidth: maxY - minY,
    textureGridSize: source.sceneGridSize, visualOffset: { x: normal.x * centerY, y: normal.y * centerY },
    hingeFlip: source.hingeFlip === true, parts };
}

export function transformBuildingV2SeamlessSurface(plan, { a, b, scale = 1, sceneGridSize = plan?.textureGridSize, reflected = false } = {}) {
  if (plan?.version !== 2 || !Array.isArray(plan.parts) || !plan.parts.length || !(scale > 0) || !(sceneGridSize > 0)) throw new Error('Building V2 requires a compiled seamless surface.');
  a = point(a); b = point(b);
  const sourceAngle = Math.atan2(plan.span.end.y - plan.span.start.y, plan.span.end.x - plan.span.start.x);
  const angle = Math.atan2(b.y - a.y, b.x - a.x) - sourceAngle, c = Math.cos(angle), s = Math.sin(angle);
  const vector = p => {
    let {x,y} = p;
    if(reflected) { const ca=Math.cos(sourceAngle), sa=Math.sin(sourceAngle), along=x*ca+y*sa, across=-x*sa+y*ca; x=along*ca+across*sa; y=along*sa-across*ca; }
    return { x: (x * c - y * s) * scale, y: (x * s + y * c) * scale };
  };
  const position = p => { const v = vector({ x: p.x - plan.span.start.x, y: p.y - plan.span.start.y }); return { x: a.x + v.x, y: a.y + v.y }; };
  if (Math.abs(distance(a, b) - plan.spanLength * scale) > EPSILON * Math.max(10, scale)) throw new Error(`Seamless Secret Door transform changed its exact width (expected ${plan.spanLength * scale}, received ${distance(a, b)}, scale ${scale}).`);
  const transform = part => ({ ...copy(part), span: { start: position(part.span.start), end: position(part.span.end) },
    ...(part.sourcePath ? { sourcePath: part.sourcePath.map(position) } : {}),
    spanLength: part.spanLength * scale, wallWidth: part.wallWidth * scale, textureGridSize: sceneGridSize,
    visualOffset: vector(part.visualOffset),
    ...(reflected && part.textureFlip ? {textureFlip: {...part.textureFlip, vertical: !part.textureFlip.vertical}} : {}),
    ...(part.repeatDistance != null ? { repeatDistance: part.repeatDistance * scale,
      phaseDistance: part.phaseDistance * scale, startDistance: part.startDistance * scale, endDistance: part.endDistance * scale,
      textureOffset: { x: part.textureOffset.x * scale, y: part.textureOffset.y * scale } } : {}) });
  // The supplied jambs own the target chord. Re-evaluating its final endpoint
  // as a + (b - a) can lose an ULP even during an identity transform.
  return { ...transform(plan), span: { start: a, end: b }, parts: plan.parts.map(transform) };
}

export function measureBuildingV2SeamlessSurface(plan) {
  if (plan?.version !== 2 || !plan.parts?.length) throw new Error('Seamless bounds require a compiled surface.');
  const corners = plan.parts.flatMap(part => {
    const a = part.span.start, b = part.span.end;
    const nx = -(b.y - a.y) / part.spanLength, ny = (b.x - a.x) / part.spanLength;
    return [a, b].flatMap(p => [-1, 1].map(sign => ({
      x: p.x + part.visualOffset.x + sign * nx * part.wallWidth / 2,
      y: p.y + part.visualOffset.y + sign * ny * part.wallWidth / 2
    })));
  });
  return { minX: Math.min(...corners.map(p => p.x)), minY: Math.min(...corners.map(p => p.y)),
    maxX: Math.max(...corners.map(p => p.x)), maxY: Math.max(...corners.map(p => p.y)) };
}

export function buildingV2SeamlessSurfacesEqual(left, right, path = []) {
  const geometric = new Set(['span', 'sourcePath', 'spanLength', 'wallWidth', 'repeatDistance', 'phaseDistance', 'visualOffset',
    'textureOffset', 'textureGridSize', 'startDistance', 'endDistance']);
  if (typeof left === 'number' && typeof right === 'number' && path.some(key => geometric.has(key))) {
    return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= EPSILON;
  }
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left).sort(), other = Object.keys(right).sort();
  return keys.length === other.length && keys.every((key, index) => key === other[index]
    && buildingV2SeamlessSurfacesEqual(left[key], right[key], [...path, key]));
}
