// ─────────────────────────────────────────────────────────────────────────
// E2E Sprint 2 — Test 02: POS COMANDA cobro efectivo (DB-only)
//
// Flujo testeado (vía RPCs directas, sin UI):
//   1. Setup tenant E2E + seed COMANDA (canales + mesas + turno + cajero+pin)
//   2. Snapshot saldo "Caja Efectivo" del local
//   3. Abrir venta en mesa 1 (canal salon)
//   4. Agregar 2 items: Sushi Tradicional (12000) + Bebida (3500) = 15500
//   5. Cobrar efectivo (medio EFECTIVO)
//   6. Verificar:
//      - venta queda en estado="cobrada"
//      - 2 items en ventas_pos_items
//      - movimiento creado por 15500
//      - saldo "Caja Efectivo" del local subió en 15500
//   7. Cleanup: anular venta + cleanup tenant
//
// Por qué DB-only (no Playwright UI):
//   - Las RPCs son el corazón de la lógica de plata. Si cambia un botón
//     pero la RPC sigue funcionando, el saldo SIEMPRE va a quedar bien.
//   - DB-only corre en ~5 segundos vs ~2 minutos por UI.
//   - El test de UI lo dejamos para 1-2 flows "smoke" que sí prueben wireado.
// ─────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import { createSuperadminClient } from "../../helpers/supabaseClient";
import {
  seedE2ETenant,
  cleanupE2ETenant,
  createServiceClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { seedComandaPos, type E2EComandaPosSeed } from "../setup/seed-comanda";

test.describe.serial("E2E Sprint 2 — POS cobro efectivo (DB-only)", () => {
  let seed: E2ETenantSeedResult | null = null;
  let pos: E2EComandaPosSeed | null = null;

  test.beforeAll(async ({}, testInfo) => {
    const superdb = await createSuperadminClient();
    if (!superdb) {
      test.skip(true, "SUPERADMIN_PASSWORD no seteado en packages/pase/.env.local");
      return;
    }
    const { data: sess } = await superdb.auth.getSession();
    const superToken = sess?.session?.access_token;
    if (!superToken) throw new Error("No se obtuvo token superadmin");

    const baseUrl = (testInfo.project.use.baseURL || "https://pase-yndx.vercel.app").replace(/\/$/, "");
    seed = await seedE2ETenant({ superadminToken: superToken, baseUrl });
    pos = await seedComandaPos(seed);

    await superdb.auth.signOut();
  });

  test.afterAll(async () => {
    try { await cleanupE2ETenant(); } catch (e) {

      console.error("[afterAll] cleanupE2ETenant falló:", e);
    }
  });

  test("abrir mesa → agregar items → cobrar efectivo → saldo sube", async () => {
    if (!seed || !pos) {
      test.skip(true, "Seed inicial falló");
      return;
    }

    const svc = createServiceClient();

    // ── 1. Snapshot saldo inicial Caja Efectivo del local 1 ────────────
    const { data: saldoAntes } = await svc.from("saldos_caja")
      .select("saldo")
      .eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo")
      .single();
    const saldoInicial = Number(saldoAntes!.saldo);
    expect(saldoInicial).toBe(0);

    // ── 2. Abrir venta en mesa 1 ───────────────────────────────────────
    // RPC fn_abrir_venta_comanda — SECURITY DEFINER + chequea permiso
    // 'comanda.ventas.cobrar'. Como el seed deja `oculto=true` y service
    // role bypassa RLS, vamos a invocarla con el service client. La RPC
    // usa auth_tenant_id() que devuelve NULL con service role → falla.
    //
    // Workaround: invocamos como el dueño autenticado del tenant E2E.
    const { createE2EDuenoClient } = await import("../setup/seed-tenant");
    const duenoDb = await createE2EDuenoClient();

    const mesa1Id = pos.mesas[0]!.id;
    const { data: ventaIdRes, error: ventaErr } = await duenoDb.rpc("fn_abrir_venta_comanda", {
      p_local_id: seed.local1Id,
      p_modo: "salon",
      p_canal_id: pos.canalSalonId,
      p_mesa_id: mesa1Id,
      p_cajero_id: pos.cajeroEmpleadoId,
      p_covers: 2,
      p_origen: "pos",
      p_estado: "abierta",
    });
    if (ventaErr) throw new Error(`fn_abrir_venta_comanda: ${ventaErr.message}`);
    const ventaId = ventaIdRes as unknown as number;
    expect(ventaId).toBeGreaterThan(0);

    // ── 3. Agregar 2 items ─────────────────────────────────────────────
    const itemSushi = seed.items.find(i => i.nombre.includes("Sushi"))!;
    const itemBebida = seed.items.find(i => i.nombre.includes("Bebida"))!;

    const { error: addErr1 } = await duenoDb.rpc("fn_agregar_item_comanda", {
      p_venta_id: ventaId,
      p_item_id: itemSushi.id,
      p_cantidad: 1,
      p_precio_unitario: itemSushi.precio, // 12000
      p_observaciones: null,
    });
    if (addErr1) throw new Error(`agregar item sushi: ${addErr1.message}`);

    const { error: addErr2 } = await duenoDb.rpc("fn_agregar_item_comanda", {
      p_venta_id: ventaId,
      p_item_id: itemBebida.id,
      p_cantidad: 1,
      p_precio_unitario: itemBebida.precio, // 3500
      p_observaciones: null,
    });
    if (addErr2) throw new Error(`agregar item bebida: ${addErr2.message}`);

    // Verificar items se cargaron
    const { data: itemsVenta } = await duenoDb.from("ventas_pos_items")
      .select("item_id, cantidad, precio_unitario")
      .eq("venta_id", ventaId)
      .is("deleted_at", null);
    expect(itemsVenta).toHaveLength(2);
    const totalEsperado = 12000 + 3500; // 15500

    // ── 4. Cobrar efectivo ─────────────────────────────────────────────
    const { error: cobrErr } = await duenoDb.rpc("fn_cobrar_venta_comanda", {
      p_venta_id: ventaId,
      p_pagos: [
        { medio_cobro_id: seed.medioEfectivoId, monto: totalEsperado },
      ],
      p_propina: 0,
      p_descuento: 0,
    });
    if (cobrErr) throw new Error(`fn_cobrar_venta_comanda: ${cobrErr.message}`);

    // ── 5. Verificar resultados ────────────────────────────────────────
    // (a) venta queda cobrada
    const { data: venta } = await svc.from("ventas_pos")
      .select("estado, total, cobrada_at")
      .eq("id", ventaId)
      .single();
    expect(venta?.estado).toBe("cobrada");
    expect(Number(venta?.total)).toBe(totalEsperado);

    // (b) movimiento creado con el monto correcto
    const { data: movs } = await svc.from("movimientos")
      .select("importe, cuenta, anulado")
      .eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo")
      .eq("anulado", false);
    expect(movs).toHaveLength(1);
    expect(Number(movs![0]!.importe)).toBe(totalEsperado);

    // (c) saldo Caja Efectivo subió en totalEsperado
    const { data: saldoDespues } = await svc.from("saldos_caja")
      .select("saldo")
      .eq("tenant_id", seed.tenantId)
      .eq("local_id", seed.local1Id)
      .eq("cuenta", "Caja Efectivo")
      .single();
    expect(Number(saldoDespues!.saldo) - saldoInicial).toBe(totalEsperado);

    // (d) mesa queda libre después del cobro (fn_cobrar libera mesa)
    const { data: mesa } = await svc.from("mesas")
      .select("estado")
      .eq("id", mesa1Id)
      .single();
    expect(mesa?.estado).toBe("libre");

    await duenoDb.auth.signOut();
  });
});
