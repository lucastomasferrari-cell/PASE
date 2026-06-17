import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: carga un gasto desde la UI contra prod (RPC atómica
// crear_gasto), verifica los 3 efectos en DB (gastos + movimientos +
// saldos_caja con resta exacta del sentinel). Cleanup híbrido: anular el
// movimiento (la única RPC que revierte saldo atómicamente) y después
// borrar las dos filas residuales para no dejar el sentinel en la tabla.
const SENTINEL = 234567.89;
const LOCAL = "Local Prueba 2";
const CUENTA = "Caja Efectivo";
const CATEGORIA = "OTROS FIJOS";
const TIPO_ESPERADO = "fijo";
const TIPO_MOV_ESPERADO = "Gasto fijo";

test.describe("Gastos — mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let saldoInicial: number;
  let gastoId: string | null = null;
  let movId: string | null = null;

  test.beforeEach(async ({ page }) => {
    db = await createDuenoClient();

    // Resolver local_id + tenant_id de "Local Prueba 2".
    const { data: locales, error: locErr } = await db
      .from("locales")
      .select("id, nombre, tenant_id")
      .eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    if (locales.length > 1) throw new Error(`Hay ${locales.length} locales con nombre "${LOCAL}" — desambiguar`);
    localId = locales[0].id as number;
    const tenantId = locales[0].tenant_id as string;

    // Pre-check explícito: la fila (cuenta="Caja Efectivo", local_id) DEBE
    // existir en saldos_caja. crear_gasto no la crea, solo actualiza — sin
    // ella el saldo nunca cambia y el assert final fallaría con un
    // diagnóstico confuso. Mejor frenar acá con un mensaje accionable.
    const { data: saldoRow, error: saldoErr } = await db
      .from("saldos_caja")
      .select("saldo")
      .eq("cuenta", CUENTA)
      .eq("local_id", localId)
      .maybeSingle();
    if (saldoErr) throw new Error(`Error leyendo saldos_caja: ${saldoErr.message}`);
    if (saldoRow == null) {
      throw new Error(
        `Falta fila en saldos_caja para (cuenta="${CUENTA}", local_id=${localId}). ` +
        `Crear con:\n` +
        `INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id) ` +
        `VALUES ('${CUENTA}', ${localId}, 0, '${tenantId}');`
      );
    }
    saldoInicial = saldoRow.saldo as number;

    gastoId = null;
    movId = null;

    await loginAs(page, "dueno", { local: LOCAL });
  });

  test.afterEach(async () => {
    // Cada paso en su propio try/catch — un fallo en uno no debe abortar
    // los siguientes. Querés que se intente borrar todo lo creado.
    if (movId) {
      try {
        const { error } = await db.rpc("anular_movimiento", {
          p_mov_id: movId,
          p_motivo: "e2e mutante cleanup",
        });
        if (error && !error.message.includes("YA_ANULADO")) {
           
          console.error(`[cleanup] anular_movimiento(${movId}): ${error.message}`);
        }
      } catch (e) {
         
        console.error(`[cleanup] anular_movimiento threw:`, e);
      }
    }
    if (movId) {
      try {
        const { error } = await db.from("movimientos").delete().eq("id", movId);
        if (error) {
           
          console.error(`[cleanup] delete movimientos(${movId}): ${error.message}`);
        }
      } catch (e) {
         
        console.error(`[cleanup] delete movimientos threw:`, e);
      }
    }
    if (gastoId) {
      try {
        const { error } = await db.from("gastos").delete().eq("id", gastoId);
        if (error) {
           
          console.error(`[cleanup] delete gastos(${gastoId}): ${error.message}`);
        }
      } catch (e) {
         
        console.error(`[cleanup] delete gastos threw:`, e);
      }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("cargar gasto crea gasto + movimiento + resta del saldo", async ({ page }) => {
    await goTo(page, "Gastos");

    await page.getByRole("button", { name: "+ Cargar Gasto" }).click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });

    const modal = page.locator(".overlay .modal");

    // Tipo: queda en default "fijo" (lo que dispara catsByTipo("fijo")).
    // Categoría: "OTROS FIJOS" — neutral, no es un costo recurrente real.
    await modal.locator('.field:has(label:has-text("Categoría")) select')
      .selectOption({ label: CATEGORIA });

    // Local — el dueño ve un select con "Todos" + locales disponibles.
    await modal.locator('.field:has(label:has-text("Local")) select')
      .selectOption({ label: LOCAL });

    // Fecha: default hoy. Sin cambios.

    // Cuenta de egreso (label tiene asterisco — match parcial).
    await modal.locator('.field:has(label:has-text("Cuenta de egreso")) select')
      .selectOption({ label: CUENTA });

    // Monto.
    await modal.locator('.field:has(label:has-text("Monto")) input')
      .fill(String(SENTINEL));

    await modal.getByRole("button", { name: "Guardar" }).click();
    await expect(page.locator(".overlay")).not.toBeVisible({ timeout: 10_000 });

    // ── Assert 1: el gasto existe en DB con sentinel ─────────────────────
    const { data: gastos, error: gastosErr } = await db
      .from("gastos")
      .select("id, local_id, monto, categoria, tipo, cuenta")
      .eq("local_id", localId)
      .eq("monto", SENTINEL);
    expect(gastosErr).toBeNull();
    expect(gastos?.length).toBe(1);
    expect(gastos?.[0]?.categoria).toBe(CATEGORIA);
    expect(gastos?.[0]?.tipo).toBe(TIPO_ESPERADO);
    expect(gastos?.[0]?.cuenta).toBe(CUENTA);
    gastoId = gastos![0]!.id as string;

    // ── Assert 2: el movimiento asociado existe (importe negativo) ───────
    const { data: movs, error: movsErr } = await db
      .from("movimientos")
      .select("id, cuenta, local_id, importe, tipo, cat, gasto_id_ref")
      .eq("gasto_id_ref", gastoId);
    expect(movsErr).toBeNull();
    expect(movs?.length).toBe(1);
    expect(movs?.[0]?.importe).toBe(-SENTINEL);
    expect(movs?.[0]?.cuenta).toBe(CUENTA);
    expect(movs?.[0]?.local_id).toBe(localId);
    expect(movs?.[0]?.tipo).toBe(TIPO_MOV_ESPERADO);
    expect(movs?.[0]?.cat).toBe(CATEGORIA);
    movId = movs![0]!.id as string;

    // ── Assert 3: el saldo bajó por SENTINEL exacto ──────────────────────
    const { data: saldoFinal, error: saldoFinalErr } = await db
      .from("saldos_caja")
      .select("saldo")
      .eq("cuenta", CUENTA)
      .eq("local_id", localId)
      .maybeSingle();
    expect(saldoFinalErr).toBeNull();
    expect(saldoFinal?.saldo).toBe(saldoInicial - SENTINEL);
  });

  // ── Test mutante #2: idempotency (F8). DB-only. ─────────────────────────
  // crear_gasto acepta p_idempotency_key. 2da llamada con misma key devuelve
  // el resultado original sin crear gasto/movimiento/saldo adicionales.
  test("crear_gasto con idempotency_key: 2da llamada no duplica efectos", async () => {
    const idempKey = `test-gasto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const SENTINEL_IDEM = 234001.23; // distinto del test #1 para no colisionar

    const { data: r1, error: e1 } = await db.rpc("crear_gasto", {
      p_fecha: new Date().toISOString().slice(0, 10),
      p_local_id: localId,
      p_categoria: CATEGORIA,
      p_tipo: "fijo",
      p_monto: SENTINEL_IDEM,
      p_detalle: "e2e idempotency",
      p_cuenta: CUENTA,
      p_plantilla_id: null,
      p_idempotency_key: idempKey,
    });
    expect(e1).toBeNull();
    gastoId = (r1 as { gasto_id: string }).gasto_id;
    movId = (r1 as { mov_id: string }).mov_id;

    const saldoTrasUno = (await db.from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle()).data?.saldo;

    const { data: r2, error: e2 } = await db.rpc("crear_gasto", {
      p_fecha: new Date().toISOString().slice(0, 10),
      p_local_id: localId,
      p_categoria: CATEGORIA,
      p_tipo: "fijo",
      p_monto: SENTINEL_IDEM,
      p_detalle: "e2e idempotency",
      p_cuenta: CUENTA,
      p_plantilla_id: null,
      p_idempotency_key: idempKey,
    });
    expect(e2).toBeNull();
    expect((r2 as { idempotent_replay?: boolean }).idempotent_replay).toBe(true);
    expect((r2 as { gasto_id: string }).gasto_id).toBe(gastoId);
    expect((r2 as { mov_id: string }).mov_id).toBe(movId);

    // No se creó otro gasto/movimiento.
    const { data: gastosAfter } = await db.from("gastos").select("id")
      .eq("monto", SENTINEL_IDEM).eq("local_id", localId);
    expect(gastosAfter?.length).toBe(1);
    const { data: movsAfter } = await db.from("movimientos").select("id")
      .eq("gasto_id_ref", gastoId);
    expect(movsAfter?.length).toBe(1);

    // Saldo no cambió tras la 2da llamada (replay no impacta).
    const saldoTrasDos = (await db.from("saldos_caja").select("saldo")
      .eq("cuenta", CUENTA).eq("local_id", localId).maybeSingle()).data?.saldo;
    expect(saldoTrasDos).toBe(saldoTrasUno);
  });

  // ── Test mutante #3: robustez del tipo (bug Anto jun-2026). ─────────────
  // crear_gasto traducía el tipo SOLO por el grupo de la categoría; si la
  // categoría no matcheaba config_categorias, metía la etiqueta cruda
  // ("Otros") en gastos.tipo y violaba gastos_tipo_check. Ahora la etiqueta
  // se normaliza a un valor del enum ("Otros" → 'variable').
  test("crear_gasto: etiqueta 'Otros' + categoría desconocida cae a 'variable' (no viola el check)", async () => {
    const SENTINEL_OTROS = 234002.34;
    const { data, error } = await db.rpc("crear_gasto", {
      p_fecha: new Date().toISOString().slice(0, 10),
      p_local_id: localId,
      p_categoria: "__CAT_INEXISTENTE_MUTANTE__", // fuerza el fallback por etiqueta
      p_tipo: "Otros",
      p_monto: SENTINEL_OTROS,
      p_detalle: "e2e tipo robusto",
      p_cuenta: CUENTA,
      p_plantilla_id: null,
      p_idempotency_key: null,
    });
    expect(error).toBeNull();
    gastoId = (data as { gasto_id: string }).gasto_id;
    movId = (data as { mov_id: string }).mov_id;
    expect((data as { tipo: string }).tipo).toBe("variable");

    const { data: g } = await db.from("gastos").select("tipo").eq("id", gastoId).single();
    expect(g?.tipo).toBe("variable"); // valor válido del enum, no la etiqueta cruda
  });

  // ── Test mutante #4: tipo irreconocible → error claro, no "violates check".
  test("crear_gasto: tipo irreconocible tira TIPO_GASTO_INVALIDO (no error crudo de Postgres)", async () => {
    const { error } = await db.rpc("crear_gasto", {
      p_fecha: new Date().toISOString().slice(0, 10),
      p_local_id: localId,
      p_categoria: "__CAT_INEXISTENTE_MUTANTE__",
      p_tipo: "zzz-no-existe",
      p_monto: 234003.45,
      p_detalle: "e2e tipo invalido",
      p_cuenta: CUENTA,
      p_plantilla_id: null,
      p_idempotency_key: null,
    });
    // Falla antes de insertar nada → sin cleanup (gastoId/movId quedan null).
    expect(error).not.toBeNull();
    expect(error?.message).toContain("TIPO_GASTO_INVALIDO");
  });

  // ── Test mutante #5: tipo nuevo 'mano_obra' (Costo Laboral suelto). ──────
  // Etiqueta "Mano de Obra" → enum 'mano_obra'; el EERR lo suma a Costo Laboral
  // (no pide empleado registrado, a diferencia de 'empleado'). Lucas 16-jun.
  test("crear_gasto: etiqueta 'Mano de Obra' → tipo 'mano_obra' (no viola el check)", async () => {
    const SENTINEL_MO = 234004.56;
    const { data, error } = await db.rpc("crear_gasto", {
      p_fecha: new Date().toISOString().slice(0, 10),
      p_local_id: localId,
      p_categoria: "__CAT_MANOBRA_MUTANTE__", // fuerza fallback por etiqueta
      p_tipo: "Mano de Obra",
      p_monto: SENTINEL_MO,
      p_detalle: "e2e mano de obra",
      p_cuenta: CUENTA,
      p_plantilla_id: null,
      p_idempotency_key: null,
    });
    expect(error).toBeNull();
    gastoId = (data as { gasto_id: string }).gasto_id;
    movId = (data as { mov_id: string }).mov_id;
    expect((data as { tipo: string }).tipo).toBe("mano_obra");

    const { data: g } = await db.from("gastos").select("tipo").eq("id", gastoId).single();
    expect(g?.tipo).toBe("mano_obra");
  });
});
