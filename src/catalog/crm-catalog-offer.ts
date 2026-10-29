import { normalizeTextForMatch } from '../chat/autofix-config';
import {
  computeCatalogIntegralPrice,
  computeCatalogPiecePrice,
  type CatalogPricingRules,
} from './catalog-pricing-rules';
import { MOLDURA_PINTADA_CATALOG } from './moldura';
import {
  PANEL_PIEZA_BPC_CODE,
  PANEL_PIEZA_OPTIONS,
  resolveCatalogPiezaForMatrixLookup,
} from './panel-pieza-catalog';

/**
 * El CRM no tiene tarifas propias. Cada botón se resuelve contra una celda
 * que ya existe en price_matrix, o queda en captura manual.
 * No se suman celdas ni se usan las bases oficiales de baño cuando el taller
 * no las configuró.
 */
export const CRM_TARIFF_KINDS = [
  'reparacion_pintura',
  'montaje',
  'montaje_pintura',
  'integral',
  'manual',
] as const;

export type CrmTariffKind = (typeof CRM_TARIFF_KINDS)[number];

export const CRM_OPERATIONS = ['reparar', 'pintar', 'montar'] as const;
export type CrmOperation = (typeof CRM_OPERATIONS)[number];

export type CrmOfferCategoryId =
  | 'piezas'
  | 'montaje'
  | 'integrales'
  | 'personalizado';

export type CrmTariffQuote = {
  pesos: number;
  matrixRowId: string | null;
};

export type CrmOfferPiece = {
  code: string;
  label: string;
  catalogPieza: string;
  categories: Array<'piezas' | 'montaje' | 'integrales'>;
  tariffs: {
    reparacion_pintura: CrmTariffQuote | null;
    montaje: CrmTariffQuote | null;
    montaje_pintura: CrmTariffQuote | null;
    integral: CrmTariffQuote | null;
  };
};

export type CrmOperationCombination = {
  category: 'piezas' | 'montaje' | 'integrales';
  operations: CrmOperation[];
  tariff: CrmTariffKind | 'incompatible' | 'pending';
  label: string;
  reason: string;
};

export type CrmCatalogOffer = {
  categories: Array<{
    id: CrmOfferCategoryId;
    label: string;
    operations: CrmOperation[];
  }>;
  pieces: CrmOfferPiece[];
  combinations: CrmOperationCombination[];
  pricingNote: string;
};

export type CrmLineSnapshot = {
  catalogPieceCode: string | null;
  tariffKind: CrmTariffKind | null;
  catalogOperations: string | null;
  catalogMatrixRowId: string | null;
  catalogUnitPriceCents: number | null;
};

export type CrmCatalogRates = {
  rules?: CatalogPricingRules | null;
  pieceBases: ReadonlyArray<{
    servicio: string;
    basePrice: number;
    matrixRowId: string | null;
  }>;
  montajeBases: ReadonlyArray<{
    servicio: string;
    precio: number;
    matrixRowId: string | null;
    hasDedicatedRate: boolean;
  }>;
  montajePinturaBases: ReadonlyArray<{
    servicio: string;
    precio: number;
    matrixRowId: string | null;
    hasDedicatedRate: boolean;
  }>;
  integralBases: ReadonlyArray<{
    servicio: string;
    basePrice: number;
    matrixRowId: string | null;
    banioCode?: string | null;
  }>;
};

const REPAIR_ONLY_REASON =
  'No hay tarifa de solo reparación. La celda del catálogo es reparación y pintura.';
const PAINT_ONLY_REASON =
  'No hay tarifa de solo pintura para esta pieza. Captura el precio a mano.';
const INCOMPATIBLE_REASON =
  'No se puede reparar y montar la misma pieza.';
const PENDING_REASON = 'Elige la operación.';
const MAX_CATALOG_CENTS = 1_000_000_000;

/**
 * Faros y calaveras no están en el panel de hojalatería.
 * Izquierda y derecha comparten la celda MONTAJE: el catálogo no parte el precio por lado.
 */
const MONTAJE_SIDE_PIECES = [
  { code: 'CAL_IZQ', label: 'Calavera izquierda', catalogPieza: 'Calavera' },
  { code: 'CAL_DER', label: 'Calavera derecha', catalogPieza: 'Calavera' },
  { code: 'FARO_IZQ', label: 'Faro izquierdo', catalogPieza: 'Faro' },
  { code: 'FARO_DER', label: 'Faro derecho', catalogPieza: 'Faro' },
  {
    code: 'FARO_NIEBLA_IZQ',
    label: 'Faro de niebla izquierdo',
    catalogPieza: 'Faro niebla',
  },
  {
    code: 'FARO_NIEBLA_DER',
    label: 'Faro de niebla derecho',
    catalogPieza: 'Faro niebla',
  },
] as const;

export const CRM_OPERATION_COMBINATIONS: readonly CrmOperationCombination[] = [
  {
    category: 'piezas',
    operations: [],
    tariff: 'pending',
    label: '',
    reason: PENDING_REASON,
  },
  {
    category: 'piezas',
    operations: ['reparar', 'pintar'],
    tariff: 'reparacion_pintura',
    label: 'Reparación y pintura',
    reason: '',
  },
  {
    category: 'piezas',
    operations: ['reparar'],
    tariff: 'manual',
    label: 'Reparar',
    reason: REPAIR_ONLY_REASON,
  },
  {
    category: 'piezas',
    operations: ['pintar'],
    tariff: 'manual',
    label: 'Pintar',
    reason: PAINT_ONLY_REASON,
  },
  {
    category: 'piezas',
    operations: ['reparar', 'montar'],
    tariff: 'incompatible',
    label: '',
    reason: INCOMPATIBLE_REASON,
  },
  {
    category: 'piezas',
    operations: ['pintar', 'montar'],
    tariff: 'incompatible',
    label: '',
    reason: INCOMPATIBLE_REASON,
  },
  {
    category: 'piezas',
    operations: ['reparar', 'pintar', 'montar'],
    tariff: 'incompatible',
    label: '',
    reason: INCOMPATIBLE_REASON,
  },
  {
    category: 'montaje',
    operations: [],
    tariff: 'pending',
    label: '',
    reason: PENDING_REASON,
  },
  {
    category: 'montaje',
    operations: ['montar'],
    tariff: 'montaje',
    label: 'Montaje',
    reason: '',
  },
  {
    category: 'montaje',
    operations: ['montar', 'pintar'],
    tariff: 'montaje_pintura',
    label: 'Montaje y pintura',
    reason: '',
  },
  {
    category: 'montaje',
    operations: ['pintar'],
    tariff: 'manual',
    label: 'Pintar',
    reason: PAINT_ONLY_REASON,
  },
  {
    category: 'montaje',
    operations: ['reparar', 'montar'],
    tariff: 'incompatible',
    label: '',
    reason: INCOMPATIBLE_REASON,
  },
  {
    category: 'montaje',
    operations: ['reparar', 'pintar', 'montar'],
    tariff: 'incompatible',
    label: '',
    reason: INCOMPATIBLE_REASON,
  },
  {
    category: 'integrales',
    operations: [],
    tariff: 'integral',
    label: '',
    reason: '',
  },
];

const EMPTY_TARIFFS: CrmOfferPiece['tariffs'] = {
  reparacion_pintura: null,
  montaje: null,
  montaje_pintura: null,
  integral: null,
};

export function buildCrmCatalogOffer(rates: CrmCatalogRates): CrmCatalogOffer {
  const pieces: CrmOfferPiece[] = [];
  for (const option of PANEL_PIEZA_OPTIONS) {
    if (option.internalDamageRange || option.refaccionManual) continue;
    if (option.code === PANEL_PIEZA_BPC_CODE) continue;
    if (option.integralService || option.banioCompleto) {
      pieces.push({
        code: option.code,
        label: option.fullName,
        catalogPieza: option.catalogPieza,
        categories: ['integrales'],
        tariffs: {
          ...EMPTY_TARIFFS,
          integral: integralQuote(rates, option.catalogPieza, option.fullName, option.code),
        },
      });
      continue;
    }
    const catalogPieza = resolveCatalogPiezaForMatrixLookup(option.code);
    if (!catalogPieza) continue;
    pieces.push(bodyPiece(option.code, option.fullName, catalogPieza, rates));
  }
  for (const extra of MONTAJE_SIDE_PIECES) {
    pieces.push({
      code: extra.code,
      label: extra.label,
      catalogPieza: extra.catalogPieza,
      categories: ['montaje'],
      tariffs: {
        ...EMPTY_TARIFFS,
        montaje: dedicatedQuote(rates.montajeBases, [extra.catalogPieza]),
        montaje_pintura: dedicatedQuote(rates.montajePinturaBases, [
          extra.catalogPieza,
        ]),
      },
    });
  }

  return {
    categories: [
      {
        id: 'piezas',
        label: 'Piezas y reparaciones',
        operations: ['reparar', 'pintar'],
      },
      {
        id: 'montaje',
        label: 'Montaje y sustitución',
        operations: ['montar', 'pintar'],
      },
      { id: 'integrales', label: 'Servicios integrales', operations: [] },
      { id: 'personalizado', label: 'Servicios personalizados', operations: [] },
    ],
    pieces,
    combinations: CRM_OPERATION_COMBINATIONS.map((row) => ({
      ...row,
      operations: [...row.operations],
    })),
    pricingNote:
      'Sugerencia de tarifa base: daño leve y tamaño compacto, sin prima. El montaje usa su celda dedicada y no se suma a la reparación. Si no hay celda, el precio queda vacío.',
  };
}

export function parseCrmLineSnapshot(
  record: Record<string, unknown>,
): { ok: true; value: CrmLineSnapshot } | { ok: false; error: string } {
  const empty = emptySnapshot();
  const present = [
    'catalogPieceCode',
    'tariffKind',
    'catalogOperations',
    'catalogMatrixRowId',
    'catalogUnitPriceCents',
  ].some((key) => record[key] != null && String(record[key]).trim() !== '');
  if (!present) return { ok: true, value: empty };

  const operations = parseOperations(record.catalogOperations);
  if (!operations.ok) return operations;
  const piece = parsePieceCode(record.catalogPieceCode);
  if (!piece.ok) return piece;
  const matrix = parseMatrixId(record.catalogMatrixRowId);
  if (!matrix.ok) return matrix;
  const catalogUnit = parseCatalogCents(record.catalogUnitPriceCents);
  if (!catalogUnit.ok) return catalogUnit;

  const tariff = parseTariffKind(record.tariffKind);
  if (!tariff.ok) return tariff;
  if (!tariff.value) {
    return { ok: false, error: 'Indica la tarifa de catálogo o márcala como manual.' };
  }
  if (operations.value.includes('reparar') && operations.value.includes('montar')) {
    return { ok: false, error: INCOMPATIBLE_REASON };
  }
  const allowed = allowedTariffs(operations.value, piece.value);
  if (!allowed.includes(tariff.value)) {
    return {
      ok: false,
      error: 'La tarifa no corresponde a esa combinación de operaciones.',
    };
  }
  if (tariff.value === 'manual') {
    if (catalogUnit.value != null || matrix.value) {
      return {
        ok: false,
        error: 'Un servicio manual no guarda una tarifa de catálogo.',
      };
    }
  }

  return {
    ok: true,
    value: {
      catalogPieceCode: piece.value,
      tariffKind: tariff.value,
      catalogOperations: operations.value.length ? operations.value.join('+') : null,
      catalogMatrixRowId: tariff.value === 'manual' ? null : matrix.value,
      catalogUnitPriceCents: tariff.value === 'manual' ? null : catalogUnit.value,
    },
  };
}

function bodyPiece(
  code: string,
  label: string,
  catalogPieza: string,
  rates: CrmCatalogRates,
): CrmOfferPiece {
  const montajeNames = montajeLookupNames(catalogPieza);
  return {
    code,
    label,
    catalogPieza,
    categories: ['piezas', 'montaje'],
    tariffs: {
      reparacion_pintura: pieceQuote(rates, catalogPieza),
      montaje: dedicatedQuote(rates.montajeBases, montajeNames),
      montaje_pintura: dedicatedQuote(rates.montajePinturaBases, montajeNames),
      integral: null,
    },
  };
}

function pieceQuote(
  rates: CrmCatalogRates,
  catalogPieza: string,
): CrmTariffQuote | null {
  const row = findByName(rates.pieceBases, [catalogPieza]);
  if (!row || row.basePrice <= 0) return null;
  const pesos = computeCatalogPiecePrice({
    basePrice: row.basePrice,
    sizeTier: 'Compacto',
    isPremium: false,
    damageMagnitude: 'LEVE',
    rules: rates.rules ?? undefined,
  });
  if (!Number.isInteger(pesos) || pesos <= 0) return null;
  return { pesos, matrixRowId: row.matrixRowId };
}

function integralQuote(
  rates: CrmCatalogRates,
  catalogPieza: string,
  fullName: string,
  code: string,
): CrmTariffQuote | null {
  const names = [catalogPieza, fullName, code].map((name) => normalizeTextForMatch(name));
  const row = rates.integralBases.find((candidate) => {
    if (candidate.banioCode && candidate.banioCode === code) return true;
    return names.includes(normalizeTextForMatch(candidate.servicio));
  });
  if (!row || row.basePrice <= 0) return null;
  const pesos = computeCatalogIntegralPrice({
    basePrice: row.basePrice,
    sizeTier: 'Compacto',
    isPremium: false,
    rules: rates.rules ?? undefined,
  });
  if (!Number.isInteger(pesos) || pesos <= 0) return null;
  return { pesos, matrixRowId: row.matrixRowId };
}

function dedicatedQuote(
  rows: CrmCatalogRates['montajeBases'],
  names: string[],
): CrmTariffQuote | null {
  const row = findByName(rows, names);
  if (!row?.hasDedicatedRate || row.precio <= 0) return null;
  const pesos = Math.round(row.precio);
  if (!Number.isInteger(pesos) || pesos <= 0) return null;
  return { pesos, matrixRowId: row.matrixRowId };
}

function montajeLookupNames(catalogPieza: string): string[] {
  if (catalogPieza === MOLDURA_PINTADA_CATALOG) {
    return [MOLDURA_PINTADA_CATALOG, 'MOLDURA'];
  }
  return [catalogPieza];
}

function findByName<T extends { servicio: string }>(
  rows: readonly T[],
  names: string[],
): T | null {
  const wanted = new Set(names.map((name) => normalizeTextForMatch(name)));
  return rows.find((row) => wanted.has(normalizeTextForMatch(row.servicio))) ?? null;
}

function emptySnapshot(): CrmLineSnapshot {
  return {
    catalogPieceCode: null,
    tariffKind: null,
    catalogOperations: null,
    catalogMatrixRowId: null,
    catalogUnitPriceCents: null,
  };
}

function parseOperations(
  value: unknown,
): { ok: true; value: CrmOperation[] } | { ok: false; error: string } {
  if (value == null || String(value).trim() === '') return { ok: true, value: [] };
  const parts = String(value)
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.some((part) => !CRM_OPERATIONS.includes(part as CrmOperation))) {
    return { ok: false, error: 'La operación no existe en el catálogo.' };
  }
  const unique = CRM_OPERATIONS.filter((operation) => parts.includes(operation));
  if (unique.includes('reparar') && unique.includes('montar')) {
    return { ok: false, error: INCOMPATIBLE_REASON };
  }
  return { ok: true, value: unique };
}

function parsePieceCode(
  value: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value == null || String(value).trim() === '') return { ok: true, value: null };
  const code = String(value).trim();
  if (!/^[A-Za-z0-9_]{1,32}$/.test(code)) {
    return { ok: false, error: 'La pieza de catálogo no es válida.' };
  }
  return { ok: true, value: code };
}

function parseMatrixId(
  value: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value == null || String(value).trim() === '') return { ok: true, value: null };
  const id = String(value).trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      id,
    )
  ) {
    return { ok: false, error: 'La fila de tarifa no es válida.' };
  }
  return { ok: true, value: id };
}

function parseCatalogCents(
  value: unknown,
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value == null || value === '') return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, error: 'La tarifa de catálogo debe ir en centavos enteros.' };
  }
  if (value < 0 || value > MAX_CATALOG_CENTS) {
    return { ok: false, error: 'La tarifa de catálogo está fuera de rango.' };
  }
  return { ok: true, value };
}

function parseTariffKind(
  value: unknown,
): { ok: true; value: CrmTariffKind | null } | { ok: false; error: string } {
  if (value == null || String(value).trim() === '') return { ok: true, value: null };
  const kind = String(value).trim();
  if (!CRM_TARIFF_KINDS.includes(kind as CrmTariffKind)) {
    return { ok: false, error: 'La tarifa de catálogo no existe.' };
  }
  return { ok: true, value: kind as CrmTariffKind };
}

function allowedTariffs(
  operations: readonly CrmOperation[],
  pieceCode: string | null,
): CrmTariffKind[] {
  const key = operations.join('+');
  if (key === 'reparar+pintar') return ['reparacion_pintura', 'manual'];
  if (key === 'montar') return ['montaje', 'manual'];
  if (key === 'montar+pintar') return ['montaje_pintura', 'manual'];
  if (key === 'reparar' || key === 'pintar') return ['manual'];
  if (key === '') return pieceCode ? ['integral', 'manual'] : ['manual'];
  return ['manual'];
}
