import { NexusLogger as Logger } from '../../core/nexus-logger.js';
import { callRequiredDelegateMethod } from './delegate-methods.js';

const COMMON_METHODS = Object.freeze([
  'getPreviewLayerHostState',
  'applyLaunchPlacementAnchorTileId',
  'syncPreviewRenderSort',
  'applyCurrentPreviewLayerOrdering',
  'applyLayerManagerPreviewPlacement'
]);

export const HOSTED_PREVIEW_PLACEMENT_ADAPTER_METHODS = Object.freeze({
  texture: COMMON_METHODS,
  path: Object.freeze([
    ...COMMON_METHODS,
    'applyPathPreviewPlacementMetadata',
    'selectLayerManagerPreview'
  ]),
  building: Object.freeze([
    ...COMMON_METHODS,
    'canApplyLayerManagerPreviewLevel',
    'refreshLayerManagerPreviewPlacement',
    'selectLayerManagerPreview'
  ])
});

function resolveAdapterKind(adapterKind) {
  return String(adapterKind || '').trim();
}

export function getHostedPreviewPlacementAdapterMethods(adapterKind) {
  const kind = resolveAdapterKind(adapterKind);
  const methods = HOSTED_PREVIEW_PLACEMENT_ADAPTER_METHODS[kind];
  if (!methods) {
    throw new Error(`Unknown hosted preview-placement adapter kind "${kind}".`);
  }
  return methods;
}

export function callRequiredPreviewPlacementAdapterMethod({
  delegate = null,
  adapterKind,
  methodName,
  args = [],
  logger = Logger,
  loggerPrefix = 'PremiumSessionHost',
  bundleLabel = 'premium feature'
} = {}) {
  const kind = resolveAdapterKind(adapterKind);
  const methods = getHostedPreviewPlacementAdapterMethods(kind);
  if (!methods.includes(methodName)) {
    logger?.error?.(`${loggerPrefix}.previewPlacement.contractMethodUnknown`, {
      adapterKind: kind,
      methodName
    });
    throw new Error(`Hosted preview-placement ${kind} adapter does not define ${methodName}().`);
  }
  return callRequiredDelegateMethod({
    delegate,
    methodName,
    args,
    loggerPrefix,
    logScope: 'previewPlacement',
    bundleLabel
  });
}
