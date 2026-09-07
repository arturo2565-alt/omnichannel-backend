import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  CONVERSATION_LEAD_STATUSES,
  Conversation,
  isConversationLeadStatus,
} from './entities/conversation.entity';
import { LeadEventEntity } from './entities/lead-event.entity';

@Injectable()
export class LeadEventsService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Append-only: inserta el evento y proyecta `conversation.status`.
   */
  async logTransition(
    conversationId: string,
    newStatus: string,
    metadata?: Record<string, unknown> | null,
  ): Promise<LeadEventEntity> {
    const cid = String(conversationId ?? '').trim();
    if (!cid) {
      throw new BadRequestException('logTransition: conversationId vacío');
    }
    const status = String(newStatus ?? '').trim();
    if (!isConversationLeadStatus(status)) {
      throw new BadRequestException(
        `logTransition: status inválido "${status}". Permitidos: ${CONVERSATION_LEAD_STATUSES.join(', ')}`,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const conv = await manager.findOne(Conversation, { where: { id: cid } });
      if (!conv) {
        throw new NotFoundException(
          `logTransition: conversación no encontrada ${cid}`,
        );
      }

      const event = manager.create(LeadEventEntity, {
        conversationId: cid,
        status,
        metadata: metadata && typeof metadata === 'object' ? metadata : null,
      });
      const saved = await manager.save(event);
      await manager.update(Conversation, { id: cid }, { status });
      return saved;
    });
  }
}
