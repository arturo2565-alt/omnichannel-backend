/**
 * Sobre del volcado. AES-256-GCM por archivo, con la clave envuelta en RSA-OAEP.
 * El worker solo recibe la clave pública. La privada no entra en este módulo al cifrar.
 */
import { constants, createPublicKey, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import { decryptDump, encryptDump } from './staging-backup-crypto.mjs';

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

export function sealDump(plain, publicPem) {
  const pem = assertPublicOnly(publicPem);
  const key = randomBytes(32);
  const inner = encryptDump(plain, key);
  const wrapped = publicEncrypt(
    { key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    key,
  );
  if (wrapped.length > MAX_WRAPPED) {
    throw new Error('backup ERROR: el worker solo acepta la clave pública.');
  }
  const header = Buffer.alloc(7);
  MAGIC.copy(header, 0);
  header[4] = VERSION;
  header.writeUInt16BE(wrapped.length, 5);
  return Buffer.concat([header, wrapped, inner]);
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
