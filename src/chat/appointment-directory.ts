import type { EntityManager } from 'typeorm';
import {
  isProspectOrigin,
  toAppointmentListItem,
  type AppointmentListItem,
  type AppointmentSource,
  type CrmServiceLine,
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

export type CrmCommercialSchema = {
  attribution: boolean;
  lines: boolean;
  snapshot: boolean;
};

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

export async function readCrmCommercialSchema(
  manager: SqlRunner,
): Promise<CrmCommercialSchema> {
  const rows = await manager.query(`
    SELECT
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'appointments'
          AND column_name = 'campaignName'
      ) AS "hasAttribution",
      EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'appointment_service_lines'
      ) AS "hasLines",
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'appointment_service_lines'
          AND column_name = 'catalogPieceCode'
      ) AS "hasSnapshot"
  `);
  const row = (Array.isArray(rows) ? rows[0] : null) as
    | (StorageRow & {
        hasAttribution?: boolean | string;
        hasLines?: boolean | string;
        hasSnapshot?: boolean | string;
        hasattribution?: boolean | string;
        haslines?: boolean | string;
        hassnapshot?: boolean | string;
      })
    | null;
  return {
    attribution: isSqlFlag(row?.hasAttribution ?? row?.hasattribution),
    lines: isSqlFlag(row?.hasLines ?? row?.haslines),
    snapshot: isSqlFlag(row?.hasSnapshot ?? row?.hassnapshot),
  };
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
  const commercial = await readCrmCommercialSchema(manager);
  const attributionSelect = commercial.attribution
    ? `,
      a."campaignName" AS "campaignName",
      a."adName" AS "adName",
      a."adExternalId" AS "adExternalId",
      a."attributionKind" AS "attributionKind"`
    : '';

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
      ${attributionSelect}
    FROM appointments a
    LEFT JOIN conversation c ON c.id = a."conversationId"
    ${contractJoin}
    WHERE ${APPOINTMENT_VISIBILITY_SQL}
    ${sourceSql}
    ORDER BY a."scheduledAt" ASC
  `;

  const rows = await manager.query(sql, params);
  const items = mapAppointmentRows(rows, true);
  if (!commercial.lines || items.length === 0) return items;
  const snapshotSelect = commercial.snapshot
    ? `,
        "catalogPieceCode" AS "catalogPieceCode",
        "tariffKind" AS "tariffKind",
        "catalogOperations" AS "catalogOperations",
        "catalogMatrixRowId" AS "catalogMatrixRowId",
        "catalogUnitPriceCents" AS "catalogUnitPriceCents"`
    : '';
  const lineRows = await manager.query(
    `
      SELECT
        id,
        "appointmentId" AS "appointmentId",
        name,
        "quantityHundredths" AS "quantityHundredths",
        "unitPriceCents" AS "unitPriceCents",
        "subtotalCents" AS "subtotalCents"
        ${snapshotSelect}
      FROM appointment_service_lines
      WHERE "tallerId" = $1 AND "appointmentId" = ANY($2)
      ORDER BY "sortOrder" ASC, "createdAt" ASC
    `,
    [tallerId, items.map((item) => item.id)],
  );
  return attachServiceLines(items, lineRows);
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
        campaignName: extended ? nullableString(record.campaignName) : null,
        adName: extended ? nullableString(record.adName) : null,
        adExternalId: extended ? nullableString(record.adExternalId) : null,
        attributionKind: extended ? nullableString(record.attributionKind) : null,
      },
      record.contractedAmount == null ? null : Number(record.contractedAmount),
    );
  });
}

function nullableTariff(value: unknown): string | null {
  const text = nullableString(value);
  if (
    text === 'reparacion_pintura' ||
    text === 'montaje' ||
    text === 'montaje_pintura' ||
    text === 'integral' ||
    text === 'manual'
  ) {
    return text;
  }
  return null;
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value);
  return text.length ? text : null;
}

function attachServiceLines(
  items: AppointmentListItem[],
  rows: unknown,
): AppointmentListItem[] {
  const grouped = new Map<string, CrmServiceLine[]>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const record = row as Record<string, unknown>;
    const appointmentId = nullableString(record.appointmentId);
    if (!appointmentId) continue;
    const line: CrmServiceLine = {
      id: String(record.id),
      name: String(record.name ?? ''),
      quantityHundredths: Number(record.quantityHundredths),
      unitPriceCents: Number(record.unitPriceCents),
      subtotalCents: Number(record.subtotalCents),
      catalogPieceCode: nullableString(record.catalogPieceCode),
      tariffKind: nullableTariff(record.tariffKind),
      catalogOperations: nullableString(record.catalogOperations),
      catalogMatrixRowId: nullableString(record.catalogMatrixRowId),
      catalogUnitPriceCents:
        record.catalogUnitPriceCents == null || record.catalogUnitPriceCents === ''
          ? null
          : Number(record.catalogUnitPriceCents),
    };
    const bucket = grouped.get(appointmentId) ?? [];
    bucket.push(line);
    grouped.set(appointmentId, bucket);
  }
  return items.map((item) => {
    const lines = grouped.get(item.id) ?? [];
    const quotedTotalCents = lines.reduce((sum, line) => sum + line.subtotalCents, 0);
    return {
      ...item,
      lines,
      quotedTotalCents: lines.length ? quotedTotalCents : null,
    };
  });
}

function isSqlFlag(value: unknown): boolean {
  return value === true || value === 't' || value === 'true' || value === 1;
}
