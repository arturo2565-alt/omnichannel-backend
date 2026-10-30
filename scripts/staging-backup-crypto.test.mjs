import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { decryptDump, encryptDump, parseBackupKey } from './staging-backup-crypto.mjs';
import { libpqEnv, redactBackupLog } from './dump-staging-database.mjs';

const pins = {
  STAGING_DB_PUBLIC_HOST: 'staging-pg.proxy.example.test',
  PRODUCTION_DB_PUBLIC_HOST: 'prod-pg.proxy.example.test',
};

test('rechaza una clave ausente, corta o que no descifra', () => {
  assert.throws(() => parseBackupKey(''), /clave de cifrado/);
  assert.throws(() => parseBackupKey(Buffer.from('corta').toString('base64')), /clave de cifrado/);
  const key = randomBytes(32);
  const blob = encryptDump(Buffer.from('PGDMP-sintetico'), key);
  assert.throws(() => decryptDump(blob.subarray(0, 10), key), /no es válido/);
  assert.throws(() => decryptDump(Buffer.from('no-es-un-volcado'), key), /no es válido/);
  const corrupt = Buffer.from(blob);
  corrupt[corrupt.length - 1] ^= 0xff;
  assert.throws(() => decryptDump(corrupt, key), /no se pudo descifrar/);
  assert.throws(() => decryptDump(blob, randomBytes(32)), /no se pudo descifrar/);
  assert.equal(decryptDump(blob, parseBackupKey(key.toString('base64'))).toString(), 'PGDMP-sintetico');
});

test('rechaza origen privado, de producción, loopback y TLS débil sin revelar la clave', () => {
  const ok = libpqEnv('postgres://user:secret@staging-pg.proxy.example.test:5432/app', pins);
  assert.equal(ok.PGSSLMODE, 'verify-full');
  assert.equal(ok.PGHOST, 'staging-pg.proxy.example.test');
  assert.equal(Object.hasOwn(ok, 'DATABASE_URL'), false);
  for (const url of [
    'postgres://user:secret@postgres.railway.internal:5432/app',
    'postgres://user:secret@prod-pg.proxy.example.test:5432/app',
    'postgres://user:secret@127.0.0.1:5432/app',
    'postgres://user:secret@staging-pg.proxy.example.test:5432/app?sslmode=require',
    'postgres://user:secret@otro.example.test:5432/app',
  ]) {
    assert.throws(
      () => libpqEnv(url, pins),
      (err) => {
        assert.match(err.message, /TLS|proxy público/);
        assert.equal(err.message.includes('secret'), false);
        assert.equal(err.message.includes('otro.example.test'), false);
        assert.equal(err.message.includes('railway.internal'), false);
        return true;
      },
    );
  }
  assert.equal(
    redactBackupLog('falló postgres://user:secret@host/db password=secret'),
    'falló postgres://redacted password=redacted',
  );
});
