import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatModule } from './chat/chat.module';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      // Priorizamos la URL de la nube, si no existe usamos la local
      url: process.env.DATABASE_URL,
      
      autoLoadEntities: true,
      synchronize: true, // Mantenlo en true para que cree las tablas en Supabase solo
      
      // CONFIGURACIÓN DE CONEXIÓN ROBUSTA
      // Solo activamos SSL si existe DATABASE_URL (estamos en la nube)
      ssl: false,
    }),
    ChatModule,
  ],
})
export class AppModule {}