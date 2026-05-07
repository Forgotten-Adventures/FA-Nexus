import { NexusLogger as Logger } from '../core/nexus-logger.js'
import { resolveTileId } from './tile-targets.js'

function clamp(value, min, max, fallback = min) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
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

function shouldCloneDisplayFilter(filter) {
  if (!filter || filter.destroyed) return false
  try {
    if (filter?.constructor?.name === 'CustomTileOverheadFilter') return false
  } catch (_) {}
  return true
}

function copyDisplayFilters(source, target) {
  if (!source || !target) return
  try {
    const filters = Array.isArray(source.filters)
      ? source.filters.filter((filter) => shouldCloneDisplayFilter(filter))
      : []
    target.filters = filters.length ? [...filters] : null
  } catch (_) {}
  try {
    if (source.filterArea !== undefined) target.filterArea = source.filterArea ?? null
  } catch (_) {}
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
  copyDisplayFilters(source, target)
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

function cloneCustomDisplayPropValue(value, map) {
  if (!value) return value
  if (map?.has?.(value)) return map.get(value)
  if ((value instanceof PIXI.Texture) || (value instanceof PIXI.BaseTexture)) return value
  if (ArrayBuffer.isView(value)) return new value.constructor(value)
  if (Array.isArray(value)) return value.map((entry) => cloneCustomDisplayPropValue(entry, map))
  if (value && (typeof value === 'object')) {
    const proto = Object.getPrototypeOf(value)
    if ((proto === Object.prototype) || (proto === null)) {
      const cloned = {}
      for (const [key, entry] of Object.entries(value)) {
        cloned[key] = cloneCustomDisplayPropValue(entry, map)
      }
      return cloned
    }
  }
  return value
}

function copyMappedCustomDisplayProps(map) {
  for (const [source, clone] of map.entries()) {
    if (!source || !clone || source.destroyed || clone.destroyed) continue
    const keys = Object.keys(source).filter((key) => key.startsWith('faNexus'))
    for (const key of keys) {
      if (key === 'faNexusPreviewMirrorSource') continue
      const value = source[key]
      if (typeof value === 'function') continue
      try { clone[key] = cloneCustomDisplayPropValue(value, map) } catch (_) {}
    }
  }
}

export function cloneDisplayObjectForProxy(displayObject) {
  try {
    const map = new Map()
    const clone = cloneDisplayObjectTree(displayObject, map)
    applyClonedMasks(map)
    copyMappedCustomDisplayProps(map)
    return clone
  } catch (error) {
    Logger.warn?.('DisplayObjectProxy.clone.failed', {
      error: String(error?.message || error),
      tileId: resolveTileId(displayObject?.tile || null)
    })
    return null
  }
}

export function createDisplayProxyFactory(displayObject) {
  return () => cloneDisplayObjectForProxy(displayObject)
}
