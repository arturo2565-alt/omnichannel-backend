import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatModule } from './chat/chat.module';
import { Message } from './chat/entities/chat.entity';
import { Conversation } from './chat/entities/conversation.entity';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      // 1. URL DINÁMICA: Railway/Supabase nos darán el string completo de conexión
      url: process.env.DATABASE_URL || 'postgres://postgres:admin123@localhost:5432/respond_clone',
      
      // 2. ENTIDADES: 'autoLoadEntities' busca automáticamente Message y Conversation
      autoLoadEntities: true,
      
      // 3. SINCRONIZACIÓN: Útil en desarrollo/prototipos para crear tablas solas
      synchronize: true, 
      
      // 4. CONFIGURACIÓN SSL: Crucial para bases de datos en la nube (como Supabase o Railway DB)
      // rejectUnauthorized: false evita errores de certificado en conexiones seguras
      ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
    }),
    ChatModule,
  ],
})
export class AppModule {}
