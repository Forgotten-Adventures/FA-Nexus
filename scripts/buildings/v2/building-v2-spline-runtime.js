/** Deterministic projection of authored spline controls. No mutable editor state. */
function point(value) {
  if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y)) throw new Error('Building V2 spline requires finite control coordinates.');
  return { x: value.x, y: value.y };
}

export function deriveBuildingV2SplineSegments(points, { closed = false, tension = 0.5 } = {}) {
  if (!Array.isArray(points) || points.length < (closed ? 3 : 2)
    || !Number.isFinite(tension) || tension < 0 || tension > 1) {
    throw new Error('Building V2 spline requires valid controls and tension between 0 and 1.');
  }
  const controls = points.map(point);
  const at = index => closed ? controls[(index + controls.length) % controls.length]
    : controls[Math.max(0, Math.min(controls.length - 1, index))];
  return Array.from({ length: controls.length - (closed ? 0 : 1) }, (_, index) => {
    const a = at(index - 1), start = at(index), end = at(index + 1), b = at(index + 2);
    if (Math.hypot(end.x - start.x, end.y - start.y) <= 1e-6) throw new Error('Building V2 spline has coincident adjacent controls.');
    // Cardinal Hermite tangents. Zero tension is straight; one gives the full
    // neighbour tangent. Clamped endpoint neighbours give a finite end tangent.
    const k = tension / 3;
    return { start: point(start), end: point(end), geometry: { kind: 'cubic',
      controls: [
        { x: start.x + (end.x - a.x) * k, y: start.y + (end.y - a.y) * k },
        { x: end.x - (b.x - start.x) * k, y: end.y - (b.y - start.y) * k }
      ] } };
  });
}

export function resolveBuildingV2SplineSpan(authoring, span) {
  const path = authoring?.interiorPathsById?.[span?.owner?.id];
  if (span?.geometry?.kind !== 'spline-span' || path?.family !== 'spline') throw new Error('Building V2 spline span lost its owning Path.');
  const index = path.edges?.findIndex(edge => edge.semanticWallId === span.id);
  if (!(index >= 0)) throw new Error('Building V2 spline span is absent from its owning Path.');
  const segment = deriveBuildingV2SplineSegments(path.controlIds.map(id => authoring.splineControlsById?.[id]), path)[index];
  const reverse = path.edges[index].direction === 'reverse';
  return reverse ? { start: segment.end, end: segment.start, geometry: { kind: 'cubic', controls: segment.geometry.controls.toReversed() } } : segment;
}

export function evaluateBuildingV2Cubic(start, geometry, end, t) {
  const a = point(start), b = point(end);
  if (!Array.isArray(geometry?.controls) || geometry.controls.length !== 2 || !Number.isFinite(t)) throw new Error('Building V2 cubic requires two controls and a finite parameter.');
  const [c, d] = geometry.controls.map(point), u = 1 - t;
  return { x: u ** 3 * a.x + 3 * u * u * t * c.x + 3 * u * t * t * d.x + t ** 3 * b.x,
    y: u ** 3 * a.y + 3 * u * u * t * c.y + 3 * u * t * t * d.y + t ** 3 * b.y };
}

export function restrictBuildingV2Cubic(start, geometry, end, t0, t1) {
  if (![t0, t1].every(t => Number.isFinite(t) && t >= 0 && t <= 1)) throw new Error('Building V2 cubic restriction requires parameters within the span.');
  const reverse = t1 < t0;
  if (reverse) [t0, t1] = [t1, t0];
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const split = (p, t) => {
    const a = lerp(p[0], p[1], t), b = lerp(p[1], p[2], t), c = lerp(p[2], p[3], t);
    const d = lerp(a, b, t), e = lerp(b, c, t), f = lerp(d, e, t);
    return { left: [p[0], a, d, f], right: [f, e, c, p[3]] };
  };
  let p = [point(start), ...geometry.controls.map(point), point(end)];
  if (t1 < 1) p = split(p, t1).left;
  if (t0 > 0) p = split(p, t1 > 0 ? t0 / t1 : 0).right;
  if (reverse) p.reverse();
  return { start: p[0], end: p[3], geometry: { kind: 'cubic', controls: p.slice(1, 3) } };
}
