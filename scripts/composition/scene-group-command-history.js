// Native layer entries own chronology; this map owns each complete payload once.
const commands = new Map();
const activeByScene = new Map();
let bridge = null;
let nextId = 0;
const clone = (value) => structuredClone(value);
const sceneId = (scene) => String(scene?.id || '');

export function setSceneGroupCommandHistoryBridge(value) {
  if (bridge && value && bridge !== value) throw new Error('Scene Group native history is already installed.');
  bridge = value;
}

export function captureSceneGroupCommandHistoryContext(scene) {
  return bridge?.context(scene) ?? null;
}

export function recordSceneGroupCommand(scene, command, context, { settlement } = {}) {
  const plans = Array.isArray(command?.plans) ? command.plans : [];
  if (!sceneId(scene) || !command?.groupId || !command?.operation
    || (!plans.length && !command?.registryDelta?.groups?.length && !command?.registryDelta?.relationships?.length)) {
    throw new Error('Scene Group command history requires a Scene, group, operation, and changed state.');
  }
  if (!bridge?.accepts(scene, context)) return null;
  const entry = clone({...command, plans, sceneId: sceneId(scene),
    id: globalThis.crypto?.randomUUID?.() || `scene-group-command-${++nextId}`});
  const record = { command: entry, settlement: null };
  commands.set(entry.id, record);
  try {
    if (!bridge.register(scene, entry)) {
      commands.delete(entry.id);
      return null;
    }
  } catch (error) {
    bridge.remove(entry.id);
    commands.delete(entry.id);
    throw error;
  }
  if (settlement) {
    record.settlement = Promise.resolve(settlement).then(plans => {
      // A Scene switch or history pruning must not revive the pending command.
      if (commands.get(entry.id) === record) record.command.plans = clone(plans);
    }).catch(error => {
      bridge?.remove(entry.id);
      commands.delete(entry.id);
      throw error;
    });
    void record.settlement.catch(() => {});
  }
  pruneSceneGroupCommandHistory();
  return clone(entry);
}

export function waitForSceneGroupCommandSettlement(commandId) {
  return commands.get(commandId)?.settlement;
}

export function beginSceneGroupCommand(scene, {commandId} = {}) {
  if (activeByScene.has(sceneId(scene))) throw new Error('A Scene Group history command is already running.');
  const command = commands.get(commandId)?.command;
  if (!command || command.sceneId !== sceneId(scene) || !bridge?.accepts(scene)) return null;
  activeByScene.set(sceneId(scene), commandId);
  return clone(command);
}

export function completeSceneGroupCommand(scene, {commandId} = {}) {
  // Teardown invalidates in-flight leases; completion must not recreate them.
  if (activeByScene.get(sceneId(scene)) !== commandId || !commands.has(commandId)) return null;
  const command = commands.get(commandId)?.command;
  bridge?.remove(commandId);
  commands.delete(commandId);
  activeByScene.delete(sceneId(scene));
  return clone(command);
}

export function cancelSceneGroupCommand(scene, {commandId} = {}) {
  if (activeByScene.get(sceneId(scene)) === commandId) activeByScene.delete(sceneId(scene));
}

/**
 * True when an Undo command was refused before any write because its group or its documents no longer match what
 * the command recorded. Retrying succeeds once that later change is reverted, so the command is kept.
 */
export function isStaleSceneGroupHistoryFailure(error) {
  if (error?.rollback && error.rollback.ok === false) return false;
  for (let current = error, depth = 0; current && depth < 6; current = current.cause, depth += 1) {
    if (current.code === 'group-history-diverged' || current.staleSceneGroupHistory === true) return true;
  }
  return false;
}

/** Drop a command the user chose to skip, together with its native history entries. */
export function discardSceneGroupCommand(scene, {commandId} = {}) {
  if (activeByScene.get(sceneId(scene)) === commandId) activeByScene.delete(sceneId(scene));
  bridge?.remove(commandId);
  return commands.delete(commandId);
}

export function clearSceneGroupCommandHistory(scene) {
  for (const [id, { command }] of commands) {
    if (scene && command.sceneId !== sceneId(scene)) continue;
    bridge?.remove(id);
    commands.delete(id);
  }
  if (scene) activeByScene.delete(sceneId(scene));
  else activeByScene.clear();
}

export function pruneSceneGroupCommandHistory() {
  for (const [id, { command }] of commands) {
    if (bridge?.hasReference(id)) continue;
    commands.delete(id);
    if (activeByScene.get(command.sceneId) === id) activeByScene.delete(command.sceneId);
  }
}
