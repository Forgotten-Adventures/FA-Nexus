export function hasPremiumAuth({ moduleId = 'fa-nexus' } = {}) {
  try {
    const auth = game?.settings?.get?.(moduleId, 'patreon_auth_data');
    return !!(auth && auth.authenticated && auth.state);
  } catch (_) {
    return false;
  }
}

export function isPremiumAuthFailure(error) {
  if (!error) return false;
  const code = String(error?.code || error?.name || '').toUpperCase();
  if (code && (/AUTH/.test(code) || ['STATE_MISSING', 'ENTITLEMENT_REQUIRED', 'HTTP_401', 'HTTP_403', 'SESSION_EXPIRED', 'STATE_INVALID'].includes(code))) {
    return true;
  }
  const message = String(error?.message || '').toLowerCase();
  return message.includes('auth') || message.includes('state');
}
