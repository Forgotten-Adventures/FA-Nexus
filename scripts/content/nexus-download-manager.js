// NexusDownloadManager — manages downloading cloud files to local Foundry storage
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { forgeIntegration } from '../core/forge-integration.js';
import {
  requireFilePickerMethod,
  wrapOperationalError
} from './nexus-content-service.js';
import {
  appendStoragePath,
  buildTypedPathLookupKey,
  generateNormalizedPathLookupKeys,
  normalizeRelativeStoragePath,
  stripPathQueryAndHash
} from '../storage/path-utils.js';
import { ProgressEmitter } from './nexus-content-service.js';

// Import retry utility
async function retryWithBackoff(fn, {
  maxRetries = 3,
  initialDelay = 1000,
  maxDelay = 30000,
  onRetry,
  signal
} = {}) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (signal?.aborted) {
        throw new DOMException('Operation aborted', 'AbortError');
      }

      return await fn();
    } catch (error) {
      lastError = error;

      if (error?.name === 'AbortError' || signal?.aborted) {
        throw error;
      }

      if (attempt >= maxRetries) {
        break;
      }

      const delay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
      const offlineHint = typeof navigator !== 'undefined' && navigator?.onLine === false;
      Logger.info('DownloadManager.retry', { attempt: attempt + 1, maxRetries, delay, offlineHint, error: String(error?.message || error) });

      try {
        onRetry?.({ attempt: attempt + 1, maxRetries, delay, error });
      } catch (_) {}

      await new Promise(resolve => {
        const timeout = setTimeout(resolve, delay);
        const onAbort = () => {
          clearTimeout(timeout);
          signal?.removeEventListener?.('abort', onAbort);
          resolve();
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
      });

      if (signal?.aborted) {
        throw new DOMException('Operation aborted', 'AbortError');
      }
    }
  }

  throw lastError;
}

/**
 * NexusDownloadManager
 * Manages downloading cloud files into Foundry's local storage and tracks a simple
 * filename-to-path inventory. Ensures only one download per file is active.
 */
export class NexusDownloadManager {
  /** Construct a new download manager */
  constructor(options = {}) {
    this._inflight = new Map(); // key -> Promise<string>
    this._inventory = new Map(); // normalized filename key -> local path
    this._initialized = false;
    // Background scanning control
    this._bgScanActive = false;
    this._bgScanQueued = false;
    this._bgScanDelayMs = 20; // small delay to yield between directory scans
    this._maxIndexEntries = 200000; // soft cap to avoid unbounded memory usage
    this.progressEmitter = options.progressEmitter || new ProgressEmitter();
    this._initializationError = null;
  }

  /**
   * Initialize by ensuring download directories and scanning existing files.
   * Safe to call multiple times; no-op on subsequent calls.
   * @returns {Promise<boolean>}
   */
  async initialize() {
    if (this._initialized) return true;
    try {
      await forgeIntegration.initialize();
      Logger.info('DownloadManager.init:start');
      const tokensStorage = this._getStorage('tokens');
      const assetsStorage = this._getStorage('assets');
      if (tokensStorage.target) await this._ensureDir(tokensStorage.target, tokensStorage);
      if (assetsStorage.target) await this._ensureDir(assetsStorage.target, assetsStorage);
      // Do NOT block startup with a deep scan. Kick off a background indexer instead.
      this._initialized = true;
      const allowScan = !forgeIntegration.isRunningOnForge();
      if (allowScan) {
        this._startBackgroundScan([tokensStorage, assetsStorage]);
      } else {
        Logger.debug('DownloadManager.init:skipScan', { reason: 'forge-environment' });
      }
      Logger.info('DownloadManager.init:done', {
        tokensDir: tokensStorage.storedDir,
        assetsDir: assetsStorage.storedDir,
        tokensSource: tokensStorage.source,
        assetsSource: assetsStorage.source,
        files: this._inventory.size,
        backgroundScan: allowScan
      });
      this._initializationError = null;
      return true;
    } catch (e) {
      this._initializationError = wrapOperationalError(e, {
        code: 'DOWNLOAD_MANAGER_INIT_FAILED',
        source: 'DownloadManager.initialize',
        operation: 'initialize-download-manager',
        userMessage: 'FA Nexus could not initialize local download storage.'
      });
      Logger.error('DownloadManager.init:failed', this._initializationError);
      return false;
    }
  }

  /**
   * Resolve the configured download directory for a content kind
   * @param {'tokens'|'assets'} kind
   * @returns {string}
   * @private
   */
  _getDir(kind) {
    const def = kind === 'tokens' ? 'fa-nexus-tokens' : 'fa-nexus-assets';
    const key = kind === 'tokens' ? 'cloudDownloadDirTokens' : 'cloudDownloadDirAssets';
    try { return game.settings.get('fa-nexus', key) || def; } catch (_) { return def; }
  }

  _getStorage(kind) {
    const storedDir = this._getDir(kind);
    const context = forgeIntegration.resolveFilePickerContext(storedDir);
    const source = context?.source || (forgeIntegration.isRunningOnForge() ? 'forgevtt' : 'data');
    const target = context?.target || '';
    const options = Object.assign({}, context?.options || {});
    const fallbacks = Array.isArray(context?.fallbacks) ? context.fallbacks.slice() : [];
    return {
      kind,
      storedDir,
      source,
      target,
      options,
      fallbacks
    };
  }

  /** Ensure a data directory exists (create if missing) */
  async _ensureDir(dir, context = null) {
    const FilePickerImpl = requireFilePickerMethod('browse', {
      source: 'DownloadManager._ensureDir',
      operation: 'ensure-download-directory',
      folder: dir,
      kind: context?.kind || '',
      userMessage: `FA Nexus could not access the download directory "${dir}" because the Foundry FilePicker runtime is unavailable.`
    });
    const source = context?.source || forgeIntegration.getStorageTarget?.() || (forgeIntegration.isRunningOnForge() ? 'forgevtt' : 'data');
    const options = Object.assign({}, context?.options || {});
    try {
      await FilePickerImpl.browse(source, dir, options);
    } catch (_) {
      Logger.info('DownloadManager.mkdir', { dir });
      requireFilePickerMethod('createDirectory', {
        source: 'DownloadManager._ensureDir',
        operation: 'create-download-directory',
        folder: dir,
        kind: context?.kind || '',
        userMessage: `FA Nexus could not create the download directory "${dir}" because the Foundry FilePicker runtime is unavailable.`
      });
      await FilePickerImpl.createDirectory(source, dir, options);
    }
  }

  /**
   * Recursively scan a directory and populate the filename inventory.
   * Also indexes by the file's relative path from baseDir.
   */
  async _scanDirRecursive(dir, baseDir, context = null) {
    try {
      const FilePickerImpl = foundry.applications.apps.FilePicker.implementation;
      const source = context?.source || forgeIntegration.getStorageTarget?.() || (forgeIntegration.isRunningOnForge() ? 'forgevtt' : 'data');
      const options = Object.assign({}, context?.options || {});
      const res = await FilePickerImpl.browse(source, dir, options);
      Logger.info('DownloadManager.scan', { dir, count: (res.files||[]).length, subdirs: (res.dirs||[]).length });
      for (const filePath of res.files || []) {
        const name = String(filePath.split('/').pop() || '');
        const rel = this._relativePathFromFilePath(filePath, baseDir, name);
        this._registerInventoryEntry(context?.kind, [name, rel], filePath);
      }
      for (const subdir of res.dirs || []) {
        const normalized = this._normalizeBrowseTarget({ source }, subdir);
        await this._scanDirRecursive(normalized, baseDir, { kind: context?.kind, source, options });
      }
    } catch (e) {
      Logger.warn('DownloadManager.scan:failed', { dir, error: String(e?.message||e) });
    }
  }

  /** Start a low-impact, non-blocking background scan to gradually build the index */
  _startBackgroundScan(storages) {
    try {
      if (forgeIntegration.isRunningOnForge()) {
        Logger.debug('DownloadManager.bgScan:skip', { reason: 'forge-environment' });
        return;
      }
      if (this._bgScanActive || this._bgScanQueued) return;
      this._bgScanQueued = true;
      const FilePickerImpl = foundry.applications.apps.FilePicker.implementation;
      const queue = [];
      for (const storage of storages || []) {
        if (!storage?.target) continue;
        queue.push({ storage, dir: storage.target, base: storage.target });
      }
      const step = async () => {
        if (!this._initialized) { this._bgScanQueued = false; this._bgScanActive = false; return; }
        if (this._inventory.size >= this._maxIndexEntries) {
          this._bgScanQueued = false; this._bgScanActive = false;
          Logger.info('DownloadManager.bgScan:stopped:maxIndex', { size: this._inventory.size });
          return;
        }
        const next = queue.shift();
        if (!next) { this._bgScanQueued = false; this._bgScanActive = false; return; }
        this._bgScanActive = true;
        try {
          const source = next.storage?.source || 'data';
          const options = Object.assign({}, next.storage?.options || {});
          const res = await FilePickerImpl.browse(source, next.dir, options);
          for (const filePath of res.files || []) {
            const name = String(filePath.split('/').pop() || '');
            const rel = this._relativePathFromFilePath(filePath, next.base, name);
            this._registerInventoryEntry(next.storage?.kind, [name, rel], filePath);
            if (this._inventory.size >= this._maxIndexEntries) break;
          }
          if (this._inventory.size < this._maxIndexEntries) {
            for (const sub of res.dirs || []) {
              const normalized = this._normalizeBrowseTarget({ source }, sub);
              queue.push({ storage: next.storage, dir: normalized, base: next.base });
            }
          }
        } catch (e) {
          Logger.debug('DownloadManager.bgScan:dirFailed', { dir: next.dir, error: String(e?.message||e) });
        }
        setTimeout(step, this._bgScanDelayMs);
      };
      setTimeout(step, this._bgScanDelayMs);
    } catch (_) { /* noop */ }
  }

  _normalizeBrowseTarget(context, value) {
    const source = context?.source || 'data';
    const str = String(value ?? '').trim();
    if (!str) return '';
    if (/^https?:\/\//i.test(str)) {
      const resolved = forgeIntegration.resolveFilePickerContext(str);
      if (resolved?.target != null && String(resolved.source || '').toLowerCase() === String(source).toLowerCase()) {
        return resolved.target;
      }
    }
    return forgeIntegration.normalizeFilePickerTarget(source, str);
  }

  _normalizeProbeBrowsePath(value) {
    return String(normalizeRelativeStoragePath(value) || '').toLowerCase();
  }

  _splitProbeBrowseTarget(target) {
    const normalized = normalizeRelativeStoragePath(target);
    if (!normalized) return [];
    return normalized.split('/').filter(Boolean);
  }

  _probeSegmentsStartWith(segments, rootSegments) {
    if (!rootSegments.length) return true;
    if (segments.length < rootSegments.length) return false;
    for (let i = 0; i < rootSegments.length; i += 1) {
      if (String(segments[i] || '').toLowerCase() !== String(rootSegments[i] || '').toLowerCase()) return false;
    }
    return true;
  }

  _directoryListIncludesProbeChild(result, parentTarget, childSegment) {
    const dirs = result?.dirs;
    if (!Array.isArray(dirs)) return null;
    const expected = this._normalizeProbeBrowsePath(appendStoragePath(parentTarget, childSegment));
    const child = this._normalizeProbeBrowsePath(childSegment);
    for (const dir of dirs) {
      const normalized = this._normalizeProbeBrowsePath(dir);
      if (!normalized) continue;
      if (normalized === expected || normalized === child) return true;
      if (expected && normalized.endsWith(`/${expected}`)) return true;
      if (child && normalized.endsWith(`/${child}`)) return true;
    }
    return false;
  }

  async _isMissingProbeDirectory(FilePickerImpl, storage, targetDir) {
    const targetSegments = this._splitProbeBrowseTarget(targetDir);
    const rootSegments = this._splitProbeBrowseTarget(storage?.target || '');
    if (!targetSegments.length || !this._probeSegmentsStartWith(targetSegments, rootSegments)) return false;

    const minParentLength = rootSegments.length;
    if (targetSegments.length <= minParentLength) return false;

    const source = storage?.source || 'data';
    const options = Object.assign({}, storage?.options || {});
    for (let parentLength = targetSegments.length - 1; parentLength >= minParentLength; parentLength -= 1) {
      const parentTarget = targetSegments.slice(0, parentLength).join('/');
      const childSegment = targetSegments[parentLength];
      let parentResult = null;
      try {
        parentResult = await FilePickerImpl.browse(source, parentTarget, Object.assign({}, options));
      } catch (error) {
        continue;
      }

      const childExists = this._directoryListIncludesProbeChild(parentResult, parentTarget, childSegment);
      if (childExists === null) {
        Logger.debug('DownloadManager.probeLocal:parentBrowseMissingDirs', {
          source,
          parentTarget,
          targetDir
        });
        return false;
      }

      return childExists === false;
    }

    return false;
  }

  _relativePathFromFilePath(filePath, baseDir, fallbackName = '') {
    const raw = String(filePath ?? '');
    const normalizedBase = normalizeRelativeStoragePath(baseDir);
    const fallback = normalizeRelativeStoragePath(fallbackName)
      || normalizeRelativeStoragePath(stripPathQueryAndHash(raw).split('/').pop() || '');
    const normalizedFile = normalizeRelativeStoragePath(raw);
    if (!normalizedBase) return normalizedFile || fallback;
    if (normalizedFile === normalizedBase) return fallback;
    if (normalizedFile.startsWith(`${normalizedBase}/`)) {
      return normalizedFile.slice(normalizedBase.length + 1) || fallback;
    }
    const collapsedRaw = stripPathQueryAndHash(raw).replace(/\\/g, '/').replace(/\/+/g, '/');
    const marker = `/${normalizedBase}/`;
    const idx = collapsedRaw.indexOf(marker);
    if (idx >= 0) {
      return normalizeRelativeStoragePath(collapsedRaw.slice(idx + marker.length)) || fallback;
    }
    return normalizedFile || fallback;
  }

  _stripQueryAndHash(value) {
    return stripPathQueryAndHash(value);
  }

  _pathEndsWithFilename(value, filename) {
    if (!value || !filename) return false;
    const target = String(normalizeRelativeStoragePath(filename) || '').trim().toLowerCase();
    if (!target) return false;
    const raw = normalizeRelativeStoragePath(value);
    const tail = raw.split('/').pop();
    if (!tail) return false;
    return tail.toLowerCase() === target;
  }

  _extractUploadPath(uploadResult) {
    if (!uploadResult) return '';
    if (typeof uploadResult === 'string') return uploadResult;
    if (typeof uploadResult?.url === 'string') return uploadResult.url;
    if (typeof uploadResult?.path === 'string') return uploadResult.path;
    if (typeof uploadResult?.file === 'string') return uploadResult.file;
    if (Array.isArray(uploadResult?.files) && typeof uploadResult.files[0] === 'string') return uploadResult.files[0];
    return '';
  }

  _resolveStoredFilePath(storage, targetDir, filename, hint = null) {
    const extracted = this._extractUploadPath(hint);
    const rawHint = typeof hint === 'string' ? hint : '';
    const candidate = extracted || rawHint;

    if (candidate && /^https?:\/\//i.test(candidate)) return candidate;

    const storedDir = String(storage?.storedDir || '').trim();
    const baseUrl = /^https?:\/\//i.test(storedDir) ? (storedDir.endsWith('/') ? storedDir : `${storedDir}/`) : '';

    if (String(storage?.source || '').toLowerCase() === 's3' && baseUrl) {
      const baseTarget = String(storage?.target || '').replace(/\/+$/, '');
      const dir = String(targetDir || '').replace(/^\/+/, '').replace(/\/+$/, '');
      let relativeDir = dir;
      if (baseTarget) {
        if (dir === baseTarget) relativeDir = '';
        else if (dir.startsWith(`${baseTarget}/`)) relativeDir = dir.slice(baseTarget.length + 1);
      }
      const relPath = [relativeDir, filename].filter(Boolean).join('/');
      return `${baseUrl}${relPath.replace(/^\/+/, '')}`;
    }

    if (candidate) return candidate;
    return [String(targetDir || '').replace(/\/+$/, ''), filename].filter(Boolean).join('/');
  }

  /**
   * Return a local path if the filename is already present
   * @param {'tokens'|'assets'} kind
   * @param {{filename:string}} item
   * @returns {string|null}
   */
  getLocalPath(kind, item) {
    for (const key of this._candidateInventoryKeys(kind, item)) {
      const hit = this._inventory.get(key);
      if (hit) return forgeIntegration.optimizeCacheURL(hit);
    }
    return null;
  }

  /**
   * Ensure a file is present locally, downloading if necessary.
   * Uses an inflight map to coalesce concurrent requests for the same file.
   * @param {'tokens'|'assets'} kind
   * @param {{filename:string,tier?:string}} item
   * @param {string} url - Source URL to download from
   * @param {{forceDownload?:boolean}} [options]
   * @returns {Promise<string>} Local path in the Foundry data storage (or direct URL if useDirectCloudUrls is enabled for free items)
   */
  async ensureLocal(kind, item, url, options = {}) {
    if (!item || !url) throw new Error('ensureLocal requires item and url');

    // If useDirectCloudUrls setting is enabled and item is free tier, return URL directly without downloading
    // Treat empty/missing tier as 'free' since that's the default
    const tierLower = String(item.tier || '').toLowerCase();
    const isFree = tierLower === 'free' || tierLower === '';
    const forceDownload = options?.forceDownload === true;
    if (isFree && !forceDownload) {
      try {
        const useDirectUrls = game?.settings?.get?.('fa-nexus', 'useDirectCloudUrls') === true;
        if (useDirectUrls) {
          Logger.info('DownloadManager.ensureLocal:directUrl', { kind, filename: item.filename, tier: item.tier, url });
          return url;
        }
      } catch (_) { /* setting not available, fall through to normal download */ }
    }

    const initialized = await this.initialize();
    if (!initialized) throw this._initializationError || new Error('Download manager initialization failed');
    const filename = String(item.filename || '').trim();
    if (!filename) throw new Error('Missing filename');
    let existing = null;
    for (const key of this._candidateInventoryKeys(kind, { filename, path: item?.file_path || item?.path })) {
      existing = this._inventory.get(key);
      if (existing) break;
    }
    if (existing) return forgeIntegration.optimizeCacheURL(existing);

    // Before downloading, check the expected parent directory only (cheap-ish) to see if file already exists.
    try {
      const storage = this._getStorage(kind);
      const rel = this._normalizeRelativePathFromItem(item, filename);
      const relSanitized = this._sanitizeRelativePath(rel);
      const subdir = this._dirName(relSanitized);
      const targetDir = [storage.target, subdir].filter(Boolean).join('/');
      const FilePickerImpl = requireFilePickerMethod('browse', {
        source: 'DownloadManager.ensureLocal',
        operation: 'probe-download-directory',
        folder: targetDir,
        kind,
        userMessage: `FA Nexus could not browse the download directory "${targetDir}" because the Foundry FilePicker runtime is unavailable.`
      });
      const res = await FilePickerImpl.browse(storage.source, targetDir, Object.assign({}, storage.options));
      const foundPath = (res.files || []).find((p) => this._pathEndsWithFilename(p, filename)) || null;
      if (foundPath) {
        const path = this._resolveStoredFilePath(storage, targetDir, filename, foundPath);
        this._registerInventoryEntry(kind, [filename, relSanitized], path);
        Logger.info('DownloadManager.ensureLocal:foundExisting', { path });
        return forgeIntegration.optimizeCacheURL(path);
      }
    } catch (_) { /* ignore and fallback to download */ }

    const relative = this._normalizeRelativePathFromItem(item, filename);
    const key = this._inventoryLookupKey(kind, relative || filename);
    if (this._inflight.has(key)) return this._inflight.get(key);
    const storage = this._getStorage(kind);
    const p = this._download(kind, filename, url, relative, storage).finally(() => this._inflight.delete(key));
    this._inflight.set(key, p);
    return p;
  }

  /**
   * Perform the actual download and upload into Foundry's data storage
   * @param {'tokens'|'assets'} kind
   * @param {string} filename
   * @param {string} url
   * @returns {Promise<string>} Local path
   * @private
   */
  async _download(kind, filename, url, relative, storageOverride = null) {
    const storage = storageOverride || this._getStorage(kind);
    const baseDir = storage.storedDir;
    const rel = relative || filename;
    const relSanitized = this._sanitizeRelativePath(rel);
    const subdir = this._dirName(relSanitized);
    const targetDir = [storage.target, subdir].filter(Boolean).join('/');

    this.progressEmitter.emit('download:start', { kind, filename, url, targetDir });

    try {
      Logger.info('DownloadManager.download:start', { kind, filename, baseDir, targetDir, rel: relSanitized });

      const blob = await retryWithBackoff(
        async () => {
          this.progressEmitter.emit('download:fetch', { kind, filename, url });
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`Download failed ${resp.status}`);
          return resp.blob();
        },
        {
          maxRetries: 3,
          initialDelay: 1500,
          maxDelay: 20000,
          onRetry: ({ attempt, maxRetries, delay }) => {
            this.progressEmitter.emit('download:retry', { kind, filename, attempt, maxRetries, delay });
            Logger.info('DownloadManager.download.retry', { kind, filename, attempt, maxRetries, delay });
          }
        }
      );

      const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
      const FilePickerImpl = requireFilePickerMethod('upload', {
        source: 'DownloadManager._download',
        operation: 'upload-downloaded-file',
        folder: targetDir,
        kind,
        userMessage: `FA Nexus could not upload "${filename}" because the Foundry FilePicker runtime is unavailable.`
      });

      // Ensure nested directory structure exists before uploading
      this.progressEmitter.emit('download:prepare', { kind, filename, targetDir });
      await this._ensureNestedDir(targetDir, storage);

      this.progressEmitter.emit('download:upload', { kind, filename, targetDir });
      const uploadResult = await FilePickerImpl.upload(storage.source, targetDir, file, { ...storage.options }, { notify: false, filename });

      const path = this._resolveStoredFilePath(storage, targetDir, filename, uploadResult);
      this._registerInventoryEntry(kind, [filename, relSanitized], path);
      Logger.info('DownloadManager.download:done', { path });
      this.progressEmitter.emit('download:complete', { kind, filename, path });
      return forgeIntegration.optimizeCacheURL(path);
    } catch (error) {
      const errorMsg = String(error?.message || error);
      Logger.error('DownloadManager.download:error', { kind, filename, error: errorMsg });
      this.progressEmitter.emit('download:error', { kind, filename, error: errorMsg });
      throw error;
    }
  }

  /**
   * Probe local storage for a specific item without downloading it.
   * Checks only the expected parent directory and updates inventory if found.
   * @param {'tokens'|'assets'} kind
   * @param {{filename:string, file_path?:string, path?:string}} item
   * @returns {Promise<string|null>} Local path if present, else null
   */
  async probeLocal(kind, item) {
    try {
      const initialized = await this.initialize();
      if (!initialized) throw this._initializationError || new Error('Download manager initialization failed');
      const filename = String(item?.filename || '').trim();
      if (!filename) return null;
      // Quick inventory lookup first
      for (const key of this._candidateInventoryKeys(kind, item || { filename })) {
        const hit = this._inventory.get(key);
        if (hit) return forgeIntegration.optimizeCacheURL(hit);
      }
      if (forgeIntegration.isRunningOnForge()) {
        Logger.debug('DownloadManager.probeLocal:skipForge', { kind, filename });
        return null;
      }
      const storage = this._getStorage(kind);
      const rel = this._normalizeRelativePathFromItem(item || {}, filename);
      const relSanitized = this._sanitizeRelativePath(rel);
      const subdir = this._dirName(relSanitized);
      const targetDir = [storage.target, subdir].filter(Boolean).join('/');
      const FilePickerImpl = requireFilePickerMethod('browse', {
        source: 'DownloadManager.probeLocal',
        operation: 'probe-local-download-cache',
        folder: targetDir,
        kind,
        userMessage: `FA Nexus could not probe the local ${kind} cache for "${filename}".`
      });
      let res = null;
      try {
        res = await FilePickerImpl.browse(storage.source, targetDir, Object.assign({}, storage.options));
      } catch (browseError) {
        if (await this._isMissingProbeDirectory(FilePickerImpl, storage, targetDir)) {
          return null;
        }
        throw browseError;
      }
      const foundPath = (res.files || []).find((p) => this._pathEndsWithFilename(p, filename)) || null;
      if (!foundPath) return null;
      const path = this._resolveStoredFilePath(storage, targetDir, filename, foundPath);
      this._registerInventoryEntry(kind, [filename, relSanitized], path);
      Logger.info('DownloadManager.probeLocal:found', { path });
      return forgeIntegration.optimizeCacheURL(path);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw wrapOperationalError(error, {
        code: 'LOCAL_PROBE_FAILED',
        source: 'DownloadManager.probeLocal',
        operation: 'probe-local-download-cache',
        folder: String(item?.path || item?.file_path || ''),
        kind,
        userMessage: `FA Nexus could not probe the local ${kind} cache for "${item?.filename || 'unknown file'}".`
      });
    }
  }

  _registerInventoryEntry(kind, nameOrNames, path) {
    if (!nameOrNames || !path) return;
    const names = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
    for (const n of names) {
      for (const key of this._generateInventoryKeys(n)) {
        const inventoryKey = this._inventoryLookupKey(kind, key);
        if (inventoryKey) this._inventory.set(inventoryKey, path);
      }
    }
  }

  _candidateInventoryKeys(kind, item) {
    const keys = [];
    for (const key of this._candidateKeysForItem(item)) {
      const inventoryKey = this._inventoryLookupKey(kind, key);
      if (inventoryKey) keys.push(inventoryKey);
    }
    return keys;
  }

  _candidateKeysForItem(item) {
    const names = new Set();
    if (!item) return [];
    const filename = item?.filename != null ? String(item.filename).trim() : '';
    const rawFilePath = String(item?.file_path || '').trim();
    const rawPath = String(item?.path || '').trim();
    const usePathFallback = rawPath && (!rawFilePath || rawFilePath === filename);
    const relSource = usePathFallback ? { path: rawPath, filename } : item;
    const relRaw = this._normalizeRelativePathFromItem(relSource, filename);
    const rel = relRaw ? this._sanitizeRelativePath(relRaw) : '';
    const hasDir = rel.includes('/');
    if (rel) names.add(rel);
    // Avoid filename-only fallback when a directory-qualified path is present.
    if (filename && (!hasDir || !rel)) names.add(filename);
    if (!filename && !rel) {
      const fp = item?.file_path || item?.path;
      if (fp) {
        const tail = String(fp).split('/').pop();
        if (tail) names.add(tail);
      }
    }
    const keys = new Set();
    for (const name of names) {
      for (const k of this._generateInventoryKeys(name)) keys.add(k);
    }
    return Array.from(keys);
  }

  _inventoryLookupKey(kind, key) {
    return buildTypedPathLookupKey(kind, key, {
      normalizePath: normalizeRelativeStoragePath
    });
  }

  _generateInventoryKeys(name) {
    return generateNormalizedPathLookupKeys(name, {
      normalizePath: normalizeRelativeStoragePath
    });
  }

  /** Ensure nested subdirectories exist under data scheme */
  async _ensureNestedDir(targetDir, context = null) {
    const segments = String(targetDir || '').split('/').filter(Boolean);
    if (segments.length === 0) return;
    let acc = segments[0];
    await this._ensureDir(acc, context);
    for (let i = 1; i < segments.length; i++) {
      acc = `${acc}/${segments[i]}`;
      await this._ensureDir(acc, context);
    }
  }

  /** Convert item.path or item.file_path into a clean relative path with filename */
  _normalizeRelativePathFromItem(item, fallbackFilename) {
    const fromItem = String(item?.file_path || item?.path || '').trim();
    const filename = normalizeRelativeStoragePath(item?.filename || fallbackFilename || '');
    if (!fromItem) return filename;
    const sanitized = this._sanitizeRelativePath(fromItem);
    if (!sanitized) return filename;
    // Ensure the last segment matches the filename; if not, append filename
    const tail = sanitized.split('/').pop();
    if (tail && filename && tail.toLowerCase() === filename.toLowerCase()) return sanitized;
    if (!filename) return sanitized;
    const dir = this._dirName(sanitized);
    return dir ? `${dir}/${filename}` : filename;
  }

  /** Sanitize a user/cloud provided relative path for local storage */
  _sanitizeRelativePath(p) {
    return normalizeRelativeStoragePath(p);
  }

  /** Return directory name portion of a path (without trailing slash) */
  _dirName(p) {
    const idx = String(p || '').lastIndexOf('/');
    if (idx <= 0) return '';
    return p.slice(0, idx);
  }

}
