import type { UserRole } from '../entities/user.entity';

export interface JwtPayload {
  sub: string;
  email: string;
  tallerId: string;
  role: UserRole;
}

export interface AuthenticatedUser {
  userId: string;
  email: string;
  tallerId: string;
  role: UserRole;
}
