# TASK BATCH REPORT — 2026-04-26

Ejecutado autónomamente sin Lucas presente. Cada task = 1 commit.

| Task | Estado | SHA | Notas |
|---|---|---|---|
| TASK A — simplificar rrhh_ad_scope_all | ✅ HECHA | `61b7843` | Cleanup trivial post-Fase 0 |
| TASK B — encriptar write-path mp_credenciales | ✅ HECHA | `94a53a6` | Schema real distinto del plan; ajustada |
| TASK C — categorías ingreso vs egreso | ✅ HECHA | `650b7bb` | Bug era de cache, no de DB ni código |
| TASK D — filtro Conciliación MP | ✅ HECHA | `5b090d6` | Filtro nuevo `ES_VENTA` aplicado al list |
| TASK E — transferencia entre cuentas UI | ✅ HECHA | `e39bf9c` | RPC ya existía; solo UI |
| TASK F — cron MP automático | ⚠ PARCIAL | `d13ce14` | Solo `maxDuration`. Ver detalle abajo |

**Estado final tests:** 152/152 verde después de cada commit.

---

## Detalles por task

### TASK A — `61b7843`
- Migration `202604261850_simplificar_rrhh_ad_policy.sql`: drop+recreate de la policy sin cast `::text`. Validado con `pg_policies.qual` (ya no contiene `::text`).

### TASK B — `94a53a6`
- **Desviación importante del plan:** las columnas `user_id, alias, account_email, account_id` que la spec mencionaba **NO existen** en `mp_credenciales`. Schema real: `id, local_id, access_token, activo, ultima_sync, saldo_*, balance_at, saldo_inicial, saldo_inicial_at, por_acreditar, access_token_encrypted`.
- Migration ajustada al schema real:
  - Agrega `access_token_last8 text` (UX para mostrar últimos 8 chars sin desencriptar el token).
  - Backfill desde la columna plana existente. Single fila id=3 → last8=`73828709`.
  - RPC `set_mp_token(p_local_id int, p_access_token text)` con auth gate `auth_es_dueno_o_admin()`, encripta + escribe a las 3 columnas (plain + encrypted + last8) + activo=true.
- `ConciliacionMP.tsx`:
  - SELECT explícito en lugar de wildcard, sin traer `access_token` plano.
  - `guardarCredencial` ahora llama a la RPC con manejo de error vía toast.
  - Display: `c.access_token_last8` con fallback `••••••••`.
- La columna plana sigue siendo escrita (safety net por si hay que revertir). Se puede dropear en una migration futura cuando todo esté estable.

### TASK C — `650b7bb`
- **Diagnóstico:** DB y código estaban correctos. Las 11 categorías `cat_ingreso` son sólo Liquidaciones + Ingreso Socio + Devolución Proveedor + Otro Ingreso + Transferencia Varios. SUPERMERCADO/HIELO están en `cat_compra` y `gasto_variable`, nunca en ingreso. El componente Caja.tsx hacía bien el ternario `form.esEgreso ? catsEgreso : catsIngreso`.
- **Causa raíz más probable:** sessionStorage cache stale. Si un usuario tenía sesión vieja con cache previo a un fix de DB, vería lista mala hasta que el cache TTL (1h) expire.
- **Fix mínimo:** bumpé el cache key de `pase_categorias_v1` a `v2`. Invalida los caches de todos los usuarios; próximo load fetcha de DB.

### TASK D — `5b090d6`
- **Diagnóstico tipos en `mp_movimientos`:** 124 `liquidacion`, 69 `bank_transfer`, 8 `payment`, 8 `point`, 3 `payment_out`, 1 `refund`. Los 16 `payment+point` son los "ruidos" a esconder de la conciliación.
- **Fix:** agregué helper `ES_VENTA(t) = t==="point"||t==="payment"` y lo apliqué al filter del list principal (3 ocurrencias: count del panel-title, empty check, render de tbody). Mantuve los counters de KPIs (ingresos/egresos totales, ventasPresenciales, ventasOnline) intactos para no cambiar las métricas agregadas — la spec sólo pidió esconderlos del listado.

### TASK E — `e39bf9c`
- **RPC existente:** `transferencia_cuentas(p_local_id int, p_cuenta_origen text, p_cuenta_destino text, p_monto numeric, p_fecha date, p_detalle text)` returns `jsonb`. Solo UI.
- Botón "↔ Transferir" agregado al header de Tesorería junto al "+ Movimiento", deshabilitado si el usuario tiene <2 cuentas visibles.
- Modal con: origen, destino (filtra para no incluir origen), monto, fecha, detalle opcional, selector de local cuando aplica.
- Validaciones cliente + manejo de error con `translateRpcError`.
- Estilo idéntico al modal Nuevo Movimiento.

### TASK F — `d13ce14` ⚠ PARCIAL
- **Diagnóstico:** `vercel.json` tiene el cron configurado correctamente (`/api/mp-sync` a las 6 UTC = 3 ART). El código de `mp-sync.js` no tiene auth check. **Pero la causa raíz más probable es timeout:** la función hace `await sleep(90000)` (90s) en el flow de release_report. Vercel Hobby tiene timeout default de 60s en crons, así que el sleep solo ya excede.
- **Fix aplicado:** declaré `maxDuration` explícito en `vercel.json` para los 3 endpoints MP:
  - `mp-sync.js`: 300s (cubre sleep + procesamiento)
  - `mp-generate.js`: 30s (POST inicial)
  - `mp-process.js`: 60s (descarga CSV + procesa)
- **NO aplicado del plan original:**
  - **Auth check con `CRON_SECRET`**: rompería el manual sync de la UI (los `fetch("/api/mp-*")` desde `ConciliacionMP.tsx` no envían `Authorization` header) y requería env var en Vercel que la spec dijo no pushear sin OK.
- **⚠ ACCIÓN PENDIENTE PARA LUCAS:**
  1. **Verificar el plan de Vercel.** `maxDuration > 60s` requiere **Vercel Pro**. En Hobby, Vercel ignora el override y mantiene el cap de 60s — y el cron va a seguir fallando.
  2. Si seguís en Hobby, hay 2 caminos posibles (en task futura):
     - **a)** Upgrade a Pro.
     - **b)** Refactorear `mp-sync.js` para que delegue a `mp-generate` + `mp-process` en dos crons separados con un gap de 2 minutos, y eliminar el `sleep(90000)`. Eso permite quedarse en Hobby.
  3. Validar logs del próximo cron (mañana 3am ART) en el dashboard de Vercel para confirmar si el `maxDuration` ayuda.

---

## Smoke tests manuales pendientes para Lucas

1. **TASK B — Conciliación MP / Configurar credenciales:**
   - Abrir Conciliación MP → ⚙ Configurar.
   - Agregar/editar una credencial. El display debe mostrar los últimos 8 chars (no `undefined` ni nada raro).
   - El cron y el manual sync deben seguir funcionando con el token nuevo (la columna plana sigue escrita como safety net).

2. **TASK C — Tesorería / Nuevo Movimiento → Ingreso:**
   - El dropdown de Categoría debe mostrar **sólo** las 11 categorías de ingreso (Liquidación X, Ingreso Socio, etc.). Si seguís viendo Supermercado/Hielo, **forzá `Ctrl+Shift+Del` → borrar sessionStorage** o esperá 1h a que el TTL expire.

3. **TASK D — Conciliación MP / list:**
   - El list de movimientos NO debe mostrar más "Venta Presencial" ni "Cobro Online" (eran 16 filas, las que aparecían molestando).
   - Las KPIs de "Ventas presenciales" y "Ventas online" siguen mostrando los totales (intencional).

4. **TASK E — Tesorería / Transferir:**
   - Botón "↔ Transferir" en el header.
   - Click → modal → elegir origen y destino (distintas), monto, fecha → Transferir.
   - Debe generar 2 movimientos (egreso + ingreso) y refrescar la lista.

5. **TASK F — Cron MP:**
   - Validar mañana 3am ART en Vercel dashboard si el cron logró completar (depende del plan de Vercel — ver detalles arriba).

---

## Estado final
- Tests: **152/152 verde** después de cada commit.
- Build de Vite: OK.
- 6 commits creados, todos pusheados al final del batch en una sola operación.
