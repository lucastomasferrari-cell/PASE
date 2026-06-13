# Cobro Offline en COMANDA (Tier 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development, tarea por tarea.

**Goal:** Que el POS pueda COBRAR sin internet — hoy es el único flujo crítico online-only (riesgo operativo #1 del piloto). `PaymentDialog` y `ComensalSplitDialog` llaman `agregarPago()` → `fn_agregar_pago_venta_comanda` (RPC directa, sin rama offline ni wrapper). Fix: dar a `agregarPago()` una rama offline SIMÉTRICA a la que `cobrar()` ya tiene — encola la op, escribe el pago local, marca la venta cobrada localmente; al volver internet la cola flushea contra un wrapper `_offline` nuevo. NO se tocan los dialogs (siguen llamando `agregarPago`). NO se toca el motor de cola (está sólido).

**Arquitectura (verificada 13-jun):**
- `fn_agregar_pago_venta_comanda` (vigente en `202605270800:148`): idempotente por `p_idempotency_key` (por-pago: `SELECT id FROM ventas_pos_pagos WHERE idempotency_key=...` → return si existe); inserta el pago; cuando `total_pagado + monto >= venta.total` marca `estado='cobrada'` + libera mesa (lo que dispara los triggers de stock, proyección de ventas y auto-finalizar reserva); crea `movimientos_caja` si hay turno. **Es replay-safe tal cual.**
- El cliente ya tiene el patrón completo (`pagosOfflineService.cobrarVentaOffline`, `ventasOfflineService`, `enqueueOperation`, `pushQueue`, reconciliación tempId→BIGINT). `pushQueue` agrega el sufijo `_offline` automáticamente cuando el payload tiene una key con `idempotency_uuid` no-nula.
- `agregarPago()` en `pagosService.ts` (líneas 119-132) hoy SOLO hace `db.rpc('fn_agregar_pago_venta_comanda', ...)`. `cobrar()` (líneas 21-74) ya tiene el patrón `if (featureFlags.offlineFirstVentas) { ...offline... } else { ...online... }` — copiamos ESE patrón a `agregarPago()`.
- La venta creada offline tiene `idempotency_uuid` en su fila local (lo setea `abrirVentaOffline`). El pago offline lo pasa como `p_venta_idempotency_uuid` para que el wrapper resuelva el `venta_id` aunque sea tempId.

**Reglas del repo:** money-logic en prod (explicar/cuidado), C2 mutante, `REVOKE FROM PUBLIC, anon` + GRANT (lección 11-jun: los default privileges de Supabase dan EXECUTE a anon en toda función nueva), dry-run con ROLLBACK, e2e-full misma PR, push + deploy comanda READY.

---

### Task 1: Migración — wrapper `fn_agregar_pago_venta_comanda_offline`

**Files:** Create `packages/pase/supabase/migrations/202606130600_agregar_pago_offline_wrapper.sql`

- [ ] **Step 0:** Confirmar la firma vigente de `fn_agregar_pago_venta_comanda` (grep `CREATE OR REPLACE FUNCTION (public\.)?fn_agregar_pago_venta_comanda` — la más alta; debería ser `202605270800` pero verificar que no haya posterior). Confirmar que existe `fn_resolver_venta_id_por_uuid(bigint, uuid)` (creada en 202605161400, la usan los otros wrappers). Mirar 1-2 wrappers existentes (`fn_cobrar_venta_comanda_offline` en `202605161500`) para copiar el patrón EXACTO (orden de params, dedup, REVOKE).

- [ ] **Step 1:** Escribir el wrapper:
```sql
-- 202606130600_agregar_pago_offline_wrapper.sql
-- Tier 2 (cobro offline): wrapper _offline para fn_agregar_pago_venta_comanda.
-- PaymentDialog/ComensalSplitDialog cobran incremental (un pago a la vez) y
-- hoy llaman la RPC directa (online-only). Este wrapper permite que la cola
-- offline replay-ee cada pago: resuelve la venta por UUID (puede ser tempId no
-- sincronizado) y delega en la inner, que ya es idempotente por idempotency_key.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_agregar_pago_venta_comanda_offline(
  p_venta_id bigint,
  p_venta_idempotency_uuid uuid,
  p_metodo text,
  p_monto numeric,
  p_idempotency_key text,                       -- per-pago dedup (lo usa la inner)
  p_cobrado_por uuid DEFAULT NULL,
  p_vuelto numeric DEFAULT NULL,
  p_propina_incluida numeric DEFAULT 0,
  p_cuotas integer DEFAULT NULL,
  p_idempotency_uuid uuid DEFAULT NULL           -- op-level (consistencia con otros wrappers)
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_venta_id bigint;
BEGIN
  v_venta_id := fn_resolver_venta_id_por_uuid(p_venta_id, p_venta_idempotency_uuid);
  RETURN fn_agregar_pago_venta_comanda(
    v_venta_id, p_metodo, p_monto, p_idempotency_key,
    p_cobrado_por, p_vuelto, p_propina_incluida, p_cuotas
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_agregar_pago_venta_comanda_offline(bigint, uuid, text, numeric, text, uuid, numeric, numeric, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_agregar_pago_venta_comanda_offline(bigint, uuid, text, numeric, text, uuid, numeric, numeric, integer, uuid) TO authenticated, service_role;

COMMIT;
```
(Ajustar el orden EXACTO de params al de la inner verificada en Step 0; el dedup real lo hace la inner por `idempotency_key`, así que el wrapper no necesita su propio check de `idempotency_uuid` — pero si los otros wrappers lo tienen, replicar por consistencia. La firma de params debe matchear EXACTO el REVOKE/GRANT.)

- [ ] **Step 2:** Commit `feat(comanda): wrapper fn_agregar_pago_venta_comanda_offline (cobro offline)`.

---

### Task 2: Aplicar en prod (dry-run obligatorio) + smoke

- [ ] env pull → script Write tool → DRY_RUN=1 (BEGIN/COMMIT neutralizado + ROLLBACK) → aplicar.
- [ ] Smoke: `SELECT proname, proacl FROM pg_proc WHERE proname='fn_agregar_pago_venta_comanda_offline'` → existe y anon NO está en proacl. Limpiar temporales.

---

### Task 3: Cliente — `agregarPagoOffline` + rama offline en `agregarPago()`

**Files:**
- Modify: `packages/comanda/src/services/offline/pagosOfflineService.ts` (agregar `agregarPagoOffline`)
- Modify: `packages/comanda/src/services/pagosService.ts` (`agregarPago` gana la rama offline)

- [ ] **Step 1:** En `pagosOfflineService.ts` agregar (mirror de `cobrarVentaOffline` + el patrón de `ventasOfflineService.agregarItemOffline` para `depends_on`):
```typescript
export interface AgregarPagoOfflineArgs {
  ventaId: number;              // tempId negativo o BIGINT real
  ventaUuid: string | null;     // idempotency_uuid de la venta (para resolver tempId)
  ventaOpId?: string | null;    // _local_op_id de la venta, para depends_on
  metodo: string;
  monto: number;
  idempotencyKey: string;       // per-pago (la genera el dialog: newIdempotencyKey())
  cobradoPor?: string | null;
  vuelto?: number | null;
  propinaIncluida?: number;
  cuotas?: number | null;
  tenantId: string;
  localId: number;
}

export async function agregarPagoOffline(a: AgregarPagoOfflineArgs): Promise<{ tempPagoId: number; queuedOpId: string }> {
  const now = new Date().toISOString();
  const tempId = nextTempId();

  // 1. Pago local
  const pago = {
    id: tempId, tenant_id: a.tenantId, local_id: a.localId, venta_id: a.ventaId,
    metodo: a.metodo, monto: a.monto, idempotency_key: a.idempotencyKey,
    vuelto: a.vuelto ?? 0, propina_incluida: a.propinaIncluida ?? 0,
    cobrado_por: a.cobradoPor ?? null, created_at: now,
  } as unknown as LocalVentaPago;
  await ventasPagosRepo.put(pago);

  // 2. Si los pagos locales cubren el total → marcar venta cobrada localmente
  const venta = await ventasRepo.getById(a.ventaId);
  if (venta) {
    const pagosLocales = await ventasPagosRepo.listByVenta(a.ventaId); // ver helper real
    const sumado = pagosLocales.reduce((s, p) => s + Number(p.monto), 0);
    if (sumado >= Number(venta.total) - 0.01) {
      venta.estado = 'cobrada';
      (venta as unknown as { cobrada_at: string | null }).cobrada_at = now;
      venta.updated_at = now;
      await ventasRepo.put(venta);
    }
  }

  // 3. Encola. pushQueue agrega `_offline` por la key p_venta_idempotency_uuid.
  const queuedOpId = await enqueueOperation({
    target: 'fn_agregar_pago_venta_comanda',
    op_type: 'rpc',
    payload: {
      p_venta_id: a.ventaId > 0 ? a.ventaId : null,
      p_venta_idempotency_uuid: a.ventaUuid,
      p_metodo: a.metodo,
      p_monto: a.monto,
      p_idempotency_key: a.idempotencyKey,
      p_cobrado_por: a.cobradoPor ?? null,
      p_vuelto: a.vuelto ?? null,
      p_propina_incluida: a.propinaIncluida ?? 0,
      p_cuotas: a.cuotas ?? null,
    },
    depends_on: a.ventaId < 0 ? (a.ventaOpId ?? null) : null,
    reconcile: { kind: 'none' }, // el pull incremental trae el pago real con su BIGINT
  });

  void syncEngine.triggerPush();
  return { tempPagoId: tempId, queuedOpId };
}
```
Verificar el helper real para listar pagos por venta (`ventasPagosRepo.listByVenta` o equivalente — usar el que exista; si no hay, sumar leyendo el store). Verificar que `LocalVentaPos` expone `idempotency_uuid` y `_local_op_id`.

- [ ] **Step 2:** En `pagosService.ts`, `agregarPago()` gana la rama offline (copiar el patrón EXACTO de `cobrar()` que ya está en ese archivo):
```typescript
export async function agregarPago(args: AgregarPagoArgs): Promise<{ pagoId: number | null; error: string | null }> {
  const { featureFlags } = await import('../lib/featureFlags');
  if (featureFlags.offlineFirstVentas) {
    const { agregarPagoOffline } = await import('./offline/pagosOfflineService');
    const { ventasRepo } = await import('@/lib/db/repositories/ventasRepo');
    const venta = await ventasRepo.getById(args.ventaId);
    if (!venta) return { pagoId: null, error: 'VENTA_NO_ENCONTRADA' };
    try {
      const r = await agregarPagoOffline({
        ventaId: args.ventaId,
        ventaUuid: (venta as { idempotency_uuid?: string | null }).idempotency_uuid ?? null,
        ventaOpId: (venta as { _local_op_id?: string | null })._local_op_id ?? null,
        metodo: args.metodo, monto: args.monto, idempotencyKey: args.idempotencyKey,
        cobradoPor: args.cobradoPor ?? null, vuelto: args.vuelto ?? null,
        propinaIncluida: args.propinaIncluida ?? 0, cuotas: args.cuotas ?? null,
        tenantId: venta.tenant_id, localId: venta.local_id,
      });
      return { pagoId: r.tempPagoId, error: null };
    } catch (err) {
      return { pagoId: null, error: err instanceof Error ? err.message : 'Error cobrando offline' };
    }
  }
  // ── camino online legacy (idéntico al actual) ──
  const { data, error } = await db.rpc('fn_agregar_pago_venta_comanda', { /* ...igual que hoy... */ });
  if (error) return { pagoId: null, error: translateError(error) };
  return { pagoId: data as number, error: null };
}
```
- [ ] **Step 3:** `pnpm --filter comanda typecheck && lint && test` verdes. Los dialogs NO se tocan. Commit.

---

### Task 4: Tests

- [ ] **Mutante offline** (extender `packages/pase/tests/offline_first_mutante.spec.ts` o nuevo `cobro_offline_mutante.spec.ts`): contra prod (Local Prueba 2): abrir venta offline (uuid) + agregar item → `fn_agregar_pago_venta_comanda_offline(p_venta_id=null, p_venta_idempotency_uuid=<uuid venta>, ...)` resuelve la venta y registra el pago; al cubrir el total la venta queda `cobrada`; **idempotencia**: 2 llamadas con el mismo `p_idempotency_key` no duplican el pago (misma fila). Cleanup: anular venta + borrar pagos/items.
- [ ] **e2e-full #43** (`43-wrappers-offline-contrato.spec.ts`): agregar `fn_agregar_pago_venta_comanda_offline` a la lista de wrappers que el test de contrato verifica (Probe A: error de negocio, nunca 42883/PGRST202; Probe B: anon → 42501). Así el contrato lo cuida de futuras divergencias.
- [ ] **Unit comanda**: test de `agregarPagoOffline` (encola op con `p_venta_idempotency_uuid`, escribe pago local, marca venta cobrada al cubrir). Si hay `pagosService.test.ts`, agregar caso del branch offline (mock featureFlags on).
- [ ] Correr: mutante nuevo + `offline_first_mutante` (regresión) con `--project=mutante`; comanda unit; e2e-full COMPLETA (`--project=e2e-full`) verde.
- [ ] Commit tests.

---

### Task 5: Cierre

- [ ] Push + deploy comanda READY.
- [ ] Memoria: cobro offline cerrado; el flag `offlineFirstVentas` ahora cubre cobro incremental; nota: la unificación de wrappers (matar los _offline, RPCs canónicas con p_idempotency_uuid) sigue pendiente como deuda estructural (el #43 los cuida mientras tanto); `cobrarVentaOffline` tiene un placeholder `'__pending_parent__'` sospechoso (no lo usa PaymentDialog — revisar si es dead code o bug latente).

---

## Self-review
- Cobertura: cobro offline ✅ (rama en agregarPago, simétrica a cobrar), idempotencia ✅ (inner por idempotency_key + UUID venta), venta tempId ✅ (resolver por uuid + depends_on), marca cobrada local + server ✅, dialogs sin tocar ✅, contrato #43 cuida el wrapper nuevo ✅, mutante ✅.
- Riesgo: money-logic. Mitigado: la inner NO cambia (solo se agrega un wrapper que delega), dry-run, mutante de idempotencia, e2e-full. El peor caso (replay duplica pago) está bloqueado por el dedup por idempotency_key de la inner — probado en el mutante.
- Fuera de alcance (consciente): unificación de los ~12 wrappers, el dual-path del flag, el `'__pending_parent__'` de cobrarVentaOffline. Documentados como deuda.
