# MP Refactor — diseño de migración (TASK 0.11)

NO commiteado. Lectura y decisión antes de tocar código.

## 1. Flow actual (mapeado del código)

### Archivos
- `packages/pase/api/mp-generate.js` (paso 1 manual): POST a `/v1/account/release_report` para iniciar un CSV.
- `packages/pase/api/mp-process.js` (paso 3 manual): trae payments + descarga CSV + calcula saldo.
- `packages/pase/api/mp-sync.js` (cron diario 6 UTC): hace TODO en una pasada con `sleep(90s)` interno entre POST y GET.

### Endpoints HTTP que llaman al MP API hoy
| Endpoint | Propósito | Tiempo |
|---|---|---|
| `GET /v1/payments/search?begin_date=hace7d&end_date=ahora&sort=date_created&limit=200` | Trae cada cobro individual (ventas Rappi/Peya/Link, ventas Point) | Near-realtime |
| `GET /v1/account` o `GET /users/me` | Resolver `accountId` para `clasificarPago` | — |
| `PUT /v1/account/release_report/config` | Idempotente: garantiza que el reporte diario esté schedulado | — |
| `POST /v1/account/release_report` | Genera un CSV nuevo (asíncrono) | 1-3 min |
| `GET /v1/account/release_report/list` | Lista los CSVs disponibles | — |
| `GET /v1/account/release_report/<file_name>` | Descarga el CSV | — |

### Tablas tocadas

**`mp_credenciales`** (1 fila por local con cuenta MP):
- `id` int PK, `local_id` int FK, `activo` bool
- `access_token` text (legacy), `access_token_encrypted` bytea, `access_token_last8` text
- `ultima_sync` timestamp, `balance_at` timestamptz
- `saldo_disponible` numeric (CALCULADO por código), `saldo_pendiente` numeric, `saldo_no_disponible` numeric, `saldo_total` numeric, `por_acreditar` numeric
- `saldo_inicial` numeric (manual, set por Lucas), `saldo_inicial_at` timestamptz (corte temporal)

**`mp_movimientos`** (movimientos importados):
- `id` text PK, `local_id` int, `fecha` timestamptz, `tipo` text, `descripcion` text
- `monto` numeric (signo: + ingreso, − egreso), `saldo` numeric (neto histórico, opcional)
- `estado` text (`approved`, `pending`, `in_process`, etc), `referencia_id` text
- `medio_pago` text, `conciliado` bool, `vinculo_tipo`, `vinculo_id`, `conciliado_at`, `conciliado_por`

**`saldos_caja`**: una fila con `cuenta='MercadoPago'` que se actualiza con la suma de `saldo_disponible` de todas las credenciales.

### Cómo se calcula el saldo HOY

```
saldo_disponible_calculado = saldo_inicial_manual + SUM(monto de filas rr-* approved con fecha >= saldo_inicial_at)
```

- **Single source of truth: el saldo manual + la suma de movimientos rr-***.
- Las filas que NO empiezan con `rr-` (los pagos del payments-API) NO se suman al saldo. Eso es intencional — no se libera el saldo hasta el ciclo de release.
- Riesgo grave: si se pierde una fila rr-* o se duplica, el saldo queda descuadrado para siempre. No hay forma de detectar el descuadre porque MP no devuelve el saldo real al sistema.

### Tipos en `mp_movimientos.tipo` (qué inserta cada path)

| `tipo` | Origen | Prefix `id` | Direccion | ¿Aparece en list hoy (post-revert)? |
|---|---|---|---|---|
| `liquidacion` | release_report rr-* (NET_CREDIT > 0) | `rr-{src}` | Ingreso | ✓ |
| `bank_transfer` | release_report rr-* (NET_DEBIT > 0) | `rr-{src}` | Egreso | ✓ |
| `payment` | payments-API (cobro online no-Point) | `{pago.id}` | Ingreso | ✓ (no debería) |
| `point` | payments-API (cobro Point físico) | `{pago.id}` | Ingreso | ✓ (no debería) |
| `payment_out` | payments-API (egreso pagador) | `{pago.id}` | Egreso | ✓ |
| `bank_transfer_in` | payments-API (transferencia entrante) | `{pago.id}` | Ingreso | ✓ |
| `money_transfer` / `recurring` / `investment` / `recharge` / `withdrawal` | payments-API operation_type | `{pago.id}` | Egreso | ✓ |
| `fee` | payments-API (comisión MP) | `{pago.id}-fee` | Egreso | filtrado (ES_AUTOMATICO) |
| `refund` | payments-API (reembolso) | `{pago.id}-ref-{r.id}` | Egreso | ✓ |

**El flow actual mete TODO lo que devuelve `/v1/payments/search` en `mp_movimientos`.** Por eso al revertir el filter ES_VENTA, vuelven a aparecer las "Venta Presencial" y "Cobro Online" — son los `tipo='point'` y `tipo='payment'` que el payments-API trae sin filtrar. Esos NO son liquidaciones del saldo released, son cobros pendientes.

### Bug de Lucas — confirmado upstream

Las 8 liquidaciones de hoy ($116.620, $163.351, etc, entre 19:27 y 22:46) **no llegan al sync** porque:
- `release_report` solo trae filas `RECORD_TYPE='release'` cuando MP cierra el ciclo del día (~medianoche AR según `display_timezone='GMT-03'`).
- `payments-API` trae los cobros individuales que generaron cada liquidación (cada Rappi, cada Peya), pero NO la liquidación agrupada como una fila única con monto total.
- En la app de MP, Lucas ve la liquidación agrupada (porque MP la calcula on-the-fly). Pero la API no la expone hasta que se "settlea".

## 2. Endpoints alternativos investigados

### A) `/v1/account/settlement_report` (recomendado)
- **Mismo flow asíncrono que release_report** (PUT config + POST + GET list + GET file), pero con un schema CSV distinto.
- Campos del CSV (confirmados en docs MP):
  - `EXTERNAL_REFERENCE`, `SOURCE_ID`, `USER_ID`
  - `PAYMENT_METHOD_TYPE`, `PAYMENT_METHOD`, `SITE`
  - **`TRANSACTION_TYPE`** (clave: identifica explícitamente qué tipo de movimiento es)
  - `TRANSACTION_AMOUNT`, `TRANSACTION_CURRENCY`, **`TRANSACTION_DATE`** (cuando ocurrió la operación, near-realtime)
  - `FEE_AMOUNT`, `SETTLEMENT_NET_AMOUNT`, `SETTLEMENT_CURRENCY`, **`SETTLEMENT_DATE`** (cuando se liquidó al saldo released — puede ser futuro)
  - `REAL_AMOUNT`, `COUPON_AMOUNT`, `METADATA`
  - `MKP_FEE_AMOUNT`, `FINANCING_FEE_AMOUNT`, `SHIPPING_FEE_AMOUNT`, `TAXES_AMOUNT`
  - `INSTALLMENTS`, `ORDER_ID`, `SHIPPING_ID`, `SHIPMENT_MODE`, `PACK_ID`

- **Valores confirmados de `TRANSACTION_TYPE`:**
  | Valor | Significado | ¿Querer importar? | Mapeo a `tipo` |
  |---|---|---|---|
  | `SETTLEMENT` | Cobro aprobado (ingreso al saldo released) | ✓ | `liquidacion` |
  | `WITHDRAWAL` | Transferencia bancaria saliente | ✓ | `bank_transfer` |
  | `PAYOUT` | Retiro de efectivo | ✓ | `bank_transfer` |
  | `REFUND` | Reembolso (egreso) | ✓ | `refund` |
  | `CHARGEBACK` | Contracargo (egreso disputado) | ✓ | `chargeback` |
  | `DISPUTE` | Disputa abierta | opcional | `dispute` |
  | `WITHDRAWAL_CANCEL` | Transferencia cancelada (neutral) | ✗ ignorar | — |

- **Realtime claim:** `TRANSACTION_DATE` se popula apenas la operación ocurre. Pero **el reporte sigue siendo asíncrono** (POST → wait → GET). En la práctica MP genera el CSV en 1-3 minutos. Si las 8 liquidaciones de Lucas son SETTLEMENTs reales (no agrupaciones que recién aparecen al cierre de ciclo), deberían estar en un settlement_report generado a las 22:50. **Esto es lo crítico que hay que validar antes de migrar todo.**

### B) `GET /users/{userID}/mercadopago_account/balance` (recomendado para REQ 2)
- Endpoint REST, near-realtime (segundos).
- Headers: `Authorization: Bearer <token>`.
- Body de respuesta:
  ```json
  {
    "available_balance": 12345.67,
    "available_balance_by_transaction_type": [{ "transaction_type": "...", "amount": ... }, ...],
    "currency_id": "ARS",
    "total_amount": 23456.78,
    "unavailable_balance": 11111.11,
    "unavailable_balance_by_reason": [{ "reason": "...", "amount": ... }, ...],
    "user_id": <int>
  }
  ```
- `available_balance` = saldo released (lo que Lucas ve como "Disponible" en la app).
- `unavailable_balance` = saldo pendiente (cobros que aún no se liberaron).
- `total_amount` = available + unavailable.
- `userID` se obtiene de `/v1/account` o `/users/me` (ya está cacheado en el flow actual).

### C) `/mercadopago_account/movements/search` (descartado)
- Endpoint legacy, no documentado oficialmente por MP en sus SDKs modernos.
- Aparece en SDKs viejos con un TODO en filtros y paginación.
- **No usar**: riesgo alto de que MP lo deprecie sin aviso.

### D) Webhooks `payment.created` (descartado para esta task)
- Real-time real, pero requiere infra nueva (endpoint público, signature, retry, idempotencia).
- No expone webhook para `settlement` o `release` directamente.
- Camino válido a futuro pero out of scope acá.

## 3. Plan de migración propuesto

### Fase 1 — Diagnóstico de settlement_report (1 commit, sin riesgo)
**Objetivo:** confirmar que `settlement_report` trae las liquidaciones del día actual.

- Crear `packages/pase/api/mp-debug-settlement.js` (endpoint nuevo, manual, 1 cred):
  - PUT `/v1/account/settlement_report/config` para schedule.
  - POST `/v1/account/settlement_report` con begin_date=hace 1 día, end_date=ahora.
  - Espera 90s.
  - GET `/list`, descarga el CSV.
  - **No inserta en BD.** Devuelve en la respuesta JSON: número de filas, lista de TRANSACTION_TYPEs distintos, primeras 20 filas raw para inspección.
- Lucas dispara el endpoint (curl o botón temporal en UI).
- Mira el output: ¿están las 8 liquidaciones de hoy con TRANSACTION_TYPE=SETTLEMENT y TRANSACTION_DATE de hoy?
- **Si sí** → seguir a Fase 2.
- **Si no** → significa que ni el settlement_report las tiene en near-realtime. Plan alternativo: webhooks o esperar al cierre del día.

### Fase 2 — Schema (1 migration)
Migration `<TIMESTAMP>_mp_balance_api_columns.sql`:
```sql
ALTER TABLE mp_credenciales
  ADD COLUMN IF NOT EXISTS saldo_mp_actual numeric,
  ADD COLUMN IF NOT EXISTS saldo_mp_actual_at timestamptz,
  ADD COLUMN IF NOT EXISTS saldo_mp_total numeric,
  ADD COLUMN IF NOT EXISTS saldo_mp_unavailable numeric;
```
- Sin reemplazar `saldo_disponible` legacy (queda visible para comparación durante 1-2 semanas).
- Sin migrar data — los nuevos campos se llenan en el próximo sync.

### Fase 3 — Refactor del sync (3 commits)

**Commit A: agregar `mp-balance.js` (helper que pega a MP balance API)** ([api/_mp-balance.js])
```js
export async function fetchMpBalance(token, accountId) {
  const url = `https://api.mercadolibre.com/users/${accountId}/mercadopago_account/balance`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`MP balance ${res.status}`);
  return await res.json();  // { available_balance, total_amount, unavailable_balance, ... }
}
```
- Tests unitarios mockeando fetch.

**Commit B: reemplazar release_report por settlement_report en mp-generate + mp-process + mp-sync**
- `mp-generate.js`: cambiar URL a `/v1/account/settlement_report` (mismos params begin/end_date).
- `mp-process.js` parser CSV:
  - Header: leer índices de `TRANSACTION_TYPE`, `TRANSACTION_DATE`, `SETTLEMENT_DATE`, `TRANSACTION_AMOUNT`, `SETTLEMENT_NET_AMOUNT`, `SOURCE_ID`, `EXTERNAL_REFERENCE`, `PAYMENT_METHOD`.
  - Para cada fila:
    - Filtrar por TRANSACTION_TYPE in (`SETTLEMENT`, `WITHDRAWAL`, `PAYOUT`, `REFUND`, `CHARGEBACK`).
    - Mapear a `tipo`:
      - `SETTLEMENT` → `liquidacion`, `monto` = `+SETTLEMENT_NET_AMOUNT`.
      - `WITHDRAWAL` / `PAYOUT` → `bank_transfer`, `monto` = `-SETTLEMENT_NET_AMOUNT`.
      - `REFUND` → `refund`, `monto` = `-SETTLEMENT_NET_AMOUNT`.
      - `CHARGEBACK` → `chargeback`, `monto` = `-SETTLEMENT_NET_AMOUNT`.
    - `fecha` = SETTLEMENT_DATE si está, sino TRANSACTION_DATE.
    - `id` = `set-{SOURCE_ID}` (prefijo nuevo, distinto a `rr-`).
    - `referencia_id` = `EXTERNAL_REFERENCE || SOURCE_ID`.
- **REMOVER** completamente la sección "Payments API" del flow (`/v1/payments/search`). Las ventas que esa API traía (`tipo='payment'`, `tipo='point'`) ya no se importan.
- Mantener el `clasificarPago` viejo borrable o markarlo como deprecated.

**Commit C: agregar GET balance + UPDATE saldo_mp_actual en mp-process / mp-sync**
- Después del parse del CSV, llamar a `fetchMpBalance(token, accountId)`.
- UPDATE `mp_credenciales` con `saldo_mp_actual = available_balance`, `saldo_mp_total = total_amount`, `saldo_mp_unavailable = unavailable_balance`, `saldo_mp_actual_at = now()`.
- El cálculo del `saldo_disponible` legacy se mantiene durante la transición.

### Fase 4 — Dedup y data legacy

**Estrategia de dedup contra `rr-*` existentes:**
- Las nuevas filas son `set-{SOURCE_ID}`. Las viejas son `rr-{SOURCE_ID}` (mismo SOURCE_ID).
- En cada upsert de `set-*`:
  ```js
  // Buscar si existe rr- con el mismo SOURCE_ID antes de insertar
  const { data: rrTwin } = await db.from('mp_movimientos')
    .select('id').eq('id', `rr-${sourceId}`).maybeSingle();
  if (rrTwin) continue;  // skip — ya cubierto por release_report
  ```
- Después del upsert, hacer un sweep igual al actual: si hay `set-{X}` y `rr-{X}` simultáneos, borrar el `set-{X}` (rr- es la fuente autoritativa para datos cerrados).

**Data legacy de payments-API** (`tipo='payment'`, `tipo='point'`, etc, sin prefijo `rr-`/`set-`):
- **No borrar** (audit trail de qué se importó previamente).
- Cambiar el filter del list de Conciliación MP para mostrar SOLO filas con `tipo` en `('liquidacion','bank_transfer','refund','chargeback')`. Eso oculta la data legacy sin tocarla.
- En 1-2 meses, si Lucas confirma que la transición fue limpia, podemos hacer una migration que las marque como `archivado=true` o las mueva a una tabla histórica.

### Fase 5 — UI: card "Saldo MP (API)" vs "Saldo calculado (legacy)"

**`packages/pase/src/pages/ConciliacionMP.tsx`:**
- Header con 2 cards comparativas:
  - **Saldo MP (API)**: muestra `cred.saldo_mp_actual` con timestamp `saldo_mp_actual_at` formateado en AR. Color verde.
  - **Saldo calculado (legacy)**: muestra `cred.saldo_disponible`. Si difiere del API por más de $1, mostrar diferencia con badge amarillo o rojo.
- Filter del list: cambiar de `!ES_AUTOMATICO(m.tipo)` a `m.tipo IN ('liquidacion','bank_transfer','refund','chargeback')`.

### Fase 6 — Validación end-to-end

- Lucas dispara sync manual.
- Confirmar que aparecen las 8 liquidaciones (o las del día actual al momento del test).
- Confirmar que el "Saldo MP (API)" coincide con la app de MP en el celular.
- Tests vitest 152/152 verde.

## 4. Riesgos identificados

| Riesgo | Mitigación |
|---|---|
| settlement_report tampoco trae liquidaciones del día actual en near-realtime | Fase 1 lo valida antes de tocar nada. Si falla, escalamos a webhooks. |
| Cambio de schema CSV rompe el parser | Tests de parser con un CSV de muestra real. Errores caen al `catch` con log claro. |
| Doble counting durante la transición (filas rr-* viejas + filas set-* nuevas) | Skip explícito si existe `rr-{SOURCE_ID}` antes del upsert + sweep post-upsert (igual al actual). |
| Data legacy payments-API sigue contaminando filtros de saldo en otras pages | Auditar todas las queries que filtran `mp_movimientos` por tipo. Probable: solo Caja y EERR. Cambiar criterio donde aplique. |
| Si MP cambia el formato del settlement CSV en el futuro | Pasa también con release_report; mismo riesgo, mismo manejo (catch + log). |
| `saldo_mp_actual` viene de un endpoint distinto al CSV — pueden quedar desincronizados | Aceptado. La card de comparación lo hace visible. Si hay desfase >$1 sostenido por días, investigar. |

## 5. Rollback plan

- **Por commit:** cada commit es revertible individualmente.
- **Si Fase 3 rompe**: `git revert` del commit B + restaurar `mp-generate.js`/`mp-process.js`/`mp-sync.js` a la versión pre-refactor (sigue funcionando como antes con release_report). Las columnas nuevas en `mp_credenciales` quedan inertes — sin daño.
- **Si Fase 5 rompe el filter del list**: revert del commit de UI; el filter vuelve a `!ES_AUTOMATICO`. Vuelve la "data legacy" visible (mismo estado que post-revert de TASK 0.10).

## 6. Estimación de commits

1. `feat(mp): debug endpoint mp-debug-settlement para validar contenido del CSV` (Fase 1)
2. `feat(mp): migration mp_balance_api_columns + index` (Fase 2)
3. `feat(mp): helper fetchMpBalance` (Fase 3-A)
4. `refactor(mp): reemplazar release_report por settlement_report en sync/process/generate` (Fase 3-B)
5. `feat(mp): saldo desde API en cada sync (saldo_mp_actual)` (Fase 3-C)
6. `feat(conciliacion-mp): cards Saldo API vs Saldo calculado + filter del list por tipo released` (Fase 5)
7. `chore(mp): borrar mp-debug-settlement` (cleanup post validación)

Total: **6 commits productivos + 1 cleanup**.

## 7. Pregunta abierta para Lucas antes de empezar

**¿Avanzamos con Fase 1 (debug endpoint para validar settlement_report)?** Si sí, hago el commit del `mp-debug-settlement.js` y vos lo disparás (vía `/api/mp-debug-settlement` con un GET autenticado o con la sesión del browser logueado).

Si la respuesta confirma que las liquidaciones del día actual están en el CSV con TRANSACTION_TYPE=SETTLEMENT, vamos con todo el plan. Si no, pasamos a plan B (webhooks o aceptar el delay del día).

Sin tu OK explícito sobre Fase 1 no toco código.

---

**Sources** (investigación de doc MP):
- Settlement report endpoints: `https://www.mercadopago.com.co/developers/en/reference/settlements-report/download-report/get`, `https://omega.mercadopago.com.br/developers/en/reference/settlements-report/create-report/post`, `https://www.mercadopago.com.uy/developers/pt/reference/settlements-report/search-report/get`
- Account balance endpoint structure: `https://github.com/ezeql/go-mercadopago/blob/master/account_administration.go`
- TRANSACTION_TYPE values: docs MP "Report fields - Account balance" (varios países)
- Released money fields: `https://www.mercadopago.com.mx/developers/en/docs/subscriptions/additional-content/reports/released-money/report-fields`
