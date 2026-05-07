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
  /**
   * Cache local de los slugs de permisos del usuario para sesión Supabase.
   *
   * @deprecated NO usar `user.permisos.includes(slug)` directamente desde
   * componentes. Usar el hook `usePermiso(slug)` (lib/usePermiso.ts) que:
   *  - Combina sesión Supabase + rol POS empleado.
   *  - Aplica bypass para superadmin/dueño/admin.
   *  - Es el único lugar donde se toma la decisión final de autorización.
   *
   * Este campo se mantiene para retrocompatibilidad y porque `usePermiso`
   * lo lee internamente. Nunca usarlo desde JSX/components.
   *
   * Eliminación planificada: cuando exista la tabla `rol_pos_permisos`
   * formal y se reemplace todo el mapping por queries.
   */
  permisos: string[];
  locales: number[];
}
