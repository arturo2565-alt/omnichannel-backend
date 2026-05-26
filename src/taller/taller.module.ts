import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Taller } from './entities/taller.entity';
import { TallerService } from './taller.service';
import { MultitenantBackfillService } from './multitenant-backfill.service';
import { Conversation } from '../chat/entities/conversation.entity';
import { Message } from '../chat/entities/chat.entity';
import { Contact } from '../chat/entities/contact.entity';
import { DraftQuoteEntity } from '../chat/entities/draft-quote.entity';
import { PriceMatrix } from '../catalog/entities/price-matrix.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Taller,
      Conversation,
      Message,
      Contact,
      DraftQuoteEntity,
      PriceMatrix,
    ]),
  ],
  providers: [TallerService, MultitenantBackfillService],
  exports: [TallerService, TypeOrmModule],
})
export class TallerModule {}
