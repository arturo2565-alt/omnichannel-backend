import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import {
  DamageInventoryItem,
  Message,
  VehicleDamageAnalysis,
} from './entities/chat.entity';
import { Conversation } from './entities/conversation.entity';
import { DraftQuoteEntity } from './entities/draft-quote.entity';
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

function normalizeDamageInventoryJson(raw: unknown): DamageInventoryItem[] {
  const o =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const direct = Array.isArray(raw) ? raw : null;
  const arr =
    (Array.isArray(o['items']) ? o['items'] : null) ??
    (Array.isArray(o['resultado']) ? o['resultado'] : null) ??
    direct;
  if (!Array.isArray(arr)) {
    throw new Error(
      'Se esperaba un JSON con la clave "items" (array de objetos con pieza, severidad, descripcion, urls_asociadas)',
    );
  }
  const out: DamageInventoryItem[] = [];
  for (const el of arr) {
    if (!el || typeof el !== 'object') continue;
    const r = el as Record<string, unknown>;
    const pieza = typeof r['pieza'] === 'string' ? r['pieza'].trim() : '';
    const severidad =
      typeof r['severidad'] === 'string' ? r['severidad'].trim() : '';
    const descripcion =
      typeof r['descripcion'] === 'string'
        ? r['descripcion'].trim()
        : typeof r['descripcionTecnica'] === 'string'
          ? String(r['descripcionTecnica']).trim()
          : '';
    let urls_asociadas: string[] = [];
    const u = r['urls_asociadas'];
    if (Array.isArray(u)) {
      urls_asociadas = u.map((x) => String(x).trim()).filter(Boolean);
    }
    if (!pieza || !severidad) continue;
    out.push({
      pieza,
      severidad,
      descripcion: descripcion || 'Sin descripción.',
      urls_asociadas,
    });
  }
  if (!out.length) {
    throw new Error(
      'El inventario ("items") está vacío o no tiene filas con pieza y severidad válidas',
    );
  }
  return out;
}

function inventoryItemsToVehicleAnalysis(
  items: DamageInventoryItem[],
  sourceUrls: string[],
): VehicleDamageAnalysis {
  const inv: DamageInventoryItem[] = items.map((it) => ({
    pieza: it.pieza,
    severidad: it.severidad,
    descripcion: it.descripcion,
    urls_asociadas: [...(it.urls_asociadas ?? [])],
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
        `• ${it.pieza} (${coerceDamageLevelCode(it.severidad)}): ${it.descripcion}`,
    )
    .join('\n');
  const just = `Inventario unificado de ${inv.length} registro(s) de daño. Regla: por pieza se tomó la mayor severidad entre las fotos asociadas. Imágenes de entrada: ${sourceUrls.length}.`;

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
  descripcion?: string;
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
export class ChatService {
  private openai: OpenAI;

  constructor(
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,

    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,

    @InjectRepository(DraftQuoteEntity)
    private readonly draftQuoteRepository: Repository<DraftQuoteEntity>,

    private readonly chatGateway: ChatGateway,
  ) {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY, 
    });
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
   * GUARDAR MENSAJE Y ACTUALIZAR CONVERSACIÓN
   */
  async saveMessage(data: any) {
    let conversation = await this.conversationRepository.findOne({
      where: { externalId: data.id || '123' }
    });

    if (!conversation) {
      conversation = this.conversationRepository.create({
        externalId: data.id || '123',
        contactName: data.user || 'Cliente Desconocido',
        platform: shouldPersistPlatformOnConversation(data.platform)
          ? String(data.platform).trim()
          : null,
      });
      conversation = await this.conversationRepository.save(conversation);
    } else if (shouldPersistPlatformOnConversation(data.platform)) {
      conversation.platform = String(data.platform).trim();
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

    await this.conversationRepository.save(conversation);

    const newMessage = this.messageRepository.create({
      content: contentToSave,
      channelType: data.platform || 'test',
      senderName: data.user || 'Cliente Desconocido',
      direction: data.direction || 'outbound',
      externalId: data.id || '123',
      conversation: conversation,
    });
    
    const saved = await this.messageRepository.save(newMessage);

    const conversationIdForSockets =
      saved.conversationId ?? conversation.id;

    if (saved.direction === 'inbound' && !isIncomingImage(saved.content)) {
      this.generateAiSuggestion(saved);
    }

    if (incomingIsImage && isIncomingImage(saved.content)) {
      void this.finalizeInboundImagePipeline(
        saved.id,
        conversationIdForSockets,
        saved.content,
      ).catch((err) => console.error('finalizeInboundImagePipeline:', err));
    }

    this.chatGateway.emitNewMessage(saved);
    return saved;
  }

  /**
   * Analiza una o varias imágenes (URLs públicas, p. ej. Cloudinary) con visión gpt-4o (perito AutoFix).
   * Devuelve el inventario por pieza; usa {@link inventoryItemsToVehicleAnalysis} para unir a `VehicleDamageAnalysis`.
   */
  async analyzeDamageImage(
    imageUrls: string | string[],
  ): Promise<DamageInventoryItem[]> {
    const urlsRaw = Array.isArray(imageUrls) ? imageUrls : [imageUrls];
    const urls = [
      ...new Set(urlsRaw.map((u) => String(u).trim()).filter(Boolean)),
    ];
    if (!urls.length) {
      throw new Error('Se requiere al menos una URL de imagen');
    }

    const systemPrompt = `Eres un perito experto de AutoFix. Tu misión es analizar fotos de golpes vehiculares.

Se te proporcionan varias imágenes de un mismo vehículo.

Agrupa las imágenes que correspondan a la misma pieza.

Identifica si hay piezas distintas (ej: Imagen 1 y 2 son Fascia, Imagen 3 es Puerta).

Genera un inventario de daños único. Si una pieza tiene varias fotos, usa el ángulo que muestre mayor severidad para determinar el precio.

Devuelve un array de objetos: [{ pieza, severidad, descripcion, urls_asociadas }].

Clasifica la severidad EXACTAMENTE en una de estas categorías: DL (Leve), DML (Medio-Leve), DM (Medio), DMF (Medio-Fuerte), DF (Fuerte), DMFuerte (Muy Fuerte).

Ten en cuenta reflejos y descuadres de piezas para determinar si el daño es estructural (DF/DMFuerte).`;

    const userSchemaHint = `Responde ÚNICAMENTE con un objeto JSON válido (sin markdown) con esta estructura exacta:
{ "items": [ ... ] }
donde cada elemento de "items" tiene estas claves:
- "pieza": string, nombre de la pieza (ej. Fascia, Salpicadera, Puerta, Cofre, Tapa Cajuela, Toldo, Espejo, Estribo).
- "severidad": string, EXACTAMENTE uno de: DL, DML, DM, DMF, DF, DMFuerte (código tal cual).
- "descripcion": string en español, observaciones técnicas visibles (consolidadas por pieza si hay varias fotos).
- "urls_asociadas": array de strings; deben ser exactamente URLs que te fueron enviadas en este mensaje, las que correspondan a esa pieza.

Numeración para tu razonamiento: la primera imagen del usuario es Imagen 1, la segunda Imagen 2, etc.`;

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
              text: `${userSchemaHint}\n\n${intro}\n\nURLs en orden (debes copiarlas literalmente en urls_asociadas cuando correspondan):\n${urls.map((u, i) => `${i + 1}. ${u}`).join('\n')}`,
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
    return normalizeDamageInventoryJson(parsed);
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
              const urlsLine =
                it.urls_asociadas?.length > 0
                  ? it.urls_asociadas.join('\n   ')
                  : '(sin URLs listadas por el modelo)';
              return [
                `${i + 1}. Pieza: ${it.pieza} — severidad ${code}`,
                `   Descripción: ${it.descripcion}`,
                `   URLs asociadas:\n   ${urlsLine}`,
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
   * Tras guardar mensaje con imagen en Cloudinary: peritaje IA, estimate, tabla draft_quotes, socket.
   */
  private async finalizeInboundImagePipeline(
    messageId: string,
    conversationId: string,
    imageUrl: string,
  ): Promise<void> {
    const imageUrls = [imageUrl];
    const inventory = await this.analyzeDamageImage(imageUrls);
    const analysis = inventoryItemsToVehicleAnalysis(inventory, imageUrls);
    const estimateAmount = this.computePrimaryMatrixEstimate(analysis);
    const draftQuoteDoc = this.generateDraftQuote(analysis);

    const row = this.draftQuoteRepository.create({
      conversationId,
      messageId,
      imageUrl:
        imageUrls.length === 1 ? imageUrls[0] : JSON.stringify(imageUrls),
      damageAnalysis: analysis,
      estimateAmount,
      quotePayload: draftQuoteDoc,
      status: 'PENDING_APPROVAL',
    });
    const savedDraft = await this.draftQuoteRepository.save(row);

    await this.messageRepository.update(
      { id: messageId },
      { damageAnalysis: analysis, draftQuote: draftQuoteDoc },
    );

    this.chatGateway.emitDraftQuoteReady({
      draftQuoteId: savedDraft.id,
      conversationId,
      messageId,
      damageAnalysis: analysis,
      draftQuote: draftQuoteDoc,
      estimateAmount,
    });
  }

  async findDraftQuotesByConversation(conversationId: string) {
    return this.draftQuoteRepository.find({
      where: { conversationId },
      order: { createdAt: 'DESC' },
    });
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

      const items: DamageInventoryItem[] = linesDto.map((L, i) => {
        const prev = prevInv[i];
        return {
          pieza: String(L.pieza).trim(),
          severidad: String(L.severidad).trim(),
          descripcion:
            typeof L.descripcion === 'string' && L.descripcion.trim()
              ? L.descripcion.trim()
              : (prev?.descripcion ?? 'Sin descripción.'),
          urls_asociadas:
            Array.isArray(L.urls_asociadas) && L.urls_asociadas.length > 0
              ? L.urls_asociadas.map(String).filter(Boolean)
              : Array.isArray(prev?.urls_asociadas)
                ? [...prev.urls_asociadas]
                : [],
        };
      });

      const flatUrls = items.flatMap((it) => it.urls_asociadas);
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

      if (row.messageId) {
        await this.messageRepository.update(
          { id: row.messageId },
          { damageAnalysis: analysisMerged, draftQuote: quotePayload },
        );
      }

      return saved;
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

    if (row.messageId) {
      await this.messageRepository.update(
        { id: row.messageId },
        { damageAnalysis: analysis, draftQuote: quotePayload },
      );
    }

    return saved;
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
    }));
  }

  // --- LÓGICA DE IA ---

  async generateAiSuggestion(message: Message) {
    try {
      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o", 
        messages: [
          { 
            role: "system", 
            content: "Eres un asistente de ventas experto. Sugiere una respuesta MUY corta (máximo 2 frases) para este mensaje. Sé amable y profesional." 
          },
          { role: "user", content: message.content }
        ],
      });

      const suggestion = completion.choices[0].message.content;

      this.chatGateway.server.emit('aiSuggestion', {
        conversationId: message.conversation?.id || (message as any).conversationId,
        suggestion: suggestion
      });

    } catch (error) {
      console.error("Error con OpenAI:", error.message);
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

  async findAllMessages() {
    return await this.messageRepository.find({
      relations: ['conversation'], 
      order: { createdAt: 'DESC' },
    });
  }
}