// Pantalla de gestión de Roles (RBAC).
//
// Lucas 2026-05-19: en vez de tildar permisos uno por uno por usuario, ahora
// cada usuario tiene 1 rol asignado. Esta pantalla muestra los 6 roles del
// sistema + los roles custom del tenant. Permite crear/editar/eliminar
// custom (los del sistema son read-only en v1).
//
// Modelo:
//   - Roles del sistema (es_sistema=true, tenant_id=NULL): Dueño, Socio,
//     Administrador, Encargado, Cajero, Contador. Solo lectura desde acá.
//   - Roles custom (tenant_id=tu tenant): CRUD completo.
//
// Después de editar permisos de un rol → los usuarios con ese rol cambian
// permisos al instante (vía RLS + auth_tiene_permiso).

import { useState, useEffect, useCallback } from "react";
import { db } from "../lib/supabase";
import { MODULOS, PERMISOS_EXTRAS, tienePermiso } from "../lib/auth";
import { translateRpcError } from "../lib/errors";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";
import type { Usuario } from "../types";

interface Rol {
  id: string;
  tenant_id: string | null;
  slug: string;
  nombre: string;
  descripcion: string | null;
  es_sistema: boolean;
  created_at: string;
  updated_at: string;
}

interface RolConPermisos extends Rol {
  permisos: string[];
  usuarios_count: number;
}

interface Props { user: Usuario }

// Agrupamos los permisos en categorías para que la UI sea legible.
// Cada categoría tiene un grupo de slugs + un title.
const CATEGORIAS_PERMISOS: Array<{ titulo: string; perms: Array<{ slug: string; label: string; descripcion?: string }> }> = [
  {
    titulo: "Operación diaria",
    perms: [
      { slug: "dashboard", label: "Dashboard / Inicio" },
      { slug: "caja", label: "Caja / Tesorería" },
      { slug: "ventas", label: "Ventas (cargar cierres)" },
      { slug: "gastos", label: "Gastos" },
      { slug: "compras", label: "Compras" },
      { slug: "proveedores", label: "Proveedores" },
      { slug: "remitos", label: "Remitos" },
      { slug: "mp", label: "Conciliación Mercado Pago" },
    ],
  },
  {
    titulo: "Acciones destructivas (sin permiso pide código del dueño)",
    perms: PERMISOS_EXTRAS.filter(p => p.slug.endsWith("_anular")).map(p => ({
      slug: p.slug,
      label: p.label,
      descripcion: p.descripcion,
    })),
  },
  {
    titulo: "Información sensible (financiera)",
    perms: [
      { slug: "eerr", label: "Estado de Resultados (EERR)" },
      { slug: "cierre", label: "Cierres / Comparativo" },
      { slug: "finanzas", label: "Finanzas" },
      { slug: "cashflow", label: "Cashflow / Ruta del dinero" },
      { slug: "negocio", label: "Negocio (resumen)" },
      { slug: "objetivos", label: "Objetivos" },
    ],
  },
  {
    titulo: "Costos / Recetas / Insumos",
    perms: [
      { slug: "costos", label: "Costos" },
      { slug: "recetas", label: "Recetas" },
      { slug: "insumos", label: "Insumos" },
    ],
  },
  {
    titulo: "Histórico y Auditoría",
    perms: PERMISOS_EXTRAS.filter(p => !p.slug.endsWith("_anular")).map(p => ({
      slug: p.slug,
      label: p.label,
      descripcion: p.descripcion,
    })),
  },
  {
    titulo: "RRHH",
    perms: [
      { slug: "rrhh", label: "Equipo / RRHH (gestionar sueldos)" },
    ],
  },
  {
    titulo: "Contador externo",
    perms: [
      { slug: "contador", label: "Contador / IVA" },
    ],
  },
  {
    titulo: "Administración del sistema",
    perms: [
      { slug: "usuarios", label: "Gestión de usuarios" },
      { slug: "configuracion", label: "Configuración" },
      { slug: "ajustes", label: "Ajustes" },
      { slug: "ajustes_dashboards", label: "Ajustes de Dashboards" },
      { slug: "blindaje", label: "Blindaje / Códigos manager" },
      { slug: "codigos_manager", label: "Generar códigos manager (TOTP)" },
    ],
  },
];

export default function RolesPermisos({ user }: Props) {
  const [roles, setRoles] = useState<RolConPermisos[]>([]);
  const [loading, setLoading] = useState(true);
  const [editando, setEditando] = useState<RolConPermisos | null>(null);
  const [creando, setCreando] = useState(false);
  const { toast, showToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    const { data: rolesData, error: e1 } = await db.from("roles")
      .select("*")
      .order("es_sistema", { ascending: false })
      .order("nombre");
    if (e1) {
      showToast("Error cargando roles: " + e1.message);
      setLoading(false);
      return;
    }
    const rolesArr = (rolesData ?? []) as Rol[];
    const ids = rolesArr.map(r => r.id);
    if (ids.length === 0) { setRoles([]); setLoading(false); return; }

    const { data: permsData } = await db.from("rol_permisos")
      .select("rol_id, modulo_slug")
      .in("rol_id", ids);
    const { data: usersData } = await db.from("usuarios")
      .select("rol_id")
      .eq("activo", true)
      .in("rol_id", ids);

    const permsMap = new Map<string, string[]>();
    (permsData ?? []).forEach((p) => {
      const list = permsMap.get(p.rol_id) ?? [];
      list.push(p.modulo_slug);
      permsMap.set(p.rol_id, list);
    });
    const usersCountMap = new Map<string, number>();
    (usersData ?? []).forEach((u: { rol_id: string }) => {
      usersCountMap.set(u.rol_id, (usersCountMap.get(u.rol_id) ?? 0) + 1);
    });

    setRoles(rolesArr.map(r => ({
      ...r,
      permisos: permsMap.get(r.id) ?? [],
      usuarios_count: usersCountMap.get(r.id) ?? 0,
    })));
    setLoading(false);
    // showToast solo en error — no dispara render loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Gate: solo dueño/admin/superadmin.
  if (!tienePermiso(user, "usuarios") && user.rol !== "dueno" && user.rol !== "admin" && user.rol !== "superadmin") {
    return <div className="alert alert-warn" style={{margin:24}}>No tenés permisos para gestionar roles. Pedile al dueño.</div>;
  }

  const rolesSistema = roles.filter(r => r.es_sistema);
  const rolesCustom = roles.filter(r => !r.es_sistema);

  return (
    <>
      <div style={{padding:24,maxWidth:1100,margin:"0 auto"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24}}>
          <div>
            <h1 style={{fontSize:18,fontWeight:500,margin:0}}>Roles y permisos</h1>
            <div style={{fontSize:12,color:"var(--muted2)",marginTop:4}}>
              Asigná uno de estos roles a cada usuario en Equipo. Si necesitás algo distinto, creá un rol custom.
            </div>
          </div>
          <button className="btn btn-acc" onClick={() => setCreando(true)}>+ Nuevo rol custom</button>
        </div>

        {loading ? <div className="loading">Cargando…</div> : (
          <>
            <h2 style={{fontSize:13,fontWeight:500,marginTop:0,marginBottom:12,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1}}>
              Roles del sistema ({rolesSistema.length})
            </h2>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(280px, 1fr))",gap:12,marginBottom:32}}>
              {rolesSistema.map(r => (
                <RolCard key={r.id} rol={r} onEdit={() => setEditando(r)} />
              ))}
            </div>

            <h2 style={{fontSize:13,fontWeight:500,marginBottom:12,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1}}>
              Roles custom de tu cuenta ({rolesCustom.length})
            </h2>
            {rolesCustom.length === 0 ? (
              <div className="alert alert-info">
                Todavía no creaste ningún rol custom. Si los roles del sistema te alcanzan, no necesitás crear nada.
              </div>
            ) : (
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(280px, 1fr))",gap:12}}>
                {rolesCustom.map(r => (
                  <RolCard key={r.id} rol={r} onEdit={() => setEditando(r)} editable />
                ))}
              </div>
            )}
          </>
        )}

        {editando && (
          <ModalEditarRol
            rol={editando}
            onClose={() => setEditando(null)}
            onSaved={() => { setEditando(null); void load(); showToast("Rol actualizado"); }}
            onDeleted={() => { setEditando(null); void load(); showToast("Rol eliminado"); }}
          />
        )}
        {creando && (
          <ModalEditarRol
            rol={null}
            onClose={() => setCreando(false)}
            onSaved={() => { setCreando(false); void load(); showToast("Rol creado"); }}
            onDeleted={() => {/* no aplica al crear */}}
          />
        )}
      </div>
      {toast && <ToastComponent toast={toast} />}
    </>
  );
}

function RolCard({ rol, onEdit, editable = false }: { rol: RolConPermisos; onEdit: () => void; editable?: boolean }) {
  return (
    <div className="panel" style={{padding:14}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:14,fontWeight:500,marginBottom:2}}>{rol.nombre}</div>
          {rol.es_sistema && (
            <span className="badge b-info" style={{fontSize:8,marginRight:4}}>Sistema</span>
          )}
          {editable && (
            <span className="badge b-muted" style={{fontSize:8,marginRight:4}}>Custom</span>
          )}
        </div>
      </div>
      <div style={{fontSize:11,color:"var(--muted2)",marginTop:6,minHeight:32}}>
        {rol.descripcion || "(sin descripción)"}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginTop:10,fontSize:11}}>
        <span style={{color:"var(--muted2)"}}><strong style={{color:"var(--txt)"}}>{rol.permisos.length}</strong> permisos</span>
        <span style={{color:"var(--muted2)"}}><strong style={{color:"var(--txt)"}}>{rol.usuarios_count}</strong> usuarios</span>
      </div>
      <button className="btn btn-sec btn-sm" style={{marginTop:10,width:"100%"}} onClick={onEdit}>
        {rol.es_sistema ? "Ver permisos" : "Editar"}
      </button>
    </div>
  );
}

function ModalEditarRol({ rol, onClose, onSaved, onDeleted }: { rol: RolConPermisos | null; onClose: () => void; onSaved: () => void; onDeleted: () => void }) {
  const [nombre, setNombre] = useState(rol?.nombre ?? "");
  const [descripcion, setDescripcion] = useState(rol?.descripcion ?? "");
  const [permisos, setPermisos] = useState<Set<string>>(new Set(rol?.permisos ?? []));
  const [guardando, setGuardando] = useState(false);
  const esSistema = rol?.es_sistema ?? false;
  const editable = !esSistema; // sistema = solo lectura

  // Lista de slugs únicos definida en CATEGORIAS_PERMISOS.
  const slugsConocidos = new Set(CATEGORIAS_PERMISOS.flatMap(c => c.perms.map(p => p.slug)));
  // Permisos que el rol tiene PERO no aparecen en CATEGORIAS (raros, legacy o
  // recién añadidos). Los mostramos al final para no perderlos al editar.
  const permisosHuerfanos = Array.from(permisos).filter(s => !slugsConocidos.has(s));

  function toggle(slug: string) {
    if (!editable) return;
    setPermisos(prev => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function guardar() {
    if (guardando) return;
    if (!nombre.trim()) { alert("Falta el nombre"); return; }
    setGuardando(true);
    try {
      if (rol) {
        // Editando
        const { error } = await db.rpc("actualizar_rol", {
          p_rol_id: rol.id,
          p_nombre: nombre.trim() !== rol.nombre ? nombre.trim() : null,
          p_descripcion: descripcion !== (rol.descripcion ?? "") ? descripcion : null,
          p_permisos: Array.from(permisos),
        });
        if (error) throw error;
      } else {
        // Creando
        const { error } = await db.rpc("crear_rol", {
          p_nombre: nombre.trim(),
          p_descripcion: descripcion || null,
          p_permisos: Array.from(permisos),
        });
        if (error) throw error;
      }
      onSaved();
    } catch (e) {
      alert("Error: " + translateRpcError(e as Parameters<typeof translateRpcError>[0]));
    } finally {
      setGuardando(false);
    }
  }

  async function eliminar() {
    if (!rol || esSistema) return;
    if (rol.usuarios_count > 0) {
      alert(`No se puede eliminar: hay ${rol.usuarios_count} usuario(s) con este rol. Reasignalos primero.`);
      return;
    }
    if (!confirm(`¿Eliminar el rol "${rol.nombre}"? Esta acción no se puede deshacer.`)) return;
    try {
      const { error } = await db.rpc("eliminar_rol", { p_rol_id: rol.id });
      if (error) throw error;
      onDeleted();
    } catch (e) {
      alert("Error: " + translateRpcError(e as Parameters<typeof translateRpcError>[0]));
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{width:680,maxHeight:"90vh",display:"flex",flexDirection:"column"}} onClick={e => e.stopPropagation()}>
        <div className="modal-hd">
          <div className="modal-title">
            {rol ? `${esSistema ? "Ver" : "Editar"} rol: ${rol.nombre}` : "Nuevo rol custom"}
            {esSistema && <span className="badge b-info" style={{fontSize:8,marginLeft:8}}>Sistema</span>}
          </div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{flex:1,overflowY:"auto"}}>
          {esSistema && (
            <div className="alert alert-info" style={{marginBottom:12,fontSize:11}}>
              Los roles del sistema vienen pre-cargados y no se editan desde acá.
              Si necesitás un set distinto, creá un rol custom (botón en la pantalla anterior).
            </div>
          )}
          <div className="field" style={{marginBottom:12}}>
            <label>Nombre</label>
            <input value={nombre} onChange={e => setNombre(e.target.value)} disabled={!editable}
              placeholder="Ej: Encargado con anular ventas" />
          </div>
          <div className="field" style={{marginBottom:18}}>
            <label>Descripción (opcional)</label>
            <input value={descripcion} onChange={e => setDescripcion(e.target.value)} disabled={!editable}
              placeholder="Para qué sirve este rol" />
          </div>

          <div style={{fontSize:11,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>
            Permisos ({permisos.size} marcados)
          </div>

          {CATEGORIAS_PERMISOS.map(cat => (
            <div key={cat.titulo} style={{marginBottom:14,padding:10,background:"var(--s2)",borderRadius:"var(--r)"}}>
              <div style={{fontSize:11,fontWeight:500,marginBottom:6,color:"var(--txt)"}}>{cat.titulo}</div>
              {cat.perms.map(p => (
                <label key={p.slug} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"4px 0",cursor:editable?"pointer":"default"}}>
                  <input type="checkbox" checked={permisos.has(p.slug)}
                    onChange={() => toggle(p.slug)} disabled={!editable}
                    style={{marginTop:2}} />
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:12}}>{p.label}</div>
                    {p.descripcion && (
                      <div style={{fontSize:10,color:"var(--muted2)",marginTop:1,lineHeight:1.3}}>{p.descripcion}</div>
                    )}
                  </div>
                </label>
              ))}
            </div>
          ))}

          {permisosHuerfanos.length > 0 && (
            <div style={{marginBottom:14,padding:10,background:"var(--s2)",borderRadius:"var(--r)"}}>
              <div style={{fontSize:11,fontWeight:500,marginBottom:6,color:"var(--warn)"}}>
                Otros permisos legacy
              </div>
              <div style={{fontSize:10,color:"var(--muted2)",marginBottom:6}}>
                Permisos que este rol tiene pero no están categorizados. Si los borrás se pierden.
              </div>
              {permisosHuerfanos.map(slug => (
                <label key={slug} style={{display:"flex",alignItems:"center",gap:8,padding:"4px 0"}}>
                  <input type="checkbox" checked={permisos.has(slug)}
                    onChange={() => toggle(slug)} disabled={!editable} />
                  <code style={{fontSize:11}}>{slug}</code>
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="modal-ft" style={{display:"flex",gap:8,justifyContent:"space-between"}}>
          <div>
            {rol && !esSistema && (
              <button className="btn btn-danger" onClick={eliminar}>Eliminar rol</button>
            )}
          </div>
          <div style={{display:"flex",gap:8}}>
            <button className="btn btn-sec" onClick={onClose}>{editable ? "Cancelar" : "Cerrar"}</button>
            {editable && (
              <button className="btn btn-acc" onClick={guardar} disabled={guardando}>
                {guardando ? "Guardando…" : (rol ? "Guardar cambios" : "Crear rol")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
