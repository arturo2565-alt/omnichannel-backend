import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Taller } from '../../taller/entities/taller.entity';

/**
 * Celda de la matriz servicio × severidad (hojalatería / pintura / otros).
 * Tabla física: `price_matrix`. La columna en BD sigue siendo `pieza` (migración opcional a `servicio`).
 */
@Entity({ name: 'price_matrix' })
@Unique(['tallerId', 'servicio', 'severidad'])
export class PriceMatrix {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Taller, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'tallerId' })
  taller: Taller | null;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  tallerId: string | null;

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

  /**
   * Cotización inmediata (sin peritaje pesado): baños de pintura, cerámico, estética, etc.
   * Hojalatería clásica permanece en `false`.
   */
  @Column({ type: 'boolean', name: 'is_instant_service', default: false })
  isInstantService: boolean;
}
