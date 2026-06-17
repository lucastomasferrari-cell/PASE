# Spec — Cierre / bloqueo de mes (cierre de período) · PASE

**Fecha:** 2026-06-16
**Autor:** Lucas + Claude
**Estado:** Diseño para revisión

> Segunda de dos features pedidas por Lucas (la primera fue el Simulador de escenarios, ya en prod — ver `2026-06-16-simulador-escenarios-eerr-design.md`). Sinergia: un mes cerrado queda firme → el reporte de ese mes (y la simulación encima) es estable.

---

## 1. Objetivo

Dar al dueño un **cierre de período contable**: marcar un mes como cerrado para un local, y a partir de ahí **bloquear cualquier cambio** (crear / editar / anular) sobre datos con fecha en ese mes. Así el reporte de un mes pasado queda firme y nadie lo desbalancea sin querer (ni cargando algo con fecha vieja, ni editando/anulando lo que ya estaba).

---

## 2. Decisiones tomadas (brainstorm 16-jun)

- **Qué bloquea: TODO lo financiero** — ventas, compras/facturas, remitos, gastos, sueldos (rrhh) y movimientos de caja. Cierre contable completo.
- **Quién: solo dueño/admin** cierran y reabren. Reabrir es libre para ellos (no pide ceremonia extra), pero queda registrado quién y cuándo cerró/reabrió.
- **Granularidad: por local** — cada local cierra su propio mes (coherente con el resto del sistema, que es per-local).
- **Sueldos (rrhh) entran en v1** — aunque `rrhh_liquidaciones` no tiene `fecha`/`local_id` directos (se resuelven por la novedad mes/año + el local del empleado).
- **Dónde se cierra: en Reportes**, parado en el mes que se revisa.

---

## 3. Arquitectura de datos

Tabla nueva **`periodos_cerrados`** (por local; columnas estándar + RLS dual):

| campo | tipo | nota |
|---|---|---|
| `id` | UUID PK | |
| `tenant_id` | UUID | |
| `local_id` | INTEGER | |
| `periodo_mes` | DATE | primer día del mes cerrado (ej. 2026-05-01) |
| `cerrado_at` | TIMESTAMPTZ | |
| `cerrado_por` | INTEGER | usuario que cerró |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

`UNIQUE (tenant_id, local_id, periodo_mes)`. **La existencia de la fila = ese mes/local está cerrado.** Reabrir = borrar la fila (con log en auditoría). No se reusa `cashflow_cierres` (ese guarda saldos del cashflow, otro propósito).

Helper SQL `fn_periodo_esta_cerrado(p_local_id, p_fecha) → boolean` (STABLE): true si existe `periodos_cerrados` para ese local y el mes de `p_fecha`. Lo usan los triggers.

---

## 4. Acciones (RPCs atómicas — C9/C11)

- `cerrar_periodo(p_local_id integer, p_periodo_mes date) → jsonb` — inserta la fila (idempotente: si ya está cerrado, no falla). SECURITY DEFINER; exige `auth_es_dueno_o_admin()` (sino `SOLO_DUENO_ADMIN`) + local del tenant. Registra `cerrado_por`/`cerrado_at`.
- `reabrir_periodo(p_local_id integer, p_periodo_mes date) → jsonb` — borra la fila. Mismas validaciones. Audita la reapertura (quién/cuándo) vía `_auditar`.
- Ambas: `REVOKE ... FROM PUBLIC, anon` + `GRANT ... TO authenticated`.

---

## 5. Enforcement — el bloqueo de verdad

Un **trigger guardián** `fn_guard_periodo_cerrado()` (reusa el patrón de los anti-huérfanos `202606092000`), conectado **BEFORE INSERT OR UPDATE OR DELETE** en cada tabla de plata. Antes de escribir una fila, resuelve `(local_id, fecha)` de la fila (NEW en insert/update, OLD en delete/update) y si el período está cerrado → `RAISE EXCEPTION 'PERIODO_CERRADO'`.

- **Bypass por GUC** `pase.skip_periodo_guard` (igual que `skip_orphan_guard`): lo setea `eliminar_tenant_completo` / migraciones / backfills para no romperse. Default: candado activo.
- En UPDATE chequea **ambos** lados (OLD y NEW): no se puede sacar ni meter una fila de/hacia un mes cerrado.
- Tablas con `fecha` + `local_id` directos (trigger simple): **ventas, facturas, remitos, gastos, movimientos**.
- **Sueldos**: `rrhh_liquidaciones` no tiene `fecha`/`local_id`. Su trigger resuelve el período por la **novedad** (`rrhh_novedades.mes`/`.anio` vía `liq.novedad_id`) y el local por el **empleado** (`rrhh_empleados.local_id` vía `nov.empleado_id`). Si ese (local, mes/año) está cerrado → bloquea. (Los adelantos/pagos que generan gasto+movimiento ya quedan cubiertos por los triggers de `gastos`/`movimientos`.)

> El error `PERIODO_CERRADO` se mapea en `src/lib/errors.ts::translateRpcError` → "Ese mes está cerrado. Reabrilo desde Reportes para poder modificarlo."

---

## 6. Frontend

- **En Reportes (EERR)**, para dueño/admin: botón **"Cerrar mes 🔒"** sobre el mes/local que se está viendo; si ya está cerrado, muestra **"🔒 Mes cerrado"** + botón **"Reabrir mes"**. Indicador visible del estado.
- Servicio `src/lib/periodos.ts`: `cerrarPeriodo`, `reabrirPeriodo`, `estaCerrado(localId, mes)` / `listarCerrados(localId)` (query directa con filtro `local_id`).
- **Manejo de error transversal:** cualquier pantalla (Caja, Gastos, Compras, Ventas, Equipo) que intente guardar/editar/anular algo en un mes cerrado recibe `PERIODO_CERRADO` traducido. El backend es la fuente de verdad; las pantallas no necesitan lógica extra (defensa en el trigger). Nice-to-have futuro: deshabilitar el datepicker en meses cerrados (no en v1).

---

## 7. Casos borde

- **Conciliación MP**: crea movimientos con fecha pasada. Si el mes ya está cerrado, la creación se bloquea → regla operativa: **conciliar antes de cerrar**, o reabrir el mes. Documentado.
- **COMANDA → ventas**: las ventas del POS son del día (mes corriente), no afectadas. Solo se bloquearía una venta con fecha en un mes cerrado (caso raro).
- **`eliminar_tenant_completo` / tests**: usan el GUC `pase.skip_periodo_guard` para no chocar con el candado.
- **Cerrar un mes "incompleto"**: se permite (Lucas decide cuándo cerrar). El candado no valida que el mes esté "completo".

---

## 8. Reglas del repo a cumplir

- Tabla nueva con checklist (C7: `tenant_id`/`created_at`/`updated_at`, RLS dual con `local_id`).
- RPCs SECURITY DEFINER con auth check + `REVOKE FROM PUBLIC, anon` (C11), error codes UPPER_SNAKE (C9) mapeados.
- `applyLocalScope` / filtro `local_id` en las queries del servicio (C3).
- **Test E2E mutante** (C2): cerrar mes → intentar crear/editar/anular un gasto y un movimiento con fecha en ese mes → `PERIODO_CERRADO`; reabrir → permitido. + tocar **e2e-full** (invariante: con un mes cerrado, un INSERT con fecha en ese mes falla).
- Regla nueva a respetar: **todo trigger guardián nuevo sobre tabla que `eliminar_tenant_completo` borra necesita el bypass GUC**, o rompe el e2e con error de borrado de tenant.

---

## 9. Riesgos / cosas a cuidar

- **Es enforcement sobre TODAS las tablas de plata** → un trigger mal hecho puede frenar la operación diaria. Por eso: bypass GUC, tests mutante + e2e-full, y la lógica del guard es read-only sobre `periodos_cerrados` (barata).
- **`rrhh_liquidaciones`**: el join a novedad/empleado en el trigger es la única parte con lógica no trivial — cuidar performance (índices ya existen en las FK) y el caso `novedad_id` null (si existiera → no bloquea, no rompe).
- **No romper backfills**: cualquier migración futura que toque datos de meses cerrados debe setear el GUC.

---

## 10. Criterio de éxito (MVP)

El dueño, parado en Reportes sobre un mes pasado, lo **cierra**. A partir de ahí: nadie puede crear, editar ni anular ventas/compras/gastos/sueldos/movimientos con fecha en ese mes (reciben un mensaje claro). Si necesita corregir algo, **reabre** el mes (queda registrado), corrige y vuelve a cerrar. El reporte de ese mes queda firme.
