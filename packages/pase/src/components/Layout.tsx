import { useState } from "react";
import { NavLink } from "react-router-dom";
import { ROLES, tienePermiso } from "../lib/auth";
import type { Usuario, Local, Tenant } from "../types";
import { ThemeToggle } from "./ui/ThemeToggle";
import { BandejaEntradaBoton } from "./BandejaEntradaBoton";
import { useTenantFeatures } from "../lib/useTenantFeatures";
import { tenantTieneFeature } from "../lib/features";
import polishCss from "../styles/polish.css?raw";

// Mapa de slug del sidebar → feature flag del catálogo (src/lib/features.ts).
// Si el feature está OFF para el tenant, el item NO aparece en el sidebar.
// Slugs no listados acá son siempre visibles (inicio, tenants).
//
// Sprint 27-may noche: feature flags por tenant. Superadmin administra
// desde /tenants → "Funciones".
const SLUG_TO_FEATURE: Record<string, string> = {
  caja: "modulo.caja",
  compras: "modulo.compras",
  ventas: "modulo.ventas",
  gastos: "modulo.gastos",
  rrhh: "modulo.rrhh",
  negocio: "modulo.negocio",
  // finanzas: el item de sidebar se fusionó en Negocio (11-jun) — el feature
  // "modulo.finanzas" ya no gatea ningún item propio.
  objetivos: "modulo.objetivos",
  eerr: "modulo.reportes",
  herramientas_hub: "modulo.herramientas_hub",
  ajustes: "modulo.ajustes",
  usuarios: "modulo.usuarios",
};
// Sprint COMANDA Autónomo (24-may noche): abrirComanda eliminado del sidebar.
// COMANDA es un sistema independiente — los users se loguean directo en
// pase-comanda.vercel.app. No hay más botón cross-sistema.
// import { abrirComanda } from "../lib/comanda-sso";

interface SidebarProps {
  user: Usuario;
  onLogout: () => Promise<void> | void;
  locales: Local[];
  localActivo: number | null;
  setLocalActivo: (v: number | null) => void;
  tenant: Tenant | null;
  // UUID del tenant impersonado por superadmin (TASK 0.15). null = vista
  // propia del superadmin (sin override).
  tenantOverride: string | null;
  onClearOverride: () => void;
}

export function Sidebar({ user, onLogout, locales, localActivo, setLocalActivo, tenant, tenantOverride, onClearOverride }: SidebarProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const esSuperAdmin = user.rol === "superadmin";
  const localesDisp = (user.rol==="dueno" || user.rol==="admin" || esSuperAdmin) ? locales : locales.filter((l: { id: number })=>(user._locales||user.locales||[]).includes(l.id));
  // Sprint 27-may noche: features por tenant. Para superadmin, el helper
  // tenantTieneFeature siempre devuelve TRUE — ven todo.
  const { features: tenantFeatures } = useTenantFeatures(user.tenant_id ?? null);
  // ───────────────────────────────────────────────────────────────────
  // Sidebar consolidado a 13 items en 4 secciones (sprint mayo 2026):
  //   • OPERACIÓN    (4) — caja, compras, ventas, gastos
  //   • DIRECCIÓN    (4) — negocio, finanzas, objetivos, reportes
  //   • HERRAMIENTAS (3) — equipo, contador/iva, blindaje
  //   • SISTEMA      (3) — ajustes, usuarios, tenants
  //
  // 'tenants' aparece solo si user.rol === "superadmin" (filtrado por
  // getPermisos en lib/auth.ts). Items con `path` (URL real, post Commit 1
  // sprint v2 — React Router). El `slug` se mantiene para compat con
  // tienePermiso() y el array de permisos por rol. Tocar acá implica
  // ajustar src/lib/sidebar-nav.ts (misma source-of-truth).
  // ───────────────────────────────────────────────────────────────────
  // `altSlugs`: el item se muestra si el user tiene el slug principal O
  // alguno de los alternativos. Caso: Negocio absorbió Finanzas (11-jun) —
  // usuarios con permiso 'finanzas' pero sin 'negocio' siguen viendo el item.
  const nav: Array<{ slug: string; path: string; label: string; sec: string; icon: string; altSlugs?: string[] }> = [
    // === INICIO (1) — dashboard personalizado por usuario ===
    {slug:"inicio",path:"/inicio",label:"Inicio",sec:"Operación",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6 L7 2 L12 6 V12 a1 1 0 0 1 -1 1 H3 a1 1 0 0 1 -1 -1 Z"/><path d="M5.5 13 V8.5 h3 V13"/></svg>`},

    // === OPERACIÓN (4) ===
    {slug:"caja",path:"/caja",label:"Caja",sec:"Operación",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="5" width="12" height="8" rx="1"/><path d="M4 5V4a3 3 0 0 1 6 0v1"/></svg>`},
    {slug:"compras",path:"/compras",label:"Compras",sec:"Operación",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1"/><circle cx="11" cy="12" r="1"/><path d="M1 2h2l1.5 7.5h7L13 4H4"/></svg>`},
    {slug:"ventas",path:"/ventas",label:"Ventas",sec:"Operación",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="5.5"/><path d="M7 4v6M9 5.5c0-1-1-1.5-2-1.5s-2 .5-2 1.5 1 1.3 2 1.5 2 .5 2 1.5-1 1.5-2 1.5-2-.5-2-1.5"/></svg>`},
    {slug:"gastos",path:"/gastos",label:"Gastos",sec:"Operación",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="6" r="4.5"/><path d="M7 4v4M5 6.5l2 2 2-2"/></svg>`},
    // Equipo MOVIDO de Herramientas → Operación 2026-05-18 (Lucas).
    {slug:"rrhh",path:"/equipo",label:"Equipo",sec:"Operación",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5" cy="5" r="2.5"/><path d="M1 13c0-2.5 2-4 4-4s4 1.5 4 4"/><circle cx="10" cy="5" r="2"/><path d="M13 13c0-2 -1-3.5-3-3.5"/></svg>`},
    // Recetario (28-may noche): hub Insumos+Recetas. Reemplaza los 2 entries
    // que estaban sueltos en Dirección. Slug 'rentabilidad' por permisos.
    {slug:"rentabilidad",path:"/recetario",label:"Recetario",sec:"Operación",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2h6l2 2v8.5a.5.5 0 0 1-.5.5H3.5a.5.5 0 0 1-.5-.5z"/><path d="M5 5h4M5 7.5h4M5 10h3"/></svg>`},
    // Reservas OCULTADO 2026-05-18 (Lucas: "no sirve, vive en COMANDA").
    // Item comentado para reactivar fácil si se decide reintroducir.
    // {slug:"reservas",path:"/reservas",label:"Reservas",sec:"Operación",icon:`<svg...`},

    // Equipo y Contador/IVA TAMBIÉN viven en el hub /herramientas ahora
    // (Lucas 2026-05-18: "herramientas no concentré todo al final"). Se sacan
    // del sidebar para evitar duplicación. Las rutas standalone siguen
    // existiendo para compat con tour y bookmarks.

    // === DIRECCIÓN (4) ===
    // Finanzas fusionada en Negocio (rediseño 11-jun): una sola vista de
    // dirección. altSlugs mantiene el acceso a users con permiso 'finanzas'.
    {slug:"negocio",altSlugs:["finanzas"],path:"/negocio",label:"Negocio",sec:"Dirección",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 1.5 A5.5 5.5 0 1 1 1.5 7 L7 7 Z"/><path d="M7 1.5 A5.5 5.5 0 0 1 12.5 7 L7 7 Z"/></svg>`},
    // Conciliación 10-jun-2026 (Lucas): nuevo módulo para cierre de mes contra
    // extracto de MercadoPago. Cruza el archivo del panel MP línea por línea
    // contra movimientos.cuenta='MercadoPago' del local activo.
    {slug:"conciliacion",path:"/conciliacion-extracto",label:"Conciliación",sec:"Dirección",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4l2 2 4-4"/><path d="M2 9l2 2 4-4"/><path d="M11 4h1.5"/><path d="M11 9h1.5"/></svg>`},
    {slug:"objetivos",path:"/objetivos",label:"Objetivos",sec:"Dirección",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5.5"/><circle cx="7" cy="7" r="3"/><circle cx="7" cy="7" r="0.5" fill="currentColor"/></svg>`},
    {slug:"eerr",path:"/reportes",label:"Reportes",sec:"Dirección",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1,11 5,7 8,9 13,3"/><polyline points="10,3 13,3 13,6"/></svg>`},
    {slug:"rentabilidad",path:"/rentabilidad",label:"Rentabilidad",sec:"Dirección",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 11V5l3 4 3-6 4 8"/></svg>`},

    // === HERRAMIENTAS (1) ===
    // Consolidación 2026-05-18 (Lucas: "herramientas concentrá todo al final").
    // Una sola entrada al hub /herramientas con grilla de cards adentro:
    // Equipo, Contador/IVA, Blindaje, Importar, Lector MP, Configurar
    // dashboards, Códigos Manager. Las rutas standalone /equipo, /herramientas/*
    // siguen existiendo para compat con tour y bookmarks.
    {slug:"herramientas_hub",path:"/herramientas",label:"Herramientas",sec:"Herramientas",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5l3-3 2 2-3 3-2 0z"/><path d="M9 7l3 3-1.5 1.5-3-3"/><path d="M5 9l-3 3M7 7l5 5"/></svg>`},

    // === SISTEMA (5) ===
    {slug:"ajustes",path:"/ajustes",label:"Ajustes",sec:"Sistema",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="2.5"/><path d="M7 1v1M7 12v1M1 7h1M12 7h1M2.9 2.9l.7.7M10.4 10.4l.7.7M2.9 11.1l.7-.7M10.4 3.6l.7-.7"/></svg>`},
    {slug:"usuarios",path:"/usuarios",label:"Usuarios",sec:"Sistema",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="4.5" r="2.5"/><path d="M2.5 12.5c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5"/></svg>`},
    {slug:"tenants",path:"/tenants",label:"Tenants",sec:"Sistema",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="1.5" width="9" height="11" rx="0.5"/><path d="M5 4h1M8 4h1M5 6.5h1M8 6.5h1M5 9h1M8 9h1M6.5 12.5v-2h1v2"/></svg>`},
  ];
  const secs = [...new Set(nav.map(n=>n.sec))];
  return (
    <>
      <button className="hamburger" onClick={() => setOpen(o => !o)} aria-label="Menú">☰</button>
      <div className={`overlay-sb ${open ? "open" : ""}`} onClick={close}/>
      <div className={`sb ${open ? "open" : ""}`}>
        <div className="sb-logo">
          <div className="brand">pase<span className="brand-dot">.</span></div>
          <div className="brand-sub">aliado gastronómico</div>
          {/* Multi-tenant badges (TASK 0.15). El nombre del tenant en
              régimen normal (no-superadmin) NO se muestra acá — es
              redundante con el dropdown de sucursales del propio sidebar.
              Sprint v2 cosmético: header minimalista. */}
          {esSuperAdmin && !tenantOverride && (
            <div className="badge-sb badge-sb-super">Modo superadmin</div>
          )}
          {tenantOverride && tenant && (
            <div className="badge-sb badge-sb-tenant">
              <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tenant.nombre}</span>
              <button onClick={onClearOverride} className="badge-sb-close" title="Volver a vista superadmin">✕</button>
            </div>
          )}
        </div>
        {localesDisp.length > 1 && (
          <div className="sb-local" data-tour="sidebar-local">
            {/* Decisión Lucas 2026-05-17: eliminada la opción "Todas las
                sucursales" del sidebar. El modo consolidado generaba bugs
                de lógica (objetivos de 1 local cruzados con ventas de N).
                Las comparativas viven dentro de pantallas específicas
                (ej: card "Ranking sucursales" en /negocio). El sidebar
                siempre tiene UNA sucursal activa. */}
            <select value={localActivo??""} onChange={e=>setLocalActivo(parseInt(e.target.value))}>
              {localesDisp.map((l: { id: number; nombre: string })=><option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
          </div>
        )}
        <nav className="sb-nav" data-tour="sidebar-nav">
          {secs.map(s=>{
            // tienePermiso (no perms.includes) para respetar los short-circuits
            // de slugs especiales: 'inicio' (todos), 'ajustes_dashboards' (dueño/admin),
            // 'tenants' (superadmin). Estos no viven en MODULOS pero sí en `nav`.
            const items = nav.filter(n => {
              if (n.sec !== s) return false;
              const tieneAcceso = tienePermiso(user, n.slug)
                || (n.altSlugs ?? []).some(alt => tienePermiso(user, alt));
              if (!tieneAcceso) return false;
              // Feature flag gate — superadmin bypassa (tenantTieneFeature
              // siempre devuelve TRUE). Tenant normal: si el feature está
              // mapeado y desactivado, ocultar.
              if (esSuperAdmin) return true;
              const featureSlug = SLUG_TO_FEATURE[n.slug];
              if (!featureSlug) return true; // sin mapeo = siempre visible
              return tenantTieneFeature(featureSlug, tenantFeatures);
            });
            if(!items.length) return null;
            return (<div key={s}><div className="sb-section">{s}</div>{items.map(n=>(
              <NavLink
                key={n.slug}
                to={n.path}
                onClick={close}
                className={({isActive}) => `nav-item${isActive ? " active" : ""}`}
              >
                <span style={{width:14,height:14,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}} dangerouslySetInnerHTML={{__html: n.icon}}/>
                {n.label}
              </NavLink>
            ))}</div>);
          })}
        </nav>
        <div className="sb-user">
          {/* Fila 'Nombre | Toggle tema' — el toggle vivía flotando entre
              el nav y el bloque del usuario; sprint v2 cosmético lo trae
              al row del nombre para agrupar visualmente la zona inferior. */}
          <div className="sb-user-row">
            <div className="sb-uname">{user.nombre}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <BandejaEntradaBoton user={user} />
              <ThemeToggle />
            </div>
          </div>
          {/* Decisión 2026-05-13: roles sin color. La distinción es solo textual. */}
          <div className="sb-urole">{ROLES[user.rol]?.label}</div>
          {/* Botón "Abrir COMANDA" ELIMINADO 24-may noche.
              Sprint COMANDA Autónomo Fase 5: COMANDA es un sistema
              independiente — el dueño se loguea directo en
              pase-comanda.vercel.app con su email/password de PASE
              (auth compartido, perfiles separados). */}
          <button className="sb-logout" onClick={onLogout}>Cerrar sesión →</button>
        </div>
      </div>
    </>
  );
}

export const css = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

/* ─────────────────────────────────────────────────────────────────────
 * PASE Design System v1.0 (aprobado 2026-05-13, doc: /DESIGN_SYSTEM.md).
 *
 * Las variables legacy (--bg, --s1, --s2, --s3, --bd, --bd2, --acc, --txt,
 * --muted, --muted2, --danger, --success, --warn, --info, --r) se mapean
 * a los tokens nuevos para preservar compatibilidad con TODO el código
 * que ya las usa (inline styles en 25 pantallas). Esta capa de aliasing
 * permite migrar componente por componente sin big-bang.
 *
 * Reglas críticas:
 * - Único celeste de marca: --pase-celeste. Sin verdes/rojos/violetas.
 * - --success se mapea a celeste (positivos en celeste, no verde).
 * - --danger/--warn/--info se mapean a text-muted (sin alarma cromática).
 * - Bordes 0.5px en lugar de 1px.
 * - Sin gradientes, sin box-shadows profundas.
 * ──────────────────────────────────────────────────────────────────── */
:root {
  --bg:       var(--pase-bg);
  --s1:       var(--pase-bg-soft);
  --s2:       var(--pase-bg-soft);
  --s3:       var(--pase-celeste-100);
  --bd:       var(--pase-border);
  --bd2:      var(--pase-border-strong);
  --acc:      var(--pase-celeste);
  --txt:      var(--pase-text);
  --muted:    var(--pase-text-muted);
  --muted2:   var(--pase-text-muted);
  --danger:   var(--pase-text);
  --success:  var(--pase-celeste);
  --warn:     var(--pase-text-muted);
  --info:     var(--pase-text-muted);
  --r:        var(--pase-radius-md);
}

body{
  background:var(--pase-bg-page);
  color:var(--pase-text);
  font-family:var(--pase-font);
  font-size:13px;
  line-height:1.55;
  min-height:100vh;
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
  transition:background-color 0.2s ease,color 0.2s ease;
}

/* Detalle decorativo: línea de 4px en gradiente celeste→dorado en el borde
   superior derecho del frame, solo visible en dark mode. Inspirado en el
   piping de la camiseta suplente Argentina 2006. */
[data-theme="dark"] body::after {
  content: '';
  position: fixed;
  top: 0;
  right: 0;
  width: 280px;
  height: 4px;
  background: linear-gradient(90deg, var(--pase-celeste), var(--pase-gold));
  opacity: 0.55;
  pointer-events: none;
  z-index: 100;
}

.app{display:flex;min-height:100vh}

/* ─── SIDEBAR ──────────────────────────────────────────────────────── */
.sb{width:220px;background:var(--pase-bg);border-right:0.5px solid var(--pase-border);display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:20}
/* Detalle decorativo "argentino" (2026-05-14): banner de 5px arriba del
   header del sidebar con stripes celeste-blanco-celeste (estética de la
   bandera). El --pase-bg adapta automáticamente a dark mode. */
.sb-logo{padding:28px 20px 24px;border-bottom:0.5px solid var(--pase-border);text-align:center;position:relative}
.sb-logo::before{content:'';position:absolute;top:0;left:0;right:0;height:5px;background:linear-gradient(180deg,var(--pase-celeste) 0,var(--pase-celeste) 2px,var(--pase-bg) 2px,var(--pase-bg) 3px,var(--pase-celeste) 3px,var(--pase-celeste) 5px);opacity:0.85}
.brand{font-size:32px;font-weight:500;color:var(--pase-text);letter-spacing:-0.035em;line-height:1}
/* El punto del logo: dorado --pase-gold. Junto con el sol del InfoTooltip,
   son los 2 únicos usos de dorado en el producto (anclas de marca). */
.brand-dot{color:var(--pase-gold)}
.brand-sub{font-size:9px;color:var(--pase-text-muted);letter-spacing:0.04em;margin-top:6px}
.brand-tenant{margin-top:10px;font-size:10px;color:var(--pase-text-muted);letter-spacing:0.02em}
.badge-sb{margin-top:10px;padding:4px 8px;border-radius:8px;font-size:9.5px;font-weight:500;text-align:center}
.badge-sb-super{background:var(--pase-celeste-100);color:var(--pase-text);letter-spacing:0.02em}
.badge-sb-tenant{background:var(--pase-celeste-100);color:var(--pase-text);display:flex;align-items:center;justify-content:space-between;gap:6px}
.badge-sb-close{background:none;border:none;color:var(--pase-text-muted);cursor:pointer;padding:0;font-size:11px}
.badge-sb-close:hover{color:var(--pase-text)}

.sb-local{padding:10px 14px;border-bottom:0.5px solid var(--pase-border)}
.sb-local select{width:100%;background:var(--pase-bg);border:0.5px solid var(--pase-border-strong);color:var(--pase-text);padding:6px 8px;font-size:11.5px;font-family:var(--pase-font);border-radius:8px;outline:none}
.sb-local select:focus{border-color:var(--pase-celeste-300)}

.sb-nav{flex:1;padding:8px 0;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--pase-border-strong) transparent}
.sb-nav::-webkit-scrollbar{width:4px}
.sb-nav::-webkit-scrollbar-thumb{background:var(--pase-border-strong);border-radius:2px}
.sb-section{padding:14px 12px 6px;font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:var(--pase-celeste-300);font-weight:500}
.nav-item{display:flex;align-items:center;gap:10px;padding:8px 14px;cursor:pointer;font-size:12.5px;color:var(--pase-text-muted);border-radius:8px;margin:1px 10px;transition:background 0.15s ease,color 0.15s ease;text-decoration:none}
.nav-item:hover,.nav-item:focus,.nav-item.active{text-decoration:none}
.nav-item:hover{background:var(--pase-bg-soft);color:var(--pase-text)}
.nav-item.active{background:var(--pase-celeste-100);color:var(--pase-text);font-weight:500}

.sb-user{padding:14px 16px;border-top:0.5px solid var(--pase-border)}
.sb-user-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.sb-uname{font-size:12px;font-weight:500;color:var(--pase-text)}
.sb-urole{font-size:10px;color:var(--pase-text-muted)}
.sb-logout{display:block;width:100%;margin-top:8px;padding:6px;background:transparent;border:0.5px solid var(--pase-border-strong);color:var(--pase-text-muted);cursor:pointer;font-size:10px;font-family:var(--pase-font);border-radius:8px;transition:all 0.15s}
.sb-logout:hover{border-color:var(--pase-celeste-300);color:var(--pase-text)}
.sb-comanda{display:block;width:100%;margin-top:8px;padding:7px 8px;background:var(--pase-celeste-100);border:0.5px solid var(--pase-celeste-300);color:var(--pase-text);font-size:11px;font-weight:500;font-family:var(--pase-font);border-radius:8px;transition:all 0.15s;text-align:center;text-decoration:none}
.sb-comanda:hover{background:var(--pase-celeste-200);border-color:var(--pase-celeste-400)}

/* ─── MAIN ─────────────────────────────────────────────────────────── */
.main{margin-left:220px;flex:1;padding:28px 36px 36px;min-height:100vh;background:var(--pase-bg-page)}
.ph-row{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:22px;gap:12px;flex-wrap:wrap}
.ph-title{font-family:var(--pase-font);font-size:20px;font-weight:500;line-height:1.15;color:var(--pase-text);letter-spacing:-0.025em}
.ph-sub{font-size:11px !important;color:var(--pase-text-muted);margin-top:5px;font-weight:400 !important}

/* ─── GRIDS ────────────────────────────────────────────────────────── */
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:20px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px}

/* ─── KPI / PANEL / CARDS ──────────────────────────────────────────── */
.kpi{background:var(--pase-bg);border:0.5px solid var(--pase-border);border-radius:14px;padding:16px 18px}
.kpi.kpi-sm{padding:12px 14px}
.kpi-label{font-size:var(--pase-fs-sm);color:var(--pase-text-muted);margin-bottom:8px;font-weight:500;letter-spacing:0.03em;text-transform:uppercase}
.kpi-value{font-size:var(--pase-fs-2xl);font-weight:500;line-height:1.1;color:var(--pase-text);letter-spacing:var(--pase-ls-tight);font-variant-numeric:tabular-nums}
.kpi-value-compact{font-size:18px;font-weight:500;line-height:1.1;color:var(--pase-text);letter-spacing:var(--pase-ls-tight);font-variant-numeric:tabular-nums}
.kpi-sub{font-size:var(--pase-fs-sm);color:var(--pase-text-muted);margin-top:6px}
.kpi-acc{color:var(--pase-celeste)}
.kpi-danger{color:var(--pase-text)}
.kpi-warn{color:var(--pase-text-muted)}
.kpi-success{color:var(--pase-celeste)}

.panel{background:var(--pase-bg);border:0.5px solid var(--pase-border);border-radius:var(--pase-radius-card);margin-bottom:18px;overflow:hidden;transition:border-color 0.15s ease}
.panel-hd{padding:14px 20px;border-bottom:0.5px solid var(--pase-border);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:var(--pase-bg)}
.panel-title{font-size:var(--pase-fs-md);font-weight:500;color:var(--pase-text);letter-spacing:var(--pase-ls-snug)}

/* ─── TABLAS ─────────────────────────────────────────────────────────
 * Polish v2 2026-05-17:
 * - thead sticky (queda visible al scrollear tablas largas)
 * - Hover sutil con transition + cursor en filas clickeables
 * - .num / .num-right helpers para alinear columnas de plata a la derecha
 * - .col-fecha / .col-id helpers para columnas chicas (tabular-nums)
 * - Padding 8/12 — densidad consistente
 * - Bordes finos var(--pase-border)
 */
table{width:100%;border-collapse:collapse;font-family:var(--pase-font)}
thead th{
  padding:10px 14px;
  text-align:left;
  font-size:var(--pase-fs-xs);
  font-weight:500;
  color:var(--pase-text-muted);
  border-bottom:0.5px solid var(--pase-border-strong);
  background:var(--pase-bg);
  letter-spacing:0.04em;
  text-transform:uppercase;
  position:sticky;
  top:0;
  z-index:1;
  white-space:nowrap;
}
thead th.num-right,thead th.col-monto{text-align:right}
thead th.col-fecha,thead th.col-id{text-align:left;white-space:nowrap}
tbody tr{
  border-bottom:0.5px solid var(--pase-border);
  transition:background 0.12s ease;
}
tbody tr:last-child{border-bottom:none}
tbody tr:hover{background:var(--pase-bg-soft)}
tbody tr.clickable{cursor:pointer}
tbody tr.clickable:hover{background:var(--pase-celeste-100)}
td{padding:10px 14px;font-size:var(--pase-fs-base);color:var(--pase-text);vertical-align:middle}
td.num,td.num-right,td.col-monto{font-variant-numeric:tabular-nums;text-align:right;font-weight:500}
td.col-fecha,td.col-id{font-variant-numeric:tabular-nums;color:var(--pase-text-muted);font-size:var(--pase-fs-sm)}
td.col-truncate{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Wrapper de scroll horizontal para tablas. Necesario porque el contenedor
   .panel tiene overflow hidden (para preservar el border-radius del
   border) — sin este wrapper, las tablas anchas se cortan en seco. Usar
   envolviendo la tabla y además darle a la tabla un min-width para
   garantizar legibilidad mínima.
   Creado 2026-05-20 (Lucas: "se desconfigura a cada rato" cuando se
   agregaba/quitaba una columna en Caja).
*/
.table-scroll-wrap{
  width:100%;
  overflow-x:auto;
  /* Saca la barra de scroll cuando la tabla ya entra (mejora UX en desktop).
     Solo aparece cuando hace falta. */
  scrollbar-gutter:stable;
  /* Custom scrollbar más sutil (igual que el resto de la app). */
  scrollbar-width:thin;
  scrollbar-color:var(--pase-border) transparent;
}
.table-scroll-wrap::-webkit-scrollbar{height:8px}
.table-scroll-wrap::-webkit-scrollbar-track{background:transparent}
.table-scroll-wrap::-webkit-scrollbar-thumb{background:var(--pase-border);border-radius:4px}
.table-scroll-wrap::-webkit-scrollbar-thumb:hover{background:var(--pase-text-muted)}

/* ─── FOCUS RING UNIFICADO (a11y) ───────────────────────────────────── */
/* Cualquier elemento interactivo con :focus-visible recibe el mismo ring
   celeste. Reemplaza los outlines nativos del browser inconsistentes. */
button:focus-visible,
a:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
[role="button"]:focus-visible{
  outline:2px solid var(--pase-celeste);
  outline-offset:2px;
}

/* Hover lift sutil aplicable a cualquier elemento interactivo */
.lift{transition:transform 0.15s ease,box-shadow 0.15s ease}
.lift:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(15,30,45,0.06)}

/* Animación fade-in para entradas de listas/cards. Usar .anim-in className */
@keyframes pase-fade-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.anim-in{animation:pase-fade-in 0.2s ease-out}

/* ─── BADGES ───────────────────────────────────────────────────────── */
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:var(--pase-fs-xs);font-weight:500;background:var(--pase-celeste-100);color:var(--pase-text);letter-spacing:0.02em}
.b-danger{background:var(--pase-bg-out);color:var(--pase-text-muted)}
.b-success{background:var(--pase-celeste-100);color:var(--pase-text)}
.b-warn{background:var(--pase-bg-out);color:var(--pase-text-muted)}
.b-info{background:var(--pase-celeste-100);color:var(--pase-text)}
.b-muted{background:var(--pase-bg-out);color:var(--pase-text-muted)}
.b-anulada{background:var(--pase-bg-out);color:var(--pase-text-muted);text-decoration:line-through}

/* ─── BOTONES ──────────────────────────────────────────────────────── */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:var(--pase-h-md);padding:0 16px;border:none;cursor:pointer;font-family:var(--pase-font);font-size:var(--pase-fs-base);font-weight:500;border-radius:8px;transition:all 0.15s;white-space:nowrap;letter-spacing:var(--pase-ls-snug)}
.btn-acc{background:var(--pase-celeste);color:#fff;border:none}
.btn-acc:hover{background:var(--pase-celeste-300)}
.btn-sec{background:var(--pase-bg);color:var(--pase-text);border:0.5px solid var(--pase-border-strong)}
.btn-sec:hover{background:var(--pase-bg-soft);border-color:var(--pase-celeste-300)}
.btn-ghost{background:transparent;color:var(--pase-text-muted);border:0.5px solid var(--pase-border-strong)}
.btn-ghost:hover{color:var(--pase-text);background:var(--pase-bg-soft)}
.btn-sm{height:var(--pase-h-sm);padding:0 10px;font-size:var(--pase-fs-sm)}
.btn-success{background:transparent;color:var(--pase-celeste);border:0.5px solid var(--pase-celeste-300)}
.btn-success:hover{background:var(--pase-celeste-100)}
.btn-danger{background:transparent;color:var(--pase-text);border:0.5px solid var(--pase-border-strong)}
.btn-danger:hover{background:var(--pase-bg-soft);border-color:var(--pase-text-muted)}

/* ─── FORMS ────────────────────────────────────────────────────────── */
.field{margin-bottom:14px}
.field label{display:block;font-size:var(--pase-fs-xs);color:var(--pase-text-muted);margin-bottom:6px;font-weight:500;letter-spacing:0.03em;text-transform:uppercase}
.field input,.field select,.field textarea{width:100%;height:var(--pase-h-md);background:var(--pase-bg);border:0.5px solid var(--pase-border-strong);color:var(--pase-text);padding:0 12px;font-family:var(--pase-font);font-size:var(--pase-fs-base);border-radius:8px;outline:none;transition:border-color 0.15s,box-shadow 0.15s}
.field textarea{height:auto;padding:9px 11px;min-height:80px}
.field input:focus,.field select:focus,.field textarea:focus{border-color:var(--pase-celeste);box-shadow:0 0 0 3px var(--pase-celeste-100)}
.field select option{background:var(--pase-bg);color:var(--pase-text)}

.form2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.form4{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;align-items:end}

/* ─── MODALES ──────────────────────────────────────────────────────── */
/* overlay con padding-left:200px para respetar el sidebar fijo. Sin esto,
   modales anchos (legajo, pago de sueldo) se centraban en el viewport
   total y quedaban tapados parcialmente por el sidebar. */
.overlay{position:fixed;inset:0;padding-left:220px;background:rgba(10,20,40,0.45);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:100}
@media (max-width: 920px){ .overlay{padding-left:0} }
.modal{background:var(--pase-bg);border:0.5px solid var(--pase-border);border-radius:16px;width:640px;max-width:96vw;max-height:92vh;overflow-y:auto}
.modal-hd{padding:18px 24px;border-bottom:0.5px solid var(--pase-border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--pase-bg);z-index:1}
.modal-title{font-family:var(--pase-font);font-size:var(--pase-fs-lg);font-weight:500;color:var(--pase-text);letter-spacing:var(--pase-ls-tight)}
.modal-body{padding:24px;color:var(--pase-text)}
.modal-ft{padding:16px 24px;border-top:0.5px solid var(--pase-border);display:flex;gap:10px;justify-content:flex-end;position:sticky;bottom:0;background:var(--pase-bg)}
.close-btn{background:none;border:none;color:var(--pase-text-muted);cursor:pointer;font-size:18px;line-height:1}
.close-btn:hover{color:var(--pase-text)}

/* ─── TABS ─────────────────────────────────────────────────────────── */
.tabs{display:flex;border-bottom:0.5px solid var(--pase-border);margin-bottom:18px;flex-wrap:wrap;gap:4px}
.tab{padding:9px 16px;font-size:var(--pase-fs-base);cursor:pointer;color:var(--pase-text-muted);border-bottom:2px solid transparent;margin-bottom:-0.5px;transition:all 0.15s}
.tab.active{color:var(--pase-text);border-bottom-color:var(--pase-celeste);font-weight:500}
.tab:hover:not(.active){color:var(--pase-text)}

/* ─── ALERTS ───────────────────────────────────────────────────────── */
.alert{padding:11px 14px;border-radius:10px;font-size:var(--pase-fs-base);margin-bottom:12px;border:0.5px solid var(--pase-border);line-height:1.5;background:var(--pase-bg-soft);color:var(--pase-text)}
.alert-danger,.alert-warn,.alert-success,.alert-info{background:var(--pase-bg-soft);border-color:var(--pase-border);color:var(--pase-text)}

/* ─── CAJAS ────────────────────────────────────────────────────────── */
.caja-card{background:var(--pase-bg);border:0.5px solid var(--pase-border);border-radius:14px;padding:18px 20px;position:relative;overflow:hidden}
.caja-name{font-size:var(--pase-fs-sm);color:var(--pase-text-muted);margin-bottom:8px;font-weight:500;letter-spacing:var(--pase-ls-snug)}
.caja-saldo{font-family:var(--pase-font);font-size:var(--pase-fs-2xl);font-weight:500;color:var(--pase-text);letter-spacing:var(--pase-ls-tight);font-variant-numeric:tabular-nums}

.anulada-row{opacity:0.5}

/* ─── SEARCH (inputs/selects/date en filtros) ──────────────────────── */
/* Aplicable a <input>, <input type="date">, <input type="month"> y <select>.
   Misma altura/border/font para que la barra de filtros se vea ordenada. */
.search,input.search,select.search,input[type="date"].search,input[type="month"].search,input[type="search"].search{
  height:32px;
  background:var(--pase-bg);
  border:0.5px solid var(--pase-border-strong);
  color:var(--pase-text);
  padding:0 12px;
  font-family:var(--pase-font);
  font-size:var(--pase-fs-sm);
  border-radius:8px;
  outline:none;
  transition:border-color 0.15s,box-shadow 0.15s;
  box-sizing:border-box;
  vertical-align:middle;
}
.search:focus,input.search:focus,select.search:focus,input[type="date"].search:focus,input[type="month"].search:focus,input[type="search"].search:focus{
  border-color:var(--pase-celeste);
  box-shadow:0 0 0 3px var(--pase-celeste-100);
}
/* Caret nativo del select reemplazado por chevron consistente */
select.search{
  appearance:none;
  -webkit-appearance:none;
  background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg width='10' height='10' viewBox='0 0 12 12' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%236E8CAB' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat:no-repeat;
  background-position:right 10px center;
  padding-right:28px;
  cursor:pointer;
}
/* Calendar icon del input date alineado */
input[type="date"].search::-webkit-calendar-picker-indicator,
input[type="month"].search::-webkit-calendar-picker-indicator{
  cursor:pointer;
  opacity:0.55;
  transition:opacity 0.15s;
}
input[type="date"].search:hover::-webkit-calendar-picker-indicator,
input[type="month"].search:hover::-webkit-calendar-picker-indicator{
  opacity:0.85;
}

/* ─── ESTADOS ──────────────────────────────────────────────────────── */
/* Polish v2 2026-05-17: empty/loading legacy refinados para que las pantallas
   que todavía no migraron a <EmptyState> se vean dignas (no migrar 8+ pantallas
   archivo por archivo cuando una mejora global cubre el 80%). */
.empty{
  padding:40px 24px;
  text-align:center;
  color:var(--pase-text-muted);
  font-size:var(--pase-fs-sm);
  line-height:1.55;
  font-style:italic;
  letter-spacing:var(--pase-ls-snug);
}
.loading{
  padding:40px 24px;
  text-align:center;
  color:var(--pase-text-muted);
  font-size:var(--pase-fs-sm);
  letter-spacing:var(--pase-ls-snug);
}

/* ─── LOGIN ────────────────────────────────────────────────────────── */
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--pase-bg-page);position:relative}
.login-bg{position:absolute;inset:0}
.login-card{position:relative;width:420px;background:var(--pase-bg);border:0.5px solid var(--pase-border);border-radius:16px;padding:44px 40px}
.login-brand{font-family:var(--pase-font);font-size:36px;font-weight:500;color:var(--pase-text);line-height:1;letter-spacing:-0.04em}
.login-sub{font-size:11px;color:var(--pase-text-muted);margin-bottom:36px;margin-top:8px;letter-spacing:0.02em}

/* ─── NUM/MONO ─────────────────────────────────────────────────────── */
.num{font-family:var(--pase-font);font-size:14px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--pase-text)}
.mono{font-family:var(--pase-font);font-size:11px;font-variant-numeric:tabular-nums}

/* ─── EERR ─────────────────────────────────────────────────────────── */
.eerr-row{display:flex;align-items:center;justify-content:space-between;padding:9px 16px;border-bottom:0.5px solid var(--pase-border);color:var(--pase-text)}
.eerr-row:last-child{border-bottom:none}
.eerr-section-title{padding:11px 16px;font-size:11px;color:var(--pase-text-muted);font-weight:500;border-top:0.5px solid var(--pase-border);background:var(--pase-bg-soft);letter-spacing:-0.01em}

.items-table{width:100%;border-collapse:collapse;margin-top:8px}
.items-table th{font-size:var(--pase-fs-sm);color:var(--pase-text-muted);padding:6px;text-align:left;border-bottom:0.5px solid var(--pase-border);font-weight:500}
.items-table td{padding:7px 6px;font-size:var(--pase-fs-base);color:var(--pase-text)}
.items-table tr:hover{background:var(--pase-bg-soft)}

.saldo-edit{display:flex;gap:8px;align-items:center}
.saldo-edit input{width:160px}

.section{margin-bottom:14px}
.section-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.section-title{font-size:var(--pase-fs-sm);color:var(--pase-text-muted);font-weight:500;letter-spacing:var(--pase-ls-snug)}
.section-total{font-size:var(--pase-fs-base);color:var(--pase-text);font-weight:500;font-variant-numeric:tabular-nums}

/* ─── PILLS ────────────────────────────────────────────────────────── */
.pills{display:flex;gap:5px;margin-bottom:14px;flex-wrap:wrap}
.pill{padding:4px 11px;border-radius:999px;font-size:var(--pase-fs-sm);cursor:pointer;color:var(--pase-text-muted);border:0.5px solid var(--pase-border);background:var(--pase-bg);transition:all 0.12s}
.pill:hover{color:var(--pase-text);border-color:var(--pase-celeste-300)}
.pill.active{background:var(--pase-celeste-100);color:var(--pase-text);border-color:var(--pase-celeste-100)}

/* ─── Layout módulo madre con sub-nav lateral derecho ───────────────
   Wrapper de Compras y Caja (cualquier módulo con RightSubNav). El sub-nav
   ocupa 168px a la derecha en desktop. En mobile (<900px) el sub-nav pasa
   arriba (order:-1) y el grid colapsa a 1 columna — sino las tablas del
   contenido principal quedan apretadas al lado del aside.
*/
.module-with-aside {
  display: grid;
  grid-template-columns: 1fr 168px;
  gap: 20px;
  align-items: start;
}
@media (max-width: 900px) {
  .module-with-aside {
    grid-template-columns: 1fr;
    gap: 12px;
  }
  .module-with-aside > aside {
    order: -1;
  }
}

/* build: 2026-05-13-ds-v1 */

/* ─── MOBILE/TABLET ≤1024px ────────────────────────────────────────── */
@media (max-width: 1024px) {
  .sb {
    transform: translateX(-100%);
    transition: transform 0.25s ease;
    z-index: 50;
    width: 240px;
    box-shadow: 0 0 32px rgba(26,58,94,0.08);
  }
  .sb.open { transform: translateX(0); }
  .main {
    margin-left: 0;
    padding: 16px;
    padding-top: calc(60px + env(safe-area-inset-top, 0px));
    background: var(--pase-bg-page);
  }
  .grid4 { grid-template-columns: repeat(2,1fr); }
  .grid3 { grid-template-columns: repeat(2,1fr); }
  .grid2 { grid-template-columns: 1fr; }
  .form2 { grid-template-columns: 1fr; }
  .form3 { grid-template-columns: 1fr; }
  .form4 { grid-template-columns: 1fr 1fr; }
  .modal { width: 98vw; max-width: 98vw; }
  table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .ph-row { flex-direction: column; gap: 8px; }
  .tabs { gap: 0; }
  .tab { padding: 6px 10px; font-size: 11px; }
  .btn { padding: 6px 11px; font-size: 11px; }
  .kpi-value { font-size: 19px; }
  .panel-hd { flex-direction: column; align-items: flex-start; gap: 8px; }
}

/* ─── HAMBURGER ────────────────────────────────────────────────────── */
.hamburger {
  display: none;
  position: fixed;
  top: calc(12px + env(safe-area-inset-top, 0px));
  left: calc(12px + env(safe-area-inset-left, 0px));
  z-index: 60;
  background: var(--pase-celeste);
  border: none;
  border-radius: 10px;
  padding: 10px 14px;
  cursor: pointer;
  color: #fff;
  font-size: 20px;
  line-height: 1;
  font-weight: 500;
}
.hamburger:active { transform: scale(0.96); }
@media (max-width: 1024px) {
  .hamburger { display: flex; align-items: center; justify-content: center; }
  .overlay-sb {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(26,58,94,0.32);
    z-index: 40;
  }
  .overlay-sb.open { display: block; }
}
` + polishCss;
