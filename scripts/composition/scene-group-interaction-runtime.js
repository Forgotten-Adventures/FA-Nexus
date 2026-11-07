import { notifySceneGroupFailure } from './scene-group-notifications.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { initializeSceneMemberLocks } from './scene-member-lock-runtime.js';
import { handleSceneGroupDeleteKey } from './scene-group-delete-command.js';
import { isSceneGroupsEnabled } from '../core/feature-areas.js';
import {
  SCENE_GROUP_INTERACTION_HOOK,
  sceneGroupInteractionState
} from './scene-group-interaction-state.js';
import {
  getSceneGroupInteractionIndex,
  invalidateSceneGroupInteractionIndex,
  isSceneGroupInteractionDocument
} from './scene-group-interaction-resolver.js';
import {
  SCENE_GROUP_MEMBER_SELECTION_OPTIONS,
  SCENE_GROUP_MEMBER_SELECTION_SETTING,
  buildSceneGroupMemberSelectionControl,
  deriveSceneGroupMemberPresentation,
  normalizeSceneGroupMemberSelectionMode,
  resolveSceneGroupMarqueeSelection,
  resolveSceneGroupMemberSelection,
  readSceneGroupMemberSelectionMode
} from './scene-group-member-selection.js';

const PLACEABLE_TAB_MARKER = Symbol.for('fa-nexus.scene-group-placeable-tab-decoration');
const CANVAS_CLICK_MARKER = Symbol.for('fa-nexus.scene-group-canvas-click-selection');
const CANVAS_MARQUEE_MARKER = Symbol.for('fa-nexus.scene-group-canvas-marquee-selection');
const SUPPORTED_HOOK_TYPES = Object.freeze(['Tile', 'Wall', 'AmbientLight', 'AmbientSound', 'Region']);
const CANVAS_LAYER_KEYS = Object.freeze(['tiles', 'walls', 'lighting', 'sounds', 'regions']);

function reportRuntimeFailure(scope, error, details = {}) {
  Logger.error(scope, {
    sceneId: globalThis.canvas?.scene?.id || null,
    ...details,
    error: String(error?.message || error)
  });
  notifySceneGroupFailure(error, 'Scene Group interaction failed');
}

class SceneGroupInteractionRuntime {
  constructor() {
    this._syncing = false;
    this._initialized = false;
    this._selectedMemberCache = null;
    this._nativeSelectionToken = 0;
    this._nativeSelectionScheduled = false;
    this._nativeControlsToPreserve = null;
    this._marqueeSelectionDepth = 0;
  }

  initialize() {
    if (this._initialized) return;
    this._initialized = true;
    initializeSceneMemberLocks();
    this._patchPlaceableTabDecoration();
    this._patchCanvasClickSelection();
    this._patchCanvasMarqueeSelection();
    this._installHooks();
    globalThis.addEventListener('keydown', (event) => handleSceneGroupDeleteKey(event, {
      onError: (error) => reportRuntimeFailure('SceneGroupInteractionRuntime.delete.failed', error)
    }), true);
    this.sync('initialize');
    Logger.info('SceneGroupInteractionRuntime.initialized', {
      selectionModel: 'mode-consistent-canvas-groups'
    });
  }

  _patchPlaceableTabDecoration() {
    const PlaceableTab = foundry?.applications?.sidebar?.tabs?.PlaceableTab;
    const prototype = PlaceableTab?.prototype;
    if (!prototype
      || typeof prototype._prepareEntry !== 'function'
      || typeof prototype._onClickEntry !== 'function'
      || typeof prototype._onRender !== 'function') {
      throw new Error('Foundry v14 PlaceableTab interaction methods are unavailable.');
    }
    if (prototype[PLACEABLE_TAB_MARKER]) return;
    const runtime = this;
    const originalPrepareEntry = prototype._prepareEntry;
    const originalOnClickEntry = prototype._onClickEntry;
    const originalOnRender = prototype._onRender;
    Object.defineProperty(prototype, PLACEABLE_TAB_MARKER, {
      value: { originalPrepareEntry, originalOnClickEntry, originalOnRender },
      configurable: false
    });

    prototype._prepareEntry = async function faNexusPrepareSceneGroupPlaceableEntry(entry, context) {
      const result = await originalPrepareEntry.call(this, entry, context);
      try {
        if (!isSceneGroupInteractionDocument(entry)) return result;
        const scene = entry?.parent || globalThis.canvas?.scene;
        const state = sceneGroupInteractionState.snapshot(scene);
        const presentation = deriveSceneGroupMemberPresentation({
          documentUuid: entry?.uuid,
          mode: runtime._readSelectionMode(),
          index: getSceneGroupInteractionIndex(scene),
          selectedGroupIds: state.selectedGroupIds
        });
        if (presentation.visible) {
          result.css = `${result.css || ''} fa-nexus-scene-group-membership`.trim();
        }
        if (presentation.selectedGroupMember) {
          result.css = `${result.css || ''} fa-nexus-scene-group-member`.trim();
        }
        result.faNexusSceneGroupMembership = presentation;
      } catch (error) {
        reportRuntimeFailure('SceneGroupInteractionRuntime.placeableEntry.prepareFailed', error, {
          documentUuid: entry?.uuid || null
        });
      }
      return result;
    };

    prototype._onClickEntry = function faNexusSelectSceneGroupFromPlaceableEntry(event) {
      try {
        if (event?.target?.closest?.('button')) return originalOnClickEntry.call(this, event);
        const document = this._getPlaceableFromElement?.(event?.target);
        if (!isSceneGroupInteractionDocument(document)) {
          return originalOnClickEntry.call(this, event);
        }
        const scene = document.parent || globalThis.canvas?.scene;
        const selection = resolveSceneGroupMemberSelection({
          documentUuid: document.uuid,
          mode: runtime._readSelectionMode(),
          index: getSceneGroupInteractionIndex(scene),
          event
        });
        if (selection.kind === 'group') {
          event?.stopPropagation?.();
          runtime.selectCanvasGroup(scene, selection.groupId, event);
          return;
        }
        if (!(event?.ctrlKey || event?.metaKey || event?.shiftKey) && !document.object?.controlled
          && sceneGroupInteractionState.snapshot(scene).selectedGroupIds.length) {
          sceneGroupInteractionState.clear(scene, 'exclusive-placeable-row');
        }
        if ((event?.ctrlKey || event?.metaKey) && !event?.shiftKey) {
          if (!globalThis.ui?.controls?.tool?.control) globalThis.ui?.controls?.activate?.({ tool: 'select' });
          if (!document?.rendered) return;
          if (document.object?.controlled) document.object.release();
          else document.object?.control?.({ force: true, releaseOthers: false });
          return;
        }
        return originalOnClickEntry.call(this, event);
      } catch (error) {
        reportRuntimeFailure('SceneGroupInteractionRuntime.placeableEntry.selectFailed', error);
      }
    };

    prototype._onRender = async function faNexusRenderSceneGroupPlaceableTab(context, options) {
      await originalOnRender.call(this, context, options);
      try {
        runtime._decoratePlaceableTab(this);
      } catch (error) {
        reportRuntimeFailure('SceneGroupInteractionRuntime.placeableTab.decorateFailed', error, {
          collectionName: this?.collectionName || null
        });
      }
    };
  }

  _patchCanvasClickSelection() {
    const runtime = this;
    for (const documentName of SUPPORTED_HOOK_TYPES) {
      const objectClass = globalThis.CONFIG?.[documentName]?.objectClass;
      const prototype = objectClass?.prototype;
      if (!prototype || typeof prototype._onClickLeft !== 'function') {
        throw new Error(`Foundry v14 ${documentName} canvas click interaction is unavailable.`);
      }
      if (Object.prototype.hasOwnProperty.call(prototype, CANVAS_CLICK_MARKER)) continue;
      const originalOnClickLeft = prototype._onClickLeft;
      Object.defineProperty(prototype, CANVAS_CLICK_MARKER, {
        value: { originalOnClickLeft },
        configurable: false
      });
      prototype._onClickLeft = function faNexusSelectSceneGroupFromCanvas(event) {
        try {
          if (runtime._selectCanvasPlaceable(this, event)) return;
          return originalOnClickLeft.call(this, event);
        } catch (error) {
          reportRuntimeFailure('SceneGroupInteractionRuntime.canvas.selectFailed', error, {
            documentUuid: this?.document?.uuid || null,
            documentName
          });
          throw error;
        }
      };
    }
  }

  _selectCanvasPlaceable(placeable, event) {
    const document = placeable?.document;
    if (!isSceneGroupInteractionDocument(document)) return false;
    const scene = document.parent || globalThis.canvas?.scene;
    const selection = resolveSceneGroupMemberSelection({
      documentUuid: document.uuid,
      mode: this._readSelectionMode(),
      index: getSceneGroupInteractionIndex(scene),
      event
    });
    if (selection.kind !== 'group') {
      const state = sceneGroupInteractionState.snapshot(scene);
      if (Number(event?.button || 0) !== 0) return false;
      const retain = !!(event?.shiftKey || event?.ctrlKey || event?.metaKey);
      if (!retain && !placeable.controlled && state.selectedGroupIds.length) {
        sceneGroupInteractionState.clear(scene, 'exclusive-native-click');
      }
      if (!retain || this._readSelectionMode() === 'individual') return false;
      event?.preventDefault?.();
      if (placeable.controlled) placeable.release();
      else placeable.control({ releaseOthers: false });
      return true;
    }
    event?.preventDefault?.();
    event?.stopPropagation?.();
    placeable.layer?.hud?.close?.();
    this.selectCanvasGroup(scene, selection.groupId, event);
    return true;
  }

  selectCanvasGroup(scene, groupId, event = {}, { toggle = true } = {}) {
    const state = sceneGroupInteractionState.snapshot(scene);
    const modified = !!(event.shiftKey || event.ctrlKey || event.metaKey);
    const selected = state.selectedGroupIds.includes(groupId);
    const retain = modified || selected;
    if (!retain) {
      this._syncing = true;
      try { for (const placeable of this._placeables()) if (placeable.controlled) placeable.release(); }
      finally { this._syncing = false; }
    }
    return sceneGroupInteractionState.selectGroup(scene, groupId, { retain, toggle: modified && toggle });
  }

  _patchCanvasMarqueeSelection() {
    for (const layerKey of CANVAS_LAYER_KEYS) {
      const layerClass = globalThis.CONFIG?.Canvas?.layers?.[layerKey]?.layerClass
        || globalThis.canvas?.[layerKey]?.constructor;
      const prototype = layerClass?.prototype;
      const currentSelectObjects = prototype?.selectObjects;
      if (!prototype || typeof currentSelectObjects !== 'function') {
        throw new Error(`Foundry v14 ${layerKey} marquee selection is unavailable.`);
      }
      if (currentSelectObjects[CANVAS_MARQUEE_MARKER]) continue;
      const runtime = this;
      const wrappedSelectObjects = function faNexusSelectSceneGroupsFromMarquee(...args) {
        const releaseOthers = args[1]?.releaseOthers !== false;
        runtime._marqueeSelectionDepth += 1;
        let completed = false;
        try {
          const result = currentSelectObjects.apply(this, args);
          completed = true;
          return result;
        } finally {
          runtime._marqueeSelectionDepth -= 1;
          if (completed && runtime._marqueeSelectionDepth === 0) {
            runtime._reconcileNativeMarqueeSelection({
              releaseOthers,
              layerKey
            });
          }
        }
      };
      Object.defineProperty(wrappedSelectObjects, CANVAS_MARQUEE_MARKER, {
        value: { originalSelectObjects: currentSelectObjects },
        configurable: false
      });
      prototype.selectObjects = wrappedSelectObjects;
    }
  }

  _installHooks() {
    Hooks.on(SCENE_GROUP_INTERACTION_HOOK, (_state, reason) => this.sync(`interaction.${reason || 'changed'}`));
    Hooks.on('canvasReady', () => {
      invalidateSceneGroupInteractionIndex();
      this._selectedMemberCache = null;
      this._patchCanvasMarqueeSelection();
      this.sync('canvas-ready');
    });
    Hooks.on('canvasTearDown', () => {
      this._cancelNativeSelectionReconcile();
      invalidateSceneGroupInteractionIndex();
      this._selectedMemberCache = null;
    });
    Hooks.on('updateSetting', (payload) => {
      if (payload?.namespace !== 'fa-nexus' || payload?.key !== SCENE_GROUP_MEMBER_SELECTION_SETTING) return;
      this.sync('member-selection-mode-update');
    });
    Hooks.on('updateScene', (scene, changes) => {
      if (scene?.id !== globalThis.canvas?.scene?.id) return;
      if (!Object.prototype.hasOwnProperty.call(changes?.flags?.['fa-nexus'] || {}, 'compositionRegistry')) return;
      invalidateSceneGroupInteractionIndex();
      this._selectedMemberCache = null;
      this.sync('registry-update');
    });
    for (const documentName of SUPPORTED_HOOK_TYPES) {
      Hooks.on(`control${documentName}`, (placeable, controlled) => this._onNativeControl(placeable, controlled));
    }
  }

  _onNativeControl(placeable, controlled) {
    if (this._syncing || !placeable?.document || !isSceneGroupInteractionDocument(placeable.document)) return;
    this._queueNativeSelectionReconcile(controlled ? 'control' : 'release');
  }

  _cancelNativeSelectionReconcile() {
    this._nativeSelectionToken += 1;
    this._nativeSelectionScheduled = false;
  }

  _queueNativeSelectionReconcile(reason) {
    if (this._nativeSelectionScheduled) return;
    this._nativeSelectionScheduled = true;
    const token = this._nativeSelectionToken;
    queueMicrotask(() => {
      if (token !== this._nativeSelectionToken) return;
      this._nativeSelectionScheduled = false;
      this._reconcileNativeSelection(reason);
    });
  }

  _reconcileNativeSelection(reason) {
    const scene = globalThis.canvas?.scene;
    if (!scene || !globalThis.canvas?.ready) return;
    try {
      const index = getSceneGroupInteractionIndex(scene);
      const controlled = this._placeables().filter((placeable) => placeable?.controlled && placeable?.document);
      const groupedMemberUuids = [...new Set(controlled
        .map((placeable) => placeable.document.uuid)
        .filter((uuid) => index.directOwnerByUuid.has(uuid)))]
        .sort((left, right) => left.localeCompare(right));
      const state = sceneGroupInteractionState.snapshot(scene);
      if (this._readSelectionMode() !== 'individual' && state.selectedGroupIds.length && !groupedMemberUuids.length) return;
      const currentMemberUuids = [...state.selectedMemberUuids].sort((left, right) => left.localeCompare(right));
      const selectionMatches = groupedMemberUuids.length === currentMemberUuids.length
        && groupedMemberUuids.every((uuid, indexPosition) => uuid === currentMemberUuids[indexPosition]);
      if (groupedMemberUuids.length) {
        if (state.selectedGroupIds.length || !selectionMatches) {
          sceneGroupInteractionState.selectMembers(scene, groupedMemberUuids);
        }
      } else if (state.selectedGroupIds.length || state.selectedMemberUuids.length) {
        sceneGroupInteractionState.clear(scene, `native-${reason}`);
      }
    } catch (error) {
      reportRuntimeFailure('SceneGroupInteractionRuntime.nativeSelection.reconcileFailed', error, { reason });
    }
  }

  _reconcileNativeMarqueeSelection({ releaseOthers = true, layerKey = null } = {}) {
    const scene = globalThis.canvas?.scene;
    if (!scene || !globalThis.canvas?.ready) return;
    this._cancelNativeSelectionReconcile();
    try {
      const index = getSceneGroupInteractionIndex(scene);
      const controlled = this._placeables().filter((placeable) => (
        placeable?.controlled && isSceneGroupInteractionDocument(placeable.document)
      ));
      const controlledUuids = [...new Set(controlled.map((placeable) => placeable.document.uuid))];
      const mode = this._readSelectionMode();
      const selection = resolveSceneGroupMarqueeSelection({
        documentUuids: controlledUuids,
        mode,
        index
      });
      const state = sceneGroupInteractionState.snapshot(scene);
      if (selection.groupIds.length) {
        this._nativeControlsToPreserve = new Set(selection.individualUuids);
        try {
          sceneGroupInteractionState.selectGroups(scene, selection.groupIds, {
            retain: !releaseOthers,
            anchorId: selection.groupIds.at(-1),
            primaryGroupId: selection.groupIds.at(-1)
          });
        } finally {
          this._nativeControlsToPreserve = null;
        }
        return;
      }

      const groupedMemberUuids = selection.individualUuids
        .filter((uuid) => index.directOwnerByUuid.has(uuid))
        .sort((left, right) => left.localeCompare(right));
      if (groupedMemberUuids.length) {
        sceneGroupInteractionState.selectMembers(scene, groupedMemberUuids);
        return;
      }
      if (!releaseOthers && state.selectedGroupIds.length) return;
      if (state.selectedGroupIds.length || state.selectedMemberUuids.length) {
        sceneGroupInteractionState.clear(scene, 'native-marquee');
      }
    } catch (error) {
      reportRuntimeFailure('SceneGroupInteractionRuntime.nativeMarqueeSelection.reconcileFailed', error, {
        layerKey,
        releaseOthers
      });
    }
  }

  _placeables() {
    const placeables = [];
    for (const layerKey of CANVAS_LAYER_KEYS) {
      for (const placeable of globalThis.canvas?.[layerKey]?.placeables || []) placeables.push(placeable);
    }
    return placeables;
  }

  _readSelectionMode() {
    try {
      return readSceneGroupMemberSelectionMode();
    } catch (error) {
      reportRuntimeFailure('SceneGroupInteractionRuntime.memberSelectionMode.readFailed', error);
      return normalizeSceneGroupMemberSelectionMode(null);
    }
  }

  _setSelectionMode(mode) {
    const value = normalizeSceneGroupMemberSelectionMode(mode);
    Promise.resolve(globalThis.game?.settings?.set?.(
      'fa-nexus',
      SCENE_GROUP_MEMBER_SELECTION_SETTING,
      value
    )).catch((error) => {
      reportRuntimeFailure('SceneGroupInteractionRuntime.memberSelectionMode.writeFailed', error, { value });
    });
  }

  _createSelectionModeControl(surface) {
    const document = globalThis.document;
    if (!document?.createElement) return null;
    const control = buildSceneGroupMemberSelectionControl(this._readSelectionMode());
    const root = document.createElement('div');
    root.className = 'fa-nexus-scene-member-selection';
    root.dataset.sceneMemberSelectionMode = '';
    root.dataset.sceneMemberSelectionSurface = surface;
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Scene Member Selection Mode');
    for (const option of SCENE_GROUP_MEMBER_SELECTION_OPTIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `fa-nexus-scene-member-selection__option${option.value === control.mode ? ' is-active' : ''}`;
      button.dataset.sceneMemberSelectionModeValue = option.value;
      button.title = option.title;
      button.setAttribute('aria-label', option.label);
      button.setAttribute('aria-pressed', option.value === control.mode ? 'true' : 'false');
      button.textContent = option.label;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._setSelectionMode(option.value);
      });
      root.append(button);
    }
    return root;
  }

  _syncSelectionModeControls() {
    const mode = this._readSelectionMode();
    for (const root of globalThis.document?.querySelectorAll?.('[data-scene-member-selection-mode]') || []) {
      for (const button of root.querySelectorAll('[data-scene-member-selection-mode-value]')) {
        const active = button.dataset.sceneMemberSelectionModeValue === mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }
  }

  _decoratePlaceableTab(tab) {
    const documentName = tab?.documentClass?.documentName;
    if (!SUPPORTED_HOOK_TYPES.includes(documentName) || !tab?.element) return;
    const existingControl = tab.element.querySelector('[data-scene-member-selection-mode]');
    existingControl?.remove?.();
    if (!isSceneGroupsEnabled()) return;
    const control = this._createSelectionModeControl('placeables');
    const search = tab.element.querySelector('search');
    if (control && search) search.insertAdjacentElement('afterend', control);

    const scene = globalThis.canvas?.scene;
    if (!scene) return;
    const state = sceneGroupInteractionState.snapshot(scene);
    const index = getSceneGroupInteractionIndex(scene);
    const collection = scene.getEmbeddedCollection?.(tab.collectionName);
    const mode = this._readSelectionMode();
    for (const row of tab.element.querySelectorAll('[data-entry-id]')) {
      row.classList.remove('fa-nexus-scene-group-membership', 'fa-nexus-scene-group-member');
      row.querySelector('.fa-nexus-scene-group-membership-icon')?.remove?.();
      delete row.dataset.sceneGroupDirectId;
      delete row.dataset.sceneGroupRootId;
      const entry = collection?.get?.(row.dataset.entryId);
      if (!isSceneGroupInteractionDocument(entry)) continue;
      const presentation = deriveSceneGroupMemberPresentation({
        documentUuid: entry.uuid,
        mode,
        index,
        selectedGroupIds: state.selectedGroupIds
      });
      if (!presentation.visible) continue;
      row.classList.add('fa-nexus-scene-group-membership');
      if (presentation.selectedGroupMember) row.classList.add('fa-nexus-scene-group-member');
      row.dataset.sceneGroupDirectId = presentation.directGroupId;
      row.dataset.sceneGroupRootId = presentation.rootGroupId;
      const icon = globalThis.document.createElement('i');
      icon.className = `${presentation.iconClass} fa-fw meta-icon fa-nexus-scene-group-membership-icon`;
      icon.style.setProperty('--fa-nexus-scene-group-icon-color', presentation.iconColor);
      icon.title = presentation.tooltip;
      icon.setAttribute('data-tooltip', '');
      icon.setAttribute('aria-label', presentation.tooltip);
      row.querySelector('.description')?.append?.(icon);
    }
  }

  _releaseNativeCanvasControls() {
    const preserveUuids = this._nativeControlsToPreserve;
    for (const placeable of this._placeables()) {
      const uuid = placeable?.document?.uuid;
      const preserve = preserveUuids?.has?.(uuid) === true
        || (this._readSelectionMode() !== 'individual'
          && !getSceneGroupInteractionIndex(globalThis.canvas.scene).directOwnerByUuid.has(uuid));
      if (placeable?.controlled && !preserve) placeable.release({ renderSidebar: false });
      if (placeable?.hasActiveHUD) placeable.layer?.hud?.close?.();
    }
  }

  sync(reason = 'sync') {
    if (this._syncing) return;
    this._syncSelectionModeControls();
    if (!globalThis.canvas?.ready || !globalThis.canvas?.scene) return;
    this._syncing = true;
    try {
      const state = sceneGroupInteractionState.snapshot(globalThis.canvas.scene);
      if (state.selectedGroupIds.length) {
        this._cancelNativeSelectionReconcile();
        this._releaseNativeCanvasControls();
      }
      globalThis.ui?.placeables?.render?.();
      if (globalThis.game?.activeTool === 'select') globalThis.ui?.placeablesPalette?.render?.();
      Logger.debug?.('SceneGroupInteractionRuntime.synced', {
        sceneId: globalThis.canvas.scene.id,
        reason,
        selectedGroupCount: state.selectedGroupIds.length
      });
    } catch (error) {
      reportRuntimeFailure('SceneGroupInteractionRuntime.sync.failed', error, { reason });
    } finally {
      this._syncing = false;
    }
  }
}

export const sceneGroupInteractionRuntime = new SceneGroupInteractionRuntime();
sceneGroupInteractionRuntime.initialize();
