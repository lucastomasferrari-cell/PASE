import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: fn_get_modificadores_publico (Fase 6 Brainstorm #8,
// chunk item-detalle, 2026-06-02).
//
// La RPC nueva expone modifier_groups + modifiers a la tienda pública
// (sin auth) para que la pantalla TiendaItemDetalle pueda render. Como
// vive accesible por anon, los mutantes acá protegen:
//
//   1. Estructura: para un item con groups asignados, retorna las filas
//      correctas con (group + cada modifier).
//   2. Anti-enumeration: si el item_id no corresponde a un item visible
//      en la tienda del slug, retorna [] (NO informa si existe o no).
//   3. Anti-soft-deleted: modifiers/groups con deleted_at no aparecen.
//   4. Anti-inactive: modifiers con activo=FALSE no aparecen.
//
// Estos cuatro caen apenas se rompa el filtro en la migration
// `202606021800_tienda_modificadores_publico.sql`.
//
// El test crea+limpia su propio modifier_group + modifier. NO crea items
// — usa uno existente del tenant (debe existir item con visible_tienda
// y precio en canal tienda-propia).

const SENTINEL_GROUP_NOMBRE = "TEST_MUTANTE_GROUP";
const SENTINEL_MOD_NOMBRE = "TEST_MUTANTE_MOD";
const LOCAL = "Local Prueba 2";

test.describe("Tienda — modificadores públicos mutante", () => {
  let db: SupabaseClient;
  let tenantId: string;
  let localSlug: string;
  let itemId: number;          // item del tenant que SÍ está en v_catalogo_publico
  let itemIdOculto: number;    // item del tenant que NO está en v_catalogo_publico (visible_tienda=false)

  // IDs creados para cleanup
  let createdGroupIds: number[] = [];
  let createdModifierIds: number[] = [];
  let createdAssignmentIds: number[] = [];

  test.beforeEach(async () => {
    db = await createDuenoClient();
    createdGroupIds = [];
    createdModifierIds = [];
    createdAssignmentIds = [];

    // Resolver local + tenant + slug
    const { data: locales, error: errL } = await db.from("locales")
      .select("id, tenant_id").eq("nombre", LOCAL);
    if (errL) throw new Error(`Consulta local falló: ${errL.message}`);
    if (!locales || locales.length === 0) throw new Error(`Falta local "${LOCAL}"`);
    const localId = locales[0].id as number;
    tenantId = locales[0].tenant_id as string;

    const { data: settings } = await db.from("comanda_local_settings")
      .select("slug, tienda_activa").eq("local_id", localId).maybeSingle();
    if (!settings || !settings.slug || !settings.tienda_activa) {
      throw new Error(
        `Local "${LOCAL}" debe tener slug + tienda_activa=true en ` +
        `comanda_local_settings. Setear desde Settings/SettingsLocal o ` +
        `UPDATE manual.`
      );
    }
    localSlug = settings.slug as string;

    // Resolver un item PÚBLICO del tenant (debe figurar en v_catalogo_publico
    // de este slug). Si no hay ninguno, el test no puede correr sin setup
    // previo — pre-check accionable.
    const { data: itemsPub } = await db.from("v_catalogo_publico")
      .select("item_id").eq("local_slug", localSlug).limit(1);
    if (!itemsPub || itemsPub.length === 0) {
      throw new Error(
        `Falta al menos un item público en tienda de "${LOCAL}" (slug=${localSlug}). ` +
        `Crear uno desde Catálogo con visible_tienda=true + precio en canal tienda-propia.`
      );
    }
    itemId = itemsPub[0].item_id as number;

    // Resolver un item OCULTO (del mismo tenant pero NO público) — para
    // probar anti-enumeration. Si no hay, el test 2 se skipea con notice.
    const { data: itemsOcultos } = await db.from("items")
      .select("id").eq("tenant_id", tenantId).eq("visible_tienda", false)
      .is("deleted_at", null).limit(1);
    itemIdOculto = itemsOcultos?.[0]?.id as number ?? 0;
  });

  test.afterEach(async () => {
    // Cleanup en orden inverso: asignaciones → modifiers → groups.
    for (const aid of createdAssignmentIds) {
      try { await db.from("item_modifier_groups").delete().eq("id", aid); }
      catch (e) { console.error(`[cleanup] assignment ${aid}:`, e); }
    }
    for (const mid of createdModifierIds) {
      try { await db.from("modifiers").delete().eq("id", mid); }
      catch (e) { console.error(`[cleanup] modifier ${mid}:`, e); }
    }
    for (const gid of createdGroupIds) {
      try { await db.from("modifier_groups").delete().eq("id", gid); }
      catch (e) { console.error(`[cleanup] group ${gid}:`, e); }
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("MUTANTE: estructura — group con 2 modifiers, retorna 2 filas con datos correctos", async () => {
    // 1. Crear modifier_group
    const { data: g, error: errG } = await db.from("modifier_groups").insert({
      tenant_id: tenantId,
      nombre: `${SENTINEL_GROUP_NOMBRE}_${Date.now()}`,
      descripcion: "Test mutante",
      requerido: true,
      min_seleccion: 1,
      max_seleccion: 1,
      tipo: "opcion",
    }).select("id").single();
    expect(errG).toBeNull();
    const groupId = g!.id as number;
    createdGroupIds.push(groupId);

    // 2. Crear 2 modifiers
    const { data: m1, error: errM1 } = await db.from("modifiers").insert({
      tenant_id: tenantId,
      modifier_group_id: groupId,
      nombre: `${SENTINEL_MOD_NOMBRE}_A`,
      precio_extra: 100,
      orden: 1,
      activo: true,
    }).select("id").single();
    expect(errM1).toBeNull();
    createdModifierIds.push(m1!.id as number);

    const { data: m2 } = await db.from("modifiers").insert({
      tenant_id: tenantId,
      modifier_group_id: groupId,
      nombre: `${SENTINEL_MOD_NOMBRE}_B`,
      precio_extra: 200,
      orden: 2,
      activo: true,
    }).select("id").single();
    createdModifierIds.push(m2!.id as number);

    // 3. Asignar al item público
    const { data: asg } = await db.from("item_modifier_groups").insert({
      tenant_id: tenantId,
      item_id: itemId,
      modifier_group_id: groupId,
      orden: 0,
    }).select("id").single();
    createdAssignmentIds.push(asg!.id as number);

    // 4. Llamar RPC pública (autenticado como dueño es OK — anon es lo
    //    importante para el grant pero la RPC misma no chequea auth)
    const { data: rows, error: errRpc } = await db.rpc("fn_get_modificadores_publico", {
      p_item_id: itemId,
      p_local_slug: localSlug,
    });
    expect(errRpc).toBeNull();
    const filas = (rows ?? []) as Array<Record<string, unknown>>;

    // 5. Filtrar solo las filas de NUESTRO group (puede haber otros groups
    //    asignados al mismo item desde prod)
    const nuestras = filas.filter((r) => r.modifier_group_id === groupId);
    expect(nuestras.length).toBe(2); // MUTANTE: si el LEFT JOIN se rompe, viene 1 o 0

    const modIds = nuestras.map((r) => r.modifier_id).sort();
    expect(modIds).toEqual([m1!.id, m2!.id].sort());

    // Datos del group bien proyectados
    expect(nuestras[0]!.group_nombre).toContain(SENTINEL_GROUP_NOMBRE);
    expect(nuestras[0]!.group_tipo).toBe("opcion");
    expect(nuestras[0]!.requerido).toBe(true);
    expect(nuestras[0]!.min_seleccion).toBe(1);
    expect(nuestras[0]!.max_seleccion).toBe(1);

    // Precios bien convertidos a número
    const filaA = nuestras.find((r) => r.modifier_id === m1!.id);
    expect(Number(filaA!.modifier_precio_extra)).toBe(100);
    expect(filaA!.modifier_nombre).toContain("_A");
  });

  test("MUTANTE: anti-enumeration — item no público retorna []", async () => {
    if (!itemIdOculto) {
      test.skip(true, "No hay item con visible_tienda=false en el tenant para probar. " +
                       "Crear uno desde Catálogo y dejarlo NO visible en tienda.");
      return;
    }

    // Crear modifier_group + asignación al item OCULTO
    const { data: g } = await db.from("modifier_groups").insert({
      tenant_id: tenantId,
      nombre: `${SENTINEL_GROUP_NOMBRE}_OCULTO_${Date.now()}`,
      requerido: false,
      min_seleccion: 0,
      tipo: "extra",
    }).select("id").single();
    createdGroupIds.push(g!.id as number);

    const { data: m } = await db.from("modifiers").insert({
      tenant_id: tenantId,
      modifier_group_id: g!.id,
      nombre: `${SENTINEL_MOD_NOMBRE}_OCULTO`,
      precio_extra: 50,
      orden: 1,
      activo: true,
    }).select("id").single();
    createdModifierIds.push(m!.id as number);

    const { data: asg } = await db.from("item_modifier_groups").insert({
      tenant_id: tenantId,
      item_id: itemIdOculto,
      modifier_group_id: g!.id,
      orden: 0,
    }).select("id").single();
    createdAssignmentIds.push(asg!.id as number);

    // MUTANTE: item oculto, NO debe filtrar modifs aunque exista asignación
    const { data: rows, error: errRpc } = await db.rpc("fn_get_modificadores_publico", {
      p_item_id: itemIdOculto,
      p_local_slug: localSlug,
    });
    expect(errRpc).toBeNull();
    const filas = (rows ?? []) as Array<Record<string, unknown>>;

    // Filtrar por NUESTRO group: si la validación anti-enumeration se rompe,
    // veremos al menos 1 fila con nuestro group_id
    const nuestras = filas.filter((r) => r.modifier_group_id === g!.id);
    expect(nuestras.length).toBe(0); // MUTANTE: si validación se rompe, viene 1
  });

  test("MUTANTE: modifier_group soft-deleted no aparece", async () => {
    const { data: g } = await db.from("modifier_groups").insert({
      tenant_id: tenantId,
      nombre: `${SENTINEL_GROUP_NOMBRE}_SOFTDEL_${Date.now()}`,
      requerido: false,
      min_seleccion: 0,
      tipo: "extra",
      deleted_at: new Date().toISOString(), // ← soft-deleted desde el inicio
    }).select("id").single();
    createdGroupIds.push(g!.id as number);

    const { data: m } = await db.from("modifiers").insert({
      tenant_id: tenantId,
      modifier_group_id: g!.id,
      nombre: `${SENTINEL_MOD_NOMBRE}_SOFTDEL`,
      precio_extra: 999,
      orden: 1,
      activo: true,
    }).select("id").single();
    createdModifierIds.push(m!.id as number);

    const { data: asg } = await db.from("item_modifier_groups").insert({
      tenant_id: tenantId,
      item_id: itemId,
      modifier_group_id: g!.id,
      orden: 99,
    }).select("id").single();
    createdAssignmentIds.push(asg!.id as number);

    const { data: rows } = await db.rpc("fn_get_modificadores_publico", {
      p_item_id: itemId,
      p_local_slug: localSlug,
    });
    const filas = (rows ?? []) as Array<Record<string, unknown>>;
    const nuestras = filas.filter((r) => r.modifier_group_id === g!.id);
    expect(nuestras.length).toBe(0); // MUTANTE: si filter deleted_at se rompe, leakea
  });

  test("MUTANTE: modifier inactivo (activo=false) no aparece", async () => {
    const { data: g } = await db.from("modifier_groups").insert({
      tenant_id: tenantId,
      nombre: `${SENTINEL_GROUP_NOMBRE}_INACT_${Date.now()}`,
      requerido: false,
      min_seleccion: 0,
      tipo: "extra",
    }).select("id").single();
    createdGroupIds.push(g!.id as number);

    // 1 activo + 1 inactivo
    const { data: mAct } = await db.from("modifiers").insert({
      tenant_id: tenantId,
      modifier_group_id: g!.id,
      nombre: `${SENTINEL_MOD_NOMBRE}_ACTIVO`,
      precio_extra: 10,
      orden: 1,
      activo: true,
    }).select("id").single();
    createdModifierIds.push(mAct!.id as number);

    const { data: mInact } = await db.from("modifiers").insert({
      tenant_id: tenantId,
      modifier_group_id: g!.id,
      nombre: `${SENTINEL_MOD_NOMBRE}_INACTIVO`,
      precio_extra: 20,
      orden: 2,
      activo: false,
    }).select("id").single();
    createdModifierIds.push(mInact!.id as number);

    const { data: asg } = await db.from("item_modifier_groups").insert({
      tenant_id: tenantId,
      item_id: itemId,
      modifier_group_id: g!.id,
      orden: 100,
    }).select("id").single();
    createdAssignmentIds.push(asg!.id as number);

    const { data: rows } = await db.rpc("fn_get_modificadores_publico", {
      p_item_id: itemId,
      p_local_slug: localSlug,
    });
    const filas = (rows ?? []) as Array<Record<string, unknown>>;
    const nuestras = filas.filter((r) => r.modifier_group_id === g!.id);

    // Solo el activo debe aparecer
    expect(nuestras.length).toBe(1); // MUTANTE: si activo=false leakea, viene 2
    expect(nuestras[0]!.modifier_id).toBe(mAct!.id);
    expect(nuestras[0]!.modifier_nombre).toContain("_ACTIVO");
  });

  test("MUTANTE: v_catalogo_publico expone tiene_modificadores=TRUE para item con groups", async () => {
    // Crear group + asignación al item
    const { data: g } = await db.from("modifier_groups").insert({
      tenant_id: tenantId,
      nombre: `${SENTINEL_GROUP_NOMBRE}_FLAG_${Date.now()}`,
      requerido: false,
      min_seleccion: 0,
      tipo: "extra",
    }).select("id").single();
    createdGroupIds.push(g!.id as number);

    const { data: asg } = await db.from("item_modifier_groups").insert({
      tenant_id: tenantId,
      item_id: itemId,
      modifier_group_id: g!.id,
      orden: 200,
    }).select("id").single();
    createdAssignmentIds.push(asg!.id as number);

    // Consultar la vista pública para ese item
    const { data: rows } = await db.from("v_catalogo_publico")
      .select("item_id, tiene_modificadores")
      .eq("local_slug", localSlug)
      .eq("item_id", itemId)
      .limit(1);

    expect(rows?.length).toBeGreaterThan(0);
    expect(rows![0]!.tiene_modificadores).toBe(true); // MUTANTE: si la columna calc se rompe, viene false
  });
});
