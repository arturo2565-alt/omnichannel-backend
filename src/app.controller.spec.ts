import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  it('GET /api/health responde ok y staging cuando PEGAZUZ_ENV=staging', async () => {
    const previous = process.env.PEGAZUZ_ENV;
    process.env.PEGAZUZ_ENV = 'staging';
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer())
        .get('/api/health')
        .expect(200)
        .expect({ ok: true, staging: true });
    } finally {
      if (previous === undefined) delete process.env.PEGAZUZ_ENV;
      else process.env.PEGAZUZ_ENV = previous;
      await app.close();
    }
  });

  it('AppModule registra el controlador y el servicio del health check', () => {
    const source = readFileSync(join(process.cwd(), 'src/app.module.ts'), 'utf8');
    expect(source).toContain('controllers: [AppController, DebugController]');
    expect(source).toContain('providers: [AppService]');
  });
});
