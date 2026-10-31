/**
 * Plan del respaldo dentro de la red privada de staging.
 * No abre conexiones, no llama a pg_dump y no imprime secretos.
 * execution queda en plan-only hasta un respaldo real autorizado.
 */
import { pathToFileURL } from 'node:url';
import { assertPostgres18 } from './assert-staging-restore.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_NAME = /^staging\/postgres\/[0-9]{8}T[0-9]{6}Z\.dump\.enc$/;

/** Una variable de entorno no puede sacar este build de plan-only. */
export const BUILD_EXECUTION = 'plan-only';
export const APPROVED_START_COMMAND = 'node scripts/staging-private-backup.mjs startup';

function fail(message) {
  throw new Error(message);
}

function hostnameOf(databaseUrl) {
  try {
    return new URL(String(databaseUrl).replace(/^postgres(ql)?:\/\//, 'http://')).hostname;
  } catch {
    return '';
  }
}

function usernameOf(databaseUrl) {
  try {
    return decodeURIComponent(new URL(String(databaseUrl).replace(/^postgres(ql)?:\/\//, 'http://')).username);
  } catch {
    return '';
  }
}

export function assertPrivateSan(sanText) {
  const text = String(sanText ?? '');
  if (!text.includes('DNS:postgres-9yd6.railway.internal') || text.includes('rlwy.net')) {
    fail('backup ERROR: el certificado privado no identifica a Postgres-9yd6.');
  }
}

export function assertSshIdentityStaysOn(configText) {
  const text = String(configText ?? '');
  if (
    /StrictHostKeyChecking\s*(=|\s)\s*(no|accept-new|off)\b/i.test(text) ||
    /UserKnownHostsFile\s*(=|\s)\s*\/dev\/null/i.test(text) ||
    /ssh-keyscan/i.test(text)
  ) {
    fail('backup ERROR: el túnel SSH no puede desactivar la identidad del host.');
  }
}

export function assertWriterPolicy(policy) {
  const statement = policy?.Statement;
  if (policy?.Version !== '2012-10-17' || !Array.isArray(statement) || statement.length !== 1) {
    fail('backup ERROR: el worker solo puede escribir objetos.');
  }
  const actions = Array.isArray(statement[0].Action) ? statement[0].Action : [statement[0].Action];
  const resource = statement[0].Resource;
  if (
    statement[0].Effect !== 'Allow' ||
    actions.length !== 1 ||
    actions[0] !== 's3:PutObject' ||
    typeof resource !== 'string' ||
    !resource.endsWith('/staging/postgres/*') ||
    resource === '*'
  ) {
    fail('backup ERROR: el worker solo puede escribir objetos.');
  }
}

export function assertBackupRoleSpec(sql) {
  const text = String(sql ?? '');
  if (
    !text.includes('pegazuz_backup') ||
    !text.includes('NOSUPERUSER') ||
    !text.includes('NOCREATEDB') ||
    !text.includes('NOCREATEROLE') ||
    !text.includes('pg_read_all_data') ||
    /(?<!NO)SUPERUSER/.test(text) ||
    /(?<!NO)CREATEDB/.test(text) ||
    /(?<!NO)CREATEROLE/.test(text) ||
    /password\s+['"][^'"]+['"]/i.test(text) ||
    /\b(DROP|DELETE|TRUNCATE|ALTER ROLE postgres)\b/i.test(text)
  ) {
    fail('backup ERROR: el rol de respaldo no cumple el mínimo privilegio.');
  }
}

export function assertCiphertextObject(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length < 8 || buffer.subarray(0, 4).toString('utf8') !== 'PGZ2') {
    fail('backup ERROR: solo se puede guardar el volcado cifrado.');
  }
  return buffer;
}

export function assertObjectName(name) {
  if (!OBJECT_NAME.test(String(name ?? ''))) {
    fail('backup ERROR: el objeto externo no es válido.');
  }
}

export function stageExternalObject(name, bytes) {
  assertObjectName(name);
  return { name, body: assertCiphertextObject(bytes), canDelete: false };
}

export const BACKUP_ROLE_SQL = [
  'CREATE ROLE pegazuz_backup WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;',
  'GRANT pg_read_all_data TO pegazuz_backup;',
].join('\n');

export function assertWorkerStartup(env = {}) {
  if (BUILD_EXECUTION !== 'plan-only') {
    fail('backup ERROR: este build no ejecuta el volcado.');
  }
  for (const [name, value] of Object.entries(env)) {
    const text = String(value ?? '');
    if (
      text.includes('PRIVATE KEY') ||
      text.includes('BEGIN RSA') ||
      (/(PRIVATE_KEY|RAILWAY_TOKEN|RAILWAY_API_TOKEN|PRODUCTION_DATABASE|PROD_DATABASE)/.test(name) &&
        text.trim() !== '')
    ) {
      fail('backup ERROR: el worker no admite esa credencial.');
    }
  }
  const databaseUrl = String(env.DATABASE_URL ?? '');
  if (
    databaseUrl.includes('caboose.proxy.rlwy.net') ||
    env.RAILWAY_ENVIRONMENT_NAME === 'production' ||
    env.RAILWAY_SERVICE_NAME === 'omnichannel-backend' ||
    env.RAILWAY_SERVICE_NAME === 'Postgres'
  ) {
    fail('backup ERROR: el worker no admite esa credencial.');
  }
  return { execution: BUILD_EXECUTION, connects: false, cronRunsDump: false };
}

export function assertCronCannotDump(schedule, startCommand) {
  const cron = schedule == null ? '' : String(schedule).trim();
  const command = startCommand == null ? '' : String(startCommand).trim();
  if (BUILD_EXECUTION !== 'plan-only' || /pg_dump|psql|pg_restore|openssl|railway ssh/.test(command)) {
    fail('backup ERROR: el arranque no puede conectar.');
  }
  if (cron !== '' && command !== 'node scripts/staging-private-backup.mjs startup') {
    fail('backup ERROR: el cron no puede arrancar el volcado.');
  }
  return {
    scheduled: cron !== '',
    execution: BUILD_EXECUTION,
    connects: false,
    exitCode: command === '' ? null : 1,
  };
}

export function assertApprovedStartCommand(command) {
  const text = command == null ? '' : String(command).trim();
  if (text !== APPROVED_START_COMMAND) {
    fail('backup ERROR: el arranque tiene que ser el comando inerte.');
  }
  return { command: APPROVED_START_COMMAND, startsApi: false, connects: false, exitCode: 1 };
}

export function assertNoSharedStartOverride(names) {
  const shared = ['railway.toml', 'railway.json', 'railpack.json', 'Procfile'];
  for (const name of names ?? []) {
    if (shared.some((file) => String(name).endsWith(file))) {
      fail('backup ERROR: un archivo de arranque del repositorio cambiaría el API.');
    }
  }
}

export function assertInertService(spec) {
  assertApprovedStartCommand(spec?.startCommand);
  const cron = spec?.cronSchedule == null ? '' : String(spec.cronSchedule).trim();
  const described = JSON.stringify(spec ?? {});
  if (
    spec?.environment !== 'staging' ||
    spec?.service !== 'pegazuz-backup-staging' ||
    spec?.publicNetworking !== false ||
    spec?.volume !== false ||
    spec?.restartPolicy !== 'NEVER' ||
    /DATABASE_URL|PRIVATE KEY|RAILWAY_TOKEN/.test(described)
  ) {
    fail('backup ERROR: el servicio inerte no está cerrado.');
  }
  return { connects: false, execution: BUILD_EXECUTION, exitCode: 1, cron: cron !== '' };
}

export function planWorkerTlsProbe() {
  return {
    executable: false,
    execution: BUILD_EXECUTION,
    environment: 'staging',
    service: 'pegazuz-backup-staging',
    host: 'postgres-9yd6.railway.internal',
    servername: 'postgres-9yd6.railway.internal',
    sslmode: 'verify-full',
    sql: false,
    dump: false,
    ca: 'STAGING_DB_ROOT_CERT',
    command:
      'openssl s_client -starttls postgres -connect postgres-9yd6.railway.internal:5432 -servername postgres-9yd6.railway.internal -verify_hostname postgres-9yd6.railway.internal -CAfile "$PGSSLROOTCERT" -verify_return_error',
  };
}

export function nextRemoteOperation() {
  return {
    verdict: 'NO-GO',
    operation: 'create-inert-staging-service',
    backupVerdict: 'NO-GO',
    phases: backupPhases().map((phase) => phase.verdict),
  };
}

export function backupPhases() {
  return [
    { id: 1, name: 'publicar el arranque inerte', verdict: 'NO-GO' },
    { id: 2, name: 'crear pegazuz-backup-staging sin cron ni secretos', verdict: 'NO-GO' },
    { id: 3, name: 'entregar solo root.crt', verdict: 'NO-GO' },
    { id: 4, name: 'sonda TLS sin SQL', verdict: 'NO-GO' },
    { id: 5, name: 'bucket externo de otra cuenta', verdict: 'NO-GO' },
    { id: 6, name: 'clave pública RSA', verdict: 'NO-GO' },
    { id: 7, name: 'rol pegazuz_backup', verdict: 'NO-GO' },
    { id: 8, name: 'primer respaldo', verdict: 'NO-GO' },
  ];
}

export function assertPrivateBackupContext(env, clientVersion) {
  assertPostgres18(clientVersion, 'pg_dump');
  if (env?.RAILWAY_ENVIRONMENT_NAME !== 'staging' || env?.RAILWAY_PROJECT_NAME !== 'amused-possibility') {
    fail('backup ERROR: el respaldo solo corre en staging.');
  }
  if (env?.RAILWAY_SERVICE_NAME !== 'pegazuz-backup-staging') {
    fail('backup ERROR: el respaldo solo corre en su propio servicio.');
  }
  if (
    !UUID.test(String(env?.RAILWAY_ENVIRONMENT_ID ?? '')) ||
    env.RAILWAY_ENVIRONMENT_ID !== env.EXPECTED_RAILWAY_ENVIRONMENT_ID ||
    !UUID.test(String(env?.RAILWAY_SERVICE_ID ?? '')) ||
    env.RAILWAY_SERVICE_ID !== env.EXPECTED_RAILWAY_SERVICE_ID ||
    env.RAILWAY_ENVIRONMENT_ID === env.RAILWAY_SERVICE_ID
  ) {
    fail('backup ERROR: el destino de Railway no está fijado.');
  }
  if (env?.STAGING_DB_HOST !== 'postgres-9yd6.railway.internal') {
    fail('backup ERROR: el origen no es la red privada de staging.');
  }
  if (env?.PRODUCTION_DB_PUBLIC_HOST !== 'caboose.proxy.rlwy.net') {
    fail('backup ERROR: falta la exclusión del proxy de producción.');
  }
  if (env?.PGSSLMODE !== 'verify-full') {
    fail('backup ERROR: el origen exige verify-full.');
  }
  const cert = String(env?.STAGING_DB_ROOT_CERT ?? '');
  if (!cert.includes('BEGIN CERTIFICATE') || cert.includes('PRIVATE KEY')) {
    fail('backup ERROR: la CA pública no es válida.');
  }
  const pub = String(env?.STAGING_BACKUP_PUBLIC_KEY ?? '');
  if (!pub.includes('BEGIN PUBLIC KEY') || pub.includes('PRIVATE KEY')) {
    fail('backup ERROR: el worker solo acepta la clave pública.');
  }
  if (String(env?.STAGING_BACKUP_KEY ?? '').trim() !== '') {
    fail('backup ERROR: la clave simétrica no puede vivir en el worker.');
  }
  if (String(env?.RAILWAY_TOKEN ?? '').trim() !== '' || String(env?.RAILWAY_API_TOKEN ?? '').trim() !== '') {
    fail('backup ERROR: el worker no puede llevar un token de Railway.');
  }
  for (const value of Object.values(env ?? {})) {
    if (String(value ?? '').includes('PRIVATE KEY')) {
      fail('backup ERROR: la clave privada no puede estar en el worker.');
    }
  }
  const bucket = String(env?.STAGING_BACKUP_BUCKET_HOST ?? '');
  if (
    bucket.length < 3 ||
    /[:/@]/.test(bucket) ||
    bucket.endsWith('.railway.internal') ||
    bucket.endsWith('.railway.app') ||
    bucket.endsWith('.rlwy.net') ||
    bucket === 'caboose.proxy.rlwy.net'
  ) {
    fail('backup ERROR: el destino tiene que sobrevivir fuera de Railway.');
  }
  const databaseUrl = String(env?.DATABASE_URL ?? '');
  if (
    hostnameOf(databaseUrl) !== 'postgres-9yd6.railway.internal' ||
    usernameOf(databaseUrl) !== 'pegazuz_backup' ||
    /sslmode=(disable|allow|prefer|require|verify-ca)/i.test(databaseUrl)
  ) {
    fail('backup ERROR: el origen no es la red privada de staging.');
  }
  return {
    transport: 'railway-private-cron',
    host: 'postgres-9yd6.railway.internal',
    service: 'pegazuz-backup-staging',
    environment: 'staging',
    sslmode: 'verify-full',
    role: 'pegazuz_backup',
    objectPrefix: 'staging/postgres/',
    execution: BUILD_EXECUTION,
  };
}

function failCli(err) {
  console.error(err instanceof Error ? err.message : 'backup ERROR');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === 'refuse-github') {
    console.error('backup ERROR: GitHub no extrae el volcado de staging.');
    process.exit(1);
  }
  if (mode === 'startup' || mode === 'probe-tls') {
    try {
      assertWorkerStartup(process.env);
    } catch (err) {
      failCli(err);
    }
    console.error('backup ERROR: plan-only. No se abre ninguna conexión.');
    process.exit(1);
  }
  failCli(new Error('backup ERROR: este build no ejecuta el volcado.'));
}
