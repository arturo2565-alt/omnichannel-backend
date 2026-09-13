/** Familia física de moldura. No es Estética Exterior. */

export const PANEL_PIEZA_MOLDURA_CODE = 'MOLDURA';
export const MOLDURA_LEGACY_CODE = 'Moldura';
export const MOLDURA_PINTADA_CATALOG = 'MOLDURA_PINTADA';

export const MOLDING_POSITIONS = [
  'ARCO_DELANTERO_IZQUIERDO',
  'ARCO_DELANTERO_DERECHO',
  'ARCO_TRASERO_IZQUIERDO',
  'ARCO_TRASERO_DERECHO',
  'PUERTA',
  'FASCIA',
  'OTRA',
  'UNKNOWN',
] as const;

export type MoldingPosition = (typeof MOLDING_POSITIONS)[number];

export const MOLDING_FINISH_TYPES = [
  'PINTADA_CARROCERIA',
  'NEGRA_TEXTURIZADA',
  'UNKNOWN',
] as const;

export type MoldingFinishType = (typeof MOLDING_FINISH_TYPES)[number];

export const MOLDURA_NO_PINTABLE_REQUIERE_REVISION =
  'MOLDURA_NO_PINTABLE_REQUIERE_REVISION';

export const MOLDURA_MONTAJE_PENDIENTE = 'MOLDURA_MONTAJE_PENDIENTE';

const POSITION_SET = new Set<string>(MOLDING_POSITIONS);
const FINISH_SET = new Set<string>(MOLDING_FINISH_TYPES);

const POSITION_LABEL: Record<MoldingPosition, string> = {
  ARCO_DELANTERO_IZQUIERDO: 'arco delantero izquierdo',
  ARCO_DELANTERO_DERECHO: 'arco delantero derecho',
  ARCO_TRASERO_IZQUIERDO: 'arco trasero izquierdo',
  ARCO_TRASERO_DERECHO: 'arco trasero derecho',
  PUERTA: 'de puerta',
  FASCIA: 'de fascia',
  OTRA: '',
  UNKNOWN: '',
};

const FINISH_LABEL: Record<MoldingFinishType, string> = {
  PINTADA_CARROCERIA: 'Pintada al color',
  NEGRA_TEXTURIZADA: 'Negra texturizada',
  UNKNOWN: 'Por confirmar',
};

const FINISH_SEARCH: Record<MoldingFinishType, string> = {
  PINTADA_CARROCERIA: 'pintada',
  NEGRA_TEXTURIZADA: 'negra',
  UNKNOWN: '',
};

export function parseMoldingPosition(raw: unknown): MoldingPosition {
  const t = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (POSITION_SET.has(t)) return t as MoldingPosition;
  return 'UNKNOWN';
}

export function parseMoldingFinishType(raw: unknown): MoldingFinishType {
  const t = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (FINISH_SET.has(t)) return t as MoldingFinishType;
  return 'UNKNOWN';
}

function normalizeMolduraText(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** True si el texto/código pertenece a la familia MOLDURA (incluye legacy). */
export function isMolduraPieza(raw: string): boolean {
  const t = String(raw ?? '').trim();
  if (!t) return false;
  if (t === PANEL_PIEZA_MOLDURA_CODE || t === MOLDURA_LEGACY_CODE) return true;
  if (/^MOLDURA::/i.test(t) || /^Moldura::/.test(t)) return true;
  const n = normalizeMolduraText(t.replace(/::/g, ' '));
  return n === 'moldura' || n.startsWith('moldura ');
}

/** Histórico: pieza exacta "Moldura" sin atributos nuevos. */
export function isHistoricalBareMoldura(
  pieza: string,
  moldingPosition?: string | null,
): boolean {
  return (
    String(pieza ?? '').trim() === MOLDURA_LEGACY_CODE &&
    (moldingPosition == null || String(moldingPosition).trim() === '')
  );
}

export function molduraPhysicalPanelKey(
  moldingPosition?: string | null,
): string {
  return `${PANEL_PIEZA_MOLDURA_CODE}::${parseMoldingPosition(moldingPosition)}`;
}

/**
 * Identidad física de moldura.
 * Histórico `Moldura` (sin attrs) se conserva. Claves `MOLDURA::…` se reutilizan.
 */
export function physicalPanelKeyForMolduraItem(item: {
  pieza: string;
  moldingPosition?: string | null;
  physicalPanelKey?: string | null;
}): string {
  const stored = String(item.physicalPanelKey ?? '').trim();
  if (stored === MOLDURA_LEGACY_CODE) return stored;
  if (/^MOLDURA::/i.test(stored)) {
    return `${PANEL_PIEZA_MOLDURA_CODE}::${parseMoldingPosition(stored.slice(stored.indexOf('::') + 2))}`;
  }
  if (isHistoricalBareMoldura(item.pieza, item.moldingPosition)) {
    return MOLDURA_LEGACY_CODE;
  }
  return molduraPhysicalPanelKey(item.moldingPosition);
}

export function humanizeMolduraPosition(position?: string | null): string {
  const pos = parseMoldingPosition(position);
  return POSITION_LABEL[pos] ?? '';
}

export function humanizeMolduraFinish(finish?: string | null): string {
  return FINISH_LABEL[parseMoldingFinishType(finish)];
}

/** Label de cliente. Nunca `MOLDURA::…`. */
export function humanizeMolduraPieceLabel(
  moldingPosition?: string | null,
): string {
  const loc = humanizeMolduraPosition(moldingPosition);
  return loc ? `Moldura ${loc}` : 'Moldura';
}

export function molduraFinishClientLine(finish?: string | null): string {
  return `Acabado: ${humanizeMolduraFinish(finish)}`;
}

/** Términos de búsqueda de mercado. No hardcodea vehículo. */
export function molduraMarketSearchLabel(input: {
  moldingPosition?: string | null;
  finishType?: string | null;
}): string {
  const loc = humanizeMolduraPosition(input.moldingPosition);
  const finish = FINISH_SEARCH[parseMoldingFinishType(input.finishType)];
  return ['moldura', loc, finish].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

export function isMolduraPaintedRepair(finish?: string | null): boolean {
  return parseMoldingFinishType(finish) === 'PINTADA_CARROCERIA';
}

export function isMolduraNonPaintableFinish(finish?: string | null): boolean {
  const f = parseMoldingFinishType(finish);
  return f === 'NEGRA_TEXTURIZADA' || f === 'UNKNOWN';
}

/**
 * Contrato aditivo para Vision (schema/prompt).
 * No pide precios. UNKNOWN es válido.
 */
export const MOLDURA_VISION_CONTRACT = `
Molduras (aditivo; no cambia otras reglas):
Si detectas una moldura dañada:
- usa pieza "MOLDURA" (no Estética Exterior);
- identifica su posición cuando sea visible;
- identifica si es pintada al color de carrocería o plástico negro/texturizado;
- si no puede determinarse, usa UNKNOWN;
- no asumas que toda moldura se pinta;
- no calcules precios.

Cuando pieza=MOLDURA, cada item puede incluir:
- "moldingPosition": ARCO_DELANTERO_IZQUIERDO | ARCO_DELANTERO_DERECHO | ARCO_TRASERO_IZQUIERDO | ARCO_TRASERO_DERECHO | PUERTA | FASCIA | OTRA | UNKNOWN
- "finishType": PINTADA_CARROCERIA | NEGRA_TEXTURIZADA | UNKNOWN
`.trim();
