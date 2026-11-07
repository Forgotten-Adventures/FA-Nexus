export const PATREON_AUTH_POLL_INTERVAL_MS = 3000;
export const PATREON_AUTH_POLL_START_DELAY_MS = 3000;
export const PATREON_AUTH_MAX_POLL_ATTEMPTS = 20;
export const PATREON_AUTH_ACCESS_GRACE_ATTEMPTS = 5;

const PATREON_AUTH_TIMEOUT_MESSAGE = 'Patreon authentication timed out. Start a new attempt.';

function normalizedProviderError(errorPayload) {
  if (!errorPayload || typeof errorPayload !== 'object') return '';
  return [
    errorPayload.code,
    errorPayload.errorCode,
    errorPayload.error,
    errorPayload.message
  ]
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function isExplicitProviderCancellation(errorPayload) {
  return /\b(access_denied|cancelled|canceled|denied_by_user|user_denied)\b/.test(
    normalizedProviderError(errorPayload)
  );
}

function timeoutResult() {
  return {
    terminal: true,
    message: PATREON_AUTH_TIMEOUT_MESSAGE
  };
}

export function buildPatreonPollingProgress(
  pollAttempt,
  maxPollAttempts = PATREON_AUTH_MAX_POLL_ATTEMPTS
) {
  const maximum = Math.max(1, Number(maxPollAttempts) || PATREON_AUTH_MAX_POLL_ATTEMPTS);
  const attempt = Math.max(1, Math.min(maximum, Number(pollAttempt) || 1));
  return {
    statusText: `Checking Patreon authorization… attempt ${attempt} of ${maximum}.`
  };
}

export function classifyPatreonPollingFailure({
  httpStatus,
  errorPayload = null,
  pollAttempt,
  maxPollAttempts = PATREON_AUTH_MAX_POLL_ATTEMPTS,
  accessGraceAttempts = PATREON_AUTH_ACCESS_GRACE_ATTEMPTS
} = {}) {
  const status = Number(httpStatus);
  const attempt = Math.max(1, Number(pollAttempt) || 1);
  const maximum = Math.max(1, Number(maxPollAttempts) || PATREON_AUTH_MAX_POLL_ATTEMPTS);
  const graceAttempts = Math.max(0, Number(accessGraceAttempts) || 0);

  if (status === 400) {
    if (isExplicitProviderCancellation(errorPayload)) {
      return {
        terminal: true,
        message: 'Patreon authorization was cancelled. Start a new attempt.'
      };
    }
    return attempt >= maximum ? timeoutResult() : { terminal: false, message: null };
  }

  if (status === 401) {
    if (attempt <= graceAttempts) return { terminal: false, message: null };
    return {
      terminal: true,
      message: 'This Patreon account does not provide the required access.'
    };
  }

  if (status === 404) {
    return attempt >= maximum ? timeoutResult() : { terminal: false, message: null };
  }

  return {
    terminal: true,
    message: `Patreon authentication request failed with HTTP ${status}.`
  };
}
