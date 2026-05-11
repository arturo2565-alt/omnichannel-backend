import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiConfigEntity } from './entities/ai-config.entity';
import { AI_CONFIG_DEFAULT_SEED } from './ai-config-defaults';
import { AI_CONFIG_KEYS, type AiConfigKey } from './ai-config-keys';

function fallbackValueForKey(key: string): string | null {
  const hit = AI_CONFIG_DEFAULT_SEED.find((r) => r.key === key);
  return hit?.value ?? null;
}

@Injectable()
export class AiConfigService implements OnModuleInit {
  constructor(
    @InjectRepository(AiConfigEntity)
    private readonly repo: Repository<AiConfigEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedDefaultsIfMissing();
  }

  /** Inserta prompts por defecto solo si la clave aún no existe. */
  private async seedDefaultsIfMissing(): Promise<void> {
    for (const { key, value } of AI_CONFIG_DEFAULT_SEED) {
      const exists = await this.repo.exist({ where: { key } });
      if (exists) continue;
      await this.repo.save(this.repo.create({ key, value }));
    }
  }

  /**
   * Devuelve el texto guardado para `key`, o el valor embebido por defecto
   * si aún no hay fila o está vacío (claves conocidas).
   */
  async getValue(key: AiConfigKey | string): Promise<string> {
    const row = await this.repo.findOne({ where: { key } });
    const stored = row?.value != null ? String(row.value).trim() : '';
    if (stored.length > 0) return row!.value;
    return fallbackValueForKey(key) ?? '';
  }

  async setValue(key: string, value: string): Promise<AiConfigEntity> {
    let row = await this.repo.findOne({ where: { key } });
    if (!row) {
      row = this.repo.create({ key, value });
    } else {
      row.value = value;
    }
    return await this.repo.save(row);
  }

  /** Payload para el panel /admin/ai-settings */
  async getAdminAiSettings(): Promise<{
    visionPrompt: string;
    chatAppointmentPrompt: string;
    businessMapsUrl: string;
    businessPhone: string;
    businessHours: string;
  }> {
    const [
      visionPrompt,
      chatAppointmentPrompt,
      businessMapsUrl,
      businessPhone,
      businessHours,
    ] = await Promise.all([
      this.getValue(AI_CONFIG_KEYS.DEFAULT_VISION_PROMPT),
      this.getValue(AI_CONFIG_KEYS.DEFAULT_CHAT_APPOINTMENT_PROMPT),
      this.getValue(AI_CONFIG_KEYS.BUSINESS_MAPS_URL),
      this.getValue(AI_CONFIG_KEYS.BUSINESS_PHONE),
      this.getValue(AI_CONFIG_KEYS.BUSINESS_HOURS),
    ]);
    return {
      visionPrompt,
      chatAppointmentPrompt,
      businessMapsUrl,
      businessPhone,
      businessHours,
    };
  }

  async saveAdminAiSettings(body: {
    visionPrompt: string;
    chatAppointmentPrompt: string;
    businessMapsUrl: string;
    businessPhone: string;
    businessHours: string;
  }): Promise<void> {
    await Promise.all([
      this.setValue(AI_CONFIG_KEYS.DEFAULT_VISION_PROMPT, body.visionPrompt),
      this.setValue(
        AI_CONFIG_KEYS.DEFAULT_CHAT_APPOINTMENT_PROMPT,
        body.chatAppointmentPrompt,
      ),
      this.setValue(AI_CONFIG_KEYS.BUSINESS_MAPS_URL, body.businessMapsUrl),
      this.setValue(AI_CONFIG_KEYS.BUSINESS_PHONE, body.businessPhone),
      this.setValue(AI_CONFIG_KEYS.BUSINESS_HOURS, body.businessHours),
    ]);
  }
}
