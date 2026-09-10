import OpenAI from 'openai';
import {
  openAiResponsesParams,
} from './openai-model-config';

export type WebPriceHit = {
  price: number;
  source: 'serper' | 'tavily' | 'openai' | 'mercadolibre';
  snippet?: string;
};

const PRICE_MIN_MXN = 600;
const PRICE_MAX_MXN = 12_000;

/** Query abierta México/CDMX. */
export function buildRefaccionWebQuery(input: {
  pieza: string;
  marca?: string | null;
  modelo?: string | null;
  anio?: string | null;
}): string {
  const pieza = String(input.pieza ?? '').trim();
  const identity = [input.marca, input.modelo]
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .join(' ');
  const anio = String(input.anio ?? '').replace(/\D/g, '').slice(0, 4);
  return `precio "${pieza}" "${identity}" ${anio} comprar mexico cdmx`
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeYear(n: number): boolean {
  return Number.isInteger(n) && n >= 1980 && n <= 2039;
}

function parseMexicanNumber(raw: string): number | null {
  const t = String(raw ?? '')
    .replace(/\s/g, '')
    .replace(/[^\d.,]/g, '');
  if (!t) return null;
  let n: number;
  if (/\.\d{2}$/.test(t) && t.includes(',')) {
    n = Number(t.replace(/,/g, ''));
  } else if (/,\d{2}$/.test(t)) {
    n = Number(t.replace(/\./g, '').replace(',', '.'));
  } else {
    n = Number(t.replace(/,/g, ''));
  }
  if (!Number.isFinite(n)) return null;
  return n;
}

/** Extrae montos MXN de snippets (ópticas/plásticos: $600–$12,000). Excluye años. */
export function extractMxnPricesFromText(text: string): number[] {
  const blob = String(text ?? '');
  if (!blob.trim()) return [];
  const re =
    /(?:\$|mxn|pesos)?\s*(\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d{2})?|\d{3,5})\s*(?:mxn|pesos|\$)?/gi;
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(blob))) {
    const token = String(m[0] ?? '');
    const n = parseMexicanNumber(m[1] ?? '');
    if (n == null) continue;
    const hasCurrency = /\$|mxn|pesos/i.test(token);
    if (!hasCurrency && looksLikeYear(n)) continue;
    if (n < PRICE_MIN_MXN || n > PRICE_MAX_MXN) continue;
    out.push(Math.round(n));
  }
  return out;
}

export function isViableRefaccionPrice(n: number): boolean {
  return Number.isFinite(n) && n >= PRICE_MIN_MXN && n <= PRICE_MAX_MXN;
}

function collectFromSnippets(
  snippets: string[],
  source: WebPriceHit['source'],
): WebPriceHit[] {
  const hits: WebPriceHit[] = [];
  for (const snippet of snippets) {
    for (const price of extractMxnPricesFromText(snippet)) {
      hits.push({ price, source, snippet: snippet.slice(0, 180) });
    }
  }
  return hits;
}

async function searchSerper(query: string): Promise<WebPriceHit[]> {
  const key = String(process.env.SERPER_API_KEY ?? '').trim();
  if (!key) return [];
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': key,
    },
    body: JSON.stringify({ q: query, gl: 'mx', hl: 'es', num: 10 }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as {
    organic?: Array<{ title?: string; snippet?: string }>;
    answerBox?: { answer?: string; snippet?: string };
  };
  const snippets = [
    json.answerBox?.answer,
    json.answerBox?.snippet,
    ...(json.organic ?? []).flatMap((r) => [r.title, r.snippet]),
  ].filter((s): s is string => Boolean(s?.trim()));
  return collectFromSnippets(snippets, 'serper');
}

async function searchTavily(query: string): Promise<WebPriceHit[]> {
  const key = String(process.env.TAVILY_API_KEY ?? '').trim();
  if (!key) return [];
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      query,
      search_depth: 'basic',
      include_answer: true,
      max_results: 8,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as {
    answer?: string;
    results?: Array<{ title?: string; content?: string }>;
  };
  const snippets = [
    json.answer,
    ...(json.results ?? []).flatMap((r) => [r.title, r.content]),
  ].filter((s): s is string => Boolean(s?.trim()));
  return collectFromSnippets(snippets, 'tavily');
}

async function searchOpenAiWeb(query: string): Promise<WebPriceHit[]> {
  const key = String(process.env.OPENAI_API_KEY ?? '').trim();
  if (!key) return [];
  const openai = new OpenAI({ apiKey: key });
  const base = openAiResponsesParams({ tier: 'fast', maxOutputTokens: 900 });
  const prompt = [
    'Busca precios de venta en México / CDMX (MXN) para esta refacción automotriz.',
    'Devuelve solo un listado breve de precios encontrados con fuente (MercadoLibre, Amazon México, refaccionaria).',
    `Consulta: ${query}`,
  ].join('\n');

  const toolTypes = ['web_search', 'web_search_preview'] as const;
  for (const toolType of toolTypes) {
    try {
      const response = await openai.responses.create({
        ...base,
        tools: [{ type: toolType } as never],
        input: prompt,
      });
      const text = String(response.output_text ?? '').trim();
      if (!text) continue;
      const hits = collectFromSnippets([text], 'openai');
      if (hits.length) return hits;
    } catch {
      /* probar el otro tipo de tool */
    }
  }
  return [];
}

function webSearchDisabled(): boolean {
  return (
    process.env.NODE_ENV === 'test' &&
    process.env.REFACCION_WEB_SEARCH !== '1'
  );
}

/** Búsqueda abierta (Serper → Tavily → OpenAI Web Search). */
export async function searchRefaccionWebPrices(
  query: string,
): Promise<WebPriceHit[]> {
  if (webSearchDisabled()) return [];
  const attempts: Array<() => Promise<WebPriceHit[]>> = [
    () => searchSerper(query),
    () => searchTavily(query),
    () => searchOpenAiWeb(query),
  ];
  const all: WebPriceHit[] = [];
  for (const run of attempts) {
    try {
      const hits = await run();
      all.push(...hits);
      if (all.length >= 3) break;
    } catch {
      /* siguiente proveedor */
    }
  }
  return all;
}
