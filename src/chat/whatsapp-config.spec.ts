import {
  getWhatsAppEnvConfig,
  isWhatsAppPayloadForOurAccount,
  normalizeWhatsAppDigits,
  getWhatsAppVerifyToken,
  getWhatsAppAccessToken,
  getWhatsAppPhoneNumberId,
  buildWhatsAppMessagesUrl,
  normalizeWhatsAppRecipientWaId,
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

  it('normalizeWhatsAppRecipientWaId quita el 1 extra en móviles MX (521→52)', () => {
    expect(normalizeWhatsAppRecipientWaId('5215512345678')).toBe('525512345678');
    expect(normalizeWhatsAppRecipientWaId('+52 1 55 1234 5678')).toBe('525512345678');
  });

  it('normalizeWhatsAppRecipientWaId no altera números ya de 12 dígitos', () => {
    expect(normalizeWhatsAppRecipientWaId('525512345678')).toBe('525512345678');
  });
});
