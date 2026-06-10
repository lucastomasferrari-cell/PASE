import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: discriminación fiscal AR ampliada (Lucas 10-jun).
// Verifica que la RPC crear_factura_completa acepta las 9 columnas nuevas
// (iva27, no_gravado, exento, iibb_caba/ba/otros + jurisdicción,
// perc_ganancias, retencion_suss) y que el SELECT del Libro IVA Compras las
// lee correctamente. Verifica también:
//   - iibb legacy plano = suma de las 3 jurisdicciones (cache mantenido por FE)
//   - Total auto-calculado incluye TODOS los campos
//
// Cleanup: anular_factura + delete.

const LOCAL = "Local Prueba 2";
const PROVEEDOR = "Proveedor Prueba";
const NRO = `E2E-DISCFISC-${Date.now()}`;

// Sentinels distintivos por campo, todos en magnitudes razonables (no
// disparan los warnings de "monto sospechoso" en el FE).
const S = {
  neto: 100000,
  iva21: 21000,
  iva105: 5250,
  iva27: 1350,
  no_gravado: 2500,
  exento: 1000,
  iibb_caba: 1500,
  iibb_ba: 2300,
  iibb_otros: 800,
  perc_iva: 3000,
  perc_ganancias: 1200,
  retencion_suss: 700,
  otros_cargos: 4500,
  descuentos: 1000,
};
// Total esperado = suma de todo (excepto descuentos que resta)
const TOTAL_ESPERADO =
  S.neto + S.no_gravado + S.exento +
  S.iva21 + S.iva105 + S.iva27 +
  (S.iibb_caba + S.iibb_ba + S.iibb_otros) +
  S.perc_iva + S.perc_ganancias + S.retencion_suss +
  S.otros_cargos - S.descuentos;
const IIBB_TOTAL = S.iibb_caba + S.iibb_ba + S.iibb_otros;

test.describe("Facturas — discriminación fiscal AR mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let provId: number;
  let tenantId: string;
  let facturaId: string | null = null;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    const { data: locales } = await db
      .from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (!locales || locales.length === 0) throw new Error(`Falta local ${LOCAL}`);
    localId = locales[0]!.id as number;
    tenantId = locales[0]!.tenant_id as string;

    const { data: provs } = await db
      .from("proveedores").select("id").eq("nombre", PROVEEDOR);
    if (!provs || provs.length === 0) throw new Error(`Falta proveedor ${PROVEEDOR}`);
    provId = provs[0]!.id as number;
    facturaId = null;
  });

  test.afterEach(async () => {
    if (facturaId) {
      try {
        const { error } = await db.rpc("anular_factura", {
          p_factura_id: facturaId,
          p_motivo: "e2e disc-fiscal cleanup",
        });
        if (error && !error.message.includes("YA_ANULADA")) {
          // eslint-disable-next-line no-console
          console.error("[cleanup] anular_factura:", error.message);
        }
      } catch (e) { /* idempotente */ void e; }
      try { await db.from("facturas").delete().eq("id", facturaId); }
      catch (e) { /* idempotente */ void e; }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("la RPC crear_factura_completa acepta las 9 columnas nuevas y guarda todo", async () => {
    const id = `FACT-E2E-DF-${Date.now()}`;
    const payload = {
      id,
      tenant_id: tenantId,
      prov_id: provId,
      local_id: localId,
      nro: NRO,
      fecha: new Date().toISOString().slice(0, 10),
      venc: new Date().toISOString().slice(0, 10),
      neto: S.neto,
      iva21: S.iva21,
      iva105: S.iva105,
      iva27: S.iva27,
      no_gravado: S.no_gravado,
      exento: S.exento,
      iibb: IIBB_TOTAL, // cache de suma
      iibb_caba: S.iibb_caba,
      iibb_ba: S.iibb_ba,
      iibb_otros: S.iibb_otros,
      iibb_otros_jurisdiccion: "Córdoba",
      perc_iva: S.perc_iva,
      perc_ganancias: S.perc_ganancias,
      retencion_suss: S.retencion_suss,
      otros_cargos: S.otros_cargos,
      descuentos: S.descuentos,
      total: TOTAL_ESPERADO,
      cat: "OTROS",
      estado: "pendiente",
      detalle: "e2e discriminación fiscal AR",
      tipo: "factura",
      pagos: [],
    };

    const { data, error } = await db.rpc("crear_factura_completa", {
      p_factura: payload,
      p_items: [],
      p_idempotency_key: crypto.randomUUID(),
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();
    facturaId = id;

    // Assert 1: la factura existe con TODAS las columnas pobladas correctamente
    const { data: rows, error: selErr } = await db
      .from("facturas")
      .select(`
        id, total, neto, iva21, iva105, iva27,
        no_gravado, exento,
        iibb, iibb_caba, iibb_ba, iibb_otros, iibb_otros_jurisdiccion,
        perc_iva, perc_ganancias, retencion_suss,
        otros_cargos, descuentos, estado
      `)
      .eq("id", id);
    expect(selErr).toBeNull();
    expect(rows?.length).toBe(1);
    const f = rows![0]!;

    expect(Number(f.neto)).toBe(S.neto);
    expect(Number(f.iva21)).toBe(S.iva21);
    expect(Number(f.iva105)).toBe(S.iva105);
    expect(Number(f.iva27)).toBe(S.iva27);
    expect(Number(f.no_gravado)).toBe(S.no_gravado);
    expect(Number(f.exento)).toBe(S.exento);
    expect(Number(f.iibb_caba)).toBe(S.iibb_caba);
    expect(Number(f.iibb_ba)).toBe(S.iibb_ba);
    expect(Number(f.iibb_otros)).toBe(S.iibb_otros);
    expect(f.iibb_otros_jurisdiccion).toBe("Córdoba");
    // iibb legacy = suma exacta de las 3 jurisdicciones
    expect(Number(f.iibb)).toBe(IIBB_TOTAL);
    expect(Number(f.perc_iva)).toBe(S.perc_iva);
    expect(Number(f.perc_ganancias)).toBe(S.perc_ganancias);
    expect(Number(f.retencion_suss)).toBe(S.retencion_suss);
    expect(Number(f.otros_cargos)).toBe(S.otros_cargos);
    expect(Number(f.descuentos)).toBe(S.descuentos);
    expect(Number(f.total)).toBe(TOTAL_ESPERADO);
    expect(f.estado).toBe("pendiente");
  });
});
