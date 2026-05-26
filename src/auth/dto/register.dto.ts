export class RegisterDto {
  email: string;
  password: string;
  /** Nombre del taller a crear (primer usuario = owner). */
  nombreTaller: string;
  /** ID de página Meta (Messenger/Instagram); opcional en registro. */
  metaPageId?: string;
}
