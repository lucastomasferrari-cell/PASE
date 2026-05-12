import { CurrencyInput } from "../../components/CurrencyInput";
import { fmt_$ } from "../../lib/utils";
import type { Remito, FormPagoRemito } from "./types";

interface ModalPagarRemitoDirectoProps {
  remito: Remito | null;
  onClose: () => void;
  form: FormPagoRemito;
  setForm: React.Dispatch<React.SetStateAction<FormPagoRemito>>;
  cuentasUsables: string[];
  pagar: () => void;
  pagando: boolean;
}

// Modal para pagar un remito sin factura. El gasto impacta directo en
// caja y EERR — la conciliación fiscal queda como deuda (no llegó
// comprobante). Usado para compras informales que nunca facturan.
export function ModalPagarRemitoDirecto({
  remito, onClose, form, setForm, cuentasUsables, pagar, pagando,
}: ModalPagarRemitoDirectoProps) {
  if (!remito) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 420 }} onClick={e => e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Pagar Remito Directo</div><button className="close-btn" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="alert alert-info">Remito {remito.nro} · {fmt_$(remito.monto)}</div>
          <div className="alert alert-warn">Esto registra el pago sin factura. El gasto impacta en caja y en el EERR.</div>
          <div className="field"><label>Cuenta de egreso *</label><select value={form.cuenta} onChange={e => setForm({ ...form, cuenta: e.target.value })}><option value="">Seleccioná una cuenta…</option>{cuentasUsables.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
          <div className="field"><label>Monto</label><CurrencyInput value={form.monto} onChange={v => setForm({ ...form, monto: v })} aria-label="Monto del pago al remito" /></div>
          <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e => setForm({ ...form, fecha: e.target.value })} /></div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={onClose}>Cancelar</button><button className="btn btn-success" onClick={pagar} disabled={pagando || !form.cuenta}>{pagando ? "Procesando..." : "Confirmar Pago"}</button></div>
      </div>
    </div>
  );
}
