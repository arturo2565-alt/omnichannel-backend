import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { User } from './entities/user.entity';
import { Taller } from '../taller/entities/taller.entity';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

/** Segundos de vida del token (por defecto 7 días). */
function jwtExpiresInSeconds(): number {
  const raw = process.env.JWT_EXPIRES_IN?.trim();
  if (!raw) return 7 * 24 * 60 * 60;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) return Math.floor(asNum);
  return 7 * 24 * 60 * 60;
}

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Taller]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-only-change-me',
      signOptions: { expiresIn: jwtExpiresInSeconds() },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtAuthGuard],
  exports: [AuthService, JwtModule, PassportModule, JwtAuthGuard],
})
export class AuthModule {}
