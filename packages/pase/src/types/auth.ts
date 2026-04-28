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
  cuentas_visibles: string[] | null;
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

export interface Perfil extends UsuarioRow {}
