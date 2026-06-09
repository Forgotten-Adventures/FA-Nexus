import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  browseFolderPickerWithFallbacks,
  getFilePickerClass,
  normalizePickedFolderPath as normalizePickedFolderPathWithContext,
  prepareFolderPickerContext
} from '../core/file-picker-folder-browser.js';
import { forgeIntegration } from '../core/forge-integration.js';
import { TileFlattenCanvasPreview } from './tile-flatten-canvas-preview.js';
import { resolveAutoChunking } from './tile-flatten-chunking.js';
import {
  appendStoragePath,
  buildGeneratedRoot,
  getConfiguredAssetsDir,
  resolveGeneratedSceneFolder,
  sanitizeStoragePathSegments
} from '../storage/generated-paths.js';
import { normalizeGeneratedFlattenRoot } from '../storage/generated-output-policy.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const EXPORT_SCOPE_LEVEL = 'level';
const EXPORT_SCOPE_SCENE = 'scene';
const MIDDLE_PLACEMENT_SEPARATE = 'separate';
const MIDDLE_PLACEMENT_BACKGROUND = 'background';
const MIDDLE_PLACEMENT_FOREGROUND = 'foreground';

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
    this._exportDefaults = {
      action: 'flatten',
      scope: EXPORT_SCOPE_LEVEL,
      splitLayers: false,
      chunked: false,
      middlePlacement: MIDDLE_PLACEMENT_SEPARATE
    };
    this.tiles = options.tiles || [];
    this._levelRanges = this._normalizeLevelRanges(options.levelRanges);
    this._currentLevelRange = this._normalizeLevelRange(options.currentLevelRange) || this._levelRanges[0] || null;
    this._previewBoundsResolver = typeof options.previewBoundsResolver === 'function'
      ? options.previewBoundsResolver
      : null;
    this._previewBounds = null;
    this._previewBoundsPending = null;
    this._previewBoundsPendingKey = null;
    this._previewBoundsRequestId = 0;
    this._previewBoundsTimer = null;
    this._inputRefs = null;
    this._outputDefaults = {};
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
      try { this.options.window.title = 'Flatten / Export Level'; } catch (_) {}
    }
  }

  static DEFAULT_OPTIONS = {
    id: 'fa-nexus-tile-flatten-dialog',
    tag: 'form',
    window: {
      frame: true,
      positioned: true,
      resizable: true,
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
    const defaultExportScope = this._normalizeExportScope(stored.exportScope);
    const defaultExportMiddlePlacement = this._normalizeMiddlePlacement(stored.exportMiddlePlacement);
    const exportActionStrings = this._getExportActionStrings(defaultExportAction, defaultExportScope);
    this._exportDefaults = {
      action: defaultExportAction,
      scope: defaultExportScope,
      splitLayers: defaultExportSplitLayers,
      chunked: defaultExportChunked,
      middlePlacement: defaultExportMiddlePlacement
    };
    this._outputDefaults = {};
    const estimated = this._estimateRenderBounds(defaultPPI, defaultPaddingSnap, defaultPaddingExtra);
    const isExport = this._mode === 'export';
    const pluralSuffix = tileCount !== 1;
    const dialogTitle = isExport
      ? 'Flatten / Export Level'
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
    const exportScopeIsScene = defaultExportScope === EXPORT_SCOPE_SCENE;
    const exportScopeIsLevel = !exportScopeIsScene;
    const defaultOutputAction = isExport ? defaultExportAction : 'flatten';
    const defaultOutputScope = isExport ? defaultExportScope : EXPORT_SCOPE_LEVEL;
    const defaultOutputName = this._getOutputDefaultsForAction(defaultOutputAction, defaultOutputScope).name;
    const defaultOutputFolder = this._getOutputDefaultsForAction(defaultOutputAction, defaultOutputScope).folder;

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
      defaultExportScope,
      defaultExportMiddlePlacement,
      exportActionIsExport,
      exportActionIsFlatten,
      exportScopeIsScene,
      exportScopeIsLevel,
      middlePlacementSeparate: defaultExportMiddlePlacement === MIDDLE_PLACEMENT_SEPARATE,
      middlePlacementBackground: defaultExportMiddlePlacement === MIDDLE_PLACEMENT_BACKGROUND,
      middlePlacementForeground: defaultExportMiddlePlacement === MIDDLE_PLACEMENT_FOREGROUND,
      exportActionHint: exportActionStrings.actionHint,
      exportSplitHint: exportActionStrings.splitHint,
      exportScopeHint: exportActionStrings.scopeHint,
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
    const exportScopeInputs = Array.from(this.element.querySelectorAll('input[name="flatten-export-scope"]'));
    const exportSplitInput = this.element.querySelector('#flatten-export-split');
    const exportMiddlePlacementInput = this.element.querySelector('#flatten-export-middle-placement');
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
      exportScopeInputs,
      exportSplitInput,
      exportMiddlePlacementInput,
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
    if (exportScopeInputs.length) {
      const desiredScope = context.defaultExportScope || EXPORT_SCOPE_LEVEL;
      let matched = false;
      for (const input of exportScopeInputs) {
        if (input?.value === desiredScope) {
          input.checked = true;
          matched = true;
          break;
        }
      }
      if (!matched) exportScopeInputs[0].checked = true;
    }
    if (exportSplitInput) exportSplitInput.checked = !!context.defaultExportSplitLayers;
    if (exportMiddlePlacementInput) exportMiddlePlacementInput.value = context.defaultExportMiddlePlacement || MIDDLE_PLACEMENT_SEPARATE;
    if (exportChunkInput) exportChunkInput.checked = !!context.defaultExportChunked;
    if (outputNameInput) outputNameInput.value = context.defaultOutputName || '';
    if (outputFolderInput) outputFolderInput.value = context.defaultOutputFolder || '';
    this._outputCustomized = { name: false, folder: false };
    this._updateExportActionUI(exportActionInputs, exportScopeInputs);
    this._updateExportSplitUI(exportSplitInput, exportMiddlePlacementInput);
    this._updateExportChunkHint(exportChunkInput, context.exportChunkHint);
    this._renderEffectiveOutputFolder(exportActionInputs, exportScopeInputs);
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
        const exportScope = this._readExportScope(exportScopeInputs);
        const exportSplitLayers = exportSplitInput
          ? !!exportSplitInput.checked
          : !!this._exportDefaults?.splitLayers;
        const exportMiddlePlacement = this._normalizeMiddlePlacement(
          exportMiddlePlacementInput?.value || this._exportDefaults?.middlePlacement
        );
        const exportChunked = exportChunkInput
          ? !!exportChunkInput.checked
          : !!this._exportDefaults?.chunked;
        const outputAction = this._getCurrentOutputAction(exportActionInputs);
        const outputScope = this._getCurrentOutputScope(exportScopeInputs);
        const outputDefaults = this._getOutputDefaultsForAction(outputAction, outputScope);
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
        if (outputCollision?.status === 'error') {
          ui?.notifications?.error?.(outputCollision.message || 'FA Nexus could not check the output folder for existing files.');
          return;
        }
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
          exportScope,
          exportSplitLayers,
          exportMiddlePlacement,
          exportChunked,
          outputFolder,
          outputAction,
          outputScope
        });
        this._resolve({
          ppi,
          quality,
          paddingSnap,
          paddingExtra,
          exportSplitLayers,
          exportMiddlePlacement,
          exportChunked,
          exportAction,
          exportScope,
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
        this._openOutputFolderPicker(outputFolderInput, exportActionInputs, exportScopeInputs).catch((error) => {
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
          this._updateExportActionUI(exportActionInputs, exportScopeInputs);
          this._syncOutputFieldsForAction(exportActionInputs, exportScopeInputs);
          this._renderEffectiveOutputFolder(exportActionInputs, exportScopeInputs);
          this._scheduleOutputCollisionCheck();
        });
      }
    }
    if (exportScopeInputs.length) {
      for (const input of exportScopeInputs) {
        input.addEventListener('change', () => {
          this._updateExportActionUI(exportActionInputs, exportScopeInputs);
          this._syncOutputFieldsForAction(exportActionInputs, exportScopeInputs);
          this._renderEffectiveOutputFolder(exportActionInputs, exportScopeInputs);
          this._scheduleOutputCollisionCheck();
        });
      }
    }
    if (exportSplitInput) {
      exportSplitInput.addEventListener('change', () => {
        this._updateExportSplitUI(exportSplitInput, exportMiddlePlacementInput);
        this._scheduleOutputCollisionCheck();
      });
    }
    if (exportMiddlePlacementInput) {
      exportMiddlePlacementInput.addEventListener('change', () => this._scheduleOutputCollisionCheck());
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
        this._syncOutputCustomizationState('name', exportActionInputs, exportScopeInputs);
        this._scheduleOutputCollisionCheck();
      });
      outputNameInput.addEventListener('change', () => {
        outputNameInput.value = this._sanitizeOutputBaseName(
          outputNameInput.value,
          this._getOutputDefaultsForAction(
            this._getCurrentOutputAction(exportActionInputs),
            this._getCurrentOutputScope(exportScopeInputs)
          ).name
        );
        this._syncOutputCustomizationState('name', exportActionInputs, exportScopeInputs);
        this._scheduleOutputCollisionCheck();
      });
    }
    if (outputFolderInput) {
      outputFolderInput.addEventListener('input', () => {
        this._syncOutputCustomizationState('folder', exportActionInputs, exportScopeInputs);
        this._renderEffectiveOutputFolder(exportActionInputs, exportScopeInputs);
        this._scheduleOutputCollisionCheck();
      });
      outputFolderInput.addEventListener('change', () => {
        outputFolderInput.value = this._normalizeOutputFolder(
          outputFolderInput.value,
          this._getOutputDefaultsForAction(
            this._getCurrentOutputAction(exportActionInputs),
            this._getCurrentOutputScope(exportScopeInputs)
          ).folder
        );
        this._syncOutputCustomizationState('folder', exportActionInputs, exportScopeInputs);
        this._renderEffectiveOutputFolder(exportActionInputs, exportScopeInputs);
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
    catch (error) {
      Logger.warn?.('TileFlattenDialog.dropShadowSetting.readFailed', { error: String(error?.message || error) });
      return true;
    }
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

  _normalizeExportScope(value) {
    return value === EXPORT_SCOPE_SCENE ? EXPORT_SCOPE_SCENE : EXPORT_SCOPE_LEVEL;
  }

  _normalizeMiddlePlacement(value) {
    if (value === MIDDLE_PLACEMENT_BACKGROUND) return MIDDLE_PLACEMENT_BACKGROUND;
    if (value === MIDDLE_PLACEMENT_FOREGROUND) return MIDDLE_PLACEMENT_FOREGROUND;
    return MIDDLE_PLACEMENT_SEPARATE;
  }

  _normalizeLevelRange(range) {
    if (!range || typeof range !== 'object') return null;
    return {
      level: range.level || null,
      levelId: String(range.levelId || range.level?.id || '').trim() || null,
      levelName: String(range.levelName || range.level?.name || '').trim(),
      bottom: Number.isFinite(Number(range.bottom ?? range.level?.elevation?.bottom))
        ? Number(range.bottom ?? range.level.elevation.bottom)
        : 0,
      top: Number.isFinite(Number(range.top ?? range.level?.elevation?.top))
        ? Number(range.top ?? range.level.elevation.top)
        : Infinity
    };
  }

  _normalizeLevelRanges(ranges) {
    return (Array.isArray(ranges) ? ranges : [])
      .map((range) => this._normalizeLevelRange(range))
      .filter(Boolean);
  }

  _getLevelRangeName(range) {
    return String(range?.levelName || range?.level?.name || range?.levelId || 'level').trim() || 'level';
  }

  _sanitizeOutputPart(value, fallback = 'item') {
    const fallbackText = String(fallback || 'item').trim() || 'item';
    let text = String(value ?? '').trim() || fallbackText;
    text = text.replace(/\.[^./\\]+$/, '');
    text = text.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-');
    text = text.replace(/\s+/g, '-').replace(/-+/g, '-').trim();
    text = text.replace(/^\.+/, '').replace(/[. ]+$/, '');
    return text || fallbackText;
  }

  _getExportActionStrings(action, scope = EXPORT_SCOPE_LEVEL) {
    const isExport = action === 'export';
    const isScene = scope === EXPORT_SCOPE_SCENE;
    const scopeLabel = isScene ? 'scene' : 'level';
    const titleScope = isScene ? 'Scene' : 'Level';
    return {
      description: isExport
        ? `Export ${scopeLabel} background/foreground images and tiles to WebP image(s) cropped to the scene borders.`
        : `Flatten ${scopeLabel} tiles into WebP tile(s) cropped to the scene borders.`,
      submitLabel: isExport ? `Export ${titleScope}` : `Flatten ${titleScope}`,
      submitIcon: isExport ? 'fa-file-export' : 'fa-compress-arrows-alt',
      actionHint: isExport
        ? `Exports WebP image output for the selected ${scopeLabel}.`
        : `Creates flattened tile output for the selected ${scopeLabel}. Originals can be deconstructed.`,
      scopeHint: isScene
        ? 'Runs each Levels range in sequence and appends each level name to generated files.'
        : 'Runs only the current viewed Levels range.',
      splitHint: isExport
        ? 'Background band, middle elevations, and foreground band are planned as separate outputs unless middle elevations are merged.'
        : 'Background band, middle elevations, and foreground band become separate flattened tiles unless middle elevations are merged.'
    };
  }

  _getCurrentOutputAction(exportActionInputs) {
    if (this._mode !== 'export') return 'flatten';
    return this._readExportAction(exportActionInputs);
  }

  _getCurrentOutputScope(exportScopeInputs) {
    if (this._mode !== 'export') return EXPORT_SCOPE_LEVEL;
    return this._readExportScope(exportScopeInputs);
  }

  _getOutputDefaultsForAction(action, scope = EXPORT_SCOPE_LEVEL) {
    const normalizedAction = action === 'export' ? 'export' : 'flatten';
    const normalizedScope = this._normalizeExportScope(scope);
    const key = `${normalizedAction}:${normalizedScope}`;
    if (!this._outputDefaults[key]) {
      const stored = this._readPersistedOptions();
      this._outputDefaults[key] = {
        name: this._buildSuggestedOutputName(normalizedAction, normalizedScope),
        folder: this._getStoredOutputFolder(normalizedAction, stored)
      };
    }
    return this._outputDefaults[key];
  }

  _buildSuggestedOutputName(action = 'flatten', scope = EXPORT_SCOPE_LEVEL) {
    const scenePart = this._sanitizeOutputPart(canvas?.scene?.name || canvas?.scene?.id || 'scene', 'scene');
    const scopePart = scope === EXPORT_SCOPE_SCENE
      ? 'all-levels'
      : this._sanitizeOutputPart(this._getLevelRangeName(this._currentLevelRange), 'level');
    const actionPart = action === 'export' ? 'export' : 'flattened';
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
    return `${scenePart}-${scopePart}-${actionPart}-${timestamp}-${rand}`;
  }

  _getStoredOutputFolder(action = 'flatten', stored = {}) {
    const key = action === 'export' ? 'exportOutputFolder' : 'flattenOutputFolder';
    const configured = String(stored?.[key] || '').trim();
    const assetsDir = this._getAssetsDir();
    if (configured) {
      if (action === 'flatten') {
        const normalizedConfigured = normalizeGeneratedFlattenRoot(configured, { assetsDir });
        if (normalizedConfigured) return normalizedConfigured;
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

  _normalizeCollisionBrowsePath(path) {
    let raw = String(path || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      raw = url.pathname || raw;
    } catch (_) {}
    raw = raw.split(/[?#]/, 1)[0] || raw;
    raw = raw.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    raw = raw.replace(/^(data|public|forgevtt|forge-bazaar|bazaar|s3):\/?/i, '');
    try { raw = decodeURI(raw); }
    catch (_) { try { raw = decodeURIComponent(raw); } catch (_) {} }
    return raw.replace(/\/+/g, '/').toLowerCase();
  }

  _splitCollisionBrowseTarget(target) {
    const normalized = this._normalizeCollisionBrowsePath(target);
    if (!normalized) return [];
    return normalized.split('/').filter(Boolean);
  }

  _isMissingOutputFolderBrowseError(error, source, target) {
    if (String(source || 'data').toLowerCase() !== 'data') return false;
    if (!this._splitCollisionBrowseTarget(target).length) return false;

    const message = String(error?.message || error || '');
    if (!message) return false;
    if (/permission|not permitted|not allowed|FILES_BROWSE/i.test(message)) return false;
    return /does not exist|not found|ENOENT|no such file or directory/i.test(message);
  }

  _directoryListIncludesCollisionChild(result, parentTarget, childSegment) {
    const dirs = result?.dirs;
    if (!Array.isArray(dirs)) return null;
    const expected = this._normalizeCollisionBrowsePath(appendStoragePath(parentTarget, childSegment));
    const child = this._normalizeCollisionBrowsePath(childSegment);
    for (const dir of dirs) {
      const normalized = this._normalizeCollisionBrowsePath(dir);
      if (!normalized) continue;
      if (normalized === expected || normalized === child) return true;
      if (expected && normalized.endsWith(`/${expected}`)) return true;
      if (child && normalized.endsWith(`/${child}`)) return true;
    }
    return false;
  }

  async _isMissingOutputFolderForCollisionCheck(FP, source, target, options = {}) {
    const segments = this._splitCollisionBrowseTarget(target);
    if (!segments.length) return false;

    for (let parentLength = segments.length - 1; parentLength >= 0; parentLength -= 1) {
      const parentTarget = segments.slice(0, parentLength).join('/');
      const childSegment = segments[parentLength];
      let parentResult = null;
      try {
        parentResult = await FP.browse(source, parentTarget, { ...options });
      } catch (error) {
        Logger.debug?.('TileFlatten.outputCollisionCheck.parentBrowseFailed', {
          source,
          parentTarget,
          target,
          error: String(error?.message || error)
        });
        continue;
      }

      const childExists = this._directoryListIncludesCollisionChild(parentResult, parentTarget, childSegment);
      if (childExists === null) {
        Logger.error?.('TileFlatten.outputCollisionCheck.parentBrowseMissingDirs', {
          source,
          parentTarget,
          target
        });
        return false;
      }

      Logger.debug?.('TileFlatten.outputCollisionCheck.parentBrowseResolved', {
        source,
        parentTarget,
        target,
        childSegment,
        childExists
      });
      return childExists === false;
    }

    return false;
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

  _renderEffectiveOutputFolder(exportActionInputs = null, exportScopeInputs = null) {
    const refs = this._inputRefs;
    const hintEl = refs?.outputEffectiveFolderEl;
    if (!hintEl) return;
    const action = this._getCurrentOutputAction(exportActionInputs || refs.exportActionInputs);
    const scope = this._getCurrentOutputScope(exportScopeInputs || refs.exportScopeInputs);
    const defaults = this._getOutputDefaultsForAction(action, scope);
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
    const outputScope = this._getCurrentOutputScope(refs.exportScopeInputs);
    const defaults = this._getOutputDefaultsForAction(outputAction, outputScope);
    const outputName = this._normalizeOutputName(refs.outputNameInput?.value, defaults.name);
    const outputFolder = this._normalizeOutputFolder(refs.outputFolderInput?.value, defaults.folder);
    const outputContext = this._resolveEffectiveOutputFolder(outputAction, outputFolder);
    const baseName = this._sanitizeOutputBaseName(outputName, defaults.name || this._buildSuggestedOutputName(outputAction, outputScope));
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
      const middlePlacement = this._normalizeMiddlePlacement(refs.exportMiddlePlacementInput?.value);
      const chunkRequested = !!refs.exportChunkInput?.checked;
      const exceedsMaxTexture = pixelWidth > maxTextureSize || pixelHeight > maxTextureSize;
      const useChunking = exceedsMaxTexture || (chunkRequested && !!autoChunkPlan.enabled);
      const suffixes = this._buildPlannedOutputSuffixes({
        scope: outputScope,
        splitLayers,
        middlePlacement
      });
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
      scope: outputScope,
      folder: String(outputContext.effectiveFolder || '').toLowerCase(),
      filenames: filenames.map((filename) => filename.toLowerCase())
    });

    return {
      key,
      action: outputAction,
      scope: outputScope,
      outputFolder,
      effectiveFolder: outputContext.effectiveFolder,
      baseName,
      filenames
    };
  }

  _buildPlannedOutputSuffixes({ scope = EXPORT_SCOPE_LEVEL, splitLayers = false, middlePlacement = MIDDLE_PLACEMENT_SEPARATE } = {}) {
    const levelRanges = scope === EXPORT_SCOPE_SCENE
      ? this._levelRanges
      : [this._currentLevelRange].filter(Boolean);
    const ranges = levelRanges.length ? levelRanges : [null];
    const layerSuffixes = splitLayers
      ? (middlePlacement === MIDDLE_PLACEMENT_SEPARATE
        ? ['background', 'middle', 'foreground']
        : ['background', 'foreground'])
      : [''];
    const suffixes = [];
    for (const range of ranges) {
      const levelSlug = scope === EXPORT_SCOPE_SCENE
        ? this._sanitizeOutputPart(this._getLevelRangeName(range), 'level')
        : '';
      for (const layer of layerSuffixes) {
        const parts = [];
        if (levelSlug) parts.push(levelSlug);
        if (layer) parts.push(layer);
        suffixes.push(parts.length ? `-${parts.join('-')}` : '');
      }
    }
    return suffixes;
  }

  _renderOutputCollisionState() {
    const refs = this._inputRefs;
    if (!refs) return;
    const statusEl = refs.outputStatusEl;
    const nameInput = refs.outputNameInput;
    const folderInput = refs.outputFolderInput;
    const state = this._outputCollisionState;

    if (nameInput) {
      const hasOutputProblem = state?.status === 'exists' || state?.status === 'error';
      nameInput.classList.toggle('is-warning', hasOutputProblem);
      nameInput.removeAttribute('aria-invalid');
      if (hasOutputProblem) nameInput.setAttribute('aria-invalid', 'true');
    }
    if (folderInput) {
      folderInput.classList.toggle('is-warning', state?.status === 'exists' || state?.status === 'error');
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
      return;
    }

    if (state.status === 'error') {
      statusEl.hidden = false;
      statusEl.classList.add('is-warning');
      statusEl.textContent = state.message || 'Unable to check existing outputs. Fix the output folder and try again.';
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

    const forgeReady = await forgeIntegration.initialize?.();
    if (forgeIntegration.isRunningOnForge?.() && forgeReady === false) {
      throw new Error('Forge storage context is unavailable; cannot check output collisions.');
    }

    const requestedFolder = String(folder || '').trim();
    const dirContext = forgeIntegration.resolveFilePickerContext(requestedFolder);
    const source = dirContext?.source || 'data';
    const target = dirContext?.target || '';
    const options = dirContext?.options || {};
    const FP = getFilePickerClass();
    if (!FP || typeof FP.browse !== 'function') {
      throw new Error('Foundry FilePicker browse runtime is unavailable; cannot check output collisions.');
    }

    let result = null;
    try {
      result = await FP.browse(source, target, { ...options });
    } catch (error) {
      const missingFolder = await this._isMissingOutputFolderForCollisionCheck(FP, source, target, options);
      if (missingFolder) {
        Logger.debug?.('TileFlatten.outputCollisionCheck.missingFolderClear', {
          source,
          target,
          folder: requestedFolder
        });
        return [];
      }
      if (this._isMissingOutputFolderBrowseError(error, source, target)) {
        Logger.debug?.('TileFlatten.outputCollisionCheck.missingFolderClearFromError', {
          source,
          target,
          folder: requestedFolder,
          error: String(error?.message || error)
        });
        return [];
      }
      const targetLabel = requestedFolder || target || source || 'output folder';
      throw new Error(`Unable to browse "${targetLabel}" before writing output files: ${String(error?.message || error)}`);
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
      Logger.error?.('TileFlatten.outputCollisionCheck.failed', {
        error: String(error?.message || error),
        folder: plan.effectiveFolder,
        filenames: plan.filenames
      });
      this._outputCollisionPending = null;
      this._outputCollisionPendingKey = null;
      const nextState = {
        ...plan,
        status: 'error',
        existing: [],
        message: 'Unable to check existing outputs. FA Nexus stopped to avoid overwriting files without confirmation.'
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
    } catch (error) {
      Logger.warn?.('TileFlatten.outputCollisionConfirm.dialogFailed', { error: String(error?.message || error) });
    }

    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      const lines = existing.slice(0, previewCount).map((entry) => `- ${entry.filename}`);
      if (remainder > 0) lines.push(`- and ${remainder} more`);
      return window.confirm(`${title}\n\nThese files already exist and will be overwritten:\n${lines.join('\n')}\n\nContinue?`);
    }

    Logger.error?.('TileFlatten.outputCollisionConfirm.unavailable', { existing: existing.map((entry) => entry.filename) });
    ui?.notifications?.error?.('FA Nexus could not open an overwrite confirmation dialog.');
    return false;
  }

  _syncOutputCustomizationState(kind, exportActionInputs = null, exportScopeInputs = null) {
    const refs = this._inputRefs;
    if (!refs) return;
    const action = this._getCurrentOutputAction(exportActionInputs || refs.exportActionInputs);
    const scope = this._getCurrentOutputScope(exportScopeInputs || refs.exportScopeInputs);
    const defaults = this._getOutputDefaultsForAction(action, scope);
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

  _syncOutputFieldsForAction(exportActionInputs = null, exportScopeInputs = null) {
    const refs = this._inputRefs;
    if (!refs) return;
    const action = this._getCurrentOutputAction(exportActionInputs || refs.exportActionInputs);
    const scope = this._getCurrentOutputScope(exportScopeInputs || refs.exportScopeInputs);
    const defaults = this._getOutputDefaultsForAction(action, scope);
    if (refs.outputNameInput && !this._outputCustomized.name) {
      refs.outputNameInput.value = defaults.name || '';
    }
    if (refs.outputFolderInput && !this._outputCustomized.folder) {
      refs.outputFolderInput.value = defaults.folder || '';
    }
    this._syncOutputCustomizationState('name', exportActionInputs || refs.exportActionInputs, exportScopeInputs || refs.exportScopeInputs);
    this._syncOutputCustomizationState('folder', exportActionInputs || refs.exportActionInputs, exportScopeInputs || refs.exportScopeInputs);
    this._renderEffectiveOutputFolder(exportActionInputs || refs.exportActionInputs, exportScopeInputs || refs.exportScopeInputs);
    this._scheduleOutputCollisionCheck();
  }

  _normalizePickedFolderPath(path, filePicker) {
    return normalizePickedFolderPathWithContext(path, filePicker, {
      normalizePath: sanitizeStoragePathSegments,
      resolveS3Url: true
    });
  }

  async _prepareOutputFilePicker(filePicker, folder) {
    return prepareFolderPickerContext(filePicker, {
      folder,
      logger: Logger,
      loggerTag: 'TileFlatten.outputFolderBrowse'
    });
  }

  async _openOutputFolderPicker(outputFolderInput, exportActionInputs, exportScopeInputs = null) {
    if (!outputFolderInput) return;
    const FilePickerClass = getFilePickerClass();
    if (!FilePickerClass) {
      throw new Error('FilePicker implementation unavailable');
    }
    const currentAction = this._getCurrentOutputAction(exportActionInputs);
    const currentScope = this._getCurrentOutputScope(exportScopeInputs);
    const currentDefaults = this._getOutputDefaultsForAction(currentAction, currentScope);
    const currentFolder = this._normalizeOutputFolder(outputFolderInput.value, currentDefaults.folder);
    const fp = new FilePickerClass({
      type: 'folder',
      title: 'Select Output Folder',
      callback: (path) => {
        outputFolderInput.value = this._normalizePickedFolderPath(path, fp);
        this._syncOutputCustomizationState('folder', exportActionInputs, exportScopeInputs);
        this._renderEffectiveOutputFolder(exportActionInputs, exportScopeInputs);
        this._scheduleOutputCollisionCheck();
      }
    });
    const context = await this._prepareOutputFilePicker(fp, currentFolder);
    const opened = await browseFolderPickerWithFallbacks(fp, {
      context,
      logger: Logger,
      loggerTag: 'TileFlatten.outputFolderBrowse'
    });
    if (opened?.opened) return;

    throw new Error('Unable to open file storage');
  }

  _readExportAction(exportActionInputs) {
    if (!Array.isArray(exportActionInputs) || exportActionInputs.length === 0) {
      return this._exportDefaults?.action === 'export' ? 'export' : 'flatten';
    }
    const selected = exportActionInputs.find((input) => input?.checked);
    return selected?.value === 'export' ? 'export' : 'flatten';
  }

  _readExportScope(exportScopeInputs) {
    if (!Array.isArray(exportScopeInputs) || exportScopeInputs.length === 0) {
      return this._normalizeExportScope(this._exportDefaults?.scope);
    }
    const selected = exportScopeInputs.find((input) => input?.checked);
    return this._normalizeExportScope(selected?.value);
  }

  _updateExportActionUI(exportActionInputs, exportScopeInputs = null) {
    if (this._mode !== 'export') return;
    const action = this._readExportAction(exportActionInputs);
    const scope = this._readExportScope(exportScopeInputs);
    const strings = this._getExportActionStrings(action, scope);
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
    const scopeHintEl = this.element?.querySelector?.('[data-export-scope-hint]');
    if (scopeHintEl && strings.scopeHint) {
      scopeHintEl.textContent = strings.scopeHint;
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

  _updateExportSplitUI(exportSplitInput, exportMiddlePlacementInput) {
    if (!exportMiddlePlacementInput) return;
    const enabled = !!exportSplitInput?.checked;
    exportMiddlePlacementInput.disabled = !enabled;
    const group = exportMiddlePlacementInput.closest?.('[data-export-middle-placement-group]');
    if (group) group.hidden = !enabled;
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
        exportScope: this._normalizeExportScope(options?.exportScope),
        exportSplitLayers: !!options?.exportSplitLayers,
        exportMiddlePlacement: this._normalizeMiddlePlacement(options?.exportMiddlePlacement),
        exportChunked: !!options?.exportChunked
      });
      const scope = this._normalizeExportScope(options?.outputScope);
      if (action === 'export') next.exportOutputFolder = options?.outputFolder || this._getOutputDefaultsForAction('export', scope).folder;
      else next.flattenOutputFolder = options?.outputFolder || this._getOutputDefaultsForAction('flatten', scope).folder;
      game?.settings?.set?.('fa-nexus', 'flattenOptions', next);
    } catch (_) {}
  }

  _normalizePaddingSnap(value) {
    const snap = String(value || 'none').toLowerCase();
    if (snap === 'half' || snap === 'full') return snap;
    return 'none';
  }
}
