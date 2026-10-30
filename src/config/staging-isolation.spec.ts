jest.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: { EVERY_DAY_AT_9AM: '0 9 * * *' },
}));

jest.mock('@nestjs/bullmq', () => ({
  Processor: () => () => undefined,
  WorkerHost: class WorkerHost {},
  InjectQueue: () => () => undefined,
}));

jest.mock('bullmq', () => ({
  UnrecoverableError: class UnrecoverableError extends Error {},
}));

import { Test } from '@nestjs/testing';
import { UnrecoverableError } from 'bullmq';
import axios from 'axios';
import request from 'supertest';
import { AppointmentReminderService } from '../chat/appointment-reminder.service';
import { ChatController } from '../chat/chat.controller';
import { AiConfigService } from '../chat/ai-config.service';
import { ChatService } from '../chat/chat.service';
import { searchOpenAiWeb, searchSerperOrganics, searchTavilyOrganics } from '../chat/refaccion-web-search';
import { searchSerperShopping } from '../chat/refaccion-market/serper-shopping.provider';
import { TwilioService } from '../chat/twilio.service';
import { IncomingMessageWorker } from '../messaging-queue/incoming-message.worker';
import { OutgoingMessageWorker } from '../messaging-queue/outgoing-message.worker';
import { isSentryEnabled, initSentry } from '../sentry/sentry.init';
import { createOpenAiClient } from './staging-openai';

const stagingEnv = { PEGAZUZ_ENV: 'staging' } as NodeJS.ProcessEnv;

describe('aislamiento de staging', () => {
  const previous: NodeJS.ProcessEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...previous };
    jest.restoreAllMocks();
  });

  it('OpenAI arranca sin clave y no llama a la red', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const client = createOpenAiClient(stagingEnv);
    await expect(
      client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hola' }],
      }),
    ).rejects.toThrow(/apagados/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('producción sigue exigiendo OPENAI_API_KEY al construir el cliente', () => {
    expect(() => createOpenAiClient({} as NodeJS.ProcessEnv)).toThrow(
      /Missing credentials/,
    );
  });

  it('Twilio no marca aunque haya credenciales', async () => {
    process.env.PEGAZUZ_ENV = 'staging';
    process.env.TWILIO_ACCOUNT_SID = 'ACstaging';
    process.env.TWILIO_AUTH_TOKEN = 'token-staging';
    process.env.TWILIO_PHONE_NUMBER = '+15550001111';
    process.env.TALLER_RECEPTION_PHONE = '+15550002222';
    const post = jest.spyOn(axios, 'post');
    const service = new TwilioService({} as never);
    const call = await service.triggerArrivalCall();
    await service.startArrivalAlarmLoop('conversacion-ensayo');
    expect(call.ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('el cron de recordatorios no consulta citas ni encola envíos', async () => {
    process.env.PEGAZUZ_ENV = 'staging';
    const appointments = { find: jest.fn(), createQueryBuilder: jest.fn() };
    const service = new AppointmentReminderService(
      appointments as never,
      {} as never,
      {} as never,
      { enqueue: jest.fn() } as never,
      {} as never,
    );
    await expect(service.sendUpcomingAppointmentReminders()).resolves.toEqual({
      scanned: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
    });
    expect(appointments.find).not.toHaveBeenCalled();
    expect(appointments.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('los workers de entrada y salida no contactan Meta', async () => {
    process.env.PEGAZUZ_ENV = 'staging';
    const drainBuffer = jest.fn();
    const processQueuedInboundBurst = jest.fn();
    const incoming = new IncomingMessageWorker(
      { drainBuffer } as never,
      { processQueuedInboundBurst } as never,
    );
    await incoming.process({
      id: 'in-1',
      data: { conversationId: 'c', tallerId: 't', channel: 'whatsapp' },
    } as never);
    expect(drainBuffer).not.toHaveBeenCalled();
    expect(processQueuedInboundBurst).not.toHaveBeenCalled();

    const outgoing = new OutgoingMessageWorker();
    await expect(
      outgoing.process({
        id: 'out-1',
        attemptsMade: 0,
        opts: { attempts: 1 },
        data: {
          channel: 'whatsapp',
          conversationId: 'c',
          metaPayload: { messaging_product: 'whatsapp' },
        },
      } as never),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('Serper, Tavily y la búsqueda web de OpenAI no salen a la red', async () => {
    process.env.PEGAZUZ_ENV = 'staging';
    process.env.SERPER_API_KEY = 'serper-staging';
    process.env.TAVILY_API_KEY = 'tavily-staging';
    process.env.OPENAI_API_KEY = 'sk-staging';
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(searchSerperShopping('faro')).resolves.toEqual([]);
    await expect(searchSerperOrganics('faro')).resolves.toEqual([]);
    await expect(searchTavilyOrganics('faro')).resolves.toEqual([]);
    await expect(searchOpenAiWeb('faro')).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('el webhook de Meta no se procesa', async () => {
    process.env.PEGAZUZ_ENV = 'staging';
    process.env.WHATSAPP_VERIFY_TOKEN = 'verify-staging';
    const ingest = jest.fn();
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: { ingestWebhookPayload: ingest } },
        { provide: AiConfigService, useValue: {} },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer())
        .post('/webhook')
        .send({ entry: [{ id: 'page' }] })
        .expect(200)
        .expect('EVENT_RECEIVED');
      await request(app.getHttpServer())
        .get('/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'verify-staging',
          'hub.challenge': '999',
        })
        .expect(403);
      expect(ingest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('Cloudinary no recibe la imagen', async () => {
    process.env.PEGAZUZ_ENV = 'staging';
    process.env.CLOUDINARY_CLOUD_NAME = 'cloud';
    process.env.CLOUDINARY_API_KEY = 'key';
    process.env.CLOUDINARY_API_SECRET = 'secret';
    const service = Object.create(ChatService.prototype) as ChatService;
    await expect(service.uploadImage({ buffer: Buffer.from('x') } as never)).rejects.toThrow(
      /apagados/,
    );
  });

  it('Sentry no se inicializa', () => {
    process.env.PEGAZUZ_ENV = 'staging';
    process.env.SENTRY_DSN = 'https://public@sentry.example.test/1';
    initSentry();
    expect(isSentryEnabled()).toBe(false);
  });
});
