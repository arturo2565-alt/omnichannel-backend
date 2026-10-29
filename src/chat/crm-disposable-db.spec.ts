import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Taller } from '../taller/entities/taller.entity';
import { User } from '../auth/entities/user.entity';
import { Message } from './entities/chat.entity';
import { Conversation } from './entities/conversation.entity';
import { Contact } from './entities/contact.entity';
import { DraftQuoteEntity } from './entities/draft-quote.entity';
import { DraftQuoteItem } from './entities/draft-quote-item.entity';
import { AppointmentEntity } from './entities/appointment.entity';
import { AppointmentServiceLine } from './entities/appointment-service-line.entity';
import { ContractedWork } from './entities/contracted-work.entity';
import { AiConfigEntity } from './entities/ai-config.entity';
import { LlmCall } from './entities/llm-call.entity';
import { LeadEventEntity } from './entities/lead-event.entity';
import { PriceMatrix } from '../catalog/entities/price-matrix.entity';
import { isLocalDatabaseUrl, resolveDbSynchronize } from '../config/db-synchronize';
import {
  insertLegacyAppointmentRow,
  listAppointmentsForTaller,
} from './appointment-directory';
import { patchAppointmentVisit } from './appointment-visit';
import { ManualAppointmentService } from './manual-appointment.service';
import { LeadEventsService } from './lead-events.service';

const databaseUrl = String(process.env.CRM003_DATABASE_URL ?? '').trim();
const localDisposable = isLocalDatabaseUrl(databaseUrl);
const describeDisposable = localDisposable ? describe : describe.skip;

const entities = [
  Taller,
  User,
  Message,
  Conversation,
  Contact,
  DraftQuoteEntity,
  DraftQuoteItem,
  AppointmentEntity,
  AppointmentServiceLine,
  ContractedWork,
  AiConfigEntity,
  LlmCall,
  LeadEventEntity,
  PriceMatrix,
];

describeDisposable('CRM-003 base PostgreSQL desechable', () => {
  let ds: DataSource;

  beforeAll(async () => {
    const bootstrap = new DataSource({
      type: 'postgres',
      url: databaseUrl,
      entities,
      synchronize: true,
    });
    await bootstrap.initialize();
    await bootstrap.query('DROP SCHEMA public CASCADE');
    await bootstrap.query('CREATE SCHEMA public');
    await bootstrap.destroy();

    const creator = new DataSource({
      type: 'postgres',
      url: databaseUrl,
      entities,
      synchronize: true,
    });
    await creator.initialize();
    await creator.query(`
      ALTER TABLE appointments
        DROP COLUMN IF EXISTS "tallerId",
        DROP COLUMN IF EXISTS "contactId",
        DROP COLUMN IF EXISTS "vehicleMake",
        DROP COLUMN IF EXISTS "vehicleModel",
        DROP COLUMN IF EXISTS "vehicleYear",
        DROP COLUMN IF EXISTS "serviceRequested",
        DROP COLUMN IF EXISTS "quotedAmount",
        DROP COLUMN IF EXISTS origin,
        DROP COLUMN IF EXISTS notes,
        DROP COLUMN IF EXISTS source,
        DROP COLUMN IF EXISTS "clientRequestId",
        DROP COLUMN IF EXISTS "createdByUserId";
      DROP TABLE IF EXISTS contracted_works;
    `);
    await creator.destroy();

    expect(resolveDbSynchronize('false', databaseUrl)).toBe(false);
    ds = new DataSource({
      type: 'postgres',
      url: databaseUrl,
      entities,
      synchronize: resolveDbSynchronize('false', databaseUrl),
    });
    await ds.initialize();
  }, 30000);

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('el calendario sobrevive antes de 004 y el CRM queda aislado después', async () => {
    expect(await columnExists(ds, 'appointments', 'tallerId')).toBe(false);
    expect(await tableExists(ds, 'contracted_works')).toBe(false);

    const talleres = ds.getRepository(Taller);
    const contacts = ds.getRepository(Contact);
    const conversations = ds.getRepository(Conversation);
    const tallerA = await talleres.save({ nombre: 'Taller A', metaPageId: 'page-a' });
    const tallerB = await talleres.save({ nombre: 'Taller B', metaPageId: 'page-b' });
    const contactA = await contacts.save({
      tallerId: tallerA.id,
      externalId: 'wa-a',
      contactName: 'Ana histórica',
      phone: '5511111111',
      platform: 'whatsapp',
    });
    const contactB = await contacts.save({
      tallerId: tallerB.id,
      externalId: 'wa-b',
      contactName: 'Beto',
      phone: '5522222222',
      platform: 'whatsapp',
    });
    const conversationA = await conversations.save({
      tallerId: tallerA.id,
      contactId: contactA.id,
      externalId: 'wa-a',
      contactName: 'Ana histórica',
      platform: 'whatsapp',
      status: 'agendado',
    });
    const conversationB = await conversations.save({
      tallerId: tallerB.id,
      contactId: contactB.id,
      externalId: 'wa-b',
      contactName: 'Beto',
      platform: 'whatsapp',
      status: 'agendado',
    });
    const whenA = new Date('2026-05-26T20:00:00.000Z');
    const whenB = new Date('2026-05-27T20:00:00.000Z');
    await insertLegacyAppointmentRow(ds.manager, {
      id: '11111111-1111-4111-8111-111111111111',
      conversationId: conversationA.id,
      clientName: 'Ana histórica',
      vehicle: 'Nissan Versa',
      phone: '5511111111',
      quoteSummary: 'Cotización de canal',
      scheduledAt: whenA,
    });
    await insertLegacyAppointmentRow(ds.manager, {
      id: '22222222-2222-4222-8222-222222222222',
      conversationId: conversationB.id,
      clientName: 'Beto',
      vehicle: 'VW',
      phone: '5522222222',
      quoteSummary: 'Otra cotización',
      scheduledAt: whenB,
    });

    const beforeA = await listAppointmentsForTaller(ds.manager, tallerA.id);
    const beforeB = await listAppointmentsForTaller(ds.manager, tallerB.id);
    expect(beforeA.map((row) => row.clientName)).toEqual(['Ana histórica']);
    expect(beforeB.map((row) => row.clientName)).toEqual(['Beto']);
    expect(beforeA[0]?.quotedAmount).toBeNull();

    const leads = new LeadEventsService(ds);
    const gateway = {
      emitConversationLeadUpdated: jest.fn(),
      emitAppointmentUpdated: jest.fn(),
    };
    const patched = await patchAppointmentVisit(
      ds.manager,
      leads,
      gateway,
      '11111111-1111-4111-8111-111111111111',
      { visitStatus: 'realizada' },
      tallerA.id,
    );
    expect(patched.visitStatus).toBe('realizada');
    expect(patched.status).toBe('finalizada');
    await expect(
      patchAppointmentVisit(
        ds.manager,
        leads,
        gateway,
        '11111111-1111-4111-8111-111111111111',
        { visitStatus: 'cancelada' },
        tallerB.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(gateway.emitAppointmentUpdated).toHaveBeenCalledWith(
      tallerA.id,
      expect.objectContaining({ tallerId: tallerA.id, visitStatus: 'realizada' }),
    );

    const historicalBeforeMigration = await ds.query(
      `SELECT status, "clientName", "scheduledAt" FROM appointments WHERE id = $1`,
      ['11111111-1111-4111-8111-111111111111'],
    );

    const sql = readFileSync(
      join(__dirname, 'migrations/004_crm_manual_appointments.sql'),
      'utf8',
    );
    await ds.query(sql);

    const historicalAfterMigration = await ds.query(
      `SELECT status, "clientName", "scheduledAt" FROM appointments WHERE id = $1`,
      ['11111111-1111-4111-8111-111111111111'],
    );
    expect(historicalAfterMigration).toEqual(historicalBeforeMigration);
    expect(await tableExists(ds, 'contracted_works')).toBe(true);

    const leadsBeforeManual = await countLeadTotals(ds);
    const manual = new ManualAppointmentService(
      ds.getRepository(AppointmentEntity),
      ds.getRepository(Contact),
      ds.getRepository(ContractedWork),
      ds.getRepository(AppointmentServiceLine),
      {
        emitAppointmentCreated: jest.fn(),
        emitAppointmentUpdated: jest.fn(),
      } as never,
    );
    const created = await manual.create(tallerA.id, '00000000-0000-4000-8000-000000000001', {
      clientRequestId: 'crm-req-0001',
      clientName: 'Carla Manual',
      phone: '5533333333',
      vehicleMake: 'Mazda',
      vehicleModel: '3',
      vehicleYear: 2018,
      serviceRequested: 'Pintura',
      quotedAmount: 4500,
      origin: 'instagram',
      scheduledAtIso: '2026-05-26T14:00:00',
    });
    expect(created.conversationId).toBeNull();
    expect(created.quotedAmount).toBe(4500);
    expect(created.contractedAmount).toBeNull();
    expect(created.tallerId).toBe(tallerA.id);

    const calendarA = await listAppointmentsForTaller(ds.manager, tallerA.id);
    const calendarB = await listAppointmentsForTaller(ds.manager, tallerB.id);
    const crmA = await listAppointmentsForTaller(ds.manager, tallerA.id, {
      source: 'manual',
    });
    expect(calendarA.map((row) => row.clientName).sort()).toEqual([
      'Ana histórica',
      'Carla Manual',
    ]);
    expect(calendarB.map((row) => row.clientName)).toEqual(['Beto']);
    expect(crmA).toHaveLength(1);
    expect(crmA[0]?.id).toBe(created.id);

    const contract = await manual.upsertContract(tallerA.id, created.id, {
      contractedAmount: 3200,
    });
    expect(contract.contractedAmount).toBe(3200);
    expect(contract.quotedAmount).toBe(4500);
    await expect(
      manual.upsertContract(tallerB.id, created.id, { contractedAmount: 1000 }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const afterMoney = await listAppointmentsForTaller(ds.manager, tallerA.id, {
      source: 'manual',
    });
    expect(afterMoney[0]?.quotedAmount).toBe(4500);
    expect(afterMoney[0]?.contractedAmount).toBe(3200);
    expect(await countLeadTotals(ds)).toBe(leadsBeforeManual);

    const autopilot = await ds.getRepository(AppointmentEntity).save({
      conversationId: conversationB.id,
      tallerId: tallerB.id,
      contactId: contactB.id,
      clientName: 'Beto automático',
      vehicle: 'VW Jetta',
      phone: '5522222222',
      quoteSummary: 'Sigue siendo texto, no venta',
      scheduledAt: new Date('2026-05-28T21:00:00.000Z'),
      status: 'confirmada',
      source: 'autopilot',
    });
    const calendarBAfter = await listAppointmentsForTaller(ds.manager, tallerB.id);
    expect(calendarBAfter.map((row) => row.id)).toContain(autopilot.id);
    expect(calendarA.map((row) => row.id)).not.toContain(autopilot.id);
    expect(await countLeadTotals(ds)).toBe(leadsBeforeManual);
  }, 30000);
});

async function columnExists(
  ds: DataSource,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await ds.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
    `,
    [table, column],
  );
  return rows.length > 0;
}

async function tableExists(ds: DataSource, table: string): Promise<boolean> {
  const rows = await ds.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    `,
    [table],
  );
  return rows.length > 0;
}

async function countLeadTotals(ds: DataSource): Promise<number> {
  const rows = await ds.query(
    `SELECT count(*)::int AS n FROM lead_events WHERE metadata ? 'total'`,
  );
  return Number(rows[0]?.n ?? 0);
}
