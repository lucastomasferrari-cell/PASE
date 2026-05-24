// Modelo del usuario logueado para COMANDA.
//
// Sprint COMANDA Autónomo Fase 3 (Lucas 24-may): COMANDA dejó de leer la
// tabla `usuarios` de PASE. Ahora lee `comanda_usuarios` (perfil POS
// independiente). Auth compartido (mismo Supabase Auth) pero perfiles y
// permisos separados.
//
// La tabla usa UUID como PK (no INTEGER como `usuarios` de PASE).

// Roles POS (separados de los roles administrativos de PASE).
export type RolPos = 'mozo' | 'cajero' | 'manager' | 'admin';

// Rol legacy mantenido como compat para componentes que aún esperan `rol`
// de PASE. La pantalla de Settings/Permisos puede recibir Rol legacy si
// quedó algún componente sin migrar.
export type Rol = RolPos;

export interface Usuario {
  /**
   * UUID del comanda_usuario. Antes era INTEGER (de `usuarios` de PASE).
   * Sprint Autónomo cambia tipo — ojo con cualquier código que asuma number.
   */
  id: string;
  auth_id: string;
  email: string | null;
  nombre: string;
  /** Rol POS — admin bypassa todos los permisos. */
  rol_pos: RolPos;
  /** Compat: alias de `rol_pos` para componentes legacy de COMANDA. */
  rol: RolPos;
  activo: boolean;
  tenant_id: string | null;
  /** Cache de los slugs comanda.* del usuario. */
  permisos: string[];
  /** Locales asignados. null/undefined = todos los del tenant. */
  locales: number[] | null;
  /** PIN POS opcional (4-6 dígitos). */
  pin_pos: string | null;
}
