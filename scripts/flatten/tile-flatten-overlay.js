export class TileFlattenOverlay {
  constructor() {
    this._element = null;
    this._statusEl = null;
    this._progressEl = null;
    this._barEl = null;
    this._barFillEl = null;
    this._previousCanvasPointerEvents = null;
    this._previousCursor = null;
  }

  show(operation = 'flatten', options = {}) {
    if (typeof document === 'undefined') return this;
    this._ensureElements();
    const host = document.body;
    if (this._element && host && !this._element.parentElement) {
      host.appendChild(this._element);
    }
    this._blockCanvasInteractions();
    this.setStatus(options.status || this._resolveStatus(operation));
    if (Number.isFinite(options.total)) {
      this.updateProgress(0, options.total);
    } else {
      this.updateProgress(null, null);
    }
    return this;
  }

  setStatus(text) {
    if (this._statusEl) {
      this._statusEl.textContent = String(text || '').trim() || 'Processing...';
    }
  }

  updateProgress(current, total) {
    if (!this._progressEl) return;
    if (!Number.isFinite(total) || total <= 0) {
      this._progressEl.textContent = '';
      this._progressEl.style.display = 'none';
      this.setProgress(null);
      return;
    }
    const safeTotal = Math.max(1, Math.round(total));
    const safeCurrent = Number.isFinite(current)
      ? Math.min(safeTotal, Math.max(0, Math.round(current)))
      : 0;
    this._progressEl.style.display = '';
    this._progressEl.textContent = `Tile ${safeCurrent} of ${safeTotal}`;
    this.setProgress(safeCurrent / safeTotal);
  }

  hide() {
    if (this._element?.parentElement) {
      this._element.parentElement.removeChild(this._element);
    }
    this._restoreCanvasInteractions();
  }

  _ensureElements() {
    if (this._element) return;
    const overlay = document.createElement('div');
    overlay.className = 'fa-nexus-flatten-overlay';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.innerHTML = [
      '<div class="fa-nexus-flatten-overlay__panel">',
      '<div class="fa-nexus-flatten-overlay__spinner"><i class="fas fa-spinner fa-spin"></i></div>',
      '<div class="fa-nexus-flatten-overlay__status"></div>',
      '<div class="fa-nexus-flatten-overlay__progress"></div>',
      '<div class="fa-nexus-flatten-overlay__bar">',
      '<div class="fa-nexus-flatten-overlay__bar-fill"></div>',
      '</div>',
      '</div>'
    ].join('');
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0, 0, 0, 0.45)',
      zIndex: '999999',
      pointerEvents: 'all',
      cursor: 'progress'
    });
    this._element = overlay;
    const panel = overlay.querySelector('.fa-nexus-flatten-overlay__panel');
    if (panel) {
      Object.assign(panel.style, {
        minWidth: '180px',
        padding: '16px 18px',
        borderRadius: '10px',
        background: 'rgba(20, 20, 20, 0.88)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        color: '#f0f0f0',
        textAlign: 'center',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)'
      });
    }
    this._statusEl = overlay.querySelector('.fa-nexus-flatten-overlay__status');
    this._progressEl = overlay.querySelector('.fa-nexus-flatten-overlay__progress');
    this._barEl = overlay.querySelector('.fa-nexus-flatten-overlay__bar');
    this._barFillEl = overlay.querySelector('.fa-nexus-flatten-overlay__bar-fill');
    if (this._barEl) {
      Object.assign(this._barEl.style, {
        width: '180px',
        height: '6px',
        borderRadius: '999px',
        background: 'rgba(255, 255, 255, 0.18)',
        overflow: 'hidden',
        margin: '10px auto 0'
      });
    }
    if (this._barFillEl) {
      Object.assign(this._barFillEl.style, {
        height: '100%',
        width: '0%',
        borderRadius: '999px',
        background: 'linear-gradient(90deg, rgba(255,255,255,0.25), rgba(255,255,255,0.9))',
        transition: 'width 180ms ease'
      });
    }
  }

  setProgress(value) {
    if (!this._barEl || !this._barFillEl) return;
    if (!Number.isFinite(value)) {
      this._barEl.classList.add('is-indeterminate');
      this._barEl.classList.remove('is-active');
      this._barFillEl.style.width = '40%';
      return;
    }
    const clamped = Math.max(0, Math.min(1, Number(value)));
    this._barEl.classList.remove('is-indeterminate');
    this._barEl.classList.add('is-active');
    this._barFillEl.style.width = `${Math.round(clamped * 100)}%`;
  }

  _resolveStatus(operation) {
    if (operation === 'deconstruct') return 'Deconstructing...';
    if (operation === 'export') return 'Exporting...';
    return 'Flattening...';
  }

  _blockCanvasInteractions() {
    try {
      const view = canvas?.app?.view || null;
      if (view && view.style) {
        if (this._previousCanvasPointerEvents === null) {
          this._previousCanvasPointerEvents = view.style.pointerEvents || '';
        }
        view.style.pointerEvents = 'none';
      }
    } catch (_) {}
    try {
      if (this._previousCursor === null) {
        this._previousCursor = document.body.style.cursor || '';
      }
      document.body.style.cursor = 'progress';
    } catch (_) {}
  }

  _restoreCanvasInteractions() {
    try {
      const view = canvas?.app?.view || null;
      if (view && view.style) {
        view.style.pointerEvents = this._previousCanvasPointerEvents || '';
      }
    } catch (_) {}
    this._previousCanvasPointerEvents = null;
    try {
      document.body.style.cursor = this._previousCursor || '';
    } catch (_) {}
    this._previousCursor = null;
  }
}
