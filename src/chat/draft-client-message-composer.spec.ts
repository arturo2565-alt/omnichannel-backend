import {
  buildDraftClientMessageStructuredPayload,
  buildDraftClientMessageSystemPrompt,
  containsClientFacingNumericId,
  peritajeFromDamageAnalysisLike,
  validateDraftClientMessageOutput,
} from './draft-client-message-composer';
import { narrativeRespectsStructuredLines } from './piece-treatment';

describe('draft-client-message-composer', () => {
  it('buildDraftClientMessageSystemPrompt concatena chatAppointment + anexo técnico', () => {
    const out = buildDraftClientMessageSystemPrompt('Eres asesor premium.');
    expect(out).toContain('Eres asesor premium.');
    expect(out).toContain('mensaje al cliente');
    expect(out).toContain('Mismo formato y tono');
  });

  it('buildDraftClientMessageStructuredPayload agrupa peritaje, cotización y contexto', () => {
    const payload = buildDraftClientMessageStructuredPayload({
      contactName: 'Juan',
      lineRows: [{ pieza: 'Puerta', precioMx: 12000 }],
      total: 12000,
      currency: 'MXN',
      hasActiveAppointment: false,
      appointmentFormatted: '',
      mapsUrl: 'https://maps.example',
      damageIntro: 'Ya analizamos tus fotos.',
      vehicleModel: 'Toyota Corolla',
      reference: 'DRAFT-1',
      isComplement: false,
      previousPiezas: [],
      newPiezas: [],
      pricingMode: 'piezas',
      peritaje: {
        inventario: [{ pieza: 'Puerta', severidad: 'DM' }],
        imageCount: 2,
      },
    });
    expect(payload.reportePericial).toMatchObject({
      pricingMode: 'piezas',
      fotosAnalizadas: 2,
    });
    expect(payload.cotizacion).toMatchObject({
      total: 12000,
      pricingIncomplete: false,
    });
    expect(
      (payload.cotizacion as { lineRows: Array<{ description?: string }> })
        .lineRows[0]?.description,
    ).toBe('Puerta');
    expect(payload.contextoOperativo).toMatchObject({ contactName: 'Juan' });
  });

  it('peritajeFromDamageAnalysisLike mapea inventario de visión', () => {
    const p = peritajeFromDamageAnalysisLike({
      inventory: [{ pieza: 'BPC', severidad: 'Mediano', descripcionTecnica: 'Baño completo' }],
      vehiculoDetectado: 'VW Jetta',
    });
    expect(p.inventario).toHaveLength(1);
    expect(p.vehiculoDetectado).toBe('VW Jetta');
  });

  it('humaniza códigos crudos de visión antes de redactar', () => {
    const p = peritajeFromDamageAnalysisLike({
      inventory: [{ pieza: 'Calavera_TI', severidad: 'DF' }],
    });
    expect(p.inventario[0]?.pieza).toMatch(/calavera trasera izquierda/i);
    expect(p.inventario[0]?.pieza).not.toBe('Calavera_TI');
  });

  it('validateDraftClientMessageOutput rechaza IDs de plataforma', () => {
    expect(
      validateDraftClientMessageOutput(
        'Hola, aquí tienes la cotización detallada con el total acordado para tu vehículo.',
      ),
    ).toBe(true);
    expect(
      validateDraftClientMessageOutput('Tu PSID: 123456789012345'),
    ).toBe(false);
    expect(containsClientFacingNumericId('Messenger ID 99887766')).toBe(true);
  });

  it('TEST J: el payload expone treatment/serviceType y el checker bloquea inversión', () => {
    const payload = buildDraftClientMessageStructuredPayload({
      contactName: 'Juan',
      lineRows: [
        {
          pieza: 'Cofre',
          precioMx: 8500,
          description: 'Refacción de Cofre',
          tratamiento: 'SUSTITUIR',
          serviceType: 'REFACCION',
          billable: true,
        },
      ],
      total: 8500,
      currency: 'MXN',
      hasActiveAppointment: false,
      appointmentFormatted: '',
      mapsUrl: '',
      damageIntro: 'Ya analizamos tus fotos.',
      vehicleModel: 'Mazda',
      isComplement: false,
      previousPiezas: [],
      newPiezas: [],
      pricingMode: 'piezas',
      peritaje: { inventario: [{ pieza: 'Cofre', severidad: 'DMFuerte' }] },
    });
    const rows = (payload.cotizacion as { lineRows: Array<{ treatment?: string; serviceType?: string; description?: string }> }).lineRows;
    expect(rows[0]?.treatment).toBe('SUSTITUIR');
    expect(rows[0]?.serviceType).toBe('REFACCION');
    expect(rows[0]?.description).toMatch(/Refacción/);
    expect(
      narrativeRespectsStructuredLines(
        '🛠️ Reparar y pintar Cofre: $8,500 MXN',
        [
          {
            pieza: 'Cofre',
            description: 'Refacción de Cofre',
            tratamiento: 'SUSTITUIR',
            serviceType: 'REFACCION',
            precioMx: 8500,
            billable: true,
          },
        ],
      ),
    ).toBe(false);
  });
});
