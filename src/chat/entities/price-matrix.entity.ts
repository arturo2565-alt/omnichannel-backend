import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Celda editable del catálogo pieza × severidad (precio y tiempo de entrega).
 */
@Entity('price_matrix')
@Index('UQ_price_matrix_pieza_severidad', ['pieza', 'severidad'], { unique: true })
export class PriceMatrixEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 160 })
  pieza: string;

  @Column({ type: 'varchar', length: 32 })
  severidad: string;

  @Column({ type: 'int' })
  precio: number;

  @Column({ type: 'int', default: 4 })
  diasEntrega: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
