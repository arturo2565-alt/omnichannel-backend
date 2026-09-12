import {
  buildCatalogContextForLlm,
  buildLegacyFinancialCatalogAppendForLlm,
  catalogAppendContainsFinancialInstructions,
  effectiveChatPromptHash,
  hashPromptText,
} from './catalog-prompt-append';

describe('catalog prompt append CANONICAL vs LEGACY', () => {
  const names = ['Fascia', 'Baño de Pintura Exterior', 'Cerámico Automotriz'];

  it('CANONICAL composition no contiene instrucciones de cálculo/precios/totales/suplementos', () => {
    const text = buildCatalogContextForLlm(names);
    expect(catalogAppendContainsFinancialInstructions(text)).toBe(false);
    expect(text).toMatch(/Fascia/);
    expect(text).toMatch(/BPE/);
    expect(text).toMatch(/Baño de Pintura Exterior e Interiores/);
    expect(text).toMatch(/Baño de Pintura con Cambio de Color/);
    expect(text).not.toMatch(/\$\s*8[,.]?000/);
    expect(text).not.toMatch(/suma el suplemento/i);
    expect(text).not.toMatch(/entrega total y desglose/i);
  });

  it('LEGACY aislado conserva el texto financiero histórico', () => {
    const legacy = buildLegacyFinancialCatalogAppendForLlm(names);
    expect(catalogAppendContainsFinancialInstructions(legacy)).toBe(true);
    expect(legacy).toMatch(/\$8,000/);
  });

  it('hashPromptText es estable y no hashea historial', () => {
    expect(hashPromptText('abc')).toBe(hashPromptText('abc'));
    expect(hashPromptText('abc')).not.toBe(hashPromptText('abcd'));
    const a = effectiveChatPromptHash('base', 'append');
    const b = effectiveChatPromptHash('base', 'append');
    expect(a).toBe(b);
  });
});
