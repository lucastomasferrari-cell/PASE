import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: pagar un remito con la RPC pagar_remito + idempotency F8.
// DB-only (no UI) por consistencia con los nuevos tests de F8: la
// atomicidad vive en la RPC, y el UI ya es testeado por typecheck/lint/
// build. El primer test valida el happy path; el segundo, idempotency.
const SENTINEL = 345678.99;
const LOCAL = "Local Prueba 2";
const PROVEEDOR = "Proveedor Prueba";
const CUENTA = "Caja Efectivo";

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

test.describe("Remitos — pagar mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let provId: number;
  let saldoCajaInicial: number;
  let saldoProvInicial: number;
  let remitoId: string | null = null;
  let movId: string | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locales, error: locErr } = await db
      .from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    if (locales.length > 1) throw new Error(`Hay ${locales.length} locales con nombre "${LOCAL}"`);
    localId = locales[0].id as number;
    tenantId = locales[0].tenant_id as string;

    const { data: provs } = await db
      .from("proveedores").select("id, saldo").eq("nombre", PROVEEDOR);
    if (!provs || provs.length === 0) {
      throw new Error(
        `Falta proveedor "${PROVEEDOR}". Crearlo con:\n` +
        `INSERT INTO proveedores (nombre, tenant_id, saldo, estado) ` +
        `VALUES ('${PROVEEDOR}', '${tenantId}', 0, 'Activo');`
      );
    }
    provId = provs[0].id as number;
    saldoProvInicial = (provs[0].saldo as number | null) ?? 0;

    const { data: saldoRow } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    if (saldoRow == null) {
      throw new Error(`Falta saldos_caja (${CUENTA}, ${localId}).`);
    }
    saldoCajaInicial = saldoRow.saldo as number;

    remitoId = genId("REM");
    movId = null;
    const { error: insErr } = await db.from("remitos").insert([{
      id: remitoId, prov_id: provId, local_id: localId,
      nro: `E2E-PAGREM-${Date.now()}`,
      fecha: todayISO(), monto: SENTINEL, cat: "Insumos",
      estado: "sin_factura", factura_id: null, tenant_id: tenantId,
    }]);
    if (insErr) throw new Error(`Insert remito: ${insErr.message}`);
  });

  test.afterEach(async () => {
    if (movId) {
      try { await db.rpc("anular_movimiento", { p_mov_id: movId, p_motivo: "e2e cleanup" }); } catch { /* idempotente */ }
      try { await db.from("movimientos").delete().eq("id", movId); } catch { /* idempotente */ }
    }
    if (remitoId) {
      try { await db.from("remitos").delete().eq("id", remitoId); } catch { /* idempotente */ }
    }
    // Limpiar idempotency_keys que hayan quedado del test.
    try { await db.from("idempotency_keys").delete().like("key", "test-rem-%"); } catch { /* idempotente */ }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("pagar_remito: estado pagado + movimiento + saldos + idempotency", async () => {
    const idempKey = `test-rem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const { data: r1, error: e1 } = await db.rpc("pagar_remito", {
      p_remito_id: remitoId,
      p_monto: SENTINEL,
      p_cuenta: CUENTA,
      p_fecha: todayISO(),
      p_idempotency_key: idempKey,
    });
    expect(e1).toBeNull();
    movId = (r1 as { mov_id: string }).mov_id;

    // ── Assert 1: remito.estado='pagado' ────────────────────────────────
    const { data: rems } = await db
      .from("remitos").select("estado").eq("id", remitoId);
    expect(rems?.[0]?.estado).toBe("pagado");

    // ── Assert 2: movimiento creado ────────────────────────────────────
    const { data: movs } = await db
      .from("movimientos")
      .select("id, cuenta, importe, tipo, remito_id_ref, idempotency_key")
      .eq("id", movId);
    expect(movs?.length).toBe(1);
    expect(movs?.[0]?.importe).toBe(-SENTINEL);
    expect(movs?.[0]?.cuenta).toBe(CUENTA);
    expect(movs?.[0]?.tipo).toBe("Pago Proveedor");
    expect(movs?.[0]?.remito_id_ref).toBe(remitoId);
    expect(movs?.[0]?.idempotency_key).toBe(idempKey);

    // ── Assert 3: saldo bajó por SENTINEL ───────────────────────────────
    const { data: saldoAfter } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    expect(saldoAfter?.saldo).toBe(saldoCajaInicial - SENTINEL);

    // ── Assert 4: proveedor.saldo (insertó remito sin trigger directo —
    // pagar_remito no toca proveedores.saldo en la versión actual; el
    // trigger trg_saldo_prov_remitos lo recalcula al cambiar estado).
    const { data: provAfter } = await db
      .from("proveedores").select("saldo").eq("id", provId).maybeSingle();
    expect(provAfter?.saldo).toBe(saldoProvInicial);

    // ── Assert 5: idempotency — 2da llamada con misma key no duplica ────
    const { data: r2, error: e2 } = await db.rpc("pagar_remito", {
      p_remito_id: remitoId,
      p_monto: SENTINEL,
      p_cuenta: CUENTA,
      p_fecha: todayISO(),
      p_idempotency_key: idempKey,
    });
    expect(e2).toBeNull();
    expect((r2 as { idempotent_replay?: boolean }).idempotent_replay).toBe(true);
    expect((r2 as { mov_id: string }).mov_id).toBe(movId);

    // Solo hay 1 movimiento.
    const { data: movsFinal } = await db
      .from("movimientos").select("id").eq("remito_id_ref", remitoId);
    expect(movsFinal?.length).toBe(1);

    // Saldo no cambió tras la 2da llamada.
    const { data: saldoFinal } = await db
      .from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle();
    expect(saldoFinal?.saldo).toBe(saldoCajaInicial - SENTINEL);
  });
});
