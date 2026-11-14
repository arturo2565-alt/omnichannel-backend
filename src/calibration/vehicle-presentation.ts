/**
 * Presentación de marca para la lectura de calibración.
 * No escribe archivos ni altera la marca declarada por el cliente.
 */

export type VehicleProvenance = 'customer_provided' | 'catalog_inferred' | 'unknown';

export type VehiclePresentation = {
  make: string | null;
  provenance: VehicleProvenance;
  label: string;
};

export type VehicleMakeSpan = {
  make: string;
  from: number;
  to: number;
  /** Null: esa marca usó el nombre en todos los mercados donde se vendió así. */
  markets: readonly string[] | null;
  source: string;
};

export type VehicleCatalogEntry = {
  model: string;
  aliases: readonly string[];
  ambiguity: string;
  spans: readonly VehicleMakeSpan[];
};

/**
 * Solo nombres comerciales idénticos. Una plataforma compartida con otra
 * denominación no entra como alias.
 */
export const VEHICLE_CATALOG: readonly VehicleCatalogEntry[] = [
  {
    model: 'aveo',
    aliases: [],
    ambiguity: 'Kalos, Barina, G3, Wave, Swift+, Sonic, Lova, Nexia y Vida son otros nombres y no identifican un Aveo.',
    spans: [{
      make: 'Chevrolet',
      from: 2002,
      to: 2026,
      markets: null,
      source: 'https://en.wikipedia.org/wiki/Chevrolet_Aveo ; catálogo Chevrolet Aveo 2026 de GM México',
    }],
  },
  {
    model: 'prius',
    aliases: [],
    ambiguity: 'Prius c y Prius v son modelos distintos y no son alias de Prius.',
    spans: [{
      make: 'Toyota',
      from: 1997,
      to: 2026,
      markets: null,
      source: 'https://en.wikipedia.org/wiki/Toyota_Prius ; linaje Toyota, lanzamiento el 10 de diciembre de 1997',
    }],
  },
  {
    model: 'cr-v',
    aliases: ['crv', 'cr v'],
    ambiguity: 'CR-Z no es un alias de CR-V.',
    spans: [{
      make: 'Honda',
      from: 1995,
      to: 2026,
      markets: null,
      source: 'https://global.honda/en/stories/179-2510-CR-V-30th.html',
    }],
  },
  {
    model: 'explorer',
    aliases: [],
    ambiguity: 'Mountaineer y Navajo son otros nombres. Explorer Sport Trac tampoco es alias.',
    spans: [{
      make: 'Ford',
      from: 1991,
      to: 2026,
      markets: null,
      source: 'https://en.wikipedia.org/wiki/Ford_Explorer',
    }],
  },
  {
    model: 'charger',
    aliases: [],
    ambiguity: 'Entre 1975 y 1978 el nombre Charger fue Dodge en Estados Unidos y Chrysler en Australia. Valiant Charger no se trata como el mismo nombre fuera de ese mercado. Sin año, o sin mercado dentro de ese cruce, la marca queda desconocida.',
    spans: [
      {
        make: 'Dodge',
        from: 1966,
        to: 1974,
        markets: null,
        source: 'https://en.wikipedia.org/wiki/Dodge_Charger',
      },
      {
        make: 'Dodge',
        from: 1975,
        to: 1978,
        markets: ['US'],
        source: 'https://en.wikipedia.org/wiki/Dodge_Charger',
      },
      {
        make: 'Chrysler',
        from: 1975,
        to: 1978,
        markets: ['AU'],
        source: 'https://en.wikipedia.org/wiki/Chrysler_Valiant',
      },
      {
        make: 'Dodge',
        from: 1983,
        to: 1987,
        markets: ['US'],
        source: 'https://en.wikipedia.org/wiki/Dodge_Charger',
      },
      {
        make: 'Dodge',
        from: 2006,
        to: 2026,
        markets: null,
        source: 'https://en.wikipedia.org/wiki/Dodge_Charger',
      },
    ],
  },
];

const CATALOG_BY_NAME = new Map<string, VehicleCatalogEntry>();
for (const entry of VEHICLE_CATALOG) {
  for (const name of [entry.model, ...entry.aliases]) {
    CATALOG_BY_NAME.set(name, entry);
  }
}

export function presentVehicle(input: {
  make?: string | null;
  model?: string | null;
  year?: number | null;
  market?: string | null;
}): VehiclePresentation {
  const make = clean(input.make);
  const model = clean(input.model);
  const year = usableYear(input.year);
  const market = clean(input.market)?.toUpperCase() ?? null;
  if (make) {
    return {
      make,
      provenance: 'customer_provided',
      label: joinLabel(make, model, year),
    };
  }
  const inferred = inferMake(model, year, market);
  return {
    make: inferred,
    provenance: inferred ? 'catalog_inferred' : 'unknown',
    label: joinLabel(inferred, model, year),
  };
}

function inferMake(model: string | null, year: number | null, market: string | null): string | null {
  if (!model) return null;
  const entry = CATALOG_BY_NAME.get(normalize(model));
  if (!entry) return null;
  const makes = new Set(entry.spans.map((span) => span.make));
  if (year == null && makes.size > 1) return null;
  const matches = entry.spans.filter((span) => spanMatches(span, year, market));
  const matched = [...new Set(matches.map((span) => span.make))];
  return matched.length === 1 ? matched[0] : null;
}

function spanMatches(span: VehicleMakeSpan, year: number | null, market: string | null): boolean {
  if (year != null && (year < span.from || year > span.to)) return false;
  if (!span.markets) return true;
  if (!market) return true;
  return span.markets.includes(market);
}

function usableYear(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1900 || value > 2100) return null;
  return value;
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function joinLabel(make: string | null, model: string | null, year: number | null): string {
  return [make, model, year].filter((part) => part != null && part !== '').join(' ');
}
