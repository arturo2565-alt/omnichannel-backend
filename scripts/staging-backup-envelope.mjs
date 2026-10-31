/**
 * Sobre del volcado. AES-256-GCM por archivo, con la clave envuelta en RSA-OAEP.
 * El worker solo recibe la clave pública. La privada no entra en este módulo al cifrar.
 */
import { constants, createPublicKey, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import { beginDumpCipher, decryptDump, INNER_MAGIC } from './staging-backup-crypto.mjs';

const MAGIC = Buffer.from('PGZ2');
const VERSION = 1;
const MAX_WRAPPED = 512;

export function assertPublicOnly(pem) {
  const text = String(pem ?? '');
  if (!text.includes('BEGIN PUBLIC KEY') || text.includes('PRIVATE KEY')) {
    throw new Error('backup ERROR: el worker solo acepta la clave pública.');
  }
  const bits = createPublicKey(text).asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < 2048) {
    throw new Error('backup ERROR: el worker solo acepta la clave pública.');
  }
  return text;
}

export function encodeEnvelopePrefix(wrapped, iv) {
  if (!Buffer.isBuffer(wrapped) || !Buffer.isBuffer(iv) || iv.length !== 12) {
    throw new Error('backup ERROR: el archivo cifrado no es válido.');
  }
  if (wrapped.length !== 256 && wrapped.length !== 384 && wrapped.length !== 512) {
    throw new Error('backup ERROR: el worker solo acepta la clave pública.');
  }
  const prefix = Buffer.alloc(7 + wrapped.length + 4 + 12 + 16);
  MAGIC.copy(prefix, 0);
  prefix[4] = VERSION;
  prefix.writeUInt16BE(wrapped.length, 5);
  wrapped.copy(prefix, 7);
  INNER_MAGIC.copy(prefix, 7 + wrapped.length);
  iv.copy(prefix, 7 + wrapped.length + 4);
  return { prefix, tagOffset: 7 + wrapped.length + 16 };
}

export function sealDump(plain, publicPem) {
  const pem = assertPublicOnly(publicPem);
  const key = randomBytes(32);
  const { cipher, iv } = beginDumpCipher(key);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrapped = publicEncrypt(
    { key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    key,
  );
  key.fill(0);
  const { prefix, tagOffset } = encodeEnvelopePrefix(wrapped, iv);
  tag.copy(prefix, tagOffset);
  return Buffer.concat([prefix, ciphertext]);
}

/** Comprueba el prefijo PGZ2. totalBytes incluye el ciphertext y exige al menos un byte. */
export function assertSealedPrefix(prefix, totalBytes) {
  const buffer = Buffer.isBuffer(prefix) ? prefix : Buffer.from(prefix);
  if (buffer.length < 8 || !buffer.subarray(0, 4).equals(MAGIC) || buffer[4] !== VERSION) {
    throw new Error('backup ERROR: el archivo cifrado no es válido.');
  }
  const wrappedLen = buffer.readUInt16BE(5);
  const prefixNeed = 7 + wrappedLen + 4 + 12 + 16;
  if (
    (wrappedLen !== 256 && wrappedLen !== 384 && wrappedLen !== 512) ||
    buffer.length < prefixNeed ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < prefixNeed + 1
  ) {
    throw new Error('backup ERROR: el archivo cifrado no es válido.');
  }
  if (!buffer.subarray(7 + wrappedLen, 11 + wrappedLen).equals(INNER_MAGIC)) {
    throw new Error('backup ERROR: el archivo cifrado no es válido.');
  }
  return { wrappedLen, prefixNeed, tagOffset: 7 + wrappedLen + 16 };
}

/** Comprueba la estructura PGZ2. No descifra y no recibe la clave privada. */
export function assertSealedEnvelope(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const head = buffer.subarray(0, Math.min(buffer.length, 7 + MAX_WRAPPED + 32));
  assertSealedPrefix(head, buffer.length);
  return buffer;
}

export function openDump(blob, privatePem) {
  const text = String(privatePem ?? '');
  if (!text.includes('PRIVATE KEY')) {
    throw new Error('backup ERROR: no se pudo abrir el sobre.');
  }
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buffer.length < 8 || !buffer.subarray(0, 4).equals(MAGIC) || buffer[4] !== VERSION) {
    throw new Error('backup ERROR: el archivo cifrado no es válido.');
  }
  const wrappedLen = buffer.readUInt16BE(5);
  if (wrappedLen < 1 || wrappedLen > MAX_WRAPPED || buffer.length < 7 + wrappedLen + 4) {
    throw new Error('backup ERROR: el archivo cifrado no es válido.');
  }
  const wrapped = buffer.subarray(7, 7 + wrappedLen);
  const inner = buffer.subarray(7 + wrappedLen);
  try {
    const key = privateDecrypt(
      { key: text, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      wrapped,
    );
    if (key.length !== 32) {
      throw new Error('len');
    }
    return decryptDump(inner, key);
  } catch {
    throw new Error('backup ERROR: no se pudo abrir el sobre.');
  }
}
