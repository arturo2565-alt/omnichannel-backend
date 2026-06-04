import type OpenAI from 'openai';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import {
  findPanelPiezaOption,
  normalizePanelPiezaCode,
  resolveMatrixServicioRaw,
} from '../catalog/panel-pieza-catalog';
import {
  AUTO_FIX_CURRENCY,
  coerceDamageLevelCode,
  formatAutoFixMoney,
  normalizeTextForMatch,
  resolveDamageLevelFromText,
} from './autofix-config';
import type { DraftQuote } from './autofix-config';
import type { DetectedDamageItem } from './entities/chat.entity';
import { textLooksLikePiezaPinturaRepintadoRequest } from './instant-quote-from-text';
import type {
  ExtractedClientPiece,
  QuoteLineSource,
  ResolvedTextQuoteLine,
  TextQuoteProcessResult,
} from './text-client-quote.types';

const LOCAL_PIEZA_TEXT_HINT_RE =
  /\b(facia|fascia|defensa|parachoques|puerta|salpicadera|cofre|capo|toldo|espejo|estribo|cajuela|tapa\s*cajuela)\b/;

const ADD_PIECE_INTENT_RE =
  /\b(tambien|tambi[eé]n|agrega|agregar|incluye|incluir|anade|a[nñ]ade|suma|otra|otro|cuanto|cu[aá]nto|cotiz\w*|presupuesto)\b/i;

const REPAIR_INTENT_RE =
  /\b(reparar|reparacion|arreglar|arreglo|pintar|repintar|pintura)\b/i;

const SEGMENT_SPLIT_RE =
  /\s*(?:,|\by\b|\btambien\b|\btambi[eé]n\b|\bagrega\b|\bagregar\b|\bincluye\b|\bincluir\b|\banade\b|\ba[nñ]ade\b|\bsuma\b|\bmas\b|\bm[aá]s\b|\botra\b|\botro\b|\bcuanto\b|\bcu[aá]nto\b|\bpor\b)\s+/gi;

const PANEL_SCAN_ALIASES: readonly { re: RegExp; code: string }[] = [
  { re: /\bfascia\s+trasera\b|\bfacia\s+trasera\b|\bdefensa\s+trasera\b|\bparachoques\s+trasero\b/, code: 'FT' },
  { re: /\bfascia\s+delantera\b|\bfacia\s+delantera\b|\bdefensa\s+delantera\b|\bparachoques\s+delantero\b/, code: 'FD' },
  { re: /\bfascia\b|\bfacia\b|\bdefensa\b|\bparachoques\b/, code: 'FD' },
  { re: /\bpuerta\s+delantera\s+izquierda\b/, code: 'PDI' },
  { re: /\bpuerta\s+delantera\s+derecha\b/, code: 'PDD' },
  { re: /\bpuerta\s+trasera\s+izquierda\b/, code: 'PTI' },
  { re: /\bpuerta\s+trasera\s+derecha\b/, code: 'PTD' },
  { re: /\bpuerta\b/, code: 'PDI' },
  { re: /\bsalpicadera\s+trasera\s+izquierda\b/, code: 'STI' },
  { re: /\bsalpicadera\s+trasera\s+derecha\b/, code: 'STD' },
  { re: /\bsalpicadera\s+izquierda\b/, code: 'SI' },
  { re: /\bsalpicadera\s+derecha\b/, code: 'SD' },
  { re: /\bsalpicadera\b/, code: 'SI' },
  { re: /\bcofre\b|\bcapo\b/, code: 'Cofre' },
  { re: /\btoldo\b/, code: 'Toldo' },
  { re: /\btapa\s*de?\s*cajuela\b|\bcajuela\b/, code: 'Tapa Cajuela' },
  { re: /\bespejo\b/, code: 'Espejo' },
  { re: /\bestribo\b/, code: 'EI' },
  { re: /\bposte\s+izquierdo\b/, code: 'POI' },
  { re: /\bposte\s+derecho\b/, code: 'POD' },
];

export function detectTextClientQuoteIntent(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (textLooksLikePiezaPinturaRepintadoRequest(t)) return true;
  const n = normalizeTextForMatch(t);
  if (ADD_PIECE_INTENT_RE.test(n) && LOCAL_PIEZA_TEXT_HINT_RE.test(n)) return true;
  if (REPAIR_INTENT_RE.test(n) && LOCAL_PIEZA_TEXT_HINT_RE.test(n)) return true;
  if (/\bsolo\s+est[aá]\s+rayad/.test(n)) return true;
  if (/\bquiero\s+pintar\s+estas\s+piezas\b/.test(n)) return true;
  return false;
}

function splitQuoteSegments(text: string): string[] {
  const flat = String(text ?? '')
    .replace(/\r\n/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();
  if (!flat) return [];
  const parts = flat
    .split(SEGMENT_SPLIT_RE)
    .map((p) => p.trim())
    .filter((p) => p.length >= 3);
  return parts.length ? parts : [flat];
}

function inferSeverityFromSegment(segment: string): string {
  const fromText = resolveDamageLevelFromText('', segment);
  if (fromText) return fromText;
  const n = normalizeTextForMatch(segment);
  if (/\brayad\w*\b|\baranaz\w*\b|\brozad\w*\b|\bsuperficial\b|\bleve\b/.test(n)) {
    return 'DL';
  }
  if (/\bmoderad\w*\b|\bintermedi\w*\b/.test(n)) return 'DM';
  if (/\bgrave\b|\bsever\w*\b/.test(n)) return 'DF';
  return 'DL';
}

function scanPanelCodeInSegment(segment: string): string | null {
  const opt = findPanelPiezaOption(segment);
  if (opt?.code && opt.code !== 'BPC' && !opt.internalDamageRange && !opt.refaccionManual) {
    return opt.code;
  }
  const n = normalizeTextForMatch(segment);
  for (const { re, code } of PANEL_SCAN_ALIASES) {
    if (re.test(n)) return code;
  }
  return null;
}

export function extractClientQuotePiecesHeuristic(
  userText: string,
): ExtractedClientPiece[] {
  const segments = splitQuoteSegments(userText);
  const found: ExtractedClientPiece[] = [];
  const usedCodes = new Set<string>();

  for (const seg of segments) {
    const panelCode = scanPanelCodeInSegment(seg);
    if (!panelCode || usedCodes.has(panelCode)) continue;
    const opt = findPanelPiezaOption(panelCode);
    usedCodes.add(panelCode);
    found.push({
      textoOriginal: seg,
      panelCode,
      nombreVisible: opt?.fullName ?? panelCode,
      severidadHint: inferSeverityFromSegment(seg),
      confidence: 0.82,
    });
  }

  return found;
}

const LLM_EXTRACT_SYSTEM = `Eres un extractor de piezas de carrocería para cotización en taller.
Responde SOLO JSON válido: {"piezas":[{"textoOriginal":"...","panelCode":"FD|FT|PDI|...","nombreVisible":"...","severidadHint":"DL|DML|DM|DMF|DF|DMFuerte","accion":"pintar|reparar","confidence":0.0-1.0}]}
Reglas:
- panelCode debe ser código del panel (FD, FT, PDI, PDD, SI, SD, Cofre, Toldo, etc.) cuando sea posible.
- severidadHint: DL para rayón/leve, DM moderado, DF grave.
- No inventes precios.
- Si no hay pieza identificable, devuelve {"piezas":[]}.`;

export async function extractClientQuotePiecesWithLlm(
  openai: OpenAI,
  userText: string,
  contextText?: string,
): Promise<ExtractedClientPiece[]> {
  const blob = [contextText, userText].filter(Boolean).join('\n').trim();
  if (!blob) return [];
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: LLM_EXTRACT_SYSTEM },
        { role: 'user', content: blob.slice(0, 4000) },
      ],
    });
    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as {
      piezas?: Array<{
        textoOriginal?: string;
        panelCode?: string;
        nombreVisible?: string;
        severidadHint?: string;
        accion?: string;
        confidence?: number;
      }>;
    };
    const piezas = Array.isArray(parsed.piezas) ? parsed.piezas : [];
    return piezas
      .map((p) => {
        const panelCode =
          p.panelCode?.trim() ||
          scanPanelCodeInSegment(String(p.textoOriginal ?? '')) ||
          undefined;
        const opt = panelCode ? findPanelPiezaOption(panelCode) : null;
        return {
          textoOriginal: String(p.textoOriginal ?? '').trim(),
          panelCode,
          nombreVisible: p.nombreVisible?.trim() || opt?.fullName,
          severidadHint:
            p.severidadHint?.trim() ||
            inferSeverityFromSegment(String(p.textoOriginal ?? '')),
          accion: p.accion?.trim(),
          confidence:
            typeof p.confidence === 'number' && p.confidence >= 0
              ? Math.min(1, p.confidence)
              : 0.7,
        } satisfies ExtractedClientPiece;
      })
      .filter((p) => p.textoOriginal.length > 0);
  } catch (err) {
    console.warn('[TextClientQuote] LLM extract falló:', (err as Error).message);
    return [];
  }
}

export function resolveExtractedPiecesAgainstCatalog(
  pieces: readonly ExtractedClientPiece[],
  snap: MatrixPricingSnapshot,
  fuente: QuoteLineSource = 'texto_cliente',
): { resolved: ResolvedTextQuoteLine[]; unresolved: ExtractedClientPiece[] } {
  const resolved: ResolvedTextQuoteLine[] = [];
  const unresolved: ExtractedClientPiece[] = [];

  for (const piece of pieces) {
    const panelCode =
      normalizePanelPiezaCode(piece.panelCode ?? piece.textoOriginal) ||
      String(piece.panelCode ?? '').trim();
    const opt = findPanelPiezaOption(panelCode);
    const nombreVisible =
      piece.nombreVisible?.trim() || opt?.fullName || panelCode;
    const severidad = coerceDamageLevelCode(
      piece.severidadHint ?? inferSeverityFromSegment(piece.textoOriginal),
    );
    const matrixRaw = resolveMatrixServicioRaw(panelCode);
    const catalogServicio = snap.matchServicio(matrixRaw);

    if (!catalogServicio) {
      unresolved.push(piece);
      resolved.push({
        panelCode,
        nombreVisible,
        catalogServicio: null,
        severidad,
        precioOficial: 0,
        precioFinal: 0,
        fuente,
        evidencia: 'sin foto / declarado por cliente',
        confidence: piece.confidence,
        notasInternas: `No resuelto en catálogo: ${piece.textoOriginal}`,
        estadoRevision: 'requiere_revision_manual',
        unresolvedReason: 'servicio_no_encontrado',
      });
      continue;
    }

    let precioOficial = snap.getAmount(catalogServicio, severidad);
    if (precioOficial <= 0 && severidad !== 'DL') {
      precioOficial = snap.getAmount(catalogServicio, 'DL');
    }
    if (precioOficial <= 0) {
      unresolved.push(piece);
      resolved.push({
        panelCode,
        nombreVisible,
        catalogServicio,
        severidad,
        precioOficial: 0,
        precioFinal: 0,
        fuente,
        evidencia: 'sin foto / declarado por cliente',
        confidence: piece.confidence,
        notasInternas: `Sin celda de precio para ${catalogServicio} / ${severidad}`,
        estadoRevision: 'requiere_revision_manual',
        unresolvedReason: 'precio_no_en_catalogo',
      });
      continue;
    }

    resolved.push({
      panelCode,
      nombreVisible,
      catalogServicio,
      severidad,
      precioOficial,
      precioFinal: precioOficial,
      fuente,
      evidencia: 'sin foto / declarado por cliente',
      confidence: piece.confidence,
      notasInternas: piece.textoOriginal,
      estadoRevision: 'pendiente_revision_fisica',
    });
  }

  return { resolved, unresolved };
}

export function resolvedLinesToDetectedDamageItems(
  lines: readonly ResolvedTextQuoteLine[],
): DetectedDamageItem[] {
  return lines.map((l) => ({
    pieza: l.panelCode,
    severidad: l.severidad,
    descripcionTecnica: l.notasInternas || l.nombreVisible,
    urls_origen: [],
    fuente: l.fuente,
    nombreVisible: l.nombreVisible,
    catalogServicio: l.catalogServicio ?? undefined,
    precioOficial: l.precioOficial,
    precioFinal: l.precioFinal,
    evidencia: l.evidencia,
    confidence: l.confidence,
    estadoRevision: l.estadoRevision,
    notasInternas: l.notasInternas,
  }));
}

export function buildClientMessageFromSavedDraftQuote(
  quote: DraftQuote,
  opts?: {
    newPanelCodes?: readonly string[];
    unresolvedLabels?: readonly string[];
  },
): string {
  const lines = quote.lines ?? [];
  const blocks: string[] = [
    '¡Hola! Actualicé tu cotización con los datos oficiales de nuestro catálogo:',
    '',
  ];

  if (lines.length === 0) {
    blocks.push(
      'Recibí tu solicitud, pero necesito que me confirmes qué pieza exacta deseas cotizar (por ejemplo: fascia trasera, puerta delantera derecha, cofre).',
    );
    return blocks.join('\n');
  }

  for (const line of lines) {
    blocks.push(
      `• *${line.description}*: ${formatAutoFixMoney(line.unitPrice)} ${quote.currency}`,
    );
  }

  blocks.push(
    '',
    `*Total estimado: ${formatAutoFixMoney(quote.total)} ${quote.currency}*`,
    '',
    '_Los importes provienen del catálogo vigente del taller y están sujetos a revisión física en planta._',
  );

  if (opts?.newPanelCodes?.length) {
    blocks.push(
      '',
      `Piezas agregadas en este mensaje: ${opts.newPanelCodes.join(', ')}.`,
    );
  }

  if (opts?.unresolvedLabels?.length) {
    blocks.push(
      '',
      `⚠️ Necesito aclaración para: ${opts.unresolvedLabels.join(', ')}. ¿Puedes indicarme la pieza exacta o enviar una foto?`,
    );
  }

  blocks.push(
    '',
    'Si te parece bien, con gusto te ayudo a agendar una visita al taller.',
  );

  return blocks.join('\n');
}

export function logTextClientQuoteFlow(payload: Record<string, unknown>): void {
  console.log('[TextClientQuote]', JSON.stringify(payload));
}

export function emptyTextQuoteProcessResult(): TextQuoteProcessResult {
  return {
    handled: false,
    extractedPieces: [],
    resolvedLines: [],
    unresolvedPieces: [],
    addedPanelCodes: [],
    totalGuardado: 0,
  };
}
