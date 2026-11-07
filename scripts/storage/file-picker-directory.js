function resolveFilePicker(filePicker) {
  const FilePickerImpl = filePicker || globalThis.foundry?.applications?.apps?.FilePicker?.implementation;
  if (!FilePickerImpl?.browse || !FilePickerImpl?.createDirectory) {
    throw new Error('Foundry FilePicker browse/createDirectory implementation is unavailable');
  }
  return FilePickerImpl;
}

function buildFilePickerOptions(options, cloneOptions) {
  if (!cloneOptions) return options || {};
  return Object.assign({}, options || {});
}

export async function ensureFilePickerDirectory(dir, {
  source = 'data',
  options = {},
  filePicker = null,
  cloneOptions = false,
  onCreate = null
} = {}) {
  const FilePickerImpl = resolveFilePicker(filePicker);
  const targetSource = source || 'data';

  try {
    await FilePickerImpl.browse(targetSource, dir, buildFilePickerOptions(options, cloneOptions));
    return { dir, source: targetSource, created: false };
  } catch (error) {
    if (typeof onCreate === 'function') onCreate({ source: targetSource, dir, error });
    await FilePickerImpl.createDirectory(targetSource, dir, buildFilePickerOptions(options, cloneOptions));
    return { dir, source: targetSource, created: true };
  }
}

export async function ensureNestedFilePickerDirectory(targetDir, {
  source = 'data',
  options = {},
  filePicker = null,
  cloneOptions = false,
  onCreate = null
} = {}) {
  const segments = String(targetDir || '').split('/').filter(Boolean);
  const results = [];
  let acc = '';

  for (const segment of segments) {
    acc = acc ? `${acc}/${segment}` : segment;
    results.push(await ensureFilePickerDirectory(acc, {
      source,
      options,
      filePicker,
      cloneOptions,
      onCreate
    }));
  }

  return results;
}
