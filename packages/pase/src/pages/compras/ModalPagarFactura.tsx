import { fmt_d, fmt_$ } from "../../lib/utils";
import { CurrencyInput } from "../../components/CurrencyInput";
import type { Factura, PagoFactura } from "../../types/finanzas";

interface ModalPagarFacturaProps {
  pagarModal: Factura | null;
  setPagarModal: React.Dispatch<React.SetStateAction<Factura | null>>;
  facturas: Factura[];
  ncsAplicar: Record<string, number>;
  setNcsAplicar: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  pagoForm: { cuenta: string; monto: number; fecha: string };
  setPagoForm: React.Dispatch<React.SetStateAction<{ cuenta: string; monto: number; fecha: string }>>;
  cuentasUsables: string[];
  pagar: () => Promise<void>;
  pagando: boolean;
}

// Modal "Registrar pago" sobre una factura. Soporta aplicar Notas de
// Crédito disponibles del mismo proveedor (rebajan el saldo a pagar)
// + pago en plata por el restante. Extraído de Compras.tsx en F9
// (2026-05-11).
export function ModalPagarFactura({
  pagarModal, setPagarModal, facturas, ncsAplicar, setNcsAplicar,
  pagoForm, setPagoForm, cuentasUsables, pagar, pagando,
}: ModalPagarFacturaProps) {
  if (!pagarModal) return null;
  const f = pagarModal;
  // Ya pagado de la factura (incluye aplicaciones de NC previas — el
  // RPC las agrega al array pagos con tipo='nc').
  const yaPagado = (f.pagos || []).reduce((s: number, p: PagoFactura) => s + Number(p.monto || 0), 0);
  const saldoFactura = Math.max(0, Number(f.total || 0) - yaPagado);
  // NCs disponibles del proveedor: filas tipo='nota_credito', estado
  // distinto de pagada/anulada (las consumidas pasaron a 'pagada'),
  // y con saldo > 0. saldo = abs(total) - sum(pagos[]).
  const ncsDisponibles = facturas
    .filter(x => (x.tipo || "factura") === "nota_credito")
    .filter(x => String(x.prov_id) === String(f.prov_id))
    .filter(x => x.estado !== "anulada" && x.estado !== "pagada")
    .map(x => {
      const aplicado = (x.pagos || []).reduce((s: number, p: PagoFactura) => s + Number(p.monto || 0), 0);
      const saldoNc = Math.max(0, Math.abs(Number(x.total || 0)) - aplicado);
      return { nc: x, saldoNc };
    })
    .filter(x => x.saldoNc > 0);
  const totalNcAplicado = Object.values(ncsAplicar).reduce((s, m) => s + (Number(m) || 0), 0);
  const restanteAPagar = Math.max(0, saldoFactura - totalNcAplicado);
  const cerrar = () => { setPagarModal(null); setNcsAplicar({}); };

  return (
    <div className="overlay" onClick={cerrar}>
      <div className="modal" style={{ width: 540 }} onClick={e => e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Registrar Pago</div><button className="close-btn" onClick={cerrar}>✕</button></div>
        <div className="modal-body">
          <div className="alert alert-info">
            {f.nro} · Total: {fmt_$(f.total)}
            {yaPagado > 0 && <span style={{ marginLeft: 8, fontSize: 11 }}>· Ya pagado: <strong>{fmt_$(yaPagado)}</strong> · Saldo: <strong style={{ color: "var(--warn)" }}>{fmt_$(saldoFactura)}</strong></span>}
          </div>

          {ncsDisponibles.length > 0 && (
            <div style={{ marginBottom: 12, padding: 12, background: "var(--s2)", border: "1px solid var(--bd2)", borderRadius: "var(--r)" }}>
              <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: "var(--info)", marginBottom: 8, fontWeight: 600 }}>
                Notas de crédito disponibles ({ncsDisponibles.length})
              </div>
              {ncsDisponibles.map(({ nc, saldoNc }) => {
                const aplicado = ncsAplicar[nc.id] || 0;
                const maxAplicable = Math.min(saldoNc, saldoFactura - (totalNcAplicado - aplicado));
                const checked = aplicado > 0;
                return (
                  <div key={nc.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 11 }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={e => {
                        if (e.target.checked) setNcsAplicar({ ...ncsAplicar, [nc.id]: maxAplicable });
                        else { const next = { ...ncsAplicar }; delete next[nc.id]; setNcsAplicar(next); }
                      }}
                      style={{ accentColor: "var(--info)" }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500 }}>NC #{nc.nro}</div>
                      <div style={{ fontSize: 10, color: "var(--muted2)" }}>{fmt_d(nc.fecha)} · saldo disponible {fmt_$(saldoNc)}</div>
                    </div>
                    {checked && (
                      <div style={{ width: 130 }}>
                        <CurrencyInput
                          value={aplicado}
                          onChange={v => {
                            const clamped = Math.min(Math.max(0, v), saldoNc, saldoFactura - (totalNcAplicado - aplicado));
                            setNcsAplicar({ ...ncsAplicar, [nc.id]: clamped });
                          }}
                          aria-label={`Monto a aplicar de NC ${nc.nro}`}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
              {totalNcAplicado > 0 && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed var(--bd2)", fontSize: 11, color: "var(--info)" }}>
                  Aplicado en NCs: <strong>{fmt_$(totalNcAplicado)}</strong>
                </div>
              )}
            </div>
          )}

          {restanteAPagar > 0 ? (
            <>
              <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 8 }}>
                Resta pagar con plata: <strong style={{ color: "var(--warn)" }}>{fmt_$(restanteAPagar)}</strong>
              </div>
              <div className="field"><label>Cuenta de egreso *</label><select value={pagoForm.cuenta} onChange={e => setPagoForm({ ...pagoForm, cuenta: e.target.value })}><option value="">Seleccioná una cuenta…</option>{cuentasUsables.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
              <div className="field"><label>Monto a pagar</label><CurrencyInput value={pagoForm.monto || restanteAPagar} onChange={v => setPagoForm({ ...pagoForm, monto: v })} aria-label="Monto del pago" /></div>
            </>
          ) : totalNcAplicado > 0 ? (
            <div className="alert" style={{ background: "rgba(34,197,94,0.1)", border: "1px solid var(--success)", color: "var(--success)", fontSize: 11, padding: "10px 12px", marginBottom: 12 }}>
              Las NCs cubren el total de la factura. No hace falta pago en plata.
            </div>
          ) : null}
          <div className="field"><label>Fecha</label><input type="date" value={pagoForm.fecha} onChange={e => setPagoForm({ ...pagoForm, fecha: e.target.value })} /></div>
        </div>
        <div className="modal-ft">
          <button className="btn btn-sec" onClick={cerrar}>Cancelar</button>
          <button className="btn btn-success" onClick={pagar} disabled={pagando || (restanteAPagar > 0 && !pagoForm.cuenta && totalNcAplicado === 0)}>
            {pagando ? "Procesando..." : "Confirmar Pago"}
          </button>
        </div>
      </div>
    </div>
  );
}
