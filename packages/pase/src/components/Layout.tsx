import { useState } from "react";
import { ROLES, getPermisos } from "../lib/auth";
import type { Usuario, Local, Tenant } from "../types";
import { ThemeToggle } from "./ui/ThemeToggle";

interface SidebarProps {
  user: Usuario;
  section: string;
  onNav: (section: string) => void;
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

export function Sidebar({ user, section, onNav, onLogout, locales, localActivo, setLocalActivo, tenant, tenantOverride, onClearOverride }: SidebarProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const perms = getPermisos(user);
  const esSuperAdmin = user.rol === "superadmin";
  const localesDisp = (user.rol==="dueno" || user.rol==="admin" || esSuperAdmin) ? locales : locales.filter((l: { id: number })=>(user._locales||user.locales||[]).includes(l.id));
  const nav = [
    {id:"dashboard",label:"Dashboard",sec:"Principal",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="5" height="5" rx="1"/><rect x="8" y="1" width="5" height="5" rx="1"/><rect x="1" y="8" width="5" height="5" rx="1"/><rect x="8" y="8" width="5" height="5" rx="1"/></svg>`},
    {id:"ventas",label:"Ventas",sec:"Operaciones",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="1,11 4,6 7,8 10,4 13,6"/></svg>`},
    {id:"compras",label:"Compras",sec:"Operaciones",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="1" width="10" height="12" rx="1"/><line x1="5" y1="5" x2="9" y2="5"/><line x1="5" y1="8" x2="7" y2="8"/></svg>`},
    // Item "Remitos" eliminado el 2026-05-07: facturas y remitos viven juntos
    // en /compras (misma pantalla, pill "Remitos" para alternar la vista).
    {id:"gastos",label:"Gastos",sec:"Operaciones",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5"/><line x1="7" y1="4" x2="7" y2="7"/><line x1="7" y1="7" x2="9" y2="9"/></svg>`},
    {id:"proveedores",label:"Proveedores",sec:"Operaciones",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="5" r="2.5"/><path d="M2 13c0-3 2-4.5 5-4.5s5 1.5 5 4.5"/></svg>`},
    {id:"caja",label:"Tesorería",sec:"Finanzas",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="5" width="12" height="8" rx="1"/><path d="M4 5V4a3 3 0 0 1 6 0v1"/></svg>`},
    {id:"mp",label:"Conciliación MP",sec:"Finanzas",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="3" width="12" height="8" rx="1"/><line x1="1" y1="7" x2="13" y2="7"/></svg>`},
    // Cashflow eliminado del producto (Lucas, 2026-05-11). El módulo no
    // resolvía el caso de uso real (solo cubría ingresos MP, no efectivo
    // ni banco) y se decidió no continuar el desarrollo. Archivo eliminado.
    // Cierre Comparativo fusionado en EERR (Lucas, 2026-05-08): ahora EERR
    // tiene botón "+ Comparar mes" que agrega columnas comparativas + gráfico
    // de evolución. La pantalla Cierre.tsx queda como código muerto;
    // descomentar este item para reactivar si hace falta.
    // {id:"cierre",label:"Cierre",sec:"Números",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="3" height="5"/><rect x="6" y="4" width="3" height="8"/><rect x="10" y="2" width="2" height="10"/></svg>`},
    {id:"eerr",label:"Estado de Result.",sec:"Números",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="2" y1="11" x2="2" y2="5"/><line x1="6" y1="11" x2="6" y2="3"/><line x1="10" y1="11" x2="10" y2="7"/></svg>`},
    {id:"contador",label:"Contador / IVA",sec:"Números",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="1" width="10" height="12" rx="1"/><line x1="5" y1="5" x2="9" y2="5"/><line x1="5" y1="8" x2="9" y2="8"/></svg>`},
    {id:"rrhh",label:"RRHH",sec:"RRHH",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5" cy="5" r="2.5"/><path d="M1 13c0-2.5 2-4 4-4s4 1.5 4 4"/><circle cx="10" cy="5" r="2"/><path d="M13 13c0-2 -1-3.5-3-3.5"/></svg>`},
    {id:"blindaje",label:"Blindaje",sec:"Herramientas",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 1L2 3v4c0 3 2.5 5.5 5 6 2.5-.5 5-3 5-6V3L7 1z"/><polyline points="4.5,7 6.5,9 9.5,5.5"/></svg>`},
    {id:"usuarios",label:"Usuarios",sec:"Herramientas",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="5" r="2.5"/><path d="M2 13c0-3 2-4.5 5-4.5s5 1.5 5 4.5"/></svg>`},
    {id:"configuracion",label:"Conceptos",sec:"Herramientas",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="2.5"/><path d="M7 1v1M7 12v1M1 7h1M12 7h1M2.9 2.9l.7.7M10.4 10.4l.7.7M2.9 11.1l.7-.7M10.4 3.6l.7-.7"/></svg>`},
    // Solo superadmin (TASK 0.15). Filtrado por perms.includes('tenants') más abajo.
    {id:"tenants",label:"Tenants",sec:"Sistema",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="3" width="5" height="10" rx="1"/><rect x="8" y="1" width="5" height="12" rx="1"/><line x1="3" y1="6" x2="4" y2="6"/><line x1="3" y1="9" x2="4" y2="9"/><line x1="10" y1="4" x2="11" y2="4"/><line x1="10" y1="7" x2="11" y2="7"/><line x1="10" y1="10" x2="11" y2="10"/></svg>`},
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
          {/* Multi-tenant badges (TASK 0.15) — colores neutralizados por el design system v1.0 */}
          {esSuperAdmin && !tenantOverride && (
            <div className="badge-sb badge-sb-super">Modo superadmin</div>
          )}
          {tenantOverride && tenant && (
            <div className="badge-sb badge-sb-tenant">
              <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tenant.nombre}</span>
              <button onClick={onClearOverride} className="badge-sb-close" title="Volver a vista superadmin">✕</button>
            </div>
          )}
          {!esSuperAdmin && tenant && (
            <div className="brand-tenant">{tenant.nombre}</div>
          )}
        </div>
        {localesDisp.length > 1 && (
          <div className="sb-local">
            <select value={localActivo||""} onChange={e=>setLocalActivo(e.target.value?parseInt(e.target.value):null)}>
              {user.rol==="dueno" && <option value="">Todos los locales</option>}
              {localesDisp.map((l: { id: number; nombre: string })=><option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
          </div>
        )}
        <nav className="sb-nav">
          {secs.map(s=>{
            const items = nav.filter(n=>n.sec===s&&perms.includes(n.id));
            if(!items.length) return null;
            return (<div key={s}><div className="sb-section">{s}</div>{items.map(n=>(
              <div key={n.id} className={`nav-item ${section===n.id?"active":""}`} onClick={() => { onNav(n.id); close(); }}>
                <span style={{width:14,height:14,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}} dangerouslySetInnerHTML={{__html: n.icon}}/>
                {n.label}
              </div>
            ))}</div>);
          })}
        </nav>
        <ThemeToggle />
        <div className="sb-user">
          <div className="sb-uname">{user.nombre}</div>
          {/* Decisión 2026-05-13: roles sin color. La distinción es solo textual. */}
          <div className="sb-urole">{ROLES[user.rol]?.label}</div>
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

body{background:var(--pase-bg);color:var(--pase-text);font-family:var(--pase-font);font-size:13px;line-height:1.5;min-height:100vh;-webkit-font-smoothing:antialiased;transition:background-color 0.2s ease,color 0.2s ease}

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
.sb{width:200px;background:var(--pase-bg);border-right:0.5px solid var(--pase-border);display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:20}
.sb-logo{padding:22px 16px 16px;border-bottom:0.5px solid var(--pase-border);text-align:center}
.brand{font-size:26px;font-weight:500;color:var(--pase-text);letter-spacing:-0.035em;line-height:1}
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
.sb-section{padding:14px 16px 4px;font-size:9px;letter-spacing:0.08em;color:var(--pase-text-muted);font-weight:500}
.nav-item{display:flex;align-items:center;gap:9px;padding:7px 12px;cursor:pointer;font-size:12px;color:var(--pase-text-muted);border-radius:8px;margin:1px 8px;transition:background 0.12s, color 0.12s}
.nav-item:hover{background:var(--pase-bg-soft);color:var(--pase-text)}
.nav-item.active{background:var(--pase-celeste-100);color:var(--pase-text);font-weight:500}

.sb-user{padding:14px 16px;border-top:0.5px solid var(--pase-border)}
.sb-uname{font-size:12px;font-weight:500;margin-bottom:1px;color:var(--pase-text)}
.sb-urole{font-size:10px;color:var(--pase-text-muted)}
.sb-logout{display:block;width:100%;margin-top:8px;padding:6px;background:transparent;border:0.5px solid var(--pase-border-strong);color:var(--pase-text-muted);cursor:pointer;font-size:10px;font-family:var(--pase-font);border-radius:8px;transition:all 0.15s}
.sb-logout:hover{border-color:var(--pase-celeste-300);color:var(--pase-text)}

/* ─── MAIN ─────────────────────────────────────────────────────────── */
.main{margin-left:200px;flex:1;padding:24px 32px;min-height:100vh;background:var(--pase-bg)}
.ph-row{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px;gap:12px;flex-wrap:wrap}
.ph-title{font-family:var(--pase-font);font-size:18px;font-weight:500;line-height:1.1;color:var(--pase-text);letter-spacing:-0.02em}
.ph-sub{font-size:11px !important;color:var(--pase-text-muted);margin-top:4px;font-weight:400 !important}

/* ─── GRIDS ────────────────────────────────────────────────────────── */
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px}

/* ─── KPI / PANEL / CARDS ──────────────────────────────────────────── */
.kpi{background:var(--pase-bg);border:0.5px solid var(--pase-border);border-radius:14px;padding:14px 16px}
.kpi-label{font-size:11px;color:var(--pase-text-muted);margin-bottom:8px;font-weight:500;letter-spacing:-0.01em}
.kpi-value{font-size:24px;font-weight:500;line-height:1.1;color:var(--pase-text);letter-spacing:-0.03em;font-variant-numeric:tabular-nums}
.kpi-sub{font-size:11px;color:var(--pase-text-muted);margin-top:5px}
.kpi-acc{color:var(--pase-celeste)}
.kpi-danger{color:var(--pase-text)}
.kpi-warn{color:var(--pase-text-muted)}
.kpi-success{color:var(--pase-celeste)}

.panel{background:var(--pase-bg);border:0.5px solid var(--pase-border);border-radius:14px;margin-bottom:10px;overflow:hidden}
.panel-hd{padding:12px 16px;border-bottom:0.5px solid var(--pase-border);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:var(--pase-bg)}
.panel-title{font-size:12px;font-weight:500;color:var(--pase-text);letter-spacing:-0.01em}

/* ─── TABLAS ───────────────────────────────────────────────────────── */
table{width:100%;border-collapse:collapse}
thead th{padding:9px 14px;text-align:left;font-size:10.5px;font-weight:500;color:var(--pase-text-muted);border-bottom:0.5px solid var(--pase-border);background:var(--pase-bg-soft);letter-spacing:-0.01em}
tbody tr{border-bottom:0.5px solid var(--pase-border);transition:background 0.1s}
tbody tr:last-child{border-bottom:none}
tbody tr:hover{background:var(--pase-bg-soft)}
td{padding:10px 14px;font-size:12px;color:var(--pase-text)}

/* ─── BADGES ───────────────────────────────────────────────────────── */
.badge{display:inline-block;padding:3px 9px;border-radius:999px;font-size:10.5px;font-weight:500;background:var(--pase-celeste-100);color:var(--pase-text)}
.b-danger{background:var(--pase-bg-out);color:var(--pase-text-muted)}
.b-success{background:var(--pase-celeste-100);color:var(--pase-text)}
.b-warn{background:var(--pase-bg-out);color:var(--pase-text-muted)}
.b-info{background:var(--pase-celeste-100);color:var(--pase-text)}
.b-muted{background:var(--pase-bg-out);color:var(--pase-text-muted)}
.b-anulada{background:var(--pase-bg-out);color:var(--pase-text-muted);text-decoration:line-through}

/* ─── BOTONES ──────────────────────────────────────────────────────── */
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border:none;cursor:pointer;font-family:var(--pase-font);font-size:11.5px;font-weight:500;border-radius:8px;transition:all 0.15s;white-space:nowrap;letter-spacing:-0.005em}
.btn-acc{background:var(--pase-celeste);color:#fff;border:none}
.btn-acc:hover{background:var(--pase-celeste-300)}
.btn-sec{background:var(--pase-bg);color:var(--pase-text);border:0.5px solid var(--pase-border-strong)}
.btn-sec:hover{background:var(--pase-bg-soft);border-color:var(--pase-celeste-300)}
.btn-ghost{background:transparent;color:var(--pase-text-muted);border:0.5px solid var(--pase-border-strong)}
.btn-ghost:hover{color:var(--pase-text);background:var(--pase-bg-soft)}
.btn-sm{padding:4px 10px;font-size:10.5px}
.btn-success{background:transparent;color:var(--pase-celeste);border:0.5px solid var(--pase-celeste-300)}
.btn-success:hover{background:var(--pase-celeste-100)}
.btn-danger{background:transparent;color:var(--pase-text);border:0.5px solid var(--pase-border-strong)}
.btn-danger:hover{background:var(--pase-bg-soft);border-color:var(--pase-text-muted)}

/* ─── FORMS ────────────────────────────────────────────────────────── */
.field{margin-bottom:12px}
.field label{display:block;font-size:10.5px;color:var(--pase-text-muted);margin-bottom:5px;font-weight:500;letter-spacing:-0.01em}
.field input,.field select,.field textarea{width:100%;background:var(--pase-bg);border:0.5px solid var(--pase-border-strong);color:var(--pase-text);padding:9px 11px;font-family:var(--pase-font);font-size:12.5px;border-radius:8px;outline:none;transition:border-color 0.15s,box-shadow 0.15s}
.field input:focus,.field select:focus,.field textarea:focus{border-color:var(--pase-celeste);box-shadow:0 0 0 3px var(--pase-celeste-100)}
.field select option{background:var(--pase-bg);color:var(--pase-text)}

.form2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.form4{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;align-items:end}

/* ─── MODALES ──────────────────────────────────────────────────────── */
.overlay{position:fixed;inset:0;background:rgba(26,58,94,0.32);display:flex;align-items:center;justify-content:center;z-index:100}
.modal{background:var(--pase-bg);border:0.5px solid var(--pase-border);border-radius:14px;width:640px;max-width:96vw;max-height:92vh;overflow-y:auto}
.modal-hd{padding:16px 20px;border-bottom:0.5px solid var(--pase-border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--pase-bg);z-index:1}
.modal-title{font-family:var(--pase-font);font-size:16px;font-weight:500;color:var(--pase-text);letter-spacing:-0.02em}
.modal-body{padding:20px;color:var(--pase-text)}
.modal-ft{padding:14px 20px;border-top:0.5px solid var(--pase-border);display:flex;gap:8px;justify-content:flex-end;position:sticky;bottom:0;background:var(--pase-bg)}
.close-btn{background:none;border:none;color:var(--pase-text-muted);cursor:pointer;font-size:18px;line-height:1}
.close-btn:hover{color:var(--pase-text)}

/* ─── TABS ─────────────────────────────────────────────────────────── */
.tabs{display:flex;border-bottom:0.5px solid var(--pase-border);margin-bottom:16px;flex-wrap:wrap;gap:2px}
.tab{padding:8px 14px;font-size:12px;cursor:pointer;color:var(--pase-text-muted);border-bottom:2px solid transparent;margin-bottom:-0.5px;transition:all 0.12s}
.tab.active{color:var(--pase-text);border-bottom-color:var(--pase-celeste);font-weight:500}
.tab:hover:not(.active){color:var(--pase-text)}

/* ─── ALERTS ───────────────────────────────────────────────────────── */
.alert{padding:11px 14px;border-radius:10px;font-size:12px;margin-bottom:12px;border:0.5px solid var(--pase-border);line-height:1.5;background:var(--pase-bg-soft);color:var(--pase-text)}
.alert-danger,.alert-warn,.alert-success,.alert-info{background:var(--pase-bg-soft);border-color:var(--pase-border);color:var(--pase-text)}

/* ─── CAJAS ────────────────────────────────────────────────────────── */
.caja-card{background:var(--pase-bg);border:0.5px solid var(--pase-border);border-radius:14px;padding:16px 18px;position:relative;overflow:hidden}
.caja-name{font-size:11px;color:var(--pase-text-muted);margin-bottom:8px;font-weight:500;letter-spacing:-0.01em}
.caja-saldo{font-family:var(--pase-font);font-size:22px;font-weight:500;color:var(--pase-text);letter-spacing:-0.03em;font-variant-numeric:tabular-nums}

.anulada-row{opacity:0.5}

/* ─── SEARCH ───────────────────────────────────────────────────────── */
.search{background:var(--pase-bg);border:0.5px solid var(--pase-border-strong);color:var(--pase-text);padding:7px 12px;font-family:var(--pase-font);font-size:12px;border-radius:8px;outline:none;transition:border-color 0.15s,box-shadow 0.15s}
.search:focus{border-color:var(--pase-celeste);box-shadow:0 0 0 3px var(--pase-celeste-100)}

/* ─── ESTADOS ──────────────────────────────────────────────────────── */
.empty{padding:48px;text-align:center;color:var(--pase-text-muted);font-size:12px}
.loading{padding:48px;text-align:center;color:var(--pase-text-muted);font-size:11px}

/* ─── LOGIN ────────────────────────────────────────────────────────── */
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--pase-bg);position:relative}
.login-bg{position:absolute;inset:0}
.login-card{position:relative;width:400px;background:var(--pase-bg);border:0.5px solid var(--pase-border);border-radius:14px;padding:40px}
.login-brand{font-family:var(--pase-font);font-size:32px;font-weight:500;color:var(--pase-text);line-height:1;letter-spacing:-0.035em}
.login-sub{font-size:11px;color:var(--pase-text-muted);margin-bottom:32px;margin-top:6px}

/* ─── NUM/MONO ─────────────────────────────────────────────────────── */
.num{font-family:var(--pase-font);font-size:14px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--pase-text)}
.mono{font-family:var(--pase-font);font-size:11px;font-variant-numeric:tabular-nums}

/* ─── EERR ─────────────────────────────────────────────────────────── */
.eerr-row{display:flex;align-items:center;justify-content:space-between;padding:9px 16px;border-bottom:0.5px solid var(--pase-border);color:var(--pase-text)}
.eerr-row:last-child{border-bottom:none}
.eerr-section-title{padding:11px 16px;font-size:11px;color:var(--pase-text-muted);font-weight:500;border-top:0.5px solid var(--pase-border);background:var(--pase-bg-soft);letter-spacing:-0.01em}

.items-table{width:100%;border-collapse:collapse;margin-top:8px}
.items-table th{font-size:10.5px;color:var(--pase-text-muted);padding:5px 6px;text-align:left;border-bottom:0.5px solid var(--pase-border);font-weight:500}
.items-table td{padding:5px 6px;font-size:11.5px;color:var(--pase-text)}
.items-table tr:hover{background:var(--pase-bg-soft)}

.saldo-edit{display:flex;gap:8px;align-items:center}
.saldo-edit input{width:160px}

.section{margin-bottom:14px}
.section-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.section-title{font-size:11px;color:var(--pase-text-muted);font-weight:500;letter-spacing:-0.01em}
.section-total{font-size:11.5px;color:var(--pase-text);font-weight:500;font-variant-numeric:tabular-nums}

/* ─── PILLS ────────────────────────────────────────────────────────── */
.pills{display:flex;gap:5px;margin-bottom:14px;flex-wrap:wrap}
.pill{padding:4px 11px;border-radius:999px;font-size:11px;cursor:pointer;color:var(--pase-text-muted);border:0.5px solid var(--pase-border);background:var(--pase-bg);transition:all 0.12s}
.pill:hover{color:var(--pase-text);border-color:var(--pase-celeste-300)}
.pill.active{background:var(--pase-celeste-100);color:var(--pase-text);border-color:var(--pase-celeste-100)}

/* build: 2026-05-13-ds-v1 */

/* ─── MOBILE/TABLET ≤1024px ────────────────────────────────────────── */
@media (max-width: 1024px) {
  .sb {
    transform: translateX(-100%);
    transition: transform 0.25s ease;
    z-index: 50;
    width: 220px;
    box-shadow: 0 0 32px rgba(26,58,94,0.08);
  }
  .sb.open { transform: translateX(0); }
  .main {
    margin-left: 0;
    padding: 16px;
    padding-top: calc(60px + env(safe-area-inset-top, 0px));
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
`;
