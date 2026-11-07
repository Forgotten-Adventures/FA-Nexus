import { SceneGroupWorkflow } from '../composition/scene-group-workflow.js';

const MODULE_ID = 'fa-nexus';

function normalizeIdentity(value) {
  return String(value || '').trim();
}

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof globalThis.structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function readPathFlagRecords(tile) {
  const single = tile?.getFlag?.(MODULE_ID, 'pathV2')
    || tile?.flags?.[MODULE_ID]?.pathV2
    || tile?._source?.flags?.[MODULE_ID]?.pathV2
    || null;
  const merged = tile?.getFlag?.(MODULE_ID, 'pathsV2')
    || tile?.flags?.[MODULE_ID]?.pathsV2
    || tile?._source?.flags?.[MODULE_ID]?.pathsV2
    || null;
  return {
    single,
    merged,
    records: [
      ...(single ? [{ kind: 'single', index: 0, path: single }] : []),
      ...(Array.isArray(merged?.paths)
        ? merged.paths.map((path, index) => ({ kind: 'merged', index, path }))
        : [])
    ]
  };
}

export function collectManagedPathWallIdsFromFlags({ pathV2 = null, pathsV2 = null } = {}) {
  const wallIds = [];
  const seen = new Set();
  const records = [
    ...(pathV2 ? [pathV2] : []),
    ...(Array.isArray(pathsV2?.paths) ? pathsV2.paths : [])
  ];
  for (const path of records) {
    const foundryWalls = path?.foundryWalls;
    if (foundryWalls?.enabled !== true || !Array.isArray(foundryWalls.wallIds)) continue;
    for (const value of foundryWalls.wallIds) {
      const wallId = normalizeIdentity(value);
      if (!wallId || seen.has(wallId)) continue;
      seen.add(wallId);
      wallIds.push(wallId);
    }
  }
  return wallIds;
}

export function collectManagedPathWallIds(tile) {
  const flags = readPathFlagRecords(tile);
  return collectManagedPathWallIdsFromFlags({ pathV2: flags.single, pathsV2: flags.merged });
}

export function buildPathGeneratedWallAdoptionAction({
  ownerUuid,
  dependentUuids = [],
  previousDependentUuids = []
} = {}) {
  const normalizeList = (values) => Array.from(new Set(
    (Array.isArray(values) ? values : []).map(normalizeIdentity).filter(Boolean)
  ));
  return {
    type: 'adopt-generated-path-walls',
    ownerUuid: normalizeIdentity(ownerUuid),
    dependentUuids: normalizeList(dependentUuids),
    previousDependentUuids: normalizeList(previousDependentUuids)
  };
}

export function evaluatePathGeneratedWallIndependence({
  tileId,
  wallId,
  pathWall = null,
  pathV2 = null,
  pathsV2 = null
} = {}) {
  const normalizedTileId = normalizeIdentity(tileId);
  const normalizedWallId = normalizeIdentity(wallId);
  if (normalizeIdentity(pathWall?.tileId) !== normalizedTileId) {
    return { allowed: false, reason: 'The Wall no longer records the exact owning Path adapter identity.' };
  }
  const records = [
    ...(pathV2 ? [{ kind: 'single', index: 0, path: pathV2 }] : []),
    ...(Array.isArray(pathsV2?.paths)
      ? pathsV2.paths.map((path, index) => ({ kind: 'merged', index, path }))
      : [])
  ];
  const matches = records.filter(({ path }) => (
    path?.foundryWalls?.enabled === true
    && Array.isArray(path.foundryWalls.wallIds)
    && path.foundryWalls.wallIds.map(normalizeIdentity).includes(normalizedWallId)
  ));
  if (matches.length !== 1) {
    return { allowed: false, reason: 'The owning Path does not record this Wall as one exact managed output.' };
  }
  const managedWallIds = Array.from(new Set(
    matches[0].path.foundryWalls.wallIds.map(normalizeIdentity).filter(Boolean)
  ));
  if (managedWallIds.length !== 1) {
    return {
      allowed: false,
      reason: 'This Path manages multiple Wall segments. Make Independent is available only when the Path can stop recreating the selected Wall exactly.'
    };
  }
  return {
    allowed: true,
    reason: null,
    flagKind: matches[0].kind,
    flagIndex: matches[0].index
  };
}

export class PathGeneratedWallOwnership {
  constructor({ workflowFactory = () => new SceneGroupWorkflow() } = {}) {
    this._workflowFactory = workflowFactory;
  }

  async reconcileTileIds({ scene, user, tileIds = [] } = {}) {
    if (!scene) throw new Error('Canvas Scene is unavailable for Path generated-Wall ownership.');
    const normalizedTileIds = Array.from(new Set(
      (Array.isArray(tileIds) ? tileIds : []).map(normalizeIdentity).filter(Boolean)
    ));
    const registry = scene.getFlag?.(MODULE_ID, 'compositionRegistry') || null;
    const relationships = registry == null
      ? []
      : (Array.isArray(registry?.relationships)
          ? registry.relationships
          : (() => { throw new Error('Path generated-Wall ownership found a malformed composition registry.'); })());
    const results = [];
    for (const tileId of normalizedTileIds) {
      const tile = scene.tiles?.get?.(tileId) || scene.getEmbeddedDocument?.('Tile', tileId) || null;
      if (!tile?.uuid) throw new Error(`Committed Path Tile ${tileId} is unavailable for generated-Wall ownership.`);
      const previousDependentUuids = relationships
        .filter((relationship) => (
          normalizeIdentity(relationship?.type) === 'generated-by'
          && normalizeIdentity(relationship?.generator) === 'path-v2'
          && normalizeIdentity(relationship?.ownerUuid) === normalizeIdentity(tile.uuid)
        ))
        .map((relationship) => normalizeIdentity(relationship?.dependentUuid))
        .filter(Boolean);
      const wallIds = collectManagedPathWallIds(tile);
      const dependentUuids = wallIds.map((wallId) => {
        const wall = scene.walls?.get?.(wallId) || scene.getEmbeddedDocument?.('Wall', wallId) || null;
        if (!wall?.uuid) {
          throw new Error(`Committed Path Wall ${wallId} for Tile ${tileId} is unavailable for generated-Wall ownership.`);
        }
        const pathWall = wall.getFlag?.(MODULE_ID, 'pathWall')
          || wall?.flags?.[MODULE_ID]?.pathWall
          || wall?._source?.flags?.[MODULE_ID]?.pathWall
          || null;
        if (normalizeIdentity(pathWall?.tileId) !== tileId) {
          throw new Error(`Committed Path Wall ${wallId} does not identify owning Tile ${tileId}.`);
        }
        return normalizeIdentity(wall.uuid);
      });
      if (!dependentUuids.length && !previousDependentUuids.length) continue;
      const result = await this._workflowFactory().execute({
        scene,
        user,
        action: buildPathGeneratedWallAdoptionAction({
          ownerUuid: normalizeIdentity(tile.uuid),
          dependentUuids,
          previousDependentUuids
        })
      });
      results.push({ tileId, ...(result && typeof result === 'object' ? result : {}) });
    }
    return results;
  }

  _resolveMakeIndependentPlan({ scene, wallUuid } = {}) {
    const dependentUuid = normalizeIdentity(wallUuid);
    const registry = scene?.getFlag?.(MODULE_ID, 'compositionRegistry') || null;
    const relationships = Array.isArray(registry?.relationships) ? registry.relationships : [];
    const relationship = relationships.find((candidate) => (
      normalizeIdentity(candidate?.dependentUuid) === dependentUuid
      && normalizeIdentity(candidate?.type) === 'generated-by'
      && normalizeIdentity(candidate?.generator) === 'path-v2'
    )) || null;
    if (!relationship) {
      return {
        allowed: false,
        reason: 'This Wall is not managed by a Path.',
        ownerUuid: null,
        tileId: null
      };
    }
    const ownerUuid = normalizeIdentity(relationship.ownerUuid);
    const tileId = ownerUuid.split('.').pop() || null;
    const wallId = dependentUuid.split('.').pop() || null;
    const tile = tileId
      ? (scene?.tiles?.get?.(tileId) || scene?.getEmbeddedDocument?.('Tile', tileId) || null)
      : null;
    const wall = wallId
      ? (scene?.walls?.get?.(wallId) || scene?.getEmbeddedDocument?.('Wall', wallId) || null)
      : null;
    if (!tile?.uuid || normalizeIdentity(tile.uuid) !== ownerUuid || !wall?.uuid) {
      return {
        allowed: false,
        reason: 'The owning Path or generated Wall is unavailable.',
        ownerUuid,
        tileId
      };
    }
    const pathWall = wall.getFlag?.(MODULE_ID, 'pathWall')
      || wall?.flags?.[MODULE_ID]?.pathWall
      || wall?._source?.flags?.[MODULE_ID]?.pathWall
      || null;
    const flagRecords = readPathFlagRecords(tile);
    const eligibility = evaluatePathGeneratedWallIndependence({
      tileId,
      wallId,
      pathWall,
      pathV2: flagRecords.single,
      pathsV2: flagRecords.merged
    });
    if (!eligibility.allowed) {
      return {
        allowed: false,
        reason: eligibility.reason,
        ownerUuid,
        tileId
      };
    }
    return {
      allowed: true,
      reason: null,
      ownerUuid,
      tileId,
      dependentUuid,
      wallId,
      tile,
      wall,
      relationship,
      flagRecord: flagRecords.records.find((record) => (
        record.kind === eligibility.flagKind && record.index === eligibility.flagIndex
      )),
      singleFlag: flagRecords.single,
      mergedFlag: flagRecords.merged
    };
  }

  getMakeIndependentEligibility(options = {}) {
    const plan = this._resolveMakeIndependentPlan(options);
    return {
      allowed: plan.allowed,
      reason: plan.reason,
      ownerUuid: plan.ownerUuid,
      tileId: plan.tileId
    };
  }

  async makeIndependent({ scene, user, wallUuid } = {}) {
    const plan = this._resolveMakeIndependentPlan({ scene, wallUuid });
    if (!plan.allowed) throw new Error(plan.reason);
    const originalSingleFlag = clone(plan.singleFlag);
    const originalMergedFlag = clone(plan.mergedFlag);
    const originalWallFlag = clone(plan.wall.getFlag?.(MODULE_ID, 'pathWall'));
    const nextFoundryWalls = { enabled: false };
    let tileUpdate;
    let tileRollback;
    if (plan.flagRecord.kind === 'single') {
      const nextSingleFlag = clone(plan.singleFlag);
      nextSingleFlag.foundryWalls = nextFoundryWalls;
      tileUpdate = { [`flags.${MODULE_ID}.pathV2`]: nextSingleFlag };
      tileRollback = { [`flags.${MODULE_ID}.pathV2`]: originalSingleFlag };
    } else {
      const nextMergedFlag = clone(plan.mergedFlag);
      nextMergedFlag.paths[plan.flagRecord.index].foundryWalls = nextFoundryWalls;
      tileUpdate = { [`flags.${MODULE_ID}.pathsV2`]: nextMergedFlag };
      tileRollback = { [`flags.${MODULE_ID}.pathsV2`]: originalMergedFlag };
    }

    let tileUpdated = false;
    let wallUpdated = false;
    try {
      await plan.tile.update(tileUpdate, {
        diff: false,
        faNexusPathGeneratedWallOwnership: true
      });
      tileUpdated = true;
      await plan.wall.update({
        [`flags.${MODULE_ID}.-=pathWall`]: null
      }, {
        faNexusPathGeneratedWallOwnership: true
      });
      wallUpdated = true;
      if (collectManagedPathWallIds(plan.tile).includes(plan.wallId)) {
        throw new Error(`Owning Path Tile ${plan.tileId} still records Wall ${plan.wallId} as managed.`);
      }
      if (plan.wall.getFlag?.(MODULE_ID, 'pathWall') != null) {
        throw new Error(`Wall ${plan.wallId} still carries Path management metadata.`);
      }
      return await this._workflowFactory().execute({
        scene,
        user,
        action: {
          type: 'make-generated-independent',
          dependentUuid: plan.dependentUuid,
          expectedGenerator: 'path-v2'
        }
      });
    } catch (error) {
      const rollbackErrors = [];
      if (wallUpdated && originalWallFlag != null) {
        try {
          await plan.wall.update({
            [`flags.${MODULE_ID}.pathWall`]: clone(originalWallFlag)
          }, {
            faNexusPathGeneratedWallOwnership: true,
            faNexusPathGeneratedWallRollback: true
          });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (tileUpdated) {
        try {
          await plan.tile.update(tileRollback, {
            diff: false,
            faNexusPathGeneratedWallOwnership: true,
            faNexusPathGeneratedWallRollback: true
          });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Make Independent failed and rollback left residue: ${rollbackErrors.map((entry) => entry?.message || entry).join('; ')}`
        );
      }
      throw error;
    }
  }
}

export default PathGeneratedWallOwnership;
