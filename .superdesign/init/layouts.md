# PASE — Layout Components

> SuperDesign init file. Full source code of the app shell (Sidebar, TopBar, main area).

## Architecture

The entire app layout lives in a single file: `src/components/Layout.tsx`. This file exports:

1. **`Sidebar`** component — fixed left sidebar (220px, collapsible to 56px)
2. **`TopBar`** component — fixed top-right bar with BandejaEntrada + ThemeToggle + avatar dropdown
3. **`css`** template literal string — ALL global CSS (reset, sidebar, main, grids, KPIs, tables, forms, modals, tabs, badges, buttons, search inputs, responsive breakpoints, hamburger menu, topbar styles)

The `css` string is injected as `<style>{css}</style>` in App.tsx. There is no separate `.css` file for the layout globals — they are all embedded in the exported `css` constant.

Additionally, `src/styles/polish.css` is imported as `?raw` and appended to the `css` string. It adds shadows, transitions, and animation refinements on top of the base globals.

---

## Layout.tsx — FULL SOURCE (`src/components/Layout.tsx`)

### Section 1: Imports + Sidebar Component (lines 1-201)

```tsx
import { useState, useEffect, useRef } from "react";
import { NavLink } from "react-router-dom";
import { ROLES, tienePermiso } from "../lib/auth";
import type { Usuario, Local, Tenant } from "../types";
import { ThemeToggle } from "./ui/ThemeToggle";
import { BandejaEntradaBoton } from "./BandejaEntradaBoton";
import { useTenantFeatures } from "../lib/useTenantFeatures";
import { tenantTieneFeature } from "../lib/features";
import { limpiarCacheYRecargar } from "../lib/forceRefresh";
import polishCss from "../styles/polish.css?raw";

// Feature flag gating: map sidebar slug -> feature flag
const SLUG_TO_FEATURE: Record<string, string> = {
  caja: "modulo.caja",
  compras: "modulo.compras",
  ventas: "modulo.ventas",
  gastos: "modulo.gastos",
  rrhh: "modulo.rrhh",
  negocio: "modulo.negocio",
  objetivos: "modulo.objetivos",
  eerr: "modulo.reportes",
  cashflow: "modulo.reportes",
  utilidades: "modulo.reportes",
  herramientas_hub: "modulo.herramientas_hub",
  ajustes: "modulo.ajustes",
  usuarios: "modulo.usuarios",
};

interface SidebarProps {
  user: Usuario;
  onLogout: () => Promise<void> | void;
  locales: Local[];
  localActivo: number | null;
  setLocalActivo: (v: number | null) => void;
  tenant: Tenant | null;
  tenantOverride: string | null;
  onClearOverride: () => void;
}

export function Sidebar({ user, onLogout, locales, localActivo, setLocalActivo, tenant, tenantOverride, onClearOverride }: SidebarProps) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('pase_sb_collapsed') === '1'; } catch { return false; }
  });
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    try { const s = localStorage.getItem('pase_sb_sections'); return s ? JSON.parse(s) : {}; } catch { return {}; }
  });

  useEffect(() => {
    document.body.classList.toggle('sb-collapsed', collapsed);
    return () => { document.body.classList.remove('sb-collapsed'); };
  }, [collapsed]);

  const close = () => setOpen(false);
  const toggleCollapse = () => {
    setCollapsed(c => {
      const next = !c;
      try { localStorage.setItem('pase_sb_collapsed', next ? '1' : '0'); } catch {}
      return next;
    });
  };
  const toggleSection = (sec: string) => {
    setOpenSections(prev => {
      const next = { ...prev, [sec]: !(prev[sec] ?? true) };
      try { localStorage.setItem('pase_sb_sections', JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const esSuperAdmin = user.rol === "superadmin";
  const localesDisp = (user.rol==="dueno" || user.rol==="admin" || esSuperAdmin) ? locales : locales.filter((l: { id: number })=>(user._locales||user.locales||[]).includes(l.id));
  const { features: tenantFeatures } = useTenantFeatures(user.tenant_id ?? null);

  // Navigation items — each has slug, path, label, section, SVG icon
  const nav: Array<{ slug: string; path: string; label: string; sec: string; icon: string; altSlugs?: string[] }> = [
    {slug:"inicio",path:"/inicio",label:"Inicio",sec:"Operacion",icon:`<svg ...>`},
    {slug:"caja",path:"/caja",label:"Caja",sec:"Operacion",icon:`<svg ...>`},
    {slug:"compras",path:"/compras",label:"Compras",sec:"Operacion",icon:`<svg ...>`},
    {slug:"ventas",path:"/ventas",label:"Ventas",sec:"Operacion",icon:`<svg ...>`},
    {slug:"gastos",path:"/gastos",label:"Gastos",sec:"Operacion",icon:`<svg ...>`},
    {slug:"rrhh",path:"/equipo",label:"Equipo",sec:"Operacion",icon:`<svg ...>`},
    {slug:"rentabilidad",path:"/recetario",label:"Recetario",sec:"Operacion",icon:`<svg ...>`},
    {slug:"negocio",altSlugs:["finanzas"],path:"/negocio",label:"Negocio",sec:"Direccion",icon:`<svg ...>`},
    {slug:"conciliacion",path:"/conciliacion-extracto",label:"Conciliacion",sec:"Direccion",icon:`<svg ...>`},
    {slug:"objetivos",path:"/objetivos",label:"Objetivos",sec:"Direccion",icon:`<svg ...>`},
    {slug:"eerr",path:"/reportes",label:"Reportes",sec:"Direccion",icon:`<svg ...>`},
    {slug:"cashflow",path:"/cashflow",label:"Cashflow",sec:"Direccion",icon:`<svg ...>`},
    {slug:"utilidades",path:"/utilidades",label:"Utilidades",sec:"Direccion",icon:`<svg ...>`},
    {slug:"rentabilidad",path:"/rentabilidad",label:"Rentabilidad",sec:"Direccion",icon:`<svg ...>`},
    {slug:"herramientas_hub",path:"/herramientas",label:"Herramientas",sec:"Herramientas",icon:`<svg ...>`},
    {slug:"ajustes",path:"/ajustes",label:"Ajustes",sec:"Sistema",icon:`<svg ...>`},
    {slug:"ayuda",path:"/ayuda",label:"Ayuda",sec:"Sistema",icon:`<svg ...>`},
    {slug:"usuarios",path:"/usuarios",label:"Usuarios",sec:"Sistema",icon:`<svg ...>`},
    {slug:"tenants",path:"/tenants",label:"Tenants",sec:"Sistema",icon:`<svg ...>`},
  ];
  const secs = [...new Set(nav.map(n=>n.sec))];

  return (
    <>
      <button className="hamburger" onClick={() => setOpen(o => !o)} aria-label="Menu">&#9776;</button>
      <div className={`overlay-sb ${open ? "open" : ""}`} onClick={close}/>
      <div className={`sb ${open ? "open" : ""} ${collapsed ? "sb-rail" : ""}`}>
        {/* Header with brand "pase." + collapse toggle */}
        <div className="sb-header">
          <div className="sb-brand-row">
            {collapsed
              ? <div className="sb-brand-icon">P</div>
              : <div className="sb-brand-text">pase<span className="brand-dot">.</span></div>
            }
            <button className="sb-toggle" onClick={toggleCollapse} title={collapsed ? "Expandir sidebar" : "Colapsar sidebar"}>
              <svg ...>{collapsed ? <polyline points="5,3 9,7 5,11"/> : <polyline points="9,3 5,7 9,11"/>}</svg>
            </button>
          </div>
          {/* Superadmin / tenant override badges */}
        </div>

        {/* Local selector dropdown (only when >1 local) */}
        {localesDisp.length > 1 && (
          <div className="sb-workspace">
            {collapsed ? (
              <div className="sb-workspace-icon">...</div>
            ) : (
              <select value={localActivo??""} onChange={e=>setLocalActivo(parseInt(e.target.value))}>
                {localesDisp.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}
              </select>
            )}
          </div>
        )}

        {/* Navigation: grouped by section with collapsible headers */}
        <nav className="sb-nav">
          {secs.map(s => {
            const items = nav.filter(n => {
              if (n.sec !== s) return false;
              const tieneAcceso = tienePermiso(user, n.slug) || (n.altSlugs ?? []).some(alt => tienePermiso(user, alt));
              if (!tieneAcceso) return false;
              if (esSuperAdmin) return true;
              const featureSlug = SLUG_TO_FEATURE[n.slug];
              if (!featureSlug) return true;
              return tenantTieneFeature(featureSlug, tenantFeatures);
            });
            if(!items.length) return null;
            const isOpen = openSections[s] ?? true;
            return (
              <div key={s} className="sb-group">
                {!collapsed && (
                  <button className="sb-group-hd" onClick={() => toggleSection(s)}>
                    <span>{s}</span>
                    <svg className={`sb-chev ${isOpen ? "" : "sb-chev-closed"}`}>...</svg>
                  </button>
                )}
                {collapsed && <div className="sb-group-dot"/>}
                {(collapsed || isOpen) && items.map(n=>(
                  <NavLink key={n.slug} to={n.path} onClick={close}
                    className={({isActive}) => `nav-item${isActive ? " active" : ""}`}
                    title={collapsed ? n.label : undefined}
                  >
                    <span className="nav-icon" dangerouslySetInnerHTML={{__html: n.icon}}/>
                    {!collapsed && <span className="nav-label">{n.label}</span>}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div style={{ flex: 1 }} />
      </div>
    </>
  );
}
```

### Section 2: TopBar Component (lines 203-268)

```tsx
interface TopBarProps {
  user: Usuario;
  onLogout: () => Promise<void> | void;
}

export function TopBar({ user, onLogout }: TopBarProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const initial = user.nombre?.[0]?.toUpperCase() ?? "?";
  const rolLabel = ROLES[user.rol]?.label ?? user.rol;

  return (
    <div className="pase-topbar">
      <BandejaEntradaBoton user={user} />
      <ThemeToggle />
      <div ref={ref} style={{ position: "relative" }}>
        <button className="pase-topbar-avatar" onClick={() => setOpen(o => !o)} title={`${user.nombre} . ${rolLabel}`}>
          {initial}
        </button>
        {open && (
          <div className="pase-topbar-dropdown">
            <div className="pase-topbar-dd-header">
              <div className="pase-topbar-dd-name">{user.nombre}</div>
              <div className="pase-topbar-dd-role">{rolLabel}</div>
            </div>
            <div className="pase-topbar-dd-sep" />
            <button className="pase-topbar-dd-item" onClick={() => { /* Actualizar app */ }}>
              <svg .../>
              Actualizar app
            </button>
            <button className="pase-topbar-dd-item pase-topbar-dd-logout" onClick={() => { setOpen(false); void onLogout(); }}>
              <svg .../>
              Cerrar sesion
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

### Section 3: Global CSS (lines 270-772)

The exported `css` template literal includes ALL these sections (in order):

1. **Reset + font import** (Inter from Google Fonts)
2. **Design System v1.0 variable aliases** (`:root` block mapping legacy vars to `--pase-*` tokens)
3. **Body styles** (bg, color, font, font-size 13px, line-height 1.55)
4. **Dark mode decorative line** (`[data-theme="dark"] body::after` — 4px gradient celeste-to-gold, top-right)
5. **App layout** (`.app { display:flex; min-height:100vh }`)
6. **Sidebar styles** (`.sb`, `.sb-header`, `.sb-brand-*`, `.sb-workspace`, `.sb-nav`, `.sb-group`, `.nav-item`)
7. **Main area** (`.main { margin-left:220px; padding:28px 120px 36px 36px }`, `.sb-collapsed .main { margin-left:56px }`)
8. **Grid system** (`.grid4`, `.grid3`, `.grid2`)
9. **KPI / Panel / Cards** (`.kpi`, `.panel`, `.panel-hd`, `.caja-card`)
10. **Tables** (`table`, `thead th` sticky, `tbody tr` hover, scroll wrapper)
11. **Focus ring** (unified `:focus-visible` ring in celeste)
12. **Animations** (`.anim-in` fade-in, `.lift` hover)
13. **Badges** (`.badge`, `.b-danger`, `.b-success`, `.b-warn`, `.b-info`, `.b-muted`, `.b-anulada`)
14. **Buttons** (`.btn`, `.btn-acc`, `.btn-sec`, `.btn-ghost`, `.btn-sm`, `.btn-success`, `.btn-danger`)
15. **Forms** (`.field`, `.form2`, `.form3`, `.form4`)
16. **Modals** (`.overlay` with sidebar padding-left, `.modal`, `.modal-hd`, `.modal-body`, `.modal-ft`)
17. **Tabs** (`.tabs`, `.tab`, `.tab.active`)
18. **Alerts** (`.alert`, `.alert-danger/warn/success/info`)
19. **Search inputs** (`.search` class for filter bars)
20. **States** (`.empty`, `.loading`)
21. **Login** (`.login-wrap`, `.login-card`, `.login-brand`)
22. **EERR** (`.eerr-row`, `.eerr-section-title`)
23. **Pills** (`.pills`, `.pill`)
24. **Module layout with aside** (`.module-with-aside`)
25. **Mobile/tablet** (`@media max-width:1024px` — sidebar drawer, main padding, grid collapse)
26. **Hamburger** (`.hamburger` — fixed button, hidden on desktop)
27. **TopBar** (`.pase-topbar` fixed top-right, avatar, dropdown)

The CSS is then concatenated with `+ polishCss` (which adds shadows, transitions, hover refinements from `src/styles/polish.css`).

### Key CSS for layout structure:

```css
/* SIDEBAR */
.sb { width:220px; background:var(--pase-bg); border-right:0.5px solid var(--pase-border);
  display:flex; flex-direction:column; position:fixed; top:0; left:0; bottom:0; z-index:20; transition:width 0.2s ease }
.sb.sb-rail { width:56px }

/* MAIN CONTENT */
.main { margin-left:220px; flex:1; padding:28px 120px 36px 36px; min-height:100vh;
  background:var(--pase-bg-page); transition:margin-left 0.2s ease }
body.sb-collapsed .main { margin-left:56px }

/* TOP BAR */
.pase-topbar { position:fixed; top:0; right:0; z-index:15; display:flex; align-items:center; gap:6px; padding:12px 20px }
.pase-topbar-avatar { width:32px; height:32px; border-radius:50%; background:var(--pase-celeste); color:#fff;
  display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:500; border:none; cursor:pointer }

/* MOBILE: sidebar becomes drawer, main loses margin */
@media (max-width: 1024px) {
  .sb { transform:translateX(-100%); width:240px !important; z-index:50 }
  .sb.open { transform:translateX(0) }
  .main, body.sb-collapsed .main { margin-left:0; padding:16px; padding-top:calc(60px + env(safe-area-inset-top, 0px)) }
  .pase-topbar { padding:14px 60px 14px 56px }
}
```

---

## App.tsx — Shell Structure (`src/App.tsx`)

The App.tsx renders the authenticated shell as:

```tsx
<AuthProvider value={user}>
  <style>{css}</style>
  <div className="app">
    {/* Decorative blurred circles background */}
    <div style={{ position: "fixed", inset: 0, zIndex: 0, overflow: "hidden", pointerEvents: "none" }}>
      <div style={{ /* gold radial gradient circle */ }} />
      <div style={{ /* celeste radial gradient circle */ }} />
    </div>

    <div style={{position:"relative",zIndex:2}}>
      <Sidebar user={user} onLogout={logout} locales={locales} localActivo={localActivo}
        setLocalActivo={setLocalActivo} tenant={tenant} tenantOverride={tenantOverride}
        onClearOverride={clearTenantOverride} />
    </div>

    <TopBar user={user} onLogout={logout} />

    <main className="main" style={{position:"relative",zIndex:1}}>
      <Suspense fallback={<PageLoader/>}>
        <Routes>
          {/* ... all routes ... */}
        </Routes>
      </Suspense>
    </main>

    <SoporteWidget user={user} />
  </div>
</AuthProvider>
```

### Visual hierarchy (z-index):
- z-index 0: Decorative background blurred circles
- z-index 1: `<main>` content area
- z-index 2: Sidebar wrapper
- z-index 15: TopBar (fixed)
- z-index 20: Sidebar itself
- z-index 50: Sidebar on mobile (drawer mode)
- z-index 60: Hamburger button
- z-index 100: Modal overlays
