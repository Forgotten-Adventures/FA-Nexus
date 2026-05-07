const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:$/;

function splitPrefixedPath(value, { allowHttp = false } = {}) {
  const raw = String(value ?? '');
  const match = raw.match(/^([a-z0-9+.-]+:)(.*)$/i);
  if (!match) {
    return {
      prefix: '',
      remainder: raw,
      isWindowsDrive: false
    };
  }
  const prefix = String(match[1] || '');
  if (!allowHttp && /^https?:$/i.test(prefix)) {
    return {
      prefix: '',
      remainder: raw,
      isWindowsDrive: false
    };
  }
  return {
    prefix,
    remainder: String(match[2] || ''),
    isWindowsDrive: WINDOWS_DRIVE_PATTERN.test(prefix)
  };
}

export function stripPathQueryAndHash(value) {
  return String(value ?? '').split(/[?#]/, 1)[0] || '';
}

export function safeDecodePath(value) {
  if (typeof value !== 'string') return value;
  try {
    return decodeURI(value);
  } catch (_) {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return value;
    }
  }
}

function safeEncodePath(value) {
  if (typeof value !== 'string') return value;
  try {
    return encodeURI(value);
  } catch (_) {
    try {
      return encodeURIComponent(value);
    } catch (_) {
      return value;
    }
  }
}

function normalizeKnownStoragePrefixRemainder(prefix, remainder, {
  canonicalizeS3Bucket = false
} = {}) {
  if (!prefix || !remainder) return remainder;
  if (!canonicalizeS3Bucket || !/^s3:$/i.test(prefix)) return remainder;

  const hasLeadingSlash = remainder.startsWith('/');
  const clean = remainder.replace(/^\/+/, '');
  if (!clean) return remainder;

  const [bucket, ...restParts] = clean.split('/');
  if (!bucket) return remainder;
  const next = [bucket.toLowerCase(), ...restParts].join('/');
  return hasLeadingSlash ? `/${next}` : next;
}

export function normalizeStoragePath(value, {
  allowHttp = false,
  canonicalizeS3Bucket = false,
  collapseSeparators = true,
  decode = false,
  lowerCasePrefix = false,
  lowerCaseWindowsDrive = true,
  lowerCaseWindowsPath = false,
  stripQuery = false,
  trimLeading = false,
  trimTrailing = true
} = {}) {
  let raw = String(value ?? '').trim();
  if (!raw) return '';
  if (stripQuery) raw = stripPathQueryAndHash(raw);
  if (trimLeading) raw = raw.replace(/^\/+/, '');
  if (decode) {
    for (let i = 0; i < 3; i += 1) {
      const next = safeDecodePath(raw);
      if (!next || next === raw) break;
      raw = next;
    }
  }

  const parts = splitPrefixedPath(raw, { allowHttp });
  let prefix = parts.prefix;
  let remainder = parts.remainder.replace(/\\/g, '/');
  if (collapseSeparators) remainder = remainder.replace(/\/+/g, '/');
  if (trimLeading) remainder = remainder.replace(/^\/+/, '');
  if (trimTrailing && remainder.length > 1) remainder = remainder.replace(/\/+$/, '');
  if (lowerCasePrefix && prefix && !/^https?:$/i.test(prefix)) prefix = prefix.toLowerCase();
  remainder = normalizeKnownStoragePrefixRemainder(prefix, remainder, { canonicalizeS3Bucket });
  if (parts.isWindowsDrive && lowerCaseWindowsPath) remainder = remainder.toLowerCase();
  if (parts.isWindowsDrive && lowerCaseWindowsDrive) prefix = prefix.toLowerCase();
  return prefix ? `${prefix}${remainder}` : remainder;
}

export function normalizeFolderPath(value, options = {}) {
  return normalizeStoragePath(value, {
    decode: true,
    stripQuery: true,
    trimLeading: true,
    trimTrailing: true,
    collapseSeparators: true,
    lowerCasePrefix: true,
    canonicalizeS3Bucket: true,
    ...options
  });
}

export function normalizePathLower(value, options = {}) {
  const normalized = normalizeFolderPath(value, options);
  return normalized ? normalized.toLowerCase() : '';
}

export function normalizeContentSourcePath(value, options = {}) {
  return normalizeStoragePath(value, {
    decode: true,
    stripQuery: true,
    trimLeading: true,
    trimTrailing: true,
    collapseSeparators: true,
    lowerCasePrefix: true,
    canonicalizeS3Bucket: true,
    lowerCaseWindowsDrive: true,
    lowerCaseWindowsPath: true,
    ...options
  });
}

export function encodeNormalizedPathKey(value, {
  normalizePath = normalizeContentSourcePath,
  lowerCase = false
} = {}) {
  const normalized = normalizePath(value);
  if (!normalized) return '';
  return encodeURIComponent(lowerCase ? normalized.toLowerCase() : normalized);
}

export function sanitizeStorageTargetPath(value) {
  return normalizeStoragePath(value, {
    stripQuery: true,
    decode: true,
    trimLeading: true,
    trimTrailing: true,
    collapseSeparators: true
  });
}

export function normalizeRelativeStoragePath(value, options = {}) {
  let raw = String(value ?? '').trim();
  if (!raw) return '';
  raw = stripPathQueryAndHash(raw);
  if (/^https?:\/\//i.test(raw)) {
    try {
      raw = String(new URL(raw).pathname || '');
    } catch (_) {}
  }
  let normalized = normalizeStoragePath(raw, {
    decode: true,
    trimLeading: true,
    trimTrailing: true,
    collapseSeparators: true,
    lowerCasePrefix: true,
    canonicalizeS3Bucket: true,
    ...options
  });
  if (!normalized) return '';
  const parts = splitPrefixedPath(normalized);
  if (parts.prefix && !parts.isWindowsDrive) {
    normalized = String(parts.remainder || '').replace(/^\/+/, '');
  }
  const cleanSegments = [];
  for (const segment of String(normalized || '').split('/')) {
    const trimmed = String(segment || '').trim();
    if (!trimmed || trimmed === '.' || trimmed === '..') continue;
    cleanSegments.push(trimmed);
  }
  return cleanSegments.join('/');
}

export function generateNormalizedPathLookupKeys(value, {
  normalizePath = normalizeRelativeStoragePath
} = {}) {
  const keys = new Set();
  const push = (candidate) => {
    const normalized = normalizePath(candidate);
    if (!normalized) return;
    keys.add(normalized.toLowerCase());
  };

  const base = String(value ?? '').trim();
  if (!base) return [];
  push(base);

  let decoded = base;
  for (let i = 0; i < 3; i += 1) {
    const next = safeDecodePath(decoded);
    if (!next || next === decoded) break;
    decoded = next;
    push(decoded);
  }

  let encoded = base;
  for (let i = 0; i < 3; i += 1) {
    const next = safeEncodePath(encoded);
    if (!next || next === encoded) break;
    encoded = next;
    push(encoded);
  }

  return Array.from(keys.values());
}

export function buildTypedPathLookupKey(kind, key, {
  normalizePath = normalizeRelativeStoragePath
} = {}) {
  const normalizedKind = String(kind || '').trim().toLowerCase();
  const normalizedKey = String(normalizePath(key) || '').trim().toLowerCase();
  if (!normalizedKind || !normalizedKey) return '';
  return `${normalizedKind}:${normalizedKey}`;
}

export function appendStoragePath(basePath, segment) {
  const base = String(basePath || '').trim().replace(/\/+$/, '');
  const cleanSegment = String(segment || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!base) return cleanSegment;
  if (!cleanSegment) return base;
  const match = base.match(/^([a-z0-9+.-]+:)(.*)$/i);
  if (match && !/^https?:$/i.test(match[1])) {
    const tail = String(match[2] || '').replace(/^\/+/, '').replace(/\/+$/, '');
    return `${match[1]}${[tail, cleanSegment].filter(Boolean).join('/')}`;
  }
  return `${base}/${cleanSegment}`;
}

function normalizeGeneratedPathSegmentValue(value) {
  return String(value ?? '').trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/[. -]+$/, '');
}

export function sanitizeGeneratedPathSegment(value, fallback = '') {
  const normalized = normalizeGeneratedPathSegmentValue(value);
  if (normalized) return normalized;
  return normalizeGeneratedPathSegmentValue(fallback);
}

export function sanitizeStoragePathSegments(value) {
  const raw = normalizeStoragePath(value, {
    trimLeading: false,
    trimTrailing: true,
    collapseSeparators: true
  });
  if (!raw) return '';
  const { prefix, remainder } = splitPrefixedPath(raw);
  const sanitized = String(remainder || '')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => sanitizeGeneratedPathSegment(segment, segment))
    .filter(Boolean)
    .join('/');
  return prefix ? (sanitized ? `${prefix}${sanitized}` : prefix) : sanitized;
}
