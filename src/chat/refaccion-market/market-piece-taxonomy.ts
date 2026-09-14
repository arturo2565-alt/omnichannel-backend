import { parseMarketSide, type MarketSide } from './market-side';

export type MarketPieceFamily = 'CALAVERA' | 'GENERIC';

export type MarketPieceTaxonomy = {
  family: MarketPieceFamily;
  pieceCode: string;
  canonicalLabel: string;
  searchAliases: string[];
  requiredSide: MarketSide | null;
};

function norm(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GENERIC_ALIASES: Record<string, string[]> = {
  cofre: ['cofre', 'hood', 'capo', 'bonnet'],
  fascia: ['fascia', 'defensa', 'bumper', 'fascia delantera', 'fascia trasera'],
  puerta: ['puerta', 'door'],
  salpicadera: ['salpicadera', 'guardafango', 'fender'],
  'tapa cajuela': ['tapa cajuela', 'tapa de cajuela', 'cajuela', 'baul', 'porton'],
  toldo: ['toldo', 'techo'],
  estribo: ['estribo', 'side step'],
  espejo: ['espejo', 'mirror'],
  poste: ['poste', 'pilar'],
};

const CALAVERA_LEFT_ALIASES = [
  'calavera trasera izquierda',
  'calavera izquierda',
  'stop izquierdo',
  'stop trasero izquierdo',
  'lampara trasera izquierda',
  'left tail light',
  'left tail lamp',
] as const;

const CALAVERA_RIGHT_ALIASES = [
  'calavera trasera derecha',
  'calavera derecha',
  'stop derecho',
  'stop trasero derecho',
  'lampara trasera derecha',
  'right tail light',
  'right tail lamp',
] as const;

const CALAVERA_FAMILY_ALIASES = [
  'calavera',
  'stop',
  'calavera trasera',
  'stop trasero',
  'lampara trasera',
  'tail light',
  'tail lamp',
  'rear lamp',
] as const;

function isCalaveraToken(n: string): boolean {
  return (
    /\bcalavera\b/.test(n) ||
    /\bstop\b/.test(n) ||
    /\btail\s+l(ight|amp)\b/.test(n) ||
    n === 'cal izq' ||
    n === 'cal der' ||
    n.startsWith('cal_')
  );
}

/**
 * Identidad comercial de búsqueda. No cambia physicalPanelKey ni DamageItem.
 */
export function resolveMarketPieceTaxonomy(pieza: string): MarketPieceTaxonomy {
  const pieceCode = String(pieza ?? '').trim();
  const n = norm(pieceCode);
  if (isCalaveraToken(n)) {
    const side =
      parseMarketSide(n) ??
      (/_(ti|di|i)$/i.test(pieceCode) || /izq/.test(n) ? 'LEFT' : null) ??
      (/_(td|dd|d)$/i.test(pieceCode) || /der/.test(n) ? 'RIGHT' : null);
    if (side === 'RIGHT') {
      return {
        family: 'CALAVERA',
        pieceCode,
        canonicalLabel: 'Calavera derecha',
        searchAliases: [...CALAVERA_RIGHT_ALIASES],
        requiredSide: 'RIGHT',
      };
    }
    if (side === 'LEFT') {
      return {
        family: 'CALAVERA',
        pieceCode,
        canonicalLabel: 'Calavera izquierda',
        searchAliases: [...CALAVERA_LEFT_ALIASES],
        requiredSide: 'LEFT',
      };
    }
    return {
      family: 'CALAVERA',
      pieceCode,
      canonicalLabel: 'Calavera',
      searchAliases: [...CALAVERA_FAMILY_ALIASES],
      requiredSide: null,
    };
  }

  for (const [key, aliases] of Object.entries(GENERIC_ALIASES)) {
    if (n === key || n.includes(key) || aliases.some((a) => n.includes(a))) {
      return {
        family: 'GENERIC',
        pieceCode,
        canonicalLabel: key.replace(/\b\w/g, (c) => c.toUpperCase()),
        searchAliases: aliases,
        requiredSide: parseMarketSide(n),
      };
    }
  }
  return {
    family: 'GENERIC',
    pieceCode,
    canonicalLabel: pieceCode || 'pieza',
    searchAliases: n ? [n] : [],
    requiredSide: parseMarketSide(n),
  };
}

export function listingMentionsPieceFamily(
  title: string,
  snippet: string | undefined,
  taxonomy: MarketPieceTaxonomy,
): boolean {
  return Boolean(findMatchedPieceAlias(title, snippet, taxonomy));
}

export function findMatchedPieceAlias(
  title: string,
  snippet: string | undefined,
  taxonomy: MarketPieceTaxonomy,
): string | undefined {
  const blob = norm(`${title} ${snippet ?? ''}`);
  const compact = blob.replace(/\s+/g, '');
  const aliases =
    taxonomy.family === 'CALAVERA'
      ? [...CALAVERA_FAMILY_ALIASES, ...taxonomy.searchAliases]
      : taxonomy.searchAliases;
  return aliases.find((alias) => {
    const a = norm(alias);
    if (!a) return false;
    return blob.includes(a) || compact.includes(a.replace(/\s+/g, ''));
  });
}
