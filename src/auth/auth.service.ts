import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { Taller } from '../taller/entities/taller.entity';
import type { RegisterDto } from './dto/register.dto';
import type { LoginDto } from './dto/login.dto';
import type { JwtPayload } from './interfaces/jwt-payload.interface';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Taller)
    private readonly tallerRepository: Repository<Taller>,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const email = String(dto.email ?? '')
      .trim()
      .toLowerCase();
    const password = String(dto.password ?? '');
    const nombreTaller = String(dto.nombreTaller ?? '').trim();
    const metaPageId = String(dto.metaPageId ?? '').trim() || null;

    if (!email || !email.includes('@')) {
      throw new BadRequestException('email inválido.');
    }
    if (password.length < 8) {
      throw new BadRequestException('La contraseña debe tener al menos 8 caracteres.');
    }
    if (!nombreTaller) {
      throw new BadRequestException('nombreTaller es obligatorio.');
    }

    const existing = await this.userRepository.findOne({ where: { email } });
    if (existing) {
      throw new ConflictException('Ya existe un usuario con ese email.');
    }

    if (metaPageId) {
      const pageTaken = await this.tallerRepository.findOne({
        where: { metaPageId },
      });
      if (pageTaken) {
        throw new ConflictException(
          'Ese metaPageId ya está registrado en otro taller.',
        );
      }
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const taller = this.tallerRepository.create({
      nombre: nombreTaller,
      metaPageId,
    });
    await this.tallerRepository.save(taller);

    const user = this.userRepository.create({
      email,
      passwordHash,
      tallerId: taller.id,
      role: 'owner',
    });
    await this.userRepository.save(user);

    const accessToken = await this.signToken(user);

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        tallerId: user.tallerId,
      },
      taller: {
        id: taller.id,
        nombre: taller.nombre,
        metaPageId: taller.metaPageId,
      },
    };
  }

  async login(dto: LoginDto) {
    const email = String(dto.email ?? '')
      .trim()
      .toLowerCase();
    const password = String(dto.password ?? '');

    if (!email || !password) {
      throw new BadRequestException('email y password son obligatorios.');
    }

    const user = await this.userRepository.findOne({
      where: { email },
      relations: ['taller'],
    });
    if (!user) {
      throw new UnauthorizedException('Credenciales incorrectas.');
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Credenciales incorrectas.');
    }

    const accessToken = await this.signToken(user);

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        tallerId: user.tallerId,
      },
      taller: user.taller
        ? {
            id: user.taller.id,
            nombre: user.taller.nombre,
            metaPageId: user.taller.metaPageId,
          }
        : { id: user.tallerId, nombre: null, metaPageId: null },
    };
  }

  private async signToken(user: User): Promise<string> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      tallerId: user.tallerId,
      role: user.role,
    };
    return this.jwtService.signAsync(payload);
  }
}
