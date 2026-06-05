import {
  buildActiveQuoteSummaryLines,
  formatActiveQuoteSummaryForPrompt,
} from './active-quote-summary';

describe('active-quote-summary', () => {
  it('formatActiveQuoteSummaryForPrompt lista líneas y total', () => {
    const lines = buildActiveQuoteSummaryLines([
      { pieza: 'FT', severidad: 'DL', precioMx: 2900 },
      { pieza: 'PDD', severidad: 'DL', precioMx: 3200 },
    ]);
    const text = formatActiveQuoteSummaryForPrompt({
      lines,
      totalMx: 6100,
      vehicleLabel: 'Volkswagen Bora 2012',
      reference: 'COT-AF-ABC12345',
    });
    expect(text).toContain('Fascia trasera');
    expect(text).toContain('Puerta delantera derecha');
    expect(text).toContain('6,100');
    expect(text).toContain('Volkswagen Bora 2012');
  });

  it('mensaje vacío cuando no hay líneas', () => {
    const text = formatActiveQuoteSummaryForPrompt({ lines: [], totalMx: 0 });
    expect(text).toContain('Aún no hay cotización activa');
  });
});
