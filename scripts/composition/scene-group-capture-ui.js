import { createCanvasGestureSession } from '../canvas/canvas-gesture-session.js';
import { SceneGroupCapturePreview } from './scene-group-capture-preview.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { captureReviewTree } from './scene-group-capture-plan.js';
import { createSceneGroupAppearanceControl } from './scene-group-icons.js';

export function selectSceneGroupArea() {
  let resolve, reject, start, session, finished = false;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const box = document.createElement('div'), hint = document.createElement('div');
  box.className = 'fa-nexus-scene-group-capture-box';
  hint.className = 'fa-nexus-scene-group-capture-hint';
  hint.textContent = 'Draw an area to create a Scene Group · Esc to cancel';
  document.body.append(box, hint);
  const finish = (value, error) => {
    if (finished) return;
    finished = true;
    box.remove(); hint.remove(); session?.stop('scene-group-area-complete');
    if (error) reject(error); else resolve(value);
  };
  const rectangle = (a, b) => ({ minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) });
  const consume = event => { event.preventDefault(); event.stopImmediatePropagation(); return true; };
  session = createCanvasGestureSession({
    pointerdown(event, { pointer }) {
      if (event.button !== 0 || !pointer.overCanvas || !pointer.zOk || !pointer.world) return false;
      start = { world: { ...pointer.world }, screen: { x: event.clientX, y: event.clientY } };
      return consume(event);
    },
    pointermove(event) {
      if (!start) return false;
      const bounds = rectangle(start.screen, { x: event.clientX, y: event.clientY });
      Object.assign(box.style, { display: 'block', left: `${bounds.minX}px`, top: `${bounds.minY}px`, width: `${bounds.maxX - bounds.minX}px`, height: `${bounds.maxY - bounds.minY}px` });
      return consume(event);
    },
    pointerup(event, { pointer }) {
      if (!start || event.button !== 0) return false;
      const screen = rectangle(start.screen, { x: event.clientX, y: event.clientY });
      finish(screen.maxX - screen.minX > 4 && screen.maxY - screen.minY > 4
        ? { ...rectangle(start.world, pointer.world), anchor: {clientX:event.clientX, clientY:event.clientY} } : null);
      return consume(event);
    },
    pointercancel(event) { finish(null); return consume(event); },
    keydown(event) { if (event.key !== 'Escape') return false; finish(null); return consume(event); },
    // Right-button gestures belong to Foundry's native pan. Keep the area
    // selector armed after panning; Escape explicitly cancels it.
    wheel(event) { return start ? consume(event) : false; }
  }, {
    exclusiveInput: true, lockPlaceableInteractivity: true,
    onStop: () => finish(null), onCanvasTearDown: () => finish(null),
    onHandlerError: error => { finish(null, error); return true; }
  });
  return { promise, cancel: () => finish(null) };
}

export async function reviewSceneGroupCapture(candidates, { anchor = {}, refresh = null } = {}) {
  const escape = foundry.utils.escapeHTML;
  const icons = { 'Existing Groups': 'fa-folder', Buildings: 'fa-building', Paths: 'fa-route', Tiles: 'fa-image',
    Walls: 'fa-grip-lines-vertical', Lights: 'fa-lightbulb', Sounds: 'fa-volume-high', Regions: 'fa-draw-polygon' };
  const preview = new SceneGroupCapturePreview();
  const appearance=createSceneGroupAppearanceControl();
  let dialogInstance, pendingSelection = Promise.resolve(), pendingRefresh = Promise.resolve(), refreshTimer, closed = false;
  let redraw = () => {}, report = error => Logger.error('SceneGroup.captureReview.failed', {error:String(error)});
  const included = new Set(candidates.map(candidate => candidate.key));
  const options = {groupByElevation:false, groupByFolder:false};
  const renderNodes = nodes => nodes.map(node => {
    if (node.children) return `<section class="fa-nexus-scene-group-capture-category" aria-label="${escape(node.name)}">
      <label class="fa-nexus-scene-group-capture-heading"><input type="checkbox" data-capture-category="${escape(node.key)}" aria-label="Include all ${escape(node.name)}"><i class="fa-solid fa-folder-open" aria-hidden="true"></i><strong>${escape(node.name)}</strong></label>${renderNodes(node.children)}</section>`;
    const candidate = node.candidate;
    return `<div class="fa-nexus-scene-group-capture-item ${preview.isSelected(candidate) ? 'is-selected' : ''}" data-capture-key="${escape(candidate.key)}">
      <input type="checkbox" name="captureItem" value="${escape(candidate.key)}" aria-label="Include ${escape(candidate.label)}" ${included.has(candidate.key) ? 'checked' : ''}>
      <i class="fa-solid ${icons[candidate.category] || 'fa-folder'}" aria-hidden="true"></i>
      <button type="button" data-capture-action="select" class="fa-nexus-scene-group-capture-label" title="${escape(candidate.label)}">${escape(candidate.label)}</button>
      ${candidate.memberUuids.length > 1 ? `<small title="Complete group or structure">${candidate.memberUuids.length} objects</small>` : ''}
      ${candidate.outsideCount ? `<small class="fa-nexus-scene-group-capture-outside" title="These members stay included outside the original area">${candidate.outsideCount} outside</small>` : ''}
      <button type="button" data-capture-action="focus" class="fa-nexus-scene-group-capture-tool" title="Focus on canvas" aria-label="Focus ${escape(candidate.label)}"><i class="fa-solid fa-crosshairs"></i></button>
      <button type="button" data-capture-action="hide" class="fa-nexus-scene-group-capture-tool" title="Temporarily hide on this client; restored when review closes" aria-label="Temporarily hide ${escape(candidate.label)}" aria-pressed="${preview.hidden.has(candidate.key)}"><i class="fa-solid fa-eye${preview.hidden.has(candidate.key) ? '-slash' : ''}"></i></button>
    </div>`;
  }).join('');
  const refreshNow = () => {
    clearTimeout(refreshTimer);
    if (!refresh || closed) return pendingRefresh;
    pendingRefresh = pendingRefresh.then(async () => {
      if (closed) return;
      const next = await refresh();
      if (closed) return;
      candidates = next;
      for (const key of included) if (!candidates.some(candidate => candidate.key === key)) included.delete(key);
      preview.hover(null);
      redraw();
    });
    return pendingRefresh;
  };
  const hooks = [];
  for (const type of ['Tile','Wall','AmbientLight','AmbientSound','Region','Scene']) for (const operation of ['update','delete']) {
    const name = `${operation}${type}`;
    hooks.push([name, Hooks.on(name, doc => {
      if (doc !== preview.scene && doc.parent !== preview.scene) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { void refreshNow().catch(report); }, 80);
    })]);
  }
  const teardown = Hooks.on('canvasTearDown', () => { preview.close(); void dialogInstance?.close(); });
  const content = `<div class="fa-nexus-scene-group-capture-review">
    <label class="fa-nexus-scene-group-capture-name"><span>Name</span><input name="captureName" value="Scene Group" required></label>
    ${appearance.html}
    <div class="fa-nexus-scene-group-capture-options"><span>Subgroups:</span><label><input type="checkbox" name="groupByElevation"> Elevation</label><label><input type="checkbox" name="groupByFolder"> Tile folders</label></div>
    <div class="fa-nexus-scene-group-capture-tree"></div><p>Groups and structures stay together. Preview hiding is temporary.</p><p class="fa-nexus-scene-group-capture-error" role="alert"></p></div>`;
  try { return await foundry.applications.api.DialogV2.wait({
    classes: ['fa-nexus-scene-group-capture-dialog'],
    window: { title: 'Create Scene Group from Area' }, position: { width: 510, height: 'auto', left: (anchor.clientX ?? 80) + 12, top: (anchor.clientY ?? 100) + 12 }, modal: false, content,
    render: (_event, dialog) => {
      const root = dialog.element;
      dialogInstance = dialog;
      appearance.bind(root);
      const update = () => {
        root.querySelector('[data-action="create"]').disabled = !root.querySelector('[name="captureName"]').value.trim() || !root.querySelector('[name="captureItem"]:checked');
        for (const section of root.querySelectorAll('.fa-nexus-scene-group-capture-category')) {
          const header = section.querySelector('[data-capture-category]');
          const boxes = [...section.querySelectorAll('[name="captureItem"]')];
          header.checked = boxes.every(box => box.checked);
          header.indeterminate = boxes.some(box => box.checked) && !header.checked;
        }
      };
      redraw = () => {
        const tree = root.querySelector('.fa-nexus-scene-group-capture-tree'), scroll = tree.scrollTop;
        tree.innerHTML = renderNodes(captureReviewTree(candidates, options));
        tree.scrollTop = scroll;
        update();
        const bounds = root.getBoundingClientRect();
        if (bounds.bottom > innerHeight - 8) dialog.setPosition({top:Math.max(8, innerHeight - bounds.height - 8)});
      };
      root.addEventListener('change', event => {
        if (event.target.matches('[data-capture-category]')) {
          for (const input of event.target.closest('section').querySelectorAll('[name="captureItem"]')) input.checked = event.target.checked;
        }
        for (const input of root.querySelectorAll('[name="captureItem"]')) {
          if (input.checked) included.add(input.value); else included.delete(input.value);
        }
        if (event.target.name in options) { options[event.target.name] = event.target.checked; redraw(); }
        update();
      });
      const candidateFor = target => candidates.find(candidate => candidate.key === target.closest('[data-capture-key]')?.dataset.captureKey);
      report = error => { Logger.error('SceneGroup.captureInspection.failed', { error: String(error?.message || error) }); root.querySelector('[role="alert"]').textContent = 'Could not refresh this capture. Close and draw the area again.'; };
      root.addEventListener('pointerover', event => preview.hover(candidateFor(event.target)));
      root.addEventListener('pointerleave', () => preview.hover(null));
      root.addEventListener('focusin', event => preview.hover(candidateFor(event.target)));
      root.addEventListener('click', event => {
        const action = event.target.closest('[data-capture-action]');
        const candidate = candidateFor(event.target);
        if (!action || !candidate) return;
        if (action.dataset.captureAction === 'hide') {
          try {
            const hidden = preview.toggleHidden(candidate);
            action.setAttribute('aria-pressed', String(hidden));
            action.querySelector('i').className = `fa-solid fa-eye${hidden ? '-slash' : ''}`;
          } catch (error) { report(error); }
        } else {
          for (const row of root.querySelectorAll('[data-capture-key]')) row.classList.toggle('is-selected', row.dataset.captureKey === candidate.key);
          pendingSelection = pendingSelection.then(() => preview.select(candidate, { focus: action.dataset.captureAction === 'focus' || event.detail === 2 })).catch(report);
        }
      });
      root.addEventListener('input', event => { if (event.target.name === 'captureName') update(); });
      redraw();
      const bounds = root.getBoundingClientRect();
      dialog.setPosition({ left:Math.max(8, Math.min((anchor.clientX ?? 80) + 12, innerWidth - bounds.width - 8)),
        top:Math.max(8, Math.min((anchor.clientY ?? 100) + 12, innerHeight - bounds.height - 8)) });
    },
    buttons: [
      { action: 'create', label: 'Create Group', default: true, callback: async (_event, _button, dialog) => {
        await pendingSelection;
        await refreshNow();
        const name = dialog.element.querySelector('[name="captureName"]').value.trim();
        const selectedKeys = [...dialog.element.querySelectorAll('[name="captureItem"]:checked')].map(input => input.value);
        if (!name || !selectedKeys.length) throw new Error('Enter a name and select at least one item.');
        return { name, ...appearance.value, selectedKeys, candidates, groupByElevation: dialog.element.querySelector('[name="groupByElevation"]').checked,
          groupByFolder: dialog.element.querySelector('[name="groupByFolder"]').checked };
      } },
      { action: 'cancel', type: 'button', label: 'Cancel', callback: () => false }
    ], rejectClose: false
  }); } finally {
    closed = true; clearTimeout(refreshTimer); preview.close(); Hooks.off('canvasTearDown', teardown);
    for (const [name, id] of hooks) Hooks.off(name, id);
    await pendingSelection;
  }
}
