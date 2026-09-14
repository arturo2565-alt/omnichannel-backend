import { shortConvId, shortTurnId } from '../pegazuz-context';
import type { PegazuzLogRecord } from '../pegazuz-log-record';
import { renderCompactLog } from './compact-log-renderer';

const SEPARATOR = '────────────────────────────────────────────────────';

const EMOJI = {
  inbound: '💬',
  vision: '👁️',
  vehicle: '🚘',
  treatment: '🔧',
  market: '🔎',
  quote: '💰',
  llm: '🧠',
  ux: '🧩',
  outbound: '📤',
  sent: '📨',
  appointment: '📅',
  success: '✅',
  warn: '⚠️',
  error: '❌',
} as const;

function shortId(id?: string, n = 8): string | undefined {
  const raw = String(id ?? '').trim();
  if (!raw) return undefined;
  const stripped = raw.replace(/^(turn_|mrs_|quo_|vis_)/, '').replace(/-/g, '');
  return stripped.slice(0, n);
}

function joinPrettyBlock(lines: Array<string | undefined>): string {
  return lines
    .filter((row): row is string => Boolean(row && String(row).length))
    .join('\n');
}

function indentLines(title: string, rows: Array<string | undefined>): string {
  const body = rows.filter((row): row is string => Boolean(row && row.trim()));
  return joinPrettyBlock([title, ...body.map((row) => `   ${row}`)]);
}

function yesNo(value: unknown): string {
  if (value === true || value === 'true' || value === 1) return 'sí';
  if (value === false || value === 'false' || value === 0) return 'no';
  return String(value);
}

function humanPiece(code: unknown): string | undefined {
  const raw = String(code ?? '').trim();
  if (!raw) return undefined;
  const spaced = raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const [first, ...rest] = spaced.split(' ');
  if (!first) return undefined;
  return [first, ...rest.map((w) => w.toLowerCase())].join(' ');
}

function humanChannel(channel: unknown): string | undefined {
  const raw = String(channel ?? '').trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === 'facebook' || raw === 'messenger') return 'Messenger';
  if (raw === 'whatsapp') return 'WhatsApp';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function formatDuration(ms: unknown): string | undefined {
  const n = typeof ms === 'number' ? ms : Number(String(ms ?? '').replace(/ms$/i, ''));
  if (!Number.isFinite(n) || n < 0) return undefined;
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

function formatMoney(total: unknown): string | undefined {
  const n = typeof total === 'number' ? total : Number(total);
  if (!Number.isFinite(n)) return undefined;
  return `$${Math.round(n).toLocaleString('es-MX')} MXN`;
}

function abbreviateCount(n: unknown): string | undefined {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return undefined;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(v));
}

function marketStatusLabel(status: unknown): string {
  const raw = String(status ?? '').toUpperCase();
  if (raw.includes('INSUFFICIENT')) return `${EMOJI.warn} insuficiente`;
  if (raw.includes('AWAITING')) return `${EMOJI.warn} esperando datos`;
  if (raw === 'OK' || raw === 'READY') return `${EMOJI.success} OK`;
  return String(status ?? '');
}

function outboundLabel(status: unknown): string {
  const raw = String(status ?? '').toUpperCase();
  if (raw === 'ENQUEUED') return 'encolado';
  if (raw === 'SENT') return 'enviado';
  if (raw === 'NONE' || !raw) return 'ninguno';
  return String(status);
}

function rejectionRows(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).map((row) => {
    if (typeof row === 'string') return `· ${row.replace(':', ': ')}`;
    if (row && typeof row === 'object') {
      const r = row as { reason?: unknown; count?: unknown };
      return `· ${r.reason}: ${r.count}`;
    }
    return `· ${String(row)}`;
  });
}

function inboundType(data: Record<string, unknown>): string {
  const t = String(data.type ?? '').toLowerCase();
  if (t === 'image' || t === 'imagen') {
    const count = data.count != null ? ` · ${data.count} fotos` : '';
    return `imagen${count}`;
  }
  if (t === 'postback') return 'postback';
  return 'texto';
}

function renderInbound(record: PegazuzLogRecord): string {
  const turn = shortTurnId(record.correlation.turnId) ?? shortId(record.correlation.turnId);
  const conv = shortConvId(record.correlation.conversationId);
  const title = `${EMOJI.inbound} TURN START · ${turn ?? '—'}`;
  return joinPrettyBlock([
    SEPARATOR,
    indentLines(title, [
      conv ? `Conversación: ${conv}` : undefined,
      humanChannel(record.data.channel)
        ? `Canal: ${humanChannel(record.data.channel)}`
        : undefined,
      `Tipo: ${inboundType(record.data)}`,
    ]),
  ]);
}

function renderVehicle(record: PegazuzLogRecord): string {
  const year = record.data.year ? `Año: ${record.data.year}` : undefined;
  const confirmed =
    record.data.confirmed === true
      ? 'Estado: confirmado por cliente'
      : record.data.confirmed === false
        ? 'Estado: pendiente de confirmar'
        : undefined;
  return indentLines(`${EMOJI.vehicle} Vehículo`, [
    record.data.vehicle ? String(record.data.vehicle) : undefined,
    year,
    confirmed,
  ]);
}

function renderTreatment(record: PegazuzLogRecord): string {
  return indentLines(`${EMOJI.treatment} Tratamientos`, [
    `Reparar: ${record.data.reparar ?? 0}`,
    `Sustituir: ${record.data.sustituir ?? 0}`,
    `Incierto: ${record.data.incierto ?? 0}`,
    `Pendiente: ${record.data.pendiente ?? 0}`,
  ]);
}

function renderMarket(record: PegazuzLogRecord): string {
  if (record.data.phase === 'START') {
    const piece = humanPiece(record.data.piece) ?? record.data.piece;
    return `${EMOJI.market} Mercado · ${piece ?? 'pieza'} · START`;
  }
  const nested = String(record.data.event ?? '');
  if (nested === 'MARKET_INSUFFICIENT') {
    const piece = humanPiece(record.data.piece) ?? record.data.piece;
    const selected = record.data.selectedGroupSamples;
    const required = record.data.requiredSamples;
    const group =
      selected != null && required != null
        ? `Válidas para grupo: ${selected}/${required}`
        : undefined;
    return indentLines(`${EMOJI.warn} MARKET · muestras insuficientes`, [
      piece ? `Pieza: ${piece}` : undefined,
      group,
      rejectionRows(record.data.topRejectionReasons).length
        ? 'Principales rechazos:'
        : undefined,
      ...rejectionRows(record.data.topRejectionReasons),
    ]);
  }
  const piece = humanPiece(record.data.piece) ?? record.data.piece;
  const selected = record.data.selectedGroupSamples;
  const required = record.data.requiredSamples;
  const duration = formatDuration(record.data.durationMs ?? record.data.duration);
  return indentLines(`${EMOJI.market} Mercado · ${piece ?? 'pieza'}`, [
    record.data.rawResults != null ? `Raw: ${record.data.rawResults}` : undefined,
    record.data.afterDedupe != null
      ? `Deduplicados: ${record.data.afterDedupe}`
      : undefined,
    record.data.independentSamples != null
      ? `Independientes: ${record.data.independentSamples}`
      : undefined,
    selected != null && required != null
      ? `Grupo seleccionado: ${selected}/${required}`
      : undefined,
    record.data.selectedPartType
      ? `Tipo: ${record.data.selectedPartType}`
      : undefined,
    record.data.status
      ? `Estado: ${marketStatusLabel(record.data.status)}`
      : undefined,
    duration ? `⏱ ${duration}` : undefined,
  ]);
}

function renderQuote(record: PegazuzLogRecord): string {
  const estado =
    record.data.partial === true
      ? 'Estado: parcial'
      : record.data.partial === false
        ? `Estado: ${EMOJI.success} completa`
        : undefined;
  return indentLines(`${EMOJI.quote} Cotización`, [
    formatMoney(record.data.total) ? `Total: ${formatMoney(record.data.total)}` : undefined,
    record.data.billable != null ? `Cobrables: ${record.data.billable}` : undefined,
    record.data.pending != null ? `Pendientes: ${record.data.pending}` : undefined,
    estado,
  ]);
}

function renderUx(record: PegazuzLogRecord): string {
  return indentLines(`${EMOJI.ux} UX`, [
    record.data.mode ? `Modo: ${record.data.mode}` : undefined,
    record.data.delta != null ? `Delta: ${record.data.delta}` : undefined,
    record.data.greet != null ? `Saludo: ${yesNo(record.data.greet)}` : undefined,
    record.data.technical != null
      ? `Técnica: ${yesNo(record.data.technical)}`
      : undefined,
    record.data.warnings != null ? `Warnings: ${record.data.warnings}` : undefined,
    record.data.cta ? `CTA: ${record.data.cta}` : undefined,
  ]);
}

function renderLlm(record: PegazuzLogRecord): string {
  const source = record.data.source ?? 'llm';
  const model = record.data.model ?? '';
  const input = abbreviateCount(record.data.input);
  const cache =
    record.data.cachePct != null ? `cache ${record.data.cachePct}%` : undefined;
  const output = abbreviateCount(record.data.output);
  const latency = formatDuration(record.data.latencyMs ?? record.data.latency);
  const bits = [
    `${EMOJI.llm} LLM · ${source}`,
    model,
    input ? `in ${input}` : undefined,
    cache,
    output ? `out ${output}` : undefined,
    latency,
  ].filter(Boolean);
  return bits.join(' · ');
}

function renderOutbound(record: PegazuzLogRecord): string {
  const status = String(record.data.status ?? '').toLowerCase();
  if (status === 'sent') {
    const duration = formatDuration(record.data.durationMs ?? record.data.duration);
    const channel = humanChannel(record.data.channel) ?? record.data.channel;
    const turn = shortTurnId(record.correlation.turnId);
    return indentLines(
      `${EMOJI.sent} OUTBOUND SENT${turn ? ` · ${turn}` : ''}`,
      [
        [channel, duration].filter(Boolean).join(' · ') || undefined,
      ],
    );
  }
  return indentLines(`${EMOJI.outbound} Outbound`, [
    `Estado: ${outboundLabel(record.data.status)}`,
  ]);
}

function renderTurnComplete(record: PegazuzLogRecord): string {
  const turn = shortTurnId(record.correlation.turnId) ?? shortId(record.correlation.turnId);
  const timingBits = [
    record.data.visionMs != null
      ? `Vision ${formatDuration(record.data.visionMs)}`
      : undefined,
    record.data.marketMs != null
      ? `Market ${formatDuration(record.data.marketMs)}`
      : undefined,
    record.data.llmMs != null ? `LLM ${formatDuration(record.data.llmMs)}` : undefined,
    formatDuration(record.data.durationMs ?? record.data.duration)
      ? `Total ${formatDuration(record.data.durationMs ?? record.data.duration)}`
      : undefined,
  ].filter(Boolean);
  const body = indentLines(`${EMOJI.success} TURN COMPLETE · ${turn ?? '—'}`, [
    record.data.vehicle ? `Vehículo: ${record.data.vehicle}` : undefined,
    record.data.market
      ? `Market: ${marketStatusLabel(record.data.market)}`
      : undefined,
    formatMoney(record.data.quoteTotal)
      ? `Total: ${formatMoney(record.data.quoteTotal)}`
      : undefined,
    record.data.partial != null ? `Parcial: ${yesNo(record.data.partial)}` : undefined,
    record.data.outbound
      ? `Outbound: ${outboundLabel(record.data.outbound)}`
      : undefined,
    timingBits.length ? `⏱ ${timingBits.join(' · ')}` : undefined,
  ]);
  return joinPrettyBlock([body, SEPARATOR]);
}

function renderWebhook(record: PegazuzLogRecord): string {
  if (record.data.echo) {
    const mid = record.data.mid
      ? ` · mid=${shortId(String(record.data.mid), 8)}`
      : '';
    return `${EMOJI.inbound} Webhook · echo ignorado${mid}`;
  }
  return `${EMOJI.inbound} Webhook`;
}

function renderError(record: PegazuzLogRecord): string {
  const turn = shortTurnId(record.correlation.turnId);
  const piece = humanPiece(record.data.piece);
  const rows = [
    turn ? `Turn: ${turn}` : undefined,
    piece ? `Pieza: ${piece}` : undefined,
    record.data.provider ? `Provider: ${record.data.provider}` : undefined,
    record.data.message ? `Error: ${record.data.message}` : undefined,
    record.data.errorType ? `Tipo: ${record.data.errorType}` : undefined,
    record.data.retry ? `Retry: ${record.data.retry}` : undefined,
    record.level === 'error' && record.data.stack
      ? String(record.data.stack)
      : undefined,
  ];
  return indentLines(`${EMOJI.error} ${record.event} ERROR`, rows);
}

function renderVision(record: PegazuzLogRecord): string {
  const complete = record.data.phase === 'COMPLETE';
  return indentLines(`${EMOJI.vision} Visión`, [
    record.data.input != null ? `Fotos: ${record.data.input}` : undefined,
    record.data.vehicle
      ? `Vehículo detectado: ${record.data.vehicle}`
      : undefined,
    record.data.items != null ? `Piezas: ${record.data.items}` : undefined,
    complete
      ? `Estado: ${EMOJI.success} completa`
      : record.data.phase === 'PARTIAL'
        ? 'Estado: parcial'
        : record.data.phase
          ? `Estado: ${record.data.phase}`
          : undefined,
    formatDuration(record.data.durationMs)
      ? `⏱ ${formatDuration(record.data.durationMs)}`
      : undefined,
  ]);
}

export function renderPrettyLog(record: PegazuzLogRecord): string {
  if (record.level === 'error') return renderError(record);
  if (record.level === 'debug' || record.level === 'trace') {
    return renderCompactLog(record);
  }
  switch (record.event) {
    case 'INBOUND':
      return renderInbound(record);
    case 'VEHICLE':
      return renderVehicle(record);
    case 'TREATMENT':
      return renderTreatment(record);
    case 'MARKET':
      return renderMarket(record);
    case 'QUOTE':
      return renderQuote(record);
    case 'UX':
      return renderUx(record);
    case 'LLM':
      return renderLlm(record);
    case 'OUTBOUND':
      return renderOutbound(record);
    case 'TURN':
      return renderTurnComplete(record);
    case 'WEBHOOK':
      return renderWebhook(record);
    case 'VISION':
      return renderVision(record);
    default: {
      const bits = Object.entries(record.data)
        .filter(([key]) => key !== 'phase')
        .map(([key, value]) => `${key}=${String(value)}`);
      const title = `${record.event}${record.data.phase ? ` ${record.data.phase}` : ''}`;
      return joinPrettyBlock([title, ...bits.map((b) => `   ${b}`)]);
    }
  }
}
