import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Conversation } from './conversation.entity';
import type { DraftQuote } from '../autofix-config';

/** Resultado de analyzeDamageImage (JSON estructurado) */
export interface VehicleDamageAnalysis {
  partesAfectadas: string[];
  severidadDelDano: string;
  descripcionTecnica: string;
}

@Entity()
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  content: string; // El texto del mensaje

  @Column()
  channelType: string; // 'whatsapp' | 'instagram' | 'tiktok'

  @Column()
  externalId: string; // El ID que nos da Facebook/TikTok para ese mensaje

  @Column({ default: 'inbound' })
  direction: string; // 'inbound' (recibido) o 'outbound' (enviado por ti)

  @CreateDateColumn()
  createdAt: Date;

  // Aquí luego conectaremos con el "Contacto"
  @Column({ nullable: true })
  senderName: string;
  @ManyToOne(() => Conversation, (conversation) => conversation.messages)
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  @Column({ nullable: true })
  conversationId: string;

  /** Análisis IA de daños (hojalatería / pintura) cuando el mensaje es una imagen */
  @Column({ type: 'jsonb', nullable: true })
  damageAnalysis: VehicleDamageAnalysis | null;

  /** Cotización borrador generada a partir del análisis + lista base de precios */
  @Column({ type: 'jsonb', nullable: true })
  draftQuote: DraftQuote | null;
}