import { ConflictException } from '@nestjs/common';
import { ManualAppointmentService } from './manual-appointment.service';
import type { AppointmentEntity } from './entities/appointment.entity';
import type { Contact } from './entities/contact.entity';
import type { ContractedWork } from './entities/contracted-work.entity';

function matches(row: Record<string, unknown>, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, value]) => {
    if (value instanceof Date) {
      const current = row[key];
      return current instanceof Date && current.getTime() === value.getTime();
    }
    return row[key] === value;
  });
}

function repo<T extends { id?: string }>(rows: T[]) {
  return {
    rows,
    create(input: T) {
      return { ...input };
    },
    async save(input: T) {
      const id = input.id ?? `id-${rows.length + 1}`;
      const stored = { ...input, id } as T;
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) rows[index] = stored;
      else rows.push(stored);
      return stored;
    },
    async findOne(opts: { where: Record<string, unknown> }) {
      return rows.find((row) => matches(row as Record<string, unknown>, opts.where)) ?? null;
    },
    async find(opts: { where: Record<string, unknown> }) {
      return rows.filter((row) => matches(row as Record<string, unknown>, opts.where));
    },
    createQueryBuilder() {
      const state = { suffix: '' };
      const qb = {
        where() {
          return qb;
        },
        andWhere(_sql: string, params?: { suffix?: string }) {
          state.suffix = params?.suffix ?? '';
          return qb;
        },
        async getOne() {
          return (
            rows.find((row) => {
              const phone = String((row as { phone?: string }).phone ?? '').replace(/\D/g, '');
              return phone.endsWith(state.suffix);
            }) ?? null
          );
        },
      };
      return qb;
    },
    manager: {
      query: jest.fn(async () => []),
    },
  };
}

describe('ManualAppointmentService', () => {
  const when = '2026-05-26T14:00:00';
  const request = {
    clientRequestId: 'crm-req-0001',
    clientName: 'Ana López',
    phone: '5512345678',
    vehicleMake: 'Nissan',
    vehicleModel: 'Versa',
    vehicleYear: 2019,
    serviceRequested: 'Pintura',
    quotedAmount: 4500,
    origin: 'instagram',
    scheduledAtIso: when,
  };

  function build() {
    const appointments = repo<AppointmentEntity>([]);
    const contacts = repo<Contact>([]);
    const contracts = repo<ContractedWork>([]);
    const gateway = {
      emitAppointmentCreated: jest.fn(),
      emitAppointmentUpdated: jest.fn(),
    };
    const service = new ManualAppointmentService(
      appointments as never,
      contacts as never,
      contracts as never,
      gateway as never,
    );
    return { service, appointments, contacts, contracts, gateway };
  }

  it('persiste una cita manual sin conversación y sin trabajo contratado', async () => {
    const { service, appointments, contacts, contracts, gateway } = build();
    const saved = await service.create('taller-a', 'user-1', request);

    expect(saved.conversationId).toBeNull();
    expect(saved.tallerId).toBe('taller-a');
    expect(saved.contactId).toBeTruthy();
    expect(saved.quotedAmount).toBe(4500);
    expect(saved.contractedAmount).toBeNull();
    expect(saved.visitStatus).toBe('agendada');
    expect(saved.status).toBe('confirmada');
    expect(appointments.rows).toHaveLength(1);
    expect(appointments.rows[0].source).toBe('manual');
    expect(contacts.rows[0].tallerId).toBe('taller-a');
    expect(contacts.rows[0].platform).toBe('crm');
    expect(contracts.rows).toHaveLength(0);
    expect(gateway.emitAppointmentCreated).toHaveBeenCalledWith(
      'taller-a',
      expect.objectContaining({ tallerId: 'taller-a', id: saved.id }),
    );
  });

  it('reutiliza el contacto del mismo teléfono y no duplica el doble envío', async () => {
    const { service, appointments, contacts } = build();
    const first = await service.create('taller-a', 'user-1', request);
    const second = await service.create('taller-a', 'user-1', request);

    expect(second.id).toBe(first.id);
    expect(appointments.rows).toHaveLength(1);
    expect(contacts.rows).toHaveLength(1);
  });

  it('rechaza otra captura activa del mismo teléfono y horario', async () => {
    const { service } = build();
    await service.create('taller-a', 'user-1', request);
    await expect(
      service.create('taller-a', 'user-1', {
        ...request,
        clientRequestId: 'crm-req-0002',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('no deja ver ni contratar la cita de otro taller', async () => {
    const { service } = build();
    const saved = await service.create('taller-a', 'user-1', request);
    await expect(
      service.upsertContract('taller-b', saved.id, { contractedAmount: 3000 }),
    ).rejects.toThrow(/no encontrada/i);
  });

  it('guarda el contratado aparte y conserva el cotizado', async () => {
    const { service, appointments, contracts } = build();
    const saved = await service.create('taller-a', 'user-1', request);
    const contract = await service.upsertContract('taller-a', saved.id, {
      contractedAmount: 3200,
    });

    expect(contract.contractedAmount).toBe(3200);
    expect(contract.quotedAmountSnapshot).toBe(4500);
    expect(contract.quotedAmount).toBe(4500);
    expect(appointments.rows[0].quotedAmount).toBe(4500);
    expect(appointments.rows[0].status).toBe('confirmada');
    expect(contracts.rows).toHaveLength(1);
    expect(contracts.rows[0].tallerId).toBe('taller-a');
  });
});
