import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setDefaultResultOrder } from 'node:dns'; // <--- 1. Importa esto

async function bootstrap() {
  // 2. FUERZA IPv4 antes de que cualquier otra cosa pase
  setDefaultResultOrder('ipv4first'); 

  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0'); 
  
  console.log(`🚀 Servidor en modo IPv4 listo en puerto: ${port}`);
}
bootstrap();