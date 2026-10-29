import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ManualAppointmentService } from './manual-appointment.service';
import type { AppointmentEntity } from './entities/appointment.entity';
import type { Contact } from './entities/contact.entity';
import type { ContractedWork } from './entities/contracted-work.entity';
import type { AppointmentEntity } from './entities/appointment.entity';
import type { AppointmentServiceLine } from './entities/appointment-service-line.entity';

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
    async delete(where: Record<string, unknown>) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (matches(rows[index] as Record<string, unknown>, where)) rows.splice(index, 1);
      }
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
      query: jest.fn(async (sql: string) => {
        if (String(sql).includes('information_schema')) {
          return [{ hasTaller: true, hasContracts: true }];
        }
        return [];
      }),
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
    const lines = repo<AppointmentServiceLine>([]);
    appointments.manager.getRepository = (entity: { name?: string }) =>
      entity?.name === 'AppointmentServiceLine' ? lines : appointments;
    appointments.manager.transaction = async (fn: (manager: unknown) => Promise<unknown>) => {
      const snapAppointments = appointments.rows.map((row) => ({ ...row }));
      const snapLines = lines.rows.map((row) => ({ ...row }));
      try {
        return await fn({
          getRepository(entity: { name?: string }) {
            return entity?.name === 'AppointmentServiceLine' ? lines : appointments;
          },
          query: appointments.manager.query,
        });
      } catch (err) {
        appointments.rows.splice(0, appointments.rows.length, ...snapAppointments);
        lines.rows.splice(0, lines.rows.length, ...snapLines);
        throw err;
      }
    };
    const gateway = {
      emitAppointmentCreated: jest.fn(),
      emitAppointmentUpdated: jest.fn(),
    };
    const service = new ManualAppointmentService(
      appointments as never,
      contacts as never,
      contracts as never,
      lines as never,
      gateway as never,
    );
    return { service, appointments, contacts, contracts, lines, gateway };
  }

  it('no escribe una cita manual si la migración todavía no está', async () => {
    const { service, appointments } = build();
    (appointments.manager.query as jest.Mock).mockResolvedValueOnce([
      { hasTaller: false, hasContracts: false },
    ]);
    await expect(
      service.create('taller-a', 'user-1', request),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(appointments.rows).toHaveLength(0);
  });

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

  it('cotiza uno y varios servicios en centavos, y el contratado sigue aparte', async () => {
    const { service, lines, contracts, appointments } = build();
    enableCommercial(appointments);
    const saved = await service.create('taller-a', 'user-1', {
      ...request,
      quotedAmount: 1,
      lines: [
        { name: 'Pintura de salpicadera', quantityHundredths: 100, unitPriceCents: 450000 },
        { name: 'Pulido', quantityHundredths: 200, unitPriceCents: 15000 },
      ],
    });
    expect(saved.lines).toHaveLength(2);
    expect(saved.quotedTotalCents).toBe(480000);
    expect(saved.quotedAmount).toBe(4800);
    expect(saved.serviceRequested).toContain('Pintura de salpicadera');
    expect(lines.rows).toHaveLength(2);

    const edited = await service.saveCommercial('taller-a', saved.id, {
      lines: [
        {
          id: saved.lines[0].id,
          name: 'Pintura de salpicadera',
          quantityHundredths: 101,
          unitPriceCents: 333,
        },
      ],
    });
    expect(edited.lines).toHaveLength(1);
    expect(edited.lines[0].subtotalCents).toBe(336);
    expect(lines.rows).toHaveLength(1);
    const contract = await service.upsertContract('taller-a', saved.id, {
      contractedAmount: 3200,
    });
    expect(contract.contractedAmount).toBe(3200);
    expect(contract.quotedAmount).toBe(3);
    expect(contracts.rows[0].contractedAmount).not.toBe(edited.quotedTotalCents);
    await expect(
      service.saveCommercial('taller-b', saved.id, { campaignName: 'Ajena' }),
    ).rejects.toThrow(/no encontrada/i);
  });

  it('revierte la cita completa si falla un concepto', async () => {
    const { service, appointments, lines } = build();
    enableCommercial(appointments);
    const original = lines.save.bind(lines);
    let writes = 0;
    lines.save = async (input: AppointmentServiceLine) => {
      writes += 1;
      if (writes === 2) throw new Error('fallo de disco');
      return original(input);
    };
    await expect(
      service.create('taller-a', 'user-1', {
        ...request,
        lines: [
          { name: 'Pintura', quantityHundredths: 100, unitPriceCents: 450000 },
          { name: 'Pulido', quantityHundredths: 100, unitPriceCents: 15000 },
        ],
      }),
    ).rejects.toThrow(/fallo de disco/);
    expect(appointments.rows).toHaveLength(0);
    expect(lines.rows).toHaveLength(0);
  });

  it('no pisa el desglose anterior si la edición falla', async () => {
    const { service, appointments, lines } = build();
    enableCommercial(appointments);
    const saved = await service.create('taller-a', 'user-1', {
      ...request,
      lines: [
        { name: 'Pintura', quantityHundredths: 100, unitPriceCents: 450000 },
      ],
    });
    lines.save = async () => {
      throw new Error('fallo al editar');
    };
    await expect(
      service.saveCommercial('taller-a', saved.id, {
        lines: [
          { name: 'Pulido', quantityHundredths: 100, unitPriceCents: 15000 },
          { name: 'Cerámico', quantityHundredths: 100, unitPriceCents: 80000 },
        ],
      }),
    ).rejects.toThrow(/fallo al editar/);
    expect(lines.rows).toHaveLength(1);
    expect(lines.rows[0].name).toBe('Pintura');
    expect(appointments.rows[0].quotedAmount).toBe(4500);
  });

  it('deja la cita anterior sin desglose y sin anuncio inventado', async () => {
    const { service, lines } = build();
    const saved = await service.create('taller-a', 'user-1', request);
    expect(saved.lines).toEqual([]);
    expect(saved.quotedAmount).toBe(4500);
    expect(saved.campaignName).toBeNull();
    expect(saved.attributionKind).toBe('unknown');
    expect(lines.rows).toHaveLength(0);
  });

  it('no acepta atribución verificada ni guarda campaña sin la migración', async () => {
    const { service, appointments } = build();
    await expect(
      service.create('taller-a', 'user-1', {
        ...request,
        attributionKind: 'verified',
        campaignName: 'Primavera',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create('taller-a', 'user-1', {
        ...request,
        clientRequestId: 'crm-req-0002',
        scheduledAtIso: '2026-05-26T15:00:00',
        campaignName: 'Primavera',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(appointments.rows).toHaveLength(0);
  });

  it('rechaza reparar y montar la misma pieza sin guardar la cita', async () => {
    const { service, appointments, lines } = build();
    enableCommercial(appointments);
    await expect(
      service.create('taller-a', 'user-1', {
        ...request,
        lines: [
          {
            name: 'Salpicadera izquierda',
            quantityHundredths: 100,
            unitPriceCents: 450000,
            catalogPieceCode: 'SI',
            catalogOperations: 'reparar+montar',
            tariffKind: 'manual',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(appointments.rows).toHaveLength(0);
    expect(lines.rows).toHaveLength(0);
  });

  it('no mueve un servicio al taller contrario', async () => {
    const { service, appointments } = build();
    enableCommercial(appointments);
    const saved = await service.create('taller-a', 'user-1', {
      ...request,
      lines: [
        { id: '11111111-1111-4111-8111-111111111111', name: 'Baño de pintura', quantityHundredths: 100, unitPriceCents: 10000 },
      ],
    });
    const other = await service.create('taller-a', 'user-1', {
      ...request,
      clientRequestId: 'crm-req-0008',
      phone: '5588888888',
      scheduledAtIso: '2026-05-27T11:00:00',
    });
    await expect(
      service.saveCommercial('taller-a', other.id, {
        lines: [
          {
            id: saved.lines[0].id,
            name: 'Baño de pintura',
            quantityHundredths: 100,
            unitPriceCents: 10000,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

function enableCommercial(appointments: {
  manager: { query: jest.Mock };
}) {
  appointments.manager.query.mockImplementation(async (sql: string) => {
    if (String(sql).includes('UPDATE appointments')) {
      return [{ id: 'updated' }];
    }
    if (String(sql).includes('campaignName')) {
      return [{ hasAttribution: true, hasLines: true }];
    }
    if (String(sql).includes('information_schema')) {
      return [{ hasTaller: true, hasContracts: true }];
    }
    return [];
  });
}
