import {
  applyXorTreatmentsToInventory,
  canonicalPhysicalPanelKey,
  inferTreatmentDecision,
  narrativeRespectsStructuredLines,
} from './piece-treatment';
import { mergeDamageInventoryAccumulative } from './draft-quote-resume';
import {
  quoteRowsFromDamageInventory,
  sumQuoteRowsSubtotal,
} from './draft-quote-inventory-pricing';
import { sanitizeCartInventoryForPricing } from './quote-cart-inventory-mode';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';

function mockPricingSnap(
  prices: Record<string, number>,
): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: (canonical: string, level: string) =>
      prices[`${canonical}|${level}`] ?? prices[canonical] ?? 0,
    getAmount: (pieza: string, level: string) =>
      prices[`${pieza}|${level}`] ?? 0,
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: () => ['DL', 'DM', 'DMFuerte'],
  } as MatrixPricingSnapshot;
}

const snap = mockPricingSnap({
  'Cofre|DL': 4000,
  'Cofre|DMFuerte': 7650,
  'Fascia|DL': 2900,
  'Fascia|DM': 3600,
  'Fascia|DMFuerte': 4900,
});

describe('piece-treatment XOR valuador', () => {
  it('TEST H: Cofre y REFACCION:Cofre son la misma pieza física', () => {
    expect(canonicalPhysicalPanelKey('Cofre')).toBe('Cofre');
    expect(canonicalPhysicalPanelKey('REFACCION:Cofre')).toBe('Cofre');
    expect(canonicalPhysicalPanelKey('FD')).toBe('FD');
    expect(canonicalPhysicalPanelKey('REFACCION:FD')).toBe('FD');
  });

  it('TEST A: Cofre + REFACCION:Cofre SUSTITUIR no emite reparación', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        {
          pieza: 'Cofre',
          severidad: 'DMFuerte',
          descripcionTecnica: 'Golpe',
          urls_origen: [],
        },
        {
          pieza: 'REFACCION:Cofre',
          severidad: 'N/A',
          descripcionTecnica: 'Pieza nueva',
          urls_origen: [],
          precioMx: 8500,
          detallesRefaccion: 'Cofre',
        },
      ],
      snap,
    );
    expect(rows.some((r) => r.serviceType === 'REPARACION_PINTURA')).toBe(
      false,
    );
    expect(rows.every((r) => r.tratamiento === 'SUSTITUIR')).toBe(true);
  });

  it('TEST B: Cofre SUSTITUIR solo refacción + montaje/pintura', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        {
          pieza: 'Cofre',
          severidad: 'DMFuerte',
          descripcionTecnica: 'Cofre colapsado',
          urls_origen: [],
          tratamiento: 'SUSTITUIR',
          precioMx: 8500,
        },
      ],
      snap,
    );
    expect(rows.map((r) => r.serviceType)).toEqual([
      'REFACCION',
      'MONTAJE_PINTURA',
    ]);
    expect(rows[0]?.precioMx).toBe(8500);
    expect(rows[1]?.severidad).toBe('MONTAJE_PINTURA');
    expect(rows[1]?.precioMx).toBe(4000);
    expect(rows[1]?.priceSource).toBe('LEGACY_REPAIR_MATRIX_FALLBACK');
  });

  it('TEST C: FD REPARAR solo una línea de reparación, sin REFACCION', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        {
          pieza: 'FD',
          severidad: 'DM',
          descripcionTecnica: 'Abolladura reparable',
          urls_origen: [],
          tratamiento: 'REPARAR',
        },
      ],
      snap,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.serviceType).toBe('REPARACION_PINTURA');
    expect(rows[0]?.pieza).toBe('FD');
    expect(rows.some((r) => r.serviceType === 'REFACCION')).toBe(false);
  });

  it('TEST D: FD INCIERTO cobra solo la estimación de reparación', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        {
          pieza: 'FD',
          severidad: 'DMFuerte',
          descripcionTecnica: 'Impacto fuerte, anclajes no visibles',
          urls_origen: [],
          tratamiento: 'INCIERTO',
        },
      ],
      snap,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.serviceType).toBe('REPARACION_PINTURA');
    expect(rows[0]?.tratamiento).toBe('INCIERTO');
    expect(rows[0]?.disclaimer).toMatch(/revisión física/i);
    expect(rows.some((r) => r.serviceType === 'REFACCION')).toBe(false);
  });

  it('TEST E: Faro PENDIENTE subtotal 0 y no altera el total', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        {
          pieza: 'FD',
          severidad: 'DL',
          descripcionTecnica: 'Rayón',
          urls_origen: [],
          tratamiento: 'REPARAR',
        },
        {
          pieza: 'Faro_Derecho',
          severidad: 'DF',
          descripcionTecnica: 'Faro estrellado',
          urls_origen: [],
          tratamiento: 'PENDIENTE',
        },
      ],
      snap,
    );
    const pending = rows.find((r) => r.serviceType === 'PENDIENTE');
    expect(pending?.precioMx).toBe(0);
    expect(pending?.billable).toBe(false);
    const withoutPending = rows.filter((r) => r.serviceType !== 'PENDIENTE');
    expect(sumQuoteRowsSubtotal(rows)).toBe(sumQuoteRowsSubtotal(withoutPending));
  });

  it('TEST F: daños internos posibles no modifican totalGlobal', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        {
          pieza: 'PDI',
          severidad: 'DL',
          descripcionTecnica: 'Puerta',
          urls_origen: [],
        },
        {
          pieza: 'PDI_INT',
          severidad: 'N/A',
          descripcionTecnica: 'Soporte frontal',
          urls_origen: [],
          precioMx: 8000,
          precioMaximo: 12000,
        } as never,
      ],
      snap,
    );
    const billed = rows.filter((r) => r.serviceType === 'REPARACION_PINTURA');
    expect(sumQuoteRowsSubtotal(rows)).toBe(sumQuoteRowsSubtotal(billed));
    expect(rows.some((r) => r.serviceType === 'ADVERTENCIA')).toBe(true);
  });

  it('TEST G: sanitize/rebuild colapsa Cofre + REFACCION:Cofre a un XOR', () => {
    const sanitized = sanitizeCartInventoryForPricing([
      {
        pieza: 'Cofre',
        severidad: 'DMFuerte',
        descripcionTecnica: 'Cofre',
        urls_origen: [],
      },
      {
        pieza: 'REFACCION:Cofre',
        severidad: 'N/A',
        descripcionTecnica: 'Refacción',
        urls_origen: [],
        precioMx: 8500,
      },
    ]);
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0]?.tratamiento).toBe('SUSTITUIR');
    const rows = quoteRowsFromDamageInventory(sanitized, snap);
    expect(rows.some((r) => r.serviceType === 'REPARACION_PINTURA')).toBe(
      false,
    );
    expect(rows.filter((r) => r.serviceType === 'REFACCION')).toHaveLength(1);
  });

  it('TEST H: mergeDamageInventoryAccumulative une Cofre y REFACCION:Cofre', () => {
    const merged = mergeDamageInventoryAccumulative(
      [
        {
          pieza: 'Cofre',
          severidad: 'DM',
          descripcionTecnica: 'Prev',
          urls_origen: [],
        },
      ],
      [
        {
          pieza: 'REFACCION:Cofre',
          severidad: 'N/A',
          descripcionTecnica: 'Nueva',
          urls_origen: [],
          precioMx: 8500,
        },
      ],
      (raw) => raw,
    );
    expect(merged.merged).toHaveLength(1);
    expect(canonicalPhysicalPanelKey(merged.merged[0]!.pieza)).toBe('Cofre');
    expect(merged.merged[0]?.tratamiento).toBe('SUSTITUIR');
  });

  it('TEST I: total = suma de líneas cobrables', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        {
          pieza: 'Cofre',
          severidad: 'DMFuerte',
          descripcionTecnica: 'colapsado',
          urls_origen: [],
          tratamiento: 'SUSTITUIR',
          precioMx: 8500,
        },
        {
          pieza: 'Faro_Izquierdo',
          severidad: 'DF',
          descripcionTecnica: 'roto',
          urls_origen: [],
          tratamiento: 'PENDIENTE',
        },
      ],
      snap,
    );
    const expected = rows
      .filter((r) => r.billable !== false)
      .reduce((acc, r) => acc + r.precioMx, 0);
    expect(sumQuoteRowsSubtotal(rows)).toBe(expected);
  });

  it('TEST J: el texto no puede invertir sustitución en reparación', () => {
    const lines = [
      {
        pieza: 'Cofre',
        description: 'Refacción de Cofre',
        tratamiento: 'SUSTITUIR' as const,
        serviceType: 'REFACCION' as const,
        precioMx: 8500,
        billable: true,
      },
    ];
    expect(
      narrativeRespectsStructuredLines(
        '🛠️ Refacción de Cofre: $8,500 MXN. Total $8,500.',
        lines,
      ),
    ).toBe(true);
    expect(
      narrativeRespectsStructuredLines(
        '🛠️ Reparar y pintar Cofre: $8,500 MXN. Total $8,500.',
        lines,
      ),
    ).toBe(false);
  });

  it('inferencia legacy: rotura DF sin tratamiento → SUSTITUIR en panel', () => {
    expect(
      inferTreatmentDecision({
        pieza: 'Cofre',
        severidad: 'DF',
        descripcionTecnica: 'cofre roto y partido',
        urls_origen: [],
      }),
    ).toBe('SUSTITUIR');
  });

  it('applyXorTreatmentsToInventory deja un ítem por pieza física', () => {
    const out = applyXorTreatmentsToInventory([
      {
        pieza: 'Cofre',
        severidad: 'DM',
        descripcionTecnica: 'a',
        urls_origen: [],
      },
      {
        pieza: 'REFACCION:Cofre',
        severidad: 'N/A',
        descripcionTecnica: 'b',
        urls_origen: [],
        precioMx: 1000,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.tratamiento).toBe('SUSTITUIR');
  });
});
