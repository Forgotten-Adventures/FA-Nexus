import { NexusLogger as Logger } from '../../core/nexus-logger.js';

export function callRequiredDelegateMethod({
  delegate = null,
  methodName,
  args = [],
  loggerPrefix = 'PremiumSessionHost',
  logScope = 'delegate',
  bundleLabel = 'premium feature'
} = {}) {
  const method = delegate?.[methodName];
  if (typeof method !== 'function') {
    Logger.error?.(`${loggerPrefix}.${logScope}.methodMissing`, { methodName });
    throw new Error(`Installed ${bundleLabel} bundle does not support ${methodName}().`);
  }
  return method.apply(delegate, Array.isArray(args) ? args : []);
}
