---
description: Check completa antes de pushear (typecheck + lint + build + e2e + convenciones)
---

# Pre-deploy

Corré la check completa antes de pushear a `main`. PASE deploya automáticamente a Vercel desde `main`, así que cualquier cosa rota llega a producción.

## Pasos automáticos

Ejecutá los 4 pasos en orden. Si alguno falla, **frená y mostrame el error** — no sigas con los siguientes.

```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e
```

Cada paso individualmente si necesitás iterar:

1. `pnpm typecheck` — `tsc --noEmit` en pase y comanda. Tipos rotos = bug futuro garantizado.
2. `pnpm lint` — eslint bloqueante. Incluye la regla `pase-local/no-direct-financiera-write` (C4) que bloquea INSERT/UPDATE/UPSERT/DELETE directo sobre tablas financieras (`movimientos`, `saldos_caja`, `gastos`, `ventas`, `facturas`, `factura_items`, `remitos`, `rrhh_liquidaciones`, `rrhh_adelantos`, `rrhh_pagos`, `mp_movimientos`). Si C4 falla en código nuevo, el cambio debe ir por RPC atómica, no inserts directos.
3. `pnpm build` — `vite build` de producción. Falla acá típicamente significa import paths rotos o env vars faltantes que TS no atrapó.
4. `pnpm test:e2e` — smoke (paralelo) + mutante (serial). ~3 min total contra prod. Cero leftovers tolerados.

## Checklist humano de convenciones (Capa 1 — juicio caso por caso)

Repasá estos puntos para CADA feature que vayas a pushear. Si alguno no aplica, OK; si aplica y falta, plantear a Lucas antes de mergear.

### Si la feature toca lógica de plata o crea/modifica una RPC financiera:

- **C1 — Idempotency**. ¿La RPC nueva tiene `p_idempotency_key text` opcional con UNIQUE en `idempotency_keys`? Si no, doble click duplica el efecto.
- **C2 — Test mutante**. ¿Existe `*_mutante.spec.ts` para el flujo? Regla del repo (2026-05-09). Usar `/test-mutante <flujo>` si todavía no está.
- **C9 — Error code UPPER_SNAKE**. ¿Los `RAISE EXCEPTION` están en formato `CODIGO_UPPER_SNAKE` y mapeados en `src/lib/errors.ts::translateRpcError`?
- **C10 — Recovery si muere el browser a mitad**. Si el flow tiene varios pasos client-side, ¿qué pasa si la conexión cae entre INSERT 1 y N? Si requiere idempotency + estado intermedio, va con C1.

### Si la feature toca queries de listado o dashboard:

- **C5 — Filtro fecha default 90d**. ¿Las queries de listado tienen `.gte("fecha", ...)` por default? Sin esto, la pantalla se vuelve más lenta cuando crece el histórico.
- **C6 — Debounce en filtros texto**. ¿Los inputs de búsqueda usan `useDebouncedValue(input, 300)` antes de pegar a DB? Sin esto, cada tecla = una query.

### Si la feature agrega tabla nueva en SQL:

- **C7 — Columnas estándar + RLS dual**. ¿La tabla tiene `tenant_id`, `created_at`, `updated_at`, RLS habilitada con policy de tenant + (si aplica) local? Sin esto, queda fuera del aislamiento multi-tenant.
- **C11 — SECURITY DEFINER con auth check**. Si la migration crea una RPC `SECURITY DEFINER`, ¿chequea auth en las primeras 5 líneas (`auth_tenant_id()` / `auth_es_dueno_o_admin()` / `auth_es_superadmin()`) o el GRANT está limitado a `service_role`? Sin esto, el linter de Supabase la flagea correctamente y hay riesgo de escalada.

### Si la feature agrega página nueva al sidebar:

- **C8 — Lazy import en `App.tsx`**. ¿El import es `lazy(() => import(...))` con `<Suspense>`? Sin esto, el bundle crece sin control.

## Salida esperada

- **Todo verde (auto + checklist)**: respondé "OK para deploy" y mencioná tiempos totales + qué convenciones aplicaron.
- **Auto falla**: mostrame el output del paso roto (las últimas 50-80 líneas relevantes), no sigas con los próximos pasos. Sugerime hipótesis si está claro qué se rompió.
- **Checklist falla**: nombrá las convenciones que faltan y proponé cómo cumplirlas (ej. "C1 falta — agrego `p_idempotency_key` a la RPC nueva antes de pushear").

## No hagas

- No sugieras `--no-verify` ni `--skip` ni saltearte un paso.
- No corras `git push` sin que yo lo pida explícitamente.
- Si los e2e fallan por leftover en DB de un test anterior, mostrame el diagnóstico antes de proponer cleanup manual.
- No marques OK una convención sin verificar — si dudás, preguntá. Las convenciones existen porque cada una previno un bug concreto en el pasado.
