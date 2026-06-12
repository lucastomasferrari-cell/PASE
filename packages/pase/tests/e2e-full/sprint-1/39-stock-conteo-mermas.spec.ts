// E2E Test 39 — Stock: merma + conteo ciego (Pieza C) + cache per-local
//
// entrada de stock → fn_registrar_merma descuenta → conteo ciego
// (fn_iniciar/cargar/finalizar) computa diferencia real y ajusta el stock.
//
// 11-jun (stock por local, migraciones 202606120100/110/120): cada paso
// también verifica la fila per-local en `insumo_stock_local`, y un segundo
// test corre el INVARIANTE de la suite: para cada (insumo, local) del
// tenant E2E, cache per-local == SUM(ledger). OJO: el invariante usa la
// cache PER-LOCAL a propósito — la cache GLOBAL (insumos.stock_actual)
// arrastra deuda vieja del seed (stock seteado directo sin movimiento).
//
// Spec: docs/superpowers/specs/2026-05-28-stock-cmv-avt-rediseno.md
// Plan: docs/superpowers/plans/2026-06-11-stock-por-local-y-fecha-compras.md

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
    // Cache per-local (11-jun): sin fila = 0 (el trigger solo crea filas para movs con local_id).
    const stockLocal = async (lid: number) => {
      const { data } = await svc.from("insumo_stock_local").select("cantidad").eq("insumo_id", insumoId!).eq("local_id", lid);
      return data && data[0] ? Number(data[0].cantidad) : 0;
    };

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
      expect(await stockLocal(L), "la entrada con local_id debe crear/actualizar la fila per-local").toBe(100);

      const { error: mErr } = await duenoDb.rpc("fn_registrar_merma", { p_insumo_id: insumoId, p_local_id: L, p_cantidad: 10, p_motivo_id: motivoId, p_notas: "test" });
      if (mErr) throw new Error("merma: " + mErr.message);
      expect(await stock()).toBe(90);
      expect(await stockLocal(L), "la merma descuenta de la cache per-local del local").toBe(90);

      const { data: cid, error: iErr } = await duenoDb.rpc("fn_iniciar_conteo_fisico", { p_local_id: L, p_notas: "e2e" });
      if (iErr) throw new Error("iniciar conteo: " + iErr.message);
      conteoId = cid as number;
      // 11-jun: stock_teorico ahora snapshotea la cache PER-LOCAL del local
      // del conteo (antes: insumos.stock_actual global). Acá coinciden (90)
      // porque todos los movimientos del insumo fueron en el local L.
      const { data: teo } = await svc.from("stock_conteo_lineas").select("stock_teorico").eq("conteo_id", conteoId).eq("insumo_id", insumoId).single();
      expect(Number(teo!.stock_teorico)).toBe(90);

      await duenoDb.rpc("fn_cargar_conteo_linea", { p_conteo_id: conteoId, p_insumo_id: insumoId, p_stock_contado: 85, p_notas: null });
      const { error: fErr } = await duenoDb.rpc("fn_finalizar_conteo_fisico", { p_conteo_id: conteoId });
      if (fErr) throw new Error("finalizar: " + fErr.message);

      const { data: fin } = await svc.from("stock_conteo_lineas").select("diferencia").eq("conteo_id", conteoId).eq("insumo_id", insumoId).single();
      expect(Number(fin!.diferencia)).toBe(-5);
      expect(await stock()).toBe(85);
      expect(await stockLocal(L), "el ajuste de conteo (tipo='conteo' con local_id) impacta la cache per-local").toBe(85);
    } finally {
      if (conteoId) { await svc.from("stock_conteo_lineas").delete().eq("conteo_id", conteoId); await svc.from("stock_conteos").delete().eq("id", conteoId); }
      if (insumoId) { await svc.from("insumo_movimientos").delete().eq("insumo_id", insumoId); await svc.from("insumos").delete().eq("id", insumoId); }
      if (motivoCreado && motivoId) await svc.from("mermas_motivos").delete().eq("id", motivoId);
      await duenoDb.auth.signOut();
    }
  });

  // ── INVARIANTE STK-LOCAL (11-jun, migración 202606120100) ──────────────
  // Para CADA fila de la cache `insumo_stock_local` del tenant E2E:
  //   cantidad == SUM(insumo_movimientos.cantidad) del mismo (insumo, local)
  //   con deleted_at IS NULL, tolerancia 0.001.
  // Y al revés: todo (insumo, local) con movimientos en el ledger (cuyo
  // insumo siga existiendo) debe tener su fila en la cache.
  //
  // Corre acá (fin del #39) porque a esta altura ya operaron sobre stock
  // los tests 21 (merma), 22 (ajuste), 33/34 (ventas con receta), 37
  // (bandeja conciliación), 38 (recetas) y el conteo de arriba.
  // NOTA: verifica la cache PER-LOCAL, no `insumos.stock_actual` (la global
  // tiene drift conocido pre-existente: el seed setea stock directo sin
  // movimiento en el ledger).
  test("INVARIANTE: insumo_stock_local == SUM(ledger) por (insumo, local)", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const T = seed.tenantId;

    const { data: cacheRows, error: cErr } = await svc
      .from("insumo_stock_local")
      .select("insumo_id, local_id, cantidad")
      .eq("tenant_id", T);
    if (cErr) throw new Error("leer insumo_stock_local: " + cErr.message);

    const { data: movs, error: mErr } = await svc
      .from("insumo_movimientos")
      .select("insumo_id, local_id, cantidad")
      .eq("tenant_id", T)
      .not("local_id", "is", null)
      .is("deleted_at", null);
    if (mErr) throw new Error("leer insumo_movimientos: " + mErr.message);

    // Ledger agrupado por (insumo, local)
    const ledger = new Map<string, number>();
    for (const m of movs ?? []) {
      const k = `${m.insumo_id}:${m.local_id}`;
      ledger.set(k, (ledger.get(k) ?? 0) + Number(m.cantidad));
    }

    // Dirección 1: cada fila de la cache coincide con el ledger.
    for (const r of cacheRows ?? []) {
      const k = `${r.insumo_id}:${r.local_id}`;
      const total = ledger.get(k) ?? 0;
      expect(
        Math.abs(Number(r.cantidad) - total),
        `INV-STK-LOCAL drift en insumo=${r.insumo_id} local=${r.local_id}: cache=${r.cantidad} vs ledger=${total}`,
      ).toBeLessThan(0.001);
    }

    // Dirección 2: todo (insumo, local) del ledger tiene fila en la cache.
    // Se filtran movimientos huérfanos (insumo hard-deleted): el FK CASCADE
    // de la cache borra sus filas, pero el ledger puede conservarlos.
    const insumoIds = [...new Set((movs ?? []).map((m) => m.insumo_id as number))];
    const vivos = new Set<number>();
    if (insumoIds.length) {
      const { data: insExist } = await svc.from("insumos").select("id").in("id", insumoIds);
      for (const i of insExist ?? []) vivos.add(i.id as number);
    }
    const enCache = new Set((cacheRows ?? []).map((r) => `${r.insumo_id}:${r.local_id}`));
    for (const [k, total] of ledger.entries()) {
      const iid = Number(k.split(":")[0]);
      if (!vivos.has(iid)) continue; // huérfano — sin fila esperable en la cache
      expect(
        enCache.has(k),
        `INV-STK-LOCAL: el ledger tiene movimientos para (insumo:local)=${k} (total=${total}) pero falta la fila en insumo_stock_local`,
      ).toBe(true);
    }
  });
});
