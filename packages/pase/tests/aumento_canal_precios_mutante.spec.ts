import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: fn_aumento_canal_precios (Fase 6 Brainstorm #8 — chunk
// Pricing canal, 2026-06-02).
//
// La RPC nueva sube los precios SOLO de un canal específico sin tocar
// precio_madre. Caso real: Rappi sube comisión 25% → quiero trasladarlo
// solo a Rappi sin afectar el precio en mostrador.
//
// Mutantes:
//   1. UPDATE: para items con ipc existente, precio = round(precio * 1.25)
//   2. INSERT: para items SIN ipc en ese canal, crea con precio derivado
//      del madre + ajuste del canal + porcentaje pedido.
//   3. NO toca precio_madre — invariante crítico.
//   4. NO toca OTROS canales del mismo tenant.
//   5. edicion_manual queda TRUE en filas afectadas.
//   6. Anti cross-tenant: canal de otro tenant → error CANAL_NO_VALIDO.
//   7. Grupo filter: aplicar solo a items del grupo elegido.
//
// Setup: usa Local Prueba 2. Crea su propio item + canal + grupo
// específicos para no afectar data existente.

const SENTINEL_ITEM_NOMBRE = "TEST_AUMENTO_CANAL";
const SENTINEL_CANAL_NOMBRE = "TEST_AUM_CANAL";
const SENTINEL_GRUPO_NOMBRE = "TEST_AUM_GRUPO";
const PRECIO_MADRE_INICIAL = 1000;
const LOCAL = "Local Prueba 2";

test.describe("Aumento canal precios mutante", () => {
  let db: SupabaseClient;
  let tenantId: string;
  let localId: number;
  let canalId: number;
  let canalOtroId: number;  // otro canal del mismo tenant para verificar que NO se toca
  let grupoId: number;
  let itemConIpcId: number;     // item que YA tiene ipc en canalId
  let itemSinIpcId: number;     // item que NO tiene ipc en canalId (test del INSERT)
  let ipcExistenteId: number;

  test.beforeEach(async () => {
    db = await createDuenoClient();

    // Resolver local + tenant
    const { data: locales } = await db.from("locales")
      .select("id, tenant_id").eq("nombre", LOCAL);
    if (!locales || locales.length === 0) throw new Error(`Falta local "${LOCAL}"`);
    localId = locales[0].id as number;
    tenantId = locales[0].tenant_id as string;

    // Crear grupo de prueba
    const { data: g } = await db.from("item_grupos").insert({
      tenant_id: tenantId,
      nombre: `${SENTINEL_GRUPO_NOMBRE}_${Date.now()}`,
      color_ramp: "gray",
    }).select("id").single();
    grupoId = g!.id as number;

    // Crear 2 canales: uno objetivo (canalId), otro testigo (canalOtroId)
    const { data: c1 } = await db.from("canales").insert({
      tenant_id: tenantId,
      slug: `test-aum-${Date.now()}`,
      nombre: `${SENTINEL_CANAL_NOMBRE}_${Date.now()}`,
      activo: true,
      atado_madre: false,
      ajuste_madre_pct: 0,
      redondeo_a: 1,
    }).select("id").single();
    canalId = c1!.id as number;

    const { data: c2 } = await db.from("canales").insert({
      tenant_id: tenantId,
      slug: `test-otro-${Date.now()}`,
      nombre: `${SENTINEL_CANAL_NOMBRE}_OTRO_${Date.now()}`,
      activo: true,
      atado_madre: false,
      ajuste_madre_pct: 0,
      redondeo_a: 1,
    }).select("id").single();
    canalOtroId = c2!.id as number;

    // Crear 2 items en el grupo
    const { data: it1 } = await db.from("items").insert({
      tenant_id: tenantId,
      local_id: localId,
      nombre: `${SENTINEL_ITEM_NOMBRE}_CON_IPC`,
      grupo_id: grupoId,
      precio_madre: PRECIO_MADRE_INICIAL,
      estado: "disponible",
      visible_tienda: false,
    }).select("id").single();
    itemConIpcId = it1!.id as number;

    const { data: it2 } = await db.from("items").insert({
      tenant_id: tenantId,
      local_id: localId,
      nombre: `${SENTINEL_ITEM_NOMBRE}_SIN_IPC`,
      grupo_id: grupoId,
      precio_madre: PRECIO_MADRE_INICIAL,
      estado: "disponible",
      visible_tienda: false,
    }).select("id").single();
    itemSinIpcId = it2!.id as number;

    // Crear ipc inicial SOLO para item1 (item2 no tiene → testea el INSERT branch)
    const { data: ipc } = await db.from("item_precios_canal").insert({
      tenant_id: tenantId,
      local_id: localId,
      item_id: itemConIpcId,
      canal_id: canalId,
      precio: PRECIO_MADRE_INICIAL,
      edicion_manual: false,
      vendible: true,
    }).select("id").single();
    ipcExistenteId = ipc!.id as number;

    // Y un ipc en el OTRO canal para item1 — testea que NO se toca.
    await db.from("item_precios_canal").insert({
      tenant_id: tenantId,
      local_id: localId,
      item_id: itemConIpcId,
      canal_id: canalOtroId,
      precio: 777,  // sentinel — debe quedar igual post-RPC
      edicion_manual: false,
      vendible: true,
    });
  });

  test.afterEach(async () => {
    try {
      // Borrar ipcs de los items creados
      await db.from("item_precios_canal").delete().in("item_id", [itemConIpcId, itemSinIpcId]);
      await db.from("items").delete().in("id", [itemConIpcId, itemSinIpcId]);
      await db.from("canales").delete().in("id", [canalId, canalOtroId]);
      await db.from("item_grupos").delete().eq("id", grupoId);
      await db.auth.signOut();
    } catch (e) { console.error("[cleanup]:", e); }
  });

  test("MUTANTE: UPDATE — item con ipc existente sube 25%", async () => {
    const { data: result, error } = await db.rpc("fn_aumento_canal_precios", {
      p_tenant_id: tenantId,
      p_canal_id: canalId,
      p_local_id: null,
      p_grupo_id: grupoId,
      p_porcentaje: 25,
      p_redondeo_a: 1,
    });
    expect(error).toBeNull();
    const r = (result as Array<{ items_afectados: number; precios_actualizados: number; precios_creados: number }>)?.[0];
    expect(r).toBeDefined();
    expect(r!.precios_actualizados).toBe(1); // MUTANTE: si filter por canal se rompe, viene 0 o 2

    // Verificar precio actualizado
    const { data: ipc } = await db.from("item_precios_canal")
      .select("precio, edicion_manual").eq("id", ipcExistenteId).single();
    expect(Number(ipc!.precio)).toBe(1250); // 1000 * 1.25
    expect(ipc!.edicion_manual).toBe(true); // MUTANTE: si no se marca manual, falla
  });

  test("MUTANTE: INSERT — item SIN ipc en este canal lo crea con precio derivado", async () => {
    const { data: result } = await db.rpc("fn_aumento_canal_precios", {
      p_tenant_id: tenantId,
      p_canal_id: canalId,
      p_local_id: null,
      p_grupo_id: grupoId,
      p_porcentaje: 25,
      p_redondeo_a: 1,
    });
    const r = (result as Array<{ precios_creados: number }>)?.[0];
    expect(r!.precios_creados).toBe(1); // MUTANTE: si el WHERE NOT EXISTS se rompe, viene 0

    // Verificar el nuevo ipc creado para itemSinIpcId
    const { data: nuevo } = await db.from("item_precios_canal")
      .select("precio, edicion_manual, vendible")
      .eq("item_id", itemSinIpcId).eq("canal_id", canalId).single();
    expect(nuevo).not.toBeNull();
    // Canal con ajuste_madre_pct=0 → precio = 1000 * 1 * 1.25 = 1250
    expect(Number(nuevo!.precio)).toBe(1250);
    expect(nuevo!.edicion_manual).toBe(true);
    expect(nuevo!.vendible).toBe(true);
  });

  test("MUTANTE: invariante — precio_madre NO se modifica", async () => {
    const madreAntes1 = PRECIO_MADRE_INICIAL;
    const madreAntes2 = PRECIO_MADRE_INICIAL;

    await db.rpc("fn_aumento_canal_precios", {
      p_tenant_id: tenantId,
      p_canal_id: canalId,
      p_local_id: null,
      p_grupo_id: grupoId,
      p_porcentaje: 50,  // % grande para que sea fácil detectar si se filtró al madre
      p_redondeo_a: 1,
    });

    const { data: items } = await db.from("items")
      .select("id, precio_madre")
      .in("id", [itemConIpcId, itemSinIpcId]);

    const m1 = items?.find((i) => i.id === itemConIpcId);
    const m2 = items?.find((i) => i.id === itemSinIpcId);
    // MUTANTE: si por error tocamos precio_madre, este assert cae.
    expect(Number(m1!.precio_madre)).toBe(madreAntes1);
    expect(Number(m2!.precio_madre)).toBe(madreAntes2);
  });

  test("MUTANTE: invariante — OTROS canales NO se tocan", async () => {
    // El item1 tiene ipc en canalOtroId con precio 777. Tras la RPC, sigue 777.
    await db.rpc("fn_aumento_canal_precios", {
      p_tenant_id: tenantId,
      p_canal_id: canalId,
      p_local_id: null,
      p_grupo_id: grupoId,
      p_porcentaje: 99,
      p_redondeo_a: 1,
    });

    const { data: ipcOtro } = await db.from("item_precios_canal")
      .select("precio").eq("item_id", itemConIpcId).eq("canal_id", canalOtroId).single();
    // MUTANTE: si el filter por p_canal_id se rompe, este precio cambia.
    expect(Number(ipcOtro!.precio)).toBe(777);
  });

  test("MUTANTE: anti cross-tenant — canal de otro tenant → CANAL_NO_VALIDO", async () => {
    // Buscar un canal de OTRO tenant para probar.
    const { data: otroTenantCanal } = await db.from("canales")
      .select("id, tenant_id").neq("tenant_id", tenantId).is("deleted_at", null).limit(1);

    if (!otroTenantCanal || otroTenantCanal.length === 0) {
      test.skip(true, "No hay canal de otro tenant para probar cross-tenant defense");
      return;
    }
    const canalOtroTenantId = otroTenantCanal[0]!.id as number;

    const { error } = await db.rpc("fn_aumento_canal_precios", {
      p_tenant_id: tenantId, // mi tenant
      p_canal_id: canalOtroTenantId, // canal del otro
      p_local_id: null,
      p_grupo_id: grupoId,
      p_porcentaje: 10,
      p_redondeo_a: 1,
    });
    // MUTANTE: sin el check, la RPC ejecutaría updates que no afectarían nada
    // pero no devolvería error. El check explícito es lo que protege.
    expect(error).not.toBeNull();
    expect(error!.message).toContain("CANAL_NO_VALIDO");
  });
});
