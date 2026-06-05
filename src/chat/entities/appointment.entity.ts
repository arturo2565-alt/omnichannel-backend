import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Conversation } from './conversation.entity';
import { DraftQuoteEntity } from './draft-quote.entity';

export type AppointmentStatus = 'pendiente' | 'confirmada' | 'finalizada';

@Entity('appointments')
export class AppointmentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Conversación asociada (para «Ver chat»). */
  @Column({ type: 'uuid', nullable: true })
  conversationId: string | null;

  @ManyToOne(() => Conversation, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation | null;

  @Column({ type: 'text' })
  clientName: string;

  /** Modelo / descripción si se detectó (ej. desde IA o notas). */
  @Column({ type: 'text', nullable: true })
  vehicle: string | null;

  /** Para botón Llamar (opcional). */
  @Column({ type: 'varchar', length: 32, nullable: true })
  phone: string | null;

  @Column({ type: 'timestamptz' })
  scheduledAt: Date;

  @Column({ type: 'varchar', length: 24, default: 'pendiente' })
  status: AppointmentStatus;

  @Column({ type: 'uuid', nullable: true })
  draftQuoteId: string | null;

  @ManyToOne(() => DraftQuoteEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'draftQuoteId' })
  draftQuote: DraftQuoteEntity | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
