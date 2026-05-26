import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AuthenticatedUser, JwtPayload } from '../interfaces/jwt-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    const secret = process.env.JWT_SECRET?.trim();
    if (!secret) {
      throw new Error(
        'JWT_SECRET no está definido en el entorno. Configúralo antes de arrancar el servidor.',
      );
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    if (!payload?.sub || !payload?.tallerId) {
      throw new UnauthorizedException('Token JWT inválido.');
    }
    return {
      userId: payload.sub,
      email: payload.email,
      tallerId: payload.tallerId,
      role: payload.role,
    };
  }
}
