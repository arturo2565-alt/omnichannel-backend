import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { DraftQuoteEntity } from './draft-quote.entity';

@Entity('draft_quote_items')
export class DraftQuoteItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => DraftQuoteEntity, (dq) => dq.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'draftQuoteId' })
  draftQuote: DraftQuoteEntity;

  @Column({ type: 'uuid' })
  draftQuoteId: string;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  /** Etiqueta o nombre de pieza en el inventario IA / matriz. */
  @Column({ type: 'text' })
  pieza: string;

  /** Código AutoFix (DL … DMFuerte). */
  @Column({ type: 'varchar', length: 32 })
  severidad: string;

  /** Importe línea MXN aplicado en la cotización. */
  @Column({ type: 'int' })
  precioMx: number;

  @Column({ type: 'text', nullable: true })
  descripcionTecnica: string | null;

  /** Fotos evidencia enlazadas a esta pieza/línea. */
  @Column({ type: 'jsonb', nullable: true })
  urlsOrigen: string[] | null;

  /** Servicio canónico en price_matrix (p. ej. Fascia, Puerta). */
  @Column({ type: 'varchar', length: 128, nullable: true })
  catalogServicio: string | null;

  /** Nombre legible para panel (p. ej. Fascia trasera). */
  @Column({ type: 'varchar', length: 256, nullable: true })
  nombreVisible: string | null;

  /** Precio oficial de catálogo al crear/actualizar la línea. */
  @Column({ type: 'int', nullable: true })
  precioOficial: number | null;

  /** Precio final editable (alias operativo de precioMx). */
  @Column({ type: 'int', nullable: true })
  precioFinal: number | null;

  /** texto_cliente | vision | manual | ai_suggestion */
  @Column({ type: 'varchar', length: 32, default: 'vision' })
  fuente: string;

  /** Texto de evidencia (foto URL o declarado por cliente). */
  @Column({ type: 'text', nullable: true })
  evidencia: string | null;

  @Column({ type: 'float', nullable: true })
  confidence: number | null;

  @Column({ type: 'text', nullable: true })
  notasInternas: string | null;

  @Column({
    type: 'varchar',
    length: 64,
    default: 'pendiente_revision_fisica',
  })
  estadoRevision: string;

  @CreateDateColumn()
  lineCreatedAt: Date;
}
