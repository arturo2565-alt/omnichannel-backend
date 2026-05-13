import {
  Injectable,
  NotFoundException,
  BadRequestException,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
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
  formatInstantQuoteClientMessage,
  tryResolveInstantQuoteFromUserText,
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
      name: 'createAppointment',
      description:
        'Registra una cita en la base de datos del taller. Úsala cuando el cliente haya confirmado explícitamente día y hora de visita válidos dentro del horario laboral.',
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
          ...(isEcho
            ? { user: 'Asistente IA' }
            : contactHint
              ? { contactName: contactHint }
              : {}),
        };

        if (!text && imageUrls.length === 0) continue;

        if (text) {
          const saved = await this.saveMessage({
            ...basePayload,
            message: text,
          });
          console.log(
            `[Meta webhook] texto ${isEcho ? '(eco→outbound)' : '(inbound)'} | PSID hilo:`,
            threadPsid,
            '| message.externalId:',
            saved.externalId,
          );
          lastMessageId = saved.id;
          n++;
        }
        for (const url of imageUrls) {
          const saved = await this.saveMessage({
            ...basePayload,
            message: url,
          });
          console.log(
            `[Meta webhook] imagen ${isEcho ? '(eco→outbound)' : '(inbound)'} | PSID hilo:`,
            threadPsid,
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

    conversation.lastMessageAt = new Date();
    conversation.lastMessage = incomingIsImage
      ? '📷 Imagen'
      : contentToSave || 'Sin contenido';

    if (
      resolvedDirection === 'outbound' &&
      String(data.conversationLeadStatus ?? '').trim() === 'cotizado'
    ) {
      conversation.status = 'cotizado';
    }

    await this.conversationRepository.save(conversation);

    const senderName = pickFirstNonEmptyTrimmedString(
      data.user,
      data.contactName,
      data.username,
      data.name,
    );

    const messageExternalId =
      threadExternalId ||
      pickFirstNonEmptyTrimmedString(
        data.externalId,
        data.id,
        data.from,
        conversation.externalId,
      );

    const newMessage = this.messageRepository.create({
      content: contentToSave,
      channelType: data.platform || 'test',
      senderName: senderName || 'Cliente Desconocido',
      direction: resolvedDirection,
      externalId: messageExternalId || conversation.externalId,
      conversation: conversation,
    });
    
    const saved = await this.messageRepository.save(newMessage);

    const conversationIdForSockets =
      saved.conversationId ?? conversation.id;

    if (saved.direction === 'inbound' && !isIncomingImage(saved.content)) {
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

    this.chatGateway.emitNewMessage(saved);

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
  }): Promise<{ assistantMessage: string }> {
    const chatAppointmentPrompt = String(body.chatAppointmentPrompt ?? '');
    if (!chatAppointmentPrompt.trim()) {
      throw new BadRequestException('chatAppointmentPrompt vacío');
    }

    const historyTurns = this.normalizePlaygroundHistoryPayload(body.history);
    const userBatchText = body.userBatchText != null ? String(body.userBatchText).trim() : '';
    const authorizedQuoteSummary = String(body.authorizedQuoteSummary ?? '').trim();
    const visionParsed = this.normalizePlaygroundResumeVisionItems(body.visionItems);
    const visionAppend = this.buildPlaygroundVisionSystemAppend(visionParsed);

    const catalogAppend = await this.loadCatalogPromptAppendForLlm();

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
    ].join('\n');

    const resumePlaygroundAuthHint =
      '\n\nCuando recibas un mensaje de usuario que comience por "SISTEMA:" con una autorización de cotización del operador, trátalo como aviso interno: no lo repitas al cliente. Presenta la cotización de forma clara pero conversacional, con los montos exactos que figuren en ese aviso, y cuando encaje en el tono menciona beneficios como la garantía por escrito. Si el historial o el contexto permiten inferir o recordar el vehículo del cliente, intégralo de forma natural y amigable.';

    const chatMessages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `${chatAppointmentPrompt}${visionAppend}${resumePlaygroundAuthHint}${catalogAppend}`,
      },
      ...historyTurns.map((h) => ({ role: h.role, content: h.text })),
      { role: 'user', content: mergedUserForLlm },
    ];

    const chatCompletion = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: chatMessages,
      max_tokens: 1200,
    });
    const chatReply =
      chatCompletion.choices[0]?.message?.content?.trim() ||
      '(La IA no devolvió texto.)';
    return { assistantMessage: chatReply };
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
    imageBase64?: string;
    /** Turnos previos del simulador (hasta {@link ChatService.PLAYGROUND_HISTORY_PAYLOAD_MAX} con el mensaje actual). */
    history?: unknown;
  }): Promise<{
    assistantMessage: string;
    damageDetected: boolean;
    mockDraftQuote?: DraftQuote;
    visionItems?: DetectedDamageItem[];
    /** Visión devolvió cotización: el front debe revisar borrador antes de mostrar respuesta de chat. */
    isDraftPending?: boolean;
  }> {
    const userText = body.userText != null ? String(body.userText).trim() : '';
    const imageBase64 = body.imageBase64 != null ? String(body.imageBase64).trim() : '';
    if (!userText && !imageBase64) {
      throw new BadRequestException('Envía userText o imageBase64');
    }
    if (imageBase64 && /^blob:/i.test(imageBase64)) {
      throw new BadRequestException(
        'imageBase64 no puede ser una blob URL. Envía data:image/...;base64,... desde el cliente.',
      );
    }

    const visionPrompt = String(body.visionPrompt ?? '');
    const chatAppointmentPrompt = String(body.chatAppointmentPrompt ?? '');
    if (!chatAppointmentPrompt.trim()) {
      throw new BadRequestException('chatAppointmentPrompt vacío');
    }

    const historyTurns = this.normalizePlaygroundHistoryPayload(body.history);

    const catalogAppend = await this.loadCatalogPromptAppendForLlm();

    let mergedUserForLlm = userText;
    let visionItemsAfterImage: DetectedDamageItem[] = [];

    if (!imageBase64 && userText) {
      const snapCat = await this.catalogService.getMatrixPricingSnapshot();
      const instant = tryResolveInstantQuoteFromUserText(userText, snapCat);
      if (instant) {
        return {
          assistantMessage: formatInstantQuoteClientMessage(instant),
          damageDetected: true,
        };
      }
      const catalogOnly = this.tryCatalogOnlyDamageItemsFromUserText(
        userText,
        snapCat,
      );
      if (catalogOnly?.length) {
        const analysis = inventoryItemsToVehicleAnalysis(catalogOnly, []);
        const mockDraftQuote = await this.generateDraftQuote(analysis);
        return {
          assistantMessage: '',
          damageDetected: true,
          mockDraftQuote,
          visionItems: catalogOnly,
          isDraftPending: true,
        };
      }
    }

    if (imageBase64) {
      const urls = [imageBase64];
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
        const mockDraftQuote = await this.generateDraftQuote(analysis);
        return {
          assistantMessage: '',
          damageDetected: true,
          mockDraftQuote,
          visionItems: visionItemsAfterImage,
          isDraftPending: true,
        };
      } else {
        const note =
          'No se detectaron daños en la imagen con el prompt de visión actual (o sin ítems válidos).';
        mergedUserForLlm = userText.trim()
          ? `${userText}\n\n--- Análisis visual ---\n${note}`
          : note;
      }
    }

    const visionSystemAppend = imageBase64
      ? this.buildPlaygroundVisionSystemAppend(visionItemsAfterImage)
      : '';

    const chatMessages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `${chatAppointmentPrompt}${visionSystemAppend}${catalogAppend}`,
      },
      ...historyTurns.map((h) => ({ role: h.role, content: h.text })),
      { role: 'user', content: mergedUserForLlm },
    ];

    const chatCompletion = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: chatMessages,
      max_tokens: 1200,
    });
    const chatReply =
      chatCompletion.choices[0]?.message?.content?.trim() ||
      '(La IA no devolvió texto.)';

    const probeSystem = `${visionPrompt.trim() || (await this.aiConfigService.getValue(AI_CONFIG_KEYS.DEFAULT_VISION_PROMPT))}

[Modo playground — texto (puede incluir resumen de análisis de imagen pegado por el sistema)]
Si el mensaje del usuario describe daños concretos de hojalatería o pintura (pieza o zona + severidad aproximada), responde ÚNICAMENTE con JSON válido:
{ "items": [ { "pieza": string, "severidad": "DL"|"DML"|"DM"|"DMF"|"DF"|"DMFuerte"|"N/A", "descripcionTecnica": string, "urls_origen": [] } ] }
Usa "N/A" solo para servicios sin grado de daño (p. ej. tratamiento cerámico). Si no hay daño vehicular claro ni servicio identificable, responde { "items": [] }.

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
    const quoteFromText = await this.generateDraftQuote(analysis);
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
      return `\n\nEstos son los servicios y piezas que ofrecemos actualmente: ${list}. Si el usuario menciona alguno de estos, ofrécelo. Si menciona algo que no está en la lista, indícale amablemente que por ahora no contamos con ese servicio. Los servicios InstantQuote (p. ej. baño de pintura exterior por tamaño, cerámico, estética automotriz) cotízalos en el mismo mensaje con precios del catálogo: *no pidas borrador ni autorización humana ni fotos* para esos casos; entrega total y desglose amable al instante. Si pide baño de pintura y además "cambio de color", suma el suplemento: $8,000 MXN si el tamaño es Chico o Mediano (incluye variantes Premium de esos tamaños), y $10,000 MXN si es Grande o XL (incluye Premium). Para el resto de hojalatería con daño, sigue el flujo de borrador / fotos cuando aplique.`;
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

    const inventory = await this.analyzeDamageImage(imageUrls);
    const analysis = inventoryItemsToVehicleAnalysis(inventory, imageUrls);
    const estimateAmount = await this.computePrimaryMatrixEstimate(analysis);
    const draftQuoteDoc = await this.generateDraftQuote(analysis);

    const persistedImageUrl =
      imageUrls.length === 1 ? imageUrls[0] : JSON.stringify(imageUrls);

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
        imageUrls,
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

      await this.conversationRepository.update(
        { id: conversationId },
        { status: 'por_cotizar', isAutoPilotActive: false },
      );

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
      imageUrls,
    );

    await this.messageRepository.update(
      { id: messageId },
      { damageAnalysis: analysis, draftQuote: draftQuoteDoc },
    );

    await this.conversationRepository.update(
      { id: conversationId },
      { status: 'por_cotizar', isAutoPilotActive: false },
    );

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
  ): Promise<string> {
    const catalogAppend = await this.loadCatalogPromptAppendForLlm();
    const head = `${buildLlmServerTimeSystemPrefix()}\n\n${baseChatPrompt}${catalogAppend}`;
    if (conversation.status !== 'agendado') {
      return head;
    }
    return `${head}\n\n[Estado del lead: AGENDADO — La cita ya está registrada. El autopilot permanece activo: si el cliente solo agradece, saluda o escribe algo breve sin una pregunta ni solicitud nueva, responde una sola frase cordial y cierra la interacción sin volver a agendar ni pedir datos. Si el mensaje plantea una duda razonable sobre la visita, el taller o el vehículo, respóndela en pocas frases.]`;
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

      if (mergedForInstant) {
        const snapInstant = await this.catalogService.getMatrixPricingSnapshot();
        const instant = tryResolveInstantQuoteFromUserText(
          mergedForInstant,
          snapInstant,
        );
        if (instant) {
          return formatInstantQuoteClientMessage(instant);
        }
      }

      const batchIdSet =
        batchInbound && batchInbound.length > 0
          ? new Set(batchInbound.map((m) => m.id))
          : null;

      const historySansBatch = batchIdSet
        ? history.filter((m) => !batchIdSet.has(m.id))
        : history;
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
            let payload: {
              success: boolean;
              appointmentId?: string;
              scheduledAt?: string;
              error?: string;
            };
            if (name === 'createAppointment') {
              payload = await this.executeCreateAppointmentTool(
                args,
                conversation,
              );
              if (payload.success && payload.scheduledAt) {
                lastConfirmedIso = payload.scheduledAt;
              }
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

      for (let i = contextMessages.length - 1; i >= 0; i--) {
        const turn = contextMessages[i];
        if (turn?.role === 'user') {
          const lastUser = String(turn.content ?? '').trim();
          if (lastUser) {
            const snapM = await this.catalogService.getMatrixPricingSnapshot();
            const instantM = tryResolveInstantQuoteFromUserText(lastUser, snapM);
            if (instantM) {
              return formatInstantQuoteClientMessage(instantM);
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