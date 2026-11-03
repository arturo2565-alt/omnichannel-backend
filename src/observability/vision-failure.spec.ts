import { pegLogger } from './pegazuz-logger';
import { describeVisionFailure, sanitizeVisionErrorMessage } from './vision-failure';

class ProviderError extends Error {
  status: number;
  code: string;
  type: string;
  headers: { authorization: string };
  requestBody: string;

  constructor(
    name: string,
    status: number,
    type: string,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = name;
    this.status = status;
    this.type = type;
    this.code = code;
    this.headers = { authorization: 'Bearer sk-live-secret-key-1234567890' };
    this.requestBody = `data:image/jpeg;base64,${'A'.repeat(80)}`;
  }
}

function captureErrors(): { lines: () => string; restore: () => void } {
  const errors: string[] = [];
  const spy = jest.spyOn(console, 'error').mockImplementation((...args) => {
    errors.push(args.map(String).join(' '));
  });
  return {
    lines: () => errors.join('\n'),
    restore: () => spy.mockRestore(),
  };
}

describe('describeVisionFailure', () => {
  const secret = 'sk-live-secret-key-1234567890';
  const photo = `data:image/jpeg;base64,${'A'.repeat(90)}`;
  const signed =
    'https://res.cloudinary.com/demo/image/upload/a.jpg?X-Amz-Signature=abcdef123456';

  it('registra un 400 del proveedor', () => {
    const details = describeVisionFailure(
      new ProviderError(
        'BadRequestError',
        400,
        'invalid_request_error',
        'invalid_image',
        '400 The image data is invalid',
      ),
    );
    expect(details).toEqual({
      stage: 'vision_peritaje',
      errorName: 'BadRequestError',
      status: 400,
      code: 'invalid_image',
      errorType: 'invalid_request_error',
      message: '400 The image data is invalid',
    });
  });

  it.each([
    [401, 'AuthenticationError', 'invalid_api_key'],
    [403, 'PermissionDeniedError', 'insufficient_quota'],
  ])('registra un %s de autorización', (status, name, code) => {
    const details = describeVisionFailure(
      new ProviderError(name, status, 'invalid_request_error', code, `${status} denied`),
    );
    expect(details.status).toBe(status);
    expect(details.errorName).toBe(name);
    expect(details.code).toBe(code);
    expect(details).not.toHaveProperty('headers');
  });

  it('registra un 429 de límite', () => {
    const details = describeVisionFailure(
      new ProviderError(
        'RateLimitError',
        429,
        'rate_limit_error',
        'rate_limit_exceeded',
        '429 Rate limit reached',
      ),
    );
    expect(details).toMatchObject({
      status: 429,
      errorName: 'RateLimitError',
      code: 'rate_limit_exceeded',
      errorType: 'rate_limit_error',
    });
  });

  it.each([500, 503])('registra un %s del proveedor', (status) => {
    const details = describeVisionFailure(
      new ProviderError(
        'InternalServerError',
        status,
        'server_error',
        'internal_error',
        `${status} The server had an error`,
      ),
    );
    expect(details.status).toBe(status);
    expect(details.errorName).toBe('InternalServerError');
    expect(details.errorType).toBe('server_error');
  });

  it('registra una excepción sin código HTTP', () => {
    const err = new Error('Connection error.');
    err.name = 'APIConnectionError';
    const details = describeVisionFailure(err);
    expect(details).toEqual({
      stage: 'vision_peritaje',
      errorName: 'APIConnectionError',
      message: 'Connection error.',
    });
    expect(details.status).toBeUndefined();
    expect(details.code).toBeUndefined();
  });

  it('lee código y tipo anidados y descarta cabeceras y cuerpo', () => {
    const err = new Error('400 nested');
    Object.assign(err, {
      status: 400,
      error: { type: 'invalid_request_error', code: 'invalid_image' },
      headers: { authorization: `Bearer ${secret}` },
      body: photo,
    });
    const details = describeVisionFailure(err);
    const printed = JSON.stringify(details);
    expect(details.code).toBe('invalid_image');
    expect(details.errorType).toBe('invalid_request_error');
    expect(printed).not.toContain(secret);
    expect(printed).not.toContain('data:image');
    expect(printed).not.toContain('authorization');
  });

  it('sanitiza secretos, URLs temporales y base64', () => {
    const client = '¿Qué costo tiene reparar este golpe? '.repeat(12);
    const message = sanitizeVisionErrorMessage(
      `400 invalid ${photo} Bearer ${secret} Authorization: Bearer ${secret} ${signed} +52 55 1234 5678 persona@correo.test ${client}`,
    );
    expect(message).not.toContain('data:image');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('cloudinary');
    expect(message).not.toContain('X-Amz-Signature');
    expect(message).not.toContain('5512345678');
    expect(message).not.toContain('persona@correo.test');
    expect(message).not.toContain(client.trim());
    expect(message.length).toBeLessThanOrEqual(180);
    expect(message).toContain('[data-url]');
    expect(message).toContain('[url]');
  });

  it('imprime en el formato de Railway el diagnóstico y no la fotografía', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_LOG_FORMAT = 'pretty';
    const cap = captureErrors();
    const details = describeVisionFailure(
      new ProviderError(
        'BadRequestError',
        400,
        'invalid_request_error',
        'invalid_image',
        `400 invalid ${photo} Bearer ${secret}`,
      ),
    );
    pegLogger.error('TURN', {
      ...details,
      failure: 'vision',
      conversationId: 'b0e48790-e68c-44d1-93ab-777cbda4052d',
      turnId: 'turn_ca71ac',
    });
    const printed = cap.lines();
    expect(printed).toContain('TURN ERROR');
    expect(printed).toContain('Turn: ca71ac');
    expect(printed).toContain('Conversación: b0e48790');
    expect(printed).toContain('Etapa: vision_peritaje');
    expect(printed).toContain('Nombre: BadRequestError');
    expect(printed).toContain('HTTP: 400');
    expect(printed).toContain('Código: invalid_image');
    expect(printed).toContain('Tipo: invalid_request_error');
    expect(printed).toContain('[data-url]');
    expect(printed).not.toContain('data:image');
    expect(printed).not.toContain(secret);
    expect(printed).not.toContain(photo);
    cap.restore();
  });
});
