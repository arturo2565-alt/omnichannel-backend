/**
 * Contrato inerte de una futura carga PutObject.
 * No crea clientes AWS, no lee credenciales y no abre conexiones.
 * El arranque plan-only no importa este módulo.
 */
import { assertSealedFile } from './staging-backup-seal.mjs';
import { assertObjectName } from './staging-private-backup.mjs';

export const STAGING_BACKUP_BUCKET = 'pegazuz-staging-postgres';
export const STAGING_BACKUP_REGION = 'us-east-1';

/** Tope de una sola operación PutObject. Se rechaza al alcanzarlo. */
export const UPLOAD_HARD_MAX_BYTES = 5 * 1024 * 1024 * 1024;
/** Margen fijo en código. Una variable de entorno no puede ampliarlo. */
export const UPLOAD_SIZE_MARGIN_BYTES = 64 * 1024 * 1024;
export const UPLOAD_SIZE_LIMIT_BYTES = UPLOAD_HARD_MAX_BYTES - UPLOAD_SIZE_MARGIN_BYTES;

const STAMP = /^[0-9]{8}T[0-9]{6}Z$/;
const FORBIDDEN_FIELDS = [
  'privateKey',
  'secretAccessKey',
  'accessKeyId',
  'sessionToken',
  'DATABASE_URL',
  'STAGING_BACKUP_KEY',
  'STAGING_BACKUP_PRIVATE_KEY',
];

function fail(message) {
  throw new Error(message);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

export function assertStagingObjectKey(name) {
  assertObjectName(name);
  const stamp = String(name).slice('staging/postgres/'.length, -'.dump.enc'.length);
  if (!STAMP.test(stamp)) fail('backup ERROR: el objeto externo no es válido.');
  const year = Number(stamp.slice(0, 4));
  const month = Number(stamp.slice(4, 6));
  const day = Number(stamp.slice(6, 8));
  const hour = Number(stamp.slice(9, 11));
  const minute = Number(stamp.slice(11, 13));
  const second = Number(stamp.slice(13, 15));
  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day ||
    instant.getUTCHours() !== hour ||
    instant.getUTCMinutes() !== minute ||
    instant.getUTCSeconds() !== second
  ) {
    fail('backup ERROR: el objeto externo no es válido.');
  }
  return name;
}

export function stagingObjectKey(instant = new Date()) {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    fail('backup ERROR: el objeto externo no es válido.');
  }
  const stamp = [
    String(instant.getUTCFullYear()).padStart(4, '0'),
    pad(instant.getUTCMonth() + 1),
    pad(instant.getUTCDate()),
    'T',
    pad(instant.getUTCHours()),
    pad(instant.getUTCMinutes()),
    pad(instant.getUTCSeconds()),
    'Z',
  ].join('');
  return assertStagingObjectKey(`staging/postgres/${stamp}.dump.enc`);
}

export function assertUploadSize(byteLength) {
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 1) {
    fail('backup ERROR: el objeto cifrado no cabe en una sola carga.');
  }
  if (byteLength >= UPLOAD_SIZE_LIMIT_BYTES || byteLength >= UPLOAD_HARD_MAX_BYTES) {
    fail('backup ERROR: el objeto cifrado no cabe en una sola carga.');
  }
  return byteLength;
}

function rejectsDirectPayload(input) {
  if (
    Object.hasOwn(input, 'body') ||
    Object.hasOwn(input, 'path') ||
    Object.hasOwn(input, 'file') ||
    Object.hasOwn(input, 'pathname') ||
    typeof input.sealed === 'string' ||
    Buffer.isBuffer(input.sealed)
  ) {
    fail('backup ERROR: la carga solo acepta un archivo sellado.');
  }
}

export function planPutObject(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    fail('backup ERROR: la carga no es válida.');
  }
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.hasOwn(input, field)) fail('backup ERROR: el contrato no admite credenciales.');
  }
  if (input.bucket !== STAGING_BACKUP_BUCKET) fail('backup ERROR: el bucket de la carga no es válido.');
  if (input.region !== STAGING_BACKUP_REGION) fail('backup ERROR: la región de la carga no es válida.');
  const key = assertStagingObjectKey(input.key);
  if (input.ifNoneMatch !== '*') fail('backup ERROR: la carga exige If-None-Match.');
  if (input.operation !== 'PutObject') fail('backup ERROR: solo se admite una carga PutObject.');
  if (input.multipart !== false) fail('backup ERROR: la carga no admite multipart.');
  if (input.overwrite !== false) fail('backup ERROR: la carga no admite sobrescribir.');
  if (input.secureTransport === false) fail('backup ERROR: la carga exige TLS.');
  if (input.objectLockMode != null || input.retention != null) {
    fail('backup ERROR: la carga no fija la retención.');
  }
  rejectsDirectPayload(input);
  const sealed = assertSealedFile(input.sealed);
  const contentLength = assertUploadSize(sealed.byteLength);
  return {
    bucket: STAGING_BACKUP_BUCKET,
    region: STAGING_BACKUP_REGION,
    key,
    ifNoneMatch: '*',
    operation: 'PutObject',
    multipart: false,
    overwrite: false,
    secureTransport: true,
    setsObjectLock: false,
    contentLength,
    transportChecksum: {
      role: 's3-transport',
      algorithm: 'SHA256',
      header: 'x-amz-checksum-sha256',
      encoding: 'base64',
      value: sealed.sha256,
    },
    envelopeAuthentication: {
      role: 'pgz2-aes-gcm',
      format: 'PGZ2',
      cipher: 'AES-256-GCM',
      keyWrap: 'RSA-OAEP-SHA-256',
      gcmTagVerified: false,
      verifiedBy: 'apertura-offline',
    },
  };
}
