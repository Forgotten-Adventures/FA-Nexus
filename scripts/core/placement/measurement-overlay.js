import { PlacementOverlay } from './placement-overlay.js';

const DEFAULT_GRID_SIZE = 200;
const DEFAULT_MIN_WIDTH = 112;
const DEFAULT_MIN_HEIGHT = 32;
const DEFAULT_MARGIN = 14;
const DEFAULT_POINTER_OFFSET = 18;
const DEFAULT_UNIT_LABEL = 'sq';

export function getSceneGridSize(fallback = DEFAULT_GRID_SIZE) {
  const size = Number(canvas?.scene?.grid?.size);
  return Number.isFinite(size) && size > 0 ? size : fallback;
}

export function formatMeasurementNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  const abs = Math.abs(numeric);
  let digits = 2;
  if (abs >= 100) digits = 0;
  else if (abs >= 10) digits = 1;
  else if (abs < 1) digits = 3;
  const normalized = Number(numeric.toFixed(digits));
  return Object.is(normalized, -0) ? '0' : normalized.toString();
}

export function createGridMeasurementRow(label, distancePx, options = {}) {
  const numeric = Number(distancePx);
  const gridSize = Number.isFinite(options?.gridSize) && options.gridSize > 0
    ? Number(options.gridSize)
    : getSceneGridSize();
  const unitLabel = String(options?.unitLabel || DEFAULT_UNIT_LABEL).trim() || DEFAULT_UNIT_LABEL;
  const gridDistance = Number.isFinite(numeric) && gridSize > 0 ? numeric / gridSize : 0;
  return {
    label,
    primary: `${formatMeasurementNumber(gridDistance)} ${unitLabel}`,
    secondary: null
  };
}

export function measurePathLength(points = []) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const dx = (Number(current?.x) || 0) - (Number(previous?.x) || 0);
    const dy = (Number(current?.y) || 0) - (Number(previous?.y) || 0);
    total += Math.hypot(dx, dy);
  }
  return total;
}

export function resolveScreenPointer(pointer, event = null, fallback = null) {
  const screenX = Number.isFinite(pointer?.screen?.x)
    ? Number(pointer.screen.x)
    : (Number.isFinite(event?.clientX) ? Number(event.clientX) : null);
  const screenY = Number.isFinite(pointer?.screen?.y)
    ? Number(pointer.screen.y)
    : (Number.isFinite(event?.clientY) ? Number(event.clientY) : null);
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return fallback;
  return { x: screenX, y: screenY };
}

export class CursorMeasurementOverlay {
  constructor(options = {}) {
    this._className = options.className || 'fa-nexus-measurement-overlay';
    this._panelClassName = options.panelClassName || 'fa-nexus-measurement';
    this._zIndex = Number.isFinite(options.zIndex) ? Number(options.zIndex) : 100001;
    this._minWidth = Number.isFinite(options.minWidth) ? Math.max(8, Number(options.minWidth)) : DEFAULT_MIN_WIDTH;
    this._minHeight = Number.isFinite(options.minHeight) ? Math.max(8, Number(options.minHeight)) : DEFAULT_MIN_HEIGHT;
    this._margin = Number.isFinite(options.margin) ? Math.max(0, Number(options.margin)) : DEFAULT_MARGIN;
    this._pointerOffset = Number.isFinite(options.pointerOffset)
      ? Math.max(0, Number(options.pointerOffset))
      : DEFAULT_POINTER_OFFSET;
    this._overlay = null;
    this._panel = null;
    this._body = null;
  }

  render({ pointer = null, rows = [] } = {}) {
    if (!pointer || !Array.isArray(rows) || !rows.length) {
      this.hide();
      return;
    }
    const overlayState = this._ensureOverlay(pointer);
    if (!overlayState?.overlay || !overlayState?.panel || !overlayState?.body) return;
    while (overlayState.body.firstChild) {
      overlayState.body.removeChild(overlayState.body.firstChild);
    }
    rows.forEach((row) => {
      const item = document.createElement('div');
      item.className = `${this._panelClassName}__row`;
      const label = document.createElement('span');
      label.className = `${this._panelClassName}__label`;
      label.textContent = row?.label || '';
      const values = document.createElement('span');
      values.className = `${this._panelClassName}__values`;
      const primary = document.createElement('span');
      primary.className = `${this._panelClassName}__primary`;
      primary.textContent = row?.primary || '';
      values.appendChild(primary);
      if (row?.secondary) {
        const secondary = document.createElement('span');
        secondary.className = `${this._panelClassName}__secondary`;
        secondary.textContent = row.secondary;
        values.appendChild(secondary);
      }
      item.appendChild(label);
      item.appendChild(values);
      overlayState.body.appendChild(item);
    });

    const rect = overlayState.panel.getBoundingClientRect?.();
    const width = Math.max(this._minWidth, Math.ceil(rect?.width || overlayState.panel.offsetWidth || this._minWidth));
    const height = Math.max(this._minHeight, Math.ceil(rect?.height || overlayState.panel.offsetHeight || this._minHeight));
    overlayState.overlay.setScreenSize(width, height);

    const margin = this._margin;
    const pointerOffset = this._pointerOffset;
    const viewportWidth = Number(globalThis?.innerWidth || width + (margin * 2));
    const viewportHeight = Number(globalThis?.innerHeight || height + (margin * 2));
    let left = Math.round(pointer.x + pointerOffset);
    let top = Math.round(pointer.y + pointerOffset);
    if ((left + width) > (viewportWidth - margin)) {
      left = Math.max(margin, Math.round(pointer.x - width - pointerOffset));
    }
    if ((top + height) > (viewportHeight - margin)) {
      top = Math.max(margin, Math.round(pointer.y - height - pointerOffset));
    }
    overlayState.overlay.updatePointer(left + Math.round(width / 2), top + Math.round(height / 2));
  }

  hide() {
    try { this._overlay?.destroy?.(); }
    catch (_) { }
    this._overlay = null;
    this._panel = null;
    this._body = null;
  }

  destroy() {
    this.hide();
  }

  _ensureOverlay(pointer) {
    if (!PlacementOverlay || typeof document === 'undefined') return null;
    if (this._overlay && this._panel && this._body) return { overlay: this._overlay, panel: this._panel, body: this._body };
    this.hide();
    const fallbackPointer = {
      x: Number(globalThis?.innerWidth || 0) / 2,
      y: Number(globalThis?.innerHeight || 0) / 2
    };
    const startPointer = pointer ? { x: Number(pointer.x) || 0, y: Number(pointer.y) || 0 } : fallbackPointer;
    const overlay = new PlacementOverlay({
      className: this._className,
      pointer: startPointer,
      screenWidth: this._minWidth,
      screenHeight: this._minHeight,
      trackZoom: false,
      zIndex: this._zIndex
    });
    try { overlay.element.dataset.faNexusToolOverlay = 'true'; } catch (_) { }
    const panel = document.createElement('div');
    panel.className = this._panelClassName;
    const body = document.createElement('div');
    body.className = `${this._panelClassName}__body`;
    panel.appendChild(body);
    overlay.content?.appendChild?.(panel);
    this._overlay = overlay;
    this._panel = panel;
    this._body = body;
    return { overlay, panel, body };
  }
}
