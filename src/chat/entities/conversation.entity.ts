import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { Message } from './chat.entity';
import { DraftQuoteEntity } from './draft-quote.entity';

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

  @Column({ default: 'open' }) // 'open' o 'closed'
  status: string;

  @OneToMany(() => Message, (message) => message.conversation)
  messages: Message[];

  @OneToMany(() => DraftQuoteEntity, (q) => q.conversation)
  draftQuotes: DraftQuoteEntity[];

  @UpdateDateColumn()
  lastMessageAt: Date;

  @Column({ nullable: true })
  lastMessage: string; // <--- Esta es la que lee el Sidebar
}