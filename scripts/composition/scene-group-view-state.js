import { NexusLogger as Logger } from '../core/nexus-logger.js';

const SETTING = 'sceneGroupViewState';
export class SceneGroupViewState {
  _all() {
    return globalThis.game?.settings?.get?.('fa-nexus', SETTING) || {};
  }
  read(scene) {
    const id = String(scene?.id || '');
    return this._all()[id] || { groups: [], structures: [], walls: [] };
  }
  windowPosition() {
    const saved = this._all().window || {};
    if (![saved.left, saved.top, saved.width, saved.height].every(Number.isFinite) || saved.width < 320 || saved.height < 240) return {};
    const width = Math.min(saved.width, globalThis.innerWidth || saved.width);
    const height = Math.min(saved.height, globalThis.innerHeight || saved.height);
    return { width, height, left: Math.max(0, Math.min(saved.left, (globalThis.innerWidth || width) - width)),
      top: Math.max(0, Math.min(saved.top, (globalThis.innerHeight || height) - height)) };
  }
  setWindowPosition(position) {
    const { left, top, width, height } = position;
    if (![left, top, width, height].every(Number.isFinite) || width < 320 || height < 240) return;
    const window = { left, top, width, height }, previous = this._all().window;
    if (previous && Object.keys(window).every(key => window[key] === previous[key])) return;
    return this._save({ ...this._all(), window });
  }
  expanded(scene, kind, id) { return (this.read(scene)[kind] || []).includes(id); }
  setExpanded(scene, kind, ids, expanded) {
    const view = { ...this.read(scene) }, values = new Set(view[kind] || []);
    for (const id of ids) { if (expanded) values.add(id); else values.delete(id); }
    view[kind] = [...values];
    const snapshot = { ...this._all(), [scene.id]: view };
    // Foundry v14 writes client settings synchronously before returning its
    // promise. The setting remains the sole authority, including after reload.
    return this._save(snapshot);
  }
  _save(snapshot) {
    return game.settings.set('fa-nexus', SETTING, snapshot).catch(error => {
      Logger.error('SceneGroups.viewState.saveFailed', { error: String(error?.message || error) });
      globalThis.ui?.notifications?.error?.('Could not save Scene Groups window preferences.');
    });
  }
  toggle(scene, kind, id) { this.setExpanded(scene, kind, [id], !this.expanded(scene, kind, id)); }
}
export const sceneGroupViewState = new SceneGroupViewState();
