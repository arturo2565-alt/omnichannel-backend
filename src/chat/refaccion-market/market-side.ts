export const MARKET_SIDES = ['LEFT', 'RIGHT'] as const;
export type MarketSide = (typeof MARKET_SIDES)[number];

const LEFT_RE =
  /\b(izquierda|izquierdo|izquierdos|izquierdas|izq\.?|left|lh|lado\s+izquierdo)\b/i;
const RIGHT_RE =
  /\b(derecha|derecho|derechos|derechas|der\.?|right|rh|lado\s+derecho)\b/i;

export function parseMarketSide(raw: unknown): MarketSide | null {
  const blob = String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!blob) return null;
  const left = LEFT_RE.test(blob);
  const right = RIGHT_RE.test(blob);
  if (left && right) return null;
  if (left) return 'LEFT';
  if (right) return 'RIGHT';
  return null;
}

export function listingHasSide(
  title: string,
  snippet: string | undefined,
  side: MarketSide,
): boolean {
  return parseMarketSide(`${title} ${snippet ?? ''}`) === side;
}
