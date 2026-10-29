import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Taller } from '../../taller/entities/taller.entity';
import { AppointmentEntity } from './appointment.entity';

/**
 * Concepto cotizado de una cita CRM. Importes en centavos enteros.
 * No escribe en CanonicalQuoteV1 ni en lead_events.
 */
@Entity('appointment_service_lines')
@Index('IDX_service_lines_taller_name', ['tallerId', 'name'])
export class AppointmentServiceLine {
  @PrimaryColumn('uuid')
  id: string;

  @ManyToOne(() => AppointmentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'appointmentId' })
  appointment: AppointmentEntity;

  @Index()
  @Column({ type: 'uuid' })
  appointmentId: string;

  @ManyToOne(() => Taller, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tallerId' })
  taller: Taller;

  @Column({ type: 'uuid' })
  tallerId: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'int' })
  quantityHundredths: number;

  @Column({ type: 'int' })
  unitPriceCents: number;

  @Column({ type: 'int' })
  subtotalCents: number;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
