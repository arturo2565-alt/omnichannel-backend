import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
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
import { listAppointmentsForTaller } from './appointment-directory';
import { ManualAppointmentService } from './manual-appointment.service';

const databaseUrl = String(process.env.CRM008_DATABASE_URL ?? '').trim();
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

describeDisposable('CRM-008 base PostgreSQL 18 desechable', () => {
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
    await creator.query('DROP TABLE IF EXISTS appointment_service_lines CASCADE');
    await creator.destroy();

    expect(resolveDbSynchronize(undefined, 'postgres://app@db.example:5432/app')).toBe(
      false,
    );
    expect(resolveDbSynchronize('false', databaseUrl)).toBe(false);
    ds = new DataSource({
      type: 'postgres',
      url: databaseUrl,
      entities,
      synchronize: false,
    });
    await ds.initialize();
  }, 30000);

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('aplica 005 sin reescribir y deja el desglose atómico', async () => {
    const version = await ds.query('SELECT version() AS version');
    expect(String(version[0].version)).toContain('PostgreSQL 18');
    expect(await columnExists(ds, 'appointments', 'campaignName')).toBe(false);
    expect(await tableExists(ds, 'appointment_service_lines')).toBe(false);

    const talleres = ds.getRepository(Taller);
    const contacts = ds.getRepository(Contact);
    const conversations = ds.getRepository(Conversation);
    const appointments = ds.getRepository(AppointmentEntity);
    const tallerA = await talleres.save({ nombre: 'Taller A', metaPageId: 'page-a' });
    const tallerB = await talleres.save({ nombre: 'Taller B', metaPageId: 'page-b' });
    const contactA = await contacts.save({
      tallerId: tallerA.id,
      externalId: 'crm-a',
      contactName: 'Ana',
      phone: '5511111111',
      platform: 'crm',
    });
    const contactB = await contacts.save({
      tallerId: tallerB.id,
      externalId: 'wa-b',
      contactName: 'Beto',
      phone: '5522222222',
      platform: 'whatsapp',
    });
    const conversationB = await conversations.save({
      tallerId: tallerB.id,
      contactId: contactB.id,
      externalId: 'wa-b',
      contactName: 'Beto',
      platform: 'whatsapp',
      status: 'agendado',
    });
    const historical = await appointments.save({
      tallerId: tallerA.id,
      contactId: contactA.id,
      conversationId: null,
      clientName: 'Histórica CRM-003',
      phone: '5544444444',
      vehicle: 'Honda Civic',
      serviceRequested: 'Hojalatería',
      quoteSummary: 'Hojalatería',
      quotedAmount: 4500,
      origin: 'recomendacion',
      scheduledAt: new Date('2026-05-20T16:00:00.000Z'),
      status: 'confirmada',
      source: 'manual',
      clientRequestId: 'crm-003-hist',
    });
    const autopilot = await appointments.save({
      conversationId: conversationB.id,
      tallerId: tallerB.id,
      contactId: contactB.id,
      clientName: 'Beto automático',
      vehicle: 'VW Jetta',
      phone: '5522222222',
      quoteSummary: 'Sigue siendo texto, no venta',
      scheduledAt: new Date('2026-05-28T16:00:00.000Z'),
      status: 'confirmada',
      source: 'autopilot',
    });

    const manual = new ManualAppointmentService(
      appointments,
      contacts,
      ds.getRepository(ContractedWork),
      ds.getRepository(AppointmentServiceLine),
      {
        emitAppointmentCreated: jest.fn(),
        emitAppointmentUpdated: jest.fn(),
      } as never,
    );
    const beforeCount = await countAppointments(ds);
    await expect(
      manual.create(tallerA.id, '00000000-0000-4000-8000-000000000001', {
        clientRequestId: 'crm-008-too-soon',
        clientName: 'Nueva',
        phone: '5533333333',
        origin: 'instagram',
        scheduledAtIso: '2026-05-26T14:00:00',
        lines: [
          { name: 'Pintura', quantityHundredths: 100, unitPriceCents: 450000 },
        ],
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      manual.create(tallerA.id, '00000000-0000-4000-8000-000000000001', {
        clientRequestId: 'crm-008-campaign-soon',
        clientName: 'Nueva',
        phone: '5533333333',
        origin: 'instagram',
        scheduledAtIso: '2026-05-26T15:00:00',
        campaignName: 'Primavera',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await countAppointments(ds)).toBe(beforeCount);

    const listedBefore = await listAppointmentsForTaller(ds.manager, tallerA.id);
    const historicalBefore = listedBefore.find((row) => row.id === historical.id);
    expect(historicalBefore?.quotedAmount).toBe(4500);
    expect(historicalBefore?.serviceRequested).toBe('Hojalatería');
    expect(historicalBefore?.lines).toEqual([]);
    expect(historicalBefore?.attributionKind).toBeNull();
    const autopilotBefore = (
      await listAppointmentsForTaller(ds.manager, tallerB.id)
    ).find((row) => row.id === autopilot.id);
    expect(autopilotBefore?.quoteSummary).toBe('Sigue siendo texto, no venta');
    expect(autopilotBefore?.lines).toEqual([]);
    expect(autopilotBefore?.source).toBe('autopilot');

    const snapshot = await businessSnapshot(ds, historical.id);
    const fileBefore = await relationFile(ds, 'appointments');
    const sql = readFileSync(
      join(__dirname, 'migrations/005_crm_service_lines.sql'),
      'utf8',
    );
    await ds.query(sql);
    await ds.query(sql);
    expect(await businessSnapshot(ds, historical.id)).toEqual(snapshot);
    expect(await relationFile(ds, 'appointments')).toBe(fileBefore);
    expect(await columnExists(ds, 'appointments', 'attributionKind')).toBe(true);
    const kind = await ds.query(
      `SELECT "attributionKind" AS kind, "campaignName" AS campaign FROM appointments WHERE id = $1`,
      [historical.id],
    );
    expect(kind[0]).toEqual({ kind: 'unknown', campaign: null });
    const constraints = await ds.query(
      `
        SELECT conname
        FROM pg_constraint
        WHERE conname IN (
          'CHK_appointments_attributionKind',
          'CHK_service_lines_quantity',
          'CHK_service_lines_unit',
          'CHK_service_lines_subtotal'
        )
        ORDER BY conname
      `,
    );
    expect(constraints).toHaveLength(4);

    const sql006 = readFileSync(
      join(__dirname, 'migrations/006_crm_catalog_snapshot.sql'),
      'utf8',
    );
    await ds.query(sql006);
    await ds.query(sql006);
    expect(await businessSnapshot(ds, historical.id)).toEqual(snapshot);
    expect(await columnExists(ds, 'appointment_service_lines', 'catalogPieceCode')).toBe(
      true,
    );
    expect(await columnExists(ds, 'appointment_service_lines', 'catalogUnitPriceCents')).toBe(
      true,
    );

    const created = await manual.create(tallerA.id, '00000000-0000-4000-8000-000000000001', {
      clientRequestId: 'crm-008-multi',
      clientName: 'Carla',
      phone: '5533333333',
      origin: 'facebook',
      scheduledAtIso: '2026-05-26T14:00:00',
      campaignName: 'Primavera',
      adName: 'Salpicadera',
      adExternalId: 'ad-100',
      lines: [
        { name: 'Pintura de salpicadera', quantityHundredths: 100, unitPriceCents: 450000 },
        { name: 'Pulido', quantityHundredths: 200, unitPriceCents: 15000 },
      ],
    });
    const again = await manual.create(tallerA.id, '00000000-0000-4000-8000-000000000001', {
      clientRequestId: 'crm-008-multi',
      clientName: 'Carla',
      phone: '5533333333',
      origin: 'facebook',
      scheduledAtIso: '2026-05-26T14:00:00',
      campaignName: 'Primavera',
      adName: 'Salpicadera',
      adExternalId: 'ad-100',
      lines: [
        { name: 'Pintura de salpicadera', quantityHundredths: 100, unitPriceCents: 450000 },
        { name: 'Pulido', quantityHundredths: 200, unitPriceCents: 15000 },
      ],
    });
    expect(again.id).toBe(created.id);
    expect(created.quotedTotalCents).toBe(480000);
    expect(created.quotedAmount).toBe(4800);
    expect(created.attributionKind).toBe('manual');
    const storedLines = await ds.query(
      `
        SELECT name, "quantityHundredths" AS qty, "unitPriceCents" AS price, "subtotalCents" AS subtotal
        FROM appointment_service_lines
        WHERE "appointmentId" = $1 AND "tallerId" = $2
        ORDER BY "sortOrder"
      `,
      [created.id, tallerA.id],
    );
    expect(storedLines).toEqual([
      { name: 'Pintura de salpicadera', qty: 100, price: 450000, subtotal: 450000 },
      { name: 'Pulido', qty: 200, price: 15000, subtotal: 30000 },
    ]);

    const edited = await manual.saveCommercial(tallerA.id, created.id, {
      lines: [
        {
          id: created.lines[0].id,
          name: 'Pintura de salpicadera',
          quantityHundredths: 101,
          unitPriceCents: 333,
        },
      ],
      campaignName: 'Primavera',
      adName: 'Salpicadera',
      adExternalId: 'ad-100',
    });
    expect(edited.lines).toHaveLength(1);
    expect(edited.lines[0].subtotalCents).toBe(336);
    expect(edited.quotedAmount).toBe(3);
    const contract = await manual.upsertContract(tallerA.id, created.id, {
      contractedAmount: 3200,
    });
    expect(contract.contractedAmount).toBe(3200);
    expect(contract.quotedAmount).toBe(3);
    expect(contract.contractedAmount).not.toBe(edited.quotedTotalCents);

    const crmA = await listAppointmentsForTaller(ds.manager, tallerA.id, {
      source: 'manual',
    });
    const card = crmA.find((row) => row.id === created.id);
    expect(card?.lines).toHaveLength(1);
    expect(card?.quotedTotalCents).toBe(336);
    expect(card?.campaignName).toBe('Primavera');
    expect(card?.contractedAmount).toBe(3200);
    const calendarB = await listAppointmentsForTaller(ds.manager, tallerB.id);
    expect(calendarB.map((row) => row.id)).toContain(autopilot.id);
    expect(calendarB.map((row) => row.id)).not.toContain(created.id);

    const suggestionsA = await manual.suggestions(tallerA.id);
    const suggestionsB = await manual.suggestions(tallerB.id);
    expect(suggestionsA.campaigns).toContain('Primavera');
    expect(suggestionsA.services).toContain('Pintura de salpicadera');
    expect(suggestionsB.campaigns).not.toContain('Primavera');
    expect(suggestionsB.services).not.toContain('Pintura de salpicadera');

    const snapped = await manual.saveCommercial(tallerA.id, created.id, {
      lines: [
        {
          id: edited.lines[0].id,
          name: 'Reparación y pintura · Salpicadera izquierda',
          quantityHundredths: 100,
          unitPriceCents: 460000,
          catalogPieceCode: 'SI',
          catalogOperations: 'reparar+pintar',
          tariffKind: 'reparacion_pintura',
          catalogMatrixRowId: '11111111-1111-4111-8111-111111111111',
          catalogUnitPriceCents: 450000,
        },
      ],
    });
    expect(snapped.lines[0].unitPriceCents).toBe(460000);
    expect(snapped.lines[0].catalogUnitPriceCents).toBe(450000);
    expect(snapped.quotedAmount).not.toBe(contract.contractedAmount);
    const visible = await listAppointmentsForTaller(ds.manager, tallerA.id, {
      source: 'manual',
    });
    const storedSnap = visible.find((row) => row.id === created.id)?.lines[0];
    expect(storedSnap?.tariffKind).toBe('reparacion_pintura');
    expect(storedSnap?.catalogPieceCode).toBe('SI');
    expect(storedSnap?.catalogOperations).toBe('reparar+pintar');
    expect(await businessSnapshot(ds, historical.id)).toEqual(snapshot);

    await expect(
      manual.saveCommercial(tallerB.id, created.id, { campaignName: 'Ajena' }),
    ).rejects.toThrow(/no encontrada/i);

    await expect(
      ds.query(
        `
          INSERT INTO appointment_service_lines (
            id, "appointmentId", "tallerId", name,
            "quantityHundredths", "unitPriceCents", "subtotalCents", "sortOrder"
          ) VALUES ($1, $2, $3, 'Mal', 100, 100, 1, 0)
        `,
        ['33333333-3333-4333-8333-333333333333', historical.id, tallerA.id],
      ),
    ).rejects.toThrow(/CHK_service_lines_subtotal/);

    await ds.query(`
      CREATE OR REPLACE FUNCTION crm008_fail_second_line() RETURNS trigger AS $$
      BEGIN
        IF (
          SELECT count(*) FROM appointment_service_lines
          WHERE "appointmentId" = NEW."appointmentId"
        ) >= 1 THEN
          RAISE EXCEPTION 'forced line failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await ds.query(`
      CREATE TRIGGER crm008_fail_second_line
      BEFORE INSERT ON appointment_service_lines
      FOR EACH ROW EXECUTE FUNCTION crm008_fail_second_line()
    `);
    try {
      await expect(
        manual.create(tallerA.id, '00000000-0000-4000-8000-000000000001', {
          clientRequestId: 'crm-008-rollback',
          clientName: 'Incompleta',
          phone: '5555555555',
          origin: 'google',
          scheduledAtIso: '2026-05-27T11:00:00',
          lines: [
            { name: 'Uno', quantityHundredths: 100, unitPriceCents: 10000 },
            { name: 'Dos', quantityHundredths: 100, unitPriceCents: 20000 },
          ],
        }),
      ).rejects.toThrow(/forced line failure/);
      const leftover = await ds.query(
        `SELECT id FROM appointments WHERE "clientRequestId" = 'crm-008-rollback'`,
      );
      expect(leftover).toEqual([]);
      const leftoverLines = await ds.query(
        `
          SELECT id FROM appointment_service_lines
          WHERE name IN ('Uno', 'Dos')
        `,
      );
      expect(leftoverLines).toEqual([]);
    } finally {
      await ds.query('DROP TRIGGER IF EXISTS crm008_fail_second_line ON appointment_service_lines');
      await ds.query('DROP FUNCTION IF EXISTS crm008_fail_second_line()');
    }

    const quotedAutopilot = await manual.saveCommercial(tallerB.id, autopilot.id, {
      lines: [{ name: 'Baño de pintura', quantityHundredths: 100, unitPriceCents: 250000 }],
      campaignName: 'Solo B',
    });
    expect(quotedAutopilot.quotedTotalCents).toBe(250000);
    expect(quotedAutopilot.contractedAmount).toBeNull();
    expect(await countRows(ds, 'lead_events')).toBe(0);
    expect(await countRows(ds, 'draft_quotes')).toBe(0);
    expect(await businessSnapshot(ds, historical.id)).toEqual(snapshot);
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

async function countAppointments(ds: DataSource): Promise<number> {
  const rows = await ds.query('SELECT count(*)::int AS n FROM appointments');
  return Number(rows[0].n);
}

async function countRows(ds: DataSource, table: string): Promise<number> {
  const rows = await ds.query(`SELECT count(*)::int AS n FROM ${table}`);
  return Number(rows[0].n);
}

async function businessSnapshot(ds: DataSource, id: string) {
  const rows = await ds.query(
    `
      SELECT
        "clientName" AS "clientName",
        status,
        "serviceRequested" AS "serviceRequested",
        "quotedAmount" AS "quotedAmount",
        "quoteSummary" AS "quoteSummary",
        origin,
        "scheduledAt" AS "scheduledAt"
      FROM appointments
      WHERE id = $1
    `,
    [id],
  );
  return rows[0];
}

async function relationFile(ds: DataSource, name: string): Promise<string> {
  const rows = await ds.query(
    `SELECT relfilenode::text AS file FROM pg_class WHERE relname = $1`,
    [name],
  );
  return String(rows[0].file);
}
