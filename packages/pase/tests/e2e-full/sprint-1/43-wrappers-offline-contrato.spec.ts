// ─────────────────────────────────────────────────────────────────────────
// E2E Test 43 — Contrato de los wrappers RPC *_comanda_offline
//
// Origen (bug 11-jun): los wrappers offline tenían DOS bugs invisibles a la
// suite porque ningún test los llamaba directo:
//
//  1. ACL: eran ejecutables por `anon` desde su creación. Los default
//     privileges de Supabase dan EXECUTE a anon/authenticated/service_role
//     en toda función nueva, y `REVOKE ... FROM PUBLIC` solo NO los quita.
//     Fix: migración 202606111100.
//  2. Inners inexistentes: 4 de los 9 wrappers llamaban funciones SIN el
//     sufijo _comanda (fn_anular_venta, fn_anular_item, fn_cortesia_item,
//     fn_modificar_precio_item) que nunca existieron → todo replay de la
//     cola offline de esas acciones moría con 42883 y la pendiente quedaba
//     atascada. Fix: migración 202606111200.
//
// Este test fija el contrato para que ninguno de los dos vuelva:
//
//  A) authenticated + IDs inexistentes → error de NEGOCIO (P0001) o ningún
//     error. NUNCA 42883 (inner inexistente), 42501 (permiso revocado de
//     más) ni PGRST202 (wrapper desaparecido del schema). No muta nada:
//     con IDs inexistentes el wrapper corta en el resolver o en la
//     validación de la inner.
//  B) anon → 42501 permission denied en TODOS los wrappers (probing
//     anónimo bloqueado).
//
// fn_abrir_venta_comanda_offline queda fuera del probe A (crearía una venta
// real si los args pasaran las validaciones) pero entra en el B.
//
// LIMITACIÓN CONOCIDA del probe A: con venta inexistente el wrapper corta en
// fn_resolver_venta_id_por_uuid (P0001) ANTES de la llamada interna, así que
// para transferir/unir/partir este test NO valida la firma de la inner. Al
// 11-jun esos 3 wrappers siguen llamando las inners de mesa-ops con args
// incompletos (les falta manager/motivo; unir además invierte origen/destino)
// — fix pendiente en la migración borrador
// 202606111100_fix_wrappers_offline_nombres_internos.sql (sesión debugging
// 11-jun), que al aterrizar debería extender este test con ventas reales.
// ─────────────────────────────────────────────────────────────────────────

import {
  test,
  expect,
} from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createE2EDuenoClient } from "../setup/seed-tenant";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SUPABASE_URL = "https://pduxydviqiaxfqnshhdc.supabase.co";

function loadAnonKey(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "..", "..", "..", ".env.local");
  const raw = readFileSync(envPath, "utf-8");
  const m = raw.match(/^VITE_SUPABASE_ANON_KEY=(.+)$/m);
  if (!m || !m[1]) throw new Error(`VITE_SUPABASE_ANON_KEY no encontrada en ${envPath}`);
  return m[1].trim().replace(/^"(.*)"$/, "$1");
}

// UUID que no existe en ninguna tabla — solo dispara los paths de "no encontrado".
const NX_UUID = "00000000-0000-0000-0000-00000000e2e1";
const NX_ID = 999_999_999;

// Wrapper → args con referencias inexistentes (no mutan nada).
const PROBES: Array<[string, Record<string, unknown>]> = [
  ["fn_anular_venta_comanda_offline", {
    p_venta_id: NX_ID, p_venta_idempotency_uuid: NX_UUID,
    p_manager_id: null, p_motivo: "probe contrato e2e",
    p_idempotency_uuid: null, p_idempotency_key: null,
  }],
  ["fn_anular_item_comanda_offline", {
    p_item_id: NX_ID, p_item_idempotency_uuid: NX_UUID,
    p_manager_id: null, p_motivo: "probe contrato e2e",
    p_idempotency_uuid: null, p_idempotency_key: null,
  }],
  ["fn_cortesia_item_comanda_offline", {
    p_item_id: NX_ID, p_item_idempotency_uuid: NX_UUID,
    p_manager_id: null, p_motivo: "probe contrato e2e",
    p_idempotency_uuid: null, p_idempotency_key: null,
  }],
  ["fn_modificar_precio_item_comanda_offline", {
    p_item_id: NX_ID, p_item_idempotency_uuid: NX_UUID,
    p_precio_nuevo: 1, p_manager_id: null, p_motivo: "probe contrato e2e",
    p_idempotency_uuid: null, p_idempotency_key: null,
  }],
  ["fn_cobrar_venta_comanda_offline", {
    p_venta_id: NX_ID, p_venta_idempotency_uuid: NX_UUID,
    p_pagos: [], p_propina: 0, p_cobrado_por: null,
    p_idempotency_uuid: null, p_idempotency_key: null,
  }],
  ["fn_aplicar_descuento_comanda_offline", {
    p_venta_id: NX_ID, p_venta_idempotency_uuid: NX_UUID,
    p_monto: 1, p_motivo: "probe contrato e2e", p_manager_id: null,
    p_idempotency_uuid: null, p_idempotency_key: null,
  }],
  // Cobro offline incremental (Tier 2, 13-jun): wrapper de fn_agregar_pago_
  // venta_comanda. Resuelve la venta por UUID y delega en la inner idempotente
  // por p_idempotency_key. Con venta inexistente corta en el resolver (P0001).
  ["fn_agregar_pago_venta_comanda_offline", {
    p_venta_id: NX_ID, p_venta_idempotency_uuid: NX_UUID,
    p_metodo: "efectivo", p_monto: 1, p_idempotency_key: "probe-contrato-e2e",
    p_cobrado_por: null, p_vuelto: null, p_propina_incluida: 0, p_cuotas: null,
    p_idempotency_uuid: null,
  }],
  // Mesa-ops: desde 202606111300 los wrappers aceptan p_manager_id/p_motivo
  // (la capa offline ahora los transporta — bug 11-jun parte 2). Los probes
  // los incluyen a propósito: si alguien revierte la firma, esto da PGRST202.
  ["fn_transferir_mesa_comanda_offline", {
    p_venta_id: NX_ID, p_venta_idempotency_uuid: NX_UUID,
    p_mesa_destino_id: NX_ID, p_manager_id: null, p_motivo: "probe contrato e2e",
    p_idempotency_uuid: null, p_idempotency_key: null,
  }],
  ["fn_unir_mesas_comanda_offline", {
    p_venta_destino_id: NX_ID, p_venta_destino_idempotency_uuid: NX_UUID,
    p_venta_origen_id: NX_ID, p_venta_origen_idempotency_uuid: NX_UUID,
    p_manager_id: null, p_motivo: "probe contrato e2e",
    p_idempotency_uuid: null, p_idempotency_key: null,
  }],
  ["fn_partir_cuenta_comanda_offline", {
    p_venta_original_id: NX_ID, p_venta_original_idempotency_uuid: NX_UUID,
    p_item_ids: [NX_ID], p_manager_id: null, p_motivo: "probe contrato e2e",
    p_idempotency_uuid: null, p_idempotency_key: null,
  }],
];

// Para el probe anon alcanza el wrapper más sensible de cada familia + abrir.
const ANON_PROBES: Array<[string, Record<string, unknown>]> = [
  ...PROBES,
  ["fn_abrir_venta_comanda_offline", {
    p_local_id: NX_ID, p_canal_id: NX_ID, p_modo: "mesa", p_mesa_id: null,
    p_mozo_id: null, p_cajero_id: null, p_cliente_id: null, p_covers: null,
    p_tab_nombre: null, p_idempotency_uuid: NX_UUID, p_idempotency_key: null,
  }],
];

test.describe.serial("E2E Test 43 — Contrato wrappers *_comanda_offline", () => {
  test("A) authenticated: cada wrapper llega a error de negocio (nunca 42883/42501/PGRST202)", async () => {
    const db = await createE2EDuenoClient();
    for (const [fn, args] of PROBES) {
      const { error } = await db.rpc(fn, args);
      // Códigos que delatan wrapper roto — el mensaje del assert muestra cuál.
      const detalle = `${fn} → ${error ? `${error.code} / ${error.message}` : "OK"}`;
      expect(error?.code, `42883 = el wrapper llama una inner INEXISTENTE: ${detalle}`).not.toBe("42883");
      expect(error?.code, `42501 = authenticated perdió EXECUTE: ${detalle}`).not.toBe("42501");
      expect(error?.code, `PGRST202 = el wrapper no existe en el schema: ${detalle}`).not.toBe("PGRST202");
      // Con IDs inexistentes lo esperable es un error de negocio P0001.
      if (error) {
        expect(error.code, `esperaba error de negocio P0001: ${detalle}`).toBe("P0001");
      }
    }
  });

  test("B) anon: TODOS los wrappers responden permission denied (42501)", async () => {
    const anon = createClient(SUPABASE_URL, loadAnonKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    for (const [fn, args] of ANON_PROBES) {
      const { error } = await anon.rpc(fn, args);
      expect(error, `${fn}: anon NO recibió error — wrapper abierto a probing anónimo`).not.toBeNull();
      expect(error?.code, `${fn}: anon esperaba 42501, recibió ${error?.code} / ${error?.message}`).toBe("42501");
    }
  });
});
