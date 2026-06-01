import {
  getWhatsAppEnvConfig,
  isWhatsAppPayloadForOurAccount,
  normalizeWhatsAppDigits,
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
});
