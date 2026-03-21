import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatModule } from './chat/chat.module';
import { Message } from './chat/entities/chat.entity';
import { Conversation } from './chat/entities/conversation.entity';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      // 1. Usamos la URL de conexión de las variables de entorno (Railway/Supabase)
      // Si no existe, puedes dejar el string local como respaldo para desarrollo
      url: process.env.DATABASE_URL || 'postgres://postgres:admin123@localhost:5432/respond_clone',
      
      // 2. Cargamos las entidades automáticamente sin listarlas una por una
      autoLoadEntities: true,
      
      // 3. Sincronización automática de tablas (Cuidado en producción real, pero ideal para prototipos)
      synchronize: true, 
      
      // 4. Configuración de Seguridad SSL (Crítica para la nube)
      ssl: true,
      extra: {
        ssl: {
          rejectUnauthorized: false, // Permite certificados autofirmados comunes en bases de datos gestionadas
        },
      },
    }),
    ChatModule,
  ],
})
export class AppModule {}
