// ─────────────────────────────────────────────────────────────────────────
// E2E Test 29 — POS COMANDA: transferir mesa + unir mesas + partir cuenta
//
// Operaciones del POS sobre venta abierta que requieren manager activo
// (rol_pos IN ('manager','dueno') AND pos_activo=TRUE) por C11.
//
// Las 3 RPCs viven en `202605151700_f1_5_auth_check_rpcs_sprint2.sql` que
// agregó el chequeo IDOR intra-tenant (mesa/venta destino debe ser del mismo
// local). Sin este check, un encargado de local A podía mover ventas a
// mesas del local B del mismo tenant.
//
// Cubre:
//  A) transferir_mesa: mover venta de mesa1 a mesa2 → mesa origen libre + destino ocupada
//  B) transferir_mesa cross-local → MESA_DESTINO_CROSS_LOCAL
//  C) unir_mesas: items de venta1 pasan a venta2 + venta1 anulada + mesa1 libre
//  D) unir_mesas IDs iguales → VENTAS_IGUALES
//  E) partir_cuenta: subset de items pasa a venta nueva → ambas con totales recalc
//  F) partir_cuenta sin items → ITEMS_REQUERIDOS
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
import {
  seedComandaPos,
  type E2EComandaPosSeed,
} from "../setup/seed-comanda";

test.describe.serial("E2E Test 29 — POS: mesas (transferir / unir / partir)", () => {
  let seed: E2ETenantSeedResult | null = null;
  let pos: E2EComandaPosSeed | null = null;
  const mesasExtra: { id: number; numero: string }[] = [];  // mesas 5-8 del local1
  let mesaLocal2Id: number;
  let managerId: string = "";


  test.beforeAll(async () => {
    // Lee el seed compartido creado por globalSetup (UN tenant E2E para toda
    // la suite). Sprint 27-may: refactor para eliminar cascada de SLUG_DUPLICATED.
    seed = loadSharedSeed();
    pos = await seedComandaPos(seed);
    // 29-may fix: usar el QUINCENAL promovido a manager por seedComandaPos.
    managerId = pos.managerEmpleadoId;
  });

  // Helper: combina mesas del seed (0-3) + extras (4-7).
  // mesa(0..3) = pos.mesas[0..3]; mesa(4..7) = mesasExtra[0..3]
  function mesaAt(idx: number): number {
    if (idx < 4) return pos!.mesas[idx]!.id;
    return mesasExtra[idx - 4]!.id;
  }
  async function abrirVentaEn(duenoDb: Awaited<ReturnType<typeof createE2EDuenoClient>>, mesaIdx: number) {
    if (!seed || !pos) throw new Error("seed null");
    const { data: vRes, error } = await duenoDb.rpc("fn_abrir_venta_comanda", {
      p_local_id: seed.local1Id,
      p_modo: "salon",
      p_canal_id: pos.canalSalonId,
      p_mesa_id: mesaAt(mesaIdx),
      p_cajero_id: pos.cajeroEmpleadoId,
      p_covers: 2, p_origen: "pos", p_estado: "abierta",
    });
    if (error) throw new Error(`abrir venta: ${error.message}`);
    return vRes as unknown as number;
  }

  async function agregarItem(duenoDb: Awaited<ReturnType<typeof createE2EDuenoClient>>, ventaId: number, itemSubstring: string) {
    if (!seed) throw new Error("seed null");
    const item = seed.items.find(i => i.nombre.includes(itemSubstring))!;
    await duenoDb.rpc("fn_agregar_item_comanda", {
      p_venta_id: ventaId, p_item_id: item.id, p_cantidad: 1,
    });
  }

  test("A) transferir_mesa: venta pasa de mesa1 a mesa2", async () => {
    if (!seed || !pos) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();
    const ventaId = await abrirVentaEn(duenoDb, 0); // mesa[0]
    await agregarItem(duenoDb, ventaId, "Sushi");

    const mesaOrigenId = mesaAt(0);
    const mesaDestinoId = mesaAt(1);

    const { error } = await duenoDb.rpc("fn_transferir_mesa_comanda", {
      p_venta_id: ventaId,
      p_mesa_destino: mesaDestinoId,
      p_manager_id: managerId,
      p_motivo: "T29 transferir mesa",
    });
    if (error) throw new Error(`fn_transferir_mesa_comanda: ${error.message}`);

    const { data: venta } = await svc.from("ventas_pos").select("mesa_id").eq("id", ventaId).single();
    expect(venta!.mesa_id).toBe(mesaDestinoId);

    const { data: mesas } = await svc.from("mesas")
      .select("id, estado").in("id", [mesaOrigenId, mesaDestinoId]);
    const origen = mesas!.find(m => m.id === mesaOrigenId);
    const destino = mesas!.find(m => m.id === mesaDestinoId);
    expect(origen!.estado).toBe("libre");
    expect(destino!.estado).toBe("ocupada");

    // Override registrado
    const { data: ovs } = await svc.from("ventas_pos_overrides")
      .select("accion").eq("venta_id", ventaId);
    expect(ovs!.some(o => o.accion === "transfer_table")).toBe(true);
    await duenoDb.auth.signOut();
  });

  test("B) transferir_mesa CROSS-LOCAL → MESA_DESTINO_CROSS_LOCAL", async () => {
    if (!seed || !pos) { test.skip(true, "Seed falló"); return; }
    const duenoDb = await createE2EDuenoClient();
    const ventaId = await abrirVentaEn(duenoDb, 2);

    const { error } = await duenoDb.rpc("fn_transferir_mesa_comanda", {
      p_venta_id: ventaId,
      p_mesa_destino: mesaLocal2Id, // mesa del local2 ← cross-local
      p_manager_id: managerId,
      p_motivo: "intentar cross-local",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("MESA_DESTINO_CROSS_LOCAL");
    await duenoDb.auth.signOut();
  });

  test("C) unir_mesas: items de venta1 pasan a venta2 + venta1 anulada", async () => {
    if (!seed || !pos) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    const v1 = await abrirVentaEn(duenoDb, 3); // mesa[3]
    await agregarItem(duenoDb, v1, "Sushi");
    const v2 = await abrirVentaEn(duenoDb, 4); // mesa[4]
    await agregarItem(duenoDb, v2, "Bebida");

    const { error } = await duenoDb.rpc("fn_unir_mesas_comanda", {
      p_venta_origen_id: v1,
      p_venta_destino_id: v2,
      p_manager_id: managerId,
      p_motivo: "T29 unir mesas",
    });
    if (error) throw new Error(`fn_unir_mesas_comanda: ${error.message}`);

    const { data: vOrigen } = await svc.from("ventas_pos").select("estado").eq("id", v1).single();
    const { data: vDestino } = await svc.from("ventas_pos").select("estado, total").eq("id", v2).single();
    expect(vOrigen!.estado).toBe("anulada");
    expect(vDestino!.estado).toBe("abierta");
    expect(Number(vDestino!.total)).toBe(12000 + 3500); // Sushi + Bebida

    // Items movidos al destino
    const { data: itemsDestino } = await svc.from("ventas_pos_items")
      .select("id").eq("venta_id", v2).is("deleted_at", null);
    expect(itemsDestino).toHaveLength(2);

    // Mesa origen liberada
    const { data: mesaOrigen } = await svc.from("mesas").select("estado").eq("id", mesaAt(3)).single();
    expect(mesaOrigen!.estado).toBe("libre");

    // Override 'merge_mesas'
    const { data: ovs } = await svc.from("ventas_pos_overrides").select("accion").eq("venta_id", v2);
    expect(ovs!.some(o => o.accion === "merge_mesas")).toBe(true);
    await duenoDb.auth.signOut();
  });

  test("D) unir_mesas con IDs iguales → VENTAS_IGUALES", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const duenoDb = await createE2EDuenoClient();
    const v1 = await abrirVentaEn(duenoDb, 5);

    const { error } = await duenoDb.rpc("fn_unir_mesas_comanda", {
      p_venta_origen_id: v1, p_venta_destino_id: v1,
      p_manager_id: managerId, p_motivo: "ids iguales",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("VENTAS_IGUALES");
    await duenoDb.auth.signOut();
  });

  test("E) partir_cuenta: subset de items pasa a venta nueva con totales recalc", async () => {
    if (!seed || !pos) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const duenoDb = await createE2EDuenoClient();

    const vOrig = await abrirVentaEn(duenoDb, 6); // mesa[6]
    await agregarItem(duenoDb, vOrig, "Sushi");    // 12000
    await agregarItem(duenoDb, vOrig, "Bebida");   // 3500

    const { data: items } = await svc.from("ventas_pos_items")
      .select("id, item_id, precio_unitario").eq("venta_id", vOrig)
      .is("deleted_at", null).order("id");
    const bebidaItemId = items![1]!.id;

    const { data: ventaNuevaIdRes, error } = await duenoDb.rpc("fn_partir_cuenta_comanda", {
      p_venta_id: vOrig,
      p_item_ids: [bebidaItemId],
      p_manager_id: managerId,
      p_motivo: "T29 partir bebida",
    });
    if (error) throw new Error(`fn_partir_cuenta_comanda: ${error.message}`);
    const ventaNuevaId = ventaNuevaIdRes as unknown as number;
    expect(ventaNuevaId).toBeGreaterThan(0);

    const { data: vOrigAfter } = await svc.from("ventas_pos")
      .select("total, estado").eq("id", vOrig).single();
    const { data: vNuevaAfter } = await svc.from("ventas_pos")
      .select("total, estado").eq("id", ventaNuevaId).single();
    expect(Number(vOrigAfter!.total)).toBe(12000); // solo sushi
    expect(Number(vNuevaAfter!.total)).toBe(3500); // solo bebida
    expect(vNuevaAfter!.estado).toBe("abierta");

    const { data: ovs } = await svc.from("ventas_pos_overrides")
      .select("accion").eq("venta_id", vOrig);
    expect(ovs!.some(o => o.accion === "split_check")).toBe(true);
    await duenoDb.auth.signOut();
  });

  test("F) partir_cuenta sin items → ITEMS_REQUERIDOS", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const duenoDb = await createE2EDuenoClient();
    const vOrig = await abrirVentaEn(duenoDb, 7);
    await agregarItem(duenoDb, vOrig, "Sushi");

    const { error } = await duenoDb.rpc("fn_partir_cuenta_comanda", {
      p_venta_id: vOrig, p_item_ids: [],
      p_manager_id: managerId, p_motivo: "array vacío",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("ITEMS_REQUERIDOS");
    await duenoDb.auth.signOut();
  });
});
