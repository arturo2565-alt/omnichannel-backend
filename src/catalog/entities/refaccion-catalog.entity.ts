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
 * Diccionario legacy por taller. Ya NO es fuente de precio en CANONICAL.
 *
 * Fase 1: el Quote Engine no lee costo/margen.
 * Fase 3: cleanup de columnas financieras cuando no quede dependencia histórica.
 *
 * Tabla física: `refaccion_catalog`.
 *
 * @deprecated LEGACY_ONLY — conservar filas históricas; no usar para cotizar.
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

  /** @deprecated LEGACY_ONLY — no es fuente CANONICAL. Columna: costo_referencia_base */
  @Column({ type: 'int', name: 'costo_referencia_base' })
  costoReferenciaBase: number;

  /** @deprecated LEGACY_ONLY — no es fuente CANONICAL. Columna: margen_porcentaje */
  @Column({ type: 'int', name: 'margen_porcentaje', default: 30 })
  margenPorcentaje: number;
}
