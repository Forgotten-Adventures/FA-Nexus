/**
 * PlacementOverlay
 * Shared cursor-following overlay for placement workflows.
 *
 * Responsibilities:
 * - Render a fixed-position container that follows the user's cursor.
 * - Maintain width/height derived from either world-space or screen-space units.
 * - Track canvas zoom to keep world-sized overlays accurate.
 * - Expose a content container so callers can populate with custom markup.
 * - Provide an optional callback whenever the rendered screen size changes.
 */
export class PlacementOverlay {
  /**
   * @param {Object} [options]
   * @param {{x:number,y:number}} [options.pointer] - Initial cursor position
   * @param {number} [options.worldWidth] - Width in world units (pre-zoom)
   * @param {number} [options.worldHeight] - Height in world units (pre-zoom)
   * @param {number} [options.screenWidth] - Width in rendered pixels (post-zoom)
   * @param {number} [options.screenHeight] - Height in rendered pixels (post-zoom)
   * @param {string} [options.className] - Additional class names for the root element
   * @param {number} [options.zIndex] - Custom z-index (defaults to 99999)
   * @param {boolean} [options.trackZoom=true] - Whether to watch canvas zoom when world size used
   * @param {(width:number, height:number)=>void} [options.onSizeChange] - Notified when rendered size changes
   */
  constructor(options = {}) {
    const {
      pointer = null,
      worldWidth = null,
      worldHeight = null,
      screenWidth = null,
      screenHeight = null,
      className = '',
      zIndex = 99999,
      trackZoom = true,
      onSizeChange = null
    } = options;

    this._element = document.createElement('div');
    const classes = ['fa-nexus-placement-overlay'];
    if (className) classes.push(className);
    this._element.className = classes.join(' ');
    this._element.style.position = 'fixed';
    this._element.style.pointerEvents = 'none';
    this._element.style.transform = 'translate(-50%, -50%)';
    this._element.style.zIndex = String(zIndex);
    this._element.style.opacity = '0.95';
    this._element.style.display = 'flex';
    this._element.style.alignItems = 'center';
    this._element.style.justifyContent = 'center';

    this._content = document.createElement('div');
    this._content.className = 'fa-nexus-placement-overlay__content';
    this._content.style.width = '100%';
    this._content.style.height = '100%';
    this._content.style.display = 'flex';
    this._content.style.flexDirection = 'column';
    this._content.style.alignItems = 'center';
    this._content.style.justifyContent = 'center';
    this._content.style.textAlign = 'center';
    this._element.appendChild(this._content);

    document.body.appendChild(this._element);

    this._worldWidth = null;
    this._worldHeight = null;
    this._screenWidth = null;
    this._screenHeight = null;
    this._zoomWatcherId = null;
    this._onSizeChange = typeof onSizeChange === 'function' ? onSizeChange : null;
    this._trackZoom = trackZoom !== false;

    if (Number.isFinite(worldWidth) && Number.isFinite(worldHeight)) {
      this.setWorldSize(worldWidth, worldHeight, { trackZoom: this._trackZoom });
    } else if (Number.isFinite(screenWidth) && Number.isFinite(screenHeight)) {
      this.setScreenSize(screenWidth, screenHeight);
    } else {
      this._element.style.width = '120px';
      this._element.style.height = '120px';
    }

    const targetPointer = pointer || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    this.updatePointer(targetPointer.x, targetPointer.y);
  }

  /**
   * Root element accessor so existing code can manipulate legacy references.
   * @returns {HTMLElement|null}
   */
  get element() {
    return this._element;
  }

  /**
   * Container where callers can append custom markup (spinner, preview, etc.).
   * @returns {HTMLElement|null}
   */
  get content() {
    return this._content;
  }

  /**
   * Update overlay screen size explicitly.
   * @param {number} width
   * @param {number} height
   */
  setScreenSize(width, height) {
    const w = Number.isFinite(width) ? Math.max(8, Math.round(width)) : null;
    const h = Number.isFinite(height) ? Math.max(8, Math.round(height)) : null;
    if (w != null) {
      this._screenWidth = w;
      this._element.style.width = `${w}px`;
    }
    if (h != null) {
      this._screenHeight = h;
      this._element.style.height = `${h}px`;
    }
    this._notifySizeChange();
  }

  /**
   * Update overlay world dimensions (pre-zoom). Automatically tracks zoom unless disabled.
   * @param {number} width
   * @param {number} height
   * @param {Object} [options]
   * @param {boolean} [options.trackZoom=true]
   */
  setWorldSize(width, height, options = {}) {
    const trackZoom = options.trackZoom !== undefined ? !!options.trackZoom : this._trackZoom;
    const w = Number.isFinite(width) ? Math.max(0.001, Number(width)) : null;
    const h = Number.isFinite(height) ? Math.max(0.001, Number(height)) : null;
    if (w != null) this._worldWidth = w;
    if (h != null) this._worldHeight = h;
    this._applyWorldSize();
    if (trackZoom) this._startZoomWatcher();
    else this._stopZoomWatcher();
  }

  /**
   * Force the overlay to recompute rendered size from world dimensions.
   */
  refreshFromWorldSize() {
    this._applyWorldSize();
  }

  /**
   * Public helper to resume zoom tracking when world size changes.
   */
  startZoomTracking() {
    this._startZoomWatcher();
  }

  /**
    * Stop listening for zoom changes (overlay keeps last rendered size).
    */
  stopZoomTracking() {
    this._stopZoomWatcher();
  }

  /**
   * Update the overlay cursor position.
   * @param {number} x
   * @param {number} y
   */
  updatePointer(x, y) {
    if (!this._element) return;
    if (Number.isFinite(x)) this._element.style.left = `${Math.round(x)}px`;
    if (Number.isFinite(y)) this._element.style.top = `${Math.round(y)}px`;
  }

  /**
   * Clean up DOM + timers.
   */
  destroy() {
    this._stopZoomWatcher();
    if (this._element?.parentNode) {
      try { this._element.parentNode.removeChild(this._element); }
      catch (_) {}
    }
    this._element = null;
    this._content = null;
  }

  /**
   * Internal: translate stored world dimensions to rendered pixels.
   */
  _applyWorldSize() {
    if (!this._element) return;
    if (!Number.isFinite(this._worldWidth) || !Number.isFinite(this._worldHeight)) return;
    const zoom = Number(canvas?.stage?.scale?.x ?? 1) || 1;
    const width = Math.max(8, Math.round(this._worldWidth * zoom));
    const height = Math.max(8, Math.round(this._worldHeight * zoom));
    this._screenWidth = width;
    this._screenHeight = height;
    this._element.style.width = `${width}px`;
    this._element.style.height = `${height}px`;
    this._notifySizeChange();
  }

  _startZoomWatcher() {
    if (!Number.isFinite(this._worldWidth) || !Number.isFinite(this._worldHeight)) return;
    if (this._zoomWatcherId) return;
    const useRAF = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function';
    const step = () => {
      if (!this._element || !document.body.contains(this._element)) {
        this._stopZoomWatcher();
        return;
      }
      this._applyWorldSize();
      this._zoomWatcherId = useRAF
        ? window.requestAnimationFrame(step)
        : window.setTimeout(step, 150);
    };
    this._zoomWatcherId = useRAF
      ? window.requestAnimationFrame(step)
      : window.setTimeout(step, 150);
  }

  _stopZoomWatcher() {
    if (!this._zoomWatcherId) return;
    try {
      if (typeof window !== 'undefined') {
        window.cancelAnimationFrame?.(this._zoomWatcherId);
        window.clearTimeout?.(this._zoomWatcherId);
      }
    } catch (_) {}
    this._zoomWatcherId = null;
  }

  _notifySizeChange() {
    if (!this._onSizeChange) return;
    const width = Number.isFinite(this._screenWidth) ? this._screenWidth : Number(this._element?.offsetWidth || 0);
    const height = Number.isFinite(this._screenHeight) ? this._screenHeight : Number(this._element?.offsetHeight || 0);
    if (width && height) {
      try { this._onSizeChange(width, height); }
      catch (_) {}
    }
  }
}

/**
 * Factory helper for a consistent spinner + label cluster.
 * @param {Object} [options]
 * @param {string} [options.label='Downloading...']
 * @param {string} [options.iconClass='fas fa-spinner fa-spin']
 * @returns {HTMLElement}
 */
export function createPlacementSpinner(options = {}) {
  const { label = 'Downloading...', iconClass = 'fas fa-spinner fa-spin' } = options || {};
  const container = document.createElement('div');
  container.className = 'fa-nexus-placement-overlay__spinner';
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.gap = '4px';
  container.style.alignItems = 'center';
  container.style.justifyContent = 'center';
  container.style.color = '#fff';
  container.style.textShadow = '0 1px 2px rgba(0,0,0,0.6)';
  container.style.fontSize = '12px';
  container.style.opacity = '0.9';

  const icon = document.createElement('i');
  icon.className = iconClass;
  container.appendChild(icon);

  const span = document.createElement('span');
  span.textContent = label;
  container.appendChild(span);

  return container;
}
