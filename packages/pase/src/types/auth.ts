export type RolUsuario = "dueno" | "admin" | "encargado" | "compras" | "cajero";

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
}

export interface Usuario extends UsuarioRow {
  _permisos?: string[];
  _locales?: number[];
}

export interface Local {
  id: number;
  nombre: string;
}

export interface Perfil extends UsuarioRow {}
