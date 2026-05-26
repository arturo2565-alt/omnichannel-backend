import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Taller } from './entities/taller.entity';
import { Conversation } from '../chat/entities/conversation.entity';
import { Message } from '../chat/entities/chat.entity';
import { Contact } from '../chat/entities/contact.entity';
import { DraftQuoteEntity } from '../chat/entities/draft-quote.entity';
import { PriceMatrix } from '../catalog/entities/price-matrix.entity';

/**
 * Asigna el primer taller registrado a filas legacy con `tallerId` NULL.
 */
@Injectable()
export class MultitenantBackfillService implements OnModuleInit {
  private readonly logger = new Logger(MultitenantBackfillService.name);

  constructor(
    @InjectRepository(Taller)
    private readonly tallerRepository: Repository<Taller>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(Contact)
    private readonly contactRepository: Repository<Contact>,
    @InjectRepository(DraftQuoteEntity)
    private readonly draftQuoteRepository: Repository<DraftQuoteEntity>,
    @InjectRepository(PriceMatrix)
    private readonly priceMatrixRepository: Repository<PriceMatrix>,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.SKIP_TENANT_BACKFILL === 'true') {
      this.logger.log('SKIP_TENANT_BACKFILL=true — backfill omitido.');
      return;
    }
    try {
      await this.backfillNullTallerIds();
    } catch (err) {
      this.logger.error('Backfill multitenant falló', err);
    }
  }

  async backfillNullTallerIds(): Promise<void> {
    const first = await this.tallerRepository.find({
      order: { createdAt: 'ASC' },
      take: 1,
    });
    const taller = first[0];
    if (!taller) {
      this.logger.warn(
        'Sin talleres en BD; omite backfill (registra uno con POST /auth/register).',
      );
      return;
    }

    const tallerId = taller.id;
    const updates: Array<Promise<unknown>> = [
      this.conversationRepository.update(
        { tallerId: IsNull() },
        { tallerId },
      ),
      this.messageRepository.update({ tallerId: IsNull() }, { tallerId }),
      this.contactRepository.update({ tallerId: IsNull() }, { tallerId }),
      this.draftQuoteRepository.update({ tallerId: IsNull() }, { tallerId }),
      this.priceMatrixRepository.update({ tallerId: IsNull() }, { tallerId }),
    ];
    const results = await Promise.all(updates);
    let total = 0;
    for (const r of results) {
      const affected =
        typeof r === 'object' && r && 'affected' in r
          ? Number((r as { affected?: number }).affected) || 0
          : 0;
      total += affected;
    }
    if (total > 0) {
      this.logger.log(
        `Backfill multitenant: ${total} fila(s) asignadas a taller "${taller.nombre}" (${tallerId}).`,
      );
    }
  }
}
