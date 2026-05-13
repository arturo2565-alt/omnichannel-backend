import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Celda de la matriz servicio × severidad (hojalatería / pintura / otros).
 * Tabla física: `price_matrix`. La columna en BD sigue siendo `pieza` (migración opcional a `servicio`).
 */
@Entity({ name: 'price_matrix' })
@Unique(['servicio', 'severidad'])
export class PriceMatrix {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Nombre del servicio o pieza en catálogo (columna BD: `pieza`). */
  @Column({ type: 'varchar', length: 120, name: 'pieza' })
  @Index()
  servicio: string;

  @Column({ type: 'varchar', length: 32 })
  severidad: string;

  @Column({ type: 'int' })
  precio: number;

  /** Días hábiles orientativos de entrega para esta celda (no existía en la matriz JS). */
  @Column({ type: 'int', name: 'dias_entrega' })
  diasEntrega: number;
}
