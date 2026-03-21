import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatModule } from './chat/chat.module';
import { Message } from './chat/entities/chat.entity';
import { Conversation } from './chat/entities/conversation.entity';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      username: 'postgres', // <--- CAMBIA ESTO
      password: 'admin123',            // <--- CAMBIA ESTO
      database: 'respond_clone',
      entities: [Message, Conversation],
      synchronize: true, // Esto crea las tablas automáticamente (solo para desarrollo)
    }),
    ChatModule,
  ],
})
export class AppModule {}
