// Shared committed-runtime helpers. Authoring state belongs to the premium editor.

const STRUCTURAL_BEHAVIOR_KEYS = Object.freeze(['move', 'light', 'sight', 'sound', 'dir', 'threshold']);

const THRESHOLD_KEYS = Object.freeze(['light', 'sight', 'sound', 'attenuation']);

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function requirePlainObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value;
}

function assertExactKeys(value, expected, path, { allowMissing = false } = {}) {
  const object = requirePlainObject(value, path);
  const keys = Object.keys(object);
  const unsupported = keys.find((key) => !expected.includes(key));
  if (unsupported) throw new Error(`${path}.${unsupported} is unsupported.`);
  if (!allowMissing) {
    const missing = expected.find((key) => !own(object, key));
    if (missing) throw new Error(`${path}.${missing} is required.`);
  }
}

function normalizeConstants(constants = globalThis?.CONST) {
  const source = constants || {};
  const normalized = {
    sense: {
      none: source?.EDGE_SENSE_TYPES?.NONE,
      limited: source?.EDGE_SENSE_TYPES?.LIMITED,
      normal: source?.EDGE_SENSE_TYPES?.NORMAL,
      proximity: source?.EDGE_SENSE_TYPES?.PROXIMITY,
      distance: source?.EDGE_SENSE_TYPES?.DISTANCE
    },
    movement: {
      none: source?.WALL_MOVEMENT_TYPES?.NONE,
      normal: source?.WALL_MOVEMENT_TYPES?.NORMAL
    },
    direction: {
      both: source?.EDGE_DIRECTIONS?.BOTH,
      left: source?.EDGE_DIRECTIONS?.LEFT,
      right: source?.EDGE_DIRECTIONS?.RIGHT
    },
    door: {
      none: source?.WALL_DOOR_TYPES?.NONE,
      door: source?.WALL_DOOR_TYPES?.DOOR,
      secret: source?.WALL_DOOR_TYPES?.SECRET
    },
    doorState: {
      closed: source?.WALL_DOOR_STATES?.CLOSED,
      open: source?.WALL_DOOR_STATES?.OPEN,
      locked: source?.WALL_DOOR_STATES?.LOCKED
    }
  };
  for (const [group, values] of Object.entries(normalized)) {
    for (const [name, value] of Object.entries(values)) {
      if (!Number.isFinite(value)) {
        throw new Error(`Foundry v14 Wall constant ${group}.${name} is unavailable.`);
      }
    }
  }
  return normalized;
}

function normalizeThreshold(value, path, { sparse = false } = {}) {
  assertExactKeys(value, THRESHOLD_KEYS, path, { allowMissing: sparse });
  const normalized = {};
  for (const key of THRESHOLD_KEYS) {
    if (!own(value, key)) continue;
    const candidate = value[key];
    if (key === 'attenuation') {
      if (typeof candidate !== 'boolean') throw new Error(`${path}.attenuation must be a boolean.`);
    } else if (candidate !== null && (!Number.isFinite(candidate) || candidate <= 0)) {
      throw new Error(`${path}.${key} must be null or a positive number.`);
    }
    normalized[key] = candidate;
  }
  if (sparse && !Object.keys(normalized).length) {
    throw new Error(`${path} must contain at least one threshold field.`);
  }
  return normalized;
}

function assertEnum(value, allowed, path) {
  if (!Number.isFinite(value) || !allowed.includes(value)) {
    throw new Error(`${path} must be a supported Foundry v14 Wall value.`);
  }
  return value;
}

function validateStructuralBehavior(value, { constants, path = 'behavior', sparse = false } = {}) {
  const c = normalizeConstants(constants);
  assertExactKeys(value, STRUCTURAL_BEHAVIOR_KEYS, path, { allowMissing: sparse });
  const normalized = {};
  const senseValues = [c.sense.none, c.sense.limited, c.sense.normal, c.sense.proximity, c.sense.distance];
  if (own(value, 'move')) normalized.move = assertEnum(value.move, [c.movement.none, c.movement.normal], `${path}.move`);
  for (const key of ['light', 'sight', 'sound']) {
    if (own(value, key)) normalized[key] = assertEnum(value[key], senseValues, `${path}.${key}`);
  }
  if (own(value, 'dir')) normalized.dir = assertEnum(value.dir, [c.direction.both, c.direction.left, c.direction.right], `${path}.dir`);
  if (own(value, 'threshold')) normalized.threshold = normalizeThreshold(value.threshold, `${path}.threshold`, { sparse });
  if (sparse && !Object.keys(normalized).length) throw new Error(`${path} must contain at least one behavior field.`);
  return normalized;
}

export function normalizeBuildingStructuralWallBehavior(value, {
  constants = globalThis.CONST,
  path = 'behavior',
  sparse = false
} = {}) {
  return validateStructuralBehavior(value, { constants, path, sparse });
}
