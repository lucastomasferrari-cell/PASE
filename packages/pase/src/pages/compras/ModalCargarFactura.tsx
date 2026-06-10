import { useEffect, useState } from "react";
import { CurrencyInput } from "../../components/CurrencyInput";
import { Combobox } from "../../components/Combobox";
import { LocalLockedChip, LocalSelectorObligatorio, Modal } from "../../components/ui";
import { fmt_$ } from "@pase/shared/utils";
import { UNIDADES } from "../../lib/constants";
import { db } from "../../lib/supabase";
import { useGuardedHandler } from "../../lib/useGuardedHandler";
import { useToast } from "../../hooks/useToast";
import { ToastComponent } from "../../components/Toast";
import type { Local } from "../../types";
import type { Usuario } from "../../types/auth";
import type { Proveedor } from "../../types/finanzas";
import type { FormFactura, ItemFactura } from "./types";

// Catálogo de materias primas para vincular items de factura (CMV refactor).
interface MateriaPrimaOpcion {
  id: number;
  nombre: string;
  insumo_nombre: string | null;
  proveedor_id: number | null;
}

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
  /** User para insert con tenant_id + created_by en quick-create MP/insumo. */
  user: Usuario;
  form: FormFactura;
  setForm: React.Dispatch<React.SetStateAction<FormFactura>>;
  proveedores: Proveedor[];
  localesDisp: Local[];
  /** localActivo del sidebar — si !== null, sucursal viene LOCKED (chip 🔒). */
  localActivo: number | null;
  categorias: CategoriasBundle;
  onProvChange: (prov_id: string) => void;
  calcTotal: () => number;
  items: ItemFactura[];
  addItem: () => void;
  updateItem: (i: number, field: keyof ItemFactura, val: string | number) => void;
  removeItem: (i: number) => void;
  guardar: () => void;
  saving: boolean;
  /** Modo edición (Lucas 10-jun): si !== null, el modal muestra el input
   *  de justificativo + título "Editar factura" + esconde el detalle de
   *  insumos (la edición no remap items). */
  editandoFactura?: { id: string; nro: string | null; estado: string } | null;
  editandoMotivo?: string;
  setEditandoMotivo?: (s: string) => void;
}

// Insumo light para el dropdown del mini-modal de quick-create MP
interface InsumoOpcion { id: number; nombre: string; unidad: string }

// Modal "Cargar Factura / Nota de Crédito" — input manual con todas las
// percepciones argentinas (IVA 21/10.5, IIBB, perc. IVA), detalle de
// insumos opcional y total auto-calculado. Cubre el flujo cuando NO se
// usa el Lector IA.
export function ModalCargarFactura({
  abierto, onClose, user, form, setForm, proveedores, localesDisp, localActivo, categorias,
  onProvChange, calcTotal, items, addItem, updateItem, removeItem, guardar, saving,
  editandoFactura, editandoMotivo, setEditandoMotivo,
}: ModalCargarFacturaProps) {
  const esEdicion = !!editandoFactura;
  const { toast, showError, showToast } = useToast();
  const [materiasPrimas, setMateriasPrimas] = useState<MateriaPrimaOpcion[]>([]);
  const [insumosOpts, setInsumosOpts] = useState<InsumoOpcion[]>([]);

  // Quick-create MP inline (automatización 29-may): fila del detalle → "+ Crear MP"
  // abre mini-modal pre-llenado con nombre/unidad/precio del row.
  const [quickMpRowIdx, setQuickMpRowIdx] = useState<number | null>(null);
  const [quickMpForm, setQuickMpForm] = useState({
    nombre: "", insumo_id: "", unidad_compra: "un", factor_conversion: "1", merma_pct: "0", precio_actual: "",
  });
  // Quick-create insumo nested (desde el mini-modal de MP, si el insumo tampoco existe)
  const [quickInsumoOpen, setQuickInsumoOpen] = useState(false);
  const [quickInsumoForm, setQuickInsumoForm] = useState({ nombre: "", unidad: "kg" });

  // Cargar catálogo de materias primas al abrir. Filtra por proveedor del form
  // si está seteado (sugerencia: si elegís Pescadería X, sólo te ofrece MPs
  // de ese proveedor + las genéricas sin proveedor).
  useEffect(() => {
    if (!abierto) return;
    void db.from('materias_primas')
      .select('id, nombre, proveedor_id, insumo:insumos(nombre)')
      .is('deleted_at', null)
      .eq('activa', true)
      .order('nombre')
      .limit(500)
      .then(({ data }) => {
        const mapped: MateriaPrimaOpcion[] = (data ?? []).map((r) => {
          const row = r as { id: number; nombre: string; proveedor_id: number | null;
            insumo?: { nombre: string | null } | { nombre: string | null }[] | null };
          const insumo = Array.isArray(row.insumo) ? row.insumo[0] : row.insumo;
          return {
            id: row.id,
            nombre: row.nombre,
            insumo_nombre: insumo?.nombre ?? null,
            proveedor_id: row.proveedor_id,
          };
        });
        setMateriasPrimas(mapped);
      });
    // Cargar insumos para el dropdown del mini-modal de MP
    void db.from('insumos')
      .select('id, nombre, unidad')
      .eq('activo', true).is('deleted_at', null).order('nombre').limit(500)
      .then(({ data }) => setInsumosOpts((data ?? []) as InsumoOpcion[]));
  }, [abierto]);

  // Abrir el mini-modal de MP, pre-llenando con datos de la fila
  function abrirQuickMp(rowIdx: number) {
    const it = items[rowIdx];
    if (!it) return;
    setQuickMpForm({
      nombre: it.producto.trim(),
      insumo_id: "",
      unidad_compra: it.unidad || "un",
      factor_conversion: "1",
      merma_pct: "0",
      precio_actual: String(it.precio_unitario || ""),
    });
    setQuickMpRowIdx(rowIdx);
  }

  // Crear MP inline: INSERT + refresh + auto-vincular a la fila
  const { run: crearMpQuick, isPending: creandoMp } = useGuardedHandler(async () => {
    if (!quickMpForm.nombre.trim()) { showError("Ponele un nombre a la materia prima"); return; }
    if (!quickMpForm.insumo_id) { showError("Tenés que elegir o crear un insumo"); return; }
    const factor = parseFloat(quickMpForm.factor_conversion);
    if (!factor || factor <= 0) { showError("El factor debe ser > 0"); return; }
    const payload = {
      tenant_id: user.tenant_id,
      created_by: user.id,
      nombre: quickMpForm.nombre.trim(),
      insumo_id: parseInt(quickMpForm.insumo_id),
      proveedor_id: form.prov_id ? parseInt(form.prov_id) : null,
      unidad_compra: quickMpForm.unidad_compra,
      factor_conversion: factor,
      merma_pct: parseFloat(quickMpForm.merma_pct) || 0,
      precio_actual: quickMpForm.precio_actual ? parseFloat(quickMpForm.precio_actual) : null,
      activa: true,
    };
    const { data, error } = await db.from('materias_primas').insert([payload]).select('id, nombre, proveedor_id, insumo:insumos(nombre)').single();
    if (error || !data) { showError("No se pudo crear la MP: " + (error?.message ?? "vacío")); return; }
    // Mapear y agregar a la lista local sin re-fetch completo
    const row = data as { id: number; nombre: string; proveedor_id: number | null;
      insumo?: { nombre: string | null } | { nombre: string | null }[] | null };
    const insumo = Array.isArray(row.insumo) ? row.insumo[0] : row.insumo;
    const nuevaMp: MateriaPrimaOpcion = {
      id: row.id, nombre: row.nombre,
      insumo_nombre: insumo?.nombre ?? null,
      proveedor_id: row.proveedor_id,
    };
    setMateriasPrimas([...materiasPrimas, nuevaMp].sort((a, b) => a.nombre.localeCompare(b.nombre)));
    // Auto-vincular a la fila que disparó el create
    if (quickMpRowIdx !== null) {
      updateItem(quickMpRowIdx, 'materia_prima_id' as keyof ItemFactura, row.id);
    }
    showToast("Materia prima creada y vinculada");
    setQuickMpRowIdx(null);
  });

  // Crear insumo inline (nested desde el mini-modal de MP)
  const { run: crearInsumoQuick, isPending: creandoInsumo } = useGuardedHandler(async () => {
    if (!quickInsumoForm.nombre.trim()) { showError("Ponele un nombre al insumo"); return; }
    const { data, error } = await db.from('insumos').insert([{
      tenant_id: user.tenant_id,
      created_by: user.id,
      nombre: quickInsumoForm.nombre.trim(),
      unidad: quickInsumoForm.unidad,
      activo: true,
      es_comprado: true,
      stock_disponible: true,
    }]).select('id, nombre, unidad').single();
    if (error || !data) { showError("No se pudo crear el insumo: " + (error?.message ?? "vacío")); return; }
    const nuevo = data as InsumoOpcion;
    setInsumosOpts([...insumosOpts, nuevo].sort((a, b) => a.nombre.localeCompare(b.nombre)));
    setQuickMpForm({ ...quickMpForm, insumo_id: String(nuevo.id) });
    showToast("Insumo creado");
    setQuickInsumoOpen(false);
    setQuickInsumoForm({ nombre: "", unidad: "kg" });
  });

  if (!abierto) return null;
  const { compra, fijos, variables, publicidad, comisiones, impuestos, bucketMap } = categorias;

  // Filtrar MPs según el proveedor del form (incluye también las "genéricas" sin proveedor).
  const provIdNum = form.prov_id ? Number(form.prov_id) : null;
  const materiasFiltradas = provIdNum
    ? materiasPrimas.filter((mp) => mp.proveedor_id === provIdNum || mp.proveedor_id === null)
    : materiasPrimas;

  // Auto-match por nombre de producto: si hay match único, lo sugiere.
  // Score básico: includes case-insensitive normalizado. Si hay >1 match
  // exacto/parcial, no auto-sugiere para no equivocarse — el user elige.
  function sugerirMP(producto: string): number | null {
    const q = producto.trim().toLowerCase();
    if (q.length < 3) return null;
    const candidatos = materiasFiltradas.filter((mp) => {
      const nombre = mp.nombre.toLowerCase();
      const insumo = (mp.insumo_nombre ?? '').toLowerCase();
      return nombre.includes(q) || q.includes(nombre) || insumo.includes(q);
    });
    if (candidatos.length === 1 && candidatos[0]) return candidatos[0].id;
    return null;
  }

  // Wrapper de updateItem: cuando se cambia el campo "producto", intentar
  // auto-vincular MP. Solo si materia_prima_id está NULL/0 (no pisa selección manual).
  function updateItemConAutoLink(i: number, field: keyof ItemFactura, val: string | number) {
    updateItem(i, field, val);
    if (field === 'producto' && typeof val === 'string') {
      const itemActual = items[i];
      if (itemActual && !itemActual.materia_prima_id) {
        const sugerencia = sugerirMP(val);
        if (sugerencia !== null) {
          // Pequeño delay para dejar terminar el updateItem anterior
          setTimeout(() => updateItem(i, 'materia_prima_id' as keyof ItemFactura, sugerencia), 50);
        }
      }
    }
  }

  // Contar items sin MP vinculada (para warning visual y al guardar)
  const itemsSinMP = items.filter((it) => it.producto.trim().length > 0 && !it.materia_prima_id).length;
  const tieneItems = items.some((it) => it.producto.trim().length > 0);
  const esCMVCategoria = form.cat && bucketMap[form.cat] === 'cat_compra';

  // Wrapper guardar: si es categoría CMV y hay items sin MP vinculada, pide confirmación.
  function guardarConConfirmacion() {
    if (esCMVCategoria && itemsSinMP > 0) {
      const ok = confirm(
        `Hay ${itemsSinMP} ítem${itemsSinMP === 1 ? '' : 's'} sin vincular a materia prima.\n\n` +
        `Su costo NO se va a actualizar y NO va a aparecer correctamente en el reporte CMV.\n\n` +
        `¿Guardar igual? Cancelá para vincular antes.`
      );
      if (!ok) return;
    }
    guardar();
  }
  /* AUDIT F4B#1 / sprint #5: migrado a <Modal>. */
  return (
    <Modal
      isOpen={abierto}
      onClose={onClose}
      title={
        esEdicion
          ? `Editar factura ${editandoFactura?.nro ?? ""}`
          : (form.tipo === "nota_credito" ? "Cargar Nota de Crédito" : "Cargar Factura")
      }
      maxWidth={680}
      preventCloseOnOverlay={saving}
      footer={<><button className="btn btn-sec" onClick={onClose}>Cancelar</button><button className="btn btn-acc" onClick={guardarConConfirmacion} disabled={saving || !form.local_id || (esEdicion && !(editandoMotivo || "").trim())}>{saving ? "Guardando..." : (esEdicion ? "Guardar cambios" : "Guardar")}</button></>}
    >
          {esEdicion && (
            <div className="alert alert-info" style={{ marginBottom: 12, fontSize: 12 }}>
              Estás editando la factura <strong>{editandoFactura?.nro}</strong> (estado: <strong>{editandoFactura?.estado}</strong>).
              Si ya estuviera pagada o anulada, la edición se rechazaría — en ese caso anulala y volvé a cargar.
            </div>
          )}
          {esEdicion && (
            <div className="field" style={{ marginBottom: 12 }}>
              <label>Motivo de la edición *</label>
              <input
                value={editandoMotivo || ""}
                onChange={e => setEditandoMotivo?.(e.target.value)}
                placeholder="¿Por qué editás? (obligatorio para auditoría)"
                style={{ width: "100%" }}
              />
            </div>
          )}
          <div className="form2">
            <div className="field"><label>Tipo de comprobante</label><select value={form.tipo} onChange={e => setForm({ ...form, tipo: e.target.value })} disabled={esEdicion}><option value="factura">Factura</option><option value="nota_credito">Nota de Crédito</option></select></div>
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
            <div className="field"><label>Perc. IVA</label><CurrencyInput value={form.perc_iva} onChange={v => setForm({ ...form, perc_iva: v })} aria-label="Percepción IVA" /></div>
          </div>

          {/* Discriminación fiscal AR — colapsable (Lucas 10-jun, Libro IVA
              Compras del contador). Por default va cerrado: la mayoría de
              las facturas solo usan los campos comunes de arriba. Si la
              factura tiene IIBB, IVA 27%, no gravado, perc. ganancias, etc.,
              el usuario abre y completa lo que corresponde. */}
          <details style={{ marginTop: 10, padding: "8px 10px", border: "1px solid var(--bd)", borderRadius: "var(--r)", background: "var(--s2)" }}>
            <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--muted2)", fontWeight: 500 }}>
              Discriminación fiscal (IVA 27% · No grav. · Exento · IIBB por jurisdicción · Perc. Gan. · SUSS)
            </summary>
            <div style={{ marginTop: 10, fontSize: 11, color: "var(--muted2)" }}>
              Completá solo lo que aplique a esta factura. Los campos van al Libro IVA Compras para el contador.
            </div>
            <div className="form3" style={{ marginTop: 8 }}>
              <div className="field"><label>IVA 27%</label><CurrencyInput value={form.iva27} onChange={v => setForm({ ...form, iva27: v })} aria-label="IVA 27%" /></div>
              <div className="field"><label>No gravado</label><CurrencyInput value={form.no_gravado} onChange={v => setForm({ ...form, no_gravado: v })} aria-label="No gravado" /></div>
              <div className="field"><label>Exento</label><CurrencyInput value={form.exento} onChange={v => setForm({ ...form, exento: v })} aria-label="Exento" /></div>
            </div>
            <div className="form3">
              <div className="field"><label>Perc. IIBB · CABA</label><CurrencyInput value={form.iibb_caba} onChange={v => setForm({ ...form, iibb_caba: v })} aria-label="IIBB CABA" /></div>
              <div className="field"><label>Perc. IIBB · Bs As</label><CurrencyInput value={form.iibb_ba} onChange={v => setForm({ ...form, iibb_ba: v })} aria-label="IIBB Bs As" /></div>
              <div className="field">
                <label>Perc. IIBB · Otra</label>
                <CurrencyInput value={form.iibb_otros} onChange={v => setForm({ ...form, iibb_otros: v })} aria-label="IIBB otra jurisdicción" />
                {form.iibb_otros > 0 && (
                  <input
                    type="text"
                    placeholder="Jurisdicción (Córdoba, Mendoza...)"
                    value={form.iibb_otros_jurisdiccion}
                    onChange={e => setForm({ ...form, iibb_otros_jurisdiccion: e.target.value })}
                    style={{ marginTop: 4, fontSize: 11 }}
                  />
                )}
              </div>
            </div>
            <div className="form3">
              <div className="field"><label>Perc. Ganancias</label><CurrencyInput value={form.perc_ganancias} onChange={v => setForm({ ...form, perc_ganancias: v })} aria-label="Percepción Ganancias" /></div>
              <div className="field"><label>Retención SUSS</label><CurrencyInput value={form.retencion_suss} onChange={v => setForm({ ...form, retencion_suss: v })} aria-label="Retención SUSS" /></div>
              <div className="field" />
            </div>
          </details>

          <div className="form3" style={{ marginTop: 10 }}>
            <div className="field"><label>Otros Cargos</label><CurrencyInput value={form.otros_cargos} onChange={v => setForm({ ...form, otros_cargos: v })} aria-label="Otros cargos" /></div>
            <div className="field"><label>Descuentos (−)</label><CurrencyInput value={form.descuentos} onChange={v => setForm({ ...form, descuentos: v })} aria-label="Descuentos" /></div>
            <div className="field"><label>Total calculado</label><input readOnly value={fmt_$(calcTotal())} style={{ color: "var(--acc)", fontFamily: "'Inter',sans-serif", fontWeight: 500 }} /></div>
          </div>
          <div className="field"><label>Descripción</label><input value={form.detalle} onChange={e => setForm({ ...form, detalle: e.target.value })} placeholder="Detalle general..." /></div>

          {/* DETALLE DE INSUMOS */}
          <div style={{ marginTop: 16, borderTop: "1px solid var(--bd)", paddingTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontSize: 10, letterSpacing: .8, textTransform: "uppercase", color: "var(--muted2)" }}>Detalle de Insumos (opcional)</span>
              <button className="btn btn-ghost btn-sm" onClick={addItem}>+ Agregar ítem</button>
            </div>
            {items.length > 0 && (
              <table className="items-table">
                <thead><tr><th>Producto</th><th>Cantidad</th><th>Unidad</th><th>Precio unit.</th><th>Subtotal</th><th>→ Materia prima (CMV)</th><th></th></tr></thead>
                <tbody>{items.map((it, i) => {
                  // Highlight visual: si producto tiene contenido pero MP no vinculada Y la categoría es CMV
                  const necesitaVincular = esCMVCategoria && it.producto.trim().length > 0 && !it.materia_prima_id;
                  return (
                  <tr key={i} style={necesitaVincular ? { background: 'rgba(255, 200, 0, 0.08)' } : undefined}>
                    <td><input style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--txt)", padding: "4px 6px", fontFamily: "'Inter',sans-serif", fontSize: 11, borderRadius: "var(--r)" }} value={it.producto} onChange={e => updateItemConAutoLink(i, "producto", e.target.value)} placeholder="Ej: Salmón" /></td>
                    <td><input type="number" step="0.01" style={{ width: 70, background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--txt)", padding: "4px 6px", fontFamily: "'Inter',sans-serif", fontSize: 11, borderRadius: "var(--r)" }} value={it.cantidad} onChange={e => updateItem(i, "cantidad", e.target.value)} /></td>
                    <td><select style={{ background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--txt)", padding: "4px 6px", fontFamily: "'Inter',sans-serif", fontSize: 11, borderRadius: "var(--r)" }} value={it.unidad} onChange={e => updateItem(i, "unidad", e.target.value)}>{UNIDADES.map(u => <option key={u}>{u}</option>)}</select></td>
                    <td><input type="number" step="0.01" style={{ width: 90, background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--txt)", padding: "4px 6px", fontFamily: "'Inter',sans-serif", fontSize: 11, borderRadius: "var(--r)" }} value={it.precio_unitario} onChange={e => updateItem(i, "precio_unitario", e.target.value)} /></td>
                    <td style={{ color: "var(--acc)", fontFamily: "'Inter',sans-serif", fontSize: 13, fontWeight: 500 }}>{fmt_$(it.subtotal)}</td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <select
                          style={{
                            width: "100%",
                            background: necesitaVincular ? "rgba(217, 119, 6, 0.12)" : "var(--bg)",
                            border: necesitaVincular ? "1px solid #d97706" : "1px solid var(--bd)",
                            color: "var(--txt)", padding: "4px 6px", fontSize: 11, borderRadius: "var(--r)",
                          }}
                          value={it.materia_prima_id ?? ""}
                          onChange={e => updateItem(i, "materia_prima_id" as keyof ItemFactura, e.target.value ? Number(e.target.value) : 0)}
                          title={necesitaVincular
                            ? "⚠ Sin vincular — el costo del insumo NO se actualizará"
                            : "Vincular a una materia prima del catálogo"}
                        >
                          <option value="">{necesitaVincular ? "⚠ Sin vincular" : "— sin vincular —"}</option>
                          {materiasFiltradas.map((mp) => (
                            <option key={mp.id} value={mp.id}>
                              {mp.nombre}{mp.insumo_nombre ? ` → ${mp.insumo_nombre}` : ""}
                            </option>
                          ))}
                        </select>
                        {it.producto.trim().length > 0 && !it.materia_prima_id && (
                          <button
                            type="button"
                            onClick={() => abrirQuickMp(i)}
                            style={{ fontSize: 10, color: "var(--acc)", background: "none", border: "none", padding: "0 0 0 2px", cursor: "pointer", textDecoration: "underline", textAlign: "left" }}
                            title="Crear esta materia prima en el catálogo y vincularla a este ítem"
                          >
                            + Crear MP nueva
                          </button>
                        )}
                      </div>
                    </td>
                    <td><button className="btn btn-danger btn-sm" onClick={() => removeItem(i)}>✕</button></td>
                  </tr>
                  );
                })}</tbody>
              </table>
            )}
            {tieneItems && esCMVCategoria && itemsSinMP > 0 && (
              <div style={{ fontSize: 11, color: '#92400e', marginTop: 6, padding: "8px 10px", background: 'rgba(255, 200, 0, 0.12)', border: '1px solid rgba(217, 119, 6, 0.4)', borderRadius: 4 }}>
                <strong>⚠ Atención:</strong> {itemsSinMP} {itemsSinMP === 1 ? 'ítem' : 'ítems'} sin vincular a materia prima.
                Sin vincular, el stock del insumo NO se va a sumar y NO va a aparecer en el reporte CMV.
                Vinculalos arriba con el dropdown, o creá las materias primas faltantes en Recetario → Materias primas.
              </div>
            )}
            {tieneItems && esCMVCategoria && itemsSinMP === 0 && (
              <div style={{ fontSize: 10, color: '#15803d', marginTop: 6, padding: "6px 8px", background: 'rgba(34, 197, 94, 0.08)', borderRadius: 4 }}>
                ✓ Todos los ítems vinculados — el costo de los insumos se actualizará automáticamente.
              </div>
            )}
            {items.length > 0 && !esCMVCategoria && (
              <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 6, padding: "6px 8px", background: "var(--bg)", borderRadius: 4 }}>
                💡 Si esto fuera una compra de mercadería (CMV), elegí una categoría CMV arriba para vincular ítems a materias primas.
              </div>
            )}
          </div>

          {/* Mini-Modal: crear MP rápido desde una fila de la factura.
              Pre-llena nombre/unidad/precio de la fila, deja al user elegir/crear el insumo. */}
          <Modal
            isOpen={quickMpRowIdx !== null}
            onClose={() => setQuickMpRowIdx(null)}
            title="Crear materia prima"
            maxWidth={500}
            footer={
              <>
                <button className="btn btn-sec" onClick={() => setQuickMpRowIdx(null)} disabled={creandoMp}>Cancelar</button>
                <button className="btn btn-acc" onClick={() => crearMpQuick()} disabled={creandoMp}>
                  {creandoMp ? "Creando…" : "Crear y vincular"}
                </button>
              </>
            }
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 11, color: "var(--muted2)" }}>
                La MP es <strong>cómo te vende el proveedor</strong> (ej: "Bolsa salmón 5kg"). El insumo es <strong>la materia base</strong> (ej: "Salmón"). Una MP apunta a un insumo.
              </div>
              <div>
                <label style={{ fontSize: 11, color: "var(--muted2)" }}>Nombre MP *</label>
                <input type="text" value={quickMpForm.nombre} onChange={e => setQuickMpForm({ ...quickMpForm, nombre: e.target.value })}
                  placeholder="Ej: Bolsa salmón 5kg" className="search" style={{ width: "100%" }} autoFocus />
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <label style={{ fontSize: 11, color: "var(--muted2)" }}>Insumo *</label>
                  <button type="button" onClick={() => setQuickInsumoOpen(true)}
                    style={{ fontSize: 10, color: "var(--acc)", background: "none", border: "none", padding: 0, cursor: "pointer", textDecoration: "underline" }}>
                    + Crear insumo
                  </button>
                </div>
                <select value={quickMpForm.insumo_id} onChange={e => setQuickMpForm({ ...quickMpForm, insumo_id: e.target.value })}
                  className="search" style={{ width: "100%" }}>
                  <option value="">Seleccionar insumo</option>
                  {insumosOpts.map(i => <option key={i.id} value={String(i.id)}>{i.nombre} ({i.unidad})</option>)}
                </select>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <div>
                  <label style={{ fontSize: 11, color: "var(--muted2)" }}>Unidad compra *</label>
                  <input type="text" value={quickMpForm.unidad_compra} onChange={e => setQuickMpForm({ ...quickMpForm, unidad_compra: e.target.value })}
                    className="search" style={{ width: "100%" }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: "var(--muted2)" }}>Factor *</label>
                  <input type="number" step="0.01" min="0.01" value={quickMpForm.factor_conversion}
                    onChange={e => setQuickMpForm({ ...quickMpForm, factor_conversion: e.target.value })}
                    className="search" style={{ width: "100%" }} />
                  <div style={{ fontSize: 9, color: "var(--muted2)", marginTop: 2 }}>
                    {(() => {
                      const ins = insumosOpts.find(i => String(i.id) === quickMpForm.insumo_id);
                      return ins ? `${ins.unidad} por ${quickMpForm.unidad_compra || "unidad"}` : "Cantidad por unidad de compra";
                    })()}
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 11, color: "var(--muted2)" }}>Merma %</label>
                  <input type="number" step="0.01" min="0" value={quickMpForm.merma_pct}
                    onChange={e => setQuickMpForm({ ...quickMpForm, merma_pct: e.target.value })}
                    className="search" style={{ width: "100%" }} />
                </div>
              </div>
              <div>
                <label style={{ fontSize: 11, color: "var(--muted2)" }}>Precio actual (opcional)</label>
                <input type="number" step="0.01" min="0" value={quickMpForm.precio_actual}
                  onChange={e => setQuickMpForm({ ...quickMpForm, precio_actual: e.target.value })}
                  className="search" style={{ width: "100%" }} />
                <div style={{ fontSize: 9, color: "var(--muted2)", marginTop: 2 }}>
                  Si cargás esta factura el trigger lo actualiza automático con el precio_unitario del ítem.
                </div>
              </div>
            </div>
          </Modal>

          {/* Mini-mini-modal: crear insumo desde dentro del mini-modal de MP */}
          <Modal
            isOpen={quickInsumoOpen}
            onClose={() => setQuickInsumoOpen(false)}
            title="Crear insumo rápido"
            maxWidth={400}
            footer={
              <>
                <button className="btn btn-sec" onClick={() => setQuickInsumoOpen(false)} disabled={creandoInsumo}>Cancelar</button>
                <button className="btn btn-acc" onClick={() => crearInsumoQuick()} disabled={creandoInsumo}>
                  {creandoInsumo ? "Creando…" : "Crear"}
                </button>
              </>
            }
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: "var(--muted2)" }}>Nombre *</label>
                <input type="text" value={quickInsumoForm.nombre}
                  onChange={e => setQuickInsumoForm({ ...quickInsumoForm, nombre: e.target.value })}
                  placeholder="Ej: Salmón" className="search" style={{ width: "100%" }} autoFocus />
              </div>
              <div>
                <label style={{ fontSize: 11, color: "var(--muted2)" }}>Unidad base *</label>
                <select value={quickInsumoForm.unidad}
                  onChange={e => setQuickInsumoForm({ ...quickInsumoForm, unidad: e.target.value })}
                  className="search" style={{ width: "100%" }}>
                  <option value="kg">kg</option>
                  <option value="g">g</option>
                  <option value="L">L</option>
                  <option value="ml">ml</option>
                  <option value="un">un</option>
                  <option value="docena">docena</option>
                </select>
              </div>
            </div>
          </Modal>

          {toast && <ToastComponent toast={toast} />}
    </Modal>
  );
}
