// ─────────────────────────────────────────────────────────────────────────
// E2E Test 44 — MESA: ciclo completo de reserva (modelo v3, Tier1 #4)
//
// Migración 202606130100_mesa_modelo_reservas.sql. Ciclo punta a punta
// contra el tenant E2E (DB-only):
//
//   [1] fn_crear_reserva con teléfono → cliente_id upserteado (tel
//       normalizado) + duracion_min default por tamaño de grupo
//   [2] confirmar → sentar CON mesa (sentada_at + mesa_id)
//   [3] fn_abrir_venta_comanda en esa mesa → link inverso: reservas.venta_id
//       = la venta + cliente_id copiado al ticket
//   [4] agregar item + fn_cobrar_venta_comanda → el trigger
//       trg_venta_pos_finalizar_reserva auto-finaliza la reserva
//   [5] INVARIANTE: ninguna reserva 'sentada' del tenant cuya venta linkeada
//       esté 'cobrada' (si existe, el trigger de auto-finalizar no corrió)
//
// Seed: el tenant E2E puede no tener comanda_local_settings para el local 1
// (specs 15/34 la crean/borran con sus propios slugs) — beforeAll la crea si
// falta (reservas_activas=true, gracia 30). Mesa dedicada para no chocar con
// las ventas/mesas que dejaron los specs 02/28/29/31/32.
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

const SENT = "ZZE2ERESERVA44";
const RUN = Date.now();
// Mismo número, dos formatos AR — fn_normalizar_telefono los unifica.
const TEL_SUF = String(RUN % 100000000).padStart(8, "0");
const TEL_RESERVA = `+54 9 11 ${TEL_SUF.slice(0, 4)}-${TEL_SUF.slice(4)}`;

test.describe.serial("E2E Test 44 — MESA reservas: ciclo crear→sentar→venta→cobrar", () => {
  let seed: E2ETenantSeedResult | null = null;
  let pos: E2EComandaPosSeed | null = null;
  let mesaId: number;
  let reservaId: number;
  let ventaId: number;
  let clienteId: number;

  test.beforeAll(async () => {
    seed = loadSharedSeed();
    pos = await seedComandaPos(seed);
    const svc = createServiceClient();

    // comanda_local_settings para local 1: el seed base NO la crea (la crean
    // los specs de marketplace con slugs propios y a veces la borran). Si
    // falta, crearla con reservas activas.
    const { data: cfg } = await svc
      .from("comanda_local_settings")
      .select("id, reservas_activas")
      .eq("local_id", seed.local1Id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!cfg) {
      const { error: insErr } = await svc.from("comanda_local_settings").insert({
        tenant_id: seed.tenantId,
        local_id: seed.local1Id,
        slug: `e2e-t44-reservas-${RUN}`,
        tienda_activa: true,
        reservas_activas: true,
        reservas_no_show_gracia_min: 30,
      });
      if (insErr) throw new Error(`Seed comanda_local_settings T44: ${insErr.message}`);
    } else if (!cfg.reservas_activas) {
      await svc
        .from("comanda_local_settings")
        .update({ reservas_activas: true })
        .eq("id", cfg.id as number);
    }

    // Mesa dedicada del test (libre, sin ventas previas de otros specs).
    const { data: mesa, error: mesaErr } = await svc
      .from("mesas")
      .insert({
        tenant_id: seed.tenantId,
        local_id: seed.local1Id,
        numero: `L1-T44-${RUN}`,
        capacidad: 4,
        estado: "libre",
      })
      .select("id")
      .single();
    if (mesaErr) throw new Error(`Seed mesa T44: ${mesaErr.message}`);
    mesaId = mesa!.id as number;
  });

  test("[1-2] crear con teléfono (cliente_id + duracion) → confirmar → sentar con mesa", async () => {
    if (!seed || !pos) { test.skip(true, "Seed falló"); return; }
    const duenoDb = await createE2EDuenoClient();
    const svc = createServiceClient();

    // fecha_hora cercana a NOW: el link inverso de fn_abrir_venta_comanda usa
    // la ventana [NOW−4h, NOW+2h].
    const fechaHora = new Date(Date.now() + 30 * 60_000).toISOString();
    const { data: ridRaw, error: crearErr } = await duenoDb.rpc("fn_crear_reserva", {
      p_local_id: seed.local1Id,
      p_cliente_nombre: `${SENT} Cliente`,
      p_cliente_telefono: TEL_RESERVA,
      p_fecha_hora: fechaHora,
      p_personas: 2,
      p_idempotency_key: `${SENT}-${RUN}`,
    });
    if (crearErr) throw new Error(`fn_crear_reserva: ${crearErr.message}`);
    reservaId = Number(ridRaw);
    expect(reservaId).toBeGreaterThan(0);

    const { data: r1 } = await svc
      .from("reservas")
      .select("estado, cliente_id, duracion_min")
      .eq("id", reservaId)
      .single();
    expect(r1!.estado).toBe("pendiente");
    expect(r1!.cliente_id, "crear con teléfono debe upsertear cliente y guardar el id").not.toBeNull();
    clienteId = r1!.cliente_id as number;
    // Config default: ≤2 personas → 90 min (el tenant E2E no la customiza).
    expect(Number(r1!.duracion_min)).toBe(90);

    // El cliente quedó con el teléfono canónico NORMALIZADO.
    const { data: cli } = await svc
      .from("clientes")
      .select("telefono, tenant_id")
      .eq("id", clienteId)
      .single();
    expect(cli!.tenant_id).toBe(seed.tenantId);
    expect(cli!.telefono).toBe(`11${TEL_SUF}`);

    // confirmar → sentar con mesa
    const { error: confErr } = await duenoDb.rpc("fn_cambiar_estado_reserva", {
      p_reserva_id: reservaId, p_nuevo_estado: "confirmada", p_motivo: null, p_mesa_id: null,
    });
    if (confErr) throw new Error(`confirmar: ${confErr.message}`);

    const { error: sentErr } = await duenoDb.rpc("fn_cambiar_estado_reserva", {
      p_reserva_id: reservaId, p_nuevo_estado: "sentada", p_motivo: null, p_mesa_id: mesaId,
    });
    if (sentErr) throw new Error(`sentar: ${sentErr.message}`);

    const { data: r2 } = await svc
      .from("reservas")
      .select("estado, mesa_id, sentada_at, venta_id")
      .eq("id", reservaId)
      .single();
    expect(r2!.estado).toBe("sentada");
    expect(r2!.mesa_id).toBe(mesaId);
    expect(r2!.sentada_at).not.toBeNull();
    expect(r2!.venta_id, "todavía no hay venta en la mesa").toBeNull();

    await duenoDb.auth.signOut();
  });

  test("[3] abrir venta en la mesa → link inverso + cliente_id al ticket", async () => {
    if (!seed || !pos) { test.skip(true, "Seed falló"); return; }
    const duenoDb = await createE2EDuenoClient();
    const svc = createServiceClient();

    const { data: vRaw, error: vErr } = await duenoDb.rpc("fn_abrir_venta_comanda", {
      p_local_id: seed.local1Id,
      p_modo: "salon",
      p_canal_id: pos.canalSalonId,
      p_mesa_id: mesaId,
      p_cajero_id: pos.cajeroEmpleadoId,
      p_covers: 2,
      p_origen: "pos",
      p_estado: "abierta",
    });
    if (vErr) throw new Error(`fn_abrir_venta_comanda: ${vErr.message}`);
    ventaId = Number(vRaw);
    expect(ventaId).toBeGreaterThan(0);

    const { data: r } = await svc
      .from("reservas")
      .select("venta_id, estado")
      .eq("id", reservaId)
      .single();
    expect(r!.venta_id, "abrir venta en mesa con reserva sentada debe linkearla (link inverso)").toBe(ventaId);
    expect(r!.estado).toBe("sentada");

    const { data: v } = await svc
      .from("ventas_pos")
      .select("cliente_id, mesa_id")
      .eq("id", ventaId)
      .single();
    expect(v!.mesa_id).toBe(mesaId);
    expect(v!.cliente_id, "el cliente de la reserva debe copiarse al ticket").toBe(clienteId);

    await duenoDb.auth.signOut();
  });

  test("[4] cobrar la venta → la reserva se auto-finaliza (trigger)", async () => {
    if (!seed || !pos) { test.skip(true, "Seed falló"); return; }
    const duenoDb = await createE2EDuenoClient();
    const svc = createServiceClient();

    const itemSushi = seed.items.find(i => i.nombre.includes("Sushi"))!;
    const { error: addErr } = await duenoDb.rpc("fn_agregar_item_comanda", {
      p_venta_id: ventaId,
      p_item_id: itemSushi.id,
      p_cantidad: 1,
    });
    if (addErr) throw new Error(`fn_agregar_item_comanda: ${addErr.message}`);

    const { data: vTotal } = await svc.from("ventas_pos").select("total").eq("id", ventaId).single();
    const total = Number(vTotal!.total);
    expect(total).toBeGreaterThan(0);

    const { error: cobrErr } = await duenoDb.rpc("fn_cobrar_venta_comanda", {
      p_venta_id: ventaId,
      p_pagos: [
        { metodo: "EFECTIVO", monto: total, idempotency_key: `${SENT}-pago-${RUN}` },
      ],
      p_propina: 0,
      p_cobrado_por: pos.cajeroEmpleadoId,
      p_idempotency_key: `${SENT}-cobro-${RUN}`,
    });
    if (cobrErr) throw new Error(`fn_cobrar_venta_comanda: ${cobrErr.message}`);

    const { data: v } = await svc.from("ventas_pos").select("estado").eq("id", ventaId).single();
    expect(v!.estado).toBe("cobrada");

    const { data: r } = await svc
      .from("reservas")
      .select("estado, finalizada_at, venta_id, cliente_id")
      .eq("id", reservaId)
      .single();
    expect(r!.estado, "al cobrar el ticket la reserva sentada debe auto-finalizarse").toBe("finalizada");
    expect(r!.finalizada_at).not.toBeNull();
    expect(r!.venta_id, "el link a la venta se conserva").toBe(ventaId);
    expect(r!.cliente_id).toBe(clienteId);

    await duenoDb.auth.signOut();
  });

  test("[5] INVARIANTE: ninguna reserva sentada con venta cobrada", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();

    const { data: sentadas, error: sErr } = await svc
      .from("reservas")
      .select("id, venta_id")
      .eq("tenant_id", seed.tenantId)
      .eq("estado", "sentada")
      .not("venta_id", "is", null)
      .is("deleted_at", null);
    if (sErr) throw new Error(`Query reservas sentadas: ${sErr.message}`);

    if (sentadas && sentadas.length > 0) {
      const ventaIds = sentadas.map(s => s.venta_id as number);
      const { data: cobradas, error: vErr } = await svc
        .from("ventas_pos")
        .select("id")
        .in("id", ventaIds)
        .eq("estado", "cobrada");
      if (vErr) throw new Error(`Query ventas cobradas: ${vErr.message}`);
      const violaciones = (sentadas ?? []).filter(s =>
        (cobradas ?? []).some(c => c.id === s.venta_id),
      );
      expect(
        violaciones,
        `INV-RSV: reservas 'sentada' con venta COBRADA (el trigger de auto-finalizar no corrió): ${JSON.stringify(violaciones)}`,
      ).toHaveLength(0);
    }
  });
});
