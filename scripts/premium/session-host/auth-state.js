export function hasPremiumAuth({ moduleId = 'fa-nexus' } = {}) {
  try {
    const auth = game?.settings?.get?.(moduleId, 'patreon_auth_data');
    return !!(auth && auth.authenticated && auth.state);
  } catch (_) {
    return false;
  }
}

// The one authority for "the Patreon login itself is gone". Since the 2026-10-26 Premium/Pro tier split the n8n
// endpoints answer a tier that lacks access with HTTP 401 (downloads: "Invalid access level"; tools:
// PRO_TIER_REQUIRED) and a missing or non-premium file with 403. Neither means the login expired, and signing the
// user out for them sent every member without a qualifying tier round a reconnect loop. The only expired-login signs
// are a missing local state and the 400 "Invalid State or IP mismatch" answer.
const EXPIRED_LOGIN_CODES = new Set(['STATE_MISSING', 'STATE_INVALID', 'INVALID_STATE', 'SESSION_EXPIRED', 'AUTH_STATE_MISMATCH']);
const STATE_MISMATCH_TEXT = /invalid state|ip mismatch|state (?:mismatch|invalid|expired)/i;

/** True for a 400 answer whose text says the stored Patreon state is invalid or bound to another IP. */
export function isStateMismatchResponse(status, ...texts) {
  return Number(status) === 400 && STATE_MISMATCH_TEXT.test(texts.filter(Boolean).join(' '));
}

/** True only when the error says the Patreon login has expired or is missing, so disconnecting is right. */
export function isPremiumAuthFailure(error) {
  if (!error) return false;
  const code = String(error?.code || '').toUpperCase();
  if (EXPIRED_LOGIN_CODES.has(code)) return true;
  const status = Number(error?.status ?? error?.details?.status);
  return isStateMismatchResponse(code === 'HTTP_400' ? 400 : status,
    error?.message, error?.details?.message, error?.details?.error);
}

/**
 * True when the account is signed in but its tier does not include the Pro tools: the entitlement endpoint's
 * PRO_TIER_REQUIRED refusal, or a successful answer that leaves the tool's key out (ENTITLEMENT_REQUIRED).
 */
export function isProTierRefusal(error) {
  const code = String(error?.code || '').toUpperCase();
  return code === 'PRO_TIER_REQUIRED' || code === 'ENTITLEMENT_REQUIRED';
}

export const PRO_TIER_UPGRADE_URL = 'https://www.patreon.com/forgottenadventures/membership';

/** The message for a signed-in member whose tier does not include a Pro tool. */
export function proTierMessage(label = 'This tool') {
  return `${label} is a Pro tool, and your Patreon tier doesn't include the Pro tools. The Pro tier unlocks them.`;
}
