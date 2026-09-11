import {
  classifyQuoteRow,
  quoteRowSubtotalForTotal,
  quoteRowsFromDamageInventory,
  buildDraftQuoteLinesFromDamageInventory,
  sumQuoteRowsSubtotal,
} from './draft-quote-inventory-pricing';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';

function mockPricingSnap(
  prices: Record<string, number>,
): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: (canonical: string, level: string) =>
      prices[`${canonical}|${level}`] ??
      prices[canonical] ??
      0,
    getAmount: (pieza: string, level: string) =>
      prices[`${pieza}|${level}`] ?? 0,
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: (canonical: string) =>
      prices[`__sev__${canonical}`]
        ? String(prices[`__sev__${canonical}`]).split('|')
        : ['BASE'],
  } as MatrixPricingSnapshot;
}

describe('draft-quote-inventory-pricing', () => {
  it('suma el mínimo en daños internos y el precio manual en refacciones', () => {
    const lines = [
      {
        pieza: 'Posibles daños internos',
        severidad: 'N/A',
        precioMx: 3000,
        precioMaximo: 8000,
      },
      {
        pieza: 'Refacción: Calavera',
        severidad: 'N/A',
        precioMx: 1500,
        detallesRefaccion: 'Calavera',
      },
      { pieza: 'PDI', severidad: 'DM', precioMx: 4200 },
    ];
    expect(sumQuoteRowsSubtotal(lines)).toBe(1500 + 4200);
    expect(classifyQuoteRow(lines[0])).toBe('internal_damage');
    expect(classifyQuoteRow(lines[1])).toBe('refaccion');
    expect(quoteRowSubtotalForTotal(lines[0])).toBe(0);
  });

  it('quoteRowsFromDamageInventory mantiene FD y FT como líneas separadas', () => {
    const snap = mockPricingSnap({
      'Fascia|DL': 2900,
      'Fascia|DM': 3600,
      'Puerta|DL': 3100,
      'Cofre|DM': 5000,
    });
    const rows = quoteRowsFromDamageInventory(
      [
        { pieza: 'FD', severidad: 'DM', descripcionTecnica: 'Fascia del.', urls_origen: [] },
        { pieza: 'FT', severidad: 'DL', descripcionTecnica: 'Fascia tras.', urls_origen: [] },
        { pieza: 'PDI', severidad: 'DL', descripcionTecnica: 'Puerta', urls_origen: [] },
        { pieza: 'Cofre', severidad: 'DM', descripcionTecnica: 'Cofre', urls_origen: [] },
      ],
      snap,
    );
    expect(rows.map((r) => r.pieza)).toEqual(['FD', 'FT', 'PDI', 'Cofre']);
    expect(sumQuoteRowsSubtotal(rows)).toBe(14850);

    const draftLines = buildDraftQuoteLinesFromDamageInventory(
      [
        { pieza: 'FD', severidad: 'DL', descripcionTecnica: '', urls_origen: [] },
        { pieza: 'FT', severidad: 'DL', descripcionTecnica: '', urls_origen: [] },
      ],
      snap,
    );
    expect(draftLines).toHaveLength(2);
    expect(draftLines[0]?.description).toContain('Fascia delantera');
    expect(draftLines[1]?.description).toContain('Fascia trasera');
  });

  it('quoteRowsFromDamageInventory cotiza servicios integrales por tamaño', () => {
    const snap = mockPricingSnap({
      '__sev__Cerámico Automotriz': 'BASE',
      'Cerámico Automotriz|BASE': 7000,
    });
    const rows = quoteRowsFromDamageInventory(
      [
        {
          pieza: 'CERAMICO',
          severidad: 'Compacto',
          descripcionTecnica: 'Cerámico express',
          urls_origen: [],
        },
        {
          pieza: 'FD',
          severidad: 'DL',
          descripcionTecnica: 'Fascia',
          urls_origen: [],
        },
      ],
      snap,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.pieza).toBe('CERAMICO');
    expect(rows[0]?.precioMx).toBe(7000);
    expect(classifyQuoteRow(rows[0]!)).toBe('integral');
  });

  it('cotiza óptica rota como REFACCION y no como pieza de matriz', () => {
    const snap = mockPricingSnap({
      'Fascia|DF': 4200,
    });
    const rows = quoteRowsFromDamageInventory(
      [
        {
          pieza: 'Calavera_Izquierda',
          severidad: 'DF',
          descripcionTecnica: 'Calavera estrellada',
          urls_origen: [],
        },
        {
          pieza: 'REFACCION:Calavera_Izquierda',
          severidad: 'N/A',
          descripcionTecnica: 'Pieza nueva',
          urls_origen: [],
          precioMx: 2860,
          detallesRefaccion: 'Calavera Trasera Izquierda',
        },
        {
          pieza: 'FT',
          severidad: 'DF',
          descripcionTecnica: 'Fascia',
          urls_origen: [],
        },
      ],
      snap,
    );
    expect(rows.map((r) => r.serviceType)).toEqual(['REFACCION', 'REPARACION_PINTURA']);
    expect(rows[0]?.precioMx).toBe(2860);
    expect(classifyQuoteRow(rows[0]!)).toBe('refaccion');
    expect(rows[1]?.pieza).toBe('FT');
    expect(rows[1]?.tratamiento).toBe('INCIERTO');
    expect(Number.isFinite(rows[1]?.precioMx)).toBe(true);
    expect(rows[1]!.precioMx).toBeGreaterThan(0);
    expect(sumQuoteRowsSubtotal(rows)).toBe(2860 + rows[1]!.precioMx);
  });

  it('DMFuerte en Cofre/Fascia desglosa refacción + cabina, no hojalatería sola', () => {
    const snap = mockPricingSnap({
      'Cofre|DL': 4000,
      'Cofre|DMFuerte': 7650,
      'Fascia|DL': 2900,
      'Fascia|DMFuerte': 4900,
    });
    const rows = quoteRowsFromDamageInventory(
      [
        {
          pieza: 'Cofre',
          severidad: 'DMFuerte',
          descripcionTecnica: 'Cofre colapsado',
          urls_origen: [],
        },
        {
          pieza: 'FD',
          severidad: 'DMFuerte',
          descripcionTecnica: 'Fascia destruida',
          urls_origen: [],
          posibleReemplazoRefaccion: true,
        },
      ],
      snap,
    );
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.serviceType === 'REPARACION_PINTURA')).toHaveLength(0);
    expect(rows.filter((r) => r.serviceType === 'REFACCION')).toHaveLength(2);
    expect(rows.filter((r) => r.serviceType === 'MONTAJE_PINTURA')).toHaveLength(2);
    expect(rows[0]?.descripcionServicio).toMatch(/Refacción de Cofre/i);
    expect(rows[1]?.descripcionServicio).toMatch(/Montar y pintar/i);
    expect(rows[1]?.severidad).toBe('DL');
    expect(rows[1]?.precioMx).toBe(4000);
  });

  it('REFACCION con precio inválido no produce NaN', () => {
    const snap = mockPricingSnap({});
    const rows = quoteRowsFromDamageInventory(
      [
        {
          pieza: 'REFACCION:Faro_Izquierdo',
          severidad: 'N/A',
          descripcionTecnica: '',
          urls_origen: [],
          precioMx: Number.NaN,
        },
      ],
      snap,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.precioMx).toBe(0);
    expect(Number.isFinite(sumQuoteRowsSubtotal(rows))).toBe(true);
  });
});
