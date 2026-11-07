const SURFACE_ATTRIBUTES = Object.freeze(['light', 'darkness', 'move', 'sight', 'sound', 'occlusion', 'exposure', 'culling']);

function values(collection) {
  return Array.from(collection?.values?.() ?? collection ?? []);
}

// Foundry v14 Scene.#updateSurfaces: detached behaviors are deliberately not active.
function deriveSurfaces(regions) {
  const surfaces = [];
  for (const region of regions) {
    if (region.hidden) continue;
    const bottom = { key: `${region.id},${region.elevation.bottom}`, region, elevation: region.elevation.bottom };
    const top = { key: `${region.id},${region.elevation.top}`, region, elevation: region.elevation.top };
    for (const attribute of SURFACE_ATTRIBUTES) bottom[attribute] = top[attribute] = false;
    const flat = region.elevation.bottom === region.elevation.top;
    for (const behavior of values(region.behaviors)) {
      if (behavior.disabled || behavior.type !== 'defineSurface') continue;
      const system = behavior.system;
      for (const attribute of SURFACE_ATTRIBUTES) {
        // DefineSurface.darkness is the native getter alias for light.
        const enabled = attribute === 'darkness' ? system.light : system[attribute];
        if (flat || system.placement === 'bottom' || system.placement === 'both') bottom[attribute] ||= enabled;
        if (flat || system.placement === 'top' || system.placement === 'both') top[attribute] ||= enabled;
      }
    }
    if (SURFACE_ATTRIBUTES.some(attribute => bottom[attribute])) surfaces.push(Object.freeze(bottom));
    if (!flat && SURFACE_ATTRIBUTES.some(attribute => top[attribute])) surfaces.push(Object.freeze(top));
  }
  return Object.freeze(surfaces.sort((a, b) => a.elevation - b.elevation));
}

function matches(surface, { type, level, occlusion, exposure, culling } = {}) {
  if (level !== undefined && !surface.region.includedInLevel(level)) return false;
  if (type !== undefined && !surface[type]) return false;
  return (occlusion === undefined || surface.occlusion === occlusion)
    && (exposure === undefined || surface.exposure === exposure)
    && (culling === undefined || surface.culling === culling);
}

function refreshNativeEffects(canvas) {
  canvas.perception.update({ initializeLighting: true, initializeVision: true,
    refreshLighting: true, refreshVision: true, refreshSounds: true, refreshOccludedSurfaces: true });
  canvas.tokens.recalculatePlannedMovementPaths();
  for (const token of canvas.tokens.placeables ?? []) {
    if (!token.controlled) token.renderFlags.set({ refreshVisibility: true });
  }
  globalThis.foundry?.canvas?.interaction?.MouseInteractionManager?.emulateMoveEvent?.();
}

/** Client-local, detached Region effects. No document lifecycle events or Scene collection writes. */
export function createBuildingV2SurfaceRegionSimulationV14({
  getCanvas = () => globalThis.canvas,
  getRegionDocumentClass = () => globalThis.CONFIG?.Region?.documentClass,
  getRegionObjectClass = () => globalThis.CONFIG?.Region?.objectClass,
  getRegionMeshClass = () => globalThis.foundry?.canvas?.placeables?.regions?.RegionMesh,
  getEraseBlendMode = () => globalThis.PIXI?.BLEND_MODES?.ERASE,
  getRandomId = () => globalThis.foundry.utils.randomID(16),
  refreshEffects = refreshNativeEffects
} = {}) {
  const states = new WeakMap();
  const stack = [];
  const hiddenMeshes = new Map();
  let lease;
  let generation = 0;

  function hideCommittedMesh(mesh) {
    const active = stack.at(-1);
    if (!active || active.meshes.includes(mesh)) return;
    const document = mesh.region?.document;
    if (!active.replacedRegionIds.includes(document?.id)) return;
    if (!values(document.behaviors).some(behavior => behavior.type === 'suppressWeather' && behavior.uuid === mesh.name)) return;
    if (!hiddenMeshes.has(mesh)) hiddenMeshes.set(mesh, mesh.renderable);
    mesh.renderable = false;
  }

  function reconcile() {
    for (const [mesh, renderable] of hiddenMeshes) {
      if (!mesh.destroyed) mesh.renderable = renderable;
    }
    hiddenMeshes.clear();
    for (const prepared of stack) {
      for (const mesh of prepared.meshes) mesh.renderable = prepared === stack.at(-1);
    }
    for (const mesh of lease?.suppression?.children ?? []) hideCommittedMesh(mesh);
  }

  function install(scene, suppression) {
    const descriptor = Object.getOwnPropertyDescriptor(scene, 'getSurfaces');
    const base = scene.getSurfaces;
    const wrapper = function(options) {
      const original = base.call(this, options);
      const active = stack.at(-1);
      if (!active) return original;
      const surfaces = original.filter(surface => !active.replacedRegionIds.includes(surface.region.id));
      surfaces.push(...active.surfaces.filter(surface => matches(surface, options)));
      return Object.freeze(surfaces.sort((a, b) => a.elevation - b.elevation));
    };
    Object.defineProperty(scene, 'getSurfaces', { configurable: true, enumerable: descriptor?.enumerable ?? false,
      writable: true, value: wrapper });
    lease = { scene, suppression, descriptor };
    suppression.on('childAdded', hideCommittedMesh);
  }

  function uninstall() {
    if (!lease) return;
    const { scene, suppression, descriptor } = lease;
    suppression.off('childAdded', hideCommittedMesh);
    if (descriptor) Object.defineProperty(scene, 'getSurfaces', descriptor);
    else delete scene.getSurfaces;
    lease = undefined;
  }

  function destroyResources(prepared) {
    const errors = [];
    for (const mesh of prepared.meshes) {
      try { if (!mesh.destroyed) mesh.destroy({ children: true }); } catch (error) { errors.push(error); }
    }
    for (const object of prepared.objects) {
      try {
        if (!object.destroyed) {
          const geometry = object.geometry;
          object.destroy({ children: true });
          geometry?.destroy();
        }
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Building V2 detached Surface Region cleanup failed.');
  }

  return Object.freeze({
    prepare({ sources = [], replacedRegionIds = [] } = {}) {
      const canvas = getCanvas();
      const scene = canvas?.scene;
      const suppression = canvas?.weather?.suppression;
      const DocumentClass = getRegionDocumentClass();
      const ObjectClass = getRegionObjectClass();
      const MeshClass = getRegionMeshClass();
      if (!Array.isArray(sources) || !Array.isArray(replacedRegionIds)) throw new Error('Surface Region simulation requires source and replacement arrays.');
      // RegionDocument construction registers token attachments, so reject before any construction.
      if (sources.some(source => source?.attachment?.token)) throw new Error('Surface Region simulation does not support token-attached Regions.');
      if (!scene || typeof scene.getSurfaces !== 'function' || !suppression?.addChild
        || !suppression.on || !suppression.off || typeof DocumentClass !== 'function'
        || typeof ObjectClass !== 'function' || typeof MeshClass !== 'function' || getEraseBlendMode() === undefined) {
        throw new Error('Building V2 Surface Region simulation requires Foundry v14 Region and weather APIs.');
      }
      const regions = [], objects = [], meshes = [];
      const id = ++generation;
      try {
        for (const source of sources) {
          const detachedSource = structuredClone(source);
          detachedSource._id = getRandomId();
          for (const behavior of detachedSource.behaviors ?? []) behavior._id ||= getRandomId();
          const region = new DocumentClass(detachedSource, { parent: scene });
          regions.push(region);
          const object = new ObjectClass(region);
          objects.push(object);
          object._previewType = 'creation';
          region._object = object;
          if (region.hidden || !region.includedInLevel(canvas.level)) continue;
          for (const behavior of values(region.behaviors)) {
            if (behavior.disabled || behavior.type !== 'suppressWeather') continue;
            const mesh = new MeshClass(object);
            meshes.push(mesh);
            mesh.name = `fa-nexus-building-v2.surface.${id}.${behavior.uuid}`;
            mesh.blendMode = getEraseBlendMode();
          }
        }
        const prepared = Object.freeze({ regions: Object.freeze(regions), objects: Object.freeze(objects),
          meshes: Object.freeze(meshes), surfaces: deriveSurfaces(regions),
          replacedRegionIds: Object.freeze([...new Set(replacedRegionIds)]) });
        states.set(prepared, { canvas, scene, suppression, released: false });
        return prepared;
      } catch (error) {
        try { destroyResources({ objects, meshes }); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Building V2 Surface Region preparation and cleanup failed.');
        }
        throw error;
      }
    },

    activate(prepared) {
      const state = states.get(prepared);
      if (!state || state.released) throw new Error('Cannot activate an unknown or released Surface Region projection.');
      if (stack.includes(prepared)) throw new Error('Surface Region projection is already active.');
      if (getCanvas()?.scene !== state.scene || (lease && lease.scene !== state.scene)) {
        throw new Error('Surface Region projection no longer belongs to the active Canvas Scene.');
      }
      try {
        if (!lease) install(state.scene, state.suppression);
        stack.push(prepared);
        for (const mesh of prepared.meshes) state.suppression.addChild(mesh);
        reconcile();
        refreshEffects(state.canvas);
        return prepared;
      } catch (error) {
        const index = stack.indexOf(prepared);
        if (index >= 0) stack.splice(index, 1);
        for (const mesh of prepared.meshes) { mesh.parent?.removeChild(mesh); mesh.renderable = false; }
        reconcile();
        if (!stack.length) uninstall();
        try { refreshEffects(state.canvas); } catch (restoreError) {
          throw new AggregateError([error, restoreError], 'Building V2 Surface Region activation and restored-effect refresh failed.');
        }
        throw error;
      }
    },

    release(prepared) {
      const state = states.get(prepared);
      if (!state || state.released) return false;
      const index = stack.indexOf(prepared);
      const wasActive = index === stack.length - 1 && index >= 0;
      if (index >= 0) stack.splice(index, 1);
      // Restore global seams before destruction or refresh can fail.
      reconcile();
      if (!stack.length) uninstall();
      destroyResources(prepared);
      state.released = true;
      if (wasActive) refreshEffects(state.canvas);
      return true;
    }
  });
}
