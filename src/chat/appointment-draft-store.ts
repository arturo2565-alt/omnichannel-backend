import type { EntityManager } from 'typeorm';
import {
  appointmentDraftProgressEqual,
  parseAppointmentDraft,
  type AppointmentDraft,
} from './appointment-draft';

/**
 * Lee y escribe el borrador bajo SELECT … FOR UPDATE.
 * El candado vive en PostgreSQL, así que dos procesos no se pisan.
 */
export async function commitConversationAppointmentDraft(
  manager: EntityManager,
  conversationId: string,
  produce: (current: AppointmentDraft) => AppointmentDraft | Promise<AppointmentDraft>,
  tableName: string,
): Promise<AppointmentDraft> {
  const table = String(tableName ?? '').trim();
  if (!/^[a-z_]+$/.test(table)) {
    throw new Error('Tabla de conversación no reconocida.');
  }
  return manager.transaction(async (tx) => {
    const rows: Array<{ appointmentDraft: unknown }> = await tx.query(
      `SELECT "appointmentDraft" FROM "${table}" WHERE id = $1 FOR UPDATE`,
      [conversationId],
    );
    if (!rows.length) return parseAppointmentDraft(null);
    const current = parseAppointmentDraft(rows[0]?.appointmentDraft);
    const produced = await produce(current);
    if (appointmentDraftProgressEqual(produced, current)) return current;
    await tx.query(
      `UPDATE "${table}" SET "appointmentDraft" = $2::jsonb WHERE id = $1`,
      [conversationId, JSON.stringify(produced)],
    );
    return produced;
  });
}
