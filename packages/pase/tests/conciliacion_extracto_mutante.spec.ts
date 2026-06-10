import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: RPC fn_cruzar_extracto_mp (Lucas 10-jun, módulo nuevo
// "Conciliación").
//
// Cubre la regla de matching central del módulo:
//   - Monto EXACTO (al centavo) — bloqueante para verde/amarillo
//   - Fecha en ventana ±15 días desde la fecha del extracto
//   - Semáforo: verde (1 match), amarillo (>1), rojo_falta (0), rojo_sobra
//
// El test crea movimientos sentinel en Local Prueba 2 con sentinel monto
// distintivo ($SENTINEL_MONTO), llama la RPC con un "extracto" sintético
// armado en memoria, y valida los conteos del semáforo.
//
// Patrón: usa Local Prueba 2 + sentinel monto fuera de rango productivo
// (87_654.32). Cleanup idempotente al final.

const LOCAL = "Local Prueba 2";
const SENTINEL_MATCH = 87654.32;       // mov que matchea con extracto
const SENTINEL_SOBRA = 12345.67;       // mov que sobra en PASE
const PERIODO_DESDE = "2099-04-01";    // fuera de rango productivo
const PERIODO_HASTA = "2099-04-30";

test.describe("Conciliación extracto MP — fn_cruzar_extracto_mp mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  const movIdsCreated: string[] = [];

  test.beforeAll(async () => {
    db = await createDuenoClient();
    const { data: locales, error } = await db
      .from("locales").select("id").eq("nombre", LOCAL);
    if (error) throw new Error(`Error consultando locales: ${error.message}`);
    if (!locales || locales.length === 0) throw new Error(`Falta seed "${LOCAL}"`);
    localId = locales[0]!.id as number;
  });

  test.afterAll(async () => {
    if (!db) return;
    // Cleanup sentinels (idempotente — corre incluso si test falló).
    for (const id of movIdsCreated) {
      try {
        // eslint-disable-next-line pase-local/no-direct-financiera-write -- cleanup test
        await db.from("movimientos").delete().eq("id", id);
      } catch { /* ignore */ }
    }
    // Cleanup corridas test (las que pudieron quedar)
    try {
      await db.from("conciliacion_corridas")
        .delete()
        .eq("local_id", localId)
        .gte("periodo_desde", PERIODO_DESDE)
        .lte("periodo_hasta", PERIODO_HASTA);
    } catch { /* ignore */ }
  });

  test("verde: 1 mov del extracto matchea con 1 mov en PASE (mismo monto, fecha en ±15d)", async () => {
    // Crear 1 mov en PASE con monto SENTINEL_MATCH, fecha 15-abr-2099
    const { data: created, error: cErr } = await db.rpc("crear_movimiento_caja", {
      p_fecha: "2099-04-15",
      p_cuenta: "MercadoPago",
      p_tipo: "Ingreso Manual",
      p_cat: null,
      p_importe: SENTINEL_MATCH,
      p_detalle: "TEST-CONCIL-VERDE",
      p_local_id: localId,
    });
    if (cErr) throw new Error(`No se pudo crear mov: ${cErr.message}`);
    // Recuperar el id del mov recién creado (la RPC no lo retorna directo).
    const { data: movs } = await db.from("movimientos")
      .select("id")
      .eq("local_id", localId)
      .eq("cuenta", "MercadoPago")
      .eq("importe", SENTINEL_MATCH)
      .eq("detalle", "TEST-CONCIL-VERDE")
      .limit(1);
    expect(movs && movs.length).toBe(1);
    movIdsCreated.push(movs![0]!.id as string);

    // Llamar RPC con extracto de 1 línea: misma fecha + monto
    const { data, error } = await db.rpc("fn_cruzar_extracto_mp", {
      p_local_id: localId,
      p_periodo_desde: PERIODO_DESDE,
      p_periodo_hasta: PERIODO_HASTA,
      p_movs_extracto: [
        { fecha: "2099-04-15", monto: SENTINEL_MATCH, descripcion: "test verde", referencia_externa: null },
      ],
    });
    if (error) throw new Error(`RPC falló: ${error.message}`);
    const res = data as {
      totales: { verdes: number; amarillos: number; rojos_falta: number; rojos_sobra: number; extracto_total: number };
      extracto: Array<{ estado: string; num_candidatos: number }>;
    };
    // Debe quedar verde: 1 candidato, 0 faltas, 0 sobrantes
    expect(res.totales.extracto_total).toBe(1);
    expect(res.totales.verdes).toBe(1);
    expect(res.totales.amarillos).toBe(0);
    expect(res.totales.rojos_falta).toBe(0);
    expect(res.totales.rojos_sobra).toBe(0);
    expect(res.extracto[0]!.estado).toBe("verde");
    expect(res.extracto[0]!.num_candidatos).toBe(1);
  });

  test("amarillo: extracto tiene 1 mov, PASE tiene 2 movs con mismo monto en ventana", async () => {
    // Crear 2 movs en PASE con MISMO monto, fechas distintas pero ambas en ventana ±15d
    for (const fecha of ["2099-04-10", "2099-04-20"]) {
      const { error } = await db.rpc("crear_movimiento_caja", {
        p_fecha: fecha,
        p_cuenta: "MercadoPago",
        p_tipo: "Ingreso Manual",
        p_cat: null,
        p_importe: SENTINEL_MATCH + 1,  // distinto al del verde para no interferir
        p_detalle: `TEST-CONCIL-AMARILLO-${fecha}`,
        p_local_id: localId,
      });
      if (error) throw new Error(`No se pudo crear mov: ${error.message}`);
    }
    const { data: movsAmarillo } = await db.from("movimientos")
      .select("id")
      .eq("local_id", localId)
      .like("detalle", "TEST-CONCIL-AMARILLO-%");
    expect(movsAmarillo && movsAmarillo.length).toBe(2);
    movsAmarillo!.forEach(m => movIdsCreated.push(m.id as string));

    // Extracto: 1 mov fecha 15-abr (entre las 2 fechas de PASE) con mismo monto
    const { data, error } = await db.rpc("fn_cruzar_extracto_mp", {
      p_local_id: localId,
      p_periodo_desde: PERIODO_DESDE,
      p_periodo_hasta: PERIODO_HASTA,
      p_movs_extracto: [
        { fecha: "2099-04-15", monto: SENTINEL_MATCH + 1, descripcion: "test amarillo", referencia_externa: null },
      ],
    });
    if (error) throw new Error(`RPC falló: ${error.message}`);
    const res = data as {
      totales: { amarillos: number; verdes: number };
      extracto: Array<{ estado: string; num_candidatos: number; candidatos: unknown[] }>;
    };
    expect(res.totales.amarillos).toBe(1);
    expect(res.totales.verdes).toBe(0);
    expect(res.extracto[0]!.estado).toBe("amarillo");
    expect(res.extracto[0]!.num_candidatos).toBe(2);
    expect(res.extracto[0]!.candidatos.length).toBe(2);
  });

  test("rojo_falta: extracto tiene mov que NO está en PASE (distinto monto)", async () => {
    // El mov del extracto tiene un monto que NUNCA cargamos en PASE
    const MONTO_INEXISTENTE = 999_999.99;
    const { data, error } = await db.rpc("fn_cruzar_extracto_mp", {
      p_local_id: localId,
      p_periodo_desde: PERIODO_DESDE,
      p_periodo_hasta: PERIODO_HASTA,
      p_movs_extracto: [
        { fecha: "2099-04-12", monto: MONTO_INEXISTENTE, descripcion: "test rojo_falta", referencia_externa: null },
      ],
    });
    if (error) throw new Error(`RPC falló: ${error.message}`);
    const res = data as {
      totales: { rojos_falta: number; verdes: number };
      extracto: Array<{ estado: string; num_candidatos: number }>;
    };
    expect(res.totales.rojos_falta).toBe(1);
    expect(res.totales.verdes).toBe(0);
    expect(res.extracto[0]!.estado).toBe("rojo_falta");
    expect(res.extracto[0]!.num_candidatos).toBe(0);
  });

  test("rojo_sobra: PASE tiene mov que NO está en el extracto", async () => {
    // Crear mov sobrante en PASE
    const { error: cErr } = await db.rpc("crear_movimiento_caja", {
      p_fecha: "2099-04-22",
      p_cuenta: "MercadoPago",
      p_tipo: "Ingreso Manual",
      p_cat: null,
      p_importe: SENTINEL_SOBRA,
      p_detalle: "TEST-CONCIL-SOBRA",
      p_local_id: localId,
    });
    if (cErr) throw new Error(`No se pudo crear mov: ${cErr.message}`);
    const { data: movs } = await db.from("movimientos")
      .select("id")
      .eq("local_id", localId)
      .eq("cuenta", "MercadoPago")
      .eq("detalle", "TEST-CONCIL-SOBRA")
      .limit(1);
    expect(movs && movs.length).toBe(1);
    movIdsCreated.push(movs![0]!.id as string);

    // Llamar RPC con un extracto vacío → todos los movs PASE en el período son sobrantes
    const { data, error } = await db.rpc("fn_cruzar_extracto_mp", {
      p_local_id: localId,
      p_periodo_desde: PERIODO_DESDE,
      p_periodo_hasta: PERIODO_HASTA,
      p_movs_extracto: [],
    });
    if (error) throw new Error(`RPC falló: ${error.message}`);
    const res = data as {
      totales: { rojos_sobra: number; extracto_total: number };
      sobrantes: Array<{ id: string; importe: number; detalle: string }>;
    };
    expect(res.totales.extracto_total).toBe(0);
    // Debe haber AL MENOS nuestro sobrante (puede haber otros si tests previos no limpiaron)
    expect(res.totales.rojos_sobra).toBeGreaterThanOrEqual(1);
    const nuestroSobrante = res.sobrantes.find(s => s.detalle === "TEST-CONCIL-SOBRA");
    expect(nuestroSobrante).toBeDefined();
    expect(Number(nuestroSobrante!.importe)).toBe(SENTINEL_SOBRA);
  });

  test("regla 15 días: mov en PASE +20 días NO matchea (cae a rojo_falta)", async () => {
    const MONTO_OUT = 88_888.88;
    // Crear mov en PASE a 25 días del fecha extracto (fuera de ventana ±15d)
    const { error: cErr } = await db.rpc("crear_movimiento_caja", {
      p_fecha: "2099-05-15", // fuera de período pero más lejos que 15d del 04-20
      p_cuenta: "MercadoPago",
      p_tipo: "Ingreso Manual",
      p_cat: null,
      p_importe: MONTO_OUT,
      p_detalle: "TEST-CONCIL-FUERA-VENTANA",
      p_local_id: localId,
    });
    if (cErr) throw new Error(`No se pudo crear mov: ${cErr.message}`);
    const { data: movs } = await db.from("movimientos")
      .select("id")
      .eq("local_id", localId)
      .eq("detalle", "TEST-CONCIL-FUERA-VENTANA")
      .limit(1);
    if (movs && movs.length > 0) movIdsCreated.push(movs[0]!.id as string);

    // Extracto: mov del 2099-04-20 con MONTO_OUT. PASE tiene mov el 2099-05-15
    // (25 días después). Está fuera de ventana ±15d → debe quedar rojo_falta.
    const { data, error } = await db.rpc("fn_cruzar_extracto_mp", {
      p_local_id: localId,
      p_periodo_desde: PERIODO_DESDE,
      p_periodo_hasta: PERIODO_HASTA,
      p_movs_extracto: [
        { fecha: "2099-04-20", monto: MONTO_OUT, descripcion: "test fuera ventana", referencia_externa: null },
      ],
    });
    if (error) throw new Error(`RPC falló: ${error.message}`);
    const res = data as {
      extracto: Array<{ estado: string; num_candidatos: number }>;
    };
    expect(res.extracto[0]!.estado).toBe("rojo_falta");
    expect(res.extracto[0]!.num_candidatos).toBe(0);
  });
});
