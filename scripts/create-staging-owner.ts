/**
 * Alta del usuario de ensayo. La contraseña llega por el entorno y no se imprime.
 *
 *   STAGING_OWNER_EMAIL=dueno@ensayo.test \
 *   STAGING_OWNER_PASSWORD='...' \
 *   DATABASE_URL=postgres://... \
 *   npm run seed:staging-owner
 */
import 'reflect-metadata';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import {
  migrationUsesSsl,
  redactDatabaseUrl,
} from '../src/config/db-synchronize';
import { assertCrmMigrationAllowed } from '../src/config/migration-target';
import {
  STAGING_OWNER_EMAIL_SUFFIX,
  STAGING_TALLER_ID,
} from '../src/config/staging-synthetic';

const BCRYPT_ROUNDS = 12;

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  const email = String(process.env.STAGING_OWNER_EMAIL ?? '')
    .trim()
    .toLowerCase();
  const password = String(process.env.STAGING_OWNER_PASSWORD ?? '');
  if (!url) {
    console.error('seed:staging-owner ERROR: falta DATABASE_URL.');
    process.exit(1);
  }
  if (!email.endsWith(STAGING_OWNER_EMAIL_SUFFIX)) {
    console.error(
      'seed:staging-owner ERROR: el correo debe terminar en @ensayo.test.',
    );
    process.exit(1);
  }
  if (password.length < 12) {
    console.error(
      'seed:staging-owner ERROR: la contraseña necesita al menos 12 caracteres.',
    );
    process.exit(1);
  }
  assertCrmMigrationAllowed(url, process.env);

  const ds = new DataSource({
    type: 'postgres',
    url,
    ssl: migrationUsesSsl(url, process.env.DATABASE_SSL)
      ? { rejectUnauthorized: false }
      : false,
    entities: [],
    synchronize: false,
  });
  await ds.initialize();
  try {
    const taller = await ds.query(`SELECT 1 FROM talleres WHERE id = $1`, [
      STAGING_TALLER_ID,
    ]);
    if (taller.length === 0) {
      console.error(
        'seed:staging-owner ERROR: falta el taller de ensayo. Ejecuta seed:staging antes.',
      );
      process.exit(1);
    }
    const existing = await ds.query(`SELECT 1 FROM users WHERE email = $1`, [
      email,
    ]);
    if (existing.length > 0) {
      console.log('OK: el usuario de ensayo ya existía.');
      return;
    }
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await ds.query(
      `
      INSERT INTO users (id, email, password_hash, "tallerId", role, "createdAt")
      VALUES (gen_random_uuid(), $1, $2, $3, 'owner', NOW())
    `,
      [email, passwordHash, STAGING_TALLER_ID],
    );
    console.log('OK: usuario de ensayo creado.');
  } catch (err) {
    const message = redactDatabaseUrl(
      err instanceof Error ? err.message : String(err),
    );
    console.error(`seed:staging-owner ERROR: ${message}`);
    process.exit(1);
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }
}

void main();
