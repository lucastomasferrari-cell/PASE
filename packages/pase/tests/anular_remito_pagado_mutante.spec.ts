import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: anular un remito PAGADO debe revertir el pago en caja.
// Antes anular_remito no tocaba el pago → la plata quedaba gastada sin remito
// (caja descuadrada). Ahora anula el movimiento de pago y devuelve el saldo,
// todo en la misma transacción. DB-only: la atomicidad vive en la RPC.
const SENTINEL = 456789.55;
const LOCAL = "Local Prueba 2";
const PROVEEDOR = "Proveedor Prueba";
const CUENTA = "Caja Efectivo";

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

test.describe("Remitos — anular pagado mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let provId: number;
  let saldoCajaInicial: number;
  let remitoId: string | null = null;
  let movId: string | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locales, error: locErr } = await db
      .from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    localId = locales[0].id as number;
    tenantId = locales[0].tenant_id as string;

    const { data: provs } = await db
      .from("proveedores").select("id").eq("nombre", PROVEEDOR);
    if (!provs || provs.length === 0) throw new Error(`Falta proveedor "${PROVEEDOR}".`);
    provId = provs[0].id as number;

    const { data: saldoRow } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    if (saldoRow == null) throw new Error(`Falta saldos_caja (${CUENTA}, ${localId}).`);
    saldoCajaInicial = saldoRow.saldo as number;

    remitoId = genId("REM");
    movId = null;
    const { error: insErr } = await db.from("remitos").insert([{
      id: remitoId, prov_id: provId, local_id: localId,
      nro: `E2E-ANULREM-${Date.now()}`,
      fecha: todayISO(), monto: SENTINEL, cat: "Insumos",
      estado: "sin_factura", factura_id: null, tenant_id: tenantId,
    }]);
    if (insErr) throw new Error(`Insert remito: ${insErr.message}`);
  });

  test.afterEach(async () => {
    if (movId) {
      try { await db.from("movimientos").delete().eq("id", movId); } catch { /* idempotente */ }
    }
    if (remitoId) {
      try { await db.from("remitos").delete().eq("id", remitoId); } catch { /* idempotente */ }
    }
    try { await db.from("idempotency_keys").delete().like("key", "test-anulrem-%"); } catch { /* idempotente */ }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("anular_remito de un remito pagado revierte el pago y la caja", async () => {
    // 1) Pagar el remito → baja la caja por SENTINEL.
    const idempKey = `test-anulrem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const { data: pago, error: ePago } = await db.rpc("pagar_remito", {
      p_remito_id: remitoId, p_monto: SENTINEL, p_cuenta: CUENTA,
      p_fecha: todayISO(), p_idempotency_key: idempKey,
    });
    expect(ePago).toBeNull();
    movId = (pago as { mov_id: string }).mov_id;

    const { data: saldoPostPago } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    expect(saldoPostPago?.saldo).toBe(saldoCajaInicial - SENTINEL);

    // 2) Anular el remito pagado.
    const { data: anul, error: eAnul } = await db.rpc("anular_remito", {
      p_remito_id: remitoId, p_motivo: "e2e anular pagado",
    });
    expect(eAnul).toBeNull();
    expect((anul as { estado: string }).estado).toBe("anulado");
    expect((anul as { pagos_revertidos: number }).pagos_revertidos).toBe(1);

    // ── Assert 1: remito anulado ──────────────────────────────────────────
    const { data: rems } = await db
      .from("remitos").select("estado").eq("id", remitoId);
    expect(rems?.[0]?.estado).toBe("anulado");

    // ── Assert 2: movimiento de pago anulado ──────────────────────────────
    const { data: movs } = await db
      .from("movimientos").select("anulado").eq("id", movId);
    expect(movs?.[0]?.anulado).toBe(true);

    // ── Assert 3: la caja volvió al saldo inicial (plata devuelta) ─────────
    const { data: saldoFinal } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    expect(saldoFinal?.saldo).toBe(saldoCajaInicial);
  });
});
