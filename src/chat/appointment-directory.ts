import type { EntityManager } from 'typeorm';
import {
  isProspectOrigin,
  toAppointmentListItem,
  type AppointmentListItem,
  type AppointmentSource,
} from './crm-appointment';

export const APPOINTMENT_VISIBILITY_SQL =
  '(a."tallerId" = $1 OR (a."tallerId" IS NULL AND c."tallerId" = $1))';

/** Columnas anteriores al CRM. El calendario las puede leer sin la migración 004. */
export const LEGACY_APPOINTMENT_SELECT = [
  'a.id',
  'a.conversationId',
  'a.clientName',
  'a.vehicle',
  'a.phone',
  'a.quoteSummary',
  'a.scheduledAt',
  'a.status',
] as const;

export type AppointmentStorage = 'legacy' | 'partial' | 'ready';

type SqlRunner = Pick<EntityManager, 'query'>;

type StorageRow = {
  hasTaller?: boolean | string;
  hasContracts?: boolean | string;
  hastaller?: boolean | string;
  hascontracts?: boolean | string;
};

export async function readAppointmentStorage(
  manager: SqlRunner,
): Promise<AppointmentStorage> {
  const rows = await manager.query(`
    SELECT
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'appointments'
          AND column_name = 'tallerId'
      ) AS "hasTaller",
      EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'contracted_works'
      ) AS "hasContracts"
  `);
  const row = (Array.isArray(rows) ? rows[0] : null) as StorageRow | null;
  const hasTaller = isSqlFlag(row?.hasTaller ?? row?.hastaller);
  const hasContracts = isSqlFlag(row?.hasContracts ?? row?.hascontracts);
  if (!hasTaller) return 'legacy';
  if (!hasContracts) return 'partial';
  return 'ready';
}

export async function listAppointmentsForTaller(
  manager: SqlRunner,
  tallerId: string,
  options?: { source?: AppointmentSource },
): Promise<AppointmentListItem[]> {
  const storage = await readAppointmentStorage(manager);
  if (storage === 'legacy') {
    if (options?.source) return [];
    const rows = await manager.query(
      `
        SELECT
          a.id,
          a."clientName" AS "clientName",
          a.vehicle,
          a.phone,
          a."quoteSummary" AS "quoteSummary",
          a."scheduledAt" AS "scheduledAt",
          a.status,
          a."conversationId" AS "conversationId"
        FROM appointments a
        INNER JOIN conversation c ON c.id = a."conversationId"
        WHERE c."tallerId" = $1
        ORDER BY a."scheduledAt" ASC
      `,
      [tallerId],
    );
    return mapAppointmentRows(rows, false);
  }

  const params: unknown[] = [tallerId];
  let sourceSql = '';
  if (options?.source) {
    params.push(options.source);
    sourceSql = ' AND a.source = $2';
  }
  const contractJoin =
    storage === 'ready'
      ? `LEFT JOIN contracted_works cw
           ON cw."appointmentId" = a.id AND cw."tallerId" = $1`
      : '';
  const contractSelect =
    storage === 'ready' ? 'cw."contractedAmount" AS "contractedAmount"' : 'NULL AS "contractedAmount"';

  const sql = `
    SELECT
      a.id,
      a."clientName" AS "clientName",
      a.vehicle,
      a.phone,
      a."quoteSummary" AS "quoteSummary",
      a."scheduledAt" AS "scheduledAt",
      a.status,
      a."conversationId" AS "conversationId",
      a."tallerId" AS "tallerId",
      a."contactId" AS "contactId",
      a."vehicleMake" AS "vehicleMake",
      a."vehicleModel" AS "vehicleModel",
      a."vehicleYear" AS "vehicleYear",
      a."serviceRequested" AS "serviceRequested",
      a."quotedAmount" AS "quotedAmount",
      a.origin,
      a.notes,
      a.source,
      ${contractSelect}
    FROM appointments a
    LEFT JOIN conversation c ON c.id = a."conversationId"
    ${contractJoin}
    WHERE ${APPOINTMENT_VISIBILITY_SQL}
    ${sourceSql}
    ORDER BY a."scheduledAt" ASC
  `;

  const rows = await manager.query(sql, params);
  return mapAppointmentRows(rows, true);
}

export async function insertLegacyAppointmentRow(
  manager: SqlRunner,
  input: {
    id: string;
    conversationId: string;
    clientName: string;
    vehicle: string | null;
    phone: string | null;
    quoteSummary: string | null;
    scheduledAt: Date;
  },
): Promise<void> {
  await manager.query(
    `
      INSERT INTO appointments (
        id,
        "conversationId",
        "clientName",
        vehicle,
        phone,
        "quoteSummary",
        "scheduledAt",
        status,
        "createdAt",
        "updatedAt"
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmada', now(), now())
    `,
    [
      input.id,
      input.conversationId,
      input.clientName,
      input.vehicle,
      input.phone,
      input.quoteSummary,
      input.scheduledAt,
    ],
  );
}

export async function updateAppointmentStatusColumn(
  manager: SqlRunner,
  id: string,
  status: string,
): Promise<void> {
  await manager.query(
    `UPDATE appointments SET status = $1, "updatedAt" = now() WHERE id = $2`,
    [status, id],
  );
}

export async function updateLegacyAppointmentClientFields(
  manager: SqlRunner,
  id: string,
  fields: {
    clientName: string;
    vehicle: string | null;
    phone: string | null;
    quoteSummary: string | null;
  },
): Promise<void> {
  await manager.query(
    `
      UPDATE appointments
      SET "clientName" = $1,
          vehicle = $2,
          phone = $3,
          "quoteSummary" = $4,
          "updatedAt" = now()
      WHERE id = $5
    `,
    [fields.clientName, fields.vehicle, fields.phone, fields.quoteSummary, id],
  );
}

function mapAppointmentRows(
  rows: unknown,
  extended: boolean,
): AppointmentListItem[] {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const record = row as Record<string, unknown>;
    const origin = String(record.origin ?? '');
    return toAppointmentListItem(
      {
        id: String(record.id),
        clientName: String(record.clientName ?? ''),
        vehicle: nullableString(record.vehicle),
        phone: nullableString(record.phone),
        quoteSummary: nullableString(record.quoteSummary),
        scheduledAt: (record.scheduledAt as Date | string) ?? '',
        status: String(record.status ?? 'confirmada'),
        conversationId: nullableString(record.conversationId),
        tallerId: extended ? nullableString(record.tallerId) : null,
        contactId: extended ? nullableString(record.contactId) : null,
        vehicleMake: extended ? nullableString(record.vehicleMake) : null,
        vehicleModel: extended ? nullableString(record.vehicleModel) : null,
        vehicleYear:
          extended && record.vehicleYear != null ? Number(record.vehicleYear) : null,
        serviceRequested: extended ? nullableString(record.serviceRequested) : null,
        quotedAmount:
          extended && record.quotedAmount != null ? Number(record.quotedAmount) : null,
        origin: extended && isProspectOrigin(origin) ? origin : null,
        notes: extended ? nullableString(record.notes) : null,
        source: extended ? nullableString(record.source) : null,
      },
      record.contractedAmount == null ? null : Number(record.contractedAmount),
    );
  });
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value);
  return text.length ? text : null;
}

function isSqlFlag(value: unknown): boolean {
  return value === true || value === 't' || value === 'true' || value === 1;
}
