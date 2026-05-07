import { forgeIntegration } from './forge-integration.js';

function identityPath(value) {
  return String(value ?? '').trim();
}

function getHookApi() {
  return globalThis.Hooks || null;
}

function cloneOptions(options) {
  return (options && typeof options === 'object') ? { ...options } : {};
}

function getFilePickerBucket(filePicker) {
  return String(
    filePicker?.source?.bucket
      ?? filePicker?.sources?.s3?.bucket
      ?? filePicker?.options?.bucket
      ?? ''
  ).trim();
}

function normalizeFolderPickerContext(context) {
  if (!context || typeof context !== 'object') {
    return { source: '', target: '', options: {}, fallbacks: [] };
  }
  return {
    source: String(context.source || '').trim(),
    target: String(context.target || '').trim(),
    options: cloneOptions(context.options),
    fallbacks: Array.isArray(context.fallbacks)
      ? context.fallbacks.map((value) => String(value || '').trim()).filter(Boolean)
      : []
  };
}

function attachForgeRenderHook(filePicker, context) {
  const hookApi = getHookApi();
  if (!hookApi || typeof hookApi.once !== 'function' || !filePicker || context?.source !== 'forgevtt') return;

  const bucketOptions = cloneOptions(context.options);
  filePicker.__faNexusForgeContext = { source: 'forgevtt', options: bucketOptions };

  const handler = (app, html) => {
    if (app !== filePicker) return;
    try { hookApi.off?.('renderFilePicker', handler); } catch (_) {}
    try { app.activeSource = 'forgevtt'; } catch (_) {}

    const root = html && typeof html === 'object' && 'length' in html ? html[0] || null : html;
    if (!root) return;

    try {
      const forgeTab = root.querySelector?.('[data-tab="forgevtt"]');
      if (forgeTab) forgeTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    } catch (_) {}

    setTimeout(() => {
      try {
        const ctx = app.__faNexusForgeContext;
        if (!ctx || ctx.source !== 'forgevtt') return;
        const select = root.querySelector?.('select[name="bucket"]');
        const selectValue = ctx.options?.bucketKey ?? (ctx.options?.bucket !== undefined ? String(ctx.options.bucket) : null);
        if (!select || selectValue === null) return;
        const value = String(selectValue);
        if (select.value === value) return;
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (_) {}
    }, 75);
  };

  hookApi.once('renderFilePicker', handler);
}

export function getFilePickerClass() {
  const FilePickerBase = foundry?.applications?.apps?.FilePicker ?? globalThis.FilePicker;
  return FilePickerBase?.implementation ?? FilePickerBase ?? globalThis.FilePicker ?? null;
}

export async function prepareFolderPickerContext(filePicker, {
  folder = '',
  useCurrentContext = false,
  logger = null,
  loggerTag = 'FolderPicker'
} = {}) {
  if (!filePicker) {
    try { logger?.warn?.(`${loggerTag}.prepare.missingInstance`); } catch (_) {}
    return { source: '', target: '', options: {}, fallbacks: [] };
  }

  try {
    await forgeIntegration.initialize?.();
  } catch (error) {
    try { logger?.debug?.(`${loggerTag}.prepare.initFailed`, error); } catch (_) {}
  }

  try {
    const context = normalizeFolderPickerContext(
      useCurrentContext
        ? forgeIntegration.getFilePickerContext()
        : forgeIntegration.resolveFilePickerContext(folder)
    );
    attachForgeRenderHook(filePicker, context);
    return context;
  } catch (error) {
    try { logger?.debug?.(`${loggerTag}.prepare.contextFailed`, error); } catch (_) {}
    return { source: '', target: '', options: {}, fallbacks: [] };
  }
}

export function buildFolderPickerBrowseAttempts(context, {
  fallbackSource = 'data'
} = {}) {
  const normalized = normalizeFolderPickerContext(context);
  const attempts = [];
  const seen = new Set();

  const push = (source, {
    target = '',
    options = {}
  } = {}) => {
    const normalizedSource = String(source || '').trim();
    if (!normalizedSource) return;
    const normalizedTarget = String(target || '').trim();
    const key = `${normalizedSource}::${normalizedTarget}`;
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({
      source: normalizedSource,
      target: normalizedTarget,
      options: cloneOptions(options)
    });
  };

  push(normalized.source, {
    target: normalized.target,
    options: normalized.options
  });

  for (const fallback of normalized.fallbacks) {
    push(fallback, { target: '', options: {} });
  }

  if (fallbackSource) {
    push(fallbackSource, { target: '', options: {} });
  }

  return attempts;
}

function applyFolderPickerAttempt(filePicker, attempt, baseOptions) {
  const source = String(attempt?.source || '').trim();
  const target = String(attempt?.target || '').trim();
  const options = cloneOptions(attempt?.options);
  if (!source) throw new Error('Missing FilePicker source');

  if (!filePicker.sources || typeof filePicker.sources !== 'object') {
    filePicker.sources = {};
  }

  const existing = (filePicker.sources[source] && typeof filePicker.sources[source] === 'object')
    ? { ...filePicker.sources[source] }
    : {};
  delete existing.bucket;
  delete existing.bucketKey;
  delete existing.buckets;
  existing.target = target || '';
  if (options.bucket !== undefined) existing.bucket = options.bucket;
  if (options.bucketKey !== undefined) existing.bucketKey = options.bucketKey;
  if (options.buckets !== undefined) existing.buckets = options.buckets;

  filePicker.sources[source] = existing;
  filePicker.activeSource = source;
  filePicker.options = { ...baseOptions, ...options };

  return {
    source,
    target,
    options,
    sourceConfig: existing
  };
}

export async function browseFolderPickerWithFallbacks(filePicker, {
  context = null,
  attempts = null,
  fallbackSource = 'data',
  logger = null,
  loggerTag = 'FolderPicker'
} = {}) {
  if (!filePicker) return { opened: false, attempt: null };

  const browseAttempts = Array.isArray(attempts) && attempts.length
    ? attempts
    : buildFolderPickerBrowseAttempts(context, { fallbackSource });
  const baseOptions = cloneOptions(filePicker.options);

  try { logger?.debug?.(`${loggerTag}.browseAttempts`, { attempts: browseAttempts, initialSources: Object.keys(filePicker.sources || {}) }); } catch (_) {}

  for (const attempt of browseAttempts) {
    try {
      const applied = applyFolderPickerAttempt(filePicker, attempt, baseOptions);
      try {
        logger?.debug?.(`${loggerTag}.browseAttempt`, {
          source: applied.source,
          target: applied.target,
          options: filePicker.options,
          sourceConfig: applied.sourceConfig
        });
      } catch (_) {}
      await filePicker.browse(applied.target || undefined, { ...applied.options });
      return { opened: true, attempt: applied };
    } catch (error) {
      try {
        logger?.warn?.(`${loggerTag}.browseFailed`, {
          source: String(attempt?.source || ''),
          target: String(attempt?.target || ''),
          error
        });
      } catch (_) {}
    }
  }

  filePicker.options = baseOptions;
  return { opened: false, attempt: null };
}

export function normalizePickedFolderPath(path, filePicker, {
  normalizePath = identityPath,
  resolveS3Url = false
} = {}) {
  const result = String(path ?? '').trim();
  if (!result) return '';

  const source = String(filePicker?.activeSource || '').trim().toLowerCase();
  const hasPrefix = /^[a-z0-9+.-]+:/i.test(result);
  const clean = result.replace(/^\/+/, '').replace(/\/+$/, '');
  const finish = (value) => {
    const normalized = typeof normalizePath === 'function' ? normalizePath(value) : value;
    return String(normalized ?? '').trim();
  };

  if (!source) return finish(result);
  if (source === 'data') return finish(clean);

  if (source === 's3') {
    if (resolveS3Url && /^https?:\/\//i.test(result)) {
      try {
        const resolved = forgeIntegration.resolveFilePickerContext(result);
        const bucketFromUrl = String(resolved?.options?.bucket || '').trim();
        const targetFromUrl = String(resolved?.target || '').trim();
        if (bucketFromUrl) {
          return finish(targetFromUrl ? `s3:${bucketFromUrl}/${targetFromUrl}` : `s3:${bucketFromUrl}`);
        }
      } catch (_) {}
    }

    const bucket = getFilePickerBucket(filePicker);
    if (bucket) return finish(clean ? `s3:${bucket}/${clean}` : `s3:${bucket}`);
    return finish(clean ? `s3:${clean}` : 's3:');
  }

  if (!hasPrefix) {
    const normalizedSource = source === 'bazaar' ? 'forge-bazaar' : source;
    return finish(clean ? `${normalizedSource}:${clean}` : `${normalizedSource}:`);
  }

  return finish(result);
}
