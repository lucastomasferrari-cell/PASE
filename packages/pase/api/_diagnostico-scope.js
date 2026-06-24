// Scope server-side para el bot de diagnóstico IA.
//
// La API usa el cliente service_role (bypassa RLS), así que NO se pueden usar
// las funciones SQL auth_locales_visibles() / auth_tiene_permiso(): esas leen
// el JWT del usuario (request.jwt.claims), que acá no existe. Replicamos su
// lógica EXACTA con el service client, filtrando manualmente (regla E de
// CLAUDE.md). Fuente de verdad:
//   - locales:  migration 202605292130_auth_locales_visibles_fallback_comanda.sql
//   - permisos: migration 202605201900_rbac_roles.sql §8 (auth_tiene_permiso)
//
// `auth` = { user, row } que devuelve checkUserAuth (_user-auth.js):
//   user.id       = auth uid (auth.users) — para el fallback COMANDA
//   row.id        = usuarios.id (INTEGER)
//   row.rol       = 'dueno' | 'admin' | 'encargado' | 'cajero' | 'superadmin'
//   row.rol_id    = rol RBAC (puede ser null en usuarios legacy)
//   row.tenant_id = tenant del usuario

export const ROLES_ACCESO_TOTAL = new Set(['dueno', 'admin', 'superadmin']);
const SLUG_DIAGNOSTICO = 'diagnostico_ia';

// Locales que el usuario puede ver. Espeja auth_locales_visibles():
//   dueño/admin/superadmin → todos los locales del tenant
//   resto → usuario_locales (PASE); si está vacío, fallback comanda_usuarios.locales
// El bot solo puede consultar locales que estén en este array (defensa en
// profundidad: executeTool revalida el local pedido contra esta lista).
export async function localesVisibles(admin, auth) {
  const { row, user } = auth;

  if (ROLES_ACCESO_TOTAL.has(row.rol)) {
    const { data } = await admin
      .from('locales')
      .select('id')
      .eq('tenant_id', row.tenant_id);
    return (data || []).map((r) => r.id);
  }

  const { data: ul } = await admin
    .from('usuario_locales')
    .select('local_id')
    .eq('usuario_id', row.id);
  if (ul && ul.length) return ul.map((r) => r.local_id);

  // Fallback: cajero solo-COMANDA (sin fila en usuario_locales).
  const { data: cu } = await admin
    .from('comanda_usuarios')
    .select('locales')
    .eq('auth_id', user.id)
    .eq('activo', true)
    .limit(1)
    .maybeSingle();
  return Array.isArray(cu?.locales) ? cu.locales : [];
}

// ¿El usuario tiene el permiso de diagnóstico? Espeja auth_tiene_permiso():
//   dueño/admin/superadmin → siempre
//   resto → rol_permisos(rol_id) ∪ usuario_permisos(usuario_id), por modulo_slug
export async function tienePermisoDiagnostico(admin, auth) {
  const { row } = auth;
  if (ROLES_ACCESO_TOTAL.has(row.rol)) return true;

  if (row.rol_id) {
    const { data: rp } = await admin
      .from('rol_permisos')
      .select('modulo_slug')
      .eq('rol_id', row.rol_id)
      .eq('modulo_slug', SLUG_DIAGNOSTICO)
      .limit(1);
    if (rp && rp.length) return true;
  }

  const { data: up } = await admin
    .from('usuario_permisos')
    .select('modulo_slug')
    .eq('usuario_id', row.id)
    .eq('modulo_slug', SLUG_DIAGNOSTICO)
    .limit(1);
  return !!(up && up.length);
}
