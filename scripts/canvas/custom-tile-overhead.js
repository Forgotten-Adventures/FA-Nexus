import { NexusLogger as Logger } from '../core/nexus-logger.js'

const TILE_STATES = new Map()

const DEFAULT_PROXY_SIZE = 2
const MAX_PROXY_SIZE_FALLBACK = 4096
const MAX_PROXY_SIZE_CAP = 8192
const LATE_TEXTURE_REASON = 'late-texture'

const FILTER_FRAGMENT_SHADER = `
varying vec2 vTextureCoord;

uniform sampler2D uSampler;
uniform sampler2D occlusionTexture;
uniform vec2 screenDimensions;
uniform float occlusionElevation;
uniform float baseAlpha;
uniform float occludedAlpha;
uniform float fadeOcclusion;
uniform float radialOcclusion;
uniform float visionOcclusion;

void main() {
  vec4 color = texture2D(uSampler, vTextureCoord);
  vec2 maskCoord = gl_FragCoord.xy / max(screenDimensions, vec2(1.0));
  vec3 occluded = 1.0 - step(vec3(occlusionElevation), texture2D(occlusionTexture, maskCoord).rgb);
  float occlusion = max(occluded.r * fadeOcclusion, max(occluded.g * radialOcclusion, occluded.b * visionOcclusion));
  float alphaFactor = mix(baseAlpha, occludedAlpha, occlusion);
  gl_FragColor = color * alphaFactor;
}
`

function clamp(value, min, max, fallback = min) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

function resolveTileId(tile) {
  try {
    return tile?.document?.id || tile?.id || null
  } catch (_) {
    return null
  }
}

function shouldUseTileOcclusionProxy(tile) {
  try {
    const doc = tile?.document
    if (!doc) return false
    const mode = Number(doc.occlusion?.mode ?? doc._source?.occlusion?.mode)
    const occlusionModes = globalThis?.CONST?.OCCLUSION_MODES || {}
    const allowedModes = [
      Number(occlusionModes.FADE),
      Number(occlusionModes.RADIAL),
      Number(occlusionModes.VISION)
    ].filter(Number.isFinite)
    if (allowedModes.length) return allowedModes.includes(mode)
    return (mode === 1) || (mode === 3) || (mode === 4)
  } catch (_) {}
  return false
}

function getRenderer() {
  return canvas?.app?.renderer || null
}

function getTransparentFallbackTexture() {
  try {
    return PIXI.Texture.EMPTY
  } catch (_) {
    return null
  }
}

function getMaxProxyTextureSize() {
  try {
    const renderer = getRenderer()
    const gl = renderer?.gl || renderer?.context?.gl
    if (!gl) return MAX_PROXY_SIZE_FALLBACK
    const value = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE) || MAX_PROXY_SIZE_FALLBACK) || MAX_PROXY_SIZE_FALLBACK
    return Math.max(1024, Math.min(value, MAX_PROXY_SIZE_CAP))
  } catch (_) {
    return MAX_PROXY_SIZE_FALLBACK
  }
}

function resolveProxySize(tile, mesh) {
  const docWidth = Math.max(DEFAULT_PROXY_SIZE, Number(tile?.document?.width) || Number(mesh?._texture?.width) || DEFAULT_PROXY_SIZE)
  const docHeight = Math.max(DEFAULT_PROXY_SIZE, Number(tile?.document?.height) || Number(mesh?._texture?.height) || DEFAULT_PROXY_SIZE)
  const maxSize = getMaxProxyTextureSize()
  const scale = Math.min(1, maxSize / Math.max(docWidth, docHeight))
  const proxyWidth = Math.max(DEFAULT_PROXY_SIZE, Math.round(docWidth * scale))
  const proxyHeight = Math.max(DEFAULT_PROXY_SIZE, Math.round(docHeight * scale))
  return {
    docWidth,
    docHeight,
    proxyWidth,
    proxyHeight,
    scaleX: Math.max(1e-6, proxyWidth / docWidth),
    scaleY: Math.max(1e-6, proxyHeight / docHeight)
  }
}

function resolveAnchor(tile) {
  return {
    x: clamp(tile?.document?.texture?.anchorX, 0, 1, 0.5),
    y: clamp(tile?.document?.texture?.anchorY, 0, 1, 0.5)
  }
}

function invalidateMeshBounds(mesh, { clearTextureAlphaData = true } = {}) {
  try {
    if (!mesh || mesh.destroyed) return
    if (clearTextureAlphaData && ('_textureAlphaData' in mesh)) mesh._textureAlphaData = null
    if (Number.isFinite(mesh._canvasBoundsID)) mesh._canvasBoundsID += 1
    mesh.updateCanvasTransform?.()
  } catch (_) {}
}

function resolveMeshProxyAlphaData(texture) {
  try {
    const loader = foundry?.canvas?.TextureLoader || globalThis.TextureLoader || null
    return loader?.getTextureAlphaData?.(texture, 0.25) || null
  } catch (_) {
    return null
  }
}

function refreshMeshProxyAlphaData(state) {
  const proxyTexture = state?.proxyTexture
  state.proxyAlphaData = proxyTexture && !proxyTexture.destroyed
    ? resolveMeshProxyAlphaData(proxyTexture)
    : null
  try { if (state?.mesh) invalidateMeshBounds(state.mesh) } catch (_) {}
}

function destroyProxyMesh(state) {
  const proxyMesh = state?.proxyMesh
  if (!proxyMesh || proxyMesh.destroyed) return
  try { proxyMesh.parent = null } catch (_) {}
  try { proxyMesh.destroy({ children: true, texture: false, baseTexture: false }) } catch (_) {}
  state.proxyMesh = null
}

function ensureProxyMesh(state) {
  const mesh = state?.mesh
  const proxyTexture = state?.proxyTexture
  if (!mesh || mesh.destroyed || !proxyTexture || proxyTexture.destroyed) return null

  let proxyMesh = state.proxyMesh
  if (proxyMesh?.destroyed) {
    state.proxyMesh = null
    proxyMesh = null
  }
  if (!proxyMesh) {
    try {
      proxyMesh = new mesh.constructor({
        texture: proxyTexture,
        object: state.tile,
        name: `fa-nexus-custom-overhead-proxy-${state.tileId || 'tile'}`
      })
      proxyMesh.eventMode = 'none'
      if ('interactiveChildren' in proxyMesh) proxyMesh.interactiveChildren = false
      proxyMesh.visible = false
      proxyMesh.renderable = false
      proxyMesh.cullable = false
      state.proxyMesh = proxyMesh
    } catch (_) {
      state.proxyMesh = null
      return null
    }
  } else if (proxyMesh.texture !== proxyTexture) {
    try { proxyMesh.texture = proxyTexture } catch (_) {}
  }
  return proxyMesh
}

function syncProxyMeshState(state) {
  const mesh = state?.mesh
  const proxyMesh = ensureProxyMesh(state)
  if (!mesh || mesh.destroyed || !proxyMesh || proxyMesh.destroyed) return null
  const parent = mesh.parent || canvas?.primary || null
  if (!parent) return null

  try {
    proxyMesh.parent = parent
    proxyMesh.position?.copyFrom?.(mesh.position)
    proxyMesh.pivot?.copyFrom?.(mesh.pivot)
    proxyMesh.skew?.copyFrom?.(mesh.skew)
    proxyMesh.anchor?.copyFrom?.(mesh.anchor)
  } catch (_) {}
  try { proxyMesh.rotation = mesh.rotation ?? 0 } catch (_) {}
  try { proxyMesh.angle = mesh.angle ?? 0 } catch (_) {}
  try { proxyMesh.alpha = 1 } catch (_) {}
  try { proxyMesh.visible = mesh.visible !== false } catch (_) {}
  try { proxyMesh.renderable = mesh.renderable !== false } catch (_) {}
  try { proxyMesh.roundPixels = mesh.roundPixels } catch (_) {}
  try { proxyMesh.blendMode = mesh.blendMode } catch (_) {}
  try { proxyMesh.elevation = mesh.elevation } catch (_) {}
  try { proxyMesh.sort = mesh.sort } catch (_) {}
  try { proxyMesh.sortLayer = mesh.sortLayer } catch (_) {}
  try { proxyMesh.zIndex = mesh.zIndex } catch (_) {}
  try { proxyMesh.occlusionMode = mesh.occlusionMode } catch (_) {}
  try { proxyMesh.unoccludedAlpha = mesh.unoccludedAlpha } catch (_) {}
  try { proxyMesh.occludedAlpha = mesh.occludedAlpha } catch (_) {}
  try { proxyMesh.hidden = mesh.hidden } catch (_) {}
  try { proxyMesh.hoverFade = mesh.hoverFade } catch (_) {}
  try { proxyMesh.textureAlphaThreshold = mesh.textureAlphaThreshold } catch (_) {}
  try { proxyMesh.restrictsLight = mesh.restrictsLight } catch (_) {}
  try { proxyMesh.restrictsWeather = mesh.restrictsWeather } catch (_) {}
  try {
    const width = Math.max(1, Number(mesh._width) || Number(state?.tile?.document?.width) || Number(proxyMesh.texture?.width) || 1)
    const height = Math.max(1, Number(mesh._height) || Number(state?.tile?.document?.height) || Number(proxyMesh.texture?.height) || 1)
    proxyMesh.resize(width, height, {
      fit: 'fill',
      scaleX: Math.sign(Number(mesh.scale?.x) || 1) || 1,
      scaleY: Math.sign(Number(mesh.scale?.y) || 1) || 1
    })
  } catch (_) {}
  try {
    if (state.proxyAlphaData) proxyMesh._textureAlphaData = state.proxyAlphaData
  } catch (_) {}
  try { proxyMesh.transform.updateTransform(parent.transform) } catch (_) {}
  try {
    proxyMesh.canvasTransform.copyFrom(proxyMesh.transform.localTransform)
    if (parent.canvasTransform) proxyMesh.canvasTransform.prepend(parent.canvasTransform)
  } catch (_) {}
  try {
    proxyMesh._canvasBounds.clear()
    proxyMesh._calculateCanvasBounds()
    if (proxyMesh._canvasBounds.isEmpty()) {
      proxyMesh.canvasBounds.x = proxyMesh.x
      proxyMesh.canvasBounds.y = proxyMesh.y
      proxyMesh.canvasBounds.width = 0
      proxyMesh.canvasBounds.height = 0
    } else {
      proxyMesh._canvasBounds.getRectangle(proxyMesh.canvasBounds)
    }
  } catch (_) {}
  return proxyMesh
}

class CustomTileOverheadFilter extends PIXI.Filter {
  constructor(tile) {
    super(undefined, FILTER_FRAGMENT_SHADER, {
      screenDimensions: [1, 1],
      occlusionTexture: getTransparentFallbackTexture(),
      occlusionElevation: 0,
      baseAlpha: 1,
      occludedAlpha: 0,
      fadeOcclusion: 0,
      radialOcclusion: 0,
      visionOcclusion: 0
    })
    this.tile = tile
  }

  apply(filterManager, input, output, clear, currentState) {
    try {
      const tile = this.tile
      const mesh = tile?.mesh
      const uniforms = this.uniforms
      const effectsActive = shouldApplyVisibleOverheadEffects(tile)
      const occlusionMask = canvas?.masks?.occlusion
      uniforms.screenDimensions = canvas?.screenDimensions || [1, 1]
      uniforms.occlusionTexture = occlusionMask?.renderTexture || getTransparentFallbackTexture()
      uniforms.occlusionElevation = occlusionMask?.mapElevation?.(mesh?.elevation ?? tile?.document?.elevation ?? 0) ?? 0
      if (!effectsActive) {
        uniforms.baseAlpha = 1
        uniforms.occludedAlpha = 1
        uniforms.fadeOcclusion = 0
        uniforms.radialOcclusion = 0
        uniforms.visionOcclusion = 0
      } else {
        uniforms.baseAlpha = clamp(mesh?.unoccludedAlpha ?? tile?.document?.alpha, 0, 1, 1)
        uniforms.occludedAlpha = clamp(mesh?.occludedAlpha ?? tile?.document?.occlusion?.alpha, 0, 1, 0)
        const state = mesh?._occlusionState || {}
        uniforms.fadeOcclusion = clamp(state.fade, 0, 1, 0)
        uniforms.radialOcclusion = clamp(state.radial, 0, 1, 0)
        uniforms.visionOcclusion = clamp(state.vision, 0, 1, 0)
      }
    } catch (_) {}
    super.apply(filterManager, input, output, clear, currentState)
  }
}

function createState(tile, mesh) {
  const state = {
    tile,
    tileId: resolveTileId(tile),
    mesh,
    proxyTexture: null,
    proxyAlphaData: null,
    proxyMesh: null,
    proxySizeKey: null,
    meshBindings: null,
    entries: new Map(),
    targetFilters: new Map(),
    lateTextureWatchers: new Map(),
    rebuildQueued: false,
    rebuildHandle: null,
    rebuildTimer: null,
    rebuildReason: null
  }
  TILE_STATES.set(tile, state)
  return state
}

function getState(tile) {
  if (!tile) return null
  return TILE_STATES.get(tile) || null
}

function syncStateMesh(state, mesh) {
  if (!state) return null
  if (mesh && mesh !== state.mesh) {
    restoreMeshProxyBindings(state)
    state.mesh = mesh
  }
  if (shouldUseTileOcclusionProxy(state.tile)) ensureMeshProxyBindings(state)
  else restoreMeshProxyBindings(state)
  return state.mesh || null
}

function ensureState(tile, mesh) {
  let state = getState(tile)
  if (!state) state = createState(tile, mesh)
  syncStateMesh(state, mesh)
  return state
}

function restoreMeshProxyBindings(state) {
  const bindings = state?.meshBindings
  const mesh = bindings?.mesh || null
  if (mesh && !mesh.destroyed) {
    try {
      if (bindings.containsCanvasPoint) mesh.containsCanvasPoint = bindings.containsCanvasPoint
    } catch (_) {}
    try {
      if (bindings.containsPoint) mesh.containsPoint = bindings.containsPoint
    } catch (_) {}
    try {
      if (bindings.renderDepthData) mesh.renderDepthData = bindings.renderDepthData
    } catch (_) {}
    try {
      if (bindings.calculateCanvasBounds) mesh._calculateCanvasBounds = bindings.calculateCanvasBounds
    } catch (_) {}
    try { delete mesh.faNexusCustomOverheadProxyTexture } catch (_) {}
    try { delete mesh.faNexusCustomOverheadMeshBound } catch (_) {}
    try { delete mesh.faNexusCustomOverheadState } catch (_) {}
    invalidateMeshBounds(mesh)
  }
  if (state) state.meshBindings = null
}

function ensureMeshProxyBindings(state) {
  const mesh = state?.mesh
  if (!mesh || mesh.destroyed) return
  if (state?.meshBindings?.mesh === mesh) {
    try {
      mesh.faNexusCustomOverheadProxyTexture = state.proxyTexture || null
      mesh.faNexusCustomOverheadMeshBound = true
    } catch (_) {}
    return
  }

  restoreMeshProxyBindings(state)

  const bindings = {
    mesh,
    containsCanvasPoint: typeof mesh.containsCanvasPoint === 'function' ? mesh.containsCanvasPoint : null,
    containsPoint: typeof mesh.containsPoint === 'function' ? mesh.containsPoint : null,
    renderDepthData: typeof mesh.renderDepthData === 'function' ? mesh.renderDepthData : null,
    calculateCanvasBounds: typeof mesh._calculateCanvasBounds === 'function' ? mesh._calculateCanvasBounds : null
  }

  if (bindings.containsCanvasPoint) {
    mesh.containsCanvasPoint = function (...args) {
      if (state.mesh !== this) return bindings.containsCanvasPoint.apply(this, args)
      const proxyMesh = syncProxyMeshState(state)
      if (!proxyMesh) return bindings.containsCanvasPoint.apply(this, args)
      return bindings.containsCanvasPoint.apply(proxyMesh, args)
    }
  }

  if (bindings.containsPoint) {
    mesh.containsPoint = function (...args) {
      if (state.mesh !== this) return bindings.containsPoint.apply(this, args)
      const proxyMesh = syncProxyMeshState(state)
      if (!proxyMesh) return bindings.containsPoint.apply(this, args)
      return bindings.containsPoint.apply(proxyMesh, args)
    }
  }

  if (bindings.renderDepthData) {
    mesh.renderDepthData = function (...args) {
      if (state.mesh !== this) return bindings.renderDepthData.apply(this, args)
      const proxyMesh = syncProxyMeshState(state)
      if (!proxyMesh) return bindings.renderDepthData.apply(this, args)
      return bindings.renderDepthData.apply(proxyMesh, args)
    }
  }

  if (bindings.calculateCanvasBounds) {
    mesh._calculateCanvasBounds = function (...args) {
      if (state.mesh !== this) return bindings.calculateCanvasBounds.apply(this, args)
      const proxyMesh = syncProxyMeshState(state)
      if (!proxyMesh) return bindings.calculateCanvasBounds.apply(this, args)
      const bounds = proxyMesh.canvasBounds
      if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return
      this._canvasBounds.addFrameMatrix(
        new PIXI.Matrix(),
        bounds.x,
        bounds.y,
        bounds.x + bounds.width,
        bounds.y + bounds.height
      )
    }
  }

  state.meshBindings = bindings
  try {
    mesh.faNexusCustomOverheadState = state
    mesh.faNexusCustomOverheadProxyTexture = state.proxyTexture || null
    mesh.faNexusCustomOverheadMeshBound = true
  } catch (_) {}
}

function ensureEntryParent(state, entry) {
  const mesh = state?.mesh
  const contentContainer = entry?.contentContainer
  if (!mesh || mesh.destroyed || !contentContainer || contentContainer.destroyed) return
  try {
    contentContainer.visible = true
    contentContainer.renderable = true
    contentContainer.eventMode = 'none'
    if ('interactiveChildren' in contentContainer) contentContainer.interactiveChildren = false
  } catch (_) {}
  if (contentContainer.parent === mesh) return
  try { contentContainer.parent?.removeChild?.(contentContainer) } catch (_) {}
  try { mesh.addChild(contentContainer) } catch (_) {}
}

function syncEntryContent(state, entry, reason = null) {
  if (!state || !entry) return
  try {
    entry.syncContent?.({
      tile: state.tile,
      mesh: state.mesh,
      state,
      entry,
      reason
    })
  } catch (error) {
    Logger.warn?.('CustomTileOverhead.syncContent.failed', {
      error: String(error?.message || error),
      tileId: state?.tileId,
      kind: entry?.kind || null,
      reason
    })
  }
}

function syncEntryContentTransforms(state, reason = null) {
  if (!state) return
  for (const entry of state.entries.values()) syncEntryContent(state, entry, reason)
}

function syncEntryParentsToMesh(state) {
  if (!state) return
  for (const entry of state.entries.values()) ensureEntryParent(state, entry)
  try { state.mesh.faNexusCustomOverheadState = state } catch (_) {}
  try { state.tile.faNexusCustomOverheadState = state } catch (_) {}
}

function syncVisibleState(state) {
  const mesh = state?.mesh
  if (!mesh || mesh.destroyed) return
  const shouldShow = mesh.visible !== false
  const shouldRender = mesh.renderable !== false
  const contentAlpha = shouldApplyVisibleOverheadEffects(state?.tile)
    ? 1
    : clamp(state?.tile?.document?.alpha, 0, 1, 1)
  try { mesh.alpha = 1 } catch (_) {}
  for (const entry of state.entries.values()) {
    const contentContainer = entry?.contentContainer
    if (!contentContainer || contentContainer.destroyed) continue
    try { contentContainer.visible = shouldShow } catch (_) {}
    try { contentContainer.renderable = shouldRender } catch (_) {}
    try { contentContainer.alpha = contentAlpha } catch (_) {}
  }
}

function collectMaskObjects(displayObject, masks = new Set()) {
  if (!displayObject || displayObject.destroyed) return masks
  const mask = displayObject.mask
  if (mask && !mask.destroyed) masks.add(mask)
  const children = Array.isArray(displayObject.children) ? displayObject.children : []
  for (const child of children) collectMaskObjects(child, masks)
  return masks
}

function collectFilterTargets(displayObject, maskedObjects = new Set(), targets = []) {
  if (!displayObject || displayObject.destroyed) return targets
  if (maskedObjects.has(displayObject)) return targets
  const children = Array.isArray(displayObject.children) ? displayObject.children : []
  if (!children.length) {
    if (displayObject.renderable !== false) targets.push(displayObject)
    return targets
  }
  for (const child of children) collectFilterTargets(child, maskedObjects, targets)
  return targets
}

function resolveFilterTargets(entry) {
  const contentContainer = entry?.contentContainer
  if (!contentContainer || contentContainer.destroyed) return []
  const filterMode = entry?.filterMode === 'container' ? 'container' : 'leaf'
  if (filterMode === 'container') return [contentContainer]
  const maskedObjects = collectMaskObjects(contentContainer)
  return collectFilterTargets(contentContainer, maskedObjects)
}

function shouldApplyVisibleOverheadEffects(tile = null) {
  try {
    return shouldUseTileOcclusionProxy(tile) && (canvas?.activeLayer?.options?.name === 'tokens')
  } catch (_) {
    return false
  }
}

function clearProxyTexture(state) {
  if (!state) return
  if (state.proxyTexture && !state.proxyTexture.destroyed) {
    try { state.proxyTexture.destroy(true) } catch (_) {}
  }
  state.proxyTexture = null
  state.proxyAlphaData = null
  state.proxySizeKey = null
  try { if (state.mesh) delete state.mesh.faNexusCustomOverheadProxyTexture } catch (_) {}
  try { if (state.tile) delete state.tile.faNexusCustomOverheadProxyTexture } catch (_) {}
}

function deactivateOverheadRuntime(state) {
  if (!state) return
  cancelScheduledRebuild(state)
  clearLateTextureWatchers(state)
  restoreTargetFilters(state)
  destroyProxyMesh(state)
  clearProxyTexture(state)
  restoreMeshProxyBindings(state)
}

function restoreTargetFilters(state) {
  if (!state?.targetFilters?.size) return
  for (const record of state.targetFilters.values()) {
    const target = record?.target
    if (!target || target.destroyed) continue
    try { target.filters = record.originalFilters ? [...record.originalFilters] : null } catch (_) {}
    try {
      if (record.hadFilterArea) target.filterArea = record.originalFilterArea
      else target.filterArea = null
    } catch (_) {}
  }
  state.targetFilters.clear()
}

function syncTargetFilters(state) {
  if (!state) return
  if (!shouldApplyVisibleOverheadEffects(state?.tile)) {
    restoreTargetFilters(state)
    return
  }
  const nextTargets = new Map()
  for (const entry of state.entries.values()) {
    const targets = resolveFilterTargets(entry)
    for (const target of targets) {
      if (!target || target.destroyed) continue
      nextTargets.set(target, true)
      let record = state.targetFilters.get(target)
      if (!record) {
        const originalFilters = Array.isArray(target.filters) ? [...target.filters] : null
        const hadFilterArea = target.filterArea !== undefined
        record = {
          target,
          filter: new CustomTileOverheadFilter(state.tile),
          originalFilters,
          originalFilterArea: target.filterArea ?? null,
          hadFilterArea
        }
        state.targetFilters.set(target, record)
      }
      const baseFilters = record.originalFilters ? [...record.originalFilters] : []
      try { target.filters = [...baseFilters, record.filter] } catch (_) {}
    }
  }

  for (const [target, record] of Array.from(state.targetFilters.entries())) {
    if (nextTargets.has(target)) continue
    if (!target.destroyed) {
      try { target.filters = record.originalFilters ? [...record.originalFilters] : null } catch (_) {}
      try {
        if (record.hadFilterArea) target.filterArea = record.originalFilterArea
        else target.filterArea = null
      } catch (_) {}
    }
    state.targetFilters.delete(target)
  }
}

function clearLateTextureWatchers(state) {
  if (!state?.lateTextureWatchers?.size) return
  for (const watcher of state.lateTextureWatchers.values()) {
    try { watcher.base?.off?.('loaded', watcher.onReady) } catch (_) {}
    try { watcher.base?.off?.('update', watcher.onReady) } catch (_) {}
    try { watcher.texture?.off?.('update', watcher.onReady) } catch (_) {}
  }
  state.lateTextureWatchers.clear()
}

function collectDisplayTextures(displayObject, textures = new Set()) {
  if (!displayObject || displayObject.destroyed) return textures
  const directTexture = displayObject.texture
  if (directTexture?.baseTexture) textures.add(directTexture)
  const materialTexture = displayObject.material?.texture
  if (materialTexture?.baseTexture) textures.add(materialTexture)
  const uniforms = displayObject.shader?.uniforms || null
  if (uniforms?.uSampler?.baseTexture) textures.add(uniforms.uSampler)
  if (uniforms?.texture?.baseTexture) textures.add(uniforms.texture)
  const children = Array.isArray(displayObject.children) ? displayObject.children : []
  for (const child of children) collectDisplayTextures(child, textures)
  return textures
}

function monitorLateTextures(state) {
  if (!state) return
  if (!shouldUseTileOcclusionProxy(state.tile)) {
    clearLateTextureWatchers(state)
    return
  }
  clearLateTextureWatchers(state)
  for (const entry of state.entries.values()) {
    const contentContainer = entry?.contentContainer
    if (!contentContainer || contentContainer.destroyed) continue
    const textures = collectDisplayTextures(contentContainer)
    for (const texture of textures) {
      const base = texture?.baseTexture
      if (!base || base.destroyed || base.valid) continue
      const watchKey = `${base.uid || base.cacheId || Math.random()}`
      if (state.lateTextureWatchers.has(watchKey)) continue
      const onReady = () => {
        try { base.off?.('loaded', onReady) } catch (_) {}
        try { base.off?.('update', onReady) } catch (_) {}
        try { texture.off?.('update', onReady) } catch (_) {}
        state.lateTextureWatchers.delete(watchKey)
        invalidateCustomTileOverhead(state.tile, LATE_TEXTURE_REASON)
      }
      try { base.on?.('loaded', onReady) } catch (_) {}
      try { base.on?.('update', onReady) } catch (_) {}
      try { texture.on?.('update', onReady) } catch (_) {}
      state.lateTextureWatchers.set(watchKey, { base, texture, onReady })
    }
  }
}

function ensureProxyTexture(state, size) {
  const sizeKey = `${size.proxyWidth}x${size.proxyHeight}`
  if (state.proxyTexture && !state.proxyTexture.destroyed) {
    try { state.proxyTexture.destroy(true) } catch (_) {}
  }
  const proxyTexture = PIXI.RenderTexture.create({
    width: size.proxyWidth,
    height: size.proxyHeight,
    resolution: 1,
    scaleMode: PIXI.SCALE_MODES.LINEAR
  })
  try {
    if (proxyTexture?.baseTexture) proxyTexture.baseTexture.clearColor = [0, 0, 0, 0]
  } catch (_) {}
  state.proxyTexture = proxyTexture
  state.proxySizeKey = sizeKey
  state.mesh.faNexusCustomOverheadProxyTexture = proxyTexture
  state.tile.faNexusCustomOverheadProxyTexture = proxyTexture
  return proxyTexture
}

function cancelScheduledRebuild(state) {
  if (!state) return
  if (state.rebuildHandle !== null) {
    try { cancelAnimationFrame(state.rebuildHandle) } catch (_) {}
    state.rebuildHandle = null
  }
  if (state.rebuildTimer !== null) {
    try { clearTimeout(state.rebuildTimer) } catch (_) {}
    state.rebuildTimer = null
  }
  state.rebuildQueued = false
}

function queueRebuild(state) {
  if (!state || state.rebuildQueued) return
  state.rebuildQueued = true
  if (typeof requestAnimationFrame === 'function') {
    state.rebuildHandle = requestAnimationFrame(() => {
      state.rebuildHandle = null
      state.rebuildQueued = false
      rebuildCustomTileOverhead(state)
    })
    return
  }
  state.rebuildTimer = setTimeout(() => {
    state.rebuildTimer = null
    state.rebuildQueued = false
    rebuildCustomTileOverhead(state)
  }, 0)
}

function cloneUniformValue(value) {
  if ((value instanceof PIXI.Texture) || (value instanceof PIXI.BaseTexture)) return value
  if (ArrayBuffer.isView(value)) return new value.constructor(value)
  if (Array.isArray(value)) return value.map((entry) => cloneUniformValue(entry))
  if (value && typeof value === 'object') {
    if (typeof value.clone === 'function') {
      try { return value.clone() } catch (_) {}
    }
    const cloned = {}
    for (const [key, entry] of Object.entries(value)) cloned[key] = cloneUniformValue(entry)
    return cloned
  }
  return value
}

function copyCommonDisplayProps(source, target) {
  if (!source || !target) return
  try { target.position?.copyFrom?.(source.position) } catch (_) {
    try { target.position?.set?.(source.position?.x ?? 0, source.position?.y ?? 0) } catch (_) {}
  }
  try { target.scale?.copyFrom?.(source.scale) } catch (_) {
    try { target.scale?.set?.(source.scale?.x ?? 1, source.scale?.y ?? 1) } catch (_) {}
  }
  try { target.pivot?.copyFrom?.(source.pivot) } catch (_) {}
  try { target.skew?.copyFrom?.(source.skew) } catch (_) {}
  try { target.rotation = source.rotation ?? 0 } catch (_) {}
  try { target.angle = source.angle ?? 0 } catch (_) {}
  try { target.visible = source.visible !== false } catch (_) {}
  try { target.renderable = source.renderable !== false } catch (_) {}
  try { target.alpha = clamp(source.alpha, 0, 1, 1) } catch (_) {}
  try { target.name = source.name || null } catch (_) {}
  try { target.eventMode = source.eventMode || 'none' } catch (_) {}
  try {
    if ('interactiveChildren' in target) target.interactiveChildren = !!source.interactiveChildren
  } catch (_) {}
  try {
    if ('sortableChildren' in target) target.sortableChildren = !!source.sortableChildren
  } catch (_) {}
  try {
    if ('blendMode' in target && source.blendMode !== undefined) target.blendMode = source.blendMode
  } catch (_) {}
  try {
    if ('tint' in target && source.tint !== undefined) target.tint = source.tint
  } catch (_) {}
  try {
    if ('zIndex' in target && source.zIndex !== undefined) target.zIndex = source.zIndex
  } catch (_) {}
}

function resolveMeshTexture(mesh) {
  return mesh?.texture
    || mesh?.shader?.texture
    || mesh?.shader?.uniforms?.uSampler
    || mesh?.shader?.uniforms?.sampler
    || mesh?.shader?.uniforms?.texture
    || mesh?.material?.texture
    || null
}

function cloneMeshShader(mesh) {
  const shader = mesh?.shader || mesh?.material || null
  if (!shader) return null
  if (shader?.program && shader?.uniforms) {
    return new PIXI.Shader(shader.program, cloneUniformValue(shader.uniforms))
  }
  const texture = resolveMeshTexture(mesh)
  if (texture && PIXI?.MeshMaterial) {
    try {
      const material = new PIXI.MeshMaterial(texture)
      material.alpha = Number.isFinite(Number(shader?.alpha)) ? Number(shader.alpha) : 1
      if (material.uvMatrix && shader?.uvMatrix) {
        material.uvMatrix.isSimple = shader.uvMatrix.isSimple
        material.uvMatrix.clampOffset = shader.uvMatrix.clampOffset
        material.uvMatrix.clampMargin = shader.uvMatrix.clampMargin
        material.uvMatrix.update()
      }
      return material
    } catch (_) {}
  }
  return shader
}

function cloneDisplayObjectTree(source, map = new Map()) {
  if (!source || source.destroyed) return null
  if (map.has(source)) return map.get(source)
  let clone = null
  if (source instanceof PIXI.TilingSprite) {
    clone = new PIXI.TilingSprite(source.texture, Math.max(1, Number(source.width) || 1), Math.max(1, Number(source.height) || 1))
    try { clone.tilePosition?.copyFrom?.(source.tilePosition) } catch (_) {}
    try { clone.tileScale?.copyFrom?.(source.tileScale) } catch (_) {}
    try {
      if (clone.tileTransform && source.tileTransform) clone.tileTransform.rotation = source.tileTransform.rotation
    } catch (_) {}
    try { clone.anchor?.copyFrom?.(source.anchor) } catch (_) {}
  } else if (source instanceof PIXI.Sprite) {
    clone = new PIXI.Sprite(source.texture)
    try { clone.anchor?.copyFrom?.(source.anchor) } catch (_) {}
    try { clone.width = Math.max(1, Number(source.width) || 1) } catch (_) {}
    try { clone.height = Math.max(1, Number(source.height) || 1) } catch (_) {}
  } else if ((source instanceof PIXI.Mesh) || (source?.geometry && (source?.shader || source?.material))) {
    const shader = cloneMeshShader(source)
    try {
      clone = new source.constructor(source.geometry, shader)
    } catch (_) {
      clone = new PIXI.Mesh(source.geometry, shader)
    }
    try {
      if (source.state && clone.state) clone.state.blendMode = source.state.blendMode
    } catch (_) {}
  } else {
    clone = new PIXI.Container()
  }

  map.set(source, clone)
  copyCommonDisplayProps(source, clone)
  const children = Array.isArray(source.children) ? source.children : []
  for (const child of children) {
    const childClone = cloneDisplayObjectTree(child, map)
    if (!childClone) continue
    try { clone.addChild(childClone) } catch (_) {}
  }
  return clone
}

function applyClonedMasks(map) {
  for (const [source, clone] of map.entries()) {
    const mask = source?.mask
    if (!mask) continue
    const clonedMask = map.get(mask)
    if (!clonedMask) continue
    try { clonedMask.visible = true } catch (_) {}
    try { clonedMask.renderable = true } catch (_) {}
    try { clone.mask = clonedMask } catch (_) {}
  }
}

export function cloneDisplayObjectForCustomTileProxy(displayObject) {
  try {
    const map = new Map()
    const clone = cloneDisplayObjectTree(displayObject, map)
    applyClonedMasks(map)
    return clone
  } catch (error) {
    Logger.warn?.('CustomTileOverhead.cloneProxy.failed', {
      error: String(error?.message || error),
      tileId: resolveTileId(displayObject?.tile || null)
    })
    return null
  }
}

export function createDisplayProxyFactory(displayObject) {
  return () => cloneDisplayObjectForCustomTileProxy(displayObject)
}

function createProxyRoot(entry, state) {
  try {
    const root = typeof entry?.proxyFactory === 'function'
      ? entry.proxyFactory({ tile: state.tile, mesh: state.mesh, state, entry })
      : cloneDisplayObjectForCustomTileProxy(entry?.contentContainer)
    if (root && !root.destroyed) return root
  } catch (error) {
    Logger.warn?.('CustomTileOverhead.proxyFactory.failed', {
      error: String(error?.message || error),
      tileId: state?.tileId
    })
  }
  return cloneDisplayObjectForCustomTileProxy(entry?.contentContainer)
}

function destroyProxyRoot(root) {
  try { root?.destroy?.({ children: true, texture: false, baseTexture: false }) } catch (_) {}
}

function createProxyShell(state, size) {
  const shell = new PIXI.Container()
  const anchor = resolveAnchor(state?.tile)
  shell.name = `fa-nexus-custom-overhead-${state?.tileId || 'tile'}-proxy`
  shell.position.set(size.docWidth * anchor.x, size.docHeight * anchor.y)
  shell.scale.set(size.docWidth, size.docHeight)
  shell.eventMode = 'none'
  shell.sortableChildren = false
  shell.interactiveChildren = false
  shell.visible = true
  shell.renderable = true
  return shell
}

function renderEntriesToProxy(state, size, proxyTexture) {
  const entries = Array.from(state?.entries?.values() || [])
  if (!entries.length || !proxyTexture) return false
  const renderer = getRenderer()
  if (!renderer) return false

  const stage = new PIXI.Container()
  stage.eventMode = 'none'
  stage.sortableChildren = false
  stage.interactiveChildren = false
  stage.scale.set(size.scaleX, size.scaleY)

  const proxyShell = createProxyShell(state, size)
  stage.addChild(proxyShell)

  const proxyRoots = []
  try {
    for (const entry of entries) {
      const proxyRoot = createProxyRoot(entry, state)
      if (!proxyRoot || proxyRoot.destroyed) continue
      proxyRoots.push(proxyRoot)
      proxyShell.addChild(proxyRoot)
    }
    if (!proxyRoots.length) return false
    renderer.render(stage, {
      renderTexture: proxyTexture,
      clear: true,
      skipUpdateTransform: false
    })
    return true
  } finally {
    try { proxyShell.removeChildren() } catch (_) {}
    try { stage.removeChild(proxyShell) } catch (_) {}
    for (const proxyRoot of proxyRoots) destroyProxyRoot(proxyRoot)
    try { proxyShell.destroy({ children: false }) } catch (_) {}
    try { stage.destroy({ children: false }) } catch (_) {}
  }
}

function rebuildCustomTileOverhead(state) {
  try {
    if (!state?.tile || state.tile.destroyed) {
      destroyState(state)
      return
    }
    const mesh = state.tile.mesh
    if (!mesh || mesh.destroyed) return
    syncStateMesh(state, mesh)
    if (!state.entries.size) {
      destroyState(state)
      return
    }

    syncEntryParentsToMesh(state)
    syncEntryContentTransforms(state, state.rebuildReason || 'rebuild')
    syncVisibleState(state)
    if (!shouldUseTileOcclusionProxy(state.tile)) {
      deactivateOverheadRuntime(state)
      return
    }
    syncTargetFilters(state)

    const size = resolveProxySize(state.tile, mesh)
    const proxyTexture = ensureProxyTexture(state, size)
    const rendered = renderEntriesToProxy(state, size, proxyTexture)
    if (!rendered) return

    ensureMeshProxyBindings(state)
    refreshMeshProxyAlphaData(state)
    monitorLateTextures(state)
  } catch (error) {
    Logger.warn?.('CustomTileOverhead.rebuild.failed', {
      error: String(error?.message || error),
      tileId: state?.tileId,
      reason: state?.rebuildReason || null
    })
  }
}

function destroyState(state, { preserveContainers = false } = {}) {
  if (!state) return
  cancelScheduledRebuild(state)
  clearLateTextureWatchers(state)
  restoreTargetFilters(state)

  if (!preserveContainers) {
    const mesh = state.mesh
    for (const entry of state.entries.values()) {
      const contentContainer = entry?.contentContainer
      if (!contentContainer || contentContainer.destroyed) continue
      if (contentContainer.parent === mesh) {
        try { mesh.removeChild(contentContainer) } catch (_) {}
      }
      try { contentContainer.destroy?.({ children: true, texture: false, baseTexture: false }) } catch (_) {}
    }
  }

  clearProxyTexture(state)
  destroyProxyMesh(state)
  restoreMeshProxyBindings(state)
  try { delete state.tile.faNexusCustomOverheadState } catch (_) {}
  try { delete state.tile.faNexusCustomOverheadProxyTexture } catch (_) {}
  TILE_STATES.delete(state.tile)
}

export function attachCustomTileOverhead(tile, {
  kind = 'default',
  contentContainer,
  proxyFactory = null,
  filterMode = 'leaf',
  syncContent = null
} = {}) {
  try {
    if (!tile || tile.destroyed || !contentContainer || contentContainer.destroyed) return null
    const mesh = tile.mesh
    if (!mesh || mesh.destroyed) return null
    const state = ensureState(tile, mesh)
    const previousEntry = state.entries.get(kind) || null
    if (previousEntry?.contentContainer && previousEntry.contentContainer !== contentContainer) {
      try {
        if (previousEntry.contentContainer.parent === mesh) mesh.removeChild(previousEntry.contentContainer)
      } catch (_) {}
    }
    state.entries.set(kind, {
      kind,
      contentContainer,
      proxyFactory,
      filterMode: filterMode === 'container' ? 'container' : 'leaf',
      syncContent: typeof syncContent === 'function' ? syncContent : null
    })
    ensureEntryParent(state, state.entries.get(kind))
    syncEntryContent(state, state.entries.get(kind), 'attach')
    syncVisibleState(state)
    if (!shouldUseTileOcclusionProxy(tile)) {
      deactivateOverheadRuntime(state)
      return state
    }
    syncTargetFilters(state)
    monitorLateTextures(state)
    return state
  } catch (error) {
    Logger.warn?.('CustomTileOverhead.attach.failed', {
      error: String(error?.message || error),
      tileId: resolveTileId(tile),
      kind
    })
    return null
  }
}

export function invalidateCustomTileOverhead(tile, reason = 'refresh') {
  try {
    const state = getState(tile)
    if (!state) return
    state.rebuildReason = reason
    if (!shouldUseTileOcclusionProxy(tile)) {
      deactivateOverheadRuntime(state)
      return
    }
    queueRebuild(state)
  } catch (_) {}
}

export function detachCustomTileOverhead(tile, { kind = null, contentContainer = null, preserveContainers = true } = {}) {
  try {
    const state = getState(tile)
    if (!state) return

    if (!kind && !contentContainer) {
      destroyState(state, { preserveContainers })
      return
    }

    const keysToRemove = []
    for (const [entryKind, entry] of state.entries.entries()) {
      if (kind && entryKind !== kind) continue
      if (contentContainer && entry?.contentContainer !== contentContainer) continue
      keysToRemove.push(entryKind)
    }

    for (const entryKind of keysToRemove) {
      const entry = state.entries.get(entryKind)
      const container = entry?.contentContainer
      if (!preserveContainers && container && !container.destroyed && container.parent === state.mesh) {
        try { state.mesh.removeChild(container) } catch (_) {}
        try { container.destroy?.({ children: true, texture: false, baseTexture: false }) } catch (_) {}
      }
      state.entries.delete(entryKind)
    }

    if (!state.entries.size) {
      destroyState(state, { preserveContainers })
      return
    }
    syncVisibleState(state)
    syncTargetFilters(state)
    monitorLateTextures(state)
    invalidateCustomTileOverhead(tile, 'detach')
  } catch (error) {
    Logger.warn?.('CustomTileOverhead.detach.failed', {
      error: String(error?.message || error),
      tileId: resolveTileId(tile)
    })
  }
}

export function invalidateAllCustomTileOverheads(reason = 'global-refresh') {
  try {
    for (const state of TILE_STATES.values()) invalidateCustomTileOverhead(state.tile, reason)
  } catch (_) {}
}

function refreshCustomTileOverhead(tile, reason = null) {
  try {
    const state = getState(tile)
    if (!state) return
    const mesh = tile?.mesh
    if (mesh && !mesh.destroyed) syncStateMesh(state, mesh)
    syncEntryParentsToMesh(state)
    syncEntryContentTransforms(state, reason || 'refresh')
    syncVisibleState(state)
    if (!shouldUseTileOcclusionProxy(tile)) {
      deactivateOverheadRuntime(state)
      return
    }
    syncTargetFilters(state)
    monitorLateTextures(state)
    if (reason) invalidateCustomTileOverhead(tile, reason)
  } catch (_) {}
}

function scheduleFollowupInvalidate(reason) {
  try {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => invalidateAllCustomTileOverheads(`${reason}:raf`))
    }
  } catch (_) {}
  try {
    setTimeout(() => invalidateAllCustomTileOverheads(`${reason}:timeout`), 120)
  } catch (_) {}
}

function detachDeletedTile(doc) {
  try {
    const state = Array.from(TILE_STATES.values()).find((entry) => entry?.tile?.document?.id === doc?.id)
    if (!state) return
    destroyState(state)
  } catch (_) {}
}

function clearAllStates() {
  try {
    for (const state of Array.from(TILE_STATES.values())) destroyState(state)
  } catch (_) {}
}

function patchTileRefreshMethods() {
  try {
    const Tile = globalThis?.foundry?.canvas?.placeables?.Tile
      || canvas?.tiles?.constructor?.placeableClass
      || globalThis?.CONFIG?.Tile?.objectClass
    if (!Tile?.prototype) return
    if (Tile.prototype._faNexusCustomTileOverheadPatched) return

    const patch = (methodName, reason) => {
      const original = Tile.prototype?.[methodName]
      if (typeof original !== 'function') return
      Tile.prototype[`_faNexusCustomTileOverheadOriginal${methodName}`] = original
      Tile.prototype[methodName] = function (...args) {
        const result = original.apply(this, args)
        try { refreshCustomTileOverhead(this, reason) } catch (_) {}
        return result
      }
    }

    patch('_refreshState', 'tile-refreshState')
    patch('_refreshMesh', 'tile-refreshMesh')
    patch('_refreshElevation', 'tile-refreshElevation')
    patch('_refreshSize', 'tile-refreshSize')
    Tile.prototype._faNexusCustomTileOverheadPatched = true
  } catch (_) {}
}

try {
  patchTileRefreshMethods()
  Hooks.on('canvasReady', () => {
    patchTileRefreshMethods()
    invalidateAllCustomTileOverheads('canvasReady')
  })
  Hooks.on('drawTile', (tile) => {
    refreshCustomTileOverhead(tile)
  })
  Hooks.on('refreshTile', (tile) => {
    refreshCustomTileOverhead(tile)
  })
  Hooks.on('activateTokensLayer', () => {
    invalidateAllCustomTileOverheads('activateTokensLayer')
    scheduleFollowupInvalidate('activateTokensLayer')
  })
  Hooks.on('activateTilesLayer', () => {
    invalidateAllCustomTileOverheads('activateTilesLayer')
    scheduleFollowupInvalidate('activateTilesLayer')
  })
  Hooks.on('deleteTile', (doc) => {
    detachDeletedTile(doc)
  })
  Hooks.on('canvasTearDown', () => {
    clearAllStates()
  })
} catch (_) {}
