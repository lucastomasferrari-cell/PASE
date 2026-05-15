import { useState, useEffect, useMemo, useRef } from "react";
import { db } from "../../lib/supabase";
import { PageHeader } from "../../components/ui";
import type { Usuario, Local } from "../../types";

// Página observatorio (Lucas, 2026-05-14): probar si los webhooks de MP
// traen pagos que el cron actual (release_report + payments/search 30min)
// pierde — específicamente Point Smart, donde el 1/5 faltaron ~$553k.
//
// La página NO toca producción. Solo lee mp_webhooks_test (tabla nueva).
// Si el experimento concluye que webhooks no sirven, borrar tabla + endpoint
// + esta página + entry del sidebar.

interface WebhookRow {
  id: string;
  tenant_id: string | null;
  local_id: number | null;
  mp_credencial_id: number | null;
  received_at: string;
  http_signature_valid: boolean | null;
  http_signature_error: string | null;
  http_request_id: string | null;
  raw_body: unknown;
  mp_topic: string | null;
  mp_action: string | null;
  mp_resource_id: string | null;
  mp_user_id: string | null;
  payment_fetched_at: string | null;
  payment_fetch_status: number | null;
  payment_fetch_error: string | null;
  payment_data: PaymentData | null;
  match_status: string | null;
  match_mp_movimiento_id: string | null;
}

interface PaymentData {
  id?: number | string;
  status?: string;
  status_detail?: string;
  transaction_amount?: number;
  payment_method_id?: string;
  payment_type_id?: string;
  date_created?: string;
  date_approved?: string;
  description?: string;
  point_of_interaction?: { type?: string };
}

interface Props {
  user: Usuario | null;
  locales: Local[];
  localActivo: number | null;
}

const POLL_MS = 5000;
const WEBHOOK_URL = "https://pase-yndx.vercel.app/api/mp-webhook";

const fmtDate = (iso: string | null): string => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const day = String(d.getDate()).padStart(2, "0");
    const mon = String(d.getMonth() + 1).padStart(2, "0");
    const yr = d.getFullYear();
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${day}/${mon}/${yr} ${h}:${m}:${s}`;
  } catch {
    return iso;
  }
};

const fmtMonto = (n: number | undefined | null): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  return "$" + Number(n).toLocaleString("es-AR", { maximumFractionDigits: 2 });
};

const matchBadge = (status: string | null): { label: string; bg: string; color: string } => {
  switch (status) {
    case "already_in_mov":
      return { label: "✓ Ya estaba", bg: "var(--pase-celeste-100)", color: "var(--pase-text)" };
    case "not_in_mov":
      return { label: "★ NUEVO (no estaba)", bg: "#FEF3C7", color: "#92400E" };
    case "mov_check_err":
      return { label: "Error chequeo", bg: "var(--pase-bg-out)", color: "var(--pase-text-muted)" };
    case "no_payment_id":
      return { label: "Sin payment_id", bg: "var(--pase-bg-out)", color: "var(--pase-text-muted)" };
    case "no_credencial":
      return { label: "Sin credencial", bg: "var(--pase-bg-out)", color: "var(--pase-text-muted)" };
    default:
      return { label: status || "—", bg: "var(--pase-bg-out)", color: "var(--pase-text-muted)" };
  }
};

const sigBadge = (valid: boolean | null): { label: string; color: string } => {
  if (valid === true) return { label: "✓ válida", color: "var(--pase-celeste)" };
  if (valid === false) return { label: "✗ inválida", color: "#DC2626" };
  return { label: "no validada", color: "var(--pase-text-muted)" };
};

export default function WebhooksMpTest({ user }: Props) {
  const [rows, setRows] = useState<WebhookRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [filterMatch, setFilterMatch] = useState<"all" | "not_in_mov" | "already_in_mov">("all");
  const [selected, setSelected] = useState<WebhookRow | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<number | null>(null);

  const esAdmin = user?.rol === "dueno" || user?.rol === "admin" || user?.rol === "superadmin";

  const load = async () => {
    let q = db.from("mp_webhooks_test").select("*").order("received_at", { ascending: false }).limit(200);
    if (filterMatch !== "all") q = q.eq("match_status", filterMatch);
    const { data } = await q;
    setRows((data as WebhookRow[]) || []);
    setLoading(false);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [filterMatch]);

  useEffect(() => {
    if (!autoRefresh) {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    pollRef.current = window.setInterval(() => { load(); }, POLL_MS);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, filterMatch]);

  const stats = useMemo(() => {
    let total = 0, nuevos = 0, yaEstaban = 0, sigInvalida = 0;
    for (const r of rows) {
      total++;
      if (r.match_status === "not_in_mov") nuevos++;
      if (r.match_status === "already_in_mov") yaEstaban++;
      if (r.http_signature_valid === false) sigInvalida++;
    }
    return { total, nuevos, yaEstaban, sigInvalida };
  }, [rows]);

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(WEBHOOK_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard puede fallar en HTTP — ignorar */ }
  };

  if (!esAdmin) {
    return <div className="empty">Esta página es solo para dueño/admin/superadmin.</div>;
  }

  return (
    <div>
      <PageHeader
        title="Webhooks MP (prueba)"
        info={
          <>
            Observatorio temporal: cada notificación que MP nos manda al endpoint <code>/api/mp-webhook</code> se guarda
            acá + se cruza contra <code>mp_movimientos</code>. Sirve para ver si webhooks captura pagos que el cron
            actual (release_report + payments/search) pierde — especialmente Point Smart.
            <br/><br/>
            <b>Scope:</b> solo Neko Villa Crespo. Otros locales se ignoran.
          </>
        }
        actions={
          <>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--pase-text-muted)" }}>
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={e => setAutoRefresh(e.target.checked)}
              />
              Auto-refresh ({POLL_MS/1000}s)
            </label>
            <button className="btn btn-sec btn-sm" onClick={() => load()}>Refrescar</button>
          </>
        }
      />

      {/* ─── Instrucciones de configuración ────────────────────────────────── */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-hd">
          <div className="panel-title">Configuración (hacer 1 sola vez)</div>
        </div>
        <div style={{ padding: "12px 16px", fontSize: 12, lineHeight: 1.7 }}>
          <div style={{ marginBottom: 8, color: "var(--pase-text-muted)" }}>
            URL del webhook (copiar y pegar en el panel de MP):
          </div>
          <div style={{
            display: "flex", gap: 8, alignItems: "center", marginBottom: 14,
            padding: "10px 12px", background: "var(--pase-bg-soft)",
            border: "0.5px solid var(--pase-border)", borderRadius: 8,
            fontFamily: "var(--pase-font)", fontSize: 11.5,
          }}>
            <code style={{ flex: 1, overflow: "auto", whiteSpace: "nowrap" }}>{WEBHOOK_URL}</code>
            <button className="btn btn-sec btn-sm" onClick={copyUrl}>
              {copied ? "✓ Copiado" : "Copiar"}
            </button>
          </div>
          <ol style={{ marginLeft: 20, color: "var(--pase-text)" }}>
            <li>Entrar a <a href="https://www.mercadopago.com.ar/developers/panel" target="_blank" rel="noreferrer" style={{ color: "var(--pase-celeste)" }}>panel de MP developer</a> → tu aplicación → <b>Webhooks</b>.</li>
            <li>Configurar URL de producción con la URL de arriba.</li>
            <li>Marcar el evento <b>Pagos</b> (payment).</li>
            <li>Guardar → MP genera una <b>"Clave secreta"</b>. Copiar.</li>
            <li>Setear esa clave como variable de entorno <code>MP_WEBHOOK_SECRET</code> en Vercel (Settings → Environment Variables → Production).</li>
            <li>Redeploy en Vercel para que tome la nueva env var.</li>
            <li>Hacer una venta de prueba en Villa Crespo → debería aparecer abajo en segundos.</li>
          </ol>
          <div style={{ marginTop: 12, padding: "8px 12px", background: "#FEF3C7", borderRadius: 6, fontSize: 11.5, color: "#92400E" }}>
            <b>Nota:</b> mientras <code>MP_WEBHOOK_SECRET</code> NO esté seteada, los webhooks llegan pero no se valida la firma (modo testing). Apenas confirmes que llegan, completá el secret y rechazamos cualquier request no firmado.
          </div>
        </div>
      </div>

      {/* ─── Stats cards ───────────────────────────────────────────────────── */}
      <div className="grid4" style={{ marginBottom: 14 }}>
        <div className="kpi">
          <div className="kpi-label">Webhooks recibidos</div>
          <div className="kpi-value">{stats.total}</div>
          <div className="kpi-sub">últimos 200</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Ya estaban en mp_movimientos</div>
          <div className="kpi-value kpi-success">{stats.yaEstaban}</div>
          <div className="kpi-sub">cron + webhook coinciden</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">★ NUEVOS (no estaban)</div>
          <div className="kpi-value" style={{ color: "#92400E" }}>{stats.nuevos}</div>
          <div className="kpi-sub">webhook trajo algo que el cron no</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Firma inválida</div>
          <div className="kpi-value" style={{ color: stats.sigInvalida > 0 ? "#DC2626" : "var(--pase-text-muted)" }}>
            {stats.sigInvalida}
          </div>
          <div className="kpi-sub">debería ser 0 con secret correcto</div>
        </div>
      </div>

      {/* ─── Filtro ────────────────────────────────────────────────────────── */}
      <div className="pills">
        <div
          className={`pill ${filterMatch === "all" ? "active" : ""}`}
          onClick={() => setFilterMatch("all")}
        >
          Todos ({rows.length})
        </div>
        <div
          className={`pill ${filterMatch === "not_in_mov" ? "active" : ""}`}
          onClick={() => setFilterMatch("not_in_mov")}
          style={{ background: filterMatch === "not_in_mov" ? "#FEF3C7" : undefined }}
        >
          ★ Solo NUEVOS
        </div>
        <div
          className={`pill ${filterMatch === "already_in_mov" ? "active" : ""}`}
          onClick={() => setFilterMatch("already_in_mov")}
        >
          Solo ya estaban
        </div>
      </div>

      {/* ─── Tabla ─────────────────────────────────────────────────────────── */}
      <div className="panel">
        <div className="panel-hd">
          <div className="panel-title">Webhooks recibidos</div>
        </div>
        {loading ? (
          <div className="loading">Cargando...</div>
        ) : rows.length === 0 ? (
          <div className="empty">
            Aún no llegó ningún webhook.
            <br/><br/>
            Si ya configuraste el panel de MP, hacé una venta de prueba en Villa Crespo y refrescá esta página.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Recibido</th>
                <th>Topic / Action</th>
                <th>Payment ID</th>
                <th>Estado MP</th>
                <th style={{ textAlign: "right" }}>Monto</th>
                <th>Tipo / Método</th>
                <th>Cruce con cron</th>
                <th>Firma</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const m = matchBadge(r.match_status);
                const s = sigBadge(r.http_signature_valid);
                const pd = r.payment_data;
                const poiType = pd?.point_of_interaction?.type;
                const isPointSmart = poiType === "POINT" || (typeof poiType === "string" && poiType.includes("POINT"));
                return (
                  <tr key={r.id}>
                    <td className="mono" style={{ whiteSpace: "nowrap" }}>{fmtDate(r.received_at)}</td>
                    <td style={{ fontSize: 11 }}>
                      <div>{r.mp_topic || "—"}</div>
                      {r.mp_action && <div style={{ color: "var(--pase-text-muted)", fontSize: 10 }}>{r.mp_action}</div>}
                    </td>
                    <td className="mono">{r.mp_resource_id || "—"}</td>
                    <td>
                      {pd?.status ? (
                        <span className="badge" style={{
                          background: pd.status === "approved" ? "var(--pase-celeste-100)" : "var(--pase-bg-out)",
                          color: "var(--pase-text)",
                        }}>
                          {pd.status}
                        </span>
                      ) : (
                        <span className="badge b-muted">{r.payment_fetch_status ? `HTTP ${r.payment_fetch_status}` : "—"}</span>
                      )}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>{fmtMonto(pd?.transaction_amount)}</td>
                    <td style={{ fontSize: 11 }}>
                      <div>{pd?.payment_type_id || "—"}</div>
                      <div style={{ color: "var(--pase-text-muted)", fontSize: 10 }}>
                        {pd?.payment_method_id || ""}
                        {isPointSmart && <span style={{ color: "#92400E", fontWeight: 500 }}> · POINT</span>}
                      </div>
                    </td>
                    <td>
                      <span className="badge" style={{ background: m.bg, color: m.color }}>{m.label}</span>
                    </td>
                    <td style={{ fontSize: 10.5, color: s.color }}>{s.label}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => setSelected(r)}>Ver</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ─── Modal detalle ─────────────────────────────────────────────────── */}
      {selected && (
        <div className="overlay" onClick={() => setSelected(null)}>
          <div className="modal" style={{ width: 820 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">Webhook #{selected.id.slice(0, 8)}</div>
              <button className="close-btn" onClick={() => setSelected(null)}>✕</button>
            </div>
            <div className="modal-body">
              <DetailRow label="Recibido" value={fmtDate(selected.received_at)} />
              <DetailRow label="Topic" value={selected.mp_topic || "—"} />
              <DetailRow label="Action" value={selected.mp_action || "—"} />
              <DetailRow label="Resource ID" value={selected.mp_resource_id || "—"} />
              <DetailRow label="Request ID" value={selected.http_request_id || "—"} />
              <DetailRow label="Firma" value={sigBadge(selected.http_signature_valid).label} />
              {selected.http_signature_error && (
                <DetailRow label="Error firma" value={selected.http_signature_error} />
              )}
              <DetailRow label="Cruce" value={matchBadge(selected.match_status).label} />
              {selected.match_mp_movimiento_id && (
                <DetailRow label="mp_movimientos.id" value={selected.match_mp_movimiento_id} mono />
              )}
              <DetailRow label="Fetch payment" value={
                selected.payment_fetch_status
                  ? `HTTP ${selected.payment_fetch_status}`
                  : (selected.payment_fetch_error || "—")
              } />

              <h3 style={{ fontSize: 12, fontWeight: 500, marginTop: 18, marginBottom: 8, color: "var(--pase-text)" }}>
                Raw body (lo que MP envió)
              </h3>
              <JsonBox data={selected.raw_body} />

              {selected.payment_data && (
                <>
                  <h3 style={{ fontSize: 12, fontWeight: 500, marginTop: 18, marginBottom: 8, color: "var(--pase-text)" }}>
                    Payment data (GET /v1/payments/{`{id}`})
                  </h3>
                  <JsonBox data={selected.payment_data} />
                </>
              )}
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={() => setSelected(null)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "5px 0", fontSize: 12, borderBottom: "0.5px solid var(--pase-border)" }}>
      <div style={{ width: 140, color: "var(--pase-text-muted)", flexShrink: 0 }}>{label}</div>
      <div style={{ color: "var(--pase-text)", fontFamily: mono ? "var(--pase-font)" : undefined, wordBreak: "break-all" }}>{value}</div>
    </div>
  );
}

function JsonBox({ data }: { data: unknown }) {
  const text = useMemo(() => {
    try { return JSON.stringify(data, null, 2); }
    catch { return String(data); }
  }, [data]);
  return (
    <pre style={{
      background: "var(--pase-bg-soft)",
      border: "0.5px solid var(--pase-border)",
      borderRadius: 8,
      padding: 12,
      fontSize: 10.5,
      lineHeight: 1.5,
      maxHeight: 320,
      overflow: "auto",
      whiteSpace: "pre-wrap",
      wordBreak: "break-all",
      color: "var(--pase-text)",
      fontFamily: "var(--pase-font)",
    }}>{text}</pre>
  );
}
