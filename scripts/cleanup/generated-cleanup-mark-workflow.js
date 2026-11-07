import { NexusLogger as Logger } from '../core/nexus-logger.js';

export const GENERATED_CLEANUP_BACKUP_ROOT = 'fa-nexus/cleanup-backups';
const LEGACY_BACKUP_ROOT = '__fa-nexus-cleanup-backups__';
export function isGeneratedCleanupBackupPath(path) {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return [GENERATED_CLEANUP_BACKUP_ROOT, LEGACY_BACKUP_ROOT].some(root =>
    normalized === root || normalized.endsWith(`/${root}`) || normalized.startsWith(`${root}/`) || normalized.includes(`/${root}/`));
}

export const SUPPORTED_GENERATED_CLEANUP_EXTENSIONS = new Set(['.png', '.webp']);

export function resolveGeneratedCleanupMimeType(extension) {
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function failureReasonForPhase(phase) {
  if (phase === 'validate') return 'unsupported-extension';
  if (phase === 'fetch-original') return 'fetch-failed';
  if (phase === 'upload-backup') return 'backup-upload-failed';
  return 'overwrite-upload-failed';
}

export class GeneratedCleanupMarkWorkflow {
  constructor({
    getFilePicker,
    ensureNestedDir,
    buildFetchCandidates,
    createPlaceholderFile,
    extractUploadPath,
    buildSkipEntry,
    fetchImpl = (...args) => globalThis.fetch(...args),
    logger = Logger
  } = {}) {
    this._getFilePicker = getFilePicker;
    this._ensureNestedDir = ensureNestedDir;
    this._buildFetchCandidates = buildFetchCandidates;
    this._createPlaceholderFile = createPlaceholderFile;
    this._extractUploadPath = extractUploadPath;
    this._buildSkipEntry = buildSkipEntry;
    this._fetchImpl = fetchImpl;
    this._logger = logger;
  }

  async markEntry(entry, { backupFirst = true, backupStamp = '' } = {}) {
    let phase = 'validate';
    try {
      if (!SUPPORTED_GENERATED_CLEANUP_EXTENSIONS.has(String(entry.extension || '').toLowerCase())) {
        throw new Error(`Unsupported extension: ${entry.extension || 'unknown'}`);
      }

      if (backupFirst) {
        phase = 'fetch-original';
        const originalBlob = await this.fetchOriginalBlob(entry);
        phase = 'upload-backup';
        const backupPath = await this.uploadBackup(entry, originalBlob, backupStamp);
        entry.backupPath = backupPath;
        this._logger.info('GeneratedCleanup.mark.backupCreated', { source: entry.source, target: entry.target, backupPath });
      }

      phase = 'overwrite-placeholder';
      const writtenPath = await this.overwriteWithPlaceholder(entry);
      entry.markStatus = 'marked';
      entry.markError = '';
      this._logger.info('GeneratedCleanup.mark.success', {
        source: entry.source,
        target: entry.target,
        writtenPath,
        backupPath: entry.backupPath || null
      });
      return { marked: true, writtenPath, backupPath: entry.backupPath || null };
    } catch (error) {
      const message = String(error?.message || error);
      const reason = failureReasonForPhase(phase);
      entry.markStatus = 'skipped';
      entry.markError = message;
      this._logger.error('GeneratedCleanup.mark.failed', {
        source: entry.source,
        target: entry.target,
        error: message
      });
      return {
        marked: false,
        phase,
        reason,
        skip: this._buildSkipEntry(phase, reason, {
          category: entry.category,
          path: entry.path,
          source: entry.source,
          target: entry.target,
          error: message
        })
      };
    }
  }

  async fetchOriginalBlob(entry) {
    const candidates = this._buildFetchCandidates(entry);
    if (!candidates.length) throw new Error('Unable to resolve fetch URL');
    let lastError = null;
    for (const url of candidates) {
      try {
        this._logger.info('GeneratedCleanup.mark.fetchOriginal', { source: entry.source, target: entry.target, url });
        const response = await this._fetchImpl(url, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Fetch failed with ${response.status}`);
        }
        return response.blob();
      } catch (error) {
        lastError = error;
        this._logger.warn('GeneratedCleanup.mark.fetchAttemptFailed', {
          source: entry.source,
          target: entry.target,
          url,
          error: String(error?.message || error)
        });
      }
    }
    throw lastError || new Error('Fetch failed');
  }

  /** Write a file's original bytes back over its cleanup placeholder. */
  async restoreOriginal(entry, blob) {
    const FilePickerImpl = this._getFilePicker();
    const extension = String(entry.filename || '').slice(String(entry.filename || '').lastIndexOf('.')).toLowerCase();
    const file = new File([blob], entry.filename, { type: blob?.type || resolveGeneratedCleanupMimeType(extension) });
    const upload = await FilePickerImpl.upload(
      entry.source,
      entry.parentTarget,
      file,
      Object.assign({}, entry.options || {}),
      { notify: false, filename: entry.filename }
    );
    const writtenPath = this._extractUploadPath(upload) || [entry.parentTarget, entry.filename].filter(Boolean).join('/');
    if (!writtenPath) throw new Error('Restore upload returned no path');
    this._logger.info('GeneratedCleanup.restore.success', { source: entry.source, target: entry.target, writtenPath });
    return writtenPath;
  }

  async uploadBackup(entry, blob, backupStamp) {
    const FilePickerImpl = this._getFilePicker();
    const backupDir = [GENERATED_CLEANUP_BACKUP_ROOT, backupStamp, entry.parentTarget].filter(Boolean).join('/');
    await this._ensureNestedDir(backupDir, entry);
    const file = new File([blob], entry.filename, { type: blob?.type || resolveGeneratedCleanupMimeType(entry.extension) });
    const upload = await FilePickerImpl.upload(
      entry.source,
      backupDir,
      file,
      Object.assign({}, entry.options || {}),
      { notify: false, filename: entry.filename }
    );
    const backupPath = this._extractUploadPath(upload) || [backupDir, entry.filename].filter(Boolean).join('/');
    if (!backupPath) throw new Error('Backup upload returned no path');
    return backupPath;
  }

  async overwriteWithPlaceholder(entry) {
    const FilePickerImpl = this._getFilePicker();
    const placeholder = await this._createPlaceholderFile(entry.filename, entry.extension);
    const upload = await FilePickerImpl.upload(
      entry.source,
      entry.parentTarget,
      placeholder,
      Object.assign({}, entry.options || {}),
      { notify: false, filename: entry.filename }
    );
    const writtenPath = this._extractUploadPath(upload) || [entry.parentTarget, entry.filename].filter(Boolean).join('/');
    if (!writtenPath) throw new Error('Overwrite upload returned no path');
    return writtenPath;
  }
}
