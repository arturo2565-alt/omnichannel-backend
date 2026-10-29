import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCrmCatalogOffer,
  parseCrmLineSnapshot,
  type CrmCatalogRates,
} from './crm-catalog-offer';

const MATRIX = '11111111-1111-4111-8111-111111111111';
const MONTAJE = '22222222-2222-4222-8222-222222222222';
const MONTAJE_PINTURA = '33333333-3333-4333-8333-333333333333';
const BANIO = '44444444-4444-4444-8444-444444444444';

function rates(extra?: Partial<CrmCatalogRates>): CrmCatalogRates {
  return {
    pieceBases: [
      { servicio: 'Salpicadera', basePrice: 4500, matrixRowId: MATRIX },
      { servicio: 'Fascia', basePrice: 2800, matrixRowId: MATRIX },
    ],
    montajeBases: [
      {
        servicio: 'Calavera',
        precio: 900,
        matrixRowId: MONTAJE,
        hasDedicatedRate: true,
      },
      {
        servicio: 'Fascia',
        precio: 0,
        matrixRowId: null,
        hasDedicatedRate: false,
      },
    ],
    montajePinturaBases: [
      {
        servicio: 'Fascia',
        precio: 3200,
        matrixRowId: MONTAJE_PINTURA,
        hasDedicatedRate: true,
      },
      {
        servicio: 'Salpicadera',
        precio: 0,
        matrixRowId: null,
        hasDedicatedRate: false,
      },
      {
        servicio: 'MOLDURA',
        precio: 1500,
        matrixRowId: MONTAJE,
        hasDedicatedRate: true,
      },
    ],
    integralBases: [
      {
        servicio: 'Baño de Pintura Exterior',
        basePrice: 28000,
        matrixRowId: BANIO,
        banioCode: 'BPE',
      },
      {
        servicio: 'Cerámico Automotriz',
        basePrice: 0,
        matrixRowId: null,
      },
    ],
    ...extra,
  };
}

describe('oferta comercial del catálogo', () => {
  it('cotiza reparación y pintura con la base de la pieza, sin sumar pintura aparte', () => {
    const offer = buildCrmCatalogOffer(rates());
    const piece = offer.pieces.find((item) => item.code === 'SI');
    expect(piece?.label).toBe('Salpicadera izquierda');
    expect(piece?.catalogPieza).toBe('Salpicadera');
    expect(piece?.tariffs.reparacion_pintura).toEqual({
      pesos: 4500,
      matrixRowId: MATRIX,
    });
    expect(piece?.tariffs.montaje_pintura).toBeNull();
  });

  it('la salpicadera trasera usa la pieza de catálogo ya definida, no una tarifa nueva', () => {
    const offer = buildCrmCatalogOffer(rates());
    const rear = offer.pieces.find((item) => item.code === 'STI');
    expect(rear?.label).toBe('Salpicadera trasera izquierda');
    expect(rear?.catalogPieza).toBe('Salpicadera');
    expect(rear?.tariffs.reparacion_pintura?.pesos).toBe(4500);
  });

  it('montaje y pintura usa la celda dedicada y no la suma con la reparación', () => {
    const offer = buildCrmCatalogOffer(rates());
    const fascia = offer.pieces.find((item) => item.code === 'FD');
    expect(fascia?.tariffs.reparacion_pintura?.pesos).toBe(2800);
    expect(fascia?.tariffs.montaje).toBeNull();
    expect(fascia?.tariffs.montaje_pintura).toEqual({
      pesos: 3200,
      matrixRowId: MONTAJE_PINTURA,
    });
    expect(
      (fascia?.tariffs.montaje_pintura?.pesos ?? 0) +
        (fascia?.tariffs.reparacion_pintura?.pesos ?? 0),
    ).not.toBe(fascia?.tariffs.montaje_pintura?.pesos);
  });

  it('no inventa montaje cuando la celda no está configurada', () => {
    const offer = buildCrmCatalogOffer(rates());
    const piece = offer.pieces.find((item) => item.code === 'SI');
    expect(piece?.tariffs.montaje).toBeNull();
    expect(piece?.tariffs.montaje_pintura).toBeNull();
  });

  it('faros del mismo lado comparten la celda de montaje y no tienen reparación inventada', () => {
    const offer = buildCrmCatalogOffer(rates());
    const left = offer.pieces.find((item) => item.code === 'FARO_IZQ');
    const right = offer.pieces.find((item) => item.code === 'FARO_DER');
    expect(left?.categories).toEqual(['montaje']);
    expect(left?.tariffs.reparacion_pintura).toBeNull();
    expect(right?.tariffs.montaje).toBeNull();
    const calavera = offer.pieces.find((item) => item.code === 'CAL_IZQ');
    expect(calavera?.tariffs.montaje).toEqual({
      pesos: 900,
      matrixRowId: MONTAJE,
    });
    expect(offer.pieces.find((item) => item.code === 'CAL_DER')?.tariffs.montaje?.pesos).toBe(
      900,
    );
  });

  it('el baño usa la base configurada y el cerámico sin precio queda vacío', () => {
    const offer = buildCrmCatalogOffer(rates());
    expect(offer.pieces.find((item) => item.code === 'BPE')?.tariffs.integral).toEqual({
      pesos: 28000,
      matrixRowId: BANIO,
    });
    expect(offer.pieces.find((item) => item.code === 'BPC')).toBeUndefined();
    expect(offer.pieces.find((item) => item.code === 'CERAMICO')?.tariffs.integral).toBeNull();
    expect(offer.pieces.find((item) => item.code === 'PDI_INT')).toBeUndefined();
    expect(offer.pieces.find((item) => item.code === 'REFACCION')).toBeUndefined();
  });

  it('no rellena un baño sin celda con la base oficial', () => {
    const offer = buildCrmCatalogOffer(
      rates({
        integralBases: [
          {
            servicio: 'Baño de Pintura Exterior',
            basePrice: 0,
            matrixRowId: null,
            banioCode: 'BPE',
          },
        ],
      }),
    );
    expect(offer.pieces.find((item) => item.code === 'BPE')?.tariffs.integral).toBeNull();
  });

  it('aplica el factor compacto del taller y no una magnitud de daño por defecto distinta de leve', () => {
    const offer = buildCrmCatalogOffer(
      rates({
        rules: {
          sizeTierFactors: { Compacto: 2, Mediano: 9, Grande: 9, XL: 9 },
          premiumFactor: 3,
          severityFactors: { LEVE: 1, MEDIO: 4, FUERTE: 4, MUY_FUERTE: 4 },
          roundToMx: 50,
        },
      }),
    );
    expect(
      offer.pieces.find((item) => item.code === 'SI')?.tariffs.reparacion_pintura?.pesos,
    ).toBe(9000);
  });

  it('la moldura de montaje lee la celda MOLDURA existente', () => {
    const offer = buildCrmCatalogOffer(rates());
    const moldura = offer.pieces.find((item) => item.label === 'Moldura');
    expect(moldura?.tariffs.montaje_pintura?.pesos).toBe(1500);
  });

  it('declara incompatibles reparar y montar, y deja solo pintar en manual', () => {
    const offer = buildCrmCatalogOffer(rates());
    const blocked = offer.combinations.find(
      (row) =>
        row.category === 'piezas' &&
        row.operations.includes('reparar') &&
        row.operations.includes('montar'),
    );
    expect(blocked?.tariff).toBe('incompatible');
    const paint = offer.combinations.find(
      (row) =>
        row.category === 'piezas' &&
        row.operations.length === 1 &&
        row.operations[0] === 'pintar',
    );
    expect(paint?.tariff).toBe('manual');
    const repair = offer.combinations.find(
      (row) =>
        row.category === 'piezas' &&
        row.operations.length === 1 &&
        row.operations[0] === 'reparar',
    );
    expect(repair?.tariff).toBe('manual');
  });

  it('dos talleres no comparten precios dentro de la oferta', () => {
    const tallerA = buildCrmCatalogOffer(rates());
    const tallerB = buildCrmCatalogOffer(
      rates({
        pieceBases: [{ servicio: 'Salpicadera', basePrice: 1200, matrixRowId: MATRIX }],
      }),
    );
    expect(
      tallerA.pieces.find((item) => item.code === 'SI')?.tariffs.reparacion_pintura?.pesos,
    ).toBe(4500);
    expect(
      tallerB.pieces.find((item) => item.code === 'SI')?.tariffs.reparacion_pintura?.pesos,
    ).toBe(1200);
  });

  it('rechaza reparar y montar en el snapshot y acepta la tarifa correspondiente', () => {
    expect(
      parseCrmLineSnapshot({
        catalogPieceCode: 'SI',
        catalogOperations: 'reparar+montar',
        tariffKind: 'manual',
      }).ok,
    ).toBe(false);

    const saved = parseCrmLineSnapshot({
      catalogPieceCode: 'SI',
      catalogOperations: 'pintar+reparar',
      tariffKind: 'reparacion_pintura',
      catalogMatrixRowId: MATRIX,
      catalogUnitPriceCents: 450000,
    });
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.value.catalogOperations).toBe('reparar+pintar');
      expect(saved.value.catalogUnitPriceCents).toBe(450000);
    }
  });

  it('un precio manual no se guarda como tarifa de catálogo', () => {
    const manual = parseCrmLineSnapshot({
      catalogPieceCode: 'SI',
      catalogOperations: 'pintar',
      tariffKind: 'manual',
      catalogUnitPriceCents: 100,
    });
    expect(manual.ok).toBe(false);

    const clear = parseCrmLineSnapshot({
      catalogPieceCode: 'SI',
      catalogOperations: 'pintar',
      tariffKind: 'manual',
    });
    expect(clear.ok).toBe(true);
    if (clear.ok) expect(clear.value.catalogUnitPriceCents).toBeNull();
  });

  it('una línea antigua sin campos de catálogo sigue siendo válida', () => {
    const legacy = parseCrmLineSnapshot({ name: 'Hojalatería' });
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.value.tariffKind).toBeNull();
  });

  it('la migración 006 no reescribe precios ni borra filas', () => {
    const sql = readFileSync(
      join(__dirname, '../chat/migrations/006_crm_catalog_snapshot.sql'),
      'utf8',
    );
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "catalogPieceCode"');
    expect(sql).toContain('CHK_service_lines_tariffKind');
    expect(sql.toLowerCase()).not.toContain('update ');
    expect(sql.toLowerCase()).not.toContain('delete ');
    expect(sql.toLowerCase()).not.toContain('drop table');
    expect(sql.toLowerCase()).not.toContain('drop column');
  });
});
