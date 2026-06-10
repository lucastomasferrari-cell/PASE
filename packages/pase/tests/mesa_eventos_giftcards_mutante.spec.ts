import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";
import { createServiceClient } from "./e2e-full/setup/seed-tenant";

// MESA módulo #4 — mutante de eventos con prepago + giftcards (09-jun).
// Migración 202606100600. Flujo de plata completo a nivel DB:
//
//   EVENTO: crear publicado → fn_eventos_publicos lo lista → inscripción
//   pública (monto SERVER-side) → cupos respetados (pendientes recientes
//   cuentan) → fn_confirmar_pago_evento (service_role: simula el webhook MP)
//   marca pagada + suma cupos (idempotente, valida monto).
//
//   GIFTCARD: catálogo → compra pública → confirmación genera CÓDIGO único →
//   fn_canjear_giftcard (staff) pagada→canjeada, doble canje rechazado.
//
// El tramo HTTP real (preference MP + webhook) se prueba con credenciales
// reales en smoke manual — acá se cubre toda la lógica de plata en DB.

const LOCAL = "Local Prueba 2";
const SLUG = "local-prueba-7";
const PRECIO_EVENTO = 15000;
const PRECIO_GIFT = 95000;

test.describe("MESA — eventos prepago + giftcards (mutante)", () => {
  let db: SupabaseClient;
  let svc: SupabaseClient;
  let localId: number;
  let tenantId: string;
  let eventoId: number | null = null;
  let giftcardId: number | null = null;

  function fechaFutura(): string {
    return new Date(Date.now() + 7 * 86400_000).toISOString();
  }

  test.beforeEach(async () => {
    db = await createDuenoClient();
    svc = createServiceClient();
    const { data: locales } = await db.from("locales").select("id, tenant_id").eq("nombre", LOCAL);
    if (!locales || locales.length !== 1) throw new Error(`Local "${LOCAL}" no único`);
    localId = locales[0]!.id as number;
    tenantId = locales[0]!.tenant_id as string;
  });

  test.afterEach(async () => {
    // Orden FK: inscripciones/compras → evento/giftcard. Cada paso chequea error.
    if (eventoId) {
      const { error: e1 } = await svc.from("evento_inscripciones").delete().eq("evento_id", eventoId);
      if (e1) console.error("[cleanup] inscripciones:", e1.message);
      const { error: e2 } = await svc.from("eventos").delete().eq("id", eventoId);
      if (e2) console.error("[cleanup] evento:", e2.message);
      eventoId = null;
    }
    if (giftcardId) {
      const { error: e3 } = await svc.from("giftcard_compras").delete().eq("giftcard_id", giftcardId);
      if (e3) console.error("[cleanup] compras:", e3.message);
      const { error: e4 } = await svc.from("giftcards").delete().eq("id", giftcardId);
      if (e4) console.error("[cleanup] giftcard:", e4.message);
      giftcardId = null;
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("evento: inscripción pública con monto server-side, cupos y confirmación idempotente", async () => {
    // Dueño crea evento PUBLICADO con 5 cupos.
    const { data: ev, error: evErr } = await db.from("eventos").insert({
      tenant_id: tenantId, local_id: localId,
      titulo: "MUTANTE Omakase test", descripcion: "test",
      fecha_inicio: fechaFutura(), precio_por_persona: PRECIO_EVENTO,
      cupos_total: 5, estado: "publicado",
    }).select("id").single();
    expect(evErr).toBeNull();
    eventoId = ev!.id as number;

    // Aparece en el listado público con los cupos.
    const { data: pub } = await db.rpc("fn_eventos_publicos", { p_local_slug: SLUG });
    const mio = (pub as Array<{ id: number; cupos_disponibles: number; precio_por_persona: number }>)
      .find(e => e.id === eventoId);
    expect(mio).toBeDefined();
    expect(Number(mio!.cupos_disponibles)).toBe(5);

    // Inscripción pública ×3 → monto = 3 × precio (SERVER-side, no viene del front).
    const { data: insc, error: iErr } = await db.rpc("fn_inscribir_evento_publico", {
      p_local_slug: SLUG, p_evento_id: eventoId,
      p_nombre: "Cliente Mutante", p_telefono: "1100000000", p_email: "mut@test.com",
      p_cantidad: 3, p_idempotency_key: `mut-ev-${eventoId}-a`,
    });
    expect(iErr).toBeNull();
    const inscA = insc as { inscripcion_id: number; monto_total: number };
    expect(Number(inscA.monto_total)).toBe(3 * PRECIO_EVENTO);

    // Cupos: quedan 5−3 pendientes = 2 → pedir 3 más debe fallar (los
    // pendientes recientes RESERVAN cupo durante el checkout).
    const { error: sinCupo } = await db.rpc("fn_inscribir_evento_publico", {
      p_local_slug: SLUG, p_evento_id: eventoId,
      p_nombre: "Otro", p_telefono: null, p_email: "otro@test.com",
      p_cantidad: 3, p_idempotency_key: `mut-ev-${eventoId}-b`,
    });
    expect(sinCupo).not.toBeNull();
    expect(sinCupo!.message).toContain("EVENTO_SIN_CUPOS");

    // Confirmación (simula webhook MP, service_role): monto ERRADO rechazado.
    const { error: mal } = await svc.rpc("fn_confirmar_pago_evento", {
      p_inscripcion_id: inscA.inscripcion_id, p_payment_id: "mp-test-1", p_monto: 999,
    });
    expect(mal).not.toBeNull();
    expect(mal!.message).toContain("MONTO_NO_COINCIDE");

    // Monto correcto → pagada + cupos_vendidos=3.
    const { error: okErr } = await svc.rpc("fn_confirmar_pago_evento", {
      p_inscripcion_id: inscA.inscripcion_id, p_payment_id: "mp-test-1",
      p_monto: 3 * PRECIO_EVENTO,
    });
    expect(okErr).toBeNull();
    const { data: evPost } = await svc.from("eventos").select("cupos_vendidos, estado").eq("id", eventoId).single();
    expect(Number(evPost!.cupos_vendidos)).toBe(3);

    // Re-confirmar (webhook duplicado de MP) → idempotente, NO suma cupos otra vez.
    const { data: dup, error: dupErr } = await svc.rpc("fn_confirmar_pago_evento", {
      p_inscripcion_id: inscA.inscripcion_id, p_payment_id: "mp-test-1",
      p_monto: 3 * PRECIO_EVENTO,
    });
    expect(dupErr).toBeNull();
    expect((dup as { ya_pagada?: boolean }).ya_pagada).toBe(true);
    const { data: evPost2 } = await svc.from("eventos").select("cupos_vendidos").eq("id", eventoId).single();
    expect(Number(evPost2!.cupos_vendidos)).toBe(3);

    // Las RPCs de confirmación NO son llamables por el público/staff (solo service_role).
    const { error: noPerm } = await db.rpc("fn_confirmar_pago_evento", {
      p_inscripcion_id: inscA.inscripcion_id, p_payment_id: "x", p_monto: 1,
    });
    expect(noPerm).not.toBeNull();
  });

  test("giftcard: compra pública → confirmación genera código → canje único en POS", async () => {
    const { data: g, error: gErr } = await db.from("giftcards").insert({
      tenant_id: tenantId, local_id: localId,
      nombre: "MUTANTE Dinner Card", descripcion: "test", precio: PRECIO_GIFT, activa: true,
    }).select("id").single();
    expect(gErr).toBeNull();
    giftcardId = g!.id as number;

    // Pública la lista.
    const { data: pub } = await db.rpc("fn_giftcards_publicas", { p_local_slug: SLUG });
    expect((pub as Array<{ id: number }>).some(x => x.id === giftcardId)).toBe(true);

    // Compra pública → pendiente, monto = precio del catálogo.
    const { data: compra, error: cErr } = await db.rpc("fn_comprar_giftcard_publica", {
      p_local_slug: SLUG, p_giftcard_id: giftcardId,
      p_comprador_nombre: "Regalador Mutante", p_comprador_email: "regalo@test.com",
      p_para_nombre: "Agasajado", p_mensaje: "feliz cumple",
      p_idempotency_key: `mut-gc-${giftcardId}`,
    });
    expect(cErr).toBeNull();
    const compraId = (compra as { compra_id: number; monto: number }).compra_id;
    expect(Number((compra as { monto: number }).monto)).toBe(PRECIO_GIFT);

    // Canjear ANTES de pagar → rechazado (no tiene código todavía, pero probamos por estado).
    // (sin código no se puede ni buscar — el código nace al pagar; assert post-pago)

    // Confirmar pago (service_role) → genera código GC-XXXXXXXX.
    const { data: conf, error: confErr } = await svc.rpc("fn_confirmar_pago_giftcard", {
      p_compra_id: compraId, p_payment_id: "mp-test-gc", p_monto: PRECIO_GIFT,
    });
    expect(confErr).toBeNull();
    const codigo = (conf as { codigo: string }).codigo;
    expect(codigo).toMatch(/^GC-[A-F0-9]{8}$/);

    // Canje por el staff (dueño) → canjeada, devuelve datos para mostrar.
    const { data: canje, error: kErr } = await db.rpc("fn_canjear_giftcard", { p_codigo: codigo });
    expect(kErr).toBeNull();
    expect((canje as { monto: number; giftcard: string }).giftcard).toBe("MUTANTE Dinner Card");
    expect(Number((canje as { monto: number }).monto)).toBe(PRECIO_GIFT);

    // Doble canje → rechazado.
    const { error: k2 } = await db.rpc("fn_canjear_giftcard", { p_codigo: codigo });
    expect(k2).not.toBeNull();
    expect(k2!.message).toContain("GIFTCARD_YA_CANJEADA");

    // Código inventado → rechazado.
    const { error: k3 } = await db.rpc("fn_canjear_giftcard", { p_codigo: "GC-NOEXISTE" });
    expect(k3).not.toBeNull();
    expect(k3!.message).toContain("GIFTCARD_CODIGO_INVALIDO");
  });
});
