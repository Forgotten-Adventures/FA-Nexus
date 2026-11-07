import { NexusLogger as Logger } from '../../core/nexus-logger.js';

function stringifyError(error) {
  return String(error?.message || error);
}

export function callRequiredHostMethod({
  host = null,
  methodName,
  args = [],
  logger = Logger,
  loggerPrefix = 'PremiumSessionBundle',
  logScope = 'host',
  hostLabel = 'public host'
} = {}) {
  const method = host?.[methodName];
  if (typeof method !== 'function') {
    logger?.error?.(`${loggerPrefix}.${logScope}.methodMissing`, { methodName });
    throw new Error(`Installed ${hostLabel} does not support ${methodName}().`);
  }
  try {
    return method.apply(host, Array.isArray(args) ? args : []);
  } catch (error) {
    logger?.error?.(`${loggerPrefix}.${logScope}.failed`, {
      methodName,
      error: stringifyError(error)
    });
    throw error;
  }
}
