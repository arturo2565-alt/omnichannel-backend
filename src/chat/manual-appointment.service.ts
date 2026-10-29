import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Contact } from './entities/contact.entity';
import { AppointmentEntity } from './entities/appointment.entity';
import { AppointmentServiceLine } from './entities/appointment-service-line.entity';
import { ContractedWork } from './entities/contracted-work.entity';
import { ChatGateway } from './chat.gateway';
import {
  listAppointmentsForTaller,
  readAppointmentStorage,
  readCrmCommercialSchema,
  type CrmCommercialSchema,
} from './appointment-directory';
import {
  composeVehicleLabel,
  crmContactExternalId,
  isAppointmentVisibleToTaller,
  isProspectOrigin,
  isUniqueViolation,
  parseAttribution,
  parseContractedAmount,
  parseManualAppointmentInput,
  phoneSuffix,
  toAppointmentListItem,
  toAppointmentRealtimePayload,
  type AppointmentListItem,
  type AttributionKind,
  type CrmServiceLine,
  type ParsedManualAppointment,
} from './crm-appointment';
import {
  parseServiceLines,
  pesosFromCents,
  serviceSummary,
  type ParsedServiceLine,
} from './crm-money';
import { isUsableAppointmentClientName } from './appointment-client-guard';
import {
  parseWorkshopScheduledAtIso,
  validateWorkshopSlotUtcDetailed,
} from './appointment-intent';

@Injectable()
export class ManualAppointmentService {
  constructor(
    @InjectRepository(AppointmentEntity)
    private readonly appointments: Repository<AppointmentEntity>,
    @InjectRepository(Contact)
    private readonly contacts: Repository<Contact>,
    @InjectRepository(ContractedWork)
    private readonly contracts: Repository<ContractedWork>,
    @InjectRepository(AppointmentServiceLine)
    private readonly lines: Repository<AppointmentServiceLine>,
    private readonly gateway: ChatGateway,
  ) {}

  listManual(tallerId: string): Promise<AppointmentListItem[]> {
    return listAppointmentsForTaller(this.appointments.manager, tallerId, {
      source: 'manual',
    });
  }

  async suggestions(tallerId: string): Promise<{
    campaigns: string[];
    ads: string[];
    adExternalIds: string[];
    services: string[];
  }> {
    const schema = await readCrmCommercialSchema(this.appointments.manager);
    const [campaigns, ads, adExternalIds, services] = await Promise.all([
      schema.attribution
        ? this.distinctTexts('campaignName', tallerId)
        : Promise.resolve([]),
      schema.attribution
        ? this.distinctTexts('adName', tallerId)
        : Promise.resolve([]),
      schema.attribution
        ? this.distinctTexts('adExternalId', tallerId)
        : Promise.resolve([]),
      schema.lines ? this.distinctServiceNames(tallerId) : Promise.resolve([]),
    ]);
    return { campaigns, ads, adExternalIds, services };
  }

  async create(
    tallerId: string,
    userId: string,
    body: Record<string, unknown>,
  ): Promise<AppointmentListItem> {
    await this.requireCrmStorage();
    const parsed = parseManualAppointmentInput(body ?? {});
    if (!parsed.ok) throw new BadRequestException(parsed.error);
    const input = parsed.value;
    const schema = await readCrmCommercialSchema(this.appointments.manager);
    this.assertCommercialReady(schema, input.lines, input.attributionKind);

    const byKey = await this.appointments.findOne({
      where: { tallerId, clientRequestId: input.clientRequestId },
    });
    if (byKey) return this.hydrate(byKey);

    const slot = parseWorkshopScheduledAtIso(input.scheduledAtIso);
    if (!slot.ok) throw new BadRequestException(slot.error);
    const hours = validateWorkshopSlotUtcDetailed(slot.date);
    if (!hours.valid) throw new BadRequestException(hours.error);

    const duplicate = await this.findActiveDuplicate(
      tallerId,
      input.phone,
      slot.date,
    );
    if (duplicate) {
      throw new ConflictException(
        'Ya existe una cita activa para ese teléfono en ese horario.',
      );
    }

    const contact = await this.reuseOrCreateContact(tallerId, input);
    const row = this.appointments.create({
      tallerId,
      contactId: contact.id,
      conversationId: null,
      clientName: input.clientName,
      phone: input.phone,
      vehicle: composeVehicleLabel(input),
      vehicleMake: input.vehicleMake,
      vehicleModel: input.vehicleModel,
      vehicleYear: input.vehicleYear,
      serviceRequested: input.serviceRequested,
      quotedAmount: input.quotedAmount,
      origin: input.origin,
      notes: input.notes,
      quoteSummary: input.serviceRequested,
      scheduledAt: slot.date,
      status: 'confirmada',
      source: 'manual',
      clientRequestId: input.clientRequestId,
      createdByUserId: userId,
    });

    try {
      const saved = await this.appointments.manager.transaction(async (manager) => {
        await manager.query(
          `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
          [tallerId, `${input.phone}|${slot.date.toISOString()}`],
        );
        const raced = await this.findActiveDuplicate(
          tallerId,
          input.phone,
          slot.date,
          manager,
        );
        if (raced) {
          throw new ConflictException(
            'Ya existe una cita activa para ese teléfono en ese horario.',
          );
        }
        const stored = await manager.getRepository(AppointmentEntity).save(row);
        if (input.lines && input.lines.length > 0) {
          await this.replaceLines(
            manager,
            tallerId,
            stored.id,
            input.lines,
            schema.snapshot,
          );
        }
        if (schema.attribution) {
          await this.writeAttribution(manager, tallerId, stored.id, input);
        }
        return stored;
      });
      this.gateway.emitAppointmentCreated(
        tallerId,
        toAppointmentRealtimePayload(tallerId, saved),
      );
      return this.hydrate(saved, input);
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      if (!isUniqueViolation(err)) throw err;
      const again = await this.appointments.findOne({
        where: { tallerId, clientRequestId: input.clientRequestId },
      });
      if (!again) throw err;
      return this.hydrate(again);
    }
  }

  async upsertContract(
    tallerId: string,
    appointmentId: string,
    body: { contractedAmount?: unknown; notes?: unknown },
  ): Promise<{
    appointmentId: string;
    contractedAmount: number;
    quotedAmountSnapshot: number | null;
    quotedAmount: number | null;
  }> {
    await this.requireCrmStorage();
    const row = await this.requireVisible(tallerId, appointmentId);
    if (row.status === 'cancelada' || row.status === 'no_asistio') {
      throw new BadRequestException(
        'No se registra un trabajo contratado en una cita cancelada o de inasistencia.',
      );
    }
    const money = parseContractedAmount(body?.contractedAmount);
    if (!money.ok) throw new BadRequestException(money.error);

    let contract = await this.contracts.findOne({
      where: { appointmentId: row.id, tallerId },
    });
    if (!contract) {
      contract = this.contracts.create({
        tallerId,
        appointmentId: row.id,
        contactId: row.contactId,
        conversationId: row.conversationId,
        quotedAmountSnapshot: row.quotedAmount ?? null,
        contractedAmount: money.amount,
        notes: optionalNote(body?.notes),
      });
    } else {
      contract.contractedAmount = money.amount;
      contract.quotedAmountSnapshot = row.quotedAmount ?? null;
      if (body?.notes !== undefined) contract.notes = optionalNote(body.notes);
    }
    const saved = await this.contracts.save(contract);
    this.gateway.emitAppointmentUpdated(
      tallerId,
      toAppointmentRealtimePayload(tallerId, row),
    );
    return {
      appointmentId: row.id,
      contractedAmount: saved.contractedAmount,
      quotedAmountSnapshot: saved.quotedAmountSnapshot ?? null,
      quotedAmount: row.quotedAmount ?? null,
    };
  }

  async saveCommercial(
    tallerId: string,
    appointmentId: string,
    body: Record<string, unknown>,
  ): Promise<AppointmentListItem> {
    await this.requireCrmStorage();
    const row = await this.requireVisible(tallerId, appointmentId);
    const schema = await readCrmCommercialSchema(this.appointments.manager);
    const attribution = parseAttribution(body);
    if (!attribution.ok) throw new BadRequestException(attribution.error);
    const touchesAttribution = ['campaignName', 'adName', 'adExternalId'].some(
      (key) => key in (body ?? {}),
    );
    let lines: ParsedServiceLine[] | null = null;
    if ('lines' in (body ?? {})) {
      const parsed = parseServiceLines(body.lines);
      if (!parsed.ok) throw new BadRequestException(parsed.error);
      lines = parsed.lines;
    }
    this.assertCommercialReady(
      schema,
      lines,
      touchesAttribution ? attribution.value.attributionKind : 'unknown',
    );
    if ('origin' in (body ?? {})) {
      const origin = String(body.origin ?? '').trim().toLowerCase();
      if (!isProspectOrigin(origin)) {
        throw new BadRequestException('Origen inválido.');
      }
      row.origin = origin;
    }
    await this.appointments.manager.transaction(async (manager) => {
      if (lines) {
        await this.replaceLines(manager, tallerId, row.id, lines, schema.snapshot);
        const summary = serviceSummary(lines);
        row.serviceRequested = summary;
        row.quoteSummary = summary;
        row.quotedAmount = lines.length
          ? pesosFromCents(lines.reduce((sum, line) => sum + line.subtotalCents, 0))
          : null;
      }
      if (lines || 'origin' in (body ?? {})) {
        await manager.getRepository(AppointmentEntity).save(row);
      }
      if (touchesAttribution && schema.attribution) {
        await this.writeAttribution(manager, tallerId, row.id, attribution.value);
      }
    });
    this.gateway.emitAppointmentUpdated(
      tallerId,
      toAppointmentRealtimePayload(tallerId, row),
    );
    return this.hydrate(row, {
      lines,
      campaignName: touchesAttribution ? attribution.value.campaignName : undefined,
      adName: touchesAttribution ? attribution.value.adName : undefined,
      adExternalId: touchesAttribution ? attribution.value.adExternalId : undefined,
      attributionKind: touchesAttribution
        ? attribution.value.attributionKind
        : undefined,
    });
  }

  private async distinctTexts(
    column: 'campaignName' | 'adName' | 'adExternalId',
    tallerId: string,
  ): Promise<string[]> {
    const rows = await this.appointments.manager.query(
      `
        SELECT DISTINCT "${column}" AS name
        FROM appointments
        WHERE "tallerId" = $1
          AND "${column}" IS NOT NULL
          AND btrim("${column}") <> ''
        ORDER BY 1
        LIMIT 30
      `,
      [tallerId],
    );
    return textNames(rows);
  }

  private async distinctServiceNames(tallerId: string): Promise<string[]> {
    const rows = await this.appointments.manager.query(
      `
        SELECT DISTINCT name
        FROM appointment_service_lines
        WHERE "tallerId" = $1 AND btrim(name) <> ''
        ORDER BY 1
        LIMIT 30
      `,
      [tallerId],
    );
    return textNames(rows);
  }

  private async requireCrmStorage(): Promise<void> {
    const storage = await readAppointmentStorage(this.appointments.manager);
    if (storage === 'ready') return;
    throw new ServiceUnavailableException(
      'Falta aplicar la migración CRM-001-A. El calendario sigue disponible.',
    );
  }

  private assertCommercialReady(
    schema: CrmCommercialSchema,
    lines: ParsedServiceLine[] | null,
    attributionKind: AttributionKind,
  ): void {
    if ((lines?.length ?? 0) > 0 && !schema.lines) {
      throw new ServiceUnavailableException(
        'Falta aplicar la migración CRM-008. El calendario sigue disponible.',
      );
    }
    if (attributionKind === 'manual' && !schema.attribution) {
      throw new ServiceUnavailableException(
        'Falta aplicar la migración CRM-008 para guardar la campaña y el anuncio.',
      );
    }
  }

  private async replaceLines(
    manager: EntityManager,
    tallerId: string,
    appointmentId: string,
    lines: ParsedServiceLine[],
    snapshotReady: boolean,
  ): Promise<void> {
    const repo = manager.getRepository(AppointmentServiceLine);
    const existing = await repo.find({
      where: { appointmentId, tallerId },
    });
    const keep = new Set(lines.map((line) => line.id));
    for (const row of existing) {
      if (keep.has(row.id)) continue;
      await repo.delete({ id: row.id, tallerId, appointmentId });
    }
    for (const [index, line] of lines.entries()) {
      const foreign = await repo.findOne({ where: { id: line.id } });
      if (
        foreign &&
        (foreign.appointmentId !== appointmentId || foreign.tallerId !== tallerId)
      ) {
        throw new BadRequestException('Ese servicio pertenece a otra cita.');
      }
      await repo.save(
        repo.create({
          id: line.id,
          appointmentId,
          tallerId,
          name: line.name,
          quantityHundredths: line.quantityHundredths,
          unitPriceCents: line.unitPriceCents,
          subtotalCents: line.subtotalCents,
          sortOrder: index,
        }),
      );
      if (snapshotReady) {
        await this.writeLineSnapshot(manager, tallerId, appointmentId, line);
      }
    }
  }

  private async writeLineSnapshot(
    manager: EntityManager,
    tallerId: string,
    appointmentId: string,
    line: ParsedServiceLine,
  ): Promise<void> {
    const updated = await manager.query(
      `
        UPDATE appointment_service_lines
        SET "catalogPieceCode" = $1,
            "tariffKind" = $2,
            "catalogOperations" = $3,
            "catalogMatrixRowId" = $4,
            "catalogUnitPriceCents" = $5
        WHERE id = $6
          AND "tallerId" = $7
          AND "appointmentId" = $8
        RETURNING id
      `,
      [
        line.catalogPieceCode,
        line.tariffKind,
        line.catalogOperations,
        line.catalogMatrixRowId,
        line.catalogUnitPriceCents,
        line.id,
        tallerId,
        appointmentId,
      ],
    );
    if (!Array.isArray(updated) || updated.length === 0) {
      throw new NotFoundException(`Servicio no encontrado: ${line.id}`);
    }
  }

  private async writeAttribution(
    manager: EntityManager,
    tallerId: string,
    appointmentId: string,
    input: {
      campaignName: string | null;
      adName: string | null;
      adExternalId: string | null;
      attributionKind: AttributionKind;
    },
  ): Promise<void> {
    const updated = await manager.query(
      `
        UPDATE appointments AS a
        SET "campaignName" = $1,
            "adName" = $2,
            "adExternalId" = $3,
            "attributionKind" = $4,
            "updatedAt" = now()
        WHERE a.id = $5
          AND (
            a."tallerId" = $6
            OR (
              a."tallerId" IS NULL
              AND EXISTS (
                SELECT 1
                FROM conversation c
                WHERE c.id = a."conversationId"
                  AND c."tallerId" = $6
              )
            )
          )
        RETURNING a.id
      `,
      [
        input.campaignName,
        input.adName,
        input.adExternalId,
        input.attributionKind,
        appointmentId,
        tallerId,
      ],
    );
    if (!Array.isArray(updated) || updated.length === 0) {
      throw new NotFoundException(`Cita no encontrada: ${appointmentId}`);
    }
  }

  private async hydrate(
    row: AppointmentEntity,
    extras?: {
      lines?: ParsedServiceLine[] | CrmServiceLine[] | null;
      campaignName?: string | null;
      adName?: string | null;
      adExternalId?: string | null;
      attributionKind?: AttributionKind;
    },
  ): Promise<AppointmentListItem> {
    const contract = await this.contracts.findOne({
      where: { appointmentId: row.id },
    });
    const schema = await readCrmCommercialSchema(this.appointments.manager);
    let lines: CrmServiceLine[] = extras?.lines ?? [];
    if (extras?.lines == null && schema.lines && row.tallerId) {
      const stored = await this.lines.find({
        where: { appointmentId: row.id, tallerId: row.tallerId },
      });
      lines = [...stored]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((line) => ({
          id: line.id,
          name: line.name,
          quantityHundredths: line.quantityHundredths,
          unitPriceCents: line.unitPriceCents,
          subtotalCents: line.subtotalCents,
        }));
    }
    const quotedTotalCents = lines.length
      ? lines.reduce((sum, line) => sum + line.subtotalCents, 0)
      : null;
    const storedAttribution = await this.readAttribution(row, schema.attribution, extras);
    return toAppointmentListItem(
      {
        ...row,
        campaignName: extras?.campaignName ?? storedAttribution.campaignName,
        adName: extras?.adName ?? storedAttribution.adName,
        adExternalId: extras?.adExternalId ?? storedAttribution.adExternalId,
        attributionKind: extras?.attributionKind ?? storedAttribution.attributionKind,
        lines,
        quotedTotalCents,
      },
      contract?.contractedAmount ?? null,
    );
  }

  private async readAttribution(
    row: AppointmentEntity,
    attributionReady: boolean,
    extras?: {
      campaignName?: string | null;
      adName?: string | null;
      adExternalId?: string | null;
      attributionKind?: AttributionKind;
    },
  ): Promise<{
    campaignName: string | null;
    adName: string | null;
    adExternalId: string | null;
    attributionKind: AttributionKind | null;
  }> {
    const empty = {
      campaignName: null,
      adName: null,
      adExternalId: null,
      attributionKind: null as AttributionKind | null,
    };
    if (
      !attributionReady ||
      !row.id ||
      (extras?.campaignName !== undefined &&
        extras?.adName !== undefined &&
        extras?.adExternalId !== undefined &&
        extras?.attributionKind !== undefined)
    ) {
      return empty;
    }
    const rows = await this.appointments.manager.query(
      `
        SELECT
          a."campaignName" AS "campaignName",
          a."adName" AS "adName",
          a."adExternalId" AS "adExternalId",
          a."attributionKind" AS "attributionKind"
        FROM appointments a
        WHERE a.id = $1
          AND (
            a."tallerId" = $2
            OR (
              a."tallerId" IS NULL
              AND EXISTS (
                SELECT 1
                FROM conversation c
                WHERE c.id = a."conversationId"
                  AND c."tallerId" = $2
              )
            )
          )
      `,
      [row.id, row.tallerId],
    );
    const found = Array.isArray(rows) ? rows[0] : null;
    if (!found || typeof found !== 'object') return empty;
    const record = found as Record<string, unknown>;
    const kind = record.attributionKind;
    return {
      campaignName: textOrNull(record.campaignName),
      adName: textOrNull(record.adName),
      adExternalId: textOrNull(record.adExternalId),
      attributionKind:
        kind === 'manual' || kind === 'verified' || kind === 'unknown' ? kind : null,
    };
  }

  private async requireVisible(
    tallerId: string,
    appointmentId: string,
  ): Promise<AppointmentEntity> {
    const row = await this.appointments.findOne({
      where: { id: appointmentId },
      relations: ['conversation'],
    });
    if (
      !row ||
      !isAppointmentVisibleToTaller(
        row,
        row.conversation ? { tallerId: row.conversation.tallerId } : null,
        tallerId,
      )
    ) {
      throw new NotFoundException(`Cita no encontrada: ${appointmentId}`);
    }
    return row;
  }

  private async findActiveDuplicate(
    tallerId: string,
    phone: string,
    scheduledAt: Date,
    manager: EntityManager = this.appointments.manager,
  ): Promise<AppointmentEntity | null> {
    const rows = await manager.getRepository(AppointmentEntity).find({
      where: { tallerId, phone, scheduledAt },
    });
    return (
      rows.find(
        (row) => row.status === 'confirmada' || row.status === 'pendiente',
      ) ?? null
    );
  }

  private async reuseOrCreateContact(
    tallerId: string,
    input: ParsedManualAppointment,
  ): Promise<Contact> {
    const externalId = crmContactExternalId(input.phone);
    const byKey = await this.contacts.findOne({
      where: { tallerId, externalId },
    });
    const existing = byKey ?? (await this.findContactByPhone(tallerId, input.phone));
    if (existing) {
      let dirty = false;
      if (!isUsableAppointmentClientName(existing.contactName)) {
        existing.contactName = input.clientName.slice(0, 255);
        dirty = true;
      }
      if (!String(existing.phone ?? '').trim()) {
        existing.phone = input.phone;
        dirty = true;
      }
      return dirty ? this.contacts.save(existing) : existing;
    }

    const created = this.contacts.create({
      tallerId,
      externalId,
      contactName: input.clientName.slice(0, 255),
      phone: input.phone,
      avatarUrl: null,
      platform: 'crm',
    });
    try {
      return await this.contacts.save(created);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const again = await this.contacts.findOne({
        where: { tallerId, externalId },
      });
      if (!again) throw err;
      return again;
    }
  }

  private async findContactByPhone(
    tallerId: string,
    phone: string,
  ): Promise<Contact | null> {
    const suffix = phoneSuffix(phone);
    if (suffix.length < 8) return null;
    return this.contacts
      .createQueryBuilder('c')
      .where('c.tallerId = :tallerId', { tallerId })
      .andWhere(
        `right(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g'), 10) = :suffix`,
        { suffix },
      )
      .getOne();
  }
}

function textOrNull(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function textNames(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => String((row as { name?: string }).name ?? '').trim())
    .filter(Boolean);
}

function optionalNote(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, 2000) : null;
}
