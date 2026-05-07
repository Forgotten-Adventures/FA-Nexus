export const FLATTEN_WEBP_METADATA_CHUNK = 'FANX';
export const FLATTEN_WEBP_METADATA_SCHEMA = 'fa-nexus.flatten.deconstruction.webp';
export const FLATTEN_WEBP_METADATA_VERSION = 1;

const WEBP_SIGNATURE_RIFF = 'RIFF';
const WEBP_SIGNATURE_WEBP = 'WEBP';
const FLATTEN_METADATA_KIND = 'flatten-deconstruction';

function toBytes(buffer, label = 'WebP buffer') {
  if (buffer instanceof Uint8Array) return buffer;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  throw new Error(`${label} is not readable binary data.`);
}

function requireTextEncoder() {
  if (typeof TextEncoder !== 'function') {
    throw new Error('TextEncoder is unavailable; cannot write FA Nexus WebP metadata.');
  }
  return new TextEncoder();
}

function requireTextDecoder() {
  if (typeof TextDecoder !== 'function') {
    throw new Error('TextDecoder is unavailable; cannot read FA Nexus WebP metadata.');
  }
  return new TextDecoder('utf-8', { fatal: true });
}

function readAscii(bytes, offset, length) {
  if ((offset + length) > bytes.length) throw new Error('WebP metadata read exceeded buffer bounds.');
  let value = '';
  for (let i = 0; i < length; i += 1) value += String.fromCharCode(bytes[offset + i]);
  return value;
}

function writeAscii(bytes, offset, value) {
  for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i) & 0xff;
}

function readUint32LE(bytes, offset) {
  if ((offset + 4) > bytes.length) throw new Error('WebP metadata read exceeded buffer bounds.');
  return (bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)) >>> 0;
}

function writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function parseWebPChunks(input) {
  const bytes = toBytes(input);
  if (bytes.length < 12) throw new Error('Unreadable WebP: RIFF header is missing.');
  if (readAscii(bytes, 0, 4) !== WEBP_SIGNATURE_RIFF) {
    throw new Error('Unreadable WebP: RIFF signature is missing.');
  }
  if (readAscii(bytes, 8, 4) !== WEBP_SIGNATURE_WEBP) {
    throw new Error('Unreadable WebP: WEBP signature is missing.');
  }

  const riffSize = readUint32LE(bytes, 4);
  const expectedLength = riffSize + 8;
  if (expectedLength !== bytes.length) {
    throw new Error(`Unreadable WebP: RIFF size ${riffSize} does not match file length ${bytes.length}.`);
  }

  const chunks = [];
  let offset = 12;
  while (offset < bytes.length) {
    if ((offset + 8) > bytes.length) {
      throw new Error('Unreadable WebP: truncated chunk header.');
    }
    const id = readAscii(bytes, offset, 4);
    const size = readUint32LE(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    const paddedEnd = dataEnd + (size % 2);
    if (dataEnd > bytes.length || paddedEnd > bytes.length) {
      throw new Error(`Unreadable WebP: chunk ${id} exceeds file bounds.`);
    }
    chunks.push({
      id,
      size,
      start: offset,
      dataStart,
      dataEnd,
      paddedEnd,
      bytes: bytes.slice(offset, paddedEnd),
      data: bytes.slice(dataStart, dataEnd)
    });
    offset = paddedEnd;
  }

  return { bytes, chunks };
}

function validateFlattenMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Flatten WebP metadata must be an object.');
  }
  if (Number(metadata.version) !== 1) {
    throw new Error(`Unsupported flatten metadata version: ${metadata.version ?? 'missing'}.`);
  }
  if (!Array.isArray(metadata.tiles) || metadata.tiles.length === 0) {
    throw new Error('Flatten WebP metadata does not contain deconstruction tile data.');
  }
  if (metadata.chunked && (!Array.isArray(metadata.chunks) || metadata.chunks.length === 0)) {
    throw new Error('Chunked flatten WebP metadata does not contain a chunk manifest.');
  }
  return metadata;
}

function buildMetadataEnvelope(metadata) {
  const flattened = validateFlattenMetadata(metadata);
  return {
    schema: FLATTEN_WEBP_METADATA_SCHEMA,
    version: FLATTEN_WEBP_METADATA_VERSION,
    module: 'fa-nexus',
    kind: FLATTEN_METADATA_KIND,
    embeddedAt: Date.now(),
    flattened
  };
}

function validateMetadataEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('Unreadable FA Nexus WebP metadata: envelope is not an object.');
  }
  if (envelope.schema !== FLATTEN_WEBP_METADATA_SCHEMA) {
    throw new Error(`Unsupported FA Nexus WebP metadata schema: ${envelope.schema ?? 'missing'}.`);
  }
  if (Number(envelope.version) !== FLATTEN_WEBP_METADATA_VERSION) {
    throw new Error(`Unsupported FA Nexus WebP metadata version: ${envelope.version ?? 'missing'}.`);
  }
  if (envelope.kind !== FLATTEN_METADATA_KIND) {
    throw new Error(`Unsupported FA Nexus WebP metadata kind: ${envelope.kind ?? 'missing'}.`);
  }
  validateFlattenMetadata(envelope.flattened);
  return envelope;
}

function buildChunk(id, payload) {
  const data = toBytes(payload, `${id} payload`);
  const paddedLength = data.length + (data.length % 2);
  const chunk = new Uint8Array(8 + paddedLength);
  writeAscii(chunk, 0, id);
  writeUint32LE(chunk, 4, data.length);
  chunk.set(data, 8);
  if (paddedLength !== data.length) chunk[chunk.length - 1] = 0;
  return chunk;
}

export function embedFlattenMetadataInWebPBuffer(input, metadata) {
  const { chunks } = parseWebPChunks(input);
  const encoder = requireTextEncoder();
  const payload = encoder.encode(JSON.stringify(buildMetadataEnvelope(metadata)));
  const metadataChunk = buildChunk(FLATTEN_WEBP_METADATA_CHUNK, payload);
  const keptChunks = chunks
    .filter((chunk) => chunk.id !== FLATTEN_WEBP_METADATA_CHUNK)
    .map((chunk) => chunk.bytes);
  keptChunks.push(metadataChunk);

  const chunkBytes = keptChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const riffSize = 4 + chunkBytes;
  if (riffSize > 0xffffffff) {
    throw new Error('Flatten WebP metadata would exceed the RIFF size limit.');
  }

  const output = new Uint8Array(8 + riffSize);
  writeAscii(output, 0, WEBP_SIGNATURE_RIFF);
  writeUint32LE(output, 4, riffSize);
  writeAscii(output, 8, WEBP_SIGNATURE_WEBP);
  let offset = 12;
  for (const chunk of keptChunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export async function embedFlattenMetadataInWebPBlob(blob, metadata) {
  if (!blob || typeof blob.arrayBuffer !== 'function') {
    throw new Error('Flatten WebP metadata cannot be embedded because the WebP blob is unreadable.');
  }
  const output = embedFlattenMetadataInWebPBuffer(await blob.arrayBuffer(), metadata);
  return new Blob([output], { type: 'image/webp' });
}

export function readFlattenMetadataFromWebPBuffer(input) {
  const { chunks } = parseWebPChunks(input);
  const metadataChunks = chunks.filter((chunk) => chunk.id === FLATTEN_WEBP_METADATA_CHUNK);
  if (metadataChunks.length === 0) {
    throw new Error(`Missing FA Nexus flatten metadata chunk (${FLATTEN_WEBP_METADATA_CHUNK}).`);
  }
  if (metadataChunks.length > 1) {
    throw new Error(`Unreadable FA Nexus WebP metadata: found ${metadataChunks.length} metadata chunks.`);
  }

  let envelope = null;
  try {
    const decoder = requireTextDecoder();
    envelope = JSON.parse(decoder.decode(metadataChunks[0].data));
  } catch (error) {
    throw new Error(`Unreadable FA Nexus WebP metadata: ${error?.message || error}`);
  }
  return validateMetadataEnvelope(envelope);
}

export async function readFlattenMetadataFromWebPBlob(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function') {
    throw new Error('Cannot read FA Nexus WebP metadata because the WebP blob is unreadable.');
  }
  return readFlattenMetadataFromWebPBuffer(await blob.arrayBuffer());
}

export async function readFlattenMetadataFromWebPUrl(url, options = {}) {
  const target = String(url || '').trim();
  if (!target) throw new Error('Cannot read FA Nexus WebP metadata without a WebP URL.');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch is unavailable; cannot read FA Nexus WebP metadata.');
  }
  const response = await fetchImpl(target, { cache: options.cache || 'no-store' });
  if (!response?.ok) {
    throw new Error(`Failed to fetch FA Nexus WebP metadata from ${target}: HTTP ${response?.status || 'unknown'}.`);
  }
  return readFlattenMetadataFromWebPBuffer(await response.arrayBuffer());
}
