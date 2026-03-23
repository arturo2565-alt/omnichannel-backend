import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Conversation } from './conversation.entity';

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
}