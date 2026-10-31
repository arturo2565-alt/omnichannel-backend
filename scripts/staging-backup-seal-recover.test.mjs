import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDump, sealDump } from './staging-backup-envelope.mjs';
import { BUILD_EXECUTION } from './staging-private-backup.mjs';
import { planPutObject, STAGING_BACKUP_BUCKET, STAGING_BACKUP_REGION } from './staging-backup-put-contract.mjs';
import { HOLD_MARKER } from './staging-backup-seal-hold.mjs';
import {
  consumeSealed,
  discardSealed,
  reapAbandonedSeals,
  sealBlocks,
  sealedLocation,
} from './staging-backup-seal.mjs';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });

function sealNames() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('pegazuz-seal-'));
}

function containsMarker(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const info = lstatSync(full);
    if (info.isSymbolicLink()) return true;
    if (info.isFile() && readFileSync(full).includes(HOLD_MARKER)) return true;
  }
  return false;
}

function spawnHold(phase) {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'staging-backup-seal-hold.mjs'), phase], {
    cwd: join(import.meta.dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.fromEntries(
      ['PATH', 'TMPDIR', 'TMP', 'TEMP']
        .filter((name) => process.env[name])
        .map((name) => [name, process.env[name]]),
    ),
  });
  let out = '';
  let err = '';
  let settled = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('el hijo no avisó')), 10000);
    const finish = () => {
      if (!out.includes('READY\n')) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on('data', finish);
    child.once('exit', (code) => {
      if (settled) return;
      clearTimeout(timer);
      reject(new Error(`el hijo terminó con ${code}`));
    });
  });
  return { child, ready, output: () => ({ out, err }) };
}

async function stop(child) {
  child.kill('SIGKILL');
  await once(child, 'exit');
}

test('el identificador se lee por el descriptor y no sobrevive a discard', async () => {
  const handle = await sealBlocks([Buffer.from('PGDMP-sintetico-ciclo')], publicPem);
  const loc = sealedLocation(handle);
  let blocked = null;
  const reading = consumeSealed(handle, async () => {
    blocked = discardSealed(handle);
    await assert.rejects(blocked, /sigue en uso/);
  });
  const consumed = await reading;
  assert.equal(consumed.byteLength > 0, true);
  await discardSealed(handle);
  await discardSealed(handle);
  assert.equal(existsSync(loc.dir), false);
  await assert.rejects(consumeSealed(handle, async () => {}), /sellado/);
  assert.throws(() => planPutObject({
    bucket: STAGING_BACKUP_BUCKET,
    region: STAGING_BACKUP_REGION,
    key: 'staging/postgres/20261031T181905Z.dump.enc',
    ifNoneMatch: '*',
    operation: 'PutObject',
    multipart: false,
    overwrite: false,
    sealed: handle,
  }), /sellado/);
});

test('openDump rechaza tag, ciphertext y clave ajena sin devolver el plaintext', async () => {
  const plain = Buffer.from('PGDMP-sintetico-gcm');
  const handle = await sealBlocks([plain], publicPem);
  try {
    const chunks = [];
    const consumed = await consumeSealed(handle, async (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    const bytes = Buffer.concat(chunks);
    const classic = sealDump(plain, publicPem);
    assert.equal(bytes.subarray(0, 4).toString(), 'PGZ2');
    assert.equal(bytes[4], 1);
    assert.equal(bytes.readUInt16BE(5), classic.readUInt16BE(5));
    assert.equal(bytes.subarray(7 + 256, 11 + 256).toString(), 'PGZ1');
    assert.equal(openDump(bytes, privatePem).equals(plain), true);
    assert.equal(consumed.sha256, createHash('sha256').update(bytes).digest('base64'));
    assert.equal(consumed.sha256.includes(plain.toString()), false);
    const plan = planPutObject({
      bucket: STAGING_BACKUP_BUCKET,
      region: STAGING_BACKUP_REGION,
      key: 'staging/postgres/20261031T181905Z.dump.enc',
      ifNoneMatch: '*',
      operation: 'PutObject',
      multipart: false,
      overwrite: false,
      sealed: handle,
    });
    assert.equal(plan.envelopeAuthentication.gcmTagVerified, false);
    assert.equal(plan.transportChecksum.algorithm, 'SHA256');
    const badTag = Buffer.from(bytes);
    badTag[7 + 256 + 16] ^= 0xff;
    const badCipher = Buffer.from(bytes);
    badCipher[badCipher.length - 1] ^= 0xff;
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    for (const attempt of [
      () => openDump(badTag, privatePem),
      () => openDump(badCipher, privatePem),
      () => openDump(bytes, other.privateKey.export({ type: 'pkcs8', format: 'pem' })),
    ]) {
      assert.throws(attempt, (err) => {
        assert.match(err.message, /no se pudo abrir el sobre/);
        assert.equal(err.message.includes('PGDMP-sintetico-gcm'), false);
        return true;
      });
    }
  } finally {
    await discardSealed(handle);
  }
});

test('la limpieza automática se niega y un pid vivo no borra el directorio', async () => {
  const handle = await sealBlocks([Buffer.from('PGDMP-sintetico-activo')], publicPem);
  const active = sealedLocation(handle);
  const ambiguous = mkdtempSync(join(tmpdir(), 'pegazuz-seal-'));
  chmodSync(ambiguous, 0o700);
  writeFileSync(join(ambiguous, 'seal.mark'), 'PGZSEAL1\n', { mode: 0o600 });
  writeFileSync(join(ambiguous, 'nota.txt'), 'no-borrar', { mode: 0o600 });
  const target = mkdtempSync(join(tmpdir(), 'pegazuz-sentinel-'));
  writeFileSync(join(target, 'sentinel'), 'sigue');
  const link = join(tmpdir(), 'pegazuz-seal-ZzYy99');
  symlinkSync(target, link);
  const quitter = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await once(quitter, 'exit');
  try {
    await assert.rejects(reapAbandonedSeals(), /automática/);
    await assert.rejects(reapAbandonedSeals(active.dir), /ruta/);
    const alive = await reapAbandonedSeals({ pid: process.pid, directory: active.dir });
    assert.equal(alive.removed, 0);
    assert.equal(alive.keptActive, 1);
    assert.equal(existsSync(active.dir), true);
    const refused = await reapAbandonedSeals({ pid: quitter.pid, directory: ambiguous });
    assert.equal(refused.removed, 0);
    assert.equal(refused.rejected, 1);
    assert.equal(existsSync(ambiguous), true);
    assert.equal(existsSync(join(target, 'sentinel')), true);
    const linked = await reapAbandonedSeals({ pid: quitter.pid, directory: link });
    assert.equal(linked.removed, 0);
    assert.equal(existsSync(link), true);
    const chunks = [];
    await consumeSealed(handle, async (chunk) => chunks.push(chunk[0]));
    assert.equal(chunks.length > 0, true);
  } finally {
    await discardSealed(handle);
    rmSync(ambiguous, { recursive: true, force: true });
    unlinkSync(link);
    rmSync(target, { recursive: true, force: true });
  }
});

test('un hijo interrumpido no publica plaintext y la limpieza posterior lo retira', async () => {
  const before = new Set(sealNames());
  const abandoned = spawnHold('abandon');
  await abandoned.ready;
  await once(abandoned.child, 'exit');
  const orphan = sealNames().filter((name) => !before.has(name));
  assert.equal(orphan.length, 1);
  const orphanDir = join(tmpdir(), orphan[0]);
  assert.equal(containsMarker(orphanDir), false);
  await assert.rejects(reapAbandonedSeals(), /automática/);
  assert.equal(existsSync(orphanDir), true);
  const cleaned = await reapAbandonedSeals({ pid: abandoned.child.pid, directory: orphanDir });
  assert.equal(cleaned.removed, 1);
  assert.equal(existsSync(orphanDir), false);

  for (const phase of ['before-cipher', 'after-tag', 'after-publish']) {
    const seen = new Set(sealNames());
    const hold = spawnHold(phase);
    await hold.ready;
    const born = sealNames().filter((name) => !seen.has(name));
    assert.equal(born.length, 1);
    const dir = join(tmpdir(), born[0]);
    assert.equal(containsMarker(dir), false);
    const whileAlive = await reapAbandonedSeals({ pid: hold.child.pid, directory: dir });
    assert.equal(whileAlive.removed, 0);
    assert.equal(whileAlive.keptActive, 1);
    assert.equal(existsSync(dir), true);
    await stop(hold.child);
    const { out, err } = hold.output();
    assert.equal(out.includes(HOLD_MARKER), false);
    assert.equal(err.includes(HOLD_MARKER), false);
    assert.match(out, /READY/);
    const after = await reapAbandonedSeals({ pid: hold.child.pid, directory: dir });
    assert.equal(after.removed, 1);
    assert.equal(existsSync(dir), false);
  }
});

test('el arranque no barre temporales', () => {
  assert.equal(BUILD_EXECUTION, 'plan-only');
  const worker = readFileSync(join(import.meta.dirname, 'staging-private-backup.mjs'), 'utf8');
  assert.doesNotMatch(worker, /reapAbandonedSeals|staging-backup-seal-hold/);
});
