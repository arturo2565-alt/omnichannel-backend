import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Ruta accesible sin JWT (webhooks Meta, verificación, etc.). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
