import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Conversation } from './conversation.entity';
import type { DraftQuote } from '../autofix-config';

/**
 * Daño único dentro del resultado de visión IA (analiza grupo de fotos sesión/conversación).
 * `urls_origen`: URLs de entrada que evidencian este daño / pieza.
 */
export interface DetectedDamageItem {
  pieza: string;
  severidad: string;
  descripcionTecnica: string;
  urls_origen: string[];
}

/** @deprecated usar DetectedDamageItem (descripcion → descripcionTecnica, urls_asociadas → urls_origen). */
export type DamageInventoryItem = DetectedDamageItem;

/** Resultado agregado del peritaje + cotización (AutoFix / gpt-4o). */
export interface VehicleDamageAnalysis {
  /** Pieza principal (p. ej. Fascia, Puerta, Cofre) */
  pieza: string;
  /** Código exacto: DL | DML | DM | DMF | DF | DMFuerte */
  severidad: string;
  descripcionTecnica: string;
  justificacion: string;
  /** Lista para cotización; suele incluir al menos `pieza` */
  partesAfectadas: string[];
  /** Etiqueta legible o mismo código que `severidad` (compatibilidad) */
  severidadDelDano: string;
  /** Daños consolidados sobre el grupo de imágenes de la sesión. */
  inventory?: DetectedDamageItem[];
}

@Entity()
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  content: string; // El texto del mensaje

  @Column()
  channelType: string; // 'whatsapp' | 'instagram' | 'tiktok'

  @Column()
  externalId: string; // El ID que nos da Facebook/TikTok para ese mensaje

  @Column({ default: 'inbound' })
  direction: string; // 'inbound' (recibido) o 'outbound' (enviado por ti)

  @CreateDateColumn()
  createdAt: Date;

  // Aquí luego conectaremos con el "Contacto"
  @Column({ nullable: true })
  senderName: string;
  @ManyToOne(() => Conversation, (conversation) => conversation.messages)
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  @Column({ nullable: true })
  conversationId: string;

  /** Análisis IA de daños (hojalatería / pintura) cuando el mensaje es una imagen */
  @Column({ type: 'jsonb', nullable: true })
  damageAnalysis: VehicleDamageAnalysis | null;

  /** Cotización borrador generada a partir del análisis + lista base de precios */
  @Column({ type: 'jsonb', nullable: true })
  draftQuote: DraftQuote | null;
}