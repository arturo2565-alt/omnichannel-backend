import {
  buildDraftClientNarrativeFinalUserMessage,
  buildDraftClientNarrativeReportFromAnalysis,
  buildDraftClientNarrativeReportFromPieces,
  containsClientFacingNumericId,
  dialogueTurnsToChatMessages,
} from './draft-quote-client-narrative';

describe('draft-quote-client-narrative', () => {
  it('buildDraftClientNarrativeReportFromAnalysis incluye inventario y vehículo', () => {
    const report = buildDraftClientNarrativeReportFromAnalysis({
      pieza: 'Puerta',
      severidad: 'DM',
      partesAfectadas: ['Puerta'],
      descripcionTecnica: 'Abolladura media',
      justificacion: 'Peritaje visual',
      vehiculoDetectado: 'Toyota Corolla 2019',
      inventory: [
        {
          pieza: 'Puerta',
          severidad: 'DM',
          descripcionTecnica: 'Abolladura media',
          urls_origen: [],
        },
      ],
    });
    expect(report.vehiculoDetectado).toBe('Toyota Corolla 2019');
    expect(report.inventory).toHaveLength(1);
    expect(report.inventory[0]?.pieza).toBe('Puerta');
  });

  it('buildDraftClientNarrativeReportFromPieces arma inventario mínimo', () => {
    const report = buildDraftClientNarrativeReportFromPieces(
      ['Cofre', 'Fascia'],
      'Nissan March',
    );
    expect(report.inventory).toHaveLength(2);
    expect(report.vehiculoDetectado).toBe('Nissan March');
  });

  it('buildDraftClientNarrativeFinalUserMessage embebe reporte y cotización', () => {
    const msg = buildDraftClientNarrativeFinalUserMessage(
      { inventory: [{ pieza: 'Cofre' }] },
      { lineas: [{ pieza: 'Cofre', precioMx: 5000 }], totalMx: 5000, moneda: 'MXN' },
      { contactName: 'Juan', hasActiveAppointment: false, mapsUrl: 'https://maps.test' },
    );
    expect(msg).toContain('reportePericial');
    expect(msg).toContain('cotizacion');
    expect(msg).toContain('5000');
  });

  it('dialogueTurnsToChatMessages omite cloudinary y vacíos', () => {
    const turns = dialogueTurnsToChatMessages([
      { role: 'user', content: 'Hola' },
      { role: 'assistant', content: '   ' },
      { role: 'user', content: 'https://cloudinary.com/x.jpg' },
      { role: 'assistant', content: 'Gracias por escribir' },
    ]);
    expect(turns).toEqual([
      { role: 'user', content: 'Hola' },
      { role: 'assistant', content: 'Gracias por escribir' },
    ]);
  });

  it('containsClientFacingNumericId detecta IDs de plataforma', () => {
    expect(containsClientFacingNumericId('Tu PSID: 123456789012')).toBe(true);
    expect(containsClientFacingNumericId('Cotización lista para ti')).toBe(false);
  });
});
