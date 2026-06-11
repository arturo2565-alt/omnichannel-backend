import {
  detectCartPricingMode,
  mergeCartInventoryWithPricingMode,
  sanitizeCartInventoryForPricing,
} from './quote-cart-inventory-mode';
import { VISION_BPC_PIEZA_CODE } from './vision-bpc-inventory';

describe('quote-cart-inventory-mode', () => {
  const bpcItem = {
    pieza: VISION_BPC_PIEZA_CODE,
    severidad: 'DM',
    descripcionTecnica: 'Baño completo Vocho.',
    urls_origen: [] as string[],
  };

  const toldoItem = {
    pieza: 'Toldo',
    severidad: 'DL',
    descripcionTecnica: 'Cotización express — Toldo.',
    urls_origen: [] as string[],
  };

  const puertaItem = {
    pieza: 'PDI',
    severidad: 'DL',
    descripcionTecnica: 'Puerta delantera izquierda.',
    urls_origen: [] as string[],
  };

  it('detectCartPricingMode: bpc solo cuando no hay piezas sueltas', () => {
    expect(detectCartPricingMode([bpcItem])).toBe('bpc');
    expect(detectCartPricingMode([toldoItem, puertaItem])).toBe('piezas');
    expect(detectCartPricingMode([bpcItem, toldoItem])).toBe('piezas');
  });

  it('sanitizeCartInventoryForPricing elimina BPC si hay piezas sueltas', () => {
    const mixed = [bpcItem, toldoItem, puertaItem];
    const sanitized = sanitizeCartInventoryForPricing(mixed);
    expect(sanitized.map((i) => i.pieza)).toEqual(['Toldo', 'PDI']);
  });

  it('mergeCartInventoryWithPricingMode: pieza nueva quita BPC previo', () => {
    const merged = mergeCartInventoryWithPricingMode([bpcItem], toldoItem);
    expect(merged.map((i) => i.pieza)).toEqual(['Toldo']);
  });

  it('mergeCartInventoryWithPricingMode: BPC reemplaza todo el inventario', () => {
    const merged = mergeCartInventoryWithPricingMode(
      [toldoItem, puertaItem],
      bpcItem,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.pieza).toBe(VISION_BPC_PIEZA_CODE);
  });
});
