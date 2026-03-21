import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message } from './entities/chat.entity';
import { Conversation } from './entities/conversation.entity';
import { ChatGateway } from './chat.gateway';
import { OpenAI } from 'openai';

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

  async saveMessage(data: any) {
    // 1. LÓGICA DE CONVERSACIÓN
    let conversation = await this.conversationRepository.findOne({
      where: { externalId: data.id || '123' }
    });

    if (!conversation) {
      console.log('Abriendo nueva conversación para:', data.user);
      conversation = this.conversationRepository.create({
        externalId: data.id || '123',
        contactName: data.user || 'Cliente Desconocido',
      });
      conversation = await this.conversationRepository.save(conversation);
    }

    conversation.lastMessageAt = new Date(); 
    await this.conversationRepository.save(conversation); 

    // 2. GUARDADO DEL MENSAJE
    const newMessage = this.messageRepository.create({
      content: data.message || 'Sin contenido',
      channelType: data.platform || 'test',
      senderName: data.user || 'Cliente Desconocido',
      direction: data.direction || 'inbound',
      externalId: data.id || '123',
      conversation: conversation,
    });
    
    const saved = await this.messageRepository.save(newMessage);
    
    // 3. IA AUTOMÁTICA: Solo si el mensaje viene del cliente
    if (saved.direction === 'inbound') {
      this.generateAiSuggestion(saved);
    }
    
    this.chatGateway.emitNewMessage(saved);
    return saved;
  }

  /**
   * SUGERENCIA AUTOMÁTICA (Vía Sockets)
   * Se dispara al recibir un mensaje.
   */
  async generateAiSuggestion(message: Message) {
    try {
      const completion = await this.openai.chat.completions.create({
        model: "gpt-3.5-turbo", 
        messages: [
          { 
            role: "system", 
            content: "Eres un asistente de ventas experto y amable. Sugiere una respuesta MUY corta (máximo 2 frases) y profesional para este mensaje de cliente. No uses el nombre del cliente si no lo sabes con certeza." 
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

  /**
   * SUGERENCIA MANUAL (Vía Request)
   * Útil para cuando el agente pulsa un botón de "Pedir ayuda a la IA".
   */
  async getManualAiSuggestion(conversationId: string) {
    try {
      // 1. Buscamos el último mensaje de esa conversación para darle contexto a la IA
      const lastMessage = await this.messageRepository.findOne({
        where: { conversation: { id: conversationId } as any }, // Ajustado para buscar por relación
        order: { createdAt: 'DESC' }
      });

      if (!lastMessage) return "No hay mensajes para analizar.";

      // 2. Le pedimos ayuda a GPT
      const completion = await this.openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { 
            role: "system", 
            content: "Eres un asistente de ventas pro. Genera una respuesta breve, amable y vendedora basada en el último mensaje del cliente." 
          },
          { role: "user", content: lastMessage.content }
        ],
      });

      return completion.choices[0].message.content;
    } catch (error) {
      console.error("Error OpenAI:", error);
      return "Lo siento, no pude generar una sugerencia ahora.";
    }
  }

  async findAllMessages() {
    return await this.messageRepository.find({
      relations: ['conversation'], 
      order: { createdAt: 'DESC' },
    });
  }
}