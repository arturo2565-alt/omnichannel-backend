import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Matriz de precios (pieza × severidad). Migración desde valores que vivían en código.
 */
@Entity('price_matrix')
@Index(['pieza', 'severidad'], { unique: true })
export class PriceMatrix {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 128 })
  pieza: string;

  @Column({ type: 'varchar', length: 32 })
  severidad: string;

  @Column({ type: 'double precision' })
  precio: number;

  /** Días hábiles orientativos de entrega para esa línea (no existía en la matriz en código). */
  @Column({ type: 'int', name: 'dias_entrega' })
  diasEntrega: number;
}
