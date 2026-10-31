/**
 * La identidad TLS solo cuenta si sale del certificado que presenta Postgres-9yd6.
 * El script de la imagen y el mensaje de arranque no bastan.
 * Este módulo no abre conexiones.
 */

const PRIVATE_HOST = 'postgres-9yd6.railway.internal';

function fail(message) {
  throw new Error(message);
}

export function assertLiveTlsEvidence(evidence) {
  if (evidence?.source !== 'live-handshake') {
    fail('backup ERROR: la identidad TLS no queda validada sin el certificado en servicio.');
  }
  if (evidence.environment !== 'staging' || evidence.peerHost !== PRIVATE_HOST) {
    fail('backup ERROR: la inspección solo acepta la red privada de staging.');
  }
  if (evidence.servername !== PRIVATE_HOST || evidence.sslmode !== 'verify-full') {
    fail('backup ERROR: verify-full tiene que usar el hostname privado.');
  }
  if (evidence.verifyReturnCode !== 0) {
    fail('backup ERROR: la verificación del certificado no es válida.');
  }
  if (evidence.sql !== false || evidence.writes !== false || evidence.privateKeyRead !== false) {
    fail('backup ERROR: la inspección no puede consultar ni leer claves.');
  }
  const san = String(evidence.san ?? '');
  if (!san.includes(`DNS:${PRIVATE_HOST}`) || san.includes('rlwy.net')) {
    fail('backup ERROR: el certificado privado no identifica a Postgres-9yd6.');
  }
  const blob = JSON.stringify(evidence);
  if (blob.includes('PRIVATE KEY') || blob.includes('BEGIN RSA')) {
    fail('backup ERROR: la inspección no puede consultar ni leer claves.');
  }
  return { identity: 'verified', host: PRIVATE_HOST, sslmode: 'verify-full' };
}

/** Hechos leídos en la consola de Postgres-9yd6. No incluye el PEM. */
export const CONFIRMED_STAGING_TLS = {
  source: 'live-handshake',
  observedIn: 'staging-postgres-console',
  observedOn: '2026-10-30',
  environment: 'staging',
  service: 'Postgres-9yd6',
  peerHost: PRIVATE_HOST,
  servername: PRIVATE_HOST,
  sslmode: 'verify-full',
  verifyReturnCode: 0,
  chain: 'OK',
  verification: 'OK',
  hostnameCheck: 'san-on-live-cert',
  sql: false,
  writes: false,
  privateKeyRead: false,
  san: 'DNS:localhost, DNS:postgres-9yd6.railway.internal',
};

export function assertTlsClosure(evidence) {
  const verified = assertLiveTlsEvidence(evidence);
  const san = String(evidence?.san ?? '');
  if (
    evidence?.chain !== 'OK' ||
    evidence?.verification !== 'OK' ||
    evidence?.hostnameCheck !== 'san-on-live-cert' ||
    !san.includes('DNS:localhost') ||
    !san.includes(`DNS:${PRIVATE_HOST}`)
  ) {
    fail('backup ERROR: el cierre TLS no coincide con el certificado en servicio.');
  }
  return verified;
}

export function assertWorkerUsesConfirmedIdentity(worker) {
  const verified = assertTlsClosure(CONFIRMED_STAGING_TLS);
  if (worker?.host !== verified.host || worker?.sslmode !== 'verify-full') {
    fail('backup ERROR: el worker tiene que usar el hostname privado verificado.');
  }
  return { host: verified.host, sslmode: 'verify-full' };
}

export function assertRootCertPem(pem) {
  const text = String(pem ?? '');
  if (!text.includes('BEGIN CERTIFICATE') || /PRIVATE KEY|BEGIN RSA/.test(text)) {
    fail('backup ERROR: la CA pública no es válida.');
  }
  return { publicOnly: true, committed: false };
}

export function planTlsInspection() {
  return {
    executable: false,
    blockedBy: 'ssh-host-key-unpublished',
    environment: 'staging',
    service: 'Postgres-9yd6',
    newService: false,
    cron: false,
    sql: false,
    writes: false,
    privateKeyRead: false,
    sslmode: 'verify-full',
    servername: PRIVATE_HOST,
    sshHostKeyChecking: 'yes',
    publicFiles: [
      '/var/lib/postgresql/data/certs/server.crt',
      '/var/lib/postgresql/data/certs/root.crt',
    ],
    forbiddenFiles: [
      '/var/lib/postgresql/data/certs/server.key',
      '/var/lib/postgresql/data/certs/root.key',
    ],
    commands: [
      'openssl x509 -in /var/lib/postgresql/data/certs/server.crt -noout -subject -issuer -dates -ext subjectAltName',
      'openssl x509 -in /var/lib/postgresql/data/certs/root.crt -noout -subject -issuer -dates',
      'openssl s_client -starttls postgres -connect postgres-9yd6.railway.internal:5432 -servername postgres-9yd6.railway.internal -CAfile /var/lib/postgresql/data/certs/root.crt -verify_return_error',
    ],
  };
}

export function assertInspectionPlan(plan) {
  const commands = Array.isArray(plan?.commands) ? plan.commands.join('\n') : '';
  if (
    plan?.executable !== false ||
    plan?.blockedBy !== 'ssh-host-key-unpublished' ||
    plan?.environment !== 'staging' ||
    plan?.service !== 'Postgres-9yd6' ||
    plan?.newService !== false ||
    plan?.cron !== false ||
    plan?.sql !== false ||
    plan?.writes !== false ||
    plan?.privateKeyRead !== false ||
    plan?.sslmode !== 'verify-full' ||
    plan?.servername !== PRIVATE_HOST ||
    plan?.sshHostKeyChecking !== 'yes' ||
    /server\.key|root\.key|psql|pg_dump|StrictHostKeyChecking\s*(=|\s)\s*(no|accept-new)/i.test(commands)
  ) {
    fail('backup ERROR: la inspección remota no está autorizada.');
  }
  if (!commands.includes('openssl x509') || !commands.includes('-starttls postgres') || !commands.includes('-CAfile')) {
    fail('backup ERROR: la inspección remota no está autorizada.');
  }
  return plan;
}
