// En src/main.ts del backend
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // IMPORTANTE: Habilitar CORS antes del listen
  app.enableCors({
    origin: '*', // Esto permite que cualquier origen (como tu puerto 5173) entre
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  await app.listen(3000);
}
bootstrap();