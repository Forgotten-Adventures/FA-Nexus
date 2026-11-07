const PUBLIC_R2_BASE_URL = 'https://r2-public.forgotten-adventures.net';

export const CONTENT_KIND_DESCRIPTORS = Object.freeze({
  tokens: Object.freeze({
    kind: 'tokens',
    dbName: 'fa-nexus-cloud-tokens-v2',
    updateEndpointPath: 'foundry-nexus-tokens-update-v2',
    downloadEndpointPath: 'foundry-nexus-download-v2',
    downloadQueryParam: 'token_path',
    thumbnailBaseUrl: `${PUBLIC_R2_BASE_URL}/tokens/thumbnails`,
    freeBaseUrl: `${PUBLIC_R2_BASE_URL}/tokens/free_tokens`,
    downloadDirSetting: 'cloudDownloadDirTokens',
    downloadDirDefault: 'fa-nexus/tokens',
    legacyDownloadDir: 'fa-nexus-tokens'
  }),
  assets: Object.freeze({
    kind: 'assets',
    dbName: 'fa-nexus-cloud-assets-v2',
    updateEndpointPath: 'foundry-nexus-assets-update-v2',
    downloadEndpointPath: 'foundry-nexus-download-v2',
    downloadQueryParam: 'asset_path',
    thumbnailBaseUrl: `${PUBLIC_R2_BASE_URL}/assets/thumbnails`,
    freeBaseUrl: `${PUBLIC_R2_BASE_URL}/assets/free_assets`,
    downloadDirSetting: 'cloudDownloadDirAssets',
    downloadDirDefault: 'fa-nexus/assets',
    legacyDownloadDir: 'fa-nexus-assets'
  })
});

/**
 * Resolve the descriptor for a cloud content kind.
 * @param {'tokens'|'assets'} kind
 * @returns {Readonly<{
 *   kind: 'tokens'|'assets',
 *   dbName: string,
 *   updateEndpointPath: string,
 *   downloadEndpointPath: string,
 *   downloadQueryParam: string,
 *   thumbnailBaseUrl: string,
 *   freeBaseUrl: string,
 *   downloadDirSetting: string,
 *   downloadDirDefault: string
 * }>}
 */
export function getContentKindDescriptor(kind) {
  if (!Object.prototype.hasOwnProperty.call(CONTENT_KIND_DESCRIPTORS, kind)) {
    throw new Error(`Unknown FA Nexus content kind: ${String(kind || '')}`);
  }
  return CONTENT_KIND_DESCRIPTORS[kind];
}

/**
 * Encode cloud file paths while preserving folder separators.
 * @param {string} filePath
 * @returns {string}
 */
export function encodeCloudPath(filePath) {
  return String(filePath || '').split('/').map(encodeURIComponent).join('/');
}

/**
 * Build the public R2 URL for a content kind path.
 * @param {'tokens'|'assets'} kind
 * @param {'thumbnail'|'free'} urlKind
 * @param {string} filePath
 * @returns {string}
 */
export function buildContentKindPublicUrl(kind, urlKind, filePath) {
  const descriptor = getContentKindDescriptor(kind);
  let baseUrl;
  if (urlKind === 'thumbnail') baseUrl = descriptor.thumbnailBaseUrl;
  else if (urlKind === 'free') baseUrl = descriptor.freeBaseUrl;
  else throw new Error(`Unknown FA Nexus public URL kind: ${String(urlKind || '')}`);
  return `${baseUrl}/${encodeCloudPath(filePath)}`;
}
