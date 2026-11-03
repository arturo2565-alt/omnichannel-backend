jest.mock('@nestjs/bullmq', () => ({
  Processor: () => () => undefined,
  WorkerHost: class WorkerHost {},
  InjectQueue: () => () => undefined,
}));

jest.mock('bullmq', () => ({
  UnrecoverableError: class UnrecoverableError extends Error {},
}));

import { randomUUID } from 'crypto';
import axios from 'axios';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { LabController, LabVisibilityGuard } from './lab.controller';
import {
  createLabExternalId,
  labAccess,
  labRouteVisibility,
  parseLabTurn,
} from './lab-channel';
import { decideStagingInboundJob, decideStagingOutbound } from '../config/staging-sandbox';
import { STAGING_TALLER_ID } from '../config/staging-synthetic';
import { IncomingMessageWorker } from '../messaging-queue/incoming-message.worker';
import { OutgoingMessageProducer } from '../messaging-queue/outgoing-message.producer';
import { OutgoingMessageWorker } from '../messaging-queue/outgoing-message.worker';
import { renderDeterministicCta } from './client-message-ux';
import type { ClientQuoteMessageContext } from './client-message-ux';
import { extractLatestDeclaredVehicleIdentity } from '../domain/peritaje-v1/declared-vehicle-identity';
import { pegLogger } from '../observability/pegazuz-logger';

const ALLOWED = '5215550100001';

function completeEnv(): NodeJS.ProcessEnv {
  return {
    PEGAZUZ_ENV: 'staging',
    STAGING_SANDBOX: 'on',
    STAGING_WHATSAPP_PHONE_NUMBER_ID: 'phone-ensayo-100',
    STAGING_WHATSAPP_BUSINESS_ACCOUNT_ID: 'waba-ensayo-100',
    STAGING_WHATSAPP_ACCESS_TOKEN: 'staging-access-token-ensayo',
    STAGING_WHATSAPP_VERIFY_TOKEN: 'staging-verify-token-ensayo',
    STAGING_WHATSAPP_APP_SECRET: 'staging-app-secret-ensayo',
    STAGING_WHATSAPP_NUMBER: '5215550100099',
    STAGING_WHATSAPP_ALLOWLIST: ALLOWED,
    STAGING_OPENAI_API_KEY: 'staging-openai-key-ensayo',
    STAGING_OPENAI_MAX_REQUESTS: '2',
    STAGING_OPENAI_MAX_TOTAL_TOKENS: '100',
    OPENAI_API_KEY: 'other-openai-key-ensayo',
    WHATSAPP_PHONE_NUMBER_ID: 'phone-production-999',
    WHATSAPP_NUMBER: '5215550190000',
  };
}

const owner = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'dueno@ensayo.test',
  tallerId: STAGING_TALLER_ID,
  role: 'owner' as const,
};

function dataUrl(kind: 'jpeg' | 'png' | 'webp', mark: number): string {
  const extra = Buffer.from([mark]);
  const bytes =
    kind === 'jpeg'
      ? Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), extra])
      : kind === 'png'
        ? Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            extra,
          ])
        : Buffer.concat([
            Buffer.from('RIFF'),
            Buffer.from([0, 0, 0, 0]),
            Buffer.from('WEBP'),
            extra,
          ]);
  const mime = kind === 'jpeg' ? 'jpeg' : kind;
  return `data:image/${mime};base64,${bytes.toString('base64')}`;
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
      rows.find((row) =>
        Object.entries(where).every(
          ([key, value]) => (row as Record<string, unknown>)[key] === value,
        ),
      ) ?? null,
    delete: jest.fn(async () => {
      throw new Error('el laboratorio no borra');
    }),
    createQueryBuilder: () => {
      const qb = {
        where: () => qb,
        andWhere: () => qb,
        orderBy: () => qb,
        getOne: async () => null,
      };
      return qb;
    },
  };
}

function harness() {
  const conversations = memoryRepo<Record<string, any>>([]);
  const contacts = memoryRepo<Record<string, any>>([]);
  const messages = memoryRepo<Record<string, any>>([]);
  const service = Object.create(ChatService.prototype) as ChatService;
  Object.assign(service, {
    conversationRepository: conversations,
    contactRepository: contacts,
    messageRepository: messages,
    conversationFindOrCreateInflight: new Map(),
    consolidatedVisionInFlight: new Set(),
    leadEventsService: { logTransition: jest.fn().mockResolvedValue(undefined) },
    chatGateway: { emitNewMessage: jest.fn() },
    incomingMessageProducer: { enqueueMessage: jest.fn().mockResolvedValue(undefined) },
    outgoingMessageProducer: { enqueueOutboundMessage: jest.fn() },
    tallerService: { findDefaultTallerId: jest.fn() },
    ensureImageOnCloudinary: jest.fn(() => {
      throw new Error('cloudinary');
    }),
    getRecentImages: jest.fn().mockResolvedValue([]),
    buildVisionTextHistoryForConversation: jest.fn().mockResolvedValue([]),
    analyzeDamageImageInSequentialChunks: jest.fn(),
  });
  return { service, conversations, contacts, messages };
}

describe('laboratorio interno', () => {
  const previous = process.env;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = completeEnv();
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('red externa');
    });
  });

  afterEach(() => {
    process.env = previous;
    fetchSpy.mockRestore();
  });

  it('en producción la ruta no existe y sin el dueño del taller sintético se rechaza', () => {
    expect(labRouteVisibility({ PEGAZUZ_ENV: 'production' })).toBe('hidden');
    expect(labRouteVisibility({})).toBe('hidden');
    expect(new LabVisibilityGuard().canActivate()).toBe(true);
    process.env = { PEGAZUZ_ENV: 'production' };
    expect(() => new LabVisibilityGuard().canActivate()).toThrow(NotFoundException);
    expect(labAccess(completeEnv(), owner)).toBe('ok');
    expect(
      labAccess(completeEnv(), { ...owner, tallerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
    ).toBe('forbidden');
    expect(labAccess(completeEnv(), { ...owner, email: 'dueno@autofix.mx' })).toBe('forbidden');
    expect(labAccess(completeEnv(), { ...owner, role: 'agent' })).toBe('forbidden');
    expect(Reflect.getMetadata(GUARDS_METADATA, LabController)).toEqual(
      expect.arrayContaining([LabVisibilityGuard, JwtAuthGuard]),
    );
  });

  it('no acepta identificadores externos ni imágenes que no sean JPEG, PNG o WebP', () => {
    const externalId = createLabExternalId();
    expect(externalId).toMatch(/^lab:[0-9a-f-]{36}$/i);
    expect(externalId).not.toMatch(/^\d+$/);
    expect(() => parseLabTurn({ externalId: '5215550100001', text: 'hola' }, 1000)).toThrow(
      BadRequestException,
    );
    expect(() =>
      parseLabTurn({ text: 'hola', images: ['https://cdn.example/foto.jpg'] }, 1000),
    ).toThrow(BadRequestException);
    try {
      parseLabTurn({ images: ['data:image/gif;base64,SECRETO-DE-PRUEBA'] }, 1000);
      throw new Error('debía rechazar el formato');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify(err)).not.toContain('SECRETO-DE-PRUEBA');
      expect(JSON.stringify(err)).not.toContain('data:image');
    }
  });

  it('crea la conversación en el taller sintético y un turno junta texto con varias fotos', async () => {
    const { service, conversations, messages } = harness();
    const created = await service.createLabConversation(owner, {});
    const turn = await service.appendLabTurn(
      created.id,
      {
        text: 'Buenas tardes quiero arreglar mi Beetle 2015',
        images: [dataUrl('jpeg', 1), dataUrl('png', 2), dataUrl('webp', 3)],
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
      },
      owner,
    );
    expect(turn.messageIds).toHaveLength(4);
    expect(turn.debounceMs).toBe(25_000);
    expect(conversations.rows).toHaveLength(1);
    expect(conversations.rows[0]).toMatchObject({
      id: created.id,
      platform: 'lab',
      tallerId: STAGING_TALLER_ID,
    });
    expect(String(conversations.rows[0].externalId)).toMatch(/^lab:/);
    const queued = (service as any).incomingMessageProducer.enqueueMessage.mock.calls;
    expect(queued).toHaveLength(4);
    expect(queued.every((call: unknown[]) => call[0] === STAGING_TALLER_ID && call[1] === created.id && call[2] === 'lab')).toBe(true);
    expect(queued.map((call: any[]) => call[3].kind)).toEqual(['text', 'image', 'image', 'image']);
    expect((service as any).ensureImageOnCloudinary).not.toHaveBeenCalled();
    expect((service as any).outgoingMessageProducer.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(messages.delete).not.toHaveBeenCalled();

    const again = await service.appendLabTurn(
      created.id,
      {
        text: 'Buenas tardes quiero arreglar mi Beetle 2015',
        images: [dataUrl('jpeg', 1), dataUrl('png', 2), dataUrl('webp', 3)],
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
      },
      owner,
    );
    expect(again.messageIds).toEqual(turn.messageIds);
    expect(messages.rows).toHaveLength(4);
  });

  it('mantiene dos conversaciones separadas y conserva el expediente si el modelo falla', async () => {
    const { service, messages } = harness();
    const [first, second] = await Promise.all([
      service.createLabConversation(owner, {}),
      service.createLabConversation(owner, {}),
    ]);
    expect(first.id).not.toBe(second.id);
    await Promise.all([
      service.appendLabTurn(
        first.id,
        {
          text: 'Es un Beetle 2015',
          images: [dataUrl('jpeg', 4), dataUrl('jpeg', 5)],
          idempotencyKey: '33333333-3333-4333-8333-333333333333',
        },
        owner,
      ),
      service.appendLabTurn(
        second.id,
        {
          text: 'Es un Jetta 2018',
          images: [dataUrl('png', 6)],
          idempotencyKey: '44444444-4444-4444-8444-444444444444',
        },
        owner,
      ),
    ]);
    const of = (id: string) => messages.rows.filter((row) => row.conversationId === id);
    expect(of(first.id).map((row) => row.content).join('\n')).toContain('Beetle 2015');
    expect(of(first.id).map((row) => row.content).join('\n')).not.toContain('Jetta');
    expect(of(second.id).map((row) => row.content).join('\n')).toContain('Jetta 2018');
    expect(of(second.id).map((row) => row.content).join('\n')).not.toContain('Beetle');

    const correction = await service.appendLabTurn(
      first.id,
      {
        text: 'No es 2015, es 2017',
        idempotencyKey: '55555555-5555-4555-8555-555555555555',
      },
      owner,
    );
    expect(correction.conversationId).toBe(first.id);
    const declared = extractLatestDeclaredVehicleIdentity(
      of(first.id).filter((row) => row.direction === 'inbound' && !String(row.content).startsWith('data:')).map((row) => row.content),
    );
    expect(declared).toMatchObject({ year: '2017', correctsYear: true });
    expect(of(second.id).some((row) => String(row.content).includes('2017'))).toBe(false);

    const before = messages.rows.length;
    const providerError = new Error(
      `model down data:image/jpeg;base64,${'A'.repeat(80)}`,
    );
    providerError.name = 'APIConnectionError';
    (service as any).analyzeDamageImageInSequentialChunks.mockRejectedValue(providerError);
    const errorSpy = jest.spyOn(pegLogger, 'error');
    const queued = (service as any).incomingMessageProducer.enqueueMessage.mock.calls
      .filter((call: any[]) => call[1] === first.id && call[3].kind === 'image')
      .map((call: any[]) => call[3]);
    await expect(
      service.processQueuedInboundBurst({
        conversationId: first.id,
        tallerId: STAGING_TALLER_ID,
        channel: 'lab',
        items: queued,
      }),
    ).rejects.toBe(providerError);
    const failure = messages.rows.filter(
      (row) =>
        row.conversationId === first.id &&
        row.direction === 'outbound' &&
        String(row.content).includes('expediente sigue guardado'),
    );
    expect(failure).toHaveLength(1);
    expect(String(failure[0]?.content)).not.toMatch(/cotización actualizada|qued[oó] agendada/i);
    expect(messages.rows).toHaveLength(before + 1);
    expect(of(first.id).map((row) => row.content).join('\n')).toContain('Beetle 2015');
    expect(of(second.id)).toHaveLength(2);
    expect((service as any).analyzeDamageImageInSequentialChunks).toHaveBeenCalledTimes(1);
    expect((service as any).analyzeDamageImageInSequentialChunks.mock.calls[0][0]).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(messages.delete).not.toHaveBeenCalled();
    const visionLog = errorSpy.mock.calls
      .map((call) => call[1] as { stage?: string; message?: string; failure?: string })
      .find((data) => data?.stage === 'vision_peritaje');
    expect(visionLog).toMatchObject({
      stage: 'vision_peritaje',
      errorName: 'APIConnectionError',
      failure: 'vision',
    });
    expect(visionLog?.message).toContain('model down');
    expect(visionLog?.message).not.toContain('data:image');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('data:image');
    errorSpy.mockRestore();
  });

  it('guarda la respuesta de cotización parcial sin llamar a un proveedor externo', async () => {
    const { service, messages } = harness();
    const created = await service.createLabConversation(owner, {});
    const partial = renderDeterministicCta({
      ctx: {
        ctaType: 'ASK_MISSING_VEHICLE_DATA',
        missingVehicleFields: ['year'],
      } as ClientQuoteMessageContext,
      hasActiveAppointment: false,
    });
    const saved = await service.saveMessage({
      direction: 'outbound',
      conversationId: created.id,
      tallerId: STAGING_TALLER_ID,
      platform: 'lab',
      message: partial,
      user: 'Agente',
    });
    expect(saved).toMatchObject({
      conversationId: created.id,
      direction: 'outbound',
      content: partial,
      channelType: 'lab',
    });
    expect(messages.rows.some((row) => row.id === saved.id && row.content === partial)).toBe(true);
    expect(partial).toContain('año');
    expect((service as any).outgoingMessageProducer.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect((service as any).ensureImageOnCloudinary).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    const otherId = randomUUID();
    const labQuote = {
      id: 'quote-lab',
      conversationId: created.id,
      tallerId: STAGING_TALLER_ID,
      items: [],
      quotePayload: null,
    };
    (service as any).draftQuoteRepository = {
      find: async ({ where }: { where: { conversationId: string; tallerId: string } }) =>
        [labQuote, {
          id: 'quote-otro',
          conversationId: otherId,
          tallerId: STAGING_TALLER_ID,
          items: [],
          quotePayload: null,
        }].filter(
          (row) =>
            row.conversationId === where.conversationId &&
            row.tallerId === where.tallerId,
        ),
    };
    const quotes = await service.findDraftQuotesByConversation(created.id, STAGING_TALLER_ID);
    expect(quotes.map((row) => row.id)).toEqual(['quote-lab']);
  });

  it('un turno de laboratorio no modifica una conversación de WhatsApp', async () => {
    const { service, conversations, messages } = harness();
    const whatsappId = randomUUID();
    conversations.rows.push({
      id: whatsappId,
      tallerId: STAGING_TALLER_ID,
      externalId: ALLOWED,
      platform: 'whatsapp',
      contactName: 'Cliente WhatsApp',
      isAutoPilotActive: true,
    });
    await expect(
      service.appendLabTurn(whatsappId, { text: 'hola' }, owner),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(conversations.rows[0].platform).toBe('whatsapp');
    expect(conversations.rows[0].externalId).toBe(ALLOWED);
    expect(messages.rows).toHaveLength(0);
    expect(messages.delete).not.toHaveBeenCalled();
    expect(conversations.delete).not.toHaveBeenCalled();
  });

  it('el sandbox de WhatsApp sigue aceptando su canal y el laboratorio no sale a la red', async () => {
    expect(decideStagingInboundJob({ tallerId: STAGING_TALLER_ID, channel: 'whatsapp' })).toBe(true);
    expect(decideStagingInboundJob({ tallerId: STAGING_TALLER_ID, channel: 'lab' })).toBe(true);
    expect(
      decideStagingInboundJob({
        tallerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        channel: 'lab',
      }),
    ).toBe(false);
    expect(decideStagingInboundJob({ tallerId: STAGING_TALLER_ID, channel: 'messenger' })).toBe(false);
    expect(
      decideStagingOutbound({
        channel: 'lab',
        tallerId: STAGING_TALLER_ID,
        metaPayload: { to: ALLOWED },
      }).send,
    ).toBe(false);
    expect(
      decideStagingOutbound({
        channel: 'whatsapp',
        tallerId: STAGING_TALLER_ID,
        metaPayload: { to: ALLOWED },
      }).send,
    ).toBe(true);

    const queue = { add: jest.fn() };
    const producer = new OutgoingMessageProducer(queue as never);
    await expect(
      producer.enqueueOutboundMessage(STAGING_TALLER_ID, randomUUID(), 'lab', { to: ALLOWED }),
    ).rejects.toThrow(/lab/);
    expect(queue.add).not.toHaveBeenCalled();

    const post = jest.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {} } as never);
    const worker = new OutgoingMessageWorker();
    await expect(
      worker.process({
        id: 'out-lab',
        attemptsMade: 0,
        opts: { attempts: 1 },
        data: {
          channel: 'lab',
          conversationId: randomUUID(),
          tallerId: STAGING_TALLER_ID,
          metaPayload: { to: ALLOWED, type: 'text', text: { body: 'hola' } },
        },
      } as never),
    ).rejects.toThrow(/lab/);
    expect(post).not.toHaveBeenCalled();
    post.mockRestore();

    const drainBuffer = jest.fn().mockResolvedValue([
      { kind: 'text', content: 'hola', messageId: 'm1' },
    ]);
    const burst = jest.fn();
    const incoming = new IncomingMessageWorker(
      { drainBuffer, rescheduleIfBufferPending: jest.fn() } as never,
      { processQueuedInboundBurst: burst } as never,
    );
    process.env = { PEGAZUZ_ENV: 'production' };
    await incoming.process({
      id: 'in-lab',
      data: { conversationId: 'conv-lab', tallerId: STAGING_TALLER_ID, channel: 'lab' },
    } as never);
    expect(drainBuffer).not.toHaveBeenCalled();
    process.env = completeEnv();
    await incoming.process({
      id: 'in-lab-ok',
      data: { conversationId: 'conv-lab', tallerId: STAGING_TALLER_ID, channel: 'lab' },
    } as never);
    expect(burst).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sin autenticación el controlador exige usuario y un cuerpo de alta no admite canal', async () => {
    const { service, conversations } = harness();
    await expect(service.createLabConversation(undefined as never, {})).rejects.toThrow(
      /unauthorized/i,
    );
    await expect(
      service.createLabConversation(owner, { externalId: '5215550100001' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(conversations.rows).toHaveLength(0);
    process.env = {};
    await expect(service.createLabConversation(owner, {})).rejects.toBeInstanceOf(NotFoundException);
  });
});
