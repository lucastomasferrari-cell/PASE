// E2E Sprint 2 — Test 12: notification_preferences (feature 22-may noche)
// Verifica: fn_user_quiere_notif default ON + filtrado cuando OFF.

import { test, expect } from "@playwright/test";
import { createSuperadminClient } from "../../helpers/supabaseClient";
import { seedE2ETenant, cleanupE2ETenant, createServiceClient, type E2ETenantSeedResult } from "../setup/seed-tenant";

test.describe.serial("E2E Sprint 2 — Notification preferences", () => {
  let seed: E2ETenantSeedResult | null = null;

  test.beforeAll(async ({}, testInfo) => {
    await cleanupE2ETenant();
    const superdb = await createSuperadminClient();
    if (!superdb) { test.skip(true, "SUPERADMIN_PASSWORD no seteado"); return; }
    const { data: sess } = await superdb.auth.getSession();
    const baseUrl = (testInfo.project.use.baseURL || "https://pase-yndx.vercel.app").replace(/\/$/, "");
    seed = await seedE2ETenant({ superadminToken: sess?.session?.access_token!, baseUrl });
    await superdb.auth.signOut();
  });

  test.afterAll(async () => { try { await cleanupE2ETenant(); } catch (e) { console.error(e); } });

  test("default ON (sin fila) + OFF cuando enabled=false + ON cuando enabled=true", async () => {
    if (!seed) { test.skip(true, "Seed falló"); return; }
    const svc = createServiceClient();
    const uid = seed.duenoUsuarioId;

    // Default ON (no hay fila en notification_preferences)
    const { data: r1 } = await svc.rpc("fn_user_quiere_notif", {
      p_user_id: uid, p_type: "ig_dm_new",
    });
    expect(r1).toBe(true);

    // Insertar pref OFF
    await svc.from("notification_preferences").insert({
      user_id: uid, notification_type: "ig_dm_new", enabled: false,
    });
    const { data: r2 } = await svc.rpc("fn_user_quiere_notif", {
      p_user_id: uid, p_type: "ig_dm_new",
    });
    expect(r2).toBe(false);

    // Update pref a ON
    await svc.from("notification_preferences").update({ enabled: true })
      .eq("user_id", uid).eq("notification_type", "ig_dm_new");
    const { data: r3 } = await svc.rpc("fn_user_quiere_notif", {
      p_user_id: uid, p_type: "ig_dm_new",
    });
    expect(r3).toBe(true);

    // Otro tipo distinto (sin fila) — sigue default ON
    const { data: r4 } = await svc.rpc("fn_user_quiere_notif", {
      p_user_id: uid, p_type: "cashbox_negative",
    });
    expect(r4).toBe(true);
  });
});
