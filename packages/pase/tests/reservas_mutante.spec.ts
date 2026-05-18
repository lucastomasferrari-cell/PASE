import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loginAs } from "./helpers/auth";
import { goTo } from "./helpers/navigation";
import { createDuenoClient } from "./helpers/supabaseClient";

// Test mutante: carga una reserva desde la UI (INSERT directo en `reservas`,
// no hay RPC), verifica que se persiste con todos los campos del sentinel,
// cambia el estado vía el select inline (UPDATE directo) y verifica que el
// estado nuevo quedó en DB. Cleanup: borrar la fila.
//
// Por qué un sentinel raro en cliente_nombre: no hay columna numérica única
// como en gastos/ventas. El nombre del cliente debe ser inconfundible para
// que el cleanup encuentre exactamente la reserva del test.
const LOCAL = "Local Prueba 2";
const SENTINEL_NOMBRE = `__E2E_MUTANTE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;
const SENTINEL_COVERS = 17;
const SENTINEL_NOTAS = "test mutante — borrar si quedó";
const SENTINEL_HORA = "20:30";

// Skipeado 2026-05-18: la pantalla /reservas fue ocultada del producto
// (Lucas: "no sirve, en todo caso vive en COMANDA"). La ruta ahora redirige
// a /inicio. Si el feature vuelve a PASE, sacar el .skip.
test.describe.skip("Reservas — mutante", () => {
  let db: SupabaseClient;
  let localId: number;
  let reservaId: number | null = null;

  test.beforeEach(async ({ page }) => {
    db = await createDuenoClient();

    const { data: locales, error: locErr } = await db
      .from("locales")
      .select("id, nombre, tenant_id")
      .eq("nombre", LOCAL);
    if (locErr) throw new Error(`Error consultando locales: ${locErr.message}`);
    if (!locales || locales.length === 0) throw new Error(`No existe local "${LOCAL}"`);
    if (locales.length > 1) throw new Error(`Hay ${locales.length} locales con nombre "${LOCAL}" — desambiguar`);
    localId = locales[0].id as number;

    reservaId = null;
    await loginAs(page, "dueno", { local: LOCAL });
  });

  test.afterEach(async () => {
    // Cleanup defensivo: buscar TODA fila con el sentinel (no solo la
    // referenciada por reservaId) por si el test creó pero falló antes
    // de capturar el id.
    try {
      const { error } = await db.from("reservas").delete().eq("cliente_nombre", SENTINEL_NOMBRE);
      if (error) console.error(`[cleanup] delete reservas: ${error.message}`);
    } catch (e) {
      console.error(`[cleanup] delete reservas threw:`, e);
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test("crear reserva persiste con campos exactos + cambio de estado se persiste", async ({ page }) => {
    await goTo(page, "Reservas");

    await page.getByRole("button", { name: "+ Nueva reserva" }).first().click();
    await expect(page.locator(".overlay")).toBeVisible({ timeout: 5_000 });

    const modal = page.locator(".overlay .modal");

    await modal.locator('.field:has(label:has-text("Hora")) input').fill(SENTINEL_HORA);
    await modal.locator('.field:has(label:has-text("Cliente")) input').fill(SENTINEL_NOMBRE);
    await modal.locator('.field:has(label:has-text("Cubiertos")) input').fill(String(SENTINEL_COVERS));
    await modal.locator('.field:has(label:has-text("Notas")) input').fill(SENTINEL_NOTAS);

    await modal.getByRole("button", { name: "Crear reserva" }).click();
    await expect(page.locator(".overlay")).not.toBeVisible({ timeout: 10_000 });

    // ── Assert 1: la reserva existe en DB con todos los campos del sentinel ─
    const { data: reservas, error: resErr } = await db
      .from("reservas")
      .select("id, local_id, cliente_nombre, covers, notas, estado, hora_inicio")
      .eq("cliente_nombre", SENTINEL_NOMBRE);
    expect(resErr).toBeNull();
    expect(reservas?.length).toBe(1);
    expect(reservas?.[0]?.local_id).toBe(localId);
    expect(reservas?.[0]?.covers).toBe(SENTINEL_COVERS);
    expect(reservas?.[0]?.notas).toBe(SENTINEL_NOTAS);
    expect(reservas?.[0]?.estado).toBe("pendiente"); // default
    // hora_inicio se guarda como time, comparamos por prefijo HH:MM
    expect((reservas?.[0]?.hora_inicio as string).slice(0, 5)).toBe(SENTINEL_HORA);
    reservaId = reservas![0]!.id as number;

    // ── Assert 2: cambio de estado vía select inline persiste ───────────────
    // Localizamos la fila por el nombre del cliente y el select de estado.
    const fila = page.locator("tr", { hasText: SENTINEL_NOMBRE });
    await fila.locator("select").selectOption("confirmada");
    // El cambio dispara update sin overlay; damos tiempo a que viaje a DB.
    await page.waitForTimeout(1_000);

    const { data: tras, error: trasErr } = await db
      .from("reservas")
      .select("estado")
      .eq("id", reservaId)
      .maybeSingle();
    expect(trasErr).toBeNull();
    expect(tras?.estado).toBe("confirmada");
  });
});
