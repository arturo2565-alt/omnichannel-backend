import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
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
}
