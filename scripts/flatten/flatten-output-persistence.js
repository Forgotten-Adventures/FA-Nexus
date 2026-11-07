import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { forgeIntegration } from '../storage/forge-integration.js';
import { embedFlattenMetadataInWebPBlob } from './flatten-webp-metadata.js';
import { resolveFlattenOutputFolder } from './flatten-output-paths.js';

export class FlattenOutputPersistence {
  constructor(manager) {
    if (!manager) throw new Error('FlattenOutputPersistence requires manager.');
    this.manager = manager;
  }

  async resolveFlattenUploadContext(folder = null) {
    const manager = this.manager;
    await forgeIntegration.initialize();
    const generatedPath = resolveFlattenOutputFolder('flatten', folder, { assetsDir: manager._getAssetsDir() });
    await manager._registerGeneratedFlattenRoot(generatedPath.root);
    const dirContext = forgeIntegration.resolveFilePickerContext(generatedPath.folder);
    const source = dirContext?.source || 'data';
    const bucketOptions = dirContext?.options || {};
    const baseTarget = dirContext?.target || '';
    const baseDir = baseTarget;
    const FP = foundry.applications.apps.FilePicker.implementation;

    await manager._ensureNestedDir(baseDir, { source, options: bucketOptions });

    Logger.info('TileFlatten.uploadContext.flatten', {
      root: generatedPath.root,
      effectiveFolder: generatedPath.folder,
      source,
      target: baseDir,
      worldId: generatedPath.worldId,
      sceneId: generatedPath.sceneId
    });

    return {
      FP,
      source,
      bucketOptions,
      baseTarget,
      baseDir,
      assetsSetting: generatedPath.folder,
      requestedRoot: generatedPath.root,
      effectiveFolder: generatedPath.folder,
      worldId: generatedPath.worldId,
      sceneId: generatedPath.sceneId
    };
  }

  async resolveExportUploadContext(folder = null) {
    const manager = this.manager;
    const resolved = resolveFlattenOutputFolder('export', folder, { assetsDir: manager._getAssetsDir() });
    const requested = resolved.folder;
    await forgeIntegration.initialize();
    const dirContext = forgeIntegration.resolveFilePickerContext(requested);
    const source = dirContext?.source || 'data';
    const bucketOptions = dirContext?.options || {};
    const baseTarget = dirContext?.target || '';
    const baseDir = baseTarget;
    const FP = foundry.applications.apps.FilePicker.implementation;

    await manager._ensureNestedDir(baseDir, { source, options: bucketOptions });
    Logger.info('TileFlatten.uploadContext.export', {
      root: requested,
      effectiveFolder: requested,
      source,
      target: baseDir
    });

    return {
      FP,
      source,
      bucketOptions,
      baseTarget,
      baseDir,
      assetsSetting: requested,
      requestedRoot: requested,
      effectiveFolder: requested,
      worldId: null,
      sceneId: null
    };
  }

  async findExistingOutputFiles(uploadContext, filenames) {
    const wanted = new Map();
    for (const filename of Array.isArray(filenames) ? filenames : []) {
      const normalized = String(filename || '').trim();
      if (!normalized) continue;
      wanted.set(normalized.toLowerCase(), normalized);
    }
    if (!wanted.size) return [];

    const FP = uploadContext?.FP || foundry?.applications?.apps?.FilePicker?.implementation;
    if (!FP || typeof FP.browse !== 'function') {
      throw new Error('Foundry FilePicker browse runtime is unavailable; cannot check output collisions.');
    }

    const source = uploadContext?.source || 'data';
    const baseDir = uploadContext?.baseDir || '';
    const bucketOptions = uploadContext?.bucketOptions || {};
    let result = null;
    try {
      result = await FP.browse(source, baseDir, { ...bucketOptions });
    } catch (error) {
      if (this.isMissingOutputFolderBrowseError(error, source, baseDir)) {
        Logger.debug?.('TileFlatten.overwriteCheck.missingFolderClearFromError', {
          source,
          baseDir,
          error: String(error?.message || error)
        });
        return [];
      }
      throw error;
    }
    const existing = [];
    const seen = new Set();

    for (const filePath of result?.files || []) {
      const filename = this.manager._extractFilenameFromPath(filePath);
      const key = filename.toLowerCase();
      if (!filename || !wanted.has(key) || seen.has(key)) continue;
      seen.add(key);
      existing.push({
        filename: wanted.get(key) || filename,
        path: String(filePath || '')
      });
    }

    existing.sort((a, b) => String(a.filename || '').localeCompare(String(b.filename || '')));
    return existing;
  }

  isMissingOutputFolderBrowseError(error, source, target) {
    if (String(source || 'data').toLowerCase() !== 'data') return false;
    if (!String(target || '').trim()) return false;

    const message = String(error?.message || error || '');
    if (!message) return false;
    if (/permission|not permitted|not allowed|FILES_BROWSE/i.test(message)) return false;
    return /does not exist|not found|ENOENT|no such file or directory/i.test(message);
  }

  async confirmOverwriteOutputs(uploadContext, filenames, options = {}) {
    const planned = Array.from(new Set(
      (Array.isArray(filenames) ? filenames : [])
        .map((filename) => String(filename || '').trim())
        .filter(Boolean)
    ));
    if (!planned.length) return true;

    let existing = [];
    try {
      existing = await this.findExistingOutputFiles(uploadContext, planned);
    } catch (error) {
      Logger.error('TileFlatten.overwriteCheck.failed', {
        error: String(error?.message || error),
        source: uploadContext?.source || 'data',
        baseDir: uploadContext?.baseDir || '',
        filenames: planned
      });
      ui?.notifications?.error?.('FA Nexus could not check the output folder for existing files. The operation was stopped to avoid overwriting files without confirmation.');
      return false;
    }
    if (!existing.length) return true;

    const previewCount = Math.min(existing.length, 8);
    const previewItems = existing
      .slice(0, previewCount)
      .map((entry) => `<li><code>${this.manager._escapeHTML(entry.filename)}</code></li>`)
      .join('');
    const remainder = existing.length - previewCount;
    const subject = existing.length === 1 ? 'file already exists' : `${existing.length} files already exist`;
    const followup = remainder > 0
      ? `<p>And ${remainder} more file${remainder === 1 ? '' : 's'}.</p>`
      : '';
    const content = [
      `<p>The following ${subject} and will be overwritten:</p>`,
      `<ul>${previewItems}</ul>`,
      followup,
      '<p>Continue?</p>'
    ].join('');
    const title = String(options?.title || 'Overwrite Existing Files?').trim() || 'Overwrite Existing Files?';
    const actionLabel = String(options?.actionLabel || 'Overwrite').trim() || 'Overwrite';

    try {
      const DialogV2 = foundry?.applications?.api?.DialogV2;
      if (DialogV2?.confirm) {
        const result = await DialogV2.confirm({
          window: { title },
          modal: true,
          content,
          yes: {
            label: actionLabel,
            icon: 'fas fa-file-import'
          },
          no: {
            label: 'Cancel'
          },
          defaultYes: false
        });
        return !!result;
      }
      if (typeof Dialog?.confirm === 'function') {
        return Dialog.confirm({
          title,
          content,
          yes: () => true,
          no: () => false,
          defaultYes: false
        });
      }
    } catch (error) {
      Logger.warn('TileFlatten.overwriteConfirm.dialogFailed', { error: String(error?.message || error) });
    }

    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      const lines = existing.slice(0, previewCount).map((entry) => `- ${entry.filename}`);
      if (remainder > 0) lines.push(`- and ${remainder} more`);
      return window.confirm(`${title}\n\nThese files already exist and will be overwritten:\n${lines.join('\n')}\n\nContinue?`);
    }

    Logger.error('TileFlatten.overwriteConfirm.unavailable', { filenames: existing.map((entry) => entry.filename) });
    ui?.notifications?.error?.('FA Nexus could not open an overwrite confirmation dialog.');
    return false;
  }

  normalizeWebPFilename(options = {}) {
    const manager = this.manager;
    const baseName = manager._sanitizeOutputBaseName(options.baseName, manager._buildFlattenFilenameBase());
    let filename = String(options.filename || `${baseName}.webp`).trim();
    filename = filename.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-');
    if (!String(filename).toLowerCase().endsWith('.webp')) filename = `${filename}.webp`;
    return filename;
  }

  resolveSavedWebPPath(uploadResult, uploadContext, filename) {
    const source = uploadContext?.source || 'data';
    const baseTarget = uploadContext?.baseTarget || '';
    const baseDir = uploadContext?.baseDir || '';
    const assetsSetting = uploadContext?.assetsSetting || this.manager._getAssetsDir();
    let path = '';

    try {
      if (typeof uploadResult?.url === 'string') path = uploadResult.url;
      else if (typeof uploadResult?.path === 'string') path = uploadResult.path;
      else if (typeof uploadResult === 'string') path = uploadResult;
    } catch (_) {}
    if (!path) path = `${baseDir}/${filename}`;

    if (source === 's3' && !/^https?:\/\//i.test(path)) {
      const objectKey = this.resolveS3UploadedObjectKey(path, uploadContext, filename);
      const s3Url = this.buildS3ObjectUrl(uploadContext, objectKey);
      if (s3Url) {
        path = s3Url;
      } else if (/^https?:\/\//i.test(String(assetsSetting || ''))) {
        const baseUrl = String(assetsSetting || '').trim().endsWith('/') ? String(assetsSetting || '').trim() : `${String(assetsSetting || '').trim()}/`;
        const rel = baseTarget && baseDir.startsWith(`${baseTarget}/`) ? baseDir.slice(baseTarget.length + 1) : (baseDir === baseTarget ? '' : baseDir);
        const relPath = [rel, filename].filter(Boolean).join('/');
        path = `${baseUrl}${relPath.replace(/^\/+/, '')}`;
      }
    }
    if (source === 'forgevtt') {
      path = forgeIntegration.optimizeCacheURL(path);
    }

    return path;
  }

  predictWebPUploadPath(uploadContext, filename) {
    return this.resolveSavedWebPPath(null, uploadContext || {}, filename);
  }

  buildS3ObjectUrl(uploadContext, key) {
    const cleanBucket = String(uploadContext?.bucketOptions?.bucket || '').trim();
    const cleanKey = this.normalizeS3ObjectKey(key);
    if (!cleanBucket || !cleanKey) return '';

    const s3 = game?.data?.files?.s3 ?? {};
    const forcePathStyle = Boolean(s3.forcePathStyle || s3.pathStyle || s3.usePathStyle);
    const endpointCandidate = s3.endpoint || s3.url || s3.publicUrl || s3.publicURL || '';

    let endpointUrl = null;
    try {
      if (endpointCandidate instanceof URL) endpointUrl = endpointCandidate;
      else if (typeof endpointCandidate === 'string' && endpointCandidate.trim()) {
        const raw = endpointCandidate.trim();
        endpointUrl = new URL(raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`);
      } else if (endpointCandidate && typeof endpointCandidate === 'object') {
        const protocol = String(endpointCandidate.protocol || 'https:');
        const host = String(endpointCandidate.host || endpointCandidate.hostname || '').trim();
        if (host) endpointUrl = new URL(`${protocol.endsWith(':') ? protocol : `${protocol}:`}//${host}`);
      }
    } catch (_) {
      endpointUrl = null;
    }

    if (endpointUrl) {
      if (forcePathStyle) {
        return new URL(cleanKey, this.ensureTrailingSlash(`${endpointUrl.origin.replace(/\/+$/, '')}/${cleanBucket}`)).href;
      }
      const host = endpointUrl.hostname;
      const withBucketHost = host.startsWith(`${cleanBucket}.`) ? host : `${cleanBucket}.${host}`;
      const origin = `${endpointUrl.protocol}//${withBucketHost}${endpointUrl.port ? `:${endpointUrl.port}` : ''}`;
      return new URL(cleanKey, this.ensureTrailingSlash(origin)).href;
    }

    const region = s3.region || s3.awsRegion || s3.awsDefaultRegion || '';
    const host = region ? `${cleanBucket}.s3.${region}.amazonaws.com` : `${cleanBucket}.s3.amazonaws.com`;
    return new URL(cleanKey, `https://${host}/`).href;
  }

  ensureTrailingSlash(value) {
    const normalized = String(value ?? '').trim();
    if (!normalized) return '';
    return normalized.endsWith('/') ? normalized : `${normalized}/`;
  }

  normalizeS3ObjectKey(value) {
    let raw = String(value ?? '').trim();
    if (!raw) return '';
    raw = raw.split(/[?#]/, 1)[0] || '';
    try { raw = decodeURI(raw); } catch (_) {}
    return raw.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  }

  resolveS3ObjectKey(value, uploadContext = null) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';

    try {
      const resolved = forgeIntegration.resolveFilePickerContext(raw);
      if (resolved?.source === 's3') {
        const target = this.normalizeS3ObjectKey(resolved.target);
        if (target) return target;
      }
    } catch (_) {}

    if (/^https?:\/\//i.test(raw)) {
      try {
        const url = new URL(raw);
        let key = this.normalizeS3ObjectKey(url.pathname);
        const bucket = String(uploadContext?.bucketOptions?.bucket || '').trim().toLowerCase();
        if (bucket) {
          const parts = key.split('/').filter(Boolean);
          if (parts[0]?.toLowerCase() === bucket) key = parts.slice(1).join('/');
        }
        return key;
      } catch (_) {}
    }

    if (/^s3:/i.test(raw)) {
      let key = raw.replace(/^s3:\/?/i, '');
      const bucket = String(uploadContext?.bucketOptions?.bucket || '').trim().toLowerCase();
      if (bucket) {
        const parts = key.split('/').filter(Boolean);
        if (parts[0]?.toLowerCase() === bucket) key = parts.slice(1).join('/');
      }
      return this.normalizeS3ObjectKey(key);
    }

    return this.normalizeS3ObjectKey(raw);
  }

  resolveS3UploadedObjectKey(path, uploadContext, filename) {
    const key = this.resolveS3ObjectKey(path, uploadContext);
    const baseKey = this.resolveS3ObjectKey(uploadContext?.baseDir || '', uploadContext);
    if (!key) return [baseKey, filename].filter(Boolean).join('/');
    if (baseKey && !key.includes('/')) return `${baseKey}/${key}`;
    return key;
  }

  s3UploadPathsMatch(expectedPath, actualPath, uploadContext = null) {
    if ((uploadContext?.source || '') !== 's3') return false;
    return this.storageObjectKeysMatch(expectedPath, actualPath, uploadContext);
  }

  storageObjectKeysMatch(leftPath, rightPath, uploadContext = null) {
    const leftKey = this.resolveS3ObjectKey(leftPath, uploadContext);
    const rightKey = this.resolveS3ObjectKey(rightPath, uploadContext);
    return !!(leftKey && rightKey && leftKey === rightKey);
  }

  normalizeUploadPathForComparison(value) {
    let raw = String(value || '').trim().replace(/\\/g, '/');
    try {
      const base = globalThis.location?.href || 'http://localhost/';
      const url = new URL(raw, base);
      const baseUrl = new URL(base);
      if (url.origin === baseUrl.origin) raw = `${url.pathname}${url.search || ''}${url.hash || ''}`;
    } catch (_) {}
    try { raw = decodeURI(raw); } catch (_) {}
    return raw.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  }

  recordSavedWebPPathMismatch(expectedPath, actualPath, filename, uploadContext = null) {
    if (!expectedPath) return;
    const expected = this.normalizeUploadPathForComparison(expectedPath);
    const actual = this.normalizeUploadPathForComparison(actualPath);
    if (expected === actual) return;
    if (this.s3UploadPathsMatch(expectedPath, actualPath, uploadContext)) return;

    Logger.warn('TileFlatten.saveWebP.pathMismatch', {
      filename,
      expectedPath,
      actualPath,
      source: uploadContext?.source || 'data',
      usingActualPath: true
    });
  }

  async saveAsWebP(canvasEl, quality, options = {}) {
    const blob = await this.manager._canvasToWebPBlob(canvasEl, quality);
    return this.saveWebPBlob(blob, options);
  }

  async captureFlattenChunkWebP(entry, quality, options = {}) {
    const filename = this.normalizeWebPFilename({ filename: options.filename });
    const blob = await this.manager._canvasToWebPBlob(entry?.canvas, quality);
    if (!blob) {
      throw new Error(`Failed to encode flattened WebP chunk ${filename}.`);
    }
    const src = this.predictWebPUploadPath(options.uploadContext, filename);
    return {
      src,
      filename,
      blob,
      x: Number(entry?.x) || 0,
      y: Number(entry?.y) || 0,
      width: Number(entry?.width) || 0,
      height: Number(entry?.height) || 0,
      pixelWidth: Number(entry?.pixelWidth) || null,
      pixelHeight: Number(entry?.pixelHeight) || null
    };
  }

  chunkBlobRecordToMetadataEntry(record) {
    return {
      src: String(record?.src || ''),
      x: Number(record?.x) || 0,
      y: Number(record?.y) || 0,
      width: Number(record?.width) || 0,
      height: Number(record?.height) || 0,
      pixelWidth: Number(record?.pixelWidth) || null,
      pixelHeight: Number(record?.pixelHeight) || null
    };
  }

  replaceFlattenMetadataGeneratedPath(metadata, previousPath, nextPath) {
    const previous = String(previousPath || '').trim();
    const next = String(nextPath || '').trim();
    if (!metadata || !previous || !next || previous === next) return;

    const matches = (candidate) => this.normalizeUploadPathForComparison(candidate) === this.normalizeUploadPathForComparison(previous);
    if (matches(metadata.filePath)) metadata.filePath = next;
    if (metadata.embeddedMetadata && matches(metadata.embeddedMetadata.primaryFilePath)) {
      metadata.embeddedMetadata.primaryFilePath = next;
    }
    if (Array.isArray(metadata.chunks)) {
      for (const chunk of metadata.chunks) {
        if (matches(chunk?.src)) chunk.src = next;
      }
    }
  }

  async saveCapturedFlattenWebP(record, uploadContext, metadata) {
    const expectedPath = String(record?.src || '').trim();
    const path = await this.saveWebPBlob(record?.blob, {
      quiet: true,
      uploadContext,
      filename: record?.filename,
      expectedPath,
      flattenMetadata: metadata
    });
    if (!path) throw new Error(`Failed to save flattened WebP ${record?.filename || ''}`.trim());
    if (record && path !== expectedPath) {
      record.src = path;
      this.replaceFlattenMetadataGeneratedPath(metadata, expectedPath, path);
    }
    return path;
  }

  async saveWebPBlob(blob, options = {}) {
    if (!blob) return null;

    const filename = this.normalizeWebPFilename(options);
    const uploadContext = options.uploadContext || await this.resolveFlattenUploadContext();
    const source = uploadContext?.source || 'data';
    const bucketOptions = uploadContext?.bucketOptions || {};
    const baseDir = uploadContext?.baseDir || '';
    const FP = uploadContext?.FP || foundry.applications.apps.FilePicker.implementation;
    const embeddedMetadata = options.flattenMetadata || null;
    const uploadBlob = embeddedMetadata
      ? await embedFlattenMetadataInWebPBlob(blob, embeddedMetadata)
      : blob;
    const file = new File([uploadBlob], filename, { type: 'image/webp' });

    // A Flatten ends with one message of its own; a message per uploaded picture on top of it is noise.
    // Without `notify` Foundry still reports a refused upload, and a missing path fails the save below.
    const uploadResult = await FP.upload(source, baseDir, file, { ...bucketOptions }, { notify: options.quiet !== true, filename });

    const path = this.resolveSavedWebPPath(uploadResult, uploadContext, filename);
    this.recordSavedWebPPathMismatch(options.expectedPath || '', path, filename, uploadContext);

    await new Promise(resolve => setTimeout(resolve, 200));

    return path;
  }
}
