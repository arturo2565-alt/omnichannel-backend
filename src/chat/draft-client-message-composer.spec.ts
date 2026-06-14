import {
  buildDraftClientMessageStructuredPayload,
  buildDraftClientMessageSystemPrompt,
  containsClientFacingNumericId,
  peritajeFromDamageAnalysisLike,
  validateDraftClientMessageOutput,
} from './draft-client-message-composer';

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
    expect(payload.cotizacion).toMatchObject({ total: 12000 });
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
});
