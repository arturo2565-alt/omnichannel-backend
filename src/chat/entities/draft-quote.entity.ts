import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Conversation } from './conversation.entity';
import { Message } from './chat.entity';
import type { VehicleDamageAnalysis } from './chat.entity';
import type { DraftQuote as DraftQuotePayload } from '../autofix-config';

@Entity('draft_quotes')
export class DraftQuoteEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  @Column({ type: 'uuid' })
  conversationId: string;

  @ManyToOne(() => Message, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'messageId' })
  message: Message | null;

  @Column({ type: 'uuid', nullable: true })
  messageId: string | null;

  @Column({ type: 'text' })
  imageUrl: string;

  @Column({ type: 'jsonb' })
  damageAnalysis: VehicleDamageAnalysis;

  /** Monto principal según `calculateEstimate` (matriz pieza × severidad) */
  @Column({ type: 'int' })
  estimateAmount: number;

  @Column({ type: 'jsonb' })
  quotePayload: DraftQuotePayload;

  @Column({ default: 'PENDING_APPROVAL' })
  status: string;

  @CreateDateColumn()
  createdAt: Date;
}
