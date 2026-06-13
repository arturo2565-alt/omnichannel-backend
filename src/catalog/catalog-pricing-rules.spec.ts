import {
  aggregatePieceBaseRows,
  coerceDamageMagnitude,
  computeCatalogPiecePrice,
  mergeCatalogPricingRules,
} from './catalog-pricing-rules';

describe('catalog-pricing-rules', () => {
  it('coerceDamageMagnitude mapea legacy a 4 niveles', () => {
    expect(coerceDamageMagnitude('DL')).toBe('LEVE');
    expect(coerceDamageMagnitude('DM')).toBe('MEDIO');
    expect(coerceDamageMagnitude('DF')).toBe('FUERTE');
    expect(coerceDamageMagnitude('DMFuerte')).toBe('MUY_FUERTE');
  });

  it('aggregatePieceBaseRows toma LEVE o DL como base', () => {
    const bases = aggregatePieceBaseRows([
      { id: '1', servicio: 'Fascia', severidad: 'DL', precio: 2900, diasEntrega: 4 },
      { id: '2', servicio: 'Fascia', severidad: 'DM', precio: 3600, diasEntrega: 4 },
    ]);
    expect(bases).toHaveLength(1);
    expect(bases[0]!.basePrice).toBe(2900);
  });

  it('computeCatalogPiecePrice aplica tamaño y premium', () => {
    const rules = mergeCatalogPricingRules(null);
    const bmw = computeCatalogPiecePrice({
      basePrice: 2900,
      sizeTier: 'Mediano',
      isPremium: true,
      damageMagnitude: 'LEVE',
      rules,
    });
    expect(bmw).toBe(3300);
  });
});
