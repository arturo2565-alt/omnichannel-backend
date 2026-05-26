import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity';

@Entity('talleres')
export class Taller {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 200 })
  nombre: string;

  /**
   * ID de página de Meta (Messenger / Instagram) para enrutar webhooks entrantes.
   * Único cuando está registrado.
   */
  @Column({ type: 'varchar', length: 64, nullable: true, unique: true })
  metaPageId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @OneToMany(() => User, (user) => user.taller)
  users: User[];
}
