import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Taller } from '../../taller/entities/taller.entity';
import { AppointmentEntity } from './appointment.entity';
import { Contact } from './contact.entity';

/**
 * Importe efectivamente contratado. No es el cotizado y no escribe en CanonicalQuoteV1.
 */
@Entity('contracted_works')
@Unique(['appointmentId'])
export class ContractedWork {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Taller, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tallerId' })
  taller: Taller;

  @Index()
  @Column({ type: 'uuid' })
  tallerId: string;

  @ManyToOne(() => AppointmentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'appointmentId' })
  appointment: AppointmentEntity;

  @Column({ type: 'uuid' })
  appointmentId: string;

  @ManyToOne(() => Contact, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'contactId' })
  contact: Contact | null;

  @Column({ type: 'uuid', nullable: true })
  contactId: string | null;

  @Column({ type: 'uuid', nullable: true })
  conversationId: string | null;

  /** Foto del cotizado al momento de contratar. No alimenta ventas por sí sola. */
  @Column({ type: 'int', nullable: true })
  quotedAmountSnapshot: number | null;

  @Column({ type: 'int' })
  contractedAmount: number;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
