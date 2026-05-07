import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { Message, VehicleDamageAnalysis } from './entities/chat.entity';
import { Conversation } from './entities/conversation.entity';
import { ChatGateway } from './chat.gateway';
import { OpenAI } from 'openai';
import { v2 as cloudinary } from 'cloudinary';
import {
  AUTO_FIX_CURRENCY,
  DraftQuote,
  DraftQuoteLine,
  formatAutoFixMoney,
  getAutoFixPriceById,
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

function normalizeDamageAnalysisJson(raw: unknown): VehicleDamageAnalysis {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const parts = o['partesAfectadas'];
  const partesAfectadas = Array.isArray(parts)
    ? parts.map((p) => String(p))
    : typeof parts === 'string' && parts.trim()
      ? [parts.trim()]
      : [];
  const sev = o['severidadDelDano'] ?? o['severidad'];
  const desc = o['descripcionTecnica'] ?? o['descripcion'];
  return {
    partesAfectadas,
    severidadDelDano:
      typeof sev === 'string' && sev.trim() ? sev.trim() : 'no determinada',
    descripcionTecnica:
      typeof desc === 'string' && desc.trim()
        ? desc.trim()
        : 'Sin descripción técnica disponible.',
  };
}

@Injectable()
export class ChatService {
  private openai: OpenAI;

  constructor(
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    
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

    // Identificamos si es una imagen para el texto de vista previa en el Sidebar
    const isImageUrl = (url: string) => 
      (typeof url === 'string' && url.match(/\.(jpeg|jpg|gif|png|webp)$/) != null) || 
      (typeof url === 'string' && url.includes('cloudinary'));
    
    conversation.lastMessageAt = new Date(); 
    conversation.lastMessage = isImageUrl(data.message) ? '📷 Imagen' : (data.message || 'Sin contenido');
    
    await this.conversationRepository.save(conversation); 

    const newMessage = this.messageRepository.create({
      content: data.message || 'Sin contenido',
      channelType: data.platform || 'test',
      senderName: data.user || 'Cliente Desconocido',
      direction: data.direction || 'outbound',
      externalId: data.id || '123',
      conversation: conversation,
    });
    
    const saved = await this.messageRepository.save(newMessage);

    const conversationIdForSockets =
      saved.conversationId ?? conversation.id;

    // Solo generamos sugerencia si es texto entrante
    if (saved.direction === 'inbound' && !isImageUrl(saved.content)) {
      this.generateAiSuggestion(saved);
    }

    if (isImageUrl(saved.content)) {
      void this.persistDamageAnalysisAfterImageSave(
        saved.id,
        saved.content,
        conversationIdForSockets,
      ).catch((err) =>
        console.error('persistDamageAnalysisAfterImageSave:', err),
      );
    }

    this.chatGateway.emitNewMessage(saved);
    return saved;
  }

  /**
   * Analiza una imagen (URL pública, p. ej. Cloudinary) como técnico de hojalatería y pintura.
   * Devuelve JSON: partes afectadas, severidad del daño, descripción técnica.
   */
  async analyzeDamageImage(imageUrl: string): Promise<VehicleDamageAnalysis> {
    const systemPrompt = `Eres un perito senior en hojalatería y pintura automotriz con décadas de experiencia en taller, valoración de siniestros y acabados OEM.
Tu tarea es examinar la fotografía del vehículo y describir con rigor técnico lo observable en la imagen (no inventes daños fuera de campo o zonas no visibles).
Criterios: panel metálico vs plásticos, deformaciones, rayones, picaduras, óxido, roturas de cristales, desajustes de junta, trabajo de chapa (martilleo, masilla, soldadura) y de pintura (laca, barniz, mate, repintes, naranja, empañado).
Responde ÚNICAMENTE con un objeto JSON válido (sin markdown ni texto adicional) con exactamente estas claves:
- "partesAfectadas": array de strings con las zonas o piezas afectadas (ej. "Aleta delantera derecha", "Paragolpes trasero").
- "severidadDelDano": string breve (ej. "leve", "moderada", "grave") o descripción corta si no encaja en esas categorías.
- "descripcionTecnica": string con la descripción técnica detallada en español.`;

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
              text: 'Analiza esta imagen del vehículo y devuelve el JSON solicitado.',
            },
            {
              type: 'image_url',
              image_url: { url: imageUrl, detail: 'high' },
            },
          ],
        },
      ],
      max_tokens: 1200,
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
    return normalizeDamageAnalysisJson(parsed);
  }

  /**
   * Arma una cotización formal en estado PENDING_APPROVAL a partir del peritaje
   * y la lista de precios base (autofix-config).
   */
  generateDraftQuote(analysis: VehicleDamageAnalysis): DraftQuote {
    const lines: DraftQuoteLine[] = [];
    const partCount = Math.max(1, analysis.partesAfectadas.length);

    const paint = getAutoFixPriceById('paint_per_panel');
    if (paint) {
      lines.push({
        priceItemId: paint.id,
        description: `${paint.description} — zonas referidas: ${analysis.partesAfectadas.join('; ') || 'no especificadas'}`,
        quantity: partCount,
        unitPrice: paint.unitPrice,
        subtotal: partCount * paint.unitPrice,
      });
    }

    const blob = `${analysis.severidadDelDano} ${analysis.descripcionTecnica}`.toLowerCase();
    const suggestsDent =
      /golpe|abollad|deform|chapa|hojalater|colisión|impacto|levantar|martille|panel metálico/i.test(
        blob,
      ) || /moderad|grave|sever/i.test(analysis.severidadDelDano.toLowerCase());

    if (suggestsDent) {
      const dent = getAutoFixPriceById('dent_removal');
      if (dent) {
        lines.push({
          priceItemId: dent.id,
          description: dent.description,
          quantity: 1,
          unitPrice: dent.unitPrice,
          subtotal: dent.unitPrice,
        });
      }
    }

    if (/paragolpe|defensa|plástico|poliuretano/i.test(blob)) {
      const plastic = getAutoFixPriceById('plastic_bumper_repair');
      if (plastic) {
        lines.push({
          priceItemId: plastic.id,
          description: plastic.description,
          quantity: 1,
          unitPrice: plastic.unitPrice,
          subtotal: plastic.unitPrice,
        });
      }
    }

    if (/rayón|arañazo|picadura|óxido|masilla|preparaci/i.test(blob)) {
      const prep = getAutoFixPriceById('surface_prep_filler');
      if (prep) {
        lines.push({
          priceItemId: prep.id,
          description: prep.description,
          quantity: 1,
          unitPrice: prep.unitPrice,
          subtotal: prep.unitPrice,
        });
      }
    }

    if (/mate|empañ|naranja|brillo|acabado|laca/i.test(blob)) {
      const polish = getAutoFixPriceById('polish_correction');
      if (polish) {
        lines.push({
          priceItemId: polish.id,
          description: polish.description,
          quantity: 1,
          unitPrice: polish.unitPrice,
          subtotal: polish.unitPrice,
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

    const formalNarrative = [
      'Estimado cliente,',
      '',
      'Por medio del presente documento se emite una PROPUESTA DE COTIZACIÓN en carácter MERAMENTE INFORMATIVO, elaborada con base en el análisis visual preliminar del daño y en la tabla de precios de referencia interna del taller (hojalatería y pintura).',
      '',
      'Estado del documento: PENDIENTE DE APROBACIÓN (PENDING_APPROVAL). Los importes, tiempos y alcances definitivos requieren inspección física en planta y autorización expresa de un asesor.',
      '',
      'Resumen pericial (automático):',
      `- Severidad declarada: ${analysis.severidadDelDano}`,
      `- Partes o zonas mencionadas: ${analysis.partesAfectadas.length ? analysis.partesAfectadas.join(', ') : 'no detalladas'}`,
      `- Descripción técnica: ${analysis.descripcionTecnica}`,
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
        partesAfectadas: [...analysis.partesAfectadas],
        severidadDelDano: analysis.severidadDelDano,
        descripcionTecnica: analysis.descripcionTecnica,
      },
    };
  }

  private async persistDamageAnalysisAfterImageSave(
    messageId: string,
    imageUrl: string,
    conversationId: string,
  ): Promise<void> {
    const analysis = await this.analyzeDamageImage(imageUrl);
    const draftQuote = this.generateDraftQuote(analysis);
    await this.messageRepository.update(
      { id: messageId },
      { damageAnalysis: analysis, draftQuote },
    );
    this.chatGateway.emitImageDamageAnalysis({
      messageId,
      conversationId,
      damageAnalysis: analysis,
      draftQuote,
    });
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