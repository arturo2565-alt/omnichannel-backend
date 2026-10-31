import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, symlinkSync, unlinkSync, writeSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDump, sealDump } from './staging-backup-envelope.mjs';
import { BUILD_EXECUTION, stageExternalObject } from './staging-private-backup.mjs';
import { planPutObject, STAGING_BACKUP_BUCKET, STAGING_BACKUP_REGION } from './staging-backup-put-contract.mjs';
import {
  discardSealed,
  sealBlocks,
  sealedLocation,
  sealedModes,
} from './staging-backup-seal.mjs';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const marker = 'PGDMP-sintetico-sellado';

function plan(handle) {
  return planPutObject({
    bucket: STAGING_BACKUP_BUCKET,
    region: STAGING_BACKUP_REGION,
    key: 'staging/postgres/20261031T181905Z.dump.enc',
    ifNoneMatch: '*',
    operation: 'PutObject',
    multipart: false,
    overwrite: false,
    sealed: handle,
  });
}

function sealDirs() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('pegazuz-seal-'));
}

test('el streaming abre el mismo plaintext y no repite el sobre', async () => {
  const first = await sealBlocks([Buffer.from(marker)], publicPem);
  const second = await sealBlocks([Buffer.from(marker)], publicPem);
  try {
    const left = readFileSync(join(sealedLocation(first).dir, sealedLocation(first).name));
    const right = readFileSync(join(sealedLocation(second).dir, sealedLocation(second).name));
    const classic = sealDump(Buffer.from(marker), publicPem);
    assert.equal(left.subarray(0, 4).toString(), 'PGZ2');
    assert.equal(left[4], 1);
    assert.equal(left.readUInt16BE(5), 256);
    assert.equal(left.subarray(7 + 256, 7 + 260).toString(), 'PGZ1');
    assert.equal(classic.readUInt16BE(5), left.readUInt16BE(5));
    assert.equal(classic.subarray(7 + 256, 7 + 260).toString(), 'PGZ1');
    assert.equal(openDump(left, privatePem).toString(), marker);
    assert.equal(openDump(right, privatePem).toString(), marker);
    assert.equal(left.equals(right), false);
    assert.equal(left.equals(classic), false);
    const modes = sealedModes(first);
    assert.equal(modes.fileMode, 0o600);
    assert.equal(modes.dirMode, 0o700);
    const planned = plan(first);
    assert.equal(planned.transportChecksum.value, createHash('sha256').update(left).digest('base64'));
    assert.equal(planned.envelopeAuthentication.gcmTagVerified, false);
    assert.equal(planned.contentLength, left.length);
  } finally {
    await discardSealed(first);
    await discardSealed(second);
  }
});

test('procesa varios bloques sin concatenar el plaintext en el módulo', async () => {
  const sourceText = readFileSync(new URL('./staging-backup-seal.mjs', import.meta.url), 'utf8');
  assert.match(sourceText, /for await/);
  assert.doesNotMatch(sourceText, /Buffer\.concat|readFile\(|readFileSync\(|@aws-sdk|staging-private-backup/);
  const parts = [Buffer.alloc(80 * 1024, 1), Buffer.alloc(80 * 1024, 2), Buffer.alloc(80 * 1024, 3)];
  let pulls = 0;
  async function* blocks() {
    for (const part of parts) {
      pulls += 1;
      yield part;
    }
  }
  const handle = await sealBlocks(blocks(), publicPem);
  try {
    assert.equal(pulls, 3);
    const bytes = readFileSync(join(sealedLocation(handle).dir, sealedLocation(handle).name));
    const opened = openDump(bytes, privatePem);
    assert.equal(opened.length, 80 * 1024 * 3);
    assert.equal(opened[0], 1);
    assert.equal(opened[80 * 1024], 2);
    assert.equal(opened[160 * 1024], 3);
    assert.equal(JSON.stringify(plan(handle)).includes(marker), false);
  } finally {
    await discardSealed(handle);
  }
});

test('rechaza entrada vacía, rutas, symlink, identificador falso y archivo sustituido', async () => {
  const before = sealDirs();
  await assert.rejects(sealBlocks([], publicPem), /no es válido/);
  await assert.rejects(sealBlocks(Buffer.from(marker), publicPem), /entrada/);
  await assert.rejects(sealBlocks([Buffer.from(marker)], publicPem, { path: `/tmp/${marker}` }), (err) => {
    assert.match(err.message, /ruta/);
    assert.equal(err.message.includes(marker), false);
    return true;
  });
  assert.deepEqual(
    sealDirs().filter((name) => !before.includes(name)),
    [],
  );
  const handle = await sealBlocks([Buffer.from(marker)], publicPem);
  try {
    const loc = sealedLocation(handle);
    const full = join(loc.dir, loc.name);
    unlinkSync(full);
    symlinkSync('otro', full);
    assert.throws(
      () => plan(handle),
      (err) => {
        assert.match(err.message, /sellado/);
        assert.equal(err.message.includes(loc.dir), false);
        assert.equal(err.message.includes(marker), false);
        return true;
      },
    );
  } finally {
    await discardSealed(handle);
  }
  const live = await sealBlocks([Buffer.from(marker)], publicPem);
  try {
    const loc = sealedLocation(live);
    const full = join(loc.dir, loc.name);
    const fd = openSync(full, 'r+');
    try {
      writeSync(fd, Buffer.from([0xff]), 0, 1, readFileSync(full).length - 1);
    } finally {
      closeSync(fd);
    }
    assert.throws(() => openDump(readFileSync(full), privatePem), /no se pudo abrir el sobre/);
    assert.throws(() => plan(live), /sellado/);
    assert.throws(() => plan({ finalized: true, byteLength: 10, sha256: 'aa' }), /identificador/);
    assert.throws(() => stageExternalObject(full, readFileSync(full)), /archivo sellado/);
  } finally {
    await discardSealed(live);
  }
});

test('un fallo ENOSPC o anterior a la publicación no deja plaintext ni parciales', async () => {
  const before = sealDirs();
  await assert.rejects(sealBlocks([Buffer.from(marker)], publicPem, { fault: 'ENOSPC' }), (err) => {
    assert.equal(err.code, 'ENOSPC');
    assert.match(err.message, /no se pudo sellar/);
    assert.equal(err.message.includes(marker), false);
    return true;
  });
  await assert.rejects(sealBlocks([Buffer.from(marker)], publicPem, { fault: 'before-publish' }), (err) => {
    assert.match(err.message, /no se pudo publicar/);
    assert.equal(err.message.includes(marker), false);
    return true;
  });
  await assert.rejects(sealBlocks([Buffer.alloc(64, 7)], publicPem, { maxBytes: 64 }), /no cabe/);
  await assert.rejects(sealBlocks([Buffer.alloc(128, 7)], publicPem, { maxBytes: 320 }), /no cabe/);
  const leftover = sealDirs().filter((name) => !before.includes(name));
  assert.deepEqual(leftover, []);
});

test('el arranque no carga este módulo', () => {
  assert.equal(BUILD_EXECUTION, 'plan-only');
  const root = join(import.meta.dirname, '..');
  const worker = readFileSync(join(root, 'scripts/staging-private-backup.mjs'), 'utf8');
  assert.doesNotMatch(worker, /staging-backup-seal/);
  const started = spawnSync(process.execPath, ['scripts/staging-private-backup.mjs', 'startup'], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, PEGAZUZ_INERT_HOLD_MS: '0' },
  });
  assert.equal(started.status, 1);
  assert.match(started.stdout, /plan-only\. No se abre ninguna conexión/);
  assert.match(started.stderr, /plan-only\. No se abre ninguna conexión/);
});
