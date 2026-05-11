import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { Message } from './chat.entity';
import { DraftQuoteEntity } from './draft-quote.entity';

/** Estados de lead admitidos para `Conversation.status`. */
export const CONVERSATION_LEAD_STATUSES = [
  'nuevo',
  'por_cotizar',
  'cotizado',
  'agendado',
] as const;

export type ConversationLeadStatus =
  (typeof CONVERSATION_LEAD_STATUSES)[number];

@Entity()
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  externalId: string; // El ID que viene de WhatsApp o Instagram

  @Column()
  contactName: string;

  @Column({ type: 'character varying', nullable: true })
  platform?: string | null; // 'whatsapp' | 'instagram' | etc.

  /** Lead: nuevo → por_cotizar (IA + borrador) → cotizado (envío cotización) → agendado (manual / futuro). */
  @Column({ type: 'varchar', length: 32, default: 'nuevo' })
  status: string;

  /** Si es true, mensajes entrantes de texto reciben respuesta automática de IA; se desactiva al generarse un borrador de cotización. */
  @Column({ type: 'boolean', default: true })
  isAutoPilotActive: boolean;

  @OneToMany(() => Message, (message) => message.conversation)
  messages: Message[];

  @OneToMany(() => DraftQuoteEntity, (q) => q.conversation)
  draftQuotes: DraftQuoteEntity[];

  @UpdateDateColumn()
  lastMessageAt: Date;

  @Column({ nullable: true })
  lastMessage: string; // <--- Esta es la que lee el Sidebar
}