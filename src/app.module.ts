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
      ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
      
      extra: {
        // Configuraciones adicionales para evitar que la conexión se quede "colgada"
        ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : null,
        connectTimeoutMS: 10000, // 10 segundos de espera máxima
      },
    }),
    ChatModule,
  ],
})
export class AppModule {}