import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { Conversation } from './conversation.entity';
import { Taller } from '../../taller/entities/taller.entity';
import { Contact } from './contact.entity';

export type AppointmentStatus =
  | 'pendiente'
  | 'confirmada'
  | 'finalizada'
  | 'cancelada'
  | 'no_asistio';

export type AppointmentSource = 'manual' | 'autopilot';

@Entity('appointments')
@Index('UQ_appointments_client_request', ['tallerId', 'clientRequestId'], {
  unique: true,
  where: '"clientRequestId" IS NOT NULL',
})
export class AppointmentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Conversación asociada (para «Ver chat»). Nula en citas capturadas a mano. */
  @Column({ type: 'uuid', nullable: true })
  conversationId: string | null;

  @ManyToOne(() => Conversation, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation | null;

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

  @Column({ type: 'text' })
  clientName: string;

  /** Modelo / descripción si se detectó (ej. desde IA o notas). */
  @Column({ type: 'text', nullable: true })
  vehicle: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  vehicleMake: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  vehicleModel: string | null;

  @Column({ type: 'int', nullable: true })
  vehicleYear: number | null;

  /** Para botón Llamar (opcional). */
  @Column({ type: 'varchar', length: 32, nullable: true })
  phone: string | null;

  /** Resumen / total de la cotización activa al agendar. Texto, no métrica de venta. */
  @Column({ type: 'text', nullable: true })
  quoteSummary: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  serviceRequested: string | null;

  /** Cotizado manual. No alimenta ventasGeneradas ni CanonicalQuoteV1. */
  @Column({ type: 'int', nullable: true })
  quotedAmount: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  origin: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  source: AppointmentSource | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  clientRequestId: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @Column({ type: 'timestamptz' })
  scheduledAt: Date;

  @Column({ type: 'varchar', length: 24, default: 'pendiente' })
  status: AppointmentStatus;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
