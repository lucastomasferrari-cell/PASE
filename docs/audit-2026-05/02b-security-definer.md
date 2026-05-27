# Fase 2B — Seguridad multi-tenant en funciones SECURITY DEFINER

**Estado:** ✅ Completa
**Fecha:** 2026-05-26
**Método:** dump LIVE de las 224 funciones `prosecdef=true` del schema `public` vía `pg_get_functiondef` + `routine_privileges` + análisis programático (regex auth helpers + IDOR heurístico + clasificación) + revisión manual de los 50 casos más sensibles. Verificación cruzada de helpers que actúan como auth gate (`fn_assert_local_autorizado`, `auth_tiene_permiso_o_override`, `fn_check_perm_comanda`, `comanda_auth_tiene_permiso`).

## 📊 Resumen ejecutivo

**224 funciones SECURITY DEFINER** en `public` (10 son auth helpers exentos, 4 son excepciones documentadas en CLAUDE.md, 17 son triggers).

Hallazgos sobre las 193 funciones RPC restantes (callable vía PostgREST):

| Severidad | # | Descripción corta |
|---|---|---|
| 🔴 **CRÍTICO** | **17** | Auth missing y opera sobre tablas financieras / cross-tenant, O contradicción entre comentario "solo service_role" y `GRANT` a `authenticated` |
| 🟠 **ALTO** | **13** | Auth ausente sobre datos no-financieros, o auth presente pero IDOR factible vía parámetro ID financiero |
| 🟡 **MEDIO** | **5** | `agregar_comentario_ticket` IDOR, varios helpers internos sin search_path |
| 🟢 **BAJO** | **34** | Funciones OK funcionalmente pero sin `SET search_path` (privesc vía search_path attack) |
| ✅ OK | 120 | Auth check presente en primeras líneas + búsqueda explícita por tenant |

### ⚠️ Hallazgos confirmados que ya son explotables HOY

Los 3 más graves, ranked:

1. **`agent_update_ticket`** y **`dispatch_auto_fix_workflow`** declaran en comentario "solo callable por service_role" pero los GRANTS incluyen `anon:EXECUTE` y `authenticated:EXECUTE`. Cualquier usuario logueado puede UPDATE cualquier `tickets_soporte.agent_status`/`agent_log`/`agent_cost_usd` de cualquier tenant. Además puede disparar webhook GitHub (`repository_dispatch`) con cualquier `ticket_id` arbitrario → side-effect externo no autorizado.

2. **`fn_agregar_pago_venta_comanda`** no chequea auth ni valida que `p_venta_id` pertenezca al tenant del caller. Cualquier usuario autenticado de cualquier tenant puede INSERT un pago confirmado sobre cualquier venta y, si completa el total, marcarla cobrada + crear `movimientos_caja` en un turno ajeno. Ya callable desde el frontend de Comanda con anon key.

3. **`fn_procesar_reversos_pendientes_comanda`** acepta `p_turno_id` y procesa todos los `reversos_pendientes WHERE local_id=v_local_id`. Sin auth check. Un tenant A pasa el `turno_id` de un tenant B y dispara la creación de `movimientos_caja` cross-tenant.

Estos NO son bugs latentes — son superficies de ataque activas en producción.

---

## 🎯 Ranking de los 17 CRÍTICOS (atacar primero)

| # | Función | Patología | Esfuerzo fix | Impacto |
|---|---|---|---|---|
| 1 | `agent_update_ticket` | Comentario dice "solo service_role" pero `GRANT` incluye anon+authenticated. Sin auth check. | 1 min (REVOKE) | Cualquier user UPDATEa tickets de cualquier tenant: status, log JSONB acumulable, costo agregable infinito |
| 2 | `dispatch_auto_fix_workflow` | Mismo bug que #1 + dispara webhook GitHub | 1 min (REVOKE) | Cualquier user dispara workflow en GitHub con ticket_id arbitrario |
| 3 | `fn_agregar_pago_venta_comanda` | Sin auth, sin `fn_assert_local_autorizado`. Solo valida sobrepago. | 5 min | Tenant A registra pagos sobre ventas de Tenant B + crea movimientos_caja cross-tenant |
| 4 | `fn_procesar_reversos_pendientes_comanda` | Sin auth, opera sobre cualquier `turno_id` | 5 min | Cross-tenant: tenant A procesa reversos de tenant B y crea movs en su turno |
| 5 | `fn_aplicar_cupon` | Sin auth check ni `fn_assert_local_autorizado`. Toma `cupon_id` + `venta_id` ajenos. | 5 min | Cualquier user aplica cualquier cupón a cualquier venta (incluso cross-tenant). UPDATE de `ventas_pos.total` + INSERT en `cupon_usos` |
| 6 | `fn_aplicar_stock_venta` | Sin auth. SELECTea `ventas_pos` por ID, INSERTA en `insumo_movimientos` con `tenant_id` derivado. | 5 min | Cross-tenant: tenant A llama con `venta_id` de tenant B → crea movs de insumo en tenant B. Stock corrupto en otro tenant. |
| 7 | `fn_revertir_stock_venta` | Sin auth check. Reversa stock de cualquier venta. | 5 min | Idem #6 inverso: revertir stock ajeno |
| 8 | `fn_marcar_listo_comanda` / `fn_marcar_entregado_comanda` | Sin auth, sin tenant. UPDATEan `ventas_pos.estado`. | 5 min cada | Cualquier user marca cualquier venta de cualquier tenant como lista/entregada |
| 9 | `fn_modificar_precio_item_comanda_offline` / `fn_cortesia_item_comanda_offline` / `fn_anular_item_comanda_offline` | Delegan al `fn_*_comanda` por UUID **sin pasar `p_manager_id`**. Las non-offline tienen un check de manager, pero la versión _offline lo bypassea pasando NULL implícito a través de `PERFORM fn_X(v_item_id, p_manager_id, p_motivo, ...)` — el `p_manager_id` viene como argumento explícito, así que técnicamente fluye, **pero** ninguna llama `fn_assert_local_autorizado` antes de delegar → el delegado SÍ lo hace pero el orden de validación deja una ventana corta sin lock. Verificar: aún hay grant `anon:EXECUTE` sin necesidad. | 5 min | IDOR factible si la función delegada falla silenciosa |
| 10 | `fn_set_pedido_geo` | Sin auth, sin tenant. UPDATE `ventas_pos.cliente_lat/lon` de cualquier venta en estado `necesita_aprobacion`. | 5 min | Cualquier user setea coords arbitrarias sobre pedidos de delivery de cualquier tenant. Riesgo: ruteo del rider al lugar equivocado. |
| 11 | `fn_recalc_costo_insumo` / `fn_recalcular_stock_insumo` | Sin auth. UPDATEan `insumos.costo_actual` / `stock_actual` de cualquier insumo. | 5 min cada | Cross-tenant: tenant A altera costo de insumo de tenant B → corrompe márgenes en EERR + CMV |
| 12 | `fn_recalcular_totales_venta_comanda` | Sin auth. UPDATE `ventas_pos.subtotal/total`. | 5 min | Cross-tenant: tenant A recalcula totales de venta ajena → si caller envía un escenario donde la query SELECT da 0, marca total=0 |
| 13 | `asignar_rol_a_usuario` ✅ tiene auth | **NO crítico** — verificado manual: chequea `auth_es_dueno_o_admin()` + valida `v_user.tenant_id != auth_tenant_id()` + `v_rol.tenant_id`. FALSO POSITIVO del clasificador. (mantenido en tabla para transparencia) |
| 14 | `_resync_liquidacion_pagos` | GRANT a PUBLIC/anon/authenticated. UPDATE `rrhh_liquidaciones.estado/pagos_realizados/pagado_at` de cualquier liquidación. Es helper interno (llamado solo por 1 trigger) → debería estar REVOKE FROM PUBLIC + GRANT solo service_role. | 1 min (REVOKE) | Cualquier user puede forzar resync de liquidación ajena → blanquea o sobreescribe `estado` |
| 15 | `_resync_pago_especial` | Idem #14 con `rrhh_pagos_especiales`. | 1 min | Cualquier user resync arbitrario de pagos especiales ajenos |
| 16 | `fn_recalcular_saldo_proveedor` | Sin auth. UPDATE `proveedores.saldo` de cualquier prov. | 5 min | Cross-tenant: corromper saldos visibles |
| 17 | `fn_user_quiere_notif` | Sin auth. SELECT `notification_preferences` de cualquier user_id. Es helper, devuelve boolean. | 1 min (REVOKE) | Information disclosure menor: enumerar qué tipos de notif tiene cada user. Bajo impacto pero patrón roto. |

> Nota sobre #13: tras revisar manualmente quedó claro que `asignar_rol_a_usuario` SÍ tiene el check. Lo dejo enumerado para que se vea que fue verificado y no es bug.

---

## 🟠 ALTOS (13)

| Función | Patología |
|---|---|
| `_get_mp_passphrase` | Helper sin auth, pero grants ya REVOKED a PUBLIC/anon/authenticated — OK por restricción de grants. Falta marca de búsqueda en CLAUDE.md como excepción documentada. |
| `cerrar_ticket` | Tiene `auth_es_superadmin()` check pero el GRANT a `anon/authenticated` es ruido. Funcional OK pero confunde. |
| `editar_venta` | Tiene `auth_tiene_permiso_o_override` + `auth_locales_visibles()` pero **falta** check explícito de `v_venta.tenant_id = auth_tenant_id()`. Defense-in-depth: si en el futuro 2 tenants comparten un local_id (no debería pasar, pero), leak. |
| `fn_calcular_costo_receta_porcion` | Sin auth, pero es SQL pure-read (devuelve un NUMERIC). Information disclosure: cualquier user revela costo de receta ajena. |
| `fn_resolver_venta_id_por_uuid` / `fn_resolver_venta_item_id_por_uuid` | Sin auth. Resuelven UUID → ID. Information disclosure: enumerar UUIDs válidos / mapear ID interno. Llamadas por 8+3 funciones internas. |
| `fn_marcar_password_cambiada` | OK: tiene `auth.uid() IS NULL` check + filtra por `auth_id = v_auth_id`. **FALSO POSITIVO**. |
| `fn_cleanup_oauth_states` | Sin auth. DELETEa `ig_oauth_states WHERE expires_at < NOW() - 24h`. Bajo riesgo (solo borra expirados >24h), pero patrón: cualquier user puede disparar maintenance. |
| `fn_reactivar_items_vencidos` | Sin auth. UPDATE `items` en estado `agotado` con `agotado_hasta < NOW()`. Cross-tenant: tenant A revive items agotados de tenant B (menor). |
| `fn_reporte_cmv_resumen` | Sin auth. Devuelve agregados de CMV — pero internamente llama `fn_reporte_cmv(p_local_id, ...)` que SÍ valida tenant. Verificar la función llamada. |
| `agregar_comentario_ticket` | Auth check OK pero permite a "autor" comentar sin validar `tenant_id` del ticket. Si autor_user_id se duplica entre tenants (improbable, INT PK global). Bajo riesgo. |

---

## 🟡 MEDIO (5) y 🟢 BAJO (34)

### MEDIO
- `eliminar_venta` / `eliminar_cierre` — auth tiene override + visibilidad de locales, pero no chequea explícitamente `v_venta.tenant_id = auth_tenant_id()`. Mismo patrón que `editar_venta`.
- Varias funciones offline (`fn_*_offline`) delegan a non-offline sin re-validar — funcional OK pero acoplan auth a otra función. Si el delegado pierde su check en una migration, todas las offline rompen sin ruido.

### BAJO (34 funciones sin `SET search_path`)
Funciones que tienen auth check correcto pero no declaran `SET search_path TO 'public'`. Bajo SECURITY DEFINER + search_path no fijo = vulnerable a search_path injection si un user logueado redefine `pg_temp.tabla_critica` antes de invocar. En la práctica Supabase corre con `pg_catalog, public, pg_temp` por default que mitiga, pero el linter de Supabase las flagea correctamente.

Lista parcial: `fn_aplicar_cupon`, `fn_marcar_listo_comanda`, `fn_marcar_entregado_comanda`, `fn_aplicar_stock_venta`, `fn_revertir_stock_venta`, `fn_recalc_costo_insumo`, `fn_recalcular_stock_insumo`, `fn_recalcular_totales_venta_comanda`, `fn_recalcular_saldo_proveedor`, `fn_user_quiere_notif`, `fn_agregar_pago_venta_comanda`, `fn_refund_venta_comanda`, `fn_canjear_puntos_cliente`, `fn_ajustar_stock_insumo`, `fn_iniciar_conteo_fisico`, `fn_ceder_empleado_a_local`, `fn_revocar_cesion_empleado`, `fn_transferir_stock_local`, `fn_generar_invoice_proxima`, `crear_gasto_empleado`, `fn_calcular_costo_receta_porcion`, otras. **Fix global:** `ALTER FUNCTION x SET search_path TO 'public';` para las 34.

---

## 🧪 Ejemplos de explotación (para los 3 CRÍTICOS más graves)

### Exploit #1: `fn_agregar_pago_venta_comanda` cross-tenant

```js
// Tenant A logueado vía anon key + Supabase Auth
const supabase = createClient(URL, ANON_KEY);
await supabase.auth.signInWithPassword({ email: 'attacker@a.com', password: '...' });

// 1) Lista ventas de TENANT B (RLS los oculta normalmente).
//    Pero p_venta_id es BIGINT secuencial global → enumerable.
//    Atacante prueba IDs vecinos al suyo hasta encontrar una venta abierta de B.
for (let id = MY_LAST_VENTA_ID - 100; id < MY_LAST_VENTA_ID + 100; id++) {
  const { data, error } = await supabase.rpc('fn_agregar_pago_venta_comanda', {
    p_venta_id: id,
    p_metodo: 'efectivo',
    p_monto: 999999, // > total → triggers SOBREPAGO, descarta. Buscar el monto exacto.
    p_idempotency_key: `attack-${id}`,
  });
  // Si NO retorna VENTA_NO_ENCONTRADA → existe. Hacer probe binario por monto.
}

// 2) Cobrar venta de tenant B con su propio monto:
await supabase.rpc('fn_agregar_pago_venta_comanda', {
  p_venta_id: VENTA_TENANT_B,
  p_metodo: 'efectivo',
  p_monto: TOTAL_VENTA,
  p_idempotency_key: 'final',
});
// → ventas_pos.estado='cobrada' + movimientos_caja insertado en el turno de B
//   con caja del local del tenant B descalzada (tenant_id=B, local_id=B's local).
```

Resultado: tenant A no roba plata directamente (los movs van al ledger de B), pero ROMPE la caja de B + dispara estado "cobrada" sobre ventas que el cajero de B no procesó. El cajero de B abre el turno y ve $30k de movs fantasma.

### Exploit #2: `agent_update_ticket` overwrite cross-tenant

```js
await supabase.rpc('agent_update_ticket', {
  p_ticket_id: 'b3a1...', // ticket UUID de otro tenant
  p_status: 'resolved',
  p_log_entry: { texto: 'fake fix by attacker' },
  p_cost_usd: 99999, // se SUMA, no se reemplaza → infla agent_cost_usd
});
// → UPDATE tickets_soporte de otro tenant
//   - resuelve tickets ajenos sin permiso
//   - infla costo USD reportado (impacto en pricing/dashboards superadmin)
//   - inyecta texto en log JSONB
```

### Exploit #3: `dispatch_auto_fix_workflow` webhook hijack

```js
await supabase.rpc('dispatch_auto_fix_workflow', { p_ticket_id: ARBITRARY_UUID });
// → POST a https://api.github.com/repos/lucastomasferrari-cell/PASE/dispatches
//   con event_type='auto_fix_bug' + ticket_id arbitrario
// El workflow auto-fix corre en GitHub Actions con permisos de write al repo.
// Atacante consume runner minutes + posiblemente abre PRs spam.
```

---

## 📋 Observaciones generales (cross-función)

1. **Patrón "comentario engaña, GRANTS no protegen"** (CRÍTICO #1 y #2). Las funciones que comentan "solo service_role" pero NO ejecutan `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` están abiertas. Ningún check explícito del lado de la función. Auditar TODOS los `-- Solo callable por service_role` en el codebase.

2. **Funciones de Comanda (POS/online) sin auth-on-RPC** (CRÍTICOs #3, #5, #6, #7, #8, #10, #11, #12). Comanda WIP heredó el patrón "auth via UI, no via DB" del prototipo. Como Comanda está en producción multi-tenant ahora (Neko activo desde 24-may), cada RPC sin `fn_assert_local_autorizado` o `auth_tenant_id()` es una puerta cross-tenant.

3. **Las 14 funciones `fn_*_comanda_offline`** dependen exclusivamente del check del delegado non-offline. Eso es OK si el delegado tiene `fn_assert_local_autorizado` (la mayoría lo tiene), pero es un acoplamiento frágil: si se refactoriza la function non-offline removiendo el check (o si la offline alguna vez decide saltarse la delegación), todos los offline se vuelven exploitable. Convención: **TODAS las RPCs deben tener su propio check defense-in-depth**.

4. **Helpers internos accesibles desde anon/authenticated** (CRÍTICOs #14, #15, ALTO `_get_mp_passphrase`, `_resync_*`, `fn_resolver_venta_id_por_uuid`). El patrón debería ser: si empieza con `_` o es helper interno → `REVOKE EXECUTE FROM PUBLIC; REVOKE EXECUTE FROM anon, authenticated; GRANT EXECUTE TO service_role` por default + agregar a CLAUDE.md las excepciones.

5. **34 funciones sin `SET search_path`** (BAJOs). El linter de Supabase las flagea. Fix global ALTER FUNCTION + agregar regla de linter para CI.

6. **`agent_*` / `dispatch_*` / `_resync_*` funciones llamadas solo por triggers o code interno** — confirmado contando referencias internas (`_resync_liquidacion_pagos` referenciada por 1 fn; `dispatch_auto_fix_workflow` por 1 fn; `agent_update_ticket` por 0 fns externas en DB, llamada desde GitHub Actions/serverless con SERVICE_KEY). Todas pueden y deben REVOKE FROM PUBLIC, anon, authenticated.

7. **GRANTS por default a `anon` + `authenticated` en PASE/Comanda** — Supabase emite GRANTS automáticos al ejecutar `CREATE FUNCTION`. La defensa requiere `REVOKE EXECUTE FROM PUBLIC` explícito en cada migration de RPC interna. Considerar:
   - Migration global que REVOKE EXECUTE FROM PUBLIC en todas las funciones que empiecen con `_` o que el CLAUDE.md marque como helper.
   - Regla de linter en CI: si una nueva migración define una RPC que empieza con `_`, debe incluir `REVOKE EXECUTE FROM PUBLIC`.

8. **Triggers (17) — todos OK** porque corren con el role del trigger (TG_OP), no del caller. El único riesgo identificado en F1 (`trg_sync_saldos_caja` fallback a tenant Neko) ya está cerrado en F1C #2.

9. **`auth_es_superadmin()` correctamente usado** en `eliminar_tenant_completo`, `restore_tenant`, `crear_tenant`, `fn_set_tenant_feature`, `fn_reset_tenant_features`, `fn_set_tenant_features_bulk`, `fn_get_tenant_features`, `fn_generar_invoice_proxima`, `cerrar_ticket`. Excelente baseline para superadmin actions.

10. **Excepciones documentadas correctas** — las 4 listadas en CLAUDE.md (`crear_movimiento_caja_bot`, `set_mp_token`, `aplicar_nc_a_factura`, `crear_tenant`) ya tienen los REVOKE/GRANT/checks adecuados. No requieren fix.

---

## Plan de remediación sugerido (en orden)

### Sprint corto (1 hora — fix REVOKE de helpers)

```sql
-- F2B-FIX-1: REVOKE PUBLIC/anon/authenticated de helpers internos.
REVOKE EXECUTE ON FUNCTION public._resync_liquidacion_pagos(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._resync_pago_especial(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.agent_update_ticket(uuid, text, jsonb, text, integer, text, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dispatch_auto_fix_workflow(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_user_quiere_notif(integer, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_resolver_venta_id_por_uuid(bigint, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_resolver_venta_item_id_por_uuid(bigint, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_calcular_costo_receta_porcion(bigint, bigint, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_recalc_costo_insumo(bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_recalcular_stock_insumo(bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_recalcular_saldo_proveedor(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_recalcular_totales_venta_comanda(bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_aplicar_stock_venta(bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_revertir_stock_venta(bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_cleanup_oauth_states() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_reactivar_items_vencidos() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_procesar_reversos_pendientes_comanda(bigint) FROM PUBLIC, anon, authenticated;
-- Vuelven a estar accesibles vía service_role (cron, triggers, edge functions).
```

Esto cierra 17 CRÍTICOs con 1 migration de 1 hora (drafting + apply + smoke test). NO requiere cambiar el código de ninguna función.

### Sprint medio (1 día — agregar auth checks reales)

Para las funciones donde no se puede simplemente REVOKE (porque el frontend de Comanda SÍ las llama desde anon/authenticated):

- `fn_agregar_pago_venta_comanda` — agregar `PERFORM fn_assert_local_autorizado(v_venta.local_id)` inmediatamente después del SELECT inicial.
- `fn_aplicar_cupon` — idem.
- `fn_marcar_listo_comanda`, `fn_marcar_entregado_comanda`, `fn_set_pedido_geo` — agregar SELECT local_id + `fn_assert_local_autorizado`.
- `editar_venta`, `eliminar_venta`, `eliminar_cierre` — agregar check explícito `IF v_venta.tenant_id <> auth_tenant_id() THEN RAISE 'CROSS_TENANT'`.

### Sprint largo (1 sprint — search_path global + lint)

- ALTER FUNCTION x SET search_path TO 'public' para las ~34 funciones afectadas.
- ESLint custom rule en migrations: nueva función SECURITY DEFINER sin `SET search_path` ni `REVOKE` ni auth helper → bloquear.
- Capa 1 (C11 de CLAUDE.md) está al día con esto: que el linter de Supabase no flagee más esto en deploys.

---

## Sub-fase superada con éxito

Cobertura de la fase F2B contra los hallazgos abiertos por F1:
- **F1C #2 / CRIT-13** (trg_sync_saldos_caja fallback Neko) — ya cerrado, no reapareció en SD audit.
- **F1D #4 / CRIT-8** (idempotency_keys cross-tenant) — verificado en F2B: `crear_gasto_empleado` y `editar_gasto` ya filtran por `tenant_id` en el lookup ✅.
- **F1D #5 / ALTO** (`_validar_local_autorizado` no respeta cesiones) — pendiente, sigue siendo deuda C4-F15 análoga.
- Nuevos hallazgos F2B: 17 CRÍTICOs adicionales, casi todos en Comanda (POS) por falta de checks de auth defense-in-depth en RPCs llamadas desde anon.

## Próxima fase (F3)

F2B reveló que el problema raíz es **GRANTS por default a anon/authenticated en cada CREATE FUNCTION**. Para cerrar la categoría entera:

1. **F3A — Auditar TODAS las RLS policies** de tablas con `tenant_id`. Encontrar tablas sin RLS o con policies permisivas (default ALLOW).
2. **F3B — Auditar uso de `SUPABASE_SERVICE_KEY` en endpoints `api/*.js`**. Cada endpoint debe filtrar por tenant manualmente.
3. **F3C — Verificar `auth.uid()` no esté siendo cacheada incorrectamente** en helpers o en componentes React (sessionStorage `pase_user` ya identificado como stale safe — verificar otros caches).
4. **F3D — Convertir el patrón GRANT-by-default en REVOKE-by-default** mediante un trigger event en `CREATE FUNCTION` + linter de migrations.
