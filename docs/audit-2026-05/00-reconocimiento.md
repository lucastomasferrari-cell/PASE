# Fase 0 — Reconocimiento del monorepo

**Estado:** ✅ Completa
**Fecha:** 2026-05-26
**Método:** 3 agentes Explore en paralelo + métricas vía Bash

## 1. Resumen ejecutivo

El monorepo PASE tiene **4 paquetes activos** + 2 legacy/experimental. Total de
código analizado: **~85.000 LOC** distribuidas en ~950 archivos.

| Paquete | LOC | Archivos | Estado real |
|---|---|---|---|
| `pase` | 22.852 (src/ = 41.786 contando todo) | 573 | **Producción** — back-office activo |
| `comanda` | 55.304 | 338 | **WIP** — POS, no opera con clientes finales aún |
| `instagram-bot` | 1.921 | 13 | Producción — bot IG/WA de Neko |
| `admin-console` | 4.075 | 28 | Producción — superadmin standalone |
| `shared` | scaffold vacío | — | sin uso |
| `print-agent` / `print-server` | legacy experimental | — | sin uso |

**Migrations SQL:** 287 archivos
**RPCs Postgres:** ~186 funciones
**Tablas DB principales:** 35+

## 2. Hallazgo más llamativo

**COMANDA (WIP) tiene 2.4× más código que PASE (producción).** Es señal a
investigar en Fase 7 (deuda/overengineering): ¿hay duplicación PASE↔COMANDA?
¿el sync engine offline-first está sobre-construido para el caso de uso?

## 3. Mapa de PASE (`packages/pase`)

### Páginas core (70+)

**Operación:**
- `Caja.tsx` (1075) — Movimientos + saldos
- `Compras.tsx` (1204) — Facturas + remitos
- `Ventas.tsx` (529) — Listado/anular ventas
- `Gastos.tsx` (1009) — Gastos fijos/variables/adelantos

**Finanzas/Reportes:**
- `EERR.tsx` (601) — Estado de Resultados
- `Negocio.tsx`, `Finanzas.tsx`, `Cierre.tsx`
- `ConciliacionMP.tsx` (**1666 LOC** — el más grande del repo)
- `ConciliacionBancaria.tsx` (529)

**RRHH:**
- `RRHH.tsx` (1075) — Dashboard empleados
- `RRHHLegajo.tsx` (1253) — Detalle empleado

**Admin/Sistema:**
- `Usuarios.tsx` (773), `RolesPermisos.tsx`, `Tenants.tsx`
- `Ajustes.tsx` (665), `Config.tsx`, `Solicitudes.tsx`
- `Onboarding.tsx`, `AprobarSolicitud.tsx`, `ConfiguracionNotificaciones.tsx`

**Herramientas:**
- `LectorFacturasIA.tsx` (558) — OCR + Claude
- `LectorExtractoMP.tsx` (541) — Parser CSV MP
- `Importar.tsx` (638), `ImportarMaxirest.tsx`
- `MensajeriaIG.tsx` (586), `CodigosManager.tsx`

**Subdirectorios con tabs/modales:**
- `compras/` — 9 modales (cargar/pagar/vincular facturas y remitos)
- `rrhh/` — 7 tabs/modales
- `rentabilidad/` — 5 tabs (Stock, CMV, Compras sugeridas, Alertas, Simulador)
- `caja/`, `herramientas/`, `mensajeria/`

### Hooks (9 reusables)
`useBandejaEntrada`, `useCategorias`, `useDebouncedValue`, `useGuardedHandler`,
`useLocalContextoUI`, `useMediosCobro`, `usePuestosRRHH`, `useRealtimeTable`,
`useTenantFeatures`

### Helpers clave (`src/lib/`)
- `auth.ts` — `auth_tenant_id()`, `auth_locales_visibles()`, `applyLocalScope()`
- `errors.ts` — traductor RPC errors → español
- `format.ts`, `utils.ts` — formato moneda/fecha
- `mpExtractoParser.ts` — parser CSV MP
- `onboardingTours.ts` (528 LOC) — Shepherd.js tours
- `push.ts` — Web Push
- `supabase.ts`, `constants.ts`, `features.ts`

### Endpoints serverless (12 activos)
- `mp-process.js`, `mp-generate.js`, `mp-sync.js`, `mp-update-pending-releases.js` — MP crons
- `backup-cleanup.js`, `backup-tenants.js` — backups
- `claude.js` — proxy IA
- `crear-tenant.js`, `auth-admin.js`, `auth-change-password.js`
- `afip-cae.js`, `tienda-mp.js`

**Helpers privados (`_*.js`):** `_cors`, `_cron-auth`, `_email`, `_mp-csv`,
`_mp-payments-search`, `_mp-token`, `_rappi`, `_pedidosya`, `_soporte-prompt`,
`_gastro-sensei-prompt`, `_user-auth`

## 4. Mapa de COMANDA (`packages/comanda`)

### Páginas (90+ — más grande que PASE)

**POS core (lo más jugoso):**
- `Pos/VentaScreen.tsx` (**1378 LOC** — el archivo más grande de COMANDA)
- `Pos/HandheldView.tsx` (725), `PedidosHub.tsx` (551)
- `Pos/SalonView.tsx`, `MostradorView.tsx`, `PosLayout.tsx`, `SalonLayoutEditor.tsx`

**Catálogo:**
- `Catalogo/ItemsTab.tsx`, `CombosLista.tsx`, `RecetasLista.tsx`, `GruposTab.tsx`
- `Catalogo/AlertasMargenLista.tsx`, `DisponibilidadLista.tsx`, `ItemReviewQueue.tsx`

**Reportes (8):**
- `Reportes/Dashboard.tsx`, `ReporteVentas`, `ReporteCanales`, `ReporteProductos`
- `ReporteTiempos`, `ReporteCMV`, `ReportePerformanceEmpleados`

**E-commerce/Delivery:**
- `Tienda/TiendaHome`, `TiendaCheckout` (627), `TiendaSeguimiento`, `TiendaLayout`
- `Online/TrackingDelivery`, `Delivery/DispatchMap`

**Hardware/Dispositivos:**
- `Hardware/HardwareImpresoras` (518), `HardwareAgentes`, `HardwareRiders`
- `Kds/KdsView` — Kitchen Display
- `Rider/RiderPWA`

**Settings (16 archivos):**
- `Settings/SettingsLocal` (652), `SettingsAfip` (624), métodos cobro, mesas,
  empleados, AFIP, integraciones

**Caja (6), Clientes, Marketing (Fidelidad/Cupones), Inventario (4),
Integraciones, Marketplace, Login**

### Hooks (14)
Core: `useTheme`, `useDebouncedValue`, `useOnlineStatus`, `useVisiblePolling`,
`useRealtimeTable`, `useFeaturesPosModos`, `usePermiso`, `useTimezone`,
`useGeolocation`, `useGuardedHandler`, `useNotifier`
**Offline-first:** `useSync`, `useSyncState`

### Capa offline-first (única vs PASE)
- **IndexedDB**: DB `comanda-offline` v1 con 7 stores
  (items, grupos, mesas, empleados, canales, modificadores, lista_precios)
- **Sync engine** (`src/lib/sync/`):
  - `syncEngine.ts` — orchestrator
  - `pushQueue.ts`, `pullInitial.ts`, `pullIncremental.ts`
  - `operations.ts`, `idReconciliation.ts`, `conflictResolver.ts` (last-write-wins)
  - `SyncEngineLifecycle.tsx` — React wrapper
- **RPCs offline** (`services/offline/`):
  - `ventasOfflineService`, `pagosOfflineService`, `overridesOfflineService`,
    `transferenciasOfflineService`
- **Cache strategy:** stale-while-revalidate, stale time 24h

### Servicios (65+)
Demasiados para listar — agrupados por dominio: Ventas, Pagos, Items, Insumos,
Materias Primas, Combos, Recetas, Modifiers, Precios, Tax Rates, Grupos,
Canales, Config, LocalSettings, Empleados, Mesas, KDS, Permisos, Reportes,
AllChecks, Auditoría, Tienda, MenuQR, Clientes, Direcciones, Riders, Print,
Descuentos, MetodosCobro, TurnosCaja, MiCierre, AlertasMargen, ItemReview,
Marketplace, Cupones, Reservas, Reviews, Mermas, Logbook, Integraciones.

### Tipos (`src/types/database.ts` — 534 LOC)
`TaxRate`, `ItemGrupo`, `Item`, `ModoPos`, `Estacion`, `Canal`, `Modifier`,
`Mesa`, `DisposicionMesa`, `EmpleadoPos`, `VentaPos`, `VentaPosItem`, `VentaPosPago`

### Endpoints API
**NO existe `packages/comanda/api/`** — todos los backends pasan por Supabase
RPCs o se delegan al stack `pase`.

## 5. Mapa de bot IG + admin-console

### `packages/instagram-bot/`

**Endpoints (7):**
- `webhook.js` (373) — Recibe DMs de Meta, procesa con Claude
- `send.js` — Envía DMs como humano (JWT auth)
- `oauth-callback.js` — Completa OAuth IG
- `refresh-tokens.js` — Renueva tokens IG
- `auth-bridge.js` — Bridge auth PASE↔bot
- `diagnostic.js` — Lista env vars
- `notif-pendientes-process.js` (309) — Cron push notifications

**Helpers (`api/_lib/`):** `db`, `meta`, `claude`, `prompt`, `push`, `cors`

**Env vars (15+):** Supabase keys, Meta tokens (`META_VERIFY_TOKEN`,
`META_APP_SECRET`, `IG_APP_ID`, `IG_APP_SECRET`), OAuth (`OAUTH_REDIRECT_URI`,
`PASE_BASE_URL`), `ANTHROPIC_API_KEY`, VAPID (push), `REFRESH_SECRET`,
`CRON_BEARER`, runtime.

**Eventos Meta procesados:** message (texto/imagen/video/audio/file/sticker),
read, reaction, delivery, postback, referral. Echo events ignorados;
non-message events logueados en `ig_eventos` pero no crean `ig_mensajes`.

### `packages/admin-console/`

**Páginas (7):** Login, Tenants, **TenantsFeaturesMatriz**,
**TenantFeaturesDetalle**, Metricas, Pagos (529), Soporte

**Componentes (6 top-level):** `TenantWizard` (319), `AgentPanel`,
`PushToggle`, `Sidebar`, `TicketsList`, `TicketDetail`

**Helpers (`src/lib/`):** `auth`, `supabase`, `features` (336), `tickets`,
`push`, `useTenantFeatures`, `cn`

**Autenticación:** `usuarios.rol = 'superadmin'`. Server-side via
`auth_es_superadmin()` RLS, client-side `useAuth()`. FK a Supabase Auth via
`auth_id`. Estados: loading → authenticated/forbidden/unauthenticated.

## 6. Top 20 archivos >500 LOC (refactor candidates)

| Archivo | LOC | Paquete |
|---|---|---|
| `ConciliacionMP.tsx` | **1666** | pase |
| `VentaScreen.tsx` | **1378** | comanda |
| `RRHHLegajo.tsx` | **1253** | pase |
| `Compras.tsx` | **1204** | pase |
| `Caja.tsx` | 1075 | pase |
| `RRHH.tsx` | 1075 | pase |
| `Gastos.tsx` | 1009 | pase |
| `Usuarios.tsx` | 773 | pase |
| `HandheldView.tsx` | 725 | comanda |
| `IntegracionPartnerScreen.tsx` | 707 | comanda |
| `Layout.tsx` | 669 | pase |
| `Ajustes.tsx` | 665 | pase |
| `SettingsLocal.tsx` | 652 | comanda |
| `Importar.tsx` | 638 | pase |
| `TiendaCheckout.tsx` | 627 | comanda |
| `SettingsAfip.tsx` | 624 | comanda |
| `EERR.tsx` | 601 | pase |
| `Objetivos.tsx` | 599 | pase |
| `App.tsx` | 595 | pase |
| `MensajeriaIG.tsx` | 586 | pase |

Estos son candidatos primarios para Fase 7 (overengineering / refactor).
ConciliacionMP, RRHHLegajo y Compras son los más cargados.

## 7. RPCs Postgres por categoría (~186 total)

### Financieras atómicas (Capa 1)
`pagar_factura`, `pagar_remito`, `anular_factura`, `anular_remito`,
`anular_gasto`, `anular_movimiento`, `crear_movimiento_caja`,
`editar_movimiento_caja`, `crear_gasto`, `editar_gasto`,
`transferencia_cuentas`, `pagar_sueldo`, `registrar_adelanto`,
`pagar_vacaciones`, `pagar_aguinaldo`, `liquidacion_final_empleado`,
`crear_cierre_ventas`, `eliminar_cierre`, `eliminar_venta`, `editar_venta`,
`crear_gasto_empleado`, `aplicar_nc_a_factura`

→ **Foco principal de Fase 1**

### COMANDA (50+)
`fn_abrir_turno_caja_comanda`, `fn_abrir_venta_comanda`,
`fn_agregar_item_comanda`, `fn_anular_venta_comanda`,
`fn_aprobar_pedido_comanda`, `fn_cerrar_turno_caja_comanda`,
`fn_cobrar_venta_comanda`, `fn_crear_pedido_publico_comanda`,
`fn_kds_get_tickets_comanda`, `fn_marcar_listo_comanda` (+ 40+ más)

→ **Foco principal de Fase 5**

### Stock / CMV
`fn_ajustar_stock_insumo`, `fn_aplicar_stock_venta`, `fn_revertir_stock_venta`,
`fn_revertir_stock_factura`, `fn_recalcular_stock_*`, `fn_transferir_stock_local`,
`fn_iniciar_conteo_fisico`, `fn_finalizar_conteo_fisico`,
`fn_cmv_real`, `fn_calcular_costo_receta_porcion`

### MP Conciliación
`fn_conciliar_mp_con_factura_nueva`, `fn_conciliar_mp_con_gasto`,
`fn_conciliar_mp_con_movimiento_interno`, `fn_ignorar_mp`, `fn_designorar_mp`

### Auth/RBAC
`auth_usuario_id`, `auth_tenant_id`, `auth_locales_visibles`,
`auth_cuentas_operables`, `auth_tiene_permiso`, `auth_es_dueno_o_admin`,
`auth_es_superadmin`, `auth_tiene_permiso_o_override`, `auth_tenant_tiene_feature`

→ **Foco principal de Fase 2**

### Admin multitenancy
`crear_tenant`, `crear_tenant_v2`, `eliminar_tenant_completo`,
`restore_tenant`, `set_mp_token`, `fn_set_tenant_feature`,
`fn_reset_tenant_features`

### Otros relevantes
`fn_marcar_password_cambiada`, `fn_verificar_pin_pos`, `fn_aplicar_cupon`,
`fn_canjear_puntos_cliente`, `precheck_manager_override`, `marcar_tarea_completada`,
`fn_solicitar_autorizacion`, `fn_aprobar_solicitud`

## 8. Tablas DB principales (35+)

**Finanzas:** `movimientos`, `saldos_caja`, `gastos`, `ventas`, `factura_items`,
`facturas`, `remitos`, `notas_credito`, `mp_movimientos`, `mp_justificaciones`,
`conciliaciones_mp`

**RRHH:** `rrhh_empleados`, `rrhh_liquidaciones`, `rrhh_adelantos`,
`rrhh_pagos`, `rrhh_puestos`

**Stock:** `insumos`, `insumo_movimientos`, `recetas`, `receta_porciones`,
`stock_movimientos`

**Maestros:** `usuarios`, `usuario_permisos`, `medios_cobro`,
`config_categorias`, `tenants`

**Comanda:** `comanda_usuarios`, `comanda_sesiones`, `mesas`, `items_comanda`,
`ventas_comanda`, `pedidos_comanda`, `tickets_comanda`, `recetas_versiones`,
`insumos_recetas`

**Integraciones:** `integraciones_externas`, `instagram_bot`,
`ig_conversaciones`, `ig_mensajes`, `delivery_riders`, `print_agents`

**Auditoría:** `auditoria` (append-only), `idempotency_keys`, `comanda_history`

**Manager system:** `manager_solicitudes`, `manager_override_usos`,
`tenant_totp_secret`, `tenant_features`

## 9. Estrategia para las fases siguientes

### Fase 1 — Bugs financieros (próxima)
**Target:** las ~22 RPCs financieras atómicas + triggers de saldos_caja +
4 archivos page más grandes (`ConciliacionMP`, `Compras`, `Caja`, `Gastos`).
**Subagentes en paralelo:** uno por dominio (pagar/anular/transferir/RRHH).

### Fase 2 — Seguridad multi-tenant
**Target:** RLS policies de tablas con `local_id` o `tenant_id`. Verificar que
las RPCs respeten `_validar_local_autorizado`. Auditar bypass via
`SECURITY DEFINER`. Revisar 7 helpers de `auth.ts`.

### Fase 3 — Performance
**Target:** queries sin filtro fecha en pages con listados (`Caja`, `Compras`,
`Gastos`, `Ventas`, `ConciliacionMP`). N+1 en RPCs que iteran sobre
`jsonb_array_elements`. Bundle size con `vite-bundle-analyzer`.

### Fase 4 — Frontend PASE
**Target:** los 11 archivos PASE >500 LOC. Foco en
`ConciliacionMP` (1666), `RRHHLegajo` (1253), `Compras` (1204), `Caja` (1075),
`RRHH` (1075), `Gastos` (1009). Hooks mal usados, race conditions, prop drilling.

### Fase 5 — COMANDA completo
**Target:** sync engine offline, `VentaScreen` (1378), 65 servicios.
Validar consistencia entre RPCs `_offline` y normales (¿hacen lo mismo en
contextos distintos?). Conflict resolver last-write-wins en plata = ¿bug?

### Fase 6 — Bot IG + admin-console
**Target:** webhook hardening (firma Meta, replay, throttling). Push
notifications cron auth. `Pagos.tsx` (529) y `Metricas.tsx` (459) del admin.

### Fase 7 — Deuda + overengineering
**Target:** duplicación PASE↔COMANDA en helpers (format, utils, errors).
COMANDA tiene 14 hooks que se solapan con los 9 de PASE — ¿hay copia-pega?
Eliminar archivos del listado >500 LOC que sean obvios candidatos.

### Fase 8 — Consolidación
Meta-reporte ejecutivo con ranking de TODO + estimación de esfuerzo.

## 10. Áreas a investigar específicamente

Algunas observaciones del reconocimiento que valen investigación dirigida en
fases posteriores:

1. **COMANDA tiene 4 RPCs `_offline` paralelas a las normales** (`ventas`,
   `pagos`, `overrides`, `transferencias`). Riesgo: drift entre las 2
   implementaciones de la misma operación. → Fase 5.

2. **Conflict resolver `last-write-wins` en plata** — peligroso si dos cajeros
   editan la misma venta offline. → Fase 5.

3. **`ConciliacionMP.tsx` con 1666 LOC y `Compras.tsx` con 1204 LOC** son las
   pantallas más grandes y mueven plata constantemente. Riesgo alto de bugs
   ocultos. → Fases 1 + 4.

4. **287 migrations SQL** — algunas pueden estar obsoletas/no aplicadas. Vale
   la pena un audit del orden cronológico vs estado actual de DB. → Fase 2/7.

5. **`onboardingTours.ts` con 528 LOC** es un archivo de pura configuración
   declarativa — probable candidato para datos JSON en lugar de TS. → Fase 7.

6. **Helpers privados en `pase/api/_*.js`** — 11 archivos compartidos entre
   endpoints. Algunos pueden estar legacy (`_pedidosya`, `_rappi`,
   `_gastro-sensei-prompt`) si los feature flags están off. → Fase 7.

7. **Subdirectorios de páginas (`pages/compras/`, `pages/rrhh/`, etc.)** —
   pattern bueno pero inconsistente: algunos módulos lo usan, otros tienen
   todo en un archivo monolítico. → Fase 4.

## 11. Para la próxima fase

Cuando arranquemos Fase 1, vamos a:

1. Listar las ~22 RPCs financieras + 4 RPCs de COMANDA que mueven plata.
2. Despachar agentes en paralelo (uno por subdominio: pagar/anular/transferir/RRHH/conciliación).
3. Cada agente lee el código completo de su RPC + busca: race conditions,
   missing locks, edge cases (montos cero/negativos), idempotency gaps,
   permisos faltantes, ROLLBACK que deja estados inconsistentes.
4. Consolidar findings en `01-bugs-financieros.md` con severidad.
5. Auto-fixes inmediatos para typos / dead code dentro de esas RPCs.

**Estimado Fase 1:** 3-4 horas de trabajo distribuido.
