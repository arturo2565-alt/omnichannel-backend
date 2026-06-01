import {
  extractMetaWhatsAppInboundEvents,
  extractWaIdFromRawWhatsAppPayload,
  isMetaWhatsAppWebhook,
} from './meta-whatsapp-webhook';

describe('meta-whatsapp-webhook', () => {
  const samplePayload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-12345',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550001111',
                phone_number_id: 'PHONE-NUM-ID-99',
              },
              contacts: [
                {
                  profile: { name: 'Test User' },
                  wa_id: '16315551181',
                },
              ],
              messages: [
                {
                  from: '16315551181',
                  id: 'wamid.TEST',
                  timestamp: '1504902988',
                  type: 'text',
                  text: { body: 'Hello from WhatsApp test' },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };

  it('detecta whatsapp_business_account como webhook válido', () => {
    expect(isMetaWhatsAppWebhook(samplePayload)).toBe(true);
    expect(isMetaWhatsAppWebhook({ object: 'page', entry: [] })).toBe(false);
  });

  it('extrae WABA, teléfono del negocio y wa_id del cliente', () => {
    const events = extractMetaWhatsAppInboundEvents(samplePayload);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      wabaId: 'WABA-12345',
      phoneNumberId: 'PHONE-NUM-ID-99',
      displayPhoneNumber: '15550001111',
      threadWaId: '16315551181',
      contactName: 'Test User',
      messageId: 'wamid.TEST',
      text: 'Hello from WhatsApp test',
    });
  });

  it('extractWaIdFromRawWhatsAppPayload resuelve wa_id en payload anidado', () => {
    expect(extractWaIdFromRawWhatsAppPayload(samplePayload)).toBe('16315551181');
  });

  it('ignora cambios de statuses sin messages', () => {
    const statusOnly = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA-1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550001111',
                  phone_number_id: 'PN-1',
                },
                statuses: [
                  {
                    id: 'wamid.OUT',
                    status: 'delivered',
                    timestamp: '1504902988',
                    recipient_id: '16315551181',
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(extractMetaWhatsAppInboundEvents(statusOnly)).toEqual([]);
  });
});
