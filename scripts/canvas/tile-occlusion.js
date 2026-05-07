function coerceFiniteInteger(value) {
  const numeric = Number(value)
  return Number.isInteger(numeric) ? numeric : null
}

const FA_NEXUS_FOREGROUND_BAND_KIND = 'foreground'

function collectModeValues(modes, target) {
  if (modes instanceof Set) {
    for (const value of modes) target.push(value)
    return
  }
  if (Array.isArray(modes)) {
    target.push(...modes)
    return
  }
  const numeric = coerceFiniteInteger(modes)
  if (numeric !== null) target.push(numeric)
}

function getOwnDataProperty(object, key) {
  if (!object || (typeof object !== 'object')) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (!descriptor || !('value' in descriptor)) return undefined
  return descriptor.value
}

function getLegacyOcclusionMode(occlusion) {
  if (!occlusion || (typeof occlusion !== 'object')) return null

  const directMode = coerceFiniteInteger(getOwnDataProperty(occlusion, 'mode'))
  if (directMode !== null) return directMode

  const sourceOcclusion = getOwnDataProperty(occlusion, '_source')
  if (sourceOcclusion && sourceOcclusion !== occlusion) {
    return getLegacyOcclusionMode(sourceOcclusion)
  }

  return null
}

function normalizeModeList(values) {
  return Array.from(new Set(
    values
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  ))
}

function legacyModeToV14Mode(legacyMode) {
  const numeric = coerceFiniteInteger(legacyMode)
  if (numeric === null || numeric <= 0) return null
  return 1 << (numeric - 1)
}

function resolveMaskFromModes(modes) {
  return normalizeModeList(modes).reduce((mask, mode) => mask | mode, 0)
}

function resolveModeCandidates(modes) {
  if (modes instanceof Set || Array.isArray(modes)) return Array.from(modes)
  const numeric = coerceFiniteInteger(modes)
  return numeric === null ? [] : [numeric]
}

export const DEFAULT_VISIBLE_TILE_OCCLUSION_MODES = Object.freeze([1, 4, 8])

export function getTileOcclusionModes(occlusion, { sourceOcclusion = null } = {}) {
  const modes = []
  collectModeValues(occlusion?.modes, modes)
  collectModeValues(sourceOcclusion?.modes, modes)

  const embeddedSourceOcclusion = getOwnDataProperty(occlusion, '_source')
  collectModeValues(embeddedSourceOcclusion?.modes, modes)

  const normalizedModes = normalizeModeList(modes)
  if (normalizedModes.length) return normalizedModes

  const legacyMode = [
    getLegacyOcclusionMode(sourceOcclusion),
    getLegacyOcclusionMode(embeddedSourceOcclusion),
    getLegacyOcclusionMode(occlusion)
  ].find((value) => value !== null)

  const v14Mode = legacyModeToV14Mode(legacyMode)
  return v14Mode ? [v14Mode] : []
}

export function getTileOcclusionMask(occlusion, options = {}) {
  return resolveMaskFromModes(getTileOcclusionModes(occlusion, options))
}

export function tileUsesOcclusionModes(occlusion, expectedModes, options = {}) {
  const currentMask = getTileOcclusionMask(occlusion, options)
  if (!currentMask) return false
  const expectedMask = resolveMaskFromModes(resolveModeCandidates(expectedModes))
  return expectedMask ? ((currentMask & expectedMask) !== 0) : false
}

export function getVisibleTileOcclusionModes() {
  const occlusionModes = globalThis?.CONST?.OCCLUSION_MODES || {}
  const modes = [
    Number(occlusionModes.FADE),
    Number(occlusionModes.RADIAL),
    Number(occlusionModes.VISION)
  ].filter(Number.isFinite)
  return modes.length ? modes : DEFAULT_VISIBLE_TILE_OCCLUSION_MODES
}

export function tileUsesVisibleTileOcclusion(occlusion, options = {}) {
  return tileUsesOcclusionModes(occlusion, getVisibleTileOcclusionModes(), options)
}

export function getSurfaceTileOcclusionModes() {
  const mode = Number(globalThis?.CONST?.OCCLUSION_MODES?.SURFACE)
  return Number.isFinite(mode) ? [mode] : [2]
}

export function tileUsesSurfaceTileOcclusion(occlusion, options = {}) {
  return tileUsesOcclusionModes(occlusion, getSurfaceTileOcclusionModes(), options)
}

export function tileUsesLightOrWeatherRestrictions(target) {
  const restrictions = target?.restrictions || target || null
  return !!(restrictions?.light || restrictions?.weather)
}

export function normalizeTileOcclusionForV14(occlusion, { sourceOcclusion = null } = {}) {
  const alphaValue = Number(occlusion?.alpha ?? sourceOcclusion?.alpha ?? embeddedSourceAlpha(occlusion))
  const alpha = Number.isFinite(alphaValue) ? Math.max(0, Math.min(1, alphaValue)) : 0

  return {
    modes: getTileOcclusionModes(occlusion, { sourceOcclusion }),
    alpha
  }
}

function embeddedSourceAlpha(occlusion) {
  const sourceOcclusion = getOwnDataProperty(occlusion, '_source')
  return sourceOcclusion?.alpha
}

function nextDown(value) {
  if (typeof Math.nextDown === 'function') return Math.nextDown(value)
  const scale = Math.max(1, Math.abs(value))
  return value - (Number.EPSILON * scale)
}

function applySameElevationSurfaceRule(mesh, elevation) {
  if (
    mesh?._occludedBySameElevationSurfaces === false
    || (
      mesh?.faNexusBgBandApplied
      && mesh?.faNexusBgBandKind === FA_NEXUS_FOREGROUND_BAND_KIND
    )
  ) {
    return nextDown(elevation)
  }
  return elevation
}

function getFiniteElevation(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
  }
  return null
}

function resolveTileDocumentForOcclusion(target, mesh = null) {
  return target?.document
    || target
    || mesh?.object?.document
    || mesh?.object
    || null
}

export function resolveTileOcclusionElevation(target, {
  mesh = target?.mesh,
  document = resolveTileDocumentForOcclusion(target, mesh),
  fallback = 0
} = {}) {
  const documentElevation = getFiniteElevation(document?.elevation, document?._source?.elevation)
  const renderElevation = getFiniteElevation(mesh?.faNexusBgBandValue, mesh?.elevation)
  const meshElevation = getFiniteElevation(mesh?.elevation)
  const elevation = mesh?.faNexusBgBandApplied && renderElevation !== null
    ? renderElevation
    : getFiniteElevation(meshElevation, documentElevation, fallback, 0)
  return applySameElevationSurfaceRule(mesh, elevation ?? 0)
}

export function mapTileOcclusionElevation(target, {
  mesh = target?.mesh,
  document = resolveTileDocumentForOcclusion(target, mesh),
  occlusionMask = globalThis?.canvas?.masks?.occlusion,
  fallback = 0
} = {}) {
  try {
    if (typeof occlusionMask?.mapElevation !== 'function') return null
    const elevation = resolveTileOcclusionElevation(target, { mesh, document, fallback })
    const mapped = occlusionMask.mapElevation(elevation)
    return Number.isFinite(mapped) ? mapped : null
  } catch (_) {
    return null
  }
}

export function installTileOcclusionElevationOverride(mesh, document = null) {
  if (!mesh || mesh.destroyed) return { status: 'skipped', reason: 'missing-mesh' }
  const existing = Object.getOwnPropertyDescriptor(mesh, '_occlusionElevation')
  if (existing && !mesh.faNexusOcclusionElevationOverride) {
    return { status: 'blocked', reason: 'existing-own-descriptor' }
  }
  if (!mesh.faNexusOcclusionElevationOverride) {
    try { mesh.faNexusOcclusionElevationOriginalDescriptor = existing || null } catch (_) {}
  }
  try {
    Object.defineProperty(mesh, '_occlusionElevation', {
      configurable: true,
      get() {
        const targetDocument = resolveTileDocumentForOcclusion(this?.object, this) || document
        const mapped = mapTileOcclusionElevation(this?.object || targetDocument, {
          mesh: this,
          document: targetDocument,
          occlusionMask: globalThis?.canvas?.masks?.occlusion,
          fallback: this?.elevation ?? 0
        })
        if (mapped !== null) return mapped
        const fallbackElevation = applySameElevationSurfaceRule(this, Number(this?.elevation) || 0)
        return globalThis?.canvas?.masks?.occlusion?.mapElevation?.(fallbackElevation) ?? 0
      }
    })
    mesh.faNexusOcclusionElevationOverride = true
    return { status: 'installed' }
  } catch (error) {
    return { status: 'failed', reason: 'define-failed', error }
  }
}

export function removeTileOcclusionElevationOverride(mesh) {
  if (!mesh || !mesh.faNexusOcclusionElevationOverride) return { status: 'skipped', reason: 'not-installed' }
  const original = mesh.faNexusOcclusionElevationOriginalDescriptor
  try {
    if (original) Object.defineProperty(mesh, '_occlusionElevation', original)
    else delete mesh._occlusionElevation
    delete mesh.faNexusOcclusionElevationOverride
    delete mesh.faNexusOcclusionElevationOriginalDescriptor
    return { status: 'removed' }
  } catch (error) {
    return { status: 'failed', reason: 'restore-failed', error }
  }
}
