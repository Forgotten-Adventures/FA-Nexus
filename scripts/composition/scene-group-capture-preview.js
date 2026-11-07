import { selectSceneMembers, revealHomogeneousSceneMembers } from './scene-group-member-actions.js';
import { sceneGroupInteractionState } from './scene-group-interaction-state.js';
import { getSceneGroupDocumentBounds } from './scene-group-workflow.js';

// One dialog owns these temporary display changes. No document visibility,
// relationships, audio playback, or shared textures are edited by inspection.
export class SceneGroupCapturePreview {
  constructor(scene = canvas.scene) {
    this.scene = scene;
    this.hidden = new Map();
    this.marker = document.createElement('div');
    this.marker.className = 'fa-nexus-scene-group-capture-marker';
    document.body.append(this.marker);
    this.closed = false;
    this.update = () => {
      if (this.closed) return;
      for (const state of this.hidden.values()) this._suppress(state);
      const candidate = this.hovered;
      const bounds = candidate && this.bounds(candidate);
      this.marker.hidden = !bounds || this.isSelected(candidate) || canvas.scene !== this.scene;
      if (!this.marker.hidden) {
        const matrix = canvas.stage.worldTransform;
        const a = matrix.apply({ x: bounds.minX, y: bounds.minY });
        const b = matrix.apply({ x: bounds.maxX, y: bounds.maxY });
        const view = canvas.app.view.getBoundingClientRect();
        Object.assign(this.marker.style, { left: `${view.left + Math.min(a.x, b.x) - 4}px`, top: `${view.top + Math.min(a.y, b.y) - 4}px`,
          width: `${Math.max(16, Math.abs(b.x - a.x) + 8)}px`, height: `${Math.max(16, Math.abs(b.y - a.y) + 8)}px` });
      }
      this.frame = requestAnimationFrame(this.update);
    };
    this.update();
  }

  hover(candidate) { this.hovered = candidate; }

  bounds(candidate) {
    const docs = candidate.memberUuids.map(uuid => fromUuidSync(uuid)).filter(doc => doc?.parent === this.scene);
    if (!docs.length) return null;
    const parts = docs.map(doc => ['AmbientLight', 'AmbientSound'].includes(doc.documentName)
      ? {minX:doc.x,minY:doc.y,maxX:doc.x,maxY:doc.y} : getSceneGroupDocumentBounds(doc));
    return {minX:Math.min(...parts.map(b=>b.minX)),minY:Math.min(...parts.map(b=>b.minY)),
      maxX:Math.max(...parts.map(b=>b.maxX)),maxY:Math.max(...parts.map(b=>b.maxY))};
  }

  isSelected(candidate) {
    if (!candidate) return false;
    if (candidate.groupId) return sceneGroupInteractionState.snapshot(this.scene).selectedGroupIds.includes(candidate.groupId);
    return !!fromUuidSync(candidate.memberUuid)?.object?.controlled;
  }

  async select(candidate, { focus = false } = {}) {
    if (this.closed || canvas.scene !== this.scene) return;
    this.selected = candidate;
    if (candidate.groupId) {
      await revealHomogeneousSceneMembers(candidate.memberUuids);
      if (this.closed) return;
      sceneGroupInteractionState.selectGroup(this.scene, candidate.groupId);
    } else {
      await selectSceneMembers([candidate.memberUuid], candidate.memberUuid);
      if (this.closed) return;
      sceneGroupInteractionState.selectMembers(this.scene, [candidate.memberUuid], { anchorUuid: candidate.memberUuid });
    }
    if (focus && !this.closed) {
      const b = this.bounds(candidate);
      if (b) await canvas.animatePan({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, duration: 200 });
    }
  }

  _suppress(state) {
    for (const doc of state.documents) {
      const object = doc.object;
      for (const display of [object, object?.mesh]) {
        if (!display || display.destroyed) continue;
        if (!state.displays.has(display)) state.displays.set(display, display.renderable);
        display.renderable = false;
      }
      const source = object?.lightSource;
      if (source?.suppression && !state.sources.has(source)) {
        state.sources.set(source, source.suppression.faNexusCapturePreview);
        source.suppression.faNexusCapturePreview = true;
        canvas.perception.update({ refreshLighting: true, refreshVision: true });
      }
    }
  }

  _restore(state) {
    for (const [display, renderable] of state.displays) if (!display.destroyed) display.renderable = renderable;
    for (const [source, previous] of state.sources) {
      if (previous === undefined) delete source.suppression.faNexusCapturePreview;
      else source.suppression.faNexusCapturePreview = previous;
    }
    for (const doc of state.documents) doc.object?.renderFlags?.set({ refreshState: true });
    if (state.sources.size) canvas.perception.update({ refreshLighting: true, refreshVision: true });
  }

  toggleHidden(candidate) {
    if (this.closed) return false;
    const existing = this.hidden.get(candidate.key);
    if (existing) { this.hidden.delete(candidate.key); this._restore(existing); return false; }
    const documents = candidate.memberUuids.map(uuid => fromUuidSync(uuid));
    if (documents.some(doc => !doc || doc.parent !== this.scene)) throw new Error('The capture item changed. Draw the area again.');
    const state = { documents, displays: new Map(), sources: new Map() };
    this.hidden.set(candidate.key, state);
    this._suppress(state);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    cancelAnimationFrame(this.frame);
    for (const state of this.hidden.values()) this._restore(state);
    this.hidden.clear();
    this.marker.remove();
  }
}
