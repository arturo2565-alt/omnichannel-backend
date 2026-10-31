/**
 * Cifrado autenticado del volcado. AES-256-GCM, IV aleatorio de 12 bytes.
 * La clave es un secreto del entorno staging. Este módulo no la imprime.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAGIC = Buffer.from('PGZ1');
const AAD = Buffer.from('pegazuz-staging-postgres-v1');

export const INNER_MAGIC = MAGIC;

export function beginDumpCipher(key) {
  if (!ArrayBuffer.isView(key) || key.byteLength !== 32) {
    throw new Error('backup ERROR: el archivo cifrado no es válido.');
  }
  const keyBytes = Buffer.isBuffer(key) ? key : Buffer.from(key.buffer, key.byteOffset, key.byteLength);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes, iv);
  cipher.setAAD(AAD);
  return { cipher, iv };
}

export function parseBackupKey(value) {
  const raw = Buffer.from(String(value ?? '').trim(), 'base64');
  if (raw.length !== 32) {
    throw new Error('backup ERROR: falta la clave de cifrado de staging.');
  }
  return raw;
}

export function encryptDump(plain, key) {
  const { cipher, iv } = beginDumpCipher(key);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]);
}

export function decryptDump(blob, key) {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buffer.length < MAGIC.length + 12 + 16 + 1 || !buffer.subarray(0, 4).equals(MAGIC)) {
    throw new Error('backup ERROR: el archivo cifrado no es válido.');
  }
  const iv = buffer.subarray(4, 16);
  const tag = buffer.subarray(16, 32);
  const ciphertext = buffer.subarray(32);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('backup ERROR: no se pudo descifrar el volcado.');
  }
}

function fail(err) {
  console.error(err instanceof Error ? err.message : 'backup ERROR');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  try {
    const key = parseBackupKey(process.env.STAGING_BACKUP_KEY);
    if (mode === 'key') {
      console.log('OK: la clave de cifrado está presente.');
    } else if (mode === 'encrypt') {
      writeFileSync(process.argv[4], encryptDump(readFileSync(process.argv[3]), key), { mode: 0o600 });
      console.log('OK: el volcado quedó cifrado.');
    } else if (mode === 'decrypt') {
      writeFileSync(process.argv[4], decryptDump(readFileSync(process.argv[3]), key), { mode: 0o600 });
      console.log('OK: el volcado se descifró.');
    } else {
      console.error('backup ERROR: falta el modo de cifrado.');
      process.exit(1);
    }
  } catch (err) {
    fail(err);
  }
}
