import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  emptyAppointmentDraft,
  mergeAppointmentDraftSnapshot,
  type AppointmentDraft,
} from './appointment-draft';
import { commitConversationAppointmentDraft } from './appointment-draft-store';

const PORT = 55448;

jest.setTimeout(120_000);

describe('borrador de cita con bloqueo de PostgreSQL', () => {
  let dataDir = '';
  let first: DataSource;
  let second: DataSource;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'appointment-draft-'));
    const locale = { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' };
    const init = spawnSync(
      'initdb',
      ['-D', dataDir, '-U', 'pegazuz', '--auth=trust', '-E', 'UTF8'],
      { env: locale, stdio: 'ignore' },
    );
    if (init.status !== 0) throw new Error('no se pudo crear la base desechable');
    const start = spawnSync(
      'pg_ctl',
      ['-D', dataDir, '-l', join(dataDir, 'server.log'), '-o', `-p ${PORT} -h 127.0.0.1`, 'start'],
      { env: locale, stdio: 'ignore' },
    );
    if (start.status !== 0) throw new Error('no se pudo arrancar la base desechable');
    const options = {
      type: 'postgres' as const,
      host: '127.0.0.1',
      port: PORT,
      username: 'pegazuz',
      database: 'postgres',
      entities: [],
      synchronize: false,
      logging: false,
    };
    first = new DataSource(options);
    second = new DataSource({ ...options });
    await first.initialize();
    await second.initialize();
    await first.query(`
      CREATE TABLE conversation (
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
    if (dataDir) {
      spawnSync('pg_ctl', ['-D', dataDir, 'stop', '-m', 'fast'], { stdio: 'ignore' });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('dos conexiones conservan vehículo y nombre, y no tocan el estado', async () => {
    const id = randomUUID();
    await first.query(
      `INSERT INTO conversation (id, status, "isAutoPilotActive") VALUES ($1, 'agendado', true)`,
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
      }, 'conversation'),
      commitConversationAppointmentDraft(second.manager, id, (current) => {
        seen.push(`b:${current.vehicleIdentity?.value ?? ''}:${current.clientName?.value ?? ''}`);
        return mergeAppointmentDraftSnapshot(nameDesired, current);
      }, 'conversation'),
    ]);

    const rows = await first.query(
      `SELECT status, "isAutoPilotActive" AS autopilot, "appointmentDraft" AS draft FROM conversation WHERE id = $1`,
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
    expect(seen.filter((item) => item.includes('Mazda') || item.includes('Ana')).length).toBeGreaterThan(0);

    const before = JSON.stringify(draft);
    await commitConversationAppointmentDraft(
      second.manager,
      id,
      (current) => mergeAppointmentDraftSnapshot(vehicleDesired, current),
      'conversation',
    );
    const again = await first.query(
      `SELECT "appointmentDraft" AS draft FROM conversation WHERE id = $1`,
      [id],
    );
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
      'conversation',
    );
    const kept = await second.query(
      `SELECT "appointmentDraft" AS draft FROM conversation WHERE id = $1`,
      [id],
    );
    expect(kept[0].draft.vehicleIdentity).toMatchObject({
      value: 'Mazda 2 2024',
      source: 'client',
      confirmed: true,
    });
    expect(kept[0].draft.clientName.value).toBe('Ana Ensayo');
  });
});
