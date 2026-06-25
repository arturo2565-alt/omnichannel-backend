import {
  getWhatsAppEnvConfig,
  isWhatsAppPayloadForOurAccount,
  normalizeWhatsAppDigits,
  getWhatsAppVerifyToken,
  getWhatsAppAccessToken,
  getWhatsAppPhoneNumberId,
  buildWhatsAppMessagesUrl,
  normalizeWhatsAppRecipientWaId,
  normalizeWhatsAppMessageBody,
} from './whatsapp-config';

describe('whatsapp-config', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('acepta payload cuando phone_number_id coincide', () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'PHONE-99';
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = 'WABA-1';
    expect(
      isWhatsAppPayloadForOurAccount(
        { phoneNumberId: 'PHONE-99', wabaId: 'OTHER' },
        getWhatsAppEnvConfig(),
      ),
    ).toBe(true);
  });

  it('acepta payload cuando WABA coincide aunque phone difiera', () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'PHONE-99';
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = 'WABA-1';
    expect(
      isWhatsAppPayloadForOurAccount(
        { wabaId: 'WABA-1', phoneNumberId: 'OTHER' },
        getWhatsAppEnvConfig(),
      ),
    ).toBe(true);
  });

  it('rechaza payload de otra cuenta cuando hay env configurado', () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'PHONE-99';
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = 'WABA-1';
    expect(
      isWhatsAppPayloadForOurAccount(
        { wabaId: 'WABA-OTHER', phoneNumberId: 'PHONE-OTHER' },
        getWhatsAppEnvConfig(),
      ),
    ).toBe(false);
  });

  it('normaliza dígitos de WHATSAPP_NUMBER vs display_phone_number', () => {
    process.env.WHATSAPP_NUMBER = '+52 55 1234 5678';
    expect(
      isWhatsAppPayloadForOurAccount(
        { displayPhoneNumber: '525512345678' },
        getWhatsAppEnvConfig(),
      ),
    ).toBe(true);
    expect(normalizeWhatsAppDigits('+52 55 1234 5678')).toBe('525512345678');
  });

  it('getWhatsAppVerifyToken lee solo WHATSAPP_VERIFY_TOKEN', () => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'AutoFix_Secret_2026';
    delete process.env.FB_VERIFY_TOKEN;
    expect(getWhatsAppVerifyToken()).toBe('AutoFix_Secret_2026');
  });

  it('getWhatsAppVerifyToken no usa FB_VERIFY_TOKEN como fallback', () => {
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    process.env.FB_VERIFY_TOKEN = 'fb-only';
    expect(getWhatsAppVerifyToken()).toBe('');
  });

  it('buildWhatsAppMessagesUrl usa WHATSAPP_PHONE_NUMBER_ID', () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
    expect(buildWhatsAppMessagesUrl()).toBe(
      'https://graph.facebook.com/v21.0/1234567890/messages',
    );
  });

  it('getWhatsAppAccessToken lee WHATSAPP_ACCESS_TOKEN', () => {
    process.env.WHATSAPP_ACCESS_TOKEN = 'EAA-test-token';
    expect(getWhatsAppAccessToken()).toBe('EAA-test-token');
  });

  it('normalizeWhatsAppRecipientWaId conserva el 1 de celular MX del webhook (521)', () => {
    expect(normalizeWhatsAppRecipientWaId('5215512345678')).toBe('5215512345678');
    expect(normalizeWhatsAppRecipientWaId('5215527677274')).toBe('5215527677274');
    expect(normalizeWhatsAppRecipientWaId('+52 1 55 1234 5678')).toBe('5215512345678');
  });

  it('normalizeWhatsAppRecipientWaId no altera wa_id ya normalizado sin el 1', () => {
    expect(normalizeWhatsAppRecipientWaId('525512345678')).toBe('525512345678');
  });

  it('normalizeWhatsAppMessageBody unifica CRLF y CR a LF', () => {
    expect(normalizeWhatsAppMessageBody('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('normalizeWhatsAppMessageBody convierte secuencias escapadas a LF', () => {
    expect(normalizeWhatsAppMessageBody('linea1\\nlinea2')).toBe('linea1\nlinea2');
    expect(normalizeWhatsAppMessageBody('linea1\\\\nlinea2')).toBe('linea1\nlinea2');
    expect(normalizeWhatsAppMessageBody('a\\r\\nb')).toBe('a\nb');
  });

  it('normalizeWhatsAppMessageBody produce JSON válido con \\n escapado', () => {
    const body = normalizeWhatsAppMessageBody('uno\\ntres\r\ncuatro');
    const payload = JSON.stringify({ text: { body } });
    expect(() => JSON.parse(payload)).not.toThrow();
    expect(JSON.parse(payload).text.body).toBe('uno\ntres\ncuatro');
  });
});
