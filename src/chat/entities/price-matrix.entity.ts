import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('price_matrix')
@Index(['pieza', 'severidad'], { unique: true })
export class PriceMatrixEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 160 })
  pieza: string;

  @Column({ type: 'varchar', length: 32 })
  severidad: string;

  @Column({ type: 'double precision' })
  precio: number;

  @Column({ type: 'int', default: 4 })
  diasEntrega: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
