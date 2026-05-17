import { useEffect, useState } from "react";
import { db } from "../lib/supabase";
import { PageHeader, EmptyState, LocalLockedChip, LocalSelectorObligatorio } from "../components/ui";
import { toISO, today, fmt_d } from "../lib/utils";
import type { Usuario, Local } from "../types";

/**
 * Pantalla Reservas — agenda diaria por sucursal.
 *
 * Esqueleto 2026-05-17 (Lucas pidió arrancar el sistema). Funcionalidad MVP:
 *   - Listado por día con todas las reservas del local activo
 *   - Crear/editar/cancelar reservas
 *   - Estados: pendiente / confirmada / sentada / cancelada / no_show
 *   - Notas libres + cliente + teléfono + cantidad
 *
 * Lo que NO está en MVP (Fase 2):
 *   - Vista calendario semanal
 *   - Asignación de mesa específica (acoplado a COMANDA)
 *   - Lista de espera con WhatsApp automático
 *   - App pública para que el cliente reserve solo
 *   - Integración TheFork / Google Reservas / Restorando
 *
 * Tabla: `reservas` (migration 202605172100).
 */

interface Reserva {
  id: number;
  tenant_id: string;
  local_id: number;
  created_at: string;
  fecha: string;
  hora_inicio: string | null;
  duracion_min: number;
  cliente_nombre: string;
  cliente_telefono: string | null;
  cliente_email: string | null;
  covers: number;
  estado: "pendiente" | "confirmada" | "sentada" | "cancelada" | "no_show";
  mesa_asignada: string | null;
  notas: string | null;
  origen: string;
}

interface Props {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

const ESTADO_LABELS: Record<Reserva["estado"], string> = {
  pendiente: "Pendiente",
  confirmada: "Confirmada",
  sentada: "Sentada",
  cancelada: "Cancelada",
  no_show: "No vino",
};

const ESTADO_COLORS: Record<Reserva["estado"], string> = {
  pendiente: "#D97706",      // dorado dim
  confirmada: "var(--pase-celeste)",
  sentada: "var(--pase-gold)",
  cancelada: "var(--pase-text-muted)",
  no_show: "#DC2626",
};

export default function Reservas({ user, locales, localActivo }: Props) {
  const [fecha, setFecha] = useState(toISO(today));
  const [localTrabajo, setLocalTrabajo] = useState<number | null>(localActivo);
  const [reservas, setReservas] = useState<Reserva[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<"new" | Reserva | null>(null);

  useEffect(() => { setLocalTrabajo(localActivo); }, [localActivo]);

  async function load() {
    if (!localTrabajo) { setReservas([]); setLoading(false); return; }
    setLoading(true);
    const { data } = await db.from("reservas")
      .select("*")
      .eq("local_id", localTrabajo)
      .eq("fecha", fecha)
      .order("hora_inicio", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
    setReservas((data as Reserva[]) || []);
    setLoading(false);
  }

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [fecha, localTrabajo]);

  async function cambiarEstado(r: Reserva, nuevo: Reserva["estado"]) {
    const updates: Partial<Reserva> = { estado: nuevo };
    if (nuevo === "confirmada") updates["confirmada_at" as keyof Reserva] = new Date().toISOString() as never;
    if (nuevo === "sentada") updates["sentada_at" as keyof Reserva] = new Date().toISOString() as never;
    if (nuevo === "cancelada") updates["cancelada_at" as keyof Reserva] = new Date().toISOString() as never;
    await db.from("reservas").update(updates).eq("id", r.id);
    void load();
  }

  const totalCovers = reservas.filter(r => r.estado !== "cancelada" && r.estado !== "no_show").reduce((s, r) => s + r.covers, 0);
  const pendientes = reservas.filter(r => r.estado === "pendiente").length;
  const confirmadas = reservas.filter(r => r.estado === "confirmada").length;

  return (
    <div style={{ padding: "0 20px" }}>
      <PageHeader
        title="Reservas"
        subtitle="agenda diaria por sucursal"
        info={<>
          Reservas tomadas por teléfono/WhatsApp. Sirve para reservar el slot horario + cantidad de covers — la mesa específica se asigna cuando llega el cliente.<br /><br />
          <strong>Pendiente para Fase 2:</strong> vista calendario semanal, lista de espera con WhatsApp, integración con TheFork/Google Reservas, app pública para que el cliente reserve solo.
        </>}
        actions={
          <>
            <input
              type="date"
              value={fecha}
              onChange={e => setFecha(e.target.value)}
              className="search"
              style={{ width: 150 }}
            />
            <button
              className="btn btn-acc"
              onClick={() => setModal("new")}
              disabled={!localTrabajo}
              title={!localTrabajo ? "Elegí una sucursal" : undefined}
            >
              + Nueva reserva
            </button>
          </>
        }
      />

      {/* Selector de sucursal */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <span style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)" }}>Sucursal:</span>
        {localActivo !== null ? (
          <LocalLockedChip nombre={locales.find(l => l.id === localActivo)?.nombre ?? "—"} />
        ) : (
          <LocalSelectorObligatorio value={localTrabajo} onChange={setLocalTrabajo} locales={locales} />
        )}
      </div>

      {/* Resumen del día */}
      {localTrabajo && (
        <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          <KPI label="Reservas" value={String(reservas.filter(r => r.estado !== "cancelada").length)} />
          <KPI label="Pendientes" value={String(pendientes)} accent={pendientes > 0 ? "#D97706" : undefined} />
          <KPI label="Confirmadas" value={String(confirmadas)} accent={confirmadas > 0 ? "var(--pase-celeste)" : undefined} />
          <KPI label="Total cubiertos" value={String(totalCovers)} />
        </div>
      )}

      {!localTrabajo ? (
        <EmptyState icon="🏪" title="Seleccioná una sucursal" description="Elegí del selector de arriba para ver las reservas." />
      ) : loading ? (
        <div className="loading">Cargando reservas…</div>
      ) : reservas.length === 0 ? (
        <EmptyState
          icon="📅"
          title={`Sin reservas para ${fmt_d(fecha)}`}
          description="Cargá la primera con el botón + Nueva reserva."
          cta={<button className="btn btn-acc" onClick={() => setModal("new")}>+ Nueva reserva</button>}
        />
      ) : (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th style={{ width: 80 }}>Hora</th>
                <th>Cliente</th>
                <th>Tel</th>
                <th style={{ textAlign: "center", width: 70 }}>Covers</th>
                <th>Mesa</th>
                <th>Notas</th>
                <th style={{ width: 110 }}>Estado</th>
                <th style={{ width: 60 }}></th>
              </tr>
            </thead>
            <tbody>{reservas.map(r => (
              <tr key={r.id} style={{ opacity: r.estado === "cancelada" || r.estado === "no_show" ? 0.5 : 1 }}>
                <td style={{ fontVariantNumeric: "tabular-nums", color: "var(--pase-text-muted)" }}>
                  {r.hora_inicio?.slice(0, 5) || <span style={{ fontStyle: "italic" }}>—</span>}
                </td>
                <td style={{ fontWeight: 500 }}>{r.cliente_nombre}</td>
                <td style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)" }}>{r.cliente_telefono || "—"}</td>
                <td style={{ textAlign: "center", fontWeight: 500 }}>{r.covers}</td>
                <td style={{ fontSize: "var(--pase-fs-sm)" }}>{r.mesa_asignada || "—"}</td>
                <td style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.notas || undefined}>
                  {r.notas || "—"}
                </td>
                <td>
                  <select
                    value={r.estado}
                    onChange={e => cambiarEstado(r, e.target.value as Reserva["estado"])}
                    className="search"
                    style={{
                      fontSize: "var(--pase-fs-xs)", height: 26, padding: "0 8px",
                      color: ESTADO_COLORS[r.estado], fontWeight: 500,
                      borderColor: ESTADO_COLORS[r.estado],
                    }}
                  >
                    {(Object.keys(ESTADO_LABELS) as Reserva["estado"][]).map(e =>
                      <option key={e} value={e}>{ESTADO_LABELS[e]}</option>
                    )}
                  </select>
                </td>
                <td>
                  <button className="btn btn-ghost btn-sm" onClick={() => setModal(r)} style={{ fontSize: "var(--pase-fs-sm)" }}>
                    Editar
                  </button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {modal && localTrabajo && (
        <ReservaModal
          modal={modal}
          tenantId={user.tenant_id!}
          localId={localTrabajo}
          fechaDefault={fecha}
          createdBy={user.id}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); void load(); }}
        />
      )}
    </div>
  );
}

function KPI({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="panel" style={{ padding: "10px 14px", flex: 1, minWidth: 140 }}>
      <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: "var(--pase-fs-xl)", fontWeight: 500, color: accent || "var(--pase-text)" }}>{value}</div>
    </div>
  );
}

// ─── Modal Nueva/Editar Reserva ────────────────────────────────────────

interface ReservaModalProps {
  modal: "new" | Reserva;
  tenantId: string;
  localId: number;
  fechaDefault: string;
  createdBy: number;
  onClose: () => void;
  onSaved: () => void;
}

function ReservaModal({ modal, tenantId, localId, fechaDefault, createdBy, onClose, onSaved }: ReservaModalProps) {
  const editing = modal !== "new" ? modal : null;
  const [form, setForm] = useState({
    fecha: editing?.fecha || fechaDefault,
    hora_inicio: editing?.hora_inicio || "",
    cliente_nombre: editing?.cliente_nombre || "",
    cliente_telefono: editing?.cliente_telefono || "",
    cliente_email: editing?.cliente_email || "",
    covers: editing?.covers || 2,
    mesa_asignada: editing?.mesa_asignada || "",
    notas: editing?.notas || "",
    origen: editing?.origen || "manual",
    duracion_min: editing?.duracion_min || 90,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function guardar() {
    if (!form.cliente_nombre.trim() || form.covers < 1) return;
    setSaving(true);
    setErr(null);
    const payload = {
      tenant_id: tenantId,
      local_id: localId,
      created_by: createdBy,
      fecha: form.fecha,
      hora_inicio: form.hora_inicio || null,
      duracion_min: form.duracion_min,
      cliente_nombre: form.cliente_nombre.trim(),
      cliente_telefono: form.cliente_telefono.trim() || null,
      cliente_email: form.cliente_email.trim() || null,
      covers: form.covers,
      mesa_asignada: form.mesa_asignada.trim() || null,
      notas: form.notas.trim() || null,
      origen: form.origen,
    };
    const res = editing
      ? await db.from("reservas").update(payload).eq("id", editing.id)
      : await db.from("reservas").insert(payload);
    if (res.error) { setErr(res.error.message); setSaving(false); return; }
    setSaving(false);
    onSaved();
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 560 }} onClick={e => e.stopPropagation()}>
        <div className="modal-hd">
          <div className="modal-title">{editing ? "Editar reserva" : "Nueva reserva"}</div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {err && <div className="alert alert-danger">{err}</div>}

          <div className="form2">
            <div className="field"><label>Fecha *</label>
              <input type="date" value={form.fecha} onChange={e => setForm({ ...form, fecha: e.target.value })} />
            </div>
            <div className="field"><label>Hora <span style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-xs)" }}>(vacío = lista de espera)</span></label>
              <input type="time" value={form.hora_inicio} onChange={e => setForm({ ...form, hora_inicio: e.target.value })} />
            </div>
          </div>

          <div className="form2">
            <div className="field"><label>Cliente *</label>
              <input value={form.cliente_nombre} onChange={e => setForm({ ...form, cliente_nombre: e.target.value })} placeholder="Nombre y apellido" />
            </div>
            <div className="field"><label>Teléfono</label>
              <input value={form.cliente_telefono} onChange={e => setForm({ ...form, cliente_telefono: e.target.value })} placeholder="11 1234-5678" />
            </div>
          </div>

          <div className="form2">
            <div className="field"><label>Email (opcional)</label>
              <input type="email" value={form.cliente_email} onChange={e => setForm({ ...form, cliente_email: e.target.value })} />
            </div>
            <div className="field"><label>Cubiertos *</label>
              <input type="number" min={1} max={50} value={form.covers} onChange={e => setForm({ ...form, covers: parseInt(e.target.value) || 1 })} />
            </div>
          </div>

          <div className="form2">
            <div className="field"><label>Origen</label>
              <select value={form.origen} onChange={e => setForm({ ...form, origen: e.target.value })}>
                <option value="manual">Teléfono / Manual</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="instagram">Instagram</option>
                <option value="web_publica">Web pública</option>
                <option value="otro">Otro</option>
              </select>
            </div>
            <div className="field"><label>Duración estimada (min)</label>
              <input type="number" min={30} max={300} step={15} value={form.duracion_min} onChange={e => setForm({ ...form, duracion_min: parseInt(e.target.value) || 90 })} />
            </div>
          </div>

          <div className="field"><label>Mesa asignada (opcional)</label>
            <input value={form.mesa_asignada} onChange={e => setForm({ ...form, mesa_asignada: e.target.value })} placeholder="ej. Mesa 4 o Ventana" />
          </div>

          <div className="field"><label>Notas (alergias, cumpleaños, preferencias)</label>
            <input value={form.notas} onChange={e => setForm({ ...form, notas: e.target.value })} placeholder="ej. cumpleaños cliente, alérgico al maní" maxLength={500} />
          </div>
        </div>
        <div className="modal-ft">
          <button className="btn btn-sec" onClick={onClose}>Cancelar</button>
          <button className="btn btn-acc" onClick={guardar} disabled={saving || !form.cliente_nombre.trim()}>
            {saving ? "Guardando…" : editing ? "Guardar cambios" : "Crear reserva"}
          </button>
        </div>
      </div>
    </div>
  );
}
