import { CurrencyInput } from "../../components/CurrencyInput";
import { Combobox } from "../../components/Combobox";
import { fmt_$ } from "../../lib/utils";
import { UNIDADES } from "../../lib/constants";
import type { Local } from "../../types";
import type { Proveedor } from "../../types/finanzas";
import type { FormFactura, ItemFactura } from "./types";

// Bundle de categorías EERR para el Combobox. Lo paso como un solo
// prop para no inflar la lista de props con 7 arrays sueltos.
export interface CategoriasBundle {
  compra: string[];
  fijos: string[];
  variables: string[];
  publicidad: string[];
  comisiones: string[];
  impuestos: string[];
  bucketMap: Record<string, string>;
}

interface ModalCargarFacturaProps {
  abierto: boolean;
  onClose: () => void;
  form: FormFactura;
  setForm: React.Dispatch<React.SetStateAction<FormFactura>>;
  proveedores: Proveedor[];
  localesDisp: Local[];
  categorias: CategoriasBundle;
  onProvChange: (prov_id: string) => void;
  calcTotal: () => number;
  items: ItemFactura[];
  addItem: () => void;
  updateItem: (i: number, field: keyof ItemFactura, val: string | number) => void;
  removeItem: (i: number) => void;
  guardar: () => void;
  saving: boolean;
}

// Modal "Cargar Factura / Nota de Crédito" — input manual con todas las
// percepciones argentinas (IVA 21/10.5, IIBB, perc. IVA), detalle de
// insumos opcional y total auto-calculado. Cubre el flujo cuando NO se
// usa el Lector IA.
export function ModalCargarFactura({
  abierto, onClose, form, setForm, proveedores, localesDisp, categorias,
  onProvChange, calcTotal, items, addItem, updateItem, removeItem, guardar, saving,
}: ModalCargarFacturaProps) {
  if (!abierto) return null;
  const { compra, fijos, variables, publicidad, comisiones, impuestos, bucketMap } = categorias;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 680 }} onClick={e => e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">{form.tipo === "nota_credito" ? "Cargar Nota de Crédito" : "Cargar Factura"}</div><button className="close-btn" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="form2">
            <div className="field"><label>Tipo de comprobante</label><select value={form.tipo} onChange={e => setForm({ ...form, tipo: e.target.value })}><option value="factura">Factura</option><option value="nota_credito">Nota de Crédito</option></select></div>
            <div className="field"><label>Local *</label><select value={form.local_id} onChange={e => setForm({ ...form, local_id: e.target.value })}><option value="">Seleccioná...</option>{localesDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}</select></div>
          </div>
          <div className="form2">
            <div className="field"><label>Proveedor *</label><select value={form.prov_id} onChange={e => onProvChange(e.target.value)}><option value="">Seleccioná...</option>{proveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></div>
            <div className="field"><label>Nº Factura *</label><input value={form.nro} onChange={e => setForm({ ...form, nro: e.target.value })} placeholder="A-0001-00001234" /></div>
          </div>
          <div className="form2">
            <div className="field"><label>Categoría EERR</label>
              <Combobox
                value={form.cat}
                onChange={v => setForm({ ...form, cat: v })}
                options={[
                  ...compra.map(c => ({ value: c, label: c, group: "Mercadería (CMV)" })),
                  ...fijos.map(c => ({ value: c, label: c, group: "Gastos Fijos" })),
                  ...variables.map(c => ({ value: c, label: c, group: "Gastos Variables" })),
                  ...publicidad.map(c => ({ value: c, label: c, group: "Publicidad y MKT" })),
                  ...comisiones.map(c => ({ value: c, label: c, group: "Comisiones" })),
                  ...impuestos.map(c => ({ value: c, label: c, group: "Impuestos" })),
                ]}
                groupOrder={["Mercadería (CMV)", "Gastos Fijos", "Gastos Variables", "Publicidad y MKT", "Comisiones", "Impuestos"]}
                placeholder="Buscar o elegir categoría..."
                clearable
              />
              {form.cat && (
                <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 4 }}>
                  {(() => {
                    const b = bucketMap[form.cat];
                    if (!b) return "Categoría libre — entrará al CMV";
                    if (b === "cat_compra") return "Tipo: Mercadería → suma al CMV";
                    const labels: Record<string, string> = { gasto_fijo: "Gasto fijo", gasto_variable: "Gasto variable", gasto_publicidad: "Publicidad", gasto_comision: "Comisión", gasto_impuesto: "Impuesto" };
                    return `Tipo: ${labels[b] || b} → suma a ese bucket de gastos`;
                  })()}
                </div>
              )}
            </div>
            <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e => setForm({ ...form, fecha: e.target.value })} /></div>
          </div>
          <div className="form2">
            <div className="field"><label>Vencimiento</label><input type="date" value={form.venc} onChange={e => setForm({ ...form, venc: e.target.value })} /></div>
            <div className="field"><label>Neto Gravado *</label><CurrencyInput value={form.neto} onChange={v => setForm({ ...form, neto: v })} aria-label="Neto gravado" /></div>
          </div>
          <div className="form3">
            <div className="field"><label>IVA 21%</label><CurrencyInput value={form.iva21} onChange={v => setForm({ ...form, iva21: v })} aria-label="IVA 21%" /></div>
            <div className="field"><label>IVA 10.5%</label><CurrencyInput value={form.iva105} onChange={v => setForm({ ...form, iva105: v })} aria-label="IVA 10.5%" /></div>
            <div className="field"><label>Perc. IIBB</label><CurrencyInput value={form.iibb} onChange={v => setForm({ ...form, iibb: v })} aria-label="Percepción IIBB" /></div>
          </div>
          <div className="form3">
            <div className="field"><label>Perc. IVA</label><CurrencyInput value={form.perc_iva} onChange={v => setForm({ ...form, perc_iva: v })} aria-label="Percepción IVA" /></div>
            <div className="field"><label>Otros Cargos</label><CurrencyInput value={form.otros_cargos} onChange={v => setForm({ ...form, otros_cargos: v })} aria-label="Otros cargos" /></div>
            <div className="field"><label>Descuentos (−)</label><CurrencyInput value={form.descuentos} onChange={v => setForm({ ...form, descuentos: v })} aria-label="Descuentos" /></div>
          </div>
          <div className="field"><label>Total calculado</label><input readOnly value={fmt_$(calcTotal())} style={{ color: "var(--acc)", fontFamily: "'Inter',sans-serif", fontWeight: 500 }} /></div>
          <div className="field"><label>Descripción</label><input value={form.detalle} onChange={e => setForm({ ...form, detalle: e.target.value })} placeholder="Detalle general..." /></div>

          {/* DETALLE DE INSUMOS */}
          <div style={{ marginTop: 16, borderTop: "1px solid var(--bd)", paddingTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontSize: 10, letterSpacing: .8, textTransform: "uppercase", color: "var(--muted2)" }}>Detalle de Insumos (opcional)</span>
              <button className="btn btn-ghost btn-sm" onClick={addItem}>+ Agregar ítem</button>
            </div>
            {items.length > 0 && (
              <table className="items-table">
                <thead><tr><th>Producto</th><th>Cantidad</th><th>Unidad</th><th>Precio unit.</th><th>Subtotal</th><th></th></tr></thead>
                <tbody>{items.map((it, i) => (
                  <tr key={i}>
                    <td><input style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--txt)", padding: "4px 6px", fontFamily: "'Inter',sans-serif", fontSize: 11, borderRadius: "var(--r)" }} value={it.producto} onChange={e => updateItem(i, "producto", e.target.value)} placeholder="Ej: Salmón" /></td>
                    <td><input type="number" step="0.01" style={{ width: 70, background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--txt)", padding: "4px 6px", fontFamily: "'Inter',sans-serif", fontSize: 11, borderRadius: "var(--r)" }} value={it.cantidad} onChange={e => updateItem(i, "cantidad", e.target.value)} /></td>
                    <td><select style={{ background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--txt)", padding: "4px 6px", fontFamily: "'Inter',sans-serif", fontSize: 11, borderRadius: "var(--r)" }} value={it.unidad} onChange={e => updateItem(i, "unidad", e.target.value)}>{UNIDADES.map(u => <option key={u}>{u}</option>)}</select></td>
                    <td><input type="number" step="0.01" style={{ width: 90, background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--txt)", padding: "4px 6px", fontFamily: "'Inter',sans-serif", fontSize: 11, borderRadius: "var(--r)" }} value={it.precio_unitario} onChange={e => updateItem(i, "precio_unitario", e.target.value)} /></td>
                    <td style={{ color: "var(--acc)", fontFamily: "'Inter',sans-serif", fontSize: 13, fontWeight: 500 }}>{fmt_$(it.subtotal)}</td>
                    <td><button className="btn btn-danger btn-sm" onClick={() => removeItem(i)}>✕</button></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={onClose}>Cancelar</button><button className="btn btn-acc" onClick={guardar} disabled={saving}>{saving ? "Guardando..." : "Guardar"}</button></div>
      </div>
    </div>
  );
}
