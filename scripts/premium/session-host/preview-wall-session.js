import {
  cloneWallDocumentSource,
  deleteWallDocuments,
  forgetWallCreationHistory,
  restoreWallDocuments
} from './wall-document-lifecycle.js';

const DEFAULT_LOG_PREFIX = '[fa-nexus][premium-preview-wall-session]';

const normalizeWallIds = (ids = []) => {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => String(id || '').trim()).filter(Boolean);
};

export class PreviewWallSession {
  constructor({
    logger = null,
    logPrefix = DEFAULT_LOG_PREFIX,
    deleteOptions = {},
    restoreOptions = {},
    onError = null
  } = {}) {
    this.logger = logger;
    this.logPrefix = logPrefix || DEFAULT_LOG_PREFIX;
    this.deleteOptions = deleteOptions && typeof deleteOptions === 'object' ? { ...deleteOptions } : {};
    this.restoreOptions = restoreOptions && typeof restoreOptions === 'object' ? { ...restoreOptions } : {};
    this.onError = typeof onError === 'function' ? onError : null;
    this.active = false;
    this.committed = false;
    this.previewWallIds = [];
    this.originalWalls = null;
    this.retiredOriginalWallIds = [];
  }

  begin() {
    this.active = true;
    this.committed = false;
    this.previewWallIds = [];
    this.originalWalls = null;
    this.retiredOriginalWallIds = [];
  }

  reset() {
    this.active = false;
    this.committed = false;
    this.previewWallIds = [];
    this.originalWalls = null;
  }

  getWallIds() {
    return [...this.previewWallIds];
  }

  isCommitted() {
    return !!this.committed;
  }

  markCommitted() {
    this.committed = true;
  }

  setPreviewWallIds(ids = []) {
    this.previewWallIds = normalizeWallIds(ids);
    forgetWallCreationHistory(this.previewWallIds);
    const activeIds = new Set(this.previewWallIds);
    this.retiredOriginalWallIds = this.getOriginalWallIds()
      .filter((id) => !activeIds.has(id));
  }

  clearOriginalWalls() {
    this.originalWalls = null;
    this.retiredOriginalWallIds = [];
  }

  getOriginalWallIds() {
    return normalizeWallIds(
      (Array.isArray(this.originalWalls) ? this.originalWalls : [])
        .map((source) => source?._id || source?.id)
    );
  }

  getReusableWallIds() {
    return Array.from(new Set([
      ...this.previewWallIds,
      ...this.retiredOriginalWallIds
    ]));
  }

  getRetiredOriginalWallIds() {
    return [...this.retiredOriginalWallIds];
  }

  appendOriginalWallSources(entries = []) {
    const capturedIds = new Set(this.getOriginalWallIds());
    const originals = Array.isArray(entries)
      ? entries
        .map((entry) => cloneWallDocumentSource(entry, {
          logger: this.logger,
          logPrefix: this.logPrefix
        }))
        .filter((source) => {
          const id = String(source?._id || source?.id || '').trim();
          if (!id || capturedIds.has(id)) return false;
          capturedIds.add(id);
          return true;
        })
      : [];
    if (!originals.length) return [];
    if (!this.originalWalls) this.originalWalls = [];
    this.originalWalls.push(...originals);
    return originals;
  }

  async captureOriginalWallEntries(entries = [], {
    deleteCode = 'existing.remove',
    throwOnSurvivors = false,
    survivorMessage = 'Unable to remove existing Foundry walls before edit'
  } = {}) {
    if (!Array.isArray(entries) || !entries.length) return [];
    this.appendOriginalWallSources(entries);
    const ids = entries.map((entry) => entry?.id).filter(Boolean);
    if (!ids.length) return [];
    const survivingIds = await this.deleteWalls(ids, deleteCode);
    if (survivingIds.length && throwOnSurvivors) {
      throw new Error(`${survivorMessage}: ${survivingIds.join(', ')}`);
    }
    return survivingIds;
  }

  async deleteWalls(ids = [], code = 'delete') {
    const result = await deleteWallDocuments(ids, {
      logger: this.logger,
      logPrefix: this.logPrefix,
      code,
      ...this.deleteOptions,
      // Session writes stay out of native Undo: Ctrl+Z must not recreate a discarded preview.
      documentDeleteOptions: { ...this.deleteOptions.documentDeleteOptions, isUndo: true }
    });
    const survivingIds = Array.isArray(result?.survivingIds) ? result.survivingIds : [];
    if (survivingIds.length && this.onError) {
      this.onError(`${code}.persisted`, new Error(`Foundry walls persisted after ${code}: ${survivingIds.join(', ')}`));
    }
    return survivingIds;
  }

  async deletePreviewWalls(code = 'preview.delete', { preserveOriginals = false } = {}) {
    if (!this.previewWallIds.length) return [];
    const originalIds = preserveOriginals ? new Set(this.getOriginalWallIds()) : null;
    const ids = this.previewWallIds.filter((id) => !originalIds?.has(id));
    this.previewWallIds = [];
    this.retiredOriginalWallIds = preserveOriginals ? this.getOriginalWallIds() : [];
    if (!ids.length) return [];
    return await this.deleteWalls(ids, code || 'preview.delete');
  }

  async restoreOriginalWalls() {
    if (!Array.isArray(this.originalWalls) || !this.originalWalls.length || !globalThis?.canvas?.scene) return { restored: false };
    const result = await restoreWallDocuments(this.originalWalls, {
      logger: this.logger,
      logPrefix: this.logPrefix,
      code: null,
      documentUpdateOptions: { ...this.restoreOptions, isUndo: true }
    });
    if (result?.error && this.onError) this.onError('restore.failed', result.error);
    return result;
  }

  async teardown({
    committed = false,
    discardOriginal = false,
    waitForIdle = null
  } = {}) {
    if (!this.active) {
      this.clearOriginalWalls();
      this.setPreviewWallIds([]);
      return;
    }
    this.active = false;
    if (typeof waitForIdle === 'function') await waitForIdle();
    if (committed) {
      this.clearOriginalWalls();
      this.setPreviewWallIds([]);
      return;
    }
    if (discardOriginal) {
      await this.deletePreviewWalls('preview.discard');
      this.clearOriginalWalls();
      this.setPreviewWallIds([]);
      return;
    }
    await this.deletePreviewWalls('preview.cleanup', { preserveOriginals: true });
    await this.restoreOriginalWalls();
    this.clearOriginalWalls();
    this.setPreviewWallIds([]);
  }
}

export default PreviewWallSession;
