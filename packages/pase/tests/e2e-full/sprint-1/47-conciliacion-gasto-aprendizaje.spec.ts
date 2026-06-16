// ─────────────────────────────────────────────────────────────────────────
// E2E Test 47 — CONCILIACIÓN: crear gasto desde fila + aprendizaje de impuesto
//
// Cubre el flujo nuevo (jun-2026) de ConciliacionExtracto contra el tenant E2E
// compartido (DB-only):
//
//   [0] Un titular nunca visto NO es "conocido".
//   [1] crear_gasto robusto: categoría desconocida + etiqueta "Otros" → tipo
//       'variable' (antes la etiqueta cruda violaba gastos_tipo_check — bug Anto,
//       migración 202606161200).
//   [2] crear_gasto con etiqueta "Impuesto" → enum 'impuesto'; + fn_aprender_
//       gasto_alias aprende el titular → categoría (lo que hace crearGastoDeFila
//       al crear un gasto desde una fila roja).
//   [3] fn_clasificar_gastos_conocidos: ahora ese titular se reconoce como gasto
//       conocido con su categoría (alimenta el botón de un clic / "Crear N
//       conocidos"). Migración 202606161300.
//   [4] INVARIANTE: el titular nunca visto sigue SIN aparecer como conocido.
//
// Período aislado (2031-02) + sentinel propio. El tenant E2E se destruye en
// global-teardown; igual se limpia gastos/movs/alias en afterAll.
// ─────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createE2EDuenoClient } from "../setup/seed-tenant";
import { loadSharedSeed } from "../setup/shared-seed";

const SENT = "ZZE2ECONCIL47";
const DESC_IMPUESTO = `Impuesto por extraccion ${SENT}`;
const DESC_OTROS = `Gasto raro ${SENT}`;
const DESC_DESCONOCIDO = `Titular jamas visto ${SENT}`;
const CAT_IMP = "__CAT_IMP_E2E_47__"; // fuera de config → fuerza el fallback por etiqueta
const CAT_OTROS = "__CAT_OTROS_E2E_47__";
const CUENTA = "MercadoPago";

test.describe.serial("E2E Test 47 — CONCILIACIÓN: crear gasto desde fila + aprendizaje", () => {
  let duenoDb: SupabaseClient;
  let localId: number;
  const movIds: string[] = [];
  const gastoIds: string[] = [];

  test.beforeAll(async () => {
    const seed = loadSharedSeed();
    localId = seed.local1Id;
    duenoDb = await createE2EDuenoClient();
  });

  test.afterAll(async () => {
    for (const id of movIds) {
      await duenoDb.rpc("anular_movimiento", { p_mov_id: id, p_motivo: "e2e 47 cleanup" }).then(() => {}, () => {});
      await duenoDb.from("movimientos").delete().eq("id", id).then(() => {}, () => {});
    }
    for (const id of gastoIds) {
      await duenoDb.from("gastos").delete().eq("id", id).then(() => {}, () => {});
    }
    await duenoDb.from("conciliacion_alias").delete()
      .eq("local_id", localId).ilike("titular", `%${SENT}%`).then(() => {}, () => {});
    try { await duenoDb.auth.signOut(); } catch { /* */ }
  });

  test("crear_gasto robusto + aprende titular → próxima vez es 'conocido'", async () => {
    // [0] Pre: el titular del impuesto NO es conocido todavía.
    const { data: pre, error: preErr } = await duenoDb.rpc("fn_clasificar_gastos_conocidos", {
      p_local_id: localId, p_descripciones: [DESC_IMPUESTO],
    });
    expect(preErr).toBeNull();
    expect((pre as unknown[]).length).toBe(0);

    // [1] crear_gasto robusto: categoría desconocida + etiqueta "Otros" → 'variable'.
    const { data: gOtros, error: eOtros } = await duenoDb.rpc("crear_gasto", {
      p_fecha: "2031-02-05", p_local_id: localId, p_categoria: CAT_OTROS,
      p_tipo: "Otros", p_monto: 1234.56, p_detalle: DESC_OTROS, p_cuenta: CUENTA,
      p_plantilla_id: null, p_idempotency_key: null,
    });
    expect(eOtros).toBeNull();
    expect((gOtros as { tipo: string }).tipo).toBe("variable");
    gastoIds.push((gOtros as { gasto_id: string }).gasto_id);
    movIds.push((gOtros as { mov_id: string }).mov_id);

    // [2] Crear el impuesto (etiqueta "Impuesto" → enum 'impuesto') + aprender
    //     el titular — exactamente lo que hace crearGastoDeFila en la UI.
    const { data: gImp, error: eImp } = await duenoDb.rpc("crear_gasto", {
      p_fecha: "2031-02-06", p_local_id: localId, p_categoria: CAT_IMP,
      p_tipo: "Impuesto", p_monto: 789.01, p_detalle: DESC_IMPUESTO, p_cuenta: CUENTA,
      p_plantilla_id: null, p_idempotency_key: null,
    });
    expect(eImp).toBeNull();
    expect((gImp as { tipo: string }).tipo).toBe("impuesto");
    gastoIds.push((gImp as { gasto_id: string }).gasto_id);
    movIds.push((gImp as { mov_id: string }).mov_id);

    const { error: aprErr } = await duenoDb.rpc("fn_aprender_gasto_alias", {
      p_local_id: localId, p_descripcion: DESC_IMPUESTO, p_categoria: CAT_IMP, p_tipo: "Impuesto",
    });
    expect(aprErr).toBeNull();

    // [3] Ahora el titular ES conocido y trae su categoría aprendida.
    const { data: post, error: postErr } = await duenoDb.rpc("fn_clasificar_gastos_conocidos", {
      p_local_id: localId, p_descripciones: [DESC_IMPUESTO, DESC_DESCONOCIDO],
    });
    expect(postErr).toBeNull();
    const conocidos = post as { descripcion: string; categoria: string; tipo: string }[];
    const hit = conocidos.find((c) => c.descripcion === DESC_IMPUESTO);
    expect(hit).toBeTruthy();
    expect(hit!.categoria).toBe(CAT_IMP);
    expect(hit!.tipo).toBe("Impuesto");

    // [4] INVARIANTE: el titular nunca visto sigue sin aparecer.
    expect(conocidos.find((c) => c.descripcion === DESC_DESCONOCIDO)).toBeUndefined();
  });
});
