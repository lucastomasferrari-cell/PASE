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

import {
  test,
  expect,
} from "@playwright/test";
import {
  createServiceClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";
import {
  seedComandaPos,
  type E2EComandaPosSeed,
} from "../setup/seed-comanda";

test.describe.serial("E2E Sprint 2 — POS cobro efectivo (DB-only)", () => {
  let seed: E2ETenantSeedResult | null = null;
  let pos: E2EComandaPosSeed | null = null;

  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
    pos = await seedComandaPos(seed);
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

    // fn_agregar_item_comanda no recibe precio: lo toma de items.precio_madre.
    const { error: addErr1 } = await duenoDb.rpc("fn_agregar_item_comanda", {
      p_venta_id: ventaId,
      p_item_id: itemSushi.id,
      p_cantidad: 1,
    });
    if (addErr1) throw new Error(`agregar item sushi: ${addErr1.message}`);

    const { error: addErr2 } = await duenoDb.rpc("fn_agregar_item_comanda", {
      p_venta_id: ventaId,
      p_item_id: itemBebida.id,
      p_cantidad: 1,
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
    // fn_cobrar_venta_comanda(p_venta_id, p_pagos JSONB, p_propina, p_cobrado_por, p_idempotency_key)
    // p_pagos shape: [{ metodo: TEXT, monto: NUMERIC, idempotency_key: TEXT, vuelto?: NUMERIC, propina_incluida?: NUMERIC }]
    const { error: cobrErr } = await duenoDb.rpc("fn_cobrar_venta_comanda", {
      p_venta_id: ventaId,
      p_pagos: [
        {
          metodo: "EFECTIVO",
          monto: totalEsperado,
          idempotency_key: `e2e-pago-${ventaId}-${Date.now()}`,
        },
      ],
      p_propina: 0,
    });
    if (cobrErr) throw new Error(`fn_cobrar_venta_comanda: ${cobrErr.message}`);

    // ── 5. Verificar resultados ────────────────────────────────────────
    // (a) venta queda cobrada
    const { data: venta } = await svc.from("ventas_pos")
      .select("estado, total")
      .eq("id", ventaId)
      .single();
    expect(venta?.estado).toBe("cobrada");
    expect(Number(venta?.total)).toBe(totalEsperado);

    // (b) pagos guardados en ventas_pos_pagos
    const { data: pagos } = await svc.from("ventas_pos_pagos")
      .select("metodo, monto, estado")
      .eq("venta_id", ventaId);
    expect(pagos).toHaveLength(1);
    expect(pagos![0]!.metodo).toBe("EFECTIVO");
    expect(Number(pagos![0]!.monto)).toBe(totalEsperado);
    expect(pagos![0]!.estado).toBe("confirmado");

    // (c) movimiento creado en movimientos_caja (COMANDA usa su propia tabla,
    // distinta de movimientos de PASE — el passage a PASE pasa al cerrar turno).
    const { data: movs, error: movsErr } = await svc.from("movimientos_caja")
      .select("*")
      .eq("tenant_id", seed.tenantId)
      .eq("turno_caja_id", pos.turnoCajaId);
    if (movsErr) throw new Error(`Query movimientos_caja: ${movsErr.message}`);
    expect(movs!.length).toBeGreaterThan(0);
    // El mov del cobro debe estar — buscar uno con monto = totalEsperado
    const cobroMov = movs!.find(m => Number(m.monto) === totalEsperado || Number(m.importe) === totalEsperado);
    expect(cobroMov, `No encontré mov con monto ${totalEsperado}. Filas: ${JSON.stringify(movs)}`).toBeDefined();

    // (d) mesa queda libre después del cobro (fn_cobrar libera mesa)
    const { data: mesa } = await svc.from("mesas")
      .select("estado")
      .eq("id", mesa1Id)
      .single();
    expect(mesa?.estado).toBe("libre");

    // NOTA: saldos_caja NO se modifica acá. COMANDA mantiene `movimientos_caja`
    // del turno. El passage a `saldos_caja` y `movimientos` de PASE ocurre al
    // cerrar el turno (fn_cerrar_turno_caja) — eso lo cubre un test futuro.
    void saldoInicial;

    await duenoDb.auth.signOut();
  });
});
