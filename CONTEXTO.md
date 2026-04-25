# PASE — Sistema de Gestión Gastronómica

## Stack
- Frontend: React + TypeScript + Vite
- Backend: Supabase (pduxydviqiaxfqnshhdc.supabase.co)
- Deploy: Vercel (pase-yndx.vercel.app)
- Repo: lucastomasferrari-cell/PASE

## Estructura
- src/pages/ → un archivo por módulo
- src/components/Layout.tsx → sidebar + navegación
- src/lib/supabase.ts → cliente Supabase (anon key desde VITE_SUPABASE_ANON_KEY)
- src/lib/auth.ts → hook useAuth(), tienePermiso(), esEncargado(), localesVisibles(), scopeLocales(), applyLocalScope(), cuentasVisibles(), puedeVerCuenta()
- api/ → endpoints serverless (mp-sync, mp-generate, mp-process, claude, telegram-webhook, auth-admin, auth-setup, auth-hash-passwords, auth-migrate-all)

## Autenticación
- Login exclusivo vía Supabase Auth (`db.auth.signInWithPassword`). El fallback SHA-256 se eliminó en commit 3805ea7.
- Todos los usuarios activos tienen `auth_id` poblado. El email para Auth: `email` de la tabla `usuarios`; si no contiene `@`, se concatena `@pase.local`.
- Roles: dueno (acceso total), admin (casi total), encargado (restringido por local y por cuentas).
- Permisos por módulo en tabla `usuario_permisos`.
- Locales por encargado en tabla `usuario_locales`.
- Cuentas visibles en Tesorería por usuario: columna `usuarios.cuentas_visibles TEXT[]` (NULL = todas, array = filtro estricto, array vacío = ninguna).
- Password temporal: columna `usuarios.password_temporal BOOLEAN`. Si es true, el componente `src/pages/ForcePasswordChange.tsx` bloquea navegación hasta cambiar password.
- Para resetear password: Supabase Dashboard → Authentication → Users → "Reset password", opcionalmente después `UPDATE usuarios SET password_temporal = true WHERE id = X` para forzar cambio al próximo login.
- Endpoint admin `api/auth-migrate-all.js` para migrar masivamente usuarios sin auth_id (protegido con header `x-admin-secret`, requiere env var `ADMIN_MIGRATION_SECRET` en Vercel).

## Módulos activos
- Dashboard, Ventas, Facturas, Remitos, Gastos, Proveedores
- Import Maxirest, Caja & Bancos, Caja Efectivo
- Conciliación MP (MercadoPago), Estado de Resultados, Contador IVA
- Lector Facturas IA, Insumos, Recetas
- Empleados (módulo viejo, ocultar del sidebar — reemplazado por RRHH)
- RRHH (nuevo, ver detalle abajo)
- Usuarios (gestión de accesos)

## Módulo RRHH — Estado actual
Tabs: Dashboard | Empleados | Novedades | Pagos
Modal Legajo accesible desde Empleados (botón "Legajo" por fila)
Ícono ⚙ en esquina para configuración de valores de dobles

### Tablas RRHH en Supabase
- rrhh_empleados: id(uuid), local_id(int), apellido, nombre, cuil, puesto, modo_pago, sueldo_mensual, valor_dia(generated), valor_hora(generated), alias_mp, fecha_inicio, activo, vacaciones_dias_acumulados, aguinaldo_acumulado, fecha_egreso, motivo_baja
- rrhh_novedades: id, empleado_id, mes, anio, inasistencias, presentismo, dias_trabajados, horas_extras, dobles, pagos_dobles_realizados, feriados, adelantos, vacaciones_dias, observaciones, estado(borrador/confirmado), cargado_por, updated_at
- rrhh_liquidaciones: id, novedad_id, sueldo_base, descuento_ausencias, total_horas_extras, total_dobles, total_feriados, total_vacaciones, subtotal1, monto_presentismo, subtotal2, adelantos, pagos_realizados, total_a_pagar, efectivo, transferencia, estado(pendiente/pagado), gasto_id, pagado_at, pagado_por
- rrhh_valores_doble: puesto, valor
- rrhh_historial_sueldos: empleado_id, sueldo_anterior, sueldo_nuevo, fecha_cambio, motivo
- rrhh_documentos: empleado_id, tipo, nombre_archivo, url, mes, anio, subido_por
- rrhh_pagos_especiales: empleado_id, tipo(vacaciones/aguinaldo/liquidacion_final), monto, dias, periodo_desde, periodo_hasta, gasto_id, pagado_at

### Lógica de cálculo liquidación mensual
- sueldo_base: MENSUAL=sueldo, QUINCENAL=sueldo/2, SEMANAL=sueldo/4
- valor_dia = sueldo_mensual / 30
- valor_hora = valor_dia / 8
- descuento_ausencias = inasistencias × valor_dia
- total_horas_extras = horas_extras × valor_hora
- total_dobles = dobles × valor_doble[puesto]
- total_feriados = feriados × valor_dia
- presentismo = sueldo_mensual × 0.05 si MANTIENE, 0 si no
- subtotal1 = sueldo_base - descuento_ausencias + adicionales
- subtotal2 = subtotal1 + presentismo
- total_a_pagar = subtotal2 - adelantos - pagos_dobles_realizados

### Vacaciones (cálculo automático por antigüedad)
- < 5 años: 14 días/año → 14/12 por mes trabajado
- 5-10 años: 21 días/año
- 10-20 años: 28 días/año
- > 20 años: 35 días/año

### SAC / Aguinaldo
- Se paga en junio y diciembre
- SAC = mejor sueldo del semestre / 2
- Se acumula: aguinaldo_acumulado += sueldo/12 con cada pago mensual

## Conciliación MercadoPago
- Sync automático vía cron-job.org cada 30 min.
- Job 1 (mp-generate): genera CSV en MP.
- Job 2 (mp-process): descarga y procesa CSV.
- Saldo inicial fijado: $1.843.593 el 11/04/2026.
- Prefijos: rr-* = release_report (autoritativo), sin prefijo = payments API.
- Timezone: Argentina es UTC-3 todo el año. Los horarios se muestran con helpers `toBuenosAires`, `fmt_dt_ar`, `fmt_t_ar` de `src/lib/utils.ts`.
- Parsing CSV release_report: MP entrega fechas en Argentina-local sin marcador TZ. El código detecta la falta de TZ y anexa -03:00 antes del parse. Pagos vía REST API (`date_approved`) ya vienen con Z y no se modifican.
- Columna `mp_movimientos.fecha` es `timestamptz` (migrada 23/Apr/2026 de `timestamp without time zone`).

## Tablas principales Supabase
- usuarios: id, nombre, email, password (legacy SHA-256, sin uso), rol, locales (array legacy), auth_id (uuid, NOT NULL en activos), activo, password_temporal (boolean), cuentas_visibles (text[])
- usuario_permisos, usuario_locales, locales
- movimientos, facturas, factura_items, factura_items_stock
- ventas (con columna `origen TEXT DEFAULT 'manual'`)
- gastos, gastos_plantillas
- remitos, remito_items
- proveedores, insumos, recetas, receta_items
- saldos_caja, caja_efectivo
- mp_credenciales (admin-only), mp_movimientos (`fecha` es timestamptz), mp_liquidaciones
- empleados (vieja, deprecated), empleado_archivos
- rrhh_empleados, rrhh_novedades, rrhh_liquidaciones, rrhh_valores_doble, rrhh_historial_sueldos, rrhh_documentos, rrhh_pagos_especiales, rrhh_adelantos
- auditoria, blindaje_tipos_documento, blindaje_documentos, config_categorias

## Pendientes prioritarios
1. Fix RRHH: vacaciones muestra 0.0d — cálculo por antigüedad no funciona.
2. Fix RRHH: SAC acumulado muestra $0 — mostrar SAC teórico del semestre.
3. Fix RRHH: Novedades y Pagos no autoseleccionan local.
4. Fix RRHH: botón Pagar mes en legajo (verificar tras mover a tab Pagos).
5. Liquidación final en legajo — pendiente de implementar.
6. Módulo Empleados viejo → ocultar del sidebar (reemplazado por RRHH).
7. Refactor: pasar `user` a `src/lib/services/caja.service.ts` y `rrhh.service.ts` para que usen `applyLocalScope` en lugar del `if (localId) q.eq(...)` actual. Las RLS lo cubren server-side pero conviene alinear el patrón.

## Decisiones de arquitectura tomadas
- **Login: Supabase Auth como único sistema** (cambio de política 23/Apr/2026: antes era SHA-256 en tabla usuarios).
- **RLS activo y restrictivo en todas las tablas** (migration 20260423_rls_real_policies.sql + extensión para gastos_plantillas, factura_items_stock, remito_items, rrhh_adelantos, mp_liquidaciones).
- **Helpers de scope SECURITY DEFINER** en Postgres: `auth_usuario_id()`, `auth_es_dueno_o_admin()`, `auth_locales_visibles()`.
- **Anon key fuera del código**: se lee de `VITE_SUPABASE_ANON_KEY` (ver `.env.example`). Rotada el 23/Apr/2026. Procedimiento en `ROTATE_ANON_KEY.md`.
- **Defense-in-depth en frontend**: `applyLocalScope(q, user, localActivo)` y `scopeLocales(user, localActivo)` de `src/lib/auth.ts` en toda query a tablas con `local_id`.
- **Aislamiento por local — tres capas**: (1) Datos vía `usuario_locales` (trabajo humano del dueño: asignar cada encargado a sus locales). (2) Backend: RLS con `auth_locales_visibles()` en cada tabla con `local_id`. (3) UX: encargados con >1 local deben elegir uno al loguearse mediante modal bloqueante (`src/components/SeleccionarLocalModal.tsx`), forzando `localActivo != null`. Un encargado nunca opera con `localActivo=null` — la app no se lo permite. La lección del bug #27 es que si las tres capas no están alineadas (ej: `usuario_locales` sobrecargado con todos los locales + frontend permite `localActivo=null`), los permisos de RLS quedan demasiado amplios y hay leak entre sucursales aunque el código esté bien.
- **Fechas/timezone**: guardar siempre en UTC con `timestamptz` en DB. Conversión a zona Argentina solo en display via helpers `toBuenosAires`, `fmt_dt_ar`, `fmt_t_ar` de `src/lib/utils.ts`. Nunca hacer `.toISOString()` sobre fecha local sin marcador TZ.
- **Distinción de origen en Ventas**: columna `origen` ('manual' | 'maxirest') diferencia carga manual de importada. Las importadas no se editan (solo eliminar).
- **Medios de cobro: catálogo dinámico**. Tabla `medios_cobro` (refactor C, migration `20260424_medios_cobro_catalogo.sql`) reemplaza al array hardcoded `MEDIOS_COBRO` de `src/lib/constants.ts`. El dueño edita el catálogo desde Configuración → Medios de cobro y puede definir medios distintos por local (ej: Belgrano usa "Efectivo" sin sufijo, Villa Crespo usa "EFECTIVO SALON" + "EFECTIVO DELIVERY"). Filas globales (`local_id IS NULL`) son visibles en todos los locales; filas con `local_id` son específicas de ese local. Si existen ambos con el mismo nombre, el local-specific gana (override del dueño). El hook `useMediosCobro` (paralelo a `useCategorias`) cachea en `sessionStorage` y cae a `constants.MEDIOS_COBRO`/`MEDIO_A_CUENTA` como fallback offline. Flujo: dueño configura → Maxirest matchea por nombre exacto contra el catálogo del local activo + globales → si falta algún medio, el importer rechaza el batch entero con un alert listando los faltantes (no importa parcial para no desbalancear caja). EERR y formularios manuales (Ventas) consumen el mismo catálogo via hook.
- local_id y usuario_id son INTEGER (no UUID) en todas las tablas.
- El módulo RRHH NO depende del módulo Empleados viejo.
- Pagos de sueldo crean gastos en tabla gastos con categoría "Sueldos".
- Legajo del empleado es modal, no página separada.
- **Migrations automáticas**: el flow oficial es `vercel env pull` + `pg` local + script one-off — NO un endpoint HTTP deployado. Pasos: commit del SQL en `supabase/migrations/` → `npx vercel env pull .env.local.tmp --environment=production` para bajar `POSTGRES_URL_NON_POOLING` → script de Node con `pg` (instalado con `npm install pg --no-save` para no contaminar `package.json`) que lee la URL del archivo, ejecuta el SQL en transacción y corre queries de verificación. Limpieza al terminar: borrar `.env.local.tmp` y el script. **Pre-requisito**: la variable `POSTGRES_URL_NON_POOLING` en Vercel NO debe estar marcada "Sensitive" (si lo está, `vercel env pull` baja la key con valor `""`); si la encontrás encriptada, parar y pedir al dueño que destilde el flag. El usuario nunca copia-pega SQL en el Dashboard. **Antipatrón explícito**: NO crear endpoints serverless tipo `api/admin-run-sql.js` con auth por header — fuerzan que el secret pase por algún canal (chat, terminal compartido, log) y son superficie de ataque innecesaria. El endpoint que existió temporalmente para este patrón fue eliminado en `ce11694` y `e9284d4`.

## Sistema de permisos por módulo

El sistema tiene dos capas que conversan entre sí:

1. **usuario_permisos (frontend gate)**: habilita botones y pages según módulos asignados al usuario. Los strings de módulo ("slugs") están normalizados: `proveedores`, `insumos`, `recetas`, `configuracion`, `rrhh`, `usuarios`, `compras` (facturas), `gastos`, `caja`, `ventas`, `cashflow`, `eerr`, `dashboard`, `lector_ia`, `mp` (conciliación), `cierre`, `contador`, `costos`, `blindaje`, `remitos`, `maxirest`. Ver lista completa en `src/lib/auth.ts::MODULOS` y `tienePermiso()`.

2. **RLS Postgres (backend gate)**: controla acceso SQL directo vía función `auth_tiene_permiso(slug)` que cruza `auth.uid()` con `usuario_permisos`. Dueño y admin pasan siempre por `CASE WHEN auth_es_dueno_o_admin() THEN true`.

### Reglas de modificación

Al agregar una tabla nueva al sistema:

- **Data local-scoped** (tiene `local_id`): usar policy con `auth_locales_visibles()` como ya documentado en "Cómo agregar una tabla nueva → A".
- **Master data con control granular** (catálogos, recetas, proveedores): usar `auth_tiene_permiso('<slug>')` tanto en `USING` como en `WITH CHECK`.
- **Data crítica de sistema** (tokens, credenciales, audit log): mantener admin-only con `auth_es_dueno_o_admin()`.

### Mapeo actual tabla → slug (migration `20260424_rls_permisos_granulares.sql`)

| Tabla | Slug | Operaciones |
|-------|------|-------------|
| `proveedores` | `proveedores` | ALL |
| `insumos` | `insumos` | ALL |
| `recetas`, `receta_items` | `recetas` | ALL |
| `config_categorias` | `configuracion` | ALL |
| `medios_cobro` | `configuracion` | escritura; SELECT abierto autenticados |
| `rrhh_valores_doble` | `rrhh` | ALL |
| `usuarios`, `usuario_permisos`, `usuario_locales` | `usuarios` | SELECT (escritura admin-only) |
| `locales`, `mp_credenciales`, `auditoria` | — | admin-only (no relajar) |

### Cache de permisos

Los permisos se cachean en `sessionStorage` (clave `pase_user`) al login. Si el dueño cambia permisos de un usuario activo, el usuario puede refrescar via botón **"Actualizar permisos ↻"** en el panel de usuario del sidebar (abajo, al lado de "Cerrar sesión"), sin cerrar sesión. El RLS del backend siempre lee DB fresh, así que aunque el cache quede stale, no hay bypass de seguridad — sólo UX (el frontend muestra/oculta botones en base al cache).

## Taxonomía canónica (movimientos.tipo, categorías, grupos)

Post migration `20260424_taxonomia_grupo_ingresos.sql`:

**`movimientos.tipo`** — valor canónico seteado por código/RPC, nunca por usuario. Universo:

- Pagos de negocio: `Pago Proveedor`, `Pago Sueldo`, `Pago Vacaciones`, `Pago Aguinaldo`, `Liquidación Final`, `Adelanto`.
- Gastos por grupo: `Gasto fijo`, `Gasto variable`, `Gasto publicidad`, `Gasto impuesto`, `Gasto comision` (el tipo lo derivan las RPCs a partir del grupo de la categoría).
- Ingresos: `Ingreso Venta`, `Ingreso Manual`.
- Manuales: `Egreso Manual`.
- Internos: `Transferencia Salida`, `Transferencia Entrada`.
- Legacy pre-batch α (ya no se genera, pero puede existir en filas viejas antes del cleanup): `Pago Gasto` (normalizado a `Egreso Manual` por la migration).

**`config_categorias.grupo`** — clasificación contable única. Valores:

| Grupo | Tipos de `config_categorias.tipo` |
|-------|-----------------------------------|
| CMV | `cat_compra` |
| Gastos Fijos | `gasto_fijo` |
| Gastos Variables | `gasto_variable` |
| Publicidad y MKT | `gasto_publicidad` |
| Comisiones | `gasto_comision` |
| Impuestos | `gasto_impuesto` |
| INGRESOS | `cat_ingreso` (11 filas: Liquidación Rappi/MP/PedidosYa/Evento/Bigbox/Fanbag/Nave + Ingreso Socio + Devolución Proveedor + Otro Ingreso + Transferencia Varios) |
| (NULL) | `medio_cobro` — los medios no son grupo contable |

Sueldos se deriva de `rrhh_liquidaciones`, no desde `config_categorias`.

**`gastos.tipo`** — columna legacy que se mantiene (EERR.tsx filtra por ella). La RPC `crear_gasto` deriva el valor desde el grupo de la categoría elegida: `Gastos Fijos→"fijo"`, `Gastos Variables→"variable"`, etc. El frontend no tiene que preocuparse — el `p_tipo` que pasa queda como fallback cuando la categoría no está en el catálogo con grupo.

**Fuente de verdad para listas de categorías en el frontend**: hook `useCategorias()` (`src/lib/useCategorias.ts`). Fetch único a `config_categorias` con cache en `sessionStorage` (1h TTL). Fallback silencioso a `constants.ts` si la DB falla.

## Panel "Por cobrar" en Cashflow

En `src/pages/Cashflow.tsx`, panel informativo que deriva en runtime:

- Para cada medio de cobro no-efectivo del mes (Rappi Online, Peya Online, MP Delivery, Bigbox, Fanbag, Nave, tarjetas, QR, Link, transferencias): suma `ventas.monto` del mes.
- Resta los movimientos con `cat = "Liquidación X"` del mismo mes y misma plataforma.
- Muestra: vendido · cobrado · pendiente.

Política Opción C (validada 2026-04-24): sólo efectivo dispara movimiento automático al cargar la venta. El resto se refleja en Cashflow cuando el usuario registra manualmente un movimiento de ingreso con la categoría de liquidación correspondiente (ver las 11 filas `cat_ingreso` en `config_categorias`).

## Deuda técnica — Caja Efectivo

Hoy existen dos representaciones paralelas para "Caja Efectivo":

1. Fila en `saldos_caja` con `cuenta = 'Caja Efectivo'`. Las RPCs del batch α escriben ahí si el usuario elige esa cuenta como egreso.
2. Tabla `caja_efectivo` (libro privado del dueño, panel "Caja Efectivo — Privado" en Tesorería).

Cuando una venta con medio EFECTIVO SALON / EFECTIVO DELIVERY / PEYA EFECTIVO / EVENTO dispara movimiento automático, va a **Caja Chica** (no a Caja Efectivo). No están reconciliados. Para mover plata entre las dos representaciones hay que hacerlo manualmente.

Pendiente para batch futuro: decidir si unificar las dos tablas o desambiguar nombres.

## EERR vs Cashflow — diferencia conceptual

El sistema tiene dos miradas distintas sobre el dinero:

**EERR (Estado de Resultados) — base devengada.** Cuenta el resultado del negocio independientemente de cuándo entra o sale la plata. Lee de: `ventas`, `facturas`, `gastos`, `rrhh_liquidaciones` (todo por fecha del hecho económico, no del pago).

- Ingresos = ventas del período, por fecha de venta.
- CMV = facturas de proveedores del período, por fecha de factura.
- Gastos, Sueldos = por fecha de gasto o liquidación.

**Cashflow — base percibida.** Cuenta cómo se mueve la plata entre cuentas. Lee de: `movimientos` (anulado=false) + `saldos_caja`.

- Ingresos cobrados = movimientos positivos (ventas cobradas, liquidaciones de plataformas, aportes de socios, devoluciones, etc.).
- Egresos pagados = movimientos negativos.

Los "Ingresos" de Cashflow **NO van al EERR**. La venta se cuenta en EERR cuando se carga en Ventas (fecha de venta, no de cobro). Cuando Rappi/MercadoPago/PedidosYa/Bigbox/etc liquidan días después, ese movimiento entra al Cashflow como realización de cobro, pero no es una venta nueva — sumarla al EERR sería contar dos veces.

**Categorías de ingreso exclusivas de Cashflow (grupo "INGRESOS"):**

- Liquidación Rappi, MercadoPago, PedidosYa, Evento, Bigbox, Fanbag, Nave.
- Ingreso Socio, Devolución Proveedor, Otro Ingreso, Transferencia Varios.

**Cuándo mirar cada uno:**

- EERR para rentabilidad mensual del negocio (¿gané o perdí este mes en términos contables?).
- Cashflow para liquidez y plan de caja (¿con qué plata cuento hoy y qué compromisos tengo pendientes?).

**Consecuencia**: EERR y Cashflow no tienen que coincidir día a día. Se reconcilian a largo plazo. Si un mes no cuadran, no es necesariamente un bug — es el delay natural de cobros diferidos (tarjeta 48-72h, Rappi/Peya 7-14 días, eventos al cierre, etc.).

## Comandos útiles
- Claude Code: claude --dangerously-skip-permissions
- Deploy: push a main → Vercel auto-deploya

## Cómo agregar una tabla nueva (checklist obligatorio)

Cuando crees una tabla, hacé estos pasos o **no va a funcionar desde el frontend** (RLS bloquea todo por default):

### A) Tabla con `local_id` (datos scoped por sucursal):

```sql
ALTER TABLE mi_tabla ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mt_scope_all" ON mi_tabla FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()) OR local_id IS NULL)
  WITH CHECK (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()) OR local_id IS NULL);
```

### B) Master data global (catálogo, config):

```sql
ALTER TABLE mi_tabla ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mt_read" ON mi_tabla FOR SELECT TO authenticated USING (true);
CREATE POLICY "mt_admin_write" ON mi_tabla FOR ALL TO authenticated
  USING (auth_es_dueno_o_admin()) WITH CHECK (auth_es_dueno_o_admin());
```

### C) Tabla hija (items de otra tabla que ya tiene RLS):

```sql
ALTER TABLE mi_tabla_hija ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mth_scope_all" ON mi_tabla_hija FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM tabla_padre p WHERE p.id = mi_tabla_hija.padre_id
    AND (auth_es_dueno_o_admin() OR p.local_id = ANY(auth_locales_visibles()))))
  WITH CHECK (EXISTS (SELECT 1 FROM tabla_padre p WHERE p.id = mi_tabla_hija.padre_id
    AND (auth_es_dueno_o_admin() OR p.local_id = ANY(auth_locales_visibles()))));
```

### D) En el frontend, toda query a tablas con `local_id` debe usar `applyLocalScope`:

```typescript
import { applyLocalScope } from "../lib/auth";
let q = db.from("mi_tabla").select("*").gte("fecha", desde);
q = applyLocalScope(q, user, localActivo);
const { data } = await q.order("fecha");
```

### E) Endpoints serverless en `api/`:

Usar siempre `SUPABASE_SERVICE_KEY` (env var en Vercel), nunca anon. La service_key bypassa RLS — filtrar manualmente por `local_id`/usuario en el código del endpoint si corresponde.

### F) Fechas en nuevas tablas:

Usar `timestamptz` siempre, nunca `timestamp` sin zona. Guardar en UTC, mostrar con helpers de `src/lib/utils.ts`.

## Troubleshooting rápido

- **"Usuario no ve sus datos"** → falta policy RLS (pasos A/B/C).
- **"Encargado ve datos de otro local"** → falta `applyLocalScope` en frontend, o policy mal.
- **"new row violates row-level security policy"** → el `WITH CHECK` no pasa. El `local_id` del INSERT/UPDATE tiene que estar en los del usuario.
- **"relation does not exist"** en policies con JOIN → nombre de columna mal escrito.
- **Horarios desfasados 3h** → columna guardada como `timestamp` sin zona en vez de `timestamptz`, o display sin usar helpers de Buenos Aires.

## Pagos atómicos (RPC)

Desde el batch α (migration `20260423_rpc_pagos_atomicos.sql`), toda operación que mueve plata entre múltiples tablas (movimientos, saldos_caja, facturas/remitos/gastos, rrhh_*) pasa por una función Postgres que agrupa todo en una transacción. Si algún step falla → rollback automático. Previene los estados inconsistentes que generaba el frontend al aplicar 4-5 operaciones sueltas.

### Las 13 funciones

| RPC | Usada en | Qué hace |
|-----|----------|----------|
| `pagar_factura(factura_id, monto, cuenta, fecha, detalle)` | Compras.tsx | UPDATE facturas(estado, pagos) + UPDATE proveedores.saldo + UPDATE saldos_caja + INSERT movimientos(fact_id) + auditoria |
| `pagar_remito(remito_id, monto, cuenta, fecha)` | Remitos.tsx | UPDATE remitos(estado='pagado') + UPDATE proveedores.saldo + UPDATE saldos_caja + INSERT movimientos(remito_id_ref) + auditoria |
| `anular_factura(factura_id, motivo)` | Compras.tsx | UPDATE facturas(estado='anulada') + revertir saldo proveedor si no estaba pagada + auditoria |
| `anular_remito(remito_id, motivo)` | Remitos.tsx | UPDATE remitos(estado='anulado') + revertir saldo proveedor si sin_factura + auditoria |
| `pagar_sueldo(nov_id, formas_pago, adelantos_ids, fecha, mes, anio, crear_liq, calc)` | RRHH.tsx | Loop formas_pago: UPDATE saldos_caja + INSERT movimientos(liquidacion_id). UPDATE rrhh_liquidaciones(estado, pagos_realizados). UPDATE rrhh_adelantos.descontado=true. UPDATE rrhh_empleados.aguinaldo_acumulado. Crea la liq si no existe. Auditoria. |
| `registrar_adelanto(empleado_id, monto, cuenta, fecha, detalle)` | RRHH.tsx | UPDATE saldos_caja + INSERT rrhh_adelantos + INSERT movimientos(adelanto_id_ref) + auditoria |
| `pagar_vacaciones(empleado_id, lineas, dias, monto_esperado, fecha)` | RRHHLegajo.tsx | Loop lineas: UPDATE saldos_caja + INSERT movimientos(pago_especial_id_ref). INSERT rrhh_pagos_especiales. UPDATE rrhh_empleados.vacaciones_dias_acumulados=0 si completa. |
| `pagar_aguinaldo(empleado_id, lineas, monto_esperado, fecha)` | RRHHLegajo.tsx | Igual que vacaciones pero sobre aguinaldo_acumulado |
| `liquidacion_final_empleado(empleado_id, fecha_egreso, motivo, total, cuenta)` | RRHHLegajo.tsx | Check LIQ_FINAL_YA_EXISTE + INSERT rrhh_pagos_especiales + UPDATE saldos_caja + INSERT movimientos + UPDATE rrhh_empleados(activo=false, egreso, vac/agu=0) |
| `crear_movimiento_caja(fecha, cuenta, tipo, cat, importe, detalle, local_id)` | Caja.tsx | INSERT movimientos + UPDATE saldos_caja |
| `anular_movimiento(mov_id, motivo)` | Caja.tsx | UPDATE movimientos(anulado=true) + revertir saldos_caja. Propaga a rrhh_liquidaciones vía liquidacion_id (fallback match por detalle+fecha+cuenta+local_id) + auditoria |
| `crear_gasto(fecha, local_id, categoria, tipo, monto, detalle, cuenta, plantilla_id)` | Gastos.tsx | INSERT gastos + UPDATE saldos_caja + INSERT movimientos(gasto_id_ref) + auditoria. p_plantilla_id opcional |
| `transferencia_cuentas(local_id, origen, destino, monto, fecha, detalle)` | (sin UI aún) | Dos UPDATE saldos_caja (−origen, +destino) + 2 INSERT movimientos (Transferencia Salida/Entrada) + auditoria |

### Patrón de uso en el frontend

```typescript
import { translateRpcError } from "../lib/errors";
const { error } = await db.rpc("pagar_factura", {
  p_factura_id: f.id, p_monto: monto, p_cuenta: pagoForm.cuenta,
  p_fecha: pagoForm.fecha, p_detalle: detalle,
});
if (error) { alert(translateRpcError(error)); return; }
```

### Convenciones

- **Errores**: `RAISE EXCEPTION 'CODIGO_UPPER_SNAKE'`. Ej: `FACTURA_YA_PAGADA`, `SALDO_INSUFICIENTE`, `LOCAL_NO_AUTORIZADO`, `LIQ_FINAL_YA_EXISTE`. `src/lib/errors.ts::translateRpcError` mapea a español; códigos no mapeados muestran el raw (fallback transparente).
- **SECURITY INVOKER** en todas: respetan RLS + validan permisos vía `_validar_local_autorizado(local_id)` que usa `auth_es_dueno_o_admin()` y `auth_locales_visibles()`.
- **`_actualizar_saldo_caja`** es el helper que actualiza saldos con INSERT ... ON CONFLICT DO UPDATE (nunca falla por "fila no existe"). Loguea `WARN_SALDO_NEGATIVO` en auditoria si el saldo queda en rojo, sin bloquear (flag `p_permitir_negativo` default true).
- **Columnas de referencia en `movimientos`**: `liquidacion_id (uuid)`, `gasto_id_ref (text)`, `remito_id_ref (text)`, `adelanto_id_ref (uuid)`, `pago_especial_id_ref (uuid)`, `fact_id (text, existente)`. Las RPCs las setean al insertar para permitir propagación de anulaciones con vínculo duro.
- **Cron MP (`mp-process.js`)**: el delta de las RPCs sobre `saldos_caja.MercadoPago` es efímero. El cron pisa con el saldo autoritativo de MP en la próxima sync. Documentado en el docstring de `pagar_factura` y `pagar_sueldo`.
- **Deuda técnica abierta**: la cuenta "Caja Efectivo" en saldos_caja sigue existiendo aunque haya una tabla `caja_efectivo` para el libro privado del dueño. La separación queda pendiente para un refactor aparte. Las RPCs escriben a saldos_caja para mantener el comportamiento actual.
