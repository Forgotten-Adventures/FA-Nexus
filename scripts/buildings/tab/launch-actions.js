import { NexusLogger as Logger } from '../../core/nexus-logger.js';
import { resolvePlacementAnchorTile } from '../../canvas/elevation-band-utils.js';
import { NONE_TEXTURE_KEY } from './constants.js';

function isBenignBuildingCommitError(error) {
  const message = String(error?.message || error || '').trim();
  return message === 'No geometry to commit' || message === 'Missing wall texture';
}

export const launchActionMethods = {
  async _handleBuildingAssetCardClick(event, cardElement, item) {
    event.preventDefault();
    event.stopPropagation();
    if (!(await this._ensureBuildingEditorAccess())) {
      return;
    }
    const key = this._extractItemKey(item, cardElement);
    if (!key && !this._isNoneTextureItem(item)) return;

    if (this._activeSubtab === 'building') {
      if (this._isPathsItem(item)) {
        if (this._isCardPremiumLocked(item, cardElement)) {
          ui?.notifications?.error?.('Authentication required for premium assets. Please connect Patreon.');
          return;
        }
        const ready = await this._ensureBuildingAssetReady(cardElement, item, {
          triggerEvent: event,
          label: 'Preparing wall path...'
        });
        if (!ready) return;
        this._selectOuterWallPath(key);
        const wallPathLocal = this._resolveAssetLocalPath(item, cardElement);
        if (this._buildingManager?.isActive) {
          try {
            await this._buildingManager.updateWallPath?.({ wallPathKey: key, wallPath: item, wallPathLocal });
          } catch (error) {
            Logger.warn?.('BuildingsTab.updateWallPath.failed', { error: String(error?.message || error), key, wallPathLocal });
            ui?.notifications?.error?.(`Failed to update wall path: ${error?.message || error}`);
          }
        } else {
          await this._startBuildingSession('outer', { triggerEvent: event });
        }
        return;
      }
      if (this._isTextureItem(item)) {
        if (!this._isNoneTextureItem(item) && this._isCardPremiumLocked(item, cardElement)) {
          ui?.notifications?.error?.('Authentication required for premium assets. Please connect Patreon.');
          return;
        }
        if (!this._isNoneTextureItem(item)) {
          const ready = await this._ensureBuildingAssetReady(cardElement, item, {
            triggerEvent: event,
            label: 'Preparing fill texture...'
          });
          if (!ready) return;
        }
        this._selectFillTexture(key);
        this._refreshVisibleTextureSelection();
        await this._handleFillTextureSelectionChanged({ key, item, cardElement, triggerEvent: event });
        return;
      }
    }
  },

  async _ensureBuildingAssetReady(cardElement, item, { triggerEvent = null, label = 'Preparing asset...' } = {}) {
    if (!item || this._isNoneTextureItem(item)) return true;
    if (this._isCardPremiumLocked(item, cardElement)) {
      ui?.notifications?.error?.('Authentication required for premium assets. Please connect Patreon.');
      return false;
    }
    const ensureLocal = this._cards?.ensureLocalAssetForCard;
    if (!ensureLocal) return true;
    const localPath = await ensureLocal.call(this._cards, cardElement, item, { triggerEvent, label });
    if (localPath) return true;

    const source = (cardElement?.getAttribute?.('data-source') || item?.source || '').toLowerCase();
    if (source && source !== 'cloud') {
      const fallback = cardElement?.getAttribute?.('data-file-path') || this._resolveFilePath?.(item) || item?.file_path || item?.path || item?.url || '';
      if (fallback) {
        item.cachedLocalPath = item.cachedLocalPath || fallback;
        return true;
      }
    }
    return false;
  },

  async _prepareSessionAssets(mode, { triggerEvent = null } = {}) {
    const wallKey = this._selectedOuterWallPathKey;
    if (!wallKey) {
      ui?.notifications?.warn?.('Select a wall path asset to start Building Tool.');
      return null;
    }
    const wallAsset = this._findItemByKey(wallKey);
    if (!wallAsset) return null;
    const wallCard = this._findCardElementByKey(wallKey, 'paths');
    const wallReady = await this._ensureBuildingAssetReady(wallCard, wallAsset, {
      triggerEvent,
      label: 'Preparing wall path...'
    });
    if (!wallReady) return null;

    let fillAsset = null;
    let fillTextureLocal = '';
    if (mode === 'outer' && this._selectedFillTextureKey && this._selectedFillTextureKey !== NONE_TEXTURE_KEY) {
      fillAsset = this._findItemByKey(this._selectedFillTextureKey);
      if (fillAsset) {
        const fillCard = this._findCardElementByKey(this._selectedFillTextureKey, 'textures');
        const fillReady = await this._ensureBuildingAssetReady(fillCard, fillAsset, {
          triggerEvent,
          label: 'Preparing fill texture...'
        });
        if (!fillReady) return null;
        fillTextureLocal = this._resolveAssetLocalPath(fillAsset, fillCard);
      }
    }

    const wallPathLocal = this._resolveAssetLocalPath(wallAsset, wallCard);

    return { wallKey, wallAsset, fillAsset, wallPathLocal, fillTextureLocal };
  },

  _resolveAssetLocalPath(item, cardElement) {
    if (!item) return '';
    if (item.cachedLocalPath) return item.cachedLocalPath;
    const cardUrl = cardElement?.getAttribute?.('data-url');
    if (cardUrl) {
      item.cachedLocalPath = cardUrl;
      return cardUrl;
    }
    const filePath = cardElement?.getAttribute?.('data-file-path') || this._resolveFilePath?.(item) || item?.file_path || item?.path || item?.url || '';
    if (filePath) item.cachedLocalPath = filePath;
    return filePath;
  },

  async _startBuildingSession(mode = 'outer', { triggerEvent = null } = {}) {
    const manager = this._getBuildingManager();
    if (!manager) return;

    const assets = await this._prepareSessionAssets(mode, { triggerEvent });
    if (!assets) return;

    const { wallKey, wallAsset, fillAsset, wallPathLocal, fillTextureLocal } = assets;
    const controlledTiles = Array.isArray(canvas?.tiles?.controlled)
      ? canvas.tiles.controlled.filter((tile) => tile && !tile.destroyed)
      : [];
    const selectedTile = resolvePlacementAnchorTile(controlledTiles, { source: 'building-tab-start' })
      || controlledTiles.find((tile) => !!tile?.document)
      || null;
    const selectedDoc = selectedTile?.document || selectedTile || null;
    const selectedElevation = Number(selectedDoc?.elevation ?? selectedTile?.elevation);
    const selectedLevelIdsSource = selectedDoc?.levels instanceof Set || Array.isArray(selectedDoc?.levels)
      ? Array.from(selectedDoc.levels)
      : (selectedDoc?._source?.levels || []);
    const selectedLevelIds = Array.from(new Set(selectedLevelIdsSource
      .map((levelId) => String(levelId || '').trim())
      .filter(Boolean)));
    const currentLevel = canvas?.level || (canvas?.scene?._view ? canvas.scene.levels.get(canvas.scene._view) : null);
    const placementLevelId = selectedLevelIds.length === 1
      ? selectedLevelIds[0]
      : String(currentLevel?.id || '').trim();
    const placementLevels = selectedLevelIds.length
      ? selectedLevelIds
      : (placementLevelId ? [placementLevelId] : []);
    const session = {
      mode,
      wallPathKey: wallKey,
      wallPath: wallAsset,
      wallPathLocal,
      fillTextureKey: this._selectedFillTextureKey,
      fillTexture: fillAsset,
      fillTextureLocal,
      portalMode: this._activeSubtab === 'portals',
      placementLevels,
      placementLevelId: placementLevelId || null
    };
    if (Number.isFinite(selectedElevation)) {
      session.selectedElevation = selectedElevation;
      session.placementAnchorElevation = selectedElevation;
    }

    try {
      await manager.start(session);
      this._attachEscapeListener();
    } catch (error) {
      Logger.warn?.('BuildingsTab.building.start.failed', { mode, error: String(error?.message || error) });
      const code = String(error?.code || error?.name || '').toUpperCase();
      if (code === 'ENTITLEMENT_REQUIRED' || /premium/i.test(String(error?.message || ''))) {
        ui?.notifications?.warn?.('Building Editor is a premium feature. Please connect Patreon to continue.');
      } else {
        ui?.notifications?.error?.(`Failed to start Building Editor: ${error?.message || error}`);
      }
      this._detachEscapeListener();
    }
  },

  _isCardPremiumLocked(item, cardElement) {
    try {
      const authed = typeof this._hasPremiumAuth === 'function' ? this._hasPremiumAuth() : false;
      return !!this._isAssetLocked?.(item, cardElement, { authed });
    } catch (_) {
      return false;
    }
  },

  async _ensureBuildingEditorAccess() {
    const helper = this._cards;
    if (helper && typeof helper._requirePremiumFeature === 'function') {
      return helper._requirePremiumFeature('building.edit', { label: 'Building Editor' });
    }
    const authed = typeof this._hasPremiumAuth === 'function' ? this._hasPremiumAuth() : false;
    if (authed) return true;
    ui?.notifications?.error?.('Building Editor is a premium feature. Please connect Patreon.');
    return false;
  },

  _stopBuildingSession({ reason = 'manual' } = {}) {
    const manager = this._buildingManager;
    if (!manager) return;
    if (!manager.isActive) {
      this._stopBuildingManager(manager, { reason });
      return;
    }
    if (reason === 'tab-deactivate') {
      const hasChanges = typeof manager.hasSessionChanges === 'function'
        ? manager.hasSessionChanges()
        : true;
      if (!hasChanges) {
        this._stopBuildingManager(manager, { reason });
        return;
      }
      const canCommit = typeof manager.canCommitSession === 'function'
        ? manager.canCommitSession()
        : true;
      if (!canCommit) {
        Logger.info?.('BuildingsTab.building.commit.skipped', { reason, cause: 'session-not-committable' });
        this._stopBuildingManager(manager, { reason: `${reason}-discard` });
        return;
      }
      if (typeof manager.commitBuilding === 'function') {
        Promise.resolve()
          .then(() => manager.commitBuilding({ reason }))
          .catch((error) => {
            if (isBenignBuildingCommitError(error)) {
              Logger.info?.('BuildingsTab.building.commit.discarded', {
                reason,
                error: String(error?.message || error)
              });
              return this._stopBuildingManager(manager, { reason: `${reason}-discard` });
            }
            Logger.warn?.('BuildingsTab.building.commit.failed', { reason, error: String(error?.message || error) });
            return null;
          })
          .finally(() => {
            if (!manager.isActive) this._detachEscapeListener();
          });
        return;
      }
    }
    if (reason === 'esc') {
      if (typeof manager.requestCancelSession === 'function') {
        const cancelPromise = manager.requestCancelSession({ reason });
        if (cancelPromise?.catch) {
          cancelPromise.catch((error) => {
            Logger.warn?.('BuildingsTab.building.cancel.failed', { reason, error: String(error?.message || error) });
          });
        }
        Promise.resolve(cancelPromise).then((cancelled) => {
          if (cancelled || !manager.isActive) this._detachEscapeListener();
        });
        return;
      }
    }
    this._stopBuildingManager(manager, { reason });
  },

  _stopBuildingManager(manager, { reason = 'manual' } = {}) {
    try {
      const stopPromise = manager?.stop?.({ reason });
      Promise.resolve(stopPromise)
        .catch((error) => {
          Logger.warn?.('BuildingsTab.building.stop.failed', { reason, error: String(error?.message || error) });
        })
        .finally(() => {
          this._detachEscapeListener();
        });
      return stopPromise;
    } catch (error) {
      Logger.warn?.('BuildingsTab.building.stop.failed', { reason, error: String(error?.message || error) });
      this._detachEscapeListener();
      return null;
    }
  },

  _attachEscapeListener() {
    if (this._escapeListenerAttached) return;
    const target = globalThis?.window || globalThis;
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener('keydown', this._boundEscapeHandler, true);
    this._escapeListenerAttached = true;
    this._escapeListenerTarget = target;
  },

  _detachEscapeListener() {
    if (!this._escapeListenerAttached || !this._escapeListenerTarget) return;
    try {
      this._escapeListenerTarget.removeEventListener('keydown', this._boundEscapeHandler, true);
    } catch (_) {}
    this._escapeListenerAttached = false;
    this._escapeListenerTarget = null;
  },

  _handleGlobalKeydown(event) {
    if (!event || event.key !== 'Escape') return;
    if (!this._buildingManager?.isActive) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    this._stopBuildingSession({ reason: 'esc' });
  }
};
