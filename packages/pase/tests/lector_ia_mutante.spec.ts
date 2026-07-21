import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Tests mutantes del Lector IA: cubren los DOS paths que el frontend del
// Lector IA puede tomar en LectorFacturasIA.tsx:313:
//
//   const estado = confGlobal < 70 ? "revision" : "pendiente";
//
// → Path A (confianza >= 70%): estado='pendiente' — caso normal.
// → Path B (confianza < 70%): estado='revision' — factura marcada para
//   revisión humana. Bug del 2026-05-13: la migration 202605121600 agregó
//   un CHECK constraint que solo aceptaba 4 estados, omitiendo 'revision'.
//   El empleado de Lucas no podía guardar facturas IA con baja confianza.
//   Fix: migration 202605131800 extendió el constraint a 5 estados.
//
// Bonus: el test A también cubre el caso del payload SIN `tipo` (bug
// previo del 2026-05-13, fix 4f064ee + migration 202605131500). La RPC
// `crear_factura_completa` debe aplicar el fallback 'factura'.
//
// Regla del repo: 1 caller → 1 test. El Lector IA es 1 caller con 2 paths,
// así que llevamos 2 tests aquí.

const SENTINEL = 234567.89;
const SENTINEL_REVISION = 345678.91;
const SENTINEL_ITEMS = 456789.12;
const LOCAL = "Local Prueba 2";
const PROVEEDOR = "Proveedor Prueba";

test.describe("Lector IA — RPC crear_factura_completa (cobertura bugs 2026-05-13)", () => {
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
      // Renglones primero (el test de items los crea; los demás no tienen).
      await db.from("factura_items").delete().eq("factura_id", facturaId).then(() => {}, () => {});
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

  test("Path A (confianza >= 70 → estado='pendiente') SIN tipo: el backend aplica fallback 'factura'", async () => {
    // Shape EXACTO que arma LectorFacturasIA.tsx::315 cuando confGlobal >= 70.
    // Test mutante: simula el caso adverso de payload SIN `tipo` para verificar
    // que la RPC defensiva lo maneja (capa 2, defense-in-depth).
    const id = `LECTOR-IA-${Date.now()}`;
    const nro = `E2E-LECTOR-IA-PEND-${Date.now()}`;
    const payload = {
      id,
      prov_id: provId,
      local_id: localId,
      nro,
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

  test("Path B (confianza < 70 → estado='revision'): el constraint acepta 'revision'", async () => {
    // Shape EXACTO que arma LectorFacturasIA.tsx::315 cuando confGlobal < 70:
    // estado='revision'. Bug del 2026-05-13: la migration 202605121600
    // agregó CHECK que solo aceptaba 4 estados y omitió 'revision'.
    // Empleado de Lucas no podía guardar facturas IA con baja confianza.
    // Fix: migration 202605131800 extiende el constraint a 5 estados.
    const id = `LECTOR-IA-REV-${Date.now()}`;
    const nro = `E2E-LECTOR-IA-REV-${Date.now()}`;
    const payload = {
      id,
      prov_id: provId,
      local_id: localId,
      nro,
      fecha: new Date().toISOString().slice(0, 10),
      venc: null,
      neto: SENTINEL_REVISION,
      iva21: 0,
      iva105: 0,
      iibb: 0,
      total: SENTINEL_REVISION,
      cat: "",
      estado: "revision", // ← el path adverso del Lector IA
      pagos: [],
      imagen_url: null,
      tipo: "factura",
    };

    const { error } = await db.rpc("crear_factura_completa", {
      p_factura: payload,
      p_items: [],
      p_idempotency_key: crypto.randomUUID(),
    });

    // ── Assert 1: la RPC NO falló por facturas_estado_check ────────────
    expect(error).toBeNull();

    // ── Assert 2: la factura persistió con estado='revision' ──────────
    const { data: facturas, error: facturasErr } = await db
      .from("facturas")
      .select("id, estado, total, tipo")
      .eq("id", id);
    expect(facturasErr).toBeNull();
    expect(facturas?.length).toBe(1);
    const f = facturas![0]!;
    expect(f.estado).toBe("revision");
    expect(f.tipo).toBe("factura");
    expect(f.total).toBe(SENTINEL_REVISION);
    facturaId = f.id as string;

    // ── Assert 3: el saldo del proveedor subió por SENTINEL_REVISION ──
    const { data: provFinal, error: provFinalErr } = await db
      .from("proveedores")
      .select("saldo")
      .eq("id", provId)
      .maybeSingle();
    expect(provFinalErr).toBeNull();
    expect(provFinal?.saldo).toBe(saldoProvInicial + SENTINEL_REVISION);
  });

  test("Path items: la RPC persiste p_items y un renglón CMV cae en la bandeja de Cruce", async () => {
    // Regresión Request B (21-jul): el Lector IA extraía los renglones pero
    // guardaba p_items: [] → los descartaba. Ahora los pasa. Verificamos que
    // crear_factura_completa persiste los factura_items y que un renglón de
    // mercadería (categoría grupo CMV) aparece en v_bandeja_conciliacion para
    // cruzarlo con su insumo (pantalla Cruce del Recetario).
    const { data: cats } = await db
      .from("config_categorias").select("nombre").eq("grupo", "CMV").limit(1);
    const catCMV = (cats?.[0]?.nombre as string) ?? "";
    expect(catCMV.length).toBeGreaterThan(0); // el tenant debe tener alguna CMV

    const id = `LECTOR-IA-ITEMS-${Date.now()}`;
    const nro = `E2E-LECTOR-IA-ITEMS-${Date.now()}`;
    const producto = `ZZITEMS Producto ${Date.now()}`;
    const payload = {
      id, prov_id: provId, local_id: localId, nro,
      fecha: new Date().toISOString().slice(0, 10), venc: null,
      neto: SENTINEL_ITEMS, iva21: 0, iva105: 0, iibb: 0, total: SENTINEL_ITEMS,
      cat: catCMV, estado: "pendiente", pagos: [], imagen_url: null, tipo: "factura",
    };

    const { error } = await db.rpc("crear_factura_completa", {
      p_factura: payload,
      p_items: [{ producto, cantidad: 2, unidad: "kg", precio_unitario: 100, subtotal: 200 }],
      p_idempotency_key: crypto.randomUUID(),
    });
    expect(error).toBeNull();
    facturaId = id;

    // ── Assert 1: el renglón se PERSISTIÓ (antes se tiraba con []) ──────
    const { data: items, error: itErr } = await db
      .from("factura_items")
      .select("producto, cantidad, materia_prima_id")
      .eq("factura_id", id);
    expect(itErr).toBeNull();
    expect(items?.length).toBe(1);
    expect(items![0]!.producto).toBe(producto);
    expect(Number(items![0]!.cantidad)).toBe(2);
    expect(items![0]!.materia_prima_id).toBeNull(); // sin cruzar todavía

    // ── Assert 2: aparece en la bandeja de Cruce (grupo CMV) ───────────
    const { data: bandeja, error: bErr } = await db
      .from("v_bandeja_conciliacion")
      .select("factura_item_id, grupo_categoria")
      .eq("factura_id", id);
    expect(bErr).toBeNull();
    expect(bandeja?.length).toBe(1);
    expect(bandeja![0]!.grupo_categoria).toBe("CMV");
  });
});
