import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Celda de la matriz pieza × severidad (hojalatería / pintura).
 * Tabla física: `price_matrix`.
 */
@Entity({ name: 'price_matrix' })
@Unique(['pieza', 'severidad'])
export class PriceMatrix {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 120 })
  @Index()
  pieza: string;

  @Column({ type: 'varchar', length: 32 })
  severidad: string;

  @Column({ type: 'int' })
  precio: number;

  /** Días hábiles orientativos de entrega para esta celda (no existía en la matriz JS). */
  @Column({ type: 'int', name: 'dias_entrega' })
  diasEntrega: number;
}
