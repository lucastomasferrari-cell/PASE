// ─────────────────────────────────────────────────────────────────────────
// E2E Test 34 — Marketplace: pedido público → aprobación → cobro MP → stock
//
// Reemplaza al viejo "Test 15 marketplace + MP webhook" que fue marcado
// como completed pero NUNCA corrió contra prod (descubrimos 24-may noche
// que fn_crear_pedido_publico_comanda estaba roto 3 semanas y nadie lo
// detectó porque ningún test la ejercitaba contra DB real).
//
// Este test es DELIBERADAMENTE asserts-strict para evitar el mismo
// falsamente verde: cada paso valida que la RPC efectivamente cambió la
// DB (estado, columnas, side-effects via trigger).
//
// Flow cubierto:
//   [1] Setup: insumo + factura → stock 5kg + item + receta 0.1kg/u
//   [2] Settings marketplace (comanda_local_settings con slug)
//   [3] Turno de caja abierto (requerido por fn_cobrar_venta_comanda)
//   [4] fn_crear_pedido_publico_comanda → venta necesita_aprobacion
//   [5] Idempotency: misma key → mismo venta_id
//   [6] fn_get_pedido_publico_comanda (consulta cliente por teléfono)
//   [7] fn_aprobar_pedido_comanda → estado=enviada
//   [8] fn_cobrar_venta_comanda (simula webhook MP) → estado=cobrada
//   [9] Trigger trg_venta_cobrada_stock → salida_venta -0.2kg
//   [10] Idempotency cobro: replay del webhook no duplica pagos
//   [11] ventas_pos_pagos cargado correctamente
// ─────────────────────────────────────────────────────────────────────────

import {
  test,
  expect,
} from "@playwright/test";
import {
  createServiceClient,
  createE2EDuenoClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

const SENTINEL = `T34_${Date.now()}`;
const SLUG_MARKETPLACE = `e2e-mkt-${Date.now()}`;
const today = new Date().toISOString().slice(0, 10);

test.describe.serial("E2E Test 34 — marketplace end-to-end", () => {
  let seed: E2ETenantSeedResult | null = null;
  let insumoId: number | null = null;
  let itemId: number | null = null;
  let recetaId: number | null = null;
  let proveedorId: number | null = null;
  let facturaId: string | null = null;
  let materiaPrimaId: number | null = null;
  let turnoId: number | null = null;
  let ventaId: number | null = null;

   
  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
  });

  test.afterAll(async () => {
    if (seed) {
      const svc = createServiceClient();
      // Cleanup específico del test (lo creado por SENTINEL/SLUG_MARKETPLACE)
      if (ventaId) {
        await svc.from("ventas_pos_pagos").delete().eq("venta_id", ventaId);
        await svc.from("ventas_pos_items").delete().eq("venta_id", ventaId);
        await svc.from("ventas_pos").delete().eq("id", ventaId);
      }
      if (recetaId) {
        await svc.from("receta_insumos").delete().eq("receta_id", recetaId);
        await svc.from("recetas").delete().eq("id", recetaId);
      }
      if (itemId) await svc.from("items").delete().eq("id", itemId);
      if (facturaId) {
        await svc.from("factura_items").delete().eq("factura_id", facturaId);
        await svc.from("facturas").delete().eq("id", facturaId);
      }
      if (insumoId) {
        await svc.from("insumo_movimientos").delete().eq("insumo_id", insumoId);
        await svc.from("materias_primas").delete().eq("insumo_id", insumoId);
        await svc.from("insumos").delete().eq("id", insumoId);
      }
      if (proveedorId) await svc.from("proveedores").delete().eq("id", proveedorId);
      if (turnoId) await svc.from("turnos_caja").delete().eq("id", turnoId);
      await svc.from("comanda_local_settings").delete().eq("slug", SLUG_MARKETPLACE);
      await svc.from("idempotency_keys").delete().like("key", `${SENTINEL}%`);
    }
    // Nota 29-may: cleanup del tenant compartido vive en globalTeardown,
    // NO acá. Borrarlo desde afterAll de cada spec rompía la shared-seed.
  });

  test("[1-3] Setup: stock + receta + marketplace settings + turno abierto", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();

    // [1] Crear insumo (kg, costo $2000, stock=0)
    const { data: ins } = await svc.from("insumos").insert({
      tenant_id: seed.tenantId, local_id: seed.local1Id,
      nombre: `${SENTINEL}_Arroz`, unidad: "kg",
      costo_actual: 2000, stock_actual: 0, activo: true,
      es_comprado: true, stock_disponible: true,
    }).select("id").single();
    insumoId = ins!.id as number;

    // Proveedor + factura + materia_prima → trigger sube stock a 5kg
    const { data: prov } = await svc.from("proveedores").insert({
      tenant_id: seed.tenantId, nombre: `${SENTINEL}_Prov`,
    }).select("id").single();
    proveedorId = prov!.id as number;

    facturaId = `FAC-${SENTINEL}`;
    await svc.from("facturas").insert({
      id: facturaId, tenant_id: seed.tenantId, local_id: seed.local1Id,
      prov_id: proveedorId, fecha: today,
      nro: `00001-${String(Math.floor(Math.random() * 99999)).padStart(8, "0")}`,
      neto: 8264, iva21: 1736, iva105: 0, iibb: 0, total: 10000,
      cat: "INSUMOS COCINA", estado: "pendiente", tipo: "A",
    });

    // 29-may fix: agregar randomness extra al nombre para evitar cualquier
    // colisión si el insumo ya tiene una MP con nombre similar de run previo.
    const mpNombre = `${SENTINEL}_MP_${Math.random().toString(36).slice(2, 8)}`;
    const { data: mp, error: mpErr } = await svc.from("materias_primas").insert({
      tenant_id: seed.tenantId, nombre: mpNombre,
      insumo_id: insumoId, proveedor_id: proveedorId,
      unidad_compra: "kg", precio_actual: 2000, factor_conversion: 1, activa: true,
    }).select("id").single();
    if (mpErr) throw new Error(`Insert materia_prima: ${mpErr.message}`);
    materiaPrimaId = mp!.id as number;

    await svc.from("factura_items").insert({
      factura_id: facturaId, tenant_id: seed.tenantId,
      producto: "Arroz 5kg", cantidad: 5, unidad: "kg",
      precio_unitario: 2000, subtotal: 10000,
      materia_prima_id: materiaPrimaId,
    });
    await new Promise(r => setTimeout(r, 400));
    const { data: insAfter } = await svc.from("insumos").select("stock_actual").eq("id", insumoId!).single();
    expect(Number(insAfter!.stock_actual)).toBe(5);

    // Item + receta (0.1kg/u, precio $5000)
    const { data: it } = await svc.from("items").insert({
      tenant_id: seed.tenantId, local_id: seed.local1Id,
      nombre: `${SENTINEL}_Sushi`, precio_madre: 5000, estado: "disponible",
    }).select("id").single();
    itemId = it!.id as number;

    const { data: rec } = await svc.from("recetas").insert({
      tenant_id: seed.tenantId, local_id: seed.local1Id,
      item_id: itemId, nombre: `Receta ${SENTINEL}`, rendimiento: 1, activa: true,
    }).select("id").single();
    recetaId = rec!.id as number;

    await svc.from("receta_insumos").insert({
      tenant_id: seed.tenantId, receta_id: recetaId, insumo_id: insumoId,
      cantidad: 0.1, orden: 1,
    });

    // [2] Marketplace settings con slug único. uniq_cls_local es PARCIAL
    // (WHERE deleted_at IS NULL) entonces ON CONFLICT no aplica. Delete
    // existing + insert.
    await svc.from("comanda_local_settings").delete().eq("local_id", seed.local1Id);
    const { error: cls } = await svc.from("comanda_local_settings").insert({
      tenant_id: seed.tenantId, local_id: seed.local1Id,
      slug: SLUG_MARKETPLACE, tienda_activa: true, acepta_delivery: true,
    });
    expect(cls).toBeNull();

    // [3] Turno de caja abierto. Primero cerrar turnos abiertos previos
    // (un local solo puede tener 1 turno abierto a la vez).
    await svc.from("turnos_caja")
      .update({ estado: "cerrado", monto_final_declarado: 0, cerrado_at: new Date().toISOString() })
      .eq("local_id", seed.local1Id).eq("estado", "abierto");

    // Abrir turno via RPC desde duenoDb (tiene tenant en JWT, pasa
    // fn_assert_local_autorizado que con svc/service_role falla por NULL).
    const duenoSvc = await createE2EDuenoClient();
    const { data: turnoIdRes, error: tErr } = await duenoSvc.rpc("fn_abrir_turno_caja_comanda", {
      p_local_id: seed.local1Id,
      p_cajero_id: seed.empleados.mensual.id,
      p_monto_inicial: 0,
      p_notas: `Test marketplace ${SENTINEL}`,
    });
    if (tErr) throw new Error(`fn_abrir_turno_caja_comanda: ${tErr.message}`);
    await duenoSvc.auth.signOut();
    turnoId = turnoIdRes as unknown as number;
  });

  test("[4-5] Crear pedido público + idempotency", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const idemKey = `${SENTINEL}-ped`;

    // [4] fn_crear_pedido_publico_comanda
    const { data, error } = await svc.rpc("fn_crear_pedido_publico_comanda", {
      p_local_slug: SLUG_MARKETPLACE,
      p_cliente_nombre: `Cliente ${SENTINEL}`,
      p_cliente_telefono: "1144445555",
      p_cliente_email: "cliente@e2e.test",
      p_tipo_entrega: "retiro",
      p_cliente_direccion: null,
      p_items: [{ item_id: itemId!, cantidad: 2 }],
      p_metodo_pago_preferido: "mercadopago",
      p_notas: `Pedido E2E ${SENTINEL}`,
      p_programada_para: null,
      p_idempotency_key: idemKey,
    });
    expect(error).toBeNull();
    ventaId = Number(data?.[0]?.venta_id);
    expect(ventaId).toBeGreaterThan(0);

    // DB-strict: venta creada con estado y origen correctos
    const { data: v } = await svc.from("ventas_pos")
      .select("estado, origen, total, cliente_nombre, cliente_telefono")
      .eq("id", ventaId!).single();
    expect(v?.estado).toBe("necesita_aprobacion");
    expect(v?.origen).toBe("tienda_online");
    expect(Number(v?.total)).toBe(10000);  // 2 unidades × $5000
    expect(v?.cliente_telefono).toBe("1144445555");

    // [5] Idempotency: reenviar mismo key → mismo venta_id
    const { data: data2 } = await svc.rpc("fn_crear_pedido_publico_comanda", {
      p_local_slug: SLUG_MARKETPLACE,
      p_cliente_nombre: "X", p_cliente_telefono: "1", p_cliente_email: null,
      p_tipo_entrega: "retiro", p_cliente_direccion: null,
      p_items: [{ item_id: itemId!, cantidad: 99 }],
      p_metodo_pago_preferido: "mercadopago",
      p_notas: null, p_programada_para: null,
      p_idempotency_key: idemKey,
    });
    expect(Number(data2?.[0]?.venta_id)).toBe(ventaId);
  });

  test("[6] Cliente consulta su pedido por teléfono", async () => {
    if (!ventaId) { test.skip(true, "Venta no creada"); return; }
    const svc = createServiceClient();
    const { data, error } = await svc.rpc("fn_get_pedido_publico_comanda", {
      p_venta_id: ventaId, p_telefono: "1144445555",
    });
    expect(error).toBeNull();
    expect(data?.[0]?.estado).toBe("necesita_aprobacion");
  });

  test("[7] Aprobar pedido → estado=enviada", async () => {
    if (!ventaId) { test.skip(true, "Venta no creada"); return; }
    const db = await createE2EDuenoClient();
    const svc = createServiceClient();
    const { error } = await db.rpc("fn_aprobar_pedido_comanda", { p_venta_id: ventaId });
    expect(error).toBeNull();
    const { data } = await svc.from("ventas_pos")
      .select("estado, enviada_at").eq("id", ventaId).single();
    expect(data?.estado).toBe("enviada");
    expect(data?.enviada_at).not.toBeNull();
    await db.auth.signOut();
  });

  test("[8-9] Cobrar via webhook MP → estado=cobrada + trigger baja stock", async () => {
    if (!ventaId || !insumoId) { test.skip(true, "Setup incompleto"); return; }
    const db = await createE2EDuenoClient();
    const svc = createServiceClient();
    const idemWebhook = `mp-webhook-${SENTINEL}`;
    const idemPago = `mp-payment-${SENTINEL}`;

    // [8] fn_cobrar_venta_comanda (simula EXACTAMENTE lo que hace el webhook MP)
    const { error } = await db.rpc("fn_cobrar_venta_comanda", {
      p_venta_id: ventaId,
      p_pagos: [{
        metodo: "mercadopago",
        monto: 10000,
        idempotency_key: idemPago,
      }],
      p_propina: 0,
      p_cobrado_por: null,
      p_idempotency_key: idemWebhook,
    });
    expect(error).toBeNull();

    // Esperar trigger
    await new Promise(r => setTimeout(r, 600));

    // Venta cobrada
    const { data: v } = await svc.from("ventas_pos")
      .select("estado, cobrada_at").eq("id", ventaId).single();
    expect(v?.estado).toBe("cobrada");
    expect(v?.cobrada_at).not.toBeNull();

    // [9] Trigger bajó stock 0.2kg (2 unidades × 0.1kg receta)
    const { data: stockFin } = await svc.from("insumos")
      .select("stock_actual").eq("id", insumoId).single();
    expect(Number(stockFin!.stock_actual)).toBeCloseTo(4.8, 3);

    // insumo_movimientos tiene la salida_venta correcta
    const { data: movs } = await svc.from("insumo_movimientos")
      .select("tipo, cantidad, fuente_tipo")
      .eq("insumo_id", insumoId).order("created_at");
    const salidaVenta = movs?.find(m => m.tipo === "salida_venta");
    expect(salidaVenta).toBeDefined();
    expect(Number(salidaVenta!.cantidad)).toBeCloseTo(-0.2, 3);
    expect(salidaVenta!.fuente_tipo).toBe("venta_pos_item");

    await db.auth.signOut();
  });

  test("[10-11] Idempotency cobro + ventas_pos_pagos cargado correctamente", async () => {
    if (!ventaId) { test.skip(true, "Venta no creada"); return; }
    const db = await createE2EDuenoClient();
    const svc = createServiceClient();

    // [10] Replay del webhook con mismas keys → NO debe crear pagos duplicados
    await db.rpc("fn_cobrar_venta_comanda", {
      p_venta_id: ventaId,
      p_pagos: [{
        metodo: "mercadopago", monto: 10000,
        idempotency_key: `mp-payment-${SENTINEL}`,
      }],
      p_propina: 0, p_cobrado_por: null,
      p_idempotency_key: `mp-webhook-${SENTINEL}`,
    });
    // No nos importa si retorna error o no — lo que importa es el invariant:
    const { data: pagos } = await svc.from("ventas_pos_pagos")
      .select("metodo, monto, estado").eq("venta_id", ventaId);
    expect(pagos?.length).toBe(1);  // 1 solo pago, no duplicado por replay

    // [11] El pago tiene los datos correctos
    expect(pagos?.[0]?.metodo).toBe("mercadopago");
    expect(Number(pagos?.[0]?.monto)).toBe(10000);
    expect(pagos?.[0]?.estado).toBe("confirmado");

    await db.auth.signOut();
  });
});
