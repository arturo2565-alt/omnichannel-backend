import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { isLocalDatabaseUrl } from '../config/db-synchronize';
import {
  emptyAppointmentDraft,
  mergeAppointmentDraftSnapshot,
  type AppointmentDraft,
} from './appointment-draft';
import { commitConversationAppointmentDraft } from './appointment-draft-store';

const LOCAL_PORT = 55448;
const TABLE = 'conversation';

jest.setTimeout(120_000);

/** Solo el servicio local de CI o un Postgres de esta máquina. Nunca DATABASE_URL. */
function localServiceUrl(raw: string | undefined): string | null {
  const url = String(raw ?? '').trim();
  if (!url) return null;
  if (!isLocalDatabaseUrl(url)) {
    throw new Error(
      'La prueba de concurrencia solo acepta PostgreSQL en localhost, 127.0.0.1 o ::1.',
    );
  }
  return url;
}

function disposableDatabaseName(): string {
  const name = `adraft${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  if (!/^adraft[a-z0-9]+$/.test(name)) {
    throw new Error('Nombre de base temporal inválido.');
  }
  return name;
}

function optionsFor(baseUrl: string, database: string): DataSourceOptions {
  const parsed = new URL(baseUrl.replace(/^postgres(ql)?:/i, 'http:'));
  return {
    type: 'postgres',
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    username: decodeURIComponent(parsed.username || 'postgres'),
    password: decodeURIComponent(parsed.password || ''),
    database,
    entities: [],
    synchronize: false,
    logging: false,
  };
}

function commandFailure(label: string, result: ReturnType<typeof spawnSync>): Error {
  const detail = String(result.stderr || result.stdout || '')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://***')
    .trim()
    .slice(0, 500);
  return new Error(detail ? `${label}: ${detail}` : label);
}

describe('borrador de cita con bloqueo de PostgreSQL', () => {
  let dataDir = '';
  let serviceUrl: string | null = null;
  let serviceDatabase = '';
  let first: DataSource;
  let second: DataSource;

  beforeAll(async () => {
    serviceUrl = localServiceUrl(process.env.CRM008_DATABASE_URL);
    if (serviceUrl) {
      serviceDatabase = disposableDatabaseName();
      const admin = new DataSource(optionsFor(serviceUrl, 'postgres'));
      await admin.initialize();
      await admin.query(`CREATE DATABASE ${serviceDatabase}`);
      await admin.destroy();
      const options = optionsFor(serviceUrl, serviceDatabase);
      first = new DataSource(options);
      second = new DataSource({ ...options });
    } else {
      dataDir = mkdtempSync(join(tmpdir(), 'appointment-draft-'));
      const locale = { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' };
      const init = spawnSync(
        'initdb',
        ['-D', dataDir, '-U', 'pegazuz', '--auth=trust', '-E', 'UTF8'],
        { env: locale, encoding: 'utf8' },
      );
      if (init.status !== 0) throw commandFailure('no se pudo crear la base desechable', init);
      const start = spawnSync(
        'pg_ctl',
        ['-D', dataDir, '-l', join(dataDir, 'server.log'), '-o', `-p ${LOCAL_PORT} -h 127.0.0.1`, 'start'],
        { env: locale, encoding: 'utf8' },
      );
      if (start.status !== 0) throw commandFailure('no se pudo arrancar la base desechable', start);
      const options: DataSourceOptions = {
        type: 'postgres',
        host: '127.0.0.1',
        port: LOCAL_PORT,
        username: 'pegazuz',
        database: 'postgres',
        entities: [],
        synchronize: false,
        logging: false,
      };
      first = new DataSource(options);
      second = new DataSource({ ...options });
    }
    await first.initialize();
    await second.initialize();
    await first.query(`
      CREATE TABLE ${TABLE} (
        id uuid PRIMARY KEY,
        status character varying(32) NOT NULL DEFAULT 'nuevo',
        "isAutoPilotActive" boolean NOT NULL DEFAULT true,
        "appointmentDraft" jsonb
      )
    `);
  });

  afterAll(async () => {
    if (second?.isInitialized) await second.destroy();
    if (first?.isInitialized) await first.destroy();
    if (serviceUrl && serviceDatabase) {
      const admin = new DataSource(optionsFor(serviceUrl, 'postgres'));
      await admin.initialize();
      await admin.query(`DROP DATABASE IF EXISTS ${serviceDatabase} WITH (FORCE)`);
      await admin.destroy();
      return;
    }
    if (dataDir) {
      spawnSync('pg_ctl', ['-D', dataDir, 'stop', '-m', 'fast'], { encoding: 'utf8' });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rechaza un host remoto sin abrir conexión', () => {
    expect(() => localServiceUrl('postgres://postgres@db.railway.internal:5432/postgres')).toThrow(
      /localhost/,
    );
    expect(() => localServiceUrl('postgres://postgres@supabase.co:5432/postgres')).toThrow(
      /localhost/,
    );
    expect(localServiceUrl('postgres://postgres@127.0.0.1:5432/postgres')).toContain('127.0.0.1');
    expect(localServiceUrl('')).toBeNull();
  });

  it('dos conexiones conservan vehículo y nombre, y no tocan el estado', async () => {
    const id = randomUUID();
    await first.query(
      `INSERT INTO ${TABLE} (id, status, "isAutoPilotActive") VALUES ($1, 'agendado', true)`,
      [id],
    );
    const vehicleDesired = emptyAppointmentDraft();
    vehicleDesired.vehicleIdentity = {
      value: 'Mazda 2 2024',
      source: 'client',
      confirmed: true,
    };
    const nameDesired = emptyAppointmentDraft();
    nameDesired.clientName = {
      value: 'Ana Ensayo',
      source: 'client',
      confirmed: true,
    };
    const seen: string[] = [];
    await Promise.all([
      commitConversationAppointmentDraft(first.manager, id, async (current) => {
        seen.push(`a:${current.vehicleIdentity?.value ?? ''}:${current.clientName?.value ?? ''}`);
        await new Promise((resolve) => setTimeout(resolve, 80));
        return mergeAppointmentDraftSnapshot(vehicleDesired, current);
      }, TABLE),
      commitConversationAppointmentDraft(second.manager, id, (current) => {
        seen.push(`b:${current.vehicleIdentity?.value ?? ''}:${current.clientName?.value ?? ''}`);
        return mergeAppointmentDraftSnapshot(nameDesired, current);
      }, TABLE),
    ]);

    const rows = await first.query(
      `SELECT status, "isAutoPilotActive" AS autopilot, "appointmentDraft" AS draft FROM ${TABLE} WHERE id = $1`,
      [id],
    );
    const draft = rows[0].draft as AppointmentDraft;
    expect(rows[0].status).toBe('agendado');
    expect(rows[0].autopilot).toBe(true);
    expect(draft.vehicleIdentity).toMatchObject({
      value: 'Mazda 2 2024',
      source: 'client',
      confirmed: true,
    });
    expect(draft.clientName?.value).toBe('Ana Ensayo');
    const secondRead = seen.find((item) => item.startsWith('b:'));
    const firstRead = seen.find((item) => item.startsWith('a:'));
    const laterSawTheOther =
      (secondRead?.includes('Mazda') ?? false) || (firstRead?.includes('Ana') ?? false);
    expect(laterSawTheOther).toBe(true);

    const before = JSON.stringify(draft);
    await commitConversationAppointmentDraft(
      second.manager,
      id,
      (current) => mergeAppointmentDraftSnapshot(vehicleDesired, current),
      TABLE,
    );
    const again = await first.query(
      `SELECT status, "appointmentDraft" AS draft FROM ${TABLE} WHERE id = $1`,
      [id],
    );
    expect(again[0].status).toBe('agendado');
    expect(JSON.stringify(again[0].draft)).toBe(before);

    const vision = emptyAppointmentDraft();
    vision.vehicleIdentity = {
      value: 'hatchback claro',
      source: 'vision',
      confirmed: false,
    };
    await commitConversationAppointmentDraft(
      first.manager,
      id,
      (current) => mergeAppointmentDraftSnapshot(vision, current),
      TABLE,
    );
    const kept = await second.query(
      `SELECT status, "isAutoPilotActive" AS autopilot, "appointmentDraft" AS draft FROM ${TABLE} WHERE id = $1`,
      [id],
    );
    expect(kept[0].status).toBe('agendado');
    expect(kept[0].autopilot).toBe(true);
    expect(kept[0].draft.vehicleIdentity).toMatchObject({
      value: 'Mazda 2 2024',
      source: 'client',
      confirmed: true,
    });
    expect(kept[0].draft.clientName.value).toBe('Ana Ensayo');
  });
});
