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

  it('conserva renglones REFACCION junto a piezas de matriz', () => {
    const refaccion = {
      pieza: 'REFACCION:Calavera_Izquierda',
      severidad: 'N/A',
      descripcionTecnica: 'Pieza nueva',
      urls_origen: [] as string[],
      precioMx: 2860,
    };
    const mixed = [puertaItem, refaccion];
    expect(detectCartPricingMode(mixed)).toBe('piezas');
    const sanitized = sanitizeCartInventoryForPricing(mixed);
    expect(sanitized.map((i) => i.pieza)).toEqual([
      'PDI',
      'REFACCION:Calavera_Izquierda',
    ]);
    expect(sanitized[1]?.precioMx).toBe(2860);
    expect(detectCartPricingMode([refaccion])).toBe('piezas');
    expect(
      sanitizeCartInventoryForPricing([refaccion]).map((i) => i.pieza),
    ).toEqual(['REFACCION:Calavera_Izquierda']);
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
