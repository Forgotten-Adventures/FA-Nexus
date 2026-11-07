import { NexusLogger as Logger } from './nexus-logger.js';

function formatFaNexusCloudEnabledReadError(error) {
  return String(error?.message || error)
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(apiKey|api_key|jwt|token|secret|password|authorization)=([^&\s]+)/gi, '$1=[redacted]');
}

export function readFaNexusCloudEnabledSetting({ setting, warningKey, context = {} } = {}) {
  if (!setting) return true;
  try {
    const value = game.settings.get('fa-nexus', setting);
    return typeof value === 'boolean' ? value : true;
  } catch (error) {
    Logger.warn(warningKey || 'FaNexus.cloudEnabled.readFailed', {
      ...context,
      error: formatFaNexusCloudEnabledReadError(error)
    });
    return false;
  }
}
