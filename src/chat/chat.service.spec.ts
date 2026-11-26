jest.mock('@nestjs/bullmq', () => ({
  Processor: () => () => undefined,
  WorkerHost: class WorkerHost {},
  InjectQueue: () => () => undefined,
}));

jest.mock('bullmq', () => ({
  UnrecoverableError: class UnrecoverableError extends Error {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChatService } from './chat.service';
import { Message } from './entities/chat.entity';
import { Conversation } from './entities/conversation.entity';
import { Contact } from './entities/contact.entity';
import { DraftQuoteEntity } from './entities/draft-quote.entity';
import { DraftQuoteItem } from './entities/draft-quote-item.entity';
import { AppointmentEntity } from './entities/appointment.entity';
import { ChatGateway } from './chat.gateway';
import { AiConfigService } from './ai-config.service';
import { CatalogService } from '../catalog/catalog.service';
import { RefaccionMarketService } from './refaccion-market/refaccion-market.orchestrator';
import { TallerService } from '../taller/taller.service';
import { TwilioService } from './twilio.service';
import { QuoteCartService } from './quote-cart.service';
import { IncomingMessageProducer } from '../messaging-queue/incoming-message.producer';
import { OutgoingMessageProducer } from '../messaging-queue/outgoing-message.producer';
import { LeadEventsService } from './lead-events.service';

describe('ChatService', () => {
  let service: ChatService;
  const previousKey = process.env.OPENAI_API_KEY;

  beforeEach(async () => {
    if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = 'ensayo';
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: getRepositoryToken(Message), useValue: {} },
        { provide: getRepositoryToken(Conversation), useValue: {} },
        { provide: getRepositoryToken(Contact), useValue: {} },
        { provide: getRepositoryToken(DraftQuoteEntity), useValue: {} },
        { provide: getRepositoryToken(DraftQuoteItem), useValue: {} },
        { provide: getRepositoryToken(AppointmentEntity), useValue: {} },
        { provide: ChatGateway, useValue: {} },
        { provide: AiConfigService, useValue: {} },
        { provide: CatalogService, useValue: {} },
        { provide: RefaccionMarketService, useValue: {} },
        { provide: TallerService, useValue: {} },
        { provide: TwilioService, useValue: {} },
        { provide: QuoteCartService, useValue: {} },
        { provide: IncomingMessageProducer, useValue: {} },
        { provide: OutgoingMessageProducer, useValue: {} },
        { provide: LeadEventsService, useValue: {} },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
  });

  afterEach(() => {
    if (previousKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
