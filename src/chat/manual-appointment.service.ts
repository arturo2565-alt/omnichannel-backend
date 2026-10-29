import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Contact } from './entities/contact.entity';
import { AppointmentEntity } from './entities/appointment.entity';
import { ContractedWork } from './entities/contracted-work.entity';
import { ChatGateway } from './chat.gateway';
import { listAppointmentsForTaller } from './appointment-directory';
import {
  composeVehicleLabel,
  crmContactExternalId,
  isAppointmentVisibleToTaller,
  isUniqueViolation,
  parseContractedAmount,
  parseManualAppointmentInput,
  phoneSuffix,
  toAppointmentListItem,
  toAppointmentRealtimePayload,
  type AppointmentListItem,
  type ParsedManualAppointment,
} from './crm-appointment';
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
    private readonly gateway: ChatGateway,
  ) {}

  listManual(tallerId: string): Promise<AppointmentListItem[]> {
    return listAppointmentsForTaller(this.appointments.manager, tallerId, {
      source: 'manual',
    });
  }

  async create(
    tallerId: string,
    userId: string,
    body: Record<string, unknown>,
  ): Promise<AppointmentListItem> {
    const parsed = parseManualAppointmentInput(body ?? {});
    if (!parsed.ok) throw new BadRequestException(parsed.error);
    const input = parsed.value;

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
      const saved = await this.appointments.save(row);
      this.gateway.emitAppointmentCreated(
        tallerId,
        toAppointmentRealtimePayload(tallerId, saved),
      );
      return this.hydrate(saved);
    } catch (err) {
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

  private async hydrate(row: AppointmentEntity): Promise<AppointmentListItem> {
    const contract = await this.contracts.findOne({
      where: { appointmentId: row.id },
    });
    return toAppointmentListItem(row, contract?.contractedAmount ?? null);
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
  ): Promise<AppointmentEntity | null> {
    const rows = await this.appointments.find({
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

function optionalNote(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, 2000) : null;
}
