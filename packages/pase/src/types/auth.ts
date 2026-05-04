export type RolUsuario = "superadmin" | "dueno" | "admin" | "encargado" | "compras" | "cajero";

export interface UsuarioRow {
  id: number;
  auth_id: string;
  email: string;
  nombre: string;
  rol: RolUsuario | string;
  activo: boolean;
  password_temporal: boolean;
  locales: number[] | null;
  /** Cuentas cuyo SALDO el usuario puede ver (cards Tesorería, totales).
   *  NULL = sin restricción. Coincide con la columna usuarios.cuentas_visibles. */
  cuentas_visibles: string[] | null;
  /** Cuentas contra las que el usuario puede OPERAR (cargar pagos/gastos).
   *  Migration 202605041700 agregó la columna; antes de correrla viene
   *  undefined y el helper hace fallback a cuentas_visibles. */
  cuentas_operables?: string[] | null;
  /** TASK 0.15: NULL para superadmin (fuera de tenants); UUID para resto. */
  tenant_id: string | null;
}

export interface Usuario extends UsuarioRow {
  _permisos?: string[];
  _locales?: number[];
}

export interface Local {
  id: number;
  nombre: string;
  tenant_id?: string;
}

export interface Tenant {
  id: string;
  nombre: string;
  slug: string;
  activo: boolean;
  plan: string | null;
  trial_ends_at: string | null;
  created_at: string;
  updated_at?: string;
}

export type Perfil = UsuarioRow;
