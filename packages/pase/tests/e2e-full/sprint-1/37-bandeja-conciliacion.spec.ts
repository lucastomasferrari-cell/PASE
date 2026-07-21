// E2E Test 37 — Bandeja conciliadora Compras→Insumos (Pieza A)
//
// Valida el circuito: renglón de mercadería sin materia prima → aparece en
// v_bandeja_conciliacion → fn_conciliar_producto setea materia_prima_id +
// escribe compras_mapeo + el trigger suma stock → 2da factura con el mismo
// producto (texto distinto) se auto-vincula sola → fn_descartar_renglon saca
// un renglón de la bandeja.
//
// Spec: docs/superpowers/specs/2026-06-07-bandeja-conciliacion-compras-insumos-design.md

import { test, expect } from "@playwright/test";
import {
  createServiceClient,
  createE2EDuenoClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

const SENT = "ZZE2EBANDEJA";
const PRODUCTO = `${SENT} Producto`;

test.describe.serial("E2E Test 37 — Bandeja conciliadora", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(() => { seed = loadSharedSeed(); });

  test("conciliar producto → stock + memoria + auto-vínculo + descartar", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const T = seed.tenantId;
    const facIds: string[] = [];
    let provId: number | undefined, insumoId: number | undefined, mpId: number | undefined, catNombre = "";

    try {
      // ── Prerequisitos (svc bypassa RLS) ──
      const { data: prov } = await svc.from("proveedores").insert({ nombre: `${SENT} Prov`, tenant_id: T, estado: "Activo" }).select("id").single();
      provId = prov!.id as number;

      const { data: anyCat } = await svc.from("config_categorias").select("tipo").eq("tenant_id", T).limit(1);
      const tipo = (anyCat && anyCat[0]?.tipo) || "Gasto";
      catNombre = `${SENT}_CMV`;
      await svc.from("config_categorias").insert({ nombre: catNombre, grupo: "CMV", tipo, activo: true, tenant_id: T });

      const { data: ins } = await svc.from("insumos").insert({ nombre: `${SENT} Insumo`, unidad: "kg", tenant_id: T, activo: true, es_comprado: true, stock_disponible: true }).select("id").single();
      insumoId = ins!.id as number;
      const { data: mp } = await svc.from("materias_primas").insert({ nombre: `${SENT} MP`, tenant_id: T, insumo_id: insumoId, proveedor_id: provId, unidad_compra: "caja", factor_conversion: 10, activa: true }).select("id").single();
      mpId = mp!.id as number;

      const nuevaFactura = async (suf: string, producto: string) => {
        const fid = `FAC-${SENT}-${suf}`;
        facIds.push(fid);
        await svc.from("facturas").insert({ id: fid, prov_id: provId, local_id: seed!.local1Id, fecha: "2026-06-07", cat: catNombre, total: 11000, tenant_id: T, estado: "pendiente" });
        await svc.from("factura_items").insert({ factura_id: fid, producto, cantidad: 1, unidad: "caja", precio_unitario: 11000, subtotal: 11000, tenant_id: T });
        return fid;
      };

      // 1. Renglón sin materia prima → bandeja.
      const f1 = await nuevaFactura("1", PRODUCTO);
      const { data: b1 } = await svc.from("v_bandeja_conciliacion").select("factura_item_id, grupo_categoria").eq("factura_id", f1);
      expect(b1?.length).toBe(1);
      expect(b1![0]!.grupo_categoria).toBe("CMV");

      // 2. Conciliar (con auth de dueño E2E).
      const { data: res, error: cErr } = await duenoDb.rpc("fn_conciliar_producto", {
        p_materia_prima_id: mpId, p_producto: PRODUCTO, p_proveedor_id: provId, p_global: false, p_idempotency_key: null,
      });
      if (cErr) throw new Error("fn_conciliar_producto: " + cErr.message);
      expect((res as { renglones_vinculados: number }).renglones_vinculados).toBe(1);

      // 3. Stock + memoria + fuera de bandeja.
      const { data: fi } = await svc.from("factura_items").select("materia_prima_id").eq("factura_id", f1).single();
      expect(Number(fi!.materia_prima_id)).toBe(mpId);
      const { count: mapeoN } = await svc.from("compras_mapeo").select("id", { count: "exact", head: true }).eq("materia_prima_id", mpId);
      expect(mapeoN).toBe(1);
      const { data: movs } = await svc.from("insumo_movimientos").select("cantidad").eq("insumo_id", insumoId).eq("fuente_tipo", "factura_item");
      expect(movs?.length).toBe(1);
      expect(Number(movs![0]!.cantidad)).toBe(10);

      // 4. 2da factura, mismo producto escrito distinto → auto-vincula.
      const f2 = await nuevaFactura("2", `  ${SENT.toLowerCase()} producto  `);
      const { data: fi2 } = await svc.from("factura_items").select("materia_prima_id").eq("factura_id", f2).single();
      expect(Number(fi2!.materia_prima_id)).toBe(mpId);

      // 5. Descartar un renglón.
      const f3 = await nuevaFactura("3", `${SENT} Flete`);
      const { data: b3 } = await svc.from("v_bandeja_conciliacion").select("factura_item_id").eq("factura_id", f3);
      expect(b3?.length).toBe(1);
      const { error: dErr } = await duenoDb.rpc("fn_descartar_renglon", { p_factura_item_id: b3![0]!.factura_item_id, p_descartar: true });
      if (dErr) throw new Error("fn_descartar_renglon: " + dErr.message);
      const { count: enB3 } = await svc.from("v_bandeja_conciliacion").select("factura_item_id", { count: "exact", head: true }).eq("factura_id", f3);
      expect(enB3).toBe(0);
    } finally {
      // ── Cleanup ──
      for (const fid of facIds) {
        await svc.from("factura_items").delete().eq("factura_id", fid);
        await svc.from("facturas").delete().eq("id", fid);
      }
      if (insumoId) await svc.from("insumo_movimientos").delete().eq("insumo_id", insumoId);
      if (mpId) {
        await svc.from("compras_mapeo").delete().eq("materia_prima_id", mpId);
        await svc.from("materias_primas").delete().eq("id", mpId);
      }
      if (insumoId) await svc.from("insumos").delete().eq("id", insumoId);
      await svc.from("config_categorias").delete().eq("nombre", catNombre).eq("tenant_id", T);
      if (provId) await svc.from("proveedores").delete().eq("id", provId);
      await duenoDb.auth.signOut();
    }
  });
});
