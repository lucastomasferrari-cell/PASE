import { CurrencyInput } from "../../components/CurrencyInput";
import { LocalLockedChip, LocalSelectorObligatorio, Modal } from "../../components/ui";
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
  /** localActivo del sidebar — si !== null, sucursal viene LOCKED (chip 🔒). */
  localActivo: number | null;
  categoriasCompra: string[];
  onProvChange: (prov_id: string) => void;
  guardar: () => void;
}

// Modal "Nuevo Remito Valorado": compras informales sin factura. Si
// llega la factura después se vincula via ModalVincularRemito; si no
// llega, se paga directo via ModalPagarRemitoDirecto.
export function ModalCargarRemito({
  abierto, onClose, form, setForm, proveedores, localesDisp, localActivo,
  categoriasCompra, onProvChange, guardar,
}: ModalCargarRemitoProps) {
  /* AUDIT F4B#1 / sprint #5: migrado a <Modal>. */
  return (
    <Modal
      isOpen={abierto}
      onClose={onClose}
      title="Nuevo Remito Valorado"
      footer={<><button className="btn btn-sec" onClick={onClose}>Cancelar</button><button className="btn btn-acc" onClick={guardar} disabled={!form.local_id || !form.monto}>Confirmar</button></>}
    >
      <div className="alert alert-info">Para compras informales. Si llega factura, la vinculás. Si no llega, pagás directo.</div>
      <div className="form2">
        <div className="field"><label>Proveedor</label><select value={form.prov_id} onChange={e => onProvChange(e.target.value)}><option value="">Sin proveedor</option>{proveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></div>
        <div className="field"><label>Local *</label>
          {localActivo !== null ? (
            <div style={{ paddingTop: 4 }}>
              <LocalLockedChip nombre={localesDisp.find(l => l.id === localActivo)?.nombre ?? "—"} />
            </div>
          ) : (
            <LocalSelectorObligatorio
              value={form.local_id ? Number(form.local_id) : null}
              onChange={id => setForm({ ...form, local_id: id !== null ? String(id) : "" })}
              locales={localesDisp}
            />
          )}
        </div>
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
    </Modal>
  );
}
