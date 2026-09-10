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

export enum RefaccionCategoria {
  OPTICA = 'OPTICA',
  COLISION = 'COLISION',
  ILUMINACION = 'ILUMINACION',
  PLASTICO = 'PLASTICO',
}

/**
 * Catálogo de refacciones y ópticas por taller (costo base + margen).
 * Tabla física: `refaccion_catalog`.
 */
@Entity({ name: 'refaccion_catalog' })
@Unique(['tallerId', 'codigo'])
export class RefaccionCatalog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Taller, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'tallerId' })
  taller: Taller;

  @Column({ type: 'uuid' })
  @Index()
  tallerId: string;

  /** Código interno, p. ej. FARO_IZQ, CAL_DER, MOLD_FD. */
  @Column({ type: 'varchar', length: 48 })
  @Index()
  codigo: string;

  @Column({ type: 'varchar', length: 160 })
  nombre: string;

  @Column({ type: 'varchar', length: 24 })
  categoria: RefaccionCategoria;

  /** Costo de referencia de la pieza nueva (MXN). */
  @Column({ type: 'int', name: 'costo_referencia_base' })
  costoReferenciaBase: number;

  /** Margen del taller sobre el costo base (porcentaje entero). */
  @Column({ type: 'int', name: 'margen_porcentaje', default: 30 })
  margenPorcentaje: number;
}
