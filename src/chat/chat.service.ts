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
  calculateEstimate,
  coerceDamageLevelCode,
  DAMAGE_LEVEL_KEYS,
  DraftQuote,
  DraftQuoteLine,
  formatAutoFixMoney,
  matchPiezaFromAnalysis,
  matrixInventoryMaxLines,
  type DamageLevel,
} from './autofix-config';

/** Canales internos del panel: no deben sobrescribir el canal real del cliente en la conversación */
const AGENT_ONLY_PLATFORMS = new Set(['web-dashboard', 'test']);

function isAgentOnlyPlatform(platform: string | undefined | null): boolean {
  if (platform == null || typeof platform !== 'string') return false;
  return AGENT_ONLY_PLATFORMS.has(platform.trim().toLowerCase());
}

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

function damageLevelRank(level: DamageLevel): number {
  const i = DAMAGE_LEVEL_KEYS.indexOf(level);
  return i >= 0 ? i : 0;
}

function pickWorstDamageLevel(levels: string[]): DamageLevel {
  let worst: DamageLevel = 'DL';
  for (const raw of levels) {
    const c = coerceDamageLevelCode(raw);
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

@Injectable()
export class ChatService implements OnModuleDestroy {
  private openai: OpenAI;

  /** Tras la última imagen: esperar tanto tiempo en silencio antes de lanzar GPT (reinicia con cada nueva foto). */
  private static readonly INBOUND_IMAGE_ANALYSIS_DEBOUNCE_MS = 30 * 1000;

  /** Ventana histórica (p. ej. fallback / consultas) para imágenes entrantes recientes en la conversación. */
  static readonly RECENT_IMAGE_LOOKBACK_MS = 5 * 60 * 1000;

  /** conversationId → timeout del análisis consolidado pendiente */
  private readonly consolidatedImageTimers = new Map<
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
  private buildDraftQuoteLineRowsForPersist(
    analysis: VehicleDamageAnalysis,
    doc: DraftQuote,
    fallbackUrls: string[],
  ): Omit<DraftQuoteItem, 'id' | 'draftQuote' | 'draftQuoteId'>[] {
    const lines = doc.lines ?? [];
    if (!lines.length) return [];

    const inv = analysis.inventory ?? [];

    if (inv.length > 0 && inv.length === lines.length) {
      return lines.map((line, idx) => {
        const row = inv[idx];
        const canonical =
          matchPiezaFromAnalysis(row.pieza.trim()) ??
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
      const grouped = matrixInventoryMaxLines(
        inv.map((it) => ({
          pieza: it.pieza,
          severidad: it.severidad,
        })),
      );
      const out: Omit<DraftQuoteItem, 'id' | 'draftQuote' | 'draftQuoteId'>[] = [];
      for (let idx = 0; idx < grouped.length; idx++) {
        const g = grouped[idx];
        const line = lines[idx];
        const related = inv.filter(
          (it) => matchPiezaFromAnalysis(it.pieza) === g.canonical,
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
    const rows = this.buildDraftQuoteLineRowsForPersist(
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
  private computePrimaryMatrixEstimate(analysis: VehicleDamageAnalysis): number {
    if (analysis.inventory?.length) {
      const sum = calculateEstimate(
        analysis.inventory.map((i) => ({
          pieza: i.pieza,
          severidad: i.severidad,
        })),
      );
      if (sum > 0) return sum;
    }
    const level = coerceDamageLevelCode(analysis.severidad);
    const piezaMatriz =
      matchPiezaFromAnalysis(analysis.pieza) ??
      matchPiezaFromAnalysis(analysis.partesAfectadas?.[0] ?? '') ??
      analysis.pieza;
    return calculateEstimate(piezaMatriz, level);
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
        conversation = this.conversationRepository.create({
          externalId: threadExternalId,
          contactName: contactName || 'Cliente Desconocido',
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
        void this.autoPilotSendTextReply(saved, convRow).catch((err) =>
          console.error('autoPilotSendTextReply:', err),
        );
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
    return saved;
  }

  /**
   * Visión GPT-4o sobre **todas las URLs dadas**: un solo reporte consolidado en `items`.
   *
   * @param imageUrls Lote ordenado típicamente de la ráfaga acumulada en memoria o de {@link getRecentImages} (+ deduplicadas).
   */
  async analyzeDamageImage(imageUrls: readonly string[]): Promise<DetectedDamageItem[]> {
    const urls = [
      ...new Set(imageUrls.map((u) => String(u).trim()).filter(Boolean)),
    ];
    if (!urls.length) {
      throw new Error('Se requiere al menos una URL de imagen');
    }

    const systemPrompt = `Eres un perito experto de AutoFix para hojalatería y pintura.

Recibes un lote de fotos correspondiente a **un mismo envío/ráfaga de capturas**: todas las URLs del lote se acumulan mientras el usuario manda fotos seguidas; el análisis se hace cuando ha pasado un periodo sin nuevas imágenes en esa ráfaga (puede haber solo una foto o varias).

Debes analizar el **CONJUNTO COMPLETO** de una sola vez (no hagas conclusiones foto a foto de forma independiente ignorando las demás) y producir UN ÚNICO REPORTE PERICIAL CONSOLIDADO en formato lista JSON (\`items\`).

Interpretación geométrica y de proceso:
• **Ángulos / encuadres distintos de la MISMA pieza** (mismo golpe, misma fascia, vistas lateral y frontal diferentes, foto lejana y foto cercana, etc.) → **un solo objeto** por esa pieza, con severidad igual a la **más alta** que observe en todas esas vistas.
• **Piezas o zonas de daño claramente distintas** (ej. Fascia delantera y Puerta lado conductor claramente no es el mismo elemento) → **varios objetos** en la lista.

Si una sola foto muestra dos zonas/pestañas/pestanas diferentes con daño en piezas diferentes, registra cada una como entrada separada (puede repetir URL en urls_origen cuando ambas se ven en esa imagen).

Severidad: EXACTAMENTE uno de DL, DML, DM, DMF, DF, DMFuerte.

Ten en cuenta reflejos, sombras de carrocería y líneas de cierre entre piezas. Descuadre o daño muy profundo pueden justificar DF o DMFuerte.

NO inventes URLs: solo pueden aparecer valores que figuraron en el texto del usuario.`;

    const userSchemaHint = `Responde ÚNICAMENTE con un objeto JSON válido (sin markdown):
{ "items": [ ... ] }

Cada elemento de items es una **pieza o zona agrupada lógica** tras consolidar vistas:
- Varias fotos del mismo punto de impacto mismo componente ⇒ un solo objeto y severidad máxima vista.
- Varios golpes/pestañas en piezas diferentes ⇒ varios objetos.

Por objeto:
- "pieza": string (nombre entendible: Fascia, Salpicadera, Puerta, Cofre, Tapa Cajuela, Toldo, Espejo, Estribo, etc.).
- "severidad": EXACTAMENTE DL | DML | DM | DMF | DF | DMFuerte.
- "descripcionTecnica": texto en español (sintetiza lo visto considerando todas las fotos pertinentes).
- "urls_origen": array copiando **literalmente** de la lista siguiente las URLs donde se ve ese daño (las que mejor apoyan la severidad declarada).

Contexto temporal: todas las siguientes fotos llegaron en ventana corta (~5 min) en el mismo chat.`;

    const intro = urls
      .map((_, i) => `Imagen ${i + 1}: posición ${i + 1} en el bloque de imágenes`)
      .join('; ');

    const imageParts = urls.map((url) => ({
      type: 'image_url' as const,
      image_url: { url, detail: 'high' as const },
    }));

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `${userSchemaHint}\n\n${intro}\n\nURLs en orden — copiar en urls_origen las que evidencien cada daño:\n${urls.map((u, i) => `${i + 1}. ${u}`).join('\n')}`,
            },
            ...imageParts,
          ],
        },
      ],
      max_tokens: 3000,
    });

    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) {
      throw new Error('OpenAI no devolvió contenido para el análisis de daños');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error('Respuesta de OpenAI no es JSON válido');
    }
    return normalizeDetectedDamagesJson(parsed);
  }

  /**
   * Arma una cotización formal en estado PENDING_APPROVAL a partir del peritaje
   * y la lista de precios base (autofix-config).
   */
  generateDraftQuote(analysis: VehicleDamageAnalysis): DraftQuote {
    const lines: DraftQuoteLine[] = [];
    let resolvedLevel: DamageLevel;

    if (analysis.inventory?.length) {
      resolvedLevel = pickWorstDamageLevel(
        analysis.inventory.map((i) => i.severidad),
      );
      const grouped = matrixInventoryMaxLines(
        analysis.inventory.map((i) => ({
          pieza: i.pieza,
          severidad: i.severidad,
        })),
      );
      for (const g of grouped) {
        if (g.unitPrice <= 0) continue;
        lines.push({
          priceItemId: `matrix:${g.canonical}:${g.damageLevel}`,
          description: `${g.canonical} — nivel ${g.damageLevel} (matriz; mayor costo entre filas de esta pieza)`,
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
        const canonical = matchPiezaFromAnalysis(parteRaw);
        if (!canonical) continue;
        const key = `${canonical}|${resolvedLevel}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const unit = calculateEstimate(canonical, resolvedLevel);
        if (unit <= 0) continue;
        lines.push({
          priceItemId: `matrix:${canonical}:${resolvedLevel}`,
          description: `${canonical} — nivel ${resolvedLevel} (según matriz de referencia)`,
          quantity: 1,
          unitPrice: unit,
          subtotal: unit,
        });
      }
    }

    if (lines.length === 0) {
      const fallbackPieza = 'Estetica Exterior';
      const unit = calculateEstimate(fallbackPieza, resolvedLevel);
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
                `${i + 1}. Pieza: ${it.pieza} — severidad ${code}`,
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
            `- Pieza identificada: ${analysis.pieza}`,
            `- Severidad (código AutoFix): ${analysis.severidad}`,
            `- Nivel aplicado en matriz de precios: ${resolvedLevel}`,
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
    const estimateAmount = this.computePrimaryMatrixEstimate(analysis);
    const draftQuoteDoc = this.generateDraftQuote(analysis);

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

      const manualLines: DraftQuoteLine[] = linesDto.map((L, idx) => {
        const u = Math.round(Number(L.precioMx));
        const canonical =
          matchPiezaFromAnalysis(String(L.pieza).trim()) ??
          String(L.pieza).trim();
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

      let quotePayload = this.generateDraftQuote(analysisMerged);
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

    let estimateAmount = this.computePrimaryMatrixEstimate(analysis);
    let quotePayload = this.generateDraftQuote(analysis);
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
      status: c.status,
      lastMessageAt: c.lastMessageAt,
      lastMessage: c.lastMessage,
      platform: normalizePlatformForApi(c.platform, fallbackByConvId.get(c.id)),
      isAutoPilotActive: Boolean(c.isAutoPilotActive),
    }));
  }

  // --- LÓGICA DE IA ---

  /** Texto sugerido para mensajes entrantes (ventas corto). */
  private async buildInboundSuggestionText(content: string): Promise<string | null> {
    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content:
              'Eres un asistente de ventas experto. Sugiere una respuesta MUY corta (máximo 2 frases) para este mensaje. Sé amable y profesional.',
          },
          { role: 'user', content },
        ],
      });
      const suggestion = completion.choices[0]?.message?.content?.trim();
      return suggestion || null;
    } catch (error) {
      console.error('buildInboundSuggestionText:', error);
      return null;
    }
  }

  /**
   * Autopilot: genera respuesta y la guarda como mensaje **outbound** para que aparezca en el chat.
   */
  private async autoPilotSendTextReply(
    inboundMsg: Message,
    conversation: Conversation,
  ): Promise<void> {
    const text = await this.buildInboundSuggestionText(inboundMsg.content);
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
  }

  async generateAiSuggestion(message: Message) {
    try {
      const suggestion = await this.buildInboundSuggestionText(message.content);
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
      const history = await this.messageRepository.find({
        where: { conversation: { id: conversationId } as any },
        order: { createdAt: 'DESC' },
        take: 10 
      });

      if (!history || history.length === 0) return "No hay historial para analizar.";

      const contextMessages = history.reverse()
        .filter(m => !m.content.includes('cloudinary')) 
        .map(m => ({
          role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: m.content
        }));

      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { 
            role: "system", 
            content: "Eres un cerrador de ventas experto. Basado en el historial de chat, sugiere la mejor respuesta para cerrar la venta o resolver la duda del cliente de forma persuasiva y breve." 
          },
          ...contextMessages 
        ],
      });

      return completion.choices[0].message.content;

    } catch (error) {
      console.error("Error en sugerencia manual:", error);
      return "No pude generar una sugerencia con contexto.";
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