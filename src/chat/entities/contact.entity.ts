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

/**
 * Contacto del canal (PSID, wa_id, etc.) aislado por taller.
 * La conversación activa sigue en {@link Conversation}; este registro centraliza el contacto por tenant.
 */
@Entity('contacts')
@Unique(['tallerId', 'externalId'])
export class Contact {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Taller, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tallerId' })
  taller: Taller;

  @Column({ type: 'uuid' })
  @Index()
  tallerId: string;

  /** ID estable del contacto en el canal (PSID, wa_id, etc.). */
  @Column({ type: 'varchar', length: 128 })
  externalId: string;

  @Column({ type: 'varchar', length: 255 })
  contactName: string;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  avatarUrl: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  platform: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
