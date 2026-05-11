import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('ai_config')
export class AiConfigEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 128, unique: true })
  key: string;

  @Column({ type: 'text' })
  value: string;
}
