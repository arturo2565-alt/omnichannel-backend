import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 1. CONFIGURACIÓN DE CORS UNIFICADA
  // Mantenemos tus métodos permitidos y habilitamos para producción
  app.enableCors({
    origin: '*', // En producción puedes cambiarlo a tu dominio de React específico
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // 2. EL CAMBIO CLAVE PARA RAILWAY
  // Railway asigna un puerto dinámico mediante la variable de entorno PORT
  const port = process.env.PORT || 3000;
  
  // 3. ESCUCHAR EN '0.0.0.0'
  // Es vital para que los servicios de la nube puedan rutear el tráfico a tu contenedor
  await app.listen(port, '0.0.0.0'); 
  
  console.log(`🚀 Servidor listo y escuchando en el puerto: ${port}`);
}
bootstrap();