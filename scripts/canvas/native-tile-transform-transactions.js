const ACTIVE_TRANSACTIONS = new Map();
const RESERVED_TRANSACTIONS = new Map();

export const NATIVE_TILE_TRANSFORM_BUSY = 'NATIVE_TILE_TRANSFORM_BUSY';

function transactionKey(target) {
  const document = target?.document || target || null;
  const sceneId = String(document?.parent?.id || '').trim();
  const tileId = String(document?.id || '').trim();
  if (!sceneId || !tileId) {
    throw new Error('Native Tile transform transactions require scene and Tile ids.');
  }
  return `${sceneId}:${tileId}`;
}

export function trackNativeTileTransformTransaction(document, transaction, {
  family = 'unknown',
  reservationToken = null
} = {}) {
  if (!transaction || typeof transaction.then !== 'function') {
    throw new Error('Native Tile transform transactions require a Promise.');
  }
  const key = transactionKey(document);
  const entry = {
    family: String(family || 'unknown'),
    promise: Promise.resolve(transaction)
  };
  const active = ACTIVE_TRANSACTIONS.get(key) || new Set();
  active.add(entry);
  ACTIVE_TRANSACTIONS.set(key, active);
  if (reservationToken) {
    releaseNativeTileTransformReservation(document, reservationToken, {
      transaction: entry.promise
    });
  }

  const cleanup = () => {
    active.delete(entry);
    if (!active.size && ACTIVE_TRANSACTIONS.get(key) === active) {
      ACTIVE_TRANSACTIONS.delete(key);
    }
  };
  entry.promise.then(cleanup, cleanup);
  // The caller owns reporting the failure; this prevents an unobserved rejection
  // while preserving the rejecting Promise for explicit waiters.
  void entry.promise.catch(() => {});
  return entry.promise;
}

export function reserveNativeTileTransformTransaction(document, token, {
  family = 'unknown'
} = {}) {
  const key = transactionKey(document);
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) {
    throw new Error('Native Tile transform reservations require a token.');
  }
  if (ACTIVE_TRANSACTIONS.get(key)?.size || RESERVED_TRANSACTIONS.get(key)?.size) {
    // A refusal, not a fault: on a slow host the previous change of this Tile can still be saving.
    throw Object.assign(new Error(
      `Native ${String(family || 'unknown')} Tile transform is still committing linked documents; try again when it finishes.`
    ), { userRefusal: true, code: NATIVE_TILE_TRANSFORM_BUSY });
  }
  let resolveReservation;
  let rejectReservation;
  const promise = new Promise((resolve, reject) => {
    resolveReservation = resolve;
    rejectReservation = reject;
  });
  void promise.catch(() => {});
  RESERVED_TRANSACTIONS.set(key, new Map([[
    normalizedToken,
    {
      family: String(family || 'unknown'),
      promise,
      resolve: resolveReservation,
      reject: rejectReservation
    }
  ]]));
  return normalizedToken;
}

export function rejectNativeTileTransformReservation(document, token, error) {
  const key = transactionKey(document);
  const normalizedToken = String(token || '').trim();
  const reservations = RESERVED_TRANSACTIONS.get(key);
  const reservation = normalizedToken ? reservations?.get(normalizedToken) : null;
  if (!reservation) return false;
  reservations.delete(normalizedToken);
  if (!reservations.size) RESERVED_TRANSACTIONS.delete(key);
  const failure = error instanceof Error
    ? error
    : new Error(String(error || 'Native Tile transform reservation failed.'));
  reservation.reject(failure);
  return true;
}

export function releaseNativeTileTransformReservation(document, token, {
  transaction = null
} = {}) {
  const key = transactionKey(document);
  const normalizedToken = String(token || '').trim();
  const reservations = RESERVED_TRANSACTIONS.get(key);
  const reservation = normalizedToken ? reservations?.get(normalizedToken) : null;
  if (!reservation) return false;
  reservations.delete(normalizedToken);
  if (!reservations.size) RESERVED_TRANSACTIONS.delete(key);
  // Promise resolution adopts the active transaction. A waiter which observed
  // only the reservation therefore still receives an immediate success or
  // failure even if the active entry settles and cleans itself up first.
  reservation.resolve(transaction || undefined);
  return true;
}

/** True while a change of this Tile is reserved or still writing its linked documents. */
export function hasPendingNativeTileTransformTransaction(document) {
  const key = transactionKey(document);
  return !!(ACTIVE_TRANSACTIONS.get(key)?.size || RESERVED_TRANSACTIONS.get(key)?.size);
}

export async function waitForNativeTileTransformTransactions(document) {
  const key = transactionKey(document);
  let settledCount = 0;
  while (true) {
    const active = ACTIVE_TRANSACTIONS.get(key);
    const reservations = RESERVED_TRANSACTIONS.get(key);
    if (!active?.size && !reservations?.size) return { key, settledCount };
    const activeBatch = Array.from(active || [], (entry) => entry.promise);
    const reservationBatch = Array.from(reservations?.values() || [], (entry) => entry.promise);
    const batch = [...activeBatch, ...reservationBatch];
    settledCount += activeBatch.length;
    const results = await Promise.allSettled(batch);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

export function waitForSceneNativeTileTransformTransactions(scene) {
  const prefix = `${scene?.id}:`;
  const keys = [...new Set([...ACTIVE_TRANSACTIONS.keys(), ...RESERVED_TRANSACTIONS.keys()])]
    .filter(key => key.startsWith(prefix));
  if (!keys.length) return null;
  return Promise.all(keys.map(key => waitForNativeTileTransformTransactions({parent:scene,id:key.slice(prefix.length)})));
}

export function getNativeTileTransformTransactionDiagnostics() {
  const tiles = Array.from(ACTIVE_TRANSACTIONS, ([key, entries]) => ({
    key,
    count: entries.size,
    families: [...new Set(Array.from(entries, (entry) => entry.family))].sort()
  })).sort((left, right) => left.key.localeCompare(right.key));
  const reservations = Array.from(RESERVED_TRANSACTIONS, ([key, entries]) => ({
    key,
    count: entries.size,
    families: [...new Set(Array.from(entries.values(), (entry) => entry.family))].sort()
  })).sort((left, right) => left.key.localeCompare(right.key));
  return {
    activeTransactionCount: tiles.reduce((count, tile) => count + tile.count, 0),
    reservedTransactionCount: reservations.reduce((count, entry) => count + entry.count, 0),
    tiles,
    reservations
  };
}
