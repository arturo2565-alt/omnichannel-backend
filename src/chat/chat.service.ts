import {
  Injectable,
  NotFoundException,
  BadRequestException,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { In, Repository } from 'typeorm';
import {
  DetectedDamageItem,
  Message,
  VehicleDamageAnalysis,
} from './entities/chat.entity';
import { Conversation } from './entities/conversation.entity';
import { DraftQuoteEntity } from './entities/draft-quote.entity';
import { DraftQuoteItem } from './entities/draft-quote-item.entity';
import {
  AppointmentEntity,
  type AppointmentStatus,
} from './entities/appointment.entity';
import { ChatGateway } from './chat.gateway';
import { OpenAI } from 'openai';
import { v2 as cloudinary } from 'cloudinary';
import {
  AUTO_FIX_CURRENCY,
  coerceDamageLevelCode,
  damageLevelRank,
  DraftQuote,
  DraftQuoteLine,
  formatAutoFixMoney,
  normalizeTextForMatch,
  type DamageLevel,
} from './autofix-config';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import {
  WORKSHOP_TIMEZONE,
  validateWorkshopSlotUtc,
  buildLlmServerTimeSystemPrefix,
} from './appointment-intent';
import { AI_CONFIG_KEYS } from './ai-config-keys';
import { AiConfigService } from './ai-config.service';
import axios from 'axios';
import { CatalogService } from '../catalog/catalog.service';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import {
  classifyBañoPinturaTierWithLlm,
  coerceBañoSeveridadToCatalog,
  composeBañoNaturalInstantReply,
  extractBañoPersonalizedColorDetail,
} from './baño-pintura-llm';
import {
  buildPlaygroundPostQuoteSchedulingSystemAppend,
  getPlaygroundInstantInterceptorDecision,
  PLAYGROUND_INSTANT_INTERCEPTOR_HISTORY_TURNS,
  playgroundUserMessageMentionsWeekdayOnlyRough,
} from './playground-instant-quote-interceptor';
import {
  DRAFT_RESUME_BASE_AUTH_HINT,
  buildClienteFormalNarrativeAgendado,
  buildClienteFormalNarrativeComplement,
  buildClienteFormalNarrativeSinCita,
  buildDamagePhotoIntroForCliente,
  buildDraftResumeAgendadoCriticalContext,
  buildDraftResumeSinCitaSystemAppend,
  draftQuoteLinesToClientePiezaRows,
  formatAppointmentHumanDate,
  formatDraftAppointmentCitaLong,
  mergeDamageInventoryAccumulative,
  normalizeAuthorizedQuoteSummaryLines,
  piezaLabelFromDraftLineDescription,
  type DamageInventoryMergeResult,
} from './draft-quote-resume';
import { buildObtenerCotizacionExpressPayload } from './autopilot-cotizacion-express';
import {
  assistantMessageIsBañoVehiclePrompt,
  type InstantQuoteResolution,
  formatInstantQuoteClientMessage,
  inferBañoTierSeveridad,
  inferBañoVehicleDisplayLabel,
  isProhibitedVagueInstantQuoteText,
  isBañoDePinturaServicio,
  mentionsCambioDeColor,
  materializeInstantQuoteResolution,
  mentionsBañoDePinturaIntent,
  purifyVehicleModelUserReply,
  flattenBañoTierSource,
  resolveBañoCanonicalFromSnap,
  threadRequiresBañoStructuredQuote,
  tierSourceMentionsBora,
  resolveInstantCanonicalLatestThenFull,
  isBañoVehicleProfiledForQuote,
  isPlaceholderBañoVehicleLabel,
  shouldAskVehicleBeforeBañoQuote,
  extractBañoColorDetailHeuristic,
  tryBañoPinturaVehicleGateReply,
  tryResolvePiezaPinturaInstantReply,
  tryResolveInstantQuoteFromUserText,
  tryVagueGenericServiceProfilingReply,
  userLatestMessageLooksLikeVehicleModelReply,
} from './instant-quote-from-text';

/** Canales internos del panel: no deben sobrescribir el canal real del cliente en la conversación */
const AGENT_ONLY_PLATFORMS = new Set(['web-dashboard', 'test']);

function isAgentOnlyPlatform(platform: string | undefined | null): boolean {
  if (platform == null || typeof platform !== 'string') return false;
  return AGENT_ONLY_PLATFORMS.has(platform.trim().toLowerCase());
}

/** Modelo multimodal para peritaje por imagen (`analyzeDamageImage`). */
const VISION_DAMAGE_MODEL = 'gpt-5.5';

/** Solo guardamos en conversation.platform valores que describen WhatsApp / Instagram / etc. */
function shouldPersistPlatformOnConversation(
  platform: unknown,
): platform is string {
  return typeof platform === 'string' && platform.trim().length > 0
    ? !isAgentOnlyPlatform(platform)
    : false;
}

function normalizePlatformForApi(
  conversationPlatform: string | null | undefined,
  messageFallback: string | undefined,
): string {
  const p = conversationPlatform?.trim();
  if (p && !isAgentOnlyPlatform(p)) return p.toLowerCase();
  const fb = messageFallback?.trim();
  if (fb && !isAgentOnlyPlatform(fb)) return fb.toLowerCase();
  return 'unknown';
}

function pickFirstNonEmptyTrimmedString(...values: unknown[]): string {
  for (const v of values) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s.length > 0) return s;
  }
  return '';
}

/** UUID de conversación interna (panel / API). */
function looksLikeConversationUuid(raw: unknown): boolean {
  const s = String(raw ?? '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s,
  );
}

/** Imagen entrante: URL, data URL base64 o ya alojada en Cloudinary */
function isIncomingImage(content: unknown): content is string {
  if (typeof content !== 'string' || !content.trim()) return false;
  if (/^data:image\//i.test(content)) return true;
  return (
    content.match(/\.(jpeg|jpg|gif|png|webp)(\?|$)/i) != null ||
    content.includes('cloudinary')
  );
}

/** Quita bloques ```json … ``` que a veces devuelve el modelo antes de JSON.parse. */
function stripMarkdownCodeFencesFromModelText(raw: string): string {
  let s = String(raw ?? '').trim();
  const fullFence = /^```(?:json)?\s*([\s\S]*?)\s*```\s*$/im;
  const m = fullFence.exec(s);
  if (m) return m[1].trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/gim, '');
  return s.trim();
}

/** Aísla el primer objeto `{...}` si hubo texto alrededor del JSON. */
function extractLikelyJsonObjectSubstring(s: string): string {
  const t = stripMarkdownCodeFencesFromModelText(s);
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last > first) return t.slice(first, last + 1).trim();
  return t;
}

/**
 * Parsea JSON de visión. Si falla, no se interpreta como "sin daños": log claro y error.
 */
function parseVisionModelJsonResponse(rawText: string, context: string): unknown {
  const candidate = extractLikelyJsonObjectSubstring(rawText);
  try {
    return JSON.parse(candidate) as unknown;
  } catch (err) {
    console.error(
      `[Vision JSON ${context}] JSON.parse falló tras limpiar markdown/prosa. Error:`,
      err,
    );
    console.error(
      `[Vision JSON ${context}] Candidato (primeros 4000 chars):`,
      candidate.slice(0, 4000),
    );
    throw new Error(
      'La respuesta del modelo de visión no es JSON válido. Revisa la consola del servidor ("Respuesta cruda de Vision" y logs anteriores).',
    );
  }
}

function isFacebookMessengerPlatform(
  platform: string | null | undefined,
): boolean {
  const s = String(platform ?? '').toLowerCase().trim();
  return (
    s.includes('facebook') || s.includes('messenger') || s === 'fb'
  );
}

/** Messenger / WhatsApp: autopilot por texto va en cola con debounce (no respuesta inmediata por mensaje). */
function shouldDebounceAutopilotInboundText(
  platform: string | null | undefined,
): boolean {
  const s = String(platform ?? '').toLowerCase().trim();
  if (!s) return false;
  return (
    isFacebookMessengerPlatform(s) ||
    s.includes('whatsapp')
  );
}

/**
 * Webhook de Meta Page (Messenger): `object: "page"` + `entry[]`.
 * Si `object` falta pero hay `entry[].messaging[]`, también lo tratamos como Meta (evita perder eventos).
 * Instagram usa `object: "instagram"` — no usar esta ruta.
 */
function isMetaPageWebhook(body: unknown): boolean {
  const b = body as Record<string, unknown> | null;
  if (!b || !Array.isArray(b.entry)) return false;
  if (b.object === 'instagram') return false;
  if (b.object === 'page') return true;
  return b.entry.some(
    (e) =>
      e &&
      typeof e === 'object' &&
      Array.isArray((e as Record<string, unknown>).messaging) &&
      ((e as Record<string, unknown>).messaging as unknown[]).length > 0,
  );
}

function normalizeDamageAnalysisJson(raw: unknown): VehicleDamageAnalysis {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const piezaRaw = typeof o['pieza'] === 'string' ? o['pieza'].trim() : '';
  const sevRaw =
    typeof o['severidad'] === 'string'
      ? o['severidad'].trim()
      : typeof o['severidadDelDano'] === 'string'
        ? String(o['severidadDelDano']).trim()
        : '';
  const severidad = coerceDamageLevelCode(sevRaw);
  const desc =
    typeof o['descripcionTecnica'] === 'string' && o['descripcionTecnica'].trim()
      ? o['descripcionTecnica'].trim()
      : typeof o['descripcion'] === 'string' && o['descripcion'].trim()
        ? String(o['descripcion']).trim()
        : 'Sin descripción técnica disponible.';
  const justificacion =
    typeof o['justificacion'] === 'string' && o['justificacion'].trim()
      ? o['justificacion'].trim()
      : 'Sin justificación detallada.';

  const parts = o['partesAfectadas'];
  let partesAfectadas: string[] = Array.isArray(parts)
    ? parts.map((p) => String(p).trim()).filter(Boolean)
    : typeof parts === 'string' && parts.trim()
      ? [parts.trim()]
      : [];
  const pieza = piezaRaw || (partesAfectadas[0] ?? '');
  if (piezaRaw && !partesAfectadas.some((p) => p.includes(piezaRaw) || piezaRaw.includes(p))) {
    partesAfectadas = [piezaRaw, ...partesAfectadas];
  }
  if (!partesAfectadas.length && pieza) partesAfectadas = [pieza];
  if (!partesAfectadas.length) partesAfectadas = ['Estetica Exterior'];

  return {
    pieza: pieza || 'No identificada',
    severidad,
    descripcionTecnica: desc,
    justificacion,
    partesAfectadas,
    severidadDelDano: severidad,
  };
}

function pickWorstDamageLevel(levels: string[]): DamageLevel {
  if (!levels.length) return 'DM';
  let worst: DamageLevel = coerceDamageLevelCode(levels[0] ?? 'DM');
  for (let i = 1; i < levels.length; i++) {
    const c = coerceDamageLevelCode(levels[i] ?? '');
    if (damageLevelRank(c) > damageLevelRank(worst)) worst = c;
  }
  return worst;
}

function normalizeDetectedDamagesJson(raw: unknown): DetectedDamageItem[] {
  const o =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const direct = Array.isArray(raw) ? raw : null;
  const arr =
    (Array.isArray(o['items']) ? o['items'] : null) ??
    (Array.isArray(o['detectedDamages']) ? o['detectedDamages'] : null) ??
    (Array.isArray(o['resultado']) ? o['resultado'] : null) ??
    direct;
  if (!Array.isArray(arr)) {
    throw new Error(
      'Se esperaba JSON con la clave "items" u otro array de daños ({ pieza, severidad, descripcionTecnica, urls_origen })',
    );
  }
  const out: DetectedDamageItem[] = [];
  for (const el of arr) {
    if (!el || typeof el !== 'object') continue;
    const r = el as Record<string, unknown>;
    const pieza = typeof r['pieza'] === 'string' ? r['pieza'].trim() : '';
    const severidad =
      typeof r['severidad'] === 'string' ? r['severidad'].trim() : '';
    const descripcionTecnica =
      typeof r['descripcionTecnica'] === 'string'
        ? r['descripcionTecnica'].trim()
        : typeof r['descripcion'] === 'string'
          ? String(r['descripcion']).trim()
          : '';
    const u =
      Array.isArray(r['urls_origen'])
        ? r['urls_origen']
        : Array.isArray(r['urls_asociadas'])
          ? r['urls_asociadas']
          : [];
    let urls_origen = u.map((x) => String(x).trim()).filter(Boolean);
    if (!pieza || !severidad) continue;
    out.push({
      pieza,
      severidad,
      descripcionTecnica:
        descripcionTecnica || 'Sin descripción técnica disponible.',
      urls_origen,
    });
  }
  if (!out.length) {
    throw new Error(
      'El array de daños detectados está vacío o sin filas con pieza y severidad válidas',
    );
  }
  return out;
}

/** Igual que {@link normalizeDetectedDamagesJson} pero devuelve `[]` si el JSON no es válido o no hay ítems. */
function parseDetectedDamageItemsAllowEmpty(parsed: unknown): DetectedDamageItem[] {
  try {
    return normalizeDetectedDamagesJson(parsed);
  } catch {
    return [];
  }
}

function inventoryItemsToVehicleAnalysis(
  items: DetectedDamageItem[],
  sourceUrls: string[],
): VehicleDamageAnalysis {
  const inv: DetectedDamageItem[] = items.map((it) => ({
    pieza: it.pieza,
    severidad: it.severidad,
    descripcionTecnica: it.descripcionTecnica,
    urls_origen: [...(it.urls_origen ?? [])],
  }));
  const partes = [...new Set(inv.map((i) => i.pieza).filter(Boolean))];
  const worst = pickWorstDamageLevel(inv.map((i) => i.severidad));
  const piezaLabel =
    partes.length === 1
      ? partes[0]
      : partes.length > 1
        ? `${partes.slice(0, 2).join(' + ')}${partes.length > 2 ? ` (+${partes.length - 2} más)` : ''}`
        : 'No identificada';
  const desc = inv
    .map(
      (it) =>
        `• ${it.pieza} (${coerceDamageLevelCode(it.severidad)}): ${it.descripcionTecnica}`,
    )
    .join('\n');
  const just = `Inventario unificado (${inv.length} daño(s) detectado(s) en el grupo de imágenes de la sesión). Las piezas repetidas entre fotos se consolidan tomando la severidad más alta. Imágenes analizadas: ${sourceUrls.length}.`;

  return {
    pieza: piezaLabel,
    severidad: worst,
    severidadDelDano: worst,
    descripcionTecnica: desc,
    justificacion: just,
    partesAfectadas: partes.length ? partes : ['Estetica Exterior'],
    inventory: inv,
  };
}

/** URLs almacenadas en `draft_quotes.imageUrl` (una URL o JSON array). */
function parseDraftImageUrls(imageUrl: string): string[] {
  const s = String(imageUrl ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const j = JSON.parse(s) as unknown;
      return Array.isArray(j) ? j.map(String).filter(Boolean) : [s];
    } catch {
      return [s];
    }
  }
  return [s];
}

/** Serializa evidencias visuales para `imageUrl` (una URL o JSON array). */
function persistDraftImageUrlField(imageUrls: readonly string[]): string {
  const urls = [
    ...new Set(imageUrls.map((u) => String(u).trim()).filter(Boolean)),
  ];
  if (!urls.length) return '';
  return urls.length === 1 ? urls[0]! : JSON.stringify(urls);
}

function attachImageUrlToDraftQuote(
  quote: DraftQuote,
  imageUrls: readonly string[],
): DraftQuote & { imageUrl: string } {
  return { ...quote, imageUrl: persistDraftImageUrlField(imageUrls) };
}

/** Lote de imágenes del playground (`imagesBase64[]`; acepta `imageBase64` legacy). */
function normalizePlaygroundImagesBase64Input(body: {
  imagesBase64?: unknown;
  imageBase64?: unknown;
}): string[] {
  const urls: string[] = [];
  if (Array.isArray(body.imagesBase64)) {
    for (const el of body.imagesBase64) {
      const s = String(el ?? '').trim();
      if (s) urls.push(s);
    }
  }
  const legacy =
    body.imageBase64 != null ? String(body.imageBase64).trim() : '';
  if (legacy) urls.push(legacy);
  return [...new Set(urls)];
}

export interface PatchInventoryLineDto {
  pieza: string;
  severidad: string;
  precioMx: number;
  /** @deprecated usar descripcionTecnica */
  descripcion?: string;
  descripcionTecnica?: string;
  /**
   * Evidencias en URL. Omitir la propiedad conserva URLs previas (mismo índice en inventario).
   * Enviar `[]` crea o mantiene la línea **sin** fotos (p. ej. pieza manual en el panel).
   */
  urls_origen?: string[];
  /** @deprecated usar urls_origen */
  urls_asociadas?: string[];
}

export interface PatchDraftQuoteBody {
  pieza?: string;
  severidad?: string;
  /** Precio final (MXN). Opcional: sustituye total y líneas tras recálculo por matriz. */
  precioFinal?: number;
  /** Varias piezas con precio por línea (panel). Si se envía, sustituye el flujo de una sola pieza. */
  inventoryLines?: PatchInventoryLineDto[];
}

/** Herramientas del autopilot (Chat Completions `tools`). */
const AUTOPILOT_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'obtenerCotizacionExpress',
      description:
        'Úsala cuando el cliente solicite el precio de un baño de pintura o el repintado express de piezas específicas y ya conozcas el modelo del vehículo. Esta función consultará la base de datos real del taller y te devolverá los precios oficiales para que se los presentes al cliente.',
      parameters: {
        type: 'object',
        properties: {
          servicios: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Piezas a repintar (ej. Puerta, Fascia, Salpicadera) o "baño de pintura" / pintura exterior completa.',
          },
          modeloVehiculo: {
            type: 'string',
            description:
              'Marca y modelo del vehículo del cliente (ej. Volkswagen Bora 2012, Nissan March 2018). Obligatorio antes de cotizar.',
          },
        },
        required: ['servicios', 'modeloVehiculo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'createAppointment',
      description:
        'Registra una cita en la base de datos del taller. Úsala cuando el cliente haya confirmado explícitamente día y hora de visita válidos dentro del horario laboral. En el panel de simulación (playground), la misma llamada solo valida horario y devuelve vista previa sin persistir en BD.',
      parameters: {
        type: 'object',
        properties: {
          scheduledAtIso: {
            type: 'string',
            description:
              'Fecha y hora del turno en ISO 8601 (ej. 2026-05-08T15:00:00-06:00). Debe corresponder al acuerdo con el cliente.',
          },
          clientName: {
            type: 'string',
            description:
              'Nombre del cliente si se menciona; si omites, se usará el nombre de la conversación.',
          },
          vehicleDescription: {
            type: 'string',
            description:
              'Modelo o datos del vehículo si el cliente los dio en el chat.',
          },
          phone: {
            type: 'string',
            description:
              'Teléfono del cliente si consta en el mensaje (solo dígitos o formato típico).',
          },
        },
        required: ['scheduledAtIso'],
      },
    },
  },
];

@Injectable()
export class ChatService implements OnModuleDestroy {
  private openai: OpenAI;

  /** Tras la última imagen: esperar tanto tiempo en silencio antes de lanzar GPT (reinicia con cada nueva foto). */
  private static readonly INBOUND_IMAGE_ANALYSIS_DEBOUNCE_MS = 30 * 1000;

  /** Máximo de imágenes por llamada a visión (evita timeouts / TPM en ráfagas grandes). */
  private static readonly VISION_IMAGE_CHUNK_SIZE = 3;

  /**
   * Tras el último mensaje de texto entrante (Messenger / WhatsApp): esperar antes de lanzar el autopilot.
   * Se reinicia con cada nuevo texto; al vencer, se responde en bloque a todos los textos aún sin contestar.
   */
  private static readonly AUTOPILOT_INBOUND_TEXT_DEBOUNCE_MS = 60 * 1000;

  /** Mensajes recientes (cliente + IA/sistema) que recibe el modelo en cada llamada de chat. */
  private static readonly LLM_CONVERSATION_HISTORY_LIMIT = 15;

  /** Ventana histórica (p. ej. fallback / consultas) para imágenes entrantes recientes en la conversación. */
  static readonly RECENT_IMAGE_LOOKBACK_MS = 5 * 60 * 1000;

  /** conversationId → timeout del análisis consolidado pendiente */
  private readonly consolidatedImageTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  /** conversationId → timeout del autopilot por texto (Messenger / WhatsApp) */
  private readonly autopilotTextDebounceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  /**
   * conversationId → URLs de la **ráfaga actual** (orden de llegada; se vacía al ejecutar el análisis tras el quiet-period).
   */
  private readonly pendingBurstImageUrls = new Map<string, string[]>();

  constructor(
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,

    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,

    @InjectRepository(DraftQuoteEntity)
    private readonly draftQuoteRepository: Repository<DraftQuoteEntity>,

    @InjectRepository(DraftQuoteItem)
    private readonly draftQuoteItemRepository: Repository<DraftQuoteItem>,

    @InjectRepository(AppointmentEntity)
    private readonly appointmentRepository: Repository<AppointmentEntity>,

    private readonly chatGateway: ChatGateway,

    private readonly aiConfigService: AiConfigService,

    private readonly catalogService: CatalogService,
  ) {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY, 
    });
  }

  onModuleDestroy(): void {
    for (const t of this.consolidatedImageTimers.values()) {
      clearTimeout(t);
    }
    this.consolidatedImageTimers.clear();
    this.pendingBurstImageUrls.clear();
    for (const t of this.autopilotTextDebounceTimers.values()) {
      clearTimeout(t);
    }
    this.autopilotTextDebounceTimers.clear();
  }

  /**
   * Últimos {@link ChatService.LLM_CONVERSATION_HISTORY_LIMIT} mensajes de la conversación,
   * en orden cronológico (más antiguo primero).
   */
  private async loadRecentMessagesForLlm(
    conversationId: string,
  ): Promise<Message[]> {
    const rows = await this.messageRepository.find({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      take: ChatService.LLM_CONVERSATION_HISTORY_LIMIT,
    });
    return rows.reverse();
  }

  /** Convierte filas persistidas a turnos `user` / `assistant` (omite vacíos e imágenes). */
  private messagesToChatCompletionTurns(
    rows: readonly Message[],
  ): ChatCompletionMessageParam[] {
    const out: ChatCompletionMessageParam[] = [];
    for (const m of rows) {
      const text = String(m.content ?? '').trim();
      if (!text || text.includes('cloudinary')) continue;
      const role: 'user' | 'assistant' =
        m.direction === 'inbound' ? 'user' : 'assistant';
      out.push({ role, content: text });
    }
    return out;
  }

  /** Máx. turnos de historial en el payload del playground (sesión larga de prueba). */
  private static readonly PLAYGROUND_HISTORY_PAYLOAD_MAX = 50;

  /** Historial opcional del panel playground (sin persistir en BD). */
  private normalizePlaygroundHistoryPayload(
    raw: unknown,
  ): { role: 'user' | 'assistant'; text: string }[] {
    if (!Array.isArray(raw)) return [];
    const out: { role: 'user' | 'assistant'; text: string }[] = [];
    for (const el of raw) {
      if (!el || typeof el !== 'object') continue;
      const o = el as Record<string, unknown>;
      const role = o['role'];
      const textRaw = o['text'];
      if (role !== 'user' && role !== 'assistant') continue;
      const text = String(textRaw ?? '').trim();
      if (!text) continue;
      out.push({
        role,
        text: text.length > 8000 ? `${text.slice(0, 8000)}…` : text,
      });
    }
    return out.slice(-(ChatService.PLAYGROUND_HISTORY_PAYLOAD_MAX - 1));
  }

  /** Últimos turnos (user + assistant) para enlazar baño de pintura con modelo en mensajes posteriores. */
  private buildPlaygroundUserBañoContext(
    historyTurns: { role: 'user' | 'assistant'; text: string }[],
    currentUserText: string,
  ): string {
    const window = historyTurns.slice(-PLAYGROUND_INSTANT_INTERCEPTOR_HISTORY_TURNS);
    const segments = window
      .map((h) => String(h.text ?? '').trim())
      .filter((t) => t.length > 0);
    const cur = String(currentUserText ?? '').trim();
    if (cur && segments[segments.length - 1] !== cur) {
      segments.push(cur);
    }
    return segments.join('\n\n');
  }

  private static readonly BAÑO_VEHICLE_GATE_LOOKBACK_MESSAGES = 3;

  /** Segmentos de texto limpios (cronológicos) para baño en autopilot: user + assistant. */
  private buildAutopilotBañoContextFromHistory(
    historyRows: readonly Message[],
    currentUserText: string,
  ): string {
    const segments = historyRows
      .map((m) => String(m.content ?? '').trim())
      .filter((t) => t.length > 0 && !t.includes('cloudinary'))
      .slice(-PLAYGROUND_INSTANT_INTERCEPTOR_HISTORY_TURNS);
    const cur = String(currentUserText ?? '').trim();
    if (cur && segments[segments.length - 1] !== cur) {
      segments.push(cur);
    }
    return segments.join('\n\n');
  }

  /**
   * Hilo unificado solo con mensajes del cliente (historial + lote actual sin duplicar),
   * para enlazar p. ej. "toldo negro…" en un turno y "es un Bora" en el siguiente.
   */
  private buildUnifiedBañoTierContext(
    historyRows: readonly Message[],
    mergedCurrentUserText: string,
  ): string {
    const segments: string[] = [];
    const seen = new Set<string>();

    const pushSegment = (raw: string) => {
      const t = String(raw ?? '').trim();
      if (!t || t.includes('cloudinary')) return;
      const key = normalizeTextForMatch(t);
      if (seen.has(key)) return;
      seen.add(key);
      segments.push(t);
    };

    for (const m of historyRows) {
      if (String(m.direction ?? '').toLowerCase() !== 'inbound') continue;
      pushSegment(String(m.content ?? ''));
    }

    const cur = String(mergedCurrentUserText ?? '').trim();
    if (cur) {
      const parts = cur.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
      if (parts.length > 1) {
        for (const p of parts) {
          pushSegment(p);
        }
      } else {
        pushSegment(cur);
      }
    }

    return segments
      .slice(-PLAYGROUND_INSTANT_INTERCEPTOR_HISTORY_TURNS)
      .join('\n\n');
  }

  private parseSeveridadFromInstantResolution(
    resolution: InstantQuoteResolution,
  ): string | null {
    const label = resolution.lines[0]?.label ?? '';
    const m = label.match(/\(([^)]+)\)\s*$/);
    return m?.[1]?.trim() || null;
  }

  private resolveBañoVehicleLabelFromTierContext(tierSource: string): string | null {
    const direct = inferBañoVehicleDisplayLabel(tierSource);
    if (direct && !isPlaceholderBañoVehicleLabel(direct)) {
      return direct;
    }
    const chunks = tierSource
      .split(/\n\n+/)
      .map((c) => c.trim())
      .filter(Boolean)
      .reverse();
    for (const chunk of chunks) {
      const fromChunk = inferBañoVehicleDisplayLabel(chunk);
      if (fromChunk && !isPlaceholderBañoVehicleLabel(fromChunk)) {
        return fromChunk;
      }
      const purified = purifyVehicleModelUserReply(chunk);
      if (
        purified &&
        userLatestMessageLooksLikeVehicleModelReply(purified) &&
        !isPlaceholderBañoVehicleLabel(purified)
      ) {
        return purified
          .split(/\s+/)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(' ');
      }
    }
    return null;
  }

  /** En los últimos N mensajes del hilo, el asistente ya preguntó por el auto (gate de baño). */
  private assistantAskedBañoVehicleInLastMessages(
    historyRows: readonly Message[],
    lookback = ChatService.BAÑO_VEHICLE_GATE_LOOKBACK_MESSAGES,
  ): boolean {
    const window = historyRows
      .filter((m) => {
        const t = String(m.content ?? '').trim();
        return t.length > 0 && !t.includes('cloudinary');
      })
      .slice(-lookback);
    for (const m of window) {
      if (String(m.direction ?? '').toLowerCase() === 'inbound') continue;
      if (assistantMessageIsBañoVehiclePrompt(String(m.content ?? ''))) {
        return true;
      }
    }
    return false;
  }

  /**
   * El asistente preguntó el auto en turnos recientes y el cliente responde con modelo:
   * no volver a ejecutar tryBañoPinturaVehicleGateReply.
   */
  private shouldSkipBañoVehicleGateAfterModelReply(
    historyRows: readonly Message[],
    latestUserText: string,
    fullBañoCtx: string,
  ): boolean {
    const latest = String(latestUserText ?? '').trim();
    if (!latest || !isBañoVehicleProfiledForQuote(normalizeTextForMatch(fullBañoCtx), latest)) {
      return false;
    }
    const ctxNorm = normalizeTextForMatch(fullBañoCtx);
    if (!mentionsBañoDePinturaIntent(ctxNorm)) return false;
    return this.assistantAskedBañoVehicleInLastMessages(
      historyRows,
      ChatService.BAÑO_VEHICLE_GATE_LOOKBACK_MESSAGES,
    );
  }

  /**
   * URLs únicas de imágenes entrantes (**inbound**) en esta conversación cuya `createdAt`
   * cae dentro de los últimos 5 minutos, en orden cronológico (más antigua primero).
   */
  async getRecentImages(conversationId: string): Promise<string[]> {
    const since = new Date(Date.now() - ChatService.RECENT_IMAGE_LOOKBACK_MS);
    const messages = await this.messageRepository
      .createQueryBuilder('m')
      .where('m.conversationId = :cid', { cid: conversationId })
      .andWhere('m.createdAt >= :since', { since })
      .orderBy('m.createdAt', 'ASC')
      .select(['m.content', 'm.direction'])
      .getMany();

    const ordered: string[] = [];
    const seen = new Set<string>();

    for (const msg of messages) {
      if (String(msg.direction || '').toLowerCase() !== 'inbound') {
        continue;
      }
      const content =
        typeof msg.content === 'string' ? msg.content.trim() : '';
      if (!content || !isIncomingImage(content)) {
        continue;
      }
      if (seen.has(content)) {
        continue;
      }
      seen.add(content);
      ordered.push(content);
    }

    return ordered;
  }

  /**
   * Persiste líneas relacionales alineadas con `draftQuote.quotePayload.lines` y el inventario/análisis.
   */
  private async buildDraftQuoteLineRowsForPersist(
    analysis: VehicleDamageAnalysis,
    doc: DraftQuote,
    fallbackUrls: string[],
  ): Promise<Omit<DraftQuoteItem, 'id' | 'draftQuote' | 'draftQuoteId'>[]> {
    const snap = await this.catalogService.getMatrixPricingSnapshot();
    const lines = doc.lines ?? [];
    if (!lines.length) return [];

    const inv = analysis.inventory ?? [];

    if (inv.length > 0 && inv.length === lines.length) {
      return lines.map((line, idx) => {
        const row = inv[idx];
        const canonical =
          snap.matchServicio(row.pieza.trim()) ??
          row.pieza.trim();
        return {
          sortOrder: idx,
          pieza: canonical,
          severidad: coerceDamageLevelCode(row.severidad),
          precioMx: Math.round(
            Number(line.subtotal ?? line.unitPrice ?? 0),
          ),
          descripcionTecnica: row.descripcionTecnica ?? null,
          urlsOrigen:
            Array.isArray(row.urls_origen) && row.urls_origen.length > 0
              ? [...row.urls_origen]
              : null,
        };
      });
    }

    if (inv.length > 0 && lines.length === 1) {
      const line0only = lines[0];
      return [
        {
          sortOrder: 0,
          pieza: analysis.pieza || 'Estetica Exterior',
          severidad: coerceDamageLevelCode(
            analysis.severidad || analysis.severidadDelDano,
          ),
          precioMx: Math.round(
            Number(line0only.subtotal ?? line0only.unitPrice ?? 0),
          ),
          descripcionTecnica: analysis.descripcionTecnica ?? null,
          urlsOrigen: fallbackUrls.length > 0 ? [...fallbackUrls] : null,
        },
      ];
    }

    if (inv.length > 0) {
      const grouped = snap.matrixInventoryMaxLines(
        inv.map((it) => ({
          servicio: it.pieza,
          severidad: it.severidad,
        })),
      );
      const out: Omit<DraftQuoteItem, 'id' | 'draftQuote' | 'draftQuoteId'>[] = [];
      for (let idx = 0; idx < grouped.length; idx++) {
        const g = grouped[idx];
        const line = lines[idx];
        const related = inv.filter(
          (it) => snap.matchServicio(it.pieza) === g.canonical,
        );
        const descParts = [...new Set(related.map((r) => r.descripcionTecnica))]
          .filter(Boolean)
          .join(' | ');
        const urlsSet = [...new Set(related.flatMap((r) => r.urls_origen ?? []))];
        const price = Math.round(
          Number(line?.subtotal ?? line?.unitPrice ?? g.unitPrice ?? 0),
        );
        out.push({
          sortOrder: idx,
          pieza: g.canonical,
          severidad: g.damageLevel,
          precioMx: price,
          descripcionTecnica: descParts ? descParts.slice(0, 16000) : null,
          urlsOrigen: urlsSet.length > 0 ? urlsSet : null,
        });
      }
      return out;
    }

    const line0 = lines[0];
    return [
      {
        sortOrder: 0,
        pieza: analysis.pieza || 'Estetica Exterior',
        severidad: coerceDamageLevelCode(
          analysis.severidad || analysis.severidadDelDano,
        ),
        precioMx: Math.round(
          Number(
            line0.subtotal ?? line0.unitPrice ?? doc.total ?? doc.subtotal ?? 0,
          ),
        ),
        descripcionTecnica: analysis.descripcionTecnica ?? null,
        urlsOrigen: fallbackUrls.length > 0 ? [...fallbackUrls] : null,
      },
    ];
  }

  private async syncDraftQuoteLineItems(
    draftQuoteId: string,
    analysis: VehicleDamageAnalysis,
    doc: DraftQuote,
    fallbackUrls: string[],
  ): Promise<void> {
    await this.draftQuoteItemRepository.delete({ draftQuoteId });
    const rows = await this.buildDraftQuoteLineRowsForPersist(
      analysis,
      doc,
      fallbackUrls,
    );
    if (!rows.length) return;
    await this.draftQuoteItemRepository.insert(
      rows.map((r) => ({ ...r, draftQuoteId })),
    );
  }

  private async loadDraftQuoteWithItemsOrThrow(id: string): Promise<DraftQuoteEntity> {
    const row = await this.draftQuoteRepository.findOne({
      where: { id },
      relations: { items: true },
    });
    if (!row) {
      throw new NotFoundException(`DraftQuote no encontrada: ${id}`);
    }
    row.items?.sort((a, b) => a.sortOrder - b.sortOrder);
    return row;
  }

  /**
   * 🌟 SUBIDA DE IMÁGENES A CLOUDINARY
   * Configura y envía el buffer del archivo a la nube.
   */
  async uploadImage(file: Express.Multer.File): Promise<string> {
    // 1. Forzamos la configuración con los valores de las variables de entorno
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    // Logs de depuración para Railway (puedes borrarlos cuando funcione)
    console.log('--- Cloudinary Config Check ---');
    console.log('Cloud Name:', process.env.CLOUDINARY_CLOUD_NAME ? 'OK' : 'MISSING');
    console.log('API Key:', process.env.CLOUDINARY_API_KEY ? 'OK' : 'MISSING');

    return new Promise((resolve, reject) => {
      // 2. Creamos el stream de subida
      const uploadStream = cloudinary.uploader.upload_stream(
        { 
          resource_type: 'image', 
          folder: 'omnichannel_chats' 
        },
        (error, result) => {
          if (error) {
            console.error('Error detallado de Cloudinary:', error);
            return reject(error);
          }
          // Validación para evitar error TS18048 (result is possibly undefined)
          if (!result) {
            return reject(new Error("Cloudinary no retornó un resultado válido"));
          }
          
          console.log('Subida exitosa:', result.secure_url);
          resolve(result.secure_url);
        }
      );

      // 3. Enviamos el buffer del archivo al stream
      uploadStream.end(file.buffer);
    });
  }

  /**
   * Sube un buffer de imagen a Cloudinary (misma carpeta que adjuntos del chat).
   */
  private async uploadImageBuffer(buffer: Buffer): Promise<string> {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { resource_type: 'image', folder: 'omnichannel_chats' },
        (error, result) => {
          if (error) return reject(error);
          if (!result?.secure_url) {
            return reject(new Error('Cloudinary no devolvió secure_url'));
          }
          resolve(result.secure_url);
        },
      );
      uploadStream.end(buffer);
    });
  }

  /**
   * Garantiza URL en Cloudinary: si ya es Cloudinary la devuelve;
   * si es data URL sube el buffer; si es URL remota la importa a Cloudinary.
   */
  private async ensureImageOnCloudinary(raw: string): Promise<string> {
    if (!raw.trim()) return raw;
    if (raw.includes('res.cloudinary.com') || raw.includes('cloudinary.com')) {
      return raw;
    }

    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    if (/^data:image\//i.test(raw)) {
      const m = raw.match(/^data:(image\/[\w+.-]+);base64,([\s\S]+)$/i);
      if (!m) throw new Error('data URL de imagen inválida');
      const buffer = Buffer.from(m[2], 'base64');
      return this.uploadImageBuffer(buffer);
    }

    return new Promise((resolve, reject) => {
      cloudinary.uploader.upload(
        raw,
        { folder: 'omnichannel_chats', resource_type: 'image' },
        (error, result) => {
          if (error) return reject(error);
          if (!result?.secure_url) {
            return reject(new Error('Cloudinary upload remoto sin secure_url'));
          }
          resolve(result.secure_url);
        },
      );
    });
  }

  /**
   * Suma de matriz por piezas del inventario (o una sola pieza si no hay inventario).
   */
  private async computePrimaryMatrixEstimate(
    analysis: VehicleDamageAnalysis,
  ): Promise<number> {
    const snap = await this.catalogService.getMatrixPricingSnapshot();
    if (analysis.inventory?.length) {
      const sum = snap.inventoryMaxTotal(
        analysis.inventory.map((i) => ({
          servicio: i.pieza,
          severidad: i.severidad,
        })),
      );
      if (sum > 0) return sum;
    }
    const level = coerceDamageLevelCode(analysis.severidad);
    const piezaMatriz =
      snap.matchServicio(analysis.pieza) ??
      snap.matchServicio(analysis.partesAfectadas?.[0] ?? '') ??
      analysis.pieza;
    return snap.getAmount(piezaMatriz, level);
  }

  /**
   * Envía texto al usuario por Send API de Messenger (Graph).
   * Documentación: recipient PSID + mensaje de texto plano.
   */
  private async sendFacebookMessengerText(
    recipientPsid: string,
    messageText: string,
  ): Promise<void> {
    const token = process.env.FB_PAGE_ACCESS_TOKEN?.trim();
    if (!token) {
      console.warn(
        'sendFacebookMessengerText: falta FB_PAGE_ACCESS_TOKEN en entorno',
      );
      return;
    }
    const text = String(messageText ?? '').trim();
    if (!text) return;

    const url = 'https://graph.facebook.com/v21.0/me/messages';
    await axios.post(
      url,
      {
        recipient: { id: recipientPsid },
        message: { text: text.slice(0, 2000) },
      },
      {
        params: { access_token: token },
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  /**
   * Perfil público del PSID vía Graph (nombre y foto). Requiere `FB_PAGE_ACCESS_TOKEN`.
   */
  async getFacebookProfile(psid: string): Promise<{
    first_name?: string;
    last_name?: string;
    profile_pic?: string;
  } | null> {
    const token = process.env.FB_PAGE_ACCESS_TOKEN?.trim();
    const id = String(psid ?? '').trim();
    if (!token || !id) return null;
    try {
      const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(id)}`;
      const { data } = await axios.get<{
        first_name?: string;
        last_name?: string;
        profile_pic?: string;
      }>(url, {
        params: {
          fields: 'first_name,last_name,profile_pic',
          access_token: token,
        },
      });
      return data && typeof data === 'object' ? data : null;
    } catch (err) {
      console.warn(
        '[getFacebookProfile] no se pudo obtener perfil para PSID',
        id,
        err,
      );
      return null;
    }
  }

  /**
   * POST `/webhook`: payload del panel (legacy) o webhook Meta (`object: page`).
   */
  async ingestWebhookPayload(body: any): Promise<{
    processed: number;
    lastMessageId?: string;
  }> {
    if (isMetaPageWebhook(body)) {
      return this.processMetaMessengerWebhook(body);
    }
    if (body && typeof body === 'object' && Array.isArray((body as any).entry)) {
      console.warn(
        '[webhook] payload con `entry` pero no clasificado como Meta page; object=',
        (body as any).object,
        '— se intentará como legacy (puede fallar si es otro producto Meta).',
      );
    }
    const saved = await this.saveMessage(body ?? {});
    return { processed: 1, lastMessageId: saved.id };
  }

  /** Evita duplicados cuando Meta reenvía el mismo `mid`. */
  private async findMessageByMetaMid(
    metaMid: string,
  ): Promise<Message | null> {
    const mid = String(metaMid ?? '').trim();
    if (!mid) return null;
    return this.messageRepository.findOne({ where: { externalId: mid } });
  }

  /**
   * Eco Meta / reenvío del panel: el taller ya guardó un outbound con el mismo texto
   * hace pocos segundos → no insertar fila duplicada al recargar el historial.
   */
  private async findRecentDuplicateOutboundMessage(
    conversationId: string,
    content: string,
    windowMs = 5000,
  ): Promise<Message | null> {
    const convId = String(conversationId ?? '').trim();
    const trimmed = String(content ?? '').trim();
    if (!convId || !trimmed) return null;
    const since = new Date(Date.now() - windowMs);
    return this.messageRepository
      .createQueryBuilder('m')
      .where('m.conversationId = :conversationId', { conversationId: convId })
      .andWhere('m.direction = :direction', { direction: 'outbound' })
      .andWhere('m.content = :content', { content: trimmed })
      .andWhere('m.createdAt >= :since', { since })
      .orderBy('m.createdAt', 'DESC')
      .getOne();
  }

  /**
   * Normaliza eventos `entry[].messaging[]` de Meta Messenger y delega en {@link saveMessage}.
   */
  private async processMetaMessengerWebhook(body: any): Promise<{
    processed: number;
    lastMessageId?: string;
  }> {
    let n = 0;
    let lastMessageId: string | undefined;
    const entries = Array.isArray(body.entry) ? body.entry : [];
    const envPage = process.env.FB_PAGE_ID?.trim();

    for (const entry of entries) {
      const pageId = entry?.id != null ? String(entry.id) : '';
      const messaging = Array.isArray(entry?.messaging)
        ? entry.messaging
        : [];

      for (const evt of messaging) {
        const msg = evt.message;
        if (!msg || typeof msg !== 'object') continue;

        const isEcho = msg.is_echo === true;
        const metaMid =
          typeof msg.mid === 'string' ? String(msg.mid).trim() : '';

        /** PSID del cliente: en eco el remitente es la página → usar `recipient.id`. */
        let threadPsid = '';
        if (isEcho) {
          threadPsid =
            evt?.recipient?.id != null ? String(evt.recipient.id) : '';
        } else {
          threadPsid =
            evt?.sender?.id != null ? String(evt.sender.id) : '';
          if (!threadPsid) continue;
          if (threadPsid === pageId || (envPage && threadPsid === envPage)) {
            continue;
          }
        }

        if (!threadPsid) continue;

        const text =
          typeof msg.text === 'string' ? msg.text.trim() : '';
        const attachments = Array.isArray(msg.attachments)
          ? msg.attachments
          : [];
        const imageUrls: string[] = [];
        for (const a of attachments) {
          if (
            a &&
            typeof a === 'object' &&
            String((a as { type?: string }).type).toLowerCase() ===
              'image' &&
            (a as { payload?: { url?: string } }).payload?.url
          ) {
            imageUrls.push(
              String((a as { payload: { url: string } }).payload.url),
            );
          }
        }

        const contactHint = isEcho
          ? ''
          : pickFirstNonEmptyTrimmedString(
              (evt.sender as { name?: string })?.name,
              `Messenger ${threadPsid.slice(0, 8)}`,
            );

        const basePayload: Record<string, unknown> = {
          externalId: threadPsid,
          platform: 'facebook',
          direction: isEcho ? 'outbound' : 'inbound',
          skipOutboundFacebookSend: isEcho,
          suppressRealtimeNotify: isEcho,
          suppressAutopilotAndSuggestions: isEcho,
          ...(isEcho
            ? { user: 'Asistente IA' }
            : contactHint
              ? { contactName: contactHint }
              : {}),
        };

        if (!text && imageUrls.length === 0) continue;

        if (text) {
          let skipText = false;
          if (metaMid) {
            const dup = await this.findMessageByMetaMid(metaMid);
            if (dup) {
              console.log(
                `[Meta webhook] mid duplicado (texto), omitido:`,
                metaMid,
              );
              skipText = true;
            }
          }
          if (!skipText && isEcho) {
            const echoConv = await this.conversationRepository.findOne({
              where: { externalId: threadPsid },
            });
            if (echoConv) {
              const panelDup =
                await this.findRecentDuplicateOutboundMessage(
                  echoConv.id,
                  text,
                );
              if (panelDup) {
                console.log(
                  '[Meta webhook] eco outbound ya guardado por el panel (ventana 5s), omitido | PSID:',
                  threadPsid,
                );
                skipText = true;
              }
            }
          }
          if (!skipText) {
            const saved = await this.saveMessage({
              ...basePayload,
              message: text,
              ...(metaMid ? { metaMessageId: metaMid } : {}),
            });
            console.log(
              `[Meta webhook] texto ${isEcho ? '(eco→outbound)' : '(inbound)'} | PSID hilo:`,
              threadPsid,
              '| mid:',
              metaMid || '(sin mid)',
              '| message.externalId:',
              saved.externalId,
            );
            lastMessageId = saved.id;
            n++;
          }
        }
        for (let imgIdx = 0; imgIdx < imageUrls.length; imgIdx += 1) {
          const url = imageUrls[imgIdx]!;
          const imageMid = metaMid
            ? imageUrls.length > 1 || text
              ? `${metaMid}:img:${imgIdx}`
              : metaMid
            : '';
          if (imageMid) {
            const dupImg = await this.findMessageByMetaMid(imageMid);
            if (dupImg) {
              console.log(
                `[Meta webhook] mid duplicado (imagen), omitido:`,
                imageMid,
              );
              continue;
            }
          }
          if (isEcho) {
            const echoConv = await this.conversationRepository.findOne({
              where: { externalId: threadPsid },
            });
            if (echoConv) {
              const panelImgDup =
                await this.findRecentDuplicateOutboundMessage(
                  echoConv.id,
                  url,
                );
              if (panelImgDup) {
                console.log(
                  '[Meta webhook] eco imagen outbound ya en panel (ventana 5s), omitido | PSID:',
                  threadPsid,
                );
                continue;
              }
            }
          }
          const saved = await this.saveMessage({
            ...basePayload,
            message: url,
            ...(imageMid ? { metaMessageId: imageMid } : {}),
          });
          console.log(
            `[Meta webhook] imagen ${isEcho ? '(eco→outbound)' : '(inbound)'} | PSID hilo:`,
            threadPsid,
            '| mid:',
            imageMid || '(sin mid)',
            '| message.externalId:',
            saved.externalId,
          );
          lastMessageId = saved.id;
          n++;
        }
      }
    }

    return { processed: n, lastMessageId };
  }

  /**
   * GUARDAR MENSAJE Y ACTUALIZAR CONVERSACIÓN.
   * - Sin `direction` o distinto de `outbound` → **`inbound`** (mensajes del cliente / webhook canal).
   * - **`outbound`** → respuestas del agente (panel / cotización / dashboard); sin análisis de imagen entrante ni sugerencias IA sobre ese mismo mensaje.
   *
   * **Resolución de conversación (sin fallback `123`):**
   * 1. Si `conversationId` es un UUID válido → carga esa fila (uso típico del panel con `direction: outbound`).
   * 2. Si no → busca por `externalId` exacto usando el primer valor no vacío entre:
   *    `externalId`, `id`, `from`, `sender_id`, `senderId`.
   * 3. Si no existe → crea conversación nueva con ese `externalId` y `contactName` (o `user`, `username`, `name`).
   */
  async saveMessage(data: any) {
    const resolvedDirection =
      String(data.direction ?? '').toLowerCase().trim() === 'outbound'
        ? 'outbound'
        : 'inbound';

    let conversation: Conversation | null = null;

    const rawConversationId = pickFirstNonEmptyTrimmedString(
      data.conversationId,
    );
    if (rawConversationId && looksLikeConversationUuid(rawConversationId)) {
      conversation = await this.conversationRepository.findOne({
        where: { id: rawConversationId },
      });
      if (!conversation) {
        throw new BadRequestException(
          `No existe conversación con id (UUID): ${rawConversationId}`,
        );
      }
    }

    let threadExternalId = '';
    if (!conversation) {
      threadExternalId = pickFirstNonEmptyTrimmedString(
        data.externalId,
        data.id,
        data.from,
        data.sender_id,
        data.senderId,
      );
      if (!threadExternalId) {
        throw new BadRequestException(
          'No se pudo determinar la conversación: envía `conversationId` (UUID interno) desde el panel, o bien `externalId` / `id` / `from` con el ID estable del contacto en el canal. No existe conversación por defecto ni fallback.',
        );
      }

      conversation = await this.conversationRepository.findOne({
        where: { externalId: threadExternalId },
      });

      const contactName = pickFirstNonEmptyTrimmedString(
        data.contactName,
        data.user,
        data.username,
        data.name,
      );

      if (!conversation) {
        let displayName = contactName;
        let avatarUrl: string | null = null;
        if (
          shouldPersistPlatformOnConversation(data.platform) &&
          isFacebookMessengerPlatform(data.platform)
        ) {
          const prof = await this.getFacebookProfile(threadExternalId);
          if (prof) {
            const full = [prof.first_name, prof.last_name]
              .filter((x) => typeof x === 'string' && x.trim())
              .map((x) => String(x).trim())
              .join(' ')
              .trim();
            if (full) displayName = full;
            if (prof.profile_pic) avatarUrl = prof.profile_pic;
          }
        }
        conversation = this.conversationRepository.create({
          externalId: threadExternalId,
          contactName: displayName || 'Cliente Desconocido',
          avatarUrl,
          platform: shouldPersistPlatformOnConversation(data.platform)
            ? String(data.platform).trim()
            : null,
          status: 'nuevo',
          isAutoPilotActive: true,
        });
        conversation = await this.conversationRepository.save(conversation);
      } else {
        if (contactName && conversation.contactName !== contactName) {
          conversation.contactName = contactName;
        }
        if (shouldPersistPlatformOnConversation(data.platform)) {
          conversation.platform = String(data.platform).trim();
        }
        await this.conversationRepository.save(conversation);
      }
    } else if (shouldPersistPlatformOnConversation(data.platform)) {
      conversation.platform = String(data.platform).trim();
      await this.conversationRepository.save(conversation);
    }

    let contentToSave = data.message || 'Sin contenido';
    const incomingIsImage = isIncomingImage(contentToSave);
    if (incomingIsImage) {
      try {
        contentToSave = await this.ensureImageOnCloudinary(contentToSave);
      } catch (err) {
        console.error('ensureImageOnCloudinary (recepción):', err);
      }
    }

    if (resolvedDirection === 'outbound') {
      const dupOutbound = await this.findRecentDuplicateOutboundMessage(
        conversation.id,
        contentToSave,
      );
      if (dupOutbound) {
        console.log(
          `[saveMessage] outbound duplicado omitido (ventana 5s, p. ej. eco Meta) | conv=${conversation.id}`,
        );
        return dupOutbound;
      }
    }

    conversation.lastMessageAt = new Date();
    conversation.lastMessage = incomingIsImage
      ? '📷 Imagen'
      : contentToSave || 'Sin contenido';

    if (
      resolvedDirection === 'outbound' &&
      String(data.conversationLeadStatus ?? '').trim() === 'cotizado'
    ) {
      const activeApt = await this.loadActiveAppointmentForConversation(
        conversation.id,
      );
      if (activeApt) {
        conversation.status = 'agendado';
      } else {
        conversation.status = 'cotizado';
      }
    }

    await this.conversationRepository.save(conversation);

    const senderName = pickFirstNonEmptyTrimmedString(
      data.user,
      data.contactName,
      data.username,
      data.name,
    );

    const messageRowExternalId =
      pickFirstNonEmptyTrimmedString(
        data.metaMessageId,
        data.messageId,
        data.mid,
      ) ||
      pickFirstNonEmptyTrimmedString(
        data.externalId,
        data.id,
        data.from,
        threadExternalId,
        conversation.externalId,
      );

    const suppressRealtimeNotify = data.suppressRealtimeNotify === true;
    const suppressAutopilotAndSuggestions =
      data.suppressAutopilotAndSuggestions === true;

    const newMessage = this.messageRepository.create({
      content: contentToSave,
      channelType: data.platform || 'test',
      senderName: senderName || 'Cliente Desconocido',
      direction: resolvedDirection,
      externalId: messageRowExternalId || conversation.externalId,
      conversation: conversation,
    });
    
    const saved = await this.messageRepository.save(newMessage);

    const conversationIdForSockets =
      saved.conversationId ?? conversation.id;

    if (
      !suppressAutopilotAndSuggestions &&
      saved.direction === 'inbound' &&
      !isIncomingImage(saved.content)
    ) {
      const convRow = await this.conversationRepository.findOne({
        where: { id: conversationIdForSockets },
      });
      if (convRow?.isAutoPilotActive) {
        if (shouldDebounceAutopilotInboundText(convRow.platform)) {
          this.scheduleDebouncedAutopilotTextReply(conversationIdForSockets);
        } else {
          void this.autoPilotSendTextReply(saved, convRow).catch((err) =>
            console.error('autoPilotSendTextReply:', err),
          );
        }
      } else {
        this.generateAiSuggestion(saved);
      }
    }

    if (
      !suppressAutopilotAndSuggestions &&
      saved.direction === 'inbound' &&
      incomingIsImage &&
      isIncomingImage(saved.content)
    ) {
      this.scheduleConsolidatedInboundImageAnalysis(
        conversationIdForSockets,
        saved.id,
        String(saved.content).trim(),
      );
    }

    if (!suppressRealtimeNotify) {
      this.chatGateway.emitNewMessage(saved);
    }

    if (
      resolvedDirection === 'outbound' &&
      isFacebookMessengerPlatform(conversation.platform) &&
      !isIncomingImage(contentToSave) &&
      !data.skipOutboundFacebookSend
    ) {
      void this.sendFacebookMessengerText(
        conversation.externalId,
        String(contentToSave),
      ).catch((err) =>
        console.error('sendFacebookMessengerText (outbound panel):', err),
      );
    }

    return saved;
  }

  /**
   * Visión multimodal (GPT-5.5) sobre **todas las URLs dadas**: un solo reporte consolidado en `items`.
   *
   * @param imageUrls Lote ordenado típicamente de la ráfaga acumulada en memoria o de {@link getRecentImages} (+ deduplicadas).
   * @param options `systemPrompt` / `userSchemaHint` sustituyen la config guardada; `allowEmptyInventory` evita error si no hay daños.
   */
  async analyzeDamageImage(
    imageUrls: readonly string[],
    options?: {
      systemPrompt?: string;
      userSchemaHint?: string;
      allowEmptyInventory?: boolean;
      /** Texto del cliente (p. ej. pieza/vehículo) — se inyecta en el turno de usuario de visión. */
      clientContextText?: string;
    },
  ): Promise<DetectedDamageItem[]> {
    const urls = [
      ...new Set(imageUrls.map((u) => String(u).trim()).filter(Boolean)),
    ];
    if (!urls.length) {
      throw new Error('Se requiere al menos una URL de imagen');
    }

    const systemPrompt =
      options?.systemPrompt != null && String(options.systemPrompt).trim() !== ''
        ? String(options.systemPrompt).trim()
        : await this.aiConfigService.getValue(
            AI_CONFIG_KEYS.DEFAULT_VISION_PROMPT,
          );

    const userSchemaHint =
      options?.userSchemaHint != null && String(options.userSchemaHint).trim() !== ''
        ? String(options.userSchemaHint).trim()
        : await this.aiConfigService.getValue(
            AI_CONFIG_KEYS.VISION_JSON_USER_INSTRUCTION,
          );

    const intro = urls
      .map((_, i) => `Imagen ${i + 1}: posición ${i + 1} en el bloque de imágenes`)
      .join('; ');

    const clientCtxRaw =
      options?.clientContextText != null ? String(options.clientContextText).trim() : '';
    const clientCtxBlock =
      clientCtxRaw.length > 0
        ? `\n\n[Contexto textual del cliente — úsalo para acotar pieza, vehículo y daño esperado]\n${clientCtxRaw.slice(0, 4000)}`
        : '';

    const urlLinesForText = urls
      .map((u, i) => {
        const s = String(u);
        if (/^data:image\//i.test(s)) {
          return `${i + 1}. Imagen ${i + 1}: usa la misma data URL en urls_origen que la del bloque image_url en esa posición (longitud ${s.length} caracteres).`;
        }
        return `${i + 1}. ${s}`;
      })
      .join('\n');

    const userTextBlock = [
      userSchemaHint,
      clientCtxBlock,
      intro,
      'Las imágenes van en bloques image_url a continuación (formato OpenAI).',
      'Referencias de entrada (orden = posición de cada image_url):',
      urlLinesForText,
    ]
      .filter((p) => String(p).trim().length > 0)
      .join('\n\n')
      .trim();

    const userContent = [
      { type: 'text' as const, text: userTextBlock },
      ...urls.map((url) => ({
        type: 'image_url' as const,
        image_url: { url, detail: 'high' as const },
      })),
    ];

    const completion = await this.openai.chat.completions.create({
      model: VISION_DAMAGE_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: userContent,
        },
      ],
      max_completion_tokens: 3000,
    });

    const visionResponse = completion.choices[0]?.message?.content?.trim() ?? '';
    console.log('Respuesta cruda de Vision:', visionResponse);

    if (!visionResponse) {
      if (options?.allowEmptyInventory) {
        return [];
      }
      throw new Error('OpenAI no devolvió contenido para el análisis de daños');
    }
    const parsed = parseVisionModelJsonResponse(visionResponse, 'analyzeDamageImage');
    if (options?.allowEmptyInventory) {
      return parseDetectedDamageItemsAllowEmpty(parsed);
    }
    return normalizeDetectedDamagesJson(parsed);
  }

  /** Parte URLs en lotes de hasta {@link ChatService.VISION_IMAGE_CHUNK_SIZE}. */
  private chunkImageUrlsForVision(
    urls: readonly string[],
    chunkSize = ChatService.VISION_IMAGE_CHUNK_SIZE,
  ): string[][] {
    const clean = [
      ...new Set(urls.map((u) => String(u).trim()).filter(Boolean)),
    ];
    const size = Math.max(1, chunkSize);
    const lotes: string[][] = [];
    for (let i = 0; i < clean.length; i += size) {
      lotes.push(clean.slice(i, i + size));
    }
    return lotes;
  }

  /**
   * Analiza ráfagas grandes en lotes secuenciales (sin paralelismo) y fusiona inventario.
   */
  private async analyzeDamageImageInSequentialChunks(
    imageUrls: readonly string[],
    options?: {
      systemPrompt?: string;
      userSchemaHint?: string;
      allowEmptyInventory?: boolean;
      clientContextText?: string;
    },
  ): Promise<DetectedDamageItem[]> {
    const lotes = this.chunkImageUrlsForVision(imageUrls);
    if (!lotes.length) {
      return [];
    }

    if (lotes.length === 1 && lotes[0]!.length === imageUrls.length) {
      return this.analyzeDamageImage(lotes[0]!, options);
    }

    const snap = await this.catalogService.getMatrixPricingSnapshot();
    let allDetectedDamages: DetectedDamageItem[] = [];

    console.log(
      `[VisionChunk] Procesando ${imageUrls.length} imagen(es) en ${lotes.length} lote(s) de hasta ${ChatService.VISION_IMAGE_CHUNK_SIZE}`,
    );

    for (let idx = 0; idx < lotes.length; idx++) {
      const lote = lotes[idx]!;
      console.log(
        `[VisionChunk] Lote ${idx + 1}/${lotes.length} — ${lote.length} imagen(es)`,
      );
      const batchItems = await this.analyzeDamageImage(lote, {
        ...options,
        allowEmptyInventory: true,
      });

      if (!batchItems.length) {
        continue;
      }

      if (!allDetectedDamages.length) {
        allDetectedDamages = batchItems.map((it) => ({
          pieza: it.pieza,
          severidad: it.severidad,
          descripcionTecnica: it.descripcionTecnica,
          urls_origen: [...(it.urls_origen ?? [])],
        }));
      } else {
        const merged = mergeDamageInventoryAccumulative(
          allDetectedDamages,
          batchItems,
          (raw) => snap.matchServicio(raw),
        );
        allDetectedDamages = merged.merged;
      }
    }

    if (!allDetectedDamages.length && options?.allowEmptyInventory !== false) {
      return [];
    }
    if (!allDetectedDamages.length) {
      throw new Error(
        'OpenAI no devolvió daños detectados en ningún lote de imágenes',
      );
    }

    return allDetectedDamages;
  }

  private sanitizeVisionItemsForPlaygroundPrompt(
    items: DetectedDamageItem[],
  ): Array<{
    pieza: string;
    severidad: string;
    descripcionTecnica: string;
    urls_origen: string[];
  }> {
    return items.map((it) => ({
      pieza: it.pieza,
      severidad: it.severidad,
      descripcionTecnica: it.descripcionTecnica,
      urls_origen: (it.urls_origen ?? []).map((u) => {
        const s = String(u);
        return s.length > 200 ? `[url omitida, ${s.length} caracteres]` : s;
      }),
    }));
  }

  /** Inyecta el JSON de visión en el system del chat para que el modelo no ignore el peritaje. */
  private buildPlaygroundVisionSystemAppend(items: DetectedDamageItem[]): string {
    const sanitized = this.sanitizeVisionItemsForPlaygroundPrompt(items);
    const json = JSON.stringify({ items: sanitized }, null, 2);
    const header =
      `[Playground — resultado del servicio de visión]\n` +
      `Las imágenes del lote ya fueron analizadas con el motor de visión del taller. El JSON siguiente es el peritaje codificado ("items").\n` +
      `OBLIGATORIO:\n` +
      `- Usa estos datos como fuente de verdad sobre daños cuando el mensaje incluye imagen o el cliente pregunta por ellos.\n` +
      `- No pidas otra fotografía, imagen ni archivo adjunto.\n` +
      `- No digas que no puedes ver imágenes ni que no tienes acceso al archivo.\n` +
      `- Si "items" está vacío, indica con prudencia que el análisis visual no devolvió piezas con severidad codificada.\n\n` +
      `JSON del peritaje:\n`;
    let block = `${header}${json}`;
    const max = 14000;
    if (block.length > max) {
      block = `${block.slice(0, max)}\n…[truncado por tamaño]`;
    }
    return `\n\n${block}`;
  }

  private normalizePlaygroundResumeVisionItems(raw: unknown): DetectedDamageItem[] {
    if (raw == null) return [];
    if (Array.isArray(raw)) {
      return parseDetectedDamageItemsAllowEmpty({ items: raw });
    }
    if (typeof raw === 'object') {
      const o = raw as { items?: unknown };
      if (Array.isArray(o.items)) {
        return parseDetectedDamageItemsAllowEmpty({ items: o.items });
      }
    }
    return parseDetectedDamageItemsAllowEmpty(raw);
  }

  /** Cita más reciente de la conversación (para reanudación tras borrador con lead agendado). */
  private async loadLatestAppointmentForConversation(
    conversationId: string,
  ): Promise<AppointmentEntity | null> {
    const rows = await this.appointmentRepository.find({
      where: { conversationId },
      order: { scheduledAt: 'DESC' },
      take: 1,
    });
    return rows[0] ?? null;
  }

  /** Cita activa (pendiente o confirmada) para narrativa de borrador con lead agendado. */
  private async loadActiveAppointmentForConversation(
    conversationId: string,
  ): Promise<AppointmentEntity | null> {
    const rows = await this.appointmentRepository.find({
      where: {
        conversationId,
        status: In(['confirmada', 'pendiente'] satisfies AppointmentStatus[]),
      },
      order: { scheduledAt: 'DESC' },
      take: 1,
    });
    return rows[0] ?? null;
  }

  /** Inventario previo del borrador PENDING_APPROVAL (para acumular golpes). */
  private extractPriorInventoryFromDraft(
    existingDraft: DraftQuoteEntity,
  ): DetectedDamageItem[] {
    const fromAnalysis = existingDraft.damageAnalysis?.inventory;
    if (Array.isArray(fromAnalysis) && fromAnalysis.length > 0) {
      return fromAnalysis.map((it) => ({
        pieza: it.pieza,
        severidad: it.severidad,
        descripcionTecnica: it.descripcionTecnica,
        urls_origen: [...(it.urls_origen ?? [])],
      }));
    }
    const fromBasis = existingDraft.quotePayload?.analysisBasis?.inventory;
    if (Array.isArray(fromBasis) && fromBasis.length > 0) {
      return fromBasis.map((it) => ({
        pieza: it.pieza,
        severidad: it.severidad,
        descripcionTecnica: it.descripcionTecnica,
        urls_origen: [...(it.urls_origen ?? [])],
      }));
    }
    const lines = existingDraft.quotePayload?.lines ?? [];
    if (lines.length > 0) {
      return lines.map((line) => ({
        pieza: piezaLabelFromDraftLineDescription(line.description),
        severidad: 'DL',
        descripcionTecnica: line.description,
        urls_origen: [],
      }));
    }
    return [];
  }

  /** Tras nuevo borrador: `por_cotizar` salvo lead con cita activa (permanece `agendado`). */
  private async markConversationDraftPendingReview(
    conversationId: string,
  ): Promise<void> {
    const conv = await this.conversationRepository.findOne({
      where: { id: conversationId },
    });
    const activeApt =
      await this.loadActiveAppointmentForConversation(conversationId);
    const keepAgendado =
      String(conv?.status ?? '').toLowerCase().trim() === 'agendado' ||
      activeApt != null;

    await this.conversationRepository.update(
      { id: conversationId },
      keepAgendado
        ? { isAutoPilotActive: false }
        : { status: 'por_cotizar', isAutoPilotActive: false },
    );
  }

  /**
   * Reemplaza `formalNarrative` del borrador por el mensaje al cliente (agendado vs sin cita).
   */
  private async applyClientFacingFormalNarrativeToDraft(
    draft: DraftQuote,
    analysis: VehicleDamageAnalysis,
    conversationId: string,
    imageCount: number,
    complement?: Pick<
      DamageInventoryMergeResult,
      'previousPiezas' | 'newPiezas'
    > | null,
  ): Promise<void> {
    const conv = await this.conversationRepository.findOne({
      where: { id: conversationId },
    });
    const contactName = conv?.contactName?.trim() || 'cliente';
    const isAgendado =
      String(conv?.status ?? '').toLowerCase().trim() === 'agendado';

    let apt = await this.loadActiveAppointmentForConversation(conversationId);
    if (!apt && isAgendado) {
      apt = await this.loadLatestAppointmentForConversation(conversationId);
    }

    const hasActiveAppointment = isAgendado || apt != null;
    const lineRows = draftQuoteLinesToClientePiezaRows(draft.lines);
    const total = draft.total ?? draft.subtotal ?? 0;
    const damageIntro = buildDamagePhotoIntroForCliente(analysis, imageCount);

    const isComplement =
      complement != null &&
      complement.previousPiezas.length > 0 &&
      complement.newPiezas.length > 0;

    if (isComplement) {
      const newSet = new Set(complement!.newPiezas);
      const newLineRows = lineRows.filter((r) => newSet.has(r.pieza));
      const formattedDate = apt?.scheduledAt
        ? formatDraftAppointmentCitaLong(apt.scheduledAt)
        : undefined;
      const mapsUrl = hasActiveAppointment
        ? undefined
        : await this.aiConfigService.getValue(AI_CONFIG_KEYS.BUSINESS_MAPS_URL);
      draft.formalNarrative = buildClienteFormalNarrativeComplement({
        contactName,
        previousPiezas: complement!.previousPiezas,
        newPiezas: complement!.newPiezas,
        newLineRows,
        total,
        hasAppointment: hasActiveAppointment,
        appointmentFormatted: formattedDate,
        mapsUrl,
        damageIntro,
      });
      return;
    }

    if (hasActiveAppointment) {
      const formattedDate = apt?.scheduledAt
        ? formatDraftAppointmentCitaLong(apt.scheduledAt)
        : 'el día acordado para tu visita';
      draft.formalNarrative = buildClienteFormalNarrativeAgendado({
        contactName,
        lineRows,
        total,
        appointmentFormatted: formattedDate,
        damageIntro,
      });
      return;
    }

    const mapsUrl = await this.aiConfigService.getValue(
      AI_CONFIG_KEYS.BUSINESS_MAPS_URL,
    );
    draft.formalNarrative = buildClienteFormalNarrativeSinCita({
      contactName,
      lineRows,
      total,
      mapsUrl,
      damageIntro,
    });
  }

  private async resolveDraftResumeSchedulingContext(
    conversationId: string | undefined,
    historyText: string,
  ): Promise<{
    hasConfirmedAppointment: boolean;
    appointmentHuman: string | null;
    vehiclePhrase: string;
  }> {
    let status = '';
    if (conversationId) {
      const conv = await this.conversationRepository.findOne({
        where: { id: conversationId },
      });
      status = String(conv?.status ?? '').toLowerCase().trim();
    }

    const vehicleFromHistory =
      inferBañoVehicleDisplayLabel(historyText) || 'su vehículo';

    if (status !== 'agendado') {
      return {
        hasConfirmedAppointment: false,
        appointmentHuman: null,
        vehiclePhrase: vehicleFromHistory,
      };
    }

    if (!conversationId) {
      return {
        hasConfirmedAppointment: true,
        appointmentHuman: null,
        vehiclePhrase: vehicleFromHistory,
      };
    }

    const apt = await this.loadLatestAppointmentForConversation(conversationId);
    const human = apt?.scheduledAt
      ? formatAppointmentHumanDate(apt.scheduledAt)
      : null;
    const vehiclePhrase =
      pickFirstNonEmptyTrimmedString(apt?.vehicle, vehicleFromHistory) ||
      'su vehículo';

    return {
      hasConfirmedAppointment: true,
      appointmentHuman: human,
      vehiclePhrase,
    };
  }

  private async buildDraftResumeSystemAppend(
    scheduling: {
      hasConfirmedAppointment: boolean;
      appointmentHuman: string | null;
      vehiclePhrase: string;
    },
  ): Promise<string> {
    if (scheduling.hasConfirmedAppointment) {
      const when =
        scheduling.appointmentHuman ?? 'la fecha acordada de su cita';
      return `${DRAFT_RESUME_BASE_AUTH_HINT}${buildDraftResumeAgendadoCriticalContext(
        when,
        scheduling.vehiclePhrase,
      )}`;
    }
    const mapsUrl = await this.aiConfigService.getValue(
      AI_CONFIG_KEYS.BUSINESS_MAPS_URL,
    );
    return `${DRAFT_RESUME_BASE_AUTH_HINT}${buildDraftResumeSinCitaSystemAppend(mapsUrl)}`;
  }

  /**
   * Genera la primera respuesta del asistente tras autorizar un borrador (playground o producción).
   */
  private async composeResumeAfterDraftAssistantMessage(body: {
    chatAppointmentPrompt: string;
    userBatchText?: string;
    authorizedQuoteSummary: string;
    historyTurns: { role: 'user' | 'assistant'; text: string }[];
    visionItems?: unknown;
    conversationId?: string;
  }): Promise<string> {
    const chatAppointmentPrompt = String(body.chatAppointmentPrompt ?? '');
    if (!chatAppointmentPrompt.trim()) {
      throw new BadRequestException('chatAppointmentPrompt vacío');
    }

    const userBatchText =
      body.userBatchText != null ? String(body.userBatchText).trim() : '';
    const authorizedRaw = String(body.authorizedQuoteSummary ?? '').trim();
    const authorizedQuoteSummary = authorizedRaw
      ? normalizeAuthorizedQuoteSummaryLines(authorizedRaw)
      : '';
    const visionParsed = this.normalizePlaygroundResumeVisionItems(
      body.visionItems,
    );
    const visionAppend = this.buildPlaygroundVisionSystemAppend(visionParsed);
    const catalogAppend = await this.loadCatalogPromptAppendForLlm();

    const historyText = [
      ...body.historyTurns.map((h) => h.text),
      userBatchText,
      authorizedQuoteSummary,
    ]
      .filter((t) => t.length > 0)
      .join('\n\n');

    const scheduling = await this.resolveDraftResumeSchedulingContext(
      body.conversationId,
      historyText,
    );
    const resumeAuthHint = await this.buildDraftResumeSystemAppend(scheduling);

    const batchCtx =
      userBatchText ||
      '(El cliente envió imagen(es) y mensaje en el mismo lote; no hay texto adicional.)';
    const authBlock =
      authorizedQuoteSummary ||
      '(Sin detalle de cotización autorizada: indica al cliente que un asesor le confirmará.)';

    const mergedUserForLlm = [
      '[Contexto del lote del cliente — úsalo solo como referencia, no lo cites literal salvo que encaje naturalmente]',
      batchCtx,
      '',
      authBlock,
      '',
      'Escribe un único mensaje en español dirigido al cliente final. No repitas el prefijo "SISTEMA:" ni instrucciones internas. No pidas fotos adicionales para cotizar este caso si la cotización ya está autorizada arriba.',
      'En el desglose visible al cliente usa emoji 🛠️ en cada línea de pieza con su precio en MXN.',
    ].join('\n');

    const chatMessages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `${chatAppointmentPrompt}${visionAppend}${resumeAuthHint}${catalogAppend}`,
      },
      ...body.historyTurns.map((h) => ({ role: h.role, content: h.text })),
      { role: 'user', content: mergedUserForLlm },
    ];

    const chatCompletion = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: chatMessages,
      max_tokens: 1200,
    });
    return (
      chatCompletion.choices[0]?.message?.content?.trim() ||
      '(La IA no devolvió texto.)'
    );
  }

  /**
   * Tras autorizar un borrador en el Playground (visión con ítems), genera la primera respuesta
   * del asistente de chat usando el resumen autorizado y el historial previo al cierre del lote.
   */
  async testAiPlaygroundResumeAfterDraft(body: {
    chatAppointmentPrompt: string;
    userBatchText?: string;
    authorizedQuoteSummary: string;
    history?: unknown;
    visionItems?: unknown;
    /** Si se envía, se consulta status + cita en BD (prueba flujo agendado). */
    conversationId?: string;
  }): Promise<{ assistantMessage: string }> {
    const historyTurns = this.normalizePlaygroundHistoryPayload(body.history);
    const assistantMessage = await this.composeResumeAfterDraftAssistantMessage({
      chatAppointmentPrompt: body.chatAppointmentPrompt,
      userBatchText: body.userBatchText,
      authorizedQuoteSummary: body.authorizedQuoteSummary,
      historyTurns,
      visionItems: body.visionItems,
      conversationId: body.conversationId,
    });
    return { assistantMessage };
  }

  /**
   * Producción: tras aprobar/enviar un DraftQuote, primera respuesta IA al cliente
   * (misma lógica que playground, con historial y cita desde BD).
   */
  async resumeConversationAfterDraft(
    conversationId: string,
    body: {
      userBatchText?: string;
      authorizedQuoteSummary: string;
      visionItems?: unknown;
    },
  ): Promise<{ assistantMessage: string }> {
    const conv = await this.conversationRepository.findOne({
      where: { id: conversationId },
    });
    if (!conv) {
      throw new NotFoundException(`Conversación no encontrada: ${conversationId}`);
    }

    const chatAppointmentPrompt = await this.aiConfigService.getValue(
      AI_CONFIG_KEYS.DEFAULT_CHAT_APPOINTMENT_PROMPT,
    );
    const recent = await this.loadRecentMessagesForLlm(conversationId);
    const historyTurns = this.messagesToChatCompletionTurns(recent)
      .filter(
        (m): m is { role: 'user' | 'assistant'; content: string } =>
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string',
      )
      .map((m) => ({
        role: m.role,
        text: String(m.content),
      }));

    const assistantMessage = await this.composeResumeAfterDraftAssistantMessage({
      chatAppointmentPrompt,
      userBatchText: body.userBatchText,
      authorizedQuoteSummary: body.authorizedQuoteSummary,
      historyTurns,
      visionItems: body.visionItems,
      conversationId,
    });
    return { assistantMessage };
  }

  /**
   * Plantilla premium de baño cuando ya hay resolución de catálogo (fallback si el LLM de clasificación falló).
   */
  private async tryFormatBañoPremiumInstantReply(
    resolution: InstantQuoteResolution,
    tierSource: string,
    canonical: string,
    severidadLiteral: string,
  ): Promise<string | null> {
    if (!isBañoDePinturaServicio(canonical)) return null;
    const vl = this.resolveBañoVehicleLabelFromTierContext(tierSource);
    if (!vl) return null;
    let personalizedColorDetail: string | null = null;
    if (mentionsCambioDeColor(tierSource)) {
      personalizedColorDetail = await extractBañoPersonalizedColorDetail(
        this.openai,
        tierSource,
      );
    }
    try {
      return await composeBañoNaturalInstantReply(this.openai, {
        vehicleLabel: vl,
        segmentoEs: '',
        servicioDb: canonical,
        severidadLiteral,
        resolution,
        personalizedColorDetail,
      });
    } catch (err) {
      console.warn('[BañoPremiumInstant] plantilla no aplicable:', err);
      return null;
    }
  }

  /**
   * Baño de pintura: LLM + plantilla premium; si el LLM falla, misma plantilla con resolución de catálogo.
   * Nunca devuelve el formato plano de {@link formatInstantQuoteClientMessage}.
   */
  private async resolveBañoInstantPremiumMessage(
    purifiedLatest: string,
    tierCtx: string,
    snap: MatrixPricingSnapshot,
  ): Promise<string | null> {
    const tierFlat = flattenBañoTierSource(tierCtx);
    const bañoNat = await this.tryBañoPinturaLlmInstantClientMessage(
      purifiedLatest,
      tierFlat,
      snap,
    );
    if (bañoNat) {
      return bañoNat;
    }

    const forced = await this.forceBañoPremiumStructuredReply(
      purifiedLatest,
      tierFlat,
      snap,
    );
    if (forced) {
      return forced;
    }

    const instant = tryResolveInstantQuoteFromUserText(purifiedLatest, snap, {
      fullContextForBaño: tierFlat,
    });
    if (!instant) {
      return null;
    }

    const resolved = resolveInstantCanonicalLatestThenFull(
      purifiedLatest,
      tierCtx,
      snap,
    );
    if (!resolved || !isBañoDePinturaServicio(resolved.canonical)) {
      return null;
    }

    const allowed = snap.listSeveridadesForCanonical(resolved.canonical);
    const fromLine = this.parseSeveridadFromInstantResolution(instant);
    const sevFinal =
      coerceBañoSeveridadToCatalog(fromLine ?? '', allowed) ??
      coerceBañoSeveridadToCatalog(inferBañoTierSeveridad(tierCtx), allowed) ??
      allowed[0]!;

    return this.tryFormatBañoPremiumInstantReply(
      instant,
      tierCtx,
      resolved.canonical,
      sevFinal,
    );
  }

  /**
   * Fallback por código: precios de PriceMatrix + plantilla premium (sin null si hay intención baño/color).
   */
  private async forceBañoPremiumStructuredReply(
    purifiedLatest: string,
    tierCtx: string,
    snap: MatrixPricingSnapshot,
  ): Promise<string | null> {
    if (isProhibitedVagueInstantQuoteText(purifiedLatest)) {
      return null;
    }
    const tierFlat = flattenBañoTierSource(tierCtx);
    if (!threadRequiresBañoStructuredQuote(tierFlat, purifiedLatest)) {
      return null;
    }

    const latest =
      purifyVehicleModelUserReply(purifiedLatest) ||
      flattenBañoTierSource(purifiedLatest);
    const full = tierFlat;

    let resolved = resolveInstantCanonicalLatestThenFull(latest, full, snap);
    if (!resolved || !isBañoDePinturaServicio(resolved.canonical)) {
      const forcedCanonical = resolveBañoCanonicalFromSnap(snap);
      if (!forcedCanonical) return null;
      resolved = { canonical: forcedCanonical, via: 'bano_pintura_synonym' as const };
    }

    const allowed = snap.listSeveridadesForCanonical(resolved.canonical);
    if (!allowed.length) return null;

    let sevFinal =
      coerceBañoSeveridadToCatalog(inferBañoTierSeveridad(tierFlat), allowed) ??
      allowed[0]!;
    if (tierSourceMentionsBora(tierFlat)) {
      sevFinal =
        coerceBañoSeveridadToCatalog('Mediano', allowed) ?? sevFinal;
    }

    let vehicleLabel =
      this.resolveBañoVehicleLabelFromTierContext(tierFlat) ??
      (tierSourceMentionsBora(tierFlat) ? 'Volkswagen Bora' : '');
    if (isPlaceholderBañoVehicleLabel(vehicleLabel)) {
      vehicleLabel = tierSourceMentionsBora(tierFlat) ? 'Volkswagen Bora' : '';
    }
    if (!vehicleLabel) {
      return null;
    }

    const resolution = materializeInstantQuoteResolution(snap, {
      canonical: resolved.canonical,
      severidadLiteral: sevFinal,
      tierSourceForCambioColor: tierFlat,
      resolveVia: resolved.via,
      latestPreview: latest,
      fullCtxPreview: full,
    });
    if (!resolution) {
      console.warn(
        '[BañoControlledFallback] materialize falló',
        { sevFinal, canonical: resolved.canonical },
      );
      return null;
    }

    let personalizedColorDetail: string | null = null;
    if (mentionsCambioDeColor(tierFlat)) {
      personalizedColorDetail =
        (await extractBañoPersonalizedColorDetail(this.openai, tierFlat)) ??
        extractBañoColorDetailHeuristic(tierFlat);
    }

    console.log(
      '[BañoControlledFallback] Plantilla obligatoria',
      JSON.stringify({
        vehicleLabel,
        sevFinal,
        precioMx: resolution.precioMx,
        total: resolution.total,
      }),
    );

    return composeBañoNaturalInstantReply(this.openai, {
      vehicleLabel,
      segmentoEs: 'sedán compacto mediano',
      servicioDb: resolved.canonical,
      severidadLiteral: sevFinal,
      resolution,
      personalizedColorDetail,
    });
  }

  /**
   * Baño de Pintura Exterior: clasifica severidad (tamaño) con LLM y redacta el mensaje con cifras exactas del catálogo.
   */
  private async tryBañoPinturaLlmInstantClientMessage(
    latestUserText: string,
    fullContextForBaño: string,
    snap: MatrixPricingSnapshot,
  ): Promise<string | null> {
    const latestRaw = String(latestUserText ?? '').trim();
    if (isProhibitedVagueInstantQuoteText(latestRaw)) {
      return null;
    }
    const latest =
      purifyVehicleModelUserReply(latestRaw) ||
      flattenBañoTierSource(latestRaw);
    const full = flattenBañoTierSource(String(fullContextForBaño ?? ''));
    const tierSource = full || latest;
    const tierFlat = flattenBañoTierSource(tierSource);
    const tierNorm = normalizeTextForMatch(tierFlat);

    const boraThread = tierSourceMentionsBora(tierFlat);
    const vehicleOk =
      boraThread ||
      (!shouldAskVehicleBeforeBañoQuote(tierNorm, tierFlat) &&
        isBañoVehicleProfiledForQuote(tierNorm, tierFlat));

    if (!vehicleOk && !threadRequiresBañoStructuredQuote(tierFlat, latest)) {
      console.log(
        '[LOG-PINTURA 3-pre] tryBañoPinturaLlm abortado: vehículo no perfilado. tierFlat:',
        tierFlat.slice(0, 500),
      );
      return this.forceBañoPremiumStructuredReply(latest, tierFlat, snap);
    }

    let resolved = resolveInstantCanonicalLatestThenFull(latest, full, snap);
    if (!resolved || !isBañoDePinturaServicio(resolved.canonical)) {
      const forcedCanonical = resolveBañoCanonicalFromSnap(snap);
      if (!forcedCanonical) {
        return this.forceBañoPremiumStructuredReply(latest, tierFlat, snap);
      }
      resolved = { canonical: forcedCanonical, via: 'bano_pintura_synonym' };
    }

    const allowed = snap.listSeveridadesForCanonical(resolved.canonical);
    if (!allowed.length) {
      return this.forceBañoPremiumStructuredReply(latest, tierFlat, snap);
    }

    let vehicleLabel = '';
    let segmentoEs = '';
    let severidadLiteral: string;

    try {
      const cls = await classifyBañoPinturaTierWithLlm(
        this.openai,
        tierFlat,
        allowed,
      );
      vehicleLabel = cls.vehicleLabel;
      segmentoEs = cls.segmentoEs;
      severidadLiteral = cls.severidadLiteral;
      console.log(
        '[LOG-PINTURA 3-llm] OpenAI classifyBañoPinturaTier:',
        JSON.stringify({
          vehicleLabel,
          segmentoEs,
          severidadLiteral,
        }),
      );
    } catch (err) {
      console.warn('[BañoPinturaLlm] classify fallback:', err);
      const inferred = inferBañoTierSeveridad(tierFlat);
      severidadLiteral =
        coerceBañoSeveridadToCatalog(inferred, allowed) ??
        coerceBañoSeveridadToCatalog('Mediano', allowed) ??
        allowed[0]!;
      vehicleLabel =
        this.resolveBañoVehicleLabelFromTierContext(tierFlat) ??
        (boraThread ? 'Volkswagen Bora' : '');
    }

    let sevFinal =
      coerceBañoSeveridadToCatalog(severidadLiteral, allowed) ??
      coerceBañoSeveridadToCatalog(inferBañoTierSeveridad(tierFlat), allowed) ??
      allowed[0]!;
    if (boraThread) {
      sevFinal =
        coerceBañoSeveridadToCatalog('Mediano', allowed) ?? sevFinal;
    }

    if (isPlaceholderBañoVehicleLabel(vehicleLabel)) {
      const inferredLabel =
        this.resolveBañoVehicleLabelFromTierContext(tierFlat) ??
        (boraThread ? 'Volkswagen Bora' : null);
      if (inferredLabel) {
        vehicleLabel = inferredLabel;
      } else {
        console.log(
          '[BañoPinturaLlm] vehicleLabel no perfilado; fallback controlado',
          vehicleLabel.slice(0, 80),
        );
        return this.forceBañoPremiumStructuredReply(latest, tierFlat, snap);
      }
    }

    const resolution = materializeInstantQuoteResolution(snap, {
      canonical: resolved.canonical,
      severidadLiteral: sevFinal,
      tierSourceForCambioColor: tierFlat,
      resolveVia: resolved.via,
      latestPreview: latest,
      fullCtxPreview: full,
    });
    if (!resolution) {
      console.log(
        '[LOG-PINTURA 3-pre] materializeInstantQuoteResolution null. sevFinal:',
        sevFinal,
        'canonical:',
        resolved.canonical,
        'precioCelda:',
        snap.getPriceForCanonical(resolved.canonical, sevFinal),
      );
      return this.forceBañoPremiumStructuredReply(latest, tierFlat, snap);
    }

    console.log(
      '[LOG-PINTURA 3-catálogo] Precios leídos de BD (resolution):',
      JSON.stringify({
        precioMxBase: resolution.precioMx,
        extras: resolution.extras,
        total: resolution.total,
        severidadLiteral: sevFinal,
        canonical: resolved.canonical,
      }),
    );

    let vl = vehicleLabel.trim();
    if (!vl || isPlaceholderBañoVehicleLabel(vl)) {
      const inferredVl =
        this.resolveBañoVehicleLabelFromTierContext(tierFlat) ??
        (boraThread ? 'Volkswagen Bora' : null);
      if (!inferredVl) {
        return this.forceBañoPremiumStructuredReply(latest, tierFlat, snap);
      }
      vl = inferredVl;
    }
    const seg = segmentoEs.trim() || 'categoría de tamaño según nuestro catálogo';

    let personalizedColorDetail: string | null = null;
    if (mentionsCambioDeColor(tierFlat)) {
      personalizedColorDetail = await extractBañoPersonalizedColorDetail(
        this.openai,
        tierFlat,
      );
    }

    try {
      const premiumText = await composeBañoNaturalInstantReply(this.openai, {
        vehicleLabel: vl,
        segmentoEs: seg,
        servicioDb: resolved.canonical,
        severidadLiteral: sevFinal,
        resolution,
        personalizedColorDetail,
      });
      console.log(
        '[LOG-PINTURA 3-final] String plantilla premium ensamblado (primeros 400 chars):',
        premiumText.slice(0, 400),
      );
      return premiumText;
    } catch (err) {
      console.warn('[BañoPinturaLlm] compose fallback plantilla:', err);
      return this.forceBañoPremiumStructuredReply(latest, tierFlat, snap);
    }
  }

  /**
   * Panel AI Playground: prueba con prompts en borrador (no persiste en BD).
   * Con imagen e ítems de visión: **vision-first** — no ejecuta el chat hasta el paso
   * {@link testAiPlaygroundResumeAfterDraft} (el front llama tras “Autorizar y Enviar”).
   */
  async testAiPlayground(body: {
    visionPrompt: string;
    chatAppointmentPrompt: string;
    userText?: string;
    /** Lote de imágenes (data URL) analizadas en un solo turno de visión. */
    imagesBase64?: string[];
    /** @deprecated Usar {@link testAiPlayground.imagesBase64} */
    imageBase64?: string;
    /** Turnos previos del simulador (hasta {@link ChatService.PLAYGROUND_HISTORY_PAYLOAD_MAX} con el mensaje actual). */
    history?: unknown;
  }): Promise<{
    assistantMessage: string;
    damageDetected: boolean;
    mockDraftQuote?: DraftQuote & { imageUrl?: string };
    visionItems?: DetectedDamageItem[];
    /** Visión devolvió cotización: el front debe revisar borrador antes de mostrar respuesta de chat. */
    isDraftPending?: boolean;
  }> {
    const userText = body.userText != null ? String(body.userText).trim() : '';
    const visionImageUrls = normalizePlaygroundImagesBase64Input(body);
    if (!userText && visionImageUrls.length === 0) {
      throw new BadRequestException('Envía userText o imagesBase64');
    }
    for (const url of visionImageUrls) {
      if (/^blob:/i.test(url)) {
        throw new BadRequestException(
          'imagesBase64 no puede incluir blob URLs. Envía data:image/...;base64,... desde el cliente.',
        );
      }
    }
    const hasVisionImages = visionImageUrls.length > 0;

    const visionPrompt = String(body.visionPrompt ?? '');
    const chatAppointmentPrompt = String(body.chatAppointmentPrompt ?? '');
    if (!chatAppointmentPrompt.trim()) {
      throw new BadRequestException('chatAppointmentPrompt vacío');
    }

    const historyTurns = this.normalizePlaygroundHistoryPayload(body.history);

    const instantIntercept = getPlaygroundInstantInterceptorDecision({
      historyTurns,
      currentUserText: userText,
    });
    if (instantIntercept.skipInstantInterceptor) {
      console.log('[PlaygroundInstantQuote]', JSON.stringify(instantIntercept));
    }

    const catalogAppend = await this.loadCatalogPromptAppendForLlm();

    let mergedUserForLlm = userText;
    let visionItemsAfterImage: DetectedDamageItem[] = [];
    let catalogSnapForTextOnly: MatrixPricingSnapshot | null = null;

    if (!hasVisionImages && userText) {
      catalogSnapForTextOnly = await this.catalogService.getMatrixPricingSnapshot();
      const playBañoCtx = this.buildPlaygroundUserBañoContext(historyTurns, userText);
      if (!instantIntercept.skipInstantInterceptor) {
        const vaguePlay = tryVagueGenericServiceProfilingReply(userText);
        if (vaguePlay) {
          return {
            assistantMessage: vaguePlay,
            damageDetected: false,
          };
        }
        const piezaPlay = tryResolvePiezaPinturaInstantReply(
          userText,
          playBañoCtx,
          catalogSnapForTextOnly,
        );
        if (piezaPlay) {
          return {
            assistantMessage: piezaPlay,
            damageDetected: false,
          };
        }
        const gateReply = tryBañoPinturaVehicleGateReply(
          userText,
          playBañoCtx,
          catalogSnapForTextOnly,
        );
        if (gateReply) {
          return {
            assistantMessage: gateReply,
            damageDetected: false,
          };
        }
        const bañoPremium = await this.resolveBañoInstantPremiumMessage(
          userText,
          playBañoCtx,
          catalogSnapForTextOnly,
        );
        if (bañoPremium) {
          return {
            assistantMessage: bañoPremium,
            damageDetected: false,
          };
        }
        const instant = tryResolveInstantQuoteFromUserText(userText, catalogSnapForTextOnly, {
          fullContextForBaño: playBañoCtx,
        });
        if (instant) {
          const resolvedPlay = resolveInstantCanonicalLatestThenFull(
            userText,
            playBañoCtx,
            catalogSnapForTextOnly,
          );
          if (
            !resolvedPlay ||
            !isBañoDePinturaServicio(resolvedPlay.canonical)
          ) {
            return {
              assistantMessage: formatInstantQuoteClientMessage(instant),
              damageDetected: false,
            };
          }
        }
      }
      const catalogOnly = this.tryCatalogOnlyDamageItemsFromUserText(
        userText,
        catalogSnapForTextOnly,
      );
      if (catalogOnly?.length) {
        const analysis = inventoryItemsToVehicleAnalysis(catalogOnly, []);
        const mockDraftQuote = attachImageUrlToDraftQuote(
          await this.generateDraftQuote(analysis),
          [],
        );
        return {
          assistantMessage: '',
          damageDetected: true,
          mockDraftQuote,
          visionItems: catalogOnly,
          isDraftPending: true,
        };
      }
    }

    if (hasVisionImages) {
      const urls = visionImageUrls;
      const clientHint = userText.trim() ? userText : '';
      visionItemsAfterImage = await this.analyzeDamageImage(urls, {
        systemPrompt: visionPrompt.trim() ? visionPrompt : undefined,
        allowEmptyInventory: true,
        clientContextText: clientHint || undefined,
      });
      if (visionItemsAfterImage.length) {
        const analysis = inventoryItemsToVehicleAnalysis(
          visionItemsAfterImage,
          urls,
        );
        const mockDraftQuote = attachImageUrlToDraftQuote(
          await this.generateDraftQuote(analysis),
          urls,
        );
        return {
          assistantMessage: '',
          damageDetected: true,
          mockDraftQuote,
          visionItems: visionItemsAfterImage,
          isDraftPending: true,
        };
      } else {
        const imgCount = urls.length;
        const note =
          imgCount > 1
            ? `No se detectaron daños en las ${imgCount} imágenes con el prompt de visión actual (o sin ítems válidos).`
            : 'No se detectaron daños en la imagen con el prompt de visión actual (o sin ítems válidos).';
        mergedUserForLlm = userText.trim()
          ? `${userText}\n\n--- Análisis visual ---\n${note}`
          : note;
      }
    }

    const visionSystemAppend = hasVisionImages
      ? this.buildPlaygroundVisionSystemAppend(visionItemsAfterImage)
      : '';

    const schedulingAppend = instantIntercept.skipInstantInterceptor
      ? buildPlaygroundPostQuoteSchedulingSystemAppend({
          userMentionedWeekday:
            playgroundUserMessageMentionsWeekdayOnlyRough(userText),
        })
      : '';

    const chatSystemFull = `${chatAppointmentPrompt}${visionSystemAppend}${catalogAppend}${schedulingAppend}`;

    let chatReply: string;
    if (instantIntercept.skipInstantInterceptor) {
      chatReply = await this.runPlaygroundChatWithCreateAppointmentTool({
        baseSystem: chatSystemFull,
        historyTurns,
        userContentForTurn: mergedUserForLlm,
      });
    } else {
      const chatCompletion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: chatSystemFull,
          },
          ...historyTurns.map((h) => ({ role: h.role, content: h.text })),
          { role: 'user', content: mergedUserForLlm },
        ],
        max_tokens: 1200,
      });
      chatReply =
        chatCompletion.choices[0]?.message?.content?.trim() ||
        '(La IA no devolvió texto.)';
    }

    if (!hasVisionImages && catalogSnapForTextOnly && !instantIntercept.skipInstantInterceptor) {
      const playBañoCtx = this.buildPlaygroundUserBañoContext(historyTurns, userText);
      const vaguePlayMerged = tryVagueGenericServiceProfilingReply(userText);
      if (vaguePlayMerged) {
        return {
          assistantMessage: vaguePlayMerged,
          damageDetected: false,
        };
      }
      const piezaPlayMerged = tryResolvePiezaPinturaInstantReply(
        userText,
        playBañoCtx,
        catalogSnapForTextOnly,
      );
      if (piezaPlayMerged) {
        return {
          assistantMessage: piezaPlayMerged,
          damageDetected: false,
        };
      }
      const gateMerged = tryBañoPinturaVehicleGateReply(
        userText,
        playBañoCtx,
        catalogSnapForTextOnly,
      );
      if (gateMerged) {
        return {
          assistantMessage: gateMerged,
          damageDetected: false,
        };
      }
      const bañoPremiumMerged = await this.resolveBañoInstantPremiumMessage(
        userText,
        playBañoCtx,
        catalogSnapForTextOnly,
      );
      if (bañoPremiumMerged) {
        return {
          assistantMessage: bañoPremiumMerged,
          damageDetected: false,
        };
      }
      const instantMerged = tryResolveInstantQuoteFromUserText(userText, catalogSnapForTextOnly, {
        fullContextForBaño: playBañoCtx,
      });
      if (instantMerged) {
        const resolvedMerged = resolveInstantCanonicalLatestThenFull(
          userText,
          playBañoCtx,
          catalogSnapForTextOnly,
        );
        if (
          !resolvedMerged ||
          !isBañoDePinturaServicio(resolvedMerged.canonical)
        ) {
          return {
            assistantMessage: formatInstantQuoteClientMessage(instantMerged),
            damageDetected: false,
          };
        }
      }
    }

    const probeSystem = `${visionPrompt.trim() || (await this.aiConfigService.getValue(AI_CONFIG_KEYS.DEFAULT_VISION_PROMPT))}

[Modo playground — texto (puede incluir resumen de análisis de imagen pegado por el sistema)]
Si el mensaje del usuario describe daños concretos de hojalatería o pintura (pieza o zona + severidad aproximada), responde ÚNICAMENTE con JSON válido:
{ "items": [ { "pieza": string, "severidad": "DL"|"DML"|"DM"|"DMF"|"DF"|"DMFuerte"|"N/A", "descripcionTecnica": string, "urls_origen": [] } ] }
Usa "N/A" solo para servicios sin grado de daño (p. ej. tratamiento cerámico). Si no hay daño vehicular claro ni servicio identificable, responde { "items": [] }.
Si el usuario solo pide cotización de estética / baño de pintura / cerámico / servicio del catálogo sin describir un golpe o rasguño concreto, responde SIEMPRE { "items": [] }. No inventes daños ni piezas para poder cotizar.

${catalogAppend}`;

    const probeMessages: ChatCompletionMessageParam[] = [
      { role: 'system', content: probeSystem },
      ...historyTurns.map((h) => ({ role: h.role, content: h.text })),
      { role: 'user', content: mergedUserForLlm },
    ];

    const probe = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: probeMessages,
      max_tokens: 900,
    });
    const probeText = probe.choices[0]?.message?.content?.trim();
    let probeParsed: unknown = null;
    try {
      probeParsed = probeText ? (JSON.parse(probeText) as unknown) : null;
    } catch {
      probeParsed = null;
    }
    const probeItems = parseDetectedDamageItemsAllowEmpty(probeParsed);

    if (!probeItems.length) {
      return {
        assistantMessage: chatReply,
        damageDetected: false,
      };
    }

    const analysis = inventoryItemsToVehicleAnalysis(probeItems, []);
    const quoteFromText = attachImageUrlToDraftQuote(
      await this.generateDraftQuote(analysis),
      visionImageUrls,
    );
    const summary = this.buildPlaygroundDamageSummary(quoteFromText, probeItems.length);
    return {
      assistantMessage: `${chatReply}\n\n—\n${summary}`,
      damageDetected: true,
      mockDraftQuote: quoteFromText,
      visionItems: probeItems,
    };
  }

  private buildPlaygroundDamageSummary(quote: DraftQuote, itemCount: number): string {
    const previewLines = quote.lines
      .slice(0, 5)
      .map(
        (l, i) =>
          `${i + 1}. ${l.description} — ${formatAutoFixMoney(l.subtotal)}`,
      );
    const more =
      quote.lines.length > 5
        ? `\n… y ${quote.lines.length - 5} línea(s) más.`
        : '';
    return [
      `Daños detectados (${itemCount} ítem en peritaje de prueba).`,
      `Borrador: ${quote.reference} · subtotal ${formatAutoFixMoney(quote.subtotal)} ${quote.currency}.`,
      '',
      ...previewLines,
      more,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Lista de piezas/servicios en BD para inyectar en prompts de texto (playground, autopilot, sugerencias).
   */
  private async loadCatalogPromptAppendForLlm(): Promise<string> {
    try {
      const names = await this.catalogService.getDistinctServicioNamesForPrompt();
      if (!names.length) {
        return '\n\n[Catálogo de piezas/servicios aún sin datos en base de datos.]';
      }
      const list = names.join(', ');
      return `\n\nEstos son los nombres EXACTOS de servicios y piezas en base de datos (PriceMatrix): ${list}.
NUNCA inventes precios ni inventes nombres de servicio: si cotizas algo, el nombre del servicio debe ser uno de esa lista (copiado tal cual) y el importe debe salir solo de la matriz para la severidad correcta.
Si el usuario dice "baño de pintura" o similar sin decir "Exterior", corresponde al servicio de catálogo "Baño de Pintura Exterior" y al tamaño (severidad) que toque según el vehículo o el tamaño que el cliente indique.
**Baño de pintura (obligatorio):** si en el mensaje actual y el historial reciente del cliente NO aparece el modelo de su auto ni camioneta (ni año, ni marca, ni frases tipo "es un…", "tengo un…", "mi …") y tampoco dice explícitamente el tamaño de carrocería (Chico, Mediano, Grande, XL, con o sin Premium), PROHIBIDO dar cifras o totales. Responde exactamente: "¡Claro! Con gusto. Para darte el precio estimado, ¿qué auto o camioneta tienes?" Si el modelo ya se dijo antes en el chat, úsalo y cotiza sin volver a preguntar.
**Servicios de precio fijo en catálogo (p. ej. Estética Automotriz, Cerámico cuando aplique en la lista):** puedes dar el precio de inmediato; no dependen del tamaño del vehículo en nuestro flujo actual.
Para baño de pintura con vehículo ya conocido, tamaños de referencia: Audi A4/A5, BMW Serie 3 / 318–335, Mercedes Clase C, Mazda 6 = severidad "Mediano Premium" salvo que el usuario indique explícitamente otro tamaño (Chico, Grande, XL, Premium, etc.).
Los servicios InstantQuote (p. ej. baño de pintura exterior por tamaño, cerámico, estética automotriz) cotízalos en el mismo mensaje con precios del catálogo: *no pidas borrador ni autorización humana ni fotos* para esos casos; entrega total y desglose amable al instante. Si pide baño de pintura y además "cambio de color", suma el suplemento: $8,000 MXN si el tamaño es Chico o Mediano (incluye variantes Premium de esos tamaños), y $10,000 MXN si es Grande o XL (incluye Premium). Para el resto de hojalatería con daño, sigue el flujo de borrador / fotos cuando aplique.
**Después de cotizar:** si el cliente ya recibió el precio y muestra interés, pide día/hora o menciona un día de la semana, tu prioridad es **agendar** (en canales con herramientas: función createAppointment). No repitas montos que ya enviaste salvo que pida otra cotización explícita.`;
    } catch (err) {
      console.warn('[loadCatalogPromptAppendForLlm]', err);
      return '';
    }
  }

  /**
   * Texto sin imagen: si el mensaje encaja con un servicio del catálogo y tiene precio con severidad N/A,
   * devuelve un inventario mínimo para generar borrador (sin visión).
   */
  private tryCatalogOnlyDamageItemsFromUserText(
    userText: string,
    snap: MatrixPricingSnapshot,
  ): DetectedDamageItem[] | null {
    const t = String(userText ?? '').trim();
    if (!t) return null;
    const canonical = snap.matchServicio(t);
    if (!canonical) return null;
    const na = snap.getAmount(canonical, 'N/A');
    if (na <= 0) return null;
    return [
      {
        pieza: canonical,
        severidad: 'N/A',
        descripcionTecnica:
          'Servicio o producto del catálogo solicitado por texto (sin imagen de peritaje).',
        urls_origen: [],
      },
    ];
  }

  /**
   * Arma una cotización formal en estado PENDING_APPROVAL a partir del peritaje
   * y precios del catálogo `price_matrix` en base de datos.
   */
  async generateDraftQuote(analysis: VehicleDamageAnalysis): Promise<DraftQuote> {
    const snap = await this.catalogService.getMatrixPricingSnapshot();
    const lines: DraftQuoteLine[] = [];
    let resolvedLevel: DamageLevel;

    if (analysis.inventory?.length) {
      resolvedLevel = pickWorstDamageLevel(
        analysis.inventory.map((i) => i.severidad),
      );
      const grouped = snap.matrixInventoryMaxLines(
        analysis.inventory.map((i) => ({
          servicio: i.pieza,
          severidad: i.severidad,
        })),
      );
      for (const g of grouped) {
        if (g.unitPrice <= 0) continue;
        lines.push({
          priceItemId: `matrix:${g.canonical}:${g.damageLevel}`,
          description: `${g.canonical} — nivel ${g.damageLevel} (catálogo; mayor costo entre filas de este servicio)`,
          quantity: 1,
          unitPrice: g.unitPrice,
          subtotal: g.unitPrice,
        });
      }
    } else {
      const partes =
        analysis.partesAfectadas?.length > 0
          ? analysis.partesAfectadas
          : analysis.pieza
            ? [analysis.pieza]
            : ['Estetica Exterior'];

      resolvedLevel = coerceDamageLevelCode(
        analysis.severidad || analysis.severidadDelDano,
      );

      const seen = new Set<string>();
      for (const parteRaw of partes) {
        const canonical = snap.matchServicio(parteRaw);
        if (!canonical) continue;
        const key = `${canonical}|${resolvedLevel}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const unit = snap.getAmount(canonical, resolvedLevel);
        if (unit <= 0) continue;
        lines.push({
          priceItemId: `matrix:${canonical}:${resolvedLevel}`,
          description: `${canonical} — nivel ${resolvedLevel} (según catálogo de precios)`,
          quantity: 1,
          unitPrice: unit,
          subtotal: unit,
        });
      }
    }

    if (lines.length === 0) {
      const fallbackPieza = 'Estetica Exterior';
      const unit = snap.getAmount(fallbackPieza, resolvedLevel);
      if (unit > 0) {
        lines.push({
          priceItemId: `matrix:${fallbackPieza}:${resolvedLevel}`,
          description: `${fallbackPieza} — nivel ${resolvedLevel} (referencia general; no se identificó pieza en el texto)`,
          quantity: 1,
          unitPrice: unit,
          subtotal: unit,
        });
      }
    }

    const subtotal = lines.reduce((acc, l) => acc + l.subtotal, 0);
    const reference = `COT-AF-${randomUUID().slice(0, 8).toUpperCase()}`;
    const generatedAt = new Date().toISOString();

    const lineText = lines
      .map(
        (l, i) =>
          `${i + 1}. ${l.description} — ${l.quantity} × ${formatAutoFixMoney(l.unitPrice)} = ${formatAutoFixMoney(l.subtotal)}`,
      )
      .join('\n');

    const resumenBlock =
      analysis.inventory?.length && analysis.inventory.length > 0
        ? [
            'Resumen pericial (automático) — inventario multi-imagen:',
            ...analysis.inventory.map((it, i) => {
              const code = coerceDamageLevelCode(it.severidad);
              const legacyDesc = (
                it as { descripcionTecnica?: string; descripcion?: string }
              ).descripcion;
              const descLine =
                it.descripcionTecnica?.trim() ||
                legacyDesc?.trim() ||
                '—';
              const urls =
                Array.isArray(it.urls_origen) && it.urls_origen.length > 0
                  ? it.urls_origen
                  : Array.isArray(
                        (it as { urls_origen?: string[]; urls_asociadas?: string[] })
                          .urls_asociadas,
                      )
                    ? (
                        (
                          it as {
                            urls_asociadas?: string[];
                          }
                        ).urls_asociadas ?? []
                      )
                    : [];
              const urlsLine =
                urls.length > 0
                  ? urls.join('\n   ')
                  : '(sin URLs listadas por el modelo)';
              return [
                `${i + 1}. Servicio: ${it.pieza} — severidad ${code}`,
                `   Descripción técnica: ${descLine}`,
                `   URLs origen:\n   ${urlsLine}`,
              ].join('\n');
            }),
            '',
            `- Severidad global máxima entre piezas: ${resolvedLevel}`,
            `- Partes / zonas: ${analysis.partesAfectadas.length ? analysis.partesAfectadas.join(', ') : 'no detalladas'}`,
            `- Justificación / reglas: ${analysis.justificacion}`,
          ]
        : [
            'Resumen pericial (automático):',
            `- Servicio identificado: ${analysis.pieza}`,
            `- Severidad (código AutoFix): ${analysis.severidad}`,
            `- Nivel aplicado en catálogo de precios: ${resolvedLevel}`,
            `- Partes / zonas: ${analysis.partesAfectadas.length ? analysis.partesAfectadas.join(', ') : 'no detalladas'}`,
            `- Descripción técnica: ${analysis.descripcionTecnica}`,
            `- Justificación del perito: ${analysis.justificacion}`,
          ];

    const formalNarrative = [
      'Estimado cliente,',
      '',
      'Por medio del presente documento se emite una PROPUESTA DE COTIZACIÓN en carácter MERAMENTE INFORMATIVO, elaborada con base en el análisis visual preliminar del daño y en la tabla de precios de referencia interna del taller (hojalatería y pintura).',
      '',
      'Estado del documento: PENDIENTE DE APROBACIÓN (PENDING_APPROVAL). Los importes, tiempos y alcances definitivos requieren inspección física en planta y autorización expresa de un asesor.',
      '',
      ...resumenBlock,
      '',
      'Detalle económico propuesto (antes de impuestos):',
      lineText,
      '',
      `Subtotal propuesto: ${formatAutoFixMoney(subtotal)} ${AUTO_FIX_CURRENCY}.`,
      `Referencia interna: ${reference}. Fecha de emisión (UTC): ${generatedAt}.`,
      '',
      'Atentamente,',
      'Área de cotizaciones — Taller (borrador automático)',
    ].join('\n');

    return {
      status: 'PENDING_APPROVAL',
      currency: AUTO_FIX_CURRENCY,
      reference,
      generatedAt,
      lines,
      subtotal,
      total: subtotal,
      formalNarrative,
      analysisBasis: {
        pieza: analysis.pieza,
        severidad: analysis.severidad,
        partesAfectadas: [...analysis.partesAfectadas],
        severidadDelDano: analysis.severidadDelDano,
        descripcionTecnica: analysis.descripcionTecnica,
        justificacion: analysis.justificacion,
        ...(analysis.inventory?.length
          ? { inventory: analysis.inventory }
          : {}),
      },
    };
  }

  /**
   * Cada imagen **reinicia** un temporizador de 30 s; solo cuando pasan 30 s sin nuevas fotos
   * se ejecuta el análisis con las URLs acumuladas en la ráfaga (no una cotización por foto).
   */
  private scheduleConsolidatedInboundImageAnalysis(
    conversationId: string,
    triggeringMessageId: string,
    imageUrl: string,
  ): void {
    const url = String(imageUrl).trim();
    if (!url || !isIncomingImage(url)) {
      return;
    }

    let bucket = this.pendingBurstImageUrls.get(conversationId);
    if (!bucket) {
      bucket = [];
      this.pendingBurstImageUrls.set(conversationId, bucket);
    }
    if (!bucket.includes(url)) {
      bucket.push(url);
    }

    const prev = this.consolidatedImageTimers.get(conversationId);
    if (prev !== undefined) {
      clearTimeout(prev);
    }
    const t = setTimeout(() => {
      this.consolidatedImageTimers.delete(conversationId);
      const burst = [...(this.pendingBurstImageUrls.get(conversationId) ?? [])];
      this.pendingBurstImageUrls.delete(conversationId);
      void this.processConsolidatedInboundImages(
        conversationId,
        triggeringMessageId,
        burst,
      ).catch((err) =>
        console.error('processConsolidatedInboundImages:', err),
      );
    }, ChatService.INBOUND_IMAGE_ANALYSIS_DEBOUNCE_MS);
    this.consolidatedImageTimers.set(conversationId, t);
  }

  /**
   * Usa el lote de la ráfaga si existe; si no, cae a {@link getRecentImages} + fallback al mensaje disparador.
   */
  private async processConsolidatedInboundImages(
    conversationId: string,
    attachingMessageId: string,
    burstUrls: readonly string[],
  ): Promise<void> {
    const fromBurst = [
      ...new Set(
        burstUrls.map((u) => String(u).trim()).filter((u) => u && isIncomingImage(u)),
      ),
    ];

    let imageUrls = fromBurst;

    if (!imageUrls.length) {
      imageUrls = await this.getRecentImages(conversationId);
    }

    if (!imageUrls.length) {
      const fallbackMsg = await this.messageRepository.findOne({
        where: { id: attachingMessageId },
      });
      const raw =
        fallbackMsg?.content &&
        typeof fallbackMsg.content === 'string'
          ? fallbackMsg.content.trim()
          : '';
      if (
        raw &&
        String(fallbackMsg?.direction ?? '').toLowerCase() === 'inbound' &&
        isIncomingImage(raw)
      ) {
        imageUrls = [raw];
      } else {
        return;
      }
    }

    const existingDraft = await this.draftQuoteRepository.findOne({
      where: { conversationId, status: 'PENDING_APPROVAL' },
      order: { createdAt: 'DESC' },
    });

    const newInventory = await this.analyzeDamageImageInSequentialChunks(
      imageUrls,
      { allowEmptyInventory: true },
    );

    console.log(
      `[VisionChunk] Inventario consolidado tras lotes: ${newInventory.length} pieza(s)`,
    );

    let analysis: VehicleDamageAnalysis;
    let complementMeta: Pick<
      DamageInventoryMergeResult,
      'previousPiezas' | 'newPiezas'
    > | null = null;
    let allImageUrls = imageUrls;

    if (existingDraft) {
      const priorInventory =
        this.extractPriorInventoryFromDraft(existingDraft);
      const priorUrls = parseDraftImageUrls(existingDraft.imageUrl ?? '');
      allImageUrls = [
        ...new Set([...priorUrls, ...imageUrls]),
      ];

      if (priorInventory.length > 0) {
        const snapMerge =
          await this.catalogService.getMatrixPricingSnapshot();
        const mergedInv = mergeDamageInventoryAccumulative(
          priorInventory,
          newInventory,
          (raw) => snapMerge.matchServicio(raw),
        );
        complementMeta = {
          previousPiezas: mergedInv.previousPiezas,
          newPiezas: mergedInv.newPiezas,
        };
        analysis = inventoryItemsToVehicleAnalysis(
          mergedInv.merged,
          allImageUrls,
        );
      } else {
        analysis = inventoryItemsToVehicleAnalysis(
          newInventory,
          allImageUrls,
        );
      }
    } else {
      analysis = inventoryItemsToVehicleAnalysis(newInventory, imageUrls);
    }

    const estimateAmount = await this.computePrimaryMatrixEstimate(analysis);
    let draftQuoteDoc = await this.generateDraftQuote(analysis);

    if (existingDraft?.quotePayload?.reference) {
      draftQuoteDoc = {
        ...draftQuoteDoc,
        reference: existingDraft.quotePayload.reference,
        generatedAt: existingDraft.quotePayload.generatedAt,
      };
    }

    await this.applyClientFacingFormalNarrativeToDraft(
      draftQuoteDoc,
      analysis,
      conversationId,
      imageUrls.length,
      complementMeta,
    );

    const persistedImageUrl = persistDraftImageUrlField(allImageUrls);

    const messageId = attachingMessageId;

    if (existingDraft) {
      const priorMessageId = existingDraft.messageId;
      existingDraft.messageId = messageId;
      existingDraft.imageUrl = persistedImageUrl;
      existingDraft.damageAnalysis = analysis;
      existingDraft.estimateAmount = estimateAmount;
      existingDraft.quotePayload = draftQuoteDoc;
      const savedDraft = await this.draftQuoteRepository.save(existingDraft);
      await this.syncDraftQuoteLineItems(
        savedDraft.id,
        analysis,
        draftQuoteDoc,
        allImageUrls,
      );

      if (priorMessageId && priorMessageId !== messageId) {
        await this.messageRepository.update(
          { id: priorMessageId },
          { damageAnalysis: null, draftQuote: null },
        );
      }
      await this.messageRepository.update(
        { id: messageId },
        { damageAnalysis: analysis, draftQuote: draftQuoteDoc },
      );

      await this.markConversationDraftPendingReview(conversationId);

      this.chatGateway.emitDraftQuoteReady({
        draftQuoteId: savedDraft.id,
        conversationId,
        messageId,
        damageAnalysis: analysis,
        draftQuote: draftQuoteDoc,
        estimateAmount,
        isAutoPilotActive: false,
      });
      return;
    }

    const row = this.draftQuoteRepository.create({
      conversationId,
      messageId,
      imageUrl: persistedImageUrl,
      damageAnalysis: analysis,
      estimateAmount,
      quotePayload: draftQuoteDoc,
      status: 'PENDING_APPROVAL',
    });
    const savedDraft = await this.draftQuoteRepository.save(row);
    await this.syncDraftQuoteLineItems(
      savedDraft.id,
      analysis,
      draftQuoteDoc,
      allImageUrls,
    );

    await this.messageRepository.update(
      { id: messageId },
      { damageAnalysis: analysis, draftQuote: draftQuoteDoc },
    );

    await this.markConversationDraftPendingReview(conversationId);

    this.chatGateway.emitDraftQuoteReady({
      draftQuoteId: savedDraft.id,
      conversationId,
      messageId,
      damageAnalysis: analysis,
      draftQuote: draftQuoteDoc,
      estimateAmount,
      isAutoPilotActive: false,
    });
  }

  async findDraftQuotesByConversation(conversationId: string) {
    const rows = await this.draftQuoteRepository.find({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      relations: { items: true },
    });
    for (const r of rows) {
      r.items?.sort((a, b) => a.sortOrder - b.sortOrder);
    }
    return rows;
  }

  /**
   * Actualiza pieza / severidad / precio final de un borrador, recalcula totales y persiste.
   */
  async patchDraftQuote(id: string, body: PatchDraftQuoteBody): Promise<DraftQuoteEntity> {
    const row = await this.draftQuoteRepository.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException(`DraftQuote no encontrada: ${id}`);
    }

    const hasMulti =
      Array.isArray(body.inventoryLines) && body.inventoryLines.length > 0;

    const hasAny =
      body.pieza !== undefined ||
      body.severidad !== undefined ||
      body.precioFinal !== undefined ||
      hasMulti;
    if (!hasAny) {
      throw new BadRequestException(
        'Envía al menos uno de: pieza, severidad, precioFinal, inventoryLines',
      );
    }

    if (
      body.precioFinal !== undefined &&
      (typeof body.precioFinal !== 'number' ||
        !Number.isFinite(body.precioFinal) ||
        body.precioFinal < 0)
    ) {
      throw new BadRequestException('precioFinal debe ser un número >= 0');
    }

    if (hasMulti) {
      const prevInv = row.damageAnalysis.inventory ?? [];
      const linesDto = body.inventoryLines!;
      for (let i = 0; i < linesDto.length; i++) {
        const L = linesDto[i];
        if (!L || typeof L.pieza !== 'string' || !String(L.pieza).trim()) {
          throw new BadRequestException(
            `inventoryLines[${i}]: pieza es obligatoria`,
          );
        }
        if (L.severidad == null || String(L.severidad).trim() === '') {
          throw new BadRequestException(
            `inventoryLines[${i}]: severidad es obligatoria`,
          );
        }
        const pm = Number(L.precioMx);
        if (!Number.isFinite(pm) || pm < 0) {
          throw new BadRequestException(
            `inventoryLines[${i}]: precioMx debe ser un número >= 0`,
          );
        }
      }

      const items: DetectedDamageItem[] = linesDto.map((L, i) => {
        const prev = prevInv[i] as DetectedDamageItem & {
          descripcion?: string;
          urls_asociadas?: string[];
        };
        const descFromDto =
          typeof L.descripcionTecnica === 'string' &&
          L.descripcionTecnica.trim()
            ? L.descripcionTecnica.trim()
            : typeof L.descripcion === 'string' && L.descripcion.trim()
              ? L.descripcion.trim()
              : '';
        const desc =
          descFromDto ||
          prev?.descripcionTecnica ||
          prev?.descripcion ||
          (prev
            ? 'Sin descripción técnica disponible.'
            : 'Pieza añadida manualmente desde el panel de cotización.');

        /** `urls_origen: []` ⇒ sin evidencias (línea manual). Sin la propiedad ⇒ conservar URLs del inventario previo mismo índice. */
        let urls_origen: string[];
        if (Object.prototype.hasOwnProperty.call(L, 'urls_origen')) {
          urls_origen = Array.isArray(L.urls_origen)
            ? L.urls_origen.map(String).filter(Boolean)
            : [];
        } else if (Object.prototype.hasOwnProperty.call(L, 'urls_asociadas')) {
          urls_origen = Array.isArray(L.urls_asociadas)
            ? L.urls_asociadas.map(String).filter(Boolean)
            : [];
        } else {
          urls_origen =
            Array.isArray(prev?.urls_origen) && prev.urls_origen.length > 0
              ? [...prev.urls_origen]
              : Array.isArray(prev?.urls_asociadas) &&
                  prev.urls_asociadas.length
                ? [...prev.urls_asociadas]
                : [];
        }

        return {
          pieza: String(L.pieza).trim(),
          severidad: String(L.severidad).trim(),
          descripcionTecnica: desc,
          urls_origen,
        };
      });

      const flatUrls = items.flatMap((it) => it.urls_origen);
      const fallbackUrls = parseDraftImageUrls(row.imageUrl);
      const sourceUrls = flatUrls.length > 0 ? flatUrls : fallbackUrls;

      const analysisMerged = inventoryItemsToVehicleAnalysis(
        items,
        sourceUrls.length ? sourceUrls : fallbackUrls,
      );

      const snap = await this.catalogService.getMatrixPricingSnapshot();

      const manualLines: DraftQuoteLine[] = linesDto.map((L, idx) => {
        const u = Math.round(Number(L.precioMx));
        const canonical =
          snap.matchServicio(String(L.pieza).trim()) ?? String(L.pieza).trim();
        const lev = coerceDamageLevelCode(String(L.severidad));
        return {
          priceItemId: `panel:${idx}:${canonical}:${lev}`,
          description: `${canonical} — nivel ${lev} (panel)`,
          quantity: 1,
          unitPrice: u,
          subtotal: u,
        };
      });
      const total = manualLines.reduce((acc, l) => acc + l.subtotal, 0);
      const estimateAmount = total;

      let quotePayload = await this.generateDraftQuote(analysisMerged);
      quotePayload = {
        ...quotePayload,
        reference: row.quotePayload.reference,
        generatedAt: row.quotePayload.generatedAt,
        lines: manualLines,
        subtotal: total,
        total,
        analysisBasis: {
          ...quotePayload.analysisBasis,
          pieza: analysisMerged.pieza,
          severidad: analysisMerged.severidad,
          partesAfectadas: [...analysisMerged.partesAfectadas],
          severidadDelDano: analysisMerged.severidadDelDano,
          descripcionTecnica: analysisMerged.descripcionTecnica,
          justificacion: analysisMerged.justificacion,
          inventory: items,
        },
      };

      const marker = 'Detalle económico propuesto';
      const lineText = manualLines
        .map(
          (l, i) =>
            `${i + 1}. ${l.description} — ${l.quantity} × ${formatAutoFixMoney(l.unitPrice)} = ${formatAutoFixMoney(l.subtotal)}`,
        )
        .join('\n');
      const idxM = quotePayload.formalNarrative.indexOf(marker);
      const head =
        idxM >= 0
          ? quotePayload.formalNarrative.slice(0, idxM).trimEnd()
          : quotePayload.formalNarrative;
      quotePayload = {
        ...quotePayload,
        formalNarrative: [
          head,
          '',
          marker + ' (antes de impuestos):',
          lineText,
          '',
          `Subtotal propuesto: ${formatAutoFixMoney(total)} ${AUTO_FIX_CURRENCY}.`,
          `Referencia interna: ${quotePayload.reference}. Fecha de emisión (UTC): ${quotePayload.generatedAt}.`,
          '',
          'Atentamente,',
          'Área de cotizaciones — Taller (borrador automático)',
        ].join('\n'),
      };

      row.damageAnalysis = analysisMerged;
      row.estimateAmount = estimateAmount;
      row.quotePayload = quotePayload;

      const saved = await this.draftQuoteRepository.save(row);
      await this.syncDraftQuoteLineItems(
        saved.id,
        analysisMerged,
        quotePayload,
        sourceUrls.length ? sourceUrls : parseDraftImageUrls(row.imageUrl),
      );

      if (row.messageId) {
        await this.messageRepository.update(
          { id: row.messageId },
          { damageAnalysis: analysisMerged, draftQuote: quotePayload },
        );
      }

      return this.loadDraftQuoteWithItemsOrThrow(saved.id);
    }

    const analysis: VehicleDamageAnalysis = {
      ...row.damageAnalysis,
      partesAfectadas: [...(row.damageAnalysis.partesAfectadas ?? [])],
    };

    if (body.pieza !== undefined) {
      const p = String(body.pieza).trim();
      if (!p) throw new BadRequestException('pieza no puede estar vacía');
      analysis.pieza = p;
      analysis.partesAfectadas = [p, ...analysis.partesAfectadas.filter((x) => x !== p)];
    }

    if (body.severidad !== undefined) {
      const s = coerceDamageLevelCode(String(body.severidad));
      analysis.severidad = s;
      analysis.severidadDelDano = s;
    }

    let estimateAmount = await this.computePrimaryMatrixEstimate(analysis);
    let quotePayload = await this.generateDraftQuote(analysis);
    quotePayload = {
      ...quotePayload,
      reference: row.quotePayload.reference,
      generatedAt: row.quotePayload.generatedAt,
    };

    if (body.precioFinal !== undefined) {
      const total = Math.round(body.precioFinal);
      estimateAmount = total;
      const lineText = `1. Importe acordado (ajuste manual) — 1 × ${formatAutoFixMoney(total)} = ${formatAutoFixMoney(total)}`;
      const marker = 'Detalle económico propuesto';
      const idx = quotePayload.formalNarrative.indexOf(marker);
      const head =
        idx >= 0
          ? quotePayload.formalNarrative.slice(0, idx).trimEnd()
          : quotePayload.formalNarrative;
      quotePayload = {
        ...quotePayload,
        lines: [
          {
            priceItemId: 'manual:precio-final',
            description: 'Total ajustado manualmente (PATCH)',
            quantity: 1,
            unitPrice: total,
            subtotal: total,
          },
        ],
        subtotal: total,
        total,
        formalNarrative: [
          head,
          '',
          marker + ' (antes de impuestos):',
          lineText,
          '',
          `Subtotal propuesto: ${formatAutoFixMoney(total)} ${AUTO_FIX_CURRENCY}.`,
          `Referencia interna: ${quotePayload.reference}. Fecha de emisión (UTC): ${quotePayload.generatedAt}.`,
          '',
          'Atentamente,',
          'Área de cotizaciones — Taller (borrador automático)',
        ].join('\n'),
        analysisBasis: {
          ...quotePayload.analysisBasis,
          pieza: analysis.pieza,
          severidad: analysis.severidad,
          partesAfectadas: [...analysis.partesAfectadas],
          severidadDelDano: analysis.severidadDelDano,
        },
      };
    }

    row.damageAnalysis = analysis;
    row.estimateAmount = estimateAmount;
    row.quotePayload = quotePayload;

    const saved = await this.draftQuoteRepository.save(row);
    await this.syncDraftQuoteLineItems(
      saved.id,
      analysis,
      quotePayload,
      parseDraftImageUrls(row.imageUrl),
    );

    if (row.messageId) {
      await this.messageRepository.update(
        { id: row.messageId },
        { damageAnalysis: analysis, draftQuote: quotePayload },
      );
    }

    return this.loadDraftQuoteWithItemsOrThrow(saved.id);
  }

  // --- OPTIMIZACIÓN DE CARGA ---

  async findMessagesByConversation(conversationId: string, limit = 50) {
    let rows = await this.messageRepository.find({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
    if (!rows.length) {
      rows = await this.messageRepository.find({
        where: { conversation: { id: conversationId } as any },
        order: { createdAt: 'DESC' },
        take: limit,
      });
    }
    // Objeto plano: evita referencias circulares al serializar JSON (conversation ↔ messages)
    return rows.map((m) => ({
      id: m.id,
      content: m.content,
      channelType: m.channelType,
      externalId: m.externalId,
      direction: m.direction,
      createdAt: m.createdAt,
      senderName: m.senderName,
      conversationId: m.conversationId,
      damageAnalysis: m.damageAnalysis ?? null,
      draftQuote: m.draftQuote ?? null,
    }));
  }

  async findAllConversations() {
    const conversations = await this.conversationRepository.find({
      order: { lastMessageAt: 'DESC' },
    });

    // Si falta plataforma o solo tenemos valores internos (p. ej. web-dashboard tras responder desde el panel),
    // inferimos desde mensajes. Priorizamos el último mensaje con canal «real», no solo el último por fecha.
    const idsNeedDerivedPlatform = conversations
      .filter(
        (c) =>
          !c.platform?.trim() ||
          isAgentOnlyPlatform(c.platform),
      )
      .map((c) => c.id);

    const fallbackByConvId = new Map<string, string>();
    if (idsNeedDerivedPlatform.length) {
      const meta = this.messageRepository.metadata;
      const table = meta.tableName;
      const colConv =
        meta.findColumnWithPropertyPath('conversationId')?.databaseName ??
        'conversationId';
      const colType =
        meta.findColumnWithPropertyPath('channelType')?.databaseName ??
        'channelType';
      const colCreated =
        meta.findColumnWithPropertyPath('createdAt')?.databaseName ??
        'createdAt';
      const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
      try {
        const rows: Record<string, unknown>[] =
          await this.messageRepository.manager.query(
            `SELECT ${q(colConv)} AS "conversationId", ${q(colType)} AS "channelType"
             FROM (
               SELECT ${q(colConv)}, ${q(colType)},
                 ROW_NUMBER() OVER (
                   PARTITION BY ${q(colConv)}
                   ORDER BY
                     CASE WHEN COALESCE(LOWER(TRIM(BOTH FROM ${q(colType)})), '') IN ('web-dashboard', 'test') THEN 1 ELSE 0 END ASC,
                     ${q(colCreated)} DESC
                 ) AS _rn
               FROM ${q(table)}
               WHERE ${q(colConv)} = ANY($1::uuid[])
             ) _w WHERE _w._rn = 1`,
            [idsNeedDerivedPlatform],
          );
        for (const row of rows) {
          const cid =
            row.conversationId != null ? String(row.conversationId) : undefined;
          const ct =
            row.channelType != null ? String(row.channelType) : undefined;
          if (cid && ct !== undefined) fallbackByConvId.set(cid, ct);
        }
      } catch (err) {
        console.error(
          'findAllConversations: fallback de platform desde mensajes falló',
          err,
        );
      }
    }

    return conversations.map((c) => ({
      id: c.id,
      externalId: c.externalId,
      contactName: c.contactName,
      avatarUrl: c.avatarUrl ?? null,
      status: c.status,
      lastMessageAt: c.lastMessageAt,
      lastMessage: c.lastMessage,
      platform: normalizePlatformForApi(c.platform, fallbackByConvId.get(c.id)),
      isAutoPilotActive: Boolean(c.isAutoPilotActive),
    }));
  }

  // --- LÓGICA DE IA ---

  /** Persiste cita tras llamada de herramienta createAppointment (validación de horario del taller). */
  /** Playground: misma lógica que producción (sin persistir cotización). */
  private async executeObtenerCotizacionExpressToolPlayground(
    argsJson: string,
  ): Promise<Record<string, unknown>> {
    const stub = { status: 'nuevo' } as Conversation;
    const result = await this.executeObtenerCotizacionExpressTool(argsJson, stub);
    return { ...result, preview: true };
  }

  private async executeObtenerCotizacionExpressTool(
    argsJson: string,
    conversation: Conversation,
  ): Promise<Record<string, unknown>> {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(argsJson || '{}') as Record<string, unknown>;
    } catch {
      return { success: false, error: 'Argumentos inválidos (JSON).' };
    }

    const serviciosRaw = raw.servicios ?? raw.services ?? raw.piezas;
    const servicios = Array.isArray(serviciosRaw)
      ? serviciosRaw.map((s) => String(s ?? '').trim()).filter(Boolean)
      : typeof serviciosRaw === 'string' && serviciosRaw.trim()
        ? [serviciosRaw.trim()]
        : [];

    const modeloVehiculo = pickFirstNonEmptyTrimmedString(
      raw.modeloVehiculo,
      raw.modelo_vehiculo,
      raw.vehicleModel,
      raw.vehicleDescription,
    );

    const snap = await this.catalogService.getMatrixPricingSnapshot();
    const isAgendado =
      String(conversation.status ?? '').toLowerCase().trim() === 'agendado';

    const result = buildObtenerCotizacionExpressPayload(
      snap,
      servicios,
      modeloVehiculo,
      { leadAgendado: isAgendado },
    );

    return result as Record<string, unknown>;
  }

  private async executeCreateAppointmentTool(
    argsJson: string,
    conversation: Conversation,
  ): Promise<{
    success: boolean;
    appointmentId?: string;
    scheduledAt?: string;
    error?: string;
  }> {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(argsJson || '{}') as Record<string, unknown>;
    } catch {
      return { success: false, error: 'Argumentos inválidos (JSON).' };
    }

    const iso = pickFirstNonEmptyTrimmedString(
      raw.scheduledAtIso,
      raw.scheduled_at_iso,
    );
    if (!iso) {
      return { success: false, error: 'Falta scheduledAtIso.' };
    }

    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return { success: false, error: 'Fecha u hora no válida.' };
    }

    if (!validateWorkshopSlotUtc(d)) {
      return {
        success: false,
        error:
          'Fuera del horario del taller (lun–vie 9–18, sáb 9–14) o día cerrado.',
      };
    }

    const clientName =
      pickFirstNonEmptyTrimmedString(
        raw.clientName,
        conversation.contactName,
      ) || 'Cliente';

    const vehicleRaw = pickFirstNonEmptyTrimmedString(
      raw.vehicleDescription,
      raw.vehicle,
    );
    const vehicle = vehicleRaw.length > 0 ? vehicleRaw : null;

    const rawPhone = pickFirstNonEmptyTrimmedString(raw.phone, raw.customerPhone);
    const phone =
      rawPhone.length > 0 ? rawPhone.replace(/\s+/g, '').slice(0, 32) : null;

    const row = this.appointmentRepository.create({
      conversationId: conversation.id,
      clientName,
      vehicle,
      phone,
      scheduledAt: d,
      status: 'confirmada',
    });
    const saved = await this.appointmentRepository.save(row);

    conversation.status = 'agendado';
    await this.conversationRepository.save(conversation);

    this.chatGateway.emitConversationLeadUpdated({
      conversationId: conversation.id,
      status: conversation.status,
      contactName: conversation.contactName,
      lastMessageAt: conversation.lastMessageAt
        ? conversation.lastMessageAt.toISOString()
        : null,
      lastMessage: conversation.lastMessage ?? null,
      isAutoPilotActive: Boolean(conversation.isAutoPilotActive),
    });

    return {
      success: true,
      appointmentId: saved.id,
      scheduledAt: saved.scheduledAt.toISOString(),
    };
  }

  /**
   * Misma validación que {@link executeCreateAppointmentTool} pero sin persistir (panel de pruebas).
   */
  private async executeCreateAppointmentToolPlayground(argsJson: string): Promise<{
    success: boolean;
    appointmentId?: string | null;
    scheduledAt?: string;
    error?: string;
    preview?: boolean;
  }> {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(argsJson || '{}') as Record<string, unknown>;
    } catch {
      return { success: false, error: 'Argumentos inválidos (JSON).' };
    }

    const iso = pickFirstNonEmptyTrimmedString(
      raw.scheduledAtIso,
      raw.scheduled_at_iso,
    );
    if (!iso) {
      return { success: false, error: 'Falta scheduledAtIso.' };
    }

    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return { success: false, error: 'Fecha u hora no válida.' };
    }

    if (!validateWorkshopSlotUtc(d)) {
      return {
        success: false,
        error:
          'Fuera del horario del taller (lun–vie 9–18, sáb 9–14) o día cerrado.',
      };
    }

    return {
      success: true,
      appointmentId: null,
      scheduledAt: d.toISOString(),
      preview: true,
    };
  }

  private async runPlaygroundChatWithCreateAppointmentTool(params: {
    baseSystem: string;
    historyTurns: { role: 'user' | 'assistant'; text: string }[];
    userContentForTurn: string;
  }): Promise<string> {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: params.baseSystem },
      ...params.historyTurns.map((h) => ({ role: h.role, content: h.text })),
      { role: 'user', content: params.userContentForTurn },
    ];

    let lastConfirmedIso: string | null = null;
    for (let step = 0; step < 6; step++) {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages,
        tools: AUTOPILOT_TOOLS,
        tool_choice: 'auto',
        temperature: 0.35,
        max_tokens: 1200,
      });

      const choice = completion.choices[0]?.message;
      if (!choice) break;

      const toolCalls = choice.tool_calls;
      if (toolCalls?.length) {
        messages.push(choice as ChatCompletionMessageParam);
        for (const tc of toolCalls) {
          if (tc.type !== 'function') {
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({
                success: false,
                error: 'Tipo de herramienta no soportado.',
              }),
            });
            continue;
          }
          const name = tc.function.name;
          let payload: Record<string, unknown>;
          if (name === 'createAppointment') {
            const r = await this.executeCreateAppointmentToolPlayground(
              tc.function.arguments ?? '{}',
            );
            payload = { ...r };
            if (r.success && r.scheduledAt) {
              lastConfirmedIso = r.scheduledAt;
            }
          } else if (name === 'obtenerCotizacionExpress') {
            payload = await this.executeObtenerCotizacionExpressToolPlayground(
              tc.function.arguments ?? '{}',
            );
          } else {
            payload = { success: false, error: `Función no soportada: ${name}` };
          }
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(payload),
          });
        }
        continue;
      }

      const txt = choice.content?.trim();
      if (txt) return txt;

      if (lastConfirmedIso) {
        try {
          const d = new Date(lastConfirmedIso);
          const human = d.toLocaleString('es-MX', {
            timeZone: WORKSHOP_TIMEZONE,
            dateStyle: 'medium',
            timeStyle: 'short',
          });
          return `(Simulador) Quedó acordada la visita para el ${human}. En este panel no se guardó en base de datos; es solo prueba.`;
        } catch {
          return '(Simulador) Cita en vista previa. No persistida en BD.';
        }
      }
      break;
    }

    return lastConfirmedIso
      ? '(Simulador) Cita en vista previa. No persistida en BD.'
      : '(La IA no devolvió texto.)';
  }

  /**
   * Textos entrantes del cliente posteriores al último mensaje **outbound** (aún sin respuesta del taller/IA).
   */
  private async findUnansweredInboundTextMessages(
    conversationId: string,
  ): Promise<Message[]> {
    const all = await this.messageRepository.find({
      where: { conversationId },
      order: { createdAt: 'ASC' },
    });
    let lastOutboundIdx = -1;
    for (let i = 0; i < all.length; i++) {
      if (String(all[i].direction ?? '').toLowerCase() === 'outbound') {
        lastOutboundIdx = i;
      }
    }
    const tail = lastOutboundIdx < 0 ? all : all.slice(lastOutboundIdx + 1);
    return tail.filter(
      (m) =>
        String(m.direction ?? '').toLowerCase() === 'inbound' &&
        !isIncomingImage(m.content) &&
        String(m.content ?? '').trim().length > 0,
    );
  }

  /** Reinicia el temporizador: un solo envío de autopilot al cabo del silencio. */
  private scheduleDebouncedAutopilotTextReply(conversationId: string): void {
    const prev = this.autopilotTextDebounceTimers.get(conversationId);
    if (prev !== undefined) {
      clearTimeout(prev);
    }
    const t = setTimeout(() => {
      this.autopilotTextDebounceTimers.delete(conversationId);
      void this.processDebouncedAutopilotTextReply(conversationId).catch(
        (err) =>
          console.error('processDebouncedAutopilotTextReply:', err),
      );
    }, ChatService.AUTOPILOT_INBOUND_TEXT_DEBOUNCE_MS);
    this.autopilotTextDebounceTimers.set(conversationId, t);
  }

  private async processDebouncedAutopilotTextReply(
    conversationId: string,
  ): Promise<void> {
    const conv = await this.conversationRepository.findOne({
      where: { id: conversationId },
    });
    if (!conv?.isAutoPilotActive) {
      return;
    }

    const batch = await this.findUnansweredInboundTextMessages(conversationId);
    if (batch.length === 0) {
      return;
    }

    const anchor = batch[batch.length - 1]!;
    await this.autoPilotSendTextReply(anchor, conv, {
      inboundTextBatch: batch,
    });

    const stillPending =
      await this.findUnansweredInboundTextMessages(conversationId);
    if (stillPending.length > 0) {
      this.scheduleDebouncedAutopilotTextReply(conversationId);
    }
  }

  /**
   * System prompt del autopilot + bloque opcional cuando el lead ya está agendado
   * (agradecimientos cortos vs dudas).
   */
  private async buildAutopilotSystemSection(
    conversation: Conversation,
    baseChatPrompt: string,
    options?: {
      postQuoteScheduling?: boolean;
      userMentionedWeekday?: boolean;
    },
  ): Promise<string> {
    const catalogAppend = await this.loadCatalogPromptAppendForLlm();
    const schedulingAppend = options?.postQuoteScheduling
      ? buildPlaygroundPostQuoteSchedulingSystemAppend({
          userMentionedWeekday: options.userMentionedWeekday === true,
          forAutopilot: true,
        })
      : '';
    const head = `${buildLlmServerTimeSystemPrefix()}\n\n${baseChatPrompt}${catalogAppend}${schedulingAppend}`;
    if (conversation.status !== 'agendado') {
      return head;
    }
    return `${head}\n\n[Estado del lead: AGENDADO — El cliente ya tiene cita confirmada. Prioriza responder sus dudas sobre la visita, el taller o el vehículo. Cualquier pieza o servicio extra que cotices con obtenerCotizacionExpress debe presentarse como complemento de su orden para el día acordado; no presiones nueva agenda, no envíes ubicación del taller ni cierres de venta genéricos salvo que lo pida. Si solo agradece o saluda sin pregunta nueva, responde una frase cordial y cierra.]`;
  }

  /** Autopilot con historial + tool `createAppointment`. */
  private async composeAutopilotReplyWithTools(
    conversation: Conversation,
    inboundMsg: Message,
    options?: { inboundTextBatch?: Message[] },
  ): Promise<string | null> {
    try {
      const convFresh = await this.conversationRepository.findOne({
        where: { id: conversation.id },
      });
      if (convFresh) {
        conversation.status = convFresh.status;
        conversation.isAutoPilotActive = convFresh.isAutoPilotActive;
      }
      if (!conversation.isAutoPilotActive) {
        return null;
      }

      const history = await this.loadRecentMessagesForLlm(conversation.id);

      const batchInbound = options?.inboundTextBatch?.filter(
        (m) =>
          m &&
          String(m.content ?? '').trim().length > 0 &&
          !isIncomingImage(m.content),
      );
      const mergedForInstant = batchInbound?.length
        ? batchInbound.map((m) => String(m.content ?? '').trim()).join('\n\n')
        : String(inboundMsg.content ?? '').trim();

      const batchIdSet =
        batchInbound && batchInbound.length > 0
          ? new Set(batchInbound.map((m) => m.id))
          : null;

      const historySansBatch = batchIdSet
        ? history.filter((m) => !batchIdSet.has(m.id))
        : history;

      const interceptorTurns = historySansBatch.map((m) => ({
        role:
          String(m.direction ?? '').toLowerCase() === 'outbound'
            ? ('assistant' as const)
            : ('user' as const),
        text: String(m.content ?? ''),
      }));
      const instantDecision = getPlaygroundInstantInterceptorDecision({
        historyTurns: interceptorTurns,
        currentUserText: mergedForInstant,
      });
      const skipInstantQuoteInterceptors =
        instantDecision.skipInstantInterceptor;
      if (skipInstantQuoteInterceptors) {
        console.log('[AutopilotAgent]', JSON.stringify(instantDecision));
      }

      const dialogue = this.messagesToChatCompletionTurns(historySansBatch);

      if (batchInbound?.length) {
        const merged = batchInbound
          .map((m, i) => `(${i + 1}) ${String(m.content).trim()}`)
          .join('\n\n');
        dialogue.push({
          role: 'user',
          content: `El cliente ha enviado varios mensajes seguidos (aún sin responder). Intégralos y respóndelos todos en un solo mensaje claro y ordenado:\n\n${merged}`,
        });
      } else if (dialogue.length === 0) {
        const t = String(inboundMsg.content ?? '').trim();
        if (!t || t.includes('cloudinary')) return null;
        dialogue.push({ role: 'user', content: t });
      }

      const messages: ChatCompletionMessageParam[] = [...dialogue];

      let lastConfirmedIso: string | null = null;

      for (let step = 0; step < 6; step++) {
        const freshChatPrompt = await this.aiConfigService.getValue(
          AI_CONFIG_KEYS.DEFAULT_CHAT_APPOINTMENT_PROMPT,
        );
        const systemContent = await this.buildAutopilotSystemSection(
          conversation,
          freshChatPrompt,
          skipInstantQuoteInterceptors
            ? {
                postQuoteScheduling: true,
                userMentionedWeekday:
                  playgroundUserMessageMentionsWeekdayOnlyRough(
                    mergedForInstant,
                  ),
              }
            : undefined,
        );
        if (messages[0]?.role === 'system') {
          messages[0] = { role: 'system', content: systemContent };
        } else {
          messages.unshift({ role: 'system', content: systemContent });
        }

        const completion = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          messages,
          tools: AUTOPILOT_TOOLS,
          tool_choice: 'auto',
          temperature: 0.4,
        });

        const choice = completion.choices[0]?.message;
        if (!choice) break;

        const toolCalls = choice.tool_calls;
        if (toolCalls?.length) {
          messages.push(choice as ChatCompletionMessageParam);
          for (const tc of toolCalls) {
            if (tc.type !== 'function') {
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify({
                  success: false,
                  error: 'Tipo de herramienta no soportado.',
                }),
              });
              continue;
            }
            const name = tc.function.name;
            const args = tc.function.arguments ?? '{}';
            let payload: Record<string, unknown>;
            if (name === 'createAppointment') {
              const aptPayload = await this.executeCreateAppointmentTool(
                args,
                conversation,
              );
              payload = aptPayload as Record<string, unknown>;
              if (aptPayload.success && aptPayload.scheduledAt) {
                lastConfirmedIso = aptPayload.scheduledAt;
              }
            } else if (name === 'obtenerCotizacionExpress') {
              payload = await this.executeObtenerCotizacionExpressTool(
                args,
                conversation,
              );
            } else {
              payload = {
                success: false,
                error: `Función desconocida: ${name}`,
              };
            }
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify(payload),
            });
          }
          continue;
        }

        const txt = choice.content?.trim();
        if (txt) return txt;

        if (lastConfirmedIso) {
          try {
            const d = new Date(lastConfirmedIso);
            const human = d.toLocaleString('es-MX', {
              timeZone: WORKSHOP_TIMEZONE,
              dateStyle: 'medium',
              timeStyle: 'short',
            });
            return `¡Listo! Tu cita quedó registrada para el ${human}. ¡Te esperamos en el taller!`;
          } catch {
            return 'Tu cita ha quedado registrada. ¡Te esperamos!';
          }
        }
        return null;
      }

      return lastConfirmedIso
        ? 'Tu cita ha quedado registrada. ¡Te esperamos!'
        : null;
    } catch (err) {
      console.error('composeAutopilotReplyWithTools:', err);
      return null;
    }
  }

  /** Texto sugerido para mensajes entrantes (ventas corto), con historial reciente. */
  private async buildInboundSuggestionFromHistory(
    turns: ChatCompletionMessageParam[],
  ): Promise<string | null> {
    if (!turns.length) return null;
    try {
      const systemPrompt = await this.aiConfigService.getValue(
        AI_CONFIG_KEYS.INBOUND_SUGGESTION_PROMPT,
      );
      const catalogAppend = await this.loadCatalogPromptAppendForLlm();
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: `${systemPrompt}${catalogAppend}` },
          ...turns,
        ],
      });
      const suggestion = completion.choices[0]?.message?.content?.trim();
      return suggestion || null;
    } catch (error) {
      console.error('buildInboundSuggestionFromHistory:', error);
      return null;
    }
  }

  /**
   * Autopilot: genera respuesta y la guarda como mensaje **outbound** para que aparezca en el chat.
   */
  private async autoPilotSendTextReply(
    inboundMsg: Message,
    conversation: Conversation,
    options?: { inboundTextBatch?: Message[] },
  ): Promise<void> {
    const text = await this.composeAutopilotReplyWithTools(
      conversation,
      inboundMsg,
      options,
    );
    if (!text) return;

    const outbound = this.messageRepository.create({
      content: text,
      channelType: inboundMsg.channelType || conversation.platform || 'test',
      senderName: 'Asistente IA',
      direction: 'outbound',
      externalId: conversation.externalId,
      conversation,
    });
    const savedOut = await this.messageRepository.save(outbound);

    conversation.lastMessageAt = new Date();
    const preview =
      text.length > 120 ? `${text.slice(0, 117)}…` : text;
    conversation.lastMessage = preview;
    await this.conversationRepository.save(conversation);

    this.chatGateway.emitNewMessage(savedOut);

    if (isFacebookMessengerPlatform(conversation.platform)) {
      void this.sendFacebookMessengerText(conversation.externalId, text).catch(
        (err) =>
          console.error('sendFacebookMessengerText (autopilot):', err),
      );
    }
  }

  async generateAiSuggestion(message: Message) {
    try {
      const cid =
        message.conversation?.id ||
        (message as { conversationId?: string }).conversationId;
      let turns: ChatCompletionMessageParam[] = [];
      if (cid) {
        const recent = await this.loadRecentMessagesForLlm(String(cid));
        turns = this.messagesToChatCompletionTurns(recent);
      }
      if (turns.length === 0) {
        const single = String(message.content ?? '').trim();
        if (!single || single.includes('cloudinary')) return;
        turns = [{ role: 'user', content: single }];
      }
      const suggestion = await this.buildInboundSuggestionFromHistory(turns);
      if (!suggestion) return;

      this.chatGateway.server.emit('aiSuggestion', {
        conversationId:
          message.conversation?.id || (message as { conversationId?: string }).conversationId,
        suggestion,
      });
    } catch (error) {
      console.error('Error con OpenAI:', (error as Error).message);
    }
  }

  async getManualAiSuggestion(conversationId: string) {
    try {
      const recent = await this.loadRecentMessagesForLlm(conversationId);
      const contextMessages = this.messagesToChatCompletionTurns(recent);

      if (!contextMessages.length) return 'No hay historial para analizar.';

      const snapM = await this.catalogService.getMatrixPricingSnapshot();
      const convoWindow = contextMessages.slice(-PLAYGROUND_INSTANT_INTERCEPTOR_HISTORY_TURNS);
      const userBañoCtx = convoWindow
        .map((m) => String(m.content ?? '').trim())
        .filter((t) => t.length > 0)
        .join('\n\n');

      for (let i = contextMessages.length - 1; i >= 0; i--) {
        const turn = contextMessages[i];
        if (turn?.role === 'user') {
          const lastUser = String(turn.content ?? '').trim();
          if (lastUser) {
            const vagueSuggest = tryVagueGenericServiceProfilingReply(lastUser);
            if (vagueSuggest) {
              return vagueSuggest;
            }
            const piezaSuggest = tryResolvePiezaPinturaInstantReply(
              lastUser,
              userBañoCtx || lastUser,
              snapM,
            );
            if (piezaSuggest) {
              return piezaSuggest;
            }
            const gateM = tryBañoPinturaVehicleGateReply(
              lastUser,
              userBañoCtx || lastUser,
              snapM,
            );
            if (gateM) {
              return gateM;
            }
            const bañoPremiumM = await this.resolveBañoInstantPremiumMessage(
              lastUser,
              userBañoCtx || lastUser,
              snapM,
            );
            if (bañoPremiumM) {
              return bañoPremiumM;
            }
            const instantM = tryResolveInstantQuoteFromUserText(lastUser, snapM, {
              fullContextForBaño: userBañoCtx || lastUser,
            });
            if (instantM) {
              const resolvedM = resolveInstantCanonicalLatestThenFull(
                lastUser,
                userBañoCtx || lastUser,
                snapM,
              );
              if (
                !resolvedM ||
                !isBañoDePinturaServicio(resolvedM.canonical)
              ) {
                return formatInstantQuoteClientMessage(instantM);
              }
            }
          }
          break;
        }
      }

      const closerPrompt = await this.aiConfigService.getValue(
        AI_CONFIG_KEYS.MANUAL_AI_CLOSER_PROMPT,
      );

      const catalogAppend = await this.loadCatalogPromptAppendForLlm();

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `${buildLlmServerTimeSystemPrefix()}

${closerPrompt}${catalogAppend}`,
          },
          ...contextMessages,
        ],
      });

      return completion.choices[0].message.content;
    } catch (error) {
      console.error('Error en sugerencia manual:', error);
      return 'No pude generar una sugerencia con contexto.';
    }
  }

  async patchConversationSettings(
    id: string,
    body: { isAutoPilotActive?: boolean },
  ): Promise<{ id: string; isAutoPilotActive: boolean }> {
    const row = await this.conversationRepository.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Conversación no encontrada: ${id}`);
    }
    if (typeof body.isAutoPilotActive === 'boolean') {
      row.isAutoPilotActive = body.isAutoPilotActive;
      await this.conversationRepository.save(row);
    }
    return { id: row.id, isAutoPilotActive: Boolean(row.isAutoPilotActive) };
  }

  /** Cancela debounces / ráfagas de imagen asociados a la conversación (evita trabajo tras borrar). */
  private clearPendingConversationJobs(conversationId: string): void {
    const imgTimer = this.consolidatedImageTimers.get(conversationId);
    if (imgTimer !== undefined) {
      clearTimeout(imgTimer);
      this.consolidatedImageTimers.delete(conversationId);
    }
    this.pendingBurstImageUrls.delete(conversationId);

    const textTimer = this.autopilotTextDebounceTimers.get(conversationId);
    if (textTimer !== undefined) {
      clearTimeout(textTimer);
      this.autopilotTextDebounceTimers.delete(conversationId);
    }
  }

  /**
   * Elimina la conversación y todo su historial (citas, borradores, líneas, mensajes).
   */
  async deleteConversation(id: string): Promise<void> {
    const conversationId = String(id ?? '').trim();
    if (!conversationId || !looksLikeConversationUuid(conversationId)) {
      throw new BadRequestException('Id de conversación inválido (se espera UUID)');
    }

    const row = await this.conversationRepository.findOne({
      where: { id: conversationId },
    });
    if (!row) {
      throw new NotFoundException(`Conversación no encontrada: ${conversationId}`);
    }

    this.clearPendingConversationJobs(conversationId);

    const draftQuotes = await this.draftQuoteRepository.find({
      where: { conversationId },
      select: ['id'],
    });
    const draftQuoteIds = draftQuotes.map((q) => q.id);
    if (draftQuoteIds.length > 0) {
      await this.draftQuoteItemRepository.delete({
        draftQuoteId: In(draftQuoteIds),
      });
    }
    await this.draftQuoteRepository.delete({ conversationId });
    await this.messageRepository.delete({ conversationId });
    await this.appointmentRepository.delete({ conversationId });
    await this.conversationRepository.delete({ id: conversationId });
  }

  async findAllAppointments(): Promise<
    {
      id: string;
      clientName: string;
      vehicle: string | null;
      phone: string | null;
      scheduledAt: string;
      status: AppointmentStatus;
      conversationId: string | null;
    }[]
  > {
    const rows = await this.appointmentRepository.find({
      order: { scheduledAt: 'ASC' },
    });
    return rows.map((a) => ({
      id: a.id,
      clientName: a.clientName,
      vehicle: a.vehicle,
      phone: a.phone,
      scheduledAt: a.scheduledAt.toISOString(),
      status: a.status,
      conversationId: a.conversationId,
    }));
  }

  async patchAppointmentStatus(
    id: string,
    body: { status?: string },
  ): Promise<{ id: string; status: AppointmentStatus }> {
    const allowed: AppointmentStatus[] = [
      'pendiente',
      'confirmada',
      'finalizada',
    ];
    const row = await this.appointmentRepository.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Cita no encontrada: ${id}`);
    }
    const raw = String(body.status ?? '').toLowerCase().trim();
    if (!allowed.includes(raw as AppointmentStatus)) {
      throw new BadRequestException(
        `status debe ser uno de: ${allowed.join(', ')}`,
      );
    }
    row.status = raw as AppointmentStatus;
    await this.appointmentRepository.save(row);
    return { id: row.id, status: row.status };
  }

  async findAllMessages() {
    return await this.messageRepository.find({
      relations: ['conversation'], 
      order: { createdAt: 'DESC' },
    });
  }
}