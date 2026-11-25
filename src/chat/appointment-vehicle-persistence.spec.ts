jest.mock('@nestjs/bullmq', () => ({
  Processor: () => () => undefined,
  WorkerHost: class WorkerHost {},
  InjectQueue: () => () => undefined,
}));

jest.mock('bullmq', () => ({
  UnrecoverableError: class UnrecoverableError extends Error {},
}));

import { randomUUID } from 'crypto';
import { ChatService } from './chat.service';
import { STAGING_TALLER_ID } from '../config/staging-synthetic';
import { toAppointmentRealtimePayload } from './crm-appointment';
import { workshopNaiveIsoFromUtc } from './appointment-scheduling-helpers';

const owner = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'dueno@ensayo.test',
  tallerId: STAGING_TALLER_ID,
  role: 'owner' as const,
};

function photo(mark: number): string {
  return `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, mark]).toString('base64')}`;
}

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === 'object' && '_value' in value) {
      const expected = (value as { _value: unknown })._value;
      return Array.isArray(expected) && expected.includes(row[key]);
    }
    return row[key] === value;
  });
}

function memoryRepo<T extends { id?: string }>(rows: T[]) {
  return {
    rows,
    create: (entity: T) => ({ ...entity }),
    save: async (entity: T) => {
      const row = { ...entity } as T;
      if (!row.id) row.id = randomUUID();
      const index = rows.findIndex((item) => item.id === row.id);
      if (index >= 0) rows[index] = row;
      else rows.push(row);
      return row;
    },
    findOne: async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((row) => matchesWhere(row as Record<string, unknown>, where)) ?? null,
    find: async ({
      where,
      order,
      take,
    }: {
      where: Record<string, unknown>;
      order?: Record<string, 'ASC' | 'DESC'>;
      take?: number;
    }) => {
      let found = rows.filter((row) => matchesWhere(row as Record<string, unknown>, where));
      const scheduled = order?.scheduledAt;
      const created = order?.createdAt;
      if (scheduled || created) {
        const key = scheduled ? 'scheduledAt' : 'createdAt';
        const direction = scheduled ?? created;
        found = [...found].sort((a, b) => {
          const left = new Date(String((a as Record<string, unknown>)[key] ?? 0)).getTime();
          const right = new Date(String((b as Record<string, unknown>)[key] ?? 0)).getTime();
          return direction === 'DESC' ? right - left : left - right;
        });
      }
      return take ? found.slice(0, take) : found;
    },
    update: async (
      criteria: { id?: string },
      partial: Record<string, unknown>,
    ) => {
      const row = rows.find((item) => item.id === criteria?.id);
      if (!row) return { affected: 0 };
      Object.assign(row, partial);
      return { affected: 1 };
    },
    createQueryBuilder: () => {
      const qb = {
        where: () => qb,
        andWhere: () => qb,
        orderBy: () => qb,
        getOne: async () => null,
      };
      return qb;
    },
    manager: {
      query: async () => [{ hasTaller: true, hasContracts: true }],
    },
  };
}

function harness() {
  const conversations = memoryRepo<Record<string, any>>([]);
  const contacts = memoryRepo<Record<string, any>>([]);
  const messages = memoryRepo<Record<string, any>>([]);
  const appointments = memoryRepo<Record<string, any>>([]);
  const emitted: unknown[] = [];
  const service = Object.create(ChatService.prototype) as ChatService;
  const autoPilot = jest.fn();
  Object.assign(service, {
    conversationRepository: conversations,
    contactRepository: contacts,
    messageRepository: messages,
    appointmentRepository: appointments,
    draftQuoteRepository: { findOne: async () => null },
    conversationFindOrCreateInflight: new Map(),
    consolidatedVisionInFlight: new Set(),
    inboundStickerPersistInflight: new Map(),
    leadEventsService: { logTransition: jest.fn().mockResolvedValue(undefined) },
    chatGateway: {
      emitNewMessage: jest.fn(),
      emitAppointmentCreated: jest.fn((_tallerId: string, payload: unknown) => {
        emitted.push(payload);
      }),
      emitConversationLeadUpdated: jest.fn(),
    },
    incomingMessageProducer: {
      enqueueMessage: jest.fn().mockResolvedValue(undefined),
      hasBufferedImages: jest.fn().mockResolvedValue(false),
    },
    outgoingMessageProducer: { enqueueOutboundMessage: jest.fn() },
    quoteCartService: {
      resolveActiveCart: jest.fn().mockResolvedValue(null),
      getActiveCart: jest.fn().mockResolvedValue(null),
    },
    tallerService: {
      findDefaultTallerId: jest.fn().mockResolvedValue(STAGING_TALLER_ID),
      findById: jest.fn(async () => ({
        id: STAGING_TALLER_ID,
        nombre: 'Taller de ensayo',
      })),
    },
    getRecentImages: jest.fn().mockResolvedValue([]),
    buildVisionTextHistoryForConversation: jest.fn().mockResolvedValue([]),
    analyzeDamageImageInSequentialChunks: jest.fn(),
    autoPilotSendTextReply: autoPilot,
  });
  return { service, conversations, messages, appointments, emitted, autoPilot };
}

function draftOf(conversations: { rows: Record<string, any>[] }, id: string) {
  return conversations.rows.find((row) => row.id === id)?.appointmentDraft;
}

function labEnv(): NodeJS.ProcessEnv {
  return {
    PEGAZUZ_ENV: 'staging',
    STAGING_SANDBOX: 'on',
    STAGING_WHATSAPP_PHONE_NUMBER_ID: 'phone-ensayo-100',
    STAGING_WHATSAPP_BUSINESS_ACCOUNT_ID: 'waba-ensayo-100',
    STAGING_WHATSAPP_ACCESS_TOKEN: 'staging-access-token-ensayo',
    STAGING_WHATSAPP_VERIFY_TOKEN: 'staging-verify-token-ensayo',
    STAGING_WHATSAPP_APP_SECRET: 'staging-app-secret-ensayo',
    STAGING_WHATSAPP_NUMBER: '5215550100099',
    STAGING_WHATSAPP_ALLOWLIST: '5215550100001',
    STAGING_OPENAI_API_KEY: 'staging-openai-key-ensayo',
    STAGING_OPENAI_MAX_REQUESTS: '2',
    STAGING_OPENAI_MAX_TOTAL_TOKENS: '100',
    OPENAI_API_KEY: 'other-openai-key-ensayo',
    WHATSAPP_PHONE_NUMBER_ID: 'phone-production-999',
    WHATSAPP_NUMBER: '5215550190000',
  };
}

describe('PEG-032F persistencia del vehículo declarado', () => {
  const previous = process.env;

  beforeEach(() => {
    process.env = labEnv();
  });

  afterEach(() => {
    process.env = previous;
  });

  it('lleva Es un Mazda 2 2024 hasta la cita aunque la visión no deje correr el autopilot', async () => {
    const { service, conversations, messages, appointments, emitted, autoPilot } = harness();
    const created = await service.createLabConversation(owner, {});
    await service.appendLabTurn(
      created.id,
      { images: [photo(1)], idempotencyKey: '66666666-6666-4666-8666-666666666661' },
      owner,
    );
    await service.appendLabTurn(
      created.id,
      {
        text: 'Es un Mazda 2 2024',
        idempotencyKey: '66666666-6666-4666-8666-666666666662',
      },
      owner,
    );

    expect(draftOf(conversations, created.id)?.vehicleIdentity).toMatchObject({
      value: 'Mazda 2 2024',
      source: 'client',
      confirmed: true,
    });

    conversations.rows[0].appointmentDraft = null;
    await (service as any).processDebouncedAutopilotTextReply(created.id);
    expect(autoPilot).not.toHaveBeenCalled();
    expect(draftOf(conversations, created.id)?.vehicleIdentity).toMatchObject({
      value: 'Mazda 2 2024',
      source: 'client',
      confirmed: true,
    });

    conversations.rows[0].appointmentDraft = null;
    (service as any).analyzeDamageImageInSequentialChunks.mockRejectedValue(
      new Error('vision de ensayo'),
    );
    const image = messages.rows.find((row) => String(row.content).startsWith('data:image'));
    await expect(
      service.processQueuedInboundBurst({
        conversationId: created.id,
        tallerId: STAGING_TALLER_ID,
        channel: 'lab',
        items: [
          { kind: 'image', content: image.content, messageId: image.id },
          { kind: 'text', content: 'Es un Mazda 2 2024', messageId: 'declaracion' },
        ],
      }),
    ).rejects.toThrow('vision de ensayo');
    expect(draftOf(conversations, created.id)?.vehicleIdentity).toMatchObject({
      value: 'Mazda 2 2024',
      source: 'client',
      confirmed: true,
    });

    const conversation = conversations.rows[0];
    await (service as any).rememberDeclaredAppointmentContext(
      conversation,
      'Si, me gustaria agendar para mañana a las 10:00 am',
    );
    await (service as any).rememberDeclaredAppointmentContext(conversation, 'Ana Ensayo');
    await (service as any).rememberDeclaredAppointmentContext(conversation, '5512345678');
    const ready = draftOf(conversations, created.id);
    expect(ready.requestedDateTime).toEqual(expect.any(String));
    expect(ready.clientName.value).toBe('Ana Ensayo');
    expect(ready.phone.value).toBe('5512345678');

    const saved = await (service as any).executeCreateAppointmentTool(
      JSON.stringify({
        dateTime: workshopNaiveIsoFromUtc(new Date(ready.requestedDateTime)),
        clientName: 'Ana Ensayo',
        phone: '5512345678',
        vehicleInfo: 'hatchback claro',
      }),
      conversations.rows.find((row) => row.id === created.id),
    );

    expect(saved).toMatchObject({ success: true, persisted: true });
    expect(appointments.rows).toHaveLength(1);
    expect(appointments.rows[0]).toMatchObject({
      clientName: 'Ana Ensayo',
      phone: '5512345678',
      vehicle: 'Mazda 2 2024',
      status: 'confirmada',
      source: 'autopilot',
      conversationId: created.id,
    });
    expect(conversations.rows.find((row) => row.id === created.id)).toMatchObject({
      status: 'agendado',
    });
    expect(draftOf(conversations, created.id)).toMatchObject({
      appointmentStatus: 'confirmed',
      vehicleIdentity: { value: 'Mazda 2 2024', source: 'client', confirmed: true },
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual(
      toAppointmentRealtimePayload(STAGING_TALLER_ID, appointments.rows[0] as any),
    );
    expect(emitted[0]).toMatchObject({
      vehicle: 'Mazda 2 2024',
      clientName: 'Ana Ensayo',
      phone: '5512345678',
      status: 'confirmada',
    });

    const repeat = await (service as any).executeCreateAppointmentTool(
      JSON.stringify({
        dateTime: workshopNaiveIsoFromUtc(new Date(ready.requestedDateTime)),
        clientName: 'Ana Ensayo',
        phone: '5512345678',
        vehicleInfo: 'hatchback claro',
      }),
      conversations.rows.find((row) => row.id === created.id),
    );
    expect(repeat).toMatchObject({ success: true, unchanged: true, persisted: true });
    expect(appointments.rows).toHaveLength(1);
  });

  it('corrige el año declarado y no deja que la visión lo reemplace', async () => {
    const { service, conversations, appointments } = harness();
    const created = await service.createLabConversation(owner, {});
    await service.appendLabTurn(
      created.id,
      {
        text: 'Es un Mazda 2 2024',
        idempotencyKey: '77777777-7777-4777-8777-777777777771',
      },
      owner,
    );
    const conversation = () => conversations.rows.find((row) => row.id === created.id);
    await (service as any).rememberDeclaredAppointmentContext(
      conversation(),
      'Perdón, es 2023',
    );
    expect(draftOf(conversations, created.id)?.vehicleIdentity).toMatchObject({
      value: 'Mazda 2 2023',
      source: 'client',
      confirmed: true,
    });
    await (service as any).rememberDeclaredAppointmentContext(
      conversation(),
      'Mañana a las 10',
    );
    await (service as any).rememberDeclaredAppointmentContext(conversation(), 'Ana Ensayo');
    await (service as any).rememberDeclaredAppointmentContext(conversation(), '5512345678');
    const when = workshopNaiveIsoFromUtc(
      new Date(draftOf(conversations, created.id).requestedDateTime),
    );
    await (service as any).executeCreateAppointmentTool(
      JSON.stringify({
        dateTime: when,
        clientName: 'Ana Ensayo',
        phone: '5512345678',
        vehicleInfo: 'Mazda visto en foto',
      }),
      conversation(),
    );
    expect(appointments.rows[0].vehicle).toBe('Mazda 2 2023');
    expect(toAppointmentRealtimePayload(STAGING_TALLER_ID, appointments.rows[0] as any).vehicle).toBe(
      'Mazda 2 2023',
    );
  });

  it('serializa escrituras concurrentes y no pisa el resto de la conversación', async () => {
    const { service, conversations } = harness();
    const created = await service.createLabConversation(owner, {});
    const row = conversations.rows.find((item) => item.id === created.id)!;
    row.status = 'agendado';
    row.isAutoPilotActive = true;
    let reads = 0;
    const originalFind = conversations.findOne;
    conversations.findOne = async (query: { where: Record<string, unknown> }) => {
      const found = await originalFind(query);
      if (query?.where?.id !== created.id) return found;
      reads += 1;
      if (reads === 1) await new Promise((resolve) => setTimeout(resolve, 25));
      return found;
    };
    let updates = 0;
    const originalUpdate = conversations.update;
    conversations.update = async (
      criteria: { id?: string },
      partial: Record<string, unknown>,
    ) => {
      updates += 1;
      return originalUpdate(criteria, partial);
    };

    const staleVehicle = {
      ...row,
      status: 'nuevo',
      isAutoPilotActive: false,
      appointmentDraft: null,
    };
    const staleName = {
      ...row,
      status: 'cerrado',
      isAutoPilotActive: false,
      appointmentDraft: null,
    };
    await Promise.all([
      (service as any).rememberDeclaredAppointmentContext(
        staleVehicle,
        'Es un Mazda 2 2024',
      ),
      (service as any).rememberDeclaredAppointmentContext(staleName, 'Ana Ensayo'),
    ]);

    expect(row.status).toBe('agendado');
    expect(row.isAutoPilotActive).toBe(true);
    expect(row.appointmentDraft.vehicleIdentity).toMatchObject({
      value: 'Mazda 2 2024',
      source: 'client',
      confirmed: true,
    });
    expect(row.appointmentDraft.clientName.value).toBe('Ana Ensayo');
    const written = updates;
    await (service as any).rememberDeclaredAppointmentContext(
      row,
      'Es un Mazda 2 2024',
    );
    expect(updates).toBe(written);
  });
});
