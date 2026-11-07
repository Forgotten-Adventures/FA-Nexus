export const PREMIUM_RUNTIME_ADAPTER_ID = 'fa-nexus.premium-runtime-adapter';
export const PREMIUM_RUNTIME_ADAPTER_VERSION = 1;

function normalizeCapabilityNames(values) {
  const source = Array.isArray(values) ? values : [];
  return Array.from(new Set(source.map((value) => String(value || '').trim()).filter(Boolean)));
}

function featureLabel(featureId) {
  return String(featureId || '').trim() || 'unknown premium feature';
}

export function createPremiumRuntimeAdapter({ capabilities = {} } = {}) {
  const normalizedCapabilities = {};
  for (const [name, capability] of Object.entries(capabilities || {})) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) continue;
    if (typeof capability !== 'function') {
      throw new TypeError(`Premium Runtime Adapter capability ${normalizedName} must be a function.`);
    }
    normalizedCapabilities[normalizedName] = capability;
  }
  return Object.freeze({
    id: PREMIUM_RUNTIME_ADAPTER_ID,
    version: PREMIUM_RUNTIME_ADAPTER_VERSION,
    capabilities: Object.freeze(normalizedCapabilities)
  });
}

export function validatePremiumRuntimeAdapter({
  adapter,
  featureId,
  requiredCapabilities = []
} = {}) {
  const label = featureLabel(featureId);
  if (!adapter || adapter.id !== PREMIUM_RUNTIME_ADAPTER_ID) {
    throw new Error(`${label} requires the ${PREMIUM_RUNTIME_ADAPTER_ID} host contract.`);
  }
  if (Number(adapter.version) !== PREMIUM_RUNTIME_ADAPTER_VERSION) {
    throw new Error(`${label} requires Premium Runtime Adapter version ${PREMIUM_RUNTIME_ADAPTER_VERSION}; received ${adapter.version ?? 'missing'}.`);
  }
  const required = normalizeCapabilityNames(requiredCapabilities);
  const missing = required.filter((name) => typeof adapter.capabilities?.[name] !== 'function');
  if (missing.length) {
    throw new Error(`${label} requires missing Premium Runtime Adapter capabilities: ${missing.join(', ')}.`);
  }
  return adapter;
}

export function scopePremiumRuntimeAdapter({ adapter, featureId, capabilityNames = [] } = {}) {
  const names = normalizeCapabilityNames(capabilityNames);
  const validatedAdapter = validatePremiumRuntimeAdapter({
    adapter,
    featureId,
    requiredCapabilities: names
  });
  const capabilities = {};
  for (const name of names) capabilities[name] = validatedAdapter.capabilities[name];
  return createPremiumRuntimeAdapter({ capabilities });
}

export function attachPremiumSessionHost({
  delegate,
  host,
  adapter,
  featureId,
  requiredCapabilities = [],
  exposedCapabilities = null,
  beforeAttach = null
} = {}) {
  const validatedAdapter = validatePremiumRuntimeAdapter({ adapter, featureId, requiredCapabilities });
  if (typeof delegate?.attachHost !== 'function') {
    throw new Error(`${featureLabel(featureId)} bundle does not support attachHost().`);
  }
  if (typeof beforeAttach === 'function') beforeAttach(delegate);
  const attachmentAdapter = Array.isArray(exposedCapabilities)
    ? scopePremiumRuntimeAdapter({ adapter: validatedAdapter, featureId, capabilityNames: exposedCapabilities })
    : validatedAdapter;
  delegate.attachHost(host, attachmentAdapter);
  return delegate;
}
