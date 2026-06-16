# Spec — Módulo Utilidades / Reparto de Utilidades · PASE

**Fecha:** 2026-06-16
**Autor:** Lucas + Claude
**Estado:** Diseño para revisión

> Módulo hermano del **Cashflow** (`docs/superpowers/specs/2026-06-14-cashflow-rene-design.md`). El cashflow *muestra* los retiros; Utilidades los *gestiona*. Nace del problema real de Rene: repartir sobre la ganancia teórica del EERR (devengado) en vez de la plata real → sobre-distribución (mayo: $23.5M repartidos con ~$14M de líquido).

---

## 1. Objetivo

Dar al dueño **el control del reparto de utilidades**: definir los socios y sus %, apartar plata para repartir (la disciplina Profit First), registrar cada reparto prolijo (adiós "Egreso Manual"), y —lo más importante— saber **cuánto es seguro repartir** cada mes contra la plata real, para no descapitalizarse.

### Las 3 capas (este spec = Capa 1 + 2)
- **Capa 1 — Fundación + registro:** socios + %, CAJA UTILIDADES (reserva), reservar, registrar reparto.
- **Capa 2 — Calculador:** "cuánto es seguro repartir" (líquido − obligaciones − colchón).
- **Capa 3 — Apartado automático** (FUERA de este spec): apartar % al entrar plata. Spec propio futuro.

---

## 2. Decisiones tomadas (brainstorm 16-jun)
- **Socios por LOCAL** — cada negocio tiene su propia lista de socios + %. La CAJA UTILIDADES y el reparto son por local.
- **% fijo por socio con override puntual** — se define una vez (suman 100%); cada reparto pone un total que se divide por los %, pero se pueden ajustar los montos en un reparto puntual.
- **Colchón dinámico de los datos** — el sistema calcula el colchón de las obligaciones mensuales conocidas (sueldos + fijos + alquiler que faltan pagar) + N meses extra configurable (default 1).

---

## 3. Arquitectura de datos

Tres tablas nuevas, **por local** (columnas estándar `tenant_id`, `local_id`, `created_at`, `updated_at`, RLS dual).

### `utilidades_socios`
| campo | tipo | nota |
|---|---|---|
| `id` | UUID PK | |
| `tenant_id`, `local_id` | | |
| `nombre` | TEXT | ej. "Lucas", "Club Atlético Excursio" |
| `porcentaje` | NUMERIC(5,2) | 0–100; los activos de un local deberían sumar 100 (validación blanda + aviso, no bloquea) |
| `activo` | BOOLEAN | baja lógica |

### `utilidades_repartos`
| campo | tipo | nota |
|---|---|---|
| `id` | UUID PK | |
| `tenant_id`, `local_id` | | |
| `fecha` | DATE | cuándo se repartió |
| `periodo_ref` | DATE NULL | mes de ganancia al que corresponde (opcional, primer día) |
| `total` | NUMERIC(14,2) | total repartido |
| `cuenta_origen` | TEXT | de qué cuenta salió (default 'CAJA UTILIDADES') |
| `nota` | TEXT NULL | |
| `anulado` | BOOLEAN | |

### `utilidades_reparto_detalle`
| campo | tipo | nota |
|---|---|---|
| `id` | UUID PK | |
| `tenant_id` | | |
| `reparto_id` | UUID FK → utilidades_repartos (ON DELETE CASCADE) | |
| `socio_id` | UUID FK → utilidades_socios | |
| `monto` | NUMERIC(14,2) | lo que le tocó a este socio |
| `gasto_id` | TEXT NULL | el gasto/egreso `retiro_socio` generado (para reversar) |

### CAJA UTILIDADES
NO es una tabla nueva: es una **cuenta** más en `saldos_caja` + `movimientos` (el cashflow ya la reconoce en `fn_cashflow_cat_efectivo` y `cashflow_resumen_mes` como "Reservado"). Se crea por local on-demand (al primer reservar) insertando la fila en `saldos_caja`.

---

## 4. Acciones (RPCs atómicas — C1/C9/C11)

### 4.1 Gestionar socios
`utilidades_guardar_socio(p_local, p_id, p_nombre, p_porcentaje, p_activo)` — upsert. Devuelve la suma de % activos del local para que la UI avise si ≠ 100 (no bloquea: una sociedad puede estar en transición).

### 4.2 Reservar
Mover plata de una cuenta operativa → CAJA UTILIDADES. **Reusa `transferencia_cuentas`** (RPC existente): es una transferencia interna, el cashflow la netea. Crea la cuenta CAJA UTILIDADES si no existe.

### 4.3 Registrar reparto
`utilidades_registrar_reparto(p_local, p_fecha, p_total, p_cuenta_origen, p_periodo_ref, p_detalle jsonb, p_idempotency_key)`:
- `p_detalle` = `[{socio_id, monto}]`. La UI lo arma dividiendo `p_total` por los % (o con ajustes). El backend valida que `Σ monto = p_total`.
- Por cada socio: crea un **gasto `tipo='retiro_socio'`** desde `p_cuenta_origen` (reusa el flujo de gastos → genera el movimiento; hitea la línea "Retiros de Socios" del **EERR** y la categoría `retiro_socio` del **cashflow**). Guarda `gasto_id` en el detalle.
- Inserta `utilidades_repartos` + `utilidades_reparto_detalle`.
- `cuenta_origen` default `'CAJA UTILIDADES'` (la disciplina), pero **permite cualquier cuenta** (efvo/MP/banco) — Lucas a veces reparte directo.
- Idempotency (C1).

### 4.4 Anular reparto
`utilidades_anular_reparto(p_reparto_id)` — anula los gastos generados (reusa `anular_gasto`) + marca el reparto anulado. Revierte la plata.

---

## 5. Calculador "cuánto es seguro repartir" (Capa 2)

`utilidades_cuanto_repartir(p_local, p_periodo_mes, p_meses_colchon int DEFAULT 1)` → read-only, devuelve jsonb:

```
Plata total del negocio       (efvo operativo + MP + banco + CAJA UTILIDADES) — TODA la plata es del
                               negocio hasta que se reparte; el reservado cuenta para repartir.
  − Obligaciones pendientes    (lo que falta pagar este mes de sueldos + gastos fijos —el alquiler es un
                               gasto fijo— = devengado del mes − ya pagado de esas categorías este mes)
  − Colchón extra              (p_meses_colchon × (gastos fijos + sueldos del mes), default 1 mes)
  = 🟢 Seguro repartir: $X      (si > 0; rojo si negativo)
```

Además, el resultado desglosa:
- **Reservado** (saldo actual de CAJA UTILIDADES) — cuánto del "seguro repartir" ya está apartado y listo.
- **Ya repartido este mes** (Σ `utilidades_repartos` del mes, no anulados) vs el seguro → **aviso de sobre-distribución** si ya repartiste más que el seguro (tu dolor de mayo).
- Reusa `cashflow_resumen_mes` para la plata líquida y la lógica devengada del puente (`cashflow_puente_mes`) para sueldos/fijos del mes.

> **Por qué "plata total" y no solo operativo:** el reservado en CAJA UTILIDADES es plata del negocio apartada *justo para repartir* — descontarla del repartible sería contarla dos veces. Lo que NO se puede repartir es el colchón + las obligaciones, no el reservado.

> **Obligaciones pendientes** refleja "depende del momento del mes": a principio de mes casi nada está pagado (poco seguro repartir); a fin de mes casi todo pagado (más seguro).

---

## 6. Pantalla

Nueva pantalla **Utilidades** bajo **DIRECCIÓN** (al lado de Cashflow):

- **Arriba:** el "**Seguro repartir $X**" en grande (verde/rojo) + saldo de **CAJA UTILIDADES** (reservado) + "ya repartido este mes".
- **Socios:** lista con nombre + % (editable), aviso si no suman 100%.
- **Acciones:** botón **Reservar** (mover $ a CAJA UTILIDADES) + botón **Registrar reparto** (modal: total → preview del split por socio, ajustable → confirmar).
- **Historial de repartos:** tabla (fecha, total, por socio, cuenta origen) con anular.
- Selector de mes + local (igual que el cashflow).

---

## 7. Integración con lo existente
- **CAJA UTILIDADES** ya está contemplada en el cashflow (`fn_cashflow_cat_efectivo`, `cashflow_resumen_mes`, `cashflow_libro_mes`) → aparece como "Reservado" sin tocar nada.
- **Reparto → gastos `retiro_socio`** → hitea la línea "Retiros de Socios" del EERR (que ya lee `gastos.tipo='retiro_socio'`) y la categoría `retiro_socio` del cashflow. Cero doble-conteo.
- **Reservar → `transferencia_cuentas`** → transferencia interna, el cashflow la netea (no es ingreso/egreso).
- El calculador **reusa** `cashflow_resumen_mes` (líquido) y la lógica devengada del puente (obligaciones).

---

## 8. Reglas del repo a cumplir
RPCs atómicas (C1 idempotency en las que mueven plata, C9 error codes UPPER_SNAKE, C11 auth en SECURITY DEFINER + REVOKE FROM PUBLIC,anon). `applyLocalScope` en queries con `local_id`. Tablas nuevas con checklist (RLS dual, columnas estándar). Lazy import en `App.tsx` (C8). Test E2E mutante + tocar e2e-full para el reparto (lógica de plata).

---

## 9. Riesgos / cosas a cuidar
- **Doble-conteo de retiros:** el reparto crea gastos `retiro_socio` — NO duplicar con los retiros que el usuario pudiera cargar a mano en Gastos. La pantalla de Gastos y la de Utilidades comparten la misma categoría; el reparto es la vía canónica.
- **CAJA UTILIDADES sin saldo:** si se reparte desde CAJA UTILIDADES sin haber reservado suficiente, el saldo queda negativo (igual que las otras cajas). El calculador avisa; no se bloquea (Lucas decide).
- **% que no suman 100:** se permite (sociedad en transición) pero se avisa. El reparto por override no exige 100%.
- **Migración de retiros históricos:** los retiros mal cargados como "Egreso Manual" (ej. "RETIRO SOCIOS JUANMA" de mayo) NO se migran automático — Lucas los re-registra desde Utilidades cuando quiera (tarea manual, no bloquea el MVP).

---

## 10. Criterio de éxito (MVP)
Para un local, el dueño: define sus socios + %, aparta plata en CAJA UTILIDADES, registra un reparto que se divide solo por los % y aparece prolijo en el cashflow/EERR, y ve un número claro de **"seguro repartir $X"** que lo frena antes de descapitalizarse — sin planilla de Excel.
