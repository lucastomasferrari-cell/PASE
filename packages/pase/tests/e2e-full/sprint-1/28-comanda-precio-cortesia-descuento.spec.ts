// ─────────────────────────────────────────────────────────────────────────
// E2E Test 28 — POS COMANDA: modificar precio + cortesía + descuento
//
// Las 3 RPCs son operaciones del POS que tocan venta abierta:
//  - fn_modificar_precio_item_comanda: el manager autoriza cambiar precio.
//    Inserta ventas_pos_overrides accion='discount' subtype='modificar_precio_item'.
//  - fn_cortesia_item_comanda: marca item como cortesía (precio=0).
//    Inserta ventas_pos_overrides accion='comp' subtype='cortesia_item'.
//  - fn_aplicar_descuento_comanda: descuenta $X del total de la venta.
//    Si >15% del subtotal: requiere manager. Si ≤15%: permiso 'comanda.ventas.descuento'.
//
// Cubre:
//  A) modificar precio de un item con manager válido → precio cambia, override registrado
//  B) modificar precio NEGATIVO → PRECIO_NEGATIVO
//  C) modificar precio con motivo <5 chars → MOTIVO_REQUERIDO
//  D) cortesía: marcar item con manager → precio=0, es_cortesia=true, override 'comp'
//  E) descuento pequeño (10%) sin manager → OK
//  F) descuento grande (25%) sin manager → MANAGER_REQUERIDO_DESCUENTO_GRANDE
//  G) descuento grande con manager válido → OK
//  H) descuento negativo → DESCUENTO_INVALIDO
// ─────────────────────────────────────────────────────────────────────────

import {
  test,
  expect,
} from "@playwright/test";
import {
  cleanupE2ETenant,
  createServiceClient,
  createE2EDuenoClient,
  type E2ETenantSeedResult,
} from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";
import {
  seedComandaPos,
  type E2EComandaPosSeed,
} from "../setup/seed-comanda";

test.describe.serial("E2E Test 28 — POS: modificar precio / cortesía / descuento", () => {
  let seed: E2ETenantSeedResult | null = null;
  let pos: E2EComandaPosSeed | null = null;
  let managerId: string;  // empleado activo con rol_pos='manager'

   
  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
    pos = await seedComandaPos(seed);
  });

  test.afterAll(async () => { try { await cleanupE2ETenant(); } catch (e) { console.error(e); } });

  // Helper: abre una venta nueva con 2 items y devuelve { ventaId, item1Id, item2Id }
  async function abrirVentaConItems(duenoDb: Awaited<ReturnType<typeof createE2EDuenoClient>>): Promise<{
    ventaId: number; item1Id: number; item2Id: number; totalEsperado: number;
  }> {
    if (!seed || !pos) throw new Error("seed no inicializado");
    const { data: ventaIdRes } = await duenoDb.rpc("fn_abrir_venta_comanda", {
      p_local_id: seed.local1Id,
      p_modo: "salon",
      p_canal_id: pos.canalSalonId,
      p_mesa_id: pos.mesas[0]!.id,
      p_cajero_id: pos.cajeroEmpleadoId,
      p_covers: 2,
      p_origen: "pos",
      p_estado: "abierta",
    });
    const ventaId = ventaIdRes as unknown as number;

    const item1 = seed.items.find(i => i.nombre.includes("Sushi"))!;
    const item2 = seed.items.find(i => i.nombre.includes("Bebida"))!;
    await duenoDb.rpc("fn_agregar_item_comanda", { p_venta_id: ventaId, p_item_id: item1.id, p_cantidad: 1 });
    await duenoDb.rpc("fn_agregar_item_comanda", { p_venta_id: ventaId, p_item_id: item2.id, p_cantidad: 1 });

    const svc = createServiceClient();
    const { data: vItems } = await svc.from("ventas_pos_items")
      .select("id, item_id, precio_unitario").eq("venta_id", ventaId)
      .is("deleted_at", null).order("id");
    return {
      ventaId,
      item1Id: vItems![0]!.id as number,
      item2Id: vItems![1]!.id as number,
      totalEsperado: 12000 + 3500,
    };
  }

  test("A) modificar precio con manager → precio cambia + override", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const { ventaId, item1Id } = await abrirVentaConItems(duenoDb);

    const { error } = await duenoDb.rpc("fn_modificar_precio_item_comanda", {
      p_item_id: item1Id,
      p_nuevo_precio: 9000,  // bajamos de 12000 a 9000
      p_manager_id: managerId,
      p_motivo: "T28 descuento manual sushi",
    });
    if (error) throw new Error(`fn_modificar_precio_item_comanda: ${error.message}`);

    const { data: itemAfter } = await svc.from("ventas_pos_items")
      .select("precio_unitario, precio_unitario_original").eq("id", item1Id).single();
    expect(Number(itemAfter!.precio_unitario)).toBe(9000);
    expect(Number(itemAfter!.precio_unitario_original)).toBe(12000);

    const { data: ovs } = await svc.from("ventas_pos_overrides")
      .select("accion, metadata").eq("venta_id", ventaId);
    const ovModif = ovs!.find(o => o.metadata && (o.metadata as { subtype?: string }).subtype === "modificar_precio_item");
    expect(ovModif).toBeDefined();
    expect(ovModif!.accion).toBe("discount");

    await duenoDb.auth.signOut();
  });

  test("B) modificar precio NEGATIVO → PRECIO_NEGATIVO", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const duenoDb = await createE2EDuenoClient();
    const { item1Id } = await abrirVentaConItems(duenoDb);

    const { error } = await duenoDb.rpc("fn_modificar_precio_item_comanda", {
      p_item_id: item1Id, p_nuevo_precio: -100, p_manager_id: managerId,
      p_motivo: "intentar negativo",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("PRECIO_NEGATIVO");
    await duenoDb.auth.signOut();
  });

  test("C) modificar precio con motivo <5 chars → MOTIVO_REQUERIDO", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const duenoDb = await createE2EDuenoClient();
    const { item1Id } = await abrirVentaConItems(duenoDb);

    const { error } = await duenoDb.rpc("fn_modificar_precio_item_comanda", {
      p_item_id: item1Id, p_nuevo_precio: 5000, p_manager_id: managerId, p_motivo: "x",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("MOTIVO_REQUERIDO");
    await duenoDb.auth.signOut();
  });

  test("D) cortesía: item queda en 0 + es_cortesia=true + override 'comp'", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const { ventaId, item1Id } = await abrirVentaConItems(duenoDb);

    const { error } = await duenoDb.rpc("fn_cortesia_item_comanda", {
      p_item_id: item1Id, p_manager_id: managerId,
      p_motivo: "T28 cortesía de cumpleaños",
    });
    if (error) throw new Error(`fn_cortesia_item_comanda: ${error.message}`);

    const { data: itemAfter } = await svc.from("ventas_pos_items")
      .select("precio_unitario, es_cortesia, subtotal").eq("id", item1Id).single();
    expect(Number(itemAfter!.precio_unitario)).toBe(0);
    expect(itemAfter!.es_cortesia).toBe(true);
    expect(Number(itemAfter!.subtotal)).toBe(0);

    const { data: ovs } = await svc.from("ventas_pos_overrides")
      .select("accion, metadata").eq("venta_id", ventaId);
    const ovComp = ovs!.find(o => o.metadata && (o.metadata as { subtype?: string }).subtype === "cortesia_item");
    expect(ovComp).toBeDefined();
    expect(ovComp!.accion).toBe("comp");

    await duenoDb.auth.signOut();
  });

  test("E) descuento ≤15% sin manager → OK (permiso dueño)", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const { ventaId } = await abrirVentaConItems(duenoDb);
    // subtotal = 15500. 10% = 1550. p_monto = 1550 → 10% exacto, ≤15%.
    const { error } = await duenoDb.rpc("fn_aplicar_descuento_comanda", {
      p_venta_id: ventaId, p_monto: 1500, p_motivo: "T28 descuento 10%",
      // SIN p_manager_id → debe pasar porque el dueño tiene permiso de descuento
    });
    if (error) throw new Error(`fn_aplicar_descuento_comanda 10%: ${error.message}`);

    const { data: venta } = await svc.from("ventas_pos")
      .select("descuento_total, total").eq("id", ventaId).single();
    expect(Number(venta!.descuento_total)).toBe(1500);
    await duenoDb.auth.signOut();
  });

  test("F) descuento >15% sin manager → MANAGER_REQUERIDO_DESCUENTO_GRANDE", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const duenoDb = await createE2EDuenoClient();
    const { ventaId } = await abrirVentaConItems(duenoDb);
    // subtotal=15500. 30% = 4650. Sin manager.
    const { error } = await duenoDb.rpc("fn_aplicar_descuento_comanda", {
      p_venta_id: ventaId, p_monto: 4650, p_motivo: "intentar 30% sin manager",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("MANAGER_REQUERIDO_DESCUENTO_GRANDE");
    await duenoDb.auth.signOut();
  });

  test("G) descuento >15% con manager → OK", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const { ventaId } = await abrirVentaConItems(duenoDb);
    const { error } = await duenoDb.rpc("fn_aplicar_descuento_comanda", {
      p_venta_id: ventaId, p_monto: 4650, p_motivo: "T28 30% con manager",
      p_manager_id: managerId,
    });
    if (error) throw new Error(`fn_aplicar_descuento_comanda 30% con mgr: ${error.message}`);

    const { data: venta } = await svc.from("ventas_pos")
      .select("descuento_total").eq("id", ventaId).single();
    expect(Number(venta!.descuento_total)).toBe(4650);

    // Override 'discount' debe estar registrado porque pasamos manager_id
    const { data: ovs } = await svc.from("ventas_pos_overrides")
      .select("accion").eq("venta_id", ventaId);
    expect(ovs!.some(o => o.accion === "discount")).toBe(true);
    await duenoDb.auth.signOut();
  });

  test("H) descuento negativo → DESCUENTO_INVALIDO", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const duenoDb = await createE2EDuenoClient();
    const { ventaId } = await abrirVentaConItems(duenoDb);
    const { error } = await duenoDb.rpc("fn_aplicar_descuento_comanda", {
      p_venta_id: ventaId, p_monto: -500, p_motivo: "negativo",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("DESCUENTO_INVALIDO");
    await duenoDb.auth.signOut();
  });
});
