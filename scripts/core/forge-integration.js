/**
 * ForgeIntegrationService (FA Nexus)
 * Handles Forge-specific behaviors:
 *  - Environment detection and lazy initialization
 *  - Forge account/bucket discovery
 *  - FilePicker source/bucket option helpers
 *  - Cache URL optimization for assistant GM flows
 */

import { NexusLogger as Logger } from './nexus-logger.js';

const MODULE_ID = 'fa-nexus';
const LOGGER_TAG = 'ForgeIntegration';

const DEBUG_CACHE = new Map();

function logDebugOnce(label, detail) {
  try {
    if (typeof Logger?._isEnabled === 'function' && Logger._isEnabled() !== true) {
      Logger.debug(label, detail);
      return;
    }
    const serialized = detail === undefined ? '__undefined__' : JSON.stringify(detail ?? null);
    const cached = DEBUG_CACHE.get(label);
    if (cached === serialized) return;
    DEBUG_CACHE.set(label, serialized);
  } catch (_) {
    // Ignore serialization issues and fall back to raw logging
  }
  Logger.debug(label, detail);
}

function sanitizeBucketOptions(options) {
  if (!options || typeof options !== 'object') return options;
  const sanitized = Object.assign({}, options);
  if (typeof sanitized.apiKey === 'string') sanitized.apiKey = '[redacted]';
  if (typeof sanitized.jwt === 'string') sanitized.jwt = '[redacted]';
  return sanitized;
}

function sanitizeBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return bucket;
  const sanitized = Object.assign({}, bucket);
  if (typeof sanitized.jwt === 'string') sanitized.jwt = '[redacted]';
  return sanitized;
}

export class ForgeIntegrationService {
  constructor() {
    this.forgeAccountId = null;
    this.isInitialized = false;
    this.initializationPromise = null;
    this.isForgeDetected = null;
  }

  /** Lightweight runtime check with memoization */
  isRunningOnForge() {
    if (this.isForgeDetected !== null) return this.isForgeDetected;
    this.isForgeDetected = ForgeIntegrationService.isRunningOnForge();
    return this.isForgeDetected;
  }

  /** Static detection helper to avoid instantiating when not needed */
  static isRunningOnForge() {
    try {
      const { hostname } = globalThis.window?.location || {};
      if (typeof hostname === 'string' && (hostname.includes('forge-vtt.com') || hostname.includes('forgevtt.com'))) {
        return true;
      }
    } catch (_) {}
    try {
      if (globalThis.ForgeVTT?.usingTheForge) return true;
    } catch (_) {}
    return false;
  }

  /**
   * Ensure Forge integration is initialized (safe to call repeatedly).
   * @returns {Promise<boolean>}
   */
  async initialize() {
    if (this.isInitialized || !this.isRunningOnForge()) return this.isInitialized;
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = this._initializeForgeData().catch((error) => {
      Logger.error(`${LOGGER_TAG}.initialize failed`, error);
      return false;
    }).finally(() => {
      this.initializationPromise = null;
    });
    const result = await this.initializationPromise;
    if (result) this.isInitialized = true;
    return result;
  }

  async _initializeForgeData() {
    try {
      // Ensure ForgeAPI status is available (important for assistant GMs)
      if (!globalThis.ForgeAPI?.lastStatus) {
        try {
          await globalThis.ForgeAPI?.status();
        } catch (error) {
          Logger.warn(`${LOGGER_TAG}._initializeForgeData ForgeAPI.status failed`, error);
        }
      }

      const accountDetected = await this._detectForgeAccountId();
      if (globalThis.ForgeAPI?.lastStatus) {
        await this.updateForgeBucketChoices();
      }
      if (accountDetected) this.isInitialized = true;
      Logger.debug(`${LOGGER_TAG}._initializeForgeData`, { accountDetected, forgeAccountId: this.forgeAccountId });
      return accountDetected;
    } catch (error) {
      Logger.error(`${LOGGER_TAG}._initializeForgeData error`, error);
      return false;
    }
  }

  async _detectForgeAccountId() {
    const iconPath = 'modules/fa-nexus/images/cropped-FA-Icon-Plain-v2.png';
    try {
      const response = await fetch(iconPath, { method: 'HEAD', redirect: 'follow' });
      const finalURL = response.url;
      const match = finalURL?.match(/assets\.forge-vtt\.com\/([^/]+)\//);
      if (match && match[1]) {
        this.forgeAccountId = match[1];
        Logger.info(`${LOGGER_TAG}._detectForgeAccountId`, { forgeAccountId: this.forgeAccountId });
        return true;
      }
      Logger.warn(`${LOGGER_TAG}._detectForgeAccountId account ID not found`, { finalURL });
      return false;
    } catch (error) {
      Logger.warn(`${LOGGER_TAG}._detectForgeAccountId failed`, error);
      return false;
    }
  }

  /** Return current FilePicker source for local storage operations */
  getStorageTarget() {
    if (!this.isRunningOnForge()) return 'data';
    const bucket = this.detectCurrentForgeBucket();
    logDebugOnce(`${LOGGER_TAG}.getStorageTarget`, { runningOnForge: true, bucket });
    return bucket !== null && bucket !== undefined ? 'forgevtt' : 'data';
  }

  /** Determine whether the Foundry runtime exposes a Forge storage source */
  hasForgeStorage() {
    if (!this.isRunningOnForge()) return false;
    try {
      const storages = game?.data?.files?.storages;
      if (Array.isArray(storages)) return storages.includes('forgevtt');
      if (storages && typeof storages === 'object') return Boolean(storages.forgevtt);
    } catch (error) {
      Logger.debug(`${LOGGER_TAG}.hasForgeStorage error`, error);
    }
    return false;
  }

  /**
   * Normalize a FilePicker target for a given source by stripping redundant prefixes.
   * @param {string} source
   * @param {string} target
   * @returns {string}
   */
  normalizeFilePickerTarget(source, target) {
    if (!target) return '';
    let result = String(target).trim();
    if (!result) return '';
    const lowerSource = String(source || '').toLowerCase();
    const stripPrefixes = (value, prefixes) => {
      let next = value;
      for (const prefix of prefixes) {
        const re = new RegExp(`^${prefix}[:/]+`, 'i');
        if (re.test(next)) {
          next = next.replace(re, '');
        }
      }
      return next;
    };
    if (lowerSource === 'forge-bazaar' || lowerSource === 'bazaar') {
      result = stripPrefixes(result, ['forge-bazaar', 'bazaar']);
    } else if (lowerSource === 'forgevtt') {
      result = stripPrefixes(result, ['forgevtt']);
    } else if (lowerSource === 'data' || lowerSource === 'public' || lowerSource === 's3') {
      result = stripPrefixes(result, [lowerSource]);
    }
    while (result.startsWith('/')) result = result.slice(1);
    return result;
  }

  /**
   * Resolve FilePicker browsing context (source, target, options) for a stored folder string.
   * Handles Forge assets, Bazaar paths, and explicit source prefixes.
   * @param {string} folder
   * @returns {{source:string,target:string,options:object,fallbacks:string[]}}
   */
  resolveFilePickerContext(folder) {
    const fallback = this.getFilePickerContext();
    const defaultSource = fallback?.source || (this.isRunningOnForge() ? 'forgevtt' : 'data');
    const defaultOptions = Object.assign({}, fallback?.options || {});
    const fallbacks = [];

    if (!folder || typeof folder !== 'string') {
      return {
        source: defaultSource,
        target: '',
        options: defaultOptions,
        fallbacks
      };
    }

    let source = defaultSource;
    let target = String(folder).trim();
    let options = {};
    const norm = target.toLowerCase();
    const bazaarUrl = norm.match(/^https?:\/\/assets\.forge-vtt\.com\/bazaar\/assets\/(.+)$/i);
    const forgeUrl = norm.match(/^https?:\/\/assets\.forge-vtt\.com\/([^/]+)\/(.+)$/i);
    const prefixMatch = target.match(/^([^:]+):(.*)$/);

    const setForgeOptions = () => {
      options = Object.assign({}, this.getBucketOptions());
      if (source === 'forgevtt' && !fallbacks.includes('data')) fallbacks.push('data');
    };

    if (prefixMatch) {
      const prefix = prefixMatch[1].toLowerCase();
      target = prefixMatch[2];
      if (prefix === 'forge-bazaar' || prefix === 'bazaar') {
        source = 'forge-bazaar';
        options = {};
        if (!fallbacks.includes('bazaar')) fallbacks.push('bazaar');
      } else if (prefix === 'forgevtt') {
        source = 'forgevtt';
        setForgeOptions();
      } else if (prefix === 'data' || prefix === 'public' || prefix === 's3') {
        source = prefix;
        options = {};
      } else {
        Logger.debug(`${LOGGER_TAG}.resolveFilePickerContext unknown prefix`, { prefix, folder });
        source = defaultSource;
        options = defaultOptions;
      }
    } else if (bazaarUrl) {
      source = 'forge-bazaar';
      target = `assets/${bazaarUrl[1]}`;
      options = {};
      if (!fallbacks.includes('bazaar')) fallbacks.push('bazaar');
    } else if (forgeUrl) {
      source = 'forgevtt';
      target = forgeUrl[2];
      setForgeOptions();
    } else {
      source = defaultSource;
      options = defaultOptions;
    }

    if (source === 'forgevtt' && !fallbacks.includes('data')) {
      fallbacks.push('data');
      if (!options || typeof options !== 'object' || !Object.keys(options).length) {
        options = Object.assign({}, this.getBucketOptions());
      }
    }

    const normalizedTarget = this.normalizeFilePickerTarget(source, target);
    Logger.debug(`${LOGGER_TAG}.resolveFilePickerContext`, {
      folder,
      source,
      target: normalizedTarget,
      fallbacks,
      hasOptions: Object.keys(options || {}).length > 0
    });

    return {
      source,
      target: normalizedTarget,
      options,
      fallbacks
    };
  }

  /** Convenience helper returning { source, options } */
  getFilePickerContext() {
    const source = this.getStorageTarget();
    const options = source === 'forgevtt' ? this.getBucketOptions() : {};
    logDebugOnce(`${LOGGER_TAG}.getFilePickerContext`, { source, options: sanitizeBucketOptions(options) });
    return { source, options };
  }

  /** Retrieve Forge bucket options for FilePicker calls */
  getBucketOptions() {
    if (!this.isRunningOnForge()) return {};
    const current = this.detectCurrentForgeBucket();
    if (current === null || current === undefined) return {};
    const numeric = Number(current);
    const bucketValue = Number.isInteger(numeric) ? numeric : current;
    const buckets = this.getForgeVTTBuckets();
    let bucketKey = null;
    if (Number.isInteger(numeric) && buckets[numeric]) bucketKey = buckets[numeric]?.key ?? null;
    else if (typeof current === 'string') {
      const match = buckets.find((b) => b.key === current);
      bucketKey = match?.key ?? null;
    }
    const callOptions = this.getBucketCallOptions(current);
    const options = Object.assign({}, callOptions);
    if (!('bucket' in options)) options.bucket = bucketValue;
    if (bucketKey) options.bucketKey = bucketKey;
    logDebugOnce(`${LOGGER_TAG}.getBucketOptions`, {
      current,
      bucketKey,
      bucketValue,
      options: sanitizeBucketOptions(options)
    });
    return options;
  }

  /**
   * Build API call options for Forge buckets (cookie or JWT auth)
   * @param {string|number} bucketKey
   */
  getBucketCallOptions(bucketKey = null) {
    if (!this.isRunningOnForge()) return {};
    const buckets = this.getForgeVTTBuckets();
    if (!buckets.length) return {};
    let index = null;
    if (typeof bucketKey === 'number' && Number.isInteger(bucketKey) && buckets[bucketKey]) {
      index = bucketKey;
    } else if (typeof bucketKey === 'string') {
      const numeric = Number(bucketKey);
      if (Number.isInteger(numeric) && buckets[numeric]) {
        index = numeric;
      } else {
        index = buckets.findIndex((b) => b.key === bucketKey);
      }
    }
    if (index === null || index < 0 || !buckets[index]) {
      Logger.warn(`${LOGGER_TAG}.getBucketCallOptions unknown bucket`, { bucketKey });
      return {};
    }
    const bucket = buckets[index];
    if (bucket.key === 'my-assets') return { cookieKey: true };
    if (bucket.jwt) return { apiKey: bucket.jwt };
    return {};
  }

  /**
   * Determine preferred Forge bucket (settings-aware).
   * Falls back to first available bucket when preference is missing.
   */
  detectCurrentForgeBucket() {
    try {
      const buckets = this.getForgeVTTBuckets();
      if (!buckets.length) return null;
      const preference = game.settings.get(MODULE_ID, 'preferredForgeBucket');
      const numeric = Number(preference);
      if (Number.isInteger(numeric) && buckets[numeric]) return String(numeric);
      if (preference && typeof preference === 'string') {
        const matchIndex = buckets.findIndex((b) => b.key === preference);
        if (matchIndex >= 0) {
          const normalized = String(matchIndex);
          if (preference !== normalized) {
            try { game.settings.set(MODULE_ID, 'preferredForgeBucket', normalized); } catch (_) {}
          }
          Logger.debug(`${LOGGER_TAG}.detectCurrentForgeBucket`, {
            source: 'preference-key',
            preference,
            resolved: normalized
          });
          return normalized;
        }
      }
      const sharedIndex = buckets.findIndex((b) => typeof b.label === 'string' && b.label.startsWith('Shared Folder'));
      const fallbackIndex = sharedIndex >= 0 ? sharedIndex : 0;
      const fallback = String(Math.max(0, fallbackIndex));
      if (preference !== fallback) {
        try { game.settings.set(MODULE_ID, 'preferredForgeBucket', fallback); } catch (_) {}
      }
      Logger.debug(`${LOGGER_TAG}.detectCurrentForgeBucket`, {
        source: 'fallback',
        fallback,
        sharedIndex
      });
      return fallback;
    } catch (error) {
      Logger.warn(`${LOGGER_TAG}.detectCurrentForgeBucket failed`, error);
      return null;
    }
  }

  /**
   * Gather Forge buckets using ForgeAPI patterns.
   * Returns array of bucket metadata with label/user/jwt/key.
   */
  getForgeVTTBuckets() {
    if (!this.isRunningOnForge()) return [];
    try {
      const status = globalThis.ForgeAPI?.lastStatus || {};
      const buckets = [];
      if (status.user) {
        buckets.push({
          label: 'My Assets Library',
          userId: status.user,
          jwt: null,
          key: 'my-assets'
        });
      }
      try {
        const apiKey = game.settings?.get('forge-vtt', 'apiKey');
        if (apiKey && globalThis.ForgeAPI?.isValidAPIKey?.(apiKey)) {
          const info = globalThis.ForgeAPI._tokenToInfo(apiKey);
          buckets.push({
            label: 'Custom API Key',
            userId: info.id,
            jwt: apiKey,
            key: globalThis.ForgeAPI._tokenToHash(apiKey)
          });
        }
      } catch (_) {}
      for (const sharedKey of status.sharedAPIKeys || []) {
        if (!globalThis.ForgeAPI?.isValidAPIKey?.(sharedKey)) continue;
        const info = globalThis.ForgeAPI._tokenToInfo(sharedKey);
        let name = info.keyName || 'Shared';
        if (name.length > 50) name = `${name.slice(0, 50)}…`;
        const bucket = {
          label: `Shared Folder: ${name}`,
          userId: info.id,
          jwt: sharedKey,
          key: globalThis.ForgeAPI._tokenToHash(sharedKey)
        };
        buckets.push(bucket);
      }
      logDebugOnce(`${LOGGER_TAG}.getForgeVTTBuckets`, buckets.map((bucket) => sanitizeBucket(bucket)));
      return buckets;
    } catch (error) {
      Logger.warn(`${LOGGER_TAG}.getForgeVTTBuckets failed`, error);
      return [];
    }
  }

  /**
   * Update Forge bucket choices for the module setting so the UI reflects real names.
   */
  async updateForgeBucketChoices() {
    if (!this.isRunningOnForge()) return;
    try {
      if (!globalThis.ForgeAPI?.lastStatus) {
        try { await globalThis.ForgeAPI?.status(); } catch (_) {}
      }
      const buckets = this.getForgeVTTBuckets();
      if (!buckets.length) return;
      const choices = {};
      buckets.forEach((bucket, index) => {
        choices[String(index)] = bucket.label || `Bucket ${index + 1}`;
      });
      Logger.debug(`${LOGGER_TAG}.updateForgeBucketChoices`, {
        choiceCount: Object.keys(choices).length,
        labels: Object.values(choices)
      });
      const setting = game.settings.settings.get(`${MODULE_ID}.preferredForgeBucket`);
      if (setting) {
        setting.choices = choices;
      }
    } catch (error) {
      Logger.warn(`${LOGGER_TAG}.updateForgeBucketChoices failed`, error);
    }
  }

  /**
   * Convert cache-local path to Forge asset URL when account ID is known.
   * Avoids double redirects for assistant GM asset usage.
   */
  optimizeCacheURL(cachePath) {
    if (!cachePath || !this.isRunningOnForge() || !this.forgeAccountId) return cachePath;
    if (cachePath.startsWith('https://assets.forge-vtt.com/')) return cachePath;
    return `https://assets.forge-vtt.com/${this.forgeAccountId}/${cachePath.replace(/^\/+/, '')}`;
  }

  /** Ensure setting is registered (call during init) */
  static registerSettings() {
    if (!game?.settings) return;
    if (!ForgeIntegrationService.isRunningOnForge()) return;
    if (game.settings.settings.has(`${MODULE_ID}.preferredForgeBucket`)) return;
    game.settings.register(MODULE_ID, 'preferredForgeBucket', {
      name: 'Preferred Forge Storage Bucket',
      hint: 'Automatically select which Forge storage bucket FA Nexus uses for local scans and downloads.',
      scope: 'world',
      config: true,
      type: String,
      default: '0',
      choices: { '0': 'Auto-detect (First Available)' },
      onChange: (value) => {
        try {
          Logger.info(`${LOGGER_TAG}.preferredForgeBucket changed`, value);
        } catch (_) {}
      }
    });
  }
}

export const forgeIntegration = new ForgeIntegrationService();

// Attempt eager registration on init for immediate availability.
Hooks.once('init', () => {
  try { ForgeIntegrationService.registerSettings(); } catch (error) { Logger.warn(`${LOGGER_TAG}.registerSettings failed`, error); }
});

// Warm up detection after ready when running on Forge.
Hooks.once('ready', async () => {
  try { await forgeIntegration.initialize(); } catch (error) { Logger.warn(`${LOGGER_TAG}.ready initialize failed`, error); }
});
