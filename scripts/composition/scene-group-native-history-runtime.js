import { notifySceneGroupFailure } from './scene-group-notifications.js';
import { waitForSceneNativeTileTransformTransactions } from '../canvas/native-tile-transform-transactions.js';
import {
  captureSceneGroupCommandHistoryContext,
  clearSceneGroupCommandHistory,
  discardSceneGroupCommand,
  isStaleSceneGroupHistoryFailure,
  pruneSceneGroupCommandHistory,
  waitForSceneGroupCommandSettlement,
  setSceneGroupCommandHistoryBridge
} from './scene-group-command-history.js';

export const SCENE_GROUP_HISTORY_TYPE = 'fa-nexus-scene-group';
const referenceId = (entry) => entry?.type === SCENE_GROUP_HISTORY_TYPE ? entry.data?.[0]?._id : null;

async function defaultExecuteUndo(scene, commandId) {
  const {SceneGroupWorkflow} = await import('./scene-group-workflow.js');
  return new SceneGroupWorkflow().execute({scene, user: globalThis.game?.user,
    action: {type: 'undo-group-command', commandId}});
}

export function initializeSceneGroupNativeHistoryRuntime({
  PlaceablesLayer = globalThis.foundry?.canvas?.layers?.PlaceablesLayer,
  layerClasses = [],
  getLayers = () => globalThis.canvas?.layers || [],
  getScene = () => globalThis.canvas?.ready ? globalThis.canvas.scene : null,
  executeUndo = defaultExecuteUndo,
  Hooks = globalThis.Hooks,
  isPaused = () => globalThis.game?.paused && !globalThis.game?.user?.isGM,
  getPendingOverlayTransform = () => null,
  beforeUndo = async () => {
    if (globalThis[Symbol.for('fa-nexus.scene-group-overlay-drag-active')]) {
      throw new Error('Finish the active Scene Group transform before undoing.');
    }
  }
} = {}) {
  if (!PlaceablesLayer?.prototype) throw new Error('Scene Group native history requires PlaceablesLayer.');
  const knownLayers = new Set();
  const restores = [];
  const patched = new Map();
  let generation = 0;
  let disposed = false;
  let pending = null;
  // The command whose Undo was refused last because the Scene no longer matches it (see undoHistory below).
  let refused = null;
  const layers = () => {
    for (const layer of getLayers()) if (Array.isArray(layer?.history)) knownLayers.add(layer);
    return [...knownLayers];
  };
  const remove = (id) => {
    for (const layer of layers()) layer.history = layer.history.filter((entry) => referenceId(entry) !== id);
  };
  const invalidate = () => {
    generation++;
    refused = null;
    clearSceneGroupCommandHistory();
    for (const layer of layers()) layer.history = layer.history.filter((entry) => !referenceId(entry));
    knownLayers.clear();
  };
  const bridge = {
    context: (scene) => !disposed && getScene() === scene ? generation : null,
    accepts: (scene, context) => !disposed && !!scene && getScene() === scene
      && (context === undefined || context === generation),
    remove,
    hasReference: (id) => layers().some((layer) => layer.history.some((entry) => referenceId(entry) === id)),
    register(scene, command) {
      refreshPatches();
      // Registry-only bounds edits participate in the same member-layer history,
      // without inventing document updates just to acquire an Undo entry.
      const types = new Set([...command.plans.map((plan) => plan.documentName), ...(command.documentTypes || [])]);
      const targets = [...getLayers()].filter((layer) => types.has(layer.constructor.documentName));
      if (!targets.length) return false;
      for (const layer of targets) {
        knownLayers.add(layer);
        layer._storeHistory(SCENE_GROUP_HISTORY_TYPE, [{_id: command.id}]);
      }
      return true;
    }
  };

  function patch(prototype, name, wrap) {
    if (!Object.hasOwn(prototype, name) || typeof prototype[name] !== 'function') return;
    const names = patched.get(prototype) || new Set();
    if (names.has(name)) return;
    names.add(name);
    patched.set(prototype, names);
    const original = prototype[name];
    const replacement = wrap(original);
    prototype[name] = replacement;
    restores.push(() => { if (prototype[name] === replacement) prototype[name] = original; });
  }

  function refreshPatches() {
    const prototypes = new Set([PlaceablesLayer.prototype, ...layerClasses.map((Class) => Class.prototype)]);
    // tearDown is inherited from CanvasLayer; patch its public entry point too.
    for (let prototype = Object.getPrototypeOf(PlaceablesLayer.prototype); prototype; prototype = Object.getPrototypeOf(prototype)) {
      if (Object.hasOwn(prototype, 'tearDown')) prototypes.add(prototype);
    }
    for (const layer of getLayers()) {
      for (let prototype = Object.getPrototypeOf(layer); prototype; prototype = Object.getPrototypeOf(prototype)) {
        prototypes.add(prototype);
        if (prototype === PlaceablesLayer.prototype) break;
      }
    }
    for (const prototype of prototypes) {
      patch(prototype, '_onUndoKey', (original) => function(...args) {
        if (!referenceId(this.history?.at(-1)) && !getPendingOverlayTransform()) return original.apply(this, args);
        void this.undoHistory().catch((error) => {
          notifySceneGroupFailure(error, 'Scene Group Undo failed');
          globalThis.console?.error('FA Nexus | Scene Group Undo failed', error);
        });
        return true;
      });
      patch(prototype, 'storeHistory', (original) => function(...args) {
        try { return original.apply(this, args); }
        finally { pruneSceneGroupCommandHistory(); }
      });
      patch(prototype, 'tearDown', (original) => function(...args) {
        if (this instanceof PlaceablesLayer) invalidate();
        return original.apply(this, args);
      });
      patch(prototype, 'undoHistory', (original) => function(...args) {
        // Either a native Root drag or the shared handles may still be writing
        // their command. Settle that gesture before choosing the history entry.
        const scene = getScene();
        const context = captureSceneGroupCommandHistoryContext(scene);
        const settlements = [waitForSceneNativeTileTransformTransactions(scene), getPendingOverlayTransform()].filter(Boolean);
        if (settlements.length) return Promise.all(settlements).then(() => {
          if (!bridge.accepts(scene, context)) throw new Error('Scene Group history was invalidated during Undo.');
          return this.undoHistory(...args);
        });
        const id = referenceId(this.history?.at(-1));
        if (!id) return original.apply(this, args);
        if (isPaused()) {
          globalThis.ui?.notifications?.warn('GAME.PausedWarning', {localize: true});
          return Promise.resolve([]);
        }
        if (pending) return pending.id === id ? pending.promise
          : Promise.reject(new Error('A Scene Group history command is already running.'));
        const promise = Promise.resolve().then(async () => {
          await beforeUndo();
          const settlement = waitForSceneGroupCommandSettlement(id);
          if (settlement) await settlement;
          if (!bridge.accepts(scene, context)) throw new Error('Scene Group history was invalidated during Undo.');
          if (isPaused()) {
            globalThis.ui?.notifications?.warn('GAME.PausedWarning', {localize: true});
            return [];
          }
          if (referenceId(this.history?.at(-1)) !== id) {
            throw new Error('Native history changed before Scene Group Undo could begin.');
          }
          return executeUndo(scene, id);
        }).then((result) => { refused = null; return result; }, (error) => {
          if (!isStaleSceneGroupHistoryFailure(error)) { refused = null; throw error; }
          if (refused !== id) {
            // First refusal: the step stays, so that it works once the later change has been reverted.
            refused = id;
            error.message = `${error.message} Press Ctrl+Z again to skip this step.`;
            throw error;
          }
          // Refused twice in a row: whatever changed is not something Undo can take back. The step leaves the
          // history and this key press goes on with the entry beneath it, instead of blocking every earlier step.
          refused = null;
          discardSceneGroupCommand(scene, {commandId: id});
          globalThis.ui?.notifications?.warn('Skipped an Undo step that no longer fits the Scene.');
          if (pending?.id === id) pending = null;
          return this.undoHistory(...args);
        }).finally(() => { if (pending?.promise === promise) pending = null; });
        pending = {id, promise};
        return promise;
      });
    }
  }
  setSceneGroupCommandHistoryBridge(bridge);
  refreshPatches();
  const hookIds = [
    ['canvasTearDown', Hooks?.on?.('canvasTearDown', invalidate)],
    ['canvasReady', Hooks?.on?.('canvasReady', () => { invalidate(); refreshPatches(); })]
  ];
  return () => {
    invalidate();
    disposed = true;
    for (const [name, id] of hookIds) if (id !== undefined) Hooks.off(name, id);
    for (const restore of restores.reverse()) restore();
    setSceneGroupCommandHistoryBridge(null);
  };
}

