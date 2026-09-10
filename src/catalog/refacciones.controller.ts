import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RefaccionesService } from './refacciones.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

@Controller('catalog/refacciones')
@UseGuards(JwtAuthGuard)
export class RefaccionesController {
  constructor(private readonly refaccionesService: RefaccionesService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    const rows = await this.refaccionesService.findAll(user.tallerId);
    return { ok: true, count: rows.length, rows };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: {
      codigo?: unknown;
      nombre?: unknown;
      categoria?: unknown;
      costoReferenciaBase?: unknown;
      margenPorcentaje?: unknown;
    },
  ) {
    const row = await this.refaccionesService.create(user.tallerId, body ?? {});
    return { ok: true, row };
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body()
    body: {
      codigo?: unknown;
      nombre?: unknown;
      categoria?: unknown;
      costoReferenciaBase?: unknown;
      margenPorcentaje?: unknown;
    },
  ) {
    const row = await this.refaccionesService.update(
      user.tallerId,
      id,
      body ?? {},
    );
    return { ok: true, row };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    await this.refaccionesService.remove(user.tallerId, id);
    return { ok: true };
  }
}
