/** Read-only closed-to-open guides using Foundry v14 DoorMesh animation geometry. */
export function buildingV2DoorIndicatorsV14({ points, animation = {} }) {
  let [a, b] = points;
  if (animation.directionFlip) [a, b] = [b, a];
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return [];
  const type = animation.type || 'swing';
  // Vertical travel has no planar hinge or opening-direction arc.
  if (!['swing', 'swivel', 'slide'].includes(type)) return [];
  const direction = animation.direction === -1 ? -1 : 1;
  const double = animation.double === true;
  // Foundry's DoorMesh turns a swing by a quarter turn times strength and slides a leaf by its length times
  // strength (0 to 2, 1 when the door has none of its own). The guide shows that travel, not a fixed quarter turn.
  const strength = Number.isFinite(Number(animation.strength)) ? Math.min(2, Math.max(0, Number(animation.strength))) : 1;
  const at = (t) => ({ x: a.x + dx * t, y: a.y + dy * t });
  return Array.from({ length: double ? 2 : 1 }, (_, index) => {
    const right = index === 1;
    const sign = direction * (right ? -1 : 1);
    if (type === 'slide') {
      const start = at(double ? (right ? 0.75 : 0.25) : 0.5);
      const end = { x: start.x - dx * sign * strength * (double ? 0.5 : 1),
        y: start.y - dy * sign * strength * (double ? 0.5 : 1) };
      return { pivot: null, guide: [], travel: [start, end] };
    }
    const pivot = type === 'swivel' ? at(double ? (right ? 0.75 : 0.25) : 0.5) : at(right ? 1 : 0);
    const radius = length * (double ? 0.5 : 1) * (type === 'swivel' ? 0.5 : 1);
    const angle = Math.atan2(dy, dx) - (right ? Math.PI : 0);
    const tip = (theta, r = radius) => ({ x: pivot.x + Math.cos(theta) * r, y: pivot.y + Math.sin(theta) * r });
    const sweep = sign * strength * Math.PI / 2;
    const endAngle = angle + sweep;
    // Trace the actual leaf tip from closed to open. Shortening this radius
    // makes the arrow look like a generic direction cue rather than the
    // native Door's true swing arc.
    const travel = Array.from({ length: 25 }, (_, i) => tip(angle + sweep * i / 24));
    const guide = type === 'swivel' ? [tip(endAngle + Math.PI), tip(endAngle)] : [pivot, tip(endAngle)];
    return { pivot, guide, travel };
  });
}
