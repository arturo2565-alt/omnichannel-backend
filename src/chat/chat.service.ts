import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message } from './entities/chat.entity';
import { Conversation } from './entities/conversation.entity';
import { ChatGateway } from './chat.gateway';
import { OpenAI } from 'openai';
import { v2 as cloudinary } from 'cloudinary';

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
   * NUEVO: Sube una imagen a Cloudinary y retorna la URL segura.
   */
  async uploadImage(file: Express.Multer.File): Promise<string> {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    return new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'image', folder: 'omnichannel_chats' }, 
        (error, result) => {
          if (error) return reject(error);
          if (!result) return reject(new Error("Cloudinary no retornó un resultado"))
          resolve(result.secure_url);
        }
      ).end(file.buffer);
    });
  }

  async saveMessage(data: any) {
    let conversation = await this.conversationRepository.findOne({
      where: { externalId: data.id || '123' }
    });

    if (!conversation) {
      conversation = this.conversationRepository.create({
        externalId: data.id || '123',
        contactName: data.user || 'Cliente Desconocido',
      });
      conversation = await this.conversationRepository.save(conversation);
    }

    // Identificamos si es una imagen para el texto de vista previa en el Sidebar
    const isImageUrl = (url: string) => url?.match(/\.(jpeg|jpg|gif|png|webp)$/) != null || url?.includes('cloudinary');
    
    conversation.lastMessageAt = new Date(); 
    conversation.lastMessage = isImageUrl(data.message) ? '📷 Imagen' : (data.message || 'Sin contenido');
    
    await this.conversationRepository.save(conversation); 

    const newMessage = this.messageRepository.create({
      content: data.message || 'Sin contenido',
      channelType: data.platform || 'test',
      senderName: data.user || 'Cliente Desconocido',
      direction: data.direction || 'inbound',
      externalId: data.id || '123',
      conversation: conversation,
    });
    
    const saved = await this.messageRepository.save(newMessage);
    
    // Solo generamos sugerencia si es texto (la IA no puede "leer" la imagen aún en este flujo)
    if (saved.direction === 'inbound' && !isImageUrl(saved.content)) {
      this.generateAiSuggestion(saved);
    }
    
    this.chatGateway.emitNewMessage(saved);
    return saved;
  }

  // --- OPTIMIZACIÓN DE CARGA ---

  async findMessagesByConversation(conversationId: string, limit = 50) {
    return await this.messageRepository.find({
      where: { conversation: { id: conversationId } as any },
      relations: ['conversation'],
      order: { createdAt: 'DESC' },
      take: limit, 
    });
  }

  async findAllConversations() {
    return await this.conversationRepository.find({
      order: { lastMessageAt: 'DESC' }
    });
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
        .filter(m => !m.content.includes('cloudinary')) // Filtramos imágenes del contexto para no confundir a la IA de texto
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