import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDump, sealDump } from './staging-backup-envelope.mjs';
import {
  assertBackupRoleSpec,
  assertCiphertextObject,
  assertCronCannotDump,
  APPROVED_START_COMMAND,
  assertApprovedStartCommand,
  assertInertService,
  assertNoSharedStartOverride,
  assertObjectName,
  assertPrivateBackupContext,
  assertPrivateSan,
  assertSshIdentityStaysOn,
  assertWorkerStartup,
  assertWriterPolicy,
  BACKUP_ROLE_SQL,
  BUILD_EXECUTION,
  backupPhases,
  nextRemoteOperation,
  planWorkerTlsProbe,
  stageExternalObject,
} from './staging-private-backup.mjs';

const client18 = 'pg_dump (PostgreSQL) 18.6';

function context(overrides = {}) {
  return {
    RAILWAY_ENVIRONMENT_NAME: 'staging',
    RAILWAY_PROJECT_NAME: 'amused-possibility',
    RAILWAY_SERVICE_NAME: 'pegazuz-backup-staging',
    RAILWAY_ENVIRONMENT_ID: '11111111-1111-4111-8111-111111111111',
    EXPECTED_RAILWAY_ENVIRONMENT_ID: '11111111-1111-4111-8111-111111111111',
    RAILWAY_SERVICE_ID: '22222222-2222-4222-8222-222222222222',
    EXPECTED_RAILWAY_SERVICE_ID: '22222222-2222-4222-8222-222222222222',
    STAGING_DB_HOST: 'postgres-9yd6.railway.internal',
    PRODUCTION_DB_PUBLIC_HOST: 'caboose.proxy.rlwy.net',
    PGSSLMODE: 'verify-full',
    STAGING_DB_ROOT_CERT: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    STAGING_BACKUP_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----\n',
    STAGING_BACKUP_BUCKET_HOST: 'backups.example.test',
    DATABASE_URL: 'postgres://pegazuz_backup:secret@postgres-9yd6.railway.internal:5432/railway',
    ...overrides,
  };
}

function rejectsWithoutSecrets(overrides) {
  assert.throws(
    () => assertPrivateBackupContext(context(overrides), client18),
    (err) => {
      assert.equal(err.message.includes('secret'), false);
      assert.equal(err.message.includes('caboose'), false);
      assert.equal(err.message.includes('railway.internal'), false);
      return true;
    },
  );
}

test('el plan privado acepta solo el cron de staging y no ejecuta el volcado', () => {
  const plan = assertPrivateBackupContext(context(), client18);
  assert.equal(plan.transport, 'railway-private-cron');
  assert.equal(plan.execution, 'plan-only');
  assert.equal(BUILD_EXECUTION, 'plan-only');
  const forced = assertPrivateBackupContext(
    context({ BACKUP_EXECUTE: 'yes', STAGING_BACKUP_AUTHORIZED: 'yes' }),
    client18,
  );
  assert.equal(forced.execution, 'plan-only');
  const startup = assertWorkerStartup({
    BACKUP_EXECUTE: 'yes',
    RAILWAY_CRON_SCHEDULE: '15 8 * * *',
    PRODUCTION_DB_PUBLIC_HOST: 'caboose.proxy.rlwy.net',
  });
  assert.equal(startup.connects, false);
  assert.deepEqual(assertCronCannotDump(null, null), {
    scheduled: false,
    execution: 'plan-only',
    connects: false,
    exitCode: null,
  });
  assert.equal(
    assertCronCannotDump('15 8 * * *', 'node scripts/staging-private-backup.mjs startup').connects,
    false,
  );
  assert.throws(() => assertCronCannotDump('15 8 * * *', 'pg_dump'), /no puede conectar/);
  const started = spawnSync(process.execPath, ['scripts/staging-private-backup.mjs', 'startup'], {
    cwd: join(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      BACKUP_EXECUTE: 'yes',
      STAGING_BACKUP_AUTHORIZED: 'yes',
      RAILWAY_CRON_SCHEDULE: '15 8 * * *',
    },
  });
  assert.equal(started.status, 1);
  assert.match(started.stderr, /plan-only/);
  const poisoned = spawnSync(process.execPath, ['scripts/staging-private-backup.mjs', 'startup'], {
    cwd: join(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: 'postgres://postgres:secret@caboose.proxy.rlwy.net:12497/railway',
      RAILWAY_TOKEN: 'account-token-value',
      STAGING_BACKUP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    },
  });
  assert.equal(poisoned.status, 1);
  assert.equal(poisoned.stderr.includes('secret'), false);
  assert.equal(poisoned.stderr.includes('account-token-value'), false);
  assert.equal(poisoned.stderr.includes('BEGIN PRIVATE'), false);
  const accidentalCron = assertCronCannotDump(
    '15 8 * * *',
    'node scripts/staging-private-backup.mjs startup',
  );
  assert.equal(accidentalCron.connects, false);
  assert.equal(accidentalCron.exitCode, 1);
  assert.throws(() => assertCronCannotDump('15 8 * * *', 'npm start'), /cron no puede/);
  const inert = assertInertService({
    environment: 'staging',
    service: 'pegazuz-backup-staging',
    publicNetworking: false,
    volume: false,
    restartPolicy: 'NEVER',
    startCommand: 'node scripts/staging-private-backup.mjs startup',
    cronSchedule: '15 8 * * *',
  });
  assert.equal(inert.connects, false);
  assert.equal(inert.exitCode, 1);
  assert.equal(assertApprovedStartCommand(APPROVED_START_COMMAND).startsApi, false);
  for (const command of [null, '', 'npm start', 'npm run start:prod', 'node dist/main.js', 'nest start']) {
    assert.throws(() => assertApprovedStartCommand(command), /comando inerte/);
  }
  assert.throws(
    () =>
      assertInertService({
        environment: 'staging',
        service: 'pegazuz-backup-staging',
        publicNetworking: false,
        volume: false,
        restartPolicy: 'ON_FAILURE',
        startCommand: 'npm start',
      }),
    /comando inerte/,
  );
  assert.doesNotThrow(() => assertNoSharedStartOverride(['package.json', '.gitignore']));
  assert.throws(() => assertNoSharedStartOverride(['railway.toml']), /cambiaría el API/);
  const root = join(import.meta.dirname, '..');
  for (const name of ['railway.toml', 'railway.json', 'railpack.json', 'Procfile']) {
    assert.equal(existsSync(join(root, name)), false);
  }
  assert.equal(existsSync(join(root, 'scripts/staging-private-backup.mjs')), true);
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.doesNotMatch(ignore, /^\/?scripts\/?$/m);
  const probe = planWorkerTlsProbe();
  assert.equal(probe.executable, false);
  assert.equal(probe.sql, false);
  assert.equal(probe.dump, false);
  assert.equal(probe.host, 'postgres-9yd6.railway.internal');
  assert.equal(probe.sslmode, 'verify-full');
  assert.match(probe.command, /-verify_hostname postgres-9yd6\.railway\.internal/);
  assert.doesNotMatch(probe.command, /psql|pg_dump/);
  const probed = spawnSync(process.execPath, ['scripts/staging-private-backup.mjs', 'probe-tls'], {
    cwd: join(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  assert.equal(probed.status, 1);
  assert.match(probed.stderr, /plan-only/);
  const remote = nextRemoteOperation();
  assert.equal(remote.verdict, 'NO-GO');
  assert.equal(remote.backupVerdict, 'NO-GO');
  assert.ok(backupPhases().every((phase) => phase.verdict === 'NO-GO'));
  assert.equal(plan.role, 'pegazuz_backup');
  assert.equal(plan.sslmode, 'verify-full');
  const source = readFileSync(new URL('./staging-private-backup.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /child_process|net\.connect|tls\.connect|spawn\(/);
  const refused = spawnSync(process.execPath, ['scripts/staging-private-backup.mjs', 'refuse-github'], {
    cwd: join(import.meta.dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /GitHub no extrae el volcado/);
});

test('rechaza producción, el proxy público, loopback, SSH relajado y la clave privada', () => {
  rejectsWithoutSecrets({ RAILWAY_ENVIRONMENT_NAME: 'production' });
  rejectsWithoutSecrets({ RAILWAY_SERVICE_NAME: 'omnichannel-backend' });
  rejectsWithoutSecrets({ RAILWAY_SERVICE_NAME: 'Postgres' });
  rejectsWithoutSecrets({ RAILWAY_SERVICE_NAME: 'Postgres-9yd6' });
  rejectsWithoutSecrets({ STAGING_DB_HOST: 'caboose.proxy.rlwy.net' });
  rejectsWithoutSecrets({ STAGING_DB_HOST: 'postgres.railway.internal' });
  rejectsWithoutSecrets({ STAGING_DB_HOST: '127.0.0.1' });
  rejectsWithoutSecrets({
    DATABASE_URL: 'postgres://pegazuz_backup:secret@caboose.proxy.rlwy.net:12497/railway',
  });
  rejectsWithoutSecrets({
    DATABASE_URL: 'postgres://postgres:secret@postgres-9yd6.railway.internal:5432/railway',
  });
  rejectsWithoutSecrets({ PGSSLMODE: 'require' });
  rejectsWithoutSecrets({
    DATABASE_URL:
      'postgres://pegazuz_backup:secret@postgres-9yd6.railway.internal:5432/railway?sslmode=require',
  });
  rejectsWithoutSecrets({ STAGING_BACKUP_BUCKET_HOST: 'bucket.railway.app' });
  rejectsWithoutSecrets({ STAGING_BACKUP_BUCKET_HOST: 'caboose.proxy.rlwy.net' });
  rejectsWithoutSecrets({ STAGING_BACKUP_KEY: 'clave-simetrica' });
  rejectsWithoutSecrets({ RAILWAY_TOKEN: 'token-de-cuenta' });
  rejectsWithoutSecrets({ EXTRA_SECRET: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----' });
  rejectsWithoutSecrets({ PRODUCTION_DB_PUBLIC_HOST: 'otro.example.test' });
  assert.throws(() => assertPrivateBackupContext(context(), 'pg_dump (PostgreSQL) 16.15'), /PostgreSQL 18/);
  assert.throws(() => assertSshIdentityStaysOn('StrictHostKeyChecking no'), /identidad del host/);
  assert.throws(() => assertSshIdentityStaysOn('StrictHostKeyChecking accept-new'), /identidad del host/);
  assert.throws(() => assertSshIdentityStaysOn('UserKnownHostsFile /dev/null'), /identidad del host/);
  assert.throws(() => assertSshIdentityStaysOn('ssh-keyscan ssh.railway.com'), /identidad del host/);
  assert.doesNotThrow(() => assertSshIdentityStaysOn('StrictHostKeyChecking yes'));
});

test('exige un certificado del hostname privado y un bucket que el worker no puede borrar', () => {
  assert.throws(() => assertPrivateSan('DNS:localhost'), /Postgres-9yd6/);
  assert.throws(
    () => assertPrivateSan('DNS:postgres-9yd6.railway.internal, DNS:caboose.proxy.rlwy.net'),
    /Postgres-9yd6/,
  );
  assert.doesNotThrow(() => assertPrivateSan('DNS:localhost, DNS:postgres-9yd6.railway.internal'));
  assertBackupRoleSpec(BACKUP_ROLE_SQL);
  assert.throws(
    () => assertBackupRoleSpec("CREATE ROLE pegazuz_backup WITH LOGIN SUPERUSER PASSWORD 'x';"),
    /mínimo privilegio/,
  );
  assertWriterPolicy({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: 's3:PutObject',
        Resource: 'arn:aws:s3:::pegazuz-offsite/staging/postgres/*',
      },
    ],
  });
  assert.throws(
    () =>
      assertWriterPolicy({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['s3:PutObject', 's3:DeleteObject'],
            Resource: 'arn:aws:s3:::pegazuz-offsite/staging/postgres/*',
          },
        ],
      }),
    /solo puede escribir/,
  );
  assert.throws(() => assertObjectName('staging.dump'), /objeto externo/);
  assert.throws(() => assertObjectName('../production/postgres/20261030T081500Z.dump.enc'), /objeto externo/);
  assert.throws(() => stageExternalObject('staging/postgres/20261030T081500Z.dump.enc', Buffer.from('PGDMP')), /cifrado/);
});

test('el sobre se abre solo con la privada y no acepta una clave corta', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const plain = Buffer.from('PGDMP-sintetico-privado');
  const sealed = sealDump(plain, publicPem);
  assert.equal(openDump(sealed, privatePem).toString(), plain.toString());
  assert.throws(() => sealDump(plain, privatePem), /clave pública/);
  const short = generateKeyPairSync('rsa', { modulusLength: 1024 });
  assert.throws(() => sealDump(plain, short.publicKey.export({ type: 'spki', format: 'pem' })), /clave pública/);
  const corrupt = Buffer.from(sealed);
  corrupt[corrupt.length - 1] ^= 0xff;
  assert.throws(() => openDump(corrupt, privatePem), /no se pudo abrir el sobre/);
  assert.throws(() => openDump(sealed, publicPem), /no se pudo abrir el sobre/);
  assert.throws(() => assertCiphertextObject(randomBytes(4)), /cifrado/);
});
