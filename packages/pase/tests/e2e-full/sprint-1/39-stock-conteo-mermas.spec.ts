// E2E Test 39 — Stock: merma + conteo ciego (Pieza C)
//
// entrada de stock → fn_registrar_merma descuenta → conteo ciego
// (fn_iniciar/cargar/finalizar) computa diferencia real y ajusta el stock.
//
// Spec: docs/superpowers/specs/2026-05-28-stock-cmv-avt-rediseno.md

import { test, expect } from "@playwright/test";
import {
  createServiceClient,
  createE2EDuenoClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

const SENT = "ZZE2ESTOCK";

test.describe.serial("E2E Test 39 — Stock conteo + mermas", () => {
  let seed: E2ETenantSeedResult | null = null;
  test.beforeAll(() => { seed = loadSharedSeed(); });

  test("entrada → merma → conteo ciego revela diferencia y ajusta", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const T = seed.tenantId;
    const L = seed.local1Id;
    let insumoId: number | undefined, conteoId: number | undefined, motivoId: number | undefined, motivoCreado = false;

    const stock = async () => Number(((await svc.from("insumos").select("stock_actual").eq("id", insumoId!).single()).data)!.stock_actual ?? 0);

    try {
      // Limpiar conteos abiertos del local.
      const { data: ab } = await svc.from("stock_conteos").select("id").eq("local_id", L).eq("estado", "abierto");
      for (const a of ab || []) { await svc.from("stock_conteo_lineas").delete().eq("conteo_id", a.id as number); await svc.from("stock_conteos").delete().eq("id", a.id as number); }

      // Motivo de merma: reusar o crear.
      const { data: mot } = await svc.from("mermas_motivos").select("id, tipo_movimiento").eq("tenant_id", T).eq("activo", true).limit(1);
      if (mot && mot[0]) { motivoId = mot[0].id as number; }
      else {
        const { data: anyM } = await svc.from("mermas_motivos").select("tipo_movimiento").limit(1);
        const tipo = (anyM && anyM[0]?.tipo_movimiento) || "merma";
        const { data: nm } = await svc.from("mermas_motivos").insert({ nombre: `${SENT} motivo`, tenant_id: T, tipo_movimiento: tipo, activo: true, orden: 99 }).select("id").single();
        motivoId = nm!.id as number; motivoCreado = true;
      }

      const { data: ins } = await svc.from("insumos").insert({ nombre: `${SENT} insumo`, unidad: "kg", tenant_id: T, activo: true, stock_disponible: true, costo_actual: 100 }).select("id").single();
      insumoId = ins!.id as number;

      await svc.from("insumo_movimientos").insert({ tenant_id: T, local_id: L, insumo_id: insumoId, tipo: "entrada_ajuste", cantidad: 100, costo_unitario: 100, motivo: "carga test" });
      expect(await stock()).toBe(100);

      const { error: mErr } = await duenoDb.rpc("fn_registrar_merma", { p_insumo_id: insumoId, p_local_id: L, p_cantidad: 10, p_motivo_id: motivoId, p_notas: "test" });
      if (mErr) throw new Error("merma: " + mErr.message);
      expect(await stock()).toBe(90);

      const { data: cid, error: iErr } = await duenoDb.rpc("fn_iniciar_conteo_fisico", { p_local_id: L, p_notas: "e2e" });
      if (iErr) throw new Error("iniciar conteo: " + iErr.message);
      conteoId = cid as number;
      const { data: teo } = await svc.from("stock_conteo_lineas").select("stock_teorico").eq("conteo_id", conteoId).eq("insumo_id", insumoId).single();
      expect(Number(teo!.stock_teorico)).toBe(90);

      await duenoDb.rpc("fn_cargar_conteo_linea", { p_conteo_id: conteoId, p_insumo_id: insumoId, p_stock_contado: 85, p_notas: null });
      const { error: fErr } = await duenoDb.rpc("fn_finalizar_conteo_fisico", { p_conteo_id: conteoId });
      if (fErr) throw new Error("finalizar: " + fErr.message);

      const { data: fin } = await svc.from("stock_conteo_lineas").select("diferencia").eq("conteo_id", conteoId).eq("insumo_id", insumoId).single();
      expect(Number(fin!.diferencia)).toBe(-5);
      expect(await stock()).toBe(85);
    } finally {
      if (conteoId) { await svc.from("stock_conteo_lineas").delete().eq("conteo_id", conteoId); await svc.from("stock_conteos").delete().eq("id", conteoId); }
      if (insumoId) { await svc.from("insumo_movimientos").delete().eq("insumo_id", insumoId); await svc.from("insumos").delete().eq("id", insumoId); }
      if (motivoCreado && motivoId) await svc.from("mermas_motivos").delete().eq("id", motivoId);
      await duenoDb.auth.signOut();
    }
  });
});
