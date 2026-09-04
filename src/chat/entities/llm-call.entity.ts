import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('llm_calls')
export class LlmCall {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  tallerId: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  conversationId: string | null;

  @Column({ type: 'varchar', length: 64, default: 'openai' })
  provider: string;

  @Column({ type: 'varchar', length: 128 })
  model: string;

  /** p. ej. vision_peritaje | orchestrator | narrative | fast_path_eval | playground */
  @Column({ type: 'varchar', length: 64 })
  purpose: string;

  @Column({ type: 'int', default: 0 })
  promptTokens: number;

  @Column({ type: 'int', default: 0 })
  completionTokens: number;

  @Column({ type: 'int', default: 0 })
  totalTokens: number;

  @Column({ type: 'int', default: 0 })
  cachedTokens: number;

  @Column({ type: 'numeric', precision: 10, scale: 6, default: 0 })
  estimatedCostUsd: string;

  @Column({ type: 'int', default: 0 })
  durationMs: number;

  @Index()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
