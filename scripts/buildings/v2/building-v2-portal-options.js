// Public Foundry v14 Portal configuration. These are authored options; current
// gameplay state belongs to the native Wall and never enters this value.
export function normalizeBuildingV2PortalTiming(value = {}) {
  const duration = value.duration ?? 750;
  const strength = value.strength ?? 1;
  if (!Number.isInteger(duration) || duration <= 0
    || !Number.isFinite(strength) || strength < 0 || strength > 2) {
    throw new Error('Portal animation requires a positive integer duration in milliseconds and strength from 0 to 2.');
  }
  return { duration, strength };
}

export function normalizeBuildingV2PortalSound(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error('Portal sound requires a native Door sound key or an empty string for None.');
  }
  return value;
}

export function getBuildingV2PortalOptionFields() {
  const localize = text => globalThis.game?.i18n?.localize?.(text) ?? text;
  return [
    { path: 'duration', label: 'Animation Duration', input: 'number', min: 1, step: 1, units: 'ms' },
    { path: 'strength', label: 'Animation Strength', input: 'number', min: 0, max: 2, step: 0.05 },
    { path: 'doorSound', label: 'Door Sound', input: 'string', choices: [
      { value: '', label: 'None' },
      ...Object.entries(globalThis.CONFIG?.Wall?.doorSounds || {}).map(([value, config]) => ({
        value, label: localize(config.label ?? value)
      }))
    ] }
  ];
}
