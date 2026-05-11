# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Trabajando con Lucas

- **Lucas dirige a Claude para escribir código, no escribe código a mano.** Antes de cambios no triviales, explicar el plan en español simple (sin jerga developer) y esperar confirmación. Cambios chicos y obvios: hacer y avisar después.
- **Comunicación en español, en simple.** Al introducir un concepto técnico nuevo (hook, RLS, monorepo, RPC, etc.) explicarlo brevemente la primera vez.
- **Estado real del producto**: PASE está en producción y en uso real (back-office gastronómico). COMANDA está en desarrollo (POS frontline, no operando con clientes finales aún). La DB Supabase es compartida entre ambos — un cambio mal hecho en COMANDA puede afectar a PASE.
- **Sin restricciones formales**: Lucas NO designó módulos prohibidos ni flujos críticos que no se puedan romper. Tampoco hay flujos "sacrosantos". Igualmente, las RPCs atómicas, RLS y migraciones ya aplicadas son zonas donde un error es difícil de revertir — explicar antes de tocar es el default sano.
- **Operaciones irreversibles**: para `force-push`, reset de migración ya aplicada, `DROP TABLE`, borrado masivo de archivos o equivalentes, confirmar en chat aunque el flag `--dangerously-skip-permissions` permita ejecutar sin prompt. La conveniencia del flag no aplica acá.
- **Comando de inicio típico de Lucas**: `cd C:\Users\lucas\Documents\PASE ; claude --dangerously-skip-permissions`.
- **Regla: toda feature nueva o cambio de lógica de plata viene con test E2E mutante** (acordado 2026-05-09). Patrón establecido en `packages/pase/tests/*_mutante.spec.ts` (ventas_efectivo, gastos, facturas_cargar, facturas_pagar, etc.). Setup: usar `Local Prueba 2` + `Proveedor Prueba` + `createDuenoClient` helper + sentinel numérico distintivo. Asserts DB-only estrictas (`toBe`). Cleanup en `afterEach` con cada paso en su propio try/catch. Pre-checks de prerequisitos con mensaje accionable si falta seed. La regla es más estricta ahora que el producto está en desarrollo activo: bugs introducidos en esta etapa son más peligrosos que en un sistema estable. Si una feature no tiene test mutante, plantearle a Lucas si vale skipearlo o no antes de hacer merge.

## Workflow

- **Push directo a `main`**: no se usan branches ni PRs. Commit + push y Vercel auto-deploya `packages/pase`.
- **Único entorno productivo**: no hay staging. La DB Supabase (`pduxydviqiaxfqnshhdc`) es compartida por PASE y COMANDA, sin entorno separado de desarrollo.
- **Documentación profunda**: `packages/pase/CONTEXTO.md` es la fuente de verdad para arquitectura, decisiones, taxonomía de movimientos, RPCs, RLS y troubleshooting. Leerlo antes de tocar lógica de negocio. Este archivo es solo el índice de orientación rápida.

## Monorepo

pnpm workspaces + Turborepo. Tres paquetes:

| Paquete | Estado | Descripción |
|---|---|---|
| `packages/pase` | Producción | App principal de gestión gastronómica. React 19 + Vite + Supabase. Deploy en `pase-yndx.vercel.app`. |
| `packages/comanda` | WIP | POS/KDS/menú QR. Stack idéntico, comparte la DB Supabase con PASE. Tailwind + Radix. Deploy Vercel separado. |
| `packages/shared` | Scaffold | `@pase/shared`. Aún vacío; la extracción real desde `packages/pase/src/lib/` se hace en sprint dedicado. |

Node ≥ 20, pnpm 9 (fijado en `package.json#packageManager`).

## Comandos

Desde la raíz:

```bash
pnpm install                          # instala los 3 paquetes y crea symlinks
pnpm dev                              # turbo dev — arranca todos los dev servers en paralelo
pnpm build                            # alias de pnpm --filter pase build (build de prod)
pnpm build:all                        # turbo run build — todos los paquetes
pnpm test                             # turbo run test — vitest unit en pase + comanda
pnpm lint                             # turbo run lint
pnpm test:e2e                         # playwright (solo PASE)
```

Por paquete (preferir cuando tocás un solo paquete):

```bash
pnpm --filter pase dev                # http://localhost:5173
pnpm --filter pase test               # vitest run
pnpm --filter pase test:watch         # vitest interactivo
pnpm --filter pase typecheck          # tsc --noEmit
pnpm --filter pase test -- src/lib/foo.test.ts   # un solo test file
pnpm --filter pase test -- -t "nombre del it"     # un solo it()

pnpm --filter comanda dev             # http://localhost:5174
pnpm --filter comanda test
# Coverage en COMANDA: usar el binario directo (turbo intercepta el flag):
node_modules/.bin/vitest run --coverage --root packages/comanda
```

CI corre `turbo run test typecheck lint --filter='...[HEAD^1]'` en cada PR/push a main — sólo paquetes afectados. Lint es bloqueante (cleanup completo en PR8: 0 errors / 0 warnings).

## Arquitectura — lo que conviene saber antes de editar

### Stack y entorno
- **Frontend**: React 19, TypeScript estricto (`strict: true`, `noUncheckedIndexedAccess: true`), Vite 8, vitest 4. Sin Redux ni React Query — estado local + fetches directos en components.
- **Backend lógico**: vive en Supabase (Postgres + Auth + Storage + RLS). Casi toda mutación pasa por **RPCs Postgres atómicas**, no por inserts crudos desde el cliente.
- **Endpoints serverless** (`packages/pase/api/`): Vercel Functions para crons MP, lector IA (`/api/claude` proxy a Anthropic), telegram webhook, auth-admin. Usan `SUPABASE_SERVICE_KEY` (bypassa RLS — filtrar `local_id`/usuario manualmente).
- **TZ**: `timestamptz` siempre en DB. Conversión a Argentina (UTC-3) sólo en display vía `toBuenosAires`, `fmt_dt_ar`, `fmt_t_ar` de `src/lib/utils.ts`. Nunca `.toISOString()` sobre fecha local sin TZ.

### Aislamiento por sucursal (multi-local) — tres capas alineadas
Bug histórico #27: si una capa cae, hay leak entre sucursales aunque el código se vea correcto.

1. **Datos**: tabla `usuario_locales` mapea encargado → locales asignados.
2. **Backend**: RLS Postgres con `auth_locales_visibles()` (SECURITY DEFINER) en cada tabla con `local_id`.
3. **UX**: `SeleccionarLocalModal` bloquea navegación si encargado tiene >1 local hasta que `localActivo != null`. Encargados nunca operan con `localActivo=null`.

En el frontend, **toda query a tabla con `local_id` debe usar `applyLocalScope(q, user, localActivo)`** de `src/lib/auth.ts`. Es defense-in-depth — RLS lo cubre en backend pero el patrón debe estar.

### Multi-tenant
Migración 202604281200+ introdujo `tenant_id` en todas las tablas + RLS dual. Tenant Neko es el productivo. Hay scaffolding superadmin (`Tenants.tsx`, `OnboardingTenant.tsx`) y RPC `crear_tenant` / `restore_tenant`. Override via `pase_tenant_override` en `localStorage`.

### Auth
- **Supabase Auth es el único sistema** desde commit `3805ea7` (el fallback SHA-256 fue eliminado).
- Email para Auth: `usuarios.email`; si no contiene `@`, se concatena `@pase.local`.
- Roles: `dueno` / `admin` (acceso casi total) / `encargado` (restringido por local + cuentas visibles).
- Permisos por módulo en `usuario_permisos`, cuentas visibles en `usuarios.cuentas_visibles TEXT[]` (NULL = todas).
- `usuarios.password_temporal=true` activa `ForcePasswordChange.tsx` — bloquea navegación hasta cambiar.

### RPCs atómicas (operaciones que mueven plata)
Todo flujo que toca múltiples tablas (movimientos + saldos_caja + facturas/remitos/gastos + rrhh_*) pasa por una RPC Postgres en transacción única. **No hacer inserts/updates sueltos desde el cliente** para estos casos — generaba estados inconsistentes pre-batch α.

Las 13 RPCs principales (`pagar_factura`, `pagar_remito`, `anular_factura`, `pagar_sueldo`, `registrar_adelanto`, `pagar_vacaciones`, `pagar_aguinaldo`, `liquidacion_final_empleado`, `crear_movimiento_caja`, `anular_movimiento`, `crear_gasto`, `transferencia_cuentas`, etc.) — listado completo en `packages/pase/CONTEXTO.md` sección "Pagos atómicos (RPC)". Errores por código upper-snake (`FACTURA_YA_PAGADA`, `SALDO_INSUFICIENTE`, etc.) traducidos por `src/lib/errors.ts::translateRpcError`.

### EERR vs Cashflow — distinción conceptual
- **EERR** = base devengada. Lee `ventas`, `facturas`, `gastos`, `rrhh_liquidaciones` por fecha del hecho económico.
- **Cashflow** = base percibida. Lee `movimientos` (anulado=false) + `saldos_caja`.
- No tienen que coincidir día a día. Las "Liquidación Rappi/MP/Peya/Bigbox/etc." son ingresos exclusivos de Cashflow — sumarlas al EERR sería contar dos veces (la venta ya se contó cuando se cargó).
- Sólo efectivo dispara movimiento automático al cargar venta. Resto se refleja en Cashflow cuando el usuario carga el ingreso de liquidación con la categoría correspondiente.

### Catálogos dinámicos
- **Categorías**: tabla `config_categorias` con `grupo` (CMV / Gastos Fijos / Variables / Publicidad / Comisiones / Impuestos / INGRESOS). Hook `useCategorias()` cachea en sessionStorage 1h, fallback a `constants.ts`.
- **Medios de cobro**: tabla `medios_cobro` reemplazó `MEDIOS_COBRO` hardcoded. Filas globales (`local_id IS NULL`) + override por local. Hook `useMediosCobro()`. Si Maxirest importa con un medio que no existe en el catálogo del local activo, **rechaza el batch entero** — no importa parcial para no desbalancear caja.

### Conciliación MP
- Sync vía cron-job.org cada 30 min: `mp-generate` (genera CSV en MP) → `mp-process` (descarga + procesa).
- Token MP encriptado en DB; lectura via RPC `set_mp_token` / endpoint con auth.
- Saldo inicial fijado: $1.843.593 el 11/04/2026.
- Prefijos en `mp_movimientos.id`: `rr-*` = release_report (autoritativo), sin prefijo = payments API.
- CSV release_report: MP entrega fechas Argentina-local **sin** marcador TZ; el código detecta y anexa `-03:00` antes del parse.

### Lector de Facturas IA
Pipeline: subir factura → `/api/claude` (proxy a `claude-opus-4-7` con `ANTHROPIC_API_KEY`) → JSON → 3 capas de defensa (threshold magnitud >$10M, coherencia items vs neto, coherencia desglose vs total) → preview con campos editables coloreados por confianza → human-in-the-loop confirma. **NO pre-procesar imagen browser-side** — Otsu/cam-scanner empeoró precisión (smoke test bug #41: 92% original vs 55% procesada). Si Opus falla en facturas escaneadas malas, evaluar Google Document AI como fallback, no procesamiento browser.

## Migraciones SQL (flow oficial)

NO existe endpoint HTTP para correr migrations. NO hay `api/admin-run-sql.js` (fue eliminado en `ce11694` / `e9284d4` — el patrón de auth-by-header expone secrets innecesariamente).

Procedimiento:

1. Commit del SQL en `packages/pase/supabase/migrations/YYYYMMDDHHMM_descripcion.sql`.
2. `npx vercel env pull .env.local.tmp --environment=production` para bajar `POSTGRES_URL_NON_POOLING`.
3. Script Node one-off (instalar `pg --no-save` si hace falta) que lee la URL del archivo, ejecuta el SQL en transacción, corre verificaciones.
4. Limpieza: borrar `.env.local.tmp` y el script.

**Pre-requisito**: la env var `POSTGRES_URL_NON_POOLING` en Vercel **no debe estar marcada Sensitive** — si lo está, `vercel env pull` baja `""`. Pedir al dueño que destilde.

## Agregar tabla nueva — checklist obligatorio

Si no se hace, RLS bloquea todo desde el frontend (default deny).

**A) Tabla con `local_id`**: `ENABLE ROW LEVEL SECURITY` + policy `FOR ALL TO authenticated` con `USING/WITH CHECK = auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()) OR local_id IS NULL`.

**B) Master data global**: SELECT abierto a `authenticated`, escritura via `auth_es_dueno_o_admin()` (o `auth_tiene_permiso('<slug>')` si querés control granular por módulo).

**C) Tabla hija**: policy con `EXISTS (SELECT 1 FROM padre p WHERE p.id = hija.padre_id AND auth_locales_visibles())`.

**D) Frontend**: `applyLocalScope(q, user, localActivo)` en toda query a la nueva tabla con `local_id`.

**E) Endpoints `api/`**: usar `SUPABASE_SERVICE_KEY` y filtrar manualmente — bypassa RLS.

**F) Fechas**: `timestamptz`, nunca `timestamp` sin zona.

Plantillas SQL exactas en `packages/pase/CONTEXTO.md` sección "Cómo agregar una tabla nueva".

## Convenciones del repo

- `local_id` y `usuario_id` son `INTEGER`, no UUID (legado pre-multi-tenant).
- Anon key fuera del código — `VITE_SUPABASE_ANON_KEY`. Procedimiento de rotación en `ROTATE_ANON_KEY.md`.
- Cache de permisos en `sessionStorage` (`pase_user`); botón "Actualizar permisos ↻" en sidebar refresca sin logout. RLS server-side siempre lee fresh — el cache stale es UX, no security bypass.
- Errores RPC: `RAISE EXCEPTION 'CODIGO_UPPER_SNAKE'` → `translateRpcError` mapea a español; código no mapeado se muestra raw (fallback transparente).
- Caja Efectivo es ahora una `cuenta` más en `saldos_caja` + `movimientos` (la tabla privada `caja_efectivo` fue eliminada el 2026-05-02).
- El módulo Empleados viejo está deprecado — RRHH es el reemplazo. La tabla legacy `empleados` se eliminó en 202604261810.
- **Vercel plan Hobby — límite de 12 serverless functions**. Antes de agregar un archivo en `packages/pase/api/` contar `ls packages/pase/api/*.js | grep -v "^_" | grep -v "\.test\.js$" | wc -l`. Si llega a 12, no se puede sumar otra sin eliminar legacy o renombrar con prefix `_` (los archivos `_*.js` son helpers privados, no endpoints HTTP). Síntoma de exceso: build pasa OK pero el deploy queda en `state=ERROR` justo después de "Deploying outputs..." (incidente 2026-05-11 con `crear-tenant.js` como function #13). Después de cada push siempre verificar `state=READY` antes de asumir que prod tomó el cambio.

## Convenciones para features nuevas (Capa 1)

Reglas que aplican a **cada feature nueva** desde 2026-05-10 (plan `quiero-mejorar-la-seguridad-sunny-creek`). Algunas se chequean automáticamente, otras requieren juicio humano en `/pre-deploy`. **Si una feature no las cumple, plantearle a Lucas si vale skipearlas o no antes de mergear.**

### Automatizables (ESLint o checklist)

- **C1 — Idempotency en RPCs financieras.** Toda RPC nueva que mueve plata acepta `p_idempotency_key text` opcional + tabla `idempotency_keys` con `UNIQUE(rpc_name, key)`. Previene doble click. Distribuido en F8 para las 4 RPCs existentes (`pagar_factura`, `pagar_remito`, `pagar_sueldo`, `crear_gasto`).
- **C2 — Test E2E mutante obligatorio.** Acordado 2026-05-09. Patrón en `packages/pase/tests/*_mutante.spec.ts`. `/test-mutante <flujo>` ayuda con el plan.
- **C3 — `applyLocalScope` obligatorio.** Toda query nueva sobre tabla con `local_id` usa `applyLocalScope(q, user, localActivo)` de `src/lib/auth.ts`. Nice-to-have ESLint custom rule (no implementada todavía).
- **C4 — NO INSERT/UPDATE/UPSERT/DELETE directo sobre tablas financieras.** Bloqueante con ESLint rule `pase-local/no-direct-financiera-write` en `packages/pase/eslint.config.js`. Tablas cubiertas: `movimientos`, `saldos_caja`, `gastos`, `ventas`, `facturas`, `factura_items`, `remitos`, `rrhh_liquidaciones`, `rrhh_adelantos`, `rrhh_pagos`, `mp_movimientos`. Usar RPC atómica. Excepciones: tests, scripts, audits. Deuda existente marcada con `// eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F{N}: ...` apuntando al F-item del plan.
- **C8 — Lazy imports en `App.tsx`.** Toda página nueva con `lazy(() => import(...))` + `<Suspense>`. Nice-to-have ESLint rule (no implementada todavía).

### Requieren juicio humano (checklist en `/pre-deploy`)

- **C5 — Filtro fecha default 90d.** Toda query de listado/dashboard sobre tabla con `fecha` lleva filtro por default. Performance al crecer histórico.
- **C6 — Debounce en filtros de texto.** Toda búsqueda/filtro usa `useDebouncedValue(input, 300)` antes de pegar a DB. Helper a crear en `src/lib/useDebouncedValue.ts`.
- **C7 — Tabla nueva con columnas estándar.** `tenant_id`, `created_at`, `updated_at`, RLS dual. Plantilla en `/migrar`.
- **C9 — Error codes en UPPER_SNAKE_CASE.** Toda RPC nueva con `RAISE EXCEPTION 'CODIGO_UPPER_SNAKE'` mapeado en `src/lib/errors.ts::translateRpcError`.
- **C10 — Recovery si el browser muere a mitad.** Toda feature con plata define qué pasa si la conexión cae entre INSERT 1 y N. Idempotency + estado intermedio recuperable.
- **C11 — SECURITY DEFINER con auth check.** Toda RPC nueva con `SECURITY DEFINER` debe chequear auth en las primeras 5 líneas (`auth_tenant_id()`, `auth_es_dueno_o_admin()`, `auth_es_superadmin()`, o `GRANT EXECUTE` solo a `service_role`). Si no, el linter de Supabase la flagea correctamente.

### Falsos positivos conocidos del Supabase Database Linter

Verificados al 2026-05-10. NO requieren fix:

- `crear_movimiento_caja_bot` (migration `202605020900:107-113`): `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO service_role`. NO callable por anon. Solo Telegram webhook con SUPABASE_SERVICE_KEY puede invocarla.
- `set_mp_token` (migration `202604281206:908`): chequea `auth_es_dueno_o_admin()` y validación de tenant del local.
- `aplicar_nc_a_factura` (migration `202605140000:79-80`): chequea `auth_tenant_id()` + `FOR UPDATE` lock en NC y factura.
- `crear_tenant` (migration `202604281205:42`): chequea `auth_es_superadmin()`.

### Hallazgos reales del linter (en backlog)

- Tablas `canales_history`, `item_precios_canal_history`, `items_history` (creadas en `202605051200_comanda_sprint_1.sql`) sin RLS. Fix en una migration nueva habilitando `ENABLE ROW LEVEL SECURITY` + policy `tenant_id = auth_tenant_id()`. Capa 2b del plan.
- Leaked Password Protection desactivado en Supabase. Requiere SMTP configurado primero. Activar en Sprint A multi-tenant cuando se haga el setup de email.

## Documentación complementaria

- `packages/pase/CONTEXTO.md` — arquitectura completa, taxonomía, RPCs, RLS, troubleshooting.
- `DECISIONES_*.md` (raíz) — decisiones documentadas: TS strict, multi-tenant, facturas, borrado/cierre, backup.
- `MP_REFACTOR_DESIGN.md` — diseño Conciliación MP.
- `AUDITORIA_TECNICA_2026-05-07.md` — auditoría técnica reciente.
- `CHANGELOG_2026-05.md` — fixes y refactors recientes.
- `packages/comanda/TESTING.md`, `packages/comanda/DEPLOY.md`, `packages/comanda/DEUDA_TECNICA.md`.
- `C:/Users/lucas/.claude/plans/quiero-mejorar-la-seguridad-sunny-creek.md` — plan vigente de mejoras incrementales (3 capas).
