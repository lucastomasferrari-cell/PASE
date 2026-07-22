import { createContext, useContext, useEffect, useState } from 'react';
import { db } from './supabase';
import type { Usuario, RolPos } from '../types/auth';

// ─── Permisos ──────────────────────────────────────────────────────────────
// Sprint COMANDA Autónomo Fase 3 (24-may):
// - rol_pos='admin' bypassa todos los chequeos (acceso total POS).
// - El resto: chequea contra `comanda_usuario_permisos` (slugs comanda.*).
// - Roles 'superadmin' / 'dueno' de PASE NO aplican acá — son ortogonales.

export function tienePermiso(user: Usuario | null, slug: string): boolean {
  if (!user) return false;
  if (user.rol_pos === 'admin') return true;
  return user.permisos.includes(slug);
}

// Acceso al panel Admin (backoffice de COMANDA — /reportes, /menu, /empleados, etc.)
//
// Slugs de operación POS (los usa el day-to-day: cobrar, mesas, caja) —
// NO cuentan como "acceso admin". Un usuario POS del local (rol=pos_local)
// los tiene todos por herencia de rol pero eso no le da entrada al panel Admin.
const POS_OPERATION_SLUGS = new Set<string>([
  'comanda.ventas.cobrar',
  'comanda.ventas.anular',
  'comanda.ventas.descuento',
  'comanda.ventas.refund',
  'comanda.ventas.reopen',
  'comanda.mesas.gestionar',
  'comanda.caja.abrir',
  'comanda.caja.cerrar',
  'comanda.caja.movimientos',
  'comanda.caja.ver_esperado_cierre',
  'comanda.catalogo.ver',
  'comanda.tienda.aprobar',
  'comanda.reportes.ver',
  'comanda.pagos.ver',
  'comanda.clientes.ver',
  'comanda.empleados.ver',
  'comanda.salon.editar',
]);

// Acceso al panel Admin: requiere AL MENOS 1 slug que NO sea de operación
// POS pura. Ejemplos: comanda.catalogo.editar, comanda.precios.editar,
// comanda.empleados.editar_pos, comanda.audit.ver, etc.
//
// rol_pos='admin' = acceso total (dueño/admin del local), igual que el backend
// (comanda_auth_tiene_permiso) y que tienePermiso() acá arriba. Un usuario con
// permisos SUELTOS entra si tiene al menos 1 slug que no sea de operación POS.
//
// Historia: el 17-jul se sacó este bypass porque nekodevoto tenía rol_pos='admin'
// sin corresponder → entraba al panel. Pero la causa real era el rol_pos mal
// asignado (nekodevoto pasó a 'cajero'), no el bypass. Sacarlo dejó al dueño real
// (rol_pos='admin') afuera de su propio panel. Restaurado: si no debe entrar al
// panel, la persona no debe ser rol_pos='admin' (dato), no se toca el bypass.
export function puedeAccederAdmin(user: Usuario | null): boolean {
  if (!user) return false;
  if (user.rol_pos === 'admin') return true;
  return user.permisos.some((p) => p.startsWith('comanda.') && !POS_OPERATION_SLUGS.has(p));
}

// ─── Sesión ────────────────────────────────────────────────────────────────
// El user logueado proviene de `comanda_usuarios` (no de `usuarios` de PASE).
// Si el email tiene cuenta PASE pero no tiene fila en comanda_usuarios, NO
// puede entrar a COMANDA — se le muestra error "Sin acceso a COMANDA".

export interface AuthState {
  user: Usuario | null;
  loading: boolean;
  error: string | null;
}

const INITIAL: AuthState = { user: null, loading: true, error: null };

export const AuthContext = createContext<AuthState>(INITIAL);

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export function useAuthInternal(): AuthState {
  const [state, setState] = useState<AuthState>(INITIAL);

  useEffect(() => {
    let mounted = true;

    async function load() {
      const { data: sessionData } = await db.auth.getSession();
      const authId = sessionData.session?.user?.id;
      if (!authId) {
        if (mounted) setState({ user: null, loading: false, error: null });
        return;
      }

      // ─── Cargar perfil COMANDA por auth_id (no PASE) ──────────────────
      const { data: rows, error } = await db
        .from('comanda_usuarios')
        .select('id, auth_id, email, nombre, rol_pos, activo, tenant_id, locales, pin_pos')
        .eq('auth_id', authId)
        .eq('activo', true)
        .limit(1);

      if (error) {
        if (mounted) setState({ user: null, loading: false, error: error.message });
        return;
      }
      const row = rows?.[0];
      if (!row) {
        // El user tiene auth.users pero NO tiene fila en comanda_usuarios.
        // Esto pasa cuando: (a) tiene cuenta PASE pero no se le asignó COMANDA,
        // (b) el comanda_usuario está desactivado.
        if (mounted) setState({
          user: null,
          loading: false,
          error: 'Este usuario no tiene acceso a COMANDA. Pedile al dueño que te lo habilite desde PASE → Herramientas → Usuarios COMANDA.',
        });
        return;
      }

      // ─── Cargar permisos comanda.* del user ───────────────────────────
      // Dos fuentes:
      //   a) comanda_usuario_permisos — slugs asignados individualmente al user
      //   b) rol_pos_permisos — slugs del rol_pos (herencia por rol; nueva
      //      fuente 17-jul para pos_local + para roles cajero/manager/etc).
      // Union sin duplicados. Alinea con la lógica del backend
      // comanda_auth_tiene_permiso (que ahora también hace el union).
      const rolPos = row.rol_pos as RolPos;
      const [permsIndv, permsRol] = await Promise.all([
        db.from('comanda_usuario_permisos')
          .select('modulo_slug')
          .eq('comanda_usuario_id', row.id as string),
        db.from('rol_pos_permisos')
          .select('slug')
          .eq('rol_pos', rolPos)
          .eq('activo', true),
      ]);
      const permisosSet = new Set<string>();
      for (const p of permsIndv.data ?? []) permisosSet.add((p as { modulo_slug: string }).modulo_slug);
      for (const p of permsRol.data ?? []) permisosSet.add((p as { slug: string }).slug);
      const permisos = Array.from(permisosSet);

      const user: Usuario = {
        id: row.id as string,
        auth_id: row.auth_id as string,
        email: row.email as string,
        nombre: row.nombre as string,
        rol_pos: rolPos,
        rol: rolPos, // compat alias
        activo: row.activo as boolean,
        tenant_id: row.tenant_id as string | null,
        permisos,
        locales: (row.locales as number[] | null) ?? null,
        pin_pos: (row.pin_pos as string | null) ?? null,
      };
      if (mounted) setState({ user, loading: false, error: null });
    }

    load();

    const { data: sub } = db.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        if (mounted) setState({ user: null, loading: false, error: null });
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        load();
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}
