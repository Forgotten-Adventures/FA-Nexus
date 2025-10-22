/**
 * TokenPreviewManager (FA Nexus)
 * Extends HoverPreviewManager with token-specific metadata formatting,
 * Patreon gating rules, and token data-service integrations.
 */
import { HoverPreviewManager } from '../core/hover-preview-manager.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';

export class TokenPreviewManager extends HoverPreviewManager {
  /**
   * @param {import('./token-data-service.js').TokenDataService|null} [tokenDataService]
   * @param {{setTimeout?:Function,clearTimeout?:Function}|null} [eventManager]
   */
  constructor(tokenDataService = null, eventManager = null) {
    super({ eventManager });
    this._tokenDataService = tokenDataService;
  }

  destroy() {
    super.destroy();
    this._tokenDataService = null;
  }

  async resolveImageSource(cardEl, meta) {
    let url = meta.currentUrl || '';
    const filename = meta.filename;
    try {
      if (meta.source === 'cloud' && !meta.downloaded) {
        const svc = this._getContentService();
        if (svc) {
          const item = {
            file_path: url || cardEl.getAttribute('data-path') || '',
            filename,
            tier: meta.tier
          };
          const full = await svc.getFullURL?.('tokens', item, this._getAuthState());
          if (full) url = full;
          Logger.debug('TokenPreview.resolveImageSource', { url, tier: meta.tier, downloaded: meta.downloaded });
        }
      } else if (!url) {
        url = cardEl.getAttribute('data-url') || '';
      }
    } catch (e) {
      Logger.warn('TokenPreview.resolveImageSource.failed', { error: String(e?.message || e) });
    }
    return { url, alt: filename };
  }

  _updateMeta(cardEl, meta, metrics = {}) {
    if (!this._dimsEl) return;
    const naturalW = metrics.naturalWidth || 0;
    const naturalH = metrics.naturalHeight || 0;
    const width = naturalW || parseFloat(String(cardEl?.getAttribute('data-width') || meta.widthAttr).replace(/[^0-9.]/g, '')) || 0;
    const height = naturalH || parseFloat(String(cardEl?.getAttribute('data-height') || meta.heightAttr).replace(/[^0-9.]/g, '')) || 0;
    const gridWidth = parseFloat(String(cardEl?.getAttribute('data-grid-w') || meta.gridWidthAttr)) || 1;
    const gridHeight = parseFloat(String(cardEl?.getAttribute('data-grid-h') || meta.gridHeightAttr)) || 1;
    const scaleAttr = cardEl?.getAttribute('data-scale') || meta.scaleAttr || '1x';
    const scale = typeof scaleAttr === 'string' && scaleAttr ? (scaleAttr.endsWith('x') ? scaleAttr : `${scaleAttr}x`) : '1x';
    const fileSize = cardEl?.getAttribute('data-file-size') || meta.fileSizeAttr || '';

    let text = '';
    if (width && height) text += `${Math.round(width)}×${Math.round(height)}px`;
    text += `${text ? ' ' : ''}( ${gridWidth}×${gridHeight} grid`;
    if (scale && scale !== '1x') text += ` at ${scale} scale`;
    text += ' )';
    if (fileSize && fileSize !== '0') {
      const bytes = Number(fileSize);
      const human = Number.isFinite(bytes) && bytes > 0 ? this._formatBytes(bytes) : fileSize;
      text += ` - ${human}`;
    }
    this._dimsEl.textContent = text;
  }

  async _maybeFetchSize(cardEl, meta) {
    try {
      const svc = this._ensureTokenDataService();
      if (!svc || typeof svc.getFileSize !== 'function') return;
      const existing = cardEl.getAttribute('data-file-size') || meta.fileSizeAttr;
      if (existing && existing !== '0') return;
      const url = cardEl.getAttribute('data-url');
      if (!url) return;
      const size = await svc.getFileSize(url);
      if (Number.isFinite(size) && size > 0) {
        cardEl.setAttribute('data-file-size', String(size));
        meta.fileSizeAttr = String(size);
        const mediaEl = this._activeMediaEl || this._imgEl || this._videoEl;
        const metrics = this._collectMediaMetrics ? this._collectMediaMetrics(mediaEl) : {
          naturalWidth: mediaEl?.naturalWidth || mediaEl?.videoWidth || 0,
          naturalHeight: mediaEl?.naturalHeight || mediaEl?.videoHeight || 0
        };
        this._updateMeta(cardEl, meta, metrics);
      }
    } catch (e) {
      Logger.warn('TokenPreviewManager._maybeFetchSize', { error: String(e?.message || e) });
    }
  }

  _ensureTokenDataService() {
    if (this._tokenDataService) return this._tokenDataService;
    return null;
  }

  _getContentService() {
    try {
      const app = foundry.applications.instances.get('fa-nexus-app');
      return app?._contentService || null;
    } catch (_) {
      return null;
    }
  }

  _getAuthState() {
    try {
      const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
      if (auth && auth.authenticated && auth.state) return auth.state;
    } catch (_) {}
    return '';
  }
}
