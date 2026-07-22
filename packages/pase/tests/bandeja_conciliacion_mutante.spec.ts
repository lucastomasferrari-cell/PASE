import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// ─────────────────────────────────────────────────────────────────────────
// Test mutante: bandeja conciliadora Compras→Insumos (Pieza A).
// Spec: docs/superpowers/specs/2026-06-07-bandeja-conciliacion-compras-insumos-design.md
//
// Valida el circuito completo:
//   1. Un renglón de mercadería sin materia prima aparece en v_bandeja_conciliacion.
//   2. fn_conciliar_producto → setea materia_prima_id + escribe compras_mapeo +
//      el trigger suma stock (factor de conversión) + sale de la bandeja.
//   3. Una 2da factura con el MISMO producto (escrito distinto) se auto-vincula
//      sola (memoria + normalización) → NO entra a la bandeja.
//   4. fn_descartar_renglon → un renglón descartado no vuelve a la bandeja.
//
// DB-only. Crea todos sus prerequisitos (proveedor, categoría CMV, insumo,
// materia prima) con prefijo SENTINEL y limpia todo en afterEach.
// ─────────────────────────────────────────────────────────────────────────
const SENT = "ZZMUTBANDEJA";
const LOCAL = "Local Prueba 2";
const PRODUCTO = `${SENT} Producto Test`;

test.describe("Bandeja conciliadora — mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let provId: number;
  let catNombre: string;
  let insumoId: number;
  let mpId: number;
  let catCreada = false;
  let provCreado = false;
  const facturaIds: string[] = [];

  test.beforeEach(async () => {
    db = await createDuenoClient();
    const { data: locs } = await db.from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (!locs || locs.length !== 1) throw new Error(`Local "${LOCAL}" no único`);
    localId = locs[0].id as number;
    tenantId = locs[0].tenant_id as string;

    // Proveedor: reusar Proveedor Prueba o crear temp.
    const { data: provs } = await db.from("proveedores").select("id").eq("tenant_id", tenantId).eq("nombre", "Proveedor Prueba").limit(1);
    if (provs && provs[0]) { provId = provs[0].id as number; }
    else {
      const { data: np } = await db.from("proveedores").insert([{ nombre: `${SENT} Prov`, tenant_id: tenantId, estado: "Activo" }]).select("id").single();
      provId = np!.id as number; provCreado = true;
    }

    // Categoría CMV: reusar una del tenant o crear temp.
    const { data: cats } = await db.from("config_categorias").select("nombre").eq("tenant_id", tenantId).eq("grupo", "CMV").limit(1);
    if (cats && cats[0]) { catNombre = cats[0].nombre as string; }
    else {
      const { data: anyCat } = await db.from("config_categorias").select("tipo").eq("tenant_id", tenantId).limit(1);
      const tipo = (anyCat && anyCat[0]?.tipo) || "Gasto";
      catNombre = `${SENT}_CMV`;
      await db.from("config_categorias").insert([{ nombre: catNombre, grupo: "CMV", tipo, activo: true, tenant_id: tenantId }]);
      catCreada = true;
    }

    // Insumo + materia prima de destino.
    const { data: ins } = await db.from("insumos").insert([{ nombre: `${SENT} Insumo`, unidad: "kg", tenant_id: tenantId, activo: true, es_comprado: true, stock_disponible: true }]).select("id").single();
    insumoId = ins!.id as number;
    const { data: mp } = await db.from("materias_primas").insert([{ nombre: `${SENT} MP`, tenant_id: tenantId, insumo_id: insumoId, proveedor_id: provId, unidad_compra: "caja", factor_conversion: 10, activa: true }]).select("id").single();
    mpId = mp!.id as number;

    facturaIds.length = 0;
  });

  test.afterEach(async () => {
    for (const fid of facturaIds) {
      await db.from("factura_items").delete().eq("factura_id", fid).then(() => {}, () => {});
      await db.from("facturas").delete().eq("id", fid).then(() => {}, () => {});
    }
    if (insumoId) await db.from("insumo_movimientos").delete().eq("insumo_id", insumoId).then(() => {}, () => {});
    if (mpId) {
      await db.from("compras_mapeo").delete().eq("materia_prima_id", mpId).then(() => {}, () => {});
      await db.from("materias_primas").delete().eq("id", mpId).then(() => {}, () => {});
    }
    if (insumoId) await db.from("insumos").delete().eq("id", insumoId).then(() => {}, () => {});
    if (catCreada) await db.from("config_categorias").delete().eq("nombre", catNombre).eq("tenant_id", tenantId).then(() => {}, () => {});
    if (provCreado) await db.from("proveedores").delete().eq("id", provId).then(() => {}, () => {});
    try { await db.auth.signOut(); } catch { /* */ }
  });

  async function nuevaFactura(idSuffix: string, producto: string): Promise<string> {
    const fid = `FAC-${SENT}-${idSuffix}`;
    facturaIds.push(fid);
    const { error: fe } = await db.from("facturas").insert([{ id: fid, prov_id: provId, local_id: localId, fecha: "2026-06-07", cat: catNombre, total: 11000, tenant_id: tenantId, estado: "pendiente" }]);
    if (fe) throw new Error("insert factura: " + fe.message);
    const { error: ie } = await db.from("factura_items").insert([{ factura_id: fid, producto, cantidad: 1, unidad: "caja", precio_unitario: 11000, subtotal: 11000, tenant_id: tenantId }]);
    if (ie) throw new Error("insert factura_item: " + ie.message);
    return fid;
  }

  test("renglón → bandeja → conciliar (stock + memoria) → 2da factura auto-vincula; descartar", async () => {
    // 1. Factura con renglón de mercadería sin materia prima.
    const f1 = await nuevaFactura("1", PRODUCTO);
    const { data: b1 } = await db.from("v_bandeja_conciliacion")
      .select("factura_item_id, grupo_categoria, texto_norm").eq("factura_id", f1);
    expect(b1?.length).toBe(1);
    expect(b1![0]!.grupo_categoria).toBe("CMV");

    // 2. Conciliar.
    const { data: res, error: cErr } = await db.rpc("fn_conciliar_producto", {
      p_materia_prima_id: mpId, p_producto: PRODUCTO, p_proveedor_id: provId, p_global: false, p_idempotency_key: null,
    });
    expect(cErr).toBeNull();
    expect((res as { renglones_vinculados: number }).renglones_vinculados).toBe(1);

    // 3. Salió de la bandeja + MP seteada + mapeo + stock (factor 10).
    const { count: enBandeja } = await db.from("v_bandeja_conciliacion").select("factura_item_id", { count: "exact", head: true }).eq("factura_id", f1);
    expect(enBandeja).toBe(0);
    const { data: fi } = await db.from("factura_items").select("materia_prima_id").eq("factura_id", f1).single();
    expect(Number(fi!.materia_prima_id)).toBe(mpId);
    const { count: mapeoN } = await db.from("compras_mapeo").select("id", { count: "exact", head: true }).eq("materia_prima_id", mpId);
    expect(mapeoN).toBe(1);
    const { data: movs } = await db.from("insumo_movimientos").select("cantidad").eq("insumo_id", insumoId).eq("fuente_tipo", "factura_item");
    expect(movs?.length).toBe(1);
    expect(Number(movs![0]!.cantidad)).toBe(10); // 1 caja × factor 10

    // 4. 2da factura, mismo producto escrito distinto → auto-vincula sola.
    const f2 = await nuevaFactura("2", `  ${SENT.toLowerCase()} producto   TEST `);
    const { data: fi2 } = await db.from("factura_items").select("materia_prima_id").eq("factura_id", f2).single();
    expect(Number(fi2!.materia_prima_id)).toBe(mpId);
    const { count: enBandeja2 } = await db.from("v_bandeja_conciliacion").select("factura_item_id", { count: "exact", head: true }).eq("factura_id", f2);
    expect(enBandeja2).toBe(0);

    // 5. Descartar: un producto distinto que no es insumo.
    const f3 = await nuevaFactura("3", `${SENT} Flete`);
    const { data: b3 } = await db.from("v_bandeja_conciliacion").select("factura_item_id").eq("factura_id", f3);
    expect(b3?.length).toBe(1);
    const { error: dErr } = await db.rpc("fn_descartar_renglon", { p_factura_item_id: b3![0]!.factura_item_id, p_descartar: true });
    expect(dErr).toBeNull();
    const { count: enBandeja3 } = await db.from("v_bandeja_conciliacion").select("factura_item_id", { count: "exact", head: true }).eq("factura_id", f3).eq("descartado_conciliacion", false);
    expect(enBandeja3).toBe(0);
  });
});
