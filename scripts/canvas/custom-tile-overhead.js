import { NexusLogger as Logger } from '../core/nexus-logger.js'
import { cloneDisplayObjectForProxy } from './display-object-proxy.js'
import { resolveTileId } from './tile-targets.js'
import {
  destroyCustomOverheadProxyMesh,
  syncCustomOverheadProxyMeshState
} from './custom-tile-overhead-proxy-mesh.js'
import {
  mapTileOcclusionElevation,
  tileUsesLightOrWeatherRestrictions,
  tileUsesSurfaceTileOcclusion,
  tileUsesVisibleTileOcclusion
} from './tile-occlusion.js'
import {
  CUSTOM_TILE_RENDER_PHASES,
  registerCustomTileRenderLifecycle
} from './custom-tile-render-scheduler.js'

const TILE_STATES = new Map()

const DEFAULT_PROXY_SIZE = 2
const MAX_PROXY_SIZE_FALLBACK = 4096
const MAX_PROXY_SIZE_CAP = 8192
const LATE_TEXTURE_REASON = 'late-texture'
const DEPTH_ALPHA_THRESHOLD_MIN = 1 / 255
const PROXY_ALPHA_RESOLUTION = 0.25
// The proxy answers "is this pixel solid" for hit tests, occlusion and light
// restriction. Half the Tile's size, 2048 pixels at most, keeps its edge within
// a few Scene pixels at a quarter of the memory or less.
const PROXY_SCALE = 0.5
const PROXY_LONG_SIDE = 2048
const MODULE_ID = 'fa-nexus'
const LAYER_HIDDEN_FLAG = 'layerHidden'
const FAILURE_LOG_THROTTLE_MS = 1000
const FAILURE_LOG_TIMES = new Map()

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
uniform vec4 uColor;
uniform sampler2D occlusionTexture;
uniform float occlusionElevation;
uniform float baseAlpha;
uniform float occludedAlpha;
uniform float fadeOcclusion;
uniform float radialOcclusion;
uniform float visionOcclusion;
uniform float surfaceOcclusion;

void main() {
  vec4 color = texture2D(uSampler, vTextureCoord) * uColor;
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

const MATERIAL_VERTEX_SHADER = `
attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;
uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform mat3 uTextureMatrix;
uniform vec2 screenDimensions;
varying vec2 vTextureCoord;
varying vec2 vMaskTextureCoord;
void main() {
  vec3 position = translationMatrix * vec3(aVertexPosition, 1.0);
  gl_Position = vec4((projectionMatrix * position).xy, 0.0, 1.0);
  vTextureCoord = (uTextureMatrix * vec3(aTextureCoord, 1.0)).xy;
  vMaskTextureCoord = position.xy / max(screenDimensions, vec2(1.0));
}
`

let CustomTileOverheadMaterialClass = null
let CustomTileOverheadMaterialBase = null

function createOverheadUniforms() {
  return {
    screenDimensions: [1, 1],
    occlusionTexture: getTransparentFallbackTexture(),
    occlusionElevation: 0,
    baseAlpha: 1,
    occludedAlpha: 0,
    fadeOcclusion: 0,
    radialOcclusion: 0,
    visionOcclusion: 0,
    surfaceOcclusion: 0
  }
}

function syncOverheadUniforms(tile, uniforms) {
  const mesh = tile?.mesh
  const effectsActive = shouldApplyCustomOverheadEffects(tile)
  const occlusionMask = canvas?.masks?.occlusion
  uniforms.screenDimensions = canvas?.screenDimensions || [1, 1]
  uniforms.occlusionTexture = occlusionMask?.renderTexture || getTransparentFallbackTexture()
  uniforms.occlusionElevation = mapTileOcclusionElevation(tile, { mesh, occlusionMask })
    ?? occlusionMask?.mapElevation?.(mesh?.elevation ?? tile?.document?.elevation ?? 0)
    ?? 0
  uniforms.baseAlpha = effectsActive ? clamp(mesh?.unoccludedAlpha ?? tile?.document?.alpha, 0, 1, 1) : 1
  uniforms.occludedAlpha = effectsActive ? clamp(mesh?.occludedAlpha ?? tile?.document?.occlusion?.alpha, 0, 1, 0) : 1
  const state = effectsActive ? mesh?._occlusionState : null
  uniforms.fadeOcclusion = clamp(state?.fade, 0, 1, 0)
  uniforms.radialOcclusion = clamp(state?.radial, 0, 1, 0)
  uniforms.visionOcclusion = clamp(state?.vision, 0, 1, 0)
  uniforms.surfaceOcclusion = clamp(state?.surface, 0, 1, 0)
}

function canIntegrateOverhead(tile) {
  // This is also queried by Pixi before every filtered draw. Native alpha and
  // mode weights suffice; avoid reparsing the Tile's configured mode set here.
  // When effects are inactive, syncOverheadUniforms already supplies identity.
  const mesh = tile?.mesh
  const binary = value => value === 0 || value === 1
  if (!binary(clamp(mesh?.unoccludedAlpha ?? tile?.document?.alpha, 0, 1, 1))) return false
  if (!binary(clamp(mesh?.occludedAlpha ?? tile?.document?.occlusion?.alpha, 0, 1, 0))) return false
  const state = mesh?._occlusionState
  return binary(clamp(state?.fade, 0, 1, 0)) && binary(clamp(state?.radial, 0, 1, 0))
    && binary(clamp(state?.vision, 0, 1, 0)) && binary(clamp(state?.surface, 0, 1, 0))
}

/** Wall meshes sample Foundry's live occlusion mask in their ordinary draw.
 * Keep MeshMaterial's texture matrix, tint and premultiplied alpha behavior.
 * Proxy clones neutralize these uniforms: silhouettes never bake live occlusion. */
export function createCustomTileOverheadMaterial(texture, tile) {
  const MaterialClass = globalThis.PIXI?.MeshMaterial
  if (!MaterialClass) throw new Error('Custom Tile artwork requires Pixi MeshMaterial.')
  if (!CustomTileOverheadMaterialClass || CustomTileOverheadMaterialBase !== MaterialClass) {
    CustomTileOverheadMaterialBase = MaterialClass
    const program = PIXI.Program.from(MATERIAL_VERTEX_SHADER, FILTER_FRAGMENT_SHADER, 'fa-nexus-wall-occlusion')
    CustomTileOverheadMaterialClass = class CustomTileOverheadMaterial extends MaterialClass {
      constructor(texture, tile) {
        super(texture, { program, uniforms: createOverheadUniforms() })
        this.tile = tile
        this.faNexusCustomOverheadMaterial = true
      }

      update() {
        super.update()
        syncOverheadUniforms(this.tile, this.uniforms)
        if (!canIntegrateOverhead(this.tile)) {
          // Fractional opacity must apply after the whole mesh is composited:
          // wall joins can contain overlapping triangles. The live filter owns
          // this case, including intermediate frames of an occlusion animation.
          this.uniforms.baseAlpha = this.uniforms.occludedAlpha = 1
        }
      }
    }
  }
  return new CustomTileOverheadMaterialClass(texture, tile)
}

function clamp(value, min, max, fallback = min) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

function warnCustomTileOverheadFailure(code, { tile = null, reason = null, error = null } = {}) {
  try {
    const tileId = resolveTileId(tile)
    const errorText = String(error?.message || error)
    const key = `${code}:${tileId || ''}:${reason || ''}:${errorText}`
    const now = Date.now()
    const previous = FAILURE_LOG_TIMES.get(key) || 0
    if (now - previous < FAILURE_LOG_THROTTLE_MS) return
    FAILURE_LOG_TIMES.set(key, now)
    Logger.warn?.(code, {
      tileId,
      reason,
      error: errorText
    })
  } catch (_) {}
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

function readFaLayerHiddenFlag(doc) {
  try {
    const direct = doc?.getFlag?.(MODULE_ID, LAYER_HIDDEN_FLAG)
    if (direct !== undefined) return direct
  } catch (error) {
    Logger.warn?.('CustomTileOverhead.layerHiddenFlag.readFailed', {
      tileId: resolveTileId(doc?.object || doc),
      error: String(error?.message || error)
    })
  }
  const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID]
  return flags ? flags[LAYER_HIDDEN_FLAG] : null
}

function resolveCustomOverheadDisplayState(tile, mesh) {
  const doc = tile?.document
  const layerHidden = !!readFaLayerHiddenFlag(doc)
  return {
    visible: !layerHidden && tile?.visible !== false && mesh?.visible !== false,
    renderable: !layerHidden && tile?.renderable !== false && mesh?.renderable !== false
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
  const maxSize = Math.min(getMaxProxyTextureSize(), PROXY_LONG_SIDE)
  const scale = Math.min(PROXY_SCALE, maxSize / Math.max(docWidth, docHeight))
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

// Tile refreshes that leave the drawn artwork as it is. Every other reason may
// have changed which pixels are solid.
const SILHOUETTE_KEEPING_REASONS = new Set([
  'tile-refreshState',
  'tile-refreshElevation',
  'activateTokensLayer',
  'activateTilesLayer',
  'scene-transition-precapture'
])

function noteRebuildReason(state, reason, keepsSilhouette = false) {
  state.rebuildReason = reason
  if (keepsSilhouette || SILHOUETTE_KEEPING_REASONS.has(String(reason || '').split(':')[0])) return
  state.silhouetteStale = true
}

/** The solid pixels of the proxy as Foundry's TextureAlphaData. Foundry's own
 * reader keeps the first reading of a texture for good; the proxy is redrawn
 * into the same render texture after every edit, so it is read here. */
function resolveMeshProxyAlphaData(texture, resolution) {
  const renderer = getRenderer()
  if (!renderer || !texture?.valid) return null
  const width = Math.ceil(Math.round(texture.width * texture.resolution) * resolution)
  const height = Math.ceil(Math.round(texture.height * texture.resolution) * resolution)
  const sprite = new PIXI.Sprite(texture)
  sprite.width = width
  sprite.height = height
  sprite.anchor.set(0, 0)
  const target = PIXI.RenderTexture.create({ width, height })
  let pixels
  try {
    renderer.render(sprite, { renderTexture: target })
    pixels = renderer.extract.pixels(target)
  } finally {
    sprite.destroy(false)
    target.destroy(true)
  }
  let minX = width
  let minY = height
  let maxX = 0
  let maxY = 0
  for (let i = 3, y = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i += 4) {
      if (pixels[i] === 0) continue
      if (x < minX) minX = x
      if (x >= maxX) maxX = x + 1
      if (y < minY) minY = y
      if (y >= maxY) maxY = y + 1
    }
  }
  if (minX > maxX) minX = minY = maxX = maxY = 0
  const data = new Uint8Array((maxX - minX) * (maxY - minY))
  for (let i = 0, y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++, i++) data[i] = pixels[(((width * y) + x) * 4) + 3]
  }
  return { width, height, minX, minY, maxX, maxY, data }
}

function refreshMeshProxyAlphaData(state) {
  const proxyTexture = state?.proxyTexture
  if (!proxyTexture || proxyTexture.destroyed) state.proxyAlphaData = null
  else if (state.silhouetteStale || !state.proxyAlphaData) {
    // A quarter of the Tile's own size, as Foundry reads its Tiles.
    const resolution = Math.min(1, PROXY_ALPHA_RESOLUTION / (state.proxyScale || 1))
    state.proxyAlphaData = resolveMeshProxyAlphaData(proxyTexture, resolution)
    state.silhouetteStale = false
  }
  try { if (state?.mesh) invalidateMeshBounds(state.mesh) } catch (_) {}
}

function destroyProxyMesh(state) {
  return destroyCustomOverheadProxyMesh(state)
}

function syncProxyMeshState(state) {
  return syncCustomOverheadProxyMeshState(state, {
    resolveDisplayState: resolveCustomOverheadDisplayState,
    resolveTextureAlphaThreshold: resolveProxyTextureAlphaThreshold
  })
}

function resolveProxyTextureAlphaThreshold(tile, mesh) {
  const raw = Number(mesh?.textureAlphaThreshold ?? tile?.document?.texture?.alphaThreshold)
  const threshold = Number.isFinite(raw) ? clamp(raw, 0, 1, 0) : 0
  return shouldUseTileRestrictionProxy(tile)
    ? Math.max(threshold, DEPTH_ALPHA_THRESHOLD_MIN)
    : threshold
}

function getCustomTileOverheadFilterClass() {
  const FilterClass = globalThis.PIXI?.Filter
  if (!FilterClass) return null
  if (CustomTileOverheadFilterClass && CustomTileOverheadFilterBase === FilterClass) return CustomTileOverheadFilterClass
  CustomTileOverheadFilterBase = FilterClass
  CustomTileOverheadFilterClass = class CustomTileOverheadFilter extends FilterClass {
    constructor(tile, material = null) {
      super(FILTER_VERTEX_SHADER, FILTER_FRAGMENT_SHADER, { ...createOverheadUniforms(), uColor: [1, 1, 1, 1] })
      this.tile = tile
      this.material = material
    }

    get enabled() {
      return this._enabled !== false && !(this.material && canIntegrateOverhead(this.tile))
    }

    set enabled(value) { this._enabled = !!value }

    apply(filterManager, input, output, clear, currentState) {
      try {
        syncOverheadUniforms(this.tile, this.uniforms)
      } catch (_) {}
      super.apply(filterManager, input, output, clear, currentState)
    }
  }
  return CustomTileOverheadFilterClass
}

function createCustomTileOverheadFilter(tile, material = null) {
  const FilterClass = getCustomTileOverheadFilterClass()
  if (!FilterClass) {
    Logger.error?.('CustomTileOverhead.filter.pixiMissing', {
      tileId: resolveTileId(tile)
    })
    return null
  }
  return new FilterClass(tile, material)
}

function createState(tile, mesh) {
  const state = {
    tile,
    tileId: resolveTileId(tile),
    mesh,
    proxyTexture: null,
    proxyAlphaData: null,
    silhouetteStale: true,
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

function removeEntryContainerFromMesh(state, contentContainer) {
  const mesh = state?.mesh
  if (!mesh || !contentContainer || contentContainer.destroyed) return false
  const wasParentedToMesh = contentContainer.parent === mesh
  if (wasParentedToMesh) {
    try { mesh.removeChild(contentContainer) } catch (_) {}
  }
  return wasParentedToMesh
}

function destroyEntryContainer(contentContainer) {
  if (!contentContainer || contentContainer.destroyed) return
  try { contentContainer.destroy?.({ children: true, texture: false, baseTexture: false }) } catch (_) {}
}

function replaceCustomOverheadEntry(state, entry, { sameContent = false } = {}) {
  if (!state || !entry) return null
  const previousEntry = state.entries.get(entry.kind) || null
  if (previousEntry?.contentContainer && previousEntry.contentContainer !== entry.contentContainer) {
    removeEntryContainerFromMesh(state, previousEntry.contentContainer)
  }
  if (!sameContent) state.silhouetteStale = true
  state.entries.set(entry.kind, entry)
  return entry
}

function removeCustomOverheadEntry(state, entryKind, { preserveContainers = true, destroyUnparented = false, deleteEntry = true } = {}) {
  if (!state) return null
  const entry = state.entries.get(entryKind) || null
  if (!entry) return null
  const contentContainer = entry.contentContainer
  if (!preserveContainers && contentContainer && !contentContainer.destroyed) {
    const wasParentedToMesh = removeEntryContainerFromMesh(state, contentContainer)
    if (wasParentedToMesh || destroyUnparented) destroyEntryContainer(contentContainer)
  }
  if (deleteEntry) state.entries.delete(entryKind)
  state.silhouetteStale = true
  return entry
}

function clearCustomOverheadEntries(state, { preserveContainers = false, deleteEntries = true } = {}) {
  if (!state) return
  for (const entryKind of Array.from(state.entries.keys())) {
    removeCustomOverheadEntry(state, entryKind, { preserveContainers, destroyUnparented: true, deleteEntry: deleteEntries })
  }
}

// The Tile's rectangle in the artwork container's own coordinates, with a
// margin: PIXI skips a container whose cull area is off screen, with its masks
// and filters, each of which would otherwise be a render pass on every frame.
// The rectangle depends on the Tile's size alone, not on what is drawn in it
// (a Scatter only holds the sprites near the view).
const CULL_MARGIN = 0.25
const CULL_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]]

function syncEntryCullArea(state, entry) {
  const container = entry?.contentContainer
  const mesh = state?.mesh
  if (!container || container.destroyed || !mesh || mesh.destroyed || container.parent !== mesh) return
  const width = Number(mesh.texture?.orig?.width)
  const height = Number(mesh.texture?.orig?.height)
  if (!(width > 0) || !(height > 0)) {
    container.cullable = false
    container.cullArea = null
    return
  }
  const anchorX = Number(mesh.anchor?.x) || 0
  const anchorY = Number(mesh.anchor?.y) || 0
  container.transform.updateLocalTransform()
  const local = container.transform.localTransform
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [u, v] of CULL_CORNERS) {
    const point = local.applyInverse({ x: (u - anchorX) * width, y: (v - anchorY) * height })
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || !(maxX > minX) || !(maxY > minY)) {
    container.cullable = false
    container.cullArea = null
    return
  }
  const marginX = (maxX - minX) * CULL_MARGIN
  const marginY = (maxY - minY) * CULL_MARGIN
  const area = container.cullArea || new PIXI.Rectangle()
  area.x = minX - marginX
  area.y = minY - marginY
  area.width = (maxX - minX) + (marginX * 2)
  area.height = (maxY - minY) + (marginY * 2)
  container.cullArea = area
  container.cullable = true
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
    syncEntryCullArea(state, entry)
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
  const displayState = resolveCustomOverheadDisplayState(state?.tile, mesh)
  const shouldShow = displayState.visible
  const shouldRender = displayState.renderable
  const effectsActive = shouldApplyCustomOverheadEffects(state?.tile)
  const documentAlpha = clamp(state?.tile?.document?.alpha, 0, 1, 1)
  const contentAlpha = effectsActive
    ? 1
    : documentAlpha
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
    try {
      // Mask containers keep every shared parent and the mask neutral. Their
      // textured leaf owns ordinary opacity; the overhead filter owns it while
      // active so the document alpha is applied exactly once in either path.
      contentContainer.alpha = contentContainer.faNexusMaskSprite ? 1 : contentAlpha
    } catch (_) {}
    if (contentContainer.faNexusMaskSprite) {
      const artwork = contentContainer.faNexusTilingSprite
        || contentContainer.faNexusBaseDisplayObject
        || null
      try { if (artwork && !artwork.destroyed) artwork.alpha = effectsActive ? 1 : documentAlpha } catch (_) {}
      try {
        const mask = contentContainer.faNexusMaskSprite
        if (mask && !mask.destroyed) mask.alpha = 1
      } catch (_) {}
    }
  }
  syncProxyMeshState(state)
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

function requestAttachedOverheadRefresh(tile, refreshReason, options) {
  if (!refreshReason) return
  invalidateCustomTileOverhead(tile, refreshReason, options)
}

function restoreTargetFilters(state) {
  if (!state?.targetFilters?.size) return
  for (const record of state.targetFilters.values()) {
    const target = record?.target
    if (!target || target.destroyed) continue
    const baseFilters = record.originalFilters?.filter?.(canPreserveTargetFilter) || []
    try { target.filters = baseFilters.length ? [...baseFilters] : null } catch (_) {}
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

function isManagedHsbcFilter(filter) {
  try {
    return Object.getOwnPropertySymbols(filter || {})
      .some((symbol) => String(symbol) === 'Symbol(faNexusManagedHsbcFilter)' && filter[symbol] === true)
  } catch (_) {
    return false
  }
}

function canPreserveTargetFilter(filter) {
  if (!filter || filter.destroyed) return false
  if (!isManagedHsbcFilter(filter)) return true
  try {
    return !!filter.uniforms
  } catch (_) {
    return false
  }
}

function composeCustomOverheadFilterStack(baseFilters, overheadFilter) {
  const filters = Array.isArray(baseFilters) ? baseFilters.filter(canPreserveTargetFilter) : []
  const blendIndex = filters.findIndex(isManagedMaskedTextureBlendFilter)
  if (blendIndex < 0) return [...filters, overheadFilter]
  return [
    ...filters.slice(0, blendIndex),
    overheadFilter,
    ...filters.slice(blendIndex)
  ]
}

function resolveCurrentTargetBaseFilters(target, record) {
  const current = Array.isArray(target?.filters) ? target.filters.filter(canPreserveTargetFilter) : []
  const withoutOverhead = current.filter((filter) => filter !== record?.filter)
  if (current.includes(record?.filter)) return withoutOverhead
  if (withoutOverhead.length) return withoutOverhead
  return Array.isArray(record?.originalFilters) ? record.originalFilters.filter(canPreserveTargetFilter) : []
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
      const material = target.shader?.faNexusCustomOverheadMaterial ? target.shader : null
      let record = state.targetFilters.get(target)
      if (!record) {
        const originalFilters = Array.isArray(target.filters) ? target.filters.filter(canPreserveTargetFilter) : null
        const hadFilterArea = target.filterArea !== undefined
        const filter = createCustomTileOverheadFilter(state.tile, material)
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
      record.filter.material = material
      const baseFilters = resolveCurrentTargetBaseFilters(target, record)
      record.originalFilters = baseFilters.length ? [...baseFilters] : null
      try { target.filters = composeCustomOverheadFilterStack(baseFilters, record.filter) } catch (_) {}
    }
  }

  for (const [target, record] of Array.from(state.targetFilters.entries())) {
    if (nextTargets.has(target)) continue
    if (!target.destroyed) {
      const baseFilters = record.originalFilters?.filter?.(canPreserveTargetFilter) || []
      try { target.filters = baseFilters.length ? [...baseFilters] : null } catch (_) {}
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
  state.proxyScale = Math.min(size.scaleX, size.scaleY)
  state.silhouetteStale = true
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
  clearCustomOverheadEntries(state, { preserveContainers, deleteEntries: false })

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
  syncContent = null,
  refreshReason = null,
  contentKey = null
} = {}) {
  try {
    if (!tile || tile.destroyed || !contentContainer || contentContainer.destroyed) return null
    const mesh = tile.mesh
    if (!mesh || mesh.destroyed) return null
    const state = ensureState(tile, mesh)
    // A renderer that attaches again on every Tile refresh names what it drew.
    // The same name on the same container is the same silhouette.
    const previous = state.entries.get(kind) || null
    const sameContent = contentKey !== null && previous?.contentContainer === contentContainer
      && previous.contentKey === contentKey
    const entry = replaceCustomOverheadEntry(state, {
      kind,
      contentContainer,
      proxyFactory,
      filterMode: filterMode === 'container' ? 'container' : 'leaf',
      syncContent: typeof syncContent === 'function' ? syncContent : null,
      contentKey
    }, { sameContent })
    ensureEntryParent(state, entry)
    syncEntryContent(state, entry, 'attach')
    syncVisibleState(state)
    if (!shouldUseCustomOverheadProxy(tile)) {
      deactivateOverheadRuntime(state)
      requestAttachedOverheadRefresh(tile, refreshReason, { keepsSilhouette: sameContent })
      return state
    }
    syncTargetFilters(state)
    monitorLateTextures(state)
    requestAttachedOverheadRefresh(tile, refreshReason, { keepsSilhouette: sameContent })
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

export function invalidateCustomTileOverhead(tile, reason = 'refresh', { keepsSilhouette = false } = {}) {
  try {
    const state = getState(tile)
    if (!state) return
    noteRebuildReason(state, reason, keepsSilhouette)
    if (!shouldUseCustomOverheadProxy(tile)) {
      deactivateOverheadRuntime(state)
      return
    }
    queueRebuild(state)
  } catch (error) {
    warnCustomTileOverheadFailure('CustomTileOverhead.invalidate.failed', {
      tile,
      reason,
      error
    })
  }
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
      removeCustomOverheadEntry(state, entryKind, { preserveContainers })
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
    noteRebuildReason(state, reason)
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
  } catch (error) {
    warnCustomTileOverheadFailure('CustomTileOverhead.refresh.failed', {
      tile,
      reason,
      error
    })
  }
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
    // A delete event owns this Document, not every Tile with its embedded ID.
    for (const state of Array.from(TILE_STATES.values())) {
      if (state?.tile?.document === doc) destroyState(state)
    }
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
  registerCustomTileRenderLifecycle({
    id: 'custom-tile-overhead',
    hooks: ['drawTile', 'refreshTile'],
    phase: CUSTOM_TILE_RENDER_PHASES.OVERHEAD,
    callback: (tile) => refreshCustomTileOverhead(tile),
    logCode: 'CustomTileOverhead.lifecycle.failed'
  })
  Hooks.on('canvasReady', () => {
    patchTileRefreshMethods()
    invalidateAllCustomTileOverheads('canvasReady')
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
