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

import { createHmac } from 'crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AiConfigService } from '../chat/ai-config.service';
import { ChatController } from '../chat/chat.controller';
import { ChatService } from '../chat/chat.service';
import { pegLogger } from '../observability/pegazuz-logger';
import {
  classifyStagingWebhookSignature,
  logStagingSandboxDecision,
  logStagingWebhookHttpIn,
  logStagingWebhookPersist,
} from '../observability/staging-webhook-log';
import {
  readStagingSandbox,
  type StagingSandboxConfig,
} from './staging-sandbox';

const APP_SECRET = 'staging-app-secret-ensayo';
const ALLOWED = '5215550100005';
const FOREIGN = '5215550188888';
const DISPLAY = '5215550100099';
const PHONE_ID = 'phone-ensayo-100';
const WABA = 'waba-ensayo-100';
const TEXT = 'hola ensayo no-loguear';
const MESSAGE_ID = 'wamid.ENSAYO-SECRETO';

function completeEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PEGAZUZ_ENV: 'staging',
    STAGING_SANDBOX: 'on',
    STAGING_WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
    STAGING_WHATSAPP_BUSINESS_ACCOUNT_ID: WABA,
    STAGING_WHATSAPP_ACCESS_TOKEN: 'staging-access-token-ensayo',
    STAGING_WHATSAPP_VERIFY_TOKEN: 'staging-verify-token-ensayo',
    STAGING_WHATSAPP_APP_SECRET: APP_SECRET,
    STAGING_WHATSAPP_NUMBER: DISPLAY,
    STAGING_WHATSAPP_ALLOWLIST: `${ALLOWED},5215550100006`,
    STAGING_OPENAI_API_KEY: 'sk-staging-ensayo-only',
    STAGING_OPENAI_MAX_REQUESTS: '2',
    STAGING_OPENAI_MAX_TOTAL_TOKENS: '100',
    ...overrides,
  };
}

function activeConfig(): StagingSandboxConfig {
  const state = readStagingSandbox(completeEnv());
  if (!state.active) throw new Error('el fixture del sandbox quedó incompleto');
  return state.config;
}

function whatsAppBody(
  from: string,
  message: Record<string, unknown>,
  meta: { phoneNumberId?: string; wabaId?: string; display?: string } = {},
) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: meta.wabaId ?? WABA,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                phone_number_id: meta.phoneNumberId ?? PHONE_ID,
                display_phone_number: meta.display ?? '+52 1 555 010 0099',
              },
              contacts: [{ profile: { name: 'Cliente Ensayo' }, wa_id: from }],
              messages: [
                {
                  from,
                  id: MESSAGE_ID,
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

function textBody(
  from = ALLOWED,
  meta?: { phoneNumberId?: string; wabaId?: string; display?: string },
) {
  return whatsAppBody(from, { type: 'text', text: { body: TEXT } }, meta);
}

function sign(raw: Buffer, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

describe('observabilidad del webhook de staging', () => {
  const previous = { ...process.env };
  const ingest = jest.fn();
  let app: INestApplication;
  let info: jest.SpiedFunction<typeof pegLogger.info>;

  function events() {
    return info.mock.calls
      .filter((call) => call[0] === 'WEBHOOK')
      .map((call) => call[1]);
  }

  function assertClosed(payload: unknown) {
    const blob = JSON.stringify(payload);
    for (const secret of [
      ALLOWED,
      FOREIGN,
      DISPLAY,
      '16505551111',
      PHONE_ID,
      'phone-ajeno-200',
      WABA,
      'waba-ajena',
      APP_SECRET,
      MESSAGE_ID,
      TEXT,
      'Cliente Ensayo',
      'sk-staging',
      'sk-live',
      'sha256=',
      'lookaside',
      'evil.example',
      'uuid-no-loguear',
      'detalle secreto',
      'Bearer',
    ]) {
      expect(blob).not.toContain(secret);
    }
  }

  async function postRaw(body: unknown, header?: string | null) {
    const rawText = JSON.stringify(body);
    const raw = Buffer.from(rawText);
    const req = request(app.getHttpServer())
      .post('/webhook')
      .set('Content-Type', 'application/json');
    if (header !== null) {
      req.set('x-hub-signature-256', header === undefined ? sign(raw) : header);
    }
    return req.send(rawText);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: { ingestWebhookPayload: ingest } },
        { provide: AiConfigService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    process.env = { ...previous, ...completeEnv() };
    ingest.mockReset();
    ingest.mockResolvedValue({ processed: 0 });
    info = jest.spyOn(pegLogger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...previous };
    jest.restoreAllMocks();
  });

  it('un webhook válido y autorizado conserva la respuesta y delega el cuerpo', async () => {
    ingest.mockResolvedValue({ processed: 1, lastMessageId: 'uuid-no-loguear' });
    const body = textBody();
    const res = await postRaw(body);

    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith(body);
    expect(events()).toEqual([
      {
        event: 'http_in',
        method: 'POST',
        bodyKind: 'whatsapp',
        signature: 'valid',
      },
      { event: 'decision', result: 'accepted' },
      { event: 'persist', processed: 1, outcome: 'saved' },
    ]);
    assertClosed(events());
  });

  it('un aceptado que el servicio no guarda queda en skipped y sigue en 200', async () => {
    const res = await postRaw(textBody());
    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(events()).toEqual([
      {
        event: 'http_in',
        method: 'POST',
        bodyKind: 'whatsapp',
        signature: 'valid',
      },
      { event: 'decision', result: 'accepted' },
      { event: 'persist', processed: 0, outcome: 'skipped' },
    ]);
  });

  it('el descarte por cuenta nombra solo el primer campo distinto', async () => {
    const cases = [
      {
        body: textBody(ALLOWED, { phoneNumberId: 'phone-ajeno-200', wabaId: 'waba-ajena' }),
        accountField: 'phone_number_id',
      },
      {
        body: textBody(ALLOWED, { wabaId: 'waba-ajena' }),
        accountField: 'waba',
      },
      {
        body: textBody(ALLOWED, { display: '+1 650 555 1111' }),
        accountField: 'display',
      },
    ];
    for (const item of cases) {
      info.mockClear();
      ingest.mockClear();
      const res = await postRaw(item.body);
      expect(res.status).toBe(200);
      expect(res.text).toBe('EVENT_RECEIVED');
      expect(ingest).toHaveBeenCalledTimes(1);
      expect(events()).toEqual([
        {
          event: 'http_in',
          method: 'POST',
          bodyKind: 'whatsapp',
          signature: 'valid',
        },
        { event: 'decision', result: 'account', accountField: item.accountField },
        { event: 'persist', processed: 0, outcome: 'skipped' },
      ]);
      assertClosed(events());
    }
  });

  it('remitente, medio e identidad conservan el 200 y el motivo', async () => {
    const cases: Array<{ body: unknown; result: string }> = [
      { body: textBody(FOREIGN), result: 'sender' },
      {
        body: whatsAppBody(ALLOWED, {
          type: 'image',
          image: { link: 'https://evil.example/a.jpg' },
        }),
        result: 'media',
      },
      {
        body: {
          object: 'whatsapp_business_account',
          entry: [
            {
              id: WABA,
              changes: [
                {
                  field: 'messages',
                  value: {
                    messaging_product: 'whatsapp',
                    metadata: {
                      phone_number_id: PHONE_ID,
                      display_phone_number: DISPLAY,
                    },
                    statuses: [
                      {
                        id: MESSAGE_ID,
                        status: 'delivered',
                        recipient_id: ALLOWED,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
        result: 'identity',
      },
    ];
    for (const item of cases) {
      info.mockClear();
      ingest.mockClear();
      const res = await postRaw(item.body);
      expect(res.status).toBe(200);
      expect(res.text).toBe('EVENT_RECEIVED');
      expect(events()[1]).toEqual({ event: 'decision', result: item.result });
      expect(events()[2]).toEqual({
        event: 'persist',
        processed: 0,
        outcome: 'skipped',
      });
      assertClosed(events());
    }
  });

  it('una firma ausente o inválida sigue en 403 sin decisión ni persistencia', async () => {
    const missing = await postRaw(textBody(), null);
    expect(missing.status).toBe(403);
    expect(missing.body.message).toBe('Firma de webhook inválida.');
    expect(ingest).not.toHaveBeenCalled();
    expect(events()).toEqual([
      {
        event: 'http_in',
        method: 'POST',
        bodyKind: 'whatsapp',
        signature: 'missing',
      },
    ]);

    info.mockClear();
    const raw = Buffer.from(JSON.stringify(textBody()));
    const invalid = await postRaw(textBody(), sign(raw, 'otro-secreto-distinto'));
    expect(invalid.status).toBe(403);
    expect(invalid.body.message).toBe('Firma de webhook inválida.');
    expect(ingest).not.toHaveBeenCalled();
    expect(events()).toEqual([
      {
        event: 'http_in',
        method: 'POST',
        bodyKind: 'whatsapp',
        signature: 'invalid',
      },
    ]);
    expect(JSON.stringify(events())).not.toContain('otro-secreto-distinto');
  });

  it('un cuerpo que no es WhatsApp sigue en 403 con motivo not_whatsapp', async () => {
    const res = await postRaw({ object: 'page', entry: [{ id: '1', messaging: [] }] });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe(
      'Staging solo acepta WhatsApp del número de ensayo.',
    );
    expect(ingest).not.toHaveBeenCalled();
    expect(events()).toEqual([
      {
        event: 'http_in',
        method: 'POST',
        bodyKind: 'other',
        signature: 'valid',
      },
      { event: 'decision', result: 'not_whatsapp' },
    ]);
  });

  it('la excepción de persistencia responde 200 y solo guarda error.name', async () => {
    const err = new Error(
      'detalle secreto Bearer sk-live-abcdefghijklmnopqrst +5215550100005 wamid.ABC',
    );
    err.name = 'QueryFailedError';
    ingest.mockRejectedValue(err);
    const res = await postRaw(textBody());
    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    expect(events()).toEqual([
      {
        event: 'http_in',
        method: 'POST',
        bodyKind: 'whatsapp',
        signature: 'valid',
      },
      { event: 'decision', result: 'accepted' },
      {
        event: 'persist',
        processed: 0,
        outcome: 'failed',
        errorName: 'QueryFailedError',
      },
    ]);
    assertClosed(events());

    info.mockClear();
    const named = new Error('detalle secreto');
    named.name = 'Boom +5215550100005';
    ingest.mockRejectedValue(named);
    const again = await postRaw(textBody());
    expect(again.status).toBe(200);
    expect(again.text).toBe('EVENT_RECEIVED');
    expect(events()[2]).toEqual({
      event: 'persist',
      processed: 0,
      outcome: 'failed',
      errorName: 'Error',
    });
    assertClosed(events());
  });

  it('la línea pretty no imprime el cuerpo ni la excepción', async () => {
    info.mockRestore();
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_LOG_FORMAT = 'pretty';
    const lines: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((line) => {
      lines.push(String(line));
    });
    const err = new Error('detalle secreto +5215550100005');
    err.name = 'QueryFailedError';
    ingest.mockRejectedValue(err);
    const res = await postRaw(textBody(ALLOWED, { display: '+1 650 555 1111' }));
    logSpy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    const rendered = lines.join('\n');
    expect(rendered).toContain('event=http_in');
    expect(rendered).toContain('signature=valid');
    expect(rendered).toContain('result=account');
    expect(rendered).toContain('accountField=display');
    expect(rendered).toContain('outcome=failed');
    expect(rendered).toContain('errorName=QueryFailedError');
    expect(rendered).not.toContain(TEXT);
    expect(rendered).not.toContain(ALLOWED);
    expect(rendered).not.toContain('16505551111');
    expect(rendered).not.toContain('detalle secreto');
    expect(rendered).not.toContain(MESSAGE_ID);
  });

  it('el sandbox apagado sigue en 200 sin logs ni ingest', async () => {
    process.env.STAGING_SANDBOX = 'off';
    const res = await postRaw(textBody());
    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    expect(ingest).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
  });

  it('producción no emite los logs nuevos y conserva EVENT_RECEIVED', async () => {
    process.env = { ...previous, PEGAZUZ_ENV: 'production' };
    ingest.mockResolvedValue({ processed: 1, lastMessageId: 'uuid-no-loguear' });
    const res = await postRaw(textBody());
    expect(res.status).toBe(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(events()).toEqual([]);

    const config = activeConfig();
    logStagingWebhookHttpIn({
      method: 'POST',
      bodyKind: 'whatsapp',
      signature: 'valid',
    });
    logStagingSandboxDecision(textBody(), config);
    logStagingWebhookPersist({
      processed: 1,
      outcome: 'saved',
      errorName: 'QueryFailedError',
    });
    expect(events()).toEqual([]);
    expect(classifyStagingWebhookSignature(undefined, 'sha256=ab', APP_SECRET)).toBe(
      'invalid',
    );
  });
});
