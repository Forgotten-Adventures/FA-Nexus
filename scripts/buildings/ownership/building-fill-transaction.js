// One shared planned-vs-live rule for the whole Commit path; see building-fill-document-operations.js.
import { matchesOwnedProjection } from './building-fill-document-operations.js';

class BuildingFillTransactionError extends Error {
  constructor(code, phase, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'BuildingFillTransactionError';
    this.code = String(code || 'BUILDING_EDIT_FAILED');
    this.phase = String(phase || 'unknown');
    this.identities = Array.isArray(details.identities) ? [...details.identities] : [];
    if (Array.isArray(details.fields)) this.fields = [...details.fields];
    if (Array.isArray(details.residue)) this.residue = structuredClone(details.residue);
    if (details.recovery) this.recovery = String(details.recovery);
    if (details.rollback) this.rollback = String(details.rollback);
    if (details.reference) this.reference = structuredClone(details.reference);
  }
}


function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function valueAtPath(source, path) {
  return String(path || '').split('.').reduce((value, key) => value?.[key], source);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function fingerprint(value) {
  return JSON.stringify(canonicalValue(value));
}

// An owned path is verified by raw equality unless the operation declares that Foundry augments the
// live value at that path from its own document schema, in which case the authored projection is
// what the Building owns and what must match.
function ownedValueMatches(operation, source, path, expected) {
  const live = valueAtPath(source, path);
  if ((operation.normalizedValuePaths || []).includes(path)) return matchesOwnedProjection(live, expected);
  return fingerprint(live) === fingerprint(expected);
}

function operationMatches(operation, record, side) {
  if (operation.kind === 'replace-registry') {
    const expected = side === 'before' ? operation.beforeRegistry : operation.afterRegistry;
    return fingerprint(record) === fingerprint(expected ?? null);
  }
  if (operation.kind === 'create-document' && side === 'before') return record == null;
  if (operation.kind === 'delete-document') {
    if (side === 'after') return record == null;
    return fingerprint(record?.source ?? null) === fingerprint(operation.beforeSource ?? null);
  }
  const values = side === 'before' ? operation.beforeValues : operation.afterValues;
  if (!record?.source || !values || typeof values !== 'object') return false;
  return Object.entries(values).every(([path, expected]) => (
    ownedValueMatches(operation, record.source, path, expected)
  ));
}

function operationDifferences(operation, record, side) {
  const values = side === 'before' ? operation.beforeValues : operation.afterValues;
  if (!values || !record?.source) return [];
  return Object.entries(values)
    .filter(([path, expected]) => !ownedValueMatches(operation, record.source, path, expected))
    .map(([path]) => path);
}

async function readOperation(scene, reference, operation) {
  if (operation.kind === 'replace-registry') return scene.readRegistry({ sceneId: reference.sceneId });
  return scene.readDocument({ sceneId: reference.sceneId, documentName: operation.documentName, id: operation.id });
}

async function applyOperation(scene, reference, operation) {
  if (operation.kind === 'create-document') {
    return scene.createDocument({ documentName: operation.documentName, source: clone(operation.source), reason: operation.reason });
  }
  if (operation.kind === 'delete-document') {
    const live = await readOperation(scene, reference, operation);
    if (!operationMatches(operation, live, 'before')) {
      throw new BuildingFillTransactionError(
        'BUILDING_COMMIT_PRECONDITION_FAILED',
        'commit',
        `Building presentation changed before ${operation.documentName}.${operation.id} could be retired.`,
        { identities: [operation.uuid], fields: ['document-source'] }
      );
    }
    return scene.deleteDocument({ documentName: operation.documentName, id: operation.id, reason: operation.reason });
  }
  if (operation.kind === 'replace-registry') {
    const live = await scene.readRegistry({ sceneId: reference.sceneId });
    if (!operationMatches(operation, live, 'before')) {
      throw new BuildingFillTransactionError(
        'BUILDING_COMMIT_PRECONDITION_FAILED',
        'commit',
        'Building composition changed before ownership could be committed.',
        { identities: [reference.sceneId], fields: ['flags.fa-nexus.compositionRegistry'] }
      );
    }
    return scene.replaceRegistry({ sceneId: reference.sceneId, registry: clone(operation.afterRegistry), reason: operation.reason });
  }
  const live = await readOperation(scene, reference, operation);
  if (!operationMatches(operation, live, 'before')) {
    const fields = operationDifferences(operation, live, 'before');
    throw new BuildingFillTransactionError(
      'BUILDING_COMMIT_PRECONDITION_FAILED',
      'commit',
      `Building-owned fields changed before ${operation.documentName}.${operation.id} could be committed${fields.length ? ` (${fields.join(', ')})` : ''}.`,
      { identities: [operation.uuid], fields }
    );
  }
  // A patch with nothing in it is not a write. Issuing one anyway asks Foundry to update a document
  // to the state it is already in, which returns no document at all and is indistinguishable from a
  // rejected write. The precondition above already proved the live document matches, so the
  // operation is satisfied by the document that is already there.
  if (!Object.keys(clone(operation.afterPatch) || {}).length) return live;
  return scene.updateDocumentPatch({
    documentName: operation.documentName,
    id: operation.id,
    changes: clone(operation.afterPatch),
    reason: operation.reason
  });
}

async function rollbackOperation(scene, reference, operation) {
  if (operation.kind === 'create-document') {
    let live = null;
    try {
      live = await readOperation(scene, reference, operation);
    } catch (_readError) {
      // The server-side compensating delete below is the authoritative outcome check.
    }
    if (!operationMatches(operation, live, 'after')) {
      if (live) {
        const differences = operationDifferences(operation, live, 'after');
        throw new Error(`Refusing to delete ${operation.documentName}.${operation.id} because it does not match the attempted Building creation${differences.length ? ` (${differences.join(', ')})` : ''}.`);
      }
    }
    return scene.deleteDocument({ documentName: operation.documentName, id: operation.id, reason: 'building-edit-rollback' });
  }
  if (operation.kind === 'delete-document') {
    const beforeRollback = await readOperation(scene, reference, operation);
    if (operationMatches(operation, beforeRollback, 'before')) return beforeRollback;
    if (beforeRollback) {
      throw new Error(`Refusing to restore ${operation.documentName}.${operation.id} because another document now owns that identity.`);
    }
    try {
      return await scene.createDocument({
        documentName: operation.documentName,
        source: clone(operation.beforeSource),
        reason: 'building-edit-rollback'
      });
    } catch (error) {
      const live = await readOperation(scene, reference, operation);
      if (operationMatches(operation, live, 'before')) return live;
      throw new Error(
        `Could not restore ${operation.documentName}.${operation.id} at the server boundary: ${String(error?.message || error)}`,
        { cause: error }
      );
    }
  }
  if (operation.kind === 'replace-registry') {
    const live = await readOperation(scene, reference, operation);
    if (operationMatches(operation, live, 'before')) return live;
    if (!operationMatches(operation, live, 'after')) {
      throw new Error('Refusing to restore the Building composition registry because it changed after the attempted Building Commit.');
    }
    return scene.replaceRegistry({ sceneId: reference.sceneId, registry: clone(operation.beforeRegistry), reason: 'building-edit-rollback' });
  }
  const live = await readOperation(scene, reference, operation);
  if (operationMatches(operation, live, 'before')) return live;
  if (!operationMatches(operation, live, 'after')) {
    const fields = operationDifferences(operation, live, 'after');
    throw new Error(
      `Refusing to restore ${operation.documentName}.${operation.id} because its Building-owned fields changed after the attempted Commit${fields.length ? ` (${fields.join(', ')})` : ''}.`
    );
  }
  try {
    return await scene.updateDocumentPatch({
      documentName: operation.documentName,
      id: operation.id,
      changes: clone(operation.beforePatch),
      reason: 'building-edit-rollback'
    });
  } catch (error) {
    const restored = await readOperation(scene, reference, operation);
    if (operationMatches(operation, restored, 'before')) return restored;
    throw error;
  }
}

export async function applyBuildingFillOperations({ scene, reference, operations } = {}) {
  if (!scene?.updateDocumentPatch || !scene?.readDocument) {
    throw new TypeError('Building commit transaction requires patch and read Scene operations.');
  }
  const applied = [];
  try {
    for (const operation of operations || []) {
      if (operation.kind === 'create-document') applied.push(operation);
      try {
        await applyOperation(scene, reference, operation);
        if (operation.kind === 'replace-registry') applied.push(operation);
        if (operation.kind === 'patch-document') applied.push(operation);
        if (operation.kind === 'delete-document') {
          const live = await readOperation(scene, reference, operation);
          if (!operationMatches(operation, live, 'after')) {
            throw new BuildingFillTransactionError(
              'BUILDING_COMMIT_VERIFY_FAILED',
              'commit',
              `Building Edit could not verify ${operation.documentName}.${operation.id} was retired.`,
              { identities: [operation.uuid] }
            );
          }
          applied.push(operation);
        }
      } catch (error) {
        if (operation.kind === 'replace-registry'
          && error?.code !== 'BUILDING_COMMIT_PRECONDITION_FAILED') {
          try {
            const live = await readOperation(scene, reference, operation);
            if (operationMatches(operation, live, 'after')) applied.push(operation);
          } catch (_auditError) {
            // The replacement outcome is unknown, so rollback must account for it.
            applied.push(operation);
          }
        }
        if (operation.kind === 'delete-document'
          && error?.code !== 'BUILDING_COMMIT_PRECONDITION_FAILED'
          && !applied.includes(operation)) {
          try {
            const live = await readOperation(scene, reference, operation);
            if (operationMatches(operation, live, 'after')) applied.push(operation);
            else if (!operationMatches(operation, live, 'before')) applied.push(operation);
          } catch (_auditError) {
            // The delete outcome is unknown, so rollback must account for it and surface any residue.
            applied.push(operation);
          }
        }
        if (operation.kind === 'patch-document'
          && error?.code !== 'BUILDING_COMMIT_PRECONDITION_FAILED'
          && !applied.includes(operation)) {
          try {
            const live = await readOperation(scene, reference, operation);
            if (operationMatches(operation, live, 'after')) applied.push(operation);
            else if (!operationMatches(operation, live, 'before')) applied.push(operation);
          } catch (_auditError) {
            // The patch outcome is unknown, so rollback must account for it and surface any residue.
            applied.push(operation);
          }
        }
        throw error;
      }
    }
    for (const operation of operations || []) {
      const live = await readOperation(scene, reference, operation);
      // A planned create that produced NO document is named as such rather than reported as a
      // generic field mismatch: a Commit that reports success while its replacement does not exist
      // destroys whatever that replacement superseded.
      if (operation.kind === 'create-document' && !live?.source) {
        throw new BuildingFillTransactionError(
          'BUILDING_COMMIT_VERIFY_FAILED',
          'commit',
          `Building Edit planned ${operation.documentName}.${operation.id} (${operation.reason}) but no such document exists after Commit.`,
          { identities: [operation.uuid] }
        );
      }
      if (!operationMatches(operation, live, 'after')) {
        const fields = operationDifferences(operation, live, 'after');
        throw new BuildingFillTransactionError(
          'BUILDING_COMMIT_VERIFY_FAILED',
          'commit',
          `Building Edit could not verify ${operation.documentName}.${operation.id} after Commit${fields.length ? ` (${fields.join(', ')})` : ''}.`,
          { identities: [operation.uuid], fields }
        );
      }
    }
    return { kind: 'committed', writeCount: (operations || []).length };
  } catch (cause) {
    const rollbackErrors = new Map();
    for (const operation of [...applied].reverse()) {
      try {
        await rollbackOperation(scene, reference, operation);
      } catch (error) {
        rollbackErrors.set(`${operation.documentName}:${operation.id}`, String(error?.message || error));
      }
    }
    const residue = [];
    for (const operation of applied) {
      const rollbackError = rollbackErrors.get(`${operation.documentName}:${operation.id}`) || null;
      try {
        const live = await readOperation(scene, reference, operation);
        if (!operationMatches(operation, live, 'before')) {
          residue.push({
            documentName: operation.documentName,
            id: operation.id,
            difference: operation.kind === 'create-document'
              ? 'created-document-remained'
              : (operation.kind === 'delete-document'
                ? (live ? 'deleted-document-source-mismatch' : 'deleted-document-remained-absent')
                : (live ? 'owned-field-mismatch' : 'missing-document')),
            ...(rollbackError ? { rollbackError } : {})
          });
        }
      } catch (error) {
        residue.push({
          documentName: operation.documentName,
          id: operation.id,
          difference: `verification-failed:${String(error?.message || error)}`,
          ...(rollbackError ? { rollbackError } : {})
        });
      }
    }
    if (residue.length) {
      throw new BuildingFillTransactionError(
        'BUILDING_ROLLBACK_INCOMPLETE',
        'rollback',
        'Building Edit Commit failed and owned-field rollback could not be verified.',
        {
          reference,
          residue,
          rollback: 'incomplete',
          recovery: 'Inspect the listed Building-owned fields, then restore or recommit from a known-good snapshot.'
        },
        { cause }
      );
    }
    throw new BuildingFillTransactionError(
      'BUILDING_COMMIT_APPLY_FAILED',
      'commit',
      `Building Edit Commit failed and its owned fields were restored: ${String(cause?.message || cause)}`,
      { reference, rollback: 'complete' },
      { cause }
    );
  }
}

export default applyBuildingFillOperations;
