import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { isStagingRuntime } from './config/staging-guard';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('api/health')
  health(): { ok: true; staging: boolean } {
    return { ok: true, staging: isStagingRuntime() };
  }
}
