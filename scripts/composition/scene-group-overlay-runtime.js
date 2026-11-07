import { sceneGroupFrameCorners as frameCorners, drawSceneGroupTransformHandles } from './scene-group-transform-handles.js';
import { notifySceneGroupFailure, isSceneGroupOperationBlocked } from './scene-group-notifications.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { inspectCompositionRegistryLocks } from './composition-registry-transaction.js';
import { isSceneMemberLocked } from './scene-member-lock-state.js';
import { TilePixelSelection } from '../canvas/tile-selection.js';
import { getAssetShadowManager } from '../assets/asset-shadow-manager.js';
import { doorTransformPreviewRuntime } from '../portals/door-transform-preview-runtime.js';
import { beginLocalWallPerceptionPreview } from '../canvas/local-wall-perception-preview.js';
import { memberPreviewChanges, refreshMemberPreviewObject, captureTilePreviewDisplay, capturePreservedTilePreviewDisplays, syncMemberSemanticPreview, beginMemberSemanticPreview, clearMemberSemanticPreview, restoreTilePreviewDisplay } from './scene-member-render-preview.js';
import {
  SCENE_GROUP_INTERACTION_HOOK,
  sceneGroupInteractionState
} from './scene-group-interaction-state.js';
import { getSceneGroupInteractionIndex } from './scene-group-interaction-resolver.js';
import { sceneGroupInteractionRuntime } from './scene-group-interaction-runtime.js';
import { isSceneGroupNativeDeletionPending, SCENE_GROUP_NATIVE_DELETION_STATE_HOOK } from './scene-group-native-deletion-state.js';
import {
  resolveSceneGroupMemberSelection,
  readSceneGroupMemberSelectionMode,
  resolveSceneGroupMemberTileHandleGesture
} from './scene-group-member-selection.js';
import {
  buildSceneGroupMemberTransformTarget,
  buildSceneGroupTransformRestore,
  getSceneGroupOrientedFrame,
  getSceneGroupFrame,
  readSceneGroupMemberTransformState,
  resolveSceneGroupMoveDelta,
  SCENE_GROUP_PIVOT_MODES,
  SceneGroupWorkflowError,
  SceneGroupWorkflow
} from './scene-group-workflow.js';
import { resolveSceneGroupMoveSelection } from './scene-group-workflow.js';
import { resolveGridReferencePoint } from '../canvas/grid-reference-snap.js';

const OVERLAY_NAME = 'fa-nexus-scene-group-overlay';
const OVERLAY_DRAG_MARKER = Symbol.for('fa-nexus.scene-group-overlay-drag-active');
const FOUNDRY_DRAG_RESISTANCE_PX = 10;
const NATIVE_TILE_CONTROL_HANDLE_NAMES = new Set(['translate', 'scale', 'scaleX', 'scaleY', 'rotate']);

function setOverlayDragActive(active) {
  globalThis[OVERLAY_DRAG_MARKER] = !!active;
}

function rotatePoint(point, pivot, angleDegrees) {
  const radians = angleDegrees * (Math.PI / 180);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const offsetX = point.x - pivot.x;
  const offsetY = point.y - pivot.y;
  return {
    x: pivot.x + (cos * offsetX) - (sin * offsetY),
    y: pivot.y + (sin * offsetX) + (cos * offsetY)
  };
}

function normalizeSignedAngle(angle) {
  return ((((Number(angle) || 0) + 180) % 360) + 360) % 360 - 180;
}

function normalizeAngle(angle) {
  return (((Number(angle) || 0) % 360) + 360) % 360;
}

function eventCanvasPoint(event) {
  return event?.getLocalPosition?.(canvas?.stage)
    || event?.interactionData?.origin
    || canvas?.mousePosition
    || null;
}

function stopPointerEvent(event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  event?.stopImmediatePropagation?.();
}

function axisAlignedFrameBounds(frame) {
  const corners = frameCorners(frame);
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function translateFrame(frame, delta) {
  return {
    ...frame,
    center: { x: frame.center.x + delta.x, y: frame.center.y + delta.y }
  };
}

function scaleFrame(frame, pivot, factor) {
  return {
    ...frame,
    center: {
      x: pivot.x + ((frame.center.x - pivot.x) * factor),
      y: pivot.y + ((frame.center.y - pivot.y) * factor)
    },
    width: frame.width * factor,
    height: frame.height * factor
  };
}

function rotateFrame(frame, pivot, angle) {
  return {
    ...frame,
    angle: normalizeAngle(frame.angle + angle),
    center: rotatePoint(frame.center, pivot, angle)
  };
}

function eventModifier(event, key) {
  if (event?.[key] || event?.nativeEvent?.[key]) return true;
  const modifier = {
    altKey: 'ALT',
    ctrlKey: 'CONTROL',
    metaKey: 'CONTROL',
    shiftKey: 'SHIFT'
  }[key];
  return modifier ? Boolean(globalThis.game?.keyboard?.isModifierActive?.(modifier)) : false;
}

/**
 * The point of a Scene Group move that is snapped to the grid. Explicit bounds snap by their first corner.
 * Otherwise a layer among the given documents that was drawn on the grid (a Building, a Path, a flattened
 * section with Walls) is snapped by its own points (grid-reference-snap.js): its Tile is as large as everything
 * it draws, so neither its position nor a frame around it is on the grid, and a move snapped by those left
 * walls beside the grid lines. Without such a layer the fallback is used: the dragged Tile's position, or the
 * pivot.
 */
function resolveMoveSnapAnchor(scene, groupId, frame, fallback, documents = []) {
  if (scene?.getFlag?.('fa-nexus', 'compositionRegistry')?.groups?.[groupId]?.bounds) return frameCorners(frame)[0];
  let best = null;
  for (const document of documents) {
    const point = resolveGridReferencePoint(document);
    if (point && (!best || point.distance < best.distance)) best = point;
  }
  return best ? { x: best.x, y: best.y } : fallback;
}

function snapLikeTile(point) {
  const grid = canvas?.grid;
  const modes = globalThis.CONST?.GRID_SNAPPING_MODES;
  if (typeof grid?.getSnappedPoint !== 'function' || !modes) {
    throw new Error('Foundry Tile snapping is unavailable.');
  }
  // Tiles move between square corners and centers. Do not delegate to
  // TilesLayer#getSnappedPoint: in Foundry v14 TilesLayer inherits the adaptive
  // ShapeLayer precision (up to eight subdivisions on large grids), which is
  // much finer than the normal two-position Tile movement rhythm.
  const snapped = grid.getSnappedPoint({ x: point.x, y: point.y }, {
    mode: modes.CENTER | modes.VERTEX | modes.CORNER | modes.SIDE_MIDPOINT,
    resolution: 1
  });
  if (![snapped?.x, snapped?.y].every((value) => Number.isFinite(Number(value)))) {
    throw new Error('Foundry Tile snapping returned an invalid point.');
  }
  return { x: Number(snapped.x), y: Number(snapped.y) };
}

function displayObjectDocument(target) {
  let current = target || null;
  while (current) {
    if (current.document?.documentName) return current.document;
    current = current.parent || null;
  }
  return null;
}

function nativeTileControlHandleName(target) {
  let current = target || null;
  while (current) {
    const name = String(current.name || '').trim();
    if (NATIVE_TILE_CONTROL_HANDLE_NAMES.has(name)) return name;
    if (current.document?.documentName) return null;
    current = current.parent || null;
  }
  return null;
}

function targetBelongsToOverlayControl(target, overlay) {
  let current = target || null;
  while (current && current !== overlay) {
    if (current.faNexusHandleKind) return true;
    current = current.parent || null;
  }
  return false;
}

class SceneGroupOverlayRuntime {
  constructor() {
    this._workflow = new SceneGroupWorkflow();
    this._container = null;
    this._graphics = null;
    this._pivotHandle = null;
    this._scaleHandles = [];
    this._rotationHandle = null;
    this._activeDrag = null;
    this._previewAnimationFrameId = null;
    this._pendingPreview = null;
    this._pendingTilePointer = null;
    this._deferredTilePointer = null;
    this._pendingCanvasDeselect = null;
    this._lastPivotRightClick = null;
    this._boundStage = null;
    this._stagePointerDownCapture = (event) => this._onStagePointerDownCapture(event);
    this._stagePointerMove = (event) => this._onStagePointerMove(event);
    this._stagePointerUpCapture = (event) => this._onStagePointerUpCapture(event);
    this._stagePointerCancelCapture = (event) => this._onStagePointerCancelCapture(event);
    this._keyDownCapture = (event) => this._onKeyDownCapture(event);
    this._keyUpCapture = (event) => this._onKeyUpCapture(event);
    this._contextMenuCapture = (event) => {
      // The right-button chord emits no pointerdown, and preventing the initial
      // pointer event suppresses compatibility mousedown. Contextmenu still fires.
      if (event.button !== 2 || !this._activeDrag || event.target !== globalThis.canvas?.app?.view) return;
      stopPointerEvent(event);
      this._abortActiveDrag(this._activeDrag, null, 'right-click-cancel');
    };
    setOverlayDragActive(false);
    this._pendingTransform = null;
    this._revision = 0;
    this._initialized = false;
  }

  initialize() {
    if (this._initialized) return;
    this._initialized = true;
    Hooks.on(SCENE_GROUP_NATIVE_DELETION_STATE_HOOK, (scene, pending) => {
      if (scene?.id !== canvas?.scene?.id) return;
      if (pending) {
        this._revision += 1;
        this.clear('native-deletion-pending');
      } else this.scheduleRefresh('native-deletion-settled');
    });
    Hooks.on(SCENE_GROUP_INTERACTION_HOOK, (state, reason) => {
      if (!state?.primaryGroupId) {
        this._revision += 1;
        this.clear(`interaction-${reason || 'clear'}`);
        return;
      }
      this.scheduleRefresh('interaction');
    });
    Hooks.on('canvasReady', () => {
      this._bindCanvasStage();
      this.scheduleRefresh('canvas-ready');
    });
    Hooks.on('canvasTearDown', () => {
      this._unbindCanvasStage();
      this.clear('canvas-teardown');
    });
    Hooks.on('controlTile', () => {
      this._bindCanvasStage();
      this.scheduleRefresh('native-selection');
    });
    Hooks.on('updateScene', (scene, changes) => {
      if (scene?.id !== canvas?.scene?.id) return;
      if (!changes?.flags?.['fa-nexus']?.compositionRegistry) return;
      this.scheduleRefresh('registry-update');
    });
    for (const documentName of ['Tile', 'Wall', 'AmbientLight', 'AmbientSound', 'Region']) {
      Hooks.on(`update${documentName}`, (document) => {
        if (document?.parent?.id !== canvas?.scene?.id) return;
        this.scheduleRefresh(`update-${documentName}`);
      });
      Hooks.on(`delete${documentName}`, (document, options = {}) => {
        if (document?.parent?.id !== canvas?.scene?.id) return;
        // Aggregate deletion publishes its final registry after all document
        // batches. Reading the old registry here would see partial membership.
        if (options.faNexusSceneGroupDelete) return;
        this.scheduleRefresh(`delete-${documentName}`);
      });
    }
    globalThis.addEventListener('keydown', this._keyDownCapture, true);
    globalThis.addEventListener('keyup', this._keyUpCapture, true);
    globalThis.addEventListener('contextmenu', this._contextMenuCapture, true);
    this._bindCanvasStage();
  }

  _bindCanvasStage() {
    const stage = globalThis.canvas?.stage;
    if (!stage || this._boundStage === stage) return;
    this._unbindCanvasStage();
    stage.on('pointerdowncapture', this._stagePointerDownCapture);
    stage.on('pointermovecapture', this._stagePointerMove);
    stage.on('pointerupcapture', this._stagePointerUpCapture);
    stage.on('pointerupoutside', this._stagePointerUpCapture);
    stage.on('pointercancelcapture', this._stagePointerCancelCapture);
    this._boundStage = stage;
  }

  _unbindCanvasStage() {
    const stage = this._boundStage;
    if (!stage) return;
    stage.off('pointerdowncapture', this._stagePointerDownCapture);
    stage.off('pointermovecapture', this._stagePointerMove);
    stage.off('pointerupcapture', this._stagePointerUpCapture);
    stage.off('pointerupoutside', this._stagePointerUpCapture);
    stage.off('pointercancelcapture', this._stagePointerCancelCapture);
    this._boundStage = null;
    this._pendingTilePointer = null;
    this._deferredTilePointer = null;
    this._pendingCanvasDeselect = null;
  }

  scheduleRefresh(reason) {
    const revision = ++this._revision;
    queueMicrotask(() => {
      if (revision !== this._revision) return;
      this.refresh(reason, revision).catch((error) => {
        // A Scene operation (Flatten, Deconstruct, a Building Commit) holds the registry lock while it replaces
        // documents, and writes the registry last: until then the registry names documents it has just deleted.
        // Releasing the lock deletes its marker Wall, which refreshes again; only a failure still there then is
        // shown. Before, a Flatten that worked ended with "references to deleted items … Recover" (NUX-056).
        if (error?.code === 'missing-document' && inspectCompositionRegistryLocks(canvas?.scene).length) {
          Logger.info('SceneGroupOverlay.refreshDeferredDuringSceneOperation', { reason, sceneId: canvas?.scene?.id || null });
          this.clear('refresh-deferred');
          return;
        }
        Logger.error('SceneGroupOverlay.refreshFailed', {
          reason,
          sceneId: canvas?.scene?.id || null,
          error: String(error?.message || error)
        });
        notifySceneGroupFailure(error, `Scene Group overlay failed`);
        this.clear('refresh-failed');
      });
    });
  }

  get pendingTransform() { return this._pendingTransform; }

  async waitForPendingTransform() {
    while (this._pendingTransform) {
      const pending = this._pendingTransform;
      await pending;
    }
    return true;
  }

  async refresh(reason = 'manual', revision = this._revision) {
    if (this._activeDrag || this._pendingTransform) return;
    const scene = canvas?.scene || null;
    if (isSceneGroupNativeDeletionPending(scene)) return;
    const state = sceneGroupInteractionState.snapshot(scene);
    const groupId = state.primaryGroupId;
    if (!scene || !canvas?.ready || !canvas?.interface || !groupId) {
      this.clear(reason);
      return;
    }
    const registry = scene.getFlag('fa-nexus', 'compositionRegistry');
    if (!registry?.groups?.[groupId]) {
      sceneGroupInteractionState.discardGroup(scene, groupId, 'stale-group');
      this.clear('stale-group');
      return;
    }

    const result = await this._workflow.execute({
      scene,
      user: game?.user,
      action: { type: 'select-group', groupId }
    });
    if (this._activeDrag || this._pendingTransform) return;
    const documents = [];
    const moveSelection = this._moveSelection(groupId);
    for (const uuid of moveSelection.documentUuids) {
      const document = await fromUuid(uuid);
      if (!document) throw new Error(`Selected Scene Group member is missing: ${uuid}.`);
      documents.push(document);
    }
    const currentState = sceneGroupInteractionState.snapshot(scene);
    if (revision !== this._revision || currentState.primaryGroupId !== groupId) return;
    if (!documents.length) {
      this.clear('empty-selection');
      return;
    }

    const multiple = state.selectedGroupIds.length > 1 || moveSelection.standaloneDocumentUuids.length > 0;
    const frame = multiple ? getSceneGroupOrientedFrame(documents,0) : getSceneGroupFrame(documents,result.group);
    const pivot = !multiple && result.group?.pivotMode === SCENE_GROUP_PIVOT_MODES.CUSTOM
      ? result.group.pivot
      : frame.center;
    this._presentOverlay({
      groupId,
      frame,
      pivot,
      pivotMode: result.group?.pivotMode || SCENE_GROUP_PIVOT_MODES.AUTOMATIC
    });
    Logger.debug?.('SceneGroupOverlay.refreshed', {
      reason,
      sceneId: scene.id,
      groupId,
      memberCount: documents.length,
      frame,
      pivot
    });
  }

  _ensureContainer() {
    if (this._container && !this._container.destroyed && this._container.parent === canvas.interface) return;
    this.clear('recreate');
    const container = new PIXI.Container();
    container.name = OVERLAY_NAME;
    container.eventMode = 'passive';
    container.interactiveChildren = true;
    container.zIndex = Number.MAX_SAFE_INTEGER;
    const graphics = new PIXI.Graphics();
    graphics.name = `${OVERLAY_NAME}-graphics`;
    graphics.eventMode = 'none';
    container.addChild(graphics);
    const pivotHandle = this._createHandle({ kind: 'move', index: -1 });
    container.addChild(pivotHandle);
    const scaleHandles = [0, 1, 2, 3].map((index) => {
      const handle = this._createHandle({ kind: 'scale', index });
      container.addChild(handle);
      return handle;
    });
    const rotationHandle = this._createHandle({ kind: 'rotate', index: -1 });
    container.addChild(rotationHandle);
    canvas.interface.sortableChildren = true;
    canvas.interface.addChild(container);
    this._container = container;
    this._graphics = graphics;
    this._pivotHandle = pivotHandle;
    this._scaleHandles = scaleHandles;
    this._rotationHandle = rotationHandle;
  }

  _presentOverlay({ groupId, frame, pivot, pivotMode }) {
    this._ensureContainer();
    this._drawOverlay(frame, pivot);
    // Pixi computes child world transforms lazily. Force one bounds pass so newly
    // created handles can be hit-tested before the next canvas render tick.
    this._container.getBounds();
    this._container.visible = true;
    this._container.faNexusSceneGroupId = groupId;
    this._container.faNexusSceneGroupBounds = axisAlignedFrameBounds(frame);
    this._container.faNexusSceneGroupFrame = {
      ...frame,
      center: { ...frame.center }
    };
    this._container.faNexusSceneGroupPivot = { x: Number(pivot.x) || 0, y: Number(pivot.y) || 0 };
    this._container.faNexusSceneGroupPivotMode = pivotMode || SCENE_GROUP_PIVOT_MODES.AUTOMATIC;
  }

  _moveSelection(groupId) {
    const scene = canvas?.scene;
    const state = sceneGroupInteractionState.snapshot(scene);
    const index = getSceneGroupInteractionIndex(scene);
    return resolveSceneGroupMoveSelection(scene.getFlag('fa-nexus', 'compositionRegistry'), {
      groupId,
      groupIds: state.selectedGroupIds.length ? state.selectedGroupIds : [groupId],
      documentUuids: Array.from(canvas?.tiles?.controlled || [])
        .map((tile) => tile.document.uuid).filter((uuid) => !index.directOwnerByUuid.has(uuid))
    });
  }

  _presentImmediateTileGroup(scene, index, groupId) {
    const registry = scene?.getFlag?.('fa-nexus', 'compositionRegistry');
    const group = registry?.groups?.[groupId];
    if (!group) throw new Error(`Scene Group ${groupId} is unavailable for immediate Tile drag.`);
    const memberUuids = new Set(this._moveSelection(groupId).documentUuids);
    if (!memberUuids?.size) throw new Error(`Scene Group ${groupId} has no effective members for immediate Tile drag.`);
    const documents = [];
    const missingUuids = [];
    for (const uuid of memberUuids) {
      const document = globalThis.fromUuidSync?.(uuid) || null;
      if (document) documents.push(document);
      else missingUuids.push(uuid);
    }
    if (missingUuids.length) {
      throw new Error(`Scene Group immediate Tile drag members are missing: ${missingUuids.join(', ')}.`);
    }
    const selection = this._moveSelection(groupId);
    const multiple = sceneGroupInteractionState.snapshot(scene).selectedGroupIds.length > 1 || selection.standaloneDocumentUuids.length > 0;
    const frame = multiple ? getSceneGroupOrientedFrame(documents,0) : getSceneGroupFrame(documents,group);
    const pivotMode = multiple ? SCENE_GROUP_PIVOT_MODES.AUTOMATIC : group.pivotMode || SCENE_GROUP_PIVOT_MODES.AUTOMATIC;
    const pivot = pivotMode === SCENE_GROUP_PIVOT_MODES.CUSTOM ? group.pivot : frame.center;
    this._presentOverlay({ groupId, frame, pivot, pivotMode });
    return { frame, pivot };
  }

  _createHandle({ kind, index }) {
    const handle = new PIXI.Graphics();
    handle.name = `${OVERLAY_NAME}-${kind}-${index}`;
    handle.faNexusHandleKind = kind;
    handle.faNexusHandleIndex = index;
    handle.eventMode = 'static';
    handle.cursor = kind === 'move'
      ? 'move'
      : kind === 'rotate'
        ? 'grab'
        : ([0, 2].includes(index) ? 'nwse-resize' : 'nesw-resize');
    handle.on('pointerdown', (event) => this._onHandlePointerDown(event, handle));
    handle.on('globalpointermove', (event) => this._onHandlePointerMove(event, handle));
    handle.on('pointerup', (event) => this._onHandlePointerUp(event, handle));
    handle.on('pointerupoutside', (event) => this._onHandlePointerUp(event, handle));
    handle.on('pointercancel', (event) => this._onHandlePointerCancel(event, handle));
    if (kind === 'move') handle.on('rightclick', (event) => this._onPivotRightClick(event, handle));
    return handle;
  }

  _drawOverlay(frame, pivot) {
    const state = sceneGroupInteractionState.snapshot(canvas?.scene);
    const selection = state.primaryGroupId ? this._moveSelection(state.primaryGroupId) : null;
    const multiple = !!selection && (state.selectedGroupIds.length > 1 || selection.standaloneDocumentUuids.length > 0);
    if (!this._graphics) return;
    drawSceneGroupTransformHandles({graphics:this._graphics,pivotHandle:this._pivotHandle,
      scaleHandles:this._scaleHandles,rotationHandle:this._rotationHandle},frame,pivot,{multiple});
    for (const handle of [this._pivotHandle,...this._scaleHandles,this._rotationHandle]) {
      if (!handle) continue;
      handle.eventMode = this._pendingTransform || (this._activeDrag && this._activeDrag.handle !== handle) ? 'none' : 'static';
    }
    if (this._pivotHandle) this._pivotHandle.cursor = this._activeDrag?.handle === this._pivotHandle ? 'grabbing' : 'move';
    if (this._rotationHandle) this._rotationHandle.cursor = this._activeDrag?.handle === this._rotationHandle ? 'grabbing' : 'grab';
  }

  _captureMemberPreview(drag) {
    const operation = drag.kind === 'move' ? 'move' : drag.kind;
    if (!['move', 'scale', 'rotate'].includes(operation)) return null;
    if (operation === 'move') drag.moveSelection = this._moveSelection(drag.groupId);
    const memberUuids = operation === 'move'
      ? new Set(drag.moveSelection.documentUuids)
      : getSceneGroupInteractionIndex(canvas?.scene).effectiveMemberUuidsByGroupId.get(drag.groupId);
    if (!memberUuids?.size) {
      throw new Error(`Scene Group ${drag.groupId} has no effective members for live preview.`);
    }
    const documents = [];
    const missingUuids = [];
    for (const uuid of memberUuids) {
      const document = globalThis.fromUuidSync?.(uuid) || null;
      if (document) documents.push(document);
      else missingUuids.push(uuid);
    }
    if (missingUuids.length) {
      throw new SceneGroupWorkflowError('preview-members-missing', 'preflight-preview', {
        identities: missingUuids, message: `${missingUuids.length} group items are missing. Reload the Scene before trying again.`
      });
    }
    const locked = documents.filter(isSceneMemberLocked);
    if (locked.length) {
      throw new SceneGroupWorkflowError(operation === 'move' ? 'document-move-locked' : 'document-transform-locked', 'preflight-preview', {
        identities: locked.map(document => document.uuid), message: 'Unlock the locked group items before transforming them.'
      });
    }
    const forbidden = documents.filter((document) => (
      typeof document?.canUserModify === 'function' && !document.canUserModify(game?.user, 'update')
    ));
    if (forbidden.length) {
      throw new SceneGroupWorkflowError('document-update-forbidden', 'preflight-preview', {
        identities: forbidden.map(document => document.uuid), message: 'You cannot update every item in this group.'
      });
    }
    const records = documents.map((document) => {
      const original = readSceneGroupMemberTransformState(document, operation);
      const originalTileDocument = document?.documentName === 'Tile'
        ? {
          // Move plans intentionally omit dimensions. Renderer baselines still
          // need the complete pre-gesture pose for flattened Tile normalization.
          x: Number(document.x),
          y: Number(document.y),
          width: Number(document.width),
          height: Number(document.height),
          rotation: Number(document.rotation) || 0,
          texture: {
            anchorX: Number(document?.texture?.anchorX ?? 0.5),
            anchorY: Number(document?.texture?.anchorY ?? 0.5)
          },
          _source: {
            flags: { 'fa-nexus': structuredClone(original['flags.fa-nexus'] || {}) }
          }
        }
        : null;
      return {
        document,
        original,
        originalTileDocument,
        originalTileSize: document?.documentName === 'Tile'
          ? { width: Number(document.width), height: Number(document.height) }
          : null,
        displayPreview: captureTilePreviewDisplay(document),
        preservedDisplayPreviews: capturePreservedTilePreviewDisplays(document)
      };
    });
    const neutralTransform = operation === 'move'
      ? { operation, delta: { x: 0, y: 0 } }
      : operation === 'scale'
        ? { operation, factor: 1 }
        : { operation, angle: 0 };
    for (const record of records) {
      buildSceneGroupMemberTransformTarget(record.document, record.original, drag.pivot, neutralTransform);
    }
    const tileDocuments = records
      .map((record) => record.document)
      .filter((document) => document?.documentName === 'Tile');
    const source = `scene-group-${operation}:${drag.groupId}`;
    let shadowSuppression = null;
    let portalSuppression = null;
    let perceptionPreview = null;
    try {
      shadowSuppression = tileDocuments.length
        ? getAssetShadowManager()?.beginTransformPreviewSuppression?.({
            documents: tileDocuments,
            source,
            operation: operation === 'move'
              ? 'translate'
              : operation === 'rotate'
                ? 'rotate'
                : 'scale',
            pivot: ['rotate', 'scale'].includes(operation) ? drag.pivot : null
          })
        : null;
      portalSuppression = doorTransformPreviewRuntime.begin({
        documents,
        source
      });
      perceptionPreview = beginLocalWallPerceptionPreview(documents, { source });
      if (perceptionPreview?.supported === false) {
        Logger.warn('SceneGroupOverlay.wallPerceptionPreviewUnavailable', {
          groupId: drag.groupId,
          operation,
          reason: perceptionPreview.reason,
          regionIds: perceptionPreview.blockedRegionIds
        });
      }
    } catch (error) {
      shadowSuppression?.cancel?.();
      portalSuppression?.cancel?.();
      perceptionPreview?.cancel?.();
      throw error;
    }
    return {
      operation,
      records,
      applied: false,
      shadowSuppression,
      portalSuppression,
      perceptionPreview
    };
  }

  _applyMemberPreview(drag) {
    const preview = drag.memberPreview;
    if (!preview) return;
    const transform = preview.operation === 'move'
      ? { operation: 'move', delta: drag.delta }
      : preview.operation === 'scale'
        ? { operation: 'scale', factor: drag.factor }
        : { operation: 'rotate', angle: drag.angle };
    const targets = preview.records.map((record) => ({
      record,
      target: buildSceneGroupMemberTransformTarget(
        record.document,
        record.original,
        drag.pivot,
        transform
      )
    }));
    preview.applied = true;
    for (const { record, target } of targets) {
      beginMemberSemanticPreview(record);
      // Consume every Tile's queued transform flags before synchronizing its
      // family-specific display, so rapid reversals cannot mix frame states.
      record.document.updateSource(memberPreviewChanges(target));
      refreshMemberPreviewObject(record.document, {operation:preview.operation});
      if (record.document?.documentName === 'Tile') {
        record.document.object?.applyRenderFlags?.();
      }
      syncMemberSemanticPreview(record);
    }
    if (preview.operation === 'move') {
      preview.shadowSuppression?.updateTranslation?.(drag.delta);
    } else if (preview.operation === 'rotate') {
      preview.shadowSuppression?.updateRotation?.({
        angle: drag.angle,
        pivot: drag.pivot
      });
    } else if (preview.operation === 'scale') {
      preview.shadowSuppression?.updateScale?.({
        factor: drag.factor,
        pivot: drag.pivot
      });
    }
    preview.perceptionPreview?.apply?.();
  }

  _applyQueuedPreview({ drag, frame, pivot }) {
    this._drawOverlay(frame, pivot);
    this._applyMemberPreview(drag);
  }

  _queuePreview(drag, frame, pivot) {
    this._pendingPreview = { drag, frame, pivot };
    if (this._previewAnimationFrameId !== null) return;
    if (typeof globalThis.requestAnimationFrame !== 'function') {
      this._pendingPreview = null;
      throw new Error('Scene Group live preview requires animation-frame scheduling.');
    }
    this._previewAnimationFrameId = globalThis.requestAnimationFrame(() => {
      this._previewAnimationFrameId = null;
      const pending = this._pendingPreview;
      this._pendingPreview = null;
      if (!pending || this._activeDrag !== pending.drag) return;
      try {
        this._applyQueuedPreview(pending);
      } catch (error) {
        this._abortActiveDrag(pending.drag, error);
      }
    });
  }

  _cancelQueuedPreview(drag = null) {
    if (drag && this._pendingPreview?.drag !== drag) return;
    if (this._previewAnimationFrameId !== null) {
      if (typeof globalThis.cancelAnimationFrame !== 'function') {
        throw new Error('Scene Group live preview cannot cancel its animation frame.');
      }
      globalThis.cancelAnimationFrame(this._previewAnimationFrameId);
    }
    this._previewAnimationFrameId = null;
    this._pendingPreview = null;
  }

  _flushQueuedPreview(drag) {
    if (this._pendingPreview?.drag !== drag) return;
    const pending = this._pendingPreview;
    this._cancelQueuedPreview(drag);
    this._applyQueuedPreview(pending);
  }

  _restoreMemberPreview(drag, { render = true, releaseSuppression = true, acceptDisplayReplacement = false } = {}) {
    const preview = drag?.memberPreview;
    if (!preview) return [];
    if (!preview.applied) {
      preview.shadowSuppression?.cancel?.();
      preview.shadowSuppression = null;
      preview.portalSuppression?.cancel?.();
      preview.portalSuppression = null;
      preview.perceptionPreview?.cancel?.();
      preview.perceptionPreview = null;
      return preview.records || [];
    }
    const errors = [];
    for (const record of preview.records) {
      try {
        record.document.updateSource(memberPreviewChanges(buildSceneGroupTransformRestore(
          readSceneGroupMemberTransformState(record.document,preview.operation),record.original)));
        restoreTilePreviewDisplay(record);
        if (render) {
          refreshMemberPreviewObject(record.document);
          syncMemberSemanticPreview(record, { acceptReplacement: acceptDisplayReplacement });
        }
      } catch (error) {
        errors.push(error);
      } finally {
        // A lost/reparented display can make restoration fail. Still release
        // every surviving participant so ordinary rendering can recover.
        try {
          clearMemberSemanticPreview(record, { sync: !render });
        } catch (error) {
          errors.push(error);
        }
      }
    }
    try {
      preview.perceptionPreview?.cancel?.();
      preview.perceptionPreview = null;
    } catch (error) {
      errors.push(error);
    }
    preview.applied = false;
    if (releaseSuppression) {
      for (const key of ['shadowSuppression', 'portalSuppression']) {
        try { preview[key]?.cancel?.(); } catch (error) { errors.push(error); }
        preview[key] = null;
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Failed to restore Scene Group live preview state.');
    return preview.records;
  }

  _prepareMemberPreviewCommit(drag) {
    const preview = drag?.memberPreview;
    if (!preview?.applied) return preview?.records || [];
    const errors = [];
    for (const record of preview.records) {
      try {
        // Consume the final preview's render flags before restoring source data
        // for transform planning. Otherwise Foundry's next OBJECTS tick can
        // redraw Walls and other native placeables from the original source
        // while the asynchronous commit is still pending.
        const object = record.document.object;
        object?.applyRenderFlags?.();
        if (record.document.documentName === 'Region' && object) {
          // Region refresh only invalidates its GPU buffers. Materialize them
          // while the final preview shapes still own the source, before the
          // planner restores it; the next draw must not read the old shapes.
          if (typeof object.geometry?._updateBuffers !== 'function') {
            throw new Error(`Region ${record.document.uuid} cannot finalize its native preview geometry.`);
          }
          object.geometry._updateBuffers();
        }
        clearMemberSemanticPreview(record, {
          sync: false, preservePathPreview: true, preserveDisplayPreview: true
        });
        // Transform planning must read the persisted state, but the Pixi display
        // stays at the held preview until the asynchronous Foundry commit owns it.
        record.document.updateSource(memberPreviewChanges(buildSceneGroupTransformRestore(
          readSceneGroupMemberTransformState(record.document,preview.operation),record.original)));
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Failed to prepare Scene Group live preview for commit.');
    return preview.records;
  }

  _completeMemberPreviewCommit(drag) {
    const preview = drag?.memberPreview;
    if (!preview) return;
    for (const record of preview.records || []) clearMemberSemanticPreview(record, { sync: false });
    preview.perceptionPreview?.complete?.();
    preview.perceptionPreview = null;
    preview.applied = false;
  }

  async _completeShadowSuppressionCommit(drag) {
    const preview = drag?.memberPreview;
    const suppression = preview?.shadowSuppression;
    if (!suppression) return;
    try {
      await suppression.commit();
      preview.shadowSuppression = null;
    } catch (error) {
      Logger.warn('SceneGroupOverlay.shadowCommitHandoffRetry', {
        kind: drag?.kind || null,
        groupId: drag?.groupId || null,
        details: error?.details || null,
        error: String(error?.message || error)
      });
      try {
        await suppression.commit();
        preview.shadowSuppression = null;
      } catch (retryError) {
        suppression.abandon?.('scene-group-rebuild-handoff-failed');
        preview.shadowSuppression = null;
        Logger.error('SceneGroupOverlay.shadowCommitHandoffFailed', {
          kind: drag?.kind || null,
          groupId: drag?.groupId || null,
          details: retryError?.details || null,
          error: String(retryError?.message || retryError)
        });
        notifySceneGroupFailure(retryError, 'Scene Group shadows could not finish rebuilding');
      }
    }
  }

  async _restoreShadowSuppressionAfterCommitFailure(drag) {
    const preview = drag?.memberPreview;
    const suppression = preview?.shadowSuppression;
    if (!suppression) return;
    await suppression.fail();
    preview.shadowSuppression = null;
  }

  async _completePortalSuppressionCommit(drag) {
    const preview = drag?.memberPreview;
    const suppression = preview?.portalSuppression;
    if (!suppression) return;
    try {
      await suppression.commit();
      preview.portalSuppression = null;
    } catch (error) {
      Logger.warn('SceneGroupOverlay.portalCommitHandoffRetry', {
        kind: drag?.kind || null,
        groupId: drag?.groupId || null,
        details: error?.details || null,
        error: String(error?.message || error)
      });
      try {
        await suppression.commit();
        preview.portalSuppression = null;
      } catch (retryError) {
        Logger.error('SceneGroupOverlay.portalCommitHandoffFailed', {
          kind: drag?.kind || null,
          groupId: drag?.groupId || null,
          details: retryError?.details || null,
          error: String(retryError?.message || retryError)
        });
        notifySceneGroupFailure(retryError, 'Scene Group portals are still waiting to finish rebuilding');
        this._continuePortalSuppressionCommit(drag, suppression);
      }
    }
  }

  _continuePortalSuppressionCommit(drag, suppression) {
    const preview = drag?.memberPreview;
    const continuation = suppression?.continueCommit?.();
    if (!continuation || typeof continuation.then !== 'function') {
      Logger.error('SceneGroupOverlay.portalBackgroundHandoffUnavailable', {
        kind: drag?.kind || null,
        groupId: drag?.groupId || null,
        details: suppression?.describe?.('commit-background-unavailable') || null
      });
      return;
    }
    preview.portalSuppressionContinuation = continuation;
    void continuation.then((completed) => {
      if (!completed || preview?.portalSuppression !== suppression) return;
      preview.portalSuppression = null;
      Logger.info('SceneGroupOverlay.portalBackgroundHandoffCompleted', {
        kind: drag?.kind || null,
        groupId: drag?.groupId || null
      });
    }).catch((error) => {
      Logger.error('SceneGroupOverlay.portalBackgroundHandoffFailed', {
        kind: drag?.kind || null,
        groupId: drag?.groupId || null,
        details: error?.details || null,
        error: String(error?.message || error)
      });
    }).finally(() => {
      if (preview?.portalSuppressionContinuation === continuation) {
        preview.portalSuppressionContinuation = null;
      }
    });
  }

  async _restorePortalSuppressionAfterCommitFailure(drag) {
    const preview = drag?.memberPreview;
    const suppression = preview?.portalSuppression;
    if (!suppression) return;
    await suppression.fail();
    preview.portalSuppression = null;
  }

  _restoreMemberPreviewAfterCommitFailure(drag, context) {
    try {
      // Restore the captured visuals before waiting for authoritative portals.
      // A rejected preflight emits no document update to replace the held pose.
      // Keep suppression until those restored visuals finish their handoff.
      this._restoreMemberPreview(drag, { render: true, releaseSuppression: false, acceptDisplayReplacement: true });
    } catch (error) {
      Logger.error('SceneGroupOverlay.commitPreviewRestoreFailed', {
        context,
        groupId: drag?.groupId || null,
        error: String(error?.message || error)
      });
      notifySceneGroupFailure(error, `Scene Group preview could not be restored`);
    }
  }

  _reportPreviewFailure(drag, error) {
    Logger[isSceneGroupOperationBlocked(error) ? 'debug' : 'error']('SceneGroupOverlay.livePreviewFailed', {
      kind: drag?.kind || null,
      groupId: drag?.groupId || null,
      code: error?.code || null,
      identities: error?.identities || [],
      error: String(error?.message || error)
    });
    notifySceneGroupFailure(error, `Scene Group live preview failed`);
  }

  _abortActiveDrag(drag, error, reason = 'live-preview-failed') {
    this._cancelQueuedPreview(drag);
    try {
      this._restoreMemberPreview(drag, { render: true });
    } catch (restoreError) {
      Logger.error('SceneGroupOverlay.livePreviewRestoreFailed', {
        kind: drag?.kind || null,
        groupId: drag?.groupId || null,
        error: String(restoreError?.message || restoreError)
      });
    }
    if (drag?.handle) {
      drag.handle.alpha = 0.65;
      drag.handle.cursor = drag.kind === 'rotate' ? 'grab' : drag.handle.cursor;
    }
    this._activeDrag = null;
    setOverlayDragActive(false);
    if (error) this._reportPreviewFailure(drag, error);
    this.scheduleRefresh(reason);
  }

  _onStagePointerDownCapture(event) {
    const button = Number(event?.button ?? event?.nativeEvent?.button ?? 0);
    this._pendingTilePointer = null;
    this._pendingCanvasDeselect = null;
    if (button !== 0 || this._activeDrag) return;
    if (this._deferredTilePointer) {
      stopPointerEvent(event);
      return;
    }
    if (targetBelongsToOverlayControl(event?.target, this._container)) return;
    const targetDocument = displayObjectDocument(event?.target);
    if (targetDocument && targetDocument.documentName !== 'Tile') return;

    const scene = canvas?.scene;
    const state = sceneGroupInteractionState.snapshot(scene);
    const selectedGroupId = state.primaryGroupId;
    if (!scene) return;
    const globalPoint = event?.global;
    if (![globalPoint?.x, globalPoint?.y].every((value) => Number.isFinite(Number(value)))) return;
    const nativeHandleName = nativeTileControlHandleName(event?.target);
    let nativeHandleTile = null;
    if (nativeHandleName && targetDocument?.documentName === 'Tile') {
      const mode = readSceneGroupMemberSelectionMode();
      const handleGesture = resolveSceneGroupMemberTileHandleGesture({
        documentUuid: targetDocument.uuid,
        handleName: nativeHandleName,
        mode,
        index: getSceneGroupInteractionIndex(scene)
      });
      if (handleGesture.kind === 'noop') {
        stopPointerEvent(event);
        return;
      }
      if (handleGesture.kind === 'group-move') {
        nativeHandleTile = targetDocument.object || null;
        if (!nativeHandleTile) {
          stopPointerEvent(event);
          this._reportPreviewFailure({
            kind: 'tile-move-arm',
            groupId: handleGesture.groupId,
            tileUuid: targetDocument.uuid
          }, new Error('The native Tile move handle lost its owning Canvas object.'));
          return;
        }
      }
    }
    // A native handle already provides an exact Tile owner. Alpha resolution is
    // only appropriate for body drags: sparse artwork such as an Inner-only
    // Building can have its centered move handle over completely transparent pixels.
    const tile = nativeHandleTile
      || TilePixelSelection.resolveTopmostOpaqueTileAtPoint(globalPoint.x, globalPoint.y);
    const tileUuid = String(tile?.document?.uuid || '').trim();
    if (!tileUuid) {
      if (!targetDocument && selectedGroupId && this._container?.visible
        && this._container.faNexusSceneGroupId === selectedGroupId) {
        this._pendingCanvasDeselect = {
          sceneId: String(scene.id || ''),
          groupId: selectedGroupId,
          globalStart: { x: Number(globalPoint.x), y: Number(globalPoint.y) }
        };
      }
      return;
    }
    const mode = readSceneGroupMemberSelectionMode();
    if (mode === 'individual') {
      if (!eventModifier(event, 'ctrlKey') && !eventModifier(event, 'metaKey') && !eventModifier(event, 'shiftKey')
        && state.selectedGroupIds.length) {
        sceneGroupInteractionState.clear(scene, 'exclusive-individual-press');
      }
      // A retained group selection must not take over a native member press.
      return;
    }
    const index = getSceneGroupInteractionIndex(scene);
    const selectedOwner = state.selectedGroupIds.find((id) => index.effectiveMemberUuidsByGroupId.get(id)?.has(tileUuid));
    const selectedOrdinary = !!selectedGroupId && tile.controlled && !index.directOwnerByUuid.has(tileUuid);
    const wasSelected = !!selectedOwner || selectedOrdinary;
    let groupId = wasSelected ? selectedGroupId : null;
    if (!groupId) {
      const selection = resolveSceneGroupMemberSelection({
        documentUuid: tileUuid,
        mode,
        index,
        event: {
          button,
          ctrlKey: eventModifier(event, 'ctrlKey'),
          metaKey: eventModifier(event, 'metaKey'),
          shiftKey: eventModifier(event, 'shiftKey')
        }
      });
      if (selection.kind !== 'group') return;
      groupId = selection.groupId;
    }
    const selectionEvent = { shiftKey: eventModifier(event, 'shiftKey'), ctrlKey: eventModifier(event, 'ctrlKey'), metaKey: eventModifier(event, 'metaKey') };
    if (!wasSelected) sceneGroupInteractionRuntime.selectCanvasGroup(scene, groupId, selectionEvent, { toggle: false });

    const point = eventCanvasPoint(event);
    if (this._pendingTransform) {
      if (!point) {
        stopPointerEvent(event);
        return;
      }
      const pendingTransform = this._pendingTransform;
      this._deferredTilePointer = {
        waitFor: pendingTransform,
        sceneId: String(scene.id || ''),
        groupId,
        tileUuid,
        pointerId: Number(event?.pointerId ?? event?.nativeEvent?.pointerId),
        start: { x: Number(point.x), y: Number(point.y) },
        current: { x: Number(point.x), y: Number(point.y) },
        globalStart: { x: Number(globalPoint.x), y: Number(globalPoint.y) },
        globalCurrent: { x: Number(globalPoint.x), y: Number(globalPoint.y) },
        shiftKey: eventModifier(event, 'shiftKey'),
        released: false
      };
      stopPointerEvent(event);
      return;
    }
    let frame = this._container?.visible && this._container.faNexusSceneGroupId === groupId
      ? this._container.faNexusSceneGroupFrame
      : null;
    let pivot = this._container?.visible && this._container.faNexusSceneGroupId === groupId
      ? this._container.faNexusSceneGroupPivot
      : null;
    if (!frame || !pivot) {
      try {
        ({ frame, pivot } = this._presentImmediateTileGroup(scene, index, groupId));
      } catch (error) {
        stopPointerEvent(event);
        this._reportPreviewFailure({ kind: 'tile-move-arm', groupId, tileUuid }, error);
        sceneGroupInteractionState.clear(scene, 'tile-move-arm-failed');
        return;
      }
    }
    const tileAnchor = { x: Number(tile.document?.x), y: Number(tile.document?.y) };
    if (!point || !frame || !pivot || ![tileAnchor.x, tileAnchor.y].every(Number.isFinite)) return;
    this._pendingTilePointer = {
      sceneId: String(scene.id || ''),
      groupId,
      tileUuid,
      clickedGroupId: selectedOwner || (selectedOrdinary ? null : groupId),
      toggleOnClick: wasSelected && Object.values(selectionEvent).some(Boolean),
      frame: { ...frame, center: { ...frame.center } },
      pivot: { ...pivot },
      start: { x: Number(point.x), y: Number(point.y) },
      globalStart: { x: Number(globalPoint.x), y: Number(globalPoint.y) },
      snapAnchor: resolveMoveSnapAnchor(scene, groupId, frame, tileAnchor, [tile.document])
    };
    // The explicitly selected Scene Group owns this opaque member gesture.
    // Prevent native Tile control from clearing that group selection before
    // the drag-resistance threshold promotes the pending pointer to a move.
    stopPointerEvent(event);
  }

  _updateTileMovePreview(drag, shiftKey) {
    const rawAnchor = {
      x: drag.snapAnchor.x + (drag.current.x - drag.start.x),
      y: drag.snapAnchor.y + (drag.current.y - drag.start.y)
    };
    const targetAnchor = shiftKey ? rawAnchor : snapLikeTile(rawAnchor);
    drag.delta = resolveSceneGroupMoveDelta(drag.memberPreview.records.map((record) => record.document), {
      x: targetAnchor.x - drag.snapAnchor.x, y: targetAnchor.y - drag.snapAnchor.y
    });
    drag.targetPivot = { x: drag.pivot.x + drag.delta.x, y: drag.pivot.y + drag.delta.y };
    this._queuePreview(drag, translateFrame(drag.frame, drag.delta), drag.targetPivot);
  }

  _matchesDeferredPointer(event, deferred) {
    const eventPointerId = Number(event?.pointerId ?? event?.nativeEvent?.pointerId);
    return !Number.isFinite(deferred?.pointerId)
      || !Number.isFinite(eventPointerId)
      || eventPointerId === deferred.pointerId;
  }

  _updateDeferredTilePointer(event, deferred) {
    if (!this._matchesDeferredPointer(event, deferred)) return false;
    const point = eventCanvasPoint(event);
    const globalPoint = event?.global;
    if (point && [point.x, point.y].every((value) => Number.isFinite(Number(value)))) {
      deferred.current = { x: Number(point.x), y: Number(point.y) };
    }
    if (globalPoint && [globalPoint.x, globalPoint.y].every((value) => Number.isFinite(Number(value)))) {
      deferred.globalCurrent = { x: Number(globalPoint.x), y: Number(globalPoint.y) };
    }
    deferred.shiftKey = eventModifier(event, 'shiftKey');
    return true;
  }

  _promoteTilePointerToDrag(pending) {
    this._ensureContainer();
    this._container.visible = true;
    this._container.faNexusSceneGroupId = pending.groupId;
    this._container.faNexusSceneGroupFrame = { ...pending.frame, center: { ...pending.frame.center } };
    this._container.faNexusSceneGroupPivot = { ...pending.pivot };
    const drag = {
      kind: 'move',
      source: 'tile',
      handle: null,
      groupId: pending.groupId,
      tileUuid: pending.tileUuid,
      frame: { ...pending.frame, center: { ...pending.frame.center } },
      pivot: { ...pending.pivot },
      start: { ...pending.start },
      current: { ...(pending.current || pending.start) },
      snapAnchor: { ...pending.snapAnchor },
      delta: { x: 0, y: 0 },
      targetPivot: { ...pending.pivot },
      factor: 1,
      angle: 0
    };
    drag.memberPreview = this._captureMemberPreview(drag);
    this._activeDrag = drag;
    setOverlayDragActive(true);
    return drag;
  }

  _resumeDeferredTilePointer(completedTransform) {
    const deferred = this._deferredTilePointer;
    if (!deferred || deferred.waitFor !== completedTransform) return;
    this._deferredTilePointer = null;
    if (this._activeDrag || this._pendingTransform) return;
    const scene = canvas?.scene;
    const state = sceneGroupInteractionState.snapshot(scene);
    if (String(scene?.id || '') !== deferred.sceneId || state.primaryGroupId !== deferred.groupId) return;
    const index = getSceneGroupInteractionIndex(scene);
    if (!this._moveSelection(deferred.groupId).documentUuids.includes(deferred.tileUuid)) return;
    const tile = globalThis.fromUuidSync?.(deferred.tileUuid)?.object || null;
    const tileAnchor = { x: Number(tile?.document?.x), y: Number(tile?.document?.y) };
    if (!tile || ![tileAnchor.x, tileAnchor.y].every(Number.isFinite)) return;

    let frame;
    let pivot;
    try {
      ({ frame, pivot } = this._presentImmediateTileGroup(scene, index, deferred.groupId));
    } catch (error) {
      this._reportPreviewFailure({
        kind: 'deferred-tile-move-arm',
        groupId: deferred.groupId,
        tileUuid: deferred.tileUuid
      }, error);
      return;
    }
    const pending = {
      sceneId: deferred.sceneId,
      groupId: deferred.groupId,
      tileUuid: deferred.tileUuid,
      frame: { ...frame, center: { ...frame.center } },
      pivot: { ...pivot },
      start: { ...deferred.start },
      current: { ...deferred.current },
      globalStart: { ...deferred.globalStart },
      snapAnchor: resolveMoveSnapAnchor(scene, deferred.groupId, frame, tileAnchor, [tile.document])
    };
    const distance = Math.hypot(
      deferred.globalCurrent.x - deferred.globalStart.x,
      deferred.globalCurrent.y - deferred.globalStart.y
    );
    if (distance < FOUNDRY_DRAG_RESISTANCE_PX) {
      if (!deferred.released) this._pendingTilePointer = pending;
      return;
    }
    let drag;
    try {
      drag = this._promoteTilePointerToDrag(pending);
      this._updateTileMovePreview(drag, deferred.shiftKey);
      this._flushQueuedPreview(drag);
    } catch (error) {
      if (drag) this._abortActiveDrag(drag, error, 'deferred-tile-move-preview-failed');
      else this._reportPreviewFailure({
        kind: 'deferred-tile-move',
        groupId: deferred.groupId,
        tileUuid: deferred.tileUuid
      }, error);
      return;
    }
    if (deferred.released) this._commitTileMoveDrag(drag);
  }

  _onStagePointerMove(event) {
    const deferred = this._deferredTilePointer;
    if (deferred && this._updateDeferredTilePointer(event, deferred)) {
      stopPointerEvent(event);
      return;
    }
    const globalPoint = event?.global;
    if (this._pendingCanvasDeselect
      && [globalPoint?.x, globalPoint?.y].every((value) => Number.isFinite(Number(value)))) {
      const distance = Math.hypot(
        Number(globalPoint.x) - this._pendingCanvasDeselect.globalStart.x,
        Number(globalPoint.y) - this._pendingCanvasDeselect.globalStart.y
      );
      if (distance >= FOUNDRY_DRAG_RESISTANCE_PX) this._pendingCanvasDeselect = null;
    }
    let drag = this._activeDrag;
    if (!drag || drag.source !== 'tile') {
      const pending = this._pendingTilePointer;
      if (!pending || ![globalPoint?.x, globalPoint?.y].every((value) => Number.isFinite(Number(value)))) return;
      const distance = Math.hypot(
        Number(globalPoint.x) - pending.globalStart.x,
        Number(globalPoint.y) - pending.globalStart.y
      );
      if (distance < FOUNDRY_DRAG_RESISTANCE_PX) return;
      this._pendingTilePointer = null;
      try {
        drag = this._promoteTilePointerToDrag(pending);
      } catch (error) {
        stopPointerEvent(event);
        if (drag) this._abortActiveDrag(drag, error);
        else this._reportPreviewFailure({
          kind: 'tile-move-arm',
          groupId: pending.groupId,
          tileUuid: pending.tileUuid
        }, error);
        return;
      }
    }
    const point = eventCanvasPoint(event);
    if (!point) return;
    drag.current = { x: Number(point.x), y: Number(point.y) };
    try {
      this._updateTileMovePreview(drag, eventModifier(event, 'shiftKey'));
    } catch (error) {
      stopPointerEvent(event);
      this._abortActiveDrag(drag, error);
      return;
    }
    stopPointerEvent(event);
  }

  _onStagePointerUpCapture(event) {
    const deferred = this._deferredTilePointer;
    if (deferred && this._updateDeferredTilePointer(event, deferred)) {
      deferred.released = true;
      stopPointerEvent(event);
      return;
    }
    const drag = this._activeDrag;
    if (!drag || drag.source !== 'tile') {
      const pendingTile = this._pendingTilePointer;
      this._pendingTilePointer = null;
      const pendingDeselect = this._pendingCanvasDeselect;
      this._pendingCanvasDeselect = null;
      if (pendingTile) {
        const selectionEvent = {
          button: 0,
          ctrlKey: eventModifier(event, 'ctrlKey'),
          metaKey: eventModifier(event, 'metaKey'),
          shiftKey: eventModifier(event, 'shiftKey')
        };
        stopPointerEvent(event);
        queueMicrotask(() => {
          const scene = canvas?.scene;
          const state = sceneGroupInteractionState.snapshot(scene);
          if (String(scene?.id || '') !== pendingTile.sceneId
            || state.primaryGroupId !== pendingTile.groupId) return;
          const tile = globalThis.fromUuidSync?.(pendingTile.tileUuid)?.object || null;
          if (!tile || typeof tile.control !== 'function') {
            const error = new Error(`Native Tile selection is unavailable for ${pendingTile.tileUuid}.`);
            this._reportPreviewFailure({ kind: 'tile-click', groupId: pendingTile.groupId }, error);
            return;
          }
          try {
            const mode = readSceneGroupMemberSelectionMode();
            const selection = resolveSceneGroupMemberSelection({
              documentUuid: pendingTile.tileUuid,
              mode,
              index: getSceneGroupInteractionIndex(scene),
              event: selectionEvent
            });
            if (selection.kind === 'group') {
              if (pendingTile.toggleOnClick) sceneGroupInteractionRuntime.selectCanvasGroup(scene, pendingTile.clickedGroupId || selection.groupId, selectionEvent);
              return;
            }
            if (pendingTile.toggleOnClick) tile.release();
          } catch (error) {
            this._reportPreviewFailure({ kind: 'tile-click', groupId: pendingTile.groupId }, error);
          }
        });
        return;
      }
      if (pendingDeselect) {
        const globalPoint = event?.global;
        const distance = [globalPoint?.x, globalPoint?.y].every((value) => Number.isFinite(Number(value)))
          ? Math.hypot(
              Number(globalPoint.x) - pendingDeselect.globalStart.x,
              Number(globalPoint.y) - pendingDeselect.globalStart.y
            )
          : Number.POSITIVE_INFINITY;
        if (distance < FOUNDRY_DRAG_RESISTANCE_PX) {
          queueMicrotask(() => {
            const scene = canvas?.scene;
            const state = sceneGroupInteractionState.snapshot(scene);
            if (String(scene?.id || '') !== pendingDeselect.sceneId
              || state.primaryGroupId !== pendingDeselect.groupId) return;
            sceneGroupInteractionState.clear(scene, 'empty-canvas-click');
          });
        }
      }
      return;
    }
    this._onStagePointerMove(event);
    if (this._activeDrag !== drag) return;
    stopPointerEvent(event);
    this._commitTileMoveDrag(drag);
  }

  _commitTileMoveDrag(drag) {
    if (!drag || this._activeDrag !== drag || drag.source !== 'tile') return;
    const unchanged = Math.abs(drag.delta.x) < 0.001 && Math.abs(drag.delta.y) < 0.001;
    try {
      this._flushQueuedPreview(drag);
      if (unchanged) this._restoreMemberPreview(drag, { render: true });
      else this._prepareMemberPreviewCommit(drag);
    } catch (error) {
      this._abortActiveDrag(drag, error, 'tile-move-preview-handoff-failed');
      return;
    }
    this._activeDrag = null;
    setOverlayDragActive(false);
    if (unchanged) {
      this.scheduleRefresh('tile-move-noop');
      return;
    }
    drag.memberPreview?.shadowSuppression?.prepareCommit?.();
    drag.memberPreview?.portalSuppression?.prepareCommit?.();
    const pending = this._workflow.execute({
      scene: canvas?.scene,
      user: game?.user,
      action: {
        type: 'move-group',
        groupId: drag.groupId,
        groupIds: drag.moveSelection.groupIds,
        documentUuids: drag.moveSelection.standaloneDocumentUuids,
        expectedDocumentUuids: drag.moveSelection.documentUuids,
        delta: drag.delta
      }
    })
      .then(async () => {
        await this._completeShadowSuppressionCommit(drag);
        await this._completePortalSuppressionCommit(drag);
        this._completeMemberPreviewCommit(drag);
        return sceneGroupInteractionState.snapshot(canvas?.scene);
      })
      .catch(async (error) => {
        this._restoreMemberPreviewAfterCommitFailure(drag, 'tile-move');
        try {
          await this._restoreShadowSuppressionAfterCommitFailure(drag);
        } catch (shadowError) {
          Logger.error('SceneGroupOverlay.shadowRollbackHandoffFailed', {
            groupId: drag.groupId,
            tileUuid: drag.tileUuid,
            details: shadowError?.details || null,
            error: String(shadowError?.message || shadowError)
          });
        }
        try {
          await this._restorePortalSuppressionAfterCommitFailure(drag);
        } catch (portalError) {
          Logger.error('SceneGroupOverlay.portalRollbackHandoffFailed', {
            groupId: drag.groupId,
            tileUuid: drag.tileUuid,
            details: portalError?.details || null,
            error: String(portalError?.message || portalError)
          });
        }
        Logger.error('SceneGroupOverlay.tileMoveFailed', {
          groupId: drag.groupId,
          tileUuid: drag.tileUuid,
          code: error?.code || null,
          identities: error?.identities || [],
          error: String(error?.message || error)
        });
        notifySceneGroupFailure(error, `Scene Group move failed`);
      })
      .finally(() => {
        if (this._pendingTransform === pending) {
          this._pendingTransform = null;
          this._resumeDeferredTilePointer(pending);
        }
        this.scheduleRefresh('tile-move-complete');
      });
    this._pendingTransform = pending;
  }

  _onStagePointerCancelCapture(event) {
    const deferred = this._deferredTilePointer;
    if (deferred && this._matchesDeferredPointer(event, deferred)) {
      this._deferredTilePointer = null;
      stopPointerEvent(event);
      return;
    }
    this._pendingTilePointer = null;
    this._pendingCanvasDeselect = null;
    if (this._activeDrag?.source !== 'tile') return;
    stopPointerEvent(event);
    this._abortActiveDrag(this._activeDrag, null, 'tile-move-cancel');
  }

  _onKeyDownCapture(event) {
    if (!this._activeDrag) return;
    if (event?.key === 'Escape') {
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
      this._abortActiveDrag(this._activeDrag, null, 'escape-cancel');
      return;
    }
    if (event?.key === 'Shift' && !event?.repeat) this._updateActiveDragModifier(true);
  }

  _onKeyUpCapture(event) {
    if (event?.key === 'Shift' && this._activeDrag) this._updateActiveDragModifier(false);
  }

  _updateActiveDragModifier(shiftKey) {
    const drag = this._activeDrag;
    if (!drag || !['move', 'rotate', 'pivot'].includes(drag.kind)) return;
    try {
      if (drag.source === 'tile') this._updateTileMovePreview(drag, shiftKey);
      else this._updateHandlePreview(drag, shiftKey);
    } catch (error) {
      this._abortActiveDrag(drag, error, 'modifier-preview-failed');
    }
  }

  _onHandlePointerDown(event, handle) {
    const button = Number(event?.button ?? event?.nativeEvent?.button ?? 0);
    if (button !== 0 || this._activeDrag || this._pendingTransform || !this._container?.visible) return;
    const point = eventCanvasPoint(event);
    const groupId = String(this._container.faNexusSceneGroupId || '').trim();
    const frame = this._container.faNexusSceneGroupFrame;
    const pivot = this._container.faNexusSceneGroupPivot;
    if (!point || !groupId || !frame || !pivot) return;
    const baseKind = handle.faNexusHandleKind;
    const kind = baseKind === 'move' && eventModifier(event, 'ctrlKey') ? 'pivot' : baseKind;
    const selection = this._moveSelection(groupId);
    if (kind !== 'move' && (sceneGroupInteractionState.snapshot(canvas.scene).selectedGroupIds.length > 1 || selection.standaloneDocumentUuids.length > 0)) return;
    const startDistance = Math.hypot(point.x - pivot.x, point.y - pivot.y);
    if ((kind === 'scale' || kind === 'rotate') && startDistance < 1) return;
    const startAngle = Math.atan2(point.y - pivot.y, point.x - pivot.x);
    stopPointerEvent(event);
    const drag = {
      kind,
      source: 'handle',
      handle,
      groupId,
      frame: { ...frame, center: { ...frame.center } },
      pivot: { ...pivot },
      start: { x: Number(point.x), y: Number(point.y) },
      current: { x: Number(point.x), y: Number(point.y) },
      startDistance,
      startAngle,
      snapAnchor: canvas.scene.getFlag('fa-nexus','compositionRegistry')?.groups[groupId]?.bounds ? frameCorners(frame)[0] : { ...pivot },
      delta: { x: 0, y: 0 },
      targetPivot: { ...pivot },
      factor: 1,
      angle: 0
    };
    try {
      drag.memberPreview = this._captureMemberPreview(drag);
    } catch (error) {
      this._reportPreviewFailure(drag, error);
      this.scheduleRefresh('handle-preview-blocked');
      return;
    }
    if (kind === 'move') {
      drag.snapAnchor = resolveMoveSnapAnchor(canvas.scene, groupId, frame, { ...pivot },
        (drag.memberPreview?.records || []).map((record) => record.document));
    }
    this._activeDrag = drag;
    setOverlayDragActive(true);
    handle.cursor = ['move', 'pivot', 'rotate'].includes(kind) ? 'grabbing' : handle.cursor;
    handle.alpha = 0.8;
    for (const candidate of [this._pivotHandle, ...this._scaleHandles, this._rotationHandle]) {
      if (candidate !== handle) candidate.eventMode = 'none';
    }
  }

  _updateHandlePreview(drag, shiftKey) {
    let frame = drag.frame;
    let pivot = drag.pivot;
    if (drag.kind === 'move') {
      const rawAnchor = {
        x: drag.snapAnchor.x + (drag.current.x - drag.start.x),
        y: drag.snapAnchor.y + (drag.current.y - drag.start.y)
      };
      const targetAnchor = shiftKey ? rawAnchor : snapLikeTile(rawAnchor);
      drag.delta = resolveSceneGroupMoveDelta(drag.memberPreview.records.map((record) => record.document), {
        x: targetAnchor.x - drag.snapAnchor.x, y: targetAnchor.y - drag.snapAnchor.y
      });
      drag.targetPivot = { x: drag.pivot.x + drag.delta.x, y: drag.pivot.y + drag.delta.y };
      frame = translateFrame(drag.frame, drag.delta);
      pivot = drag.targetPivot;
    } else if (drag.kind === 'pivot') {
      const rawPivot = {
        x: drag.pivot.x + (drag.current.x - drag.start.x),
        y: drag.pivot.y + (drag.current.y - drag.start.y)
      };
      drag.targetPivot = shiftKey ? rawPivot : snapLikeTile(rawPivot);
      pivot = drag.targetPivot;
    } else if (drag.kind === 'scale') {
      const distance = Math.hypot(drag.current.x - drag.pivot.x, drag.current.y - drag.pivot.y);
      drag.factor = Math.max(0.05, Math.min(20, distance / drag.startDistance));
      frame = scaleFrame(drag.frame, drag.pivot, drag.factor);
    } else {
      const currentAngle = Math.atan2(drag.current.y - drag.pivot.y, drag.current.x - drag.pivot.x);
      const rawAngle = normalizeSignedAngle((currentAngle - drag.startAngle) * (180 / Math.PI));
      const targetFrameAngle = shiftKey
        ? Math.round((drag.frame.angle + rawAngle) / 15) * 15
        : drag.frame.angle + rawAngle;
      drag.angle = normalizeSignedAngle(targetFrameAngle - drag.frame.angle);
      frame = rotateFrame(drag.frame, drag.pivot, drag.angle);
    }
    if (drag.kind === 'pivot') {
      this._drawOverlay(frame, pivot);
      return;
    }
    this._queuePreview(drag, frame, pivot);
  }

  _onHandlePointerMove(event, handle) {
    const drag = this._activeDrag;
    if (!drag || drag.handle !== handle) return;
    const point = eventCanvasPoint(event);
    if (!point) return;
    drag.current = { x: Number(point.x), y: Number(point.y) };
    try {
      this._updateHandlePreview(drag, eventModifier(event, 'shiftKey'));
    } catch (error) {
      stopPointerEvent(event);
      this._abortActiveDrag(drag, error);
      return;
    }
    stopPointerEvent(event);
  }

  _onHandlePointerUp(event, handle) {
    const drag = this._activeDrag;
    if (!drag || drag.handle !== handle) return;
    this._onHandlePointerMove(event, handle);
    if (this._activeDrag !== drag) return;
    const action = drag.kind === 'move'
      ? {
          type: 'move-group',
          groupId: drag.groupId,
          groupIds: drag.moveSelection.groupIds,
          documentUuids: drag.moveSelection.standaloneDocumentUuids,
          expectedDocumentUuids: drag.moveSelection.documentUuids,
          delta: drag.delta
        }
      : drag.kind === 'pivot'
        ? {
            type: 'set-group-pivot',
            groupId: drag.groupId,
            mode: SCENE_GROUP_PIVOT_MODES.CUSTOM,
            pivot: drag.targetPivot
          }
        : drag.kind === 'rotate'
          ? { type: 'rotate-group', groupId: drag.groupId, angle: drag.angle }
          : { type: 'scale-group', groupId: drag.groupId, factor: drag.factor };
    const unchanged = drag.kind === 'move'
      ? Math.abs(action.delta.x) < 0.001 && Math.abs(action.delta.y) < 0.001
      : drag.kind === 'pivot'
        ? Math.abs(action.pivot.x - drag.pivot.x) < 0.001
          && Math.abs(action.pivot.y - drag.pivot.y) < 0.001
        : drag.kind === 'rotate'
          ? Math.abs(action.angle) < 0.001
          : Math.abs(action.factor - 1) < 0.0001;
    try {
      this._flushQueuedPreview(drag);
      if (unchanged) this._restoreMemberPreview(drag, { render: true });
      else this._prepareMemberPreviewCommit(drag);
    } catch (error) {
      this._abortActiveDrag(drag, error, 'handle-preview-handoff-failed');
      return;
    }
    this._activeDrag = null;
    setOverlayDragActive(false);
    stopPointerEvent(event);
    handle.alpha = 0.65;
    handle.eventMode = 'none';
    if (unchanged) {
      this.scheduleRefresh('handle-noop');
      return;
    }
    drag.memberPreview?.shadowSuppression?.prepareCommit?.();
    drag.memberPreview?.portalSuppression?.prepareCommit?.();
    const pending = this._workflow.execute({ scene: canvas?.scene, user: game?.user, action })
      .then(async () => {
        await this._completeShadowSuppressionCommit(drag);
        await this._completePortalSuppressionCommit(drag);
        this._completeMemberPreviewCommit(drag);
        return sceneGroupInteractionState.snapshot(canvas?.scene);
      })
      .catch(async (error) => {
        this._restoreMemberPreviewAfterCommitFailure(drag, `handle-${drag.kind}`);
        try {
          await this._restoreShadowSuppressionAfterCommitFailure(drag);
        } catch (shadowError) {
          Logger.error('SceneGroupOverlay.shadowRollbackHandoffFailed', {
            kind: drag.kind,
            groupId: drag.groupId,
            details: shadowError?.details || null,
            error: String(shadowError?.message || shadowError)
          });
        }
        try {
          await this._restorePortalSuppressionAfterCommitFailure(drag);
        } catch (portalError) {
          Logger.error('SceneGroupOverlay.portalRollbackHandoffFailed', {
            kind: drag.kind,
            groupId: drag.groupId,
            details: portalError?.details || null,
            error: String(portalError?.message || portalError)
          });
        }
        Logger.error('SceneGroupOverlay.transformFailed', {
          kind: drag.kind,
          groupId: drag.groupId,
          code: error?.code || null,
          identities: error?.identities || [],
          error: String(error?.message || error)
        });
        notifySceneGroupFailure(error, `Scene Group ${drag.kind} failed`);
      })
      .finally(() => {
        if (this._pendingTransform === pending) {
          this._pendingTransform = null;
          this._resumeDeferredTilePointer(pending);
        }
        this.scheduleRefresh(`handle-${drag.kind}-complete`);
      });
    this._pendingTransform = pending;
  }

  _onPivotRightClick(event, handle) {
    if (handle !== this._pivotHandle || this._activeDrag || this._pendingTransform || !this._container?.visible) return;
    stopPointerEvent(event);
    const groupId = String(this._container.faNexusSceneGroupId || '').trim();
    if (!groupId) return;
    const timestamp = Number(event?.nativeEvent?.timeStamp ?? event?.timeStamp ?? performance.now());
    const clickCount = Number(event?.detail ?? event?.nativeEvent?.detail ?? 0);
    const repeated = clickCount >= 2 || (
      this._lastPivotRightClick?.groupId === groupId
      && timestamp - this._lastPivotRightClick.timestamp <= 500
    );
    this._lastPivotRightClick = repeated ? null : { groupId, timestamp };
    if (!repeated) return;

    handle.eventMode = 'none';
    const pending = this._workflow.execute({
      scene: canvas?.scene,
      user: game?.user,
      action: {
        type: 'set-group-pivot',
        groupId,
        mode: SCENE_GROUP_PIVOT_MODES.AUTOMATIC
      }
    })
      .then(() => sceneGroupInteractionState.selectGroup(canvas?.scene, groupId))
      .catch((error) => {
        Logger.error('SceneGroupOverlay.pivotResetFailed', {
          groupId,
          error: String(error?.message || error)
        });
        notifySceneGroupFailure(error, `Scene Group pivot reset failed`);
      })
      .finally(() => {
        if (this._pendingTransform === pending) this._pendingTransform = null;
        this.scheduleRefresh('pivot-reset-complete');
      });
    this._pendingTransform = pending;
  }

  _onHandlePointerCancel(event, handle) {
    if (this._activeDrag?.handle !== handle) return;
    stopPointerEvent(event);
    this._abortActiveDrag(this._activeDrag, null, 'handle-cancel');
  }

  clear(reason = 'manual') {
    this._cancelQueuedPreview();
    if (this._activeDrag) {
      try {
        this._restoreMemberPreview(this._activeDrag, { render: true });
      } catch (error) {
        Logger.error('SceneGroupOverlay.clearPreviewRestoreFailed', {
          reason,
          error: String(error?.message || error)
        });
      }
    }
    this._activeDrag = null;
    this._pendingTilePointer = null;
    this._deferredTilePointer = null;
    this._pendingCanvasDeselect = null;
    setOverlayDragActive(false);
    if (this._container) {
      try {
        this._container.destroy({ children: true });
      } catch (error) {
        Logger.error('SceneGroupOverlay.destroyFailed', {
          reason,
          error: String(error?.message || error)
        });
      }
    }
    this._container = null;
    this._graphics = null;
    this._pivotHandle = null;
    this._scaleHandles = [];
    this._rotationHandle = null;
    this._lastPivotRightClick = null;
  }
}

export const sceneGroupOverlayRuntime = new SceneGroupOverlayRuntime();
sceneGroupOverlayRuntime.initialize();

export function waitForSceneGroupOverlayTransformSettlement() {
  return sceneGroupOverlayRuntime.waitForPendingTransform();
}
