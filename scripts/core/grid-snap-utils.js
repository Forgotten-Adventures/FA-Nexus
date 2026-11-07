export const GRID_SNAP_DIVISORS = Object.freeze([1, 2, 3, 4, 5]);
export const GRID_SNAP_SUBDIV_LABELS = Object.freeze(['Full', '1/2', '1/3', '1/4', '1/5']);
export const GRID_SNAP_SUBDIV_SETTING_KEY = 'gridSnapSubdivisions';
export const GRID_SNAP_SUBDIV_MIN = 0;
export const GRID_SNAP_SUBDIV_MAX = GRID_SNAP_DIVISORS.length - 1;
export const GRID_SNAP_SUBDIV_DEFAULT = 1;

export function normalizeGridSnapSubdivision(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return GRID_SNAP_SUBDIV_DEFAULT;
  return Math.max(
    GRID_SNAP_SUBDIV_MIN,
    Math.min(GRID_SNAP_SUBDIV_MAX, Math.round(numeric))
  );
}

export function readGridSnapSubdivisionSetting() {
  try {
    const raw = globalThis?.game?.settings?.get?.('fa-nexus', GRID_SNAP_SUBDIV_SETTING_KEY);
    return normalizeGridSnapSubdivision(raw);
  } catch (_) {
    return GRID_SNAP_SUBDIV_DEFAULT;
  }
}

export function getGridSnapDivisor(subdivisions = undefined) {
  const index = normalizeGridSnapSubdivision(
    subdivisions !== undefined ? subdivisions : readGridSnapSubdivisionSetting()
  );
  return GRID_SNAP_DIVISORS[index] ?? 1;
}

export function getGridSnapStep(gridSize, subdivisions = undefined) {
  const size = Number(gridSize);
  if (!Number.isFinite(size) || size <= 0) return 0;
  const divisor = getGridSnapDivisor(subdivisions);
  const safeDivisor = Math.max(1, Number(divisor) || 1);
  return size / safeDivisor;
}

export function snapPlacementPoint(point, {enabled=true,gridSize,subdivisions}={}) {
  const step=enabled?getGridSnapStep(gridSize,subdivisions):0;
  if(!step)return {...point};
  return {x:Math.round(point.x/step)*step,y:Math.round(point.y/step)*step};
}

/** Expand an oriented frame outwards to grid lines in its own axes. */
export function expandFrameToGrid(frame, step) {
  if (!Number.isFinite(step) || step <= 0) throw new Error('A positive grid size is required.');
  const radians = (frame.angle || 0) * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
  const x = frame.center.x * c + frame.center.y * s, y = -frame.center.x * s + frame.center.y * c;
  // Avoid adding a whole cell for floating point noise at an exact grid line.
  const floor = value => Math.floor(value / step + 1e-9) * step;
  const ceil = value => Math.ceil(value / step - 1e-9) * step;
  const left = floor(x - frame.width / 2), right = ceil(x + frame.width / 2);
  const top = floor(y - frame.height / 2), bottom = ceil(y + frame.height / 2);
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  return {...frame, center:{x:cx*c-cy*s,y:cx*s+cy*c},width:right-left,height:bottom-top};
}

export function formatGridSnapSubdivisionLabel(value) {
  const index = normalizeGridSnapSubdivision(value);
  return GRID_SNAP_SUBDIV_LABELS[index] ?? GRID_SNAP_SUBDIV_LABELS[0];
}
