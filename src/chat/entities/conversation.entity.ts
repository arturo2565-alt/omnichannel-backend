import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
  OneToMany,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { Message } from './chat.entity';
import { DraftQuoteEntity } from './draft-quote.entity';
import { Taller } from '../../taller/entities/taller.entity';
import { Contact } from './contact.entity';

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
@Unique(['tallerId', 'externalId'])
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Taller, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'tallerId' })
  taller: Taller | null;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  tallerId: string | null;

  @ManyToOne(() => Contact, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'contactId' })
  contact: Contact | null;

  @Column({ type: 'uuid', nullable: true })
  contactId: string | null;

  /** ID estable del contacto en el canal (PSID, wa_id, etc.). Único por taller. */
  @Column()
  externalId: string;

  @Column()
  contactName: string;

  /** Foto de perfil del PSID (Messenger / Graph `profile_pic`), si se obtuvo al crear el contacto. */
  @Column({ type: 'varchar', length: 2048, nullable: true })
  avatarUrl?: string | null;

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