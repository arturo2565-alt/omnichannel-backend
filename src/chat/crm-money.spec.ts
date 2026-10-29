import {
  lineSubtotalCents,
  parseServiceLines,
  pesosFromCents,
} from './crm-money';
import { parseManualAppointmentInput } from './crm-appointment';

describe('crm-money', () => {
  it('redondea el subtotal al centavo más cercano sin usar el total como venta', () => {
    expect(lineSubtotalCents(100, 450000)).toBe(450000);
    expect(lineSubtotalCents(200, 15000)).toBe(30000);
    expect(lineSubtotalCents(101, 333)).toBe(336);
    expect(pesosFromCents(450050)).toBe(4501);
    expect(pesosFromCents(336)).toBe(3);
  });

  it('rechaza cantidades y precios fuera de rango', () => {
    const invalid = parseServiceLines([
      { name: 'Pulido', quantityHundredths: 0, unitPriceCents: 100 },
    ]);
    expect(invalid.ok).toBe(false);
  });

  it('no acepta una atribución verificada escrita a mano', () => {
    const parsed = parseManualAppointmentInput({
      clientRequestId: 'crm-req-0001',
      clientName: 'Ana López',
      phone: '5512345678',
      scheduledAtIso: '2026-05-26T14:00:00',
      attributionKind: 'verified',
      campaignName: 'Primavera',
    });
    expect(parsed.ok).toBe(false);
  });

  it('deja la atribución vacía en desconocida', () => {
    const parsed = parseManualAppointmentInput({
      clientRequestId: 'crm-req-0001',
      clientName: 'Ana López',
      phone: '5512345678',
      scheduledAtIso: '2026-05-26T14:00:00',
      serviceRequested: 'Pintura',
      quotedAmount: 4500,
      origin: 'instagram',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.attributionKind).toBe('unknown');
    expect(parsed.value.campaignName).toBeNull();
    expect(parsed.value.lines).toBeNull();
    expect(parsed.value.quotedAmount).toBe(4500);
  });
});
