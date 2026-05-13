import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: simula el flow del Lector IA llamando directo a la RPC
// `crear_factura_completa` con el shape EXACTO que arma el frontend del
// Lector IA (LectorFacturasIA.tsx::315), incluyendo el caso clave del
// bug del 2026-05-13: el payload NO incluye `tipo`.
//
// El bug original: el frontend del Lector IA arma el payload sin `tipo`,
// y la RPC tenía un fallback `COALESCE(tipo, 'factura')` que NUNCA se
// aplicaba al INSERT (jsonb_populate_record usaba el JSON original).
// Resultado: INSERT fallaba con "null value in column tipo violates not
// null constraint".
//
// Fix doble (commit 4f064ee):
//   1. Frontend: agregar `tipo: "factura"` explícito al payload.
//   2. Migration 202605131500: corregir RPC para que el fallback se aplique
//      al populate_record (defense-in-depth).
//
// Este test ejercita la capa 2 (backend defensivo): llama la RPC SIN tipo
// y verifica que la factura se crea con tipo='factura' por default.

const SENTINEL = 234567.89;
const LOCAL = "Local Prueba 2";
const PROVEEDOR = "Proveedor Prueba";
const NRO = `E2E-LECTOR-IA-${Date.now()}`;

test.describe("Lector IA — RPC crear_factura_completa sin tipo (cobertura bug 2026-05-13)", () => {
  let db: SupabaseClient;
  let localId: number;
  let provId: number;
  let saldoProvInicial: number;
  let facturaId: string | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locales, error: locErr } = await db
      .from("locales")
      .select("id, nombre, tenant_id")
      .eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    if (locales.length > 1) throw new Error(`Hay ${locales.length} locales con nombre "${LOCAL}" — desambiguar`);
    localId = locales[0].id as number;
    const tenantId = locales[0].tenant_id as string;

    const { data: provs, error: provErr } = await db
      .from("proveedores")
      .select("id, nombre, saldo, estado, tenant_id")
      .eq("nombre", PROVEEDOR);
    if (provErr) throw new Error(`Error consultando proveedores: ${provErr.message}`);
    if (!provs || provs.length === 0) {
      throw new Error(
        `Falta proveedor "${PROVEEDOR}" en el tenant Neko. Crearlo con:\n` +
        `INSERT INTO proveedores (nombre, tenant_id, saldo, estado) ` +
        `VALUES ('${PROVEEDOR}', '${tenantId}', 0, 'Activo');`
      );
    }
    if (provs.length > 1) throw new Error(`Hay ${provs.length} proveedores con nombre "${PROVEEDOR}" — desambiguar`);
    provId = provs[0].id as number;
    saldoProvInicial = (provs[0].saldo as number | null) ?? 0;

    facturaId = null;
  });

  test.afterEach(async () => {
    if (facturaId) {
      try {
        const { error } = await db.rpc("anular_factura", {
          p_factura_id: facturaId,
          p_motivo: "e2e lector_ia mutante cleanup",
        });
        if (error && !error.message.includes("YA_ANULADA")) {
          console.error(`[cleanup] anular_factura(${facturaId}): ${error.message}`);
        }
      } catch (e) {
        console.error(`[cleanup] anular_factura threw:`, e);
      }
    }
    if (facturaId) {
      try {
        const { error } = await db.from("facturas").delete().eq("id", facturaId);
        if (error) console.error(`[cleanup] delete facturas(${facturaId}): ${error.message}`);
      } catch (e) {
        console.error(`[cleanup] delete facturas threw:`, e);
      }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("crear_factura_completa SIN tipo: el fallback del backend default a 'factura'", async () => {
    // Shape EXACTO que arma LectorFacturasIA.tsx::315 (post-fix mantiene
    // tipo explícito, pero este test simula el caso adverso: payload
    // SIN tipo — para verificar que la RPC defensiva lo maneja).
    const id = `LECTOR-IA-${Date.now()}`;
    const payload = {
      id,
      prov_id: provId,
      local_id: localId,
      nro: NRO,
      fecha: new Date().toISOString().slice(0, 10),
      venc: null,
      neto: SENTINEL,
      iva21: 0,
      iva105: 0,
      iibb: 0,
      total: SENTINEL,
      cat: "",
      estado: "pendiente",
      pagos: [],
      imagen_url: null,
      // NOTA: NO incluimos `tipo`. El bug original hacía que el INSERT
      // fallara acá. El fix del backend debe aplicar fallback 'factura'.
    };

    const { error } = await db.rpc("crear_factura_completa", {
      p_factura: payload,
      p_items: [],
      p_idempotency_key: crypto.randomUUID(),
    });

    // ── Assert 1: la RPC NO falló por NOT NULL constraint ──────────────
    expect(error).toBeNull();

    // ── Assert 2: la factura existe en DB con tipo='factura' ──────────
    const { data: facturas, error: facturasErr } = await db
      .from("facturas")
      .select("id, prov_id, local_id, nro, total, neto, estado, tipo")
      .eq("id", id);
    expect(facturasErr).toBeNull();
    expect(facturas?.length).toBe(1);
    const f = facturas![0]!;
    expect(f.total).toBe(SENTINEL);
    expect(f.tipo).toBe("factura"); // ← el fallback del backend lo seteó
    expect(f.estado).toBe("pendiente");
    expect(f.prov_id).toBe(provId);
    expect(f.local_id).toBe(localId);
    facturaId = f.id as string;

    // ── Assert 3: el saldo del proveedor subió por SENTINEL ───────────
    // El trigger trg_saldo_proveedor recalcula al INSERT.
    const { data: provFinal, error: provFinalErr } = await db
      .from("proveedores")
      .select("saldo")
      .eq("id", provId)
      .maybeSingle();
    expect(provFinalErr).toBeNull();
    expect(provFinal?.saldo).toBe(saldoProvInicial + SENTINEL);
  });
});
