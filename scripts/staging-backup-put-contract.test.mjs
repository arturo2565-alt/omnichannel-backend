import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { discardSealed, sealBlocks, sealedLocation } from './staging-backup-seal.mjs';
import { BUILD_EXECUTION, stageExternalObject } from './staging-private-backup.mjs';
import {
  STAGING_BACKUP_BUCKET,
  STAGING_BACKUP_REGION,
  UPLOAD_HARD_MAX_BYTES,
  UPLOAD_SIZE_LIMIT_BYTES,
  UPLOAD_SIZE_MARGIN_BYTES,
  assertStagingObjectKey,
  assertUploadSize,
  planPutObject,
  stagingObjectKey,
} from './staging-backup-put-contract.mjs';

const secret = 'clave-que-no-puede-aparecer';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
const marker = 'PGDMP-sintetico-contrato';

function request(overrides = {}) {
  return {
    bucket: STAGING_BACKUP_BUCKET,
    region: STAGING_BACKUP_REGION,
    key: 'staging/postgres/20261031T181905Z.dump.enc',
    ifNoneMatch: '*',
    operation: 'PutObject',
    multipart: false,
    overwrite: false,
    ...overrides,
  };
}

function rejectsWithoutSecret(overrides, pattern) {
  assert.throws(
    () => planPutObject(request(overrides)),
    (err) => {
      assert.match(err.message, pattern);
      assert.equal(err.message.includes(secret), false);
      assert.equal(err.message.includes('BEGIN PRIVATE'), false);
      assert.equal(err.message.includes('PGDMP'), false);
      return true;
    },
  );
}

test('genera y acepta solo la clave UTC del prefijo de staging', () => {
  const key = stagingObjectKey(new Date('2026-10-31T18:19:05.987Z'));
  assert.equal(key, 'staging/postgres/20261031T181905Z.dump.enc');
  assert.equal(assertStagingObjectKey(key), key);
  assert.throws(() => stagingObjectKey(new Date('no-es-fecha')), /objeto externo/);
  for (const name of [
    `staging/postgres/${secret}.dump.enc`,
    'production/postgres/20261031T181905Z.dump.enc',
    'staging/backup/20261031T181905Z.dump.enc',
    'staging/postgres/../production/20261031T181905Z.dump.enc',
    'staging/postgres/20261031T181905Z.dump.enc/extra',
    'staging/postgres/20261031T181905Z.dump',
    'staging/postgres/20261399T181905Z.dump.enc',
    'staging/postgres/20260229T181905Z.dump.enc',
    'staging/postgres/20261031T251905Z.dump.enc',
    'staging/postgres/20261031T181905Z.dump.enc ',
    '',
  ]) {
    assert.throws(
      () => assertStagingObjectKey(name),
      (err) => {
        assert.match(err.message, /objeto externo/);
        assert.equal(err.message.includes(secret), false);
        if (name !== '') assert.equal(err.message.includes(name), false);
        return true;
      },
    );
  }
});

test('arma un PutObject inerte desde el identificador sellado', async () => {
  const handle = await sealBlocks([Buffer.from(marker)], publicPem);
  try {
    const loc = sealedLocation(handle);
    const bytes = readFileSync(join(loc.dir, loc.name));
    const plan = planPutObject(request({ sealed: handle }));
    assert.equal(plan.bucket, 'pegazuz-staging-postgres');
    assert.equal(plan.region, 'us-east-1');
    assert.equal(plan.operation, 'PutObject');
    assert.equal(plan.ifNoneMatch, '*');
    assert.equal(plan.multipart, false);
    assert.equal(plan.overwrite, false);
    assert.equal(plan.secureTransport, true);
    assert.equal(plan.setsObjectLock, false);
    assert.equal(plan.contentLength, bytes.length);
    assert.notEqual(plan.contentLength, Buffer.from(marker).length);
    assert.deepEqual(plan.transportChecksum, {
      role: 's3-transport',
      algorithm: 'SHA256',
      header: 'x-amz-checksum-sha256',
      encoding: 'base64',
      value: createHash('sha256').update(bytes).digest('base64'),
    });
    assert.equal(plan.envelopeAuthentication.role, 'pgz2-aes-gcm');
    assert.equal(plan.envelopeAuthentication.cipher, 'AES-256-GCM');
    assert.equal(plan.envelopeAuthentication.gcmTagVerified, false);
    assert.equal(plan.envelopeAuthentication.role === plan.transportChecksum.role, false);
    assert.equal(Object.hasOwn(plan, 'body'), false);
    assert.equal(Object.hasOwn(plan, 'privateKey'), false);
    assert.equal(Object.hasOwn(plan, 'path'), false);
    assert.equal(JSON.stringify(plan).includes(marker), false);
    assert.equal(JSON.stringify(plan).includes(secret), false);
    assert.equal(JSON.stringify(plan).includes(loc.dir), false);
  } finally {
    await discardSealed(handle);
  }
});

test('rechaza bucket, región, cabecera, multipart, sobrescritura y credenciales', () => {
  rejectsWithoutSecret({ bucket: `otro-${secret}` }, /bucket/);
  rejectsWithoutSecret({ region: 'us-west-2' }, /región/);
  rejectsWithoutSecret({ ifNoneMatch: undefined }, /If-None-Match/);
  rejectsWithoutSecret({ ifNoneMatch: secret }, /If-None-Match/);
  rejectsWithoutSecret({ ifNoneMatch: '"*"' }, /If-None-Match/);
  rejectsWithoutSecret({ operation: 'CreateMultipartUpload', multipart: false }, /PutObject/);
  rejectsWithoutSecret({ operation: 'UploadPart' }, /PutObject/);
  rejectsWithoutSecret({ operation: 'CompleteMultipartUpload' }, /PutObject/);
  rejectsWithoutSecret({ multipart: true }, /multipart/);
  rejectsWithoutSecret({ overwrite: true }, /sobrescribir/);
  rejectsWithoutSecret({ secureTransport: false }, /TLS/);
  rejectsWithoutSecret({ objectLockMode: 'GOVERNANCE' }, /retención/);
  rejectsWithoutSecret({ privateKey: `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----` }, /credenciales/);
  rejectsWithoutSecret({ secretAccessKey: secret }, /credenciales/);
  rejectsWithoutSecret({ accessKeyId: secret }, /credenciales/);
  rejectsWithoutSecret({ STAGING_BACKUP_KEY: secret }, /credenciales/);
});

test('mide el tope de 5 GiB sin reservar ese volumen', () => {
  assert.equal(UPLOAD_HARD_MAX_BYTES, 5 * 1024 * 1024 * 1024);
  assert.equal(UPLOAD_SIZE_MARGIN_BYTES, 64 * 1024 * 1024);
  assert.ok(UPLOAD_SIZE_LIMIT_BYTES < UPLOAD_HARD_MAX_BYTES);
  assert.equal(assertUploadSize(UPLOAD_SIZE_LIMIT_BYTES - 1), UPLOAD_SIZE_LIMIT_BYTES - 1);
  assert.throws(() => assertUploadSize(UPLOAD_SIZE_LIMIT_BYTES), /no cabe/);
  assert.throws(() => assertUploadSize(UPLOAD_HARD_MAX_BYTES), /no cabe/);
  assert.throws(() => assertUploadSize(0), /no cabe/);
  assert.throws(() => assertUploadSize(1.5), /no cabe/);
});

test('rechaza buffers, rutas e identificadores que no salen del sellado', () => {
  const markerText = `PGDMP-${secret}`;
  rejectsWithoutSecret({ body: Buffer.from(markerText) }, /archivo sellado/);
  rejectsWithoutSecret({ body: Buffer.from('CREATE TABLE talleres') }, /archivo sellado/);
  rejectsWithoutSecret({ body: markerText }, /archivo sellado/);
  rejectsWithoutSecret({ path: `/tmp/${secret}` }, /archivo sellado/);
  rejectsWithoutSecret({ sealed: secret }, /archivo sellado/);
  rejectsWithoutSecret({ sealed: { finalized: true, byteLength: 32, sha256: secret } }, /identificador/);
  assert.throws(() => stageExternalObject('staging/postgres/20261031T181905Z.dump.enc', Buffer.from(markerText)), (err) => {
    assert.match(err.message, /archivo sellado/);
    assert.equal(err.message.includes(secret), false);
    assert.equal(err.message.includes(markerText), false);
    return true;
  });
});

test('el arranque sigue en plan-only y no importa el contrato ni el sellado', () => {
  assert.equal(BUILD_EXECUTION, 'plan-only');
  const root = join(import.meta.dirname, '..');
  const worker = readFileSync(join(root, 'scripts/staging-private-backup.mjs'), 'utf8');
  const contract = readFileSync(new URL('./staging-backup-put-contract.mjs', import.meta.url), 'utf8');
  assert.match(worker, /export const BUILD_EXECUTION = 'plan-only'/);
  assert.match(worker, /node scripts\/staging-private-backup\.mjs startup/);
  assert.doesNotMatch(worker, /staging-backup-put-contract|staging-backup-seal|reapAbandonedSeals|@aws-sdk|child_process|node:net|node:tls|node:http/);
  assert.doesNotMatch(contract, /@aws-sdk|aws-sdk|child_process|node:net|node:tls|node:http|process\.env|pg_dump/);
  const started = spawnSync(process.execPath, ['scripts/staging-private-backup.mjs', 'startup'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      PEGAZUZ_INERT_HOLD_MS: '0',
      BACKUP_EXECUTE: 'yes',
      STAGING_BACKUP_AUTHORIZED: 'yes',
    },
  });
  assert.equal(started.status, 1);
  assert.match(started.stdout, /plan-only\. No se abre ninguna conexión/);
  assert.match(started.stderr, /plan-only\. No se abre ninguna conexión/);
  assert.equal(started.stdout.includes(secret), false);
  assert.equal(started.stderr.includes(secret), false);
});
