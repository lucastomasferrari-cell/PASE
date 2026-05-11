# Changelog PASE — Mayo 2026

Registro de fixes, refactors y nuevas features. Ordenado cronológicamente
(más viejo arriba). Cada entrada tiene el hash del commit, el motivo y los
archivos clave tocados. Si requiere migration o acción manual, se indica al
final del bloque.

---

## 2026-05-07

### `d9d48a1` — refactor(conciliacion-mp): pantalla administrativa pura, modal simplificado

Conciliación MP se redujo a su rol administrativo: conciliar movimientos.
Los reportes de ventas viven en otra pantalla.

**Frontend (`ConciliacionMP.tsx`):**
- Sacados tabs **Ventas, Por cobrar e Ingresos al saldo**. Quedan **Egresos + Comisiones MP**.
- Header consolidado: **Saldo MP** (suma de `saldo_disponible`) + **Dinero a liberar** (suma de `por_acreditar`) sobre todas las credenciales del scope.
- Saco modal "Fijar saldo inicial".
- Modal de conciliar: **overlay con spinner "Procesando..."** que bloquea toda interacción mientras la RPC corre. Antes solo cambiaba label del botón → usuarios clickeaban N veces.
- Sacada opción **"Egreso manual"**. No se debe poder hacer egresos manuales en el sistema.
- Unificados tabs **Factura/Remito/Gasto** en un tab por entidad: dropdown con existentes + opción "+ Crear nuevo" inline + buscador. Facturas ahora muestran **nombre del proveedor** (antes solo número).
- Form "Crear gasto nuevo": **tipo readonly**, autocompletado desde la categoría según `config_categorias`.

**Hook (`useCategorias`):** expone `categoriaToTipo` (cache bumpeada a v4).

**Backend (migration `202605110000_mp_conciliacion_simplificacion.sql`):**
- DROP `fn_conciliar_mp_con_egreso_manual`.
- ADD `fn_conciliar_mp_con_factura_nueva` y `fn_conciliar_mp_con_remito_nuevo` (crean entidad mínima + movimiento contable + linkean atómico).

**Migration aplicada:** sí.

---

## 2026-05-08

### `c75296a` — feat(conciliacion-mp): filtros previos en modal

Antes los dropdowns listaban TODAS las facturas/remitos/gastos del período (pendientes y pagadas/conciliadas mezcladas) — generaba ruido y obligaba a buscar entre N items irrelevantes.

- **Tab Factura**: select de proveedor primero (lista solo proveedores con facturas no conciliadas), después dropdown de facturas de ese proveedor ordenadas por fecha desc.
- **Tab Remito**: idem.
- **Tab Gasto**: select de categoría primero (lista solo categorías con gastos no conciliados), después dropdown filtrado.
- En los 3 tabs, las entidades ya conciliadas con otro mp_mov **desaparecen automáticamente**.

---

### `851c6a4` — refactor(configuracion): unificar 5 tipos de gasto en un solo tab "Categorías de Gastos"

Antes había 5 tabs separados (Gastos Fijos, Variables, Publicidad y MKT, Impuestos, Comisiones). Ahora un solo tab "Categorías de Gastos" con tabla unificada. El sub-tipo es una columna **editable inline**. Al agregar una categoría se elige el tipo en el form.

- TIPOS pasa de 8 a 4 entries: Categorías de Gastos | Cat. de Compra | Cat. de Ingreso | Medios de Cobro.
- Default tab pasa de "gasto_fijo" a "categorias_gastos".
- Sin cambios en BD: la columna `config_categorias.tipo` sigue guardando los mismos valores.

---

### `65d169e` — chore(layout): ocultar Cashflow del sidebar hasta resolver ingresos no-MP

La pantalla solo muestra ingresos cobrados de MercadoPago — faltan los de efectivo y banco. Ocultada hasta resolver el flujo de ingresos por canales no-MP (probablemente con un importador de banco análogo al de Maxirest). Item del sidebar comentado en `Layout.tsx`. La pantalla y la ruta en `App.tsx` quedan intactas para reactivación rápida.

---

### `e55c4f3` — feat: lote de mejoras (RRHH doble, Blindaje, Combobox, permisos finos)

Lote de 5 mejoras pedidas por Lucas, todas independientes pero envueltas en un commit por simplicidad de revisión.

**1) RRHH — día doble derivado del sueldo**
- Antes: tabla `rrhh_valores_doble` con valor fijo por puesto. Dos empleados del mismo puesto cobraban el mismo doble aunque tuvieran sueldos distintos.
- Ahora: doble = sueldo / 30 × 2.
- Eliminado: modal de configuración, botón ⚙ del header, función `loadValoresDoble`, state `valoresDoble`/`cfgEdit`/`cfgModal`, prop a `TabNovedades`, type `ValorDoble`. Tabla legacy queda en BD pero ya no se lee.
- Lista de "puestos" ahora se deriva de `allEmps` en vez de `valoresDoble`.

**2) Blindaje — sin toggle activo + unificar lista**
- Antes: cards arriba (1 por tipo) + tabla abajo solo para admin con toggle activo/inactivo.
- Ahora: una sola tabla unificada visible para todos los roles con acceso al módulo. Columnas: Orden, Nombre, Descripción, Vencimiento, Estado, Acciones.
- Botones Subir/Actualizar y Ver para todos; Editar y Eliminar solo admin.
- Eliminar es delete real con cascade — pide confirmación con cuenta de PDFs cargados, borra archivos del storage + filas de `blindaje_documentos` + el tipo.
- Migration `202605120000_blindaje_drop_activo.sql`: limpia tipos inactivos legacy + drop columna `activo`.

**3) Combobox searchable select reusable**
- Nuevo componente `packages/pase/src/components/Combobox.tsx` (~210 líneas, sin dependencias). Input que filtra al tipear + click para abrir lista completa, con soporte de optgroups y clearable.
- Aplicado en: ConciliaciónMP modal (proveedor de factura/remito, categoría de gasto), Compras.tsx (categoría EERR), Gastos.tsx (filtro de tipo, antes pills inline que se rompía).

**4) Permiso fino "ventas_historico"**
- Nuevo concepto `PERMISOS_EXTRAS` en `auth.ts` — flags granulares que NO son módulos de sidebar pero se gestionan desde Usuarios.
- Sin este permiso, en Ventas.tsx la sección "histórico de cierres" se oculta. El usuario solo puede cargar nuevos cierres pero no ver los anteriores. Pensado para cajeros — evita que puedan calcular cuánto facturó el local.

**5) Permiso fino "ver_anulados"**
- Esconde toggles "Ver anulados / Ver inactivos" en Caja.tsx, Proveedores.tsx y RRHH.tsx (pestaña Empleados) cuando el usuario no tiene el permiso. Por default no lo tiene ningún rol no-dueño.

**UI nueva en Usuarios.tsx:** sección "Permisos avanzados" debajo de "Módulos habilitados".

**Migration aplicada:** sí.

---

### `199882d` — chore(cashflow): ocultar también de MODULOS y redirigir si sesión stale

El commit anterior solo comentó el item del sidebar. Cashflow seguía apareciendo en Usuarios → Permisos (porque el slug está en MODULOS) y en la pantalla directa si la sesión tenía "cashflow" guardado en localStorage.

- `auth.ts`: comento entry de cashflow en MODULOS y lo saco de `ROLES.admin.permisos`.
- `App.tsx`: case "cashflow" pasa a renderizar `<Dashboard/>` como fallback.

---

### `6e68d03` — feat(eerr): fusionar Cierre Comparativo + comparación de meses + gráfico evolución

Cierre Comparativo y EERR calculaban casi lo mismo. Fusión: EERR queda como única pantalla "Estado de Resultados", con la comparativa integrada.

- Botones inline arriba: input mes principal + chips "vs <mes>" para los comparados (máximo 2). Botón "+ Comparar mes" agrega uno; cada chip tiene ✕ para quitarlo.
- Helper `cargarMesResumen(mes)`: trae totales (ventas, cmv, gastos por tipo, sueldos, util bruta/neta) sin detalles por categoría.
- **Resumen P&L**: en modo solo-principal mantiene formato vertical. En modo comparativo pasa a tabla con columnas (Mes principal | vs B | vs C), con %Δ en cada celda comparada.
- **Gráfico de evolución (LineChart)**: aparece arriba del grid solo cuando hay >=1 mes comparado. Líneas: Ventas, CMV, Sueldos, Util. Neta. Eje Y formateado en k/M.
- KPIs grandes y Detalle por Categoría siguen siendo del mes principal (decisión Lucas: mantener limpio).

**Cierre Comparativo oculto:**
- Layout.tsx: comentar item del sidebar.
- auth.ts: slug 'cierre' fuera de MODULOS y de ROLES.admin.permisos.
- App.tsx: case "cierre" → fallback a `<EERR/>`.

---

### `843fbd4` — feat(facturas): bucket por categoría — servicios via Compras sin inflar CMV

Hasta hoy "factura → CMV" era automático en EERR. La regla de producto "todo lo que tiene factura va por Compras" (incluye servicios: AySA, Edenor, MP, Rappi) hacía que esos cargos inflaran el CMV en vez de aparecer como gastos operativos. Error contable.

Solución: cada factura guarda un `bucket` que clasifica a qué línea del EERR pertenece. Bucket se deriva del tipo de la categoría seleccionada.

**Migration `202605130000_facturas_bucket.sql`:**
- ADD COLUMN `facturas.bucket TEXT NULL`.
- CHECK constraint con valores válidos (cat_compra, gasto_fijo, gasto_variable, gasto_publicidad, gasto_comision, gasto_impuesto).
- UPDATE de `fn_conciliar_mp_con_factura_nueva`: hace lookup de la cat en `config_categorias` y guarda el tipo en bucket.

**Frontend:**
- `useCategorias`: nuevo map `categoriaToBucket` (cat → cat_compra/gasto_*). Cache key bumped v4→v5.
- Compras.tsx: dropdown "Categoría EERR" pasa a Combobox unificado con TODAS las cats agrupadas por tipo. Hint debajo muestra a qué bucket entrará.
- ConciliacionMP.tsx (modal "Crear factura nueva"): mismo Combobox unificado.
- EERR.tsx: clasifica facturas por bucket. `totalCMV` solo suma facturas con bucket=null o cat_compra. Las facturas con bucket=gasto_* suman a su tipo de gasto junto con la tabla `gastos`. El detalle por categoría también respeta el bucket.

**Decisión histórico:** facturas pre-2026-05-13 tienen bucket=null y EERR las trata como CMV (comportamiento previo). Sin migración de data. Reportes históricos se preservan.

**Migration aplicada:** sí.

---

### `b795a5f` — feat(retiros): agregar tipo "retiro_socio" como categoría aparte de gastos

Decisión contable: los retiros NO son gasto operativo — son distribución de utilidades, así que NO restan a Util. Neta. Aparecen en sección post-Util.Neta como info aparte. Solo se cargan via Gastos (no tienen factura).

- `useCategorias`: nuevo array `RETIROS_SOCIOS`. `retiro_socio` mantiene su nombre completo en `gastos.tipo` (no se transforma como `gasto_fijo→fijo`). Cache key bumped v5→v6.
- Configuración → Categorías de Gastos: `TIPOS_GASTO` incluye `{id:"retiro_socio", label:"Retiro de Socios"}`.
- Gastos.tsx: filtro de tipo agrega "Retiro de Socios". `catsByTipo` soporta `retiro_socio`.
- EERR.tsx: `totalRetiros` nuevo. Util. Neta NO incluye retiros. `utilNetaPostRetiros = utilNeta - totalRetiros` (lo que sobra al socio). Panel Resumen P&L: si hay retiros, agrega línea separada por dashed border + 2 filas debajo de Util. Neta. Detalle por categoría: nueva sección "RETIROS DE SOCIOS (post Util. Neta)".
- ConciliacionMP.tsx (modal Crear gasto nuevo): Combobox de categoría incluye grupo "Retiros de Socios".

**Sin migración SQL:** `gastos.tipo` y `config_categorias.tipo` son TEXT libres.

---

### `390b96b` — fix(compras): separar columna "Fecha · Vence" en dos columnas

Antes la tabla de facturas tenía una columna "Fecha · Vence" con dos fechas apiladas en la misma celda. Confuso visualmente. Ahora son dos columnas independientes: **Fecha** y **Vencimiento**. Color rojo en vencimiento cuando estado='vencida'.

---

### `9db42ad` — fix(facturas): derivar estado "vencida" en frontend cuando venc < hoy

`facturas.estado` solo se setea a "vencida" si hay un trigger SQL que lo actualice — y no existe. Resultado: facturas pendientes con fecha de vencimiento pasada quedaban con `estado='pendiente'` en DB; el filtro "Vencidas" en Compras, el badge rojo de la columna Vencimiento y el KPI de vencidas en Dashboard NO las mostraban.

**Solución:** helper `estadoFactura(f)` en `lib/utils.ts` que deriva al vuelo: si `estado==='pendiente'` y `venc < hoy` → "vencida". Sin trigger, sin race conditions, sin schedule.

Lugares actualizados: Compras.tsx (filtro de pills, badge de estado, color del vencimiento, agregación de pendientes/vencidas), Dashboard.tsx (KPI vencidas), Proveedores.tsx (estado de cuenta del proveedor + tabla Facturas Impagas).

---

### `bf18140` — feat(nc): aplicar notas de crédito a facturas con consumo trazable

Antes las NCs se cargaban como facturas con tipo='nota_credito', restaban del saldo global del proveedor pero NO había forma de aplicarlas a una factura puntual. `pagar_factura` las ignoraba y las NCs quedaban con `estado='pendiente'` para siempre, "disponibles" sin distinguir si ya se habían usado o no (bug #32 documentado en código).

Ahora: aplicación parcial trazable, NC consumida queda inhabilitada.

**Migration `202605140000_nc_aplicaciones.sql`:**
- Tabla puente `nc_aplicaciones` (nc_id, factura_id, monto, fecha, tenant_id, usuario_id) con RLS por tenant.
- RPC `aplicar_nc_a_factura(nc_id, factura_id, monto, fecha)`:
  - Lock con FOR UPDATE en NC y factura (race-safe).
  - Valida tenant, tipos, estados, mismo proveedor, saldos disponibles.
  - INSERT en `nc_aplicaciones`.
  - UPDATE `factura.pagos`: agrega objeto `{tipo:'nc', monto, nc_id, ...}`.
  - Recalcula `factura.estado`: si `SUM(pagos) >= total` → 'pagada'.
  - Si NC saldo restante = 0 → `NC.estado = 'pagada'` (consumida).
  - NO crea movimiento contable (no hay flujo de plata).

**Frontend (Compras.tsx modal de Pago):**
- Lista NCs disponibles del mismo proveedor con saldo > 0.
- Checkbox por NC + CurrencyInput para monto a aplicar (clampeado a `min(saldoNc, restanteFactura)`).
- Si las NCs cubren todo, oculta cuenta/monto de plata.
- Si queda saldo, muestra "Resta pagar con plata $X" + cuenta + monto.
- Al confirmar: corre `aplicar_nc_a_factura` por cada NC marcada, después `pagar_factura` por el restante (si hay).

**Migration aplicada:** sí.

---

## 2026-05-09 a 2026-05-11

### `2388fa3` — test(e2e): 6 mutantes + helper createDuenoClient + smoke/mutante project split

Stage 3 del plan E2E: 6 mutant specs cubriendo ventas_efectivo, gastos, facturas_cargar, facturas_pagar, sueldo_pagar y conciliacion_mp_egreso. Patrón establecido (`Local Prueba 2` + `Proveedor Prueba` + sentinel numérico distintivo + DB-only asserts estrictas + cleanup híbrido). Playwright separa proyectos: `smoke` paralelo (53 tests) y `mutante` serial (`--workers=1`, 6 tests). Helper `createDuenoClient` en `tests/helpers/supabaseClient.ts`.

---

### `435f664` — perf(bundle): F5 lazy-load 18 páginas + Suspense en App.tsx

F5 del plan sunny-creek. 21 imports eager en `App.tsx` migrados a `lazy()` + `<Suspense>`. Login queda eager (entry point). Bundle inicial: **1130 kB → 405 kB (-64%)**. LineChart de recharts (345 kB) se separa automático a chunk on-demand. Gate del 15% del plan pasa con margen.

---

### `7f53947` — fix(onboarding): refactor crear_tenant a endpoint serverless

La RPC original `crear_tenant` (migration 202604281205) crasheaba con `function digest(text, unknown) does not exist` al intentar onboardear el primer tenant nuevo. Dos bugs combinados:
1. pgcrypto está en schema `extensions` pero la RPC tiene `SET search_path = public`.
2. Aún arreglando search_path, el hash quedaba en `usuarios.password` legacy (Supabase Auth tomó su lugar en commit `3805ea7`). El dueño creado no podría loguear.

**Solución:** endpoint serverless `api/crear-tenant.js` con `SUPABASE_SERVICE_KEY` que (1) valida JWT del caller, (2) verifica que es superadmin, (3) crea `auth.user` via `auth.admin.createUser`, (4) llama RPC nueva `crear_tenant_v2` con el `p_auth_id` resultante, (5) hace rollback (`deleteUser`) si la RPC falla.

**Migration aplicada:** sí (`202605102318_rpc_crear_tenant_v2.sql`). La RPC vieja queda con `COMMENT 'DEPRECATED'`.

---

### `781c01d` — feat(tesoreria): F4 filtro fecha + paginación cursor + C6 useDebouncedValue

Bug reportado por Lucas: "En Tesorería no hay filtro de fechas y no sé si muestra todos los movimientos históricos o qué". Código tenía `.limit(80)` sin filtro fecha, mostrando los 80 movs más recientes — rango efectivo dependía del volumen del local (de días a semanas, sin claridad).

**Cambios en `Caja.tsx`:** 2 inputs date (desde/hasta) en panel header, default últimos 90 días. `queryMovimientos(offset, limit)` reutilizable con `.gte/.lte/.range`. `load()` primera página (80 filas). `loadMore()` concatena siguiente bloque. Contador "Mostrando X de Y+". Botón "Cargar más". Saldos NO se paginan ni filtran (son estado actual).

**Helper nuevo `src/lib/useDebouncedValue.ts`:** convención C6 del plan sunny-creek. Hook genérico `useDebouncedValue<T>(value, delayMs=300)` — evita flood de queries por tecla en inputs de búsqueda/filtro.

---

### `33080aa` — chore(api): eliminar 3 endpoints serverless one-shot legacy

**Root cause del incidente de deploy:** Vercel plan Hobby tiene límite hard de 12 serverless functions por deployment. El commit `7f53947` introdujo `api/crear-tenant.js` como la función #13. Build pasaba OK en logs pero "Deploying outputs..." fallaba con `state=ERROR` sin mensaje claro. Los deploys de `7f53947` y `781c01d` quedaron en ERROR, dejando prod corriendo `435f664` sin F4 ni el refactor de onboarding.

**Eliminadas (3 one-shots ya cumplidos, sin uso en `src/`):**
- `api/auth-hash-passwords.js` — hasheaba passwords legacy (pre-Auth).
- `api/auth-migrate-all.js` — creaba auth.users masivamente.
- `api/auth-setup.js` — bootstrap one-shot del dueño.

Total: 13 → 10 functions. 2 slots libres para futuras additions. Recuperables desde git history si en algún momento se necesita repetir el bootstrap.

---

### `71572a0` — docs(claude.md): registrar límite de 12 functions del plan Vercel Hobby

Convención agregada a `CLAUDE.md` para que el incidente no se repita. Incluye comando de conteo (`ls api/*.js | grep -v "^_" | grep -v "\.test\.js$" | wc -l`) y síntoma específico (`state=ERROR` justo después de "Deploying outputs..." sin error claro en build logs).

---

## 2026-05-11 (continuación — sesión Lucas despierto)

### `85ad834` — fix: remitos proveedor opcional + blindaje dedup + manejo de errores

Dos pedidos de Lucas vía WhatsApp.

**Remitos — proveedor ahora opcional:**
- `Compras.tsx::guardarRemito`: quitar `!remForm.prov_id` del guard.
- Form: label "Proveedor *" → "Proveedor", option default "Sin proveedor".
- INSERT manda `null` (no `NaN`) cuando no se selecciona proveedor.
- Migration `202605111400` (idempotente, doc retroactiva): la columna `remitos.prov_id` ya era nullable; queda en repo como decisión explícita.
- RPC `pagar_remito` ya manejaba `prov_id NULL` correctamente.

**Blindaje — causa raíz del "no deja modificar":**
- En DB había **5 tipos de documento duplicados** (IDs 6-10 copia exacta de 1-5, mismo nombre/orden/tenant). Al editar uno, el duplicado quedaba con el nombre viejo — parecía que "no se modificaba".
- Migration `202605111500` (aplicada): DELETE de duplicados (conservando id mínimo por `(tenant_id, nombre)`) + ADD UNIQUE constraint para prevenir futuros duplicados.
- Frontend `Blindaje.tsx`: agregar manejo de error con alert en `guardarTipo` / `eliminarTipo` / `guardarDoc`. Antes el modal se cerraba silenciosamente aunque la operación fallara. Error 23505 (UNIQUE violation) se traduce a "Ya existe un tipo con el nombre X".

---

### `137b84e` — feat(pwa): versión mínima — instalable desde el browser del celular

Lucas pidió "una app para usar desde el celu". Versión mínima del backlog (sin service worker, sin push).

- `packages/pase/public/manifest.webmanifest`: name=PASE, display=standalone (sin barra del browser), theme color violeta `#863bff` (matchea el favicon), background_color dark. Íconos apuntan al `favicon.svg` existente.
- `packages/pase/index.html`: title "Vite + React + TS" → "PASE", lang="es-AR", link al manifest, apple-touch-icon, meta theme-color, apple-mobile-web-app-capable + title, viewport con `viewport-fit=cover` para respetar el notch del iPhone en standalone.

**Cómo instalar:**
- Android Chrome: menú ⋮ → "Instalar app" / "Agregar a pantalla de inicio".
- iOS Safari: botón compartir → "Agregar a pantalla de inicio".

---

### `e3885c1` — feat(comanda): cerrar BLOCKERs #1 (IDOR caja) y #2 (total negativo) + catch-up schema

**Migration `202605111600` — `rrhh_pagos_especiales` catch-up retroactivo:**
Drift de schema descubierto en audit: columnas `monto_pagado` y `pendiente` existen en DB pero no estaban en migrations del repo (alguien las agregó manual). Las RPCs `pagar_vacaciones` y `pagar_aguinaldo` las usan en INSERT. Sin esta migration, si la DB se recrea desde cero las RPCs fallaban. Idempotente con `IF NOT EXISTS`.

**Migration `202605111700` — BLOCKERs de COMANDA (AUDITORIA_TECNICA_2026-05-07):**

*BLOCKER #2 — `fn_recalc_total_venta` total negativo (1 línea):*
`total = subtotal - descuento_total + propina` quedaba < 0 si el descuento supera `subtotal+propina`, y se propagaba a movimiento_caja como egreso fantasma. Fix: `GREATEST(0, ...)`.

*BLOCKER #1 — IDOR en RPCs de caja:*
`fn_abrir_turno_caja_comanda` y `fn_movimiento_caja_comanda` aceptaban `p_local_id` + `p_cajero_id/p_empleado_id` arbitrarios. Un encargado del Local A podía abrir un turno en el Local B asignando un cajero del Local B. Fix: helper `_check_local_y_empleado_comanda(local, empleado)` que valida (a) `p_local_id ∈ auth_locales_visibles()`, (b) empleado pertenece al tenant del caller, (c) si el empleado tiene `local_id` concreto, matchea. Dueño/admin/superadmin bypasean (a) pero NO (b)/(c). Empleados con `local_id` NULL (manager regional) pasan ok.

*Diferidos:* BLOCKER #3 (idempotency en 8 RPCs) — refactor mayor con cambio de signature. BLOCKER #4 (storage UUID prefix) — backfill grande, diferido hasta pre-onboarding del 2do tenant. `fn_anular_item_comanda` y `fn_aplicar_descuento_comanda` también están en BLOCKER #1 pero usan `p_manager_id` (override de otro local) — semántica distinta, análisis aparte.

**Verificado en prod:** 2 columnas presentes, 4 funciones actualizadas, helper privado creado.

---

## Decisiones de producto durables (NO en commits, pero relevantes)

### Compras vs Gastos
**Todo lo que tiene factura va por Compras** (incluye servicios MP/Rappi/AySA/Edenor). Gastos queda solo para egresos sin comprobante (propina, plata chica). Los proveedores de servicios se dan de alta una vez. Decisión 2026-05-08.

### Conciliación MP es pantalla administrativa pura
Los reportes de ventas (totales bruto/neto, ticket promedio, etc) viven en otra pantalla. Conciliación MP solo muestra Saldo MP + Dinero a liberar + Egresos a conciliar + Comisiones MP. Decisión 2026-05-07.

### Cashflow oculto
Pendiente reactivar cuando se resuelva el flujo de ingresos no-MP (probablemente con un importador de banco análogo al de Maxirest). Hoy solo cuenta ingresos de MercadoPago, faltan efectivo y banco.

---

## Cómo reactivar features ocultas

### Cashflow
1. Descomentar item en `Layout.tsx:39` (busca "Cashflow oculto temporalmente").
2. Descomentar entry en `auth.ts` MODULOS.
3. Restaurar `case "cashflow"` en `App.tsx` para que renderice `<Cashflow/>` en vez de `<Dashboard/>`.

### Cierre Comparativo
1. Descomentar item en `Layout.tsx` (busca "Cierre Comparativo fusionado").
2. Descomentar slug `cierre` en `auth.ts` MODULOS y agregarlo de vuelta a `ROLES.admin.permisos`.
3. Restaurar `case "cierre"` en `App.tsx` para que renderice `<Cierre/>` en vez de `<EERR/>`.
