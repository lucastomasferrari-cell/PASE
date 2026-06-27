// Utilidades.tsx — reparto de utilidades (módulo hermano del Cashflow).
//
// Arriba: "Seguro repartir $X" (verde/rojo) + reservado (CAJA UTILIDADES) +
// ya repartido este mes. Socios editables (% que deberían sumar 100). Reservar
// (apartar plata) y Registrar reparto (split por % → gastos retiro_socio que
// hitean EERR + cashflow). El cálculo vive en el backend (lib/utilidades.ts).

import { useEffect, useMemo, useState } from "react";
import { PageContainer, PageHeader, StatCard, Card, Modal } from "../components/ui";
import { fmt_$, todayAR_ISO } from "../lib/utils";
import { translateRpcError } from "../lib/errors";
import type { Usuario, Local } from "../types/auth";
import {
  listarSocios, guardarSocio, reservar, registrarReparto, anularReparto,
  cuantoRepartir, listarRepartos,
  type Socio, type CuantoRepartir, type Reparto,
} from "../lib/utilidades";

interface Props {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

// Cuentas operativas (origen de una reserva). CAJA UTILIDADES no es origen válido.
const CUENTAS_OPERATIVAS = ["Caja Chica", "Caja Mayor", "Caja Efectivo", "MercadoPago", "Banco"];
// Para un reparto, además se puede repartir directo desde CAJA UTILIDADES (default).
const CUENTAS_REPARTO = ["CAJA UTILIDADES", ...CUENTAS_OPERATIVAS];

const fmtM = (n: number) => `$ ${Math.round(n).toLocaleString("es-AR")}`;

export default function Utilidades({ locales, localActivo }: Props) {
  const [mes, setMes] = useState<string>(() => todayAR_ISO().slice(0, 7));
  const [localSel, setLocalSel] = useState<number | null>(localActivo ?? locales[0]?.id ?? null);
  const [mesesColchon, setMesesColchon] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);

  const lid = localActivo ?? localSel;
  const periodoMes = `${mes}-01`;
  const refresh = () => setRefreshKey((k) => k + 1);

  const [socios, setSocios] = useState<Socio[]>([]);
  const [calc, setCalc] = useState<CuantoRepartir | null>(null);
  const [repartos, setRepartos] = useState<Reparto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [socioEdit, setSocioEdit] = useState<Socio | "nuevo" | null>(null);
  const [reservarOpen, setReservarOpen] = useState(false);
  const [repartoOpen, setRepartoOpen] = useState(false);

  useEffect(() => {
    if (!lid) return;
    let cancel = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true); setError(null);
    Promise.all([
      listarSocios(lid),
      cuantoRepartir(lid, periodoMes, mesesColchon),
      listarRepartos(lid, periodoMes),
    ]).then(([s, c, r]) => {
      if (cancel) return;
      const err = s.error || c.error || r.error;
      if (err) setError(translateRpcError(err));
      setSocios(s.data ?? []);
      setCalc(c.data);
      setRepartos(r.data ?? []);
      setLoading(false);
    });
    return () => { cancel = true; };
  }, [lid, periodoMes, mesesColchon, refreshKey]);

  const sociosActivos = useMemo(() => socios.filter((s) => s.activo), [socios]);
  const sumaPct = useMemo(() => sociosActivos.reduce((a, s) => a + Number(s.porcentaje), 0), [sociosActivos]);

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Utilidades"
        info={<>Cuánto es seguro repartir este mes sin descapitalizarte (plata real − lo que falta pagar − un colchón), y el reparto prolijo entre los socios. Los retiros que registres acá aparecen en el Cashflow y el EERR.</>}
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {localActivo == null && locales.length > 0 && (
              <select value={localSel ?? ""} onChange={(e) => setLocalSel(Number(e.target.value))} style={selStyle}>
                {locales.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
              </select>
            )}
            <input type="month" value={mes} onChange={(e) => setMes(e.target.value)} style={selStyle} />
          </div>
        }
      />

      {!lid && <div style={{ color: "var(--pase-text-muted)", padding: 24 }}>Elegí un local para gestionar las utilidades.</div>}
      {error && <Card padding="md"><div style={{ color: "#B91C1C" }}>{error}</div></Card>}

      {lid && (
        <div style={{ display: "grid", gap: 16, opacity: loading ? 0.6 : 1, transition: "opacity .15s" }}>
          {/* ---- Seguro repartir (headline) ---- */}
          {calc && <SeguroRepartirCard calc={calc} mesesColchon={mesesColchon} onMesesColchon={setMesesColchon} />}

          {/* ---- acciones ---- */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => setReservarOpen(true)}>Reservar a Caja Utilidades</button>
            <button className="btn btn-acc" disabled={sociosActivos.length === 0} onClick={() => setRepartoOpen(true)}
              title={sociosActivos.length === 0 ? "Cargá al menos un socio activo" : ""}>
              Registrar reparto
            </button>
          </div>

          {/* ---- socios ---- */}
          <Card padding="lg">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={cardTitle}>Socios</div>
              <button className="btn" style={btnSm} onClick={() => setSocioEdit("nuevo")}>+ Socio</button>
            </div>
            {sociosActivos.length === 0 && <div style={subMuted}>Todavía no cargaste socios. Agregá los socios y sus % de participación.</div>}
            {socios.filter((s) => s.activo).map((s) => (
              <div key={s.id} style={rowBetween}>
                <span>{s.nombre}</span>
                <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <b style={{ fontVariantNumeric: "tabular-nums" }}>{Number(s.porcentaje).toLocaleString("es-AR")}%</b>
                  <button className="btn" style={btnSm} onClick={() => setSocioEdit(s)}>Editar</button>
                </span>
              </div>
            ))}
            {sociosActivos.length > 0 && (
              <div style={{ ...rowBetween, borderBottom: "none", fontWeight: 500, marginTop: 4 }}>
                <span>Total</span>
                <span style={{ color: Math.abs(sumaPct - 100) < 0.01 ? "var(--pase-celeste)" : "#B45309", fontVariantNumeric: "tabular-nums" }}>
                  {sumaPct.toLocaleString("es-AR")}%{Math.abs(sumaPct - 100) < 0.01 ? "" : " ⚠️ no suma 100%"}
                </span>
              </div>
            )}
          </Card>

          {/* ---- historial ---- */}
          <Card padding="lg">
            <div style={cardTitle}>Repartos del mes</div>
            {repartos.length === 0 && <div style={subMuted}>Sin repartos este mes.</div>}
            {repartos.length > 0 && (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--pase-fs-sm)" }}>
                  <thead>
                    <tr style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-xs)", textAlign: "left" }}>
                      <th style={thCell}>Fecha</th>
                      <th style={thCell}>Detalle</th>
                      <th style={thCell}>Cuenta</th>
                      <th style={{ ...thCell, textAlign: "right" }}>Total</th>
                      <th style={thCell}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {repartos.map((r) => (
                      <tr key={r.id} style={{ borderTop: "0.5px solid var(--pase-border)", opacity: r.anulado ? 0.5 : 1 }}>
                        <td style={tdCell}>{r.fecha.slice(8, 10)}/{r.fecha.slice(5, 7)}</td>
                        <td style={tdCell}>
                          {r.detalle.map((d) => `${d.nombre ?? "?"} ${fmt_$(d.monto)}`).join(" · ") || "—"}
                          {r.anulado && <span style={{ color: "#B91C1C", marginLeft: 6 }}>(anulado)</span>}
                          {r.nota && <div style={subMuted}>{r.nota}</div>}
                        </td>
                        <td style={tdCell}>{r.cuenta_origen}</td>
                        <td style={{ ...tdCell, textAlign: "right", fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{fmt_$(r.total)}</td>
                        <td style={{ ...tdCell, textAlign: "right" }}>
                          {!r.anulado && (
                            <button className="btn" style={btnSm} onClick={() => onAnular(r)}>Anular</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {socioEdit && lid && (
        <SocioModal
          lid={lid} socio={socioEdit === "nuevo" ? null : socioEdit}
          onClose={() => setSocioEdit(null)}
          onDone={() => { setSocioEdit(null); refresh(); }}
        />
      )}
      {reservarOpen && lid && (
        <ReservarModal lid={lid}
          onClose={() => setReservarOpen(false)}
          onDone={() => { setReservarOpen(false); refresh(); }}
        />
      )}
      {repartoOpen && lid && (
        <RepartoModal lid={lid} periodoMes={periodoMes} socios={sociosActivos}
          onClose={() => setRepartoOpen(false)}
          onDone={() => { setRepartoOpen(false); refresh(); }}
        />
      )}
    </PageContainer>
  );

  async function onAnular(r: Reparto) {
    if (!confirm(`Anular el reparto de ${fmt_$(r.total)} del ${r.fecha.slice(8, 10)}/${r.fecha.slice(5, 7)}? Se revierten los retiros generados.`)) return;
    const { error } = await anularReparto(r.id);
    if (error) setError(translateRpcError(error)); else refresh();
  }
}

/* ----------------------------- Seguro repartir ----------------------------- */

function SeguroRepartirCard({ calc, mesesColchon, onMesesColchon }: {
  calc: CuantoRepartir; mesesColchon: number; onMesesColchon: (n: number) => void;
}) {
  const seguro = calc.seguro_repartir;
  const positivo = seguro > 0;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card padding="lg">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={cardTitle}>Seguro repartir</div>
            <div style={{ fontSize: "2rem", fontWeight: 500, fontVariantNumeric: "tabular-nums", color: positivo ? "var(--pase-celeste)" : "#B91C1C" }}>
              {fmtM(seguro)}
            </div>
            <div style={subMuted}>
              {positivo
                ? "Lo que podés repartir hoy sin descapitalizarte."
                : "Hoy no es seguro repartir: te faltaría para cubrir obligaciones + colchón."}
            </div>
          </div>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={subMuted}>Colchón</span>
            <select value={mesesColchon} onChange={(e) => onMesesColchon(Number(e.target.value))} style={selStyle}>
              <option value={0}>Sin colchón</option>
              <option value={1}>1 mes de costos</option>
              <option value={2}>2 meses</option>
              <option value={3}>3 meses</option>
            </select>
          </label>
        </div>

        {/* desglose */}
        <div style={{ marginTop: 14, display: "grid", gap: 2 }}>
          <Row label="Plata total (operativo + reservado)" value={fmt_$(calc.plata_total)} />
          <Row label="− Obligaciones pendientes del mes" value={`− ${fmt_$(calc.obligaciones_pendientes)}`} />
          <Row label={`− Colchón (${calc.meses_colchon} ${calc.meses_colchon === 1 ? "mes" : "meses"})`} value={`− ${fmt_$(calc.colchon)}`} />
          <div style={{ ...rowBetween, borderBottom: "none", fontWeight: 500, borderTop: "0.5px solid var(--pase-border)", marginTop: 4, paddingTop: 8 }}>
            <span>= Seguro repartir</span>
            <span style={{ fontVariantNumeric: "tabular-nums", color: positivo ? "var(--pase-celeste)" : "#B91C1C" }}>{fmt_$(seguro)}</span>
          </div>
        </div>
      </Card>

      <div style={gridCards}>
        <StatCard variant="anchor" label="Reservado (Caja Utilidades)" value={fmtM(calc.reservado)} sub="apartado, listo para repartir" />
        <StatCard label="Ya repartido este mes" value={fmtM(calc.ya_repartido_mes)}
          sub={calc.sobre_distribuido ? "⚠️ más que el seguro: sobre-distribución" : "dentro de lo seguro"} />
      </div>
      {calc.sobre_distribuido && (
        <Card padding="md">
          <span style={{ color: "#B45309" }}>⚠️ Ya repartiste más de lo que era seguro este mes. Cuidado con descapitalizar el negocio.</span>
        </Card>
      )}
    </div>
  );
}

/* ----------------------------- Socio (alta/edición) ----------------------------- */

function SocioModal({ lid, socio, onClose, onDone }: {
  lid: number; socio: Socio | null; onClose: () => void; onDone: () => void;
}) {
  const [nombre, setNombre] = useState(socio?.nombre ?? "");
  const [porcentaje, setPorcentaje] = useState<string>(socio ? String(socio.porcentaje) : "");
  const [activo, setActivo] = useState(socio?.activo ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar() {
    setSaving(true); setError(null);
    const { error } = await guardarSocio({
      localId: lid, id: socio?.id ?? null, nombre, porcentaje: Number(porcentaje) || 0, activo,
    });
    setSaving(false);
    if (error) setError(translateRpcError(error)); else onDone();
  }

  return (
    <Modal isOpen onClose={onClose} title={socio ? "Editar socio" : "Nuevo socio"} preventCloseOnOverlay
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn btn-acc" disabled={saving || !nombre.trim()} onClick={guardar}>{saving ? "Guardando…" : "Guardar"}</button>
        </>
      }>
      <div style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={subMuted}>Nombre</span>
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} style={selStyle} placeholder="ej. Baldi" />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={subMuted}>Participación (%)</span>
          <input type="number" inputMode="decimal" min={0} max={100} value={porcentaje}
            onChange={(e) => setPorcentaje(e.target.value)} style={selStyle} placeholder="0–100" />
        </label>
        {socio && (
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} />
            <span>Activo</span>
          </label>
        )}
        {error && <div style={{ color: "#B91C1C", fontSize: "var(--pase-fs-sm)" }}>{error}</div>}
      </div>
    </Modal>
  );
}

/* ----------------------------- Reservar ----------------------------- */

function ReservarModal({ lid, onClose, onDone }: { lid: number; onClose: () => void; onDone: () => void }) {
  const [cuenta, setCuenta] = useState(CUENTAS_OPERATIVAS[0]!);
  const [monto, setMonto] = useState<string>("");
  const [fecha, setFecha] = useState(() => todayAR_ISO());
  const [idemKey] = useState(() => cryptoRandom());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmar() {
    const m = Number(monto);
    if (!m || m <= 0) { setError("Ingresá un monto válido."); return; }
    setSaving(true); setError(null);
    const { error } = await reservar({ localId: lid, cuentaOrigen: cuenta, monto: m, fecha, idempotencyKey: idemKey });
    setSaving(false);
    if (error) setError(translateRpcError(error)); else onDone();
  }

  return (
    <Modal isOpen onClose={onClose} title="Reservar a Caja Utilidades" subtitle="Apartás plata para repartir más adelante" preventCloseOnOverlay
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn btn-acc" disabled={saving} onClick={confirmar}>{saving ? "Reservando…" : "Reservar"}</button>
        </>
      }>
      <div style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={subMuted}>Desde la cuenta</span>
          <select value={cuenta} onChange={(e) => setCuenta(e.target.value)} style={selStyle}>
            {CUENTAS_OPERATIVAS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={subMuted}>Monto</span>
          <input type="number" inputMode="decimal" min={0} value={monto} onChange={(e) => setMonto(e.target.value)} style={selStyle} placeholder="$" />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={subMuted}>Fecha</span>
          <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} style={selStyle} />
        </label>
        {error && <div style={{ color: "#B91C1C", fontSize: "var(--pase-fs-sm)" }}>{error}</div>}
      </div>
    </Modal>
  );
}

/* ----------------------------- Registrar reparto ----------------------------- */

function RepartoModal({ lid, periodoMes, socios, onClose, onDone }: {
  lid: number; periodoMes: string; socios: Socio[]; onClose: () => void; onDone: () => void;
}) {
  const [total, setTotal] = useState<string>("");
  const [cuenta, setCuenta] = useState(CUENTAS_REPARTO[0]!);
  const [fecha, setFecha] = useState(() => todayAR_ISO());
  const [nota, setNota] = useState("");
  const [montos, setMontos] = useState<Record<string, string>>({});
  const [idemKey] = useState(() => cryptoRandom());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Recalcular el split por % cuando cambia el total.
  function recalcular(totalNum: number) {
    const next: Record<string, string> = {};
    const sumaPct = socios.reduce((a, s) => a + Number(s.porcentaje), 0);
    let acumulado = 0;
    socios.forEach((s, i) => {
      let m: number;
      if (i === socios.length - 1) m = Math.round((totalNum - acumulado) * 100) / 100;
      else {
        m = sumaPct > 0
          ? Math.round((totalNum * Number(s.porcentaje) / sumaPct) * 100) / 100
          : Math.round((totalNum / socios.length) * 100) / 100;
        acumulado += m;
      }
      next[s.id] = m > 0 ? String(m) : "0";
    });
    setMontos(next);
  }

  const sumaMontos = useMemo(
    () => socios.reduce((a, s) => a + (Number(montos[s.id]) || 0), 0),
    [montos, socios],
  );
  const totalNum = Number(total) || 0;
  const cuadra = totalNum > 0 && Math.abs(sumaMontos - totalNum) < 0.01;

  async function confirmar() {
    if (!cuadra) { setError("El reparto por socio tiene que sumar el total."); return; }
    setSaving(true); setError(null);
    const detalle = socios
      .map((s) => ({ socio_id: s.id, monto: Number(montos[s.id]) || 0 }))
      .filter((d) => d.monto > 0);
    const { error } = await registrarReparto({
      localId: lid, fecha, total: totalNum, cuentaOrigen: cuenta,
      periodoRef: periodoMes, nota: nota.trim() || null, detalle, idempotencyKey: idemKey,
    });
    setSaving(false);
    if (error) setError(translateRpcError(error)); else onDone();
  }

  return (
    <Modal isOpen onClose={onClose} title="Registrar reparto" subtitle="Se divide por los % y genera un retiro por socio" preventCloseOnOverlay
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn btn-acc" disabled={saving || !cuadra} onClick={confirmar}>{saving ? "Registrando…" : "Registrar reparto"}</button>
        </>
      }>
      <div style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={subMuted}>Total a repartir</span>
          <input type="number" inputMode="decimal" min={0} value={total}
            onChange={(e) => { setTotal(e.target.value); recalcular(Number(e.target.value) || 0); }} style={selStyle} placeholder="$" />
        </label>

        {socios.length > 0 && (
          <Card padding="md">
            <div style={cardTitle}>Le toca a cada socio</div>
            {socios.map((s) => (
              <div key={s.id} style={{ ...rowBetween, alignItems: "center" }}>
                <span>{s.nombre} <span style={subMuted}>({Number(s.porcentaje).toLocaleString("es-AR")}%)</span></span>
                <input type="number" inputMode="decimal" min={0} value={montos[s.id] ?? ""}
                  onChange={(e) => setMontos((m) => ({ ...m, [s.id]: e.target.value }))}
                  style={{ ...selStyle, width: 130, textAlign: "right" }} />
              </div>
            ))}
            <div style={{ ...rowBetween, borderBottom: "none", fontWeight: 500, marginTop: 4 }}>
              <span>Suma</span>
              <span style={{ color: cuadra ? "var(--pase-celeste)" : "#B45309", fontVariantNumeric: "tabular-nums" }}>
                {fmt_$(sumaMontos)}{cuadra ? "" : ` (≠ ${fmt_$(totalNum)})`}
              </span>
            </div>
          </Card>
        )}

        <label style={{ display: "grid", gap: 4 }}>
          <span style={subMuted}>Desde la cuenta</span>
          <select value={cuenta} onChange={(e) => setCuenta(e.target.value)} style={selStyle}>
            {CUENTAS_REPARTO.map((c) => <option key={c} value={c}>{c === "CAJA UTILIDADES" ? "Caja Utilidades (lo reservado)" : c}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={subMuted}>Fecha</span>
          <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} style={selStyle} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={subMuted}>Nota (opcional)</span>
          <input value={nota} onChange={(e) => setNota(e.target.value)} style={selStyle} placeholder="ej. reparto mayo" />
        </label>
        {error && <div style={{ color: "#B91C1C", fontSize: "var(--pase-fs-sm)" }}>{error}</div>}
      </div>
    </Modal>
  );
}

/* ----------------------------- helpers ----------------------------- */

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={rowBetween}>
      <span style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)" }}>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

function cryptoRandom(): string {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.round(Math.random() * 1e9)}`; }
}

const selStyle: React.CSSProperties = {
  padding: "6px 10px", borderRadius: 8, border: "0.5px solid var(--pase-border)",
  background: "var(--pase-surface)", color: "var(--pase-text)", fontFamily: "var(--pase-font)", fontSize: "var(--pase-fs-sm)",
};
const btnSm: React.CSSProperties = { padding: "3px 10px", fontSize: "var(--pase-fs-xs)" };
const gridCards: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 };
const cardTitle: React.CSSProperties = { fontSize: "var(--pase-fs-sm)", fontWeight: 500, color: "var(--pase-text-muted)", marginBottom: 10 };
const subMuted: React.CSSProperties = { fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginTop: 4 };
const rowBetween: React.CSSProperties = { display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "0.5px solid var(--pase-border)" };
const thCell: React.CSSProperties = { padding: "4px 8px", fontWeight: 400 };
const tdCell: React.CSSProperties = { padding: "5px 8px" };
