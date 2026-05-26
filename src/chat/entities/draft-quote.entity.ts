import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { Conversation } from './conversation.entity';
import { Message } from './chat.entity';
import type { VehicleDamageAnalysis } from './chat.entity';
import type { DraftQuote as DraftQuotePayload } from '../autofix-config';
import { DraftQuoteItem } from './draft-quote-item.entity';
import { Taller } from '../../taller/entities/taller.entity';

@Entity('draft_quotes')
export class DraftQuoteEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  @Column({ type: 'uuid' })
  conversationId: string;

  @ManyToOne(() => Taller, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'tallerId' })
  taller: Taller | null;

  @Column({ type: 'uuid', nullable: true })
  tallerId: string | null;

  @ManyToOne(() => Message, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'messageId' })
  message: Message | null;

  @Column({ type: 'uuid', nullable: true })
  messageId: string | null;

  @Column({ type: 'text' })
  imageUrl: string;

  @Column({ type: 'jsonb' })
  damageAnalysis: VehicleDamageAnalysis;

  /** Monto principal según catálogo `price_matrix` (servicio × severidad) */
  @Column({ type: 'int' })
  estimateAmount: number;

  @Column({ type: 'jsonb' })
  quotePayload: DraftQuotePayload;

  @Column({ default: 'PENDING_APPROVAL' })
  status: string;

  @CreateDateColumn()
  createdAt: Date;

  /** Líneas/piezas con precio persistente (alternativa/alineación con quotePayload.lines). */
  @OneToMany(() => DraftQuoteItem, (item) => item.draftQuote)
  items: DraftQuoteItem[];
}
