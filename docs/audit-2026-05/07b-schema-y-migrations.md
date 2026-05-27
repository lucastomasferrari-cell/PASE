# F7B — Auditoría de schema Postgres + migrations acumuladas

**Fecha:** 2026-05-27
**Alcance:** ESTADO ACTUAL del schema en prod (`pduxydviqiaxfqnshhdc`) + 292 migrations en `packages/pase/supabase/migrations/`.
**No duplica:** F2A (RLS), F2B (SECURITY DEFINER detalle), F3A (queries + índices muertos).

---

## Resumen ejecutivo

| Métrica | Valor | Comentario |
|---|---|---|
| Tablas en `public` | **124** | + 18 vistas, 0 materializadas |
| Índices | **446** | F3A ya droppeó muertos. Top: `mp_movimientos_pkey` (376KB), `idx_mp_movimientos_tenant_local_fecha` (229KB) |
| Funciones / RPCs | **326** (229 SECURITY DEFINER, 97 INVOKER) | 70% SD — alto |
| Triggers | **96** | Concentrados: `ventas_pos` (7), `insumos` (4), `ventas_pos_items`/`turnos_caja`/`items` (3) |
| Buckets Storage | **8** | 15.5 MB total — `facturas` 14.7 MB / 156 obj domina |
| Tamaño DB | **42 MB** | Top: `mp_movimientos` 2.3MB, `auditoria` 1.5MB, `ventas_pos_history` 1MB |
| Migrations totales | **292** (1.95 MB / 46.6 KL) | 53 en abr-26, 239 en may-26 |
| Extensions | 8 | `pg_cron, pg_net, pg_stat_statements, pg_trgm, pgcrypto, supabase_vault, unaccent, uuid-ossp` |
| Cron jobs activos | **1** | Solo `reactivar-items-vencidos` cada 15 min |
| Schemas custom | 0 | Sólo schemas estándar Supabase (`auth`, `cron`, `extensions`, `graphql`, `net`, `realtime`, `storage`, `vault`) |
| Roles custom | 0 | Sólo estándar Supabase |

---

## Ranking de findings

### 🔴 Críticos

#### S1. `auditoria` y `mp_movimientos` **sin** retention policy (DB crece sin techo)
- **Evidencia DB:** `auditoria` 1.5 MB / ~3.3K filas hoy. `mp_movimientos` 2.3 MB / ~5.4K. `ig_eventos` 656 KB / 472 filas (creció todo en 6 días desde 21-may). `ig_mensajes` 432 KB / 211 filas. `idempotency_keys` 296 KB / 433 filas (mín 11-may).
- **Cron jobs activos:** *solo* `reactivar-items-vencidos`. **No hay job de cleanup de ninguna tabla.**
- **Proyección:** a ritmo IG (~80 eventos/día sólo Neko) + 1 tenant nuevo cada 30 días, en 12 meses `ig_eventos` ronda 300K filas / 400+ MB sin retención. `auditoria` ya capturando 7 triggers de `ventas_pos` + 1 c/u de `items`, `item_precios_canal`, `canales`, `mesas`, `turnos_caja`, `ventas_pos_items` — cada feature nueva agrega más.
- **Fix:** crear cron `pg_cron` que borre filas con > N días:
  ```sql
  -- migration 202605280100_retention_logs.sql
  SELECT cron.schedule('cleanup-ig-eventos', '0 3 * * *',
    $$DELETE FROM ig_eventos WHERE created_at < now() - interval '90 days'$$);
  SELECT cron.schedule('cleanup-auditoria', '0 3 * * *',
    $$DELETE FROM auditoria WHERE fecha < now() - interval '180 days'$$);
  SELECT cron.schedule('cleanup-idempotency', '0 3 * * *',
    $$DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days'$$);
  SELECT cron.schedule('cleanup-pedidos-log', '0 3 * * *',
    $$DELETE FROM pedidos_externos_log WHERE created_at < now() - interval '30 days'$$);
  ```
  `mp_movimientos` NO se borra (es ledger financiero). `idempotency_keys` 7d es estándar (cualquier doble-click ya pasó).

#### S2. Bucket `rrhh-documentos` es **PUBLIC** y guarda documentos sensibles de empleados
- **Evidencia DB:** `SELECT id, name, public FROM storage.buckets` → `{empleados: public=true}, {rrhh-documentos: public=true}, {marketplace-fotos: public=true}, {mp-qrs: public=true}, {tickets-screenshots: public=true}`.
- **Riesgo:** los buckets `empleados` y `rrhh-documentos` típicamente almacenan DNIs, contratos, ART, recibos. URLs públicas → bypass total de RLS si alguien adivina/filtra el nombre del archivo. (`marketplace-fotos`, `mp-qrs`, `tickets-screenshots` son legítimamente públicos por el caso de uso.)
- **Fix:** cambiar a `public=false` y servir vía signed URLs (`createSignedUrl(path, 3600)` desde frontend ya autenticado). 14 policies en `storage` definidas — verificar que no estén basadas en `public=true`.
  ```sql
  UPDATE storage.buckets SET public=false WHERE id IN ('empleados','rrhh-documentos');
  ```
  En el frontend, sustituir `getPublicUrl` por `createSignedUrl` en los componentes que muestren archivos de estos buckets.

#### S3. **96 funciones SECURITY DEFINER sin check de auth detectado** (heurística)
- **Evidencia DB:** de 229 SD funcs, 96 no contienen `auth_tenant_id`, `auth_es_dueno_o_admin`, `auth_es_superadmin`, `auth_tiene_permiso`, ni `auth.uid()` en su definición.
- **Solapamiento con F2B:** F2B ya cubrió SECURITY DEFINER en profundidad. Esto es **complemento**: los 96 incluyen funciones públicas legítimas (menu QR, reservas públicas, pedidos delivery, reviews, riders) **y** funciones internas seguras (triggers, helpers `_get_*_passphrase`, `fn_*_audit`).
  - **Lista a triagear manualmente** (algunas son legítimas y otras pueden necesitar check): `fn_aplicar_cupon`, `fn_validar_cupon`, `fn_kds_*_comanda`, `fn_*_comanda_offline`, `agent_update_ticket`, `dispatch_auto_fix_workflow`, `_resync_pago_especial`, `vincular_remito_factura`, `transferencia_cuentas`, `aplicar_ncs_a_factura`, `anular_movimientos_batch`, `crear_tenant_v2`, `trg_saldo_proveedor`, `crear_movimiento_caja_bot` (REVOKE PUBLIC — OK).
  - **Funciones con `_comanda_offline` sufijo**: específicamente sin check porque vienen del sync engine — pero el sync engine corre como `authenticated` con anon key, así que **alguien con la anon key podría llamarlas directo bypass-eando la app**. Verificar que internamente filtren `auth_tenant_id()`/`local_id`.
- **Fix:** F2B ya tiene la metodología. Reusar para este subset.

#### S4. 5 tablas operativas con `tenant_id NULLABLE` — riesgo de filas sin tenant
- **Evidencia DB:** `ig_eventos`, `mp_webhooks_test`, `pedidos_externos_log`, `roles`, `usuarios`.
  - `usuarios` y `roles`: aceptable porque hay superadmins cross-tenant. Pero `usuarios.tenant_id IS NULL` significa potencialmente "supersusuario" — confirmar que las policies traten ese caso.
  - `ig_eventos`, `pedidos_externos_log`, `mp_webhooks_test`: legítimo porque entran sin auth contextual (webhook). PERO requiere un fallback que resuelva el tenant antes de procesar — si falla, queda fila huérfana sin posibilidad de borrar por tenant.
- **Fix:** agregar trigger `BEFORE INSERT` que resuelva tenant desde `ig_account_id`/`mp_account`/etc., o mover esa logica al endpoint y exigir NOT NULL.
  ```sql
  -- ejemplo ig_eventos
  CREATE OR REPLACE FUNCTION trg_ig_eventos_set_tenant() RETURNS TRIGGER AS $$
  BEGIN
    IF NEW.tenant_id IS NULL THEN
      SELECT tenant_id INTO NEW.tenant_id FROM ig_config WHERE ig_account_id = NEW.ig_account_id;
    END IF;
    RETURN NEW;
  END$$ LANGUAGE plpgsql;
  ```

---

### 🟠 Altos

#### S5. **68 columnas `numeric` sin precision/scale** (todas las que tocan plata)
- **Evidencia DB:** `facturas.total/neto/iva*/descuentos`, `gastos.monto`, `movimientos.importe`, `factura_items.cantidad/precio_unitario/subtotal`, `mp_credenciales.saldo_*`, `mp_movimientos.monto/saldo`, `remitos.monto`, `proveedores.saldo`, `rrhh_*.importe` (parcial).
- **Riesgo real:** Postgres usa `numeric` sin precision = "unlimited" — sirve, pero (1) no documenta el límite de negocio, (2) imposibilita un CHECK simple como `total >= 0` para flagear bugs visuales (millones tipeados), (3) usuarios PASE en otras DBs/migraciones futuras pierden info de escala.
- **Fix:** migration que altere a `NUMERIC(15,2)` (12 enteros + 2 decimales = hasta $999.999.999.999,99) para campos de dinero, `NUMERIC(10,3)` para cantidades. Incluir `CHECK (monto >= 0)` donde aplique (excepto saldos que pueden ser negativos).
  ```sql
  ALTER TABLE facturas
    ALTER COLUMN total TYPE NUMERIC(15,2),
    ALTER COLUMN neto  TYPE NUMERIC(15,2);
  ALTER TABLE facturas ADD CONSTRAINT chk_facturas_total_nonneg CHECK (total >= 0);
  ```
  Aplicar igual a `gastos`, `movimientos`, `factura_items`, `mp_movimientos`, `remitos`, `rrhh_*`. **Hacer en un batch único en bajo tráfico** para evitar `ACCESS EXCLUSIVE` lock prolongado en `movimientos` (2120 filas — OK ahora, peor con crecimiento).

#### S6. **53 tablas SIN ningún CHECK constraint** incluyendo críticas
- **Evidencia DB:** lista incluye `saldos_caja`, `movimientos`, `factura_items`, `ventas`, `medios_cobro`, `mp_credenciales`, `notificaciones_pendientes`, `idempotency_keys`, `recetas_versiones`, `tenants`, `tenant_features`, `tenant_onboarding_progress`.
- **Riesgo:** `movimientos.importe` puede ser `NaN`. `saldos_caja.saldo` sin constraint de no-NULL. `tenants.plan` (text, no enum) acepta cualquier string. `notificaciones_pendientes.tipo` sin restricción → bugs silenciosos.
- **Fix:** capa 1 al menos los más críticos:
  ```sql
  ALTER TABLE movimientos ADD CONSTRAINT chk_mov_importe_finito CHECK (importe = importe AND importe IS NOT NULL);
  ALTER TABLE saldos_caja ADD CONSTRAINT chk_saldos_no_nan CHECK (saldo = saldo);
  ALTER TABLE tenants ADD CONSTRAINT chk_plan CHECK (plan IN ('free','starter','pro','enterprise'));
  ALTER TABLE factura_items ADD CONSTRAINT chk_cant_pos CHECK (cantidad > 0);
  ```

#### S7. **67 columnas text con valores enumerados** sin CHECK ni Postgres ENUM
- **Evidencia DB:** `facturas.estado`, `facturas.tipo`, `gastos.estado/categoria/tipo`, `ventas.medio/origen`, `ventas_pos.estado/modo/origen`, `rrhh_liquidaciones.estado`, `tenants.plan`, etc.
- **Riesgo:** typo en frontend = fila con `estado='penidente'` que nunca matchea filtros. Difícil de detectar.
- **Fix por etapas:**
  1. Auditoría rápida: `SELECT DISTINCT estado FROM facturas` para cada — encontrar inconsistencias actuales.
  2. CHECK constraint (más fácil de evolucionar que ENUM):
     ```sql
     ALTER TABLE facturas ADD CONSTRAINT chk_facturas_estado
       CHECK (estado IN ('pendiente','pagada','anulada','parcial'));
     ```
  3. Postgres ENUM solo para los muy estables (`facturas.tipo IN ('A','B','C','M')` AFIP).

#### S8. **63 tablas sin columna `updated_at`** (rompe C7 — "tabla nueva con columnas estándar")
- **Evidencia DB:** Incluye tablas críticas: `auditoria`, `factura_items`, `facturas`, `gastos`, `movimientos`, `proveedores`, `saldos_caja`, `usuarios`, `ventas`, `rrhh_*` (varias), `mp_movimientos`.
- **Riesgo:** imposible saber cuándo se editó una factura/gasto post-creación; sync engine COMANDA-PASE no puede usar `updated_at > last_sync` como heurística; Cache invalidation menos preciso.
- **Caveat:** `facturas` tiene `editado_at`, `mp_movimientos` tiene `updated_*` con otro nombre — verificar caso a caso antes de agregar.
- **Fix:** migration que agregue `updated_at TIMESTAMPTZ DEFAULT now() NOT NULL` + trigger reusable:
  ```sql
  CREATE OR REPLACE FUNCTION trg_updated_at() RETURNS TRIGGER AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END$$ LANGUAGE plpgsql;
  -- aplicar a cada tabla relevante (facturas, gastos, movimientos, ventas, rrhh_*)
  ```

#### S9. **30 UNIQUE constraints sin `tenant_id`** (riesgo cross-tenant)
- **Evidencia DB:** `mp_credenciales: UNIQUE(local_id)` (no `tenant_id, local_id`), `ig_config: UNIQUE(ig_account_id)`, `objetivos_mes: UNIQUE(local_id, mes)`, `usuario_locales: UNIQUE(usuario_id, local_id)`, `medios_cobro: UNIQUE(nombre, local_id)`, `saldos_caja: UNIQUE(cuenta, local_id)`, `usuario_permisos: UNIQUE(usuario_id, modulo_slug)`.
- **Análisis:**
  - `mp_credenciales`, `ig_config`, `medios_cobro`, `saldos_caja`, `objetivos_mes`: como `local_id` es UNIQUE entre tenants (la tabla `locales` ya tiene su `tenant_id`), técnicamente OK. Pero si se llegara a borrar un tenant sin borrar sus `locales` (escenario poco probable después del fix de `eliminar_tenant_completo`), la próxima inserción colisionaría.
  - **`usuario_locales` y `usuario_permisos`**: `usuario_id` también es global (sin tenant). OK por la misma razón.
  - **`rrhh_valores_doble: UNIQUE(puesto)`**: SI es problemático — el "puesto" es un texto que podría repetirse entre tenants. Verificar.
  - **`rol_pos_permisos: UNIQUE(rol_pos, slug)`**: catálogo global (`comanda_permisos_catalogo`), OK.
- **Fix:** sólo `rrhh_valores_doble` necesita ajuste; el resto está implícitamente protegido por la unicidad de `local_id`/`usuario_id`.

#### S10. Tablas históricas crecen sin techo y sin retention
- **Evidencia DB:** `ventas_pos_history` 1MB / 363 filas, `items_history` 344 KB / 51 filas, `canales_history` 328 KB / 132 filas, `ventas_pos_items_history` 320 KB / 108 filas, `mesas_history` 176 KB / 108 filas — todas grandes por el `jsonb` de `old_data/new_data`. Crearon en sprint 1 COMANDA, sin job de cleanup.
- **Fix:** `DELETE FROM *_history WHERE changed_at < now() - interval '180 days'`. Si se necesita retención larga, partition by month con `pg_partman`.

---

### 🟡 Medios

#### S11. **84 tablas con `id INTEGER`** — riesgo de overflow a futuro
- **Evidencia DB:** `movimientos`, `gastos`, `facturas`, `factura_items`, `remitos`, `usuarios`, `locales` y muchas más usan `integer` (max 2.147 M). Convención del repo dice "`local_id` y `usuario_id` son INTEGER, no UUID (legado pre-multi-tenant)". Esos están OK por baja cardinalidad. Pero `movimientos.id`, `ventas_pos_items.id`, `auditoria.id`, etc. son flujos altos.
- **Proyección:** `auditoria` con 96 triggers + 100 tenants = ~10K/día → 36 años para overflow. Aún OK pero documentar.
- **Fix:** migrar a `bigint` los IDs de tablas append-heavy en próxima ventana de mantenimiento. `ALTER COLUMN id TYPE bigint` puede ser caro (rewrite). Hacer first time, antes de que la tabla crezca demasiado.

#### S12. **18 vistas, top con queries no triviales** — F3A ya recomendó MV; confirmo
- **Evidencia DB:** `v_admin_metricas_tenants` (1943 chars, multi-tenant agregación), `v_items_review_queue` (1546 chars), `v_insumos_alertas_stock` (1058 chars), `v_kds_tickets` (1041 chars), `v_stock_rotacion_30d` (1024 chars).
- **`v_admin_metricas_tenants`** se calcula on-demand cada vez que el superadmin entra → cuanto crezca el # tenants, query lineal en muchas tablas. Candidato a MV con `REFRESH MATERIALIZED VIEW CONCURRENTLY` cada hora.
- **`v_stock_rotacion_30d`** — agregación 30 días sobre `insumo_movimientos`. F3A ya lo identificó; recomiendo confirmar y materializar.
- **Otros candidatos para MV:** `v_mermas_top10`, `v_insumos_alertas_stock`, `v_locales_rating_resumen`.
- **Fix:** F3A ya tiene el plan, no duplicar.

#### S13. **45 jsonb columns** — uso justificable pero algunos podrían ser tipos concretos
- **Evidencia DB:** legítimos (logs/payloads/configs): `auditoria.datos_*`, `ig_eventos.payload`, `pedidos_externos_log.headers/payload`, `idempotency_keys.result`, `mp_webhooks_test.*`, `*_history.old/new_data`, `recetas_versiones.receta_data`, `tickets_soporte.*`, `usuario_dashboard_config.*`.
- **Sospechosos** (deberían ser tablas/columnas):
  - **`facturas.pagos`** — pagos de una factura es typed data, no JSON. Existe `mp_movimiento_facturas`; ¿hay duplicación?
  - **`items.sku_externos`** — varios SKUs externos = tabla hija `item_sku_externos(item_id, provider, sku)`.
  - **`rrhh_empleados.pos_favoritos`** — array de IDs típicamente → tabla `rrhh_empleado_pos_favoritos`.
  - **`comanda_local_settings.reservas_horarios`** — config estructurada → tabla `reservas_horarios(local_id, dia_semana, hora_inicio, hora_fin)`.
  - **`ventas_pos_items.modificadores`** — modificadores aplicados → tabla `ventas_pos_item_modificadores`. Hoy es JSON y dificulta reports.
- **Fix:** evaluar cada uno. Algunos justifican migración futura, otros se quedan.

#### S14. Migrations: **patrones repetidos** — funciones reemplazadas N veces
- **Evidencia migrations:** top redefiniciones (`CREATE OR REPLACE FUNCTION`):
  - `pagar_sueldo` x12, `eliminar_tenant_completo` x9, `anular_movimiento` x8, `anular_factura` x7, `pagar_factura` x6, `crear_gasto_empleado` x6, `anular_remito` x6, `fn_crear_pedido_publico_comanda` x6, `fn_agregar_pago_venta_comanda` x6.
- **Análisis:** las RPCs grandes evolucionan con el producto; redefinir es la forma correcta. **Pero** 12 versiones de `pagar_sueldo` significa la fuente de verdad de "qué hace hoy" requiere leer 12 migrations.
- **Fix recomendado:**
  - Adoptar convención: la migration que toca una RPC pone arriba un comentario con "Replaces version of YYYYMMDD. Changes: ...".
  - Considerar squash de migrations pre-may-2026 a un baseline `00000000000_baseline.sql` con el snapshot actual — pero **esto pierde historial git**. Alternativa más segura: dejar las migrations existentes, mantener un `RPC_REGISTRY.md` con la signature actual y última migration de cada RPC.

#### S15. Migrations: **9 versiones de `eliminar_tenant_completo`** + 5 fixes circulares
- **Evidencia migrations:** `202605121400_rpc_eliminar_tenant_completo.sql`, `202605222900_eliminar_tenant_completo_v2.sql`, `202605223000_eliminar_tenant_completo_dinamico.sql`, `202605223100_eliminar_tenant_fks_circulares.sql`, `202605223200_eliminar_tenant_robusto.sql`, `202605223300_eliminar_tenant_recetas_versiones.sql`, `202605241700_fix_eliminar_tenant_disable_triggers.sql`, `202605270700_audit_f1_criticos.sql`. Cada uno arregla un edge case del anterior.
- **Análisis:** ya está en su versión "dinámica" que descubre tablas auto. ✓
- **Fix:** marcar las migrations intermedias como deprecadas con comentario, mantener para historial. Considerar test de integración (ya está cubierto por test E2E F6).

#### S16. Migrations: tablas creadas con structure casi-idéntica (pattern para plantilla)
- **Evidencia migrations:** Cada feature nueva crea su tabla con `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE NO ACTION` + `created_at TIMESTAMPTZ DEFAULT now()` + `updated_at` + `created_by INTEGER REFERENCES usuarios(id)` + RLS dual. Repetido en cada migration nueva.
- **Fix:** crear función helper en migration única:
  ```sql
  CREATE OR REPLACE FUNCTION fn_setup_tenant_table(p_table TEXT) RETURNS VOID AS $$
  BEGIN
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO authenticated USING (tenant_id = auth_tenant_id())', p_table||'_tenant_scope', p_table);
    -- etc.
  END$$ LANGUAGE plpgsql;
  ```
  Y un comando custom de Claude `/nueva-tabla nombre` que genere el SQL completo.

#### S17. Migrations one-off legacy candidatas a archivado
- **Evidencia migrations:** `20260418_movimientos_local_id_backfill.sql`, `202605080920_mp_justificativos_backfill.sql`, `202605111600_rrhh_pagos_especiales_catchup.sql`, `202605111500_blindaje_tipos_dedup_unique.sql`, `202605204500_disable_auto_fix_trigger.sql`. Ya cumplieron su propósito.
- **Fix:** no remover (rompe re-aplicaciones) — agregar comentario al inicio: `-- ONE-OFF FIX 2026-04 (ya ejecutado, NO re-correr) -- mantenido por trazabilidad`.

#### S18. **18 tablas sin `tenant_id`** — algunas legítimas, algunas a revisar
- **Evidencia DB:** legítimas globales: `tenants`, `billing_plans`, `comanda_permisos_catalogo`, `rol_pos_permisos`, `notification_preferences` (per-user). Por compartirse entre usuarios sin tenant: `admin_push_subscriptions`.
- **Sospechosas que SÍ deberían tener tenant_id:**
  - `auto_entrega_log` — log de delivery por local → debería tener tenant.
  - `rider_positions` — posiciones de riders, por tenant.
  - `stock_conteo_lineas` — líneas de conteo de stock; hereda de `stock_conteos` que sí tiene tenant. OK por el FK CASCADE.
  - `cupon_usos` — usos de cupones; hereda de `cupones`. OK por FK CASCADE.
  - **`canales_history`, `items_history`, `item_precios_canal_history`, `mesas_history`, `turnos_caja_history`, `ventas_pos_history`, `ventas_pos_items_history`** — tablas de audit history sin RLS y sin tenant. Si la app expone vía API/dashboard hay leak. Verificar.
- **Fix:** agregar `tenant_id` + RLS a las 7 tablas history (también el linter de Supabase ya las flagea — está en backlog del CLAUDE.md).

---

### 🟢 Bajos

#### S19. **FK delete behavior consistency**: 213 NO ACTION, 69 CASCADE, 14 SET NULL, 4 RESTRICT
- 58 FKs `→ tenants` con NO ACTION → `eliminar_tenant_completo` los maneja explícitamente. OK.
- 14 SET NULL en columnas como `ventas_pos.rider_id`, `tickets_soporte.atendido_por`, `usuarios.rol_id` — semánticamente correcto (borrar rider/admin/rol no debe perder el registro de venta/ticket/usuario).
- 4 RESTRICT — verificar caso a caso (probablemente catálogos críticos como `proveedores`).

#### S20. Vistas con `tenant_id NULL` en columnas (no falsos positivos)
- `v_admin_metricas_tenants`, `v_catalogo_menu_qr_publico`, `v_ig_conexion_estado`, etc. — son vistas, donde la nullability se hereda de la query. Comportamiento correcto.

#### S21. **18 storage policies** con 3 buckets vacíos
- `marketplace-fotos`, `mp-qrs`, `soporte-screenshots`, `tickets-screenshots`, `tenant-backups` — varios sin objetos. `tenant-backups` solo 11 objetos / 570 KB → `backup-tenants.js` script existe (CLAUDE.md menciona pero no detalla cadencia). **No hay tabla `backup_metadata`** → no se puede saber qué tenants tienen backup vigente.
- **Fix:** crear tabla `tenant_backups (tenant_id, created_at, storage_path, size_bytes, status, verified_at)` para tener visibilidad. Cron diario.

#### S22. `ALTER COLUMN ... TYPE uuid` ejecutado 9 veces en migrations
- Casi todas en migration `20260414_usuarios_rrhh.sql` cuando se migraron IDs de RRHH de `integer` a `uuid`. Una vez completada, ya está. No es churn problemático.

#### S23. `extensions` instaladas — uso real
- `pg_cron`, `pg_net`, `pg_stat_statements`, `pg_trgm`, `pgcrypto`, `supabase_vault`, `unaccent`, `uuid-ossp`.
- `pg_cron`: solo 1 job activo → desaprovechado, sumar retention jobs (ver S1, S10).
- `pg_net`: ¿se usa? Verificar si hay HTTP calls desde Postgres (probablemente para webhooks IG/MP).
- `pg_stat_statements`: F3A usado. Bien.
- `pg_trgm`: para fuzzy search → verificar índices `gin_trgm_ops` existentes.

---

## Hallazgos cross-fase (no duplico, sólo confirmo)

- **F2A (RLS):** confirmado 0 tablas con RLS off. ✓
- **F2B (SD):** 96 SD funcs sin check explícito — sub-conjunto a triagear como S3.
- **F3A (índices):** post-fix F3, `mp_movimientos_pkey` (376KB) sigue siendo el más grande pero esperable (~5K filas con varios índices secundarios).
- **F3A (queries):** las 5 vistas grandes (S12) confirman la recomendación de F3A de materializar.

---

## Acciones priorizadas (top 8)

1. **Crear cron retention jobs** para `ig_eventos`, `auditoria`, `idempotency_keys`, `pedidos_externos_log` y tablas `*_history`. ~2h, alta prioridad (S1, S10).
2. **Cambiar buckets `empleados` y `rrhh-documentos` a `public=false`** + migrar frontend a signed URLs. ~3h, alta sensibilidad (S2).
3. **Migration de tipado financiero**: `NUMERIC(15,2)` + `CHECK >= 0` en facturas/gastos/movimientos/factura_items/mp_movimientos. ~2h (S5, S6).
4. **CHECK constraints para enums críticos** (`tenants.plan`, `facturas.estado`, `gastos.estado`, `ventas_pos.estado`, `rrhh_liquidaciones.estado`). ~2h (S7).
5. **Triage S3**: confirmar que las 96 SD sin check tienen auth interno o son públicas legítimas. ~3h leyendo def (S3).
6. **`tenant_id` + RLS en las 7 tablas history de COMANDA** ya en backlog CLAUDE.md (S18).
7. **`updated_at` + trigger** en al menos `facturas`, `gastos`, `movimientos`, `ventas` (top finance). ~1h (S8).
8. **Tabla `tenant_backups`** con metadata de cada backup ejecutado (S21).

---

## Métricas finales

- **124 tablas** / 18 vistas / 0 MV / 326 funciones / 96 triggers / 446 índices / 42MB DB / 15.5MB storage.
- **292 migrations** acumuladas (1.95MB / 46.6K líneas).
- **Estado de health:** schema sólido. La deuda principal es **retention** (S1) y **constraints** (S5/S6/S7). El producto ha evolucionado correctamente la capa multi-tenant; los gaps son refinamientos, no agujeros estructurales.
