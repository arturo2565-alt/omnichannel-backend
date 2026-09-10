import {
  BPCC_TURNKEY_LABEL,
  banioTurnkeyDisplayLabel,
  resolveBanioCodeUnitPrice,
} from './vehicle-piece-pricing';

describe('resolveBanioCodeUnitPrice / BPCC llave en mano', () => {
  it('BPE deja la base exterior', () => {
    expect(resolveBanioCodeUnitPrice(20_000, 'BPE', 'Mediano')).toBe(20_000);
  });

  it('BPEI suma interiores (+15%) redondeado a 50', () => {
    expect(resolveBanioCodeUnitPrice(20_000, 'BPEI', 'Mediano')).toBe(23_000);
  });

  it('BPCC incluye interiores + color en un solo monto', () => {
    // 20000 * 1.15 = 23000 + 8000 (Mediano) = 31000
    expect(resolveBanioCodeUnitPrice(20_000, 'BPCC', 'Mediano')).toBe(31_000);
    // Grande: +10000
    expect(resolveBanioCodeUnitPrice(20_000, 'BPCC', 'Grande')).toBe(33_000);
  });

  it('etiqueta BPCC es integral, no desglose', () => {
    expect(banioTurnkeyDisplayLabel('BPCC')).toBe(BPCC_TURNKEY_LABEL);
    expect(banioTurnkeyDisplayLabel('BPCC')).toMatch(/Exterior e Interiores/);
  });
});
