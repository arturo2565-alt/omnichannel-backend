import { User } from '../auth/entities/user.entity';
import { CatalogPricingRulesEntity } from '../catalog/entities/catalog-pricing-rules.entity';
import { PriceMatrix } from '../catalog/entities/price-matrix.entity';
import { RefaccionCatalog } from '../catalog/entities/refaccion-catalog.entity';
import { AiConfigEntity } from '../chat/entities/ai-config.entity';
import { AppointmentServiceLine } from '../chat/entities/appointment-service-line.entity';
import { AppointmentEntity } from '../chat/entities/appointment.entity';
import { Message } from '../chat/entities/chat.entity';
import { Contact } from '../chat/entities/contact.entity';
import { ContractedWork } from '../chat/entities/contracted-work.entity';
import { Conversation } from '../chat/entities/conversation.entity';
import { DraftQuoteItem } from '../chat/entities/draft-quote-item.entity';
import { DraftQuoteEntity } from '../chat/entities/draft-quote.entity';
import { LeadEventEntity } from '../chat/entities/lead-event.entity';
import { LlmCall } from '../chat/entities/llm-call.entity';
import { Taller } from '../taller/entities/taller.entity';

/** Entidades que Nest carga. El bootstrap de staging usa esta misma lista. */
export const TYPEORM_ENTITIES = [
  Taller,
  User,
  Message,
  Conversation,
  Contact,
  DraftQuoteEntity,
  DraftQuoteItem,
  AppointmentEntity,
  AppointmentServiceLine,
  ContractedWork,
  AiConfigEntity,
  LlmCall,
  LeadEventEntity,
  PriceMatrix,
  CatalogPricingRulesEntity,
  RefaccionCatalog,
];
