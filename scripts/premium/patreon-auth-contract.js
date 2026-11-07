export const PATREON_AUTH_CHECK_URL = 'https://n8n.forgotten-adventures.net/webhook/foundry-auth-check';
export const MAIN_PATREON_SOURCE_ID = 'patreon:main';
export const BATTLEMAPS_PATREON_SOURCE_ID = 'patreon:battlemaps';

export const VIP_SOURCE_IDS = Object.freeze({
  assets: 'vip:assets',
  tokens: 'vip:tokens',
  battlemaps: 'vip:battlemaps'
});

const CONTENT_PRODUCT_LABELS = Object.freeze({
  assets: 'Assets',
  tokens: 'Tokens',
  battlemaps: 'Battlemaps'
});

const CONTENT_PRODUCT_ORDER = Object.freeze(['assets', 'tokens', 'battlemaps']);

const CONTENT_SOURCE_RULES = Object.freeze({
  [MAIN_PATREON_SOURCE_ID]: Object.freeze({
    label: 'Main Patreon',
    products: Object.freeze(['assets', 'tokens'])
  }),
  [BATTLEMAPS_PATREON_SOURCE_ID]: Object.freeze({
    label: 'Battlemaps Patreon',
    products: Object.freeze(['battlemaps'])
  }),
  [VIP_SOURCE_IDS.assets]: Object.freeze({
    label: 'VIP',
    products: Object.freeze(['assets'])
  }),
  [VIP_SOURCE_IDS.tokens]: Object.freeze({
    label: 'VIP',
    products: Object.freeze(['tokens'])
  }),
  [VIP_SOURCE_IDS.battlemaps]: Object.freeze({
    label: 'VIP',
    products: Object.freeze(['battlemaps'])
  })
});

// Premium content needs a paid Patreon tier (2026-10-26 split: Premium and up). The client does not list the paid
// tier names, so a tier added later on the server still unlocks: any named tier other than these counts.
const NON_ACCESS_TIERS = new Set(['unknown', 'unknown tier', 'none', 'not linked', 'inactive', 'free', 'free member', 'free tier']);
// A Patreon row grants only while the membership is active. Declined payments are Patreon's grace period: the
// cards stay unlocked and the download server decides (a refusal there keeps the member signed in).
const PATREON_ACCESS_STATUSES = new Set(['active', 'active_patron', 'declined', 'declined_patron']);
// VIP rows are granted by hand and may carry no status; only an explicit end status removes them.
const NON_ACCESS_STATUSES = new Set(['inactive', 'canceled', 'cancelled', 'expired', 'failed', 'former', 'former_patron', 'free']);

const PREMIUM_ENTITLEMENT_LABELS = Object.freeze([
  ['texture.edit', 'Texture Painter'],
  ['path.edit', 'Paths'],
  ['building.edit', 'Building Tool']
]);

export class PatreonAuthContractError extends Error {
  constructor(code, message) {
    super(message || 'The authentication response was invalid.');
    this.name = 'PatreonAuthContractError';
    this.code = code;
  }
}

function normalizeOptionalText(value) {
  if (value == null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text || null;
}

function normalizeAccessSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PatreonAuthContractError('ACCESS_SOURCES_MALFORMED');
  }
  if (typeof value.source !== 'string') {
    throw new PatreonAuthContractError('ACCESS_SOURCES_MALFORMED');
  }
  const source = normalizeOptionalText(value.source);
  if (!source) throw new PatreonAuthContractError('ACCESS_SOURCES_MALFORMED');
  return {
    source,
    tier: normalizeOptionalText(value.tier),
    tierName: normalizeOptionalText(value.tier_name),
    tierId: normalizeOptionalText(value.tier_id),
    status: normalizeOptionalText(value.status),
    subPrice: normalizeOptionalText(value.sub_price),
    lastChargeStatus: normalizeOptionalText(value.last_charge_status),
    lastChargeDate: normalizeOptionalText(value.last_charge_date)
  };
}

function unwrapResponse(payload) {
  if (Array.isArray(payload)) {
    if (payload.length !== 1) {
      throw new PatreonAuthContractError('AUTH_RESPONSE_MALFORMED');
    }
    return payload[0];
  }
  return payload;
}

function getAccessSourceTier(source) {
  return normalizeOptionalText(source?.tierName) || normalizeOptionalText(source?.tier);
}

function isUsableAccessSource(source) {
  const tier = getAccessSourceTier(source);
  if (!tier || NON_ACCESS_TIERS.has(tier.toLowerCase())) return false;
  const status = normalizeOptionalText(source?.status)?.toLowerCase();
  if (String(source?.source || '').startsWith('vip:')) return !status || !NON_ACCESS_STATUSES.has(status);
  return !!status && PATREON_ACCESS_STATUSES.has(status);
}

export function normalizeFoundryAuthCheckResponse(payload, { expectedState } = {}) {
  const response = unwrapResponse(payload);
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new PatreonAuthContractError('AUTH_RESPONSE_MALFORMED');
  }
  if (response.schema_version !== 2) {
    throw new PatreonAuthContractError('AUTH_SCHEMA_UNSUPPORTED', 'The authentication response version is not supported.');
  }
  if (response.ok !== true) {
    throw new PatreonAuthContractError('AUTH_CHECK_FAILED', 'Authentication was not completed.');
  }
  if (response.linked !== true) {
    throw new PatreonAuthContractError('AUTH_NOT_LINKED', 'No Patreon account was linked.');
  }

  const state = normalizeOptionalText(response.state);
  if (!state || (expectedState && state !== expectedState)) {
    throw new PatreonAuthContractError('AUTH_STATE_MISMATCH', 'The authentication response did not match this request.');
  }
  if (!Array.isArray(response.access_sources)) {
    throw new PatreonAuthContractError('ACCESS_SOURCES_MALFORMED');
  }

  return {
    schemaVersion: Number.isInteger(response.schema_version) ? response.schema_version : null,
    checkedAt: normalizeOptionalText(response.checked_at),
    linked: true,
    state,
    accessSources: response.access_sources.map(normalizeAccessSource)
  };
}

export function findAccessSource(authData, sourceId) {
  const sources = Array.isArray(authData?.accessSources) ? authData.accessSources : [];
  const matches = sources.filter((entry) => entry?.source === sourceId);
  const active = matches.find((entry) => String(entry?.status || '').toLowerCase() === 'active');
  if (active) return active;
  const usable = matches.find(isUsableAccessSource);
  if (usable) return usable;
  if (matches.length) return matches[0];

  // Stored auth data from versions before the multi-source contract remains
  // displayable during the migration. It never grants an entitlement.
  if (authData?.source === sourceId) {
    return {
      source: sourceId,
      tier: normalizeOptionalText(authData.tier),
      tierName: null,
      tierId: null,
      status: null,
      subPrice: null,
      lastChargeStatus: null,
      lastChargeDate: null
    };
  }
  return null;
}

export function evaluateContentAccess(authData) {
  const products = new Set();
  const grants = [];
  const usableVipSourceIds = Object.values(VIP_SOURCE_IDS).filter((sourceId) => {
    const source = findAccessSource(authData, sourceId);
    return source && isUsableAccessSource(source);
  });
  const sourceRules = usableVipSourceIds.length
    ? Object.entries(CONTENT_SOURCE_RULES).filter(([sourceId]) => sourceId.startsWith('vip:'))
    : Object.entries(CONTENT_SOURCE_RULES).filter(([sourceId]) => sourceId.startsWith('patreon:'));

  for (const [sourceId, rule] of sourceRules) {
    const source = findAccessSource(authData, sourceId);
    if (!source || !isUsableAccessSource(source)) continue;
    const tier = sourceId.startsWith('vip:') ? 'VIP' : getAccessSourceTier(source);
    for (const product of rule.products) products.add(product);
    grants.push({
      source: sourceId,
      label: rule.label,
      tier,
      products: [...rule.products]
    });
  }

  return {
    products: CONTENT_PRODUCT_ORDER.filter((product) => products.has(product)),
    grants,
    premiumEditorAccess: grants.some((grant) => grant.source === VIP_SOURCE_IDS.assets)
  };
}

/**
 * Whether premium cards of a content product ('assets' or 'tokens') unlock for this stored Patreon login. Signed
 * out: no. Auth data stored before the multi-source contract (no access_sources) cannot be judged here, so the cards
 * stay unlocked and the download server decides; the hover asks for a reconnect.
 */
export function hasContentProductAccess(authData, product) {
  if (!authData?.authenticated || !authData?.state) return false;
  if (!Array.isArray(authData.accessSources)) return true;
  return evaluateContentAccess(authData).products.includes(product);
}

export const PREMIUM_DOWNLOAD_TIER_MESSAGE = "Your Patreon tier doesn't include premium downloads. The Premium or Pro tier unlocks them.";

/** What a click on a locked premium card says: connect first, or the tier lacks premium downloads. */
export function lockedPremiumContentMessage(authData, contentLabel = 'premium assets') {
  if (!authData?.authenticated || !authData?.state) return `Authentication required for ${contentLabel}. Please connect Patreon.`;
  return PREMIUM_DOWNLOAD_TIER_MESSAGE;
}

export function buildPatreonConnectedHoverText(authData, entitlements = {}) {
  const lines = ['Patreon connected'];
  const contentAccess = evaluateContentAccess(authData);
  if (contentAccess.grants.length) {
    const mainPatreon = contentAccess.grants.find((grant) => grant.source === MAIN_PATREON_SOURCE_ID);
    const battlemapsPatreon = contentAccess.grants.find((grant) => grant.source === BATTLEMAPS_PATREON_SOURCE_ID);
    const vipGrants = contentAccess.grants.filter((grant) => grant.source.startsWith('vip:'));
    const sourceLabels = [];
    if (mainPatreon) sourceLabels.push('Main Patreon');
    if (battlemapsPatreon) sourceLabels.push('Battlemaps Patreon');
    if (vipGrants.length) sourceLabels.push('VIP');
    lines.push(`${sourceLabels.length === 1 ? 'Source' : 'Sources'}: ${sourceLabels.join(' + ')}`);

    if (sourceLabels.length === 1) {
      const tier = mainPatreon?.tier || battlemapsPatreon?.tier || vipGrants[0]?.tier;
      if (tier) lines.push(`Tier: ${tier}`);
    } else {
      if (mainPatreon?.tier) lines.push(`Main Patreon tier: ${mainPatreon.tier}`);
      if (battlemapsPatreon?.tier) lines.push(`Battlemaps Patreon tier: ${battlemapsPatreon.tier}`);
      if (vipGrants.length) {
        const vipTiers = [...new Set(vipGrants.map((grant) => grant.tier).filter(Boolean))];
        if (vipTiers.length) lines.push(`VIP tier: ${vipTiers.join(', ')}`);
      }
    }

    const contentLabels = contentAccess.products.map((product) => CONTENT_PRODUCT_LABELS[product]);
    lines.push(`Content: ${contentLabels.join(' + ')}`);
  } else if (!Array.isArray(authData?.accessSources) && (authData?.source || authData?.tier)) {
    lines.push('Source details: Reconnect to refresh');
    const legacyTier = normalizeOptionalText(authData?.tier);
    if (legacyTier) lines.push(`Tier: ${legacyTier}`);
  } else {
    lines.push('Recognized content access: None');
  }

  const entitlementLabels = contentAccess.premiumEditorAccess || entitlements?.['premium.all'] === true
    ? ['All Pro tools']
    : PREMIUM_ENTITLEMENT_LABELS
      .filter(([key]) => entitlements?.[key] === true)
      .map(([, label]) => label);
  if (entitlementLabels.length) {
    lines.push(`Pro tools: ${entitlementLabels.join(', ')}`);
  }

  lines.push('Click to disconnect');
  return lines.join('\n');
}
