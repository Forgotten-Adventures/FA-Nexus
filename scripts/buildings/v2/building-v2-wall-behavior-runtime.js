import {
  createBuildingWallFieldRuntime,
  validateBuildingWallStructuralPatch
} from '../building-wall-fields-v14.js';
import { normalizeBuildingStructuralWallBehavior } from '../building-wall-restrictions.js';

const PRESET_NAMES = Object.freeze(['Solid', 'Terrain', 'Invisible', 'Ethereal']);
const STRUCTURAL_KEYS = Object.freeze(['move', 'light', 'sight', 'sound', 'dir', 'threshold']);
const THRESHOLD_KEYS = Object.freeze(['light', 'sight', 'sound', 'attenuation']);

function clone(value) {
  if (value === undefined) return undefined;
  return globalThis.structuredClone ? globalThis.structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function sameValue(left, right) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function mergeBehavior(base, override) {
  if (!override) return clone(base);
  const merged = { ...clone(base), ...clone(override) };
  if (own(override, 'threshold')) {
    merged.threshold = { ...clone(base?.threshold || {}), ...clone(override.threshold || {}) };
  }
  return merged;
}

function sparseDifference(base, resolved) {
  const override = {};
  for (const key of STRUCTURAL_KEYS) {
    if (key === 'threshold') {
      const threshold = {};
      for (const thresholdKey of THRESHOLD_KEYS) {
        if (!sameValue(base?.threshold?.[thresholdKey], resolved?.threshold?.[thresholdKey])) {
          threshold[thresholdKey] = clone(resolved?.threshold?.[thresholdKey]);
        }
      }
      if (Object.keys(threshold).length) override.threshold = threshold;
      continue;
    }
    if (!sameValue(base?.[key], resolved?.[key])) override[key] = clone(resolved?.[key]);
  }
  return Object.keys(override).length ? override : null;
}

export function createBuildingV2WallBehaviorRuntime({
  createAdvancedRuntime = createBuildingWallFieldRuntime
} = {}) {
  const advanced = createAdvancedRuntime();
  const presets = Object.fromEntries(PRESET_NAMES.map((name) => [name, clone(advanced.presets[name])]));
  const presetValue = (name) => {
    const normalized = String(name || '').trim();
    if (!PRESET_NAMES.includes(normalized)) {
      throw new Error(`Building V2 Wall Behavior preset ${normalized || '(missing)'} is unsupported.`);
    }
    return clone(presets[normalized]);
  };
  const completeValue = (value, path) => {
    if (value && typeof value === 'object' && Object.keys(value).length === 1 && own(value, 'preset')) {
      return presetValue(value.preset);
    }
    return normalizeBuildingStructuralWallBehavior(value, {
      constants: advanced.constants,
      path,
      sparse: false
    });
  };
  const resolvedValue = ({ defaults, pathOverride = null, segmentOverride = null } = {}) => {
    let resolved = completeValue(defaults, 'Building V2 Wall Behavior defaults');
    for (const [override, path] of [
      [pathOverride, 'Building V2 Wall Behavior Path override'],
      [segmentOverride, 'Building V2 Wall Behavior Segment override']
    ]) {
      if (override == null) continue;
      const sparse = override && typeof override === 'object'
        && Object.keys(override).length === 1 && own(override, 'preset')
        ? sparseDifference(resolved, presetValue(override.preset))
        : normalizeBuildingStructuralWallBehavior(override, {
            constants: advanced.constants,
            path,
            sparse: true
          });
      resolved = completeValue(mergeBehavior(resolved, sparse), `${path} result`);
    }
    return resolved;
  };
  return Object.freeze({
    presetNames: PRESET_NAMES,
    getPresets() {
      return clone(presets);
    },
    getFields() {
      return advanced.profiles.structural.fields.map(({ nativeField, ...descriptor }) => clone(descriptor));
    },
    patch(value, changes, { base } = {}) {
      const inherited = base === undefined ? null : completeValue(base, 'Building V2 inherited Wall Behavior');
      const effective = inherited
        ? resolvedValue({ defaults: inherited, segmentOverride: value })
        : completeValue(value, 'Building V2 Wall Behavior');
      validateBuildingWallStructuralPatch(changes, { runtime: advanced, records: [effective] });
      if (!Object.keys(changes).length) return clone(value);
      if (!inherited) return completeValue(mergeBehavior(effective, changes), 'Building V2 patched Wall Behavior');
      // Only changed leaves may gain or lose an override. An unrelated explicit
      // value must survive even when it currently equals its inherited value.
      const next = value?.preset ? sparseDifference(inherited, effective) || {} : clone(value || {});
      for (const [key, change] of Object.entries(changes)) {
        if (key === 'threshold') {
          next.threshold ||= {};
          for (const [sense, fieldValue] of Object.entries(change)) {
            if (sameValue(inherited.threshold[sense], fieldValue)) delete next.threshold[sense];
            else next.threshold[sense] = clone(fieldValue);
          }
          if (!Object.keys(next.threshold).length) delete next.threshold;
        } else if (sameValue(inherited[key], change)) delete next[key];
        else next[key] = clone(change);
      }
      if (!Object.keys(next).length) return null;
      return normalizeBuildingStructuralWallBehavior(next, {
        constants: advanced.constants, path: 'Building V2 patched Wall Behavior override', sparse: true
      });
    },
    normalizeDefault(value) {
      return completeValue(value, 'Building V2 Wall Behavior default');
    },
    normalizeOverride(value, { base } = {}) {
      if (value == null) return null;
      const normalizedBase = completeValue(base, 'Building V2 Wall Behavior inherited base');
      const resolved = value && typeof value === 'object'
        && Object.keys(value).length === 1 && own(value, 'preset')
        ? presetValue(value.preset)
        : completeValue(mergeBehavior(normalizedBase, normalizeBuildingStructuralWallBehavior(value, {
            constants: advanced.constants,
            path: 'Building V2 Wall Behavior sparse override',
            sparse: true
          })), 'Building V2 Wall Behavior sparse override result');
      return sparseDifference(normalizedBase, resolved);
    },
    resolve(options = {}) {
      return resolvedValue(options);
    },
    preset(name) {
      return presetValue(name);
    },
    identifyPreset(value) {
      const normalized = completeValue(value, 'Building V2 effective Wall Behavior');
      return PRESET_NAMES.find((name) => sameValue(normalized, presets[name])) || 'Custom';
    }
  });
}

export const BUILDING_V2_WALL_BEHAVIOR_RUNTIME_VERSION = 2;
