import type { EntityManager } from 'typeorm';
import {
  isProspectOrigin,
  toAppointmentListItem,
  type AppointmentListItem,
  type AppointmentSource,
} from './crm-appointment';

export const APPOINTMENT_VISIBILITY_SQL =
  '(a."tallerId" = $1 OR (a."tallerId" IS NULL AND c."tallerId" = $1))';

type SqlRunner = Pick<EntityManager, 'query'>;

export async function listAppointmentsForTaller(
  manager: SqlRunner,
  tallerId: string,
  options?: { source?: AppointmentSource },
): Promise<AppointmentListItem[]> {
  const params: unknown[] = [tallerId];
  let sourceSql = '';
  if (options?.source) {
    params.push(options.source);
    sourceSql = ' AND a.source = $2';
  }

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
      cw."contractedAmount" AS "contractedAmount"
    FROM appointments a
    LEFT JOIN conversation c ON c.id = a."conversationId"
    LEFT JOIN contracted_works cw
      ON cw."appointmentId" = a.id AND cw."tallerId" = $1
    WHERE ${APPOINTMENT_VISIBILITY_SQL}
    ${sourceSql}
    ORDER BY a."scheduledAt" ASC
  `;

  const rows = await manager.query(sql, params);
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
        tallerId: nullableString(record.tallerId),
        contactId: nullableString(record.contactId),
        vehicleMake: nullableString(record.vehicleMake),
        vehicleModel: nullableString(record.vehicleModel),
        vehicleYear:
          record.vehicleYear == null ? null : Number(record.vehicleYear),
        serviceRequested: nullableString(record.serviceRequested),
        quotedAmount:
          record.quotedAmount == null ? null : Number(record.quotedAmount),
        origin: isProspectOrigin(origin) ? origin : null,
        notes: nullableString(record.notes),
        source: nullableString(record.source),
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
