import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { DraftQuoteEntity } from './draft-quote.entity';

@Entity('draft_quote_change_logs')
export class DraftQuoteChangeLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => DraftQuoteEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'draftQuoteId' })
  draftQuote: DraftQuoteEntity;

  @Column({ type: 'uuid' })
  draftQuoteId: string;

  @Column({ type: 'uuid' })
  conversationId: string;

  @Column({ type: 'text' })
  triggerMessage: string;

  @Column({ type: 'jsonb', default: [] })
  extractedPieces: unknown;

  @Column({ type: 'jsonb', default: [] })
  resolvedCatalogCodes: unknown;

  @Column({ type: 'jsonb', default: [] })
  addedLines: unknown;

  @Column({ type: 'jsonb' })
  snapshotTotal: { subtotal: number; total: number };

  @Column({ type: 'text', nullable: true })
  clientMessageSent: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
