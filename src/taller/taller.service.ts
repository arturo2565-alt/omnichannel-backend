import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Taller } from './entities/taller.entity';

@Injectable()
export class TallerService {
  constructor(
    @InjectRepository(Taller)
    private readonly tallerRepository: Repository<Taller>,
  ) {}

  /** Resuelve el taller dueño de una página de Meta (webhook Messenger/Instagram). */
  async findByMetaPageId(pageId: string): Promise<Taller | null> {
    const id = String(pageId ?? '').trim();
    if (!id) return null;
    return this.tallerRepository.findOne({ where: { metaPageId: id } });
  }

  async findByMetaPageIdOrThrow(pageId: string): Promise<Taller> {
    const taller = await this.findByMetaPageId(pageId);
    if (!taller) {
      throw new NotFoundException(
        `No hay taller registrado con metaPageId=${pageId}. Configúralo en el registro del taller.`,
      );
    }
    return taller;
  }

  /** Primer taller creado (fallback webhook / datos legacy). */
  async findDefaultTaller(): Promise<Taller> {
    const rows = await this.tallerRepository.find({
      order: { createdAt: 'ASC' },
      take: 1,
    });
    const taller = rows[0];
    if (!taller) {
      throw new ServiceUnavailableException(
        'No hay talleres registrados. Crea uno con POST /auth/register.',
      );
    }
    return taller;
  }

  async findDefaultTallerId(): Promise<string> {
    return (await this.findDefaultTaller()).id;
  }

  /**
   * Webhook Meta: pageId → taller; si no hay match, primer taller (AutoFix de prueba).
   */
  async resolveTallerIdForWebhook(pageId?: string): Promise<string> {
    const trimmed = String(pageId ?? '').trim();
    if (trimmed) {
      const match = await this.findByMetaPageId(trimmed);
      if (match) return match.id;
    }
    return this.findDefaultTallerId();
  }
}
