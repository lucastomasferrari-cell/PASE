import { CurrencyInput } from "../../components/CurrencyInput";
import type { Local } from "../../types";
import type { Proveedor } from "../../types/finanzas";
import type { FormRemito } from "./types";

interface ModalCargarRemitoProps {
  abierto: boolean;
  onClose: () => void;
  form: FormRemito;
  setForm: React.Dispatch<React.SetStateAction<FormRemito>>;
  proveedores: Proveedor[];
  localesDisp: Local[];
  categoriasCompra: string[];
  onProvChange: (prov_id: string) => void;
  guardar: () => void;
}

// Modal "Nuevo Remito Valorado": compras informales sin factura. Si
// llega la factura después se vincula via ModalVincularRemito; si no
// llega, se paga directo via ModalPagarRemitoDirecto.
export function ModalCargarRemito({
  abierto, onClose, form, setForm, proveedores, localesDisp,
  categoriasCompra, onProvChange, guardar,
}: ModalCargarRemitoProps) {
  if (!abierto) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Nuevo Remito Valorado</div><button className="close-btn" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="alert alert-info">Para compras informales. Si llega factura, la vinculás. Si no llega, pagás directo.</div>
          <div className="form2">
            <div className="field"><label>Proveedor</label><select value={form.prov_id} onChange={e => onProvChange(e.target.value)}><option value="">Sin proveedor</option>{proveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></div>
            <div className="field"><label>Local *</label><select value={form.local_id} onChange={e => setForm({ ...form, local_id: e.target.value })}><option value="">Seleccioná...</option>{localesDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}</select></div>
          </div>
          <div className="form2">
            <div className="field"><label>Nº Remito (opcional)</label><input value={form.nro} onChange={e => setForm({ ...form, nro: e.target.value })} placeholder="Se genera automático" /></div>
            <div className="field"><label>Categoría EERR</label><select value={form.cat} onChange={e => setForm({ ...form, cat: e.target.value })}><option value="">Seleccioná...</option>{categoriasCompra.map(c => <option key={c}>{c}</option>)}</select></div>
          </div>
          <div className="form2">
            <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e => setForm({ ...form, fecha: e.target.value })} /></div>
            <div className="field"><label>Monto *</label><CurrencyInput value={form.monto} onChange={v => setForm({ ...form, monto: v })} aria-label="Monto del remito" /></div>
          </div>
          <div className="field"><label>Descripción / Folio</label><input value={form.detalle} onChange={e => setForm({ ...form, detalle: e.target.value })} placeholder="Folio 1234 - Detalle..." /></div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={onClose}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Confirmar</button></div>
      </div>
    </div>
  );
}
