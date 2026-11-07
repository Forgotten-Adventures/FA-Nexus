function parseActivePremiumBundleVersion(bundleId, fileName) {
  const prefix = `${bundleId}-`;
  const suffix = '.js';
  const value = String(fileName || '').trim();
  if (value.includes('/') || value.includes('\\') || !value.startsWith(prefix) || !value.endsWith(suffix)) {
    throw new Error(`Invalid active premium bundle file for ${bundleId}: ${fileName}`);
  }
  const version = value.slice(prefix.length, -suffix.length).trim();
  if (!version) throw new Error(`Missing active premium bundle version for ${bundleId}: ${fileName}`);
  return version;
}

const ACTIVE_PREMIUM_BUNDLE_SPECS = Object.freeze([
  Object.freeze({
    featureId: 'texture.paint',
    entitlementKey: 'texture.edit',
    bundleId: 'texture-editor',
    fileName: 'texture-editor-0.6.2.js',
    factoryExport: 'createTexturePaintManager',
    factoryLabel: 'texture'
  }),
  Object.freeze({
    featureId: 'path.edit.v2',
    entitlementKey: 'path.edit',
    bundleId: 'path-editor-v2',
    fileName: 'path-editor-v2-0.6.2.js',
    factoryExport: 'createPathManagerV2',
    factoryLabel: 'path v2'
  }),
  Object.freeze({
    featureId: 'building.edit',
    entitlementKey: 'building.edit',
    bundleId: 'building-editor-v2',
    fileName: 'building-editor-v2-0.6.2.js',
    factoryExport: 'createBuildingManager',
    factoryLabel: 'building'
  })
]);

export const ACTIVE_PREMIUM_BUNDLES = Object.freeze(
  ACTIVE_PREMIUM_BUNDLE_SPECS.map((spec) => Object.freeze({
    ...spec,
    version: parseActivePremiumBundleVersion(spec.bundleId, spec.fileName)
  }))
);

export const ACTIVE_PREMIUM_ENTITLEMENTS = Object.freeze(Object.fromEntries(
  ACTIVE_PREMIUM_BUNDLES.map(({ entitlementKey }) => [entitlementKey, true])
));

export function getActivePremiumBundle(bundleId) {
  return ACTIVE_PREMIUM_BUNDLES.find((bundle) => bundle.bundleId === bundleId) || null;
}
