jest.mock('@nestjs/bullmq', () => ({
  Processor: () => () => undefined,
  WorkerHost: class WorkerHost {},
  InjectQueue: () => () => undefined,
}));

jest.mock('bullmq', () => ({
  UnrecoverableError: class UnrecoverableError extends Error {},
}));

import { createHmac } from 'crypto';
import { Test } from '@nestjs/testing';
import axios from 'axios';
import request from 'supertest';
import { ChatController } from '../chat/chat.controller';
import { AiConfigService } from '../chat/ai-config.service';
import { ChatService } from '../chat/chat.service';
import { createOpenAiClient } from './staging-openai';
import { STAGING_TALLER_ID } from './staging-synthetic';
import { IncomingMessageWorker } from '../messaging-queue/incoming-message.worker';
import { OutgoingMessageProducer } from '../messaging-queue/outgoing-message.producer';
import { OutgoingMessageWorker } from '../messaging-queue/outgoing-message.worker';
import { UnrecoverableError } from 'bullmq';
import {
  assertStagingWhatsAppRecipient,
  decideStagingInboundJob,
  decideStagingOutbound,
  downloadStagingWhatsAppMedia,
  evaluateStagingSandboxInbound,
  readStagingSandbox,
  rememberRawBody,
  resetStagingOpenAiBudgetForTests,
  stagingWhatsAppPayloadForMeta,
  verifyMetaWebhookSignature,
  type StagingSandboxConfig,
} from './staging-sandbox';

const APP_SECRET = 'staging-app-secret-ensayo';
const ACCESS_TOKEN = 'staging-access-token-ensayo';
const OPENAI_STAGING = 'sk-staging-ensayo-only';
const OPENAI_OTHER = 'sk-production-different';
const ALLOWED = '5215550100005';

function completeEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PEGAZUZ_ENV: 'staging',
    STAGING_SANDBOX: 'on',
    STAGING_WHATSAPP_PHONE_NUMBER_ID: 'phone-ensayo-100',
    STAGING_WHATSAPP_BUSINESS_ACCOUNT_ID: 'waba-ensayo-100',
    STAGING_WHATSAPP_ACCESS_TOKEN: ACCESS_TOKEN,
    STAGING_WHATSAPP_VERIFY_TOKEN: 'staging-verify-token-ensayo',
    STAGING_WHATSAPP_APP_SECRET: APP_SECRET,
    STAGING_WHATSAPP_NUMBER: '5215550100099',
    STAGING_WHATSAPP_ALLOWLIST: `${ALLOWED},5215550100006`,
    STAGING_OPENAI_API_KEY: OPENAI_STAGING,
    STAGING_OPENAI_MAX_REQUESTS: '2',
    STAGING_OPENAI_MAX_TOTAL_TOKENS: '100',
    OPENAI_API_KEY: OPENAI_OTHER,
    WHATSAPP_PHONE_NUMBER_ID: 'phone-production-999',
    WHATSAPP_NUMBER: '5215550190000',
    ...overrides,
  };
}

function activeConfig(overrides: NodeJS.ProcessEnv = {}): StagingSandboxConfig {
  const state = readStagingSandbox(completeEnv(overrides));
  if (!state.active) throw new Error('el fixture del sandbox quedó incompleto');
  return state.config;
}

function whatsAppBody(from: string, message: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    tallerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    entry: [
      {
        id: 'waba-ensayo-100',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                phone_number_id: 'phone-ensayo-100',
                display_phone_number: '+52 1 555 010 0099',
              },
              messages: [
                {
                  from,
                  id: 'wamid.ENSAYO',
                  timestamp: '1710000000',
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function sign(raw: Buffer, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

describe('staging sandbox', () => {
  const previous = { ...process.env };

  afterEach(() => {
    process.env = { ...previous };
    resetStagingOpenAiBudgetForTests();
    jest.restoreAllMocks();
  });

  it('permanece apagado si el interruptor no es exactamente on', () => {
    expect(readStagingSandbox(completeEnv({ STAGING_SANDBOX: '' })).reason).toBe('off');
    expect(readStagingSandbox(completeEnv({ STAGING_SANDBOX: 'ON' })).reason).toBe('off');
    expect(readStagingSandbox(completeEnv({ PEGAZUZ_ENV: 'production' })).reason).toBe(
      'not_staging',
    );
  });

  it('una configuración incompleta o copiada de producción no abre rutas', () => {
    expect(
      readStagingSandbox(completeEnv({ STAGING_WHATSAPP_ALLOWLIST: '' })).reason,
    ).toBe('incomplete');
    expect(
      readStagingSandbox(completeEnv({ STAGING_OPENAI_API_KEY: '' })).reason,
    ).toBe('incomplete');
    expect(
      readStagingSandbox(completeEnv({ STAGING_OPENAI_MAX_REQUESTS: '0' })).reason,
    ).toBe('incomplete');
    expect(
      readStagingSandbox(
        completeEnv({
          STAGING_WHATSAPP_PHONE_NUMBER_ID: 'phone-production-999',
          WHATSAPP_PHONE_NUMBER_ID: 'phone-production-999',
        }),
      ).reason,
    ).toBe('incomplete');
    expect(
      readStagingSandbox(
        completeEnv({
          STAGING_OPENAI_API_KEY: OPENAI_OTHER,
          OPENAI_API_KEY: OPENAI_OTHER,
        }),
      ).reason,
    ).toBe('incomplete');
    expect(
      readStagingSandbox(
        completeEnv({
          STAGING_WHATSAPP_ALLOWLIST: '5215550190000',
          WHATSAPP_NUMBER: '5215550190000',
        }),
      ).reason,
    ).toBe('incomplete');
  });

  it('rechaza firma inválida y no acepta el verify token como sustituto', () => {
    const raw = Buffer.from('{"object":"whatsapp_business_account"}');
    expect(verifyMetaWebhookSignature(raw, sign(raw), APP_SECRET)).toBe(true);
    expect(verifyMetaWebhookSignature(raw, sign(raw, 'otro-secreto-distinto'), APP_SECRET)).toBe(
      false,
    );
    expect(verifyMetaWebhookSignature(raw, 'staging-verify-token-ensayo', APP_SECRET)).toBe(
      false,
    );
    expect(verifyMetaWebhookSignature(raw, undefined, APP_SECRET)).toBe(false);
    const captured = {} as { rawBody?: Buffer };
    rememberRawBody(captured as never, null, raw);
    expect(captured.rawBody?.equals(raw)).toBe(true);
  });

  it('ata el mensaje al taller sintético y rechaza cuenta, remitente y medio ajenos', () => {
    const config = activeConfig();
    const accepted = evaluateStagingSandboxInbound(
      whatsAppBody(ALLOWED, { type: 'text', text: { body: 'hola' } }),
      config,
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.events[0]?.tallerId).toBe(STAGING_TALLER_ID);
    expect(accepted.events[0]?.tallerId).not.toBe(
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    );

    expect(
      evaluateStagingSandboxInbound(
        whatsAppBody('5215550188888', { type: 'text', text: { body: 'no' } }),
        config,
      ),
    ).toEqual({ ok: false, reason: 'sender' });

    const foreign = whatsAppBody(ALLOWED, { type: 'text', text: { body: 'hola' } });
    foreign.entry[0].id = 'waba-production';
    expect(evaluateStagingSandboxInbound(foreign, config).ok).toBe(false);

    const missing = whatsAppBody(ALLOWED, { type: 'text', text: { body: 'hola' } });
    delete (
      missing.entry[0].changes[0].value.metadata as { phone_number_id?: string }
    ).phone_number_id;
    expect(evaluateStagingSandboxInbound(missing, config)).toEqual({
      ok: false,
      reason: 'identity',
    });

    expect(
      evaluateStagingSandboxInbound({ object: 'page', entry: [{ id: '1' }] }, config),
    ).toEqual({ ok: false, reason: 'not_whatsapp' });
    expect(
      evaluateStagingSandboxInbound({ message: 'hola', tallerId: STAGING_TALLER_ID }, config),
    ).toEqual({ ok: false, reason: 'not_whatsapp' });

    expect(
      evaluateStagingSandboxInbound(
        whatsAppBody(ALLOWED, {
          type: 'image',
          image: { link: 'https://evil.example/a.jpg' },
        }),
        config,
      ),
    ).toEqual({ ok: false, reason: 'media' });
  });

  it('la salida exige la allowlist antes de encolar y antes del HTTP', async () => {
    const env = completeEnv();
    expect(assertStagingWhatsAppRecipient(ALLOWED, env)).toBe(true);
    expect(assertStagingWhatsAppRecipient('5215550188888', env)).toBe(false);
    expect(assertStagingWhatsAppRecipient(ALLOWED, { PEGAZUZ_ENV: 'staging' })).toBe(false);
    expect(
      decideStagingOutbound(
        {
          channel: 'messenger',
          tallerId: STAGING_TALLER_ID,
          metaPayload: { to: ALLOWED },
        },
        env,
      ).send,
    ).toBe(false);
    expect(
      decideStagingOutbound(
        {
          channel: 'whatsapp',
          tallerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          metaPayload: { to: ALLOWED },
        },
        env,
      ).send,
    ).toBe(false);

    process.env = { ...env };
    const add = jest.fn().mockResolvedValue({ id: 'job-1' });
    const producer = new OutgoingMessageProducer({ add } as never);
    await expect(
      producer.enqueueOutboundMessage(
        STAGING_TALLER_ID,
        'conv-ensayo',
        'whatsapp',
        { to: '5215550188888' },
      ),
    ).rejects.toThrow(/apagado/);
    expect(add).not.toHaveBeenCalled();

    const post = jest.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {} });
    const worker = new OutgoingMessageWorker();
    await expect(
      worker.process({
        id: 'out-blocked',
        attemptsMade: 0,
        opts: { attempts: 1 },
        data: {
          channel: 'whatsapp',
          tallerId: STAGING_TALLER_ID,
          conversationId: 'conv-ensayo',
          metaPayload: { to: '5215550188888', type: 'text', text: { body: 'no' } },
        },
      } as never),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(post).not.toHaveBeenCalled();

    await worker.process({
      id: 'out-ok',
      attemptsMade: 0,
      opts: { attempts: 1 },
      data: {
        channel: 'whatsapp',
        tallerId: STAGING_TALLER_ID,
        conversationId: 'conv-ensayo',
        metaPayload: {
          to: ALLOWED,
          messaging_product: 'whatsapp',
          type: 'text',
          text: { body: 'hola' },
        },
      },
    } as never);
    expect(String(post.mock.calls[0]?.[0])).toContain('phone-ensayo-100');
    expect(post.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${ACCESS_TOKEN}`,
        }),
      }),
    );
    expect(JSON.stringify(post.mock.calls[0]?.[2])).not.toContain(OPENAI_OTHER);
    expect(post.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ to: '525550100005' }),
    );
    post.mockRestore();
  });

  it('el POST de staging reescribe solo el 521 mexicano y conserva el identificador original', async () => {
    const mxWebhook = '5215550100005';
    const mxListed = '525555010010';
    const international = '14155550100';
    const stored = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: mxWebhook,
      type: 'text',
      text: { body: 'hola' },
    };
    const rewritten = stagingWhatsAppPayloadForMeta(stored);
    expect(rewritten.to).toBe('525550100005');
    expect(stored.to).toBe(mxWebhook);
    const listedPayload = { ...stored, to: mxListed };
    const internationalPayload = { ...stored, to: international };
    expect(stagingWhatsAppPayloadForMeta(listedPayload)).toBe(listedPayload);
    expect(stagingWhatsAppPayloadForMeta(internationalPayload)).toBe(
      internationalPayload,
    );
    expect(stagingWhatsAppPayloadForMeta({ ...stored, to: '521555010099' }).to).toBe(
      '521555010099',
    );

    process.env = {
      ...completeEnv({
        STAGING_WHATSAPP_ALLOWLIST: `${mxWebhook},${mxListed},${international}`,
      }),
    };
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {} });
    const worker = new OutgoingMessageWorker();

    await worker.process({
      id: 'mx-521',
      attemptsMade: 0,
      opts: { attempts: 1 },
      data: {
        channel: 'whatsapp',
        tallerId: STAGING_TALLER_ID,
        conversationId: 'conv-ensayo',
        metaPayload: stored,
      },
    } as never);
    expect(stored.to).toBe(mxWebhook);
    expect(post.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        to: '525550100005',
        type: 'text',
        messaging_product: 'whatsapp',
      }),
    );
    expect(String(post.mock.calls[0]?.[0])).toContain('phone-ensayo-100');
    expect(String(post.mock.calls[0]?.[0])).not.toContain('phone-production-999');
    expect(post.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${ACCESS_TOKEN}`,
        }),
      }),
    );

    await worker.process({
      id: 'mx-52',
      attemptsMade: 0,
      opts: { attempts: 1 },
      data: {
        channel: 'whatsapp',
        tallerId: STAGING_TALLER_ID,
        conversationId: 'conv-ensayo',
        metaPayload: { ...stored, to: mxListed },
      },
    } as never);
    expect(post.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ to: mxListed }));

    await worker.process({
      id: 'intl',
      attemptsMade: 0,
      opts: { attempts: 1 },
      data: {
        channel: 'whatsapp',
        tallerId: STAGING_TALLER_ID,
        conversationId: 'conv-ensayo',
        metaPayload: { ...stored, to: international },
      },
    } as never);
    expect(post.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({ to: international }),
    );

    await expect(
      worker.process({
        id: 'blocked-twin',
        attemptsMade: 0,
        opts: { attempts: 1 },
        data: {
          channel: 'whatsapp',
          tallerId: STAGING_TALLER_ID,
          conversationId: 'conv-ensayo',
          metaPayload: { ...stored, to: '525550100005' },
        },
      } as never),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(post).toHaveBeenCalledTimes(3);

    process.env = {
      PEGAZUZ_ENV: 'production',
      WHATSAPP_PHONE_NUMBER_ID: 'phone-production-999',
      WHATSAPP_ACCESS_TOKEN: 'production-token-ensayo',
    };
    await worker.process({
      id: 'prod-521',
      attemptsMade: 0,
      opts: { attempts: 1 },
      data: {
        channel: 'whatsapp',
        tallerId: STAGING_TALLER_ID,
        conversationId: 'conv-ensayo',
        metaPayload: { ...stored },
      },
    } as never);
    expect(post.mock.calls[3]?.[1]).toEqual(expect.objectContaining({ to: mxWebhook }));
    expect(String(post.mock.calls[3]?.[0])).toContain('phone-production-999');
    expect(post.mock.calls[3]?.[2]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer production-token-ensayo',
        }),
      }),
    );
    post.mockRestore();
  });

  it('OpenAI inerte por defecto y el presupuesto corta sin otra clave', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const inert = createOpenAiClient({ PEGAZUZ_ENV: 'staging' });
    await expect(
      inert.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hola' }],
      }),
    ).rejects.toThrow(/apagados/);
    expect(fetchSpy).not.toHaveBeenCalled();

    process.env = {
      ...completeEnv({
        STAGING_OPENAI_MAX_REQUESTS: '1',
        STAGING_OPENAI_MAX_TOTAL_TOKENS: '10',
      }),
    };
    resetStagingOpenAiBudgetForTests();
    const auths: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async (_input, init) => {
      const headers = new Headers(init?.headers);
      auths.push(headers.get('authorization') ?? '');
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-ensayo',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { total_tokens: 20 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const client = createOpenAiClient();
      await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hola' }],
      });
      await expect(
        client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'otra' }],
        }),
      ).rejects.toThrow(/apagados/);
      expect(auths).toEqual([`Bearer ${OPENAI_STAGING}`]);
      expect(auths.join('')).not.toContain(OPENAI_OTHER);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('descarga solo medios Meta autorizados y no conserva la URL ni el token', async () => {
    const config = activeConfig({ STAGING_MEDIA_MAX_BYTES: '8' });
    const calls: string[] = [];
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/v21.0/')) {
        return new Response(
          JSON.stringify({
            url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
            mime_type: 'image/jpeg',
            file_size: 4,
          }),
          { status: 200 },
        );
      }
      return new Response(Buffer.from('jpeg'), { status: 200 });
    }) as typeof fetch;

    const ok = await downloadStagingWhatsAppMedia('123456789012', config, fetchImpl);
    expect(ok).toEqual({
      dataUrl: `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`,
    });
    expect(JSON.stringify(ok)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(ok)).not.toContain('lookaside');

    const gifCalls: string[] = [];
    const gif = await downloadStagingWhatsAppMedia(
      '123456789012',
      config,
      jest.fn(async (input: RequestInfo | URL) => {
        gifCalls.push(String(input));
        return new Response(
          JSON.stringify({
            url: 'https://lookaside.fbsbx.com/x',
            mime_type: 'image/gif',
            file_size: 4,
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    );
    expect(gif).toEqual({ error: 'type' });
    expect(gifCalls).toHaveLength(1);
    expect(JSON.stringify(gif)).not.toContain(ACCESS_TOKEN);

    expect(
      await downloadStagingWhatsAppMedia('no-es-id', config, fetchImpl),
    ).toEqual({ error: 'invalid' });
    expect(
      await downloadStagingWhatsAppMedia(
        '123456789012',
        config,
        async () => {
          const err = new Error('agotado');
          err.name = 'TimeoutError';
          throw err;
        },
      ),
    ).toEqual({ error: 'timeout' });
    expect(
      await downloadStagingWhatsAppMedia(
        '123456789012',
        config,
        async () =>
          new Response(
            JSON.stringify({
              url: 'https://evil.example/secret',
              mime_type: 'image/jpeg',
              file_size: 4,
            }),
            { status: 200 },
          ),
      ),
    ).toEqual({ error: 'invalid' });
    expect(calls.some((url) => url.includes('evil.example'))).toBe(false);
  });

  it('el worker de entrada no procesa otro taller ni el sandbox apagado', async () => {
    const drainBuffer = jest.fn().mockResolvedValue([]);
    const incoming = new IncomingMessageWorker(
      { drainBuffer, rescheduleIfBufferPending: jest.fn() } as never,
      {} as never,
    );
    const job = {
      id: 'in-1',
      data: {
        conversationId: 'conv-ensayo',
        tallerId: STAGING_TALLER_ID,
        channel: 'whatsapp',
      },
    } as never;

    process.env = { PEGAZUZ_ENV: 'staging' };
    expect(decideStagingInboundJob({ tallerId: STAGING_TALLER_ID, channel: 'whatsapp' })).toBe(
      false,
    );
    await incoming.process(job);
    expect(drainBuffer).not.toHaveBeenCalled();

    process.env = { ...completeEnv() };
    await incoming.process({
      id: 'in-2',
      data: {
        conversationId: 'conv-ensayo',
        tallerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        channel: 'whatsapp',
      },
    } as never);
    expect(drainBuffer).not.toHaveBeenCalled();

    await incoming.process(job);
    expect(drainBuffer).toHaveBeenCalledTimes(1);
  });

  it('el POST exige firma y el GET no la reemplaza', async () => {
    process.env = { ...completeEnv() };
    const ingest = jest.fn().mockResolvedValue({ processed: 1 });
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: { ingestWebhookPayload: ingest } },
        { provide: AiConfigService, useValue: {} },
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    try {
      const payload = whatsAppBody(ALLOWED, { type: 'text', text: { body: 'hola' } });
      const rawText = JSON.stringify(payload);
      const raw = Buffer.from(rawText);
      await request(app.getHttpServer())
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', 'sha256=00')
        .send(rawText)
        .expect(403);
      expect(ingest).not.toHaveBeenCalled();

      await request(app.getHttpServer())
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', sign(raw))
        .send(rawText)
        .expect(200);
      expect(ingest).toHaveBeenCalledTimes(1);

      const plainText = JSON.stringify({ message: 'hola', from: ALLOWED });
      await request(app.getHttpServer())
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', sign(Buffer.from(plainText)))
        .send(plainText)
        .expect(403);

      const pageText = JSON.stringify({ object: 'page', entry: [{ id: '1' }] });
      await request(app.getHttpServer())
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', sign(Buffer.from(pageText)))
        .send(pageText)
        .expect(403);

      await request(app.getHttpServer())
        .get('/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'staging-verify-token-ensayo',
          'hub.challenge': '321',
        })
        .expect(200)
        .expect('321');

      await request(app.getHttpServer())
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', 'staging-verify-token-ensayo')
        .send(rawText)
        .expect(403);
      expect(ingest).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
