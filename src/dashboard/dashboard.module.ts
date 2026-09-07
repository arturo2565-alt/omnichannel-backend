import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Conversation } from '../chat/entities/conversation.entity';
import { LeadEventEntity } from '../chat/entities/lead-event.entity';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([Conversation, LeadEventEntity]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
