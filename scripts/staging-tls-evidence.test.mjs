import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  assertInspectionPlan,
  assertLiveTlsEvidence,
  assertRootCertPem,
  assertTlsClosure,
  assertWorkerUsesConfirmedIdentity,
  CONFIRMED_STAGING_TLS,
  planTlsInspection,
} from './staging-tls-evidence.mjs';

function handshake(overrides = {}) {
  return {
    source: 'live-handshake',
    environment: 'staging',
    peerHost: 'postgres-9yd6.railway.internal',
    servername: 'postgres-9yd6.railway.internal',
    sslmode: 'verify-full',
    verifyReturnCode: 0,
    sql: false,
    writes: false,
    privateKeyRead: false,
    san: 'DNS:localhost, DNS:postgres-9yd6.railway.internal',
    ...overrides,
  };
}

test('solo un handshake real valida la identidad', () => {
  assert.equal(assertLiveTlsEvidence(handshake()).identity, 'verified');
  for (const source of ['image-script', 'boot-log', 'repository']) {
    assert.throws(
      () => assertLiveTlsEvidence(handshake({ source, san: 'DNS:postgres-9yd6.railway.internal' })),
      /certificado en servicio/,
    );
  }
  assert.throws(() => assertLiveTlsEvidence(handshake({ servername: 'localhost' })), /hostname privado/);
  assert.throws(() => assertLiveTlsEvidence(handshake({ sslmode: 'require' })), /hostname privado/);
  assert.throws(() => assertLiveTlsEvidence(handshake({ sslmode: 'verify-ca' })), /hostname privado/);
  assert.throws(() => assertLiveTlsEvidence(handshake({ verifyReturnCode: 19 })), /no es válida/);
  assert.throws(() => assertLiveTlsEvidence(handshake({ san: 'DNS:localhost' })), /Postgres-9yd6/);
  assert.throws(
    () => assertLiveTlsEvidence(handshake({ san: 'DNS:postgres-9yd6.railway.internal, DNS:caboose.proxy.rlwy.net' })),
    /Postgres-9yd6/,
  );
  assert.throws(() => assertLiveTlsEvidence(handshake({ sql: true })), /no puede consultar/);
  assert.throws(() => assertLiveTlsEvidence(handshake({ writes: true })), /no puede consultar/);
  assert.throws(() => assertLiveTlsEvidence(handshake({ privateKeyRead: true })), /no puede consultar/);
  assert.throws(() => assertLiveTlsEvidence(handshake({ environment: 'production' })), /red privada/);
  assert.throws(
    () => assertLiveTlsEvidence(handshake({ san: 'DNS:postgres-9yd6.railway.internal\n-----BEGIN PRIVATE KEY-----' })),
    /no puede consultar/,
  );
  const source = readFileSync(new URL('./staging-tls-evidence.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /child_process|net\.connect|tls\.connect|spawn\(/);
});

test('el cierre TLS usa el certificado observado y el worker el mismo hostname', () => {
  assert.equal(assertTlsClosure(CONFIRMED_STAGING_TLS).host, 'postgres-9yd6.railway.internal');
  assert.deepEqual(assertWorkerUsesConfirmedIdentity({
    host: 'postgres-9yd6.railway.internal',
    sslmode: 'verify-full',
  }), {
    host: 'postgres-9yd6.railway.internal',
    sslmode: 'verify-full',
  });
  assert.throws(
    () => assertWorkerUsesConfirmedIdentity({ host: 'localhost', sslmode: 'verify-full' }),
    /hostname privado verificado/,
  );
  assert.throws(
    () => assertWorkerUsesConfirmedIdentity({ host: 'postgres-9yd6.railway.internal', sslmode: 'require' }),
    /hostname privado verificado/,
  );
  assert.equal(
    assertRootCertPem('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n').committed,
    false,
  );
  assert.throws(
    () => assertRootCertPem('-----BEGIN CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\n'),
    /CA pública/,
  );
});

test('la inspección remota queda escrita y no se puede ejecutar', () => {
  const plan = assertInspectionPlan(planTlsInspection());
  assert.equal(plan.executable, false);
  assert.equal(plan.blockedBy, 'ssh-host-key-unpublished');
  assert.equal(plan.sshHostKeyChecking, 'yes');
  assert.equal(plan.newService, false);
  assert.equal(plan.cron, false);
  assert.ok(plan.publicFiles.every((file) => file.endsWith('.crt')));
  assert.ok(plan.forbiddenFiles.every((file) => file.endsWith('.key')));
  assert.throws(
    () => assertInspectionPlan({ ...plan, executable: true, commands: ['openssl x509', 'pg_dump'] }),
    /no está autorizada/,
  );
  assert.throws(
    () =>
      assertInspectionPlan({
        ...plan,
        commands: ['openssl s_client -starttls postgres', 'cat /var/lib/postgresql/data/certs/server.key'],
      }),
    /no está autorizada/,
  );
});
