# 04a — Páginas grandes (frontend PASE)

Auditoría focused en las 8 páginas más grandes del frontend (`packages/pase/src/pages/`).
**Total scopeada:** 9.389 LOC en 10 archivos.

## Resumen ejecutivo

- **6 páginas > 1.000 LOC** (ConciliacionMP, RRHHLegajo, Compras, Caja, RRHH, Gastos).
- **1 página entre 700-1.000 LOC** (Usuarios).
- **EERR** (601 LOC) y **ConciliacionBancaria** (529 LOC) ya están en el límite — incluidas como bonus.
- **0 `: any`** en todas estas páginas → buena disciplina TS. Casi todo el patrón cast es `as unknown as X` con comentario justificando.
- **108 `eslint-disable`** distribuidos (muchos comentados con motivo C4-Fxx — deuda registrada).
- **150 `alert/confirm/prompt`** activos en producción → UX horrible para flujos críticos de plata.
- **0 `useMemo` / `useCallback`** en 6 de las 8 páginas grandes (Caja, Compras, Gastos, RRHH, EERR, ConciliacionMP). Sólo RRHHLegajo y Usuarios usan memoización ocasional.
- **0 `htmlFor` en `<label>`** en TODA la carpeta `pages/` excepto LectorFacturasIA. **A11y crítico en las 150 modals.**
- **0 `aria-modal` / focus trap** en los modals de estas páginas. Sólo se usan `role`/`aria-*` aislados en sub-componentes (38 ocurrencias contra ~150 modals).
- **3 páginas con doble-fetch / race conditions** sin guardia `isMounted` o `AbortController` (RRHHLegajo, EERR, Caja).
- **Bug latente concreto:** `setInterval` en `ConciliacionMP.sincronizar()` no se cancela si el usuario navega afuera durante el countdown de 120s. Sigue corriendo y disparando `setSyncCountdown` sobre un componente desmontado → React warning + memory leak.

### Métricas por archivo

| Archivo | LOC | useState | useEffect | top-level fns | useMemo/Cb | alert/confirm/prompt | Imports |
|---|---:|---:|---:|---:|---:|---:|---:|
| ConciliacionMP.tsx | 1666 | 37 | 3 | 2 | 0 | 4 | 13 |
| RRHHLegajo.tsx | 1257 | 29 | 4 | ~5 | 2 | 9 | ~15 |
| Compras.tsx | 1214 | 30 | 6 | 1 | 0 | 18 | 24 |
| Caja.tsx | 1081 | 27 | 5 | 1 | 0 | 11 | 16 |
| RRHH.tsx | 1075 | 41 | 11 | 1 | 0 | 6 | 20 |
| Gastos.tsx | 1009 | 25 | 3 | 1 | 0 | 17 | 17 |
| Usuarios.tsx | 771 | 9 | 2 | ~3 | 0 | 1 | 6 |
| EERR.tsx | 601 | 12 | 2 | 1 | 0 | 0 | 9 |
| Cierre.tsx | 186 | 6 | 1 | — | — | — | — |
| ConciliacionBancaria.tsx | 529 | 7 | 2 | — | — | — | — |

## Ranking por severidad

| # | Sev | Archivo:línea | Hallazgo |
|---|---|---|---|
| 1 | 🔴 | ConciliacionMP.tsx:413-421 | `setInterval` 120s sin cleanup en unmount durante sync |
| 2 | 🔴 | Gastos.tsx:177-198 | `useEffect` con setState sin guard `isMounted` (race condition al cambiar local rápido) |
| 3 | 🔴 | RRHHLegajo.tsx:175-193 | `useEffect` recalcula liquidación final sin AbortController; depende de `vacTomadas` que carga async — el primer compute puede usar valor stale |
| 4 | 🔴 | Caja.tsx:355-371 | Query auditoría con `ilike "%\"id\":\"X\"%"` sobre JSON serializado — vulnerable a inyección si el id contiene `"` y SQL injection potencial (Postgres LIKE) |
| 5 | 🟠 | ConciliacionMP.tsx (todo) | 1666 LOC en 1 componente con 37 useState, 0 sub-componentes extraídos |
| 6 | 🟠 | Caja.tsx, Compras.tsx, Gastos.tsx, RRHH.tsx | **18 modals usan `prompt()` / `confirm()` / `alert()` para flujos financieros** — UX nativa horrible, no aria-accesible, bloquea event loop |
| 7 | 🟠 | Compras.tsx:597-604, Caja.tsx:467-475, RRHHLegajo.tsx:773-775 | `prompt()` para capturar **motivo de anulación** que queda en auditoría — sin validación, sin textarea, escapado mal |
| 8 | 🟠 | Compras.tsx:439-458 | Warning de factura duplicada usa `confirm()` (bloqueante) — debería ser dialog inline con datos |
| 9 | 🟠 | Caja.tsx:387 | `parseFloat(form.importe)*(form.esEgreso?-1:1)` — flotante para plata. Pierde precisión a partir de centavos en montos grandes |
| 10 | 🟠 | RRHHLegajo.tsx:107-119 | `useEffect` con deps `vacLineas`/`aguLineas` por referencia — re-corre en cada keystroke. Debería ser `vacLineas.map(l=>l.cuenta).join("|")` |
| 11 | 🟠 | Caja.tsx:206-211, Gastos.tsx:209-218, Compras.tsx:202-208, RRHHLegajo.tsx:107-119 | **Patrón repetido en 5 páginas**: useEffect "defensive reset" de cuenta. Es deuda — debería ser un hook custom `useDefensiveAccount(value, allowedList, setter)` |
| 12 | 🟠 | RRHH.tsx:105, 656-657 | `saveTimers.current[key] = setTimeout(...)` sin cleanup en unmount → pago/novedad fantasma si el user navega afuera con un debounce pendiente |
| 13 | 🟠 | EERR.tsx:1-14 | Eslint-disable bloque entero para `ERow`/`ESection` declarados dentro del componente (re-mount cada render). El TODO está pero acumula deuda visible |
| 14 | 🟠 | EERR.tsx:131-146 | `Promise.all(meses.map(cargarMesResumen))` — N round-trips secuenciales pequeños. Para 3 meses está OK, pero la función no debounce-protege cambios rápidos del selector |
| 15 | 🟠 | Compras.tsx:1093 | `setIdempKeyPagarFac(crypto.randomUUID())` se llama EN EL onClick del IconPay además del useEffect — duplicación; el useEffect ya cubre el caso |
| 16 | 🟠 | Compras.tsx:627-628, RRHH.tsx:451-452 | Patrón `db.from(X).insert([...])` con eslint-disable `pase-local/no-direct-financiera-write -- deuda C4-Fxx`. Hay ~5 deudas C4 abiertas vinculadas a esto |
| 17 | 🟠 | Usuarios.tsx:213-218, 254 | `delete + insert` de `usuario_permisos` y `usuario_locales` sin transacción — si falla el INSERT después del DELETE, el user queda sin permisos / sin locales. **Comentario existente en línea 224 ya marca el riesgo, pero sigue sin transaccion** |
| 18 | 🟡 | Todas | Cero `htmlFor`/`id` en `<label>` + `<input>` — a11y rota globalmente. Click en label no enfoca input |
| 19 | 🟡 | Todas | Modals sin `aria-modal="true"`, sin `role="dialog"`, sin focus trap. `<div className="overlay">` con `onClick={() => setModal(null)}` solo |
| 20 | 🟡 | Todas | Modals sin manejo de ESC global — sólo Compras.tsx:334-339 implementa ESC y solo para el lector IA |
| 21 | 🟡 | Compras.tsx:24 imports, Caja.tsx:16, RRHH.tsx:20 | Imports masivos (20-24 import lines en archivos > 1k LOC) — indicador típico de god-object |
| 22 | 🟡 | Caja.tsx:198, Gastos.tsx:156, Compras.tsx:263 | `emptyForm` declarado inline dentro del componente — re-crea ref cada render |
| 23 | 🟡 | ConciliacionMP.tsx:544-571 | `dedupedMovs` se recalcula cada render (sin useMemo). Función con `Map` + 2 `for` loops sobre `movimientos` array — O(n) cada render |
| 24 | 🟡 | RRHHLegajo.tsx:225 | `Date.now()` durante render — antiguedadMs re-calcula constantemente, marcado TODO sin fix |
| 25 | 🟡 | Compras.tsx:1051-1102, Caja.tsx:722-820 | JSX inline gigante en map sin extraer fila (`FacturaRow`, `MovimientoRow`) → re-render full lista por cualquier setState |
| 26 | 🟡 | Caja.tsx:480 | `parseFloat(String(em.importe)) || original?.importe || 0` — si user borra el input y pone "0", queda 0 (correcto), pero si pone "abc", queda original. Comportamiento confuso |
| 27 | 🟡 | Compras.tsx:619 | `nro || \`REM-${Date.now().toString().slice(-6)}\`` — Date.now en runtime de save handler está OK, pero el número puede colisionar entre dos cargas en el mismo ms |
| 28 | 🟡 | Gastos.tsx:177-198 | `useEffect` con array de deps vacío + `void` interno hace fetch only-on-mount, no recarga al cambiar local activo. Hard-codeo |
| 29 | 🟡 | EERR.tsx:60-64 | `fmtMesLabel` declarada outside, OK. Pero `cargarMesResumen` declarada inline en componente → re-crea cada render → useEffect que la usa entra en loop si la deps lo incluyera (por eso el eslint-disable) |
| 30 | 🟢 | Todas | Variables `_underscore` para fechas auxiliares (`_hace90`, `_hastaPlus`) — convención no consistente, mejor `const hace90`/`hastaPlus` o tipo helper |
| 31 | 🟢 | ConciliacionMP.tsx:227 | `const _hace90=new Date();_hace90.setDate(_hace90.getDate()-90);` — código en una línea, mal formateado |
| 32 | 🟢 | RRHHLegajo.tsx:130-159 | 7 funciones `loadX` separadas que podrían simplificarse a `useTable(table, filters)` hook. No bloqueante |
| 33 | 🟢 | Usuarios.tsx:39 | `emptyForm` no tipado (Record<string, unknown> implícito por mix de tipos) — debería ser `interface UsuarioForm` |

## Hallazgos críticos en detalle

### 🔴 #1 — ConciliacionMP: setInterval sin cleanup en unmount

**Archivo:** `packages/pase/src/pages/ConciliacionMP.tsx:413-421`

```tsx
// Paso 2: countdown de 2 minutos
await new Promise<void>(resolve=>{
  let remaining=120;
  const interval=setInterval(()=>{
    remaining--;
    setSyncCountdown(remaining);
    if(remaining<=0){clearInterval(interval);resolve();}
  },1000);
});
```

**Problema:** si el operador click "Sincronizar" y luego navega a otra ruta o cambia de sub-sección (Caja → Movimientos), el `setInterval` sigue corriendo 120 segundos llamando `setSyncCountdown` sobre un componente desmontado. Resultado: React warning + posible re-render fantasma + el `await new Promise` nunca resuelve porque el componente murió.

Además, cuando termina el countdown llama `setSyncCountdown(-1)` → `fetch /api/mp-process` → `await load()` → `showToast()` sobre el componente desmontado. La cadena entera ocurre fuera del lifecycle.

**Fix sugerido:**

```tsx
const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
useEffect(() => () => {
  if (intervalRef.current) clearInterval(intervalRef.current);
}, []);

// dentro de sincronizar():
await new Promise<void>(resolve => {
  let remaining = 120;
  intervalRef.current = setInterval(() => {
    remaining--;
    setSyncCountdown(remaining);
    if (remaining <= 0) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      resolve();
    }
  }, 1000);
});
```

Idealmente, el sync entero debería usar `AbortController` con cancel en unmount, dado que ya hay `useEffect` que dispara `sincronizar()` desde `?action=sync` (líneas 467-481).

### 🔴 #2 — Gastos: empleadosVisibles useEffect sin guard `isMounted`

**Archivo:** `packages/pase/src/pages/Gastos.tsx:177-198`

```tsx
const [empleadosVisibles, setEmpleadosVisibles] = useState<EmpleadoVisible[]>([]);
useEffect(() => {
  (async () => {
    const { data } = await db.from('v_rrhh_empleados_visible')
      .select('id, nombre, local_principal_id, locales_ids')
      .eq('activo', true)
      .order('nombre');
    if (data && data.length > 0) {
      const ids = data.map((e: { id: string }) => e.id);
      const { data: emps } = await db.from('rrhh_empleados')
        .select('id, apellido')
        .in('id', ids);
      // ...
      setEmpleadosVisibles(...);
    } else {
      setEmpleadosVisibles([]);
    }
  })();
}, []);
```

**Problemas:**
1. Sin guard `isMounted` ni `AbortController` — si el componente desmonta entre los 2 fetches secuenciales, hay setState sobre componente muerto.
2. Deps `[]` — al cambiar `localActivo` o cambiar de tenant override, esta lista NO se refresca. Combinado con la nota del propio comentario (`bug 2026-05-20: aparecían empleados de otros locales`), si el user cambia de local rápido, ve empleados stale.
3. Doble round-trip secuencial (`v_rrhh_empleados_visible` → `rrhh_empleados`). Debería ser una sola query con join: `select('id, nombre, local_principal_id, locales_ids, rrhh_empleados(apellido)')`.

### 🔴 #3 — RRHHLegajo: liquidación final con dep stale

**Archivo:** `packages/pase/src/pages/RRHHLegajo.tsx:175-193`

```tsx
useEffect(() => {
  if (!liqFinalModal || !emp || !emp.fecha_inicio) return;
  const vacAcum = calcularVacaciones(emp.fecha_inicio, vacTomadas);
  // ...
  setLiqFinalData(lf);
}, [liqFinalModal, liqFinalForm.fecha_egreso, liqFinalForm.motivo, emp?.sueldo_mensual, emp?.fecha_inicio, vacTomadas]);
```

**Problema:** `vacTomadas` se carga en otro fetch (`loadVacTomadas`, línea 140-144). Si el usuario abre el modal de liquidación final ANTES de que `loadVacTomadas` complete (típico en mobile con red lenta), el primer `calcularVacaciones` usa `vacTomadas=0` y muestra un total incorrecto. Cuando el fetch completa, el effect re-dispara y corrige — pero el usuario YA vio el número equivocado y puede haber clicado "Confirmar y pagar".

Hay una guarda intermedia: `confirmarLiqFinal()` (línea 654-673) usa `total` calculado en el render, así que el monto enviado a la RPC se recalcula correctamente. Pero la UX es: muestra $X → un segundo después salta a $Y → user confunde.

**Fix:** bloquear la apertura del modal hasta que `loadVacTomadas` complete (flag `loading` o spinner), o calcular `vacAcumuladas` inline en el render usando un `useMemo([emp, vacTomadas])`.

### 🔴 #4 — Caja: query auditoría vulnerable a SQL injection

**Archivo:** `packages/pase/src/pages/Caja.tsx:355-371`

```tsx
useEffect(() => {
  if (!detalleEdicion) { setAuditLog(null); return; }
  db.from("auditoria")
    .select("detalle")
    .eq("tabla", "movimientos")
    .eq("accion", "EDICION")
    .ilike("detalle", `%"id":"${detalleEdicion.id}"%`)
    // ...
```

**Problema:** se interpola `detalleEdicion.id` dentro del LIKE pattern sin escape. Si bien Supabase escapa el valor pasado a `.ilike()`, los caracteres `%`, `_`, `\` y `"` tienen semántica especial. Aunque hoy los ids son `MOV-<unix>-<rand>` (ascii alfanumérico), si en el futuro el formato cambia o se introduce un id con `%`, el LIKE matchea cosas que no debe.

Más urgente: **performance**. Un `ilike` sobre `auditoria.detalle` (texto JSON crudo) en una tabla que el comentario dice tiene 3.5k filas hoy y crece linealmente, sin índice especial, es full table scan. El `.limit(1)` ayuda pero no evita el scan completo. El comment marca el problema (`AUDIT F3A#9`) pero el fix es incompleto.

**Fix correcto:** agregar columna `auditoria.mov_id text` populada por trigger desde `detalle::jsonb->>'id'`, indexarla, y query `db.from("auditoria").select("detalle").eq("mov_id", detalleEdicion.id)`.

## Hallazgos arquitectónicos (no detalle por línea)

### 🟠 ConciliacionMP.tsx — el monstruo absoluto

- **1666 LOC** sin un solo sub-componente extraído (excepto `PeriodoPill` 40 LOC).
- **37 useState** declarados consecutivos (líneas 186-272).
- **Modal de conciliar** (línea 1233) tiene `width:680` con tabs "gasto / factura / remito / movimiento_interno" cada uno con su propio form. **Cada form son ~50 líneas de JSX inline**. Total del modal: ~390 LOC en una sola JSX expression.
- **6 funciones `justificarConX`** asíncronas con patrón idéntico (líneas 658-810) — refactor a un único `justificar(tipo, payload)` ahorra ~150 LOC.
- **Sin memoización**: `dedupedMovs` (líneas 544-571), `egresosManuales` (596), `egresosPendientesList` (605), `saldoConsolidado` (612), `porAcreditarTotal` (613), `ultimaSync` (614) — todos se recalculan en cada render.

**Recomendación de split:**

```
ConciliacionMP/
  ├── index.tsx                  // orquestador, ~300 LOC max
  ├── useMpConciliacion.ts       // hook con load/sincronizar/save handlers
  ├── MpHeaderKPIs.tsx           // bento de 3 KPIs
  ├── MpToolbar.tsx              // PeriodoPill + filtros + acciones
  ├── MpEgresosTable.tsx         // tabla del tab Egresos
  ├── MpIngresosTable.tsx        // tabla del tab Ingresos
  ├── ModalConciliar/
  │   ├── index.tsx              // shell del modal
  │   ├── TabGasto.tsx
  │   ├── TabFactura.tsx
  │   ├── TabRemito.tsx
  │   ├── TabMovInterno.tsx
  │   └── TabIgnorar.tsx
  └── ModalConfigCuentas.tsx
```

Estimado: pasa de 1666 LOC a 9 archivos de ~150-300 LOC cada uno. Cada uno testeable en aislamiento.

### 🟠 Patrón "defensive cuenta reset" repetido en 5 páginas

Las páginas Caja (líneas 205-211), Gastos (209-218), Compras (202-208 + 275-281), RRHHLegajo (107-119), RRHH (134-140) tienen **el mismo useEffect repetido**:

```tsx
useEffect(() => {
  if (form.cuenta && !cuentasUsables.includes(form.cuenta)) {
    setForm(f => ({ ...f, cuenta: "" }));
  }
}, [form.cuenta, cuentasUsables.join("|")]);
```

Es un workaround para el "Bug Caja-1" documentado. Cada implementación es ligeramente distinta (algunas usan join, otras nada → re-corre cada render). Debería extraerse a:

```ts
// lib/useDefensiveAccount.ts
export function useDefensiveAccount<T>(
  form: T,
  fieldKey: keyof T,
  allowedAccounts: string[],
  setForm: (updater: (prev: T) => T) => void
) {
  const accountsKey = allowedAccounts.join("|");
  useEffect(() => {
    const current = form[fieldKey];
    if (typeof current === "string" && current && !allowedAccounts.includes(current)) {
      setForm(f => ({ ...f, [fieldKey]: "" }));
    }
  }, [form[fieldKey], accountsKey]);
}
```

### 🟠 Patrón modal nativo (`alert`/`prompt`/`confirm`) en flujos de plata

**Total: 150 ocurrencias en pages/.** Las más críticas:

| Archivo:línea | Uso | Por qué importa |
|---|---|---|
| Caja.tsx:468 | `prompt("¿Por qué anulás este movimiento?")` | Motivo va a auditoría, sin validación de longitud, sin textarea, sin label |
| Compras.tsx:597-598 | `confirm + prompt` para anular factura | Doble dialog nativo, UX terrible |
| Compras.tsx:451-455 | `confirm` warning de factura duplicada con info multi-línea | Texto plano sin formato, no acepta HTML |
| Compras.tsx:688-689 | `confirm + prompt` para anular remito | Idem facturas |
| RRHHLegajo.tsx:774-775 | `prompt` con resumen de N movs y `\n` para anular pagos | Long multi-line prompt en native dialog → recortado en Chrome |
| Gastos.tsx:400 | `prompt` para motivo anular gasto | Idem caja |
| RRHH.tsx:687, 789 | `alert` para validaciones de novedad | Bloquea UI, no consistente con toast |

Los `alert(translateRpcError(error))` (24+ ocurrencias) podrían unificarse con `showError(translateRpcError(error))` del hook `useToast` ya disponible.

**Recomendación:** crear `ConfirmDialog` y `PromptDialog` controlados, con focus trap, textarea para motivos, validación de longitud mínima. Reemplazar gradualmente, empezando por los flujos críticos: anulación + warning de duplicados.

### 🟠 Sin memoización en componentes 1k+ LOC

Caja, Compras, Gastos, RRHH, EERR, ConciliacionMP: **0 `useMemo` / `useCallback`**.

- En Caja: cada keystroke en el datepicker re-genera `mFilt` (filter+sort), `subNavSections` (objeto literal), `cc()` callback, `queryMovimientos` closure. 27 useState significa ~27 posibles re-renders distintos por interacción.
- En Compras: lo mismo + 30 useState. El `subNavSections` array (líneas 790-803) con count de facturas filtradas re-corre `.filter` 4 veces cada render.
- En EERR: `facturasBucket(b)` (línea 200) se llama 6+ veces por render (CMV, fijos, variables, publicidad, comisiones, impuestos) — cada uno hace `.filter` sobre `facturas`.

Para EERR específicamente que ya tiene chart lazy + recharts pesado, agregar memos a `facturasBucket` y a las totalizaciones daría ganancia visible.

### 🟠 Usuarios.tsx — delete+insert sin transacción

Líneas 213-235 y 254-268: el flujo de save permisos hace `DELETE FROM usuario_permisos` y luego `INSERT`. Si el INSERT falla por RLS o red, el user queda **sin permisos** (el DELETE ya ocurrió). 

El comentario líneas 224-229 lo reconoce explícitamente:

```tsx
// Bug crítico fixeado 2026-05-14: antes este error se logueaba y se
// tragaba silenciosamente. Resultado: si RLS bloquea el INSERT (...)
// el DELETE previo ya borró todo y el user editado quedaba con 0 permisos.
// Ahora paramos el flow y reportamos. Por defense-in-depth dejamos
// este check aunque la RLS ya está alineada.
```

El "fix" actual es solo reportar el error — el usuario editado **queda igual sin permisos**. El admin tiene que reabrir y re-guardar. Fix correcto: RPC atómica `actualizar_permisos_usuario(p_usuario_id, p_modulos[], p_locales[])` que haga delete+insert en una transacción server-side.

### 🟠 Estilos inline masivos vs CSS modules / clases

Las 8 páginas grandes acumulan **miles de líneas de `style={{...}}` inline**. Ejemplo extremo: Caja.tsx:730-797 (movimientos table row) tiene 70 líneas continuas con inline styles. Es muy difícil de mantener consistencia de design system.

Hay un design system parcial (`var(--pase-celeste)`, `var(--pase-text-muted)`, etc.) pero se usa mezclado con valores hardcoded (`fontSize: 11`, `padding: "6px 0"`). Recomendación: mover a clases utilitarias o CSS modules.

## Para próxima fase

- **Recomendación de orden de split**: ConciliacionMP (mayor ROI por tamaño absoluto) → Compras (alto uso operativo) → Caja → RRHH → Gastos → RRHHLegajo → Usuarios.
- **Auto-fixable inmediato (sin testing manual):**
  1. Cleanup del `setInterval` en ConciliacionMP (Crítico #1).
  2. Cleanup de `saveTimers` ref en RRHH.tsx.
  3. Extraer `useDefensiveAccount` hook y aplicar a las 5 páginas.
  4. Reemplazar los `alert(translateRpcError(error))` por `showError(translateRpcError(error))` (24 ocurrencias).
  5. Memoizar `dedupedMovs`, `egresosManuales`, `saldoConsolidado` en ConciliacionMP (5 useMemo bien dirigidos).
  6. Memoizar `facturasBucket` y totalizaciones en EERR.
- **Requiere decisión humana:**
  - RPC atómica `actualizar_permisos_usuario` (cierra C4-Fxx adicional).
  - Reemplazar `prompt()` por dialog real para motivos de anulación.
  - Plan de split de ConciliacionMP (~3 días de refactor + tests).
- **No tocar sin spec:** la query de auditoría en Caja (Crítico #4) necesita migration SQL + trigger — coordinar con backend.
