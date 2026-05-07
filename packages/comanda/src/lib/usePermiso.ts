// Hook para chequear permisos en UI.
//
// Estrategia:
// 1. Si hay sesión Supabase con permisos hidratados (useAuth → user.permisos),
//    usar eso (Sprint 1). Es la fuente de verdad cuando el usuario es dueño/
//    admin en PASE y maneja Settings.
// 2. Si NO hay sesión Supabase pero SÍ hay empleado POS activo (PIN),
//    derivar de rol_pos con el mapeo provisional documentado abajo.
//
// El mapeo por rol_pos es PROVISIONAL hasta tener una tabla
// `rol_pos_permisos` o equivalente. Esta deuda técnica se mantendrá hasta
// que aparezca una pantalla "asignar permisos a roles POS" en Settings.

import { useAuth } from './auth';
import { useAuthPos } from './authPos';
import { tienePermiso as userTienePermiso } from './auth';
import type { RolPos } from '../types/database';

// Mapeo provisional rol_pos → slugs concedidos. Sprint 6 lo amplía con
// los slugs nuevos del sidebar admin (empleados, salon, pagos, online,
// hardware, marketing, clientes, integraciones, configuracion,
// suscripcion). Cuando exista la tabla rol_pos_permisos formal este
// mapeo se reemplaza por una query.
//
// Convención: 'comanda.X.ver' (lectura) ⊂ 'comanda.X.editar/gestionar'
// (escritura). Si tenés escritura siempre tenés lectura.
//
// suscripcion.gestionar es exclusivo de dueño (cobranza al titular).
const PERMISOS_POR_ROL_POS: Record<RolPos, string[]> = {
  cajero: [
    'comanda.ventas.cobrar',
    'comanda.reportes.ver',
  ],
  encargado: [
    'comanda.ventas.cobrar',
    'comanda.ventas.descuento',
    'comanda.reportes.ver',
    'comanda.salon.editar',
    'comanda.clientes.ver',
    'comanda.pagos.ver',
    'comanda.empleados.ver',
    'comanda.catalogo.ver',
  ],
  manager: [
    'comanda.ventas.cobrar',
    'comanda.ventas.descuento',
    'comanda.ventas.anular',
    'comanda.config.editar',
    'comanda.configuracion.editar',
    'comanda.catalogo.ver',
    'comanda.catalogo.editar',
    'comanda.empleados.ver',
    'comanda.empleados.editar',
    'comanda.empleados.editar_pos',
    'comanda.salon.editar',
    'comanda.pagos.ver',
    'comanda.pagos.editar',
    'comanda.online.gestionar',
    'comanda.tienda.aprobar',
    'comanda.reportes.ver',
    'comanda.hardware.gestionar',
    'comanda.marketing.gestionar',
    'comanda.clientes.ver',
    'comanda.clientes.editar',
    'comanda.integraciones.gestionar',
  ],
  dueno: ['*'],
};

export function usePermiso(slug: string): boolean {
  const { user } = useAuth();
  const { empleado } = useAuthPos();

  // 1. Sesión Supabase con permisos hidratados (superadmin/dueño/admin
  // pasan por bypass; encargados llevan el array de slugs en user.permisos).
  if (user && userTienePermiso(user, slug)) return true;

  // 2. Sesión POS con empleado autenticado: derivar del rol_pos.
  if (empleado?.rol_pos) {
    const slugs = PERMISOS_POR_ROL_POS[empleado.rol_pos] ?? [];
    if (slugs.includes('*') || slugs.includes(slug)) return true;
  }

  return false;
}
