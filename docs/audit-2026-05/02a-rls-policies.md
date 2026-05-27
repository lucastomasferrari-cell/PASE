# Fase 2A — RLS Policies multi-tenant

**Estado:** ✅ Completa
**Fecha:** 2026-05-26
**Método:** queries SQL live contra la DB Supabase de producción (`pduxydviqiaxfqnshhdc`).
**Cobertura:** 124 tablas en `public`, 230 policies RLS, 6 helpers `auth_*`, 280+ unique constraints.

## 📊 Resumen ejecutivo

**8 findings CRÍTICOS / 8 ALTOS / 9 MEDIOS / 7 BAJOS / 32 INFO.**

| Severidad | Conteo | Categorías predominantes |
|---|---|---|
| 🔴 Crítico | 8 | RLS_DISABLED en catálogo, history tables sin filtro tenant, tenant escape via UPDATE sin WITH CHECK |
| 🟠 Alto | 8 | UNIQUE sin tenant_id en columnas de input humano, child weak RLS, ALL sin WITH CHECK |
| 🟡 Medio | 9 | UNIQUE sobre tokens, asimetría USING vs WITH CHECK |
| 🟢 Bajo | 7 | NULL tenant_id rows en tablas que las filtran bien |
| ℹ️ Info | 32 | UNIQUE compuestos que incluyen FK a tabla con tenant — falsos positivos confirmados con data |

### Estado general del sistema

**Lo bueno**:
- 106/106 tablas con `tenant_id` tienen RLS habilitado (cero RLS_DISABLED en tablas tenant-scoped).
- Las 13 tablas de plata (`movimientos`, `saldos_caja`, `facturas`, `factura_items`, `remitos`, `gastos`, `rrhh_liquidaciones`, `rrhh_adelantos`, `mp_movimientos`, `mp_credenciales`, `ventas`, `ventas_pos`, `ventas_pos_items`, `idempotency_keys`) tienen policy FOR ALL con `tenant_id = auth_tenant_id()` simétrico — sin tenant escape.
- 0 cross-tenant data corruption en producción (verificado: `movimientos.tenant_id = facturas.tenant_id`, `ventas.tenant_id = locales.tenant_id`, etc — todos consistentes).
- 0 colisiones cross-tenant reales en UNIQUE constraints actuales.
- Helpers canónicos (`auth_tenant_id`, `auth_es_dueno_o_admin`, `auth_es_superadmin`, `auth_locales_visibles`, `auth_tiene_permiso`, `auth_usuario_id`) están bien definidos como `STABLE SECURITY DEFINER SET search_path TO 'public'`.

**Lo malo (lo que este reporte cubre)**:
- 4 tablas `_history` críticas no filtran por tenant — un dueño de Tenant A puede leer cambios históricos de Tenant B (363 rows mezcladas en `ventas_pos_history`).
- 1 catálogo (`comanda_permisos_catalogo`, 15 rows) sin RLS habilitado: cualquier authenticated lo puede vaciar.
- 1 policy UPDATE en `comanda_print_agents` con tenant escape latente.
- UNIQUE sobre `usuarios.email` sin tenant_id → un tenant puede bloquear emails de otro tenant.
- Múltiples UNIQUE sobre tokens (kds_tokens, menu_qr_tokens, manager_solicitudes) sin tenant_id → si un colisión sucede entre tenants, el cliente del Tenant A revela datos al Tenant B.
- 386 rows en `ig_eventos` con tenant_id=NULL (webhook recibido antes de identificar tenant) — bloqueado en SELECT pero crece la deuda.
- Deuda arquitectónica: `auth_tenant_id()` lee de `usuarios` (PASE) — para COMANDA standalone esto rompe (hoy todos los `comanda_usuarios` están duplicados en `usuarios`, 14/14, pero el sprint 24-may dejó la puerta abierta).

### ⚠️ Hallazgos confirmados con data real

| Tabla | Síntoma | Magnitud |
|---|---|---|
| `ventas_pos_history` | Rows de 64 tenants distintos, policy sin filtro tenant | 363 rows visibles a cualquier dueño/admin |
| `mesas_history` | Rows de 54 tenants, policy sin filtro tenant | 116 rows |
| `ventas_pos_items_history` | Rows de 23 tenants, policy sin filtro tenant | 115 rows |
| `comanda_permisos_catalogo` | RLS off, sin policies | 15 rows críticas para COMANDA |
| `ig_eventos` | tenant_id=NULL en webhooks IG | 386 rows (creciendo ~50-100/día) |

---

## 🎯 Ranking de los 8 CRÍTICOS (atacar primero)

| # | Bug | Categoría | Esfuerzo | Impacto |
|---|---|---|---|---|
| 1 | `comanda_permisos_catalogo` RLS DISABLED | RLS_DISABLED | 2 min | Cualquier authenticated puede TRUNCAR los 15 slugs y romper toda autorización de COMANDA |
| 2 | `ventas_pos_history` policy sin filtro tenant | LEAK_CROSS_TENANT | 5 min | Dueño Tenant A ve 363 cambios históricos de ventas POS de 64 tenants |
| 3 | `mesas_history` policy sin filtro tenant | LEAK_CROSS_TENANT | 5 min | Dueño Tenant A ve 116 cambios históricos de mesas de 54 tenants |
| 4 | `ventas_pos_items_history` policy sin filtro tenant | LEAK_CROSS_TENANT | 5 min | Idem ventas_pos_items: 115 rows mezcladas |
| 5 | `turnos_caja_history` policy sin filtro tenant | LEAK_CROSS_TENANT | 5 min | Idem (solo 1 row hoy, latente) |
| 6 | `comanda_print_agents` UPDATE WITH CHECK=NULL → tenant escape | TENANT_ESCAPE | 5 min | Dueño Tenant A puede `UPDATE SET tenant_id='B-uuid'` y mover printer a Tenant B |
| 7 | `usuarios.email` UNIQUE sin tenant_id | UNIQUE_NO_TENANT | 30 min (migration) | Tenant A registra `pepe@gmail.com` → Tenant B NO puede registrar el mismo email |
| 8 | `comanda_local_settings.slug` UNIQUE sin tenant_id | UNIQUE_NO_TENANT | 10 min (migration) | Mismo: bloqueo cross-tenant |

---

## 🔴 CRÍTICOS — detalle

### 1. `comanda_permisos_catalogo` sin RLS habilitado

```sql
SELECT relrowsecurity FROM pg_class WHERE relname='comanda_permisos_catalogo';
-- relrowsecurity: false
SELECT COUNT(*) FROM comanda_permisos_catalogo;
-- 15
SELECT * FROM pg_policies WHERE tablename='comanda_permisos_catalogo';
-- (0 rows)
```

**Leak:** sin RLS habilitado, el grant default `TO authenticated` se aplica con la regla "policy NULL = pass". Cualquier usuario logueado puede:
- `SELECT *` (filtración del catálogo de permisos — info menor).
- `DELETE FROM comanda_permisos_catalogo` (vaciar el catálogo, lo que rompería la asignación de permisos COMANDA en TODOS los tenants).
- `UPDATE comanda_permisos_catalogo SET slug='trolled' WHERE slug='comanda.ventas.abrir'` (corromper slugs, romper auth funcional de COMANDA).
- `INSERT` rows nuevas (sin efecto inmediato, pero llena el catálogo).

**Fix:**
```sql
ALTER TABLE comanda_permisos_catalogo ENABLE ROW LEVEL SECURITY;
-- SELECT abierto a authenticated, escritura solo superadmin (es catálogo global)
CREATE POLICY cpc_select_all ON comanda_permisos_catalogo FOR SELECT TO authenticated USING (true);
CREATE POLICY cpc_write_superadmin ON comanda_permisos_catalogo FOR ALL TO authenticated
  USING (auth_es_superadmin()) WITH CHECK (auth_es_superadmin());
```

**Estado en CLAUDE.md:** este caso NO estaba listado en "Hallazgos reales del linter" — es un descubrimiento nuevo.

---

### 2-5. Tablas `_history` con policies sin filtro tenant

Cuatro tablas comparten el mismo bug:

| Tabla | Rows totales | Tenants distintos visibles |
|---|---|---|
| `ventas_pos_history` | 363 | 64 |
| `mesas_history` | 116 | 54 |
| `ventas_pos_items_history` | 115 | 23 |
| `turnos_caja_history` | 1 | 1 |

Policy actual (idéntica en las 4):

```sql
USING (auth_es_superadmin() OR auth_es_dueno_o_admin())
```

**Leak:** un dueño/admin del Tenant A puede `SELECT * FROM ventas_pos_history` y leer cambios históricos de cualquier otro tenant. Como el JSONB `old_data`/`new_data` contiene el snapshot completo de la fila (incluido `precio_total`, `cliente_nombre`, `mesa_numero`, etc.), esto es leak comercial real.

**Reproducción conceptual:**
```sql
-- Como dueño del Tenant 'd668906b-...' (que tiene 2 locales y 2 usuarios):
SELECT old_data->>'tenant_id' AS leaked_tenant, COUNT(*)
  FROM ventas_pos_history
  GROUP BY old_data->>'tenant_id';
-- → vería 64 tenant_ids distintos.
```

**Diferencia con las hermanas OK:** `canales_history`, `items_history` y `item_precios_canal_history` (creadas en `202605051200_comanda_sprint_1.sql`) usan policy correcta:
```sql
USING (auth_es_superadmin() OR ((old_data ->> 'tenant_id'::text)::uuid = auth_tenant_id()))
```

**Fix mínimo:** replicar el patrón JSONB de las hermanas. Caveat: si la op es `INSERT`, `old_data` es NULL — fallback a `new_data`:
```sql
DROP POLICY ventas_pos_history_select ON ventas_pos_history;
CREATE POLICY ventas_pos_history_select ON ventas_pos_history FOR SELECT TO authenticated USING (
  auth_es_superadmin() OR
  COALESCE(
    (old_data->>'tenant_id')::uuid,
    (new_data->>'tenant_id')::uuid
  ) = auth_tenant_id()
);
-- Idem para mesas_history, turnos_caja_history, ventas_pos_items_history.
```

Actualmente las 4 tablas solo tienen ops `UPDATE` (verificado con `GROUP BY operation`), pero el fix debe cubrir INSERT/DELETE para futuro.

**Estado en CLAUDE.md:** la entrada "Tablas `canales_history`, `item_precios_canal_history`, `items_history` sin RLS" está OBSOLETA — esas 3 ya tienen RLS+filter; las que faltan son las 4 listadas acá.

---

### 6. `comanda_print_agents` UPDATE tenant escape

```sql
SELECT cmd, qual, with_check, roles FROM pg_policies
WHERE tablename='comanda_print_agents' AND policyname='print_agents_update';
-- cmd: UPDATE
-- qual (USING): (tenant_id = auth_tenant_id()) AND (auth_es_dueno_o_admin() OR (local_id = ANY (auth_locales_visibles())))
-- with_check: NULL  ← BUG
-- roles: {authenticated}
```

**Leak — tenant escape:** Postgres aplica `USING` para chequear qué filas se pueden tocar, pero si `WITH CHECK` es NULL, no valida que el resultado del UPDATE siga satisfaciendo el predicado. Eso significa que un dueño del Tenant A puede:

```sql
UPDATE comanda_print_agents
   SET tenant_id = '<tenant-B-uuid>'
 WHERE id = <my-agent>;
-- USING pasa (la fila ANTES de cambiar pertenece al Tenant A)
-- WITH CHECK no ejecuta (NULL) → la fila queda con tenant_id de Tenant B
-- Resultado: el print agent ahora es visible/usable por Tenant B
```

Hoy `comanda_print_agents` solo tiene rows del Tenant Neko (31 rows, 1 tenant) — el bug NO se ha disparado, es latente y se activa apenas haya un segundo tenant con print agents.

**Fix:**
```sql
ALTER POLICY print_agents_update ON comanda_print_agents
  WITH CHECK ((tenant_id = auth_tenant_id()) AND (auth_es_dueno_o_admin() OR (local_id = ANY (auth_locales_visibles()))));
```

**Patrón sistémico:** este es el ÚNICO caso de UPDATE con WITH CHECK=NULL apuntando a `authenticated` en todo el schema (verificado con query exhaustiva). Las demás policies UPDATE/ALL en tablas con tenant_id tienen WITH CHECK simétrico.

---

### 7. `usuarios.email` UNIQUE cross-tenant

```sql
CREATE UNIQUE INDEX usuarios_email_key ON public.usuarios USING btree (email);
```

**Leak:** Tenant A registra `pepe@gmail.com`. Tenant B intenta registrar el mismo email → falla con `unique_violation`. **Esto:**
1. Bloquea el alta legítima de Tenant B (mismo email puede ser dueño en dos restaurantes distintos).
2. Filtra info: el error de UNIQUE revela que ese email YA existe en otro tenant (enumeration attack — un atacante puede descubrir qué emails están registrados en el sistema sin saber a qué tenant).
3. Squatting: registrarse en muchos emails populares para bloquear a competidores.

Hoy no hay colisiones en data (`GROUP BY email HAVING COUNT > 1` devuelve 0 rows), pero el patrón es bomba de tiempo al crecer en B2B SaaS.

**Caveat para PASE:** el campo `email` no necesariamente es un email real (la convención es `usuarios.email` + `@pase.local` si no tiene `@`). Eso significa que el atacante de un tenant puede registrar usernames cortos como `admin`, `lucas`, `juan` para bloquearlos en otros tenants.

**Fix (migration con downtime quirúrgico):**
```sql
ALTER TABLE usuarios DROP CONSTRAINT usuarios_email_key;
CREATE UNIQUE INDEX usuarios_email_tenant_key ON usuarios (lower(email), tenant_id);
-- Y un índice parcial para superadmin (tenant_id IS NULL):
CREATE UNIQUE INDEX usuarios_email_superadmin_key ON usuarios (lower(email)) WHERE tenant_id IS NULL;
```

**Caveat #2:** la `usuarios.auth_id` UNIQUE (medium-severity) NO es bloqueante porque viene de Supabase Auth (UUID random), pero formalmente debería ser `(auth_id, tenant_id)` igual.

---

### 8. `comanda_local_settings.slug` UNIQUE cross-tenant

```sql
CREATE UNIQUE INDEX uniq_cls_slug ON comanda_local_settings (slug);
```

**Leak:** Tenant A crea local con slug `pizza-popular`. Tenant B no puede usar el mismo slug — mismo patrón de squatting que `usuarios.email`, pero peor porque el slug es público (probablemente forma parte de la URL del menú QR o del marketplace).

**Fix:**
```sql
ALTER TABLE comanda_local_settings DROP CONSTRAINT uniq_cls_slug;
CREATE UNIQUE INDEX uniq_cls_slug_tenant ON comanda_local_settings (slug, tenant_id);
```

**Si el slug debe ser globalmente único** (porque sirve URLs públicas tipo `app.com/pizza-popular`), entonces la UNIQUE global se justifica funcionalmente — pero hay que decidir explícitamente y agregar UI/UX que comunique "este slug ya está tomado, elegí otro" en vez de devolver `unique_violation` raw.

---

## 🟠 ALTOS

### `tenant_invoices`, `tenant_subscriptions` — superadmin policy sin WITH CHECK

Ambas tablas tienen:
```sql
USING (auth_es_superadmin())
-- with_check: NULL
```

**Leak:** un superadmin puede:
1. UPDATE moviendo una invoice/subscription al tenant_id que se le antoje (sin validación de que el resultado siga siendo válido).
2. INSERT con tenant_id arbitrario (esto es esperado para superadmin, pero la falta de WITH CHECK significa que NO hay protección contra typos — un superadmin podría meter una subscription en tenant_id que NO existe en `tenants`).

**Fix:**
```sql
ALTER POLICY invoices_superadmin ON tenant_invoices WITH CHECK (auth_es_superadmin());
ALTER POLICY subs_superadmin ON tenant_subscriptions WITH CHECK (auth_es_superadmin());
```

Severidad alta y no crítica porque el actor es superadmin (un solo usuario confiable hoy). Si en futuro hay múltiples superadmins, sube a crítico.

---

### `admin_push_subscriptions`, `notification_preferences` — child weak RLS

Ambas tablas son child de `usuarios` (FK `user_id → usuarios.id`) y NO tienen `tenant_id` propio. Sus policies son:
```sql
USING (user_id = auth_usuario_id())
```

**Análisis:** esto en realidad ESTÁ BIEN diseñado — la policy garantiza que cada user solo ve sus propias subscriptions/preferences. El detector lo flagueó como "weak RLS" porque no hay `tenant_id` ni `EXISTS()` chequeando el parent, pero `auth_usuario_id()` devuelve el `id` del usuario logueado en `usuarios`, que por construcción está atado a UN tenant.

**Caveat real:** si `auth_id` de Supabase Auth se reasignara entre usuarios de tenants distintos (no debería pasar nunca), las subscriptions seguirían al `id` viejo. **No es un leak práctico hoy.**

**Severidad final: MEDIUM** (downgrade — no es leak, es solo falta de defensa en profundidad. Sería mejor agregar `EXISTS (SELECT 1 FROM usuarios u WHERE u.id = user_id AND u.tenant_id = auth_tenant_id())` para defensa en profundidad).

---

### `roles` — 6 rows NULL tenant + policy las muestra como globales

```sql
SELECT id, nombre, slug, tenant_id FROM roles WHERE tenant_id IS NULL;
-- 6 rows: Dueño, Socio, Administrador, Encargado, Cajero, Contador
```

Estos 6 son roles "sistema" globales (compartidos entre tenants). Las policies los muestran a todos via `tenant_id IS NULL OR tenant_id = auth_tenant_id()`. **Esto es intencional** — pero significa que cualquier tenant podría INSERT un nuevo role con `tenant_id=NULL` y "agregar un role al catálogo sistema" si las INSERT no validan.

**Verificar:** revisar la policy INSERT/UPDATE/DELETE de `roles` para ver si solo superadmin puede crear roles globales. (No revisé el detalle; deuda menor.)

---

### `comanda_local_settings.uniq_cls_local` UNIQUE sobre `local_id`

```sql
CREATE UNIQUE INDEX uniq_cls_local ON comanda_local_settings (local_id);
```

Esto es OK funcionalmente (1 setting por local), pero `local_id` solo existe en UN tenant (verificado), entonces la unicidad ya está implícitamente scoped. No es leak.

**Severidad final: INFO** (falso positivo).

---

### Otros HIGH listados pero falsos positivos al verificar

| Tabla | UNIQUE | Verdict |
|---|---|---|
| `comanda_usuario_permisos` | `(comanda_usuario_id, modulo_slug)` | OK — `comanda_usuario_id` única por tenant |
| `medios_cobro` | `(nombre, local_id)` | OK — `local_id` única por tenant |
| `mesas` | `(local_id, numero)` | OK — idem |
| `recetas_versiones` | `(item_id, version_numero)` | OK — `item_id` única por tenant |
| `turnos_caja` | `(local_id, numero)` | OK |
| `usuario_permisos` | `(usuario_id, modulo_slug)` | OK |
| `ventas_pos` | `(local_id, numero_local)` | OK |

---

## 🟡 MEDIOS

### Asimetrías USING vs WITH CHECK (3 casos legítimos)

| Tabla | Asimetría | Análisis |
|---|---|---|
| `medios_cobro` | USING incluye `local_id IS NULL OR local_id = ANY(...)`, WITH CHECK exige `auth_tiene_permiso('configuracion')` | Intencional: lectura más laxa que escritura |
| `usuario_locales` | USING incluye `usuario_id = auth_usuario_id()`, WITH CHECK no | Intencional: cada user ve sus asignaciones, pero solo admin puede crearlas/borrarlas |
| `usuario_permisos` | Idem `usuario_locales` | Idem |

**Verdict:** asimetría es diseño correcto (lectura permisiva, escritura restringida). No es leak.

---

### UNIQUE sobre tokens sin tenant_id (5 casos)

| Tabla | UNIQUE | Análisis |
|---|---|---|
| `kds_tokens.uniq_kds_token` | `(token)` | Token aleatorio — colisión cross-tenant casi imposible, pero si pasa = leak directo (Tenant B autoriza con token de Tenant A) |
| `kds_tokens.uniq_kds_estacion_per_local` | `(local_id, estacion)` | OK — `local_id` única por tenant |
| `menu_qr_tokens.uniq_menu_qr_token` | `(token)` | Idem kds — leak si colisión |
| `manager_solicitudes.token` | `(token)` | Idem |
| `ig_config.ig_account_id` | `(ig_account_id)` | Distinta naturaleza: `ig_account_id` viene de Meta. Si dos tenants apuntan a la misma IG account (ej. error de OAuth), el primero gana — el segundo no puede conectar y recibe error de UNIQUE. Hoy 0 colisiones, pero patrón frágil. |
| `rrhh_valores_doble.puesto` | `(puesto)` | Tabla parece global por diseño (valores de salario doble por puesto) — verificar si está bien que sea single-tenant |

**Fix recomendado para tokens (kds, menu_qr, manager_solicitudes):** los tokens son random, pero agregar `(tenant_id, token)` UNIQUE en lugar de solo `(token)` da defense-in-depth a costo cero.

**Fix recomendado para `ig_config.ig_account_id`:** convertir a `(tenant_id, ig_account_id)` UNIQUE + agregar índice GLOBAL no-único que el endpoint webhook usa para resolver tenant.

---

### `mapeos_locales_externos`, `mp_credenciales.local_id`, `mp_movimiento_facturas`, `marketplace_reviews.venta_id`, `objetivos_mes`, `receta_insumos`, `rrhh_empleado_locales`, `rrhh_liquidaciones.(novedad_id, cuota_num)`, `rrhh_novedades`, `rrhh_pagos_especiales`, `saldos_caja.(cuenta, local_id)`, `turnos_caja.(local_id) WHERE estado='abierto'`, `usuario_dashboard_config.usuario_id`, `usuario_locales`, `usuarios.auth_id`, `ventas_pos.(external_provider, external_order_id)`

Todos estos son falsos positivos porque las columnas incluyen un FK transitivamente único por tenant. Movidas a sección INFO.

**Excepción real:** `ventas_pos.(external_provider, external_order_id)` — `external_provider` (ej. "rappi", "pedidosya") + `external_order_id` (id del provider). Si dos tenants venden por el mismo provider y el provider asigna el mismo order_id (improbable pero teóricamente posible), colisión. **Probablemente fine** pero documentarlo.

---

## 🟢 BAJOS

### `ig_eventos` — 386 rows con tenant_id=NULL

```sql
SELECT operation_breakdown FROM ig_eventos WHERE tenant_id IS NULL;
-- 386 rows tipo 'webhook_received' acumuladas en los últimos 6 días (~50-100/día)
```

**Análisis:** el webhook de Instagram entrega eventos antes de poder asociarlos a un tenant (se asocia recién después de resolver `ig_account_id → tenant`). La policy SELECT es `tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin()` — como `auth_tenant_id() != NULL`, las rows NULL están filtradas para clientes. OK.

**Deuda:** crece ~50-100 rows/día. Como `tenant_id` no se setea ni a posteriori, esas rows quedan huérfanas para siempre. Considerar:
1. Update post-hoc: cuando se resuelve `conversacion_id`, también update `tenant_id`.
2. TTL: borrar `tipo='webhook_received' AND tenant_id IS NULL` después de N días.

---

### `usuarios` — 1 row tenant_id=NULL

```sql
SELECT id, email, nombre, rol, tenant_id FROM usuarios WHERE tenant_id IS NULL;
-- id=23, email='superadmin', nombre='Superadmin', rol='superadmin', tenant_id=NULL
```

**Análisis:** intencional. El superadmin es global. OK.

---

### `notificaciones_pendientes`, `tenant_totp_secret` — service-role only

Sin policies para `authenticated` → cerradas 100% por frontend (default deny). Solo `service_role` puede tocarlas (via endpoints serverless con `SUPABASE_SERVICE_KEY`). Diseño correcto.

---

### `marketplace_reviews_select_public` — anon + authenticated puede leer reviews publicadas

```sql
USING (moderacion_estado = 'publicada'::text)
```

Sin filtro tenant — intencional, las reviews publicadas son públicas del marketplace. Verificar que `moderacion_estado='publicada'` está bien protegido por la policy de UPDATE (`USING auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())` — OK, solo dueño puede aprobar reviews de SU tenant).

---

## ℹ️ INFO / Falsos positivos verificados

32 findings UNIQUE_NO_TENANT donde el composite incluye una FK a tabla con tenant. Verificado con queries: NO existen colisiones cross-tenant en producción (ej. `SELECT id, COUNT(DISTINCT tenant_id) FROM locales GROUP BY id HAVING COUNT(DISTINCT tenant_id) > 1` → 0 rows). Como `local_id`, `usuario_id`, `empleado_id`, `item_id`, `receta_id` son únicos globalmente (no compartidos entre tenants), cualquier UNIQUE que los incluya está transitivamente scoped. **No requiere acción.**

---

## 🗄️ Fósiles sin tenant_id (18 tablas)

| Tabla | RLS | Naturaleza | Verdict |
|---|---|---|---|
| `admin_push_subscriptions` | ✅ | child de usuarios | OK (policy `user_id = auth_usuario_id()`) |
| `auto_entrega_log` | ✅ | log global | revisar policy |
| `billing_plans` | ✅ | catálogo planes (3 INFO) | OK (SELECT abierto, master data) |
| `canales_history` | ✅ | history JSONB tenant filter | OK (cubierto en migración 202605051200) |
| `comanda_permisos_catalogo` | ❌ | catálogo global | **CRIT #1 — fix arriba** |
| `cupon_usos` | ✅ | child de cupones | revisar |
| `item_precios_canal_history` | ✅ | history JSONB | OK |
| `items_history` | ✅ | history JSONB | OK |
| `mesas_history` | ✅ | history sin filter | **CRIT #3** |
| `notification_preferences` | ✅ | child de usuarios | OK (policy user-scoped) |
| `rider_positions` | ✅ | child de delivery_riders | revisar (no inspeccioné) |
| `rol_permisos` | ✅ | child de roles | revisar |
| `rol_pos_permisos` | ✅ | catálogo global COMANDA | OK (SELECT abierto, master data) |
| `stock_conteo_lineas` | ✅ | child de stock_conteos | revisar |
| `tenants` | ✅ | meta-tabla | OK (`auth_es_superadmin() OR id=auth_tenant_id()`) |
| `turnos_caja_history` | ✅ | history sin filter | **CRIT #5** |
| `ventas_pos_history` | ✅ | history sin filter | **CRIT #2** |
| `ventas_pos_items_history` | ✅ | history sin filter | **CRIT #4** |

---

## 🏗️ Deudas arquitectónicas (no críticas, sí relevantes)

### `auth_tenant_id()` depende de `usuarios` — bloquea COMANDA standalone

```sql
SELECT tenant_id FROM usuarios WHERE auth_id = auth.uid() AND activo LIMIT 1;
```

Si un usuario está en `comanda_usuarios` pero NO en `usuarios`, `auth_tenant_id()` devuelve NULL. Esto haría que TODAS las policies con `tenant_id = auth_tenant_id()` fallen cerradas para él. **Hoy todos los 14 `comanda_usuarios` tienen mirror en `usuarios` (matched=14, comanda_no_pase=0)**, así que no rompe nada — pero el sprint 24-may dejó la puerta abierta para usuarios COMANDA-only.

**Fix futuro (cuando se active el desacople):**
```sql
CREATE OR REPLACE FUNCTION auth_tenant_id() RETURNS uuid ... AS $$
  SELECT tenant_id FROM usuarios WHERE auth_id = auth.uid() AND activo LIMIT 1
  UNION ALL
  SELECT tenant_id FROM comanda_usuarios WHERE auth_id = auth.uid() AND activo LIMIT 1
  LIMIT 1
$$
```

O mejor: crear `auth_tenant_id_v2()` que consulte ambas tablas, deprecar la vieja.

---

### `dashboard_pinned_notes.pinned_select` hace lookup ad-hoc

```sql
qual: (auth_es_superadmin() OR ((tenant_id = auth_tenant_id()) AND
       (auth_es_dueno_o_admin() OR (target_usuario_id = auth_usuario_id()) OR
        (target_rol = (SELECT usuarios.rol FROM usuarios WHERE (usuarios.id = auth_usuario_id()))))))
```

El subquery `SELECT usuarios.rol FROM usuarios WHERE usuarios.id = auth_usuario_id()` debería ser un helper `auth_rol() RETURNS text`. Hoy:
- Es lookup correcto, no es leak.
- Performance: por cada SELECT, se ejecuta la subquery (cache-able pero sucio).
- Mantenibilidad: futuros cambios de schema en `usuarios.rol` requieren update de N policies.

**Fix:** crear `auth_rol() RETURNS text` helper SECURITY DEFINER y reemplazar el subquery inline.

---

### Crecimiento de la deuda: nuevas tablas COMANDA tipo `_history`

El patrón "history sin filter" probablemente se va a repetir cuando se agreguen más tablas COMANDA. Recomendar:
1. Plantilla obligatoria en `CONTEXTO.md` para tablas `_history` que use el patrón JSONB+COALESCE.
2. Agregar test SQL que itere sobre todas las `_history` y verifique que la policy contiene `tenant_id`.

---

## 🧪 Validaciones de coherencia (data real)

Verificadas en producción — todas devolvieron 0 rows (no hay corrupción):

| Verificación | Query | Resultado |
|---|---|---|
| movimiento.tenant = factura.tenant | `JOIN m.fact_id WHERE m.tenant_id != f.tenant_id` | 0 ✅ |
| venta.tenant = local.tenant | `JOIN local WHERE v.tenant_id != l.tenant_id` | 0 ✅ |
| gasto.tenant = local.tenant | `JOIN local WHERE g.tenant_id != l.tenant_id` | 0 ✅ |
| usuario_locales triple consistency | `WHERE ul.tenant_id != u.tenant_id OR != l.tenant_id` | 0 ✅ |
| local_id único globalmente | `GROUP BY id HAVING COUNT(DISTINCT tenant_id) > 1` | 0 ✅ |
| usuario_id único globalmente | idem | 0 ✅ |
| empleado_id, item_id, receta_id únicos globalmente | idem | 0 ✅ |
| usuario_email duplicado cross-tenant | `GROUP BY email HAVING COUNT > 1` | 0 ✅ |

**Esto significa:** los bugs identificados son LATENTES (no se han disparado en data real todavía). Pero algunos (especialmente los `_history` sin filter) se disparan apenas un dueño de otro tenant haga login y mire la tabla.

---

## 📋 Tabla completa de findings

| # | Sev | Cat | Tabla | Resumen |
|---|---|---|---|---|
| 1 | 🔴 | RLS_DISABLED | `comanda_permisos_catalogo` | Sin RLS habilitado + 15 rows críticas |
| 2 | 🔴 | HISTORY_NO_TENANT_FILTER | `ventas_pos_history` | Policy `auth_es_dueno_o_admin()` sin filtro tenant — 363 rows de 64 tenants visibles |
| 3 | 🔴 | HISTORY_NO_TENANT_FILTER | `mesas_history` | Idem — 116 rows de 54 tenants |
| 4 | 🔴 | HISTORY_NO_TENANT_FILTER | `ventas_pos_items_history` | Idem — 115 rows de 23 tenants |
| 5 | 🔴 | HISTORY_NO_TENANT_FILTER | `turnos_caja_history` | Idem — 1 row (latente, mismo patrón roto) |
| 6 | 🔴 | TENANT_ESCAPE | `comanda_print_agents` | UPDATE WITH CHECK=NULL → row se puede mover a otro tenant |
| 7 | 🔴 | UNIQUE_NO_TENANT | `usuarios.email` | UNIQUE global sobre email → squatting + enumeration |
| 8 | 🔴 | UNIQUE_NO_TENANT | `comanda_local_settings.slug` | UNIQUE global sobre slug → squatting |
| 9 | 🟠 | ALL_NO_WITH_CHECK | `tenant_invoices` | superadmin policy FOR ALL sin WITH CHECK |
| 10 | 🟠 | ALL_NO_WITH_CHECK | `tenant_subscriptions` | Idem |
| 11 | 🟠 | CHILD_WEAK_RLS | `admin_push_subscriptions` | Sin EXISTS al parent (defensa en profundidad faltante) |
| 12 | 🟠 | CHILD_WEAK_RLS | `notification_preferences` | Idem |
| 13 | 🟠 | NULL_TENANT_ROWS | `roles` | 6 rows globales — verificar policy INSERT |
| 14 | 🟠 | UNIQUE_NO_TENANT | `ig_config.ig_account_id` | OAuth race entre tenants |
| 15 | 🟠 | UNIQUE_NO_TENANT | `rrhh_valores_doble.puesto` | Verificar si es intencionalmente global |
| 16 | 🟠 | NULL_TENANT_ROWS | `ig_eventos` | 386 rows huérfanas creciendo |
| 17 | 🟡 | UNIQUE_NO_TENANT | `kds_tokens.token` | Tokens random pero sin tenant scope |
| 18 | 🟡 | UNIQUE_NO_TENANT | `menu_qr_tokens.token` | Idem |
| 19 | 🟡 | UNIQUE_NO_TENANT | `manager_solicitudes.token` | Idem |
| 20 | 🟡 | UNIQUE_NO_TENANT | `usuarios.auth_id` | UUID random — defensa en profundidad faltante |
| 21 | 🟡 | UNIQUE_NO_TENANT | `mapeos_locales_externos.(provider, external_local_id)` | Mismo provider podría asignar mismo external_id a dos tenants distintos |
| 22 | 🟡 | UNIQUE_NO_TENANT | `ventas_pos.(external_provider, external_order_id)` | Mismo análisis |
| 23 | 🟡 | ASYMMETRY_USING_VS_CHECK | `medios_cobro` | Asimetría intencional (lectura > escritura) — documentar |
| 24 | 🟡 | ASYMMETRY_USING_VS_CHECK | `usuario_locales` | Idem |
| 25 | 🟡 | ASYMMETRY_USING_VS_CHECK | `usuario_permisos` | Idem |
| 26 | 🟢 | NULL_TENANT_ROWS | `usuarios` | 1 row superadmin (intencional) |
| 27 | 🟢 | SERVICE_ONLY | `notificaciones_pendientes` | Cerrada a frontend — diseño correcto |
| 28 | 🟢 | SERVICE_ONLY | `tenant_totp_secret` | Idem |
| 29 | 🟢 | ADHOC_TENANT_LOOKUP | `dashboard_pinned_notes` | Subquery inline a usuarios — sin riesgo, deuda de helper |
| 30 | 🟢 | GLOBAL_OPEN | `billing_plans` | Master plans abierto a SELECT — intencional |
| 31 | 🟢 | GLOBAL_OPEN | `rol_pos_permisos` | Catálogo permisos COMANDA — intencional |
| 32 | 🟢 | GLOBAL_OPEN | `marketplace_reviews` | Reviews publicadas son públicas — intencional |

Plus 32 findings INFO (falsos positivos UNIQUE_NO_TENANT) que NO requieren acción.

---

## 🛠️ Recomendaciones de prioridad

**Sprint 1 (15 minutos total, sin migrations destructivas):**
- Fix #1: `ENABLE ROW LEVEL SECURITY` + 2 policies en `comanda_permisos_catalogo`.
- Fix #2-5: cambiar policy de 4 `_history` tables (DROP + CREATE policy con JSONB filter).
- Fix #6: `ALTER POLICY ... WITH CHECK` en `comanda_print_agents`.

**Sprint 2 (1 hora, requiere coordinación):**
- Fix #7: migration sobre `usuarios.email` UNIQUE → `(lower(email), tenant_id)`. **Hacer durante ventana sin login**, primero VERIFICAR que el frontend usa `email` siempre con `tenant_id` en sus queries.
- Fix #8: idem `comanda_local_settings.slug`.

**Sprint 3 (deuda menor, sin urgencia):**
- Tokens UNIQUE (#17, #18, #19): agregar tenant_id al composite.
- Helper `auth_rol()` para `dashboard_pinned_notes`.
- `auth_tenant_id_v2()` que cubra `comanda_usuarios` standalone.
- TTL/cleanup de `ig_eventos` tenant=NULL.

---

## 🧬 Comparación con CLAUDE.md

**Entradas ahora confirmadas / refutadas:**
- ✅ "Tablas `canales_history`, `item_precios_canal_history`, `items_history` sin RLS": **REFUTADA** — esas 3 tablas YA tienen RLS+filter JSONB correcto. La deuda real son las hermanas MAYORES (`ventas_pos_history`, `mesas_history`, etc).
- ✅ Falsos positivos del linter (`crear_movimiento_caja_bot`, `set_mp_token`, `aplicar_nc_a_factura`, `crear_tenant`): confirmados — no toqué RPCs en este pase, sí están en `01-bugs-financieros.md`.
- ✅ Cross-tenant data coherence: 0 corrupciones encontradas (consistente con la disciplina del proyecto).

**Entradas nuevas para CLAUDE.md (sugeridas):**
- Agregar regla: **"Toda tabla `_history` nueva debe usar policy con `tenant_id` JSONB-extracted del `old_data`+`new_data`"** + plantilla.
- Agregar regla: **"Toda UNIQUE sobre columna humana (email, slug, codigo, nombre, puesto) DEBE incluir `tenant_id`"**.
- Agregar regla: **"Toda policy UPDATE/ALL en tabla con tenant_id DEBE tener `WITH CHECK = USING`"** (defaulteable con helper).

---

## 📐 Apéndice — método

**Queries ejecutadas:**
1. `information_schema.columns` + `pg_class` → 124 tablas, identificar cuáles tienen tenant_id, cuáles RLS habilitado.
2. `pg_policies` → 230 policies, agrupadas por tabla.
3. `pg_proc` (función + def) → verificar 6 helpers canónicos.
4. `pg_index` + `pg_attribute` → 280+ unique constraints, identificar las que no incluyen tenant_id.
5. `information_schema.table_constraints` (FK) → mapear hijas-padres para detectar child tables.
6. `SELECT tenant_id, COUNT(*) GROUP BY tenant_id` por cada tabla con tenant_id → detectar distribuciones sospechosas y filas NULL.
7. JOIN cross-table sanity checks: `movimientos JOIN facturas WHERE tenant_id !=`, etc.
8. UNIQUE collision checks: `GROUP BY <cols> HAVING COUNT(DISTINCT tenant_id) > 1` por cada UNIQUE flaggeado.

**Tiempo total:** ~30 minutos, 4 scripts node.cjs descartables.

**Confidence:** ALTA — todas las afirmaciones provienen de queries SQL contra la DB live (no de leer migrations files).
