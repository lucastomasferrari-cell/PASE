import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { gzipSync, gunzipSync } from "node:zlib";
import { createSuperadminClient } from "./helpers/supabaseClient";

// Test mutante: backup → mutar DB → restore_tenant → verificar que el
// estado del tenant volvió al snapshot. Cubre la RPC restore_tenant y
// el contrato del JSON producido por api/backup-tenants.js (version=1,
// tablas como objeto de arrays).
//
// Flujo:
//   1. Crear tenant A sentinel via /api/crear-tenant.
//   2. Sembrar data sentinel (2 proveedores + 1 venta con monto único).
//   3. SELECT * por tabla con tenant_id = A → armar JSON shape v1.
//      Ciclo gzip/gunzip en memoria valida serialización pero no toca
//      el bucket (las policies de tenant-backups bloquean INSERT de un
//      user authenticated; en producción solo el cron con service_role
//      escribe ahí).
//   4. Mutar: borrar los 2 proveedores, insertar 2 intrusos, cambiar
//      monto de la venta.
//   5. Verificar que la mutación pegó (DB "rota").
//   6. Pasar el JSON parsed al RPC restore_tenant.
//   7. Asserts post-restore: proveedores originales vuelven, intrusos
//      desaparecen, monto venta vuelve al original, fila RESTORE_TENANT
//      en auditoria.
//   8. Anti cross-tenant: crear tenant B, intentar restaurar el backup
//      de A en B → debe fallar con CROSS_TENANT_RESTORE_BLOCKED.
//
// Setup: SUPERADMIN_PASSWORD en packages/pase/.env.local (gateado por
// createSuperadminClient; skip con mensaje accionable si falta).
//
// Cleanup: una sola RPC eliminar_tenant_completo(tenant_id) por tenant.
// Esa RPC desactiva los triggers append-only de auditoria, borra todas
// las tablas con tenant_id en orden topológico, borra el tenant, y
// reactiva los triggers. auth.user queda huérfano (sentinel con
// timestamp para identificación manual si hace falta).

const TIMESTAMP = Date.now();
const SENTINEL_SLUG_A = `e2e-restore-a-${TIMESTAMP}`;
const SENTINEL_SLUG_B = `e2e-restore-b-${TIMESTAMP}`;
const SENTINEL_DUENO_EMAIL_A = `dueno-restore-a-${TIMESTAMP}@e2e-mutante.local`;
const SENTINEL_DUENO_EMAIL_B = `dueno-restore-b-${TIMESTAMP}@e2e-mutante.local`;
const SENTINEL_PASSWORD = `e2e-pwd-${TIMESTAMP}-X9!`;

// Sentinels de data
const PROV_ORIG_A = `Proveedor Original A ${TIMESTAMP}`;
const PROV_ORIG_B = `Proveedor Original B ${TIMESTAMP}`;
const PROV_INTRUSO_1 = `Proveedor Intruso 1 ${TIMESTAMP}`;
const PROV_INTRUSO_2 = `Proveedor Intruso 2 ${TIMESTAMP}`;
const VENTA_MONTO_ORIG = 12345.67;
const VENTA_MONTO_MUTADO = 99999.99;

// Subconjunto de tablas que vamos a snapshotear. El RPC restore_tenant
// borra TODAS las tablas con tenant_id antes de re-insertar, así que si
// omitimos usuarios/locales/tenant_admins el dueño/local del tenant
// quedan vacíos post-restore (lo cual rompería el cleanup). Incluimos
// las raíces de identidad + las tablas donde tenemos sentinels.
const TABLAS_SNAPSHOT = [
  "usuarios",
  "locales",
  "usuario_locales",
  "usuario_permisos",
  "tenant_admins",
  "proveedores",
  "ventas",
];

type TenantInfo = {
  tenantId: string | null;
  usuarioId: number | null;
  localId: number | null;
};

test.describe("Restore tenant — mutante", () => {
  let superdb: SupabaseClient | null = null;
  let superadminToken: string | null = null;
  const a: TenantInfo = { tenantId: null, usuarioId: null, localId: null };
  const b: TenantInfo = { tenantId: null, usuarioId: null, localId: null };

  test.beforeEach(async () => {
    superdb = await createSuperadminClient();
    if (!superdb) {
      test.skip(
        true,
        "SUPERADMIN_PASSWORD no seteado en packages/pase/.env.local. Agregar la línea SUPERADMIN_PASSWORD=<tu_password> al archivo (ya está en gitignore)."
      );
      return;
    }
    const { data: sess } = await superdb.auth.getSession();
    superadminToken = sess?.session?.access_token || null;
    if (!superadminToken) throw new Error("No se obtuvo token superadmin");

    a.tenantId = null;
    a.usuarioId = null;
    a.localId = null;
    b.tenantId = null;
    b.usuarioId = null;
    b.localId = null;
  });

  test.afterEach(async () => {
    if (!superdb) return;

    // Una sola RPC borra todo del tenant en una TX (desactiva triggers
    // append-only de auditoria + DELETE en orden topológico + reactiva).
    for (const t of [a, b]) {
      if (!t.tenantId) continue;
      try {
        const { error } = await superdb.rpc("eliminar_tenant_completo", {
          p_tenant_id: t.tenantId,
        });
        if (error) {
          console.error(`[cleanup] eliminar_tenant_completo(${t.tenantId}): ${error.message}`);
        }
      } catch (e) {
        console.error("[cleanup] rpc eliminar_tenant_completo threw:", e);
      }
    }

    try {
      await superdb.auth.signOut();
    } catch {
      /* idempotente */
    }
  });

  test("backup → mutar → restore: data vuelve al snapshot + anti cross-tenant bloqueado", async ({ request }) => {
    // ── 1. Crear tenant A ───────────────────────────────────────────────
    const respA = await request.post("/api/crear-tenant", {
      data: {
        nombre: `Restore E2E A ${TIMESTAMP}`,
        slug: SENTINEL_SLUG_A,
        plan: "trial",
        dueno_email: SENTINEL_DUENO_EMAIL_A,
        dueno_nombre: `Dueño Restore A ${TIMESTAMP}`,
        dueno_password: SENTINEL_PASSWORD,
        local_nombre: `Local Restore A ${TIMESTAMP}`,
        local_direccion: "Sentinel Restore St 123",
        trial_dias: 7,
      },
      headers: { Authorization: `Bearer ${superadminToken}` },
    });
    expect(respA.status()).toBe(200);
    const bodyA = await respA.json();
    expect(bodyA.ok).toBe(true);
    a.tenantId = bodyA.tenant_id;
    a.usuarioId = bodyA.usuario_id;
    a.localId = bodyA.local_id;
    expect(a.tenantId).toBeTruthy();
    expect(a.localId).toBeTruthy();

    // Safety: nunca operar sobre el tenant Neko productivo.
    const { data: neko } = await superdb!
      .from("tenants")
      .select("id")
      .eq("slug", "neko")
      .maybeSingle();
    if (neko?.id) expect(a.tenantId).not.toBe(neko.id);

    // ── 2. Sembrar data sentinel ────────────────────────────────────────
    const { data: provIns, error: errIns } = await superdb!
      .from("proveedores")
      .insert([
        { nombre: PROV_ORIG_A, saldo: 0, tenant_id: a.tenantId },
        { nombre: PROV_ORIG_B, saldo: 0, tenant_id: a.tenantId },
      ])
      .select("id, nombre");
    expect(errIns, JSON.stringify(errIns)).toBeNull();
    expect(provIns?.length).toBe(2);

    const ventaId = crypto.randomUUID();
    const { data: ventaIns, error: errV } = await superdb!
      .from("ventas")
      .insert({
        id: ventaId,
        local_id: a.localId,
        fecha: new Date().toISOString().slice(0, 10),
        turno: "almuerzo",
        medio: "EFECTIVO",
        monto: VENTA_MONTO_ORIG,
        origen: "e2e-restore",
        tenant_id: a.tenantId,
      })
      .select("id, monto")
      .single();
    expect(errV, JSON.stringify(errV)).toBeNull();
    expect(ventaIns).toBeTruthy();

    // ── 3. Snapshot inline + gzip + upload al bucket ────────────────────
    const tablas: Record<string, unknown[]> = {};
    for (const tbl of TABLAS_SNAPSHOT) {
      const { data, error } = await superdb!
        .from(tbl)
        .select("*")
        .eq("tenant_id", a.tenantId);
      expect(error, `select * from ${tbl}`).toBeNull();
      tablas[tbl] = data || [];
    }

    const backupJson = {
      version: 1,
      tenant_id: a.tenantId,
      tenant_slug: SENTINEL_SLUG_A,
      tenant_nombre: `Restore E2E A ${TIMESTAMP}`,
      created_at: new Date().toISOString(),
      stats: {
        total_filas: Object.values(tablas).reduce((acc, arr) => acc + arr.length, 0),
        total_archivos_storage: 0,
        compresion: "gzip",
      },
      tablas,
      storage_paths: {},
    };

    // Ciclo gzip → gunzip en memoria: valida que el JSON sea serializable
    // y deserializable. Es el mismo round-trip que hace cron+UI vía bucket.
    const gz = gzipSync(Buffer.from(JSON.stringify(backupJson), "utf-8"));
    const backupPath = `${a.tenantId}/e2e-mutante-${TIMESTAMP}.json.gz`;

    // ── 4. Mutar la DB ──────────────────────────────────────────────────
    const provOrigIds = provIns!.map((p) => p.id as number);
    const { error: errDel } = await superdb!
      .from("proveedores")
      .delete()
      .in("id", provOrigIds);
    expect(errDel).toBeNull();

    const { error: errIns2 } = await superdb!.from("proveedores").insert([
      { nombre: PROV_INTRUSO_1, saldo: 0, tenant_id: a.tenantId },
      { nombre: PROV_INTRUSO_2, saldo: 0, tenant_id: a.tenantId },
    ]);
    expect(errIns2).toBeNull();

    const { error: errUpd } = await superdb!
      .from("ventas")
      .update({ monto: VENTA_MONTO_MUTADO })
      .eq("id", ventaId);
    expect(errUpd).toBeNull();

    // Verificar que la mutación efectivamente rompió el estado
    const { data: provMut } = await superdb!
      .from("proveedores")
      .select("nombre")
      .eq("tenant_id", a.tenantId);
    const nombresMut = (provMut || []).map((p) => p.nombre as string);
    expect(nombresMut).not.toContain(PROV_ORIG_A);
    expect(nombresMut).not.toContain(PROV_ORIG_B);
    expect(nombresMut).toContain(PROV_INTRUSO_1);
    expect(nombresMut).toContain(PROV_INTRUSO_2);

    const { data: ventaMut } = await superdb!
      .from("ventas")
      .select("monto")
      .eq("id", ventaId)
      .single();
    expect(Number(ventaMut?.monto)).toBe(VENTA_MONTO_MUTADO);

    // ── 5. Descomprimir el snapshot y llamar restore_tenant ─────────────
    const parsed = JSON.parse(gunzipSync(gz).toString("utf-8"));
    expect(parsed.tenant_id).toBe(a.tenantId);
    expect(parsed.version).toBe(1);

    const { data: rpcResult, error: errRpc } = await superdb!.rpc("restore_tenant", {
      p_tenant_id: a.tenantId,
      p_backup_path: backupPath,
      p_backup_json: parsed,
    });
    expect(errRpc, JSON.stringify(errRpc)).toBeNull();
    const result = rpcResult as { ok: boolean; filas_restauradas: number; filas_borradas: number };
    expect(result.ok).toBe(true);
    expect(result.filas_restauradas).toBeGreaterThan(0);
    expect(result.filas_borradas).toBeGreaterThan(0);

    // ── 6. Asserts post-restore ─────────────────────────────────────────
    const { data: provPost } = await superdb!
      .from("proveedores")
      .select("nombre")
      .eq("tenant_id", a.tenantId);
    const nombresPost = (provPost || []).map((p) => p.nombre as string).sort();
    expect(nombresPost.length).toBe(2);
    expect(nombresPost).toContain(PROV_ORIG_A);
    expect(nombresPost).toContain(PROV_ORIG_B);
    expect(nombresPost).not.toContain(PROV_INTRUSO_1);
    expect(nombresPost).not.toContain(PROV_INTRUSO_2);

    const { data: ventaPost } = await superdb!
      .from("ventas")
      .select("monto")
      .eq("id", ventaId)
      .single();
    expect(Number(ventaPost?.monto)).toBe(VENTA_MONTO_ORIG);

    // Auditoría del restore (fila más nueva con accion='RESTORE_TENANT')
    const { data: audit } = await superdb!
      .from("auditoria")
      .select("accion, tenant_id")
      .eq("tenant_id", a.tenantId)
      .eq("accion", "RESTORE_TENANT")
      .order("fecha", { ascending: false })
      .limit(1);
    expect(audit?.length).toBe(1);
    expect(audit?.[0]?.tenant_id).toBe(a.tenantId);

    // ── 7. Anti cross-tenant: crear B, restaurar A en B → debe bloquear ─
    const respB = await request.post("/api/crear-tenant", {
      data: {
        nombre: `Restore E2E B ${TIMESTAMP}`,
        slug: SENTINEL_SLUG_B,
        plan: "trial",
        dueno_email: SENTINEL_DUENO_EMAIL_B,
        dueno_nombre: `Dueño Restore B ${TIMESTAMP}`,
        dueno_password: SENTINEL_PASSWORD,
        local_nombre: `Local Restore B ${TIMESTAMP}`,
        local_direccion: "Sentinel Restore St 456",
        trial_dias: 7,
      },
      headers: { Authorization: `Bearer ${superadminToken}` },
    });
    expect(respB.status()).toBe(200);
    const bodyB = await respB.json();
    expect(bodyB.ok).toBe(true);
    b.tenantId = bodyB.tenant_id;
    b.usuarioId = bodyB.usuario_id;
    b.localId = bodyB.local_id;
    expect(b.tenantId).toBeTruthy();
    expect(b.tenantId).not.toBe(a.tenantId);

    const { error: errCross } = await superdb!.rpc("restore_tenant", {
      p_tenant_id: b.tenantId,
      p_backup_path: backupPath,
      p_backup_json: parsed,
    });
    expect(errCross).toBeTruthy();
    expect(errCross?.message || "").toContain("CROSS_TENANT_RESTORE_BLOCKED");

    // Confirmar que B no fue tocado (sigue con su local original)
    const { data: localesB } = await superdb!
      .from("locales")
      .select("id, nombre")
      .eq("tenant_id", b.tenantId);
    expect(localesB?.length).toBe(1);
    expect(localesB?.[0]?.nombre).toBe(`Local Restore B ${TIMESTAMP}`);
  });
});
