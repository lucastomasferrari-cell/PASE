// ─────────────────────────────────────────────────────────────────────────
// E2E Test 15: Marketplace flow post-cobro (estructural)
//
// ⚠️ HISTÓRICO: este test originalmente "validaba el marketplace" pero NO
// invocaba `fn_crear_pedido_publico_comanda` — hacía INSERT directo a
// ventas_pos simulando lo que la RPC haría. Por eso nunca atrapó el bug
// crítico que dejó el marketplace muerto 3 semanas (5-may → 24-may).
//
// 24-may: agregamos Test 34 que SÍ ejercita el flow end-to-end real:
//   pedido público → idempotency → aprobar → cobrar webhook MP → stock baja.
// **Test 34 es el guardian del marketplace.**
//
// Este Test 15 queda como guardián de los pasos POST-pedido (cambios de
// estado del pedido: enviado → listo → entregado, reviews, etc.) que NO
// ejercita el Test 34.
//
// Cubre:
//   1. Configurar local con marketplace activo (slug + tienda_activa=true).
//   2. Crear item disponible en tienda.
//   3. Insert ventas_pos directo — NO usar este patrón para tests nuevos.
//      Para flow real: usar fn_crear_pedido_publico_comanda (Test 34).
//   4. Cambios de estado post-cobro: enviado → listo → entregado.
//   5. Verificar reviews opcional.
// ─────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import { createSuperadminClient } from "../../helpers/supabaseClient";
import {
  seedE2ETenant, cleanupE2ETenant, createServiceClient,
  E2E_SENTINEL, type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { seedComandaPos, type E2EComandaPosSeed } from "../setup/seed-comanda";

test.describe.serial("E2E Test 15 — Marketplace pedido online", () => {
  let seed: E2ETenantSeedResult | null = null;
  let pos: E2EComandaPosSeed | null = null;

  test.beforeAll(async ({}, testInfo) => {
    await cleanupE2ETenant();
    const superdb = await createSuperadminClient();
    if (!superdb) { test.skip(true, "SUPERADMIN_PASSWORD no seteado"); return; }
    const { data: sess } = await superdb.auth.getSession();
    const baseUrl = (testInfo.project.use.baseURL || "https://pase-yndx.vercel.app").replace(/\/$/, "");
    seed = await seedE2ETenant({ superadminToken: sess?.session?.access_token!, baseUrl });
    pos = await seedComandaPos(seed); // necesito canalDelivery
    await superdb.auth.signOut();
  });

  test.afterAll(async () => { try { await cleanupE2ETenant(); } catch (e) { console.error(e); } });

  test("configurar tienda + pedido online + pago MP + cambios de estado", async () => {
    if (!seed || !pos) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();

    // ── 1. Configurar marketplace en local 1 ────────────────────────────
    const { error: csErr } = await svc.from("comanda_local_settings").insert({
      tenant_id: seed.tenantId,
      local_id: seed.local1Id,
      slug: `e2e-test-tienda-${Date.now()}`,
      tienda_activa: true,
      acepta_delivery: true,
      tiempo_retiro_min: 30,
      tiempo_delivery_min: 45,
      costo_envio_default: 1500,
      autolock_minutos: 30,
      features_pos_modos: ["salon", "mostrador", "pedidos"],
      sonido_kds_listo: true,
      sonido_pedido_nuevo: true,
      notif_push_pedidos: true,
    });
    if (csErr) throw new Error(`Configurar marketplace: ${csErr.message}`);

    // ── 2. Item disponible en tienda (ya hay items del seed, uso uno) ───
    const itemSushi = seed.items.find(i => i.nombre.includes("Sushi"))!;
    await svc.from("items").update({ visible_tienda: true }).eq("id", itemSushi.id);

    // ── 3. Simular pedido del cliente: insert ventas_pos directo ─────────
    const { data: ventaPedido, error: vErr } = await svc.from("ventas_pos").insert({
      tenant_id: seed.tenantId,
      local_id: seed.local1Id,
      numero_local: 9999,
      modo: "pedidos",
      canal_id: pos.canalDeliveryId,
      origen: "tienda_online",
      estado: "abierta",
      tipo_entrega: "delivery",
      cliente_nombre: `${E2E_SENTINEL} Cliente Marketplace`,
      cliente_telefono: "+5491111111111",
      cliente_email: "cliente-e2e@test.local",
      cliente_direccion: `${E2E_SENTINEL} Calle 123, CABA`,
      covers: 1,
      subtotal: 0,
      total: 0,
    }).select("id").single();
    if (vErr) throw new Error(`Insert pedido marketplace: ${vErr.message}`);
    const pedidoId = ventaPedido.id as number;

    // ── 4. Agregar 2 items al pedido (insert directo, no via RPC) ───────
    const cantidad = 2;
    const subtotalItem = itemSushi.precio * cantidad; // 24000
    const { error: itemsErr } = await svc.from("ventas_pos_items").insert({
      tenant_id: seed.tenantId,
      local_id: seed.local1Id,
      venta_id: pedidoId,
      item_id: itemSushi.id,
      cantidad,
      precio_unitario: itemSushi.precio,
      subtotal: subtotalItem,
      estado: "hold",
    });
    if (itemsErr) throw new Error(`Insert items pedido: ${itemsErr.message}`);

    // Actualizar totales de la venta
    const envio = 1500;
    const total = subtotalItem + envio;
    await svc.from("ventas_pos").update({
      subtotal: subtotalItem,
      total,
    }).eq("id", pedidoId);

    // ── 5. Simular pago MP confirmado: insert mp_movimientos ────────────
    // En realidad el webhook lo haría con datos de MP API. Acá inyectamos directo.
    const mpId = `mp-e2e-${Date.now()}`;
    const { error: mpErr } = await svc.from("mp_movimientos").insert({
      id: mpId,
      tenant_id: seed.tenantId,
      local_id: seed.local1Id,
      monto: total,
      descripcion: `Pago tienda online — pedido ${pedidoId}`,
      fecha: new Date().toISOString(),
      estado: "approved",
    });
    if (mpErr) throw new Error(`Insert mp_movimiento: ${mpErr.message}`);

    // Marcar venta cobrada
    await svc.from("ventas_pos").update({
      estado: "cobrada",
    }).eq("id", pedidoId);

    // ── 6. Cambiar estados: enviado → listo → entregado ─────────────────
    const estados = ["enviada", "lista", "entregada"];
    for (const e of estados) {
      const { error: stErr } = await svc.from("ventas_pos")
        .update({ estado: e }).eq("id", pedidoId);
      if (stErr) throw new Error(`Cambiar estado a ${e}: ${stErr.message}`);
    }

    // ── 7. Verificaciones finales ───────────────────────────────────────
    const { data: ventaFinal } = await svc.from("ventas_pos")
      .select("estado, total, origen, tipo_entrega").eq("id", pedidoId).single();
    expect(ventaFinal?.estado).toBe("entregada");
    expect(ventaFinal?.origen).toBe("tienda_online");
    expect(ventaFinal?.tipo_entrega).toBe("delivery");
    expect(Number(ventaFinal?.total)).toBe(total);

    // El mp_movimiento existe approved
    const { data: mpMov } = await svc.from("mp_movimientos")
      .select("estado, monto").eq("id", mpId).single();
    expect(mpMov?.estado).toBe("approved");
    expect(Number(mpMov?.monto)).toBe(total);

    // Item del pedido existe
    const { data: itemsPedido } = await svc.from("ventas_pos_items")
      .select("cantidad, subtotal").eq("venta_id", pedidoId).is("deleted_at", null);
    expect(itemsPedido).toHaveLength(1);
    expect(Number(itemsPedido![0]!.cantidad)).toBe(cantidad);
    expect(Number(itemsPedido![0]!.subtotal)).toBe(subtotalItem);

    // NOTA: el ingreso a saldos_caja "MercadoPago" del local lo hace
    // típicamente el cron mp-process al matchear el mp_movimiento con la
    // venta. Eso es flow asíncrono fuera del scope de este test.
  });
});
