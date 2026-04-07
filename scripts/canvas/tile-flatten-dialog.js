import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { forgeIntegration } from '../core/forge-integration.js';
import { TileFlattenCanvasPreview } from './tile-flatten-canvas-preview.js';
import { resolveAutoChunking } from './tile-flatten-chunking.js';
import {
  appendStoragePath,
  buildGeneratedRoot,
  getConfiguredAssetsDir,
  resolveGeneratedSceneFolder,
  sanitizeStoragePathSegments
} from '../core/generated-asset-paths.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Dialog for configuring tile flattening options
 */
export class TileFlattenDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    const cursorX = options.cursorX || window.innerWidth / 2;
    const cursorY = options.cursorY || window.innerHeight / 2;
    const left = Math.max(cursorX - 200, 20);
    const top = Math.max(cursorY - 150, 20);
    const mode = options.mode === 'export' ? 'export' : 'flatten';
    
    super({ position: { left, top, width: 400, height: 'auto' } });
    
    this._mode = mode;
    this._baseBounds = this._normalizeBaseBounds(options.baseBounds);
    this._exportDefaults = { action: 'flatten', splitLayers: false, chunked: false };
    this.tiles = options.tiles || [];
    this._previewBoundsResolver = typeof options.previewBoundsResolver === 'function'
      ? options.previewBoundsResolver
      : null;
    this._previewBounds = null;
    this._previewBoundsPending = null;
    this._previewBoundsPendingKey = null;
    this._previewBoundsRequestId = 0;
    this._previewBoundsTimer = null;
    this._inputRefs = null;
    this._outputDefaults = { flatten: { name: '', folder: '' }, export: { name: '', folder: '' } };
    this._outputCustomized = { name: false, folder: false };
    this._resolved = false;
    this._resolveCallback = null;
    this._canvasPreview = null;
    this._outputCollisionState = null;
    this._outputCollisionTimer = null;
    this._outputCollisionPending = null;
    this._outputCollisionPendingKey = null;
    this._outputCollisionRequestId = 0;

    if (this._mode === 'export') {
      try { this.options.window.title = 'Export / Flatten Scene'; } catch (_) {}
    }
  }

  static DEFAULT_OPTIONS = {
    id: 'fa-nexus-tile-flatten-dialog',
    tag: 'form',
    window: {
      frame: true,
      positioned: true,
      resizable: false,
      title: 'Flatten Tiles'
    },
    position: {
      width: 400,
      height: 'auto'
    }
  };

  static PARTS = {
    form: {
      template: 'modules/fa-nexus/templates/canvas/tile-flatten-dialog.hbs'
    }
  };

  async _prepareContext() {
    const tileCount = Array.isArray(this.tiles) ? this.tiles.length : 0;
    const stored = this._readPersistedOptions();
    const defaultPPI = Number.isFinite(Number(stored.ppi)) ? Number(stored.ppi) : 200;
    const defaultQuality = Number.isFinite(Number(stored.quality)) ? Number(stored.quality) : 0.85;
    const defaultPaddingSnap = this._normalizePaddingSnap(stored.paddingSnap);
    const defaultPaddingExtra = Number.isFinite(Number(stored.paddingExtra)) ? Number(stored.paddingExtra) : 0;
    const defaultExportSplitLayers = !!stored.exportSplitLayers;
    const defaultExportChunked = !!stored.exportChunked;
    const storedExportAction = stored.exportAction;
    const defaultExportAction = storedExportAction === 'export' ? 'export' : 'flatten';
    const exportActionStrings = this._getExportActionStrings(defaultExportAction);
    this._exportDefaults = {
      action: defaultExportAction,
      splitLayers: defaultExportSplitLayers,
      chunked: defaultExportChunked
    };
    this._outputDefaults = {
      flatten: {
        name: this._buildSuggestedOutputName('flatten'),
        folder: this._getStoredOutputFolder('flatten', stored)
      },
      export: {
        name: this._buildSuggestedOutputName('export'),
        folder: this._getStoredOutputFolder('export', stored)
      }
    };
    const estimated = this._estimateRenderBounds(defaultPPI, defaultPaddingSnap, defaultPaddingExtra);
    const isExport = this._mode === 'export';
    const pluralSuffix = tileCount !== 1;
    const dialogTitle = isExport
      ? 'Export / Flatten Scene'
      : `Flatten ${tileCount} tile${pluralSuffix ? 's' : ''}`;
    const dialogDescription = isExport
      ? exportActionStrings.description
      : 'Flatten the selected tiles into a WebP image while preserving FA Nexus metadata for future restoration.';
    const submitLabel = isExport ? exportActionStrings.submitLabel : 'Flatten Tiles';
    const submitIcon = isExport ? exportActionStrings.submitIcon : 'fa-compress-arrows-alt';
    const exportChunkHint = defaultExportChunked
      ? 'Auto-chunks large output.'
      : 'Creates a single image by default.';
    const exportActionIsExport = defaultExportAction === 'export';
    const exportActionIsFlatten = !exportActionIsExport;
    const defaultOutputAction = isExport ? defaultExportAction : 'flatten';
    const defaultOutputName = this._getOutputDefaultsForAction(defaultOutputAction).name;
    const defaultOutputFolder = this._getOutputDefaultsForAction(defaultOutputAction).folder;

    return {
      tileCount,
      isExport,
      dialogTitle,
      dialogDescription,
      submitLabel,
      submitIcon,
      defaultPPI,
      defaultQuality,
      defaultPaddingSnap,
      defaultPaddingExtra,
      defaultExportSplitLayers,
      defaultExportChunked,
      defaultExportAction,
      exportActionIsExport,
      exportActionIsFlatten,
      exportActionHint: exportActionStrings.actionHint,
      exportSplitHint: exportActionStrings.splitHint,
      exportChunkHint,
      defaultOutputName,
      defaultOutputFolder,
      snapNone: defaultPaddingSnap === 'none',
      snapHalf: defaultPaddingSnap === 'half',
      snapFull: defaultPaddingSnap === 'full',
      estimatedWidth: estimated?.pixelWidth || null,
      estimatedHeight: estimated?.pixelHeight || null,
      pluralSuffix
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);

    // Apply theme
    try {
      const body = document.body;
      const isDark = body.classList.contains('theme-dark');
      this.element.classList.toggle('fa-theme-dark', isDark);
      this.element.classList.toggle('fa-theme-light', !isDark);
    } catch (e) {}

    // Set default values
    const ppiInput = this.element.querySelector('#flatten-ppi');
    const qualityInput = this.element.querySelector('#flatten-quality');
    const paddingSnapInput = this.element.querySelector('#flatten-padding-snap');
    const paddingExtraInput = this.element.querySelector('#flatten-padding-extra');
    const exportActionInputs = Array.from(this.element.querySelectorAll('input[name="flatten-export-action"]'));
    const exportSplitInput = this.element.querySelector('#flatten-export-split');
    const exportChunkInput = this.element.querySelector('#flatten-export-chunk');
    const outputNameInput = this.element.querySelector('#flatten-output-name');
    const outputFolderInput = this.element.querySelector('#flatten-output-folder');
    const outputStatusEl = this.element.querySelector('[data-output-status]');
    const outputEffectiveFolderEl = this.element.querySelector('[data-output-effective-folder]');
    this._inputRefs = {
      ppiInput,
      qualityInput,
      paddingSnapInput,
      paddingExtraInput,
      exportActionInputs,
      exportSplitInput,
      exportChunkInput,
      outputNameInput,
      outputFolderInput,
      outputStatusEl,
      outputEffectiveFolderEl
    };
    if (ppiInput) ppiInput.value = context.defaultPPI;
    if (qualityInput) qualityInput.value = context.defaultQuality;
    if (paddingSnapInput) paddingSnapInput.value = context.defaultPaddingSnap || 'none';
    if (paddingExtraInput) paddingExtraInput.value = context.defaultPaddingExtra ?? 0;
    if (exportActionInputs.length) {
      const desiredAction = context.defaultExportAction || 'flatten';
      let matched = false;
      for (const input of exportActionInputs) {
        if (input?.value === desiredAction) {
          input.checked = true;
          matched = true;
          break;
        }
      }
      if (!matched) {
        exportActionInputs[0].checked = true;
      }
    }
    if (exportSplitInput) exportSplitInput.checked = !!context.defaultExportSplitLayers;
    if (exportChunkInput) exportChunkInput.checked = !!context.defaultExportChunked;
    if (outputNameInput) outputNameInput.value = context.defaultOutputName || '';
    if (outputFolderInput) outputFolderInput.value = context.defaultOutputFolder || '';
    this._outputCustomized = { name: false, folder: false };
    this._updateExportActionUI(exportActionInputs);
    this._updateExportChunkHint(exportChunkInput, context.exportChunkHint);
    this._renderEffectiveOutputFolder(exportActionInputs);
    this._updatePreview(ppiInput, paddingSnapInput, paddingExtraInput, exportChunkInput);
    this._scheduleOutputCollisionCheck();

    // Event handlers
    this.element.addEventListener('click', async (event) => {
      const action = event.target.closest('[data-action]')?.getAttribute('data-action');
      
      if (action === 'flatten') {
        event.preventDefault();
        const ppi = parseFloat(ppiInput?.value) || 200;
        const quality = parseFloat(qualityInput?.value) || 0.85;
        const paddingSnap = this._normalizePaddingSnap(paddingSnapInput?.value);
        const rawPaddingExtra = parseFloat(paddingExtraInput?.value);
        const paddingExtra = Number.isFinite(rawPaddingExtra) ? rawPaddingExtra : 0;
        const exportAction = this._readExportAction(exportActionInputs);
        const exportSplitLayers = exportSplitInput
          ? !!exportSplitInput.checked
          : !!this._exportDefaults?.splitLayers;
        const exportChunked = exportChunkInput
          ? !!exportChunkInput.checked
          : !!this._exportDefaults?.chunked;
        const outputAction = this._getCurrentOutputAction(exportActionInputs);
        const outputDefaults = this._getOutputDefaultsForAction(outputAction);
        const outputName = this._normalizeOutputName(
          outputNameInput?.value,
          outputDefaults.name
        );
        const outputFolder = this._normalizeOutputFolder(
          outputFolderInput?.value,
          outputDefaults.folder
        );
        
        // Validate
        if (ppi < 50 || ppi > 1000) {
          ui?.notifications?.warn?.('PPI must be between 50 and 1000');
          return;
        }
        if (quality < 0 || quality > 1) {
          ui?.notifications?.warn?.('Quality must be between 0 and 1');
          return;
        }
        const outputCollision = await this._ensureOutputCollisionCheck({ force: true });
        if (outputCollision?.existing?.length) {
          const confirmed = await this._confirmOverwriteExistingOutputs(outputCollision);
          if (!confirmed) return;
        }
        try {
          await this._ensurePreviewBounds(ppi);
        } catch (_) {}
        const previewBounds = this._previewBounds?.ppi === ppi ? this._previewBounds.bounds : null;
        const previewPpi = this._previewBounds?.ppi ?? null;

        this._persistOptions({
          ppi,
          quality,
          paddingSnap,
          paddingExtra,
          exportAction,
          exportSplitLayers,
          exportChunked,
          outputFolder,
          outputAction
        });
        this._resolve({
          ppi,
          quality,
          paddingSnap,
          paddingExtra,
          exportSplitLayers,
          exportChunked,
          exportAction,
          outputName,
          outputFolder,
          overwriteConfirmed: true,
          mode: this._mode,
          previewBounds,
          previewPpi,
          cancelled: false
        });
        this.close();
      } else if (action === 'pick-output-folder') {
        event.preventDefault();
        this._openOutputFolderPicker(outputFolderInput, exportActionInputs).catch((error) => {
          Logger.warn('TileFlatten.pickOutputFolder.failed', { error: String(error?.message || error) });
          ui?.notifications?.error?.(`Failed to open output folder picker: ${error?.message || error}`);
        });
      } else if (action === 'cancel') {
        event.preventDefault();
        this._resolve({ cancelled: true });
        this.close();
      }
    });

    // Prevent form submission
    this.element.addEventListener('submit', (event) => {
      event.preventDefault();
    });

    if (ppiInput) {
      ppiInput.addEventListener('input', () => {
        this._updatePreview(ppiInput, paddingSnapInput, paddingExtraInput, exportChunkInput);
        this._scheduleOutputCollisionCheck();
      });
      ppiInput.addEventListener('change', () => {
        this._updatePreview(ppiInput, paddingSnapInput, paddingExtraInput, exportChunkInput);
        this._scheduleOutputCollisionCheck();
      });
    }
    if (paddingSnapInput) {
      paddingSnapInput.addEventListener('change', () => {
        this._updatePreview(ppiInput, paddingSnapInput, paddingExtraInput, exportChunkInput);
        this._scheduleOutputCollisionCheck();
      });
    }
    if (paddingExtraInput) {
      paddingExtraInput.addEventListener('input', () => {
        this._updatePreview(ppiInput, paddingSnapInput, paddingExtraInput, exportChunkInput);
        this._scheduleOutputCollisionCheck();
      });
      paddingExtraInput.addEventListener('change', () => {
        this._updatePreview(ppiInput, paddingSnapInput, paddingExtraInput, exportChunkInput);
        this._scheduleOutputCollisionCheck();
      });
    }
    if (exportActionInputs.length) {
      for (const input of exportActionInputs) {
        input.addEventListener('change', () => {
          this._updateExportActionUI(exportActionInputs);
          this._syncOutputFieldsForAction(exportActionInputs);
          this._renderEffectiveOutputFolder(exportActionInputs);
          this._scheduleOutputCollisionCheck();
        });
      }
    }
    if (exportSplitInput) {
      exportSplitInput.addEventListener('change', () => this._scheduleOutputCollisionCheck());
    }
    if (exportChunkInput) {
      exportChunkInput.addEventListener('change', () => {
        this._updateExportChunkHint(exportChunkInput);
        this._updatePreview(ppiInput, paddingSnapInput, paddingExtraInput, exportChunkInput);
        this._scheduleOutputCollisionCheck();
      });
    }
    if (outputNameInput) {
      outputNameInput.addEventListener('input', () => {
        this._syncOutputCustomizationState('name', exportActionInputs);
        this._scheduleOutputCollisionCheck();
      });
      outputNameInput.addEventListener('change', () => {
        outputNameInput.value = this._sanitizeOutputBaseName(
          outputNameInput.value,
          this._getOutputDefaultsForAction(this._getCurrentOutputAction(exportActionInputs)).name
        );
        this._syncOutputCustomizationState('name', exportActionInputs);
        this._scheduleOutputCollisionCheck();
      });
    }
    if (outputFolderInput) {
      outputFolderInput.addEventListener('input', () => {
        this._syncOutputCustomizationState('folder', exportActionInputs);
        this._renderEffectiveOutputFolder(exportActionInputs);
        this._scheduleOutputCollisionCheck();
      });
      outputFolderInput.addEventListener('change', () => {
        outputFolderInput.value = this._normalizeOutputFolder(
          outputFolderInput.value,
          this._getOutputDefaultsForAction(this._getCurrentOutputAction(exportActionInputs)).folder
        );
        this._syncOutputCustomizationState('folder', exportActionInputs);
        this._renderEffectiveOutputFolder(exportActionInputs);
        this._scheduleOutputCollisionCheck();
      });
    }
  }

  _resolve(result) {
    if (this._resolved) return;
    this._resolved = true;
    if (this._resolveCallback) {
      this._resolveCallback(result);
    }
  }

  async render(force = false) {
    return new Promise((resolve) => {
      this._resolveCallback = resolve;
      super.render(force);
    });
  }

  _onClose() {
    if (!this._resolved) {
      this._resolve({ cancelled: true });
    }
    this._previewBoundsRequestId += 1;
    if (this._previewBoundsTimer) {
      clearTimeout(this._previewBoundsTimer);
      this._previewBoundsTimer = null;
    }
    if (this._outputCollisionTimer) {
      clearTimeout(this._outputCollisionTimer);
      this._outputCollisionTimer = null;
    }
    this._previewBoundsPending = null;
    this._previewBoundsPendingKey = null;
    this._outputCollisionPending = null;
    this._outputCollisionPendingKey = null;
    this._outputCollisionState = null;
    this._inputRefs = null;
    this._destroyCanvasPreview();
    super._onClose();
  }

  _estimateRenderBounds(ppi, paddingSnap = 'none', paddingExtra = 0) {
    try {
      const base = this._resolveBaseBounds(ppi);
      const bounds = base?.bounds;
      if (!bounds) return null;
      const gridSize = Math.max(1, Number(base.gridSize || canvas?.scene?.grid?.size || 100));
      const resolution = this._computeResolution(ppi, gridSize);
      const extraPadding = this._normalizePaddingExtra(paddingExtra, gridSize);
      const expanded = this._applyExtraPadding(bounds, extraPadding);
      const snapped = this._snapBounds(expanded, gridSize, paddingSnap);
      return {
        bounds,
        expanded,
        snapped,
        gridSize,
        resolution,
        pixelWidth: Math.max(1, Math.round(snapped.width * resolution)),
        pixelHeight: Math.max(1, Math.round(snapped.height * resolution))
      };
    } catch (_) {
      return null;
    }
  }

  _resolveBaseBounds(ppi) {
    const numericPpi = Number(ppi);
    if (Number.isFinite(numericPpi) && this._previewBounds?.bounds && this._previewBounds.ppi === numericPpi) {
      return {
        bounds: this._previewBounds.bounds,
        gridSize: this._previewBounds.gridSize
      };
    }
    if (this._baseBounds?.bounds) {
      return {
        bounds: this._baseBounds.bounds,
        gridSize: this._baseBounds.gridSize
      };
    }
    const bounds = this._computeShadowedBounds(this.tiles);
    if (!bounds) return null;
    return { bounds };
  }

  _computeBounds(tiles) {
    if (!Array.isArray(tiles) || !tiles.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const doc of tiles) {
      const x = Number(doc?.x) || 0;
      const y = Number(doc?.y) || 0;
      const width = Number(doc?.width) || 0;
      const height = Number(doc?.height) || 0;
      const rotation = Number(doc?.rotation) || 0;

      if (rotation !== 0) {
        const rad = rotation * (Math.PI / 180);
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const cx = x + width / 2;
        const cy = y + height / 2;
        const corners = [
          { x, y },
          { x: x + width, y },
          { x: x + width, y: y + height },
          { x, y: y + height }
        ];
        for (const corner of corners) {
          const dx = corner.x - cx;
          const dy = corner.y - cy;
          const rx = cx + (dx * cos) - (dy * sin);
          const ry = cy + (dx * sin) + (dy * cos);
          if (rx < minX) minX = rx;
          if (ry < minY) minY = ry;
          if (rx > maxX) maxX = rx;
          if (ry > maxY) maxY = ry;
        }
      } else {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x + width > maxX) maxX = x + width;
        if (y + height > maxY) maxY = y + height;
      }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null;
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  _updatePreview(ppiInput, paddingSnapInput, paddingExtraInput, exportChunkInput = null) {
    try {
      const ppi = parseFloat(ppiInput?.value) || 200;
      const paddingSnap = this._normalizePaddingSnap(paddingSnapInput?.value);
      const rawPaddingExtra = parseFloat(paddingExtraInput?.value);
      const paddingExtra = Number.isFinite(rawPaddingExtra) ? rawPaddingExtra : 0;
      this._schedulePreviewBounds(ppi);
      const paddingValueEl = this.element?.querySelector?.('[data-padding-extra-value]');
      if (paddingValueEl) {
        paddingValueEl.textContent = paddingExtra.toFixed(1);
      }
      const estimate = this._estimateRenderBounds(ppi, paddingSnap, paddingExtra);
      const debugEnabled = Logger?._isEnabled?.() === true;
      const chunkingAllowed = this._mode !== 'export' || !!exportChunkInput?.checked;
      let chunkMeta = null;
      if (debugEnabled && chunkingAllowed && estimate?.pixelWidth && estimate?.pixelHeight && estimate?.resolution) {
        const chunkPlan = resolveAutoChunking(estimate.pixelWidth, estimate.pixelHeight);
        if (chunkPlan?.enabled) {
          const chunkPixelWidth = Math.ceil(chunkPlan.chunkPixelWidth);
          const chunkPixelHeight = Math.ceil(chunkPlan.chunkPixelHeight);
          const chunkWorldWidth = chunkPixelWidth / estimate.resolution;
          const chunkWorldHeight = chunkPixelHeight / estimate.resolution;
          if (Number.isFinite(chunkWorldWidth) && Number.isFinite(chunkWorldHeight)
            && chunkWorldWidth > 0 && chunkWorldHeight > 0) {
            chunkMeta = {
              width: chunkWorldWidth,
              height: chunkWorldHeight,
              columns: chunkPlan.columns,
              rows: chunkPlan.rows
            };
          }
        }
      }
      const estimateEl = this.element?.querySelector?.('[data-flatten-estimate]');
      if (estimateEl) {
        if (estimate?.pixelWidth && estimate?.pixelHeight) {
          estimateEl.hidden = false;
          const textEl = estimateEl.querySelector('[data-flatten-estimate-text]') || estimateEl;
          if (debugEnabled && chunkMeta?.columns && chunkMeta?.rows) {
            textEl.textContent = `~${estimate.pixelWidth} x ${estimate.pixelHeight} px (${chunkMeta.columns} x ${chunkMeta.rows} chunks)`;
          } else {
            textEl.textContent = `~${estimate.pixelWidth} x ${estimate.pixelHeight} px`;
          }
        } else {
          estimateEl.hidden = true;
        }
      }

      const previewRoot = this.element?.querySelector?.('[data-flatten-preview]');
      if (!previewRoot) {
        this._updateCanvasPreview(estimate, chunkMeta, debugEnabled);
        return;
      }
      if (!estimate?.snapped || !estimate?.expanded) {
        previewRoot.hidden = true;
        this._updateCanvasPreview(null, null, debugEnabled);
        return;
      }

      const snapped = estimate.snapped;
      const expanded = estimate.expanded;
      const gridSize = Math.max(1, Number(estimate.gridSize || 0));

      const box = previewRoot.querySelector('.fa-nexus-flatten-preview__box');
      const snappedEl = previewRoot.querySelector('.fa-nexus-flatten-preview__snapped');
      const expandedEl = previewRoot.querySelector('.fa-nexus-flatten-preview__expanded');
      if (!box || !snappedEl || !expandedEl) {
        previewRoot.hidden = true;
        return;
      }

      previewRoot.hidden = false;
      const maxSize = 160;
      const scale = maxSize / Math.max(1, snapped.width, snapped.height);
      const width = Math.max(60, Math.round(snapped.width * scale));
      const height = Math.max(60, Math.round(snapped.height * scale));
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;

      snappedEl.style.width = `${width}px`;
      snappedEl.style.height = `${height}px`;
      snappedEl.style.left = '0px';
      snappedEl.style.top = '0px';

      const offsetX = Math.round((expanded.x - snapped.x) * scale);
      const offsetY = Math.round((expanded.y - snapped.y) * scale);
      expandedEl.style.width = `${Math.max(1, Math.round(expanded.width * scale))}px`;
      expandedEl.style.height = `${Math.max(1, Math.round(expanded.height * scale))}px`;
      expandedEl.style.left = `${offsetX}px`;
      expandedEl.style.top = `${offsetY}px`;

      const boundsLabel = previewRoot.querySelector('[data-flatten-preview-expanded]');
      const snappedLabel = previewRoot.querySelector('[data-flatten-preview-snapped]');
      if (boundsLabel && gridSize) {
        const w = expanded.width / gridSize;
        const h = expanded.height / gridSize;
        boundsLabel.textContent = `Current: ${w.toFixed(2)} x ${h.toFixed(2)} squares`;
      }
      if (snappedLabel && gridSize) {
        const w = snapped.width / gridSize;
        const h = snapped.height / gridSize;
        snappedLabel.textContent = `Snapped: ${w.toFixed(2)} x ${h.toFixed(2)} squares`;
      }
      this._updateCanvasPreview(estimate, chunkMeta, debugEnabled);
    } catch (_) {}
  }

  _updatePreviewFromInputs() {
    const refs = this._inputRefs;
    if (!refs) return;
    this._updatePreview(
      refs.ppiInput,
      refs.paddingSnapInput,
      refs.paddingExtraInput,
      refs.exportChunkInput
    );
  }

  _schedulePreviewBounds(ppi) {
    if (!this._previewBoundsResolver) return;
    const numericPpi = Number(ppi) || 200;
    if (this._previewBounds?.ppi === numericPpi) return;
    if (this._previewBoundsPendingKey === numericPpi) return;
    if (this._previewBoundsTimer) {
      clearTimeout(this._previewBoundsTimer);
    }
    this._previewBoundsTimer = setTimeout(() => {
      this._previewBoundsTimer = null;
      this._ensurePreviewBounds(numericPpi);
    }, 150);
  }

  async _ensurePreviewBounds(ppi) {
    if (!this._previewBoundsResolver) return;
    const numericPpi = Number(ppi) || 200;
    if (this._previewBounds?.ppi === numericPpi) return;
    if (this._previewBoundsPending && this._previewBoundsPendingKey === numericPpi) return;
    const requestId = ++this._previewBoundsRequestId;
    this._previewBoundsPendingKey = numericPpi;
    const tiles = Array.isArray(this.tiles) ? this.tiles : [];
    try {
      this._previewBoundsPending = Promise.resolve(
        this._previewBoundsResolver({ tiles, ppi: numericPpi })
      );
      const result = await this._previewBoundsPending;
      if (this._previewBoundsRequestId !== requestId) return;
      this._previewBoundsPending = null;
      this._previewBoundsPendingKey = null;
      if (result?.bounds) {
        this._previewBounds = {
          bounds: result.bounds,
          gridSize: result.gridSize ?? null,
          ppi: numericPpi
        };
      } else {
        this._previewBounds = null;
      }
      this._updatePreviewFromInputs();
    } catch (error) {
      if (this._previewBoundsRequestId !== requestId) return;
      this._previewBoundsPending = null;
      this._previewBoundsPendingKey = null;
      Logger.debug?.('TileFlatten.previewBounds.failed', { error: String(error?.message || error) });
    }
  }

  _computeResolution(ppi, gridSize) {
    const numericPPI = Math.max(10, Number(ppi) || 200);
    const numericGrid = Math.max(1, Number(gridSize) || 100);
    const resolution = numericPPI / numericGrid;
    return Math.max(0.1, Math.min(8, resolution));
  }

  _computeShadowedBounds(tiles) {
    if (!Array.isArray(tiles) || !tiles.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const doc of tiles) {
      const base = this._computeTileWorldBounds(doc);
      if (!base) continue;
      const margins = this._computeTileShadowMargins(doc);
      const expanded = this._expandBoundsWithMargins(base, margins);
      minX = Math.min(minX, expanded.x);
      minY = Math.min(minY, expanded.y);
      maxX = Math.max(maxX, expanded.x + expanded.width);
      maxY = Math.max(maxY, expanded.y + expanded.height);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null;
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  _computeTileShadowMargins(doc) {
    const margins = { left: 0, right: 0, top: 0, bottom: 0 };
    if (!doc || !this._hasShadowEnabled(doc)) return margins;
    if (!this._isDropShadowEnabled()) return margins;
    const alphaValue = this._readShadowValue(doc, 'shadowAlpha');
    const alpha = Number(alphaValue);
    if (alphaValue !== undefined && Number.isFinite(alpha) && alpha <= 0) return margins;
    const dilation = Math.max(0, this._readShadowNumeric(doc, 'shadowDilation'));
    const blur = Math.max(0, this._readShadowNumeric(doc, 'shadowBlur'));
    const blurMargin = this._computeShadowBlurMargin(blur);
    const extra = dilation + blurMargin;
    const offset = this._resolveShadowOffset(doc);
    margins.left = Math.max(0, extra - offset.x);
    margins.right = Math.max(0, extra + offset.x);
    margins.top = Math.max(0, extra - offset.y);
    margins.bottom = Math.max(0, extra + offset.y);
    return margins;
  }

  _computeShadowBlurMargin(blur) {
    const numeric = Math.max(0, Number(blur) || 0);
    if (!numeric) return 0;
    return Math.ceil((numeric * 2) + 1);
  }

  _computeTileWorldBounds(doc) {
    try {
      const placeable = doc?.object;
      const mesh = placeable?.mesh || placeable?.sprite;
      if (mesh) {
        const width = Math.abs(Number(mesh.width || 0));
        const height = Math.abs(Number(mesh.height || 0));
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
          const anchorX = Number(mesh.anchor?.x ?? 0);
          const anchorY = Number(mesh.anchor?.y ?? 0);
          const posX = Number(mesh.position?.x ?? mesh.x ?? 0);
          const posY = Number(mesh.position?.y ?? mesh.y ?? 0);
          const rotation = Number.isFinite(Number(mesh.rotation))
            ? Number(mesh.rotation)
            : (Number(mesh.angle || 0) * (Math.PI / 180));
          const left = -width * anchorX;
          const top = -height * anchorY;
          const right = left + width;
          const bottom = top + height;
          if (!rotation) {
            return {
              x: posX + left,
              y: posY + top,
              width,
              height
            };
          }
          const cos = Math.cos(rotation);
          const sin = Math.sin(rotation);
          const corners = [
            { x: left, y: top },
            { x: right, y: top },
            { x: right, y: bottom },
            { x: left, y: bottom }
          ];
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          for (const corner of corners) {
            const rx = (corner.x * cos) - (corner.y * sin) + posX;
            const ry = (corner.x * sin) + (corner.y * cos) + posY;
            minX = Math.min(minX, rx);
            minY = Math.min(minY, ry);
            maxX = Math.max(maxX, rx);
            maxY = Math.max(maxY, ry);
          }
          if (Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)) {
            return {
              x: minX,
              y: minY,
              width: maxX - minX,
              height: maxY - minY
            };
          }
        }
      }
      const bounds = placeable?.bounds;
      if (bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height) && bounds.width > 0 && bounds.height > 0) {
        return {
          x: Number(bounds.x) || 0,
          y: Number(bounds.y) || 0,
          width: Number(bounds.width) || 0,
          height: Number(bounds.height) || 0
        };
      }
      const x = Number(doc?.x) || 0;
      const y = Number(doc?.y) || 0;
      const width = Number(doc?.width) || 0;
      const height = Number(doc?.height) || 0;
      const rotation = Number(doc?.rotation) || 0;
      if (!rotation) {
        return { x, y, width, height };
      }
      const rad = rotation * (Math.PI / 180);
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const cx = x + width / 2;
      const cy = y + height / 2;
      const corners = [
        { x, y },
        { x: x + width, y },
        { x: x + width, y: y + height },
        { x, y: y + height }
      ];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const corner of corners) {
        const dx = corner.x - cx;
        const dy = corner.y - cy;
        const rx = cx + (dx * cos) - (dy * sin);
        const ry = cy + (dx * sin) + (dy * cos);
        if (rx < minX) minX = rx;
        if (ry < minY) minY = ry;
        if (rx > maxX) maxX = rx;
        if (ry > maxY) maxY = ry;
      }
      return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
      };
    } catch (_) {
      return null;
    }
  }

  _expandBoundsWithMargins(bounds, margins) {
    const left = Math.max(0, Number(margins?.left) || 0);
    const right = Math.max(0, Number(margins?.right) || 0);
    const top = Math.max(0, Number(margins?.top) || 0);
    const bottom = Math.max(0, Number(margins?.bottom) || 0);
    return {
      x: bounds.x - left,
      y: bounds.y - top,
      width: bounds.width + left + right,
      height: bounds.height + top + bottom
    };
  }

  _applyExtraPadding(bounds, extraPadding) {
    const pad = Number(extraPadding) || 0;
    if (!pad) return bounds;
    const width = bounds.width + pad * 2;
    const height = bounds.height + pad * 2;
    if (width <= 1 || height <= 1) return bounds;
    return {
      x: bounds.x - pad,
      y: bounds.y - pad,
      width,
      height
    };
  }

  _snapBounds(bounds, gridSize, paddingSnap) {
    const snap = this._normalizePaddingSnap(paddingSnap);
    if (snap === 'none') return bounds;
    const increment = snap === 'half' ? (Number(gridSize) / 2) : Number(gridSize);
    if (!Number.isFinite(increment) || increment <= 0) return bounds;
    const minX = Math.floor(bounds.x / increment) * increment;
    const minY = Math.floor(bounds.y / increment) * increment;
    const maxX = Math.ceil((bounds.x + bounds.width) / increment) * increment;
    const maxY = Math.ceil((bounds.y + bounds.height) / increment) * increment;
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  _normalizePaddingExtra(value, gridSize) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric === 0) return 0;
    const size = Math.max(1, Number(gridSize) || 100);
    return numeric * size;
  }

  _isDropShadowEnabled() {
    try { return !!game?.settings?.get?.('fa-nexus', 'assetDropShadow'); }
    catch (_) { return true; }
  }

  _hasShadowEnabled(doc) {
    try {
      return !!doc?.getFlag?.('fa-nexus', 'shadow');
    } catch (_) {
      const flags = doc?.flags?.['fa-nexus'];
      return !!(flags && flags.shadow);
    }
  }

  _readShadowNumeric(doc, key) {
    try {
      const value = doc?.getFlag?.('fa-nexus', key);
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : 0;
    } catch (_) {
      return 0;
    }
  }

  _readShadowValue(doc, key) {
    try {
      const value = doc?.getFlag?.('fa-nexus', key);
      if (value !== undefined && value !== null) return value;
    } catch (_) {}
    try {
      const flags = doc?.flags?.['fa-nexus'] || doc?._source?.flags?.['fa-nexus'];
      if (flags && Object.prototype.hasOwnProperty.call(flags, key)) return flags[key];
    } catch (_) {}
    return undefined;
  }

  _resolveShadowOffset(doc) {
    const rawX = this._readShadowValue(doc, 'shadowOffsetX');
    const rawY = this._readShadowValue(doc, 'shadowOffsetY');
    const offsetX = Number(rawX);
    const offsetY = Number(rawY);
    if (Number.isFinite(offsetX) && Number.isFinite(offsetY)) return { x: offsetX, y: offsetY };
    const distRaw = this._readShadowValue(doc, 'shadowOffsetDistance');
    const angleRaw = this._readShadowValue(doc, 'shadowOffsetAngle');
    const distance = Number.isFinite(Number(distRaw)) ? Number(distRaw) : 0;
    const angle = Number.isFinite(Number(angleRaw)) ? Number(angleRaw) : 135;
    const radians = this._normalizeAngle(angle) * (Math.PI / 180);
    return {
      x: Math.cos(radians) * distance,
      y: Math.sin(radians) * distance
    };
  }

  _normalizeAngle(angle) {
    const numeric = Number(angle);
    if (!Number.isFinite(numeric)) return 0;
    let normalized = numeric % 360;
    if (normalized < 0) normalized += 360;
    return normalized;
  }

  _ensureCanvasPreview() {
    if (!this._canvasPreview) this._canvasPreview = new TileFlattenCanvasPreview();
    return this._canvasPreview;
  }

  _destroyCanvasPreview() {
    try { this._canvasPreview?.destroy?.(); } catch (_) {}
    this._canvasPreview = null;
  }

  _updateCanvasPreview(estimate, chunkMeta = null, debugEnabled = false) {
    if (!estimate?.snapped || !estimate?.expanded) {
      this._canvasPreview?.clear?.();
      return;
    }
    const preview = this._ensureCanvasPreview();
    preview.update({
      expanded: estimate.expanded,
      snapped: estimate.snapped,
      chunk: debugEnabled ? chunkMeta : null
    });
  }

  _getExportActionStrings(action) {
    const isExport = action === 'export';
    return {
      description: isExport
        ? 'Export the scene background/foreground images and tiles to a WebP image cropped to the scene borders.'
        : 'Flatten the scene tiles into WebP tile(s) cropped to the scene borders.',
      submitLabel: isExport ? 'Export Scene' : 'Flatten Scene',
      submitIcon: isExport ? 'fa-file-export' : 'fa-compress-arrows-alt',
      actionHint: isExport
        ? 'Exports a WebP image of the scene.'
        : 'Creates tiles without scene background/foreground images. Originals can be deconstructed.',
      splitHint: isExport
        ? 'Background image + tiles below, foreground image + tiles above.'
        : 'Tiles below foreground elevation in one tile, tiles at/above in another.'
    };
  }

  _getCurrentOutputAction(exportActionInputs) {
    if (this._mode !== 'export') return 'flatten';
    return this._readExportAction(exportActionInputs);
  }

  _getOutputDefaultsForAction(action) {
    return action === 'export'
      ? (this._outputDefaults.export || { name: '', folder: '' })
      : (this._outputDefaults.flatten || { name: '', folder: '' });
  }

  _buildSuggestedOutputName(action = 'flatten') {
    const prefix = action === 'export' ? 'scene-export' : 'flattened';
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
    return `${prefix}-${timestamp}-${rand}`;
  }

  _getStoredOutputFolder(action = 'flatten', stored = {}) {
    const key = action === 'export' ? 'exportOutputFolder' : 'flattenOutputFolder';
    const configured = String(stored?.[key] || '').trim();
    const assetsDir = this._getAssetsDir();
    if (configured) {
      if (action === 'flatten') {
        const legacyDefault = appendStoragePath(assetsDir, 'flattened');
        const previousDefault = appendStoragePath(appendStoragePath(assetsDir, 'generated'), 'flattened');
        const currentDefault = buildGeneratedRoot('flattened', { assetsDir });
        const normalizedConfigured = sanitizeStoragePathSegments(configured).replace(/\/+$/, '');
        if (
          normalizedConfigured === legacyDefault.replace(/\/+$/, '')
          || normalizedConfigured === previousDefault.replace(/\/+$/, '')
        ) return currentDefault;
      }
      return sanitizeStoragePathSegments(configured);
    }
    if (action === 'export') return appendStoragePath(assetsDir, 'exports');
    return buildGeneratedRoot('flattened', { assetsDir });
  }

  _getAssetsDir() {
    return getConfiguredAssetsDir({ moduleId: 'fa-nexus' });
  }

  _normalizeOutputName(value, fallback = '') {
    const trimmed = String(value ?? '').trim();
    if (trimmed) return trimmed;
    return String(fallback || '').trim();
  }

  _normalizeOutputFolder(value, fallback = '') {
    const trimmed = String(value ?? '').trim();
    if (trimmed) return sanitizeStoragePathSegments(trimmed);
    return sanitizeStoragePathSegments(String(fallback || '').trim());
  }

  _sanitizeOutputBaseName(value, fallbackBase = '') {
    const fallback = String(fallbackBase || '').trim() || 'flattened';
    let name = String(value ?? '').trim();
    if (!name) name = fallback;
    name = name.replace(/\.[^./\\]+$/, '');
    name = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-');
    name = name.replace(/\s+/g, '-').replace(/-+/g, '-').trim();
    name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');
    return name || fallback;
  }

  _buildOutputFilename(baseName, suffix = '') {
    const safeBase = this._sanitizeOutputBaseName(baseName, this._buildSuggestedOutputName('flatten'));
    const cleanSuffix = String(suffix || '').trim();
    return `${safeBase}${cleanSuffix}.webp`;
  }

  _buildChunkOutputFilenames(baseName, pixelWidth, pixelHeight, options = {}) {
    const width = Number(pixelWidth);
    const height = Number(pixelHeight);
    const chunkPixelWidth = Number(options?.chunkPixelWidth);
    const chunkPixelHeight = Number(options?.chunkPixelHeight);
    const suffix = String(options?.suffix || '');
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return [];
    if (!Number.isFinite(chunkPixelWidth) || chunkPixelWidth <= 0) return [];
    if (!Number.isFinite(chunkPixelHeight) || chunkPixelHeight <= 0) return [];
    const columns = Math.max(1, Math.ceil(width / chunkPixelWidth));
    const rows = Math.max(1, Math.ceil(height / chunkPixelHeight));
    const filenames = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        filenames.push(this._buildOutputFilename(baseName, `${suffix}-r${row + 1}-c${col + 1}`));
      }
    }
    return filenames;
  }

  _getMaxTextureSize(renderer) {
    try {
      const gl = renderer?.gl;
      if (gl) {
        const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        if (Number.isFinite(max)) return max;
      }
    } catch (_) {}
    try {
      const optionMax = renderer?.options?.maxTextureSize;
      if (Number.isFinite(optionMax)) return optionMax;
    } catch (_) {}
    try {
      const system = renderer?.textures ?? renderer?.texture;
      const max = system?.GC?.maxSize ?? system?.maxSize;
      if (Number.isFinite(max)) return max;
    } catch (_) {}
    return 8192;
  }

  _extractFilenameFromPath(path) {
    const raw = String(path || '').trim();
    if (!raw) return '';
    let filenamePath = raw;
    try {
      const url = new URL(raw);
      filenamePath = url.pathname || raw;
    } catch (_) {}
    filenamePath = filenamePath.split(/[?#]/, 1)[0] || filenamePath;
    filenamePath = filenamePath.split('/').pop() || '';
    try {
      filenamePath = decodeURIComponent(filenamePath);
    } catch (_) {}
    return filenamePath;
  }

  _escapeHTML(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  _resolveEffectiveOutputFolder(action, folder) {
    const outputRoot = String(folder || '').trim();
    if (action === 'export') {
      return {
        outputRoot,
        effectiveFolder: outputRoot,
        sceneOwned: false,
        worldId: '',
        sceneId: ''
      };
    }
    const generatedPath = resolveGeneratedSceneFolder('flattened', { root: outputRoot });
    return {
      outputRoot: generatedPath.root,
      effectiveFolder: generatedPath.folder,
      sceneOwned: true,
      worldId: generatedPath.worldId,
      sceneId: generatedPath.sceneId
    };
  }

  _renderEffectiveOutputFolder(exportActionInputs = null) {
    const refs = this._inputRefs;
    const hintEl = refs?.outputEffectiveFolderEl;
    if (!hintEl) return;
    const action = this._getCurrentOutputAction(exportActionInputs || refs.exportActionInputs);
    const defaults = this._getOutputDefaultsForAction(action);
    const outputFolder = this._normalizeOutputFolder(refs?.outputFolderInput?.value, defaults.folder);
    if (!outputFolder) {
      hintEl.hidden = true;
      hintEl.textContent = '';
      return;
    }
    const resolved = this._resolveEffectiveOutputFolder(action, outputFolder);
    hintEl.hidden = false;
    hintEl.textContent = action === 'export'
      ? `Uploads directly to ${resolved.effectiveFolder}`
      : `Uploads to ${resolved.effectiveFolder} (world/scene appended automatically)`;
  }

  _buildCurrentOutputPlan() {
    const refs = this._inputRefs;
    if (!refs) return null;
    const outputAction = this._getCurrentOutputAction(refs.exportActionInputs);
    const defaults = this._getOutputDefaultsForAction(outputAction);
    const outputName = this._normalizeOutputName(refs.outputNameInput?.value, defaults.name);
    const outputFolder = this._normalizeOutputFolder(refs.outputFolderInput?.value, defaults.folder);
    const outputContext = this._resolveEffectiveOutputFolder(outputAction, outputFolder);
    const baseName = this._sanitizeOutputBaseName(outputName, defaults.name || this._buildSuggestedOutputName(outputAction));
    const ppi = parseFloat(refs.ppiInput?.value) || 200;
    const paddingSnap = this._normalizePaddingSnap(refs.paddingSnapInput?.value);
    const rawPaddingExtra = parseFloat(refs.paddingExtraInput?.value);
    const paddingExtra = Number.isFinite(rawPaddingExtra) ? rawPaddingExtra : 0;
    const estimate = this._estimateRenderBounds(ppi, paddingSnap, paddingExtra);
    const maxTextureSize = this._getMaxTextureSize(canvas?.app?.renderer);
    const pixelWidth = Number(estimate?.pixelWidth) || 0;
    const pixelHeight = Number(estimate?.pixelHeight) || 0;
    const autoChunkPlan = (pixelWidth > 0 && pixelHeight > 0)
      ? resolveAutoChunking(pixelWidth, pixelHeight, { maxTextureSize })
      : { enabled: false, chunkPixelWidth: 0, chunkPixelHeight: 0 };
    let filenames = [];

    if (this._mode === 'export') {
      const splitLayers = !!refs.exportSplitInput?.checked;
      const chunkRequested = !!refs.exportChunkInput?.checked;
      const exceedsMaxTexture = pixelWidth > maxTextureSize || pixelHeight > maxTextureSize;
      const useChunking = exceedsMaxTexture || (chunkRequested && !!autoChunkPlan.enabled);
      const suffixes = splitLayers ? ['-background', '-foreground'] : [''];
      filenames = useChunking
        ? suffixes.flatMap((suffix) => this._buildChunkOutputFilenames(baseName, pixelWidth, pixelHeight, {
          suffix,
          chunkPixelWidth: autoChunkPlan.chunkPixelWidth,
          chunkPixelHeight: autoChunkPlan.chunkPixelHeight
        }))
        : suffixes.map((suffix) => this._buildOutputFilename(baseName, suffix));
    } else {
      filenames = autoChunkPlan.enabled
        ? this._buildChunkOutputFilenames(baseName, pixelWidth, pixelHeight, {
          chunkPixelWidth: autoChunkPlan.chunkPixelWidth,
          chunkPixelHeight: autoChunkPlan.chunkPixelHeight
        })
        : [this._buildOutputFilename(baseName)];
    }

    if (!filenames.length) filenames = [this._buildOutputFilename(baseName)];

    const key = JSON.stringify({
      action: outputAction,
      folder: String(outputContext.effectiveFolder || '').toLowerCase(),
      filenames: filenames.map((filename) => filename.toLowerCase())
    });

    return {
      key,
      action: outputAction,
      outputFolder,
      effectiveFolder: outputContext.effectiveFolder,
      baseName,
      filenames
    };
  }

  _renderOutputCollisionState() {
    const refs = this._inputRefs;
    if (!refs) return;
    const statusEl = refs.outputStatusEl;
    const nameInput = refs.outputNameInput;
    const folderInput = refs.outputFolderInput;
    const state = this._outputCollisionState;

    if (nameInput) {
      nameInput.classList.toggle('is-warning', state?.status === 'exists');
      nameInput.removeAttribute('aria-invalid');
      if (state?.status === 'exists') nameInput.setAttribute('aria-invalid', 'true');
    }
    if (folderInput) {
      folderInput.classList.toggle('is-warning', state?.status === 'exists');
    }
    if (!statusEl) return;

    statusEl.hidden = true;
    statusEl.textContent = '';
    statusEl.classList.remove('is-warning', 'is-checking');
    if (!state || state.status === 'idle' || state.status === 'clear') return;

    if (state.status === 'checking') {
      statusEl.hidden = false;
      statusEl.classList.add('is-checking');
      statusEl.textContent = 'Checking existing outputs...';
      return;
    }

    if (state.status === 'exists') {
      const count = Array.isArray(state.existing) ? state.existing.length : 0;
      const first = count ? state.existing[0]?.filename : '';
      statusEl.hidden = false;
      statusEl.classList.add('is-warning');
      statusEl.textContent = count <= 1
        ? `Existing output found: ${first}`
        : `${count} planned output files already exist in this folder and will be overwritten on confirmation.`;
    }
  }

  _setOutputCollisionState(state) {
    this._outputCollisionState = state;
    this._renderOutputCollisionState();
  }

  _scheduleOutputCollisionCheck() {
    if (this._outputCollisionTimer) {
      clearTimeout(this._outputCollisionTimer);
    }
    this._outputCollisionTimer = setTimeout(() => {
      this._outputCollisionTimer = null;
      this._ensureOutputCollisionCheck();
    }, 180);
  }

  async _findExistingOutputFiles(folder, filenames) {
    const wanted = new Map();
    for (const filename of Array.isArray(filenames) ? filenames : []) {
      const normalized = String(filename || '').trim();
      if (!normalized) continue;
      wanted.set(normalized.toLowerCase(), normalized);
    }
    if (!wanted.size) return [];

    try {
      await forgeIntegration.initialize?.();
    } catch (_) {}

    const requestedFolder = String(folder || '').trim();
    const dirContext = forgeIntegration.resolveFilePickerContext(requestedFolder);
    const source = dirContext?.source || 'data';
    const target = dirContext?.target || '';
    const options = dirContext?.options || {};
    const FP = foundry?.applications?.apps?.FilePicker?.implementation
      ?? foundry?.applications?.apps?.FilePicker
      ?? globalThis.FilePicker?.implementation
      ?? globalThis.FilePicker;
    if (!FP || typeof FP.browse !== 'function') return [];

    let result = null;
    try {
      result = await FP.browse(source, target, { ...options });
    } catch (_) {
      return [];
    }

    const existing = [];
    const seen = new Set();
    for (const filePath of result?.files || []) {
      const filename = this._extractFilenameFromPath(filePath);
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

  async _ensureOutputCollisionCheck({ force = false } = {}) {
    const plan = this._buildCurrentOutputPlan();
    if (!plan) {
      this._setOutputCollisionState({ status: 'idle' });
      return this._outputCollisionState;
    }
    if (!force && this._outputCollisionState?.key === plan.key && this._outputCollisionState?.status !== 'checking') {
      return this._outputCollisionState;
    }
    if (!force && this._outputCollisionPending && this._outputCollisionPendingKey === plan.key) {
      return this._outputCollisionPending;
    }

    const requestId = ++this._outputCollisionRequestId;
    this._outputCollisionPendingKey = plan.key;
    this._setOutputCollisionState({
      ...plan,
      status: 'checking',
      existing: []
    });

    const pending = (async () => {
      const existing = await this._findExistingOutputFiles(plan.effectiveFolder, plan.filenames);
      if (this._outputCollisionRequestId !== requestId) return this._outputCollisionState;
      const nextState = {
        ...plan,
        status: existing.length ? 'exists' : 'clear',
        existing
      };
      this._outputCollisionPending = null;
      this._outputCollisionPendingKey = null;
      this._setOutputCollisionState(nextState);
      return nextState;
    })().catch((error) => {
      if (this._outputCollisionRequestId !== requestId) return this._outputCollisionState;
      Logger.debug?.('TileFlatten.outputCollisionCheck.failed', { error: String(error?.message || error) });
      this._outputCollisionPending = null;
      this._outputCollisionPendingKey = null;
      const nextState = {
        ...plan,
        status: 'clear',
        existing: []
      };
      this._setOutputCollisionState(nextState);
      return nextState;
    });

    this._outputCollisionPending = pending;
    return pending;
  }

  async _confirmOverwriteExistingOutputs(collisionState) {
    const existing = Array.isArray(collisionState?.existing) ? collisionState.existing : [];
    if (!existing.length) return true;

    const outputAction = collisionState?.action === 'export' ? 'export' : 'flatten';
    const title = outputAction === 'export'
      ? 'Overwrite Existing Export Files?'
      : 'Overwrite Existing Flatten Files?';
    const previewCount = Math.min(existing.length, 8);
    const previewItems = existing
      .slice(0, previewCount)
      .map((entry) => `<li><code>${this._escapeHTML(entry.filename)}</code></li>`)
      .join('');
    const remainder = existing.length - previewCount;
    const followup = remainder > 0
      ? `<p>And ${remainder} more file${remainder === 1 ? '' : 's'}.</p>`
      : '';
    const content = [
      '<p>The following files already exist and will be overwritten:</p>',
      `<ul>${previewItems}</ul>`,
      followup,
      '<p>Continue?</p>'
    ].join('');

    try {
      const DialogV2 = foundry?.applications?.api?.DialogV2;
      if (DialogV2?.confirm) {
        return !!await DialogV2.confirm({
          window: { title },
          modal: true,
          content,
          yes: {
            label: 'Overwrite',
            icon: 'fas fa-file-import'
          },
          no: {
            label: 'Cancel'
          },
          defaultYes: false
        });
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
    } catch (_) {}

    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      const lines = existing.slice(0, previewCount).map((entry) => `- ${entry.filename}`);
      if (remainder > 0) lines.push(`- and ${remainder} more`);
      return window.confirm(`${title}\n\nThese files already exist and will be overwritten:\n${lines.join('\n')}\n\nContinue?`);
    }

    return true;
  }

  _syncOutputCustomizationState(kind, exportActionInputs = null) {
    const refs = this._inputRefs;
    if (!refs) return;
    const action = this._getCurrentOutputAction(exportActionInputs || refs.exportActionInputs);
    const defaults = this._getOutputDefaultsForAction(action);
    if (kind === 'name') {
      const current = String(refs.outputNameInput?.value || '').trim();
      this._outputCustomized.name = current !== String(defaults.name || '').trim();
      return;
    }
    if (kind === 'folder') {
      const current = String(refs.outputFolderInput?.value || '').trim();
      this._outputCustomized.folder = current !== String(defaults.folder || '').trim();
    }
  }

  _syncOutputFieldsForAction(exportActionInputs = null) {
    const refs = this._inputRefs;
    if (!refs) return;
    const action = this._getCurrentOutputAction(exportActionInputs || refs.exportActionInputs);
    const defaults = this._getOutputDefaultsForAction(action);
    if (refs.outputNameInput && !this._outputCustomized.name) {
      refs.outputNameInput.value = defaults.name || '';
    }
    if (refs.outputFolderInput && !this._outputCustomized.folder) {
      refs.outputFolderInput.value = defaults.folder || '';
    }
    this._syncOutputCustomizationState('name', exportActionInputs || refs.exportActionInputs);
    this._syncOutputCustomizationState('folder', exportActionInputs || refs.exportActionInputs);
    this._renderEffectiveOutputFolder(exportActionInputs || refs.exportActionInputs);
    this._scheduleOutputCollisionCheck();
  }

  _normalizePickedFolderPath(path, filePicker) {
    const result = String(path ?? '').trim();
    if (!result) return '';
    const source = String(filePicker?.activeSource || '').toLowerCase();
    const hasPrefix = /^[a-z0-9+.-]+:/i.test(result);
    const clean = result.replace(/^\/+/, '').replace(/\/+$/, '');
    if (source === 'data') return sanitizeStoragePathSegments(clean);
    if (source === 's3') {
      if (/^https?:\/\//i.test(result)) {
        const resolved = forgeIntegration.resolveFilePickerContext(result);
        const bucketFromUrl = String(resolved?.options?.bucket || '').trim();
        const targetFromUrl = String(resolved?.target || '').trim();
        if (bucketFromUrl) return sanitizeStoragePathSegments(targetFromUrl ? `s3:${bucketFromUrl}/${targetFromUrl}` : `s3:${bucketFromUrl}`);
      }
      const bucket = String(filePicker?.source?.bucket || filePicker?.sources?.s3?.bucket || filePicker?.options?.bucket || '').trim();
      if (bucket) return sanitizeStoragePathSegments(clean ? `s3:${bucket}/${clean}` : `s3:${bucket}`);
      return sanitizeStoragePathSegments(clean ? `s3:${clean}` : 's3:');
    }
    if (!hasPrefix && source) {
      const normalizedSource = source === 'bazaar' ? 'forge-bazaar' : source;
      return sanitizeStoragePathSegments(clean ? `${normalizedSource}:${clean}` : `${normalizedSource}:`);
    }
    return sanitizeStoragePathSegments(result);
  }

  async _prepareOutputFilePicker(filePicker, folder) {
    try {
      await forgeIntegration.initialize?.();
    } catch (_) {}
    const context = forgeIntegration.resolveFilePickerContext(folder);
    if (context?.source === 'forgevtt') {
      try {
        const handler = (app, html) => {
          if (app !== filePicker) return;
          Hooks.off('renderFilePicker', handler);
          try { app.activeSource = 'forgevtt'; } catch (_) {}
          const root = html && typeof html === 'object' && 'length' in html ? html[0] || null : html;
          if (!root) return;
          const forgeTab = root.querySelector('[data-tab="forgevtt"]');
          if (forgeTab) {
            forgeTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          }
          setTimeout(() => {
            try {
              const select = root.querySelector('select[name="bucket"]');
              const selectValue = context?.options?.bucketKey ?? context?.options?.bucket ?? null;
              if (select && selectValue !== null && select.value !== String(selectValue)) {
                select.value = String(selectValue);
                select.dispatchEvent(new Event('change', { bubbles: true }));
              }
            } catch (_) {}
          }, 75);
        };
        Hooks.once('renderFilePicker', handler);
      } catch (_) {}
    }
    return context;
  }

  async _openOutputFolderPicker(outputFolderInput, exportActionInputs) {
    if (!outputFolderInput) return;
    const FilePickerBase = foundry?.applications?.apps?.FilePicker ?? globalThis.FilePicker;
    const FilePickerClass = FilePickerBase?.implementation ?? FilePickerBase ?? globalThis.FilePicker;
    if (!FilePickerClass) {
      throw new Error('FilePicker implementation unavailable');
    }
    const currentAction = this._getCurrentOutputAction(exportActionInputs);
    const currentDefaults = this._getOutputDefaultsForAction(currentAction);
    const currentFolder = this._normalizeOutputFolder(outputFolderInput.value, currentDefaults.folder);
    const fp = new FilePickerClass({
      type: 'folder',
      title: 'Select Output Folder',
      callback: (path) => {
        outputFolderInput.value = this._normalizePickedFolderPath(path, fp);
        this._syncOutputCustomizationState('folder', exportActionInputs);
        this._renderEffectiveOutputFolder(exportActionInputs);
        this._scheduleOutputCollisionCheck();
      }
    });
    const context = await this._prepareOutputFilePicker(fp, currentFolder);
    const fallbackSource = 'data';
    const attempts = [];
    if (context?.source) {
      attempts.push({
        source: context.source,
        target: context.target || '',
        options: context.options || {}
      });
    }
    if (!attempts.length || attempts[0].source !== fallbackSource) {
      attempts.push({ source: fallbackSource, target: '', options: {} });
    }

    for (const attempt of attempts) {
      const { source, target, options } = attempt;
      if (!source) continue;
      try {
        if (!fp.sources[source]) {
          fp.sources[source] = { target: '' };
        } else if (typeof fp.sources[source] !== 'object') {
          fp.sources[source] = { target: '' };
        }
        const sourceConfig = fp.sources[source];
        sourceConfig.target = target ?? sourceConfig.target ?? '';
        if (options && typeof options === 'object') {
          if (options.bucket !== undefined) sourceConfig.bucket = options.bucket;
          if (options.bucketKey !== undefined) sourceConfig.bucketKey = options.bucketKey;
          if (options.buckets !== undefined) sourceConfig.buckets = options.buckets;
        }
        fp.activeSource = source;
        if (options && typeof options === 'object' && Object.keys(options).length) {
          fp.options = Object.assign({}, fp.options || {}, options);
        }
        await fp.browse(target || undefined, Object.assign({}, options));
        return;
      } catch (error) {
        Logger.warn('TileFlatten.outputFolderBrowse.failed', { source, error: String(error?.message || error) });
      }
    }

    throw new Error('Unable to open file storage');
  }

  _readExportAction(exportActionInputs) {
    if (!Array.isArray(exportActionInputs) || exportActionInputs.length === 0) {
      return this._exportDefaults?.action === 'export' ? 'export' : 'flatten';
    }
    const selected = exportActionInputs.find((input) => input?.checked);
    return selected?.value === 'export' ? 'export' : 'flatten';
  }

  _updateExportActionUI(exportActionInputs) {
    if (this._mode !== 'export') return;
    const action = this._readExportAction(exportActionInputs);
    const strings = this._getExportActionStrings(action);
    const descriptionEl = this.element?.querySelector?.('[data-dialog-description]');
    if (descriptionEl && strings.description) {
      descriptionEl.textContent = strings.description;
    }
    const actionHintEl = this.element?.querySelector?.('[data-export-action-hint]');
    if (actionHintEl && strings.actionHint) {
      actionHintEl.textContent = strings.actionHint;
    }
    const splitHintEl = this.element?.querySelector?.('[data-export-split-hint]');
    if (splitHintEl && strings.splitHint) {
      splitHintEl.textContent = strings.splitHint;
    }
    const submitLabelEl = this.element?.querySelector?.('[data-submit-label]');
    if (submitLabelEl && strings.submitLabel) {
      submitLabelEl.textContent = strings.submitLabel;
    }
    const submitIconEl = this.element?.querySelector?.('[data-submit-icon]');
    if (submitIconEl && strings.submitIcon) {
      submitIconEl.classList.remove('fa-file-export', 'fa-compress-arrows-alt');
      submitIconEl.classList.add(strings.submitIcon);
    }
  }

  _updateExportChunkHint(exportChunkInput, fallbackText = null) {
    const hintEl = this.element?.querySelector?.('[data-export-chunk-hint]');
    if (!hintEl) return;
    const enabled = !!exportChunkInput?.checked;
    const text = enabled
      ? 'Auto-chunks large output.'
      : (fallbackText || 'Creates a single image by default.');
    hintEl.textContent = text;
  }

  _normalizeBaseBounds(value) {
    if (!value || typeof value !== 'object') return null;
    const base = value.bounds && typeof value.bounds === 'object' ? value.bounds : value;
    const x = Number(base.x);
    const y = Number(base.y);
    const width = Number(base.width);
    const height = Number(base.height);
    if (![x, y, width, height].every(Number.isFinite)) return null;
    if (width <= 0 || height <= 0) return null;
    const rawGrid = Number(value.gridSize ?? base.gridSize);
    const gridSize = Number.isFinite(rawGrid) && rawGrid > 0 ? rawGrid : null;
    return {
      bounds: { x, y, width, height },
      gridSize
    };
  }

  _readPersistedOptions() {
    try {
      const stored = game?.settings?.get?.('fa-nexus', 'flattenOptions');
      if (stored && typeof stored === 'object') return stored;
    } catch (_) {}
    return {};
  }

  _persistOptions(options) {
    try {
      const stored = this._readPersistedOptions();
      const action = options?.outputAction === 'export' ? 'export' : 'flatten';
      const next = Object.assign({}, stored, {
        ppi: options?.ppi,
        quality: options?.quality,
        paddingSnap: options?.paddingSnap,
        paddingExtra: options?.paddingExtra,
        exportAction: options?.exportAction,
        exportSplitLayers: !!options?.exportSplitLayers,
        exportChunked: !!options?.exportChunked
      });
      if (action === 'export') next.exportOutputFolder = options?.outputFolder || this._getOutputDefaultsForAction('export').folder;
      else next.flattenOutputFolder = options?.outputFolder || this._getOutputDefaultsForAction('flatten').folder;
      game?.settings?.set?.('fa-nexus', 'flattenOptions', next);
    } catch (_) {}
  }

  _normalizePaddingSnap(value) {
    const snap = String(value || 'none').toLowerCase();
    if (snap === 'half' || snap === 'full') return snap;
    return 'none';
  }
}
