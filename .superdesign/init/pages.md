# PASE — Page Component Dependency Trees

> SuperDesign init file. Focus on RRHH/Equipo page and general page structure.

## General page structure

Every authenticated page in PASE follows this hierarchy:

```
App.tsx
  <style>{css}</style>                     ← Layout.tsx global CSS injected
  <div className="app">                    ← flex container
    <div style={{zIndex:2}}>
      <Sidebar />                          ← fixed left (220px / 56px collapsed)
    </div>
    <TopBar />                             ← fixed top-right (avatar + notifications + theme)
    <main className="main">               ← margin-left: 220px (or 56px), padded content area
      <Suspense fallback={<PageLoader/>}>
        <Routes>
          <Route path="/equipo" element={<RRHHPage {...props}/>} />
          ...
        </Routes>
      </Suspense>
    </main>
    <SoporteWidget />                      ← floating support chat
  </div>
```

### Each page typically renders:

```tsx
<div>
  <PageHeader title="Page Name" actions={<button>...</button>} />
  <div className="tabs">...</div>          {/* optional tab bar */}
  {/* tab content / main content */}
</div>
```

The `.main` class provides:
- `margin-left: 220px` (accounts for fixed sidebar)
- `padding: 28px 120px 36px 36px` (desktop)
- `background: var(--pase-bg-page)` (canvas color, cards float on top)
- Mobile (`<=1024px`): `margin-left: 0; padding: 16px`

---

## RRHH/Equipo Page (`src/pages/RRHH.tsx`)

### Props

```tsx
interface RRHHProps {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}
```

### Import tree

```
RRHH.tsx
  ├── components/ui/Modal          (shared Modal component)
  ├── components/ui/PageHeader     (shared page header)
  ├── lib/supabase                 (db client)
  ├── lib/auth                     (localesVisibles, applyLocalScope, cuentasOperables, tienePermiso)
  ├── lib/errors                   (translateRpcError)
  ├── lib/usePuestosRRHH           (job positions catalog hook)
  ├── lib/useGuardedHandler        (double-click prevention)
  ├── hooks/useToast               (toast notifications)
  ├── components/Toast             (ToastComponent)
  ├── @pase/shared/utils           (toISO, toLocalISO)
  ├── lib/utils                    (today)
  ├── lib/calculos/rrhh            (calcularSACProporcional)
  ├── types                        (Usuario, Local)
  ├── types/rrhh                   (Empleado, Novedad, Liquidacion, Adelanto, LineaPago)
  │
  ├── pages/rrhh/types             (EmpForm, EmpModalState, NovedadEditable, LiquidacionConGenerated, etc.)
  ├── pages/rrhh/helpers           (calcLiquidacion, calcularValorDoble, MESES_NOMBRE, CUENTAS_PAGO, etc.)
  │
  ├── [TAB COMPONENTS]
  │   ├── pages/rrhh/TabDashboard  (KPI overview: total empleados, novedades, SAC, estimated payroll)
  │   ├── pages/rrhh/TabEmpleados  (employee list, search, add/edit modal, link to legajo)
  │   ├── pages/rrhh/TabSueldos    (salary liquidation per month, confirm+pay flow)
  │   └── pages/rrhh/TabSueldosBase (base salary management)
  │
  ├── [MODAL COMPONENTS]
  │   ├── pages/rrhh/AdelantoModal (register salary advance)
  │   └── pages/rrhh/AguinaldoModal (pay aguinaldo/bonus)
  │
  └── [LAZY]
      └── pages/RRHHLegajo         (employee dossier — lazy loaded ~1100 LOC)
```

### Render structure

```tsx
export default function RRHH({ user, locales, localActivo }: RRHHProps) {
  // ... extensive state management ...

  const tabs = [
    { id:"dashboard", label:"Dashboard" },
    { id:"empleados", label:"Empleados" },
    { id:"sueldos", label:"Sueldos" },
    { id:"sueldos_base", label:"Sueldos base" },
  ];

  return (
    <div>
      <ToastComponent toast={toast} />

      <PageHeader
        title="Equipo"
        actions={esDueno ? (
          <>
            <button className="btn btn-acc btn-sm" onClick={()=>setAgModal(true)}>Pagar Aguinaldos</button>
            <button className="btn btn-acc btn-sm" onClick={()=>{setCsModal(true);}}>Pagar Cargas / Sindicato</button>
            <button className="btn btn-outline btn-sm" onClick={()=>setAdelModal(true)}>Registrar Adelanto</button>
          </>
        ) : undefined}
      />

      <div className="tabs">
        {tabs.map(t => (
          <div key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </div>
        ))}
      </div>

      {tab === "dashboard" && <TabDashboard ... />}
      {tab === "empleados" && <TabEmpleados ... />}
      {tab === "sueldos" && <TabSueldos ... />}
      {tab === "sueldos_base" && <TabSueldosBase ... />}

      {/* Legajo modal (lazy-loaded) */}
      <Modal isOpen={!!legajoId} onClose={...} title="Legajo" maxWidth={1100}>
        {legajoId && (
          <Suspense fallback={...}>
            <RRHHLegajo ... />
          </Suspense>
        )}
      </Modal>

      {/* Adelanto modal */}
      <AdelantoModal ... />

      {/* Cargas Sociales modal */}
      <Modal isOpen={csModal} ... title="Pagar cargas / sindicato" maxWidth={420}>
        {/* form fields */}
      </Modal>

      {/* Aguinaldo modal */}
      {agModal && <AguinaldoModal ... />}
    </div>
  );
}
```

### Key layout observations for TopBar/header redesign:

1. **PageHeader is the first visual element** inside each page. It renders the gold anchor line + title + action buttons.
2. **Tabs** sit directly below PageHeader using the global `.tabs` / `.tab` CSS classes.
3. **The TopBar (top-right)** is rendered by App.tsx OUTSIDE of main — it's a sibling of `<main>`. It floats fixed at `top:0; right:0`.
4. **Actions overflow**: On the Equipo page, PageHeader has 3 action buttons ("Pagar Aguinaldos", "Pagar Cargas / Sindicato", "Registrar Adelanto"). On narrow screens these wrap.
5. **No breadcrumbs** exist anywhere in the app.
6. **The overline prop** of PageHeader is used on the Dashboard (`/inicio`) to show "Sabado 27 de junio . Neko Villa Crespo" above the greeting title.

---

## Other notable pages (for reference)

### Dashboard (`src/dashboards/DashboardHome.tsx`)
- Uses PageHeader with `overline` (date + local name) and `title` containing `<span className="ph-italic">` for the user's name in serif italic.

### Caja (`src/pages/Caja.tsx`)
- Uses `module-with-aside` grid layout (content + RightSubNav sidebar).
- Has its own sub-routing.

### Compras (`src/pages/Compras.tsx`)
- Similar `module-with-aside` layout with sub-nav.
- Has its own sub-routes.

### Negocio (`src/pages/Negocio.tsx`)
- Single-page with multiple KPI sections.
- Uses CSS Module (`Negocio.module.css`).
