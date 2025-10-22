// NexusDownloadManager — manages downloading cloud files to local Foundry storage
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { forgeIntegration } from '../core/forge-integration.js';
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

      const res = await fetch('https://www.google.com/favicon.ico', { method: 'HEAD', mode: 'no-cors', cache: 'no-cache' });
      if (!res.ok && res.type !== 'opaque') {
        throw new Error('Network appears to be offline');
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
      Logger.info('DownloadManager.retry', { attempt: attempt + 1, maxRetries, delay, error: String(error?.message || error) });

      try {
        onRetry?.({ attempt: attempt + 1, maxRetries, delay, error });
      } catch (_) {}

      await new Promise(resolve => {
        const timeout = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => {
          clearTimeout(timeout);
          resolve();
        });
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
      const tokensDir = this._getDir('tokens');
      const assetsDir = this._getDir('assets');
      await this._ensureDir(tokensDir);
      await this._ensureDir(assetsDir);
      // Do NOT block startup with a deep scan. Kick off a background indexer instead.
      this._initialized = true;
      const allowScan = !forgeIntegration.isRunningOnForge();
      if (allowScan) {
        this._startBackgroundScan([tokensDir, assetsDir]);
      } else {
        Logger.debug('DownloadManager.init:skipScan', { reason: 'forge-environment' });
      }
      Logger.info('DownloadManager.init:done', {
        tokensDir,
        assetsDir,
        files: this._inventory.size,
        backgroundScan: allowScan
      });
      return true;
    } catch (e) {
      Logger.error('DownloadManager.init:failed', e);
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

  /** Ensure a data directory exists (create if missing) */
  async _ensureDir(dir) {
    const FilePickerImpl = foundry.applications.apps.FilePicker.implementation;
    const { source, options } = forgeIntegration.getFilePickerContext();
    try {
      await FilePickerImpl.browse(source, dir, options);
    } catch (_) {
      Logger.info('DownloadManager.mkdir', { dir });
      await FilePickerImpl.createDirectory(source, dir, options);
    }
  }

  /**
   * Recursively scan a directory and populate the filename inventory.
   * Also indexes by the file's relative path from baseDir.
   */
  async _scanDirRecursive(dir, baseDir) {
    try {
      const FilePickerImpl = foundry.applications.apps.FilePicker.implementation;
      const { source, options } = forgeIntegration.getFilePickerContext();
      const res = await FilePickerImpl.browse(source, dir, options);
      Logger.info('DownloadManager.scan', { dir, count: (res.files||[]).length, subdirs: (res.dirs||[]).length });
      for (const filePath of res.files || []) {
        const name = String(filePath.split('/').pop() || '');
        const rel = filePath.startsWith(`${baseDir}/`) ? filePath.slice(baseDir.length + 1) : name;
        this._registerInventoryEntry([name, rel], filePath);
      }
      for (const subdir of res.dirs || []) {
        await this._scanDirRecursive(subdir, baseDir);
      }
    } catch (e) {
      Logger.warn('DownloadManager.scan:failed', { dir, error: String(e?.message||e) });
    }
  }

  /** Start a low-impact, non-blocking background scan to gradually build the index */
  _startBackgroundScan(baseDirs) {
    try {
      if (forgeIntegration.isRunningOnForge()) {
        Logger.debug('DownloadManager.bgScan:skip', { reason: 'forge-environment' });
        return;
      }
      if (this._bgScanActive || this._bgScanQueued) return;
      this._bgScanQueued = true;
      const FilePickerImpl = foundry.applications.apps.FilePicker.implementation;
      const queue = [];
      for (const d of baseDirs || []) if (d) queue.push({ dir: d, base: d });
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
          const { source, options } = forgeIntegration.getFilePickerContext();
          const res = await FilePickerImpl.browse(source, next.dir, options);
          for (const filePath of res.files || []) {
            const name = String(filePath.split('/').pop() || '');
            const rel = filePath.startsWith(`${next.base}/`) ? filePath.slice(next.base.length + 1) : name;
            this._registerInventoryEntry([name, rel], filePath);
            if (this._inventory.size >= this._maxIndexEntries) break;
          }
          if (this._inventory.size < this._maxIndexEntries) {
            for (const sub of res.dirs || []) queue.push({ dir: sub, base: next.base });
          }
        } catch (e) {
          Logger.debug('DownloadManager.bgScan:dirFailed', { dir: next.dir, error: String(e?.message||e) });
        }
        setTimeout(step, this._bgScanDelayMs);
      };
      setTimeout(step, this._bgScanDelayMs);
    } catch (_) { /* noop */ }
  }

  /**
   * Return a local path if the filename is already present
   * @param {'tokens'|'assets'} kind
   * @param {{filename:string}} item
   * @returns {string|null}
   */
  getLocalPath(kind, item) {
    for (const key of this._candidateKeysForItem(item)) {
      const hit = this._inventory.get(key);
      if (hit) return forgeIntegration.optimizeCacheURL(hit);
    }
    return null;
  }

  /**
   * Ensure a file is present locally, downloading if necessary.
   * Uses an inflight map to coalesce concurrent requests for the same file.
   * @param {'tokens'|'assets'} kind
   * @param {{filename:string}} item
   * @param {string} url - Source URL to download from
   * @returns {Promise<string>} Local path in the Foundry data storage
   */
  async ensureLocal(kind, item, url) {
    if (!item || !url) throw new Error('ensureLocal requires item and url');
    await this.initialize();
    const filename = String(item.filename || '').trim();
    if (!filename) throw new Error('Missing filename');
    let existing = null;
    for (const key of this._candidateKeysForItem({ filename, path: item?.file_path || item?.path })) {
      existing = this._inventory.get(key);
      if (existing) break;
    }
    if (existing) return forgeIntegration.optimizeCacheURL(existing);

    // Before downloading, check the expected parent directory only (cheap-ish) to see if file already exists.
    try {
      const baseDir = this._getDir(kind);
      const rel = this._normalizeRelativePathFromItem(item, filename);
      const relSanitized = this._sanitizeRelativePath(rel);
      const subdir = this._dirName(relSanitized);
      const targetDir = subdir ? `${baseDir}/${subdir}` : baseDir;
      const FilePickerImpl = foundry.applications.apps.FilePicker.implementation;
      const { source, options } = forgeIntegration.getFilePickerContext();
      const res = await FilePickerImpl.browse(source, targetDir, options);
      const found = (res.files || []).some(p => String(p).endsWith(`/${filename}`));
      if (found) {
        const path = `${targetDir}/${filename}`;
        this._registerInventoryEntry([filename, relSanitized], path);
        Logger.info('DownloadManager.ensureLocal:foundExisting', { path });
        return forgeIntegration.optimizeCacheURL(path);
      }
    } catch (_) { /* ignore and fallback to download */ }

    const relative = this._normalizeRelativePathFromItem(item, filename);
    const key = `${kind}:${(relative || filename).toLowerCase()}`;
    if (this._inflight.has(key)) return this._inflight.get(key);
    const p = this._download(kind, filename, url, relative).finally(() => this._inflight.delete(key));
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
  async _download(kind, filename, url, relative) {
    const baseDir = this._getDir(kind);
    const rel = relative || filename;
    const relSanitized = this._sanitizeRelativePath(rel);
    const subdir = this._dirName(relSanitized);
    const targetDir = subdir ? `${baseDir}/${subdir}` : baseDir;

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
      const FilePickerImpl = foundry.applications.apps.FilePicker.implementation;

      // Ensure nested directory structure exists before uploading
      this.progressEmitter.emit('download:prepare', { kind, filename, targetDir });
      await this._ensureNestedDir(targetDir);

      this.progressEmitter.emit('download:upload', { kind, filename, targetDir });
      const { source, options } = forgeIntegration.getFilePickerContext();
      await FilePickerImpl.upload(source, targetDir, file, { ...options }, { notify: false, filename });

      const path = `${targetDir}/${filename}`;
      this._registerInventoryEntry([filename, relSanitized], path);
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
      await this.initialize();
      const filename = String(item?.filename || '').trim();
      if (!filename) return null;
      // Quick inventory lookup first
      for (const key of this._candidateKeysForItem(item || { filename })) {
        const hit = this._inventory.get(key);
        if (hit) return forgeIntegration.optimizeCacheURL(hit);
      }
      if (forgeIntegration.isRunningOnForge()) {
        Logger.debug('DownloadManager.probeLocal:skipForge', { kind, filename });
        return null;
      }
      const baseDir = this._getDir(kind);
      const rel = this._normalizeRelativePathFromItem(item || {}, filename);
      const relSanitized = this._sanitizeRelativePath(rel);
      const subdir = this._dirName(relSanitized);
      const targetDir = subdir ? `${baseDir}/${subdir}` : baseDir;
      const FilePickerImpl = foundry.applications.apps.FilePicker.implementation;
      const { source, options } = forgeIntegration.getFilePickerContext();
      const res = await FilePickerImpl.browse(source, targetDir, options);
      const found = (res.files || []).some(p => String(p).endsWith(`/${filename}`));
      if (!found) return null;
      const path = `${targetDir}/${filename}`;
      this._registerInventoryEntry([filename, relSanitized], path);
      Logger.info('DownloadManager.probeLocal:found', { path });
      return forgeIntegration.optimizeCacheURL(path);
    } catch (_) {
      return null;
    }
  }

  _registerInventoryEntry(nameOrNames, path) {
    if (!nameOrNames || !path) return;
    const names = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
    for (const n of names) {
      for (const key of this._generateInventoryKeys(n)) {
        this._inventory.set(key, path);
      }
    }
  }

  _candidateKeysForItem(item) {
    const names = new Set();
    if (item?.filename) names.add(String(item.filename));
    const fp = item?.file_path || item?.path;
    if (fp) {
      const fpStr = String(fp);
      const tail = fpStr.split('/').pop();
      if (tail) names.add(tail);
      const rel = this._sanitizeRelativePath(fpStr);
      if (rel) names.add(rel);
    }
    const keys = new Set();
    for (const name of names) {
      for (const k of this._generateInventoryKeys(name)) keys.add(k);
    }
    return Array.from(keys);
  }

  _generateInventoryKeys(name) {
    const keys = new Set();
    const push = (value) => {
      if (!value) return;
      const trimmed = String(value).trim();
      if (!trimmed) return;
      keys.add(trimmed.toLowerCase());
    };

    const base = String(name || '');
    push(base);

    let decoded = base;
    for (let i = 0; i < 3; i++) {
      const next = this._safeDecode(decoded);
      if (!next || next === decoded) break;
      decoded = next;
      push(decoded);
    }

    let encoded = base;
    for (let i = 0; i < 3; i++) {
      const next = this._safeEncode(encoded);
      if (!next || next === encoded) break;
      encoded = next;
      push(encoded);
    }

    return Array.from(keys.values());
  }

  /** Ensure nested subdirectories exist under data scheme */
  async _ensureNestedDir(targetDir) {
    const segments = String(targetDir || '').split('/').filter(Boolean);
    if (segments.length === 0) return;
    let acc = segments[0];
    await this._ensureDir(acc);
    for (let i = 1; i < segments.length; i++) {
      acc = `${acc}/${segments[i]}`;
      await this._ensureDir(acc);
    }
  }

  /** Convert item.path or item.file_path into a clean relative path with filename */
  _normalizeRelativePathFromItem(item, fallbackFilename) {
    const fromItem = String(item?.file_path || item?.path || '').trim();
    const filename = String(item?.filename || fallbackFilename || '').trim();
    if (!fromItem) return filename;
    const sanitized = this._sanitizeRelativePath(fromItem);
    if (!sanitized) return filename;
    // Ensure the last segment matches the filename; if not, append filename
    const tail = sanitized.split('/').pop();
    if (tail && tail.toLowerCase() === filename.toLowerCase()) return sanitized;
    const dir = this._dirName(sanitized);
    return dir ? `${dir}/${filename}` : filename;
  }

  /** Sanitize a user/cloud provided relative path for local storage */
  _sanitizeRelativePath(p) {
    if (!p) return '';
    let s = String(p).replace(/\\/g, '/');
    s = s.replace(/^\/+/, '');
    s = s.replace(/\/+$/, '');
    const parts = [];
    for (const seg of s.split('/')) {
      const trimmed = seg.trim();
      if (!trimmed || trimmed === '.' || trimmed === '') continue;
      if (trimmed === '..') continue;
      parts.push(trimmed);
    }
    return parts.join('/');
  }

  /** Return directory name portion of a path (without trailing slash) */
  _dirName(p) {
    const idx = String(p || '').lastIndexOf('/');
    if (idx <= 0) return '';
    return p.slice(0, idx);
  }

  _safeDecode(value) {
    if (typeof value !== 'string') return value;
    try {
      return decodeURI(value);
    } catch (_) {
      try {
        return decodeURIComponent(value);
      } catch (_) {
        return value;
      }
    }
  }

  _safeEncode(value) {
    if (typeof value !== 'string') return value;
    try {
      return encodeURI(value);
    } catch (_) {
      try {
        return encodeURIComponent(value);
      } catch (_) {
        return value;
      }
    }
  }
}
