import { applyQuoteAuthority } from './quote-authority';

const line = (part: string, price = 8500, id = 'L1', visual?: string) => ({
  line_id: id,
  part,
  treatment: 'repair_paint',
  price_mxn: price,
  damage_severity: 'unknown',
  validation: 'human_confirmed',
  ...(visual ? { visual_part: visual } : {}),
});

describe('CAL-027 quote authority', () => {
  it('keeps the declared right side when vision says left', () => {
    const result = applyQuoteAuthority({
      lineItems: [line('salpicadera trasera derecha', 8500, 'L1', 'salpicadera trasera izquierda')],
      visualObservations: [],
      severity: null,
      operatorStatement: 'Reparación y pintura de salpicadera trasera derecha: $8,500',
    });
    const stored = result.lineItems as Array<Record<string, unknown>>;
    expect(stored[0]).toMatchObject({
      part: 'salpicadera trasera derecha',
      treatment: 'repair_paint',
      price_mxn: 8500,
    });
    expect(stored[0]).not.toHaveProperty('visual_part');
    expect(result.visualObservations).toEqual([
      expect.stringContaining('Posible discrepancia visual'),
    ]);
    expect(String(result.visualObservations)).not.toContain('confirmado como');
    expect(String(result.visualObservations)).toContain('No es un hecho confirmado');
    expect(String(result.visualObservations)).toContain('visual_inference');
  });

  it('restores the human side and does not rewrite treatment or price', () => {
    const result = applyQuoteAuthority({
      lineItems: [line('salpicadera trasera izquierda', 8500)],
      visualObservations: [],
      severity: null,
      operatorStatement: 'Reparación y pintura de salpicadera trasera derecha: $8,500',
    });
    expect(result.lineItems).toEqual([
      expect.objectContaining({
        part: 'salpicadera trasera derecha',
        treatment: 'repair_paint',
        price_mxn: 8500,
      }),
    ]);
  });

  it('reads medio-leve for one zone and leaves the other unclassified', () => {
    const result = applyQuoteAuthority({
      lineItems: [
        line('salpicadera trasera derecha', 8500, 'L1'),
        line('fascia delantera', 6300, 'L2'),
      ],
      visualObservations: [],
      severity: [{ lineId: 'L1', assessment: 'visual_inference', level: 'leve' }],
      operatorStatement: 'Salpicadera trasera derecha: daño medio-leve. Fascia delantera sin otro dato.',
    });
    expect(result.severity).toEqual([
      { lineId: 'L1', assessment: 'human_declaration', level: 'medio_leve' },
    ]);
    expect(result.severity?.some((item) => item.assessment === 'visual_inference')).toBe(false);
    expect(result.severity?.some((item) => item.lineId === 'L2')).toBe(false);
    expect(String(result.visualObservations)).toContain('no sustituye la severidad declarada');
    expect(JSON.stringify(result)).not.toContain('authenticated_owner');
    expect(JSON.stringify(result)).not.toContain('validated');
  });

  it('keeps distinct declared levels on distinct zones', () => {
    const result = applyQuoteAuthority({
      lineItems: [
        line('salpicadera trasera derecha', 8500, 'L1'),
        line('fascia delantera', 6300, 'L2'),
      ],
      visualObservations: [],
      severity: null,
      operatorStatement: 'Salpicadera trasera derecha: daño medio-leve. Fascia delantera: daño fuerte.',
    });
    expect(result.severity).toEqual([
      { lineId: 'L1', assessment: 'human_declaration', level: 'medio_leve' },
      { lineId: 'L2', assessment: 'human_declaration', level: 'fuerte' },
    ]);
  });

  it('leaves an ambiguous expression unclassified', () => {
    const result = applyQuoteAuthority({
      lineItems: [line('salpicadera trasera derecha')],
      visualObservations: [],
      severity: null,
      operatorStatement: 'Salpicadera trasera derecha: daño medio o fuerte.',
    });
    expect(result.severity).toBeNull();
    expect(String(result.visualObservations)).toContain('sin clasificación');
  });
});
