/**
 * Shared catalog pipeline helpers for browser tabs that blend local and cloud inventory.
 */

/**
 * Construct a standard abort error for tab-driven async work.
 * @returns {DOMException}
 */
export function abortError() {
  return new DOMException('Operation aborted', 'AbortError');
}

/**
 * Detect standard abort failures across browser and Foundry contexts.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAbortError(error) {
  return error?.name === 'AbortError';
}

/**
 * Format progress text with optional count and total values.
 * @param {string} [label]
 * @param {number|null} [count]
 * @param {number|null} [total]
 * @param {string} [fallbackLabel]
 * @returns {string}
 */
export function formatCatalogLoaderText(label, count, total, fallbackLabel = 'Loading...') {
  const safeLabel = String(label || '').trim() || fallbackLabel;
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.max(0, Math.floor(total)) : null;
  const safeCount = Number.isFinite(count) && count >= 0 ? Math.max(0, Math.floor(count)) : null;

  if (safeTotal == null) return safeLabel;
  if (safeCount != null && safeCount > 0) return `${safeLabel} (${safeCount} / ${safeTotal})`;
  return `${safeLabel} (${safeTotal})`;
}

/**
 * Shared control flow for fetching cloud records and merging them into a local catalog.
 * `fetchCloud` must return `{ items, error, partial }`.
 * `mergeItems` must return the final merged array.
 * @param {object} options
 * @param {boolean} [options.cloudEnabled=true]
 * @param {Array<object>} [options.localItems=[]]
 * @param {AbortSignal|null} [options.signal=null]
 * @param {Function} options.fetchCloud
 * @param {Function} options.mergeItems
 * @param {Function} [options.onCloudItems]
 * @param {Function} [options.onCloudError]
 * @param {Function} [options.onResult]
 * @param {Function} [options.onTotal]
 * @returns {Promise<{items:Array<object>, error:string|null, partial:boolean}>}
 */
export async function loadAndMergeCloudRecords({
  cloudEnabled = true,
  localItems = [],
  signal = null,
  fetchCloud,
  mergeItems,
  onCloudItems,
  onCloudError,
  onResult,
  onTotal
} = {}) {
  if (typeof fetchCloud !== 'function') throw new Error('fetchCloud callback required');
  if (typeof mergeItems !== 'function') throw new Error('mergeItems callback required');

  const safeLocal = Array.isArray(localItems) ? localItems.slice() : [];
  if (!cloudEnabled) {
    const result = { items: safeLocal, error: null, partial: false };
    try { onResult?.(result, { localItems: safeLocal, cloudItems: [] }); } catch (_) {}
    return result;
  }
  if (signal?.aborted) throw abortError();

  let cloudItems = [];
  let cloudError = null;
  let partial = false;

  try {
    const cloudResult = await fetchCloud({ signal });
    cloudItems = Array.isArray(cloudResult?.items) ? cloudResult.items : [];
    cloudError = cloudResult?.error ? String(cloudResult.error) : null;
    partial = !!cloudResult?.partial;
    try { onTotal?.(cloudItems.length); } catch (_) {}
    try { onCloudItems?.(cloudItems, cloudResult); } catch (_) {}
  } catch (error) {
    if (isAbortError(error)) throw error;
    cloudError = String(error?.message || error);
    partial = false;
    try { onCloudError?.(cloudError, error); } catch (_) {}
  }

  if (signal?.aborted) throw abortError();
  if (cloudError && !partial && safeLocal.length) partial = true;
  if (cloudError && !partial && !safeLocal.length) {
    const result = { items: [], error: cloudError, partial: false };
    try { onResult?.(result, { localItems: safeLocal, cloudItems }); } catch (_) {}
    return result;
  }

  const merged = await mergeItems({
    localItems: safeLocal,
    cloudItems,
    cloudError,
    partial,
    signal
  });
  const result = {
    items: Array.isArray(merged) ? merged : [],
    error: cloudError,
    partial
  };
  try { onResult?.(result, { localItems: safeLocal, cloudItems }); } catch (_) {}
  return result;
}
