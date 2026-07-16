import { db } from '../lib/supabase';
import { translateError } from '../lib/errors';
import { ADMIN_NAVIGATION_FULL } from '../lib/adminNavigation';

// Permisos de ACCIÓN (POS/catálogo). Los de NAVEGACIÓN (comanda.nav.*) se
// generan del sidebar más abajo y se concatenan en SLUGS_COMANDA.
const SLUGS_ACCIONES_COMANDA: ReadonlyArray<{ slug: string; label: string; modulo: string }> = [
  // Catálogo (Sprint 1)
  { slug: 'comanda.catalogo.ver',         label: 'Ver catálogo',                       modulo: 'Catálogo' },
  { slug: 'comanda.catalogo.editar',      label: 'Editar items y grupos',              modulo: 'Catálogo' },
  { slug: 'comanda.catalogo.eliminar',    label: 'Eliminar items',                     modulo: 'Catálogo' },
  { slug: 'comanda.catalogo.maestro.editar', label: 'Editar Menú Marca (maestro)',    modulo: 'Catálogo' },
  { slug: 'comanda.canales.ver',          label: 'Ver canales',                        modulo: 'Catálogo' },
  { slug: 'comanda.canales.editar',       label: 'Editar canales',                     modulo: 'Catálogo' },
  { slug: 'comanda.precios.editar',       label: 'Editar precios celda por celda',     modulo: 'Catálogo' },
  { slug: 'comanda.precios.aumento_masivo', label: 'Aplicar aumento masivo',           modulo: 'Catálogo' },
  { slug: 'comanda.modifiers.editar',     label: 'Editar modificadores',               modulo: 'Catálogo' },
  { slug: 'comanda.tax.editar',           label: 'Editar tax rates',                   modulo: 'Catálogo' },
  // POS (Sprint 2)
  { slug: 'comanda.ventas.cobrar',        label: 'Tomar pedidos y cobrar',             modulo: 'POS' },
  { slug: 'comanda.ventas.anular',        label: 'Anular item / venta (con override)', modulo: 'POS' },
  { slug: 'comanda.ventas.descuento',     label: 'Descuentos chicos sin manager',      modulo: 'POS' },
  { slug: 'comanda.ventas.refund',        label: 'Reembolsar venta cobrada',           modulo: 'POS' },
  { slug: 'comanda.ventas.reopen',        label: 'Reabrir venta cobrada',              modulo: 'POS' },
  { slug: 'comanda.mesas.gestionar',      label: 'Transferir / unir / partir mesas',   modulo: 'POS' },
  // Caja
  { slug: 'comanda.caja.abrir',           label: 'Abrir turno',                        modulo: 'Caja' },
  { slug: 'comanda.caja.cerrar',          label: 'Cerrar turno',                       modulo: 'Caja' },
  { slug: 'comanda.caja.movimientos',     label: 'Retiros / depósitos / ajustes',      modulo: 'Caja' },
  // Tienda online
  { slug: 'comanda.tienda.aprobar',       label: 'Aprobar pedidos online',             modulo: 'Tienda' },
  // Settings
  { slug: 'comanda.empleados.editar_pos', label: 'Setear PIN / rol POS de empleados', modulo: 'Settings' },
  { slug: 'comanda.config.editar',        label: 'Editar config del local',            modulo: 'Settings' },
  { slug: 'comanda.audit.ver',            label: 'Ver auditoría de overrides',         modulo: 'Settings' },
];

// Permisos de NAVEGACIÓN (acceso a cada sub-pantalla del sidebar). Se derivan
// del sidebar (adminNavigation) — un slug comanda.nav.<cat>.<sub> por sub-item
// visible. Fuente única: el propio sidebar.
const SLUGS_NAV_COMANDA: ReadonlyArray<{ slug: string; label: string; modulo: string }> =
  ADMIN_NAVIGATION_FULL.flatMap((cat) =>
    cat.subItems
      .filter((s) => s.badge !== 'soon' && s.requiredPermission)
      .map((s) => ({ slug: s.requiredPermission as string, label: s.label, modulo: cat.label })),
  );

export const SLUGS_COMANDA: ReadonlyArray<{ slug: string; label: string; modulo: string }> = [
  ...SLUGS_ACCIONES_COMANDA,
  ...SLUGS_NAV_COMANDA,
];

// Lee permisos asignados a un usuario PASE desde usuario_permisos
// (tabla shape: id uuid, usuario_id integer, modulo_slug text, tenant_id uuid).
export async function getPermisosUsuario(usuarioId: number): Promise<{ data: string[]; error: string | null }> {
  const { data, error } = await db
    .from('usuario_permisos')
    .select('modulo_slug')
    .eq('usuario_id', usuarioId);
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []).map((r) => (r as { modulo_slug: string }).modulo_slug), error: null };
}

// Sincroniza permisos: borra los que ya no están y agrega los nuevos.
// Cualquier slug es aceptado (los slugs propios de PASE coexisten).
export async function setPermisosUsuario(
  usuarioId: number,
  tenantId: string,
  slugs: string[],
): Promise<{ error: string | null }> {
  // Toma actuales relacionados con COMANDA
  const slugsComanda = SLUGS_COMANDA.map((s) => s.slug);
  const aGuardar = new Set(slugs.filter((s) => slugsComanda.includes(s)));

  const { data: actuales } = await db
    .from('usuario_permisos')
    .select('id, modulo_slug')
    .eq('usuario_id', usuarioId)
    .in('modulo_slug', slugsComanda);

  const actualesByslug = new Map<string, string>();
  for (const r of actuales ?? []) {
    actualesByslug.set((r as { modulo_slug: string }).modulo_slug, (r as { id: string }).id);
  }

  // Slugs que están en actuales pero no en aGuardar → DELETE
  const aBorrar: string[] = [];
  for (const [slug, id] of actualesByslug.entries()) {
    if (!aGuardar.has(slug)) aBorrar.push(id);
  }
  if (aBorrar.length > 0) {
    const { error: delErr } = await db.from('usuario_permisos').delete().in('id', aBorrar);
    if (delErr) return { error: delErr.message };
  }

  // Slugs en aGuardar que no estén → INSERT
  const aInsertar = Array.from(aGuardar).filter((s) => !actualesByslug.has(s));
  if (aInsertar.length > 0) {
    const rows = aInsertar.map((slug) => ({
      usuario_id: usuarioId,
      tenant_id: tenantId,
      modulo_slug: slug,
    }));
    const { error: insErr } = await db.from('usuario_permisos').insert(rows);
    if (insErr) return { error: insErr.message };
  }

  return { error: null };
}

// Lista usuarios del tenant para la pantalla de Settings → Permisos
export interface UsuarioPermisos {
  id: number;
  nombre: string;
  email: string | null;
  rol: string;
  permisos_count: number;
}

export async function listUsuariosTenant(tenantId: string): Promise<{ data: UsuarioPermisos[]; error: string | null }> {
  const { data: usrs, error: uerr } = await db
    .from('usuarios')
    .select('id, nombre, email, rol')
    .eq('tenant_id', tenantId)
    .eq('activo', true)
    .order('nombre');
  if (uerr) return { data: [], error: uerr.message };

  const ids = (usrs ?? []).map((u) => (u as { id: number }).id);
  if (ids.length === 0) return { data: [], error: null };

  const { data: perms } = await db
    .from('usuario_permisos')
    .select('usuario_id')
    .in('usuario_id', ids);

  const counts = new Map<number, number>();
  for (const p of perms ?? []) {
    const id = (p as { usuario_id: number }).usuario_id;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return {
    data: (usrs ?? []).map((u) => {
      const r = u as { id: number; nombre: string; email: string | null; rol: string };
      return {
        id: r.id, nombre: r.nombre, email: r.email, rol: r.rol,
        permisos_count: counts.get(r.id) ?? 0,
      };
    }),
    error: null,
  };
}
