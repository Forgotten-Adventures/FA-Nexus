import { forgeIntegration } from '../storage/forge-integration.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  requireFilePickerMethod,
  wrapOperationalError
} from './nexus-content-service.js';

const DEFAULT_BATCH_SIZE = 200;
const MIN_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 500;
const DEFAULT_BATCH_YIELD_MS = 8;
const MAX_BATCH_YIELD_MS = 50;

function createAbortError(signal) {
  return new DOMException(signal?.reason || 'Cancelled', 'AbortError');
}

function normalizeSupportedExtensions(supportedExtensions) {
  return new Set(
    Array.from(supportedExtensions || [], (extension) => String(extension || '').trim().toLowerCase())
      .filter(Boolean)
      .map((extension) => extension.startsWith('.') ? extension : `.${extension}`)
  );
}

function optimizeForgeRecord(record) {
  if (!record || !forgeIntegration.isRunningOnForge()) return record;
  if (record.path) record.path = forgeIntegration.optimizeCacheURL(record.path);
  if (record.url) record.url = forgeIntegration.optimizeCacheURL(record.url);
  if (record.cachedLocalPath) {
    record.cachedLocalPath = forgeIntegration.optimizeCacheURL(record.cachedLocalPath);
  }
  return record;
}

/**
 * Traverse one configured local-content root and emit mapped inventory records in batches.
 *
 * Content policy stays explicit at the call site: the adapter provides its kind, supported
 * extensions, and record mapper while this scanner owns FilePicker/Forge traversal,
 * cancellation, batching, and queue behavior.
 *
 * @param {{
 *   folder:string,
 *   contentKind:string,
 *   itemLabel:string,
 *   owner:string,
 *   supportedExtensions:Iterable<string>,
 *   mapRecord:(item:{path:string,url:string,filename:string})=>object,
 *   onBatch?:(records:object[])=>Promise<void>|void,
 *   options?:{batchSize?:number,sleepMs?:number,signal?:AbortSignal|null}
 * }} config
 * @returns {Promise<number>} total records emitted
 */
export async function streamLocalContent({
  folder,
  contentKind,
  itemLabel,
  owner,
  supportedExtensions,
  mapRecord,
  onBatch,
  options = {}
} = {}) {
  if (!folder) return 0;
  if (!contentKind || !itemLabel || !owner) {
    throw new TypeError('Local content scanning requires contentKind, itemLabel, and owner.');
  }
  if (typeof mapRecord !== 'function') {
    throw new TypeError('Local content scanning requires a record mapper.');
  }

  const allowedExtensions = normalizeSupportedExtensions(supportedExtensions);
  if (!allowedExtensions.size) {
    throw new TypeError('Local content scanning requires at least one supported extension.');
  }

  try {
    await forgeIntegration.initialize();
  } catch (error) {
    throw wrapOperationalError(error, {
      code: 'LOCAL_STREAM_INIT_FAILED',
      source: owner,
      operation: `initialize-local-${itemLabel}-stream`,
      folder,
      kind: contentKind,
      userMessage: `FA Nexus could not initialize local ${itemLabel} scanning for "${folder}".`
    });
  }

  const FilePickerImpl = requireFilePickerMethod('browse', {
    source: owner,
    operation: `stream-local-${contentKind}`,
    folder,
    kind: contentKind,
    userMessage: `FA Nexus could not scan "${folder}" because the Foundry FilePicker runtime is unavailable.`
  });
  const {
    source: resolvedSource,
    target: initialTarget,
    options: resolvedOptions,
    fallbacks
  } = forgeIntegration.resolveFilePickerContext(folder);
  const primarySource = resolvedSource || (forgeIntegration.isRunningOnForge() ? 'forgevtt' : 'data');
  const baseOptions = Object.assign({}, resolvedOptions || {});
  const fallbackSources = Array.isArray(fallbacks) ? fallbacks.slice() : [];
  const batchSize = Math.max(
    MIN_BATCH_SIZE,
    Math.min(MAX_BATCH_SIZE, Number(options.batchSize) || DEFAULT_BATCH_SIZE)
  );
  const sleepMs = Math.max(
    0,
    Math.min(MAX_BATCH_YIELD_MS, Number(options.sleepMs) || DEFAULT_BATCH_YIELD_MS)
  );
  const signal = options.signal || null;
  const checkAbort = () => {
    if (signal?.aborted) throw createAbortError(signal);
  };

  const browseAttempts = [{ source: primarySource, options: baseOptions }];
  for (const fallbackSource of fallbackSources) {
    if (!fallbackSource || fallbackSource === primarySource) continue;
    browseAttempts.push({
      source: fallbackSource,
      options: fallbackSource === 'forgevtt' ? baseOptions : {}
    });
  }

  const browseFolder = async (targetPath) => {
    let lastError = null;
    for (let index = 0; index < browseAttempts.length; index += 1) {
      checkAbort();
      const attempt = browseAttempts[index];
      try {
        const browseOptions = Object.keys(attempt.options || {}).length
          ? Object.assign({}, attempt.options)
          : {};
        return await FilePickerImpl.browse(attempt.source, targetPath, browseOptions);
      } catch (error) {
        if (signal?.aborted) throw createAbortError(signal);
        lastError = error;
        const nextAttempt = browseAttempts[index + 1];
        if (nextAttempt) {
          Logger.warn('LocalContentScanner.browse.retry', {
            kind: contentKind,
            folder,
            targetPath,
            failedSource: attempt.source,
            nextSource: nextAttempt.source,
            error: String(error?.message || error)
          });
        }
      }
    }
    throw wrapOperationalError(lastError, {
      code: 'LOCAL_FOLDER_BROWSE_FAILED',
      source: owner,
      operation: `browse-local-${itemLabel}-folder`,
      folder,
      kind: contentKind,
      userMessage: `FA Nexus could not browse the ${itemLabel} folder "${folder}".`,
      details: { targetPath }
    });
  };

  const queue = [forgeIntegration.normalizeFilePickerTarget(primarySource, initialTarget || '')];
  const visited = new Set();
  let batch = [];
  let total = 0;

  while (queue.length) {
    checkAbort();
    const nextTarget = String(queue.shift() ?? '');
    if (visited.has(nextTarget)) continue;
    visited.add(nextTarget);

    let listing;
    try {
      listing = await browseFolder(nextTarget);
    } catch (error) {
      if (signal?.aborted) throw createAbortError(signal);
      throw wrapOperationalError(error, {
        code: 'LOCAL_FOLDER_BROWSE_FAILED',
        source: owner,
        operation: `scan-local-${itemLabel}-folder`,
        folder,
        kind: contentKind,
        userMessage: `FA Nexus could not scan the ${itemLabel} folder "${folder}".`,
        details: { targetPath: nextTarget }
      });
    }

    checkAbort();
    for (const filePath of listing.files) {
      checkAbort();
      const dotIndex = filePath.lastIndexOf('.');
      const extension = dotIndex !== -1 ? filePath.slice(dotIndex).toLowerCase() : '';
      if (!extension || !allowedExtensions.has(extension)) continue;

      const filename = filePath.split('/').pop();
      try {
        const record = mapRecord({ path: filePath, url: filePath, filename });
        batch.push(optimizeForgeRecord(record));
      } catch (error) {
        Logger.warn('LocalContentScanner.record.failed', {
          kind: contentKind,
          folder,
          filePath,
          filename,
          error: String(error?.message || error)
        });
      }

      if (batch.length >= batchSize) {
        const emittedBatch = batch.slice();
        await onBatch?.(emittedBatch);
        total += batch.length;
        batch = [];
        if (sleepMs) {
          await new Promise((resolve) => setTimeout(resolve, sleepMs));
          checkAbort();
        }
      }
    }

    for (const directory of listing.dirs || []) {
      checkAbort();
      queue.push(forgeIntegration.normalizeFilePickerTarget(primarySource, directory));
    }
  }

  if (batch.length) {
    const emittedBatch = batch.slice();
    await onBatch?.(emittedBatch);
    total += batch.length;
  }
  return total;
}
