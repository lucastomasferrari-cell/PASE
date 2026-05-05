// Modelo del usuario logueado para COMANDA. Subset del de PASE.
// usuario_permisos.modulo_slug se cachea como string[].

export type Rol = 'superadmin' | 'dueno' | 'admin' | 'encargado' | 'compras' | 'cajero';

export interface Usuario {
  id: number;
  auth_id: string;
  email: string | null;
  nombre: string;
  rol: Rol;
  activo: boolean;
  tenant_id: string | null;
  permisos: string[];
  locales: number[];
}
