import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";
import { createServiceClient } from "./e2e-full/setup/seed-tenant";

// ─────────────────────────────────────────────────────────────────────────
// Test mutante: MESA modelo de reservas v3 (Tier 1 #4).
// Migración 202606130100_mesa_modelo_reservas.sql:
//   - estados: pendiente→confirmada|sentada|cancelada · confirmada→sentada|
//     no_show|cancelada · sentada→finalizada · alias 'cumplida'→'sentada'.
//   - cliente_id SIEMPRE al crear con teléfono (upsert con tel normalizado:
//     '+54 9 11 XXXX-YYYY' ≡ '011 XXXX-YYYY' → 'XXXXYYYY...').
//   - duracion_min default por tamaño de grupo (config JSONB
//     reservas_duracion_por_personas, default ≤2:90/≤4:105/≤6:120/+:150).
//   - venta_id bidireccional: al abrir venta en mesa con reserva sentada →
//     link inverso + copia cliente_id al ticket; al cobrar la venta → trigger
//     trg_venta_pos_finalizar_reserva auto-finaliza la reserva.
//   - fn_cron_auto_no_show (service_role only): confirmadas pasadas de gracia
//     (config reservas_no_show_gracia_min) → no_show + no_show_auto.
//   - fn_check_disponibilidad_reserva v2: cuenta pendiente+confirmada+sentada
//     con solapamiento real por duracion_min.
//
// DB-only, RPCs reales contra Local Prueba 2 (mismo patrón que
// puente_ventas_comanda_mutante). El cron se ejecuta vía service client
// (createServiceClient de la suite e2e — GRANT solo a service_role).
//
// OJO config: si Local Prueba 2 no tiene fila en comanda_local_settings el
// beforeEach la crea (reservas_activas=true, gracia 30) y el afterEach la
// borra; si existe, snapshotea+fuerza esos valores y los restaura.
// Cleanup completo en afterEach, cada paso en su propio try/catch.
// ─────────────────────────────────────────────────────────────────────────

const LOCAL = "Local Prueba 2";
const SENTINEL = "MUT-RSV";
const PRECIO_ITEM = 4747.47; // sentinel: leftover trivial de detectar a ojo

// Sufijo único por corrida (idempotency + teléfono de cliente irrepetible)
const RUN = `mesa-rsv-${Date.now()}`;
const TEL_SUF = String(Date.now() % 100000000).padStart(8, "0");
// Mismo número en dos formatos AR — la normalización debe unificarlos.
const TEL_FORMATO_INTL = `+54 9 11 ${TEL_SUF.slice(0, 4)}-${TEL_SUF.slice(4)}`;
const TEL_FORMATO_LOCAL = `011 ${TEL_SUF.slice(0, 4)} ${TEL_SUF.slice(4)}`;

function idem(label: string): string {
  return `${RUN}-${label}`;
}

function enMinutos(min: number): string {
  return new Date(Date.now() + min * 60_000).toISOString();
}

type DuracionRegla = { hasta: number; min: number };

test.describe("MESA modelo reservas v3 — mutante", () => {
  // ~40 llamadas de red contra prod superan el default de 30s.
  test.setTimeout(180_000);

  let db: SupabaseClient;
  let svc: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let localSlug: string;
  let canalId: number;
  let cajeroId: string;
  let managerId: string | null = null;
  let turnoAbiertoPorTest = false;
  let turnoId: number | null = null;

  // Config de reservas del local: creada por el test o snapshot a restaurar.
  let settingsCreadoId: number | null = null;
  let settingsSnapshot: { reservas_activas: boolean; reservas_no_show_gracia_min: number } | null = null;
  let duracionTabla: DuracionRegla[] = [];
  let duracionFallback = 90;

  let mesaId: number | null = null;
  let createdReservaIds: number[] = [];
  let createdVentaIds: number[] = [];

  function duracionEsperada(personas: number): number {
    for (const regla of duracionTabla) {
      if (personas <= regla.hasta) return regla.min;
    }
    return duracionFallback;
  }

  async function crearReserva(
    nombre: string,
    extra: Record<string, unknown> = {},
  ): Promise<number> {
    const { data, error } = await db.rpc("fn_crear_reserva", {
      p_local_id: localId,
      p_cliente_nombre: nombre,
      p_fecha_hora: enMinutos(30),
      p_personas: 2,
      p_idempotency_key: idem(`crear-${nombre}`),
      ...extra,
    });
    if (error) throw new Error(`fn_crear_reserva (${nombre}): ${error.message}`);
    const id = Number(data);
    createdReservaIds.push(id);
    return id;
  }

  async function cambiarEstado(id: number, estado: string, mesa?: number) {
    return db.rpc("fn_cambiar_estado_reserva", {
      p_reserva_id: id,
      p_nuevo_estado: estado,
      p_motivo: null,
      p_mesa_id: mesa ?? null,
    });
  }

  async function getReserva(id: number) {
    const { data, error } = await db
      .from("reservas")
      .select(
        "estado, mesa_id, cliente_id, venta_id, duracion_min, sentada_at, finalizada_at, no_show_auto, confirmada_at",
      )
      .eq("id", id)
      .single();
    if (error) throw new Error(`Query reserva ${id}: ${error.message}`);
    return data!;
  }

  async function disponibilidad(fechaIso: string, personas: number) {
    const { data, error } = await db.rpc("fn_check_disponibilidad_reserva", {
      p_local_slug: localSlug,
      p_fecha_hora: fechaIso,
      p_personas: personas,
    });
    if (error) throw new Error(`fn_check_disponibilidad_reserva: ${error.message}`);
    const row = (data as Array<{ disponible: boolean; motivo: string; personas_actuales: number; capacidad_max: number }>)[0];
    if (!row) throw new Error("fn_check_disponibilidad_reserva no devolvió fila");
    return row;
  }

  test.beforeEach(async () => {
    db = await createDuenoClient();
    svc = createServiceClient();
    createdReservaIds = [];
    createdVentaIds = [];
    mesaId = null;
    managerId = null;
    turnoAbiertoPorTest = false;
    turnoId = null;
    settingsCreadoId = null;
    settingsSnapshot = null;

    // ── Local Prueba 2 ──
    const { data: locales, error: locErr } = await db
      .from("locales")
      .select("id, tenant_id")
      .eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length !== 1) {
      throw new Error(`Local "${LOCAL}" no único o inexistente (${locales?.length ?? 0})`);
    }
    localId = locales[0]!.id as number;
    tenantId = locales[0]!.tenant_id as string;

    // ── Config de reservas del local (crear si falta / forzar + snapshot) ──
    const { data: cfg, error: cfgErr } = await svc
      .from("comanda_local_settings")
      .select("id, slug, reservas_activas, reservas_no_show_gracia_min, reservas_duracion_por_personas, reservas_duracion_estimada_min")
      .eq("local_id", localId)
      .is("deleted_at", null)
      .maybeSingle();
    if (cfgErr) throw new Error(`Query comanda_local_settings: ${cfgErr.message}`);
    if (!cfg) {
      const { data: nuevo, error: insErr } = await svc
        .from("comanda_local_settings")
        .insert({
          tenant_id: tenantId,
          local_id: localId,
          slug: `mutante-reservas-${Date.now()}`,
          tienda_activa: true,
          reservas_activas: true,
          reservas_no_show_gracia_min: 30,
        })
        .select("id, slug, reservas_duracion_por_personas, reservas_duracion_estimada_min")
        .single();
      if (insErr) throw new Error(`Insert comanda_local_settings: ${insErr.message}`);
      settingsCreadoId = nuevo!.id as number;
      localSlug = nuevo!.slug as string;
      duracionTabla = (nuevo!.reservas_duracion_por_personas ?? []) as DuracionRegla[];
      duracionFallback = Number(nuevo!.reservas_duracion_estimada_min ?? 90);
    } else {
      localSlug = cfg.slug as string;
      duracionTabla = (cfg.reservas_duracion_por_personas ?? []) as DuracionRegla[];
      duracionFallback = Number(cfg.reservas_duracion_estimada_min ?? 90);
      settingsSnapshot = {
        reservas_activas: Boolean(cfg.reservas_activas),
        reservas_no_show_gracia_min: Number(cfg.reservas_no_show_gracia_min ?? 30),
      };
      if (!settingsSnapshot.reservas_activas || settingsSnapshot.reservas_no_show_gracia_min !== 30) {
        const { error: updErr } = await svc
          .from("comanda_local_settings")
          .update({ reservas_activas: true, reservas_no_show_gracia_min: 30 })
          .eq("id", cfg.id as number);
        if (updErr) throw new Error(`Update comanda_local_settings: ${updErr.message}`);
      }
    }

    // ── Canal mostrador del tenant (seed estándar) ──
    const { data: canales } = await db
      .from("canales")
      .select("id")
      .eq("slug", "mostrador")
      .eq("tenant_id", tenantId)
      .limit(1);
    if (!canales || canales.length === 0) {
      throw new Error(`Falta canal slug='mostrador' para tenant ${tenantId}.`);
    }
    canalId = canales[0]!.id as number;

    // ── Cajero POS activo (lo exigen abrir turno + cobrar) ──
    const { data: cajeros } = await db
      .from("rrhh_empleados")
      .select("id")
      .eq("local_id", localId)
      .eq("pos_activo", true)
      .limit(1);
    if (!cajeros || cajeros.length === 0) {
      throw new Error(`Sin empleado POS activo en "${LOCAL}" — asignar PIN POS desde RRHH.`);
    }
    cajeroId = cajeros[0]!.id as string;

    // ── Manager POS para anular en cleanup (fallback: UPDATE directo) ──
    const { data: mgrs } = await db
      .from("rrhh_empleados")
      .select("id")
      .eq("local_id", localId)
      .in("rol_pos", ["manager", "dueno"])
      .eq("pos_activo", true)
      .limit(1);
    managerId = mgrs && mgrs.length > 0 ? (mgrs[0]!.id as string) : null;

    // ── Turno de caja: reusar el abierto si hay; si no, abrir uno ──
    const { data: turnoExist } = await db
      .from("turnos_caja")
      .select("id")
      .eq("local_id", localId)
      .eq("estado", "abierto")
      .order("id", { ascending: false })
      .limit(1);
    if (turnoExist && turnoExist.length > 0) {
      turnoId = turnoExist[0]!.id as number;
    } else {
      const { data: t, error: te } = await db.rpc("fn_abrir_turno_caja_comanda", {
        p_local_id: localId,
        p_cajero_id: cajeroId,
        p_monto_inicial: 0,
        p_notas: "mutante modelo reservas v3",
        p_idempotency_key: idem("turno"),
      });
      if (te) throw new Error(`fn_abrir_turno_caja_comanda: ${te.message}`);
      turnoId = Number(t);
      turnoAbiertoPorTest = true;
    }

    // ── Mesa dedicada (libre, sin ventas ni reservas previas) ──
    const { data: mesa, error: mesaErr } = await svc
      .from("mesas")
      .insert({
        tenant_id: tenantId,
        local_id: localId,
        numero: `RSV-${Date.now()}`,
        capacidad: 4,
        estado: "libre",
      })
      .select("id")
      .single();
    if (mesaErr) throw new Error(`Insert mesa de prueba: ${mesaErr.message}`);
    mesaId = mesa!.id as number;
  });

  test.afterEach(async () => {
    const now = new Date().toISOString();

    // 1) Ventas: anular cobradas (revierte proyección del puente) + soft-delete.
    for (const vid of createdVentaIds) {
      try {
        const { data: vRow } = await db
          .from("ventas_pos")
          .select("estado, deleted_at")
          .eq("id", vid)
          .maybeSingle();
        if (vRow && !vRow.deleted_at && vRow.estado === "cobrada") {
          if (managerId) {
            const { error } = await db.rpc("fn_anular_venta_comanda", {
              p_venta_id: vid,
              p_manager_id: managerId,
              p_motivo: "mutante reservas: cleanup",
              p_idempotency_key: idem(`anular-${vid}`),
            });
            if (error) throw new Error(`fn_anular_venta_comanda(${vid}): ${error.message}`);
          } else {
            await db
              .from("ventas_pos")
              .update({ estado: "anulada", anulada_at: now })
              .eq("id", vid);
          }
        }
      } catch (e) {
        console.error(`[cleanup] anular venta ${vid}:`, e);
      }
      try {
        await db.from("ventas_pos_items").update({ deleted_at: now }).eq("venta_id", vid);
      } catch (e) {
        console.error(`[cleanup] items venta ${vid}:`, e);
      }
      try {
        await db.from("ventas_pos_pagos").update({ deleted_at: now }).eq("venta_id", vid);
      } catch (e) {
        console.error(`[cleanup] pagos venta ${vid}:`, e);
      }
      try {
        await db.from("movimientos_caja").delete().eq("venta_id", vid);
      } catch (e) {
        console.error(`[cleanup] movimientos_caja venta ${vid}:`, e);
      }
      try {
        await db.from("ventas_pos").update({ deleted_at: now, estado: "anulada" }).eq("id", vid);
      } catch (e) {
        console.error(`[cleanup] soft-delete venta ${vid}:`, e);
      }
      try {
        await db.from("ventas_pos_proyecciones").delete().eq("venta_id", vid);
      } catch (e) {
        console.error(`[cleanup] proyeccion venta ${vid}:`, e);
      }
    }

    // 2) Filas `ventas` origen='comanda' remanentes del local de prueba
    //    (el reverso de anular debería dejarlas en 0 y borrarlas — defensivo).
    try {
      const { data: rem } = await db
        .from("ventas")
        .select("id")
        .eq("local_id", localId)
        .eq("origen", "comanda");
      if (rem && rem.length > 0) {
        console.warn(`[cleanup] ${rem.length} filas ventas origen=comanda remanentes — borrando`);
        await db.from("ventas").delete().eq("local_id", localId).eq("origen", "comanda");
      }
    } catch (e) {
      console.error("[cleanup] ventas remanentes:", e);
    }

    // 3) Overrides de auditoría de las anulaciones de este run.
    try {
      await db.from("ventas_pos_overrides").delete().like("idempotency_key", `${RUN}%`);
    } catch (e) {
      console.error("[cleanup] overrides:", e);
    }

    // 4) Reservas de test: soft-delete.
    for (const rid of createdReservaIds) {
      try {
        await db.from("reservas").update({ deleted_at: now }).eq("id", rid);
      } catch (e) {
        console.error(`[cleanup] reserva ${rid}:`, e);
      }
    }

    // 5) Cliente creado por el upsert (solo si lo creó este test: el nombre
    //    sentinel solo se setea al INSERT, nunca pisa un cliente existente).
    try {
      await svc
        .from("clientes")
        .update({ deleted_at: now })
        .eq("tenant_id", tenantId)
        .like("nombre", `${SENTINEL}%`)
        .is("deleted_at", null);
    } catch (e) {
      console.error("[cleanup] cliente sentinel:", e);
    }

    // 6) Mesa dedicada: soft-delete (hard delete chocaría con FKs de ventas_pos).
    if (mesaId) {
      try {
        await svc.from("mesas").update({ deleted_at: now }).eq("id", mesaId);
      } catch (e) {
        console.error(`[cleanup] mesa ${mesaId}:`, e);
      }
    }

    // 7) Config del local: borrar si la creó el test, restaurar si la tocó.
    try {
      if (settingsCreadoId) {
        await svc.from("comanda_local_settings").delete().eq("id", settingsCreadoId);
      } else if (
        settingsSnapshot &&
        (!settingsSnapshot.reservas_activas || settingsSnapshot.reservas_no_show_gracia_min !== 30)
      ) {
        await svc
          .from("comanda_local_settings")
          .update({
            reservas_activas: settingsSnapshot.reservas_activas,
            reservas_no_show_gracia_min: settingsSnapshot.reservas_no_show_gracia_min,
          })
          .eq("local_id", localId)
          .is("deleted_at", null);
      }
    } catch (e) {
      console.error("[cleanup] comanda_local_settings:", e);
    }

    // 8) Cerrar el turno SOLO si lo abrió este test.
    if (turnoAbiertoPorTest && turnoId) {
      try {
        const { error } = await db.rpc("fn_cerrar_turno_caja_comanda", {
          p_turno_id: turnoId,
          p_cerrado_por: cajeroId,
          p_monto_final_declarado: 0,
          p_notas: "cierre mutante reservas",
          p_idempotency_key: idem("cierre-turno"),
        });
        if (error) console.error(`[cleanup] cerrar turno ${turnoId}: ${error.message}`);
      } catch (e) {
        console.error(`[cleanup] cerrar turno ${turnoId}:`, e);
      }
    }

    try {
      await db.auth.signOut();
    } catch {
      /* idempotente */
    }
  });

  test("MUTANTE: cliente normalizado + sentada/alias + link venta + auto-finalizar + no-show + disponibilidad", async () => {
    // ════ 1. Crear con teléfono → cliente_id + duracion_min default ════
    const reservaA = await crearReserva(`${SENTINEL} titular`, {
      p_cliente_telefono: TEL_FORMATO_INTL,
      p_personas: 2,
    });
    const rA = await getReserva(reservaA);
    expect(rA.estado).toBe("pendiente");
    expect(rA.cliente_id, "fn_crear_reserva con teléfono debe upsertear cliente").not.toBeNull();
    expect(rA.duracion_min, "duracion_min debe setearse con el default por personas").toBe(
      duracionEsperada(2),
    );

    // Segunda reserva con el MISMO número en formato local → mismo cliente.
    const reservaB = await crearReserva(`${SENTINEL} repetido`, {
      p_cliente_telefono: TEL_FORMATO_LOCAL,
      p_fecha_hora: enMinutos(38 * 60), // +38h: no solapa con los slots de la fase 6
      p_personas: 2,
    });
    const rB = await getReserva(reservaB);
    expect(
      rB.cliente_id,
      `'${TEL_FORMATO_INTL}' y '${TEL_FORMATO_LOCAL}' deben normalizar al mismo cliente`,
    ).toBe(rA.cliente_id);

    // duracion default escala por grupo (4 personas en otro horario lejano).
    const reservaGrupo = await crearReserva(`${SENTINEL} grupo`, {
      p_fecha_hora: enMinutos(40 * 60),
      p_personas: 4,
    });
    expect((await getReserva(reservaGrupo)).duracion_min).toBe(duracionEsperada(4));

    // ════ 2. confirmar → sentar con mesa · alias 'cumplida' → 'sentada' ════
    const { error: eConf } = await cambiarEstado(reservaA, "confirmada");
    expect(eConf).toBeNull();
    expect((await getReserva(reservaA)).confirmada_at).not.toBeNull();

    const { error: eSentar } = await cambiarEstado(reservaA, "sentada", mesaId!);
    expect(eSentar).toBeNull();
    const rASentada = await getReserva(reservaA);
    expect(rASentada.estado).toBe("sentada");
    expect(rASentada.sentada_at).not.toBeNull();
    expect(rASentada.mesa_id).toBe(mesaId);
    expect(rASentada.venta_id, "sin venta abierta en la mesa, no hay auto-link todavía").toBeNull();

    // Compat: bundle viejo manda 'cumplida' → debe quedar 'sentada' (walk-in).
    const reservaC = await crearReserva(`${SENTINEL} walkin compat`);
    const { error: eAlias } = await cambiarEstado(reservaC, "cumplida");
    expect(eAlias, "alias 'cumplida' debe aceptarse (compat bundles viejos)").toBeNull();
    const rC = await getReserva(reservaC);
    expect(rC.estado, "'cumplida' ya no existe: el alias produce 'sentada'").toBe("sentada");
    expect(rC.sentada_at).not.toBeNull();

    // sentada NO es terminal pero solo va a finalizada.
    const { error: eInvalida } = await cambiarEstado(reservaC, "cancelada");
    expect(eInvalida).not.toBeNull();
    expect(eInvalida!.message).toContain("RESERVA_TRANSICION_INVALIDA");
    const { error: eFinalizar } = await cambiarEstado(reservaC, "finalizada");
    expect(eFinalizar).toBeNull();
    const rCFin = await getReserva(reservaC);
    expect(rCFin.estado).toBe("finalizada");
    expect(rCFin.finalizada_at).not.toBeNull();
    // finalizada es terminal.
    const { error: eTerminal } = await cambiarEstado(reservaC, "sentada");
    expect(eTerminal).not.toBeNull();
    expect(eTerminal!.message).toContain("RESERVA_TRANSICION_INVALIDA");

    // ════ 3. Abrir venta en la mesa → link inverso + cliente_id al ticket ════
    const { data: vRaw, error: eVenta } = await db.rpc("fn_abrir_venta_comanda", {
      p_local_id: localId,
      p_modo: "salon",
      p_canal_id: canalId,
      p_mesa_id: mesaId,
      p_cajero_id: cajeroId,
      p_covers: 2,
      p_origen: "pos",
      p_estado: "abierta",
    });
    if (eVenta) throw new Error(`fn_abrir_venta_comanda: ${eVenta.message}`);
    const ventaId = Number(vRaw);
    expect(ventaId).toBeGreaterThan(0);
    createdVentaIds.push(ventaId);

    const rALinked = await getReserva(reservaA);
    expect(rALinked.venta_id, "abrir venta en mesa con reserva sentada debe linkearla").toBe(ventaId);
    const { data: vRow } = await db
      .from("ventas_pos")
      .select("cliente_id, estado")
      .eq("id", ventaId)
      .single();
    expect(vRow!.cliente_id, "el cliente de la reserva debe copiarse al ticket").toBe(rA.cliente_id);

    // ════ 4. Cobrar la venta → trigger auto-finaliza la reserva ════
    const { data: items } = await db.from("items").select("id").eq("tenant_id", tenantId).limit(1);
    if (!items || items.length === 0) {
      throw new Error(`Falta al menos un item para tenant ${tenantId} (crear desde Catálogo).`);
    }
    // RPC offline: acepta p_precio_unitario (la online toma items.precio_madre
    // y no serviría para el sentinel) — mismo patrón que el mutante del puente.
    const { error: eItem } = await db.rpc("fn_agregar_item_comanda_offline", {
      p_venta_id: ventaId,
      p_venta_idempotency_uuid: null,
      p_item_id: items[0]!.id as number,
      p_cantidad: 1,
      p_precio_unitario: PRECIO_ITEM,
      p_idempotency_uuid: crypto.randomUUID(),
    });
    if (eItem) throw new Error(`fn_agregar_item_comanda_offline: ${eItem.message}`);

    const { data: vTotal } = await db.from("ventas_pos").select("total").eq("id", ventaId).single();
    const total = Number(vTotal!.total);
    const { error: eCobro } = await db.rpc("fn_cobrar_venta_comanda", {
      p_venta_id: ventaId,
      p_pagos: [{ metodo: "EFECTIVO", monto: total, idempotency_key: idem("pago") }],
      p_propina: 0,
      p_cobrado_por: cajeroId,
      p_idempotency_key: idem("cobro"),
    });
    if (eCobro) throw new Error(`fn_cobrar_venta_comanda: ${eCobro.message}`);

    const rAFinal = await getReserva(reservaA);
    expect(rAFinal.estado, "cobrar la venta linkeada debe auto-finalizar la reserva sentada").toBe(
      "finalizada",
    );
    expect(rAFinal.finalizada_at).not.toBeNull();
    expect(rAFinal.venta_id).toBe(ventaId);

    // Invariante puntual: ninguna reserva sentada del local con venta cobrada.
    const { data: sentadasConVenta } = await db
      .from("reservas")
      .select("id, venta_id")
      .eq("local_id", localId)
      .eq("estado", "sentada")
      .not("venta_id", "is", null)
      .is("deleted_at", null);
    for (const s of sentadasConVenta ?? []) {
      const { data: v } = await db
        .from("ventas_pos")
        .select("estado")
        .eq("id", s.venta_id as number)
        .maybeSingle();
      expect(
        v?.estado,
        `Reserva ${s.id} sigue 'sentada' con venta ${s.venta_id} cobrada — el trigger no corrió`,
      ).not.toBe("cobrada");
    }

    // ════ 5. Cron auto-no-show (service_role) ════
    // reservaB queda confirmada FUTURA (+38h) → no debe tocarse.
    const { error: eConfB } = await cambiarEstado(reservaB, "confirmada");
    expect(eConfB).toBeNull();

    // reserva D: confirmada y movida 2 horas al pasado (vía service client —
    // fn_crear_reserva rechaza FECHA_PASADA, el cron es quien debe marcarla).
    const reservaD = await crearReserva(`${SENTINEL} noshow`);
    const { error: eConfD } = await cambiarEstado(reservaD, "confirmada");
    expect(eConfD).toBeNull();
    const { error: eMover } = await svc
      .from("reservas")
      .update({ fecha_hora: new Date(Date.now() - 2 * 3600_000).toISOString() })
      .eq("id", reservaD);
    expect(eMover).toBeNull();

    // El cron NO es ejecutable por authenticated (GRANT solo service_role).
    const { error: eCronAuth } = await db.rpc("fn_cron_auto_no_show", {});
    expect(eCronAuth, "fn_cron_auto_no_show no debe ser ejecutable por authenticated").not.toBeNull();

    const { data: marcadas, error: eCron } = await svc.rpc("fn_cron_auto_no_show", {});
    if (eCron) throw new Error(`fn_cron_auto_no_show (service): ${eCron.message}`);
    expect(Number(marcadas)).toBeGreaterThanOrEqual(1);

    const rD = await getReserva(reservaD);
    expect(rD.estado, "confirmada pasada de gracia (30min) debe pasar a no_show").toBe("no_show");
    expect(rD.no_show_auto, "el cron marca no_show_auto=true para revisión").toBe(true);

    const rBPost = await getReserva(reservaB);
    expect(rBPost.estado, "confirmada FUTURA no debe tocarse").toBe("confirmada");
    expect(rBPost.no_show_auto).toBe(false);

    // ════ 6. Disponibilidad v2: sentada cuenta + solapamiento por duración ════
    const slotE = enMinutos(26 * 60); // +26h (≥ anticipación mínima, ≤ 30 días)
    const consultaSolapada = enMinutos(26 * 60 + 30); // dentro de [slotE, slotE+dur)
    const consultaLejana = enMinutos(32 * 60); // +32h: fuera del intervalo de E

    const baseSolapada = await disponibilidad(consultaSolapada, 2);
    const baseLejana = await disponibilidad(consultaLejana, 2);

    const reservaE = await crearReserva(`${SENTINEL} sentada solapa`, {
      p_fecha_hora: slotE,
      p_personas: 4,
    });
    const { error: eSentarE } = await cambiarEstado(reservaE, "sentada", undefined);
    expect(eSentarE).toBeNull();

    const postSolapada = await disponibilidad(consultaSolapada, 2);
    expect(
      postSolapada.personas_actuales,
      "una reserva SENTADA que solapa el horario debe contar en personas_actuales",
    ).toBe(baseSolapada.personas_actuales + 4);

    const postLejana = await disponibilidad(consultaLejana, 2);
    expect(
      postLejana.personas_actuales,
      "fuera de [fecha_hora, fecha_hora+duracion_min) la reserva NO debe contar",
    ).toBe(baseLejana.personas_actuales);
  });
});
