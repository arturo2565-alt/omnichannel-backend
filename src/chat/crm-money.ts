import {
  parseCrmLineSnapshot,
  type CrmLineSnapshot,
} from '../catalog/crm-catalog-offer';

/** Pesos enteros que ya usa `quotedAmount`. El desglose nuevo vive en centavos. */
export const MAX_QUOTED_PESOS = 10_000_000;
export const MAX_LINE_CENTS = MAX_QUOTED_PESOS * 100;
export const MAX_QUANTITY_HUNDREDTHS = 10_000;
export const MAX_SERVICE_LINES = 20;

export type ParsedServiceLine = {
  id: string;
  name: string;
  quantityHundredths: number;
  unitPriceCents: number;
  subtotalCents: number;
} & CrmLineSnapshot;

export function lineSubtotalCents(
  quantityHundredths: number,
  unitPriceCents: number,
): number {
  const product = quantityHundredths * unitPriceCents;
  return Math.floor((product + 50) / 100);
}

export function pesosFromCents(cents: number): number {
  return Math.floor((cents + 50) / 100);
}

export function parseScaledInteger(
  value: unknown,
  scale: 100,
  bounds: { min: number; max: number },
  label: string,
): { ok: true; amount: number } | { ok: false; error: string } {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      return {
        ok: false,
        error: `${label} debe enviarse en enteros, sin decimales sueltos.`,
      };
    }
    if (value < bounds.min || value > bounds.max) {
      return { ok: false, error: `${label} está fuera de rango.` };
    }
    return { ok: true, amount: value };
  }
  const text = String(value ?? '').trim().replace(/[$,\s]/g, '');
  if (!text) return { ok: false, error: `Indica ${label.toLowerCase()}.` };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return { ok: false, error: `${label} usa hasta dos decimales.` };
  }
  const [whole, frac = ''] = text.split('.');
  const amount = Number(whole) * scale + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(amount) || amount < bounds.min || amount > bounds.max) {
    return { ok: false, error: `${label} está fuera de rango.` };
  }
  return { ok: true, amount };
}

export function parseServiceLines(
  value: unknown,
  ids = newIdFactory(),
): { ok: true; lines: ParsedServiceLine[] } | { ok: false; error: string } {
  if (value == null) return { ok: true, lines: [] };
  if (!Array.isArray(value)) {
    return { ok: false, error: 'Los servicios deben ir en una lista.' };
  }
  if (value.length > MAX_SERVICE_LINES) {
    return { ok: false, error: `Máximo ${MAX_SERVICE_LINES} servicios por cita.` };
  }
  const lines: ParsedServiceLine[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Hay un servicio mal formado.' };
    }
    const record = raw as Record<string, unknown>;
    const name = String(record.name ?? '').trim().slice(0, 200);
    const quantityEmpty = record.quantityHundredths == null || record.quantityHundredths === '';
    const priceEmpty = record.unitPriceCents == null || record.unitPriceCents === '';
    if (!name && quantityEmpty && priceEmpty) continue;
    if (!name) return { ok: false, error: 'Cada servicio necesita un nombre.' };
    const quantity = parseScaledInteger(
      record.quantityHundredths,
      100,
      { min: 1, max: MAX_QUANTITY_HUNDREDTHS },
      'La cantidad',
    );
    if (!quantity.ok) return quantity;
    const price = parseScaledInteger(
      record.unitPriceCents,
      100,
      { min: 0, max: MAX_LINE_CENTS },
      'El precio unitario',
    );
    if (!price.ok) return price;
    const subtotal = lineSubtotalCents(quantity.amount, price.amount);
    if (!Number.isSafeInteger(subtotal) || subtotal > MAX_LINE_CENTS) {
      return { ok: false, error: `El subtotal de ${name} supera el límite.` };
    }
    const id = normalizeLineId(record.id) ?? ids();
    if (seen.has(id)) return { ok: false, error: 'Hay servicios repetidos.' };
    seen.add(id);
    const snapshot = parseCrmLineSnapshot(record);
    if (!snapshot.ok) return snapshot;
    lines.push({
      id,
      name,
      quantityHundredths: quantity.amount,
      unitPriceCents: price.amount,
      subtotalCents: subtotal,
      ...snapshot.value,
    });
  }
  const total = lines.reduce((sum, line) => sum + line.subtotalCents, 0);
  if (total > MAX_LINE_CENTS) {
    return { ok: false, error: 'El total cotizado supera el límite.' };
  }
  return { ok: true, lines };
}

export function serviceSummary(lines: readonly { name: string }[]): string | null {
  const text = lines
    .map((line) => line.name.trim())
    .filter(Boolean)
    .join(' · ')
    .slice(0, 200);
  return text || null;
}

function normalizeLineId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  if (!id) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return null;
  }
  return id.toLowerCase();
}

function newIdFactory(): () => string {
  return () => crypto.randomUUID();
}
