import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Conversation } from './conversation.entity';
import { Taller } from '../../taller/entities/taller.entity';
import type { DraftQuote } from '../autofix-config';
import type { VehiclePricingProfile } from '../../catalog/vehicle-pricing-profile';

/**
 * Daño único dentro del resultado de visión IA (analiza grupo de fotos sesión/conversación).
 * `urls_origen`: URLs de entrada que evidencian este daño / pieza (puede estar vacío en líneas manuales del panel).
 */
export interface DetectedDamageItem {
  pieza: string;
  severidad: string;
  descripcionTecnica: string;
  urls_origen: string[];
  /** Marca/modelo/año inferidos por visión multimodal (raíz JSON o cruce BPC). */
  vehiculoDetectado?: string;
  /** Copia del inventario antes de colapsar a BPC (solo en fila BPC). */
  inventarioVisualPrevio?: DetectedDamageItem[];
}

/** @deprecated usar DetectedDamageItem (descripcion → descripcionTecnica, urls_asociadas → urls_origen). */
export type DamageInventoryItem = DetectedDamageItem;

/** Resultado agregado del peritaje + cotización (AutoFix / visión multimodal). */
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
  /** Vehículo visto en fotos (campo `vehiculo_detectado` del JSON de visión). */
  vehiculoDetectado?: string;
  /** Baño de pintura: peritaje guardado, esperando marca/modelo antes de cotizar. */
  banioPinturaGate?: {
    solicitarModeloBanio: boolean;
    intencionBanioCompleto: boolean;
    resumenDanosVisuales: string;
    inventarioVisual: DetectedDamageItem[];
    guardadoEn: string;
  };
  /** Metadatos del carrito global (complemento post-aprobación, etc.). */
  quoteCartMeta?: {
    cartRole: 'primary' | 'complement';
    complementOfDraftId?: string;
    /** bpc = baño completo; piezas = repintado por panel. */
    pricingMode?: 'bpc' | 'piezas';
    /** Perfil vehicular para precios por tamaño + premium. */
    vehiclePricingProfile?: VehiclePricingProfile;
  };
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
  @ManyToOne(() => Conversation, (conversation) => conversation.messages, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  @Column({ nullable: true })
  conversationId: string;

  @ManyToOne(() => Taller, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'tallerId' })
  taller: Taller | null;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  tallerId: string | null;

  /** Análisis IA de daños (hojalatería / pintura) cuando el mensaje es una imagen */
  @Column({ type: 'jsonb', nullable: true })
  damageAnalysis: VehicleDamageAnalysis | null;

  /** Cotización borrador generada a partir del análisis + lista base de precios */
  @Column({ type: 'jsonb', nullable: true })
  draftQuote: DraftQuote | null;
}