# Fase 2 — Seguridad multi-tenant (consolidado)

**Estado:** ✅ Completa
**Fecha:** 2026-05-27
**Método:** 4 agentes en paralelo (F2A RLS · F2B SECURITY DEFINER · F2C Frontend/Storage · F2D Auth/JWT/sesiones), código leído live del DB + grep masivo del monorepo.

## 📊 Resumen ejecutivo

**95 findings totales** en 4 dominios. **32 CRÍTICOS**. Sub-reportes:
- [02a-rls-policies.md](./02a-rls-policies.md) — 32 findings (8 críticos)
- [02b-security-definer.md](./02b-security-definer.md) — 69 findings (17 críticos)
- [02c-frontend-tenant-scope.md](./02c-frontend-tenant-scope.md) — 15 findings (4 críticos)
- [02d-auth-sessions.md](./02d-auth-sessions.md) — 14 findings (3 críticos)

| Sub-fase | Total | 🔴 | 🟠 | 🟡 | 🟢 |
|---|---|---|---|---|---|
| F2A — RLS policies | 32 | 8 | 8 | 9 | 7 |
| F2B — SECURITY DEFINER | 69 | 17 | 13 | 5 | 34 |
| F2C — Frontend + Storage | 15 | 4 | 4 | 5 | 2 |
| F2D — Auth + sesiones | 14 | 3 | 4 | 4 | 3 |
| **TOTAL** | **130** | **32** | **29** | **23** | **46** |

### ⚠️ Hallazgos confirmados con data real / explotables HOY

1. **`ventas_pos_history`** — 363 cambios históricos de **64 tenants distintos** visibles a cualquier dueño/admin.
2. **`mesas_history`** — 116 rows de 54 tenants.
3. **`ventas_pos_items_history`** — 115 rows de 23 tenants.
4. **`agent_update_ticket` + `dispatch_auto_fix_workflow`** — GRANT a anon/authenticated, comentario dice "solo service_role". Cualquier user puede UPDATE tickets de cualquier tenant + disparar webhook GitHub.
5. **`fn_agregar_pago_venta_comanda`** — sin auth. Tenant A puede registrar pagos sobre ventas de Tenant B (BIGINT secuencial global enumerable).
6. **IG `page_access_token`** en TEXT plano (comentario miente: "encriptado a nivel aplicación"). Dump Postgres = 60d de tokens IG de todos los tenants.
7. **`password_temporal`** chequeado solo en frontend — user recién creado puede llamar `/api/claude` con curl sin cambiar password.
8. **SHA-256 client-side** todavía vivo en Config.tsx + Usuarios.tsx (contradice CLAUDE.md).

---

## 🎯 Ranking ejecutivo de los 32 CRÍTICOS

Ordenados por explotabilidad real + magnitud del leak (los más urgentes primero).

### Grupo A — Leaks de datos cross-tenant (ya activos en prod)

| # | Bug | Sub | Esfuerzo | Magnitud |
|---|---|---|---|---|
| 1 | `ventas_pos_history` policy sin filtro tenant | F2A | 5 min | 363 rows × 64 tenants leak a cualquier admin |
| 2 | `mesas_history` policy sin filtro tenant | F2A | 5 min | 116 rows × 54 tenants |
| 3 | `ventas_pos_items_history` policy sin filtro tenant | F2A | 5 min | 115 rows × 23 tenants |
| 4 | `turnos_caja_history` policy sin filtro tenant | F2A | 5 min | 1 row hoy, latente |

### Grupo B — RPCs sin auth check (Comanda multi-tenant abierta)

| # | Bug | Sub | Esfuerzo | Impacto |
|---|---|---|---|---|
| 5 | `fn_agregar_pago_venta_comanda` sin auth | F2B | 5 min | Cross-tenant: tenant A cobra ventas de B + descalza caja ajena |
| 6 | `fn_procesar_reversos_pendientes_comanda` sin auth | F2B | 5 min | Cross-tenant reversos |
| 7 | `fn_aplicar_cupon` sin auth | F2B | 5 min | Aplicar cupones ajenos a ventas ajenas |
| 8 | `fn_aplicar_stock_venta` / `fn_revertir_stock_venta` sin auth | F2B | 5 min | Corromper stock cross-tenant |
| 9 | `fn_marcar_listo_comanda` / `fn_marcar_entregado_comanda` sin auth | F2B | 5 min | Cambiar estado de ventas ajenas |
| 10 | `fn_modificar_precio_item_comanda_offline` / `fn_cortesia_*` / `fn_anular_*` (3) | F2B | 10 min | Wrapper offline puede bypassear manager check |
| 11 | `fn_set_pedido_geo` sin auth | F2B | 5 min | Setear coords arbitrarias en delivery ajeno |
| 12 | `fn_recalc_costo_insumo` / `fn_recalcular_stock_insumo` sin auth | F2B | 10 min | Corromper costos+stock cross-tenant |
| 13 | `fn_recalcular_totales_venta_comanda` sin auth | F2B | 5 min | Cambiar totales ajenos |
| 14 | `fn_recalcular_saldo_proveedor` sin auth | F2B | 5 min | Corromper saldo proveedor ajeno |

### Grupo C — Helpers internos con GRANT abierto (REVOKE rápido)

| # | Bug | Sub | Esfuerzo |
|---|---|---|---|
| 15 | `agent_update_ticket` GRANT a anon | F2B | 1 min REVOKE |
| 16 | `dispatch_auto_fix_workflow` GRANT a anon | F2B | 1 min REVOKE |
| 17 | `_resync_liquidacion_pagos` / `_resync_pago_especial` GRANT abierto | F2B | 1 min REVOKE |
| 18 | `fn_user_quiere_notif` GRANT abierto | F2B | 1 min REVOKE |

### Grupo D — RLS y schema (1 escape + 3 UNIQUE problemáticos)

| # | Bug | Sub | Esfuerzo |
|---|---|---|---|
| 19 | `comanda_permisos_catalogo` sin RLS habilitado | F2A | 2 min |
| 20 | `comanda_print_agents` UPDATE WITH CHECK=NULL → tenant escape | F2A | 5 min |
| 21 | `usuarios.email` UNIQUE sin tenant_id | F2A | 30 min (ventana) |
| 22 | `comanda_local_settings.slug` UNIQUE sin tenant_id | F2A | 10 min |

### Grupo E — Endpoints serverless expuestos

| # | Bug | Sub | Esfuerzo |
|---|---|---|---|
| 23 | `tienda-mp?action=preference` anon + venta_id enumerable BIGSERIAL | F2C | 1h (HMAC short-lived) ⏸️ |
| 24 | `tienda-mp?action=*-webhook` acepta `?local_id` en query unauth | F2C | 5 min (drop rama) |
| 25 | `afip-cae` idempotency lookup sin filtro tenant | F2C | 2 min |
| 26 | `LectorFacturasIA.tsx` sube facturas sin prefijo tenant → multi-tenant roto | F2C | 2 min |

### Grupo F — Auth gaps

| # | Bug | Sub | Esfuerzo |
|---|---|---|---|
| 27 | IG `page_access_token` en TEXT plano (sin pgcrypto) | F2D | 1-2 h (replicar patrón mp_token con vault.secrets) |
| 28 | `password_temporal` NO enforced server-side | F2D | 30 min |
| 29 | SHA-256 client-side vivo en Config.tsx + Usuarios.tsx | F2D | 30 min |

### Decisiones pendientes (requieren tu input)

| # | Bug | ¿Por qué necesita decisión? |
|---|---|---|
| 30 | `tienda-mp?action=preference` (F2C#1) | Replantear modelo: ¿HMAC en URL? ¿token corto? ¿bloquear y exigir auth? |
| 31 | Cleanup data huérfana F1 (24 sobrepagos, 3 historial perdido, 1 factura, 2 adelantos) | Borrar / corregir / dejar histórico |
| 32 | F1 #3 `pagar_remito` validación | Match exacto / parcial / margen % |
| 33 | F1 #6 `pagar_sueldo` sobrepago | Abortar / opt-in flag |

---

## Plan de ataque

Igual que F1: **auto-fixeo todo lo evidente, dejo solo lo discutible para vos**.

**Migration consolidada `202605270800_audit_f2_criticos.sql`** que toca:
- Grupo A (4 history tables): nuevas policies con filter por `(old_data->>'tenant_id')` o `(new_data->>'tenant_id')`.
- Grupo B (10 RPCs Comanda): agregar `PERFORM fn_assert_local_autorizado(v_venta.local_id)` después del SELECT inicial.
- Grupo C (4 helpers): REVOKE EXECUTE FROM PUBLIC, anon, authenticated.
- Grupo D (1+1): ENABLE RLS + ADD policy + WITH CHECK + UNIQUE (email+tenant), UNIQUE (slug+tenant).
- Grupo F #27: replicar patrón `mp_token` con vault.secrets para IG.

**Edits de código (paquete pase + instagram-bot):**
- F2C#3, #4, #8 (paths + filter)
- F2C#2 (drop rama `req.query.local_id` de webhooks)
- F2D #28 (`_user-auth.js` + middleware)
- F2D #29 (eliminar paths SHA-256 client-side)
- F2D #27 (refactor `oauth-callback.js`, `refresh-tokens.js`, `webhook.js`, `send.js` para usar RPC nueva `get_ig_token`)

**Defer:**
- F2C#1 (tienda-mp preference) — requiere rediseño del flow de checkout, queda en TODO para discutir.

---

## Cross-fase: observaciones generales

1. **Patrón "GRANT por default + comentario engaña":** las RPCs creadas por agentes/scripts heredan `GRANT EXECUTE TO authenticated, anon` por default de Postgres. El comentario `-- Solo callable por service_role` NO ejecuta REVOKE. Auditar TODO el codebase buscando este patrón. (F2B)

2. **Comanda RPCs sin defense-in-depth:** muchos casos asumen "auth via UI", típico de prototipo. Como Comanda está en producción multi-tenant desde 24-may, cada RPC sin `fn_assert_local_autorizado` es vector cross-tenant. (F2B)

3. **Storage upload paths sin prefijo tenant:** 3 de 4 callsites del frontend NO usan `${tenant_id}/...`. Solo `RRHHLegajo.tsx` lo hace bien. (F2C)

4. **`auth_tenant_id()` solo lee `usuarios`:** si COMANDA standalone se activa, rompe (14/14 mapped hoy, latente). (F2A)

5. **34 funciones sin `SET search_path`:** todas son OK funcionalmente pero vulnerables a search_path injection si user logueado crea `pg_temp.tabla`. (F2B)

6. **3 cosas críticas a estar pendiente de actualizar en CLAUDE.md:**
   - "Tablas `canales_history`, `item_precios_canal_history`, `items_history` sin RLS" → OBSOLETA, esas ya están bien; las que faltan son las 4 hermanas (`ventas_pos_history`, etc).
   - "Fallback SHA-256 fue eliminado" → MITAD CIERTO, Login.tsx OK pero Config.tsx + Usuarios.tsx todavía lo escriben.
   - Agregar regla nueva: "Toda RPC nueva con SECURITY DEFINER debe incluir `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` en la misma migration salvo si la RPC es para frontend".

## Para la próxima fase (F3)

F2 cerró seguridad. F3 (performance) puede arrancar en paralelo a los fixes auto-aplicables de F2. Atacar:
- Queries N+1 en dashboards / listados (Caja.tsx 1075 LOC, ConciliacionMP.tsx 1666 LOC).
- Bundle size (lazy load coverage actual + análisis de chunks gordos).
- Índices faltantes en columnas que se filtran masivo (ya hay índices por tenant_id, verificar fecha / local_id / categoría).
- Triggers que disparan SUMs (post 23-may, trg_sync_saldos_caja recalcula full table — verificar latencia).
