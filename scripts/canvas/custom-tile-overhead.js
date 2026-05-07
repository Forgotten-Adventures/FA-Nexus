import { NexusLogger as Logger } from '../core/nexus-logger.js'
import { cloneDisplayObjectForProxy } from './display-object-proxy.js'
import { resolveTileId } from './tile-targets.js'
import {
  mapTileOcclusionElevation,
  tileUsesLightOrWeatherRestrictions,
  tileUsesSurfaceTileOcclusion,
  tileUsesVisibleTileOcclusion
} from './tile-occlusion.js'

const TILE_STATES = new Map()

const DEFAULT_PROXY_SIZE = 2
const MAX_PROXY_SIZE_FALLBACK = 4096
const MAX_PROXY_SIZE_CAP = 8192
const LATE_TEXTURE_REASON = 'late-texture'
const DEPTH_ALPHA_THRESHOLD_MIN = 1 / 255

const FILTER_VERTEX_SHADER = `
attribute vec2 aVertexPosition;

uniform mat3 projectionMatrix;
uniform vec2 screenDimensions;
uniform vec4 inputSize;
uniform vec4 outputFrame;

varying vec2 vTextureCoord;
varying vec2 vMaskTextureCoord;

void main() {
  vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.0)) + outputFrame.xy;
  gl_Position = vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
  vTextureCoord = aVertexPosition * (outputFrame.zw * inputSize.zw);
  vMaskTextureCoord = (aVertexPosition * outputFrame.zw + outputFrame.xy) / max(screenDimensions, vec2(1.0));
}
`

const FILTER_FRAGMENT_SHADER = `
varying vec2 vTextureCoord;
varying vec2 vMaskTextureCoord;

uniform sampler2D uSampler;
uniform sampler2D occlusionTexture;
uniform float occlusionElevation;
uniform float baseAlpha;
uniform float occludedAlpha;
uniform float fadeOcclusion;
uniform float radialOcclusion;
uniform float visionOcclusion;
uniform float surfaceOcclusion;

void main() {
  vec4 color = texture2D(uSampler, vTextureCoord);
  vec4 occluded = 1.0 - step(vec4(occlusionElevation), texture2D(occlusionTexture, vMaskTextureCoord));
  float occlusion = max(
    max(occluded.r * fadeOcclusion, occluded.g * radialOcclusion),
    max(occluded.b * visionOcclusion, occluded.a * surfaceOcclusion)
  );
  float alphaFactor = mix(baseAlpha, occludedAlpha, occlusion);
  gl_FragColor = color * alphaFactor;
}
`

let CustomTileOverheadFilterClass = null
let CustomTileOverheadFilterBase = null

function clamp(value, min, max, fallback = min) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

function shouldUseTileOcclusionProxy(tile) {
  try {
    const doc = tile?.document
    if (!doc) return false
    return tileUsesVisibleTileOcclusion(doc.occlusion, {
      sourceOcclusion: doc._source?.occlusion
    })
  } catch (error) {
    Logger.debug?.('CustomTileOverhead.shouldUseTileOcclusionProxy.failed', {
      tileId: resolveTileId(tile),
      error: String(error?.message || error)
    })
  }
  return false
}

function shouldUseTileRestrictionProxy(tile) {
  try {
    return tileUsesLightOrWeatherRestrictions(tile?.document)
  } catch (error) {
    Logger.debug?.('CustomTileOverhead.shouldUseTileRestrictionProxy.failed', {
      tileId: resolveTileId(tile),
      error: String(error?.message || error)
    })
  }
  return false
}

function shouldUseTileSurfaceProxy(tile) {
  try {
    const doc = tile?.document
    if (!doc) return false
    return tileUsesSurfaceTileOcclusion(doc.occlusion, {
      sourceOcclusion: doc._source?.occlusion
    })
  } catch (error) {
    Logger.debug?.('CustomTileOverhead.shouldUseTileSurfaceProxy.failed', {
      tileId: resolveTileId(tile),
      error: String(error?.message || error)
    })
  }
  return false
}

function shouldUseCustomOverheadProxy(tile) {
  return shouldUseTileOcclusionProxy(tile) || shouldUseTileSurfaceProxy(tile) || shouldUseTileRestrictionProxy(tile)
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
  syncProxyMeshOcclusionState(mesh, proxyMesh)
  try { proxyMesh.hidden = mesh.hidden } catch (_) {}
  try { proxyMesh.hoverFade = mesh.hoverFade } catch (_) {}
  try { proxyMesh.textureAlphaThreshold = resolveProxyTextureAlphaThreshold(state?.tile, mesh) } catch (_) {}
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

function resolveProxyTextureAlphaThreshold(tile, mesh) {
  const raw = Number(mesh?.textureAlphaThreshold ?? tile?.document?.texture?.alphaThreshold)
  const threshold = Number.isFinite(raw) ? clamp(raw, 0, 1, 0) : 0
  return shouldUseTileRestrictionProxy(tile)
    ? Math.max(threshold, DEPTH_ALPHA_THRESHOLD_MIN)
    : threshold
}

function syncProxyMeshOcclusionState(sourceMesh, proxyMesh) {
  try {
    const sourceState = sourceMesh?._occlusionState
    const proxyState = proxyMesh?._occlusionState
    if (!sourceState || !proxyState) return
    proxyState.fade = Number(sourceState.fade) || 0
    proxyState.radial = Number(sourceState.radial) || 0
    proxyState.vision = Number(sourceState.vision) || 0
    proxyState.surface = Number(sourceState.surface) || 0
  } catch (_) {}
}

function getCustomTileOverheadFilterClass() {
  const FilterClass = globalThis.PIXI?.Filter
  if (!FilterClass) return null
  if (CustomTileOverheadFilterClass && CustomTileOverheadFilterBase === FilterClass) return CustomTileOverheadFilterClass
  CustomTileOverheadFilterBase = FilterClass
  CustomTileOverheadFilterClass = class CustomTileOverheadFilter extends FilterClass {
    constructor(tile) {
      super(FILTER_VERTEX_SHADER, FILTER_FRAGMENT_SHADER, {
        screenDimensions: [1, 1],
        occlusionTexture: getTransparentFallbackTexture(),
        occlusionElevation: 0,
        baseAlpha: 1,
        occludedAlpha: 0,
        fadeOcclusion: 0,
        radialOcclusion: 0,
        visionOcclusion: 0,
        surfaceOcclusion: 0
      })
      this.tile = tile
    }

    apply(filterManager, input, output, clear, currentState) {
      try {
        const tile = this.tile
        const mesh = tile?.mesh
        const uniforms = this.uniforms
        const effectsActive = shouldApplyCustomOverheadEffects(tile)
        const occlusionMask = canvas?.masks?.occlusion
        uniforms.screenDimensions = canvas?.screenDimensions || [1, 1]
        uniforms.occlusionTexture = occlusionMask?.renderTexture || getTransparentFallbackTexture()
        uniforms.occlusionElevation = mapTileOcclusionElevation(tile, { mesh, occlusionMask })
          ?? occlusionMask?.mapElevation?.(mesh?.elevation ?? tile?.document?.elevation ?? 0)
          ?? 0
        if (!effectsActive) {
          uniforms.baseAlpha = 1
          uniforms.occludedAlpha = 1
          uniforms.fadeOcclusion = 0
          uniforms.radialOcclusion = 0
          uniforms.visionOcclusion = 0
          uniforms.surfaceOcclusion = 0
        } else {
          uniforms.baseAlpha = clamp(mesh?.unoccludedAlpha ?? tile?.document?.alpha, 0, 1, 1)
          uniforms.occludedAlpha = clamp(mesh?.occludedAlpha ?? tile?.document?.occlusion?.alpha, 0, 1, 0)
          const state = mesh?._occlusionState || {}
          uniforms.fadeOcclusion = clamp(state.fade, 0, 1, 0)
          uniforms.radialOcclusion = clamp(state.radial, 0, 1, 0)
          uniforms.visionOcclusion = clamp(state.vision, 0, 1, 0)
          uniforms.surfaceOcclusion = clamp(state.surface, 0, 1, 0)
        }
      } catch (_) {}
      super.apply(filterManager, input, output, clear, currentState)
    }
  }
  return CustomTileOverheadFilterClass
}

function createCustomTileOverheadFilter(tile) {
  const FilterClass = getCustomTileOverheadFilterClass()
  if (!FilterClass) {
    Logger.error?.('CustomTileOverhead.filter.pixiMissing', {
      tileId: resolveTileId(tile)
    })
    return null
  }
  return new FilterClass(tile)
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
    rebuildReason: null,
    depthIssueKey: null
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
  if (shouldUseCustomOverheadProxy(state.tile)) ensureMeshProxyBindings(state)
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
      if (renderCustomProxyDepthData(state, this, args[0])) return
      return bindings.renderDepthData.apply(this, args)
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
    const suppressed = contentContainer.faNexusStandardMaskSuppressed === true
      || contentContainer.faNexusShadowOnlySuppressed === true
    contentContainer.visible = !suppressed
    contentContainer.renderable = !suppressed
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
  const contentAlpha = shouldApplyCustomOverheadEffects(state?.tile)
    ? 1
    : clamp(state?.tile?.document?.alpha, 0, 1, 1)
  try { mesh.alpha = 1 } catch (_) {}
  for (const entry of state.entries.values()) {
    const contentContainer = entry?.contentContainer
    if (!contentContainer || contentContainer.destroyed) continue
    if (contentContainer.faNexusStandardMaskSuppressed === true || contentContainer.faNexusShadowOnlySuppressed === true) {
      try { contentContainer.visible = false } catch (_) {}
      try { contentContainer.renderable = false } catch (_) {}
      continue
    }
    try { contentContainer.visible = shouldShow } catch (_) {}
    try { contentContainer.renderable = shouldRender } catch (_) {}
    try { contentContainer.alpha = contentAlpha } catch (_) {}
  }
}

function markDepthMaskDirty() {
  try {
    const depth = canvas?.masks?.depth
    if (!depth) return
    depth.renderDirty = true
  } catch (_) {}
}

function logDepthProxyIssue(state, code, data = {}) {
  try {
    const key = `${code}:${data?.error || data?.reason || ''}`
    if (state.depthIssueKey === key) return
    state.depthIssueKey = key
    Logger.error?.(code, {
      tileId: state?.tileId,
      ...data
    })
  } catch (_) {}
}

function clearDepthProxyIssue(state) {
  try { if (state) state.depthIssueKey = null } catch (_) {}
}

function renderProxyDepthDataUnchecked(proxyMesh, renderer) {
  if (!proxyMesh || proxyMesh.destroyed || !renderer) return
  if (!proxyMesh.visible || !proxyMesh.renderable) return
  const shader = proxyMesh._shader
  const depthShader = shader?.depthShader
  if (!depthShader) throw new Error('Proxy mesh depth shader is unavailable')
  const blendMode = proxyMesh.blendMode
  proxyMesh.blendMode = PIXI.BLEND_MODES.MAX_COLOR
  proxyMesh._shader = depthShader
  try {
    if (proxyMesh.cullable) proxyMesh._renderWithCulling(renderer)
    else proxyMesh._render(renderer)
  } finally {
    proxyMesh._shader = shader
    proxyMesh.blendMode = blendMode
  }
}

function renderCustomProxyDepthData(state, sourceMesh, renderer) {
  if (!state || !sourceMesh || sourceMesh.destroyed) return false
  if (!sourceMesh.shouldRenderDepth) return true
  if (!state.proxyTexture || state.proxyTexture.destroyed) {
    if (!state.rebuildQueued) queueRebuild(state)
    clearDepthProxyIssue(state)
    return true
  }
  const proxyMesh = syncProxyMeshState(state)
  if (!proxyMesh || proxyMesh.destroyed) {
    logDepthProxyIssue(state, 'CustomTileOverhead.depthProxy.missingProxyMesh', {
      reason: 'syncProxyMeshState returned no mesh'
    })
    return true
  }
  if (!proxyMesh.texture || proxyMesh.texture.destroyed) {
    logDepthProxyIssue(state, 'CustomTileOverhead.depthProxy.missingTexture', {
      reason: 'proxy mesh has no live texture'
    })
    return true
  }
  try {
    proxyMesh.textureAlphaThreshold = resolveProxyTextureAlphaThreshold(state.tile, sourceMesh)
    renderProxyDepthDataUnchecked(proxyMesh, renderer)
    clearDepthProxyIssue(state)
  } catch (error) {
    logDepthProxyIssue(state, 'CustomTileOverhead.depthProxy.renderFailed', {
      error: String(error?.message || error)
    })
  }
  return true
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

function shouldApplyCustomOverheadEffects(tile = null) {
  return shouldUseTileSurfaceProxy(tile) || shouldApplyVisibleOverheadEffects(tile)
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
  markDepthMaskDirty()
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

function isManagedMaskedTextureBlendFilter(filter) {
  try {
    return Object.getOwnPropertySymbols(filter || {})
      .some((symbol) => String(symbol) === 'Symbol(faNexusMaskedTextureBlendFilter)' && filter[symbol] === true)
  } catch (_) {
    return false
  }
}

function composeCustomOverheadFilterStack(baseFilters, overheadFilter) {
  const filters = Array.isArray(baseFilters) ? [...baseFilters] : []
  const blendIndex = filters.findIndex(isManagedMaskedTextureBlendFilter)
  if (blendIndex < 0) return [...filters, overheadFilter]
  return [
    ...filters.slice(0, blendIndex),
    overheadFilter,
    ...filters.slice(blendIndex)
  ]
}

function syncTargetFilters(state) {
  if (!state) return
  if (!shouldApplyCustomOverheadEffects(state?.tile)) {
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
        const filter = createCustomTileOverheadFilter(state.tile)
        if (!filter) continue
        record = {
          target,
          filter,
          originalFilters,
          originalFilterArea: target.filterArea ?? null,
          hadFilterArea
        }
        state.targetFilters.set(target, record)
      }
      const baseFilters = record.originalFilters ? [...record.originalFilters] : []
      try { target.filters = composeCustomOverheadFilterStack(baseFilters, record.filter) } catch (_) {}
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
  if (!shouldUseCustomOverheadProxy(state.tile)) {
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
  if (state.proxyTexture && !state.proxyTexture.destroyed && state.proxySizeKey === sizeKey) {
    state.mesh.faNexusCustomOverheadProxyTexture = state.proxyTexture
    state.tile.faNexusCustomOverheadProxyTexture = state.proxyTexture
    return state.proxyTexture
  }
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
  markDepthMaskDirty()
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

function createProxyRoot(entry, state) {
  try {
    const root = typeof entry?.proxyFactory === 'function'
      ? entry.proxyFactory({ tile: state.tile, mesh: state.mesh, state, entry })
      : cloneDisplayObjectForProxy(entry?.contentContainer)
    if (root && !root.destroyed) return root
  } catch (error) {
    Logger.warn?.('CustomTileOverhead.proxyFactory.failed', {
      error: String(error?.message || error),
      tileId: state?.tileId
    })
  }
  return cloneDisplayObjectForProxy(entry?.contentContainer)
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
    if (!shouldUseCustomOverheadProxy(state.tile)) {
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
    markDepthMaskDirty()
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
    if (!shouldUseCustomOverheadProxy(tile)) {
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
    if (!shouldUseCustomOverheadProxy(tile)) {
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

export function flushCustomTileOverhead(tile, reason = 'flush') {
  try {
    const state = getState(tile)
    if (!state) return false
    cancelScheduledRebuild(state)
    state.rebuildReason = reason
    rebuildCustomTileOverhead(state)
    return true
  } catch (error) {
    Logger.error?.('CustomTileOverhead.flush.failed', {
      tileId: resolveTileId(tile),
      reason,
      error: String(error?.message || error)
    })
    return false
  }
}

export function flushAllCustomTileOverheads(reason = 'global-flush') {
  const results = {
    total: 0,
    flushed: 0,
    failed: 0
  }
  try {
    for (const state of Array.from(TILE_STATES.values())) {
      results.total += 1
      if (flushCustomTileOverhead(state?.tile, reason)) results.flushed += 1
      else results.failed += 1
    }
  } catch (error) {
    Logger.error?.('CustomTileOverhead.flushAll.failed', {
      reason,
      error: String(error?.message || error)
    })
    results.failed += 1
  }
  return results
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
    if (!shouldUseCustomOverheadProxy(tile)) {
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

function detachDestroyedTile(tile) {
  try {
    const state = getState(tile)
    if (state) {
      Logger.debug?.('CustomTileOverhead.destroyTile.cleanup', {
        tileId: state.tileId,
        isPreview: !!tile?.isPreview
      })
      destroyState(state)
      return
    }
    if (tile?.document?.id) detachDeletedTile(tile.document)
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
  Hooks.on('destroyTile', (tile) => {
    detachDestroyedTile(tile)
  })
  Hooks.on('canvasTearDown', () => {
    clearAllStates()
  })
} catch (_) {}
