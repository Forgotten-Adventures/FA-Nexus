import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { GeneratedCleanupService } from './generated-cleanup-service.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function summarizeList(values, limit = 4) {
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!list.length) return 'None';
  if (list.length <= limit) return list.join(', ');
  const shown = list.slice(0, limit).join(', ');
  return `${shown} and ${list.length - limit} more`;
}

export class GeneratedCleanupDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    super(options);
    this._service = options.service instanceof GeneratedCleanupService
      ? options.service
      : new GeneratedCleanupService();
    this._report = null;
    this._busy = false;
    this._busyLabel = '';
    this._error = '';
    this._backupFirst = this._readBackupPreference();
  }

  static DEFAULT_OPTIONS = {
    id: 'fa-nexus-generated-cleanup-dialog',
    classes: ['fa-nexus-generated-cleanup-window'],
    tag: 'section',
    window: {
      frame: true,
      positioned: true,
      resizable: true,
      icon: 'fas fa-broom',
      title: 'Generated Cleanup'
    },
    position: {
      width: 980,
      height: 760
    }
  };

  static PARTS = {
    content: {
      template: 'modules/fa-nexus/templates/cleanup/generated-cleanup-dialog.hbs'
    }
  };

  _readBackupPreference() {
    try {
      return game?.settings?.get?.('fa-nexus', 'generatedCleanupBackupFirst') !== false;
    } catch (_) {
      return true;
    }
  }

  _formatUnusedEntries(entries) {
    return (Array.isArray(entries) ? entries : []).map((entry) => {
      const status = String(entry?.markStatus || '').trim();
      return {
        category: entry?.category || 'unknown',
        path: entry?.path || entry?.target || '',
        source: entry?.source || '',
        filename: entry?.filename || '',
        backupPath: entry?.backupPath || '',
        markError: entry?.markError || '',
        hasBackupPath: !!entry?.backupPath,
        hasMarkStatus: !!status,
        statusLabel: status === 'marked' ? 'Marked' : (status === 'skipped' ? 'Skipped' : 'Pending'),
        statusClass: status === 'marked' ? 'is-marked' : (status === 'skipped' ? 'is-skipped' : 'is-pending')
      };
    });
  }

  _formatMissingEntries(entries) {
    return (Array.isArray(entries) ? entries : []).map((entry) => ({
      category: entry?.category || 'unknown',
      path: entry?.path || entry?.target || '',
      count: Number(entry?.count || 0),
      originsLabel: summarizeList(entry?.origins),
      refKindsLabel: summarizeList(entry?.refKinds),
      sceneNamesLabel: summarizeList(entry?.sceneNames)
    }));
  }

  _formatSkippedEntries(entries) {
    return (Array.isArray(entries) ? entries : []).map((entry) => ({
      category: entry?.category || '',
      path: entry?.path || entry?.target || '',
      stage: entry?.stage || 'scan',
      reason: entry?.reason || 'unknown',
      error: entry?.error || '',
      refKind: entry?.refKind || '',
      sceneName: entry?.sceneName || ''
    }));
  }

  async _prepareContext() {
    const summary = this._report?.summary || {
      directLiveRefs: 0,
      deconstructLiveRefs: 0,
      uniqueLiveFiles: 0,
      rootsScanned: 0,
      scannedFiles: 0,
      scannedMaskFiles: 0,
      scannedFlattenedFiles: 0,
      unusedMasks: 0,
      unusedFlattened: 0,
      missingRefs: 0,
      skipped: 0,
      markedCount: 0,
      markSkippedCount: 0
    };
    const unusedMasks = this._formatUnusedEntries(this._report?.unusedMasks);
    const unusedFlattened = this._formatUnusedEntries(this._report?.unusedFlattened);
    const missingRefs = this._formatMissingEntries(this._report?.missingRefs);
    const skipped = this._formatSkippedEntries(this._report?.skipped);
    const scope = this._report?.scope || {};
    const roots = (Array.isArray(this._report?.roots) ? this._report.roots : []).map((root) => ({
      source: root?.source || '',
      target: root?.target || '',
      categoriesLabel: summarizeList(root?.categories),
      reasonsLabel: summarizeList(root?.reasons)
    }));
    const hasReport = !!this._report;
    const totalUnused = unusedMasks.length + unusedFlattened.length;
    const scopeWarning = String(scope?.warning || '').trim();

    return {
      busy: this._busy,
      busyLabel: this._busyLabel,
      error: this._error,
      hasError: !!this._error,
      hasScopeWarning: !!scopeWarning,
      scopeWarning,
      backupFirst: this._backupFirst,
      hasReport,
      hasUnused: totalUnused > 0,
      hasUnusedMasks: unusedMasks.length > 0,
      hasUnusedFlattened: unusedFlattened.length > 0,
      hasMissingRefs: missingRefs.length > 0,
      hasSkipped: skipped.length > 0,
      hasRoots: roots.length > 0,
      canCopy: totalUnused > 0 && !this._busy,
      canMark: totalUnused > 0 && !this._busy && scope?.markingAllowed !== false,
      unusedMasksTitle: 'Unused Masks',
      unusedFlattenedTitle: 'Unused Flattened Files',
      unusedMasksMetricLabel: 'Unused Masks',
      unusedFlattenedMetricLabel: 'Unused Flattened',
      summary,
      roots,
      unusedMasks,
      unusedFlattened,
      missingRefs,
      skipped
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    if (!root) return;

    const backupToggle = root.querySelector('[data-backup-first]');
    if (backupToggle) {
      backupToggle.checked = this._backupFirst;
      backupToggle.addEventListener('change', (event) => {
        this._backupFirst = !!event.currentTarget?.checked;
        game?.settings?.set?.('fa-nexus', 'generatedCleanupBackupFirst', this._backupFirst)
          ?.catch?.((error) => Logger.error('GeneratedCleanupDialog.backupPreference.writeFailed', { error: String(error?.message || error) }));
      });
    }

    root.addEventListener('click', async (event) => {
      const action = event.target.closest('[data-action]')?.dataset?.action;
      if (!action) return;
      event.preventDefault();
      if (action === 'scan') {
        await this._runScan();
        return;
      }
      if (action === 'copy-unused') {
        await this._copyUnusedPaths();
        return;
      }
      if (action === 'mark-unused') {
        await this._runMarkUnused();
        return;
      }
      if (action === 'close') {
        this.close({ force: true });
      }
    });
  }

  async _setBusy(isBusy, label = '') {
    this._busy = !!isBusy;
    this._busyLabel = isBusy ? String(label || 'Working...') : '';
    await this.render(true);
  }

  async _runScan() {
    if (this._busy) return;
    this._error = '';
    await this._setBusy(true, 'Scanning generated files across all scenes...');
    try {
      this._report = await this._service.scan();
      const summary = this._report?.summary || {};
      const scopeWarning = String(this._report?.scope?.warning || '').trim();
      const baseMessage = `Cleanup scan complete. ${summary.unusedMasks || 0} unused masks, ${summary.unusedFlattened || 0} unused flattened files, ${summary.missingRefs || 0} missing references.`;
      ui?.notifications?.info?.(scopeWarning ? `${baseMessage} ${scopeWarning}` : baseMessage);
    } catch (error) {
      this._error = String(error?.message || error);
      Logger.error('GeneratedCleanupDialog.scan.failed', { error: this._error });
      ui?.notifications?.error?.(`Generated cleanup scan failed: ${this._error}`);
    } finally {
      await this._setBusy(false);
    }
  }

  _buildUnusedClipboardText() {
    const unused = [
      ...(Array.isArray(this._report?.unusedMasks) ? this._report.unusedMasks : []),
      ...(Array.isArray(this._report?.unusedFlattened) ? this._report.unusedFlattened : [])
    ];
    return unused.map((entry) => String(entry?.path || entry?.target || '').trim()).filter(Boolean).join('\n');
  }

  async _copyUnusedPaths() {
    const text = this._buildUnusedClipboardText();
    if (!text) {
      ui?.notifications?.warn?.('No unused generated files are available to copy.');
      return;
    }

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      ui?.notifications?.info?.('Copied unused generated file paths to the clipboard.');
    } catch (error) {
      const message = String(error?.message || error);
      Logger.error('GeneratedCleanupDialog.copy.failed', { error: message });
      ui?.notifications?.error?.(`Failed to copy unused paths: ${message}`);
    }
  }

  async _runMarkUnused() {
    if (this._busy) return;
    const unusedCount = (this._report?.unusedMasks?.length || 0) + (this._report?.unusedFlattened?.length || 0);
    if (!this._report || unusedCount === 0) {
      ui?.notifications?.warn?.('Run a cleanup scan first. No unused generated files are available to mark.');
      return;
    }
    if (this._report?.scope?.markingAllowed === false) {
      const warning = String(this._report?.scope?.warning || '').trim()
        || 'Mark Unused is disabled because these generated roots are not isolated to the current world.';
      Logger.warn('GeneratedCleanupDialog.mark.blocked', { warning });
      ui?.notifications?.warn?.(warning);
      return;
    }

    this._error = '';
    await this._setBusy(true, this._backupFirst ? 'Backing up and marking unused generated files...' : 'Marking unused generated files...');
    try {
      this._report = await this._service.markUnused(this._report, { backupFirst: this._backupFirst });
      const summary = this._report?.summary || {};
      ui?.notifications?.info?.(
        `Mark complete. ${summary.markedCount || 0} files marked, ${summary.markSkippedCount || 0} skipped.`
      );
    } catch (error) {
      this._error = String(error?.message || error);
      Logger.error('GeneratedCleanupDialog.mark.failed', { error: this._error });
      ui?.notifications?.error?.(`Failed to mark unused files: ${this._error}`);
    } finally {
      await this._setBusy(false);
    }
  }
}
