import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  readAppointmentStorage,
  updateAppointmentStatusColumn,
} from './appointment-directory';
import {
  isAppointmentVisibleToTaller,
  resolveAppointmentDbStatus,
  toAppointmentRealtimePayload,
  type AppointmentRealtimePayload,
} from './crm-appointment';
import type { AppointmentStatus } from './entities/appointment.entity';

type SqlRunner = Pick<EntityManager, 'query'>;

type VisitGateway = {
  emitConversationLeadUpdated(payload: {
    conversationId: string;
    status: string;
    contactName?: string;
    lastMessageAt?: string | null;
    lastMessage?: string | null;
    isAutoPilotActive?: boolean;
  }): void;
  emitAppointmentUpdated(tallerId: string, payload: AppointmentRealtimePayload): void;
};

type VisitLeads = {
  logTransition(
    conversationId: string,
    newStatus: string,
    metadata?: Record<string, unknown> | null,
  ): Promise<unknown>;
};

export async function patchAppointmentVisit(
  manager: SqlRunner,
  leads: VisitLeads,
  gateway: VisitGateway,
  id: string,
  body: { status?: string; visitStatus?: string },
  tallerId: string,
): Promise<{ id: string; status: AppointmentStatus; visitStatus: string }> {
  const row = await loadVisitRow(manager, id);
  if (
    !row ||
    !isAppointmentVisibleToTaller(
      { tallerId: row.tallerId },
      row.conversationTallerId ? { tallerId: row.conversationTallerId } : null,
      tallerId,
    )
  ) {
    throw new NotFoundException(`Cita no encontrada: ${id}`);
  }

  const next = resolveAppointmentDbStatus(body ?? {});
  if (!next) {
    throw new BadRequestException(
      'status debe ser agendada, realizada, cancelada o no_asistio',
    );
  }

  await updateAppointmentStatusColumn(manager, row.id, next);
  row.status = next;

  if (row.conversationId && row.conversationPk) {
    const leadStatus =
      next === 'finalizada'
        ? 'atendido'
        : next === 'no_asistio'
          ? 'no_asistio'
          : null;
    if (leadStatus) {
      await leads.logTransition(row.conversationId, leadStatus);
      gateway.emitConversationLeadUpdated({
        conversationId: row.conversationId,
        status: leadStatus,
        contactName: row.contactName,
        lastMessageAt: row.lastMessageAt ? new Date(row.lastMessageAt).toISOString() : null,
        lastMessage: row.lastMessage,
        isAutoPilotActive: row.isAutoPilotActive,
      });
    }
  }

  const owner = String(row.tallerId ?? row.conversationTallerId ?? '').trim();
  if (owner) {
    gateway.emitAppointmentUpdated(
      owner,
      toAppointmentRealtimePayload(owner, {
        id: row.id,
        conversationId: row.conversationId,
        clientName: row.clientName,
        vehicle: row.vehicle,
        phone: row.phone,
        quoteSummary: row.quoteSummary,
        scheduledAt: row.scheduledAt,
        status: row.status,
        source: row.source,
      }),
    );
  }

  return {
    id: row.id,
    status: row.status as AppointmentStatus,
    visitStatus: toAppointmentRealtimePayload(owner || tallerId, {
      id: row.id,
      conversationId: row.conversationId,
      clientName: row.clientName,
      scheduledAt: row.scheduledAt,
      status: row.status,
    }).visitStatus,
  };
}

type VisitRow = {
  id: string;
  clientName: string;
  vehicle: string | null;
  phone: string | null;
  quoteSummary: string | null;
  scheduledAt: Date | string;
  status: string;
  conversationId: string | null;
  tallerId: string | null;
  source: string | null;
  conversationPk: string | null;
  conversationTallerId: string | null;
  contactName: string;
  lastMessageAt: Date | string | null;
  lastMessage: string | null;
  isAutoPilotActive: boolean;
};

async function loadVisitRow(
  manager: SqlRunner,
  id: string,
): Promise<VisitRow | null> {
  const storage = await readAppointmentStorage(manager);
  const tallerSelect =
    storage === 'legacy' ? 'NULL AS "tallerId", NULL AS source' : 'a."tallerId" AS "tallerId", a.source AS source';
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
        a."conversationId" AS "conversationId",
        ${tallerSelect},
        c.id AS "conversationPk",
        c."tallerId" AS "conversationTallerId",
        c."contactName" AS "contactName",
        c."lastMessageAt" AS "lastMessageAt",
        c."lastMessage" AS "lastMessage",
        c."isAutoPilotActive" AS "isAutoPilotActive"
      FROM appointments a
      LEFT JOIN conversation c ON c.id = a."conversationId"
      WHERE a.id = $1
    `,
    [id],
  );
  const record = (Array.isArray(rows) ? rows[0] : null) as Record<string, unknown> | null;
  if (!record?.id) return null;
  return {
    id: String(record.id),
    clientName: String(record.clientName ?? ''),
    vehicle: record.vehicle == null ? null : String(record.vehicle),
    phone: record.phone == null ? null : String(record.phone),
    quoteSummary: record.quoteSummary == null ? null : String(record.quoteSummary),
    scheduledAt: (record.scheduledAt as Date | string) ?? '',
    status: String(record.status ?? ''),
    conversationId: record.conversationId == null ? null : String(record.conversationId),
    tallerId: record.tallerId == null ? null : String(record.tallerId),
    source: record.source == null ? null : String(record.source),
    conversationPk: record.conversationPk == null ? null : String(record.conversationPk),
    conversationTallerId:
      record.conversationTallerId == null ? null : String(record.conversationTallerId),
    contactName: String(record.contactName ?? ''),
    lastMessageAt: (record.lastMessageAt as Date | string | null) ?? null,
    lastMessage: record.lastMessage == null ? null : String(record.lastMessage),
    isAutoPilotActive: Boolean(record.isAutoPilotActive),
  };
}
