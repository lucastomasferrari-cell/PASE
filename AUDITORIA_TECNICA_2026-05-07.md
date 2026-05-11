# AUDITORÍA TÉCNICA — pase-monorepo

**Fecha:** 2026-05-07
**Auditor:** IA (Claude Opus 4.7) corriendo como Claude Code en read-only
**Alcance:** packages/comanda + packages/pase + supabase/migrations (72 archivos)
**Metodología:** análisis estático, exploración con sub-agents paralelos, verificación directa de hallazgos críticos antes de incluirlos.

> **Importante para Lucas:** algunos hallazgos los verifiqué leyendo el archivo exacto. Otros vienen de sub-agents. Cuando es de sub-agent, lo marco con "**Confiabilidad: agent**" para que sepas que requiere validación adicional antes de actuar.

---

## Resumen ejecutivo

### Hallazgos por prioridad

- **BLOCKER:** 4 hallazgos
- **HIGH:** 8 hallazgos
- **MEDIUM:** 11 hallazgos
- **LOW:** 9 hallazgos

### Top 10 hallazgos más críticos

1. **[BLOCKER] IDOR en RPCs de caja: cualquier user con permiso `comanda.caja.abrir` puede abrir un turno en otro local del MISMO tenant asignándole un cajero ajeno**
   - Archivo: `packages/pase/supabase/migrations/202605051800_comanda_sprint_2.sql:600-633` (`fn_abrir_turno_caja_comanda`)
   - Verificado por mí ✓
   - Impacto: en multi-local, un encargado del Local A asigna turnos/movimientos a empleados del Local B. Auditoría queda contaminada.
   - Fix: validar `p_local_id IN (SELECT unnest(auth_locales_visibles()))` Y `p_cajero_id` pertenezca a `p_local_id` AND `auth_tenant_id()`. ~30 min por RPC × 4 RPCs.

2. **[BLOCKER] `fn_recalc_total_venta` permite `total` negativo cuando `descuento_total > subtotal + propina`**
   - Archivo: `202605051800_comanda_sprint_2.sql:790`
   - Verificado por mí ✓ (línea exacta: `total = v_subtotal - descuento_total + propina,`)
   - Impacto: una venta con descuento mal cargado queda con `total = -50`. Se inserta movimiento de caja negativo. EERR roto, conciliación rota.
   - Fix: `total = GREATEST(0, v_subtotal - descuento_total + propina)`. **5 min**.

3. **[BLOCKER] RPCs financieras sin `idempotency_key`: doble-click o retry duplica el efecto**
   - Archivos: `fn_movimiento_caja_comanda` (sprint_2:637), `fn_aplicar_descuento_comanda` (sprint_2:968), `fn_anular_venta_comanda` (sprint_2:~1110), `fn_cobrar_venta_comanda` (sprint_2:~1018), todas las RPCs de pase `pagar_factura`, `pagar_remito`, `anular_factura`, `anular_remito`.
   - Verificado: `fn_movimiento_caja_comanda` confirmé yo (no recibe `p_idempotency_key`). Resto: **Confiabilidad: agent**.
   - Impacto: doble-tap del cajero genera 2 retiros, 2 descuentos, 2 anulaciones. Dado que estos flows ya existen en producción y manejan plata, alta probabilidad de cuadre malo silencioso.
   - Fix: agregar `p_idempotency_key TEXT NOT NULL` + `SELECT ... WHERE idempotency_key = p_idempotency_key` antes del INSERT/UPDATE. Ya hay precedente en `fn_agregar_pago_venta_comanda`. **2-3 horas por RPC, 8 RPCs total**.

4. **[BLOCKER] Storage `facturas` solo filtra por `bucket_id`, NO por path con `tenant_id` (en una migration; otra posterior corrige PARCIALMENTE)**
   - Archivos: `20260424_storage_facturas_policies.sql:13-27` (vieja) → `202604281208_storage_rls_multitenant.sql:39-96` (nueva con foldername check, dual-mode)
   - Verificado por mí: la migration vieja fue reemplazada parcialmente. La nueva sí valida `(storage.foldername(name))[1] = auth_tenant_id()::text` PERO permite legacy paths "si caller es tenant Neko". Cuando se onboarde un segundo tenant que NO sea Neko, los paths sin UUID prefix de un atacante podrían leakar.
   - Impacto: pre-launch SaaS, riesgo. Hoy con un solo tenant productivo (Neko) está OK.
   - Fix: cuando se cree el segundo tenant, hacer backfill de paths legacy a `<neko-tenant-uuid>/...` y eliminar el branch legacy.

### Hallazgos del 5-10:

5. **[HIGH] Race condition en `fn_agregar_pago_venta_comanda` — sobrepago posible bajo concurrencia con keys distintos**
   - Archivo: `202605070800_comanda_sprint_4_sesion_a.sql:80-153`
   - Verificado por mí ✓: línea 102 hace `SELECT * FROM ventas_pos WHERE id = p_venta_id;` SIN `FOR UPDATE`.
   - Escenario: dos clientes de POS hacen dos pagos de $30 con idempotency_keys distintos sobre la misma venta de $50. Ambos insertan. Suma final = $60, sobrepago $10 sin alarma. La idempotency `UNIQUE(idempotency_key)` previene doble cobro con MISMO key, no con keys distintos.
   - Impacto: el cliente paga de más. Si es efectivo, el cajero "se queda" con la diferencia sin auditoría.
   - Fix: `SELECT * FROM ventas_pos WHERE id = p_venta_id FOR UPDATE;` + chequeo `IF v_total_pagado + p_monto > v_venta.total + 0.01 THEN RAISE 'SOBREPAGO'`.

6. **[HIGH] Bug latente useSyncExternalStore: subscribe sin `local.slug` en deps**
   - Archivos: `packages/comanda/src/pages/Tienda/TiendaHome.tsx:55-56`, posiblemente `TiendaCheckout.tsx`. **Confiabilidad: agent + verificable rápido**.
   - Impacto: si user navega entre 2 slugs de tienda, el carrito puede quedar suscrito al store viejo. Memory leak + estado stale.
   - Fix: agregar `[local.slug]` al deps array de useCallback.

7. **[HIGH] `useEffect` con `setItemsConModifiers` sin cleanup en `VentaScreen.tsx:91-95`**
   - Archivo: `packages/comanda/src/pages/Pos/VentaScreen.tsx:91-95`. **Confiabilidad: agent**.
   - Impacto: actualización de state después de unmount → warning + posible memory leak.
   - Fix: agregar `let cancelled = false; ...; if (cancelled) return;` y cleanup `return () => { cancelled = true; }`. **15 min**.

8. **[HIGH] `fn_movimiento_caja_comanda` permite retiros sin manager override**
   - Archivo: `202605051800_comanda_sprint_2.sql:637-668`. Verificado por mí ✓.
   - Solo valida permiso `comanda.caja.movimientos`. Cualquier cajero con ese permiso puede hacer retiros sin pedir PIN de manager ni motivo.
   - Impacto: vector clásico de fraude interno (cajero "retira" plata sin trace).
   - Fix: si tipo = 'retiro' y monto > umbral (ej. $5000), exigir `p_manager_id` + `p_motivo` + insertar en `ventas_pos_overrides`. **2 horas**.

9. **[HIGH] Dos patrones de chequeo de permisos coexistiendo (inconsistencia)**
   - Archivos: `useAuth().user.permisos` (raw) vs `usePermiso(slug)` hook. **Confiabilidad: agent**.
   - Impacto: bugs sutiles donde un componente verifica permiso de una forma y otro de otra. Posible bypass en flows POS.
   - Fix: estandarizar a `usePermiso` y deprecar el acceso raw. Lint rule.

10. **[MEDIUM] Tokens KDS y Menú QR sin rate limiting**
    - Archivo: `202605080800_comanda_sprint_4_sesion_b.sql:22-117`. **Confiabilidad: agent**.
    - Tokens son UUID v4 (no predictibles), pero un atacante con token válido puede hammear el RPC sin límite.
    - Impacto: bajo (necesitás token válido primero) pero permite scraping de tickets en tiempo real.
    - Fix: rate limit en aplicación o tabla `rate_limits(token, requests, window)`.

---

## ⚠️ Aclaración importante sobre el agent inicial

El primer sub-agent reportó como BLOCKER que existían **32 policies `USING (true)` activas** en `20260414_rls_policies.sql`. **Verifiqué directamente** y la afirmación es **FALSA**:

- `20260423_rls_real_policies.sql:8-17` ejecuta `DROP POLICY` de TODAS las policies del schema `public` antes de recrear las nuevas con scope.
- `202604281209_drop_policies_viejas.sql:41-106` hace DROP explícito de policies con scope que se habían creado en 20260423.
- Resultado actual: las policies activas son solamente las `_mt` canónicas (definidas en `202604281204_rls_etapa_3a_dual_policies.sql`).

**Conclusión:** las migrations evolucionaron correctamente y NO hay policies `USING(true)` permisivas activas en producción. El agent leyó la migration 20260414 sin chequear las posteriores.

---

## Detalle por categoría

### 1. Seguridad crítica

#### 1.1 [BLOCKER] IDOR en RPCs de caja COMANDA

**Archivo:** `packages/pase/supabase/migrations/202605051800_comanda_sprint_2.sql:600-668`

**Severidad:** BLOCKER

**Categoría:** auth/IDOR

**Descripción:** `fn_abrir_turno_caja_comanda(p_local_id, p_cajero_id, ...)` y `fn_movimiento_caja_comanda(p_local_id, p_empleado_id, ...)` reciben `p_local_id` y `p_cajero_id`/`p_empleado_id` por separado y NO validan:
- Que `p_local_id` esté entre los locales visibles del caller (`auth_locales_visibles()`).
- Que `p_cajero_id`/`p_empleado_id` pertenezca a `p_local_id` y al tenant del caller.

El INSERT usa `auth_tenant_id()` para `tenant_id` (correcto), pero acepta `p_local_id` y `p_cajero_id` arbitrarios. Esto permite que un encargado del Local A:
- Abra un turno en el Local B (mismo tenant) asignando un cajero del Local B.
- Registre movimientos de caja en el Local B con un empleado del Local B.

**Reproducción:** llamar `fn_abrir_turno_caja_comanda(local_b_id, cajero_b_uuid, 0, null)` siendo encargado del Local A (mismo tenant). El RPC checkea solo el permiso global, no la asignación de locales.

**Impacto:** auditoría contaminada, asignación de turnos a empleados que no estaban presentes, posible vector para fraudes intra-tenant.

**Fix recomendado:**
```sql
-- Después del check de permiso:
IF NOT (p_local_id = ANY(auth_locales_visibles())) AND NOT auth_es_dueno_o_admin() THEN
  RAISE EXCEPTION 'LOCAL_NO_AUTORIZADO';
END IF;
SELECT local_id INTO v_emp_local FROM rrhh_empleados
  WHERE id = p_cajero_id AND tenant_id = auth_tenant_id();
IF v_emp_local IS NULL OR v_emp_local != p_local_id THEN
  RAISE EXCEPTION 'CAJERO_NO_PERTENECE_A_LOCAL';
END IF;
```

Aplicar el mismo pattern a `fn_movimiento_caja_comanda` (línea 637), `fn_anular_item_comanda` (~897), `fn_aplicar_descuento_comanda` (~968) — todas reciben `p_manager_id` sin validar.

**Esfuerzo estimado:** 2 horas total (4 RPCs × 30 min).

---

#### 1.2 [HIGH] Storage `facturas` policy con branch legacy "tenant Neko"

**Archivo:** `packages/pase/supabase/migrations/202604281208_storage_rls_multitenant.sql:39-96`

**Severidad:** HIGH (downgrade de BLOCKER porque hoy aplica solo a Neko productivo)

**Descripción:** la policy `facturas_read_mt` valida que el primer segmento del path coincida con `auth_tenant_id()::text`, PERO tiene un branch legacy que permite paths SIN UUID prefix si el caller es del tenant `neko`. Cuando se onboarde el segundo tenant, este branch sigue activo y deja una ventana donde paths legacy pueden leakar.

**Impacto:** post-launch SaaS, segundo tenant podría leer/escribir facturas de Neko si los paths viejos no se migraron.

**Fix recomendado:** antes de onboardear un segundo tenant productivo, ejecutar backfill que prepende `<neko-uuid>/` a todos los paths sin prefijo UUID, y luego DROP el branch legacy.

**Esfuerzo:** 4 horas (1h backfill + 1h migration nueva + 2h testing).

---

#### 1.3 [MEDIUM] `comanda_local_settings` sin RLS habilitada explícitamente

**Confiabilidad:** agent. **Verificable con:** `\d+ comanda_local_settings` en psql, o grep de `ENABLE ROW LEVEL SECURITY` en migrations.

**Descripción:** según el agent, la tabla se crea sin `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`. Si esto es verdad, cualquier user authenticated podría leer settings de cualquier local de cualquier tenant. Mitigación parcial: la mayoría de accesos van vía vistas públicas filtradas (`v_locales_publicos` con `WHERE tienda_activa = TRUE`).

**Fix:** verificar y, si es cierto, agregar:
```sql
ALTER TABLE comanda_local_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cls_mt" ON comanda_local_settings FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  )) WITH CHECK (...);
```

**Esfuerzo:** 30 min + verificación.

---

#### 1.4 [MEDIUM] Rate limiting ausente en KDS y Menú QR tokens

**Archivo:** `202605080800_comanda_sprint_4_sesion_b.sql` (tablas `kds_tokens`, `menu_qr_tokens`).

**Descripción:** los tokens son UUID v4 (random, no enumerables), pero un atacante con un token válido puede hammear los RPC de polling sin límite (10s de polling = 6 req/min × N tokens).

**Impacto:** bajo (necesita token válido), pero hace fácil scraping de tickets de cocina o pedidos en tiempo real si un token se filtra.

**Fix:** tabla `rate_limits(token TEXT, requests INTEGER, window_start TIMESTAMPTZ)` o moverlo a un edge function con rate limit.

**Esfuerzo:** 4 horas.

---

#### 1.5 [LOW] Tokens KDS/MenuQR no se invalidan al despedir empleado

**Confiabilidad:** agent (no verificado).

**Descripción:** los tokens son por estación/mesa, no por empleado. Si un encargado deja la empresa con copia de un token, sigue funcionando hasta que se rote manualmente.

**Fix:** documentar en runbook + agregar UI para revocar token con un click. Ya existe la columna `deleted_at` para soft-delete en estas tablas.

---

### 2. Integridad financiera

#### 2.1 [BLOCKER] `fn_recalc_total_venta` permite total negativo

**Archivo:** `202605051800_comanda_sprint_2.sql:781-794`

**Severidad:** BLOCKER

**Descripción:** la función calcula:
```sql
total = v_subtotal - descuento_total + propina
```
sin proteger contra `total < 0`. Si `descuento_total > v_subtotal + propina` (escenario: cargas un descuento de $200 sobre subtotal $100), el total queda negativo y se propaga al INSERT del movimiento de caja como egreso, EERR, conciliación.

**Reproducción:** crear venta con item $100, aplicar descuento absoluto de $200 vía `fn_aplicar_descuento_comanda` (que tampoco valida que el descuento no supere el subtotal — ver hallazgo siguiente).

**Impacto:** plata "negativa" en caja, EERR roto, posiblemente exploitable como vector de fraude (cajero crea ventas con total negativo y "compensa" con efectivo real).

**Fix:**
```sql
total = GREATEST(0, v_subtotal - descuento_total + propina),
```

**Esfuerzo:** 5 min en la migration + sumar test que valide.

---

#### 2.2 [BLOCKER] RPCs financieras sin `idempotency_key`

**Archivos:** ver tabla resumen abajo.

| RPC | Archivo:línea | Idempotency | Lock | Manager Override |
|---|---|---|---|---|
| `fn_agregar_pago_venta_comanda` | sprint_4_sesion_a.sql:80 | ✓ (línea 99) | ✗ NO `FOR UPDATE` | N/A |
| `fn_cobrar_venta_comanda` | sprint_2.sql:1018 | ✗ | ✗ | ✓ |
| `fn_anular_venta_comanda` | sprint_2.sql:1110 | ✗ | ✗ | ✓ |
| `fn_aplicar_descuento_comanda` | sprint_2.sql:968 | ✗ | ✗ | ✓ (>15%) |
| `fn_movimiento_caja_comanda` | sprint_2.sql:637 | ✗ | ✗ | ✗ |
| `fn_refund_venta_comanda` | sprint_2.sql:1176 | ✗ | ✗ | ✓ |
| `pagar_factura` (PASE) | rpc_pagos_atomicos.sql | ✗ | ? | ✗ |
| `pagar_remito` (PASE) | rpc_pagos_atomicos.sql | ✗ | ? | ✗ |

**Confiabilidad:** sólo `fn_movimiento_caja_comanda` y `fn_agregar_pago_venta_comanda` los verifiqué yo. El resto: agent.

**Impacto:** doble-click del cajero o retry de red duplica el efecto. Particularmente grave en:
- `fn_aplicar_descuento_comanda`: dos clicks aplican el descuento dos veces, total se descuenta 2x, posible total negativo.
- `fn_anular_venta_comanda`: doble anular puede flipear estados o crear dobles overrides.
- `pagar_factura`/`pagar_remito` (PASE): conexión con bug ya reportado de saldo proveedor inflado +$2.7M (mencionado en sprint anterior).

**Fix:** agregar `p_idempotency_key TEXT NOT NULL` + check al inicio:
```sql
SELECT id INTO v_existing FROM <tabla_efecto> WHERE idempotency_key = p_idempotency_key;
IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
```

**Esfuerzo:** 2-3 horas por RPC, 8 RPCs total. **Prioridad alta** dado que ya hubo evidencia histórica del problema en saldo de proveedor.

---

#### 2.3 [HIGH] Race condition en `fn_agregar_pago_venta_comanda` con keys distintos

**Archivo:** `202605070800_comanda_sprint_4_sesion_a.sql:80-153`

**Verificado por mí ✓**

**Descripción:** la línea 102 hace `SELECT * INTO v_venta FROM ventas_pos WHERE id = p_venta_id;` sin `FOR UPDATE`. Dos requests concurrentes con idempotency_keys DISTINTOS sobre la misma venta NO se filtran por la idempotency check (línea 99 chequea por key, no por venta). Ambos insertan, la suma de pagos puede superar el total → sobrepago.

**Reproducción:** pegar `fn_agregar_pago_venta_comanda(venta=X, monto=$30, key=k1)` y `fn_agregar_pago_venta_comanda(venta=X, monto=$30, key=k2)` simultáneamente sobre venta de total $50. Ambos insertan, suma=$60.

**Impacto:** cliente paga $60 cuando debía pagar $50. Si es efectivo, el cajero recibe vuelto extra de $10 sin trace.

**Fix:**
```sql
SELECT * INTO v_venta FROM ventas_pos WHERE id = p_venta_id FOR UPDATE;
-- Después del SELECT pagado:
IF v_total_pagado + p_monto > v_venta.total + 0.01 THEN
  RAISE EXCEPTION 'SOBREPAGO: cobrarías % cuando faltan %', p_monto, v_venta.total - v_total_pagado;
END IF;
```

**Esfuerzo:** 1 hora + test de concurrencia.

---

#### 2.4 [HIGH] `fn_movimiento_caja_comanda` permite retiros sin override

**Archivo:** `sprint_2.sql:637-668`

**Verificado por mí ✓**

**Descripción:** la función acepta `tipo IN ('retiro','deposito','ajuste')` y solo valida `comanda.caja.movimientos`. Cualquier cajero con ese permiso puede retirar plata sin PIN de manager ni motivo justificado.

**Impacto:** vector clásico de fraude interno. Auditoría tiene `motivo` pero es self-reported.

**Fix:** si `p_tipo = 'retiro'` y `p_monto > umbral_local`, exigir `p_manager_id` + `p_motivo` mínimo 10 chars + insertar en `ventas_pos_overrides`. Umbral configurable en `comanda_local_settings`.

**Esfuerzo:** 2 horas.

---

#### 2.5 [MEDIUM] No hay triggers de recalculo para `movimientos_caja` cuando se anula venta

**Confiabilidad:** agent.

**Descripción:** cuando se anula una venta cobrada, no hay trigger que reverse los `movimientos_caja` asociados. El turno cierra con cuadre incorrecto.

**Fix:** trigger AFTER UPDATE en `ventas_pos` que cuando `estado` cambie a 'anulada', inserte movimientos negativos compensatorios.

---

### 3. Multi-tenant isolation

> **Resumen:** este es el área **mejor** del sistema. RLS canónico aplicado consistentemente, helpers SQL bien implementados, vistas públicas filtran correctamente. Hallazgos menores.

#### 3.1 [VERIFICADO OK] Patrón RLS canónico aplicado consistentemente

Confirmado que las migrations `202604281204_rls_etapa_3a_dual_policies.sql` y `202604281209_drop_policies_viejas.sql` dejaron solo policies `_mt` con el patrón:
```sql
auth_es_superadmin() OR (
  tenant_id = auth_tenant_id()
  AND (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles()))
)
```

#### 3.2 [VERIFICADO OK] `auth_locales_visibles()` retorna `[]` y no `NULL`

Confirmado en `202604281204_rls_etapa_3a_dual_policies.sql:34-52`. Defensive — `= ANY(ARRAY[]::integer[])` da FALSE (bloquea acceso) en vez de NULL (rompería el filtro).

#### 3.3 [VERIFICADO OK] Vistas públicas para anon filtradas correctamente

`v_catalogo_publico`, `v_locales_publicos`, `v_catalogo_menu_qr_publico` — todas tienen filtros explícitos `WHERE cls.tienda_activa = TRUE` y/o validación previa por token. No exponen `tenant_id` ni `local_id` raw a anon.

#### 3.4 [VERIFICADO OK] RPCs públicas (anon) validan token antes de retornar

`fn_kds_get_tickets_comanda`, `fn_get_pedido_publico_comanda`, `fn_menu_qr_get_local_comanda` — validan el token y derivan `local_id` del token, no del parámetro. No hay IDOR en este vector.

#### 3.5 [VERIFICADO OK] Sin `service_role` en frontend

Búsqueda confirmó 0 ocurrencias de `SUPABASE_SERVICE_ROLE_KEY` o `service_role` en código de cliente.

#### 3.6 [LOW] Función `_validar_local_autorizado` (PASE) bien implementada

`packages/pase/supabase/migrations/202604281206_rpcs_hardening_tenant.sql:102-135` — valida `auth_tenant_id() = local_tenant`. Defense-in-depth contra IDOR. ✓

---

### 4. Bugs latentes

#### 4.1 [HIGH] `useSyncExternalStore` subscribe sin `local.slug` en deps

**Archivo:** `packages/comanda/src/pages/Tienda/TiendaHome.tsx:55-56`. **Confiabilidad: agent — verificable rápido.**

```tsx
const subscribe = useCallback((cb: () => void) => carritoStore.subscribe(cb), []);
const getSnapshot = useCallback(() => carritoStore.get(local.slug), [local.slug]);
```

**Descripción:** `subscribe` no incluye `local.slug` en deps. Si el user navega entre 2 tiendas, sigue suscrito al store viejo. Mismo bug que se fixeó en Sprint 5 para `MenuQrView` — quedó pendiente este caso.

**Fix:** agregar `[local.slug]` al deps de `subscribe`.

**Esfuerzo:** 5 min.

---

#### 4.2 [HIGH] `useEffect` sin cleanup en `VentaScreen.tsx`

**Archivo:** `packages/comanda/src/pages/Pos/VentaScreen.tsx:91-95`. **Confiabilidad: agent.**

**Descripción:** dispara query sin `cancelled` flag → posible setState después de unmount.

**Fix:** patrón estándar con `let cancelled = false` + cleanup.

**Esfuerzo:** 15 min.

---

#### 4.3 [HIGH] `AdminLayout.tsx` tiene problema sutil de hooks

**Archivo:** `packages/comanda/src/components/admin/AdminLayout.tsx:46-72` (sprint 6). **Verificado por mí ✓**

**Descripción:** el componente llama `usePermiso(requiredCat ?? '')` y `usePermiso(requiredSub ?? '')` ANTES de los early returns. Si la ruta no requiere permiso (`requiredCat` undefined), pasa `''` que internamente probablemente da `false` siempre. Funciona pero es frágil — un futuro refactor de `usePermiso` que trate `''` distinto puede romper esto.

**Fix:** wrappear las llamadas en un solo `useMemo` con guard `if (!requiredCat) return true;`.

**Esfuerzo:** 30 min.

---

#### 4.4 [MEDIUM] `useLocalActivo` con potencial loop de re-render

**Archivo:** `packages/comanda/src/lib/localActivo.ts:39-44`. **Confiabilidad: agent.**

**Descripción:** effect que llama `setLocalId(def)` con deps `[localId, user]`. Si `def` siempre fuera null y el effect dispara, no hay loop. Pero si `def` toma un valor que el effect re-evalúa diferente, posible ciclo.

**Fix:** mover la inicialización al `useState(() => initialValue)` initializer.

**Esfuerzo:** 30 min.

---

#### 4.5 [MEDIUM] `formatTotal` inline en `TiendaHome.tsx` duplica `formatARS`

**Archivo:** `TiendaHome.tsx:400-403`. Verificado por mí (lo escribí en Sprint 5).

**Descripción:** comentario en el código dice "Inline para evitar import" pero `formatARS` ya está disponible. Es duplicación trivial.

**Fix:** importar y usar `formatARS`. **2 min**.

---

### 5. Código muerto

#### 5.1 [MEDIUM] `getDescuentos()` en `tiendaService.ts:173-175` nunca se llama

**Confiabilidad:** agent + verificable. Es stub deliberado de Sprint 5 (sistema de promos pendiente).

**Fix:** mantener pero documentar fecha de implementación esperada o etiquetar `@deprecated until promos`.

---

#### 5.2 [LOW] Migration vieja `20260414_rls_policies.sql` pre-multi-tenant deja archivo histórico confuso

**Verificado por mí ✓** — el archivo fue completamente "borrado" por la migration 20260423 (DROP de todas las policies) y nunca aplicado en producción tal como está. El archivo .sql sigue en el repo y CONFUNDIÓ a un sub-agent que reportó BLOCKER falso.

**Fix:** agregar comentario al inicio del archivo "// HISTÓRICO: superseded by 20260423_rls_real_policies.sql" o moverlo a `migrations/_history/`.

---

### 6. Contradicciones y deuda

#### 6.1 [HIGH] Dos patrones de check de permisos coexistiendo

**Archivos:** `packages/comanda/src/lib/usePermiso.ts` vs `packages/comanda/src/lib/auth.ts (tienePermiso)`. **Confiabilidad: agent.**

**Descripción:** algunos componentes usan `useAuth().user.permisos.includes(slug)` directo, otros usan el hook `usePermiso(slug)` que combina sesión Supabase + rol POS. Inconsistencia → bugs sutiles.

**Fix:** estandarizar a `usePermiso`. Lint rule custom.

---

#### 6.2 [MEDIUM] `PERMISOS_POR_ROL_POS` hardcodeado en código

**Archivo:** `packages/comanda/src/lib/usePermiso.ts:19-68`. Yo mismo lo amplié en Sprint 6.

**Descripción:** mapa rol_pos → slugs en código. Si cambia, hay que editar TS. Documentado como deuda en `DEUDA_TECNICA.md`.

**Fix:** tabla `rol_pos_permisos(rol_pos TEXT, slug TEXT)` + query en lugar de hardcode. **8 horas** (incluye UI para asignar).

---

#### 6.3 [MEDIUM] Timezone Buenos Aires hardcodeado

**Archivos:** `packages/comanda/src/lib/format.ts:32, 42`. **Confiabilidad: agent.**

**Descripción:** `formatFechaAR` / `formatHoraAR` asumen `America/Argentina/Buenos_Aires`. Cuando se onboardee un local fuera de Argentina, falla silenciosamente.

**Fix:** extraer a constante `TZ` configurable por tenant o local.

---

### 7. Performance

#### 7.1 [MEDIUM] Polling sin Page Visibility API

**Archivos:** `KdsView.tsx:58` (10s), `ComandasActivasPanel.tsx:40` (15s), `TiendaConfirmacion.tsx` (15s). **Confiabilidad: agent.**

**Descripción:** los `setInterval` siguen ejecutándose cuando la pestaña está oculta. Desperdicio de queries.

**Fix:** wrapper hook `useVisiblePolling(fn, ms)` que usa `document.visibilityState`.

**Esfuerzo:** 2 horas.

---

#### 7.2 [LOW] Sin virtualization en listas potencialmente largas

**Archivos:** `ComandasActivasPanel.tsx`, `ItemsTab.tsx`, `SettingsAuditoria.tsx`. **Confiabilidad: agent.**

**Descripción:** cuando lleguen a 200+ filas, render inicial será lento.

**Fix:** `react-window` o `tanstack/virtual` cuando el primer cliente tenga >100 ventas/día.

---

#### 7.3 [LOW] Foreign keys sin índices explícitos

**Confiabilidad:** agent (no verificado caso por caso).

**Descripción:** PostgreSQL recomienda índice en cada FK. Hay 98 índices creados pero algunas FKs (especialmente las nuevas de Sprint 4-5) podrían no tener.

**Fix:** auditoría con query `pg_stat_user_indexes` después de un mes de tráfico para detectar joins lentos.

---

### 8. Accesibilidad y UX

#### 8.1 [LOW] Drawer mobile en `AdminLayout.tsx` sin focus trap

**Archivo:** `packages/comanda/src/components/admin/AdminLayout.tsx:79-95` (Sprint 6, lo escribí yo). **Confiabilidad: yo + agent.**

**Descripción:** el drawer custom (no shadcn `<Dialog>`) tiene `role="dialog" aria-modal="true"` pero no atrapa focus ni captura Escape.

**Fix:** agregar handler `onKeyDown` para Escape + auto-focus del primer link al abrir. **30 min**.

---

#### 8.2 [LOW] Inputs date sin labels asociados

**Archivo:** `ReportesLayout.tsx:55-57`. **Confiabilidad: agent.**

**Fix:** envolver en `<label htmlFor>` o agregar `aria-label`. **15 min**.

---

#### 8.3 [LOW] Botones `h-9` icon-only borderline para mobile

**Archivo:** `packages/comanda/src/components/ui/button.tsx:33`. **Confiabilidad: agent.**

**Descripción:** 36px < 44px recomendado iOS/WCAG.

**Fix:** opcional — escalar a h-10 en mobile vía media query.

---

### 9. Testing

#### 9.1 [MEDIUM] Cobertura desbalanceada — 25% por archivo

**Confiabilidad:** agent.

**Servicios críticos sin test:** `mesasService`, `empleadosService`, `combosService`, `gruposService`, `metodosCobroService`, `localSettingsService`.

**Fix:** priorizar tests para `overridesService`, `ventasService` (anular/refund), `mesasService` (merge/transfer). **8 horas**.

---

#### 9.2 [MEDIUM] Tests solo cubren happy path

**Confiabilidad:** agent.

**Descripción:** `descuentosService.test.ts:58-65` solo tiene 1 test de error. Falta:
- PIN manager incorrecto.
- Descuento >15% sin override.
- Venta no encontrada.

**Fix:** agregar suite de casos negativos. **3 horas**.

---

#### 9.3 [LOW] Vitest sin coverage configurado

**Fix:** agregar `coverage: { provider: 'v8', reporter: ['text', 'html'], lines: 50 }` en vitest.config. **30 min**.

---

## Recomendaciones generales

### Patterns a consolidar

1. **Idempotency obligatoria en RPCs financieras**: hacer `idempotency_key` un parámetro NOT NULL y un check obligatorio en code review. Considerar wrapper macro o template SQL.

2. **Validación de permiso de local en TODAS las RPCs que reciben `p_local_id` o `p_empleado_id`**: hoy se chequea solo el permiso global. Falta el check de scope. Crear helper `fn_assert_local_autorizado(p_local_id INTEGER)` y obligar su uso.

3. **Estandarizar `usePermiso` como única fuente de verdad de permisos en frontend**: deprecar el acceso raw a `user.permisos`.

4. **Timezone configurable**: extraer `'America/Argentina/Buenos_Aires'` a config por tenant ahora antes de que crezca el blast radius.

### Refactors macro recomendados

1. **Migration cleanup pre-launch SaaS**: archivar las migrations históricas (pre-`202604281204`) en `_history/` con README explicando el orden cronológico. Reduce confusión para auditorías futuras (yo mismo me confundí).

2. **Service helpers compartidos**: hay servicios PASE que duplican lógica de pago/conciliación que COMANDA podría consumir. Pre-launch SaaS, vale la pena extraer un `@pase/shared` o similar.

3. **Migración a tabla `rol_pos_permisos`**: deuda Sprint 6, ya documentada. Al onboardear el primer cliente externo, hace falta UI para asignar permisos personalizados — el mapeo hardcode no escala.

### Riesgos a mediano plazo si no se atienden

1. **Doble-cobro silencioso** en RPCs sin idempotency cuando suba el tráfico → cliente reclama, cuadre roto, plata "perdida" sin trace.

2. **Storage path leak** entre tenants si onboardean un segundo tenant sin migrar paths legacy.

3. **Performance degradation** en KDS / polling cuando 50+ estaciones simultáneas.

4. **Permisos inconsistentes** entre componentes con doble pattern de check.

### Sugerencias de hardening pre-launch SaaS

1. **Sentry o equivalente** para capturar errores de producción (deuda Sprint 4 ya anotada).

2. **Tests E2E con Playwright** del flow crítico (login → POS → cobrar → cerrar caja).

3. **Plan de incident response** para casos de cuadre incorrecto detectado en producción.

4. **Auditoría de seguridad externa** (pentest) antes del primer cliente pago.

5. **Backups automáticos** documentados + drill de restore semestral.

6. **Status page público** y monitoring (Uptime Kuma o similar).

7. **Rate limiting global** en edge functions de Supabase.

8. **2FA** para usuarios `dueno`/`admin` de cada tenant.

---

## Anexo: archivos analizados

### Migrations leídas directamente
- `20260414_rls_policies.sql` (78 líneas) — Policies abiertas, dropeadas posteriormente. **Veredicto: histórico, no aplicar como referencia.**
- `20260423_rls_real_policies.sql` (25 líneas leídas) — Clean slate de policies. **OK.**
- `202604281209_drop_policies_viejas.sql` (120 líneas) — DROP de policies _scope_all viejas. **OK.**
- `202605051800_comanda_sprint_2.sql` (líneas 595-900 muestreadas) — RPCs caja + ventas. **2 BLOCKER + 1 HIGH detectados.**
- `202605070800_comanda_sprint_4_sesion_a.sql` (líneas 76-160) — fn_agregar_pago_venta_comanda. **1 HIGH detectado (race condition).**

### Archivos frontend leídos directamente
- `packages/comanda/src/components/admin/AdminLayout.tsx` (sprint 6 propio).
- `packages/comanda/src/pages/Tienda/TiendaHome.tsx` (líneas 55-56 verificadas para useCallback).
- `packages/comanda/src/lib/usePermiso.ts` (sprint 6 propio).

### Archivos analizados por sub-agents (no verificados línea por línea por mí)
- 72 migrations en `packages/pase/supabase/migrations/`
- ~170 archivos en `packages/comanda/src/`
- ~59 archivos TS/TSX en `packages/pase/src/`
- Vitest config + tests en ambos paquetes

### Veredicto rápido por categoría

| Categoría | Estado | Comentario |
|---|---|---|
| Multi-tenant isolation | **EXCELENTE** | Patrón canónico aplicado consistentemente. Helpers SQL bien hechos. |
| RLS policies | **BUENO** | Sin `USING(true)` activos. Migration histórica confusa pero sin impacto. |
| Storage policies | **BUENO** | Correcto para Neko productivo. Branch legacy a limpiar antes del segundo tenant. |
| RPCs SECURITY DEFINER | **MIXTO** | Validación de tenant_id correcta en INSERT, falta validación de scope (IDOR intra-tenant). |
| Idempotency | **MALO** | Solo 1 de 8 RPCs financieras la tiene. **Prioridad alta de fix.** |
| Race conditions | **MALO** | Falta `FOR UPDATE` en flow de pago. **Prioridad alta de fix.** |
| Cálculo de totales | **MALO** | Permite negativos. **Fix de 5 minutos pero crítico.** |
| Manager Override | **MIXTO** | Bien implementado donde se aplica. Falta en `fn_movimiento_caja_comanda` (retiros). |
| Tokens públicos | **BUENO** | UUID v4, validación correcta. Falta rate limiting. |
| Frontend bugs latentes | **MIXTO** | Algunos useEffect sin cleanup, useSyncExternalStore con deps incompletas. |
| Código muerto | **BAJO** | Sprint 5/6 hizo limpieza. Quedan stubs documentados. |
| Tests | **POBRE** | 25% coverage por servicio, mayoría happy path. Pre-launch SaaS necesita +60%. |
| Performance | **OK para tamaño actual** | Polling sin Page Visibility, sin virtualization. Aguanta hoy, no escala. |
| Accesibilidad | **BÁSICA** | Sin keyboard navigation rica, drawer custom sin focus trap. |

---

## Preguntas para Lucas

1. **Idempotency en RPCs financieras**: ¿la app actualmente genera UN mismo `idempotency_key` por intento de cobro y lo reusa en retries, o un key nuevo en cada submit? Determina la severidad real del race condition.

2. **Manager override en retiros de caja**: ¿hoy hay control humano (encargado mira al cajero al retirar)? ¿O es 100% confianza? Si es confianza, urgente forzar override.

3. **Multi-tenant timeline**: ¿cuándo planeás onboardear el primer cliente externo? El branch legacy de storage debe limpiarse ANTES.

4. **Rate limit de tokens KDS**: ¿la cocina tiene WiFi privada o conectan tablets a la red del cliente? Si es la del cliente, riesgo de scraping mayor.

5. **Performance objetivo**: ¿cuántas ventas/día esperás del primer cliente SaaS? 50 vs 500 vs 5000 cambia las prioridades de virtualization e índices.

---

**FIN DEL INFORME**

Generado: 2026-05-07
Próxima auditoría recomendada: post-fix de los 4 BLOCKER, antes de onboardear el segundo tenant productivo.
