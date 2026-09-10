import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  RefaccionCatalog,
  RefaccionCategoria,
} from './entities/refaccion-catalog.entity';
import { precioSugeridoAlCliente } from './refaccion-catalog-pricing';
import { REFACCION_CATALOG_DEFAULTS } from './refacciones.defaults';
import { refaccionCatalogCodigoForPieza } from './panel-pieza-catalog';

export type RefaccionCatalogDto = {
  id: string;
  codigo: string;
  nombre: string;
  categoria: RefaccionCategoria;
  costoReferenciaBase: number;
  margenPorcentaje: number;
  precioSugerido: number;
  forzarPrecioManual: boolean;
};

export type RefaccionCatalogQuote = {
  codigo: string;
  nombre: string;
  costoReferenciaBase: number;
  margenPorcentaje: number;
  precioAlCliente: number;
  fuente: 'catalogo';
};

const CATEGORIAS = new Set<string>(Object.values(RefaccionCategoria));

@Injectable()
export class RefaccionesService {
  constructor(
    @InjectRepository(RefaccionCatalog)
    private readonly repo: Repository<RefaccionCatalog>,
  ) {}

  toDto(row: RefaccionCatalog): RefaccionCatalogDto {
    const costo = Math.max(0, Math.round(Number(row.costoReferenciaBase) || 0));
    const margen = Number.isFinite(Number(row.margenPorcentaje))
      ? Math.round(Number(row.margenPorcentaje))
      : 30;
    return {
      id: row.id,
      codigo: row.codigo,
      nombre: row.nombre,
      categoria: row.categoria,
      costoReferenciaBase: costo,
      margenPorcentaje: margen,
      precioSugerido: precioSugeridoAlCliente(costo, margen),
      forzarPrecioManual: Boolean(row.forzarPrecioManual),
    };
  }

  async findAll(tallerId: string): Promise<RefaccionCatalogDto[]> {
    await this.ensureDefaults(tallerId);
    const rows = await this.repo.find({
      where: { tallerId },
      order: { categoria: 'ASC', codigo: 'ASC' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async create(
    tallerId: string,
    input: {
      codigo?: unknown;
      nombre?: unknown;
      categoria?: unknown;
      costoReferenciaBase?: unknown;
      margenPorcentaje?: unknown;
      forzarPrecioManual?: unknown;
    },
  ): Promise<RefaccionCatalogDto> {
    const parsed = this.parseWriteInput(input, { requireCodigo: true });
    const exists = await this.repo.findOne({
      where: { tallerId, codigo: parsed.codigo },
    });
    if (exists) {
      throw new ConflictException(
        `Ya existe la refacción ${parsed.codigo} en tu catálogo.`,
      );
    }
    const row = this.repo.create({
      tallerId,
      codigo: parsed.codigo,
      nombre: parsed.nombre,
      categoria: parsed.categoria,
      costoReferenciaBase: parsed.costoReferenciaBase,
      margenPorcentaje: parsed.margenPorcentaje,
      forzarPrecioManual: parsed.forzarPrecioManual,
    });
    return this.toDto(await this.repo.save(row));
  }

  async update(
    tallerId: string,
    id: string,
    input: {
      codigo?: unknown;
      nombre?: unknown;
      categoria?: unknown;
      costoReferenciaBase?: unknown;
      margenPorcentaje?: unknown;
      forzarPrecioManual?: unknown;
    },
  ): Promise<RefaccionCatalogDto> {
    const row = await this.repo.findOne({ where: { id, tallerId } });
    if (!row) throw new NotFoundException('Refacción no encontrada.');
    const parsed = this.parseWriteInput(input, { requireCodigo: false });
    if (parsed.codigo && parsed.codigo !== row.codigo) {
      const clash = await this.repo.findOne({
        where: { tallerId, codigo: parsed.codigo },
      });
      if (clash && clash.id !== row.id) {
        throw new ConflictException(
          `Ya existe la refacción ${parsed.codigo} en tu catálogo.`,
        );
      }
      row.codigo = parsed.codigo;
    }
    if (parsed.nombre) row.nombre = parsed.nombre;
    if (parsed.categoriaProvided && parsed.categoria) {
      row.categoria = parsed.categoria;
    }
    if (parsed.costoProvided) {
      row.costoReferenciaBase = parsed.costoReferenciaBase;
    }
    if (parsed.margenProvided) {
      row.margenPorcentaje = parsed.margenPorcentaje;
    }
    if (parsed.forzarProvided) {
      row.forzarPrecioManual = parsed.forzarPrecioManual;
    }
    return this.toDto(await this.repo.save(row));
  }

  async remove(tallerId: string, id: string): Promise<void> {
    const row = await this.repo.findOne({ where: { id, tallerId } });
    if (!row) throw new NotFoundException('Refacción no encontrada.');
    await this.repo.remove(row);
  }

  /**
   * Solo si el taller forzó un precio manual. La semilla no cotiza.
   */
  async resolveClienteQuote(
    tallerId: string | null | undefined,
    pieza: string,
  ): Promise<RefaccionCatalogQuote | null> {
    const tid = String(tallerId ?? '').trim();
    if (!tid) return null;
    const codigo = refaccionCatalogCodigoForPieza(pieza);
    if (!codigo) return null;
    const row = await this.repo.findOne({ where: { tallerId: tid, codigo } });
    if (!row?.forzarPrecioManual) return null;
    const costo = Math.max(0, Math.round(Number(row.costoReferenciaBase) || 0));
    const margen = Number.isFinite(Number(row.margenPorcentaje))
      ? Number(row.margenPorcentaje)
      : 30;
    const precioAlCliente = precioSugeridoAlCliente(costo, margen);
    if (!Number.isFinite(precioAlCliente) || precioAlCliente <= 0) return null;
    return {
      codigo: row.codigo,
      nombre: row.nombre,
      costoReferenciaBase: costo,
      margenPorcentaje: margen,
      precioAlCliente,
      fuente: 'catalogo',
    };
  }

  private async ensureDefaults(tallerId: string): Promise<void> {
    const count = await this.repo.count({ where: { tallerId } });
    if (count > 0) return;
    const rows = REFACCION_CATALOG_DEFAULTS.map((d) =>
      this.repo.create({ tallerId, ...d }),
    );
    await this.repo.save(rows);
  }

  private parseWriteInput(
    input: {
      codigo?: unknown;
      nombre?: unknown;
      categoria?: unknown;
      costoReferenciaBase?: unknown;
      margenPorcentaje?: unknown;
      forzarPrecioManual?: unknown;
    },
    opts: { requireCodigo: boolean },
  ): {
    codigo: string;
    nombre: string;
    categoria: RefaccionCategoria;
    categoriaProvided: boolean;
    costoReferenciaBase: number;
    costoProvided: boolean;
    margenPorcentaje: number;
    margenProvided: boolean;
    forzarPrecioManual: boolean;
    forzarProvided: boolean;
  } {
    const codigo = String(input.codigo ?? '')
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');
    if (opts.requireCodigo && !codigo) {
      throw new BadRequestException('codigo obligatorio');
    }
    if (codigo && !/^[A-Z][A-Z0-9_]{1,31}$/.test(codigo)) {
      throw new BadRequestException(
        'codigo: usa mayúsculas, números y guion bajo (ej. FARO_IZQ).',
      );
    }
    const nombre = String(input.nombre ?? '').trim();
    if (opts.requireCodigo && !nombre) {
      throw new BadRequestException('nombre obligatorio');
    }
    const rawCat = String(input.categoria ?? '')
      .trim()
      .toUpperCase();
    if (opts.requireCodigo && !CATEGORIAS.has(rawCat)) {
      throw new BadRequestException(
        `categoria: ${[...CATEGORIAS].join(', ')}`,
      );
    }
    if (rawCat && !CATEGORIAS.has(rawCat)) {
      throw new BadRequestException(
        `categoria: ${[...CATEGORIAS].join(', ')}`,
      );
    }
    const costoRaw = input.costoReferenciaBase;
    const costoProvided =
      costoRaw !== undefined && costoRaw !== null && String(costoRaw) !== '';
    let costoReferenciaBase = 0;
    if (costoProvided) {
      const n = Number(costoRaw);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        throw new BadRequestException('costoReferenciaBase entero >= 0');
      }
      costoReferenciaBase = n;
    } else if (opts.requireCodigo) {
      throw new BadRequestException('costoReferenciaBase entero >= 0');
    }
    const margenRaw = input.margenPorcentaje;
    const margenProvided =
      margenRaw !== undefined && margenRaw !== null && String(margenRaw) !== '';
    let margenPorcentaje = 30;
    if (margenProvided) {
      const n = Number(margenRaw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 300) {
        throw new BadRequestException('margenPorcentaje entero 0–300');
      }
      margenPorcentaje = n;
    }

    const forzarRaw = input.forzarPrecioManual;
    const forzarProvided = forzarRaw !== undefined && forzarRaw !== null;
    const forzarPrecioManual =
      forzarRaw === true ||
      forzarRaw === 'true' ||
      forzarRaw === 1 ||
      forzarRaw === '1';

    return {
      codigo,
      nombre,
      categoria: (rawCat || RefaccionCategoria.OPTICA) as RefaccionCategoria,
      categoriaProvided: Boolean(rawCat),
      costoReferenciaBase,
      costoProvided,
      margenPorcentaje,
      margenProvided,
      forzarPrecioManual,
      forzarProvided,
    };
  }
}
