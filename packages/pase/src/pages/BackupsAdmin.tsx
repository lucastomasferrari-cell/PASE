// Tab "Backups" del módulo superadmin Tenants. Lista los archivos del
// bucket tenant-backups por tenant, permite descargar (signed URL) y
// restaurar (doble confirmación → RPC restore_tenant).
//
// El bucket está protegido por RLS estricta superadmin (migration
// 202604281500_tenant_backups_bucket.sql). Cualquier llamada desde un
// usuario no-superadmin va a fallar con permission denied.

import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { translateRpcError } from "../lib/errors";
import { Modal } from "../components/ui";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";
import type { Tenant } from "../types";

interface BackupsAdminProps {
  tenants: Tenant[];
}

interface BackupFile {
  path: string;       // <tenant_id>/YYYY-MM-DD.json.gz
  fechaIso: string;   // YYYY-MM-DD
  size: number;       // bytes
  updatedAt: string;  // metadata.updated_at del bucket
}

const BUCKET = "tenant-backups";

const fmtMB = (bytes: number) => {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
};

const antiguedad = (fechaIso: string): { texto: string; nivel: "ok" | "warn" | "danger" } => {
  if (!fechaIso) return { texto: "—", nivel: "danger" };
  const ahora = new Date();
  const cuando = new Date(fechaIso + "T07:00:00Z"); // 04:00 ART = 07:00 UTC
  const horas = Math.floor((ahora.getTime() - cuando.getTime()) / (1000 * 3600));
  if (horas < 0) return { texto: "futuro?", nivel: "warn" };
  if (horas < 26) return { texto: "hace " + horas + "h", nivel: "ok" };
  if (horas < 24 * 3) return { texto: "hace " + Math.floor(horas / 24) + "d " + (horas % 24) + "h", nivel: "warn" };
  return { texto: "hace " + Math.floor(horas / 24) + " días", nivel: "danger" };
};

export default function BackupsAdmin({ tenants }: BackupsAdminProps) {
  const tenantsActivos = tenants.filter(t => t.activo);
  const [tenantId, setTenantId] = useState<string>(tenantsActivos[0]?.id || "");
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [restoreStep, setRestoreStep] = useState<{ file: BackupFile; step: 1 | 2; confirmText: string } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const { toast, showError } = useToast();

  const tenant = tenants.find(t => t.id === tenantId) || null;

  const loadBackups = async () => {
    if (!tenantId) return;
    setLoading(true); setErr(null);
    const { data, error } = await db.storage.from(BUCKET).list(tenantId + "/", {
      limit: 100,
      sortBy: { column: "name", order: "desc" },
    });
    if (error) {
      setErr("No se pudo listar el bucket: " + error.message);
      setBackups([]);
      setLoading(false);
      return;
    }
    const files: BackupFile[] = (data || [])
      .filter(f => f.name && f.name.endsWith(".json.gz"))
      .map(f => {
        const fechaIso = (f.name || "").replace(".json.gz", "");
        const size = (f as { metadata?: { size?: number } }).metadata?.size || 0;
        return {
          path: tenantId + "/" + f.name,
          fechaIso,
          size,
          updatedAt: f.updated_at || f.created_at || "",
        };
      })
      .sort((a, b) => b.fechaIso.localeCompare(a.fechaIso));
    setBackups(files);
    setLoading(false);
  };

  // Patrón fetch-on-dep-change: loadBackups hace setState async post-fetch.
  // No agregar loadBackups a deps (se recrea cada render → re-fetch infinito).
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { loadBackups(); }, [tenantId]);

  const descargar = async (file: BackupFile) => {
    const { data, error } = await db.storage.from(BUCKET).createSignedUrl(file.path, 60);
    if (error || !data) {
      showError("No se pudo generar URL de descarga: " + (error?.message || ""));
      return;
    }
    // Forzar descarga vía link efímero. El browser respeta el filename del path.
    const a = document.createElement("a");
    a.href = data.signedUrl;
    a.download = file.path.split("/").pop() || "backup.json.gz";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const empezarRestore = (file: BackupFile) => {
    setRestoreStep({ file, step: 1, confirmText: "" });
  };

  const cancelarRestore = () => {
    setRestoreStep(null);
    setRestoring(false);
  };

  const ejecutarRestore = async () => {
    if (!restoreStep || !tenant) return;
    setRestoring(true);
    try {
      const { data: blob, error: dlErr } = await db.storage.from(BUCKET).download(restoreStep.file.path);
      if (dlErr || !blob) throw new Error("Descarga falló: " + (dlErr?.message || "blob vacío"));

      // Descomprimir gzip browser-side via DecompressionStream (Web API,
      // soporte universal en browsers modernos).
      const decompressed = new Response(blob.stream().pipeThrough(new DecompressionStream("gzip")));
      const text = await decompressed.text();
      let backupJson: unknown;
      try { backupJson = JSON.parse(text); }
      catch (e) { throw new Error("JSON inválido del backup: " + (e as Error).message); }

      const { error: rpcErr } = await db.rpc("restore_tenant", {
        p_tenant_id: tenant.id,
        p_backup_path: restoreStep.file.path,
        p_backup_json: backupJson,
      });
      if (rpcErr) throw rpcErr;

      setFlash("Tenant " + tenant.nombre + " restaurado al backup del " + restoreStep.file.fechaIso + ".");
      setTimeout(() => setFlash(null), 8000);
      cancelarRestore();
      loadBackups();
    } catch (e) {
      showError("Restore falló: " + translateRpcError(e));
      setRestoring(false);
    }
  };

  const ultimo = backups[0];
  const ultimoEstado = ultimo ? antiguedad(ultimo.fechaIso) : null;

  if (tenantsActivos.length === 0) {
    return <div className="empty">No hay tenants activos. Creá uno desde la tab "Tenants".</div>;
  }

  return (
    <div>
      {flash && <div className="alert alert-success" style={{ marginBottom: 16 }}>{flash}</div>}

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: "var(--muted2)" }}>Tenant:</label>
        <select className="search" value={tenantId} onChange={e => setTenantId(e.target.value)} style={{ width: 240 }}>
          {tenantsActivos.map(t => <option key={t.id} value={t.id}>{t.nombre}</option>)}
        </select>
        <button className="btn btn-ghost btn-sm" onClick={loadBackups} disabled={loading}>
          {loading ? "Cargando..." : "↻ Refrescar"}
        </button>
        {ultimo && ultimoEstado && (
          <div style={{ marginLeft: "auto", fontSize: 12 }}>
            Último backup:&nbsp;
            <span className={"badge " + (ultimoEstado.nivel === "ok" ? "b-success" : ultimoEstado.nivel === "warn" ? "b-warn" : "b-danger")}>
              {ultimo.fechaIso} · {ultimoEstado.texto}
            </span>
          </div>
        )}
      </div>

      {err && <div className="alert alert-danger" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="panel">
        {loading ? (
          <div className="loading">Cargando...</div>
        ) : backups.length === 0 ? (
          <div className="empty">
            Sin backups aún para este tenant. El cron diario corre a las 04:00 ART (07:00 UTC).
            <br />
            <span style={{ fontSize: 11, color: "var(--muted2)" }}>
              Para disparar uno manualmente: <code>GET /api/backup-tenants?action=export&amp;cron_secret=...</code>
            </span>
          </div>
        ) : (
          <table>
            <thead><tr>
              <th>Fecha del backup</th>
              <th>Antigüedad</th>
              <th style={{ textAlign: "right" }}>Tamaño</th>
              <th>Path</th>
              <th></th>
            </tr></thead>
            <tbody>
              {backups.map(f => {
                const ant = antiguedad(f.fechaIso);
                return (
                  <tr key={f.path}>
                    <td className="mono">{f.fechaIso}</td>
                    <td>
                      <span className={"badge " + (ant.nivel === "ok" ? "b-success" : ant.nivel === "warn" ? "b-warn" : "b-danger")}>
                        {ant.texto}
                      </span>
                    </td>
                    <td style={{ textAlign: "right" }} className="num">{fmtMB(f.size)}</td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--muted2)" }}>{f.path}</td>
                    <td>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => descargar(f)}>Descargar</button>
                        <button className="btn btn-danger btn-sm" onClick={() => empezarRestore(f)}>Restaurar</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* AUDIT F4B#1 / sprint #5: migrado a <Modal> compartido. */}
      {/* Modal 1: warning */}
      <Modal
        isOpen={!!(restoreStep && restoreStep.step === 1 && tenant)}
        onClose={cancelarRestore}
        title="⚠ Restaurar backup"
        maxWidth={520}
        footer={
          <>
            <button className="btn btn-sec" onClick={cancelarRestore}>Cancelar</button>
            <button className="btn btn-danger" onClick={() => restoreStep && setRestoreStep({ ...restoreStep, step: 2 })}>
              Continuar
            </button>
          </>
        }
      >
        {restoreStep && tenant && (
          <>
            <p>
              Vas a <strong>BORRAR toda la data actual</strong> del tenant <strong>{tenant.nombre}</strong> y
              reemplazarla por el backup del <strong>{restoreStep.file.fechaIso}</strong>.
            </p>
            <p style={{ color: "var(--danger)", fontSize: 13 }}>
              Esta acción <strong>no se puede deshacer</strong>. El restore es atómico: si falla, queda rollback
              automático. Si tiene éxito, los datos posteriores al backup se pierden.
            </p>
            <p style={{ fontSize: 12, color: "var(--muted2)" }}>
              Los archivos del Storage (facturas, blindaje, rrhh-documentos) <strong>NO se restauran</strong>:
              el restore solo cubre data relacional. Los binarios quedan como están.
            </p>
          </>
        )}
      </Modal>

      {toast && <ToastComponent toast={toast} />}
      {/* Modal 2: confirmación por texto */}
      <Modal
        isOpen={!!(restoreStep && restoreStep.step === 2 && tenant)}
        onClose={cancelarRestore}
        title="Confirmación final"
        maxWidth={520}
        preventCloseOnOverlay={restoring}
        footer={
          <>
            <button className="btn btn-sec" onClick={cancelarRestore} disabled={restoring}>Cancelar</button>
            <button
              className="btn btn-danger"
              onClick={ejecutarRestore}
              disabled={restoring || !tenant || restoreStep?.confirmText !== tenant.nombre}
            >
              {restoring ? "Restaurando..." : "Restaurar (definitivo)"}
            </button>
          </>
        }
      >
        {restoreStep && tenant && (
          <>
            <p>Para confirmar, escribí el nombre exacto del tenant:</p>
            <p className="mono" style={{ fontSize: 14, fontWeight: 500 }}>{tenant.nombre}</p>
            <input
              type="text"
              value={restoreStep.confirmText}
              onChange={e => setRestoreStep({ ...restoreStep, confirmText: e.target.value })}
              disabled={restoring}
              autoFocus
              style={{ width: "100%", marginTop: 8 }}
            />
            {restoring && (
              <div style={{ marginTop: 12, color: "var(--muted)", fontSize: 12 }}>
                Restaurando... esto puede tardar varios segundos según el tamaño.
              </div>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
