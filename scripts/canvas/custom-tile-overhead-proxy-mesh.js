export function destroyCustomOverheadProxyMesh(state) {
  const proxyMesh = state?.proxyMesh
  if (!proxyMesh || proxyMesh.destroyed) return
  try { proxyMesh.parent = null } catch (_) {}
  try { proxyMesh.destroy({ children: true, texture: false, baseTexture: false }) } catch (_) {}
  state.proxyMesh = null
}

export function ensureCustomOverheadProxyMesh(state) {
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

export function syncCustomOverheadProxyMeshState(state, {
  resolveDisplayState,
  resolveTextureAlphaThreshold
} = {}) {
  if (typeof resolveDisplayState !== 'function') throw new Error('Custom overhead proxy mesh display resolver is required')
  if (typeof resolveTextureAlphaThreshold !== 'function') throw new Error('Custom overhead proxy mesh alpha threshold resolver is required')
  const mesh = state?.mesh
  const proxyMesh = ensureCustomOverheadProxyMesh(state)
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
  const displayState = resolveDisplayState(state?.tile, mesh)
  if (!displayState) throw new Error('Custom overhead proxy mesh display resolver returned no state')
  try { proxyMesh.visible = displayState.visible } catch (_) {}
  try { proxyMesh.renderable = displayState.renderable } catch (_) {}
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
  try { proxyMesh.textureAlphaThreshold = resolveTextureAlphaThreshold(state?.tile, mesh) } catch (_) {}
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
