/**
 * Lista de precios base (hojalatería / pintura) para cotizaciones automáticas.
 * Los importes son referencia en MXN; ajustar según política comercial.
 */
export const AUTO_FIX_CURRENCY = 'MXN' as const;

export interface AutoFixPriceItem {
  /** Identificador estable para líneas de cotización */
  id: string;
  /** Concepto que aparece en la cotización */
  description: string;
  /** Precio unitario antes de IVA (referencia) */
  unitPrice: number;
}

export const AUTO_FIX_BASE_PRICES: AutoFixPriceItem[] = [
  { id: 'paint_per_panel', description: 'Pintura por pieza', unitPrice: 1500 },
  { id: 'dent_removal', description: 'Sacar golpe (chapa / desabollado)', unitPrice: 800 },
  {
    id: 'surface_prep_filler',
    description: 'Preparación de superficie y aplicación de masilla',
    unitPrice: 400,
  },
  { id: 'polish_correction', description: 'Pulido de corrección de acabado', unitPrice: 350 },
  {
    id: 'plastic_bumper_repair',
    description: 'Reparación de paragolpes plástico (sin pintura completa)',
    unitPrice: 600,
  },
];

export function getAutoFixPriceById(id: string): AutoFixPriceItem | undefined {
  return AUTO_FIX_BASE_PRICES.find((p) => p.id === id);
}

export function formatAutoFixMoney(amount: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: AUTO_FIX_CURRENCY,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

/** Línea de cotización enlazada al catálogo base */
export interface DraftQuoteLine {
  priceItemId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

/** Cotización formal generada automáticamente; requiere validación humana */
export type DraftQuoteStatus = 'PENDING_APPROVAL';

export interface DraftQuote {
  status: DraftQuoteStatus;
  currency: typeof AUTO_FIX_CURRENCY;
  reference: string;
  generatedAt: string;
  lines: DraftQuoteLine[];
  subtotal: number;
  /** Total antes de impuestos (mismo que subtotal si no hay descuentos) */
  total: number;
  /** Texto formal para cliente / archivo interno */
  formalNarrative: string;
  /** Resumen del peritaje usado como base */
  analysisBasis: {
    partesAfectadas: string[];
    severidadDelDano: string;
    descripcionTecnica: string;
  };
}
