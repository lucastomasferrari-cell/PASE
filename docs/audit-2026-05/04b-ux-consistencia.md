# Fase 4B — UX & consistencia visual (PASE)

**Estado:** ✅ Completa
**Fecha:** 2026-05-27
**Scope:** `packages/pase/src/{pages,components,hooks,styles,index.css}/**`, comparación contra design system `src/styles/tokens.css` y componentes `src/components/ui/*`. Excluye COMANDA (Fase 5).
**Método:** lectura estática + grep dirigido sobre 38 `pages/*.tsx` + 13 sub-pages + 28 componentes UI/shared. NO se corrió el dev server ni se inspeccionó visualmente — todo el análisis es estructural sobre el código.

---

## 📊 Resumen ejecutivo

| Métrica | Valor | Comentario |
|---|---|---|
| Pages totales (top-level + sub-pages) | 51 | 38 en `pages/` + 13 en `pages/{caja,compras,herramientas,mensajeria,rentabilidad,rrhh}/` |
| Componentes UI compartidos en `components/ui/` | 21 | Card, Modal, EmptyState, PageHeader, PageContainer, KpiTile, Bento, StatCard, Sparkline, ThemeToggle, etc. |
| Componente `Button` | **❌ no existe** | 244 ocurrencias de `className="btn ..."` inline en 46 archivos |
| Pages que usan `<Modal>` (componente) | **4 de 51** (8%) | Las otras 28 dibujan overlay manual con `position:"fixed"` inline |
| Pages que usan `<PageHeader>` | 16 de 38 (42%) | El resto usa `<div className="ph-row">` (5 archivos) o headers ad-hoc |
| Pages que usan `<PageContainer>` | **0** | Componente creado, **adoption cero** |
| Pages que usan `<EmptyState>` | 14 de 38 (37%) | Otras pintan `<div>Sin datos</div>` inline |
| Pages que usan `useToast` | **6 de 38** (16%) | Sistema existe pero la mayoría sigue con `alert()` / `confirm()` |
| Archivos con `alert(...)` | **25** | 115 invocaciones totales |
| Archivos con `confirm(...)` | ~14 | 30 invocaciones totales |
| `<form>` elements en todo el codebase | **1** (en widget de dashboard) | Casi nada usa `<form>` — toda submisión por click handler en `<button>` |
| `<label htmlFor=...>` (asociación accesible) | **1** en `pages/` | Hay 227 `<label>` pero ninguno asocia con input por id |
| `fontSize:` inline en pages | **703** total | 587 hardcoded numéricos (`fontSize: 12`), 107 con vars (`var(--pase-fs-sm)`) → 17% adopción del sistema |
| `borderRadius:` inline en pages | 148 | 0 usan `var(--pase-radius-*)` |
| `padding:/margin:/gap:` con `var(--pase-space-*)` | **0** | Tokens existen, nadie los usa |
| Hex colors hardcoded en JSX (`color:"#...""`) | 8 archivos | Incluye colores de badge de Solicitudes (`#A8893A`, `#2BB673`, `#EF4444`) que NO se invierten en dark |
| Archivos con emojis hardcoded en JSX | **24 de 51** (47%) | Pese a la decisión 2026-05-17 de migrar a SVG line-art (Icons.tsx) |
| Pages con `@media` queries | 8 (de 51) | 5 archivos solo en CSS modules, 8 inline en `<style>{...}` dentro del JSX |
| `useMediaQuery` / `matchMedia` / `window.innerWidth` | **0** | No hay detección JS de viewport |
| `role="dialog"` fuera de `<Modal>` | 1 (`EstadoCuentaDrawer`) | Los 28 modales manuales no marcan rol ARIA |
| Focus trap en modales | **0** | Tab puede salirse del modal |
| Librería de iconos externa | **❌ ninguna** | Set propio en `Icons.tsx` (16 SVG) + emojis residuales |
| Schema validation (zod/yup) | **❌ no instalada** | Validación manual en cada page |

### Hallazgos top — ranking por impacto

| # | Finding | Severidad | Costo de fix |
|---|---|---|---|
| 1 | **`<Modal>` adoptado en solo 4/51 pages** — 28 archivos dibujan overlay con `<div style={{position:"fixed", ...}}>` inline; tres patrones distintos (Caja, Compras modales, RRHH) coexisten. El componente reusable existe desde el design system v1.0 y ya tiene Esc + body-scroll-lock + ARIA. | 🔴 ALTO | 28 migrations mecánicas |
| 2 | **`alert()` / `confirm()` en 25 pages financieras** — incluye Caja, Compras, RRHH, ConciliacionMP. Los `confirm()` rompen mobile (PWA en iOS muestra el origen `pase-yndx.vercel.app`), los `alert()` mata el contexto y bloquea el thread. Hay `useToast` listo y solo 6 archivos lo usan. | 🔴 ALTO | 145 reemplazos guiados |
| 3 | **`<PageContainer>` con 0 adoption** — componente creado en `ui/` con padding responsive (640px breakpoint), nadie lo usa. Cada page hace su `<div style={{padding:24}}>`. Resultado: en mobile la mayoría no tiene padding lateral apropiado y el contenido se pega al borde. | 🔴 ALTO | Wrapper en App.tsx o page-by-page |
| 4 | **Dark mode roto en badges de estado de Solicitudes/Caja/RRHH** — colores hardcoded `#A8893A`/`#2BB673`/`#EF4444`/`#D97706`/`#FCA5A5` para estados "Pendiente/Aprobada/Rechazada/Adeudado" se usan idénticos en light y dark. En dark sobre `#0E1726` el verde y el ámbar pierden contraste (WCAG AA ratio <3:1). | 🟠 MEDIO | Mover a tokens `--pase-success`/`--pase-warn`/`--pase-danger` con override `[data-theme="dark"]` |
| 5 | **587 `fontSize:` hardcoded en JSX inline** vs 107 con `var(--pase-fs-*)` — 83% del codebase ignora la escala tipográfica oficial. Files top: `Caja.tsx`, `LectorExtractoMP.tsx`, `Usuarios.tsx`, `RRHHLegajo.tsx`, `RolesPermisos.tsx`. La escala tiene `xs/sm/base/md/lg/xl/2xl/3xl` (8 niveles) precisamente para que las pantallas se vean alineadas. | 🟠 MEDIO | ESLint rule + migración asistida |
| 6 | **227 `<label>` y solo 1 con `htmlFor`** — ningún label en pages asocia con su input por id, y casi no hay `id=` en los inputs (39 files con `<input>`). Click en label NO enfoca el input. Screen readers no anuncian la asociación. | 🟠 MEDIO | id + htmlFor por cada par |
| 7 | **`<form>` casi inexistente (1 en todo el codebase)** — toda submisión va por `onClick` en `<button>`. Consecuencias: Enter no dispara submit, autofill del browser pierde contexto, no hay validación nativa HTML. | 🟠 MEDIO | Rediseño form-by-form |
| 8 | **Sin componente `<Loading>` / `<Spinner>` reusable** — 38 pages tienen `loading` state, 55 invocaciones de "Cargando" como string inline (`<div className="loading">Cargando…</div>`). Mezcla de 3 patrones: `className="loading"` (38), `<p style={{color:muted}}>Cargando…</p>` (12), `<Suspense fallback={...}>` (5). En mobile la palabra no centra y se ve flotando arriba a la izquierda. | 🟠 MEDIO | Crear `<Loading variant=overlay|inline />` + replace |
| 9 | **24 pages con emojis hardcoded en JSX** post-decisión 2026-05-17 ("emojis bajan el nivel visual"). Incluye `📭` (Caja, Gastos, MensajeriaIG), `🔔` (Ajustes, ConfiguracionNotificaciones), `⚠️` (Gastos, ImportarMaxirest, varios). `Icons.tsx` ya tiene 16 SVG line-art pero `BellIcon`, `AlertIcon`, `DocumentIcon` no se adoptaron. | 🟡 BAJO | Find/replace por icon SVG |
| 10 | **148 `borderRadius:` inline + 0 uso de `var(--pase-radius-*)`** — tokens definidos (`card=14px, md=8px, pill=999px`). Cada page elige su número (8/10/12/14/16/20). Las cards quedan visualmente disparejas. | 🟡 BAJO | ESLint rule + cleanup |
| 11 | **0 uso de `var(--pase-space-*)` en padding/margin/gap** — la escala 4/8/12/16/20/24/32 existe en tokens, nadie la consume. 246 ocurrencias inline mezclan `8, 10, 12, 14, 16, 18` arbitrariamente. | 🟡 BAJO | Token migration por sweep |
| 12 | **Sin focus trap en `<Modal>`** — Tab del usuario puede saltar al body detrás del overlay y enfocar elementos invisibles. Esc sí cierra (bien). | 🟡 BAJO | `react-focus-lock` o trap manual (~30 LOC) |
| 13 | **3 patrones distintos de modal en compras**: `ModalCargarFactura` / `ModalPagarFactura` / `ModalVincularRemito` cada uno con su overlay propio, distintos paddings, distintos botones de cerrar. Lucas reportó visualmente que se ven diferentes. | 🟡 BAJO | Migrar todos a `<Modal>` |
| 14 | **`PageHeader` adoptado parcial (42%)** — 16 pages migradas, 22 todavía con `<div className="ph-row">` o headers improvisados. La consistencia visual prometida en CONTEXTO ("pedido de Lucas: las pantallas se ven desalineadas") solo se cumple a medias. | 🟢 INFO | 22 migrations |
| 15 | **Tabla CSS sin `<thead scope="col">` ni responsive wrapper** — 39 `<table>` en pages, 0 con `scope=`, 0 con `overflow-x:auto` o `tableLayout`. En mobile las tablas anchas (RRHH, Caja, Conciliación) provocan scroll horizontal de toda la página. | 🟢 INFO | Wrapper `<div style={{overflowX:'auto'}}>` + a11y |

---

## 1. Inventario de componentes UI compartidos

`packages/pase/src/components/ui/` (21 archivos, 17 componentes exportados):

| Componente | Pages que lo importan | Adoption |
|---|---|---|
| `<Modal>` | 4 | 🔴 8% |
| `<PageHeader>` | 16 | 🟡 42% |
| `<PageContainer>` | **0** | 🔴 0% |
| `<EmptyState>` | 14 | 🟡 37% |
| `<Card>` / `<CardAnchor>` | ~10 | 🟡 |
| `<KpiTile>` / `<Bento>` / `<StatCard>` | dashboards (no en pages CRUD) | n/a |
| `<RightSubNav>` | varios (Caja, etc.) | OK |
| `<InfoTooltip>` | 10 | OK |
| `<LocalSelector*>` / `<LocalContextoChip>` | varios | OK |
| `<Sparkline>` / `<ComparativaLocales>` | dashboards | n/a |
| `<Icons.*>` (16 SVG) | pocos | 🟡 (emojis los reemplazan en 24 pages) |
| `<TipoPill>` | varios | OK |
| `<ThemeToggle>` | Layout | OK |

**Componentes ausentes que el codebase está pidiendo:**
- `<Button>` (244 usos de `className="btn ..."`)
- `<Loading>` / `<Spinner>` (38 pages con `loading` state, 3 patrones distintos)
- `<Toast>` provider top-level (existe `useToast` pero cada page lo monta por separado; en 19 pages se ignora y se usa `alert()`)
- `<ConfirmDialog>` (los 30 `confirm()` lo necesitan)
- `<FormField label="..." id="..."><input/></FormField>` (227 labels sin htmlFor)

---

## 2. Botones — 0% del codebase usa abstracción

```bash
# Conteo:
grep -rn 'className="btn' packages/pase/src/pages/ | wc -l   →  244
grep -rn 'import.*Button' packages/pase/src/                   →    0
```

PASE NO tiene componente `<Button>`. Todo usa `className="btn btn-acc"` / `"btn btn-soft"` / `"btn btn-warn"` con CSS global en `Layout.tsx`. Ventajas del approach actual: zero overhead, fácil con Tailwind-like clases. Desventajas:

- Cada page reescribe `<button className="btn btn-acc" onClick={...}>+ Nuevo</button>` con leves variaciones.
- No hay tipado de variantes (puede haber `btn-acccc` con typo y no falla).
- Estados loading/disabled mezclados — `disabled={loading}` se hace por page, sin estilo coherente.
- 337 `<button>` totales en pages, solo 43 con `type="button"` explícito (87% implícito → en el único `<form>` existente, todos los buttons serían submit por default).

**Recomendación:** crear `<Button variant=acc|soft|warn size=sm|md|lg loading>` que renderice las mismas clases CSS pero con tipado. Migración non-breaking.

---

## 3. Modal patterns — 3 patrones coexisten

### Pattern A — `<Modal>` componente reusable (4 archivos)
```tsx
// pages/Ventas.tsx, Ajustes.tsx, mensajeria/IGClienteModal.tsx, mensajeria/IGConfigModal.tsx
<Modal isOpen={open} onClose={() => setOpen(false)} title="...">
  {body}
</Modal>
```

### Pattern B — overlay manual fixed (24 archivos)
```tsx
// pages/Caja.tsx, RRHHLegajo.tsx, herramientas/Blindaje.tsx, etc.
{open && (
  <div style={{
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
  }}>
    <div style={{ background: "var(--pase-bg)", borderRadius: 14, padding: 24, maxWidth: 600 }}>
      {body}
    </div>
  </div>
)}
```

### Pattern C — `<aside>` drawer lateral (1 archivo, `EstadoCuentaDrawer`)
```tsx
<aside className={styles.drawer} role="dialog" aria-label="Estado de cuenta">
```

**Inconsistencias entre Pattern B:**
- Algunos cierran con click en overlay, otros no.
- Algunos bloquean scroll del body, otros no.
- Algunos tienen botón ✕, otros no.
- Padding interno: 16, 20, 22, 24, 30, 32 — varía.
- `borderRadius`: 8, 12, 14, 16 — varía.
- Z-index: 50, 100, 200, 999, 1000 — sin convención, modal sobre modal puede romper.

**Recomendación:** un sweep migrando los 24 archivos al `<Modal>` existente. Time est: 4-6 horas. Ganancia: dark mode coverage automático, ARIA correcto, Esc + scroll-lock gratis.

---

## 4. Estados loading / error / empty

### Loading

55 invocaciones de "Cargando..." en pages, distribuidas en:
- `<div className="loading">Cargando...</div>` — 38 (usa CSS class en Layout.tsx)
- `<p style={{color: "var(--pase-text-muted)"}}>Cargando…</p>` — 12 (inline)
- `<Suspense fallback={<div className="loading">Cargando conciliación MP…</div>}>` — 5

No hay `<Loading variant>` componente. **Sugerencia mínima:**
```tsx
// components/ui/Loading.tsx
export function Loading({ variant = "inline", message = "Cargando…" }: Props) {
  if (variant === "overlay") return <div className="loading-overlay">{message}</div>;
  if (variant === "inline-block") return <div className="loading">{message}</div>;
  return <span style={{color: "var(--pase-text-muted)"}}>{message}</span>;
}
```

### Error

No hay `<ErrorState>` reusable. Cada page hace:
```tsx
{error && <div style={{color: "var(--pase-danger)", ...}}>{error}</div>}
```
Mezcla de inline + CSS class `.alert` + `useToast.showError(...)` según el archivo.

### Empty

`<EmptyState>` SÍ existe y se usa en 14 pages — buen ratio. Las otras 11 que tienen "sin datos" usan:
- `<p>Sin movimientos.</p>` inline
- `<div className="muted">Sin facturas.</div>`
- Tabla con `<tbody>` vacío (peor UX).

**Recomendación:** migrar las 11 restantes — son <1h cada una.

---

## 5. Dark mode coverage

Bootstrap en `index.html`:
```html
<script>
  var t = localStorage.getItem('pase-theme');
  if (t === 'dark' || t === 'light') {
    document.documentElement.setAttribute('data-theme', t);
  }
</script>
```

Tokens en `tokens.css` definen dark overrides para: `--pase-bg`, `--pase-bg-soft`, `--pase-text`, `--pase-border`, `--pase-celeste-100/200/300`. Las marcas (`--pase-celeste`, `--pase-gold`) son anclas.

### Coverage estimado

| Tipo de uso | Dark-aware | Total | % |
|---|---|---|---|
| `background: var(--pase-bg)` | ✅ | bien | 100% |
| `color: var(--pase-text)` | ✅ | bien | 100% |
| `color: "#1A3A5E"` literal | ❌ | 18 ocurrencias | rompe |
| `background: "#FFFFFF"` literal | ❌ | 1 ocurrencia (`Negocio.module.css`) | rompe |
| Badges semánticos `#2BB673`/`#A8893A`/`#EF4444` | ❌ | 8 pages (Solicitudes, AprobarSolicitud, rrhh/TabEmpleados, etc.) | rompe |
| Modales con `<Modal>` | ✅ (vía `[data-theme=dark] .modal`) | 4 | OK |
| Modales con `position:fixed` inline | ❌ a menos que usen var | 24 | parcialmente roto |

**Bug regresivo de dark mode #22-may** (burbujas chat) ya fue corregido según memoria. Pero los **badges de estado** son una bomba similar: el verde `#2BB673` sobre fondo dark `#0E1726` con `rgba(43,182,115,0.15)` da contraste ~2.8:1, falla WCAG AA (4.5:1 mínimo).

### Snippet antes/después — Solicitudes badge

**Antes** (`pages/Solicitudes.tsx:58-64`):
```tsx
const ESTADO_BADGE: Record<Estado, { label: string; color: string; bg: string }> = {
  pendiente: { label: "Pendiente", color: "#A8893A", bg: "rgba(168,137,58,0.15)" },
  aprobada:  { label: "Aprobada",  color: "#2BB673", bg: "rgba(43,182,115,0.15)" },
  rechazada: { label: "Rechazada", color: "#EF4444", bg: "rgba(239,68,68,0.15)" },
  expirada:  { label: "Expirada",  color: "#93A8C2", bg: "rgba(147,168,194,0.15)" },
};
```

**Después** (agregar a `tokens.css`):
```css
:root {
  --pase-status-pendiente:  #A8893A;
  --pase-status-pendiente-bg: rgba(168,137,58,0.15);
  --pase-status-aprobada:   #2BB673;
  --pase-status-aprobada-bg: rgba(43,182,115,0.15);
  /* ... */
}
[data-theme="dark"] {
  --pase-status-pendiente:  #E5C16D;          /* tono claro para contrast */
  --pase-status-pendiente-bg: rgba(229,193,109,0.18);
  --pase-status-aprobada:   #6FE0A1;
  --pase-status-aprobada-bg: rgba(111,224,161,0.18);
  /* ... */
}
```
+ usar `color: "var(--pase-status-pendiente)"` en el badge.

---

## 6. Responsiveness

| Métrica | Valor |
|---|---|
| `@media` queries totales en src | 28 (20 archivos) |
| `@media` en pages CSS modules | 4 archivos (`Finanzas`, `Negocio`, `Ajustes`, `DesignSystem`) |
| `@media` inline en `<style>{...}` dentro JSX | 8 (`ConciliacionMP`, `EERR`, `Finanzas`, `MensajeriaIG`, `Negocio`, `PageHeader`, `PageContainer`, `Bento.module.css`) |
| `useMediaQuery` / `matchMedia` / `window.innerWidth` | **0** |
| Fixed `minWidth: <number>` en pages | 21 archivos (`Caja`, `Compras`, `LectorExtractoMP`…) — riesgo de overflow horizontal en mobile |
| `<table>` sin wrapper de scroll | 39 — **rompe mobile** |
| `<form>` con autocomplete: 0 — no relevante porque hay 1 form |

**Hallazgo #5b — Mobile en RRHH/Caja**: tablas anchas (>900px de contenido) sin `<div style={{overflowX: 'auto'}}>` o `tableLayout: 'fixed'`. En el iPhone 14 (390px viewport) la página entera scrollea horizontal — gesture roto.

### Snippet — wrapper recomendado
```tsx
<div style={{overflowX: 'auto', WebkitOverflowScrolling: 'touch'}}>
  <table>...</table>
</div>
```

---

## 7. Toasts / notifications

Hay sistema central:
- `hooks/useToast.ts` — hook con `showToast/showError/showWarn/showInfo`, autodismiss 3s
- `components/Toast.tsx` — render simple top-right

**Adoption:** 6 pages (`Ventas`, `Gastos`, `RRHH`, `RRHHLegajo`, `RolesPermisos`, `ConciliacionMP`).

**No adoption:** 19 pages siguen con `alert()` (Ajustes 7, BackupsAdmin 2, Caja 1, Compras 6, ConfiguracionNotificaciones 1, herramientas/Blindaje 4, Importar 3, ImportarMaxirest 3, LectorFacturasIA 4, mensajeria/* 4, Proveedores 6, Tenants 3, Usuarios 1, etc.).

### Anti-pattern crítico — confirm() en flujos de plata

```tsx
// Compras.tsx:597
if (!confirm(`¿Anular factura ${f.nro}? Esta acción queda registrada.`)) return;

// ConciliacionMP.tsx:506
if(!confirm(`Borrar todos los movimientos MP de ${nombre||"este local"} y re-sincronizar? Esta acción no se puede deshacer.`))return;

// ConciliacionBancaria.tsx:256
if (!confirm('¿Eliminar este extracto? Las líneas y matches se borran.')) return;
```

En PWA en iOS muestra `pase-yndx.vercel.app dice: ...` — el URL se ve en pantalla y queda raro. En desktop bloquea el event loop. **Riesgo de plata**: el usuario click yes en confirm sin leerlo (modal nativo no se puede estilizar para enfatizar el riesgo).

**Recomendación urgente:** crear `<ConfirmDialog danger title body confirmLabel onConfirm onCancel />` y migrar al menos los confirm() de flujos de anulación/borrado.

---

## 8. Iconos

PASE NO tiene librería externa (verificado en `package.json` — no hay `lucide-react`, `@radix-ui/react-icons`, ni `react-icons`). Solo dos fuentes de íconos:

1. `components/ui/Icons.tsx` — set propio de 16 SVG line-art (BellIcon, AlertIcon, DocumentIcon, etc.). Decisión 2026-05-17 dejó esto como dirección.
2. Emojis hardcoded — 24 archivos.

### Emojis residuales en JSX

```tsx
// pages/Ajustes.tsx:423
🔔 Notificaciones

// pages/Caja.tsx:702 (en EmptyState — ok formalmente porque EmptyState.icon acepta ReactNode pero igual son inconsistentes)
icon="📋"

// pages/Gastos.tsx:574, :860
icon="📭"
⚠️ Falta completar: ...

// pages/MensajeriaIG.tsx:361
<EmptyState icon="📭" .../>

// pages/ImportarMaxirest.tsx:202, :264
' · ⚠️ NO impactó caja ...'
⚠️ No se pudo procesar el cierre

// pages/rentabilidad/TabAlertas.tsx:167
icon="✅"

// pages/ConfiguracionNotificaciones.tsx:117, :180
"🔔 Notificaciones activadas ..."
"🔔 Activo en este dispositivo"
```

24 archivos: `Ajustes, Caja, compras/ModalCargarFactura, compras/ModalCargarRemito, ConciliacionMP, ConfiguracionNotificaciones, Gastos, HerramientasHub, ImportarMaxirest, LectorFacturasIA, mensajeria/IGConexionPanel, mensajeria/IGConfigModal, mensajeria/NotificacionesPushToggle, MensajeriaIG, Objetivos, rentabilidad/TabAlertas/TabCMV/TabComprasSugeridas/TabSimulador/TabStock, rrhh/TabNovedades/TabPagos, Usuarios, Ventas`.

**Recomendación:** crear los íconos faltantes (`InboxIcon`, `WarningIcon`, `CheckCircleIcon`) en `Icons.tsx` y reemplazar. Time est: 2-3h.

---

## 9. Typography

`tokens.css` define escala `--pase-fs-xs|sm|base|md|lg|xl|2xl|3xl` (10/11/13/15/18/22/28/38 px).

```bash
grep -rEcn 'fontSize:' packages/pase/src/pages/ → 703 invocaciones
grep -rEcn 'fontSize:.*var\(--pase-fs'           → 107  (15%)
grep -rEcn 'fontSize:\s*[0-9]+'                  → 587  (83%)
```

Tamaños hardcoded más vistos: `10, 11, 12, 13, 14, 15, 16, 18` (algunos como `13.5` y `10.5` que no están en la escala). Files top:
- `Caja.tsx` — alta densidad
- `LectorExtractoMP.tsx`
- `Usuarios.tsx`
- `RRHHLegajo.tsx`
- `RolesPermisos.tsx`

Snippet típico:
```tsx
<span style={{fontSize: 11, color: "var(--pase-text-muted)", fontWeight: 500}}>...</span>
```

Recomendación:
```tsx
<span style={{fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", fontWeight: 500}}>...</span>
```

**ESLint rule sugerida** (similar a `pase-local/*` ya existentes):
```js
"pase-local/no-hardcoded-font-size": ["error", {
  allowed: ["var(--pase-fs-xs)", "var(--pase-fs-sm)", "var(--pase-fs-base)", ...]
}]
```

---

## 10. Form validation

| Pattern | Adoption |
|---|---|
| `zod` / `yup` / `react-hook-form` | **0** (no instaladas) |
| Validación manual `if (!form.nombre) { alert("falta nombre"); return; }` | **dominante** |
| Mensaje de error debajo del input | rara — la mayoría va a `alert()` o `useToast.showError` |
| Disabled del submit hasta válido | algunos forms, no convención |
| `required` HTML attribute | <10 ocurrencias |

Sin `<form>` (1 en todo), no hay validación HTML nativa. Patrón típico:

```tsx
async function guardar() {
  if (!form.fecha) { alert("Falta la fecha"); return; }
  if (form.monto <= 0) { alert("Monto inválido"); return; }
  setLoading(true);
  const { error } = await db.from("...").insert(form);
  setLoading(false);
  if (error) { alert("Error: " + error.message); return; }
  showToast("Guardado");
  onClose();
}
```

**Recomendación de bajo costo (sin instalar zod):** crear helper `validate(form, rules): {ok, errors}` + mostrar errores en un `<div>` debajo de cada input. ROI alto vs reescribir todo con zod.

---

## 11. Accesibilidad básica

| Check | Status |
|---|---|
| `<button type="button">` en forms | 43 de 337 (13%) — pero hay 1 `<form>` → bug latente bajo |
| `<label htmlFor>` asociado | 1 de 227 labels (0.4%) — 🔴 |
| `id=` en `<input>` | <5 — sin id no se puede asociar |
| `<input>` con `aria-label` (cuando no hay label) | 0 — peor accesibilidad para screen readers |
| `role="dialog"` en modales | 2 (Modal componente + EstadoCuentaDrawer); los 24 inline no marcan rol |
| `aria-modal="true"` | 1 (`Modal.tsx`) |
| Focus trap en modales | 0 |
| Botones con solo ícono (sin texto ni `aria-label`) | varios — ej. botones ✕ sin aria-label en modales inline |
| `aria-label` en toda la app | 18 — bajo |
| `<table scope="col">` | 0 de 39 tablas |
| Skip-to-content link | no |
| Contrast WCAG AA | parcial — los badges de estado fallan en dark |

### Snippet antes/después — botón cerrar accesible

**Antes** (típico de modal inline):
```tsx
<div onClick={() => setOpen(false)} style={{cursor:"pointer", padding: 4}}>✕</div>
```

**Después:**
```tsx
<button
  type="button"
  onClick={() => setOpen(false)}
  aria-label="Cerrar"
  style={{background:"none", border:"none", cursor:"pointer", padding: 4, color: "var(--pase-text-muted)"}}
>
  ✕
</button>
```

---

## Severidades — resumen

| Severidad | Findings |
|---|---|
| 🔴 ALTO (UX rota / bug latente / a11y broken) | 3 (Modal 8%, alert/confirm 25 pages, PageContainer 0% adoption) |
| 🟠 MEDIO (consistencia visual notable, dark mode parcialmente roto) | 5 (badges dark, fontSize hardcoded 83%, label sin htmlFor, no `<form>`, no `<Loading>`) |
| 🟡 BAJO (deuda de design system, cleanup) | 4 (emojis vs SVG, borderRadius/space tokens 0%, focus trap, 3 patterns modales compras) |
| 🟢 INFO (oportunidad, no urgente) | 3 (PageHeader 42% adoption, tablas sin wrapper scroll, scope=col) |

---

## Recomendaciones priorizadas (next-sprint candidate)

1. **Crear `<Button>` + `<ConfirmDialog>` + `<Loading>` componentes** (1-2h) → desbloquea migration sweep
2. **Sweep: alert() → toast / ConfirmDialog en 25 pages** (3-4h) — el grueso de UX rota en mobile
3. **Sweep: modal inline → `<Modal>` en 24 archivos** (4-6h) — dark mode + ARIA + Esc gratis
4. **Adoptar `<PageContainer>` en App.tsx wrapper** (30 min) — fix padding mobile en 38 pages
5. **Tokens semánticos `--pase-status-*`** (1h) — fix dark mode badges Solicitudes/RRHH/etc
6. **ESLint rule `no-hardcoded-font-size`** + migration asistida (2-3h) — escala tipográfica real
7. **Wrapper `<div style={{overflowX:'auto'}}>` en las 39 `<table>`** (1h) — fix mobile horizontal scroll
8. **Pares `<label htmlFor>` + `<input id>` en pages financieras** (3-4h) — a11y baseline
