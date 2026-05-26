import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Taller } from '../../taller/entities/taller.entity';

export const USER_ROLES = ['owner', 'admin', 'agent'] as const;
export type UserRole = (typeof USER_ROLES)[number];

@Entity('users')
@Unique(['email'])
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 255, name: 'password_hash' })
  passwordHash: string;

  @ManyToOne(() => Taller, (taller) => taller.users, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tallerId' })
  taller: Taller;

  @Column({ type: 'uuid' })
  tallerId: string;

  @Column({ type: 'varchar', length: 32, default: 'agent' })
  role: UserRole;

  @CreateDateColumn()
  createdAt: Date;
}
