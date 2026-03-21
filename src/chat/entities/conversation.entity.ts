import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { Message } from './chat.entity';

@Entity()
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  externalId: string; // El ID que viene de WhatsApp o Instagram

  @Column()
  contactName: string;

  @Column({ default: 'open' }) // 'open' o 'closed'
  status: string;

  @OneToMany(() => Message, (message) => message.conversation)
  messages: Message[];

  @UpdateDateColumn()
  lastMessageAt: Date;
}