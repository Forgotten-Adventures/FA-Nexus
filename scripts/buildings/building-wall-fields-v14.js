// Shared committed-runtime helpers. Authoring state belongs to the premium editor.

const TOP_LEVEL_WALL_FIELDS = Object.freeze([
  '_id',
  'c',
  'levels',
  'light',
  'move',
  'sight',
  'sound',
  'dir',
  'door',
  'ds',
  'doorSound',
  'threshold',
  'animation',
  'flags'
]);

const THRESHOLD_FIELDS = Object.freeze(['light', 'sight', 'sound', 'attenuation']);

const ANIMATION_FIELDS = Object.freeze(['direction', 'double', 'duration', 'flip', 'strength', 'texture', 'type']);

const STRUCTURAL_FIELD_PATHS = Object.freeze([
  'move',
  'light',
  'threshold.light',
  'sight',
  'threshold.sight',
  'sound',
  'threshold.sound',
  'threshold.attenuation',
  'dir'
]);

const PORTAL_FIELD_PATHS = Object.freeze([
  ...STRUCTURAL_FIELD_PATHS,
  'ds',
  'doorSound',
  'animation.type',
  'animation.direction',
  'animation.duration',
  'animation.strength',
  'animation.double'
]);

const FIELD_LABELS = Object.freeze({
  move: 'Movement',
  light: 'Light',
  sight: 'Sight',
  sound: 'Sound',
  'threshold.light': 'Light Threshold',
  'threshold.sight': 'Sight Threshold',
  'threshold.sound': 'Sound Threshold',
  'threshold.attenuation': 'Threshold Attenuation',
  dir: 'Restriction Direction',
  ds: 'State',
  doorSound: 'Door Sound',
  'animation.type': 'Animation Type',
  'animation.direction': 'Opening Direction',
  'animation.duration': 'Duration',
  'animation.strength': 'Strength',
  'animation.double': 'Double Door'
});

const FIELD_CODECS = Object.freeze({
  doorSound: Object.freeze({ nativeNullValue: undefined }),
  'animation.type': Object.freeze({
    nullParentPath: 'animation',
    nativeNullValue: '',
    clearParentPath: 'animation'
  })
});

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function requirePlainObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value;
}

function assertExactRuntimeFields(fields, expected, path) {
  requirePlainObject(fields, path);
  for (const key of expected) {
    if (!fields[key]) throw new Error(`Installed Foundry v14 ${path}.${key} is unavailable.`);
  }
  const unsupported = Object.keys(fields).find((key) => !expected.includes(key));
  if (unsupported) {
    throw new Error(`Installed Foundry v14 ${path}.${unsupported} is unsupported by Building Wall Advanced.`);
  }
}

function normalizeWallFields(wallSchema) {
  const fields = wallSchema?.fields || wallSchema;
  assertExactRuntimeFields(fields, TOP_LEVEL_WALL_FIELDS, 'Wall schema');
  assertExactRuntimeFields(fields.threshold?.fields, THRESHOLD_FIELDS, 'Wall schema.threshold');
  assertExactRuntimeFields(fields.animation?.fields, ANIMATION_FIELDS, 'Wall schema.animation');
  return fields;
}

function fieldAtPath(fields, path) {
  const parts = path.split('.');
  let field = fields[parts.shift()];
  for (const part of parts) field = field?.fields?.[part];
  if (!field || typeof field.validate !== 'function') {
    throw new Error(`Installed Foundry v14 Wall field ${path} is unavailable or cannot validate values.`);
  }
  return field;
}

function localizeLabel(localize, key, fallback = key) {
  if (!key) return fallback;
  const localized = localize(key);
  return localized && localized !== key ? localized : fallback;
}

function normalizeChoiceValue(field, raw) {
  if (field?.constructor?.name === 'NumberField') return Number(raw);
  return raw;
}

function fieldChoices(field, localize) {
  const choices = field?.choices;
  if (!choices || (typeof choices !== 'object')) {
    throw new Error(`Installed Foundry v14 Wall field ${field?.fieldPath || 'unknown'} exposes no choices.`);
  }
  const entries = Array.isArray(choices)
    ? choices.map((value) => [value, String(value)])
    : Object.entries(choices);
  if (!entries.length) {
    throw new Error(`Installed Foundry v14 Wall field ${field?.fieldPath || 'unknown'} exposes no choices.`);
  }
  return entries.map(([rawValue, label]) => ({
    value: normalizeChoiceValue(field, rawValue),
    label: localizeLabel(localize, label, String(rawValue)),
    localizationKey: typeof label === 'string' ? label : null
  }));
}

function configuredChoices(record, { localize, path, includeNone = false } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`Installed Foundry v14 ${path} choices are unavailable.`);
  }
  const choices = Object.entries(record).map(([value, config]) => ({
    value,
    label: localizeLabel(localize, config?.label, value),
    localizationKey: config?.label || null
  }));
  if (!choices.length) throw new Error(`Installed Foundry v14 ${path} choices are unavailable.`);
  if (includeNone) choices.unshift({ value: null, label: 'None', localizationKey: null });
  return choices;
}

function choiceByLocalizationToken(descriptor, token) {
  const suffix = `.${token}`.toUpperCase();
  const matches = descriptor.choices.filter(({ localizationKey }) => (
    typeof localizationKey === 'string' && localizationKey.toUpperCase().endsWith(suffix)
  ));
  if (matches.length !== 1) {
    throw new Error(`Installed Foundry v14 ${descriptor.path} choices do not expose one ${token} value.`);
  }
  return matches[0].value;
}

function descriptorInput(field, choices) {
  if (choices) return 'select';
  if (field?.constructor?.name === 'BooleanField') return 'boolean';
  if (field?.constructor?.name === 'NumberField') return 'number';
  return 'text';
}

function createFieldDescriptor(fields, path, {
  localize,
  choices = null,
  applicableWhen = null
} = {}) {
  const field = fieldAtPath(fields, path);
  const resolvedChoices = choices || (
    field.choices ? fieldChoices(field, localize) : null
  );
  return {
    path,
    label: FIELD_LABELS[path] || localizeLabel(localize, field.label, path),
    input: descriptorInput(field, resolvedChoices),
    choices: resolvedChoices,
    required: field.required === true,
    nullable: field.nullable === true,
    initial: clone(field.getInitialValue?.({}) ?? field.initial),
    min: Number.isFinite(field.min) ? field.min : null,
    max: Number.isFinite(field.max) ? field.max : null,
    step: Number.isFinite(field.step) ? field.step : null,
    applicableWhen,
    codec: FIELD_CODECS[path] || null,
    ...(path === 'ds' ? {
      scopeLabels: {
        portalDefault: 'Initial State',
        portal: 'Live State'
      }
    } : {}),
    nativeField: field
  };
}

function buildDescriptors(fields, wallConfig, localize) {
  const senseDescriptors = Object.fromEntries(['light', 'sight', 'sound'].map((path) => [
    path,
    createFieldDescriptor(fields, path, { localize })
  ]));
  const thresholdSenseValues = [...new Set(['PROXIMITY', 'DISTANCE'].map((token) => (
    choiceByLocalizationToken(senseDescriptors.light, token)
  )))];
  for (const path of ['sight', 'sound']) {
    const values = ['PROXIMITY', 'DISTANCE'].map((token) => choiceByLocalizationToken(senseDescriptors[path], token));
    if (JSON.stringify(values) !== JSON.stringify(thresholdSenseValues)) {
      throw new Error(`Installed Foundry v14 ${path} threshold choices differ from light threshold choices.`);
    }
  }

  const descriptorOptions = {
    'threshold.light': { applicableWhen: { path: 'light', values: thresholdSenseValues } },
    'threshold.sight': { applicableWhen: { path: 'sight', values: thresholdSenseValues } },
    'threshold.sound': { applicableWhen: { path: 'sound', values: thresholdSenseValues } },
    'threshold.attenuation': {
      applicableWhen: {
        any: ['light', 'sight', 'sound'].map((path) => ({ path, values: thresholdSenseValues }))
      }
    },
    doorSound: {
      choices: configuredChoices(wallConfig?.doorSounds, {
        localize,
        path: 'CONFIG.Wall.doorSounds',
        includeNone: true
      })
    },
    'animation.type': {
      choices: configuredChoices(wallConfig?.animationTypes, {
        localize,
        path: 'CONFIG.Wall.animationTypes',
        includeNone: true
      })
    },
    'animation.direction': { applicableWhen: { path: 'animation.type', truthy: true } },
    'animation.duration': { applicableWhen: { path: 'animation.type', truthy: true } },
    'animation.strength': { applicableWhen: { path: 'animation.type', truthy: true } },
    'animation.double': { applicableWhen: { path: 'animation.type', truthy: true } }
  };
  const descriptorByPath = {};
  for (const path of PORTAL_FIELD_PATHS) {
    descriptorByPath[path] = senseDescriptors[path]
      || createFieldDescriptor(fields, path, { localize, ...(descriptorOptions[path] || {}) });
  }
  return descriptorByPath;
}

function createStructuralPresets(descriptorByPath) {
  const moveNormal = choiceByLocalizationToken(descriptorByPath.move, 'NORMAL');
  const senseNormal = choiceByLocalizationToken(descriptorByPath.sight, 'NORMAL');
  const senseLimited = choiceByLocalizationToken(descriptorByPath.sight, 'LIMITED');
  const senseNone = choiceByLocalizationToken(descriptorByPath.sight, 'NONE');
  const directionBoth = choiceByLocalizationToken(descriptorByPath.dir, 'BOTH');
  for (const path of ['light', 'sound']) {
    for (const token of ['NORMAL', 'LIMITED', 'NONE']) {
      choiceByLocalizationToken(descriptorByPath[path], token);
    }
  }
  const threshold = {
    light: clone(descriptorByPath['threshold.light'].initial),
    sight: clone(descriptorByPath['threshold.sight'].initial),
    sound: clone(descriptorByPath['threshold.sound'].initial),
    attenuation: clone(descriptorByPath['threshold.attenuation'].initial)
  };
  const preset = ({ move, light, sight, sound }) => ({
    move,
    light,
    sight,
    sound,
    threshold: clone(threshold),
    dir: directionBoth
  });
  return {
    Solid: preset({ move: moveNormal, light: senseNormal, sight: senseNormal, sound: senseNormal }),
    Terrain: preset({ move: moveNormal, light: senseLimited, sight: senseLimited, sound: senseLimited }),
    Invisible: preset({ move: moveNormal, light: senseNone, sight: senseNone, sound: senseNone }),
    Ethereal: preset({
      move: choiceByLocalizationToken(descriptorByPath.move, 'NONE'),
      light: senseNormal,
      sight: senseNormal,
      sound: senseNone
    })
  };
}

export function createBuildingWallFieldRuntime({
  wallSchema = globalThis?.CONFIG?.Wall?.documentClass?.schema,
  wallConfig = globalThis?.CONFIG?.Wall,
  constants = globalThis?.CONST,
  localize = (key) => globalThis?.game?.i18n?.localize?.(key) || key
} = {}) {
  if (!constants) throw new Error('Installed Foundry v14 Wall constants are unavailable.');
  const fields = normalizeWallFields(wallSchema);
  const descriptorByPath = buildDescriptors(fields, wallConfig, localize);
  const structuralFields = STRUCTURAL_FIELD_PATHS.map((path) => descriptorByPath[path]);
  const portalFields = PORTAL_FIELD_PATHS.map((path) => descriptorByPath[path]);
  return {
    constants,
    wallConfig,
    fields,
    descriptorByPath,
    presets: createStructuralPresets(descriptorByPath),
    profiles: {
      structural: { id: 'structural', fields: structuralFields },
      portal: { id: 'portal', fields: portalFields }
    }
  };
}

function valuesEqual(left, right) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stable(value[key]);
      return result;
    }, {});
  };
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function validateDescriptorValue(descriptor, value) {
  if (descriptor.choices && !descriptor.choices.some((choice) => valuesEqual(choice.value, value))) {
    throw new Error(`Building Wall Advanced ${descriptor.path} must be a supported installed Foundry v14 choice.`);
  }
  let nativeValue = value;
  if ((value === null) && own(descriptor.codec, 'nativeNullValue')) {
    nativeValue = descriptor.codec.nativeNullValue;
  }
  try {
    descriptor.nativeField.validate(nativeValue, { strict: true });
  } catch (error) {
    throw new Error(`Building Wall Advanced ${descriptor.path} is not valid for the installed Foundry v14 Wall schema.`, {
      cause: error
    });
  }
}

function mergePatch(base, changes) {
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) return clone(changes);
  const merged = requirePlainObject(clone(base) || {}, 'Building Wall Advanced patch target');
  for (const [key, value] of Object.entries(changes)) {
    merged[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergePatch(merged[key], value)
      : clone(value);
  }
  return merged;
}

function clearDescriptorForParent(runtime, allowedPaths, parentPath) {
  return allowedPaths
    .map((path) => runtime.descriptorByPath[path])
    .find((descriptor) => descriptor?.codec?.clearParentPath === parentPath) || null;
}

function assertPatchKeys(changes, allowedPaths, runtime, prefix = '') {
  const allowedExact = new Set(allowedPaths);
  const allowedParents = new Set(allowedPaths.flatMap((path) => {
    const parts = path.split('.');
    return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('.'));
  }));
  for (const [key, value] of Object.entries(requirePlainObject(changes, 'Building Wall Advanced changes'))) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (allowedExact.has(path)) continue;
    if ((value === null) && clearDescriptorForParent(runtime, allowedPaths, path)) continue;
    if (allowedParents.has(path) && value && typeof value === 'object' && !Array.isArray(value)) {
      assertPatchKeys(value, allowedPaths, runtime, path);
      continue;
    }
    throw new Error(`Building Wall Advanced patch field ${path} is unsupported for this scope.`);
  }
}

function changedLeafEntries(changes, runtime, allowedPaths, prefix = '') {
  const entries = [];
  for (const [key, value] of Object.entries(changes)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const clearDescriptor = value === null
      ? clearDescriptorForParent(runtime, allowedPaths, path)
      : null;
    if (clearDescriptor) {
      entries.push([clearDescriptor.path, null]);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      entries.push(...changedLeafEntries(value, runtime, allowedPaths, path));
    } else {
      entries.push([path, value]);
    }
  }
  return entries;
}

function validatePatchValues(changes, runtime, allowedPaths) {
  for (const [path, value] of changedLeafEntries(changes, runtime, allowedPaths)) {
    const descriptor = runtime.descriptorByPath[path];
    if (!descriptor) throw new Error(`Building Wall Advanced patch field ${path} is unsupported for this scope.`);
    validateDescriptorValue(descriptor, value);
  }
}

function thresholdValuesForSense(runtime, sense) {
  return runtime.descriptorByPath[`threshold.${sense}`]?.applicableWhen?.values || [];
}

function validatePatchApplicability(records, changes, runtime, { preserveDormant = false } = {}) {
  for (const record of records) {
    const candidate = mergePatch(record, changes);
    for (const sense of ['light', 'sight', 'sound']) {
      const senseChanged = own(changes, sense);
      const thresholdChanged = own(changes.threshold, sense);
      if (!senseChanged && !thresholdChanged) continue;
      const thresholdCapable = thresholdValuesForSense(runtime, sense)
        .some((value) => valuesEqual(value, candidate[sense]));
      const threshold = candidate.threshold?.[sense] ?? null;
      if (thresholdChanged && threshold !== null && !thresholdCapable) {
        throw new Error(`Building Wall Advanced threshold.${sense} is not applicable to the effective ${sense} restriction.`);
      }
      if (!preserveDormant && senseChanged && !thresholdCapable && threshold !== null) {
        throw new Error(`Building Wall Advanced threshold.${sense} must be explicitly clear when ${sense} is not threshold-capable.`);
      }
    }
  }
}

/** Validate a structural field patch without constructing a legacy authoring contract. */

export function validateBuildingWallStructuralPatch(changes, { runtime, records } = {}) {
  assertPatchKeys(changes, STRUCTURAL_FIELD_PATHS, runtime);
  validatePatchValues(changes, runtime, STRUCTURAL_FIELD_PATHS);
  validatePatchApplicability(records, changes, runtime, { preserveDormant: true });
  if (own(changes.threshold, 'attenuation') && changes.threshold.attenuation) {
    for (const record of records) {
      const candidate = mergePatch(record, changes);
      const applicable = ['light', 'sight', 'sound'].some(sense =>
        thresholdValuesForSense(runtime, sense).includes(candidate[sense]));
      if (!applicable) throw new Error('Threshold Attenuation requires a threshold-based sense restriction.');
    }
  }
  return changes;
}
